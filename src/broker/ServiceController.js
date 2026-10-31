/**
 * ServiceController.js
 * Safe, allowlisted control layer for MailSocketTactics background services.
 * Validates requested actions and targets against allowlists.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'status']);
const ALLOWED_TARGETS = new Set(['all', 'broker', 'adapters']);

class ServiceController {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '../..');
    this.serviceControlScript = path.resolve(this.projectRoot, 'scripts/ServiceControl.ps1');
    this.serviceRunner = path.resolve(this.projectRoot, 'src/service/ServiceRunner.js');
    this.pidPath = path.resolve(this.projectRoot, '.service.pid');
    this.httpPort = options.httpPort || 8766;
  }

  isPidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  getPid() {
    if (fs.existsSync(this.pidPath)) {
      try {
        const content = fs.readFileSync(this.pidPath, 'utf8').trim();
        const pid = parseInt(content, 10);
        if (this.isPidAlive(pid)) {
          return pid;
        }
      } catch (_) {}
    }
    return null;
  }

  async checkHealth(timeoutMs = 4000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ alive: false, error: 'Health check timeout' });
      }, timeoutMs);

      const req = http.get(`http://127.0.0.1:${this.httpPort}/health`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            resolve({ alive: true, data: parsed });
          } catch (_) {
            resolve({ alive: true, raw: data });
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        resolve({ alive: false, error: err.message });
      });
    });
  }

  async execute(action, target = 'all') {
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new Error(`Invalid action '${action}'. Allowed: ${Array.from(ALLOWED_ACTIONS).join(', ')}`);
    }
    if (!ALLOWED_TARGETS.has(target)) {
      throw new Error(`Invalid target '${target}'. Allowed: ${Array.from(ALLOWED_TARGETS).join(', ')}`);
    }

    const currentPid = this.getPid();

    if (action === 'status') {
      const health = await this.checkHealth(1500);
      return {
        action: 'status',
        target,
        running: !!currentPid,
        pid: currentPid,
        healthy: health.alive,
        details: health.data || health.raw || null
      };
    }

    if (action === 'start') {
      if (currentPid) {
        return {
          action: 'start',
          success: true,
          message: `Service is already running with PID ${currentPid}`,
          pid: currentPid
        };
      }

      // Start detached via node
      const child = spawn(process.execPath, [this.serviceRunner, `--${target}`], {
        cwd: this.projectRoot,
        detached: true,
        stdio: 'ignore',
        shell: false
      });
      child.unref();

      // Poll up to 5 seconds for health
      let started = false;
      let newPid = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        newPid = this.getPid();
        if (newPid) {
          const health = await this.checkHealth(1000);
          if (health.alive) {
            started = true;
            break;
          }
        }
      }

      if (!started && !newPid) {
        throw new Error('Service process failed to start within timeout.');
      }

      return {
        action: 'start',
        target,
        success: true,
        pid: newPid,
        message: `Service started successfully with PID ${newPid}`
      };
    }

    if (action === 'stop') {
      if (!currentPid) {
        // Even if Node is stopped, ensure lingering zrok shares/processes are released
        try {
          execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', this.serviceControlScript, '-Action', 'stop'], { timeout: 8000 }, () => {});
        } catch (_) {}

        return {
          action: 'stop',
          success: true,
          message: 'Service is already stopped.'
        };
      }

      try {
        process.kill(currentPid, 'SIGINT');
      } catch (err) {
        // Try SIGTERM
        try { process.kill(currentPid, 'SIGTERM'); } catch (_) {}
      }

      // Wait up to 3 seconds for exit
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!this.isPidAlive(currentPid)) break;
      }

      if (fs.existsSync(this.pidPath)) {
        try { fs.unlinkSync(this.pidPath); } catch (_) {}
      }

      // Release any lingering zrok cloud shares
      try {
        execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', this.serviceControlScript, '-Action', 'stop'], { timeout: 8000 }, () => {});
      } catch (_) {}

      return {
        action: 'stop',
        target,
        success: true,
        message: `Service process ${currentPid} stopped cleanly.`
      };
    }

    if (action === 'restart') {
      await this.execute('stop', target);
      await new Promise(r => setTimeout(r, 1000));
      return await this.execute('start', target);
    }
  }
}

module.exports = ServiceController;
