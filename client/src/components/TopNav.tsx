import React, { useState } from 'react';
import { Radio, Clock, Globe, Mail, Send, X, AlertCircle, CheckCircle } from 'lucide-react';
import { SystemSnapshot } from '../types';
import { client } from '../api';

interface TopNavProps {
  snapshot: SystemSnapshot | null;
  wsConnected: boolean;
  onRefresh: () => void;
}

export const TopNav: React.FC<TopNavProps> = ({ snapshot, wsConnected, onRefresh }) => {
  const isBrokerUp = snapshot?.broker.status === 'UP';

  const [modalOpen, setModalOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [urgency, setUrgency] = useState('DECISION_NEEDED');
  const [taskReference, setTaskReference] = useState('');
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const formatLastUpdate = (iso?: string) => {
    if (!iso) return 'Waiting...';
    return new Date(iso).toLocaleTimeString();
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) {
      setStatusMessage({ type: 'error', text: 'Subject and message are required.' });
      return;
    }

    setSending(true);
    setStatusMessage(null);

    try {
      const res = await client.notifyOwner({
        subject: subject.trim(),
        message: message.trim(),
        urgency,
        taskReference: taskReference.trim() || undefined,
        senderAgent: 'Control Center Operator'
      });

      if (res.result?.status === 'sent') {
        setStatusMessage({ type: 'success', text: `Email delivered to owner! (ID: ${res.result.messageId || 'sent'})` });
        setTimeout(() => {
          setSubject('');
          setMessage('');
          setTaskReference('');
          setModalOpen(false);
          setStatusMessage(null);
        }, 2200);
      } else {
        setStatusMessage({ type: 'error', text: res.result?.reason || 'Failed to send email.' });
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Notification error.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <header className="top-nav">
        <div className="top-left">
          <div className={`status-pill ${isBrokerUp ? 'status-up' : 'status-stopped'}`}>
            <span className="status-dot"></span>
            <span>{isBrokerUp ? 'BROKER ONLINE' : 'BROKER OFFLINE'}</span>
          </div>

          <div className={`status-pill ${wsConnected ? 'status-online' : 'status-offline'}`}>
            <Radio size={14} />
            <span>{wsConnected ? 'LIVE' : 'RECONNECTING'}</span>
          </div>

          {snapshot?.zrok?.status === 'CONNECTED' && (
            <div className="status-pill status-online" title="Reachable through the public tunnel (token required)">
              <Globe size={13} />
              <span>Remote on</span>
            </div>
          )}

          <div className="top-updated">
            <Clock size={13} />
            <span>Updated: {formatLastUpdate(snapshot?.timestamp)}</span>
          </div>
        </div>

        <div className="top-right" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            className="btn btn-secondary btn-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            onClick={() => { setModalOpen(true); setStatusMessage(null); }}
            title="Send transactional email notification to Owner via Brevo"
          >
            <Mail size={13} color="var(--accent-primary)" />
            <span>Notify Owner</span>
          </button>
        </div>
      </header>

      {/* Notify Owner Modal Dialog */}
      {modalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(5, 9, 20, 0.75)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '16px'
        }}>
          <div className="metric-card" style={{
            width: '100%',
            maxWidth: '540px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '12px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            padding: '24px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  background: 'var(--accent-glow)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <Mail size={16} color="var(--accent-primary)" />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#fff' }}>Notify Human Owner</h3>
                  <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>
                    Dispatches transactional email directly via Brevo API
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSend} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {statusMessage && (
                <div style={{
                  padding: '10px 14px',
                  borderRadius: '6px',
                  fontSize: '12.5px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: statusMessage.type === 'success' ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
                  color: statusMessage.type === 'success' ? 'var(--color-success)' : 'var(--color-danger)',
                  border: `1px solid ${statusMessage.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
                }}>
                  {statusMessage.type === 'success' ? <CheckCircle size={15} /> : <AlertCircle size={15} />}
                  <span>{statusMessage.text}</span>
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Urgency Level
                </label>
                <select
                  value={urgency}
                  onChange={(e) => setUrgency(e.target.value)}
                  className="select-filter"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: '#fff' }}
                >
                  <option value="DECISION_NEEDED">Decision Needed (Amber)</option>
                  <option value="URGENT_BLOCKER">Urgent Blocker (Red Alert)</option>
                  <option value="MILESTONE_REACHED">Milestone Reached (Green)</option>
                  <option value="REVIEW_REQUESTED">Review Requested (Indigo)</option>
                  <option value="GENERAL_UPDATE">General Update (Slate)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Subject
                </label>
                <input
                  type="text"
                  placeholder="e.g. Decision Needed: Boss Arena Lighting Optimization"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="search-input"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: '#fff' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Task Reference (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. X-280 or DECISION-2026-10-31"
                  value={taskReference}
                  onChange={(e) => setTaskReference(e.target.value)}
                  className="search-input"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: '#fff' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Message Content
                </label>
                <textarea
                  rows={4}
                  placeholder="Describe the blocker, decision alternatives, or summary for the human owner..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '6px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    color: '#fff',
                    fontFamily: 'inherit',
                    fontSize: '13px',
                    resize: 'vertical'
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setModalOpen(false)}
                  disabled={sending}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={sending}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <Send size={13} />
                  <span>{sending ? 'Sending...' : 'Send Notification'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
