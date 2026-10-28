import React, { useState } from 'react';
import { 
  Mail, 
  Send, 
  Search, 
  Filter, 
  Copy, 
  Check, 
  User, 
  Clock, 
  FileText,
  X
} from 'lucide-react';
import { MailboxMessage, SystemSnapshot } from '../types';
import { client } from '../api';

interface MailboxViewProps {
  snapshot: SystemSnapshot | null;
  onRefresh: () => void;
}

export const MailboxView: React.FC<MailboxViewProps> = ({ snapshot, onRefresh }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [senderFilter, setSenderFilter] = useState('all');
  const [selectedMessage, setSelectedMessage] = useState<MailboxMessage | null>(null);
  const [copied, setCopied] = useState(false);
  
  // Compose modal state
  const [showCompose, setShowCompose] = useState(false);
  const [composeAs, setComposeAs] = useState('H');
  const [composeTo, setComposeTo] = useState('Claude');
  const [composeBody, setComposeBody] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  if (!snapshot) return null;

  const messages = snapshot.mailbox?.messages || [];

  const filteredMessages = messages.filter((m) => {
    if (senderFilter !== 'all' && (m.party || '').toUpperCase() !== senderFilter.toUpperCase()) {
      return false;
    }
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const matchId = (m.id || '').toLowerCase().includes(s);
      const matchBody = (m.body || '').toLowerCase().includes(s);
      const matchSender = (m.sender || '').toLowerCase().includes(s);
      const matchTo = (m.recipientRaw || '').toLowerCase().includes(s);
      if (!matchId && !matchBody && !matchSender && !matchTo) return false;
    }
    return true;
  });

  const handlePost = async () => {
    if (!composeBody.trim()) {
      setPostError('Message body cannot be empty.');
      return;
    }
    setIsPosting(true);
    setPostError(null);
    try {
      await client.postMailboxMessage(composeAs, composeTo, composeBody);
      setShowCompose(false);
      setComposeBody('');
      onRefresh();
    } catch (err: any) {
      setPostError(err.message || 'Failed to post message.');
    } finally {
      setIsPosting(false);
    }
  };

  const copyMessage = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Extract a clean preview or subject from body
  const getSubjectPreview = (body: string) => {
    const lines = body.split('\n');
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed.startsWith('TASK:')) return trimmed.substring(5).trim();
      if (trimmed.startsWith('FINDINGS:')) return trimmed.substring(9).trim();
    }
    return lines[0]?.substring(0, 80) || 'Task Notification';
  };

  return (
    <div className="content-view">
      <div className="section-header">
        <div>
          <h2 className="section-title">
            <Mail size={20} />
            <span>Authoritative Team Mailbox</span>
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Reading directly from <code>{snapshot.mailbox.path || 'TEAM_MAILBOX.md'}</code> under mutex synchronization.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCompose(true)}>
          <Send size={14} />
          <span>Post Message</span>
        </button>
      </div>

      {/* Filters */}
      <div className="filter-bar">
        <input 
          type="text" 
          className="search-input" 
          placeholder="Search message text, ID, or keywords..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        <select className="select-filter" value={senderFilter} onChange={(e) => setSenderFilter(e.target.value)}>
          <option value="all">All Senders ({messages.length})</option>
          <option value="C">Claude (C)</option>
          <option value="X">Codex (X)</option>
          <option value="A">Antigravity (A)</option>
          <option value="H">Owner (H)</option>
        </select>
      </div>

      {/* Message Cards List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {filteredMessages.length === 0 ? (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: '8px' }}>
            No mailbox messages found matching the filter.
          </div>
        ) : (
          filteredMessages.slice().reverse().map((m) => {
            const preview = getSubjectPreview(m.body);
            return (
              <div 
                key={m.id} 
                className="metric-card" 
                style={{ cursor: 'pointer' }}
                onClick={() => setSelectedMessage(m)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span className="status-pill status-idle btn-sm" style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                      [{m.id}]
                    </span>
                    <strong style={{ fontSize: '14px', color: '#fff' }}>{m.sender} → {m.recipientRaw}</strong>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {m.timestamp}
                  </span>
                </div>

                <div style={{ fontSize: '13px', color: 'var(--accent-primary)', fontWeight: 600, marginBottom: '6px' }}>
                  {preview}
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', maxLines: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.body.replace(/\r?\n/g, ' ')}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Message Detail Modal */}
      {selectedMessage && (
        <div className="modal-backdrop" onClick={() => setSelectedMessage(null)}>
          <div className="modal-dialog" style={{ maxWidth: '700px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span className="status-pill status-idle btn-sm" style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  [{selectedMessage.id}]
                </span>
                <h3 style={{ fontSize: '15px' }}>{selectedMessage.sender} → {selectedMessage.recipientRaw}</h3>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setSelectedMessage(null)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Clock size={13} />
                <span>Timestamp: {selectedMessage.timestamp}</span>
              </div>

              <div className="form-label">Message Content</div>
              <div className="code-preview" style={{ maxHeight: '400px' }}>
                {`### [${selectedMessage.id}] ${selectedMessage.sender} -> ${selectedMessage.recipientRaw}, ${selectedMessage.timestamp}\n${selectedMessage.body}`}
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => copyMessage(selectedMessage.body)}>
                {copied ? <Check size={14} color="var(--color-success)" /> : <Copy size={14} />}
                <span>{copied ? 'Copied' : 'Copy Text'}</span>
              </button>
              <button className="btn btn-primary" onClick={() => setSelectedMessage(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compose Message Modal */}
      {showCompose && (
        <div className="modal-backdrop" onClick={() => setShowCompose(false)}>
          <div className="modal-dialog" style={{ maxWidth: '650px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ fontSize: '16px' }}>Post to Team Mailbox</h3>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowCompose(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="modal-body">
              {postError && (
                <div style={{ padding: '10px', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', borderRadius: '6px', fontSize: '12px', marginBottom: '14px' }}>
                  {postError}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '14px' }}>
                <div className="form-group">
                  <label className="form-label">Post As (Party)</label>
                  <select className="form-select" value={composeAs} onChange={(e) => setComposeAs(e.target.value)}>
                    <option value="H">Owner (H)</option>
                    <option value="C">Claude (C)</option>
                    <option value="X">Codex (X)</option>
                    <option value="A">Antigravity (A)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Target Recipient</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    placeholder="e.g. Claude, Codex, Antigravity, All" 
                    value={composeTo}
                    onChange={(e) => setComposeTo(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Message Body</label>
                <textarea 
                  className="form-textarea" 
                  rows={8}
                  placeholder={"TASK: Summary of work...\nSTATUS: IN_PROGRESS\nFINDINGS: Key details...\nNEXT ACTION: Actionable step..."}
                  value={composeBody}
                  onChange={(e) => setComposeBody(e.target.value)}
                />
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Note: Do not include the <code>### [id]</code> heading; the mutex post script appends it automatically.
                </span>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowCompose(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handlePost} disabled={isPosting}>
                <Send size={14} />
                <span>{isPosting ? 'Posting Under Mutex...' : 'Submit Message'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
