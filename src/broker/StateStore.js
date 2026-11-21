/**
 * StateStore.js
 * Durable, atomic state store for tracking message processing states,
 * worker claims, lease expirations, retries, and dead letters.
 *
 * Concurrency: the broker and every MCP server process share one state file per project.
 * Every change is an atomic read-modify-write under a cross-process file lock
 * (`<state>.json.lock`): re-read the file inside the lock, apply the change, write it with
 * temp-file + rename. Two processes can therefore never both claim the same message, and
 * one process can never overwrite another's changes with a stale in-memory copy.
 * Reads (`tasks`, `deadLetters`, `getTask`) pick up other processes' changes automatically.
 */

const fs = require('fs');
const path = require('path');
const { PROCESSING_STATUS } = require('../protocol/MessageProtocol');
const { withFileLockSync, writeJsonAtomicSync } = require('../domain/FileLock');

class StateStore {
  constructor(options = {}) {
    this.statePath = options.statePath || path.resolve(__dirname, '../../data/mailbox_state.json');
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
    this.projectId = options.projectId || null; // Project these tasks belong to; tagged onto every record
    this.lockTimeoutMs = options.lockTimeoutMs || 10000;
    this._tasks = new Map(); // messageId -> TaskState (copy of the file; use the `tasks` getter)
    this._deadLetters = new Map(); // messageId -> DeadLetterRecord
    this._fileSig = null; // size:mtime of the file when last read, to detect other processes' writes

    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.load();
  }

  // ─── Persistence (cross-process safe) ──────────────────────────

  /** Current tasks. Re-reads the file first if another process changed it. */
  get tasks() {
    this._refreshIfChanged();
    return this._tasks;
  }

  /** Current dead letters. Re-reads the file first if another process changed it. */
  get deadLetters() {
    this._refreshIfChanged();
    return this._deadLetters;
  }

  _signature() {
    try {
      const st = fs.statSync(this.statePath);
      return `${st.size}:${st.mtimeMs}`;
    } catch (_) {
      return null;
    }
  }

