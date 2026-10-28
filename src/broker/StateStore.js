/**
 * StateStore.js
 * Durable, atomic state store for tracking message processing states,
 * worker claims, lease expirations, retries, and dead letters.
 */

const fs = require('fs');
const path = require('path');
const { PROCESSING_STATUS } = require('../protocol/MessageProtocol');

class StateStore {
  constructor(options = {}) {
    this.statePath = options.statePath || path.resolve(__dirname, '../../data/mailbox_state.json');
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.tasks = new Map(); // messageId -> TaskState
    this.deadLetters = new Map(); // messageId -> DeadLetterRecord

    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.load();
  }

  /**
   * Safely loads state from disk
   */
  load() {
    if (!fs.existsSync(this.statePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      if (!raw.trim()) return;
      const data = JSON.parse(raw);

      if (data.tasks) {
        for (const [id, t] of Object.entries(data.tasks)) {
          this.tasks.set(id, t);
        }
      }
      if (data.deadLetters) {
        for (const [id, dl] of Object.entries(data.deadLetters)) {
          this.deadLetters.set(id, dl);
        }
      }
    } catch (err) {
      console.warn(`[StateStore] Warning reading state file: ${err.message}. Starting fresh in memory.`);
    }
  }

  /**
   * Atomically saves state to disk using a temp file and atomic rename
   */
  save() {
    try {
      const data = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        tasks: Object.fromEntries(this.tasks),
        deadLetters: Object.fromEntries(this.deadLetters)
      };
      const json = JSON.stringify(data, null, 2);
      const tmpPath = `${this.statePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpPath, json, 'utf8');

      // Windows atomic replacement with retry
      let renamed = false;
      for (let i = 0; i < 5; i++) {
        try {
          fs.renameSync(tmpPath, this.statePath);
          renamed = true;
          break;
        } catch (err) {
          // If destination exists, unlink on Windows fallback
          try { fs.unlinkSync(this.statePath); } catch (_) {}
        }
      }
      if (!renamed && fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
    } catch (err) {
      console.error(`[StateStore] Error persisting state: ${err.message}`);
    }
  }

  /**
   * Gets or initializes task state
   */
  getOrCreateTask(msg) {
    const id = msg.messageId || msg.id;
    if (!this.tasks.has(id)) {
      const task = {
        messageId: id,
        sender: msg.sender || '',
        recipient: msg.recipientRaw || msg.recipient || '',
        status: PROCESSING_STATUS.PENDING,
        attemptCount: 0,
        maxAttempts: this.maxRetries,
        claimOwner: null,
        leaseExpiresAt: 0,
        firstSeenAt: new Date().toISOString(),
        lastAttemptAt: null,
        completedAt: null,
        lastError: null,
        resultEvidence: null
      };
      this.tasks.set(id, task);
      this.save();
    }
    return this.tasks.get(id);
  }

  getTask(messageId) {
    return this.tasks.get(messageId) || null;
  }

  isCompleted(messageId) {
    const t = this.tasks.get(messageId);
    return t && t.status === PROCESSING_STATUS.COMPLETED;
  }

  /**
   * Attempts to claim a task for a specific worker
   */
  claimTask(messageId, workerId, leaseMs = 120000) {
    const t = this.tasks.get(messageId);
    if (!t) return false;

    if (t.status === PROCESSING_STATUS.COMPLETED) {
      return false; // Already done
    }

    const now = Date.now();
    // Allow claim if: PENDING, RETRYABLE_FAILED, or lease genuinely expired
    const isLeaseExpired = t.claimOwner && t.leaseExpiresAt > 0 && now > t.leaseExpiresAt;
    const canClaim = t.status === PROCESSING_STATUS.PENDING ||
                     t.status === PROCESSING_STATUS.RETRYABLE_FAILED ||
                     isLeaseExpired ||
                     t.claimOwner === workerId;

    if (!canClaim) {
      return false;
    }

    t.status = PROCESSING_STATUS.CLAIMED;
    t.claimOwner = workerId;
    t.leaseExpiresAt = now + leaseMs;
    t.lastAttemptAt = new Date().toISOString();
    t.attemptCount++;
    this.save();
    return true;
  }

  /**
   * Extends the lease of an actively running task if requested by the active owner
   */
  renewLease(messageId, workerId, extendMs = 60000) {
    const t = this.tasks.get(messageId);
    if (!t) return false;

    if (t.claimOwner !== workerId) {
      console.warn(`[StateStore] Lease renewal rejected for ${messageId}: owner mismatch (expected ${t.claimOwner}, got ${workerId})`);
      return false;
    }

    if (t.status !== PROCESSING_STATUS.CLAIMED && t.status !== PROCESSING_STATUS.RUNNING) {
      return false;
    }

    t.leaseExpiresAt = Date.now() + extendMs;
    this.save();
    return true;
  }

  /**
   * Marks a task as actively running by the claim owner
   */
  markRunning(messageId, workerId) {
    const t = this.tasks.get(messageId);
    if (!t) return false;
    if (t.claimOwner !== workerId) return false;

    t.status = PROCESSING_STATUS.RUNNING;
    this.save();
    return true;
  }

  /**
   * Marks task completed with evidence reference
   */
  markCompleted(messageId, workerId, evidence = null) {
    const t = this.tasks.get(messageId);
    if (!t) return false;

    t.status = PROCESSING_STATUS.COMPLETED;
    t.completedAt = new Date().toISOString();
    t.resultEvidence = evidence;
    t.claimOwner = null;
    t.leaseExpiresAt = 0;
    this.save();
    return true;
  }

  /**
   * Marks task failed. If attempts remain, sets RETRYABLE_FAILED; otherwise DEAD_LETTER.
   */
  markFailed(messageId, workerId, error = null, isPermanentFailure = false) {
    const t = this.tasks.get(messageId);
    if (!t) return { retry: false, deadLetter: true };

    t.lastError = error ? String(error) : 'Unknown failure';
    t.claimOwner = null;
    t.leaseExpiresAt = 0;

    const canRetry = !isPermanentFailure && (t.attemptCount < t.maxAttempts);

    if (canRetry) {
      t.status = PROCESSING_STATUS.RETRYABLE_FAILED;
      this.save();
      return { retry: true, attempt: t.attemptCount, maxAttempts: t.maxAttempts };
    } else {
      t.status = PROCESSING_STATUS.DEAD_LETTER;
      this.deadLetters.set(messageId, {
        messageId,
        sender: t.sender,
        recipient: t.recipient,
        attempts: t.attemptCount,
        lastError: t.lastError,
        quarantinedAt: new Date().toISOString(),
        isPermanentFailure
      });
      this.save();
      return { retry: false, deadLetter: true, error: t.lastError };
    }
  }

  /**
   * Requeues a dead-letter message
   */
  requeue(messageId) {
    const t = this.tasks.get(messageId);
    if (!t) return false;

    t.status = PROCESSING_STATUS.PENDING;
    t.attemptCount = 0;
    t.lastError = null;
    this.deadLetters.delete(messageId);
    this.save();
    return true;
  }

  /**
   * Reconciles crashed tasks on startup/reconnection
   */
  reconcileCrashedTasks() {
    const now = Date.now();
    let reconciledCount = 0;

    for (const [id, t] of this.tasks.entries()) {
      if (t.status === PROCESSING_STATUS.CLAIMED || t.status === PROCESSING_STATUS.RUNNING) {
        if (now > t.leaseExpiresAt) {
          console.log(`[StateStore] Reconciling abandoned/crashed task ${id} (expired by ${now - t.leaseExpiresAt}ms)`);
          if (t.attemptCount < t.maxAttempts) {
            t.status = PROCESSING_STATUS.RETRYABLE_FAILED;
          } else {
            t.status = PROCESSING_STATUS.DEAD_LETTER;
            this.deadLetters.set(id, {
              messageId: id,
              attempts: t.attemptCount,
              lastError: 'Crashed/abandoned lease expired on restart',
              quarantinedAt: new Date().toISOString()
            });
          }
          t.claimOwner = null;
          t.leaseExpiresAt = 0;
          reconciledCount++;
        }
      }
    }

    if (reconciledCount > 0) {
      this.save();
    }
    return reconciledCount;
  }
}

module.exports = StateStore;
