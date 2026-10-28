import React from 'react';
import { Activity, Radio, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { SystemSnapshot } from '../types';

interface ActivityTimelineViewProps {
  snapshot: SystemSnapshot | null;
}

export const ActivityTimelineView: React.FC<ActivityTimelineViewProps> = ({ snapshot }) => {
  if (!snapshot) return null;
  const logs = snapshot.logs || [];

  return (
    <div className="content-view">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            <Activity size={20} />
            <span>High-Density Activity Timeline</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Sequential event stream of notifications, claims, execution leases, and status transitions.
          </p>
        </div>
      </div>

      <div className="timeline">
        {logs.length === 0 ? (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: '8px' }}>
            No recent activity recorded yet.
          </div>
        ) : (
          logs.map((evt) => {
            const isError = evt.level === 'ERROR';
            const isWarn = evt.level === 'WARN';
            return (
              <div key={evt.id} className="timeline-item">
                <div className="timeline-icon" style={{ 
                  background: isError ? 'var(--color-danger-bg)' : isWarn ? 'var(--color-warning-bg)' : 'var(--accent-glow)' 
                }}>
                  {isError ? <AlertCircle size={16} color="var(--color-danger)" /> : <Activity size={16} color="var(--accent-primary)" />}
                </div>
                <div className="timeline-content">
                  <div className="timeline-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <strong style={{ fontSize: '13px', color: '#fff' }}>{evt.type}</strong>
                      {evt.agentId && (
                        <span className="status-pill status-idle btn-sm" style={{ padding: '2px 6px', fontSize: '10px' }}>
                          {evt.agentId}
                        </span>
                      )}
                      {evt.messageId && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-primary)' }}>
                          [{evt.messageId}]
                        </span>
                      )}
                    </div>
                    <span className="timeline-time">{new Date(evt.timestamp).toLocaleString()}</span>
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
  );
};
