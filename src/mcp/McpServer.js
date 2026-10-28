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
const { createDomainServices } = require('../domain');
const StateStore = require('../broker/StateStore');
const AgentRegistry = require('../broker/AgentRegistry');
const ActivityLogger = require('../broker/ActivityLogger');
const { normalizeAgentId } = require('../protocol/MessageProtocol');

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
          taskCounts: { pending, running, completed, total: allTasks.length }
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
        return await this.services.taskService.claimMessage({
          messageId: args.messageId,
          agentId: callerId,
          leaseMs: args.leaseMs || 120000
        });
      }

      case 'acknowledge_message': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const status = args.status === 'RUNNING' ? 'RUNNING' : 'CLAIMED';
        return await this.services.taskService.updateStatus({
          messageId: args.messageId,
          status,
          agentId: callerId
        });
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
        return await this.services.taskService.updateStatus({
          messageId: args.messageId,
          status: args.status,
          agentId: callerId,
          details: args.details
        });
      }

      case 'complete_task': {
        if (!args.messageId) throw new Error("Argument 'messageId' is required");
        const res = await this.services.taskService.completeTask({
          messageId: args.messageId,
          agentId: callerId,
          responseMessageId: args.responseMessageId,
          evidence: args.evidence || {}
        });

        // Record usage metric
        this.services.usageService.recordTaskUsage(callerId, 0, 0, 0);
        return res;
      }

      case 'fail_task': {
        if (!args.messageId || !args.error) throw new Error("Arguments 'messageId' and 'error' are required");
        return await this.services.taskService.failTask({
          messageId: args.messageId,
          agentId: callerId,
          error: args.error,
          isPermanent: !!args.isPermanent
        });
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
        return {
          acknowledged: true,
          agentId: callerId,
          timestamp: new Date().toISOString()
        };
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

    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }
}

// CLI entry point
if (require.main === module) {
  const server = new McpServer();
  server.startStdio();
}

module.exports = McpServer;
