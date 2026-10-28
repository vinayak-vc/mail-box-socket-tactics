/**
 * EventBroker.js
 * Hardened, persistent WebSocket and HTTP Event Broker for AI-agent communication.
 * Manages authenticated client sockets, heartbeats, channel subscriptions,
 * durable task states, atomic leases, periodic renewals, retries, and dead letters.
 */

const http = require('http');
const WebSocket = require('ws');
const {
  EVENT_TYPES,
  PROCESSING_STATUS,
  isRecipientMatch,
  normalizeAgentId
} = require('../protocol/MessageProtocol');
const MailboxWatcher = require('./MailboxWatcher');
const StateStore = require('./StateStore');

class EventBroker {
  constructor(config = {}) {
    this.host = config.host || '127.0.0.1';
    this.port = config.port || 8765;
    this.httpPort = config.httpPort || 8766;
    this.authToken = config.authToken || 'mailbox-socket-secret-token';
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 15000;
    this.clientTimeoutMs = config.clientTimeoutMs || 35000;
    this.leaseTimeoutMs = config.leaseTimeoutMs || 120000;
    this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : 3;
    this.backoffInitialMs = config.backoffInitialMs || 2000;

    this.wss = null;
    this.httpServer = null;
    this.heartbeatTimer = null;
    this.watcher = null;

    // Durable State Store
    this.stateStore = new StateStore({
      statePath: config.statePath,
      maxRetries: this.maxRetries
    });

    // Client connection state
    this.clients = new Map(); // socket -> { agentId, subscriptions: Set, isAlive, connectedAt, workerId }
    this.metrics = {
      connectionsAccepted: 0,
      authFailures: 0,
      notificationsSent: 0,
      acksReceived: 0,
      renewalsReceived: 0,
      retriesTriggered: 0,
      deadLettersCount: 0
    };

    if (config.mailbox) {
      this.watcher = new MailboxWatcher({
        mailboxPath: config.mailbox.path,
        debounceIntervalMs: 150,
        pollIntervalMs: config.mailbox.pollFallbackMs || 10000,
        failFastOnMissing: true
      });

      this.watcher.on('new_message', (msg) => {
        this.publishMessage(msg);
      });

      this.watcher.on('error', (err) => {
        console.error(`[EventBroker] MailboxWatcher error: ${err.message}`);
      });
    }
  }

