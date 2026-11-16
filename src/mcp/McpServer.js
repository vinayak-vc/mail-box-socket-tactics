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
const { createDomainServices } = require('../domain');
const StateStore = require('../broker/StateStore');
const AgentRegistry = require('../broker/AgentRegistry');
const ActivityLogger = require('../broker/ActivityLogger');
const { normalizeAgentId, EVENT_TYPES } = require('../protocol/MessageProtocol');

class McpServer {
  constructor(options = {}) {
    this.agentId = options.agentId || process.env.MCP_AGENT_ID || this._parseAgentArg() || 'Claude';
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '../..');
    this.mailboxPath = options.mailboxPath || process.env.MAILBOX_PATH || path.resolve(this.projectRoot, '../OneBossFight/Documentation/TEAM_MAILBOX.md');
    
    // Fallback mailbox if primary does not exist
    if (!fs.existsSync(this.mailboxPath)) {
      const localMb = path.resolve(this.projectRoot, 'Documentation/TEAM_MAILBOX.md');
      if (fs.existsSync(localMb)) this.mailboxPath = localMb;
    }

    // Initialize domain services
    this.stateStore = options.stateStore || new StateStore({
      statePath: options.statePath || path.resolve(this.projectRoot, 'data/mailbox_state.json')
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
      logger: this.logger
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
            token: token
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
        name: 'get_team_status',
        description: 'Returns operational summary of the AI team, system health, task counts, and broker status.',
        inputSchema: {
          type: 'object',
          properties: {}
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
            to: { type: 'string', description: 'Recipient party code or agent name (e.g. Claude, Codex, Antigravity, Owner)' },
            body: { type: 'string', description: 'Message body and task details' }
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

    switch (name) {
      case 'get_team_status': {
        const agents = this.services.agentService.getAllAgents();
        const allTasks = Array.from(this.stateStore.tasks.values());
        const pending = allTasks.filter(t => t.status === 'PENDING').length;
        const running = allTasks.filter(t => t.status === 'RUNNING' || t.status === 'CLAIMED').length;
        const completed = allTasks.filter(t => t.status === 'COMPLETED').length;

        return {
          status: 'UP',
          authenticatedAs: callerId,
          partyCode: callerParty,
          mailboxPath: this.mailboxPath,
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
        const msgs = await this.services.mailboxService.getPendingMessagesForAgent(callerId, this.stateStore);
        const limit = args.limit || 20;
        return {
          total: msgs.length,
          messages: msgs.slice(0, limit)
        };
      }

      case 'get_message': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const msg = await this.services.mailboxService.getMessageById(args.messageId);
        if (!msg) throw new Error(`Message '${args.messageId}' not found`);
        return msg;
      }

      case 'wait_for_message': {
        const timeoutSec = Math.min(Math.max(1, args.timeoutSeconds || 30), 120);
        const startTime = Date.now();
        const timeoutMs = timeoutSec * 1000;

        while (Date.now() - startTime < timeoutMs) {
          const pending = await this.services.mailboxService.getPendingMessagesForAgent(callerId, this.stateStore);
          if (pending.length > 0) {
            return {
              timeout: false,
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
          note: `No new messages for ${callerId} within ${timeoutSec} seconds.`
        };
      }

      case 'claim_message': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const res = await this.services.taskService.claimMessage({
          messageId: args.messageId,
          agentId: callerId,
          leaseMs: args.leaseMs || 120000
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          messageId: args.messageId,
          status: 'CLAIMED',
          workerId: callerId
        });
        return res;
      }

      case 'acknowledge_message': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const status = args.status === 'RUNNING' ? 'RUNNING' : 'CLAIMED';
        const res = await this.services.taskService.updateStatus({
          messageId: args.messageId,
          status,
          agentId: callerId
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          messageId: args.messageId,
          status,
          workerId: callerId
        });
        return res;
      }

      case 'send_message': {
        if (!args.to || !args.body) throw new Error("Arguments 'to' and 'body' are required");
        return await this.services.mailboxService.postMessage({
          as: callerParty,
          to: args.to,
          body: args.body
        });
      }

      case 'update_task_status': {
        if (!args.messageId || !args.status) throw new Error("Arguments 'messageId' and 'status' are required");
        const res = await this.services.taskService.updateStatus({
          messageId: args.messageId,
          status: args.status,
          agentId: callerId,
          details: args.details
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          messageId: args.messageId,
          status: args.status,
          workerId: callerId
        });
        return res;
      }

      case 'complete_task': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const res = await this.services.taskService.completeTask({
          messageId: args.messageId,
          agentId: callerId,
          responseMessageId: args.responseMessageId,
          evidence: args.evidence || {}
        });

        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          messageId: args.messageId,
          status: 'COMPLETED',
          workerId: callerId,
          evidence: args.evidence || {}
        });

        // Record usage metric
        this.services.usageService.recordTaskUsage(callerId, 0, 0, 0);
        return res;
      }

      case 'fail_task': {
        if (!args.messageId || !args.error) throw new Error("Arguments 'messageId' and 'error' are required");
        const res = await this.services.taskService.failTask({
          messageId: args.messageId,
          agentId: callerId,
          error: args.error,
          isPermanent: !!args.isPermanent
        });
        this._sendToBroker({
          type: EVENT_TYPES.MESSAGE_ACK,
          messageId: args.messageId,
          status: 'FAILED',
          workerId: callerId,
          error: args.error
        });
        return res;
      }

      case 'get_task_history': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        return this.services.taskService.getTaskHistory(args.messageId);
      }

      case 'get_message_history': {
        const limit = args.limit || 20;
        const messages = await this.services.mailboxService.getMessageHistory({
          agentId: callerId,
          limit
        });
        return { count: messages.length, messages };
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
        return res;
      }

      // ─── Kanban Board Tool Handlers ─────────────────────────────

      case 'get_board': {
        const board = this.services.boardService.getBoard();
        if (args.column || args.assignee) {
          const filtered = this.services.boardService.getTasks({
            column: args.column,
            assignee: args.assignee
          });
          return { columns: board.columns, tasks: filtered, taskCount: filtered.length };
        }
        return board;
      }

      case 'create_board_task': {
        if (!args.title) throw new Error("Argument 'title' is required");
        const task = this.services.boardService.createTask({
          title: args.title,
          description: args.description || '',
          column: args.column || 'backlog',
          assignee: args.assignee || null,
          priority: args.priority || 'medium',
          labels: args.labels || [],
          createdBy: callerId
        });
        return { success: true, task };
      }

      case 'move_board_task': {
        if (!args.taskId || !args.column) throw new Error("Arguments 'taskId' and 'column' are required");
        const task = this.services.boardService.moveTask(args.taskId, args.column, callerId);
        return { success: true, task };
      }

      case 'add_board_comment': {
        if (!args.taskId || !args.text) throw new Error("Arguments 'taskId' and 'text' are required");
        const comment = this.services.boardService.addComment(args.taskId, args.text, callerId);
        return { success: true, comment };
      }

      case 'update_board_task': {
        if (!args.taskId) throw new Error("Argument 'taskId' is required");
        const { taskId, ...updates } = args;
        const task = this.services.boardService.updateTask(taskId, updates, callerId);
        return { success: true, task };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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
