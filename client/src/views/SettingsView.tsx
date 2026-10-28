import React, { useState } from 'react';
import { Settings, Shield, Server, FileText, Download, Copy, Check, Eye, EyeOff } from 'lucide-react';
import { SystemSnapshot } from '../types';

interface SettingsViewProps {
  snapshot: SystemSnapshot | null;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ snapshot }) => {
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!snapshot) return null;

  const copySnapshot = () => {
    navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="content-view">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            <Settings size={20} />
            <span>System Settings & Operational Topology</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Broker network endpoints, filesystem paths, security parameters, and diagnostics.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={copySnapshot}>
          {copied ? <Check size={12} color="var(--color-success)" /> : <Copy size={12} />}
          <span>{copied ? 'Copied' : 'Copy System Snapshot'}</span>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', maxWidth: '900px' }}>
        {/* Network & Endpoints */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Broker Network Endpoints</span>
            <Server size={16} color="var(--accent-primary)" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px', fontSize: '13px' }}>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>WebSocket URL: </span>
              <strong className="mono-cell">ws://{snapshot.broker.host}:{snapshot.broker.port}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>HTTP API URL: </span>
              <strong className="mono-cell">http://{snapshot.broker.host}:{snapshot.broker.httpPort}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Heartbeat Interval: </span>
              <strong>15,000 ms (15s)</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Client Timeout: </span>
              <strong>35,000 ms (35s)</strong>
            </div>
          </div>
        </div>

        {/* Security & Auth */}
        <div className="metric-card">
          <div className="metric-title">
            <span>Security & Authentication</span>
            <Shield size={16} color="var(--color-success)" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px', fontSize: '13px' }}>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Binding: </span>
              <strong>127.0.0.1 (Strict Localhost Only)</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Execution Security: </span>
              <strong style={{ color: 'var(--color-success)' }}>shell: false (No Command Injection)</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Bearer Auth Token: </span>
              <span className="mono-cell" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                {showToken ? 'mailbox-socket-secret-token' : '••••••••••••••••••••••••'}
                <button 
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
            </div>
          </div>
        </div>

        {/* Mailbox Storage */}
        <div className="metric-card" style={{ gridColumn: 'span 2' }}>
          <div className="metric-title">
            <span>Authoritative Mailbox & Locking</span>
            <FileText size={16} color="var(--color-info)" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px', fontSize: '13px' }}>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Authoritative Path: </span>
              <strong className="mono-cell">{snapshot.mailbox.path || 'Documentation/TEAM_MAILBOX.md'}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Windows Mutex Name: </span>
              <strong className="mono-cell">Global\OneBossFightMailbox</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>StateStore Path: </span>
              <strong className="mono-cell">data/mailbox_state.json (Atomic replace)</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Agent Registry Path: </span>
              <strong className="mono-cell">data/agent_registry.json</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
