/**
 * ZrokManager.js
 * Manages zrok public internet tunneling for the MailSocketTactics Control Center and broker.
 * Enables simultaneous local access (127.0.0.1) and secure public internet access.
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

    this.process = null;
    this.publicUrl = null;
    this.shareToken = null;
    this.status = this.enabled ? 'DISCONNECTED' : 'DISABLED';
    this.lastError = null;
    this.logger = options.logger || console;
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
   * Queries existing shares via zrok list shares --json
   */
  listShares() {
    try {
      const jsonStr = execSync(`"${this.binPath}" list shares --json`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000
      });
      const data = JSON.parse(jsonStr);
      return data.shares || [];
    } catch (_) {
      return [];
    }
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

    const normalizedTarget = this.target.replace(/\/+$/, '');

    // Snapshot existing share tokens before spawning to guarantee picking ONLY the new share
    const existingTokens = new Set(
      this.listShares().map((s) => s.shareToken).filter(Boolean)
    );

    try {
      // Spawn headless share process
      this.logger.log(`[ZrokManager] Launching zrok public tunnel to target ${this.target}...`);
      const child = spawn(this.binPath, ['share', 'public', '--headless', this.target], {
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

      // Poll zrok list shares --json for up to 15 seconds to discover assigned public URL
      const startTime = Date.now();

      while (Date.now() - startTime < 15000) {
        await new Promise((r) => setTimeout(r, 1200));

        if (!this.process) {
          break;
        }

        const shares = this.listShares();
        // Priority 1: Newly created share whose token was not present before spawn
        let matchingShare = shares.find((s) => {
          const sTarget = (s.target || '').replace(/\/+$/, '');
          return sTarget === normalizedTarget && s.shareMode === 'public' && !existingTokens.has(s.shareToken);
        });

        // Fallback: If existingTokens already had it (e.g. restart), pick newest by createdAt
        if (!matchingShare) {
          const allMatching = shares
            .filter((s) => {
              const sTarget = (s.target || '').replace(/\/+$/, '');
              return sTarget === normalizedTarget && s.shareMode === 'public';
            })
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          matchingShare = allMatching[0];
        }

        if (matchingShare && matchingShare.frontendEndpoints && matchingShare.frontendEndpoints.length > 0) {
          this.shareToken = matchingShare.shareToken;
          const endpoint = matchingShare.frontendEndpoints[0];
          this.publicUrl = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;
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
        this.process.kill();
      } catch (_) {}
      this.process = null;
    }

    if (tokenToDelete) {
      try {
        execSync(`"${this.binPath}" delete share ${tokenToDelete}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 8000
        });
      } catch (_) {}
    }

    this.publicUrl = null;
    this.shareToken = null;
    this.logger.log('[ZrokManager] Tunnel stopped cleanly.');
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
      target: this.target,
      tokenConfigured: !!this.token,
      tokenMasked: this.token ? `${this.token.slice(0, 4)}...${this.token.slice(-3)}` : null,
      lastError: this.lastError
    };
  }
}

module.exports = ZrokManager;
