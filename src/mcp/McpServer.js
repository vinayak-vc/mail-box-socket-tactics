/**
 * McpServer.js
 * Model Context Protocol (MCP) server for MailSocketTactics.
 * Exposes authorized mailbox and task management tools to AI desktop applications
 * (Claude Desktop, Codex Desktop, Antigravity Desktop).
 * 
 * Supports JSON-RPC 2.0 over standard I/O (stdio).
 * Binds agent identity at process start to prevent identity spoofing.
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const crypto = require('crypto');
const { createDomainServices, createProjectServices } = require('../domain');
const StateStore = require('../broker/StateStore');
const AgentRegistry = require('../broker/AgentRegistry');
const ActivityLogger = require('../broker/ActivityLogger');
const { normalizeAgentId, EVENT_TYPES } = require('../protocol/MessageProtocol');
const { normalizeProjects, readConfigFile, findProjectByMailboxPath, LEGACY_PROJECT_ID } = require('../config/ProjectConfig');

/** Project selector that means "every configured project" (read-only tools only) */
const ALL_PROJECTS = new Set(['*', 'all']);

/** Shared JSON schema for the optional `project` tool argument */
const PROJECT_PROP = {
  type: 'string',
  description: 'Project id (see list_projects). Defaults to this server\'s default project (MAILBOX_PROJECT / MAILBOX_PATH).'
};
const PROJECT_PROP_MULTI = {
  type: 'string',
  description: 'Project id (see list_projects), or "all" to cover every configured project. Defaults to this server\'s default project.'
};

