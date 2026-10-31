/**
 * MailboxDomainService.js
 * Domain service for authoritative mailbox operations on TEAM_MAILBOX.md.
 * Shared by REST API, WebSocket event broker, and MCP server.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseMailboxMessages, isRecipientMatch, normalizeAgentId } = require('../protocol/MessageProtocol');

class MailboxDomainService {
  constructor(options = {}) {
    this.mailboxPath = options.mailboxPath || path.resolve(__dirname, '../../Documentation/TEAM_MAILBOX.md');
    this.httpPort = options.httpPort || 8766;
    this.postScriptPath = options.postScriptPath || path.resolve(__dirname, '../../scripts/MailboxPostSocket.ps1');
  }

  /**
   * Sets the authoritative mailbox path
   */
  setMailboxPath(p) {
    if (p) this.mailboxPath = p;
  }

  /**
   * Reads and parses all messages from TEAM_MAILBOX.md
   */
  async getAllMessages() {
    if (!fs.existsSync(this.mailboxPath)) {
      return [];
    }

    try {
      const content = await fs.promises.readFile(this.mailboxPath, 'utf8');
      return parseMailboxMessages(content);
    } catch (err) {
      console.error(`[MailboxDomainService] Error reading mailbox: ${err.message}`);
      return [];
    }
  }

  /**
   * Retrieves a single message by ID (e.g. C-1, X-2, A-3)
   */
  async getMessageById(messageId) {
    if (!messageId) return null;
    const norm = String(messageId).trim().toUpperCase();
    const messages = await this.getAllMessages();
    return messages.find(m => m.id.toUpperCase() === norm) || null;
  }

  /**
   * Gets pending messages addressed to a specific agent that have not been completed
   * @param {string} agentId - Target agent ID or party code (e.g. Claude, C, Codex, X)
   * @param {object} stateStore - Optional StateStore instance to check completion status
   */
  async getPendingMessagesForAgent(agentId, stateStore = null) {
    if (!agentId) return [];
    const messages = await this.getAllMessages();
    const normId = normalizeAgentId(agentId);

    return messages.filter(msg => {
      // Must match recipient (agentId first, recipientRaw second)
      if (!isRecipientMatch(normId, msg.recipientRaw)) {
        return false;
      }

      // Check task status if stateStore provided
      if (stateStore) {
        const task = stateStore.getTask(msg.id);
        if (task && (task.status === 'COMPLETED' || task.status === 'CANCELLED')) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Gets conversation thread or message history related to a message or agent
   */
  async getMessageHistory(options = {}) {
    const { messageId, agentId, limit = 50 } = options;
    const messages = await this.getAllMessages();

    let filtered = messages;
    if (agentId) {
      const norm = normalizeAgentId(agentId);
      filtered = filtered.filter(m => 
        isRecipientMatch(norm, m.recipientRaw) || normalizeAgentId(m.sender) === norm
      );
    }

    if (messageId) {
      const target = messages.find(m => m.id.toUpperCase() === String(messageId).toUpperCase());
      if (target) {
        // Return messages between sender and recipient
        const parties = new Set([normalizeAgentId(target.sender), ...target.recipientRaw.split(',').map(s => normalizeAgentId(s.trim()))]);
        filtered = filtered.filter(m => 
          parties.has(normalizeAgentId(m.sender))
        );
      }
    }

    return filtered.slice(-limit);
  }

  /**
   * Posts a new message to TEAM_MAILBOX.md under mutex via MailboxPostSocket.ps1
   */
  async postMessage({ as, to, body }) {
    if (!as || !to || !body) {
      throw new Error("Missing required fields: 'as', 'to', 'body'");
    }

    // Normalize party code for 'as'
    const validParties = ['C', 'X', 'A', 'H'];
    let partyCode = as.trim().toUpperCase();
    if (!validParties.includes(partyCode)) {
      const norm = normalizeAgentId(as);
      if (norm === 'claude') partyCode = 'C';
      else if (norm === 'codex') partyCode = 'X';
      else if (norm === 'antigravity') partyCode = 'A';
      else if (norm === 'owner' || norm === 'human') partyCode = 'H';
      else {
        throw new Error(`Invalid 'as' party identifier '${as}'. Must be one of C, X, A, H.`);
      }
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.postScriptPath,
        '-As', partyCode,
        '-To', to,
        '-Body', body,
        '-HttpPort', String(this.httpPort)
      ];

      if (this.mailboxPath && fs.existsSync(this.mailboxPath)) {
        args.push('-Mailbox', this.mailboxPath);
      }

      // Pass auth token to post script if configured
      const envFile = path.resolve(__dirname, '../../config/.env');
      let tok = process.env.MAILBOX_AUTH_TOKEN;
      if (!tok && fs.existsSync(envFile)) {
        try {
          const envContent = fs.readFileSync(envFile, 'utf8');
          const m = envContent.match(/^\s*MAILBOX_AUTH_TOKEN\s*=\s*(.+)$/m);
          if (m) tok = m[1].trim();
        } catch (e) {}
      }
      if (tok) {
        args.push('-AuthToken', tok);
      }

      const ps = spawn('powershell.exe', args, { shell: false });
      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', d => { stdout += d; });
      ps.stderr.on('data', d => { stderr += d; });

      ps.on('close', (code) => {
        if (code === 0) {
          // Extract message ID from output (e.g. "POSTED C-1")
          const match = stdout.match(/POSTED\s+([A-Z]-\d+)/i);
          const messageId = match ? match[1] : null;
          resolve({
            success: true,
            messageId,
            output: stdout.trim()
          });
        } else {
          reject(new Error(`MailboxPost failed (exit code ${code}): ${stderr || stdout}`));
        }
      });

      ps.on('error', (err) => {
        reject(new Error(`Failed to invoke powershell: ${err.message}`));
      });
    });
  }
}

module.exports = MailboxDomainService;
