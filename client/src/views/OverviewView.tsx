import React, { useState } from 'react';
import { 
  Server, 
  Users, 
  Cpu, 
  Clock, 
  CheckCircle2, 
  AlertCircle, 
  Search, 
  RefreshCw,
  Eye,
  Radio,
  FileText
} from 'lucide-react';
import { SystemSnapshot, ActivityEvent } from '../types';

interface OverviewViewProps {
  snapshot: SystemSnapshot | null;
  onRefresh: () => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ snapshot, onRefresh }) => {
  const [filterType, setFilterType] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState<string>('');

  if (!snapshot) {
    return (
      <div className="content-view" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', marginBottom: '12px' }} />
          <p>Connecting to MailSocketTactics Broker...</p>
        </div>
      </div>
    );
  }

  const agents = snapshot.agents || [];
  const connectedAgents = agents.filter(a => a.connected);
  const workingAgents = agents.filter(a => a.status === 'working');
  const idleAgents = agents.filter(a => a.status === 'idle');
  const offlineAgents = agents.filter(a => a.status === 'offline' || a.status === 'degraded');

  const tasks = snapshot.tasks;
  const logs = snapshot.logs || [];

  // Filter logs
  const filteredLogs = logs.filter(event => {
    if (filterType !== 'all' && event.type !== filterType && event.level !== filterType) {
      return false;
    }
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const matchSummary = (event.summary || '').toLowerCase().includes(s);
      const matchAgent = (event.agentId || '').toLowerCase().includes(s);
      const matchMsg = (event.messageId || '').toLowerCase().includes(s);
      if (!matchSummary && !matchAgent && !matchMsg) return false;
    }
    return true;
  });

  const formatUptime = (sec: number) => {
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${hours}h ${mins}m ${s}s`;
  };

  return (
    <div className="content-view">
      {/* 1. Summary Cards */}
      <div className="grid-cards">
        {/* Connected Agents */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Connected Agents</span>
            <Users size={16} color="var(--accent-primary)" />
          </div>
          <div className="metric-value">{connectedAgents.length} <span style={{ fontSize: '14px', color: 'var(--text-muted)', fontWeight: 400 }}>/ {agents.length}</span></div>
          <div className="metric-sub">{workingAgents.length} executing tasks, {idleAgents.length} idle</div>
        </div>

        {/* Running Tasks */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Executing Tasks</span>
            <Cpu size={16} color="var(--accent-primary)" />
          </div>
          <div className="metric-value">{tasks.runningCount}</div>
          <div className="metric-sub">Active leases locked in StateStore</div>
        </div>

        {/* Pending Tasks */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Pending Tasks</span>
            <Clock size={16} color="var(--color-warning)" />
          </div>
          <div className="metric-value">{tasks.pendingCount}</div>
          <div className="metric-sub">Awaiting agent worker claims</div>
        </div>

        {/* Completed Tasks */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Completed Tasks</span>
            <CheckCircle2 size={16} color="var(--color-success)" />
          </div>
          <div className="metric-value">{tasks.completedCount}</div>
          <div className="metric-sub">Verified & recorded with evidence</div>
        </div>

        {/* Failed & DLQ */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Dead Letter Queue</span>
            <AlertCircle size={16} color="var(--color-danger)" />
          </div>
          <div className="metric-value">{tasks.deadLetterCount}</div>
          <div className="metric-sub">{tasks.failedCount} retryable failures</div>
        </div>

        {/* Mailbox Total */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Total Mailbox Messages</span>
            <FileText size={16} color="var(--color-info)" />
          </div>
          <div className="metric-value">{snapshot.mailbox.totalMessages}</div>
          <div className="metric-sub">{snapshot.mailbox.exists ? 'Authoritative file mounted' : 'Mailbox missing'}</div>
        </div>
      </div>

      {/* 2. Service Health Grid */}
      <div style={{ marginBottom: '24px' }}>
        <div className="section-header">
          <h2 className="section-title">
            <Server size={18} />
            <span>Service Stack Health & Telemetry</span>
          </h2>
          <button className="btn btn-secondary btn-sm" onClick={onRefresh}>
            <RefreshCw size={12} />
            <span>Refresh Health</span>
          </button>
        </div>

        <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          {/* WebSocket Server */}
          <div className="metric-card">
            <div className="metric-title">
              <span>WebSocket Broker</span>
              <span className="status-pill status-online btn-sm">ws://:{snapshot.broker.port}</span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Uptime: <strong>{formatUptime(snapshot.broker.uptimeSeconds)}</strong>
            </div>
            <div className="metric-sub">Accepted: {snapshot.broker.metrics.connectionsAccepted} connections</div>
          </div>

          {/* HTTP Control API */}
          <div className="metric-card">
            <div className="metric-title">
              <span>HTTP Control API</span>
              <span className="status-pill status-online btn-sm">http://:{snapshot.broker.httpPort}</span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Notifications Sent: <strong>{snapshot.broker.metrics.notificationsSent}</strong>
            </div>
            <div className="metric-sub">Auth Failures: {snapshot.broker.metrics.authFailures}</div>
          </div>

          {/* Mailbox Watcher */}
          <div className="metric-card">
            <div className="metric-title">
              <span>Mailbox Watcher</span>
              <span className={`status-pill ${snapshot.services.watcherRunning ? 'status-online' : 'status-stopped'} btn-sm`}>
                {snapshot.services.watcherRunning ? 'ACTIVE' : 'INACTIVE'}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', wordBreak: 'break-all' }}>
              {snapshot.services.watcherPath || 'Default path'}
            </div>
            <div className="metric-sub">File Lock Retries & Debounce Active</div>
          </div>

          {/* Durable State Store */}
          <div className="metric-card">
            <div className="metric-title">
              <span>Durable StateStore</span>
              <span className="status-pill status-online btn-sm">PERSISTED</span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Total Tracked: <strong>{tasks.all.length} tasks</strong>
            </div>
            <div className="metric-sub">Atomic JSON (mailbox_state.json)</div>
          </div>

          {/* Public Internet Access (zrok) */}
          <div className="metric-card">
            <div className="metric-title">
              <span>Public Internet (zrok)</span>
              <span className={`status-pill ${snapshot.zrok?.status === 'CONNECTED' ? 'status-online' : (snapshot.zrok?.status === 'STARTING' ? 'status-working' : 'status-stopped')} btn-sm`}>
                {snapshot.zrok?.status || 'DISABLED'}
              </span>
            </div>
            {snapshot.zrok?.publicUrl ? (
              <div style={{ fontSize: '12px', marginTop: '6px' }}>
                <a 
                  href={snapshot.zrok.publicUrl} 
                  target="_blank" 
                  rel="noreferrer" 
                  style={{ color: 'var(--accent-primary)', textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  {snapshot.zrok.publicUrl}
                </a>
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                {snapshot.zrok?.enabled ? 'Establishing tunnel...' : 'Tunnel not active'}
              </div>
            )}
            <div className="metric-sub">Local + Internet Dual Mode</div>
          </div>
        </div>
      </div>

      {/* 3. Live Activity Feed */}
      <div>
        <div className="section-header">
          <h2 className="section-title">
            <Radio size={18} color="var(--accent-primary)" />
            <span>Operational Activity Feed</span>
          </h2>
        </div>

        {/* Filter bar */}
        <div className="filter-bar">
          <div style={{ position: 'relative' }}>
            <input 
              type="text" 
              className="search-input" 
              placeholder="Search events, agents, tasks..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <select 
            className="select-filter" 
            value={filterType} 
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="all">All Event Types</option>
            <option value="AGENT_CONNECTED">Agent Connected</option>
            <option value="AGENT_DISCONNECTED">Agent Disconnected</option>
            <option value="TASK_CLAIMED">Task Claimed</option>
            <option value="TASK_COMPLETED">Task Completed</option>
            <option value="TASK_FAILED">Task Failed</option>
            <option value="MAILBOX_MESSAGE">Mailbox Message</option>
            <option value="SERVICE_CONTROL">Service Action</option>
            <option value="ERROR">Errors Only</option>
            <option value="WARN">Warnings Only</option>
          </select>
        </div>

        {/* Timeline List */}
        <div className="timeline">
          {filteredLogs.length === 0 ? (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: '8px' }}>
              No activity matching the current filter.
            </div>
          ) : (
            filteredLogs.slice(0, 30).map((evt) => {
              const isError = evt.level === 'ERROR';
              const isWarn = evt.level === 'WARN';
              const iconColor = isError ? 'var(--color-danger)' : isWarn ? 'var(--color-warning)' : 'var(--accent-primary)';

              return (
                <div key={evt.id} className="timeline-item">
                  <div className="timeline-icon" style={{ background: isError ? 'var(--color-danger-bg)' : isWarn ? 'var(--color-warning-bg)' : 'var(--accent-glow)' }}>
                    {isError ? <AlertCircle size={16} color={iconColor} /> : <Radio size={16} color={iconColor} />}
                  </div>
                  <div className="timeline-content">
                    <div className="timeline-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700, color: '#fff' }}>{evt.type}</span>
                        {evt.agentId && (
                          <span className="status-pill status-idle btn-sm" style={{ padding: '1px 6px', fontSize: '10px' }}>
                            {evt.agentId}
                          </span>
                        )}
                        {evt.messageId && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-primary)' }}>
                            [{evt.messageId}]
                          </span>
                        )}
                      </div>
                      <span className="timeline-time">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {evt.summary}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
