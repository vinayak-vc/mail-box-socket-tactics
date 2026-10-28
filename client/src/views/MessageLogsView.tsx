import React, { useState } from 'react';
import { 
  FileText, 
  Download, 
  Search, 
  Filter, 
  Copy, 
  Check, 
  AlertCircle, 
  Info, 
  AlertTriangle 
} from 'lucide-react';
import { SystemSnapshot, ActivityEvent } from '../types';
import { client } from '../api';

interface MessageLogsViewProps {
  snapshot: SystemSnapshot | null;
}

export const MessageLogsView: React.FC<MessageLogsViewProps> = ({ snapshot }) => {
  const [levelFilter, setLevelFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [copied, setCopied] = useState(false);

  if (!snapshot) return null;

  const logs = snapshot.logs || [];

  const filteredLogs = logs.filter(evt => {
    if (levelFilter !== 'all' && evt.level !== levelFilter) return false;
    if (typeFilter !== 'all' && evt.type !== typeFilter) return false;
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const matchSummary = (evt.summary || '').toLowerCase().includes(s);
      const matchAgent = (evt.agentId || '').toLowerCase().includes(s);
      const matchMsg = (evt.messageId || '').toLowerCase().includes(s);
      if (!matchSummary && !matchAgent && !matchMsg) return false;
    }
    return true;
  });

  const copyLogJson = () => {
    navigator.clipboard.writeText(JSON.stringify(filteredLogs, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (format: 'json' | 'csv') => {
    window.open(client.getExportUrl(format), '_blank');
  };

  return (
    <div className="content-view">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            <FileText size={20} />
            <span>Message & Operational Logs</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Real-time operational records with automatic redaction of secrets, tokens, and authorization headers.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-secondary btn-sm" onClick={copyLogJson}>
            {copied ? <Check size={12} color="var(--color-success)" /> : <Copy size={12} />}
            <span>{copied ? 'Copied' : 'Copy Filtered JSON'}</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => handleDownload('json')}>
            <Download size={12} />
            <span>Export JSON</span>
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => handleDownload('csv')}>
            <Download size={12} />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="filter-bar">
        <input 
          type="text" 
          className="search-input" 
          placeholder="Search log messages, agent ID, task ID..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        <select className="select-filter" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
          <option value="all">All Levels</option>
          <option value="INFO">INFO Only</option>
          <option value="WARN">WARN Only</option>
          <option value="ERROR">ERROR Only</option>
        </select>

        <select className="select-filter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All Types</option>
          <option value="AGENT_CONNECTED">Agent Connected</option>
          <option value="AGENT_DISCONNECTED">Agent Disconnected</option>
          <option value="NOTIFICATION_DISPATCHED">Notification Dispatched</option>
          <option value="TASK_CLAIMED">Task Claimed</option>
          <option value="TASK_COMPLETED">Task Completed</option>
          <option value="TASK_FAILED">Task Failed</option>
          <option value="DEAD_LETTER">Dead Letter</option>
          <option value="SERVICE_CONTROL">Service Control</option>
        </select>
      </div>

      {/* Logs Table */}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Level</th>
              <th>Type</th>
              <th>Agent</th>
              <th>Message ID</th>
              <th>Operational Summary</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                  No log entries found.
                </td>
              </tr>
            ) : (
              filteredLogs.map((evt) => {
                const isError = evt.level === 'ERROR';
                const isWarn = evt.level === 'WARN';
                return (
                  <tr key={evt.id}>
                    <td className="mono-cell" style={{ whiteSpace: 'nowrap', fontSize: '11px' }}>
                      {new Date(evt.timestamp).toLocaleTimeString()}
                    </td>
                    <td>
                      <span className={`status-pill ${isError ? 'status-failed' : isWarn ? 'status-idle' : 'status-completed'} btn-sm`} style={{ fontSize: '10px' }}>
                        {evt.level}
                      </span>
                    </td>
                    <td className="mono-cell" style={{ fontWeight: 600, color: '#fff' }}>
                      {evt.type}
                    </td>
                    <td>{evt.agentId || '—'}</td>
                    <td className="mono-cell" style={{ color: 'var(--accent-primary)' }}>
                      {evt.messageId || '—'}
                    </td>
                    <td style={{ color: isError ? 'var(--color-danger)' : 'var(--text-secondary)' }}>
                      {evt.summary}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
