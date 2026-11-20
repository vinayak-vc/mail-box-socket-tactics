/**
 * BoardDomainService.js
 * Kanban-style task board service for MailSocketTactics.
 * Provides CRUD for board tasks, column management, comments, and
 * real-time event broadcasting for the dashboard.
 *
 * Data is persisted to data/board.json.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_COLUMNS = ['backlog', 'todo', 'in-progress', 'review', 'done'];

const PRIORITY_LEVELS = ['low', 'medium', 'high', 'critical'];

class BoardDomainService {
  constructor(options = {}) {
    this.storagePath = options.storagePath ||
      path.resolve(__dirname, '../../data/board.json');
    this.onEvent = options.onEvent || (() => {});
    this.logger = options.logger || null;

    // Load persisted state
    this._data = this._load();
  }

  // ─── Persistence ────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          columns: parsed.columns || DEFAULT_COLUMNS,
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
          nextId: parsed.nextId || 1
        };
      }
    } catch (err) {
      if (this.logger) {
        this.logger.log({ level: 'WARN', type: 'BOARD_LOAD_ERROR', summary: `Board load error: ${err.message}` });
      }
    }
    return { columns: [...DEFAULT_COLUMNS], tasks: [], nextId: 1 };
  }

  _save() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (err) {
      if (this.logger) {
        this.logger.log({ level: 'ERROR', type: 'BOARD_SAVE_ERROR', summary: `Board save error: ${err.message}` });
      }
    }
  }

  // ─── Board Read ─────────────────────────────────────────────────

  /**
   * Returns the full board state: columns and all tasks.
   */
  getBoard() {
    this._data = this._load();
    return {
      columns: this._data.columns,
      tasks: this._data.tasks,
      taskCount: this._data.tasks.length
    };
  }

  /**
   * Get a single task by its ID.
   */
  getTask(taskId) {
    let task = this._data.tasks.find(t => t.id === taskId);
    if (!task) {
      this._data = this._load();
      task = this._data.tasks.find(t => t.id === taskId);
    }
    return task || null;
  }

  /**
   * Get tasks filtered by column and/or assignee.
   */
  getTasks({ column, assignee, priority } = {}) {
    let result = this._data.tasks;
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

    const column = params.column || 'backlog';
    if (!this._data.columns.includes(column)) {
      throw new Error(`Invalid column '${column}'. Valid columns: ${this._data.columns.join(', ')}`);
    }

    const priority = params.priority || 'medium';
    if (!PRIORITY_LEVELS.includes(priority)) {
      throw new Error(`Invalid priority '${priority}'. Valid: ${PRIORITY_LEVELS.join(', ')}`);
    }

    const now = new Date().toISOString();
    const task = {
      id: `BT-${this._data.nextId++}`,
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

    this._data.tasks.push(task);
    this._save();

    this._broadcast('BOARD_TASK_CREATED', { task });
    this._log('INFO', 'BOARD_TASK_CREATED', `Board task ${task.id} created: "${task.title}" by ${task.createdBy}`);

    return task;
  }

  /**
   * Update a board task's fields (title, description, priority, labels, assignee).
   */
  updateTask(taskId, updates, updatedBy = 'System') {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);

    const allowed = ['title', 'description', 'priority', 'labels', 'assignee'];
    const changes = [];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        const oldVal = task[key];
        task[key] = updates[key];
        changes.push(`${key}: "${oldVal}" → "${updates[key]}"`);
      }
    }

    if (changes.length === 0) {
      return task; // no-op
    }

    task.updatedAt = new Date().toISOString();
    task.history.push({
      action: 'updated',
      by: updatedBy,
      at: task.updatedAt,
      detail: changes.join('; ')
    });

    this._save();
    this._broadcast('BOARD_TASK_UPDATED', { task });
    this._log('INFO', 'BOARD_TASK_UPDATED', `Board task ${task.id} updated by ${updatedBy}: ${changes.join('; ')}`);

    return task;
  }

  /**
   * Move a task to a different column (Kanban drag-and-drop).
   */
  moveTask(taskId, targetColumn, movedBy = 'System') {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);

    if (!this._data.columns.includes(targetColumn)) {
      throw new Error(`Invalid column '${targetColumn}'. Valid columns: ${this._data.columns.join(', ')}`);
    }

    const fromColumn = task.column;
    if (fromColumn === targetColumn) return task; // no-op

    task.column = targetColumn;
    task.updatedAt = new Date().toISOString();
    task.history.push({
      action: 'moved',
      by: movedBy,
      at: task.updatedAt,
      detail: `Moved from "${fromColumn}" to "${targetColumn}"`
    });

    this._save();
    this._broadcast('BOARD_TASK_MOVED', { task, fromColumn, toColumn: targetColumn });
    this._log('INFO', 'BOARD_TASK_MOVED', `Board task ${task.id} moved "${fromColumn}" → "${targetColumn}" by ${movedBy}`);

    return task;
  }

  /**
   * Add a comment to a task.
   */
  addComment(taskId, text, author = 'System') {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);

    if (!text || !text.trim()) throw new Error('Comment text is required');

    const comment = {
      id: `C${Date.now()}`,
      author,
      text: text.trim(),
      createdAt: new Date().toISOString()
    };

    task.comments.push(comment);
    task.updatedAt = comment.createdAt;
    task.history.push({
      action: 'commented',
      by: author,
      at: comment.createdAt,
      detail: text.trim().substring(0, 120)
    });

    this._save();
    this._broadcast('BOARD_TASK_COMMENT', { taskId: task.id, comment });
    this._log('INFO', 'BOARD_TASK_COMMENT', `Comment on ${task.id} by ${author}`);

    return comment;
  }

  /**
   * Delete a board task.
   */
  deleteTask(taskId, deletedBy = 'System') {
    const idx = this._data.tasks.findIndex(t => t.id === taskId);
    if (idx === -1) throw new Error(`Task '${taskId}' not found`);

    const removed = this._data.tasks.splice(idx, 1)[0];
    this._save();

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
    return [...this._data.columns];
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
