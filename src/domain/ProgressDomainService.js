/**
 * ProgressDomainService.js
 * Read-only project progress reader. Parses the project's markdown docs
 * (TASKS.md dashboard + gate tables, KNOWN_ISSUES.md, PROJECT_STATE.md) and the
 * AI conversation in TEAM_MAILBOX.md into one JSON document for the dashboard.
 * It never writes to the docs. Results are cached per file mtime.
 */

const fs = require('fs');
const path = require('path');
const { parseMailboxMessages } = require('../protocol/MessageProtocol');

const TRACKED_DOCS = ['PROJECT_STATE.md', 'TASKS.md', 'KNOWN_ISSUES.md', 'DECISIONS.md', 'TEST_PLAN.md', 'PERFORMANCE_LOG.md', 'TEAM_MAILBOX.md'];

function clip(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Removes the markdown decoration that makes dashboard text hard to read */
function plain(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/** Splits a markdown table row into trimmed cells (leading/trailing pipes dropped) */
function splitRow(line) {
  const cells = line.split('|').map(c => c.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function isSeparatorRow(line) {
  return /^\s*\|?\s*:?-{2,}/.test(line);
}

/** Maps the free-text Status column onto a fixed set of buckets */
function classifyStatus(text) {
  const first = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').trim().split(/\s+/)[0] || '';
  if (first === 'done' || first === 'verified' || first === 'closed' || first === 'accepted') return 'done';
  if (first === 'built' || first === 'partial' || first === 'partly') return 'built';
  if (first === 'doing' || first === 'progress' || first === 'active' || first === 'mostly') return 'doing';
  if (first === 'in' && /^in progress/i.test(String(text).trim())) return 'doing';
  if (first === 'blocked') return 'blocked';
  if (first === 'todo' || first === 'open' || first === 'pending' || first === 'needed') return 'todo';
  return 'other';
}

class ProgressDomainService {
  constructor(options = {}) {
    this.docsDir = options.docsDir || null;
    this.mailboxPath = options.mailboxPath || null;
    this.cache = { key: '', value: null };
  }

  setPaths({ docsDir, mailboxPath }) {
    if (docsDir) this.docsDir = docsDir;
    if (mailboxPath) this.mailboxPath = mailboxPath;
  }

  _resolveDocsDir() {
    if (this.docsDir) return this.docsDir;
    return this.mailboxPath ? path.dirname(this.mailboxPath) : null;
  }

  _read(file) {
    const dir = this._resolveDocsDir();
    if (!dir) return null;
    const p = path.join(dir, file);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (_) {
      return null;
    }
  }

  _docInfo() {
    const dir = this._resolveDocsDir();
    return TRACKED_DOCS.map(name => {
      let mtime = null;
      let sizeKb = null;
      try {
        const st = fs.statSync(path.join(dir || '', name));
        mtime = st.mtime.toISOString();
        sizeKb = Math.round(st.size / 1024);
      } catch (_) {}
      return { name, mtime, sizeKb, exists: mtime !== null };
    });
  }

  /** The dashboard "Progress" table: Area | Rows | Done | Progress | State */
  _parseProgressTable(lines) {
    const start = lines.findIndex(l => /^###\s+Progress\b/.test(l));
    if (start < 0) return { areas: [], whole: null };
    const areas = [];
    let whole = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,3}\s/.test(line)) break;
      if (!line.trim().startsWith('|') || isSeparatorRow(line)) continue;
      const cells = splitRow(line);
      if (cells.length < 4 || /^area$/i.test(cells[0])) continue;
      const pct = (cells[3].match(/(\d+)\s*%/) || [])[1];
      const row = {
        area: plain(cells[0]),
        rows: plain(cells[1]),
        done: plain(cells[2]),
        percent: pct !== undefined ? parseInt(pct, 10) : null,
        percentText: plain(cells[3]),
        state: clip(plain(cells.slice(4).join(' | ')), 420)
      };
      if (/whole project/i.test(row.area)) whole = row;
      else areas.push(row);
    }
    return { areas, whole };
  }

  _parseRemaining(lines) {
    const start = lines.findIndex(l => /^###\s+Remaining work/.test(l));
    if (start < 0) return [];
    const items = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^#{1,3}\s/.test(line)) break;
      const m = line.match(/^\s*\d+\.\s+(.*)$/);
      if (m) items.push(clip(plain(m[1]), 420));
    }
    return items;
  }

  /** Every task table under a "###" heading: ID | Task | Owner | ... | Status */
  _parseTaskSections(lines) {
    const sections = [];
    let current = null;
    let header = null;
    for (const line of lines) {
      const h = line.match(/^###\s+(.*)$/);
      if (h) {
        current = null;
        header = null;
        const name = plain(h[1]);
        // The dashboard sub-sections are summaries, not task tables
        if (!/^(Documents|Progress|Remaining work)/i.test(name)) {
          current = { name, tasks: [] };
          sections.push(current);
        }
        continue;
      }
      if (!current || !line.trim().startsWith('|')) continue;
      if (isSeparatorRow(line)) continue;
      const cells = splitRow(line);
      if (/^id$/i.test(cells[0])) {
        header = cells.map(c => c.toLowerCase());
        continue;
      }
      if (!header || cells.length < 3) continue;
      // Reference tables without a Status column are not tasks
      if (!header.includes('status')) continue;

      // Status is the last column; owner is found by header name. Counting from the end
      // keeps the row usable even when a cell contains an unescaped pipe.
      const ownerIdx = header.indexOf('owner');
      const statusText = cells.length === header.length ? cells[header.indexOf('status')] : cells[cells.length - 1];
      current.tasks.push({
        id: plain(cells[0]),
        title: clip(plain(cells[1]), 200),
        owner: ownerIdx >= 0 ? plain(cells[ownerIdx] || '') : '',
        status: classifyStatus(statusText),
        statusText: clip(plain(statusText), 320)
      });
    }
    return sections.filter(s => s.tasks.length > 0);
  }

  _parseKnownIssues(text) {
    if (!text) return { open: 0, closed: 0, total: 0, recentOpen: [] };
    let open = 0;
    let closed = 0;
    const openRows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^\|\s*KI-\d+/.test(line)) continue;
      const cells = splitRow(line);
      const status = cells[cells.length - 1] || '';
      if (/^closed|^fixed|^resolved/i.test(status)) {
        closed++;
      } else {
        open++;
        openRows.push({ id: plain(cells[0]), area: plain(cells[1] || ''), text: clip(plain(cells[2] || ''), 220), status: clip(plain(status), 80) });
      }
    }
    // Highest IDs are the newest
    openRows.sort((a, b) => parseInt(b.id.replace(/\D/g, ''), 10) - parseInt(a.id.replace(/\D/g, ''), 10));
    return { open, closed, total: open + closed, recentOpen: openRows.slice(0, 8) };
  }

  _parseStateBullets(text) {
    if (!text) return { heading: null, bullets: [] };
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(l => /^##\s+Current state/i.test(l));
    if (start < 0) return { heading: null, bullets: [] };
    const bullets = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      const m = lines[i].match(/^\s*-\s+(.*)$/);
      if (m) bullets.push(clip(plain(m[1]), 380));
    }
    return { heading: plain(lines[start].replace(/^##\s+/, '')), bullets };
  }

  _parseConversation(limit) {
    const text = this._read(path.basename(this.mailboxPath || 'TEAM_MAILBOX.md'));
    const messages = this.mailboxPath && fs.existsSync(this.mailboxPath)
      ? parseMailboxMessages(fs.readFileSync(this.mailboxPath, 'utf8'))
      : parseMailboxMessages(text || '');
    const lastBySender = {};
    for (const m of messages) {
      lastBySender[m.sender] = { id: m.id, timestamp: m.timestamp };
    }
    const recent = messages.slice(-limit).reverse().map(m => {
      const lines = m.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const task = (lines.find(l => /^TASK:/i.test(l)) || lines[0] || '').replace(/^TASK:\s*/i, '');
      const status = (lines.find(l => /^STATUS:/i.test(l)) || '').replace(/^STATUS:\s*/i, '');
      const next = (lines.find(l => /^NEXT ACTION:/i.test(l)) || '').replace(/^NEXT ACTION:\s*/i, '');
      return {
        id: m.id,
        sender: m.sender,
        recipient: m.recipientRaw,
        timestamp: m.timestamp,
        task: clip(plain(task), 200),
        status: clip(plain(status), 360),
        nextAction: clip(plain(next), 260)
      };
    });
    return { total: messages.length, lastBySender, recent };
  }

  /**
   * Builds the full progress document. Cheap enough to call per request:
   * parsed docs are cached until a tracked file's mtime changes.
   */
  getProgress({ messageLimit = 25 } = {}) {
    const docs = this._docInfo();
    const key = docs.map(d => `${d.name}:${d.mtime}`).join('|') + `|${messageLimit}`;
    if (this.cache.key === key && this.cache.value) {
      return { ...this.cache.value, generatedAt: new Date().toISOString() };
    }

    const tasksText = this._read('TASKS.md');
    const lines = tasksText ? tasksText.split(/\r?\n/) : [];
    const updated = (tasksText || '').match(/^##\s+Dashboard \(updated ([0-9-]+)/m);

    const { areas, whole } = this._parseProgressTable(lines);
    const sections = this._parseTaskSections(lines);

    const counts = { done: 0, built: 0, doing: 0, blocked: 0, todo: 0, other: 0 };
    for (const s of sections) {
      s.counts = { done: 0, built: 0, doing: 0, blocked: 0, todo: 0, other: 0 };
      for (const t of s.tasks) {
        s.counts[t.status]++;
        counts[t.status]++;
      }
    }

    const value = {
      docsAvailable: docs.some(d => d.exists),
      // Folder name only: never expose absolute local paths to remote viewers
      docsFolder: this._resolveDocsDir() ? path.basename(this._resolveDocsDir()) : null,
      tasksUpdated: updated ? updated[1] : null,
      whole,
      areas,
      remaining: this._parseRemaining(lines),
      sections,
      counts,
      totalTasks: Object.values(counts).reduce((a, b) => a + b, 0),
      knownIssues: this._parseKnownIssues(this._read('KNOWN_ISSUES.md')),
      state: this._parseStateBullets(this._read('PROJECT_STATE.md')),
      conversation: this._parseConversation(messageLimit),
      docs
    };

    this.cache = { key, value };
    return { ...value, generatedAt: new Date().toISOString() };
  }
}

module.exports = ProgressDomainService;
module.exports.classifyStatus = classifyStatus;