class McpServer {
  constructor(options = {}) {
    this.agentId = options.agentId || process.env.MCP_AGENT_ID || this._parseAgentArg() || 'Claude';
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '../..');
    this.configPath = options.configPath || path.resolve(this.projectRoot, 'config/default.json');
    // Unique per process: lets the broker replace this process's own stale socket on reconnect
    // without evicting other sessions of the same agent.
    this.instanceId = `${this.agentId}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

    // ─── Projects ───────────────────────────────────────────────
    // Default project precedence: options.project / MAILBOX_PROJECT > options.mailboxPath /
    // MAILBOX_PATH (matched against configured projects, else an ad-hoc project) > config defaultProject.
    this.projectDefs = new Map();
    let cfgDefault = null;
    try {
      const normalized = normalizeProjects(readConfigFile(this.configPath), { root: this.projectRoot });
      for (const def of normalized.projects) this.projectDefs.set(def.id, def);
      cfgDefault = normalized.defaultProject;
    } catch (err) {
      // stdout is reserved for JSON-RPC; config problems go to stderr and the server keeps working
      process.stderr.write(`[McpServer] Ignoring invalid project config: ${err.message}\n`);
    }

    const requestedProject = options.project || process.env.MAILBOX_PROJECT || null;
    const requestedPath = options.mailboxPath || process.env.MAILBOX_PATH || null;

    if (requestedProject) {
      const id = String(requestedProject).trim().toLowerCase();
      if (!this.projectDefs.has(id)) {
        throw new Error(`MAILBOX_PROJECT '${requestedProject}' is not configured (known: ${[...this.projectDefs.keys()].join(', ') || 'none'})`);
      }
      this.defaultProjectId = id;
    } else if (requestedPath) {
      const match = findProjectByMailboxPath([...this.projectDefs.values()], requestedPath);
      this.defaultProjectId = match ? match.id : this._registerAdHocProject(requestedPath, options);
    } else if (cfgDefault) {
      this.defaultProjectId = cfgDefault;
    } else {
      // No config at all: legacy OneBossFight location
      this.defaultProjectId = this._registerAdHocProject(path.resolve(this.projectRoot, '../OneBossFight/Documentation/TEAM_MAILBOX.md'), options);
    }

    const defaultDef = this.projectDefs.get(this.defaultProjectId);
    this.mailboxPath = defaultDef.mailboxPath;

    // Initialize domain services
    this.stateStore = options.stateStore || new StateStore({
      statePath: options.statePath || defaultDef.statePath,
      projectId: defaultDef.id
    });

    this.agentRegistry = options.agentRegistry || new AgentRegistry({
      registryPath: options.registryPath || path.resolve(this.projectRoot, 'data/agent_registry.json'),
      configPath: options.configPath || path.resolve(this.projectRoot, 'config/default.json')
    });

    this.logger = options.logger || new ActivityLogger({
      logFilePath: options.logFilePath || path.resolve(this.projectRoot, 'data/activity.log')
    });

    this.services = options.services || createDomainServices({
      mailboxPath: this.mailboxPath,
      stateStore: this.stateStore,
      agentRegistry: this.agentRegistry,
      logger: this.logger,
      projectId: defaultDef.id,
      headerFormat: defaultDef.headerFormat,
      mutexName: defaultDef.mutexName,
      docsDir: defaultDef.docsDir,
      boardStoragePath: defaultDef.boardPath
    });

    // Per-project runtime contexts (created lazily); the default one reuses the services above
    this._projectCtx = new Map();
    this._projectCtx.set(defaultDef.id, {
      id: defaultDef.id,
      name: defaultDef.name,
      def: defaultDef,
      stateStore: this.stateStore,
      services: this.services
    });

    // Validate and bind identity
    this.canonicalAgent = this._resolveIdentity(this.agentId);

    // Broker WebSocket bridge state
    this.brokerConfig = this._loadBrokerConfig(options);
    this._ws = null;
    this._brokerAuthenticated = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 2000;
    this._isDestroyed = false;

    if (options.connectBroker) {
      this.connectBroker();
    }
  }

  /**
   * Registers a project for a mailbox path that is not in config (MAILBOX_PATH / tests).
   * Keeps the legacy behaviour: falls back to Documentation/TEAM_MAILBOX.md when missing,
   * and uses data/mailbox_state.json unless a statePath is given.
   */
  _registerAdHocProject(mailboxPath, options = {}) {
    let mbPath = path.resolve(mailboxPath);
    if (!fs.existsSync(mbPath)) {
      const localMb = path.resolve(this.projectRoot, 'Documentation/TEAM_MAILBOX.md');
      if (fs.existsSync(localMb)) mbPath = localMb;
    }
    const id = this.projectDefs.has(LEGACY_PROJECT_ID) ? 'mailbox-path' : LEGACY_PROJECT_ID;
    this.projectDefs.set(id, {
      id,
      name: path.basename(path.dirname(mbPath)) || id,
      mailboxPath: mbPath,
      configuredMailboxPath: mbPath,
      mutexName: process.env.MAILBOX_MUTEX || 'Global\\OneBossFightMailbox',
      headerFormat: (process.env.MAILBOX_HEADER_FORMAT || 'broker').toLowerCase(),
      statePath: options.statePath || path.resolve(this.projectRoot, 'data/mailbox_state.json'),
      boardPath: path.resolve(this.projectRoot, 'data/board.json'),
      docsDir: null,
      adHoc: true
    });
    return id;
  }

  /**
   * Resolves the `project` tool argument to a project context (default project when omitted).
   * @throws {Error} for unknown projects
   */
  _getProject(projectId) {
    const id = projectId ? String(projectId).trim().toLowerCase() : this.defaultProjectId;
    if (this._projectCtx.has(id)) return this._projectCtx.get(id);

    const def = this.projectDefs.get(id);
    if (!def) {
      throw new Error(`Unknown project '${projectId}'. Known projects: ${[...this.projectDefs.keys()].join(', ')}`);
    }
    const stateStore = new StateStore({ statePath: def.statePath, projectId: def.id });
    const services = createProjectServices({
      mailboxPath: def.mailboxPath,
      stateStore,
      logger: this.logger,
      projectId: def.id,
      headerFormat: def.headerFormat,
      mutexName: def.mutexName,
      docsDir: def.docsDir,
      boardStoragePath: def.boardPath
    });
    const ctx = { id: def.id, name: def.name, def, stateStore, services };
    this._projectCtx.set(id, ctx);
    return ctx;
  }

  /** Project contexts for a read-only tool: every project for "all"/"*", else one */
  _getProjects(projectId) {
    if (projectId && ALL_PROJECTS.has(String(projectId).trim().toLowerCase())) {
      return [...this.projectDefs.keys()].map(id => this._getProject(id));
    }
    return [this._getProject(projectId)];
  }

  _loadBrokerConfig(options = {}) {
    let token = options.authToken || process.env.MAILBOX_AUTH_TOKEN;
    let wsPort = options.wsPort || (process.env.MAILBOX_WS_PORT ? parseInt(process.env.MAILBOX_WS_PORT, 10) : null);
    let host = options.host || '127.0.0.1';

    // 1. Try config/.env
    const envPath = path.resolve(this.projectRoot, 'config/.env');
    if (fs.existsSync(envPath)) {
      try {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const k = trimmed.substring(0, eqIdx).trim();
            const v = trimmed.substring(eqIdx + 1).trim();
            if (k === 'MAILBOX_AUTH_TOKEN' && !token) token = v;
            if (k === 'MAILBOX_WS_PORT' && !wsPort) wsPort = parseInt(v, 10);
          }
        }
      } catch (_) {}
    }

    // 2. Try config/default.json fallback
    const configPath = path.resolve(this.projectRoot, 'config/default.json');
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.broker) {
          if (!token && cfg.broker.authToken) token = cfg.broker.authToken;
          if (!wsPort && cfg.broker.port) wsPort = cfg.broker.port;
          if (cfg.broker.host) host = cfg.broker.host;
        }
      } catch (_) {}
    }

    return {
      authToken: token || 'ManchesterUnited',
      wsPort: wsPort || 8765,
      host: host || '127.0.0.1'
    };
  }

  /**
   * Connects to the local EventBroker via WebSocket for live presence and telemetry reporting
   */
  connectBroker(options = {}) {
    if (this._ws || this._isDestroyed) return;

    const host = options.host || this.brokerConfig.host || '127.0.0.1';
    const port = options.port || this.brokerConfig.wsPort || 8765;
    const url = options.url || `ws://${host}:${port}`;
    const token = options.authToken || this.brokerConfig.authToken;