  /**
   * Replaces the in-memory copy with the file's content. A file that cannot be parsed is moved
   * aside (never silently overwritten) and the store starts empty.
   */
  _readDisk() {
    let raw = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        raw = fs.existsSync(this.statePath) ? fs.readFileSync(this.statePath, 'utf8') : '';
        break;
      } catch (err) {
        if (attempt === 10) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const tasks = new Map();
    const deadLetters = new Map();
    if (raw && raw.trim()) {
      try {
        const data = JSON.parse(raw);
        for (const [id, t] of Object.entries(data.tasks || {})) {
          if (this.projectId && !t.project) t.project = this.projectId;
          tasks.set(id, t);
        }
        for (const [id, dl] of Object.entries(data.deadLetters || {})) {
          if (this.projectId && !dl.project) dl.project = this.projectId;
          deadLetters.set(id, dl);
        }
      } catch (err) {
        const aside = `${this.statePath}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.statePath, aside); } catch (_) {}
        console.warn(`[StateStore] State file unreadable (${err.message}); moved to ${aside}, starting fresh.`);
      }
    }
    this._tasks = tasks;
    this._deadLetters = deadLetters;
    this._fileSig = this._signature();
  }

  _refreshIfChanged() {
    if (this._signature() === this._fileSig) return;
    try {
      this._readDisk();
    } catch (err) {
      console.warn(`[StateStore] Could not refresh state (keeping last copy): ${err.message}`);
    }
  }

  _writeDisk() {
    writeJsonAtomicSync(this.statePath, {
      version: 1,
      lastUpdated: new Date().toISOString(),
      tasks: Object.fromEntries(this._tasks),
      deadLetters: Object.fromEntries(this._deadLetters)
    });
    this._fileSig = this._signature();
  }

  /**
   * Atomic read-modify-write: lock, re-read the file, run fn(), write, unlock.
   * fn may return { write: false } (or set this._skipWrite) to leave the file untouched.
   */
  _mutate(fn) {
    return withFileLockSync(this.statePath, () => {
      this._readDisk();
      const result = fn();
      if (!(result && result.__noWrite)) this._writeDisk();
      return result && result.__noWrite ? result.value : result;
    }, { timeoutMs: this.lockTimeoutMs });
  }

  /** Loads state from disk (used at start-up). */
  load() {
    try {
      this._readDisk();
    } catch (err) {
      console.warn(`[StateStore] Warning reading state file: ${err.message}. Starting fresh in memory.`);
    }
  }

  /**
   * Kept for old callers. Every change already persists itself under the lock, and writing the
   * in-memory copy here could overwrite other processes' changes, so this does nothing.
   */
  save() {}

  /**
   * Changes one task under the lock: fn(task) edits it in place. Returns the task, or null if missing.
   * Use this instead of editing a task object and calling save().
   */
  updateTask(messageId, fn) {
    return this._mutate(() => {
      const t = this._tasks.get(messageId);
      if (!t) return { __noWrite: true, value: null };
      fn(t);
      return t;
    });
  }

  /**
   * Gets or initializes task state
   */
  getOrCreateTask(msg) {
    const id = msg.messageId || msg.id;
    if (this.tasks.has(id)) return this._tasks.get(id);
    return this._mutate(() => {
      if (this._tasks.has(id)) return { __noWrite: true, value: this._tasks.get(id) };
      const task = {
        messageId: id,
        project: this.projectId || msg.project || null,
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
      this._tasks.set(id, task);
      return task;
    });
  }

  getTask(messageId) {
    return this.tasks.get(messageId) || null;
  }

  isCompleted(messageId) {
    const t = this.tasks.get(messageId);
    return t && t.status === PROCESSING_STATUS.COMPLETED;
  }

  /**
   * Attempts to claim a task for a specific worker. Decided on the freshly read file inside the
   * lock, so of two processes racing for one message exactly one wins.
   */
  claimTask(messageId, workerId, leaseMs = 120000) {
    return this._mutate(() => {
      const t = this._tasks.get(messageId);
      if (!t) return { __noWrite: true, value: false };

      if (t.status === PROCESSING_STATUS.COMPLETED) {
        return { __noWrite: true, value: false }; // Already done
      }

      const now = Date.now();
      // Allow claim if: PENDING, RETRYABLE_FAILED, or lease genuinely expired
      const isLeaseExpired = t.claimOwner && t.leaseExpiresAt > 0 && now > t.leaseExpiresAt;
      const canClaim = t.status === PROCESSING_STATUS.PENDING ||
                       t.status === PROCESSING_STATUS.RETRYABLE_FAILED ||
                       isLeaseExpired ||
                       t.claimOwner === workerId;
      if (!canClaim) return { __noWrite: true, value: false };

      t.status = PROCESSING_STATUS.CLAIMED;
      t.claimOwner = workerId;
      t.leaseExpiresAt = now + leaseMs;
      t.lastAttemptAt = new Date().toISOString();
      t.attemptCount++;
      return true;
    });
  }

  /**
   * Extends the lease of an actively running task if requested by the active owner
   */
  renewLease(messageId, workerId, extendMs = 60000) {
    return this._mutate(() => {
      const t = this._tasks.get(messageId);
      if (!t) return { __noWrite: true, value: false };

      if (t.claimOwner !== workerId) {
        console.warn(`[StateStore] Lease renewal rejected for ${messageId}: owner mismatch (expected ${t.claimOwner}, got ${workerId})`);
        return { __noWrite: true, value: false };
      }
      if (t.status !== PROCESSING_STATUS.CLAIMED && t.status !== PROCESSING_STATUS.RUNNING) {
        return { __noWrite: true, value: false };
      }

      t.leaseExpiresAt = Date.now() + extendMs;
      return true;
    });
  }

  /**
   * Marks a task as actively running by the claim owner
   */
  markRunning(messageId, workerId) {
    return this._mutate(() => {
      const t = this._tasks.get(messageId);
      if (!t || t.claimOwner !== workerId) return { __noWrite: true, value: false };
      t.status = PROCESSING_STATUS.RUNNING;
      return true;
    });
  }

  /**
   * Marks task completed with evidence reference
   */
  markCompleted(messageId, workerId, evidence = null) {
    return this._mutate(() => {
      const t = this._tasks.get(messageId);
      if (!t) return { __noWrite: true, value: false };

      t.status = PROCESSING_STATUS.COMPLETED;
      t.completedAt = new Date().toISOString();
      t.resultEvidence = evidence;
      t.claimOwner = null;
      t.leaseExpiresAt = 0;
      return true;
    });
  }

  /**
   * Marks task failed. If attempts remain, sets RETRYABLE_FAILED; otherwise DEAD_LETTER.
   */
  markFailed(messageId, workerId, error = null, isPermanentFailure = false) {
    return this._mutate(() => {
      const t = this._tasks.get(messageId);
      if (!t) return { __noWrite: true, value: { retry: false, deadLetter: true } };

      t.lastError = error ? String(error) : 'Unknown failure';
      t.claimOwner = null;
      t.leaseExpiresAt = 0;

      const canRetry = !isPermanentFailure && (t.attemptCount < t.maxAttempts);
      if (canRetry) {
        t.status = PROCESSING_STATUS.RETRYABLE_FAILED;
        return { retry: true, attempt: t.attemptCount, maxAttempts: t.maxAttempts };
      }

      t.status = PROCESSING_STATUS.DEAD_LETTER;
      this._deadLetters.set(messageId, {
        messageId,
        project: t.project || this.projectId || null,
        sender: t.sender,
        recipient: t.recipient,
        attempts: t.attemptCount,
        lastError: t.lastError,
        quarantinedAt: new Date().toISOString(),
        isPermanentFailure
      });
      return { retry: false, deadLetter: true, error: t.lastError };
    });
  }

  /**
   * Requeues a dead-letter message
   */
  requeue(messageId) {
    return this._mutate(() => {
      const t = this._tasks.get(messageId);
      if (!t) return { __noWrite: true, value: false };

      t.status = PROCESSING_STATUS.PENDING;
      t.attemptCount = 0;
      t.lastError = null;
      this._deadLetters.delete(messageId);
      return true;
    });
  }

  /**
   * Reconciles crashed tasks on startup/reconnection
   */
  reconcileCrashedTasks() {
    return this._mutate(() => {
      const now = Date.now();
      let reconciledCount = 0;

      for (const [id, t] of this._tasks.entries()) {
        if ((t.status === PROCESSING_STATUS.CLAIMED || t.status === PROCESSING_STATUS.RUNNING) && now > t.leaseExpiresAt) {
          console.log(`[StateStore] Reconciling abandoned/crashed task ${id} (expired by ${now - t.leaseExpiresAt}ms)`);
          if (t.attemptCount < t.maxAttempts) {
            t.status = PROCESSING_STATUS.RETRYABLE_FAILED;
          } else {
            t.status = PROCESSING_STATUS.DEAD_LETTER;
            this._deadLetters.set(id, {
              messageId: id,
              project: t.project || this.projectId || null,
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
      return reconciledCount > 0 ? reconciledCount : { __noWrite: true, value: 0 };
    });
  }
}

module.exports = StateStore;
