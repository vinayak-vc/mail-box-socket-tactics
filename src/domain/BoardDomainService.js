/**
 * BoardDomainService.js
 * Kanban-style task board service for MailSocketTactics.
 * Provides CRUD for board tasks, column management, comments, and
 * real-time event broadcasting for the dashboard.
 *
 * Data is persisted to data/board.json (one file per project).
 *
 * Concurrency: the broker and every MCP server process (one per desktop agent) open the same
 * board file. Every change is an atomic read-modify-write under a cross-process file lock
 * (`<board>.json.lock`): re-read the file inside the lock, apply the change, write it with
 * temp-file + rename, release. Reads always come from disk, so no process acts on a stale copy.
 */

const fs = require('fs');
const path = require('path');
const { withFileLockSync, writeJsonAtomicSync } = require('./FileLock');

const DEFAULT_COLUMNS = ['backlog', 'todo', 'in-progress', 'review', 'done'];

const PRIORITY_LEVELS = ['low', 'medium', 'high', 'critical'];

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class BoardDomainService {
  constructor(options = {}) {
    this.storagePath = options.storagePath ||
      path.resolve(__dirname, '../../data/board.json');
    this.onEvent = options.onEvent || (() => {});
    this.logger = options.logger || null;
    this.lockTimeoutMs = options.lockTimeoutMs || 10000;

    // Last good copy read from disk; only a fallback if the file is briefly unreadable
    this._data = this._emptyBoard();
    this._refresh();
  }

  // ─── Persistence ────────────────────────────────────────────────

  _emptyBoard() {
    return { columns: [...DEFAULT_COLUMNS], tasks: [], nextId: 1 };
  }

  _normalize(parsed) {
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    // nextId must never go backwards, or a deleted/lost id could be issued twice
    const maxNum = tasks.reduce((max, t) => {
      const m = /^BT-(\d+)$/.exec(String(t.id || ''));
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    return {
      columns: Array.isArray(parsed.columns) && parsed.columns.length ? parsed.columns : [...DEFAULT_COLUMNS],
      tasks,
      nextId: Math.max(parseInt(parsed.nextId, 10) || 1, maxNum + 1)
    };
  }

  /**
   * Reads the board from disk. Throws if the file exists but cannot be read or parsed after
   * a few retries (a rename by another process can briefly make it unavailable on Windows).
   */
  _readFromDisk() {
    let lastErr = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        if (!fs.existsSync(this.storagePath)) return this._emptyBoard();
        return this._normalize(JSON.parse(fs.readFileSync(this.storagePath, 'utf-8')));
      } catch (err) {
        lastErr = err;
        sleepSync(10);
      }
    }
    throw lastErr;
  }

  /** Refreshes the in-memory copy from disk; keeps the last good copy if the read fails. */
  _refresh() {
    try {
      this._data = this._readFromDisk();
    } catch (err) {
      this._log('WARN', 'BOARD_LOAD_ERROR', `Board load error (using last good copy): ${err.message}`);
    }
    return this._data;
  }

  /** Kept for callers/tests that used the old name; same as a fresh read. */
  _load() {
    return this._refresh();
  }

  /**
   * Atomic read-modify-write. mutator(data) changes data in place and returns a result.
   * If the file cannot be parsed, nothing is written: a corrupt or half-read board must never
   * be replaced by an empty one.
   */
  _mutate(mutator) {
    const result = withFileLockSync(this.storagePath, () => {
      const data = this._readFromDisk();
      const out = mutator(data);
      if (out && out.changed === false) {
        this._data = data;
        return out;
      }
      writeJsonAtomicSync(this.storagePath, data);
      this._data = data;
      return out;
    }, { timeoutMs: this.lockTimeoutMs });
    return result;
  }

  // ─── Board Read ─────────────────────────────────────────────────

  /**
   * Returns the full board state: columns and all tasks.
   */
  getBoard() {
    const data = this._refresh();
    return {
      columns: data.columns,
      tasks: data.tasks,
      taskCount: data.tasks.length
    };
  }

  /**
   * Get a single task by its ID.
   */
  getTask(taskId) {
    return this._refresh().tasks.find(t => t.id === taskId) || null;
  }

  /**
   * Get tasks filtered by column and/or assignee.
   */
  getTasks({ column, assignee, priority } = {}) {
    let result = this._refresh().tasks;
    if (column) result = result.filter(t => t.column === column);
    if (assignee) result = result.filter(t => t.assignee && t.assignee.toLowerCase() === assignee.toLowerCase());
    if (priority) result = result.filter(t => t.priority === priority);
    return result;
  }

  // ─── Task CRUD ──────────────────────────────────────────────────

  /**
   * Create a new board task.
   * @param {Object} params
   * @param {string} params.title - Task title (required)
   * @param {string} [params.description] - Detailed description
   * @param {string} [params.column] - Target column (default: 'backlog')
   * @param {string} [params.assignee] - Agent ID or 'unassigned'
   * @param {string} [params.priority] - low | medium | high | critical
   * @param {string[]} [params.labels] - Tags/labels
   * @param {string} [params.createdBy] - Who created the task
   * @returns {Object} The created task
   */
  createTask(params) {
    if (!params.title || !params.title.trim()) {
      throw new Error('Task title is required');
    }

    const priority = params.priority || 'medium';
    if (!PRIORITY_LEVELS.includes(priority)) {
      throw new Error(`Invalid priority '${priority}'. Valid: ${PRIORITY_LEVELS.join(', ')}`);
    }

    const column = params.column || 'backlog';

    const { task } = this._mutate((data) => {
      if (!data.columns.includes(column)) {
        throw new Error(`Invalid column '${column}'. Valid columns: ${data.columns.join(', ')}`);
      }
      const now = new Date().toISOString();
      // The id comes from the freshly read file inside the lock, so it is never issued twice
      const created = {
        id: `BT-${data.nextId++}`,
        title: params.title.trim(),
        description: (params.description || '').trim(),
        column,
        assignee: params.assignee || null,
        priority,
        labels: Array.isArray(params.labels) ? params.labels : [],
        createdBy: params.createdBy || 'System',
        createdAt: now,
        updatedAt: now,
        comments: [],
        history: [
          { action: 'created', by: params.createdBy || 'System', at: now, detail: `Task created in "${column}"` }
        ]
      };
      data.tasks.push(created);
      return { task: created };
    });

    this._broadcast('BOARD_TASK_CREATED', { task });
    this._log('INFO', 'BOARD_TASK_CREATED', `Board task ${task.id} created: "${task.title}" by ${task.createdBy}`);

    return task;
  }

  /**
   * Update a board task's fields (title, description, priority, labels, assignee).
   */
  updateTask(taskId, updates, updatedBy = 'System') {
    const allowed = ['title', 'description', 'priority', 'labels', 'assignee'];

    const { task, changes, changed } = this._mutate((data) => {
      const target = data.tasks.find(t => t.id === taskId);
      if (!target) throw new Error(`Task '${taskId}' not found`);

      const list = [];
      for (const key of allowed) {
        if (updates[key] !== undefined) {
          const oldVal = target[key];
          target[key] = updates[key];
          list.push(`${key}: "${oldVal}" → "${updates[key]}"`);
        }
      }
      if (list.length === 0) return { task: target, changes: list, changed: false };

      target.updatedAt = new Date().toISOString();
      target.history = Array.isArray(target.history) ? target.history : [];
      target.history.push({ action: 'updated', by: updatedBy, at: target.updatedAt, detail: list.join('; ') });
      return { task: target, changes: list, changed: true };
    });

    if (!changed) return task; // no-op

    this._broadcast('BOARD_TASK_UPDATED', { task });
    this._log('INFO', 'BOARD_TASK_UPDATED', `Board task ${task.id} updated by ${updatedBy}: ${changes.join('; ')}`);

    return task;
  }

  /**
   * Move a task to a different column (Kanban drag-and-drop).
   */
  moveTask(taskId, targetColumn, movedBy = 'System') {
    const { task, fromColumn, changed } = this._mutate((data) => {
      const target = data.tasks.find(t => t.id === taskId);
      if (!target) throw new Error(`Task '${taskId}' not found`);
      if (!data.columns.includes(targetColumn)) {
        throw new Error(`Invalid column '${targetColumn}'. Valid columns: ${data.columns.join(', ')}`);
      }

      const from = target.column;
      if (from === targetColumn) return { task: target, fromColumn: from, changed: false };

      target.column = targetColumn;
      target.updatedAt = new Date().toISOString();
      target.history = Array.isArray(target.history) ? target.history : [];
      target.history.push({
        action: 'moved',
        by: movedBy,
        at: target.updatedAt,
        detail: `Moved from "${from}" to "${targetColumn}"`
      });
      return { task: target, fromColumn: from, changed: true };
    });

    if (!changed) return task; // no-op

    this._broadcast('BOARD_TASK_MOVED', { task, fromColumn, toColumn: targetColumn });
    this._log('INFO', 'BOARD_TASK_MOVED', `Board task ${task.id} moved "${fromColumn}" → "${targetColumn}" by ${movedBy}`);

    return task;
  }

  /**
   * Add a comment to a task.
   */
  addComment(taskId, text, author = 'System') {
    if (!text || !text.trim()) throw new Error('Comment text is required');

    const { comment, task } = this._mutate((data) => {
      const target = data.tasks.find(t => t.id === taskId);
      if (!target) throw new Error(`Task '${taskId}' not found`);

      const created = {
        id: `C${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        author,
        text: text.trim(),
        createdAt: new Date().toISOString()
      };
      target.comments = Array.isArray(target.comments) ? target.comments : [];
      target.comments.push(created);
      target.updatedAt = created.createdAt;
      target.history = Array.isArray(target.history) ? target.history : [];
      target.history.push({
        action: 'commented',
        by: author,
        at: created.createdAt,
        detail: text.trim().substring(0, 120)
      });
      return { comment: created, task: target };
    });

    this._broadcast('BOARD_TASK_COMMENT', { taskId: task.id, comment });
    this._log('INFO', 'BOARD_TASK_COMMENT', `Comment on ${task.id} by ${author}`);

    return comment;
  }

  /**
   * Delete a board task.
   */
  deleteTask(taskId, deletedBy = 'System') {
    const { removed } = this._mutate((data) => {
      const idx = data.tasks.findIndex(t => t.id === taskId);
      if (idx === -1) throw new Error(`Task '${taskId}' not found`);
      // nextId is left as is, so the deleted id is never reissued
      return { removed: data.tasks.splice(idx, 1)[0] };
    });

    this._broadcast('BOARD_TASK_DELETED', { taskId, task: removed });
    this._log('WARN', 'BOARD_TASK_DELETED', `Board task ${taskId} deleted by ${deletedBy}`);

    return removed;
  }

  // ─── Bulk Operations ────────────────────────────────────────────

  /**
   * Create multiple tasks at once (e.g., Lead submitting a task list).
   */
  createBulk(taskList, createdBy = 'Lead') {
    const created = [];
    for (const item of taskList) {
      const task = this.createTask({ ...item, createdBy });
      created.push(task);
    }
    return created;
  }

  // ─── Column Management ──────────────────────────────────────────

  getColumns() {
    return [...this._refresh().columns];
  }

  // ─── Helpers ────────────────────────────────────────────────────

  _broadcast(eventType, data) {
    try {
      this.onEvent(eventType, data);
    } catch (_) {}
  }

  _log(level, type, summary) {
    if (this.logger) {
      try {
        this.logger.log({ level, type, summary });
      } catch (_) {}
    }
  }
}

module.exports = BoardDomainService;
