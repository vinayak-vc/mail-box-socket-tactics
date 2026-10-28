/**
 * TaskDomainService.js
 * Domain service for managing task claims, lifecycle transitions, retries, and history.
 * Shared by REST API, WebSocket event broker, and MCP server.
 */

const { PROCESSING_STATUS, isRecipientMatch, normalizeAgentId } = require('../protocol/MessageProtocol');

class TaskDomainService {
  constructor(options = {}) {
    this.stateStore = options.stateStore;
    this.logger = options.logger || console;
    this.onEvent = options.onEvent || (() => {});
    this.mailboxService = options.mailboxService;
    this.history = new Map(); // messageId -> Array of history events
  }

  setStateStore(store) {
    this.stateStore = store;
  }

  setMailboxService(svc) {
    this.mailboxService = svc;
  }

  _recordHistory(messageId, eventType, data = {}) {
    if (!this.history.has(messageId)) {
      this.history.set(messageId, []);
    }
    const entry = {
      timestamp: new Date().toISOString(),
      type: eventType,
      ...data
    };
    this.history.get(messageId).push(entry);
  }

  async _ensureTask(messageId) {
    if (!this.stateStore) return null;
    let task = this.stateStore.getTask(messageId);
    if (!task && this.mailboxService) {
      try {
        const msg = await this.mailboxService.getMessageById(messageId);
        if (msg) {
          task = this.stateStore.getOrCreateTask(msg);
        }
      } catch (_) {}
    }
    return task;
  }

  /**
   * Atomically claims an eligible message for an authenticated agent
   */
  async claimMessage({ messageId, agentId, workerId = null, leaseMs = 120000 }) {
    if (!this.stateStore) throw new Error('StateStore not initialized');
    if (!messageId || !agentId) throw new Error("Missing required fields: 'messageId', 'agentId'");

    const task = await this._ensureTask(messageId);
    if (!task) {
      throw new Error(`Task ${messageId} not found in state store`);
    }

    // Verify recipient authorization
    const normAgent = normalizeAgentId(agentId);
    if (!isRecipientMatch(normAgent, task.recipient)) {
      throw new Error(`Unauthorized: Agent ${agentId} is not a designated recipient for task ${messageId} (${task.recipient})`);
    }

    const effectiveWorker = workerId || `${agentId}-${process.pid}-${Date.now()}`;
    const claimed = this.stateStore.claimTask(messageId, effectiveWorker, leaseMs);

    if (!claimed) {
      if (task.status === PROCESSING_STATUS.COMPLETED) {
        throw new Error(`Task ${messageId} is already completed`);
      }
      throw new Error(`Task ${messageId} is already claimed by worker ${task.claimOwner || 'another active worker'}`);
    }

    this._recordHistory(messageId, 'CLAIMED', { agentId, workerId: effectiveWorker, leaseMs });
    this.onEvent('TASK_LIFECYCLE', { messageId, status: PROCESSING_STATUS.CLAIMED, agentId, workerId: effectiveWorker });

    return {
      success: true,
      messageId,
      status: PROCESSING_STATUS.CLAIMED,
      claimOwner: effectiveWorker,
      leaseExpiresAt: task.leaseExpiresAt
    };
  }