    try {
      const ws = new WebSocket(url);
      this._ws = ws;

      ws.on('open', () => {
        this._reconnectDelay = 2000;
        try {
          ws.send(JSON.stringify({
            type: EVENT_TYPES.AUTH_REQUEST,
            agentId: this.canonicalAgent.id,
            token: token,
            instanceId: this.instanceId
          }));
        } catch (_) {}
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === EVENT_TYPES.AUTH_RESPONSE) {
            if (msg.success) {
              this._brokerAuthenticated = true;
              try {
                ws.send(JSON.stringify({
                  type: EVENT_TYPES.SUBSCRIBE,
                  channels: [this.canonicalAgent.id.toLowerCase()]
                }));
              } catch (_) {}
            }
          } else if (msg.type === EVENT_TYPES.PING) {
            // Heartbeat response keeps agent presence alive in EventBroker
            try {
              ws.send(JSON.stringify({
                type: EVENT_TYPES.PONG,
                timestamp: new Date().toISOString()
              }));
            } catch (_) {}
          }
        } catch (_) {}
      });

      ws.on('close', () => {
        this._ws = null;
        this._brokerAuthenticated = false;
        this._scheduleReconnect(options);
      });

      ws.on('error', () => {
        // Never write to stdout (reserved for stdio JSON-RPC). Safely terminate to trigger reconnect.
        try { ws.terminate(); } catch (_) {}
      });
    } catch (_) {
      this._scheduleReconnect(options);
    }
  }

  _scheduleReconnect(options) {
    if (this._isDestroyed || this._reconnectTimer) return;
    this._reconnectDelay = Math.min((this._reconnectDelay || 2000) * 1.5, 30000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connectBroker(options);
    }, this._reconnectDelay);
  }

  _sendToBroker(payload) {
    if (this._ws && this._brokerAuthenticated && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify(payload));
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  close() {
    this._isDestroyed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.terminate();
      } catch (_) {}
      this._ws = null;
    }
    this._brokerAuthenticated = false;
  }

  _parseAgentArg() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--agent' && args[i + 1]) {
        return args[i + 1];
      }
    }
    return null;
  }

  _resolveIdentity(id) {
    const norm = normalizeAgentId(id);
    let canonical = this.agentRegistry.get(norm);
    if (!canonical) {
      // Map party codes
      if (norm === 'c') canonical = this.agentRegistry.get('claude');
      else if (norm === 'x') canonical = this.agentRegistry.get('codex');
      else if (norm === 'a') canonical = this.agentRegistry.get('antigravity');
    }

    return canonical || {
      id: id,
      displayName: id,
      partyCode: id.charAt(0).toUpperCase(),
      role: 'AI Collaborator',
      capabilities: ['general-coding']
    };
  }

  /**
   * Returns list of supported MCP tools with JSON schemas
   */
  getTools() {
    return [
      {
        name: 'list_projects',
        description: 'Lists the projects this MailSocket install serves (id, name, mailbox path, header format). Pass a project id as the "project" argument of other tools.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_team_status',
        description: 'Returns operational summary of the AI team, system health, task counts, and broker status.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP_MULTI
          }
        }
      },
      {
        name: 'get_my_identity',
        description: 'Returns the verified identity, party code, role, and capabilities of the current authenticated agent.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_pending_messages',
        description: 'Retrieves all unclaimed or pending mailbox messages addressed to this agent.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP_MULTI,
            limit: { type: 'number', description: 'Maximum messages to return (default 20)' }
          }
        }
      },
      {
        name: 'get_message',
        description: 'Retrieves a specific mailbox message by its ID (e.g. C-1, X-2, A-3).',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            messageId: { type: 'string', description: 'The message ID to retrieve' }
          },
          required: ['messageId']
        }
      },
      {
        name: 'wait_for_message',
        description: 'Waits for a new message addressed to this agent with a bounded timeout. Returns message or timeout.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP_MULTI,
            timeoutSeconds: { type: 'number', description: 'Timeout in seconds (default 30, max 120)' }
          }
        }
      },
      {
        name: 'claim_message',
        description: 'Atomically claims an eligible pending message for this agent before beginning execution.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            messageId: { type: 'string', description: 'The message ID to claim' },
            leaseMs: { type: 'number', description: 'Lease duration in milliseconds (default 120000)' }
          },
          required: ['messageId']
        }
      },
      {
        name: 'acknowledge_message',
        description: 'Records delivery acknowledgement for a received message without marking it completed.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            messageId: { type: 'string', description: 'The message ID being acknowledged' },
            status: { type: 'string', description: 'Status (CLAIMED or RUNNING)', default: 'CLAIMED' }
          },
          required: ['messageId']
        }
      },
      {
        name: 'send_message',
        description: 'Sends a mailbox message to another team member or the human owner through TEAM_MAILBOX.md under mutex.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            to: { type: 'string', description: 'Recipient party code or agent name (e.g. Claude, Codex, Antigravity, Owner)' },
            body: { type: 'string', description: 'Message body and task details' },
            status: {
              type: 'string',
              enum: ['OPEN', 'ACK', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'REVIEW', 'ACCEPTED', 'CHANGES_REQUESTED'],
              description: 'Header STATUS for projects using the "tel" mailbox format (default OPEN). Ignored for broker-format mailboxes.'
            }
          },
          required: ['to', 'body']
        }
      },
      {
        name: 'update_task_status',
        description: 'Updates task lifecycle state (CLAIMED, RUNNING).',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            messageId: { type: 'string', description: 'The message/task ID' },
            status: { type: 'string', description: 'New status (RUNNING)' },
            details: { type: 'string', description: 'Optional status notes' }
          },
          required: ['messageId', 'status']
        }
      },
      {
        name: 'complete_task',
        description: 'Marks a claimed task as completed with verification evidence and optional response message reference.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            messageId: { type: 'string', description: 'The task/message ID' },
            responseMessageId: { type: 'string', description: 'ID of the reply message posted to the mailbox (if any)' },
            evidence: { type: 'object', description: 'Completion evidence, summary, or output metrics' }
          },
          required: ['messageId']
        }
      },
      {
        name: 'fail_task',
        description: 'Records task execution failure with error details and assesses retry eligibility.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            messageId: { type: 'string', description: 'The task/message ID' },
            error: { type: 'string', description: 'Detailed failure message or exception' },
            isPermanent: { type: 'boolean', description: 'Whether the error cannot be retried', default: false }
          },
          required: ['messageId', 'error']
        }
      },
      {
        name: 'get_task_history',
        description: 'Retrieves lifecycle events and retry history for a specific task.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            messageId: { type: 'string', description: 'The task/message ID' }
          },
          required: ['messageId']
        }
      },
      {
        name: 'get_message_history',
        description: 'Retrieves recent mailbox conversation thread history for this agent.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP_MULTI,
            limit: { type: 'number', description: 'Number of messages to retrieve (default 20)' }
          }
        }
      },
      {
        name: 'get_agent_status',
        description: 'Inspects status and capabilities of an agent or all team agents.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID to inspect (optional, defaults to self)' }
          }
        }
      },
      {
        name: 'heartbeat',
        description: 'Sends a heartbeat to record agent activity and confirm connectivity.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'send_owner_email',
        description: 'Sends an email notification directly to the Human Owner via Brevo transactional email. Use for urgent blockers, decisions needed, critical milestones, or escalations.',
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Concise email subject (e.g. [DECISION NEEDED] Boss Phase 2 Transition Logic)' },
            message: { type: 'string', description: 'Detailed explanation, decision options, or status report for the owner' },
            urgency: {
              type: 'string',
              enum: ['DECISION_NEEDED', 'URGENT_BLOCKER', 'MILESTONE_REACHED', 'REVIEW_REQUESTED', 'GENERAL_UPDATE'],
              description: 'Urgency level or category of the notification (default: DECISION_NEEDED)'
            },
            taskReference: { type: 'string', description: 'Optional message ID or task reference (e.g. X-280, C-249)' }
          },
          required: ['subject', 'message']
        }
      },

      // ─── Kanban Board Tools ─────────────────────────────────────
      {
        name: 'get_board',
        description: 'Returns the full Kanban board state: columns and all tasks with their comments, history, assignee, and priority.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            column: { type: 'string', description: 'Optional: filter tasks by column (backlog, todo, in-progress, review, done)' },
            assignee: { type: 'string', description: 'Optional: filter tasks by assignee agent ID' }
          }
        }
      },
      {
        name: 'create_board_task',
        description: 'Creates a new task on the Kanban board. Use this when you receive a task assignment or want to track a piece of work.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            title: { type: 'string', description: 'Short task title' },
            description: { type: 'string', description: 'Detailed description of the work' },
            column: { type: 'string', enum: ['backlog', 'todo', 'in-progress', 'review', 'done'], description: 'Target column (default: backlog)' },
            assignee: { type: 'string', description: 'Agent ID to assign to (Claude, Codex, Antigravity)' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Priority level (default: medium)' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Labels / tags for the task' }
          },
          required: ['title']
        }
      },
      {
        name: 'move_board_task',
        description: 'Moves a board task to a different column. Use to update status as you work (e.g. move from todo to in-progress when starting, to review when done coding).',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            taskId: { type: 'string', description: 'Board task ID (e.g. BT-1)' },
            column: { type: 'string', enum: ['backlog', 'todo', 'in-progress', 'review', 'done'], description: 'Target column to move to' }
          },
          required: ['taskId', 'column']
        }
      },
      {
        name: 'add_board_comment',
        description: 'Adds a comment to a board task. Use for progress updates, notes, questions, or status reports on a task.',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            taskId: { type: 'string', description: 'Board task ID (e.g. BT-1)' },
            text: { type: 'string', description: 'Comment text content' }
          },
          required: ['taskId', 'text']
        }
      },
      {
        name: 'update_board_task',
        description: 'Updates a board task\'s fields (title, description, priority, labels, assignee).',
        inputSchema: {
          type: 'object',
          properties: {
            project: PROJECT_PROP,
            taskId: { type: 'string', description: 'Board task ID (e.g. BT-1)' },
            title: { type: 'string', description: 'New title' },
            description: { type: 'string', description: 'New description' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'New priority' },
            assignee: { type: 'string', description: 'New assignee agent ID' },
            labels: { type: 'array', items: { type: 'string' }, description: 'New labels' }
          },
          required: ['taskId']
        }
      }
    ];
  }

  /**
   * Executes an authorized tool call
   */
  async executeTool(name, args = {}) {
    const callerId = this.canonicalAgent.id;
    const callerParty = this.canonicalAgent.partyCode || callerId.charAt(0).toUpperCase();

    // Unknown project ids fail before any side effect
    const isMulti = args.project && ALL_PROJECTS.has(String(args.project).trim().toLowerCase());
    const project = (name === 'list_projects' || isMulti) ? null : this._getProject(args.project);

    switch (name) {
      case 'list_projects': {
        return {
          defaultProject: this.defaultProjectId,
          projects: [...this.projectDefs.values()].map(d => ({
            id: d.id,
            name: d.name,
            isDefault: d.id === this.defaultProjectId,
            mailboxPath: d.mailboxPath,
            exists: fs.existsSync(d.mailboxPath),
            headerFormat: d.headerFormat || 'broker'
          }))
        };
      }

      case 'get_team_status': {
        const agents = this.services.agentService.getAllAgents();
        const contexts = this._getProjects(args.project);
        const allTasks = contexts.flatMap(c => Array.from(c.stateStore.tasks.values()));
        const pending = allTasks.filter(t => t.status === 'PENDING').length;
        const running = allTasks.filter(t => t.status === 'RUNNING' || t.status === 'CLAIMED').length;
        const completed = allTasks.filter(t => t.status === 'COMPLETED').length;

        return {
          status: 'UP',
          authenticatedAs: callerId,
          partyCode: callerParty,
          project: contexts.length === 1 ? contexts[0].id : contexts.map(c => c.id),
          defaultProject: this.defaultProjectId,
          mailboxPath: contexts.length === 1 ? contexts[0].def.mailboxPath : contexts.map(c => c.def.mailboxPath),
          agents: agents.map(a => ({
            id: a.id,
            displayName: a.displayName,
            partyCode: a.partyCode,
            status: a.status,
            role: a.role
          })),
          taskCounts: { pending, running, completed, total: allTasks.length },
          emailNotifications: this.services.emailService ? this.services.emailService.getStatus() : { enabled: false }
        };
      }

      case 'get_my_identity': {
        return {
          agentId: this.canonicalAgent.id,
          displayName: this.canonicalAgent.displayName,
          partyCode: callerParty,
          role: this.canonicalAgent.role,
          capabilities: this.canonicalAgent.capabilities || [],
          integrationMethod: 'mcp'
        };
      }

      case 'get_pending_messages': {
        const msgs = await this._pendingFor(callerId, args.project);
        const limit = args.limit || 20;
        return {
          project: isMulti ? 'all' : project.id,
          total: msgs.length,
          messages: msgs.slice(0, limit)
        };
      }

      case 'get_message': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const msg = await project.services.mailboxService.getMessageById(args.messageId);
        if (!msg) throw new Error(`Message '${args.messageId}' not found in project '${project.id}'`);
        return { ...msg, project: project.id };
      }

      case 'wait_for_message': {
        const timeoutSec = Math.min(Math.max(1, args.timeoutSeconds || 30), 120);
        const startTime = Date.now();
        const timeoutMs = timeoutSec * 1000;

        while (Date.now() - startTime < timeoutMs) {
          const pending = await this._pendingFor(callerId, args.project);
          if (pending.length > 0) {
            return {
              timeout: false,
              project: pending[0].project,
              message: pending[0],
              pendingCount: pending.length
            };
          }
          await new Promise(r => setTimeout(r, 1500));
        }

        return {
          timeout: true,
          message: null,
          waitedSeconds: timeoutSec,
          project: isMulti ? 'all' : project.id,
          note: `No new messages for ${callerId} within ${timeoutSec} seconds.`
        };
      }

      case 'claim_message': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const res = await project.services.taskService.claimMessage({
          messageId: args.messageId,
          agentId: callerId,
          leaseMs: args.leaseMs || 120000
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          project: project.id,
          messageId: args.messageId,
          status: 'CLAIMED',
          workerId: callerId
        });
        return { ...res, project: project.id };
      }

      case 'acknowledge_message': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const status = args.status === 'RUNNING' ? 'RUNNING' : 'CLAIMED';
        const res = await project.services.taskService.updateStatus({
          messageId: args.messageId,
          status,
          agentId: callerId
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          project: project.id,
          messageId: args.messageId,
          status,
          workerId: callerId
        });
        return { ...res, project: project.id };
      }

      case 'send_message': {
        if (!args.to || !args.body) throw new Error("Arguments 'to' and 'body' are required");
        return await project.services.mailboxService.postMessage({
          as: callerParty,
          to: args.to,
          body: args.body,
          status: args.status || null
        });
      }

      case 'update_task_status': {
        if (!args.messageId || !args.status) throw new Error("Arguments 'messageId' and 'status' are required");
        const res = await project.services.taskService.updateStatus({
          messageId: args.messageId,
          status: args.status,
          agentId: callerId,
          details: args.details
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          project: project.id,
          messageId: args.messageId,
          status: args.status,
          workerId: callerId
        });
        return { ...res, project: project.id };
      }

      case 'complete_task': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const res = await project.services.taskService.completeTask({
          messageId: args.messageId,
          agentId: callerId,
          responseMessageId: args.responseMessageId,
          evidence: args.evidence || {}
        });

        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          project: project.id,
          messageId: args.messageId,
          status: 'COMPLETED',
          workerId: callerId,
          evidence: args.evidence || {}
        });

        // Record usage metric
        this.services.usageService.recordTaskUsage(callerId, 0, 0, 0);
        return { ...res, project: project.id };
      }

      case 'fail_task': {
        if (!args.messageId || !args.error) throw new Error("Arguments 'messageId' and 'error' are required");
        const res = await project.services.taskService.failTask({
          messageId: args.messageId,
          agentId: callerId,
          error: args.error,
          isPermanent: !!args.isPermanent
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          project: project.id,
          messageId: args.messageId,
          status: 'FAILED',
          workerId: callerId,
          error: args.error
        });
        return { ...res, project: project.id };
      }

      case 'get_task_history': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        return { ...project.services.taskService.getTaskHistory(args.messageId), project: project.id };
      }

      case 'get_message_history': {
        const limit = args.limit || 20;
        const contexts = this._getProjects(args.project);
        let messages = [];
        for (const c of contexts) {
          const list = await c.services.mailboxService.getMessageHistory({ agentId: callerId, limit });
          messages = messages.concat(list.map(m => ({ ...m, project: c.id })));
        }
        messages = messages.slice(-limit);
        return { project: isMulti ? 'all' : project.id, count: messages.length, messages };
      }

      case 'get_agent_status': {
        const targetId = args.agentId || callerId;
        const agent = this.services.agentService.getAgent(targetId);
        if (!agent) throw new Error(`Agent '${targetId}' not found`);
        return agent;
      }

      case 'heartbeat': {
        this._sendToBroker({
          type: EVENT_TYPES.PONG,
          timestamp: new Date().toISOString()
        });
        return {
          acknowledged: true,
          agentId: callerId,
          connectedToBroker: !!this._brokerAuthenticated,
          timestamp: new Date().toISOString()
        };
      }

      case 'send_owner_email': {
        if (!args.subject || !args.message) {
          throw new Error("Arguments 'subject' and 'message' are required");
        }
        const senderName = `${this.canonicalAgent.displayName || callerId} (${this.canonicalAgent.role || 'AI Team Member'})`;
        const res = await this.services.emailService.sendOwnerEmail({
          senderAgent: senderName,
          subject: args.subject,
          message: args.message,
          urgency: args.urgency || 'DECISION_NEEDED',
          taskReference: args.taskReference || null
        });

        if (this.logger) {
          this.logger.log({
            level: res.status === 'error' ? 'ERROR' : 'INFO',
            type: 'OWNER_EMAIL_DISPATCHED',
            agentId: callerId,
            summary: `Owner email dispatch by ${callerId}: ${args.subject} (${res.status})`
          });
        }
        return { ...res, project: project.id };
      }

      // ─── Kanban Board Tool Handlers ─────────────────────────────

      case 'get_board': {
        const board = project.services.boardService.getBoard();
        if (args.column || args.assignee) {
          const filtered = project.services.boardService.getTasks({
            column: args.column,
            assignee: args.assignee
          });
          return { project: project.id, columns: board.columns, tasks: filtered, taskCount: filtered.length };
        }
        return { project: project.id, ...board };
      }

      case 'create_board_task': {
        if (!args.title) throw new Error("Argument 'title' is required");
        const task = project.services.boardService.createTask({
          title: args.title,
          description: args.description || '',
          column: args.column || 'backlog',
          assignee: args.assignee || null,
          priority: args.priority || 'medium',
          labels: args.labels || [],
          createdBy: callerId
        });
        return { success: true, project: project.id, task };
      }

      case 'move_board_task': {
        if (!args.taskId || !args.column) throw new Error("Arguments 'taskId' and 'column' are required");
        const task = project.services.boardService.moveTask(args.taskId, args.column, callerId);
        return { success: true, project: project.id, task };
      }

      case 'add_board_comment': {
        if (!args.taskId || !args.text) throw new Error("Arguments 'taskId' and 'text' are required");
        const comment = project.services.boardService.addComment(args.taskId, args.text, callerId);
        return { success: true, project: project.id, comment };
      }

      case 'update_board_task': {
        if (!args.taskId) throw new Error("Argument 'taskId' is required");
        const { taskId, project: _project, ...updates } = args;
        const task = project.services.boardService.updateTask(taskId, updates, callerId);
        return { success: true, project: project.id, task };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Pending messages for an agent in one project (or every project for "all"), tagged with project id
   */
  async _pendingFor(agentId, projectArg) {
    const out = [];
    for (const c of this._getProjects(projectArg)) {
      const msgs = await c.services.mailboxService.getPendingMessagesForAgent(agentId, c.stateStore);
      for (const m of msgs) out.push({ ...m, project: c.id });
    }
    return out;
  }

  /**
   * Returns list of supported MCP resources
   */
  getResources() {
    return [
      {
        uri: 'mailsocket://protocol',
        name: 'Team Communication Protocol',
        description: 'Authoritative rules and message conventions for the AI collaboration team.',
        mimeType: 'text/markdown'
      },
      {
        uri: 'mailsocket://roles',
        name: 'AI Team Roles & Responsibilities',
        description: 'Defined responsibilities for Claude, Codex, Antigravity, and Human Owner.',
        mimeType: 'text/markdown'
      },
      {
        uri: 'mailsocket://schemas',
        name: 'Message & Task Schemas',
        description: 'Formal schemas for TEAM_MAILBOX.md headings, party codes, and task lifecycle.',
        mimeType: 'application/json'
      }
    ];
  }

  /**
   * Reads an MCP resource
   */
  readResource(uri) {
    if (uri === 'mailsocket://protocol') {
      return {
        uri,
        mimeType: 'text/markdown',
        text: `# MailSocketTactics Team Communication Protocol

1. Authoritative mailbox is TEAM_MAILBOX.md.
2. Messages use format: ### [Party-Number] Sender -> Recipient, YYYY-MM-DD HH:MM
3. Parties: C (Claude), X (Codex), A (Antigravity), H (Human Owner).
4. Do not perform duplicate work: check task claims before proceeding.
5. Post completion replies directly to TEAM_MAILBOX.md under mutex.
6. Multi-project: every mailbox/task/board tool takes an optional "project" argument (see list_projects).
   Projects may use the "tel" heading format: ## [MSG-###] FROM -> TO | YYYY-MM-DD | STATUS
`
      };
    }

    if (uri === 'mailsocket://roles') {
      return {
        uri,
        mimeType: 'text/markdown',
        text: `# AI Team Roles

- Claude (C): Tech Lead, Architecture, High-Level Systems
- Codex (X): Independent Critic, Code Review, Correctness Validation
- Antigravity (A): C++ Gameplay Implementation, Unreal Engine Systems
- Human Owner (H): Direction, Decisions, Commit/Push Authority
`
      };
    }

    if (uri === 'mailsocket://schemas') {
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          messageHeadingRegex: '^###\\s+\\[([A-Z])-(\\d+)\\]\\s+([^->]+)\\s*->\\s*([^,]+),\\s*(.+)$',
          lifecycleStates: ['PENDING', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'RETRYABLE_FAILED', 'DEAD_LETTER', 'CANCELLED'],
          parties: { C: 'Claude', X: 'Codex', A: 'Antigravity', H: 'Owner' }
        }, null, 2)
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  }

  /**
   * Returns list of supported MCP prompts
   */
  getPrompts() {
    return [
      {
        name: 'team_onboarding',
        description: 'Project-specific team onboarding prompt customized for the active agent.',
        arguments: []
      }
    ];
  }

  /**
   * Generates prompt content
   */
  getPrompt(name) {
    if (name === 'team_onboarding') {
      const promptText = this.services.agentService.generateOnboardingPrompt(this.canonicalAgent);
      return {
        description: `Team Onboarding for ${this.canonicalAgent.displayName}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: promptText
            }
          }
        ]
      };
    }
    throw new Error(`Prompt not found: ${name}`);
  }

  /**
   * Handles incoming JSON-RPC 2.0 requests
   */
  async handleRequest(request) {
    const { id, method, params = {} } = request;

    try {
      switch (method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {},
                resources: {},
                prompts: {}
              },
              serverInfo: {
                name: 'mailsocket-mcp',
                version: '1.0.0',
                agentId: this.canonicalAgent.id,
                partyCode: this.canonicalAgent.partyCode
              }
            }
          };
        }

        case 'notifications/initialized': {
          // Standard client notification; no response needed
          return null;
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'tools/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: this.getTools() }
          };
        }

        case 'tools/call': {
          const { name, arguments: toolArgs } = params;
          const result = await this.executeTool(name, toolArgs || {});
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }
              ]
            }
          };
        }

        case 'resources/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { resources: this.getResources() }
          };
        }

        case 'resources/read': {
          const { uri } = params;
          const resource = this.readResource(uri);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [resource]
            }
          };
        }

        case 'prompts/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: { prompts: this.getPrompts() }
          };
        }

        case 'prompts/get': {
          const { name } = params;
          const prompt = this.getPrompt(name);
          return {
            jsonrpc: '2.0',
            id,
            result: prompt
          };
        }

        default: {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method '${method}' not found`
            }
          };
        }
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: err.message
        }
      };
    }
  }

  /**
   * Starts the stdio JSON-RPC loop for desktop client integration
   */
  startStdio() {
    // Automatically establish background WebSocket bridge to local EventBroker for presence & telemetry
    this.connectBroker();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const req = JSON.parse(trimmed);
        const res = await this.handleRequest(req);
        if (res) {
          process.stdout.write(JSON.stringify(res) + '\n');
        }
      } catch (err) {
        const errRes = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${err.message}` }
        };
        process.stdout.write(JSON.stringify(errRes) + '\n');
      }
    });

    const cleanup = () => {
      this.close();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', () => this.close());
  }
}

// CLI entry point
if (require.main === module) {
  const server = new McpServer();
  server.startStdio();
}

module.exports = McpServer;
