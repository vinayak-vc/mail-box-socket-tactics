/**
 * CodexAdapter.js
 * Hardened adapter for OpenAI Codex (Technical Lead / Independent Critic).
 * Uses direct executable invocation (shell: false) with stdin/argument passing,
 * configurable session mode, timeout cancellation, and robust error handling.
 */

const { spawn } = require('child_process');
const BaseAgentAdapter = require('./BaseAgentAdapter');

class CodexAdapter extends BaseAgentAdapter {
  constructor(options = {}) {
    super({
      ...options,
      agentId: options.agentId || 'Codex'
    });

    this.execMode = options.execMode || 'cli'; // 'cli' or 'mock'
    this.cliCommand = options.cliCommand || 'C:\\Users\\Rushit Vaghela\\AppData\\Local\\OpenAI\\Codex\\bin\\2993767bd1dfb009\\codex.exe';
    this.sessionMode = options.sessionMode || 'independent'; // 'independent' or 'resume_last'
    this.timeoutMs = options.timeoutMs || 300000; // 5 minutes default
    this.mockHandler = options.mockHandler || null;
  }

  /**
   * Invokes Codex safely to process the incoming message
   */
  async dispatchMessage(message) {
    console.log(`[CodexAdapter] Dispatching message ${message.id} from ${message.sender}...`);

    if (this.execMode === 'mock') {
      if (this.mockHandler) {
        return await this.mockHandler(message);
      }
      console.log(`[CodexAdapter] [MOCK] Simulated Codex processing of ${message.id}`);
      return { success: true, simulated: true, evidence: `Mock Codex completed ${message.id}` };
    }

    const prompt = `New Mailbox Task from ${message.sender} (${message.id}):\n\n` +
      `Header: ${message.headerLine}\n\n` +
      `Content:\n${message.body}\n\n` +
      `Review current project and mailbox state, process work order or verification, and update documentation or mailbox accordingly.`;

    const args = ['exec'];
    if (this.sessionMode === 'resume_last') {
      args.push('resume', '--last');
    }
    // Pass prompt as discrete argument
    args.push(prompt);

    return new Promise((resolve, reject) => {
      let isTimedOut = false;
      console.log(`[CodexAdapter] Spawning direct process (shell: false): ${this.cliCommand} exec (mode: ${this.sessionMode})`);

      const proc = spawn(this.cliCommand, args, {
        cwd: this.workingDir,
        shell: false, // Critical: prevent shell injection
        windowsHide: true,
        env: {
          ...process.env,
          MAILBOX_CALLER: 'CodexAdapter',
          MAILBOX_TASK_ID: message.id,
          MAILBOX_WORKER_ID: this.workerId
        }
      });

      const timer = setTimeout(() => {
        isTimedOut = true;
        console.warn(`[CodexAdapter] Execution timed out after ${this.timeoutMs}ms for ${message.id}. Terminating process.`);
        try { proc.kill('SIGTERM'); } catch (_) {}
      }, this.timeoutMs);

      let stdout = '';
      let stderr = '';

      if (proc.stdout) proc.stdout.on('data', d => { stdout += d.toString(); });
      if (proc.stderr) proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', code => {
        clearTimeout(timer);
        if (isTimedOut) {
          return reject(new Error(`Codex process timed out after ${this.timeoutMs}ms`));
        }

        if (code === 0) {
          console.log(`[CodexAdapter] Codex CLI process completed successfully (exit 0)`);
          resolve({
            success: true,
            code,
            evidence: `Codex CLI exit 0 for ${message.id}`,
            stdout: stdout.trim()
          });
        } else {
          console.error(`[CodexAdapter] Codex CLI process failed with code ${code}: ${stderr || stdout}`);
          reject(new Error(`Codex CLI exited with code ${code}: ${stderr || stdout || 'Unknown error'}`));
        }
      });

      proc.on('error', err => {
        clearTimeout(timer);
        console.error(`[CodexAdapter] Process spawn error: ${err.message}`);
        reject(err);
      });
    });
  }
}

module.exports = CodexAdapter;
