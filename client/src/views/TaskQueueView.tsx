import React, { useState } from 'react';
import { 
  ListTodo, 
  RotateCw, 
  XCircle, 
  Copy, 
  Check, 
  Search, 
  Filter, 
  Clock, 
  CheckCircle2, 
  AlertCircle,
  X
} from 'lucide-react';
import { Task, SystemSnapshot } from '../types';
import { client } from '../api';

interface TaskQueueViewProps {
  snapshot: SystemSnapshot | null;
  onRefresh: () => void;
}

export const TaskQueueView: React.FC<TaskQueueViewProps> = ({ snapshot, onRefresh }) => {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [copied, setCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  if (!snapshot) return null;

  const allTasks = snapshot.tasks?.all || [];

  const filteredTasks = allTasks.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (agentFilter !== 'all') {
      const match = (t.recipient || '').toLowerCase().includes(agentFilter.toLowerCase()) ||
                    (t.claimOwner || '').toLowerCase().includes(agentFilter.toLowerCase());
      if (!match) return false;
    }
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const matchId = (t.messageId || '').toLowerCase().includes(s);
      const matchSender = (t.sender || '').toLowerCase().includes(s);
      const matchRecip = (t.recipient || '').toLowerCase().includes(s);
      if (!matchId && !matchSender && !matchRecip) return false;
    }
    return true;
  });

  const handleRetry = async (taskId: string) => {
    setActionLoading(taskId);
    try {
      await client.retryTask(taskId);
      onRefresh();
    } catch (err: any) {
      alert(`Retry error: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (taskId: string) => {
    if (!confirm(`Are you sure you want to cancel task ${taskId}?`)) return;
    setActionLoading(taskId);
    try {
      await client.cancelTask(taskId);
      onRefresh();
    } catch (err: any) {
      alert(`Cancel error: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const copyDiagnostics = (task: Task) => {
    navigator.clipboard.writeText(JSON.stringify(task, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderStatusPill = (status: string) => {
    const s = status.toUpperCase();
    if (s === 'COMPLETED') return <span className="status-pill status-completed">COMPLETED</span>;
    if (s === 'RUNNING') return <span className="status-pill status-running">RUNNING</span>;
    if (s === 'CLAIMED') return <span className="status-pill status-working">CLAIMED</span>;
    if (s === 'PENDING') return <span className="status-pill status-pending">PENDING</span>;
    if (s === 'DEAD_LETTER') return <span className="status-pill status-failed">DEAD LETTER</span>;
    if (s === 'FAILED') return <span className="status-pill status-failed">FAILED</span>;
    if (s === 'CANCELLED') return <span className="status-pill status-cancelled">CANCELLED</span>;
    return <span className="status-pill status-idle">{status}</span>;
  };

  // Determine active step index in 9-step lifecycle (0 to 8)
  const getLifecycleStep = (task: Task): number => {
    if (task.status === 'COMPLETED') return 8;
    if (task.status === 'FAILED' || task.status === 'DEAD_LETTER') return 8;
    if (task.status === 'RUNNING') return 4;
    if (task.status === 'CLAIMED') return 2;
    return 1;
  };

  const lifecycleSteps = [
    'Message Received',
    'Message Validated',
    'Task Claimed & Lock Acquired',
    'Agent Invoked',
    'Work Execution Started',
    'Lease Renewals & Progress',
    'Result Received',
    'Mailbox Response Recorded',
    'Task Completed / Finalized'
  ];

  return (
    <div className="content-view">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            <ListTodo size={20} />
            <span>Task Queue & Durable Lifecycle</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Atomic task leases, worker assignments, retries, and dead-letter quarantine.
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="filter-bar">
        <input 
          type="text" 
          className="search-input" 
          placeholder="Filter by Task/Message ID, sender, recipient..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        <select className="select-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All Statuses ({allTasks.length})</option>
          <option value="PENDING">Pending</option>
          <option value="CLAIMED">Claimed</option>
          <option value="RUNNING">Running</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed</option>
          <option value="DEAD_LETTER">Dead Letter</option>
          <option value="CANCELLED">Cancelled</option>
        </select>

        <select className="select-filter" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="all">All Agents</option>
          <option value="Claude">Claude</option>
          <option value="Codex">Codex</option>
          <option value="Antigravity">Antigravity</option>
        </select>
      </div>

      {/* Tasks Table */}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Message ID</th>
              <th>Status</th>
              <th>Sender</th>
              <th>Recipient</th>
              <th>Claim Owner</th>
              <th>Attempts</th>
              <th>Lease Expiry</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredTasks.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                  No tasks matching the selected filters.
                </td>
              </tr>
            ) : (
              filteredTasks.map((t) => (
                <tr 
                  key={t.messageId} 
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedTask(t)}
                >
                  <td className="mono-cell" style={{ fontWeight: 700, color: '#fff' }}>
                    {t.messageId}
                  </td>
                  <td>{renderStatusPill(t.status)}</td>
                  <td>{t.sender}</td>
                  <td>{t.recipient}</td>
                  <td className="mono-cell">{t.claimOwner || '—'}</td>
                  <td className="mono-cell">{t.attempts} / {t.maxAttempts}</td>
                  <td className="mono-cell">
                    {t.leaseExpiresAt ? (
                      t.leaseExpiresAt > Date.now() ? (
                        <span style={{ color: 'var(--accent-primary)' }}>
                          {Math.round((t.leaseExpiresAt - Date.now()) / 1000)}s left
                        </span>
                      ) : (
                        <span style={{ color: 'var(--color-danger)' }}>Expired</span>
                      )
                    ) : '—'}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {(t.status === 'DEAD_LETTER' || t.status === 'FAILED') && (
                        <button 
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleRetry(t.messageId)}
                          disabled={actionLoading === t.messageId}
                          title="Requeue / Retry Task"
                        >
                          <RotateCw size={12} />
                          <span>Retry</span>
                        </button>
                      )}
                      {(t.status === 'PENDING' || t.status === 'CLAIMED') && (
                        <button 
                          className="btn btn-danger btn-sm"
                          onClick={() => handleCancel(t.messageId)}
                          disabled={actionLoading === t.messageId}
                          title="Cancel Task"
                        >
                          <XCircle size={12} />
                          <span>Cancel</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Task Lifecycle Detail Drawer */}
      {selectedTask && (
        <div className="drawer-backdrop" onClick={() => setSelectedTask(null)}>
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '16px' }}>
              <div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Task Lifecycle Detail</span>
                <h3 style={{ fontSize: '18px', color: '#fff', fontFamily: 'var(--font-mono)' }}>{selectedTask.messageId}</h3>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setSelectedTask(null)}>
                <X size={16} />
              </button>
            </div>

            <div>
              <div className="form-label">Current Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {renderStatusPill(selectedTask.status)}
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Attempts: {selectedTask.attempts} of {selectedTask.maxAttempts}
                </span>
              </div>
            </div>

            {/* 9-Step Lifecycle Visualization */}
            <div>
              <div className="form-label">Task Progress Lifecycle</div>
              <div className="lifecycle-stepper">
                {lifecycleSteps.map((stepName, idx) => {
                  const currentStepIdx = getLifecycleStep(selectedTask);
                  const isDone = idx < currentStepIdx || (idx === 8 && selectedTask.status === 'COMPLETED');
                  const isCurrent = idx === currentStepIdx && selectedTask.status !== 'COMPLETED';

                  return (
                    <div key={idx} className="step-row">
                      <div className={`step-dot ${isDone ? 'completed' : isCurrent ? 'active' : ''}`}>
                        {isDone ? '✓' : idx + 1}
                      </div>
                      <span style={{ 
                        color: isDone ? 'var(--text-primary)' : isCurrent ? 'var(--accent-primary)' : 'var(--text-muted)',
                        fontWeight: isCurrent ? 700 : 400
                      }}>
                        {stepName}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Error if any */}
            {selectedTask.lastError && (
              <div>
                <div className="form-label" style={{ color: 'var(--color-danger)' }}>Error Diagnostics</div>
                <div style={{ background: 'var(--color-danger-bg)', padding: '10px', borderRadius: '6px', color: 'var(--color-danger)', fontSize: '12px' }}>
                  {selectedTask.lastError}
                </div>
              </div>
            )}

            {/* Raw JSON */}
            <div>
              <div className="form-label">State Store Record</div>
              <div className="code-preview">
                {JSON.stringify(selectedTask, null, 2)}
              </div>
            </div>

            <div style={{ marginTop: 'auto', display: 'flex', gap: '10px' }}>
              <button className="btn btn-secondary" onClick={() => copyDiagnostics(selectedTask)}>
                {copied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
                <span>{copied ? 'Copied' : 'Copy Diagnostics'}</span>
              </button>

              {(selectedTask.status === 'FAILED' || selectedTask.status === 'DEAD_LETTER') && (
                <button className="btn btn-primary" onClick={() => handleRetry(selectedTask.messageId)}>
                  <RotateCw size={14} />
                  <span>Requeue / Retry</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
