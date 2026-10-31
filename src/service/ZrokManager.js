/**
 * ZrokManager.js
 * Manages zrok public internet tunneling for the MailSocketTactics Control Center and broker.
 * Enables simultaneous local access (127.0.0.1) and secure, predictable public internet access.
 * Binds explicitly to the reserved name 'public:mailsocket' (https://mailsocket.shares.zrok.io)
 * to ensure persistent URLs across server restarts with zero ghost shares.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class ZrokManager {
  constructor(options = {}) {
    this.binPath = options.binPath || process.env.ZROK_BIN || this._findZrokBin();
    this.target = options.target || 'http://127.0.0.1:8766';
    this.token = options.token || process.env.ZROK_TOKEN || null;
    this.enabled = options.enabled !== undefined ? options.enabled : !!this.token;

    this.reservedName = options.reservedName || process.env.ZROK_RESERVED_NAME || 'mailsocket';
    this.namespace = options.namespace || 'public';
    this.nameSelection = `${this.namespace}:${this.reservedName}`;

    this.process = null;
    this.publicUrl = null;
    this.shareToken = null;
    this.status = this.enabled ? 'DISCONNECTED' : 'DISABLED';
    this.lastError = null;
    this.logger = options.logger || console;

    // Safety exit hook: release share token if Node process exits abruptly
    this._exitHandler = () => {
      if (this.shareToken) {
        try {
          execSync(`"${this.binPath}" delete share ${this.shareToken}`, {
            stdio: 'ignore',
            timeout: 5000
          });
        } catch (_) {}
      }
    };
    process.once('exit', this._exitHandler);
  }

  /**
   * Discovers the zrok binary on Windows
   */
  _findZrokBin() {
    const candidates = [
      'C:\\scrcpy-win64-v2.4\\zrok2.exe',
      'zrok2',
      'zrok',
      'C:\\Program Files\\zrok\\zrok.exe'
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }

    try {
      const whereResult = execSync('where.exe zrok2', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (whereResult) return whereResult.split('\n')[0].trim();
    } catch (_) {}

    return 'zrok2';
  }

  /**
   * Checks if zrok is authenticated/enabled; runs 'zrok enable' if token is present
   */
  async ensureEnvironment() {
    if (!this.enabled) return false;

    try {
      const statusOutput = execSync(`"${this.binPath}" status`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000
      });

      if (statusOutput.includes('Account Token') && statusOutput.includes('<<SET>>')) {
        return true;
      }
    } catch (_) {}

    // If not enabled and token is present, attempt enable
    if (this.token) {
      try {
        this.logger.log('[ZrokManager] Enabling zrok environment with configured token...');
        execSync(`"${this.binPath}" enable "${this.token}"`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 15000
        });
        return true;
      } catch (err) {
        this.lastError = `zrok enable failed: ${err.message}`;
        this.logger.error(`[ZrokManager] ${this.lastError}`);
        return false;
      }
    }

    this.lastError = 'zrok environment not enabled and no ZROK_TOKEN provided';
    return false;
  }

  /**
   * Fetches the full overview JSON from zrok
   */
  getOverview() {
    try {
      const raw = execSync(`"${this.binPath}" overview --json`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000
      });

      if (!raw || !raw.trim()) return { environments: [], names: [], shares: [] };

      const str = raw.trim();
      const sIdx = str.indexOf('{');
      const eIdx = str.lastIndexOf('}');
      if (sIdx >= 0 && eIdx > sIdx) {
        const jsonStr = str.substring(sIdx, eIdx + 1);
        const parsed = JSON.parse(jsonStr);
        const shares = [];
        if (Array.isArray(parsed.environments)) {
          for (const env of parsed.environments) {
            if (Array.isArray(env.shares)) {
              shares.push(...env.shares);
            }
          }
        }
        return {
          environments: parsed.environments || [],
          names: parsed.names || [],
          shares
        };
      }
      return { environments: [], names: [], shares: [] };
    } catch (_) {
      return { environments: [], names: [], shares: [] };
    }
  }

  /**
   * Queries existing shares via zrok overview --json
   */
  listShares() {
    return this.getOverview().shares;
  }

  /**
   * Ensures the reserved share name exists in the user's zrok account
   */
  ensureReservation() {
    try {
      const overview = this.getOverview();
      const existing = (overview.names || []).find((n) => n.name === this.reservedName);
      if (!existing) {
        this.logger.log(`[ZrokManager] Reserving name '${this.reservedName}' in namespace '${this.namespace}'...`);
        execSync(`"${this.binPath}" create name ${this.reservedName} -n ${this.namespace}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 8000
        });
        execSync(`"${this.binPath}" modify name ${this.reservedName} -r -n ${this.namespace}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 8000
        });
        this.logger.log(`[ZrokManager] Reserved name '${this.reservedName}' successfully.`);
      }
    } catch (err) {
      this.logger.warn(`[ZrokManager] ensureReservation notice: ${err.message}`);
    }
  }

  /**
   * Deletes / releases a share token from the zrok cloud controller
   */
  deleteShare(token) {
    if (!token) return;
    try {
      execSync(`"${this.binPath}" delete share ${token}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000
      });
      this.logger.log(`[ZrokManager] Released zrok cloud share '${token}'.`);
    } catch (_) {
      try {
        execSync(`"${this.binPath}" release ${token}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 8000
        });
        this.logger.log(`[ZrokManager] Released zrok share '${token}' using legacy syntax.`);
      } catch (_) {}
    }
  }

  /**
   * Cleans up all stale shares targeting this.target or holding the reserved name
   */
  cleanupStaleShares() {
    try {
      const normalizedTarget = this.target.replace(/\/+$/, '');
      const overview = this.getOverview();
      const shares = overview.shares || [];
      const names = overview.names || [];

      // 1. Delete active shares targeting our port or carrying our reserved name
      for (const share of shares) {
        const sTarget = (share.target || share.backendProxyEndpoint || '').replace(/\/+$/, '');
        const hasEndpoint = (share.frontendEndpoints || []).some((ep) => ep.includes(this.reservedName));
        if ((sTarget === normalizedTarget || sTarget.includes(':8766') || hasEndpoint) && share.shareToken) {
          this.logger.log(`[ZrokManager] Cleaning up stale share '${share.shareToken}' (target: ${sTarget})...`);
          this.deleteShare(share.shareToken);
        }
      }

      // 2. Clear any lingering shareToken bound to the reserved name in names
      for (const n of names) {
        if (n.name === this.reservedName && n.shareToken && n.shareToken !== '-') {
          this.logger.log(`[ZrokManager] Releasing shareToken '${n.shareToken}' from reserved name '${n.name}'...`);
          this.deleteShare(n.shareToken);
        }
      }
    } catch (err) {
      this.logger.warn(`[ZrokManager] Stale share cleanup error: ${err.message}`);
    }
  }

  /**
   * Kills any orphan zrok processes that are targeting port 8766
   */
  _killLingeringProcesses() {
    if (process.platform !== 'win32') return;
    try {
      const wmicOut = execSync('wmic process where "name like \'%zrok%\'" get ProcessId,CommandLine /format:csv', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      });
      const lines = wmicOut.split('\n');
      for (const line of lines) {
        if (line.includes('8766') || line.includes('mailsocket')) {
          const parts = line.trim().split(',');
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && parseInt(pid, 10) !== process.pid) {
            try {
              execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' });
              this.logger.log(`[ZrokManager] Terminated lingering zrok process PID ${pid}.`);
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  /**
   * Starts the public zrok tunnel
   */
  async start() {
    if (!this.enabled) {
      this.status = 'DISABLED';
      return null;
    }

    if (this.process) {
      return this.publicUrl;
    }

    this.status = 'STARTING';
    const envReady = await this.ensureEnvironment();
    if (!envReady) {
      this.status = 'ERROR';
      return null;
    }

    // Pre-flight cleanup: terminate any lingering zrok processes and delete stale cloud shares
    this._killLingeringProcesses();
    this.cleanupStaleShares();
    this.ensureReservation();

    try {
      this.logger.log(`[ZrokManager] Launching zrok public tunnel to target ${this.target} with reservation '${this.nameSelection}'...`);
      const child = spawn(this.binPath, ['share', 'public', '--headless', '-n', this.nameSelection, this.target], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false
      });

      this.process = child;

      child.on('error', (err) => {
        this.lastError = err.message;
        this.status = 'ERROR';
        this.logger.error(`[ZrokManager] Child process error: ${err.message}`);
        this.process = null;
      });

      child.on('exit', (code, signal) => {
        if (this.status !== 'DISCONNECTED') {
          this.logger.log(`[ZrokManager] zrok tunnel exited with code ${code} / signal ${signal}`);
        }
        this.process = null;
        this.status = 'DISCONNECTED';
        this.publicUrl = null;
        this.shareToken = null;
      });

      // Poll overview for up to 15 seconds to discover assigned public URL
      const startTime = Date.now();

      while (Date.now() - startTime < 15000) {
        await new Promise((r) => setTimeout(r, 1200));

        if (!this.process) {
          break;
        }

        const overview = this.getOverview();
        const shares = overview.shares || [];

        // Check for share targeting our port or matching our reserved name
        const matchingShare = shares.find((s) => {
          const sTarget = (s.target || s.backendProxyEndpoint || '').replace(/\/+$/, '');
          const hasEndpoint = (s.frontendEndpoints || []).some((ep) => ep.includes(this.reservedName));
          return sTarget.includes(':8766') || hasEndpoint;
        });

        if (matchingShare) {
          this.shareToken = matchingShare.shareToken;
          const endpoint = matchingShare.frontendEndpoints && matchingShare.frontendEndpoints[0];
          this.publicUrl = endpoint
            ? (endpoint.startsWith('http') ? endpoint : `https://${endpoint}`)
            : `https://${this.reservedName}.shares.zrok.io`;

          this.status = 'CONNECTED';
          this.logger.log(`[ZrokManager] Public internet tunnel established: ${this.publicUrl}`);
          return this.publicUrl;
        }
      }

      if (!this.publicUrl && this.process) {
        this.logger.warn('[ZrokManager] Tunnel process started, but public URL discovery timed out.');
      }

      return this.publicUrl;
    } catch (err) {
      this.lastError = err.message;
      this.status = 'ERROR';
      this.logger.error(`[ZrokManager] Failed to start tunnel: ${err.message}`);
      return null;
    }
  }

  /**
   * Stops the public zrok tunnel and deletes the share
   */
  async stop() {
    this.status = 'DISCONNECTED';
    const tokenToDelete = this.shareToken;

    if (this.process) {
      try {
        if (process.platform === 'win32' && this.process.pid) {
          execSync(`taskkill /pid ${this.process.pid} /f /t`, { stdio: 'ignore' });
        } else {
          this.process.kill('SIGKILL');
        }
      } catch (_) {}
      this.process = null;
    }

    if (tokenToDelete) {
      this.deleteShare(tokenToDelete);
    }
    this.cleanupStaleShares();
    this._killLingeringProcesses();

    this.publicUrl = null;
    this.shareToken = null;
    this.logger.log('[ZrokManager] Tunnel stopped cleanly and cloud endpoint deallocated.');
  }

  /**
   * Returns current status object
   */
  getStatus() {
    return {
      enabled: this.enabled,
      status: this.status,
      publicUrl: this.publicUrl,
      shareToken: this.shareToken,
      reservedName: this.reservedName,
      target: this.target,
      tokenConfigured: !!this.token,
      tokenMasked: this.token ? `${this.token.slice(0, 4)}...${this.token.slice(-3)}` : null,
      lastError: this.lastError
    };
  }
}

module.exports = ZrokManager;
