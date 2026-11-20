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
const { normalizeProjects, LEGACY_PROJECT_ID, findProjectByMailboxPath } = require('../config/ProjectConfig');

/** Thrown when a request names a project that is not configured */
class UnknownProjectError extends Error {
  constructor(id) {
    super(`Unknown project '${id}'`);
    this.statusCode = 404;
  }
}

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

    // Client connection state (initialized first: domain services reference the telemetry map)
    this.clients = new Map(); // socket -> { agentId, subscriptions: Set, isAlive, connectedAt, workerId, projects }
    this.agentTelemetry = new Map(); // normalizedId -> telemetry state

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

    this.zrokManager = config.zrokManager || null;

    // ─── Projects ───────────────────────────────────────────────
    // Each project has its own mailbox watcher, StateStore, board and progress reader.
    // Agents, usage, email and the activity log are shared across projects.
    const normalized = Array.isArray(config.projectList)
      ? { defaultProject: config.defaultProject || (config.projectList[0] && config.projectList[0].id), projects: config.projectList }
      : normalizeProjects({ projects: config.projects, defaultProject: config.defaultProject, mailbox: config.mailbox });

    let projectDefs = normalized.projects;
    if (projectDefs.length === 0) {
      // No mailbox configured at all: a watcher-less default project still owns task state
      projectDefs = [{
        id: LEGACY_PROJECT_ID, name: 'Default', mailboxPath: null, headerFormat: 'broker',
        mutexName: null, statePath: undefined, boardPath: undefined, docsDir: null, legacy: true
      }];
    }
    this.defaultProjectId = normalized.defaultProject || projectDefs[0].id;

    const { AgentDomainService, UsageDomainService, EmailDomainService } = require('../domain');
    this.projects = new Map(); // projectId -> ProjectContext
    for (const def of projectDefs) {
      const isDefault = def.id === this.defaultProjectId;
      // Broker-level statePath/boardStoragePath (used by tests and legacy callers) apply to the default project
      const resolved = {
        ...def,
        statePath: (isDefault && config.statePath) || def.statePath,
        boardPath: (isDefault && config.boardStoragePath) || def.boardPath
      };
      this.projects.set(def.id, this._createProjectContext(resolved, { isDefault }));
    }

    // Shared (cross-project) domain services
    const defaultCtx = this.projects.get(this.defaultProjectId);
    this.domainServices = {
      ...defaultCtx.services,
      agentService: new AgentDomainService({ agentRegistry: this.agentRegistry, telemetryMap: this.agentTelemetry }),
      usageService: new UsageDomainService({ storagePath: config.usageStoragePath }),
      emailService: new EmailDomainService({
        logger: this.logger,
        getPublicUrl: () => (this.zrokManager ? this.zrokManager.getStatus().publicUrl : null),
        zrokManager: this.zrokManager
      })
    };

    // Backward-compatible aliases: the default project's state store and watcher
    this.stateStore = defaultCtx.stateStore;
    this.watcher = defaultCtx.watcher;

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

    this.distPath = path.resolve(__dirname, '../../client/dist');
  }

  /**
   * Builds the runtime context for one project: StateStore, project-scoped domain
   * services and (when the mailbox exists) a MailboxWatcher.
   * A missing mailbox is fatal only for the default project; other projects start
   * without a watcher and report `exists: false`.
   */
  _createProjectContext(def, { isDefault }) {
    const ctx = {
      id: def.id,
      name: def.name || def.id,
      def,
      isDefault,
      watcher: null,
      watcherError: null
    };

    ctx.stateStore = new StateStore({
      statePath: def.statePath,
      maxRetries: this.maxRetries,
      projectId: def.id
    });

    const { createProjectServices } = require('../domain');
    ctx.services = createProjectServices({
      mailboxPath: def.mailboxPath,
      httpPort: this.httpPort,
      stateStore: ctx.stateStore,
      logger: this.logger,
      projectId: def.id,
      headerFormat: def.headerFormat,
      mutexName: def.mutexName,
      docsDir: def.docsDir,
      boardStoragePath: def.boardPath,
      onEvent: (eventType, data) => this.broadcastDashboardEvent(eventType, { ...(data || {}), project: def.id })
    });

    if (def.mailboxPath) {
      try {
        ctx.watcher = new MailboxWatcher({
          mailboxPath: def.mailboxPath,
          projectId: def.id,
          headerFormat: def.headerFormat,
          debounceIntervalMs: 150,
          pollIntervalMs: def.pollFallbackMs || 10000,
          failFastOnMissing: true
        });
      } catch (err) {
        if (isDefault) throw err;
        ctx.watcherError = err.message;
        console.warn(`[EventBroker] Project '${def.id}' mailbox unavailable, watcher disabled: ${err.message}`);
      }
    }

    if (ctx.watcher) {
      ctx.watcher.on('new_message', (msg) => {
        this.publishMessage(msg, ctx);
      });

      ctx.watcher.on('error', (err) => {
        this.lastError = `[${def.id}] ${err.message}`;
        console.error(`[EventBroker] MailboxWatcher error (${def.id}): ${err.message}`);
        this.logger.log({
          level: 'ERROR',
          type: 'MAILBOX_ERROR',
          project: def.id,
          summary: `MailboxWatcher error: ${err.message}`
        });
      });
    }

    return ctx;
  }

  /**
   * Resolves a project id (or null/undefined for the default project) to its context.
   * @throws {UnknownProjectError}
   */
  getProject(projectId) {
    const id = projectId ? String(projectId).trim().toLowerCase() : this.defaultProjectId;
    const ctx = this.projects.get(id);
    if (!ctx) throw new UnknownProjectError(projectId);
    return ctx;
  }

  /** Resolves the project named in a JSON request body, falling back to the query-scoped one */
  _projectFromBody(body, fallback) {
    return body && typeof body === 'object' && body.project ? this.getProject(body.project) : fallback;
  }

  /** Public summary of every configured project (for /api/projects and the dashboard picker) */
  listProjects() {
    return Array.from(this.projects.values()).map(ctx => {
      const tasks = Array.from(ctx.stateStore.tasks.values());
      return {
        id: ctx.id,
        name: ctx.name,
        isDefault: ctx.isDefault,
        mailboxPath: ctx.def.mailboxPath,
        exists: ctx.def.mailboxPath ? fs.existsSync(ctx.def.mailboxPath) : false,
        headerFormat: ctx.def.headerFormat || 'broker',
        watcherRunning: !!(ctx.watcher && ctx.watcher.isWatching),
        watcherError: ctx.watcherError,
        taskCounts: {
          pending: tasks.filter(t => t.status === PROCESSING_STATUS.PENDING).length,
          running: tasks.filter(t => t.status === PROCESSING_STATUS.RUNNING || t.status === PROCESSING_STATUS.CLAIMED).length,
          completed: tasks.filter(t => t.status === PROCESSING_STATUS.COMPLETED).length,
          deadLetters: ctx.stateStore.deadLetters.size
        }
      };
    });
  }

  /** Number of authenticated sockets currently bound to an agent id */
  _countAgentSockets(normId, exceptWs = null) {
    let n = 0;
    for (const [ws, st] of this.clients.entries()) {
      if (ws !== exceptWs && st.authenticated && st.agentId && st.agentId.toLowerCase() === normId) n++;
    }
    return n;
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
    for (const ctx of this.projects.values()) {
      // 1. Reconcile crashed tasks from previous broker run
      const reconciled = ctx.stateStore.reconcileCrashedTasks();
      if (reconciled > 0) {
        console.log(`[EventBroker] [${ctx.id}] Reconciled ${reconciled} unfinished tasks from previous session.`);
        this.logger.log({
          level: 'WARN',
          type: 'TASK_RECONCILED',
          project: ctx.id,
          summary: `Reconciled ${reconciled} unfinished tasks from previous session.`
        });
      }

      // 2. Initialize MailboxWatcher baseline if configured (fatal only for the default project)
      if (ctx.watcher) {
        try {
          await ctx.watcher.initBaseline();
          ctx.watcher.start();
          console.log(`[EventBroker] Watching project '${ctx.id}' mailbox: ${ctx.def.mailboxPath}`);
        } catch (err) {
          if (ctx.isDefault) throw err;
          ctx.watcherError = err.message;
          ctx.watcher.stop();
          console.warn(`[EventBroker] Project '${ctx.id}' watcher failed to start: ${err.message}`);
        }
      }
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
        // Several sessions may share one agent id (e.g. two Claude windows each running
        // an MCP server). The agent is offline only when its last socket closes.
        if (this._countAgentSockets(normId) > 0) return;

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
      clientState.instanceId = msg.instanceId ? String(msg.instanceId).slice(0, 128) : null;

      // Optional project scope: a client that lists projects only receives their notifications
      if (Array.isArray(msg.projects) && msg.projects.length > 0) {
        clientState.projects = new Set(msg.projects.map(p => String(p).toLowerCase()).filter(p => this.projects.has(p)));
      } else {
        clientState.projects = null; // all projects
      }

      // Auto-subscribe ONLY to own canonical name and party code, or dashboard
      const normId = clientState.agentId.toLowerCase();

      // Several live sessions may legitimately share an agent id (e.g. two Claude windows,
      // each with its own MCP server). Kicking the older socket made the two clients evict
      // each other on every reconnect (connect/disconnect loop every few seconds), so only a
      // socket from the SAME client instance (same instanceId) is treated as stale.
      if (clientState.instanceId) {
        for (const [otherWs, otherState] of this.clients.entries()) {
          if (otherWs !== ws && otherState.authenticated && otherState.instanceId === clientState.instanceId &&
              otherState.agentId && otherState.agentId.toLowerCase() === normId) {
            try {
              otherWs.terminate();
            } catch (_) {}
            this.clients.delete(otherWs);
          }
        }
      }
      const alreadyOnline = this._countAgentSockets(normId, ws) > 0;

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
        // Another live session of this agent may be mid-task: keep its status
        if (!alreadyOnline || telem.status === 'offline') telem.status = 'idle';
        telem.lastHeartbeat = new Date().toISOString();
        telem.lastSeen = new Date().toISOString();
      }

      const sessionCount = this._countAgentSockets(normId);
      console.log(`[EventBroker] Agent authenticated successfully: ${clientState.agentId}` +
        (sessionCount > 1 ? ` (${sessionCount} concurrent sessions)` : ''));
      this.logger.log({
        level: 'INFO',
        type: 'AGENT_CONNECTED',
        agentId: clientState.agentId,
        summary: `Agent ${clientState.agentId} authenticated successfully.`
      });

      this.broadcastDashboardEvent('AGENT_STATUS_CHANGE', {
        agentId: clientState.agentId,
        status: telem.status
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

      // Task operations take an optional `project` (default project when omitted)
      case EVENT_TYPES.MESSAGE_ACK:
      case EVENT_TYPES.LEASE_RENEW:
      case EVENT_TYPES.REPLAY_REQUEST: {
        let ctx;
        try {
          ctx = this.getProject(msg.project);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ERROR', error: err.message, messageId: msg.messageId || null }));
          break;
        }
        if (msg.type === EVENT_TYPES.MESSAGE_ACK) {
          this.metrics.acksReceived++;
          this.handleMessageAck(clientState.agentId, msg, ctx);
        } else if (msg.type === EVENT_TYPES.LEASE_RENEW) {
          this.metrics.renewalsReceived++;
          this.handleLeaseRenew(ws, clientState, msg, ctx);
        } else {
          this.handleReplayRequest(ws, clientState, msg, ctx);
        }
        break;
      }

      case 'AGENT_STATUS_UPDATE': {
        const normId = clientState.agentId.toLowerCase();
        let telem = this.agentTelemetry.get(normId);
        if (telem) {
          if (msg.status) telem.status = msg.status;
          if (msg.currentTaskId !== undefined) telem.currentTaskId = msg.currentTaskId;
          if (msg.currentTaskTitle !== undefined) telem.currentTaskTitle = msg.currentTaskTitle;
          telem.lastHeartbeat = new Date().toISOString();
          telem.lastSeen = new Date().toISOString();
        }
        this.broadcastDashboardEvent('AGENT_STATUS_CHANGE', {
          agentId: clientState.agentId,
          status: msg.status || 'idle',
          currentTaskId: msg.currentTaskId,
          currentTaskTitle: msg.currentTaskTitle
        });
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

        if (state.agentId && this._countAgentSockets(state.agentId.toLowerCase()) === 0) {
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

    // Check for expired task leases in every project's StateStore
    const now = Date.now();
    for (const ctx of this.projects.values()) {
      for (const [msgId, task] of ctx.stateStore.tasks.entries()) {
        if ((task.status === PROCESSING_STATUS.CLAIMED || task.status === PROCESSING_STATUS.RUNNING) &&
            task.leaseExpiresAt > 0 && now > task.leaseExpiresAt) {
          // markFailed clears claimOwner, so capture it first for logging
          const expiredOwner = task.claimOwner;
          console.warn(`[EventBroker] [${ctx.id}] Lease expired for message ${msgId} assigned to ${expiredOwner}`);
          const failResult = ctx.stateStore.markFailed(msgId, expiredOwner, 'Lease expired without renewal or completion');

          this.logger.log({
            level: 'WARN',
            type: 'LEASE_EXPIRED',
            messageId: msgId,
            agentId: expiredOwner,
            project: ctx.id,
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
            }, ctx);
          } else {
            this.metrics.deadLettersCount++;
            console.error(`[EventBroker] [DEAD LETTER] Message ${msgId} moved to DLQ: Lease expired after max retries`);
            this.logger.log({
              level: 'ERROR',
              type: 'DEAD_LETTER',
              messageId: msgId,
              project: ctx.id,
              summary: `Message ${msgId} moved to DLQ after lease expiration.`
            });
          }

          this.broadcastDashboardEvent('TASK_LIFECYCLE', {
            messageId: msgId,
            status: task.status,
            project: ctx.id,
            task
          });
        }
      }
    }
  }

  /**
   * Publishes message notification strictly to intended recipients
   */
  publishMessage(msg, projectCtx = null) {
    const messageId = msg.messageId || msg.id;
    if (!messageId) return 0;

    // Resolve the owning project (explicit context > msg.project > default project)
    let ctx = projectCtx;
    if (!ctx) {
      try {
        ctx = this.getProject(msg.project);
      } catch (err) {
        console.warn(`[EventBroker] Dropping message ${messageId}: ${err.message}`);
        return 0;
      }
    }
    const store = ctx.stateStore;

    // Check if malformed
    if (msg.isMalformed) {
      console.warn(`[EventBroker] Quarantining malformed message heading: ${msg.headerLine || messageId}`);
      store.markFailed(messageId, null, 'Malformed message format', true);
      this.logger.log({
        level: 'WARN',
        type: 'MALFORMED_MESSAGE',
        messageId,
        project: ctx.id,
        summary: `Quarantined malformed message heading: ${msg.headerLine || messageId}`
      });
      return 0;
    }

    // Record or retrieve task state in durable store
    const task = store.getOrCreateTask(msg);

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
      project: ctx.id,
      summary: `Mailbox message ${messageId} from ${msg.sender} addressed to ${recipientStr}`
    });

    let deliveredCount = 0;
    // Tel-format senders are party codes ('C'), so compare canonical ids
    const senderNorm = msg.sender ? String(normalizeAgentId(msg.sender)).toLowerCase() : null;

    for (const [ws, state] of this.clients.entries()) {
      if (!state.authenticated) continue;

      // Clients that declared a project scope only hear about their projects
      if (state.projects && !state.projects.has(ctx.id)) continue;

      // DO NOT deliver message back to the sender
      if (state.agentId && senderNorm && state.agentId.toLowerCase() === senderNorm) {
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
          mailboxPath: msg.mailboxPath || ctx.def.mailboxPath,
          project: ctx.id,
          projectName: ctx.name
        };

        try {
          ws.send(JSON.stringify(payload));
          deliveredCount++;
          this.metrics.notificationsSent++;
          console.log(`[EventBroker] [${ctx.id}] Dispatched notification ${messageId} to ${state.agentId}`);

          this.logger.log({
            level: 'INFO',
            type: 'NOTIFICATION_DISPATCHED',
            agentId: state.agentId,
            messageId,
            project: ctx.id,
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
      timestamp: msg.timestamp,
      project: ctx.id
    });

    return deliveredCount;
  }

  /**
   * Handles processing acknowledgement from agents
   */
  handleMessageAck(agentId, ack, projectCtx = null) {
    const { messageId, status, error, workerId, evidence } = ack;
    if (!messageId) return;
    const ctx = projectCtx || this.getProject(ack.project);
    const store = ctx.stateStore;

    console.log(`[EventBroker] ACK from ${agentId} for ${messageId}: status=${status}${error ? ' error=' + error : ''}`);
    const normId = (agentId || '').toLowerCase();
    const telem = this.agentTelemetry.get(normId);

    if (status === PROCESSING_STATUS.COMPLETED) {
      store.markCompleted(messageId, workerId, evidence);
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
        project: ctx.id,
        summary: `Task ${messageId} completed by ${agentId}`
      });
    } else if (status === PROCESSING_STATUS.CLAIMED || status === PROCESSING_STATUS.LEASE_ACQUIRED) {
      store.claimTask(messageId, workerId, this.leaseTimeoutMs);
      if (telem) {
        telem.status = 'working';
        telem.currentTaskId = messageId;
        const t = store.getTask(messageId);
        telem.currentTaskTitle = (t && t.sender) ? `Task from ${t.sender}` : messageId;
      }
      this.logger.log({
        level: 'INFO',
        type: 'TASK_CLAIMED',
        agentId,
        messageId,
        project: ctx.id,
        summary: `Task ${messageId} claimed by ${agentId} (${workerId || ''})`
      });
    } else if (status === PROCESSING_STATUS.RUNNING) {
      store.markRunning(messageId, workerId);
      if (telem) {
        telem.status = 'working';
      }
    } else if (status === 'FAILED' || status === PROCESSING_STATUS.RETRYABLE_FAILED || status === PROCESSING_STATUS.DEAD_LETTER) {
      const failResult = store.markFailed(messageId, workerId, error);
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
        project: ctx.id,
        summary: `Task ${messageId} failed: ${error || 'Unknown error'}`
      });

      if (failResult.retry) {
        this.metrics.retriesTriggered++;
        const delay = this.backoffInitialMs * Math.pow(2, failResult.attempt - 1);
        console.log(`[EventBroker] Scheduling retry for ${messageId} in ${delay}ms`);
        setTimeout(() => {
          const t = store.getTask(messageId);
          if (t && t.status !== PROCESSING_STATUS.COMPLETED) {
            this.publishMessage({
              messageId: t.messageId,
              sender: t.sender,
              recipientRaw: t.recipient,
              _isRetry: true
            }, ctx);
          }
        }, delay);
      } else {
        this.metrics.deadLettersCount++;
        this.logger.log({
          level: 'ERROR',
          type: 'DEAD_LETTER',
          messageId,
          project: ctx.id,
          summary: `Task ${messageId} exhausted retries and moved to Dead Letter Queue.`
        });
      }
    }

    const task = store.getTask(messageId);
    this.broadcastDashboardEvent('TASK_LIFECYCLE', {
      messageId,
      status,
      agentId,
      project: ctx.id,
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
  handleLeaseRenew(ws, clientState, msg, projectCtx = null) {
    const { messageId, workerId, extendMs } = msg;
    const store = (projectCtx || this.getProject(msg.project)).stateStore;
    const renewTime = extendMs || 60000;
    const renewed = store.renewLease(messageId, workerId, renewTime);

    if (renewed) {
      const task = store.getTask(messageId);
      ws.send(JSON.stringify({
        type: EVENT_TYPES.LEASE_RENEW_ACK,
        success: true,
        messageId,
        project: msg.project || this.defaultProjectId,
        newExpiresAt: task.leaseExpiresAt
      }));
    } else {
      ws.send(JSON.stringify({
        type: EVENT_TYPES.LEASE_RENEW_ACK,
        success: false,
        messageId,
        project: msg.project || this.defaultProjectId,
        error: 'Lease renewal failed: worker not owner or task not active'
      }));
    }
  }

  /**
   * Handles replay request for catch-up on reconnect
   */
  async handleReplayRequest(ws, clientState, req, projectCtx = null) {
    const ctx = projectCtx || this.getProject(req.project);
    const store = ctx.stateStore;
    if (!ctx.watcher) return;
    try {
      const text = await ctx.watcher.readMailboxFile();
      if (!text) return;

      const messages = parseMailboxMessages(text, { format: ctx.def.headerFormat });
      const since = req.sinceNumber || 0;

      for (const msg of messages) {
        if (msg.number > since && isRecipientMatch(clientState.agentId, msg.recipientRaw)) {
          if (!store.isCompleted(msg.id)) {
            ws.send(JSON.stringify({
              type: EVENT_TYPES.MAILBOX_MESSAGE_NOTIFY,
              messageId: msg.id,
              party: msg.party,
              number: msg.number,
              sender: msg.sender,
              recipientRaw: msg.recipientRaw,
              timestamp: msg.timestamp,
              mailboxPath: ctx.watcher.mailboxPath,
              project: ctx.id,
              projectName: ctx.name,
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
  async getMailboxMessages(projectCtx = null) {
    const ctx = projectCtx || this.getProject();
    if (!ctx.watcher) return [];
    try {
      const text = await ctx.watcher.readMailboxFile();
      return parseMailboxMessages(text, { format: ctx.def.headerFormat }).map(m => ({ ...m, project: ctx.id }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Checks if an agent is currently connected and authenticated
   */
  isAgentConnected(agentId) {
    if (!agentId) return false;
    const norm = agentId.toLowerCase();
    for (const [, state] of this.clients.entries()) {
      if (state.authenticated && state.agentId && state.agentId.toLowerCase() === norm) {
        return true;
      }
    }
    return false;
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

    // Project scope: ?project=<id> (default project when omitted). POST bodies may
    // also carry "project", which overrides the query parameter.
    let ctx;
    try {
      ctx = this.getProject(url.searchParams.get('project'));
    } catch (err) {
      // Bootstrap endpoints must keep working when a client remembers a removed project
      if (url.pathname === '/api/config' || url.pathname === '/api/projects' || !url.pathname.startsWith('/api/') && url.pathname !== '/publish' && url.pathname !== '/requeue' && url.pathname !== '/status' && url.pathname !== '/health') {
        ctx = this.getProject();
      } else {
        res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message, projects: Array.from(this.projects.keys()) }));
      }
    }

    // GET /api/projects (configured projects for the dashboard picker / MCP clients)
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ defaultProject: this.defaultProjectId, projects: this.listProjects() }));
    }

    // UI bootstrap configuration. The auth token is only disclosed to a
    // browser on this machine, never to tunnelled/proxied requests.
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const cfg = { wsPort: this.port, httpPort: this.httpPort, defaultProject: this.defaultProjectId };
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
        activeTasks: Array.from(ctx.stateStore.tasks.values()).filter(t => t.status === PROCESSING_STATUS.CLAIMED || t.status === PROCESSING_STATUS.RUNNING),
        completedCount: Array.from(ctx.stateStore.tasks.values()).filter(t => t.status === PROCESSING_STATUS.COMPLETED).length,
        deadLetterCount: ctx.stateStore.deadLetters.size,
        deadLetters: Array.from(ctx.stateStore.deadLetters.values()),
        connectedAgents: connected,
        project: ctx.id,
        defaultProject: this.defaultProjectId,
        projects: this.listProjects()
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
        ctx = this._projectFromBody(parsed, ctx);
        try {
          // Which project(s) to re-scan: explicit project > matching mailbox path > every watched project
          const explicit = parsed.project || url.searchParams.get('project') || (parsed.message && parsed.message.project);
          let targets;
          if (explicit) {
            targets = [this.getProject(explicit)];
          } else if (parsed.message && parsed.message.mailboxPath) {
            const def = findProjectByMailboxPath(Array.from(this.projects.values()).map(c => c.def), parsed.message.mailboxPath);
            targets = def ? [this.projects.get(def.id)] : Array.from(this.projects.values());
          } else {
            targets = Array.from(this.projects.values());
          }

          const watched = targets.filter(t => t.watcher);
          if (watched.length > 0) {
            let newFound = 0;
            for (const t of watched) {
              newFound += (await t.watcher.checkNow()).length;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, newMessagesFound: newFound, projects: watched.map(t => t.id) }));
          }

          if (parsed.message) {
            this.publishMessage(parsed.message, targets[0] || ctx);
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
        ctx = this._projectFromBody(parsed, ctx);
        const requeued = ctx.stateStore.requeue(parsed.messageId);
        if (requeued) {
          const t = ctx.stateStore.getTask(parsed.messageId);
          this.publishMessage({
            messageId: t.messageId,
            sender: t.sender,
            recipientRaw: t.recipient,
            _isRetry: true
          }, ctx);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, messageId: parsed.messageId, project: ctx.id }));
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
      this.getMailboxMessages(ctx).then((messages) => {
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

        const allTasks = Array.from(ctx.stateStore.tasks.values());
        const deadLetters = Array.from(ctx.stateStore.deadLetters.values());

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
          project: { id: ctx.id, name: ctx.name, isDefault: ctx.isDefault, headerFormat: ctx.def.headerFormat || 'broker' },
          defaultProject: this.defaultProjectId,
          projects: this.listProjects(),
          services: {
            brokerRunning: true,
            watcherRunning: !!ctx.watcher,
            watcherPath: ctx.watcher ? ctx.watcher.mailboxPath : null,
            watcherError: ctx.watcherError,
            stateStoreHealthy: true
          },
          mailbox: {
            path: ctx.def.mailboxPath || null,
            exists: ctx.def.mailboxPath ? fs.existsSync(ctx.def.mailboxPath) : false,
            headerFormat: ctx.def.headerFormat || 'broker',
            mutexName: ctx.def.mutexName || null,
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
          board: ctx.services.boardService.getBoard(),
          logs: this.logger.getEvents({ limit: 100, project: ctx.id })
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
        const progress = ctx.services.progressService.getProgress({ messageLimit: limit });
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
        const isOnline = this.isAgentConnected(agentId);
        const mcpScript = path.resolve(__dirname, '../mcp/McpServer.js');
        if (isOnline) {
          checkResult = { capable: true, status: 'Connected via MCP', details: `Active MCP session running for ${agentId}` };
        } else if (fs.existsSync(mcpScript)) {
          checkResult = { capable: true, status: 'MCP Ready', details: `MCP stdio server available at ${mcpScript} (--agent ${agentId})` };
        } else {
          checkResult = { capable: false, status: 'Configuration required', details: 'McpServer.js not found' };
        }
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
          mailbox: ctx.def.mailboxPath ? { path: ctx.def.mailboxPath, mutexName: ctx.def.mutexName } : null
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
      const allTasks = Array.from(ctx.stateStore.tasks.values());
      const statusFilter = url.searchParams.get('status');
      const agentFilter = url.searchParams.get('agent');

      let filtered = allTasks;
      if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
      if (agentFilter) filtered = filtered.filter(t => isRecipientMatch(agentFilter, t.recipient));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ project: ctx.id, tasks: filtered }));
    }

    // 11. POST /api/tasks/:id/cancel (Cancel pending task)
    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)) {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
      const taskId = decodeURIComponent(match[1]);
      const task = ctx.stateStore.getTask(taskId);

      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Task not found' }));
      }

      task.status = 'CANCELLED';
      task.lastError = 'Cancelled by administrator via Control Center';
      ctx.stateStore.save();

      this.logger.log({
        level: 'WARN',
        type: 'TASK_CANCELLED',
        messageId: taskId,
        project: ctx.id,
        summary: `Task ${taskId} cancelled by administrator.`
      });
      this.broadcastDashboardEvent('TASK_LIFECYCLE', { messageId: taskId, status: 'CANCELLED', project: ctx.id, task });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, taskId, project: ctx.id }));
    }

    // 11b. GET /api/tasks/:id/history (Get task lifecycle and attempt history)
    const taskHistMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/history$/);
    if (req.method === 'GET' && taskHistMatch) {
      const taskId = decodeURIComponent(taskHistMatch[1]);
      const history = ctx.services.taskService.getTaskHistory(taskId);
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
        ctx = this._projectFromBody(bodyData, ctx);
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
      this.getMailboxMessages(ctx).then(messages => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project: ctx.id, total: messages.length, messages }));
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
        ctx.services.mailboxService.getMessageById(msgId).then(msg => {
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
        ctx = this._projectFromBody(bodyData, ctx);
        const { as, to, body } = bodyData;
        if (!as || !to || !body) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "Missing required fields: 'as', 'to', 'body'" }));
        }

        try {
          const result = await ctx.services.mailboxService.postMessage({ as, to, body });
          this.logger.log({
            level: 'INFO',
            type: 'MAILBOX_POST',
            agentId: as,
            messageId: result.messageId,
            project: ctx.id,
            summary: `Message posted as ${as} to ${to}`
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
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

    // 14. GET /api/logs (Query activity logs, JSON or CSV)
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const format = url.searchParams.get('format') || 'json';
      const filters = {
        agentId: url.searchParams.get('agent'),
        type: url.searchParams.get('type'),
        level: url.searchParams.get('level'),
        messageId: url.searchParams.get('messageId'),
        project: url.searchParams.get('project') || undefined,
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

    // 16. GET /api/board (Full board snapshot)
    if (req.method === 'GET' && url.pathname === '/api/board') {
      const board = ctx.services.boardService.getBoard();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(board));
    }

    // 16b. GET /api/board/tasks (Filtered task list)
    if (req.method === 'GET' && url.pathname === '/api/board/tasks') {
      const filters = {
        column: url.searchParams.get('column') || undefined,
        assignee: url.searchParams.get('assignee') || undefined,
        priority: url.searchParams.get('priority') || undefined
      };
      const tasks = ctx.services.boardService.getTasks(filters);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tasks }));
    }

    // 16c. POST /api/board/tasks (Create new board task)
    if (req.method === 'POST' && url.pathname === '/api/board/tasks') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      readJsonBody().then((body) => {
        ctx = this._projectFromBody(body, ctx);
        try {
          const task = ctx.services.boardService.createTask(body);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, task }));
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

    // 16d. POST /api/board/tasks/bulk (Create multiple tasks at once)
    if (req.method === 'POST' && url.pathname === '/api/board/tasks/bulk') {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      readJsonBody().then((body) => {
        ctx = this._projectFromBody(body, ctx);
        try {
          const tasks = ctx.services.boardService.createBulk(
            body.tasks || [],
            body.createdBy || 'Lead'
          );
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, created: tasks.length, tasks }));
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

    // 16e. PATCH /api/board/tasks/:id (Update task fields)
    const boardTaskPatchMatch = url.pathname.match(/^\/api\/board\/tasks\/([^/]+)$/);
    if (req.method === 'PATCH' && boardTaskPatchMatch) {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      const taskId = decodeURIComponent(boardTaskPatchMatch[1]);
      readJsonBody().then((body) => {
        ctx = this._projectFromBody(body, ctx);
        try {
          const task = ctx.services.boardService.updateTask(taskId, body, body.updatedBy || 'Dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, task }));
        } catch (err) {
          res.writeHead(err.message.includes('not found') ? 404 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 16f. POST /api/board/tasks/:id/move (Move task to another column)
    const boardTaskMoveMatch = url.pathname.match(/^\/api\/board\/tasks\/([^/]+)\/move$/);
    if (req.method === 'POST' && boardTaskMoveMatch) {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      const taskId = decodeURIComponent(boardTaskMoveMatch[1]);
      readJsonBody().then((body) => {
        ctx = this._projectFromBody(body, ctx);
        try {
          const task = ctx.services.boardService.moveTask(taskId, body.column, body.movedBy || 'Dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, task }));
        } catch (err) {
          res.writeHead(err.message.includes('not found') ? 404 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 16g. POST /api/board/tasks/:id/comment (Add comment to a task)
    const boardCommentMatch = url.pathname.match(/^\/api\/board\/tasks\/([^/]+)\/comment$/);
    if (req.method === 'POST' && boardCommentMatch) {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      const taskId = decodeURIComponent(boardCommentMatch[1]);
      readJsonBody().then((body) => {
        ctx = this._projectFromBody(body, ctx);
        try {
          const comment = ctx.services.boardService.addComment(taskId, body.text, body.author || 'Dashboard');
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, comment }));
        } catch (err) {
          res.writeHead(err.message.includes('not found') ? 404 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }).catch(err => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // 16h. DELETE /api/board/tasks/:id (Delete a board task)
    const boardDeleteMatch = url.pathname.match(/^\/api\/board\/tasks\/([^/]+)$/);
    if (req.method === 'DELETE' && boardDeleteMatch) {
      if (!verifyAuth()) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      const taskId = decodeURIComponent(boardDeleteMatch[1]);
      try {
        const removed = ctx.services.boardService.deleteTask(taskId, 'Dashboard');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, task: removed }));
      } catch (err) {
        res.writeHead(err.message.includes('not found') ? 404 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 17. Fallback: Serve static UI files from client/dist (SPA)
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

    for (const ctx of this.projects.values()) {
      if (ctx.watcher) ctx.watcher.stop();
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

    for (const ctx of this.projects.values()) {
      ctx.stateStore.save();
    }
    this.agentRegistry.save();
    console.log('[EventBroker] Broker stopped cleanly');
  }
}

module.exports = EventBroker;
