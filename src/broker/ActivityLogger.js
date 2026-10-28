/**
 * ActivityLogger.js
 * In-memory ring buffer and persistent JSONL logger for operational telemetry.
 * Automatically sanitizes secrets, tokens, and credentials.
 */

const fs = require('fs');
const path = require('path');

class ActivityLogger {
  constructor(options = {}) {
    this.maxMemoryEvents = options.maxMemoryEvents || 500;
    this.logFilePath = options.logFilePath || path.resolve(__dirname, '../../data/activity_log.jsonl');
    this.events = [];
    this.sequence = 0;
    this.initFile();
  }

  initFile() {
    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  sanitize(obj) {
    if (!obj) return obj;
    if (typeof obj === 'string') {
      return obj
        .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
        .replace(/token=([A-Za-z0-9_\-\.]+)/gi, 'token=[REDACTED]')
        .replace(/authToken["']?\s*:\s*["'][^"']+["']/gi, 'authToken: "[REDACTED]"')
        .replace(/password["']?\s*:\s*["'][^"']+["']/gi, 'password: "[REDACTED]"')
        .replace(/apiKey["']?\s*:\s*["'][^"']+["']/gi, 'apiKey: "[REDACTED]"');
    }

    if (typeof obj === 'object') {
      const copy = Array.isArray(obj) ? [] : {};
      for (const [k, v] of Object.entries(obj)) {
        const lowerKey = k.toLowerCase();
        if (
          lowerKey.includes('token') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('password') ||
          lowerKey.includes('apikey') ||
          lowerKey.includes('authorization')
        ) {
          copy[k] = '[REDACTED]';
        } else if (typeof v === 'object' && v !== null) {
          copy[k] = this.sanitize(v);
        } else if (typeof v === 'string') {
          copy[k] = this.sanitize(v);
        } else {
          copy[k] = v;
        }
      }
      return copy;
    }

    return obj;
  }

  log(entry) {
    this.sequence++;
    const event = {
      id: `EVT-${Date.now()}-${this.sequence}`,
      timestamp: new Date().toISOString(),
      sequence: this.sequence,
      level: entry.level || 'INFO', // 'INFO' | 'WARN' | 'ERROR'
      type: entry.type || 'SYSTEM',
      agentId: entry.agentId || null,
      messageId: entry.messageId || null,
      details: this.sanitize(entry.details || {}),
      summary: this.sanitize(entry.summary || '')
    };

    this.events.unshift(event);
    if (this.events.length > this.maxMemoryEvents) {
      this.events.pop();
    }

    // Append to disk asynchronously
    try {
      const line = JSON.stringify(event) + '\n';
      fs.appendFile(this.logFilePath, line, 'utf8', () => {});
    } catch (_) {}

    return event;
  }

  getEvents(filters = {}) {
    let result = this.events;

    if (filters.agentId) {
      const target = filters.agentId.toLowerCase();
      result = result.filter(e => e.agentId && e.agentId.toLowerCase() === target);
    }

    if (filters.type) {
      result = result.filter(e => e.type === filters.type);
    }

    if (filters.level) {
      result = result.filter(e => e.level === filters.level);
    }

    if (filters.messageId) {
      result = result.filter(e => e.messageId === filters.messageId);
    }

    if (filters.sinceTimestamp) {
      const sinceTime = new Date(filters.sinceTimestamp).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
    }

    if (filters.limit) {
      result = result.slice(0, parseInt(filters.limit, 10));
    }

    return result;
  }

  exportCSV(filters = {}) {
    const list = this.getEvents(filters);
    const headers = ['id', 'timestamp', 'level', 'type', 'agentId', 'messageId', 'summary'];
    const rows = [headers.join(',')];

    for (const e of list) {
      const row = [
        `"${e.id}"`,
        `"${e.timestamp}"`,
        `"${e.level}"`,
        `"${e.type}"`,
        `"${e.agentId || ''}"`,
        `"${e.messageId || ''}"`,
        `"${(e.summary || '').replace(/"/g, '""')}"`
      ];
      rows.push(row.join(','));
    }

    return rows.join('\r\n');
  }
}

module.exports = ActivityLogger;