  /**
   * Starts WebSocket and HTTP servers
   */
  async start() {
    // 1. Reconcile crashed tasks from previous broker run
    const reconciled = this.stateStore.reconcileCrashedTasks();
    if (reconciled > 0) {
      console.log(`[EventBroker] Reconciled ${reconciled} unfinished tasks from previous session.`);
    }

    // 2. Initialize MailboxWatcher baseline if configured
    if (this.watcher) {
      await this.watcher.initBaseline();
      this.watcher.start();
    }

    // 3. Start WebSocket Server (bound to localhost only)
    await new Promise((resolve, reject) => {
      this.wss = new WebSocket.Server({
        host: this.host,
        port: this.port
      }, () => {
        console.log(`[EventBroker] WebSocket Server running on ws://${this.host}:${this.port}`);
        resolve();
      });

      this.wss.on('error', reject);
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // 4. Start Companion HTTP Server for triggers, health, status, and requeue
    await new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
      this.httpServer.listen(this.httpPort, this.host, () => {
        console.log(`[EventBroker] HTTP API Server running on http://${this.host}:${this.httpPort}`);
        resolve();
      });
      this.httpServer.on('error', reject);
    });

    // 5. Start Heartbeat Timer
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), this.heartbeatIntervalMs);
  }

  /**
   * Handles incoming WebSocket connection
   */
  handleConnection(ws, req) {
    const clientIp = req.socket.remoteAddress;
    this.metrics.connectionsAccepted++;

    const clientState = {
      authenticated: false,
      agentId: null,
      subscriptions: new Set(),
      isAlive: true,
      connectedAt: new Date().toISOString()
    };
    this.clients.set(ws, clientState);

    // Timeout if client doesn't authenticate in 10s
    const authTimeout = setTimeout(() => {
      if (!clientState.authenticated) {
        console.warn(`[EventBroker] Authentication timeout for connection from ${clientIp}`);
        this.metrics.authFailures++;
        try {
          ws.send(JSON.stringify({
            type: EVENT_TYPES.AUTH_RESPONSE,
            success: false,
            error: 'Authentication timeout'
          }));
          ws.terminate();
        } catch (_) {}
      }
    }, 10000);

    ws.on('message', (data) => {
      try {
        if (data.length > 524288) { // 512 KB payload limit
          console.warn('[EventBroker] Message exceeds 512KB limit. Terminating connection.');
          ws.terminate();
          return;
        }
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, clientState, message, authTimeout);
      } catch (err) {
        console.error(`[EventBroker] Invalid JSON from client: ${err.message}`);
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Malformed JSON payload' }));
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      const agentId = clientState.agentId || 'unauthenticated';
      console.log(`[EventBroker] Client disconnected: ${agentId}`);
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.warn(`[EventBroker] Socket error for ${clientState.agentId || 'unknown'}: ${err.message}`);
    });
  }

  /**
   * Processes messages from connected clients with mandatory authentication checks
   */
  handleClientMessage(ws, clientState, msg, authTimeout) {
    // 1. Unauthenticated client can ONLY send AUTH_REQUEST
    if (!clientState.authenticated) {
      if (msg.type !== EVENT_TYPES.AUTH_REQUEST) {
        this.metrics.authFailures++;
        console.warn(`[EventBroker] Rejected unauthenticated event type '${msg.type}'`);
        ws.send(JSON.stringify({
          type: 'ERROR',
          error: 'Authentication required before executing operations'
        }));
        return ws.terminate();
      }

      // Validate Auth Request
      if (!msg.token || msg.token !== this.authToken) {
        this.metrics.authFailures++;
        console.warn(`[EventBroker] Authentication failure: invalid token provided for agent '${msg.agentId || 'unknown'}'`);
        ws.send(JSON.stringify({
          type: EVENT_TYPES.AUTH_RESPONSE,
          success: false,
          error: 'Invalid authentication credentials'
        }));
        return ws.terminate();
      }

      clearTimeout(authTimeout);
      clientState.authenticated = true;
      clientState.agentId = normalizeAgentId(msg.agentId) || 'UnknownAgent';
      clientState.workerId = msg.workerId || null;

      // Auto-subscribe ONLY to own canonical name and party code
      const normId = clientState.agentId.toLowerCase();
      clientState.subscriptions.add(normId);

      console.log(`[EventBroker] Agent authenticated successfully: ${clientState.agentId}`);
      ws.send(JSON.stringify({
        type: EVENT_TYPES.AUTH_RESPONSE,
        success: true,
        agentId: clientState.agentId
      }));
      return;
    }

    // 2. Authenticated operations
    switch (msg.type) {
      case EVENT_TYPES.SUBSCRIBE: {
        const requested = Array.isArray(msg.channels) ? msg.channels : [msg.channel || clientState.agentId];
        const granted = [];

        for (const ch of requested) {
          const norm = String(ch).toLowerCase();
          const ownId = clientState.agentId.toLowerCase();

          // Strict channel permission check:
          // Agent can ONLY subscribe to its own name or party code.
          const isOwnParty = (ownId === 'claude' && (norm === 'c' || norm === 'claude')) ||
                             (ownId === 'codex' && (norm === 'x' || norm === 'codex')) ||
                             (ownId === 'antigravity' && (norm === 'a' || norm === 'ag' || norm === 'antigravity')) ||
                             (ownId === 'owner' && (norm === 'h' || norm === 'owner'));

          if (isOwnParty) {
            clientState.subscriptions.add(norm);
            granted.push(norm);
          } else {
            console.warn(`[EventBroker] Unauthorized subscription request by ${clientState.agentId} for channel: '${ch}'`);
          }
        }

        ws.send(JSON.stringify({
          type: EVENT_TYPES.SUBSCRIBE_ACK,
          grantedChannels: granted
        }));
        break;
      }

      case EVENT_TYPES.PONG: {
        clientState.isAlive = true;
        break;
      }

      case EVENT_TYPES.MESSAGE_ACK: {
        this.metrics.acksReceived++;
        this.handleMessageAck(clientState.agentId, msg);
        break;
      }

      case EVENT_TYPES.LEASE_RENEW: {
        this.metrics.renewalsReceived++;
        this.handleLeaseRenew(ws, clientState, msg);
        break;
      }

      case EVENT_TYPES.PUBLISH_NOTIFY: {
        if (msg.message) {
          this.publishMessage(msg.message);
        }
        break;
      }

      case EVENT_TYPES.REPLAY_REQUEST: {
        this.handleReplayRequest(ws, clientState, msg);
        break;
      }

      default:
        console.warn(`[EventBroker] Unknown message type: ${msg.type}`);
        ws.send(JSON.stringify({ type: 'ERROR', error: `Unknown event type ${msg.type}` }));
    }
  }

  /**
   * Heartbeat sweep: pings alive connections, drops dead ones, checks expired leases
   */
  runHeartbeat() {
    for (const [ws, state] of this.clients.entries()) {
      if (!state.isAlive) {
        console.log(`[EventBroker] Dropping inactive connection: ${state.agentId || 'anonymous'}`);
        ws.terminate();
        this.clients.delete(ws);
        continue;
      }
      state.isAlive = false;
      try {
        ws.send(JSON.stringify({ type: EVENT_TYPES.PING, timestamp: new Date().toISOString() }));
      } catch (err) {
        ws.terminate();
        this.clients.delete(ws);
      }
    }

    // Check for expired task leases in StateStore
    const now = Date.now();
    for (const [msgId, task] of this.stateStore.tasks.entries()) {
      if ((task.status === PROCESSING_STATUS.CLAIMED || task.status === PROCESSING_STATUS.RUNNING) &&
          task.leaseExpiresAt > 0 && now > task.leaseExpiresAt) {
        console.warn(`[EventBroker] Lease expired for message ${msgId} assigned to ${task.claimOwner}`);
        const failResult = this.stateStore.markFailed(msgId, task.claimOwner, 'Lease expired without renewal or completion');

        if (failResult.retry) {
          this.metrics.retriesTriggered++;
          console.log(`[EventBroker] Retrying expired message ${msgId} (attempt ${failResult.attempt}/${failResult.maxAttempts})`);
          this.publishMessage({
            messageId: msgId,
            sender: task.sender,
            recipientRaw: task.recipient,
            _isRetry: true
          });
        } else {
          this.metrics.deadLettersCount++;
          console.error(`[EventBroker] [DEAD LETTER] Message ${msgId} moved to DLQ: Lease expired after max retries`);
        }
      }
    }
  }

  /**
   * Publishes message notification strictly to intended recipients
   */
  publishMessage(msg) {
    const messageId = msg.messageId || msg.id;
    if (!messageId) return 0;

    // Check if malformed
    if (msg.isMalformed) {
      console.warn(`[EventBroker] Quarantining malformed message heading: ${msg.headerLine || messageId}`);
      this.stateStore.markFailed(messageId, null, 'Malformed message format', true);
      return 0;
    }

    // Record or retrieve task state in durable store
    const task = this.stateStore.getOrCreateTask(msg);

    // If already completed, ignore
    if (task.status === PROCESSING_STATUS.COMPLETED) {
      console.log(`[EventBroker] Message ${messageId} is already COMPLETED. Skipping duplicate dispatch.`);
      return 0;
    }

    let deliveredCount = 0;
    const recipientStr = msg.recipientRaw || msg.recipient || '';

    for (const [ws, state] of this.clients.entries()) {
      if (!state.authenticated) continue;

      // DO NOT deliver message back to the sender
      if (state.agentId && msg.sender && state.agentId.toLowerCase() === msg.sender.toLowerCase()) {
        continue;
      }

      // Explicit recipient check: ONLY deliver to matching subscriber
      const isMatch = isRecipientMatch(state.agentId, recipientStr);

      if (isMatch) {
        const payload = {
          type: EVENT_TYPES.MAILBOX_MESSAGE_NOTIFY,
          messageId: messageId,
          party: msg.party,
          number: msg.number,
          sender: msg.sender,
          recipientRaw: recipientStr,
          timestamp: msg.timestamp || new Date().toISOString(),
          mailboxPath: msg.mailboxPath
        };

        try {
          ws.send(JSON.stringify(payload));
          deliveredCount++;
          this.metrics.notificationsSent++;
          console.log(`[EventBroker] Dispatched notification ${messageId} to ${state.agentId}`);
        } catch (err) {
          console.error(`[EventBroker] Error sending notification to ${state.agentId}: ${err.message}`);
        }
      }
    }

    return deliveredCount;
  }

  /**
   * Handles processing acknowledgement from agents
   */
  handleMessageAck(agentId, ack) {
    const { messageId, status, error, workerId, evidence } = ack;
    if (!messageId) return;

    console.log(`[EventBroker] ACK from ${agentId} for ${messageId}: status=${status}${error ? ' error=' + error : ''}`);

    if (status === PROCESSING_STATUS.COMPLETED) {
      this.stateStore.markCompleted(messageId, workerId, evidence);
    } else if (status === PROCESSING_STATUS.CLAIMED || status === PROCESSING_STATUS.LEASE_ACQUIRED) {
      this.stateStore.claimTask(messageId, workerId, this.leaseTimeoutMs);
    } else if (status === PROCESSING_STATUS.RUNNING) {
      this.stateStore.markRunning(messageId, workerId);
    } else if (status === PROCESSING_STATUS.FAILED) {
      const failResult = this.stateStore.markFailed(messageId, workerId, error);
      if (failResult.retry) {
        this.metrics.retriesTriggered++;
        const delay = this.backoffInitialMs * Math.pow(2, failResult.attempt - 1);
        console.log(`[EventBroker] Scheduling retry for ${messageId} in ${delay}ms`);
        setTimeout(() => {
          const t = this.stateStore.getTask(messageId);
          if (t && t.status !== PROCESSING_STATUS.COMPLETED) {
            this.publishMessage({
              messageId: t.messageId,
              sender: t.sender,
              recipientRaw: t.recipient,
              _isRetry: true
            });
          }
        }, delay);
      } else {
        this.metrics.deadLettersCount++;
      }
    }
  }

  /**
   * Handles periodic lease renewal during long-running work
   */
  handleLeaseRenew(ws, clientState, msg) {
    const { messageId, workerId, extendMs } = msg;
    const renewTime = extendMs || 60000;
    const renewed = this.stateStore.renewLease(messageId, workerId, renewTime);

    if (renewed) {
      const task = this.stateStore.getTask(messageId);
      ws.send(JSON.stringify({
        type: EVENT_TYPES.LEASE_RENEW_ACK,
        success: true,
        messageId,
        newExpiresAt: task.leaseExpiresAt
      }));
    } else {
      ws.send(JSON.stringify({
        type: EVENT_TYPES.LEASE_RENEW_ACK,
        success: false,
        messageId,
        error: 'Lease renewal failed: worker not owner or task not active'
      }));
    }
  }

  /**
   * Handles replay request for catch-up on reconnect
   */
  async handleReplayRequest(ws, clientState, req) {
    if (!this.watcher) return;
    try {
      const text = await this.watcher.readMailboxFile();
      if (!text) return;

      const { parseMailboxMessages } = require('../protocol/MessageProtocol');
      const messages = parseMailboxMessages(text);
      const since = req.sinceNumber || 0;

      for (const msg of messages) {
        if (msg.number > since && isRecipientMatch(clientState.agentId, msg.recipientRaw)) {
          if (!this.stateStore.isCompleted(msg.id)) {
            ws.send(JSON.stringify({
              type: EVENT_TYPES.MAILBOX_MESSAGE_NOTIFY,
              messageId: msg.id,
              party: msg.party,
              number: msg.number,
              sender: msg.sender,
              recipientRaw: msg.recipientRaw,
              timestamp: msg.timestamp,
              mailboxPath: this.watcher.mailboxPath,
              isReplay: true
            }));
          }
        }
      }
    } catch (err) {
      console.error(`[EventBroker] Replay error: ${err.message}`);
    }
  }

  /**
   * Handles HTTP API requests with mandatory authentication
   */
  handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.httpPort}`);

    // Helper for auth verification
    const verifyAuth = () => {
      const authHeader = req.headers['authorization'];
      if (!authHeader) return false;
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      return token === this.authToken;
    };

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
      const connected = [];
      for (const [, state] of this.clients.entries()) {
        if (state.authenticated) {
          connected.push({
            agentId: state.agentId,
            subscriptions: Array.from(state.subscriptions),
            connectedAt: state.connectedAt
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'UP',
        timestamp: new Date().toISOString(),
        metrics: this.metrics,
        activeTasks: Array.from(this.stateStore.tasks.values()).filter(t => t.status === PROCESSING_STATUS.CLAIMED || t.status === PROCESSING_STATUS.RUNNING),
        completedCount: Array.from(this.stateStore.tasks.values()).filter(t => t.status === PROCESSING_STATUS.COMPLETED).length,
        deadLetterCount: this.stateStore.deadLetters.size,
        deadLetters: Array.from(this.stateStore.deadLetters.values()),
        connectedAgents: connected
      }, null, 2));
    }

    if (req.method === 'POST' && url.pathname === '/publish') {
      if (!verifyAuth()) {
        this.metrics.authFailures++;
        console.warn(`[EventBroker] Unauthorized HTTP /publish attempt from ${req.socket.remoteAddress}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid Bearer token' }));
      }

      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 524288) { // 512 KB
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
        }
      });

      req.on('end', async () => {
        try {
          // If mailbox watcher exists, trigger immediate check
          if (this.watcher) {
            const newFound = await this.watcher.checkNow();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, newMessagesFound: newFound.length }));
          }

          const parsed = body ? JSON.parse(body) : {};
          if (parsed.message) {
            this.publishMessage(parsed.message);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/requeue') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const requeued = this.stateStore.requeue(parsed.messageId);
          if (requeued) {
            const t = this.stateStore.getTask(parsed.messageId);
            this.publishMessage({
              messageId: t.messageId,
              sender: t.sender,
              recipientRaw: t.recipient,
              _isRetry: true
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, messageId: parsed.messageId }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Task not found in dead letters' }));
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  /**
   * Graceful stop
   */
  async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.watcher) {
      this.watcher.stop();
    }

    for (const [ws] of this.clients.entries()) {
      try { ws.close(); } catch (_) {}
    }
    this.clients.clear();

    await new Promise(resolve => {
      if (this.wss) {
        this.wss.close(resolve);
      } else {
        resolve();
      }
    });

    await new Promise(resolve => {
      if (this.httpServer) {
        this.httpServer.close(resolve);
      } else {
        resolve();
      }
    });

    this.stateStore.save();
    console.log('[EventBroker] Broker stopped cleanly');
  }
}

module.exports = EventBroker;
