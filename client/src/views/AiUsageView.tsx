import React, { useState } from 'react';
import { 
  Zap, 
  Clock, 
  ShieldAlert, 
  Cpu, 
  RefreshCw, 
  Info
} from 'lucide-react';
import { SystemSnapshot, AgentQuota, UsageSummary } from '../types';

interface AiUsageViewProps {
  snapshot: SystemSnapshot | null;
  onRefresh?: () => void;
}

export const AiUsageView: React.FC<AiUsageViewProps> = ({ snapshot, onRefresh }) => {
  const [refreshing, setRefreshing] = useState(false);
  const usage: UsageSummary | undefined = snapshot?.usage || undefined;

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      if (onRefresh) onRefresh();
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  };

  const getBadgeClass = (state: string) => {
    switch (state) {
      case 'Available': return 'status-pill status-online';
      case 'Estimated': return 'status-pill status-idle';
      case 'Unavailable': return 'status-pill status-offline';
      case 'Stale': return 'status-pill status-failed';
      default: return 'status-pill';
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}m ${remSec}s`;
  };

  return (
    <div className="content-view" style={{ paddingBottom: '60px' }}>
      <div className="section-header" style={{ marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>
            AI Usage & Quota Monitoring
          </h2>
          <p className="text-muted" style={{ fontSize: '13px' }}>
            Live resource consumption, execution duration, and subscription quota telemetry for Claude Desktop, Codex Desktop, and Antigravity.
          </p>
        </div>
        <button 
          className="btn btn-secondary btn-sm" 
          onClick={handleManualRefresh}
          disabled={refreshing}
          style={{ flexShrink: 0 }}
        >
          <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
          <span>{refreshing ? 'Refreshing...' : 'Refresh Usage'}</span>
        </button>
      </div>

      {/* Aggregate Stats */}
      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: '20px' }}>
        <div className="metric-card" style={{ height: '115px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="metric-title">
            <span>Total Tasks Executed</span>
            <Cpu size={16} color="var(--accent-primary)" />
          </div>
          <div className="metric-value">{usage?.aggregated.totalTasks ?? 0}</div>
          <div className="metric-sub">Across all connected AI workers</div>
        </div>

        <div className="metric-card" style={{ height: '115px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="metric-title">
            <span>Total Compute Time</span>
            <Clock size={16} color="var(--color-success)" />
          </div>
          <div className="metric-value">{formatDuration(usage?.aggregated.totalComputeDurationMs ?? 0)}</div>
          <div className="metric-sub">Execution duration recorded by broker</div>
        </div>

        <div className="metric-card" style={{ height: '115px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="metric-title">
            <span>Estimated Token Volume</span>
            <Zap size={16} color="var(--color-warning)" />
          </div>
          <div className="metric-value">{(usage?.aggregated.totalEstimatedTokens ?? 0).toLocaleString()}</div>
          <div className="metric-sub">Estimated task payload tokens</div>
        </div>

        <div className="metric-card" style={{ height: '115px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="metric-title">
            <span>Data Transparency</span>
            <ShieldAlert size={16} color="var(--accent-primary)" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', height: '36px' }}>
            <span className="status-pill status-online" style={{ fontSize: '12px', fontWeight: 700, padding: '4px 10px' }}>
              Zero-Scrape Authoritative
            </span>
          </div>
          <div className="metric-sub">Separates subscription quotas from token counts</div>
        </div>
      </div>

      {/* Policy Notice Box */}
      <div style={{
        marginBottom: '24px',
        padding: '14px 18px',
        background: 'rgba(56, 189, 248, 0.07)',
        border: '1px solid rgba(56, 189, 248, 0.25)',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        fontSize: '13px',
        lineHeight: 1.5
      }}>
        <Info size={18} color="var(--accent-primary)" style={{ flexShrink: 0, marginTop: '2px' }} />
        <div>
          <strong style={{ color: '#fff' }}>Subscription Quota Integrity Notice (Section 11):</strong>
          <span style={{ color: 'var(--text-secondary)' }}>
            {' '}Desktop application subscription quotas (e.g. Claude Pro 5-hour window, ChatGPT Plus message limits) are dynamic rolling windows managed server-side by Anthropic and OpenAI. They are not direct static token buckets and are not exposed over unauthenticated local sockets. MailSocketTactics explicitly reports these as <code>Unavailable</code> or <code>Estimated</code> rather than inventing unverified numbers.
          </span>
        </div>
      </div>

      {/* Per Agent Quota Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {usage?.quotas.map((agentQuota: AgentQuota) => (
          <div key={agentQuota.agentId} className="metric-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Agent Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#fff' }}>{agentQuota.displayName}</h3>
                <span className="status-pill status-online" style={{ fontSize: '11px', padding: '2px 8px' }}>{agentQuota.vendor}</span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{agentQuota.tier}</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Source: <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{agentQuota.taskMetrics.source}</span>
                {' '}(Confidence: <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{agentQuota.taskMetrics.confidence}</span>)
              </div>
            </div>

            {/* Sub-cards Grid: 3 equal height columns with aligned key-value metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', alignItems: 'stretch' }}>
              {/* 5-Hour Subscription Quota */}
              <div style={{ 
                background: 'rgba(15, 23, 42, 0.6)', 
                padding: '16px', 
                borderRadius: '8px', 
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                minHeight: '170px'
              }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>5-Hour Subscription Quota</span>
                    <span className={getBadgeClass(agentQuota.fiveHourQuota.state)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                      {agentQuota.fiveHourQuota.state}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Window Type:</span>
                      <strong style={{ color: 'var(--text-secondary)' }}>Rolling 5-Hour Interval</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Telemetry Channel:</span>
                      <strong style={{ color: 'var(--text-secondary)' }}>Protected (Zero-Scrape)</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Quota Status:</span>
                      <strong style={{ color: agentQuota.fiveHourQuota.state === 'Available' ? 'var(--color-success)' : 'var(--text-muted)' }}>
                        {agentQuota.fiveHourQuota.value || 'Server-Side Dynamic'}
                      </strong>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4, marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                  {agentQuota.fiveHourQuota.note}
                </div>
              </div>

              {/* Weekly Subscription Quota */}
              <div style={{ 
                background: 'rgba(15, 23, 42, 0.6)', 
                padding: '16px', 
                borderRadius: '8px', 
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                minHeight: '170px'
              }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Weekly Subscription Quota</span>
                    <span className={getBadgeClass(agentQuota.weeklyQuota.state)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                      {agentQuota.weeklyQuota.state}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Window Type:</span>
                      <strong style={{ color: 'var(--text-secondary)' }}>Weekly Dynamic Tier</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Provider Cloud:</span>
                      <strong style={{ color: 'var(--text-secondary)' }}>Dynamic Rate-Limit</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Quota Status:</span>
                      <strong style={{ color: agentQuota.weeklyQuota.state === 'Available' ? 'var(--color-success)' : 'var(--text-muted)' }}>
                        {agentQuota.weeklyQuota.value || 'Server-Side Dynamic'}
                      </strong>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4, marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                  {agentQuota.weeklyQuota.note}
                </div>
              </div>

              {/* Task Execution Metrics */}
              <div style={{ 
                background: 'rgba(15, 23, 42, 0.6)', 
                padding: '16px', 
                borderRadius: '8px', 
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                minHeight: '170px'
              }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Task Execution Metrics</span>
                    <span className={getBadgeClass(agentQuota.taskMetrics.state)} style={{ fontSize: '11px', padding: '2px 8px' }}>
                      {agentQuota.taskMetrics.state}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Tasks Processed:</span>
                      <strong style={{ fontFamily: 'var(--font-mono)', color: '#fff' }}>{agentQuota.taskMetrics.tasksExecuted}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Compute Duration:</span>
                      <strong style={{ fontFamily: 'var(--font-mono)', color: '#fff' }}>{formatDuration(agentQuota.taskMetrics.totalComputeMs)}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Last Active:</span>
                      <strong style={{ color: 'var(--text-secondary)' }}>
                        {agentQuota.taskMetrics.lastActiveAt ? new Date(agentQuota.taskMetrics.lastActiveAt).toLocaleString() : 'Never'}
                      </strong>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4, marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '8px' }}>
                  Authoritative task execution recorded by EventBroker.
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
