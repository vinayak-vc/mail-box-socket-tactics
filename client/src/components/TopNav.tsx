import React, { useState } from 'react';
import { 
  Play, 
  Square, 
  RotateCw, 
  Radio, 
  Clock, 
  AlertTriangle,
  Globe 
} from 'lucide-react';
import { SystemSnapshot } from '../types';
import { client } from '../api';

interface TopNavProps {
  snapshot: SystemSnapshot | null;
  wsConnected: boolean;
  onRefresh: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({ snapshot, wsConnected, onRefresh }) => {
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const isBrokerUp = snapshot?.broker.status === 'UP';

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    if ((action === 'stop' || action === 'restart') && !confirmAction) {
      setConfirmAction(action);
      return;
    }

    setConfirmAction(null);
    setIsProcessing(true);
    setActionMessage(`Executing ${action}...`);

    try {
      const res = await client.serviceControl(action, 'all');
      setActionMessage(res.result?.message || `${action} completed.`);
      setTimeout(() => {
        setActionMessage(null);
        onRefresh();
      }, 2000);
    } catch (err: any) {
      setActionMessage(`Error: ${err.message}`);
      setTimeout(() => setActionMessage(null), 3500);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatLastUpdate = (iso?: string) => {
    if (!iso) return 'Waiting...';
    const date = new Date(iso);
    return date.toLocaleTimeString();
  };

  return (
    <>
      <header className="top-nav">
        <div className="top-left">
          {/* System Status */}
          <div className={`status-pill ${isBrokerUp ? 'status-up' : 'status-stopped'}`}>
            <span className="status-dot"></span>
            <span>SYSTEM: {isBrokerUp ? 'ONLINE' : 'STOPPED'}</span>
          </div>

          {/* WebSocket Link */}
          <div className={`status-pill ${wsConnected ? 'status-online' : 'status-offline'}`}>
            <Radio size={14} />
            <span>{wsConnected ? 'LIVE WS' : 'WS RECONNECTING'}</span>
          </div>

          {/* Public zrok URL link */}
          {snapshot?.zrok?.publicUrl && (
            <a 
              href={snapshot.zrok.publicUrl}
              target="_blank" 
              rel="noreferrer"
              className="status-pill status-online"
              style={{ textDecoration: 'none', cursor: 'pointer' }}
              title={`Public Internet Access URL: ${snapshot.zrok.publicUrl}`}
            >
              <Globe size={13} />
              <span>Public: {snapshot.zrok.shareToken || 'Live'}</span>
            </a>
          )}

          {/* Last Update */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
            <Clock size={13} />
            <span>Updated: {formatLastUpdate(snapshot?.timestamp)}</span>
          </div>

          {actionMessage && (
            <div style={{ fontSize: '12px', color: 'var(--accent-primary)', fontWeight: 600 }}>
              {actionMessage}
            </div>
          )}
        </div>

        <div className="top-right">
          {/* Start Service */}
          <button 
            className="btn btn-secondary btn-sm" 
            onClick={() => handleServiceAction('start')}
            disabled={isProcessing || isBrokerUp}
            title="Start Event Broker & Adapters"
          >
            <Play size={13} />
            <span>Start</span>
          </button>

          {/* Stop Service */}
          <button 
            className="btn btn-secondary btn-sm" 
            onClick={() => handleServiceAction('stop')}
            disabled={isProcessing || !isBrokerUp}
            title="Stop Services"
          >
            <Square size={13} />
            <span>Stop</span>
          </button>

          {/* Restart Service */}
          <button 
            className="btn btn-secondary btn-sm" 
            onClick={() => handleServiceAction('restart')}
            disabled={isProcessing}
            title="Restart Service Stack"
          >
            <RotateCw size={13} />
            <span>Restart</span>
          </button>
        </div>
      </header>

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="modal-backdrop">
          <div className="modal-dialog">
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--color-warning)' }}>
                <AlertTriangle size={20} />
                <h3 style={{ fontSize: '15px' }}>Confirm Service {confirmAction.toUpperCase()}</h3>
              </div>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                Are you sure you want to <strong>{confirmAction}</strong> the AI team services?
                {confirmAction === 'stop' && (
                  <span style={{ display: 'block', marginTop: '10px', color: 'var(--color-danger)' }}>
                    Stopping the broker will disconnect all active agents and pause real-time notification dispatch. Persistent state is safely retained.
                  </span>
                )}
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button 
                className={`btn ${confirmAction === 'stop' ? 'btn-danger' : 'btn-primary'}`} 
                onClick={() => handleServiceAction(confirmAction)}
              >
                Confirm {confirmAction.charAt(0).toUpperCase() + confirmAction.slice(1)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
