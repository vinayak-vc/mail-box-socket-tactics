import React, { useState } from 'react';
import { 
  Bot, 
  Play, 
  Pause, 
  Terminal, 
  Radio, 
  CheckCircle, 
  AlertTriangle, 
  Clock, 
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  X
} from 'lucide-react';
import { Agent, SystemSnapshot } from '../types';
import { client } from '../api';

interface AgentsViewProps {
  snapshot: SystemSnapshot | null;
  onRefresh: () => void;
}

export const AgentsView: React.FC<AgentsViewProps> = ({ snapshot, onRefresh }) => {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [testResult, setTestResult] = useState<any | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  if (!snapshot) return null;

  const agents = snapshot.agents || [];

  const handleTogglePause = async (agent: Agent) => {
    setActionLoading(agent.id);
    try {
      await client.updateAgent(agent.id, { paused: !agent.paused });
      onRefresh();
    } catch (err: any) {
      alert(`Error updating agent: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleTestAgent = async (agent: Agent) => {
    setActionLoading(agent.id);
    setTestResult(null);
    try {
      const res = await client.testAgent(agent.id);
      setTestResult(res);
    } catch (err: any) {
      setTestResult({ capable: false, status: 'Error', details: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'working':
        return <span className="status-pill status-working"><span className="status-dot"></span>WORKING</span>;
      case 'idle':
        return <span className="status-pill status-online"><span className="status-dot"></span>IDLE / READY</span>;
      case 'paused':
        return <span className="status-pill status-idle"><span className="status-dot"></span>PAUSED</span>;
      case 'degraded':
        return <span className="status-pill status-degraded"><span className="status-dot"></span>DEGRADED</span>;
      case 'disabled':
        return <span className="status-pill status-offline"><span className="status-dot"></span>DISABLED</span>;
      default:
        return <span className="status-pill status-offline"><span className="status-dot"></span>OFFLINE</span>;
    }
  };

  return (
    <div className="content-view">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            <Bot size={20} />
            <span>Registered AI Coding Agents</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Multi-agent team coordinating asynchronously via local WebSocket notifications and TEAM_MAILBOX.md.
          </p>
        </div>
      </div>

      {/* Agent Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '20px' }}>
        {agents.map((agent) => {
          return (
            <div 
              key={agent.id} 
              className="metric-card" 
              style={{ cursor: 'pointer', position: 'relative' }}
              onClick={() => setSelectedAgent(agent)}
            >
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ 
                    width: '36px', 
                    height: '36px', 
                    borderRadius: '8px', 
                    background: agent.vendor === 'Anthropic' ? 'rgba(239, 68, 68, 0.15)' : agent.vendor === 'OpenAI' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(56, 189, 248, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 700,
                    color: '#fff'
                  }}>
                    {agent.partyCode}
                  </div>
                  <div>
                    <h3 style={{ fontSize: '15px', color: '#fff', fontWeight: 700 }}>{agent.displayName}</h3>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      ID: {agent.id} · {agent.vendor}
                    </span>
                  </div>
                </div>
                {renderStatusBadge(agent.status)}
              </div>

              {/* Role */}
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                {agent.role}
              </div>

              {/* Execution / Current Task */}
              <div style={{ background: 'var(--bg-input)', padding: '10px 12px', borderRadius: '6px', marginBottom: '12px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Current Execution
                </div>
                {agent.currentTaskId ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="status-dot" style={{ background: 'var(--accent-primary)' }}></span>
                    <span style={{ fontSize: '12px', color: 'var(--accent-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                      {agent.currentTaskId}: {agent.currentTaskTitle || 'Processing...'}
                    </span>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    No active task in progress (dormant)
                  </div>
                )}
              </div>

              {/* Metrics */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px', fontSize: '12px' }}>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Completed Tasks: </span>
                  <strong style={{ color: 'var(--color-success)', fontFamily: 'var(--font-mono)' }}>{agent.completedCount}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Failed Tasks: </span>
                  <strong style={{ color: agent.failedCount > 0 ? 'var(--color-danger)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {agent.failedCount}
                  </strong>
                </div>
              </div>

              {/* Footer Controls */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Integration: <strong>{agent.integrationMethod.toUpperCase()}</strong>
                </span>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button 
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleTogglePause(agent)}
                    disabled={actionLoading === agent.id}
                    title={agent.paused ? "Resume task assignments" : "Pause new task assignments (without killing active work)"}
                  >
                    {agent.paused ? <Play size={12} color="var(--color-success)" /> : <Pause size={12} color="var(--color-warning)" />}
                    <span>{agent.paused ? 'Resume' : 'Pause'}</span>
                  </button>

                  <button 
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleTestAgent(agent)}
                    disabled={actionLoading === agent.id}
                  >
                    <Terminal size={12} />
                    <span>Test</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Test Result Banner */}
      {testResult && (
        <div style={{ marginTop: '20px', padding: '14px 18px', background: 'var(--bg-card)', border: '1px solid var(--border-accent)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {testResult.capable ? <CheckCircle2 size={18} color="var(--color-success)" /> : <AlertTriangle size={18} color="var(--color-warning)" />}
            <div>
              <strong style={{ fontSize: '13px', color: '#fff' }}>Test Result for {testResult.agentId}: {testResult.status}</strong>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{testResult.details}</div>
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setTestResult(null)}>Dismiss</button>
        </div>
      )}

      {/* Agent Detail Drawer */}
      {selectedAgent && (
        <div className="drawer-backdrop" onClick={() => setSelectedAgent(null)}>
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '8px', background: 'var(--accent-glow)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800 }}>
                  {selectedAgent.partyCode}
                </div>
                <div>
                  <h3 style={{ fontSize: '16px', color: '#fff' }}>{selectedAgent.displayName}</h3>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    Agent ID: {selectedAgent.id}
                  </span>
                </div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setSelectedAgent(null)}>
                <X size={16} />
              </button>
            </div>

            <div>
              <div className="form-label">Status & Connection</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                {renderStatusBadge(selectedAgent.status)}
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {selectedAgent.connected ? 'WebSocket client connected to localhost:8765' : 'No active socket connected'}
                </span>
              </div>
            </div>

            <div>
              <div className="form-label">Role & Capabilities</div>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>{selectedAgent.role}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {selectedAgent.capabilities.map((c, i) => (
                  <span key={i} className="status-pill status-idle btn-sm" style={{ fontSize: '11px' }}>
                    {c}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <div className="form-label">Integration Configuration</div>
              <div className="code-preview">
                {JSON.stringify({
                  integrationMethod: selectedAgent.integrationMethod,
                  cliCommand: selectedAgent.cliCommand,
                  cliArgs: selectedAgent.cliArgs,
                  workingDir: selectedAgent.workingDir,
                  conversationId: selectedAgent.conversationId,
                  shell: false
                }, null, 2)}
              </div>
            </div>

            <div>
              <div className="form-label">Recent Error Telemetry</div>
              <div style={{ fontSize: '12px', color: selectedAgent.lastError ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                {selectedAgent.lastError || 'None recorded'}
              </div>
            </div>

            <div style={{ marginTop: 'auto', display: 'flex', gap: '10px' }}>
              <button 
                className="btn btn-secondary" 
                style={{ flex: 1 }}
                onClick={() => handleTogglePause(selectedAgent)}
              >
                {selectedAgent.paused ? 'Resume Assignment' : 'Pause Assignment'}
              </button>
              <button 
                className="btn btn-primary" 
                style={{ flex: 1 }}
                onClick={() => handleTestAgent(selectedAgent)}
              >
                Run Capability Check
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
