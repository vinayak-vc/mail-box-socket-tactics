/**
 * MailboxWatcher.js
 * Durable file watcher for TEAM_MAILBOX.md.
 * Handles path validation, atomic file reads, transient lock retries,
 * deduplication, and emits verified new message notifications.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { parseMailboxMessages } = require('../protocol/MessageProtocol');

class MailboxWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.mailboxPath = options.mailboxPath || path.resolve(__dirname, '../../Documentation/TEAM_MAILBOX.md');
    this.allowCreate = Boolean(options.allowCreate); // Only true in explicit test setup
    this.failFastOnMissing = options.failFastOnMissing !== undefined ? options.failFastOnMissing : true;
    this.seenMessageIds = new Set(options.seenMessageIds || []);
    this.lastFileMtime = 0;
    this.isWatching = false;
    this.fsWatcher = null;
    this.debounceTimer = null;
    this.debounceIntervalMs = options.debounceIntervalMs || 150;
    this.pollIntervalMs = options.pollIntervalMs || 10000; // Local check fallback, zero AI
    this.pollTimer = null;

    // Validate path on construction
    this.validatePath();
  }

  /**
   * Validates configured mailbox path; prevents silent creation of split mailboxes
   */
  validatePath() {
    if (!fs.existsSync(this.mailboxPath)) {
      if (!this.allowCreate && this.failFastOnMissing) {
        throw new Error(
          `[MailboxWatcher] Fatal: Configured authoritative mailbox not found at '${this.mailboxPath}'. ` +
          `Refusing to automatically create a new mailbox which would split agent communication.`
        );
      }
    }
  }

  /**
   * Reads the mailbox file safely, retrying on transient locks (e.g. while another party is appending).
   */
  async readMailboxFile(maxRetries = 12, retryDelayMs = 50) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!fs.existsSync(this.mailboxPath)) {
          if (!this.allowCreate && this.failFastOnMissing) {
            throw new Error(`Authoritative mailbox at ${this.mailboxPath} is missing.`);
          }
          return null;
        }
        const text = await fs.promises.readFile(this.mailboxPath, 'utf8');
        return text;
      } catch (err) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to read mailbox at ${this.mailboxPath} after ${maxRetries} attempts: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    return null;
  }

  /**
   * Initializes seen IDs from existing file without emitting new events.
   */
  async initBaseline() {
    try {
      const text = await this.readMailboxFile();
      if (text) {
        const messages = parseMailboxMessages(text);
        for (const msg of messages) {
          this.seenMessageIds.add(msg.id);
        }
        const stats = fs.statSync(this.mailboxPath);
        this.lastFileMtime = stats.mtimeMs;
        console.log(`[MailboxWatcher] Baseline initialized with ${messages.length} existing messages.`);
      }
    } catch (err) {
      if (this.failFastOnMissing && !this.allowCreate) {
        throw err;
      }
      console.warn(`[MailboxWatcher] Warning initializing baseline: ${err.message}`);
    }
  }

  /**
   * Checks file for any new messages and emits events for each new message found.
   */
  async checkNow() {
    try {
      const text = await this.readMailboxFile();
      if (!text) return [];

      const messages = parseMailboxMessages(text);
      const newMessages = [];

      for (const msg of messages) {
        if (!this.seenMessageIds.has(msg.id)) {
          this.seenMessageIds.add(msg.id);
          newMessages.push(msg);
        }
      }

      for (const msg of newMessages) {
        this.emit('new_message', {
          messageId: msg.id,
          party: msg.party,
          number: msg.number,
          sender: msg.sender,
          recipientRaw: msg.recipientRaw,
          timestamp: msg.timestamp || new Date().toISOString(),
          mailboxPath: this.mailboxPath,
          headerLine: msg.headerLine,
          isMalformed: msg.isMalformed
        });
      }

      return newMessages;
    } catch (err) {
      this.emit('error', err);
      return [];
    }
  }

  /**
   * Starts file system watcher and background local poll fallback.
   */
  start() {
    if (this.isWatching) return;
    this.isWatching = true;

    // Validate path before watching
    this.validatePath();

    const dir = path.dirname(this.mailboxPath);

    // Set up FS Watcher on file directory
    try {
      this.fsWatcher = fs.watch(dir, (eventType, filename) => {
        if (!filename || filename === path.basename(this.mailboxPath)) {
          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.checkNow().catch(err => this.emit('error', err));
          }, this.debounceIntervalMs);
        }
      });
    } catch (err) {
      console.warn(`[MailboxWatcher] fs.watch setup warning: ${err.message}`);
    }

    // Fallback local periodic check (guarantees recovery even if OS drops FS notification)
    this.pollTimer = setInterval(() => {
      this.checkNow().catch(err => this.emit('error', err));
    }, this.pollIntervalMs);
  }

  /**
   * Stops watching
   */
  stop() {
    this.isWatching = false;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

module.exports = MailboxWatcher;
