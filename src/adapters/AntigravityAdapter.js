/**
 * AntigravityAdapter.js
 * Hardened adapter for Google Antigravity (Senior C++ Implementer & Unreal Expert).
 * Uses direct executable invocation (shell: false) to language_server.exe,
 * distinguishes message acceptance from actual task completion, and verifies
 * completion via subsequent mailbox delivery receipts.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseAgentAdapter = require('./BaseAgentAdapter');
const { parseMailboxMessages } = require('../protocol/MessageProtocol');

class AntigravityAdapter extends BaseAgentAdapter {
  constructor(options = {}) {
    super({
      ...options,
      agentId: options.agentId || 'Antigravity'
    });

    this.execMode = options.execMode || 'agentapi'; // 'agentapi' or 'mock'
    this.cliCommand = options.cliCommand || 'C:\\Users\\Rushit Vaghela\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe';
    this.conversationId = options.conversationId || 'f3c213cd-dec6-440b-a5b5-afef6b3a13ca';
    this.waitForMailboxResponse = options.waitForMailboxResponse !== undefined ? options.waitForMailboxResponse : false;
    this.responseWaitTimeoutMs = options.responseWaitTimeoutMs || 60000;
    this.timeoutMs = options.timeoutMs || 30000;
    this.mockHandler = options.mockHandler || null;
  }

  /**
   * Invokes Antigravity safely and verifies acceptance and completion
   */
  async dispatchMessage(message) {
    console.log(`[AntigravityAdapter] Dispatching message ${message.id} from ${message.sender}...`);

    if (this.execMode === 'mock') {
      if (this.mockHandler) {
        return await this.mockHandler(message);
      }
      console.log(`[AntigravityAdapter] [MOCK] Simulated Antigravity processing of ${message.id}`);
      return { success: true, simulated: true, evidence: `Mock AG completed ${message.id}` };
    }

    const content = `New Mailbox Work Order from ${message.sender} (${message.id}):\n\n` +
      `Header: ${message.headerLine}\n\n` +
      `Content:\n${message.body}\n\n` +
      `Execute implementation or corrections, verify C++ build/receipts, and append delivery report to TEAM_MAILBOX.md.`;

    const args = ['agentapi', 'send-message', this.conversationId, content];

    // 1. Dispatch prompt to language_server.exe (shell: false)
    const acceptance = await new Promise((resolve, reject) => {
      let isTimedOut = false;
      console.log(`[AntigravityAdapter] Spawning direct process (shell: false): ${this.cliCommand} agentapi send-message`);

      const proc = spawn(this.cliCommand, args, {
        cwd: this.workingDir,
        shell: false, // Critical: prevent shell injection
        windowsHide: true,
        env: {
          ...process.env,
          MAILBOX_CALLER: 'AntigravityAdapter',
          MAILBOX_TASK_ID: message.id,
          MAILBOX_WORKER_ID: this.workerId
        }
      });

      const timer = setTimeout(() => {
        isTimedOut = true;
        console.warn(`[AntigravityAdapter] agentapi call timed out after ${this.timeoutMs}ms for ${message.id}`);
        try { proc.kill('SIGTERM'); } catch (_) {}
      }, this.timeoutMs);

      let stdout = '';
      let stderr = '';

      if (proc.stdout) proc.stdout.on('data', d => { stdout += d.toString(); });
      if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', code => {
        clearTimeout(timer);
        if (isTimedOut) {
          return reject(new Error(`Antigravity agentapi timed out after ${this.timeoutMs}ms`));
        }

        if (code === 0) {
          console.log(`[AntigravityAdapter] Message accepted by Antigravity application (exit 0)`);
          resolve({ accepted: true, stdout: stdout.trim() });
        } else {
          console.error(`[AntigravityAdapter] agentapi rejected with code ${code}: ${stderr || stdout}`);
          reject(new Error(`Antigravity agentapi rejected with code ${code}: ${stderr || stdout || 'Unknown error'}`));
        }
      });

      proc.on('error', err => {
        clearTimeout(timer);
        console.error(`[AntigravityAdapter] Process spawn error: ${err.message}`);
        reject(err);
      });
    });

    // 2. If configured to wait for authoritative mailbox delivery response:
    if (this.waitForMailboxResponse) {
      console.log(`[AntigravityAdapter] Awaiting authoritative delivery response from Antigravity in mailbox...`);
      const response = await this.waitForResponse(message.number, this.responseWaitTimeoutMs);
      if (response) {
        return {
          success: true,
          evidence: `Verified mailbox response: ${response.id}`,
          response
        };
      } else {
        // Documented behavior: Task is accepted in UI but mailbox response pending.
        // Do not auto-retry immediately; leave task claimed/running.
        console.log(`[AntigravityAdapter] Mailbox response pending after ${this.responseWaitTimeoutMs}ms. Keeping task active.`);
        return {
          success: true,
          status: 'ACCEPTED_PENDING_RESPONSE',
          evidence: `Message accepted by Antigravity canvas; response in progress`
        };
      }
    }

    return {
      success: true,
      evidence: `Message accepted by Antigravity (conv: ${this.conversationId})`,
      stdout: acceptance.stdout
    };
  }

  /**
   * Polls mailbox locally for an Antigravity response heading posted after given message number
   */
  async waitForResponse(sinceNumber, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(this.mailboxPath)) {
        try {
          const text = fs.readFileSync(this.mailboxPath, 'utf8');
          const messages = parseMailboxMessages(text);
          const reply = messages.find(m => m.party === 'A' && m.number > sinceNumber);
          if (reply) return reply;
        } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return null;
  }
}

module.exports = AntigravityAdapter;
