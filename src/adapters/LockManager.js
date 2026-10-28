/**
 * LockManager.js
 * Atomic file lock manager with worker identification, lease expiration,
 * stale lock recovery, and safe ownership checks.
 */

const fs = require('fs');
const path = require('path');

class LockManager {
  constructor(agentId, baseDir = null) {
    this.agentId = agentId;
    this.baseDir = baseDir || path.resolve(__dirname, `../../.locks/${agentId}`);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    this.workerId = `${agentId}-${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  }

  getLockPath(messageId) {
    return path.join(this.baseDir, `${messageId}.lock`);
  }

  isProcessAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means process exists but we lack permissions; ESRCH means process does not exist
      return e.code === 'EPERM';
    }
  }

  /**
   * Attempts to atomically acquire a lock for messageId.
   * Recovers stale locks if expired or holding process is dead.
   */
  acquireLock(messageId, leaseMs = 120000) {
    const lockPath = this.getLockPath(messageId);
    const now = Date.now();
    const lockPayload = {
      messageId,
      workerId: this.workerId,
      agentId: this.agentId,
      pid: process.pid,
      acquiredAt: now,
      leaseExpiresAt: now + leaseMs
    };
    const json = JSON.stringify(lockPayload, null, 2);

    try {
      // 'wx' flag fails atomically if file already exists
      fs.writeFileSync(lockPath, json, { flag: 'wx' });
      return { acquired: true, workerId: this.workerId };
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error(`[LockManager] Unexpected lock error: ${err.message}`);
        return { acquired: false, error: err.message };
      }

      // File exists - inspect for staleness
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const existing = JSON.parse(raw);

        // If owned by ourselves
        if (existing.workerId === this.workerId) {
          return { acquired: true, workerId: this.workerId, existing: true };
        }

        const isExpired = now > existing.leaseExpiresAt;
        const processDead = existing.pid ? !this.isProcessAlive(existing.pid) : true;

        if (isExpired || processDead) {
          console.log(`[LockManager] Recovering stale lock for ${messageId} (expired: ${isExpired}, dead PID ${existing.pid}: ${processDead})`);
          try {
            fs.unlinkSync(lockPath);
          } catch (_) {}

          // Try acquire once more
          fs.writeFileSync(lockPath, json, { flag: 'wx' });
          return { acquired: true, workerId: this.workerId, recovered: true };
        } else {
          // Valid active lock held by another live process
          return { acquired: false, reason: 'LOCKED_BY_ACTIVE_WORKER', owner: existing.workerId };
        }
      } catch (readErr) {
        // If file was deleted or invalid JSON, try acquire
        try {
          fs.writeFileSync(lockPath, json, { flag: 'wx' });
          return { acquired: true, workerId: this.workerId };
        } catch (_) {
          return { acquired: false, reason: 'CONCURRENT_CLAIM_FAILED' };
        }
      }
    }
  }

  /**
   * Extends the lease of an actively held lock
   */
  renewLock(messageId, extendMs = 60000) {
    const lockPath = this.getLockPath(messageId);
    if (!fs.existsSync(lockPath)) return false;

    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (existing.workerId !== this.workerId) {
        return false; // Not our lock!
      }

      existing.leaseExpiresAt = Date.now() + extendMs;
      fs.writeFileSync(lockPath, JSON.stringify(existing, null, 2), 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Safely releases the lock ONLY if this worker owns it
   */
  releaseLock(messageId) {
    const lockPath = this.getLockPath(messageId);
    if (!fs.existsSync(lockPath)) return true;

    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (existing.workerId !== this.workerId) {
        console.warn(`[LockManager] Refusing to delete lock for ${messageId}: owned by ${existing.workerId}, not ${this.workerId}`);
        return false;
      }
      fs.unlinkSync(lockPath);
      return true;
    } catch (err) {
      console.warn(`[LockManager] Error releasing lock: ${err.message}`);
      return false;
    }
  }
}

module.exports = LockManager;
