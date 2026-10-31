/**
 * EventBroker.js
 * Hardened, persistent WebSocket and HTTP Event Broker for AI-agent communication.
 * Manages authenticated client sockets, heartbeats, channel subscriptions,
 * durable task states, atomic leases, periodic renewals, retries, dead letters,
 * agent registry, activity logging, service management, and dashboard API.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const {
  EVENT_TYPES,
  PROCESSING_STATUS,
  isRecipientMatch,
  normalizeAgentId,
  parseMailboxMessages
} = require('../protocol/MessageProtocol');
const MailboxWatcher = require('./MailboxWatcher');
const StateStore = require('./StateStore');
const AgentRegistry = require('./AgentRegistry');
const ActivityLogger = require('./ActivityLogger');
const ServiceController = require('./ServiceController');
const PromptGenerator = require('./PromptGenerator');

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
    this.startTime = Date.now();
    this.lastError = null;

    // Sub-modules
    this.stateStore = new StateStore({
      statePath: config.statePath,
      maxRetries: this.maxRetries
    });

    this.agentRegistry = new AgentRegistry({
      registryPath: config.registryPath,
      configPath: config.configPath
    });

    this.logger = new ActivityLogger({
      logFilePath: config.logFilePath
    });

    this.serviceController = new ServiceController({
      projectRoot: path.resolve(__dirname, '../..'),
      httpPort: this.httpPort
    });

    // Domain services layer
    const { createDomainServices } = require('../domain');
    this.domainServices = createDomainServices({
      mailboxPath: config.mailbox ? config.mailbox.path : null,
      httpPort: this.httpPort,
      stateStore: this.stateStore,
      agentRegistry: this.agentRegistry,
      telemetryMap: this.agentTelemetry,
      logger: this.logger,
      onEvent: (eventType, data) => this.broadcastDashboardEvent(eventType, data)
    });

    // Client connection state
    this.clients = new Map(); // socket -> { agentId, subscriptions: Set, isAlive, connectedAt, workerId }
    this.agentTelemetry = new Map(); // normalizedId -> telemetry state

    // Initialize telemetry from registered agents
    for (const a of this.agentRegistry.getAll()) {
      this.agentTelemetry.set(a.id.toLowerCase(), {
        status: a.enabled ? (a.paused ? 'paused' : 'offline') : 'disabled',
        lastHeartbeat: null,
        lastSeen: null,
        currentTaskId: null,
        currentTaskTitle: null,
        completedCount: 0,
        failedCount: 0,
        lastError: null
      });
    }

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
        this.lastError = err.message;
        console.error(`[EventBroker] MailboxWatcher error: ${err.message}`);
        this.logger.log({
          level: 'ERROR',
          type: 'MAILBOX_ERROR',
          summary: `MailboxWatcher error: ${err.message}`
        });
      });
    }

    this.distPath = path.resolve(__dirname, '../../client/dist');
    this.zrokManager = config.zrokManager || null;
  }

  /**
   * Broadcasts structured real-time events to connected dashboard clients
   */
  broadcastDashboardEvent(eventType, data) {
    const payload = JSON.stringify({
      type: 'DASHBOARD_EVENT',
      eventType,
      data,
      timestamp: new Date().toISOString()
    });

    for (const [ws, state] of this.clients.entries()) {
      if (state.authenticated && state.subscriptions.has('dashboard')) {
        try {
          ws.send(payload);
        } catch (_) {}
      }
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
      this.logger.log({
        level: 'WARN',
        type: 'TASK_RECONCILED',
        summary: `Reconciled ${reconciled} unfinished tasks from previous session.`
      });
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

    // 4. Start Companion HTTP Server for triggers, health, status, API and Control Center UI
    await new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
      this.httpServer.listen(this.httpPort, this.host, () => {
        console.log(`[EventBroker] HTTP API Server running on http://${this.host}:${this.httpPort}`);
        resolve();
      });
      this.httpServer.on('error', reject);
    });

    // Support WebSocket upgrade directly on HTTP server (for remote tunneling via zrok)
    this.httpServer.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    // 5. Start Heartbeat Timer
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), this.heartbeatIntervalMs);

    this.logger.log({
      level: 'INFO',
      type: 'SERVER_STARTED',
      summary: `EventBroker started on WS :${this.port}, HTTP :${this.httpPort}`
    });
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

      if (clientState.authenticated && clientState.agentId) {
        const normId = clientState.agentId.toLowerCase();
        const telem = this.agentTelemetry.get(normId);
        if (telem) {
          telem.status = 'offline';
          telem.lastSeen = new Date().toISOString();
        }

        this.logger.log({
          level: 'INFO',
          type: 'AGENT_DISCONNECTED',
          agentId: clientState.agentId,
          summary: `Agent ${clientState.agentId} disconnected.`
        });

        this.broadcastDashboardEvent('AGENT_STATUS_CHANGE', {
          agentId: clientState.agentId,
          status: 'offline'
        });
      }
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

      // Auto-subscribe ONLY to own canonical name and party code, or dashboard
      const normId = clientState.agentId.toLowerCase();
      clientState.subscriptions.add(normId);

      if (normId === 'dashboard') {
        clientState.subscriptions.add('dashboard');
      }

      // Update telemetry
      let telem = this.agentTelemetry.get(normId);
      if (!telem) {
        telem = {
          status: 'idle',
          lastHeartbeat: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          currentTaskId: null,
          currentTaskTitle: null,
          completedCount: 0,
          failedCount: 0,
          lastError: null
        };
        this.agentTelemetry.set(normId, telem);
      } else {
        telem.status = 'idle';
        telem.lastHeartbeat = new Date().toISOString();
        telem.lastSeen = new Date().toISOString();
      }

      console.log(`[EventBroker] Agent authenticated successfully: ${clientState.agentId}`);
      this.logger.log({
        level: 'INFO',
        type: 'AGENT_CONNECTED',
        agentId: clientState.agentId,
        summary: `Agent ${clientState.agentId} authenticated successfully.`
      });

      this.broadcastDashboardEvent('AGENT_STATUS_CHANGE', {
        agentId: clientState.agentId,
        status: 'idle'
      });

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
          const isOwnParty = (ownId === 'claude' && (norm === 'c' || norm === 'claude')) ||
                             (ownId === 'codex' && (norm === 'x' || norm === 'codex')) ||
                             (ownId === 'antigravity' && (norm === 'a' || norm === 'ag' || norm === 'antigravity')) ||
                             (ownId === 'owner' && (norm === 'h' || norm === 'owner')) ||
                             (ownId === 'dashboard' && norm === 'dashboard') ||
                             (norm === ownId);

          if (isOwnParty) {
            clientState.subscriptions.add(norm);
            granted.push(norm);
          } else {
            console.warn(`[EventBroker] Denied unauthorized subscription to '${ch}' for agent '${clientState.agentId}'`);
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
        const telem = this.agentTelemetry.get(clientState.agentId.toLowerCase());
        if (telem) {
          telem.lastHeartbeat = new Date().toISOString();
          telem.lastSeen = new Date().toISOString();
        }
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

      case EVENT_TYPES.REPLAY_REQUEST: {
        this.handleReplayRequest(ws, clientState, msg);
        break;
      }

      default: {
        console.warn(`[EventBroker] Unknown event type '${msg.type}' from ${clientState.agentId}`);
        ws.send(JSON.stringify({ type: 'ERROR', error: `Unknown event type '${msg.type}'` }));
      }
    }
  }

  /**
   * Periodic heartbeat to detect dead connections and check for expired task leases
   */
  runHeartbeat() {
    // Check client socket liveness
    for (const [ws, state] of this.clients.entries()) {
      if (!state.isAlive) {
        console.warn(`[EventBroker] Dropping dead connection for ${state.agentId || 'unauthenticated'}`);
        ws.terminate();
        this.clients.delete(ws);

        if (state.agentId) {
          const telem = this.agentTelemetry.get(state.agentId.toLowerCase());
          if (telem) {
            telem.status = 'offline';
            telem.lastSeen = new Date().toISOString();
          }
          this.broadcastDashboardEvent('AGENT_STATUS_CHANGE', {
            agentId: state.agentId,
            status: 'offline'
          });
        }
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
        // markFailed clears claimOwner, so capture it first for logging
        const expiredOwner = task.claimOwner;
        console.warn(`[EventBroker] Lease expired for message ${msgId} assigned to ${expiredOwner}`);
        const failResult = this.stateStore.markFailed(msgId, expiredOwner, 'Lease expired without renewal or completion');

        this.logger.log({
          level: 'WARN',
          type: 'LEASE_EXPIRED',
          messageId: msgId,
          agentId: expiredOwner,
          summary: `Lease expired for message ${msgId} assigned to ${expiredOwner}`
        });

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
          this.logger.log({
            level: 'ERROR',
            type: 'DEAD_LETTER',
            messageId: msgId,
            summary: `Message ${msgId} moved to DLQ after lease expiration.`
          });
        }

        this.broadcastDashboardEvent('TASK_LIFECYCLE', {
          messageId: msgId,
          status: task.status,
          task
        });
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
      this.logger.log({
        level: 'WARN',
        type: 'MALFORMED_MESSAGE',
        messageId,
        summary: `Quarantined malformed message heading: ${msg.headerLine || messageId}`
      });
      return 0;
    }

    // Record or retrieve task state in durable store
    const task = this.stateStore.getOrCreateTask(msg);

    // If already completed, ignore
    if (task.status === PROCESSING_STATUS.COMPLETED) {
      console.log(`[EventBroker] Message ${messageId} is already COMPLETED. Skipping duplicate dispatch.`);
      return 0;
    }

    const recipientStr = msg.recipientRaw || msg.recipient || '';

    this.logger.log({
      level: 'INFO',
      type: 'MAILBOX_MESSAGE',
      messageId,
      agentId: msg.sender,
      summary: `Mailbox message ${messageId} from ${msg.sender} addressed to ${recipientStr}`
    });

    let deliveredCount = 0;

    for (const [ws, state] of this.clients.entries()) {
      if (!state.authenticated) continue;

      // DO NOT deliver message back to the sender
      if (state.agentId && msg.sender && state.agentId.toLowerCase() === msg.sender.toLowerCase()) {
        continue;
      }

      // Check if recipient is paused in AgentRegistry
      const agentDef = this.agentRegistry.get(state.agentId);
      if (agentDef && agentDef.paused) {
        console.log(`[EventBroker] Skipping dispatch of ${messageId} to paused agent ${state.agentId}`);
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

          this.logger.log({
            level: 'INFO',
            type: 'NOTIFICATION_DISPATCHED',
            agentId: state.agentId,
            messageId,
            summary: `Dispatched notification ${messageId} to ${state.agentId}`
          });
        } catch (err) {
          console.error(`[EventBroker] Error sending notification to ${state.agentId}: ${err.message}`);
        }
      }
    }

    this.broadcastDashboardEvent('MAILBOX_MESSAGE', {
      messageId,
      sender: msg.sender,
      recipient: recipientStr,
      timestamp: msg.timestamp
    });

    return deliveredCount;
  }

  /**
   * Handles processing acknowledgement from agents
   */
  handleMessageAck(agentId, ack) {
    const { messageId, status, error, workerId, evidence } = ack;
    if (!messageId) return;

    console.log(`[EventBroker] ACK from ${agentId} for ${messageId}: status=${status}${error ? ' error=' + error : ''}`);
    const normId = (agentId || '').toLowerCase();
    const telem = this.agentTelemetry.get(normId);

    if (status === PROCESSING_STATUS.COMPLETED) {
      this.stateStore.markCompleted(messageId, workerId, evidence);
      if (telem) {
        telem.status = 'idle';
        telem.currentTaskId = null;
        telem.currentTaskTitle = null;
        telem.completedCount = (telem.completedCount || 0) + 1;
      }
      this.logger.log({
        level: 'INFO',
        type: 'TASK_COMPLETED',
        agentId,
        messageId,
        summary: `Task ${messageId} completed by ${agentId}`
      });
    } else if (status === PROCESSING_STATUS.CLAIMED || status === PROCESSING_STATUS.LEASE_ACQUIRED) {
      this.stateStore.claimTask(messageId, workerId, this.leaseTimeoutMs);
      if (telem) {
        telem.status = 'working';
        telem.currentTaskId = messageId;
        const t = this.stateStore.getTask(messageId);
        telem.currentTaskTitle = (t && t.sender) ? `Task from ${t.sender}` : messageId;
      }
      this.logger.log({
        level: 'INFO',
        type: 'TASK_CLAIMED',
        agentId,
        messageId,
        summary: `Task ${messageId} claimed by ${agentId} (${workerId || ''})`
      });
    } else if (status === PROCESSING_STATUS.RUNNING) {
      this.stateStore.markRunning(messageId, workerId);
      if (telem) {
        telem.status = 'working';
      }
    } else if (status === 'FAILED' || status === PROCESSING_STATUS.RETRYABLE_FAILED || status === PROCESSING_STATUS.DEAD_LETTER) {
      const failResult = this.stateStore.markFailed(messageId, workerId, error);
      if (telem) {
        telem.status = 'degraded';
        telem.lastError = error;
        telem.failedCount = (telem.failedCount || 0) + 1;
      }
      this.logger.log({
        level: 'ERROR',
        type: 'TASK_FAILED',
        agentId,
        messageId,
        summary: `Task ${messageId} failed: ${error || 'Unknown error'}`
      });

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
        this.logger.log({
          level: 'ERROR',
          type: 'DEAD_LETTER',
          messageId,
          summary: `Task ${messageId} exhausted retries and moved to Dead Letter Queue.`
        });
      }
    }

    const task = this.stateStore.getTask(messageId);
    this.broadcastDashboardEvent('TASK_LIFECYCLE', {
      messageId,
      status,
      agentId,
      task
    });
    this.broadcastDashboardEvent('AGENT_STATUS_CHANGE', {
      agentId,
      status: telem ? telem.status : 'unknown'
    });
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
   * Reads and parses current mailbox content
   */
  async getMailboxMessages() {
    if (!this.watcher) return [];
    try {
      const text = await this.watcher.readMailboxFile();
      return parseMailboxMessages(text);
    } catch (_) {
      return [];
    }
  }

  /**
   * True only for a browser talking to the broker directly on this machine.
   * Requests arriving through the zrok tunnel (or any reverse proxy) carry a
   * non-loopback Host header and/or forwarding headers, so they never receive
   * the auth token and must supply it themselves.
   */
  isLocalBrowserRequest(req) {
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['forwarded']) {
      return false;
    }
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  }

  /**
   * Serves static assets from client/dist
   */
  serveStaticFile(req, res, pathname) {
    if (!fs.existsSync(this.distPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!DOCTYPE html><html><head><title>MailSocketTactics Control Center</title></head><body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:40px;"><h2>MailSocketTactics Control Center Backend Active</h2><p>Frontend assets are building or run via <code>npm run dev</code> on port 5173.</p><p>API snapshot: <a style="color:#38bdf8" href="/api/snapshot">/api/snapshot</a></p></body></html>');
    }

    let filePath = path.join(this.distPath, pathname === '/' ? 'index.html' : pathname);

    // Security check: prevent directory traversal
    if (!filePath.startsWith(this.distPath)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.distPath, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    try {
      if (ext === '.html') {
        let html = fs.readFileSync(filePath, 'utf8');
        if (!this.isLocalBrowserRequest(req)) {
          // Remote (tunnelled) viewers get the UI without the auth token
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        }
        const injection = `<script>window.__MST_CONFIG__ = Object.assign(window.__MST_CONFIG__ || {}, { authToken: ${JSON.stringify(this.authToken)} });</script>`;
        if (html.includes('<head>')) {
          html = html.replace('<head>', `<head>${injection}`);
        } else {
          html = injection + html;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (_) {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  /**
   * Handles HTTP API requests with mandatory authentication
   */
  handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.httpPort}`);

    // CORS headers for Vite dev server support
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Helper for auth verification
    const verifyAuth = () => {
      const authHeader = req.headers['authorization'];
      if (!authHeader) return false;
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      return token === this.authToken;
    };

    // Helper to read JSON request body
    const readJsonBody = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 524288) { // 512 KB
          reject(new Error('Payload too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

    // Read-only data endpoints: a tunnelled/remote viewer must present the token.
    // A browser on this machine keeps working without it.
    if (req.method === 'GET' &&
        (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/status') &&
        url.pathname !== '/api/config' &&
        !this.isLocalBrowserRequest(req) && !verifyAuth()) {
      this.metrics.authFailures++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid Bearer token' }));
    }

    // UI bootstrap configuration. The auth token is only disclosed to a
    // browser on this machine, never to tunnelled/proxied requests.
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const cfg = { wsPort: this.port, httpPort: this.httpPort };
      if (this.isLocalBrowserRequest(req)) cfg.authToken = this.authToken;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(cfg));
    }

    // 1. Existing /health and /status endpoints
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
        zrok: this.zrokManager ? this.zrokManager.getStatus() : { enabled: false, status: 'DISABLED', publicUrl: null },
        activeTasks: Array.from(this.stateStore.tasks.values()).filter(t => t.status === PROCESSING_STATUS.CLAIMED || t.status === PROCESSING_STATUS.RUNNING),
        completedCount: Array.from(this.stateStore.tasks.values()).filter(t => t.status === PROCESSING_STATUS.COMPLETED).length,
        deadLetterCount: this.stateStore.deadLetters.size,
        deadLetters: Array.from(this.stateStore.deadLetters.values()),
        connectedAgents: connected
      }, null, 2));
    }

    // 2. Existing /publish endpoint
    if (req.method === 'POST' && url.pathname === '/publish') {
      if (!verifyAuth()) {
        this.metrics.authFailures++;
        console.warn(`[EventBroker] Unauthorized HTTP /publish attempt from ${req.socket.remoteAddress}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid Bearer token' }));
      }

      readJsonBody().then(async (parsed) => {
        try {
          if (this.watcher) {
            const newFound = await this.watcher.checkNow();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, newMessagesFound: newFound.length }));
          }

          if (parsed.message) {
            this.publishMessage(parsed.message);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 3. Existing /requeue endpoint
    if (req.method === 'POST' && url.pathname === '/requeue') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      readJsonBody().then((parsed) => {
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
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 4. GET /api/snapshot (Comprehensive system snapshot for Dashboard)
    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      this.getMailboxMessages().then((messages) => {
        const connectedMap = new Map();
        for (const [, state] of this.clients.entries()) {
          if (state.authenticated && state.agentId) {
            connectedMap.set(state.agentId.toLowerCase(), state);
          }
        }

        // Aggregate agent registry with dynamic telemetry
        const agentList = this.agentRegistry.getAll().map(a => {
          const norm = a.id.toLowerCase();
          const conn = connectedMap.get(norm);
          const telem = this.agentTelemetry.get(norm) || {};

          let calculatedStatus = 'offline';
          if (!a.enabled) {
            calculatedStatus = 'disabled';
          } else if (a.paused) {
            calculatedStatus = 'paused';
          } else if (conn) {
            calculatedStatus = telem.status === 'working' ? 'working' : (telem.status === 'waiting' ? 'waiting' : (telem.status === 'degraded' ? 'degraded' : 'idle'));
          } else if (telem.status === 'degraded') {
            calculatedStatus = 'degraded';
          }

          return {
            ...a,
            connected: !!conn,
            status: calculatedStatus, // 'connected' | 'idle' | 'working' | 'waiting' | 'degraded' | 'offline' | 'disabled' | 'paused'
            lastHeartbeat: telem.lastHeartbeat || null,
            lastSeen: conn ? conn.connectedAt : telem.lastSeen,
            currentTaskId: telem.currentTaskId || null,
            currentTaskTitle: telem.currentTaskTitle || null,
            completedCount: telem.completedCount || 0,
            failedCount: telem.failedCount || 0,
            lastError: telem.lastError || null
          };
        });

        const allTasks = Array.from(this.stateStore.tasks.values());
        const deadLetters = Array.from(this.stateStore.deadLetters.values());

        const snapshot = {
          timestamp: new Date().toISOString(),
          broker: {
            status: 'UP',
            host: this.host,
            port: this.port,
            httpPort: this.httpPort,
            uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
            startTime: new Date(this.startTime).toISOString(),
            metrics: this.metrics,
            lastError: this.lastError
          },
          zrok: this.zrokManager ? this.zrokManager.getStatus() : { enabled: false, status: 'DISABLED', publicUrl: null },
          services: {
            brokerRunning: true,
            watcherRunning: !!this.watcher,
            watcherPath: this.watcher ? this.watcher.mailboxPath : null,
            stateStoreHealthy: true
          },
          mailbox: {
            path: this.watcher ? this.watcher.mailboxPath : null,
            exists: this.watcher ? fs.existsSync(this.watcher.mailboxPath) : false,
            totalMessages: messages.length,
            messages: messages.slice(-50) // last 50 messages
          },
          agents: agentList,
          tasks: {
            all: allTasks,
            deadLetters: deadLetters,
            pendingCount: allTasks.filter(t => t.status === PROCESSING_STATUS.PENDING).length,
            runningCount: allTasks.filter(t => t.status === PROCESSING_STATUS.RUNNING || t.status === PROCESSING_STATUS.CLAIMED).length,
            completedCount: allTasks.filter(t => t.status === PROCESSING_STATUS.COMPLETED).length,
            failedCount: allTasks.filter(t => t.status === PROCESSING_STATUS.FAILED).length,
            deadLetterCount: deadLetters.length
          },
          usage: this.domainServices ? this.domainServices.usageService.getUsageSummary() : null,
          logs: this.logger.getEvents({ limit: 100 })
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // GET /api/progress (read-only project progress parsed from the markdown docs + AI conversation)
    if (req.method === 'GET' && url.pathname === '/api/progress') {
      try {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('messages') || '25', 10) || 25, 1), 100);
        const progress = this.domainServices.progressService.getProgress({ messageLimit: limit });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(progress));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 5. GET /api/agents (List all registered agents)
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      const agents = this.agentRegistry.getAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ agents }));
    }

    // 6. POST /api/agents (Register new AI agent)
    if (req.method === 'POST' && url.pathname === '/api/agents') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      readJsonBody().then((agentData) => {
        try {
          const registered = this.agentRegistry.register(agentData);
          this.logger.log({
            level: 'INFO',
            type: 'AGENT_REGISTERED',
            agentId: registered.id,
            summary: `New agent '${registered.id}' registered.`
          });
          this.broadcastDashboardEvent('AGENT_REGISTERED', { agent: registered });

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, agent: registered }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 7. PATCH /api/agents/:id (Update agent config e.g. pause, enable, role)
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/agents/')) {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      const agentId = decodeURIComponent(url.pathname.substring('/api/agents/'.length));
      readJsonBody().then((updates) => {
        try {
          const updated = this.agentRegistry.update(agentId, updates);
          this.logger.log({
            level: 'INFO',
            type: 'AGENT_UPDATED',
            agentId: updated.id,
            summary: `Agent '${updated.id}' updated.`
          });
          this.broadcastDashboardEvent('AGENT_STATUS_CHANGE', { agentId: updated.id, updates });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, agent: updated }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 8. POST /api/agents/:id/test (Capability check / connectivity test)
    if (req.method === 'POST' && url.pathname.match(/^\/api\/agents\/([^/]+)\/test$/)) {
      const match = url.pathname.match(/^\/api\/agents\/([^/]+)\/test$/);
      const agentId = decodeURIComponent(match[1]);
      const agentDef = this.agentRegistry.get(agentId);

      if (!agentDef) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Agent not found' }));
      }

      // Check capability based on integrationMethod
      const method = agentDef.integrationMethod;
      let checkResult = { capable: false, status: 'Configuration required', details: '' };

      if (method === 'cli') {
        const cmd = agentDef.cliCommand;
        if (!cmd) {
          checkResult = { capable: false, status: 'Configuration required', details: 'Executable path not configured' };
        } else if (fs.existsSync(cmd)) {
          checkResult = { capable: true, status: 'Verified', details: `Executable found at ${cmd}` };
        } else {
          // Check if available on system PATH
          checkResult = { capable: true, status: 'Assumed valid on system PATH', details: `Command '${cmd}' configured` };
        }
      } else if (method === 'agentapi') {
        checkResult = { capable: true, status: 'AgentAPI Configured', details: 'Language server agentapi protocol configured' };
      } else if (method === 'mcp') {
        checkResult = { capable: false, status: 'Configuration required', details: 'MCP server endpoint connection requires explicit bridge adapter' };
      } else {
        checkResult = { capable: false, status: 'Configuration required', details: 'Custom adapter integration required' };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ agentId, ...checkResult }));
    }

    // 9. POST /api/prompt/generate (Generate team onboarding prompt)
    if (req.method === 'POST' && url.pathname === '/api/prompt/generate') {
      readJsonBody().then((agentConfig) => {
        const prompt = PromptGenerator.generate(agentConfig, {
          mailbox: this.watcher ? { path: this.watcher.mailboxPath } : null
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, prompt }));
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 10. GET /api/tasks (List tasks)
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const allTasks = Array.from(this.stateStore.tasks.values());
      const statusFilter = url.searchParams.get('status');
      const agentFilter = url.searchParams.get('agent');

      let filtered = allTasks;
      if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
      if (agentFilter) filtered = filtered.filter(t => isRecipientMatch(agentFilter, t.recipient));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tasks: filtered }));
    }

    // 11. POST /api/tasks/:id/cancel (Cancel pending task)
    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)) {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
      const taskId = decodeURIComponent(match[1]);
      const task = this.stateStore.getTask(taskId);

      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Task not found' }));
      }

      task.status = 'CANCELLED';
      task.lastError = 'Cancelled by administrator via Control Center';
      this.stateStore.save();

      this.logger.log({
        level: 'WARN',
        type: 'TASK_CANCELLED',
        messageId: taskId,
        summary: `Task ${taskId} cancelled by administrator.`
      });
      this.broadcastDashboardEvent('TASK_LIFECYCLE', { messageId: taskId, status: 'CANCELLED', task });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, taskId }));
    }

    // 11b. GET /api/tasks/:id/history (Get task lifecycle and attempt history)
    const taskHistMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/history$/);
    if (req.method === 'GET' && taskHistMatch) {
      const taskId = decodeURIComponent(taskHistMatch[1]);
      const history = this.domainServices ? this.domainServices.taskService.getTaskHistory(taskId) : { messageId: taskId, events: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(history));
    }

    // 11c. GET /api/usage (AI Usage and Quota Monitoring, Section 11)
    if (req.method === 'GET' && url.pathname === '/api/usage') {
      const summary = this.domainServices ? this.domainServices.usageService.getUsageSummary() : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(summary));
    }

    // 11d. GET /api/notify/status (Email notification configuration status)
    if (req.method === 'GET' && url.pathname === '/api/notify/status') {
      const emailStatus = this.domainServices?.emailService ? this.domainServices.emailService.getStatus() : { enabled: false };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(emailStatus));
    }

    // 11e. POST /api/notify/owner (Send direct notification email to the human owner)
    if (req.method === 'POST' && url.pathname === '/api/notify/owner') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid Bearer token' }));
      }

      readJsonBody().then(async (bodyData) => {
        try {
          const { senderAgent, subject, message, urgency, taskReference } = bodyData;
          if (!subject || !message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Missing required fields: 'subject', 'message'" }));
          }
          if (!this.domainServices?.emailService) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Email service not initialized' }));
          }

          const result = await this.domainServices.emailService.sendOwnerEmail({
            senderAgent: senderAgent || 'Human Owner / Control Center',
            subject,
            message,
            urgency: urgency || 'GENERAL_UPDATE',
            taskReference: taskReference || null
          });

          this.logger.log({
            level: result.status === 'error' ? 'ERROR' : 'INFO',
            type: 'OWNER_EMAIL_DISPATCHED',
            agentId: senderAgent || 'Operator',
            summary: `Owner email dispatched: '${subject}' (${result.status})`
          });

          res.writeHead(result.status === 'error' ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 12. GET /api/mailbox (Get messages parsed from TEAM_MAILBOX.md)
    if (req.method === 'GET' && url.pathname === '/api/mailbox') {
      this.getMailboxMessages().then(messages => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ total: messages.length, messages }));
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 12b. GET /api/mailbox/:id (Get single message by ID)
    const mailboxMsgMatch = url.pathname.match(/^\/api\/mailbox\/([^/]+)$/);
    if (req.method === 'GET' && mailboxMsgMatch) {
      const msgId = decodeURIComponent(mailboxMsgMatch[1]);
      if (this.domainServices) {
        this.domainServices.mailboxService.getMessageById(msgId).then(msg => {
          if (!msg) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Message '${msgId}' not found` }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(msg));
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Domain services not initialized' }));
      }
      return;
    }

    // 13. POST /api/mailbox/post (Post new message to TEAM_MAILBOX.md under mutex)
    if (req.method === 'POST' && url.pathname === '/api/mailbox/post') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      readJsonBody().then(async (bodyData) => {
        const { as, to, body } = bodyData;
        if (!as || !to || !body) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "Missing required fields: 'as', 'to', 'body'" }));
        }

        const postScript = path.resolve(__dirname, '../../scripts/MailboxPostSocket.ps1');
        const mailboxPath = this.watcher ? this.watcher.mailboxPath : '';

        const { spawn } = require('child_process');
        const args = [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', postScript,
          '-As', as,
          '-To', to,
          '-Body', body,
          '-HttpPort', String(this.httpPort)
        ];
        if (mailboxPath) {
          args.push('-Mailbox', mailboxPath);
        }

        const ps = spawn('powershell.exe', args, { shell: false });
        let psOut = '';
        let psErr = '';
        ps.stdout.on('data', d => { psOut += d; });
        ps.stderr.on('data', d => { psErr += d; });

        ps.on('close', (code) => {
          if (code === 0) {
            this.logger.log({
              level: 'INFO',
              type: 'MAILBOX_POST',
              agentId: as,
              summary: `Message posted as ${as} to ${to}`
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, output: psOut.trim() }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `MailboxPost script failed (code ${code}): ${psErr || psOut}` }));
          }
        });
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 14. GET /api/logs (Query activity logs, JSON or CSV)
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const format = url.searchParams.get('format') || 'json';
      const filters = {
        agentId: url.searchParams.get('agent'),
        type: url.searchParams.get('type'),
        level: url.searchParams.get('level'),
        messageId: url.searchParams.get('messageId'),
        limit: url.searchParams.get('limit') || 200
      };

      if (format.toLowerCase() === 'csv') {
        const csv = this.logger.exportCSV(filters);
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="activity_log.csv"'
        });
        return res.end(csv);
      }

      const logs = this.logger.getEvents(filters);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ logs }));
    }

    // 15. POST /api/service/control (Safe allowlisted service management)
    if (req.method === 'POST' && url.pathname === '/api/service/control') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid Bearer token' }));
      }

      readJsonBody().then(async ({ action, target }) => {
        try {
          const result = await this.serviceController.execute(action, target || 'all');
          this.logger.log({
            level: 'INFO',
            type: 'SERVICE_CONTROL',
            summary: `Executed service action '${action}' on '${target || 'all'}'.`
          });
          this.broadcastDashboardEvent('SERVICE_ACTION', { action, target, result });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 16. Fallback: Serve static UI files from client/dist (SPA)
    if (req.method === 'GET') {
      return this.serveStaticFile(req, res, url.pathname);
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

    if (this.zrokManager) {
      try { await this.zrokManager.stop(); } catch (_) {}
    }

    this.stateStore.save();
    this.agentRegistry.save();
    console.log('[EventBroker] Broker stopped cleanly');
  }
}

module.exports = EventBroker;
