/**
 * ClaudeAdapter.js
 * Hardened adapter for Claude (Tech Lead & Principal Architect).
 * Uses direct executable invocation (shell: false) without command injection risks,
 * explicit session management, timeout cancellation, and robust error handling.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const BaseAgentAdapter = require('./BaseAgentAdapter');

class ClaudeAdapter extends BaseAgentAdapter {
  constructor(options = {}) {
    super({
      ...options,
      agentId: options.agentId || 'Claude'
    });

    this.execMode = options.execMode || 'cli'; // 'cli' or 'mock'
    this.cliCommand = options.cliCommand || 'C:\\Users\\Rushit Vaghela\\.local\\bin\\claude.exe';
    this.sessionMode = options.sessionMode || 'continue'; // 'continue', 'new', 'session_id'
    this.sessionId = options.sessionId || null;
    this.timeoutMs = options.timeoutMs || 300000; // 5 minutes default
    this.mockHandler = options.mockHandler || null;
  }

  /**
   * Invokes Claude safely to process the incoming message
   */
  async dispatchMessage(message) {
    console.log(`[ClaudeAdapter] Dispatching message ${message.id} from ${message.sender}...`);

    if (this.execMode === 'mock') {
      if (this.mockHandler) {
        return await this.mockHandler(message);
      }
      console.log(`[ClaudeAdapter] [MOCK] Simulated Claude processing of ${message.id}`);
      return { success: true, simulated: true, evidence: `Mock Claude completed ${message.id}` };
    }

    // Direct CLI execution (shell: false)
    const prompt = `New Mailbox Task from ${message.sender} (${message.id}):\n\n` +
      `Header: ${message.headerLine}\n\n` +
      `Content:\n${message.body}\n\n` +
      `Please review the work or request, execute required changes or verification, and post your response to the mailbox using MailboxPostSocket.ps1.`;

    const args = [];
    if (this.sessionMode === 'continue') {
      args.push('-c', '-p', prompt);
    } else if (this.sessionMode === 'session_id' && this.sessionId) {
      args.push('--session-id', this.sessionId, '-p', prompt);
    } else {
      args.push('-p', prompt);
    }

    return new Promise((resolve, reject) => {
      let isTimedOut = false;
      console.log(`[ClaudeAdapter] Spawning direct process (shell: false): ${this.cliCommand} with mode: ${this.sessionMode}`);

      const proc = spawn(this.cliCommand, args, {
        cwd: this.workingDir,
        shell: false, // Critical: prevent shell command injection
        windowsHide: true,
        env: {
          ...process.env,
          MAILBOX_CALLER: 'ClaudeAdapter',
          MAILBOX_TASK_ID: message.id,
          MAILBOX_WORKER_ID: this.workerId
        }
      });

      const timer = setTimeout(() => {
        isTimedOut = true;
        console.warn(`[ClaudeAdapter] Execution timed out after ${this.timeoutMs}ms for ${message.id}. Terminating process.`);
        try { proc.kill('SIGTERM'); } catch (_) {}
      }, this.timeoutMs);

      let stdout = '';
      let stderr = '';

      if (proc.stdout) proc.stdout.on('data', d => { stdout += d.toString(); });
      if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', code => {
        clearTimeout(timer);
        if (isTimedOut) {
          return reject(new Error(`Claude process timed out after ${this.timeoutMs}ms`));
        }

        if (code === 0) {
          console.log(`[ClaudeAdapter] Claude CLI process completed successfully (exit 0)`);
          resolve({
            success: true,
            code,
            evidence: `Claude CLI exit 0 for ${message.id}`,
            stdout: stdout.trim()
          });
        } else {
          console.error(`[ClaudeAdapter] Claude CLI process failed with code ${code}: ${stderr || stdout}`);
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr || stdout || 'Unknown error'}`));
        }
      });

      proc.on('error', err => {
        clearTimeout(timer);
        console.error(`[ClaudeAdapter] Process spawn error: ${err.message}`);
        reject(err);
      });
    });
  }
}

module.exports = ClaudeAdapter;
