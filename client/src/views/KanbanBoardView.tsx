import React, { useState, useEffect, useCallback } from 'react';
import {
  LayoutGrid,
  Plus,
  MessageSquare,
  ChevronRight,
  ChevronLeft,
  X,
  Send,
  User,
  Clock,
  Tag,
  AlertCircle,
  Trash2,
  Edit3,
  GripVertical
} from 'lucide-react';
import { SystemSnapshot, BoardTask, BoardColumn, BoardPriority, BoardComment } from '../types';
import { client } from '../api';
import { Markdown } from '../components/Markdown';

interface KanbanBoardViewProps {
  snapshot: SystemSnapshot | null;
  onRefresh: () => void;
}

const COLUMN_CONFIG: Record<BoardColumn, { label: string; color: string; icon: string }> = {
  'backlog':     { label: 'Backlog',     color: '#6b7280', icon: '📋' },
  'todo':        { label: 'To Do',       color: '#3b82f6', icon: '📝' },
  'in-progress': { label: 'In Progress', color: '#f59e0b', icon: '🔧' },
  'review':      { label: 'Review',      color: '#8b5cf6', icon: '🔍' },
  'done':        { label: 'Done',        color: '#10b981', icon: '✅' },
};

const PRIORITY_COLORS: Record<BoardPriority, { bg: string; text: string; label: string }> = {
  'low':      { bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Low' },
  'medium':   { bg: 'rgba(59,130,246,0.15)',  text: '#60a5fa', label: 'Medium' },
  'high':     { bg: 'rgba(245,158,11,0.15)',   text: '#fbbf24', label: 'High' },
  'critical': { bg: 'rgba(239,68,68,0.15)',    text: '#f87171', label: 'Critical' },
};

const AGENT_COLORS: Record<string, string> = {
  'Claude': '#e2a04f',
  'Codex': '#10b981',
  'Antigravity': '#3b82f6',
};

export const KanbanBoardView: React.FC<KanbanBoardViewProps> = ({ snapshot, onRefresh }) => {
  const [selectedTask, setSelectedTask] = useState<BoardTask | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createColumn, setCreateColumn] = useState<BoardColumn>('backlog');
  const [commentText, setCommentText] = useState('');
  const [commentAuthor, setCommentAuthor] = useState('Lead');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);

  // Create form state
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPriority, setNewPriority] = useState<BoardPriority>('medium');
  const [newAssignee, setNewAssignee] = useState('');
  const [newLabels, setNewLabels] = useState('');
  const [newCreatedBy, setNewCreatedBy] = useState('Lead');

  const board = snapshot?.board;
  const columns = board?.columns || ['backlog', 'todo', 'in-progress', 'review', 'done'];
  const tasks = board?.tasks || [];
  const agents = snapshot?.agents || [];

  const getTasksForColumn = (col: string) =>
    tasks.filter(t => t.column === col);

  // ── Create Task ──────────────────────────────────────────
  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setIsSubmitting(true);
    try {
      await client.createBoardTask({
        title: newTitle.trim(),
        description: newDesc.trim(),
        column: createColumn,
        priority: newPriority,
        assignee: newAssignee || undefined,
        labels: newLabels ? newLabels.split(',').map(l => l.trim()).filter(Boolean) : [],
        createdBy: newCreatedBy || 'Lead'
      });
      setNewTitle('');
      setNewDesc('');
      setNewPriority('medium');
      setNewAssignee('');
      setNewLabels('');
      setShowCreateModal(false);
      onRefresh();
    } catch (err: any) {
      alert(`Create failed: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Move Task (column navigation) ───────────────────────
  const handleMove = async (taskId: string, targetColumn: string) => {
    try {
      await client.moveBoardTask(taskId, targetColumn, 'Dashboard');
      onRefresh();
      if (selectedTask?.id === taskId) {
        setSelectedTask({ ...selectedTask, column: targetColumn as BoardColumn });
      }
    } catch (err: any) {
      alert(`Move failed: ${err.message}`);
    }
  };

  // ── Add Comment ─────────────────────────────────────────
  const handleAddComment = async () => {
    if (!selectedTask || !commentText.trim()) return;
    setIsSubmitting(true);
    try {
      await client.addBoardTaskComment(selectedTask.id, commentText.trim(), commentAuthor || 'Lead');
      setCommentText('');
      onRefresh();
      // Re-fetch the task detail
      const board = await client.fetchBoard();
      const updated = board.tasks.find(t => t.id === selectedTask.id);
      if (updated) setSelectedTask(updated);
    } catch (err: any) {
      alert(`Comment failed: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Delete Task ─────────────────────────────────────────
  const handleDelete = async (taskId: string) => {
    if (!confirm(`Delete task ${taskId}?`)) return;
    try {
      await client.deleteBoardTask(taskId);
      setSelectedTask(null);
      onRefresh();
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  // ── Drag-and-Drop ───────────────────────────────────────
  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetColumn: string) => {
    e.preventDefault();
    if (draggedTaskId) {
      await handleMove(draggedTaskId, targetColumn);
      setDraggedTaskId(null);
    }
  };

  // ── Helpers ─────────────────────────────────────────────
  const getColumnIndex = (col: string) => columns.indexOf(col as BoardColumn);
  const getPrevColumn = (col: string): string | null => {
    const idx = getColumnIndex(col);
    return idx > 0 ? columns[idx - 1] : null;
  };
  const getNextColumn = (col: string): string | null => {
    const idx = getColumnIndex(col);
    return idx < columns.length - 1 ? columns[idx + 1] : null;
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  if (!snapshot) return null;

  return (
    <div className="content-view">
      {/* Header */}
      <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 className="section-title">
            <LayoutGrid size={20} />
            <span>Kanban Board</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Drag-and-drop task board for agent collaboration. {tasks.length} task{tasks.length !== 1 ? 's' : ''} across {columns.length} columns.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { setCreateColumn('backlog'); setShowCreateModal(true); }}
        >
          <Plus size={14} />
          <span>New Task</span>
        </button>
      </div>

      {/* Board */}
      <div style={{
        display: 'flex',
        gap: '12px',
        overflowX: 'auto',
        paddingBottom: '16px',
        minHeight: 'calc(100vh - 200px)'
      }}>
        {columns.map((col) => {
          const config = COLUMN_CONFIG[col as BoardColumn] || { label: col, color: '#6b7280', icon: '📋' };
          const colTasks = getTasksForColumn(col);

          return (
            <div
              key={col}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, col)}
              style={{
                flex: '1 0 220px',
                minWidth: '220px',
                maxWidth: '320px',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-card)',
                borderRadius: '10px',
                border: draggedTaskId ? '2px dashed var(--border-subtle)' : '1px solid var(--border-subtle)',
              }}
            >
              {/* Column header */}
              <div style={{
                padding: '12px 14px 8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: `2px solid ${config.color}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '16px' }}>{config.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>
                    {config.label}
                  </span>
                  <span style={{
                    fontSize: '11px',
                    background: config.color + '22',
                    color: config.color,
                    padding: '1px 7px',
                    borderRadius: '10px',
                    fontWeight: 600
                  }}>
                    {colTasks.length}
                  </span>
                </div>
                <button
                  onClick={() => { setCreateColumn(col as BoardColumn); setShowCreateModal(true); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    padding: '2px',
                    borderRadius: '4px'
                  }}
                  title={`Add task to ${config.label}`}
                >
                  <Plus size={14} />
                </button>
              </div>

              {/* Task cards */}
              <div style={{
                padding: '8px',
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px'
              }}>
                {colTasks.length === 0 && (
                  <div style={{
                    textAlign: 'center',
                    padding: '24px 12px',
                    color: 'var(--text-muted)',
                    fontSize: '12px',
                    opacity: 0.6
                  }}>
                    No tasks
                  </div>
                )}

                {colTasks.map(task => {
                  const prioConfig = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium;
                  const agentColor = task.assignee ? (AGENT_COLORS[task.assignee] || '#6b7280') : '#6b7280';

                  return (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, task.id)}
                      onClick={() => setSelectedTask(task)}
                      style={{
                        background: 'var(--bg-secondary)',
                        borderRadius: '8px',
                        padding: '10px 12px',
                        cursor: 'pointer',
                        border: '1px solid var(--border-subtle)',
                        transition: 'border-color 0.15s, box-shadow 0.15s',
                        position: 'relative',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = config.color;
                        (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 0 1px ${config.color}33`;
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-subtle)';
                        (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                      }}
                    >
                      {/* Drag grip */}
                      <div style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        color: 'var(--text-muted)',
                        opacity: 0.3,
                        cursor: 'grab'
                      }}>
                        <GripVertical size={12} />
                      </div>

                      {/* Task ID + Priority */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                        <span style={{ fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                          {task.id}
                        </span>
                        <span style={{
                          fontSize: '9px',
                          padding: '1px 5px',
                          borderRadius: '4px',
                          background: prioConfig.bg,
                          color: prioConfig.text,
                          fontWeight: 600,
                          textTransform: 'uppercase'
                        }}>
                          {prioConfig.label}
                        </span>
                      </div>

                      {/* Title */}
                      <div style={{
                        fontSize: '13px',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        lineHeight: '1.3',
                        marginBottom: '8px',
                        wordBreak: 'break-word',
                      }}>
                        {task.title}
                      </div>

                      {/* Labels */}
                      {task.labels.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' }}>
                          {task.labels.slice(0, 3).map(lbl => (
                            <span key={lbl} style={{
                              fontSize: '9px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'rgba(99,102,241,0.12)',
                              color: '#818cf8',
                              fontWeight: 500
                            }}>
                              {lbl}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Footer: assignee + comments + time */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '11px',
                        color: 'var(--text-muted)'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          {task.assignee ? (
                            <>
                              <div style={{
                                width: '16px',
                                height: '16px',
                                borderRadius: '50%',
                                background: agentColor,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '8px',
                                fontWeight: 700,
                                color: '#fff'
                              }}>
                                {task.assignee.charAt(0)}
                              </div>
                              <span>{task.assignee}</span>
                            </>
                          ) : (
                            <span style={{ opacity: 0.5 }}>Unassigned</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {task.comments.length > 0 && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                              <MessageSquare size={10} />
                              {task.comments.length}
                            </span>
                          )}
                          <span>{timeAgo(task.updatedAt)}</span>
                        </div>
                      </div>

                      {/* Quick move buttons */}
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginTop: '8px',
                        borderTop: '1px solid var(--border-subtle)',
                        paddingTop: '6px'
                      }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {getPrevColumn(task.column) ? (
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ fontSize: '10px', padding: '2px 6px' }}
                            onClick={() => handleMove(task.id, getPrevColumn(task.column)!)}
                            title={`Move to ${COLUMN_CONFIG[getPrevColumn(task.column) as BoardColumn]?.label}`}
                          >
                            <ChevronLeft size={10} />
                            <span>{COLUMN_CONFIG[getPrevColumn(task.column) as BoardColumn]?.label}</span>
                          </button>
                        ) : <div />}
                        {getNextColumn(task.column) ? (
                          <button
                            className="btn btn-secondary btn-sm"
                            style={{ fontSize: '10px', padding: '2px 6px' }}
                            onClick={() => handleMove(task.id, getNextColumn(task.column)!)}
                            title={`Move to ${COLUMN_CONFIG[getNextColumn(task.column) as BoardColumn]?.label}`}
                          >
                            <span>{COLUMN_CONFIG[getNextColumn(task.column) as BoardColumn]?.label}</span>
                            <ChevronRight size={10} />
                          </button>
                        ) : <div />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Task Detail Drawer ── */}
      {selectedTask && (
        <div className="drawer-backdrop" onClick={() => setSelectedTask(null)}>
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px', display: 'flex', flexDirection: 'column' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px' }}>
              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{selectedTask.id}</span>
                <h3 style={{ fontSize: '16px', color: '#fff', marginTop: '4px', lineHeight: '1.3' }}>{selectedTask.title}</h3>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(selectedTask.id)} title="Delete task">
                  <Trash2 size={12} />
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setSelectedTask(null)}>
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Meta grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', padding: '14px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <div>
                <div className="form-label">Column</div>
                <select
                  className="select-filter"
                  value={selectedTask.column}
                  onChange={(e) => handleMove(selectedTask.id, e.target.value)}
                  style={{ width: '100%', fontSize: '12px' }}
                >
                  {columns.map(c => (
                    <option key={c} value={c}>{COLUMN_CONFIG[c as BoardColumn]?.label || c}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="form-label">Priority</div>
                <span style={{
                  fontSize: '12px',
                  padding: '3px 10px',
                  borderRadius: '6px',
                  background: PRIORITY_COLORS[selectedTask.priority]?.bg,
                  color: PRIORITY_COLORS[selectedTask.priority]?.text,
                  fontWeight: 600,
                  display: 'inline-block'
                }}>
                  {PRIORITY_COLORS[selectedTask.priority]?.label}
                </span>
              </div>
              <div>
                <div className="form-label">Assignee</div>
                <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                  {selectedTask.assignee || 'Unassigned'}
                </span>
              </div>
              <div>
                <div className="form-label">Created By</div>
                <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                  {selectedTask.createdBy} · {timeAgo(selectedTask.createdAt)}
                </span>
              </div>
            </div>

            {/* Description */}
            {selectedTask.description && (
              <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="form-label">Description</div>
                <Markdown source={selectedTask.description} />
              </div>
            )}

            {/* Labels */}
            {selectedTask.labels.length > 0 && (
              <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="form-label">Labels</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {selectedTask.labels.map(lbl => (
                    <span key={lbl} style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '5px',
                      background: 'rgba(99,102,241,0.12)',
                      color: '#818cf8'
                    }}>
                      {lbl}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Comments */}
            <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
              <div className="form-label">
                Comments ({selectedTask.comments.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                {selectedTask.comments.length === 0 && (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>
                    No comments yet.
                  </div>
                )}
                {selectedTask.comments.map(c => (
                  <div key={c.id} style={{
                    background: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    border: '1px solid var(--border-subtle)'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 600, fontSize: '12px', color: AGENT_COLORS[c.author] || 'var(--text-primary)' }}>
                        {c.author}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {timeAgo(c.createdAt)}
                      </span>
                    </div>
                    <Markdown source={c.text} />
                  </div>
                ))}
              </div>

              {/* Add comment */}
              <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <select
                    className="select-filter"
                    value={commentAuthor}
                    onChange={(e) => setCommentAuthor(e.target.value)}
                    style={{ fontSize: '11px', marginBottom: '6px', width: '100%' }}
                  >
                    <option value="Lead">Lead (You)</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.id}</option>
                    ))}
                  </select>
                  <textarea
                    className="search-input"
                    placeholder="Write a comment..."
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAddComment();
                      }
                    }}
                    rows={2}
                    style={{ resize: 'vertical', width: '100%', minHeight: '48px' }}
                  />
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleAddComment}
                  disabled={!commentText.trim() || isSubmitting}
                  style={{ marginBottom: '1px' }}
                >
                  <Send size={12} />
                </button>
              </div>
            </div>

            {/* History */}
            {selectedTask.history.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px', maxHeight: '160px', overflowY: 'auto' }}>
                <div className="form-label">History</div>
                {selectedTask.history.slice().reverse().map((h, idx) => (
                  <div key={idx} style={{
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'flex-start',
                    padding: '4px 0',
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    borderBottom: idx < selectedTask.history.length - 1 ? '1px solid var(--border-subtle)' : 'none'
                  }}>
                    <span style={{ whiteSpace: 'nowrap', fontWeight: 600, color: AGENT_COLORS[h.by] || 'var(--text-secondary)' }}>
                      {h.by}
                    </span>
                    <span style={{ flex: 1 }}>{h.detail}</span>
                    <span style={{ whiteSpace: 'nowrap', opacity: 0.7 }}>{timeAgo(h.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Create Task Modal ── */}
      {showCreateModal && (
        <div className="drawer-backdrop" onClick={() => setShowCreateModal(false)}>
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px' }}>
              <h3 style={{ fontSize: '16px', color: '#fff' }}>Create Task</h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowCreateModal(false)}>
                <X size={14} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingTop: '14px' }}>
              <div>
                <div className="form-label">Title *</div>
                <input
                  className="search-input"
                  placeholder="Task title..."
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  autoFocus
                  style={{ width: '100%' }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                />
              </div>

              <div>
                <div className="form-label">Description</div>
                <textarea
                  className="search-input"
                  placeholder="Detailed description..."
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  rows={3}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <div className="form-label">Column</div>
                  <select className="select-filter" value={createColumn} onChange={(e) => setCreateColumn(e.target.value as BoardColumn)} style={{ width: '100%' }}>
                    {columns.map(c => (
                      <option key={c} value={c}>{COLUMN_CONFIG[c as BoardColumn]?.label || c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="form-label">Priority</div>
                  <select className="select-filter" value={newPriority} onChange={(e) => setNewPriority(e.target.value as BoardPriority)} style={{ width: '100%' }}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <div className="form-label">Assignee</div>
                  <select className="select-filter" value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)} style={{ width: '100%' }}>
                    <option value="">Unassigned</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.id}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="form-label">Created By</div>
                  <input
                    className="search-input"
                    value={newCreatedBy}
                    onChange={(e) => setNewCreatedBy(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              <div>
                <div className="form-label">Labels (comma-separated)</div>
                <input
                  className="search-input"
                  placeholder="e.g. ue5, animation, bug"
                  value={newLabels}
                  onChange={(e) => setNewLabels(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>

              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={!newTitle.trim() || isSubmitting}
                style={{ marginTop: '8px' }}
              >
                <Plus size={14} />
                <span>{isSubmitting ? 'Creating...' : 'Create Task'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