  /**
   * Records task execution state transition (e.g. CLAIMED -> RUNNING)
   */
  async updateStatus({ messageId, status, agentId, workerId = null, details = null }) {
    if (!this.stateStore) throw new Error('StateStore not initialized');
    const task = await this._ensureTask(messageId);
    if (!task) throw new Error(`Task ${messageId} not found`);

    const validStatuses = Object.values(PROCESSING_STATUS);
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status '${status}'. Must be one of: ${validStatuses.join(', ')}`);
    }

    const normAgent = normalizeAgentId(agentId).toLowerCase();
    if (task.claimOwner && !task.claimOwner.toLowerCase().includes(normAgent)) {
      throw new Error(`Unauthorized: Task is claimed by ${task.claimOwner}`);
    }

    if (status === PROCESSING_STATUS.RUNNING) {
      this.stateStore.markRunning(messageId, workerId || task.claimOwner);
    } else {
      task.status = status;
      this.stateStore.save();
    }

    this._recordHistory(messageId, status, { agentId, details });
    this.onEvent('TASK_LIFECYCLE', { messageId, status, agentId, details });

    return { success: true, messageId, status };
  }

  /**
   * Records actual task completion with evidence
   */
  async completeTask({ messageId, agentId, evidence = {}, responseMessageId = null }) {
    if (!this.stateStore) throw new Error('StateStore not initialized');
    const task = await this._ensureTask(messageId);
    if (!task) throw new Error(`Task ${messageId} not found`);

    const normAgent = normalizeAgentId(agentId).toLowerCase();
    if (task.claimOwner && !task.claimOwner.toLowerCase().includes(normAgent)) {
      throw new Error(`Unauthorized: Task completion must be recorded by the claiming agent (claimed by ${task.claimOwner})`);
    }

    const completionEvidence = {
      completedBy: agentId,
      workerId: evidence.workerId || task.claimOwner,
      completedAt: new Date().toISOString(),
      responseMessageId: responseMessageId || evidence.responseMessageId || null,
      ...evidence
    };

    this.stateStore.markCompleted(messageId, completionEvidence.workerId || task.claimOwner, completionEvidence);
    this._recordHistory(messageId, 'COMPLETED', { agentId, evidence: completionEvidence });
    this.onEvent('TASK_LIFECYCLE', { messageId, status: PROCESSING_STATUS.COMPLETED, agentId, evidence: completionEvidence });

    return {
      success: true,
      messageId,
      status: PROCESSING_STATUS.COMPLETED,
      completedAt: task.completedAt
    };
  }

  /**
   * Records task failure and evaluates retry/dead-letter eligibility
   */
  async failTask({ messageId, agentId, error, isPermanent = false }) {
    if (!this.stateStore) throw new Error('StateStore not initialized');
    const task = await this._ensureTask(messageId);
    if (!task) throw new Error(`Task ${messageId} not found`);

    const errorMsg = typeof error === 'string' ? error : (error && error.message ? error.message : 'Unknown execution failure');
    const res = this.stateStore.markFailed(messageId, task.claimOwner || agentId, errorMsg, isPermanent);
    const newStatus = res.retry ? PROCESSING_STATUS.RETRYABLE_FAILED : PROCESSING_STATUS.DEAD_LETTER;

    this._recordHistory(messageId, newStatus, { agentId, error: errorMsg, isPermanent, attempt: task.attemptCount });
    this.onEvent('TASK_LIFECYCLE', { messageId, status: newStatus, agentId, error: errorMsg });

    return {
      success: true,
      messageId,
      status: newStatus,
      attempts: task.attemptCount,
      maxAttempts: task.maxAttempts,
      error: errorMsg
    };
  }

  /**
   * Requeues a failed or dead-lettered task
   */
  async retryTask(messageId, requestedBy = 'operator') {
    if (!this.stateStore) throw new Error('StateStore not initialized');
    const requeued = this.stateStore.requeue(messageId);
    if (!requeued) {
      throw new Error(`Task ${messageId} is not in a retryable or dead-letter state`);
    }

    this._recordHistory(messageId, 'REQUEUED', { requestedBy });
    this.onEvent('TASK_LIFECYCLE', { messageId, status: PROCESSING_STATUS.PENDING, requestedBy });

    return { success: true, messageId, status: PROCESSING_STATUS.PENDING };
  }

  /**
   * Cancels a pending or running task
   */
  async cancelTask(messageId, reason = 'Cancelled by administrator') {
    if (!this.stateStore) throw new Error('StateStore not initialized');
    const task = this.stateStore.getTask(messageId);
    if (!task) throw new Error(`Task ${messageId} not found`);

    task.status = 'CANCELLED';
    task.lastError = reason;
    this.stateStore.save();

    this._recordHistory(messageId, 'CANCELLED', { reason });
    this.onEvent('TASK_LIFECYCLE', { messageId, status: 'CANCELLED', reason });

    return { success: true, messageId, status: 'CANCELLED' };
  }

  /**
   * Gets task lifecycle and attempt history
   */
  getTaskHistory(messageId) {
    const task = this.stateStore ? this.stateStore.getTask(messageId) : null;
    const recordedEvents = this.history.get(messageId) || [];

    return {
      messageId,
      task,
      events: recordedEvents
    };
  }
}

module.exports = TaskDomainService;
