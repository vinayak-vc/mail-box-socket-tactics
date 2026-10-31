/**
 * BaseAgentAdapter.js
 * Base class for agent-specific adapters.
 * Manages WebSocket connection, auto-reconnect, authentication, subscriptions,
 * atomic worker locks, periodic lease renewal, dispatching, and status reporting.
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const {
  EVENT_TYPES,
  PROCESSING_STATUS,
  isRecipientMatch,
  parseMailboxMessages
} = require('../protocol/MessageProtocol');
const LockManager = require('./LockManager');

class BaseAgentAdapter {
  constructor(options = {}) {
    this.agentId = options.agentId || 'UnknownAgent';
    this.brokerUrl = options.brokerUrl || 'ws://127.0.0.1:8765';
    this.authToken = options.authToken || 'mailbox-socket-secret-token';
    this.mailboxPath = options.mailboxPath || path.resolve(__dirname, '../../Documentation/TEAM_MAILBOX.md');
    this.workingDir = options.workingDir || process.cwd();
    this.reconnectIntervalMs = options.reconnectIntervalMs || 3000;
    this.maxReconnectIntervalMs = options.maxReconnectIntervalMs || 30000;
    this.currentReconnectDelay = this.reconnectIntervalMs;
    this.leaseTimeoutMs = options.leaseTimeoutMs || 120000;
    this.leaseRenewalIntervalMs = options.leaseRenewalIntervalMs || 30000;

    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.isStopping = false;

    // Local lock manager with unique worker ID
    this.lockManager = new LockManager(this.agentId, options.lockDir);
    this.workerId = this.lockManager.workerId;

    // Deduplication and active tracking
    this.processedMessageIds = new Set(options.processedMessageIds || []);
    this.activeProcessing = new Set();
    this.activeRenewalTimers = new Map(); // messageId -> intervalTimer
    this.lastSeenNumber = options.initialSeenNumber || 0;

    // Optional durable state (set by ServiceRunner). Without it the adapter is stateless (tests).
    this.statePath = options.statePath || null;
    // When false, messages addressed to several agents (or ALL) are not auto-dispatched to a headless CLI
    this.dispatchBroadcast = options.dispatchBroadcast !== undefined ? options.dispatchBroadcast : true;
    this.hasPersistedState = false;
    this.loadState();
  }

  /**
   * Loads the durable set of handled message IDs so a restart/reconnect never re-runs history
   */
  loadState() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      for (const id of data.processedMessageIds || []) this.processedMessageIds.add(id);
      this.hasPersistedState = true;
    } catch (err) {
      console.warn(`[${this.agentId}Adapter] Could not read adapter state ${this.statePath}: ${err.message}`);
    }
  }

  saveState() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: 1,
        lastUpdated: new Date().toISOString(),
        processedMessageIds: Array.from(this.processedMessageIds)
      }), 'utf8');
      fs.renameSync(tmp, this.statePath);
      this.hasPersistedState = true;
    } catch (err) {
      console.warn(`[${this.agentId}Adapter] Could not persist adapter state: ${err.message}`);
    }
  }

  /**
   * True when the recipient string targets more than one agent (or everyone).
   * The human owner is not an agent, so "Claude,Owner" is a direct message.
   */
  isBroadcast(recipientRaw) {
    const tokens = String(recipientRaw || '').toLowerCase().split(/[,/&]|\band\b/).map(t => t.trim()).filter(Boolean);
    if (tokens.some(t => t === 'all' || t === 'everyone' || t === 'team')) return true;
    return tokens.filter(t => !(t === 'owner' || t === 'human' || t === 'h' || t.startsWith('owner '))).length > 1;
  }

  /**
   * Starts adapter connection
   */
  start() {
    this.isStopping = false;
    this.connect();
  }

  /**
   * Connects to WebSocket broker
   */
  connect() {
    if (this.isStopping) return;

    try {
      this.ws = new WebSocket(this.brokerUrl);

      this.ws.on('open', () => {
        console.log(`[${this.agentId}Adapter] Connected to broker at ${this.brokerUrl} (Worker: ${this.workerId})`);
        this.isConnected = true;
        this.currentReconnectDelay = this.reconnectIntervalMs;

        // Authenticate with workerId
        this.ws.send(JSON.stringify({
          type: EVENT_TYPES.AUTH_REQUEST,
          agentId: this.agentId,
          token: this.authToken,
          workerId: this.workerId
        }));
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleBrokerMessage(msg);
        } catch (err) {
          console.error(`[${this.agentId}Adapter] Error parsing broker message: ${err.message}`);
        }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.isAuthenticated = false;
        console.warn(`[${this.agentId}Adapter] Disconnected from broker.`);
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.warn(`[${this.agentId}Adapter] Connection error: ${err.message}`);
        this.ws.close();
      });

    } catch (err) {
      console.error(`[${this.agentId}Adapter] Failed to initiate connection: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedules reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.isStopping) return;
    setTimeout(() => {
      console.log(`[${this.agentId}Adapter] Attempting reconnect to ${this.brokerUrl}...`);
      this.connect();
    }, this.currentReconnectDelay);

    this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 1.5, this.maxReconnectIntervalMs);
  }

  /**
   * Handles incoming broker messages
   */
  async handleBrokerMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.AUTH_RESPONSE: {
        if (msg.success) {
          this.isAuthenticated = true;
          console.log(`[${this.agentId}Adapter] Authenticated successfully with broker.`);

          // Subscribe strictly to own channel
          this.ws.send(JSON.stringify({
            type: EVENT_TYPES.SUBSCRIBE,
            channels: [this.agentId]
          }));

          // Run catch-up discovery from durable mailbox
          await this.performCatchup();
        } else {
          console.error(`[${this.agentId}Adapter] Authentication failed: ${msg.error}`);
        }
        break;
      }

      case EVENT_TYPES.SUBSCRIBE_ACK: {
        console.log(`[${this.agentId}Adapter] Subscriptions confirmed: ${JSON.stringify(msg.grantedChannels)}`);
        break;
      }

      case EVENT_TYPES.PING: {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: EVENT_TYPES.PONG,
            agentId: this.agentId,
            workerId: this.workerId
          }));
        }
        break;
      }

      case EVENT_TYPES.LEASE_RENEW_ACK: {
        if (!msg.success) {
          console.warn(`[${this.agentId}Adapter] Lease renewal warning for ${msg.messageId}: ${msg.error}`);
        }
        break;
      }

      case EVENT_TYPES.MAILBOX_MESSAGE_NOTIFY: {
        await this.handleNotification(msg);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Processes a notification event with atomic locking and lease renewal
   */
  async handleNotification(notify) {
    const messageId = notify.messageId;
    if (!messageId) return;

    // Validate recipient
    if (!isRecipientMatch(this.agentId, notify.recipientRaw)) {
      return; // Not for this agent
    }

    // Broadcast messages are not auto-run by headless CLIs unless explicitly enabled (token/usage burn)
    if (!this.dispatchBroadcast && this.isBroadcast(notify.recipientRaw)) {
      console.log(`[${this.agentId}Adapter] ${messageId} is a multi-recipient broadcast (${notify.recipientRaw}); not auto-dispatching.`);
      this.processedMessageIds.add(messageId);
      this.saveState();
      return;
    }

    // Check duplicate in-memory
    if (this.processedMessageIds.has(messageId)) {
      console.log(`[${this.agentId}Adapter] Message ${messageId} already completed. Ignoring duplicate.`);
      return;
    }

    // Check active memory processing
    if (this.activeProcessing.has(messageId)) {
      console.log(`[${this.agentId}Adapter] Message ${messageId} is currently being processed by this instance.`);
      return;
    }

    // Atomic filesystem lock acquisition
    const lockResult = this.lockManager.acquireLock(messageId, this.leaseTimeoutMs);
    if (!lockResult.acquired) {
      console.log(`[${this.agentId}Adapter] Could not acquire lock for ${messageId} (${lockResult.reason || 'held by another worker'}). Skipping.`);
      return;
    }

    this.activeProcessing.add(messageId);

    // Send ACK: CLAIMED
    this.sendAck(messageId, PROCESSING_STATUS.CLAIMED);

    // Start periodic lease renewal heartbeat
    this.startLeaseRenewal(messageId);

    try {
      // Read authoritative message from mailbox
      const authoritativeMessage = await this.retrieveAuthoritativeMessage(messageId);
      if (!authoritativeMessage) {
        throw new Error(`Authoritative message ${messageId} not found in ${this.mailboxPath}`);
      }

      console.log(`[${this.agentId}Adapter] Starting execution for ${messageId} from ${authoritativeMessage.sender}`);
      this.sendAck(messageId, PROCESSING_STATUS.RUNNING);

      // Dispatch to specific agent invocation implementation
      const result = await this.dispatchMessage(authoritativeMessage);

      // Processing complete
      this.processedMessageIds.add(messageId);
      this.saveState();
      if (authoritativeMessage.number > this.lastSeenNumber) {
        this.lastSeenNumber = authoritativeMessage.number;
      }

      const evidence = result && result.evidence ? result.evidence : `Completed by ${this.workerId}`;
      this.sendAck(messageId, PROCESSING_STATUS.COMPLETED, null, evidence);
      console.log(`[${this.agentId}Adapter] Successfully completed processing of ${messageId}`);

    } catch (err) {
      console.error(`[${this.agentId}Adapter] Processing error for ${messageId}: ${err.message}`);
      this.sendAck(messageId, PROCESSING_STATUS.FAILED, err.message);
    } finally {
      this.stopLeaseRenewal(messageId);
      this.activeProcessing.delete(messageId);
      this.lockManager.releaseLock(messageId);
    }
  }

  /**
   * Starts periodic lease renewal during long-running tasks
   */
  startLeaseRenewal(messageId) {
    if (this.activeRenewalTimers.has(messageId)) return;

    const timer = setInterval(() => {
      if (this.activeProcessing.has(messageId) && this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Renew with broker
        this.ws.send(JSON.stringify({
          type: EVENT_TYPES.LEASE_RENEW,
          messageId,
          workerId: this.workerId,
          extendMs: this.leaseTimeoutMs
        }));
        // Renew local lock
        this.lockManager.renewLock(messageId, this.leaseTimeoutMs);
      }
    }, this.leaseRenewalIntervalMs);

    this.activeRenewalTimers.set(messageId, timer);
  }

  /**
   * Stops periodic lease renewal
   */
  stopLeaseRenewal(messageId) {
    const timer = this.activeRenewalTimers.get(messageId);
    if (timer) {
      clearInterval(timer);
      this.activeRenewalTimers.delete(messageId);
    }
  }

  /**
   * Retrieves authoritative message from TEAM_MAILBOX.md
   */
  async retrieveAuthoritativeMessage(messageId) {
    if (!fs.existsSync(this.mailboxPath)) return null;
    const text = await fs.promises.readFile(this.mailboxPath, 'utf8');
    const messages = parseMailboxMessages(text);
    return messages.find(m => m.id === messageId) || null;
  }

  /**
   * Catch-up scan on startup/reconnect to discover unhandled messages
   */
  async performCatchup() {
    try {
      if (!fs.existsSync(this.mailboxPath)) return;
      const text = await fs.promises.readFile(this.mailboxPath, 'utf8');
      const messages = parseMailboxMessages(text);

      // First ever run with durable state: treat existing history as already handled.
      // Otherwise every restart would re-run the whole mailbox through the headless CLI.
      if (this.statePath && !this.hasPersistedState) {
        for (const msg of messages) this.processedMessageIds.add(msg.id);
        this.saveState();
        console.log(`[${this.agentId}Adapter] Catch-up baseline: ${messages.length} existing messages marked handled.`);
        return;
      }

      for (const msg of messages) {
        if (!this.processedMessageIds.has(msg.id) &&
            isRecipientMatch(this.agentId, msg.recipientRaw) &&
            msg.sender.toLowerCase() !== this.agentId.toLowerCase()) {
          console.log(`[${this.agentId}Adapter] Catch-up: discovered pending message ${msg.id}`);
          await this.handleNotification({
            messageId: msg.id,
            party: msg.party,
            number: msg.number,
            sender: msg.sender,
            recipientRaw: msg.recipientRaw,
            timestamp: msg.timestamp,
            mailboxPath: this.mailboxPath,
            isCatchup: true
          });
        }
      }
    } catch (err) {
      console.error(`[${this.agentId}Adapter] Catch-up error: ${err.message}`);
    }
  }

  /**
   * Sends acknowledgement to broker
   */
  sendAck(messageId, status, error = null, evidence = null) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({
          type: EVENT_TYPES.MESSAGE_ACK,
          messageId,
          agentId: this.agentId,
          workerId: this.workerId,
          status,
          error,
          evidence,
          timestamp: new Date().toISOString()
        }));
      } catch (err) {
        console.error(`[${this.agentId}Adapter] Failed to send ACK: ${err.message}`);
      }
    }
  }

  /**
   * Abstract dispatch method to be implemented by child classes
   */
  async dispatchMessage(message) {
    throw new Error('dispatchMessage must be implemented by subclass');
  }

  /**
   * Stops adapter cleanly
   */
  stop() {
    this.isStopping = true;
    for (const [msgId] of this.activeRenewalTimers.entries()) {
      this.stopLeaseRenewal(msgId);
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthenticated = false;
  }
}

module.exports = BaseAgentAdapter;
