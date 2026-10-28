import React, { useState } from 'react';
import { Settings, Shield, Server, FileText, Download, Copy, Check, Eye, EyeOff } from 'lucide-react';
import { SystemSnapshot } from '../types';
import { getAuthToken } from '../api';

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
                {showToken ? getAuthToken() : '••••••••••••••••••••••••'}
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

        {/* Public Internet Tunnel (zrok) */}
        <div className="metric-card" style={{ gridColumn: 'span 2' }}>
          <div className="metric-title">
            <span>Public Internet Tunnel (zrok)</span>
            <span className={`status-pill ${snapshot.zrok?.status === 'CONNECTED' ? 'status-online' : (snapshot.zrok?.status === 'STARTING' ? 'status-working' : 'status-stopped')} btn-sm`}>
              {snapshot.zrok?.status || 'DISABLED'}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginTop: '12px', fontSize: '13px' }}>
            <div>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Public Internet URL:</div>
              {snapshot.zrok?.publicUrl ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <a 
                    href={snapshot.zrok.publicUrl} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="mono-cell" 
                    style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}
                  >
                    {snapshot.zrok.publicUrl}
                  </a>
                  <button 
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      if (snapshot.zrok?.publicUrl) {
                        navigator.clipboard.writeText(snapshot.zrok.publicUrl);
                      }
                    }}
                  >
                    Copy
                  </button>
                </div>
              ) : (
                <span className="text-muted">Not active</span>
              )}
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Access Mode:</div>
              <strong>Local (127.0.0.1) & Public Internet Dual Access</strong>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>zrok Authentication Token:</div>
              <span className="mono-cell">{snapshot.zrok?.tokenMasked || (snapshot.zrok?.tokenConfigured ? 'Configured' : 'Not set')}</span>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Target Proxy:</div>
              <span className="mono-cell">{snapshot.zrok?.target || 'http://127.0.0.1:8766'}</span>
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
