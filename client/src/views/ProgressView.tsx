import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, MessageSquare, AlertCircle, FileText } from 'lucide-react';
import { ProgressData, TaskBucket } from '../types';
import { client } from '../api';

const BUCKETS: TaskBucket[] = ['done', 'built', 'doing', 'blocked', 'todo', 'other'];
const BUCKET_LABEL: Record<TaskBucket, string> = {
  done: 'Done',
  built: 'Built / partial',
  doing: 'Doing',
  blocked: 'Blocked',
  todo: 'Todo',
  other: 'Other'
};

/** "2026-10-30 14:45" (local time written by the mailbox script) -> "3h ago" */
function ago(stamp?: string | null): string {
  if (!stamp) return 'never';
  const t = Date.parse(stamp.replace(' ', 'T'));
  if (isNaN(t)) return stamp;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

const ProgressBar: React.FC<{ percent: number | null }> = ({ percent }) => {
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const tone = p >= 80 ? 'var(--color-success)' : p >= 40 ? 'var(--accent-primary)' : 'var(--color-warning)';
  return (
    <div className="pv-bar" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
      <div className="pv-bar-fill" style={{ width: `${p}%`, background: tone }} />
    </div>
  );
};

export const ProgressView: React.FC = () => {
  const [data, setData] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | TaskBucket>('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await client.fetchProgress());
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load progress');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    // New mailbox/task events change the conversation and doc state; reload on them (throttled by the browser)
    let pending: any = null;
    const unsubscribe = client.subscribe(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; load(); }, 1500);
    });
    return () => {
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      unsubscribe();
    };
  }, [load]);

  const owners = useMemo(() => {
    const set = new Set<string>();
    data?.sections.forEach(s => s.tasks.forEach(t => t.owner && set.add(t.owner)));
    return Array.from(set).sort();
  }, [data]);

  const q = query.trim().toLowerCase();
  const filteredSections = useMemo(() => {
    if (!data) return [];
    return data.sections
      .map(s => ({
        ...s,
        tasks: s.tasks.filter(t =>
          (statusFilter === 'all' || t.status === statusFilter) &&
          (ownerFilter === 'all' || t.owner === ownerFilter) &&
          (!q || `${t.id} ${t.title} ${t.statusText}`.toLowerCase().includes(q))
        )
      }))
      .filter(s => s.tasks.length > 0);
  }, [data, statusFilter, ownerFilter, q]);

  if (!data) {
    return (
      <div className="view-container">
        <div className="section-header"><h2 className="section-title">Project Progress</h2></div>
        <div className="pv-card">{error ? <span style={{ color: 'var(--color-danger)' }}>{error}</span> : 'Loading progress…'}</div>
      </div>
    );
  }

  const doneCount = data.counts.done;
  const filtersActive = statusFilter !== 'all' || ownerFilter !== 'all' || q !== '';

  return (
    <div className="view-container">
      <div className="section-header">
        <h2 className="section-title">Project Progress</h2>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          <RefreshCw size={13} /> <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </div>

      {error && <div className="pv-card pv-warn">Showing last data. {error}</div>}
      {!data.docsAvailable && <div className="pv-card pv-warn">The project docs folder could not be read.</div>}

      {/* Overall */}
      <div className="pv-card">
        <div className="pv-whole">
          <div>
            <div className="metric-title">Whole project</div>
            <div className="pv-big">{data.whole ? data.whole.percentText : `${doneCount}/${data.totalTasks}`}</div>
          </div>
          <div className="pv-whole-meta">
            <div>{data.whole ? `${data.whole.done} of ${data.whole.rows} rows done` : `${doneCount} of ${data.totalTasks} tasks done`}</div>
            <div className="pv-muted">TASKS.md dashboard updated {data.tasksUpdated || 'unknown'}</div>
          </div>
        </div>
        <ProgressBar percent={data.whole ? data.whole.percent : null} />
        {data.whole && <p className="pv-note">{data.whole.state}</p>}
      </div>

      {/* Counts */}
      <div className="pv-chips">
        {BUCKETS.map(b => (
          <button
            key={b}
            className={`pv-chip pv-${b} ${statusFilter === b ? 'pv-chip-active' : ''}`}
            onClick={() => setStatusFilter(statusFilter === b ? 'all' : b)}
            title="Filter the task list"
          >
            <strong>{data.counts[b]}</strong> {BUCKET_LABEL[b]}
          </button>
        ))}
      </div>

      {/* Per area */}
      <div className="section-header"><h2 className="section-title">Gates and areas</h2></div>
      <div className="pv-areas">
        {data.areas.map(a => (
          <div className="pv-card" key={a.area}>
            <div className="pv-area-head">
              <strong>{a.area}</strong>
              <span className="pv-muted">{a.done}/{a.rows} · {a.percentText}</span>
            </div>
            <ProgressBar percent={a.percent} />
            <p className="pv-note">{a.state}</p>
          </div>
        ))}
      </div>

      {/* Remaining */}
      {data.remaining.length > 0 && (
        <>
          <div className="section-header"><h2 className="section-title">Remaining work, in order</h2></div>
          <ol className="pv-card pv-remaining">
            {data.remaining.map((r, i) => <li key={i}>{r}</li>)}
          </ol>
        </>
      )}

      {/* Latest conversation */}
      <div className="section-header">
        <h2 className="section-title"><MessageSquare size={16} /> AI conversation</h2>
        <span className="pv-muted">{data.conversation.total} messages in the mailbox</span>
      </div>
      <div className="pv-chips">
        {Object.entries(data.conversation.lastBySender).map(([sender, info]) => (
          <span className="pv-chip" key={sender}><strong>{sender}</strong> last posted {ago(info.timestamp)} ({info.id})</span>
        ))}
      </div>
      <div className="pv-convo">
        {data.conversation.recent.map(m => (
          <div className="pv-card pv-msg" key={m.id}>
            <div className="pv-msg-head">
              <span className="mono-cell">{m.id}</span>
              <strong>{m.sender}</strong> <span className="pv-muted">→ {m.recipient}</span>
              <span className="pv-muted pv-msg-time">{m.timestamp} · {ago(m.timestamp)}</span>
            </div>
            <div>{m.task || <em className="pv-muted">(no task line)</em>}</div>
            {m.status && <div className="pv-muted"><strong>Status:</strong> {m.status}</div>}
            {m.nextAction && <div className="pv-muted"><strong>Next:</strong> {m.nextAction}</div>}
          </div>
        ))}
      </div>

      {/* Tasks */}
      <div className="section-header">
        <h2 className="section-title">Tasks by gate</h2>
        <span className="pv-muted">{data.totalTasks} tasks</span>
      </div>
      <div className="filter-bar">
        <input className="search-input" placeholder="Search id, title, status…" value={query} onChange={e => setQuery(e.target.value)} />
        <select className="select-filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}>
          <option value="all">All statuses</option>
          {BUCKETS.map(b => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
        </select>
        <select className="select-filter" value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}>
          <option value="all">All owners</option>
          {owners.map(o => <option key={o} value={o}>{o.length > 28 ? o.slice(0, 27) + '…' : o}</option>)}
        </select>
      </div>
      {filteredSections.length === 0 && <div className="pv-card pv-muted">No tasks match the filters.</div>}
      {filteredSections.map(s => (
        <details className="pv-card pv-section" key={s.name} open={filtersActive || undefined}>
          <summary>
            <strong>{s.name}</strong>
            <span className="pv-muted"> · {s.counts.done} done, {s.counts.built} built, {s.counts.doing} doing, {s.counts.blocked} blocked, {s.counts.todo} todo</span>
          </summary>
          <div className="pv-tasks">
            {s.tasks.map(t => (
              <div className="pv-task" key={s.name + t.id}>
                <div className="pv-task-head">
                  <span className="mono-cell">{t.id}</span>
                  <span className={`pv-tag pv-${t.status}`}>{BUCKET_LABEL[t.status]}</span>
                  {t.owner && <span className="pv-muted">{t.owner}</span>}
                </div>
                <div>{t.title}</div>
                {t.statusText && <div className="pv-muted">{t.statusText}</div>}
              </div>
            ))}
          </div>
        </details>
      ))}

      {/* Issues + state + docs */}
      <div className="section-header">
        <h2 className="section-title"><AlertCircle size={16} /> Known issues</h2>
        <span className="pv-muted">{data.knownIssues.open} open · {data.knownIssues.closed} closed</span>
      </div>
      <div className="pv-card">
        {data.knownIssues.recentOpen.map(k => (
          <div className="pv-task" key={k.id}>
            <div className="pv-task-head"><span className="mono-cell">{k.id}</span><span className="pv-muted">{k.area}</span></div>
            <div>{k.text}</div>
          </div>
        ))}
        {data.knownIssues.recentOpen.length === 0 && <span className="pv-muted">None found.</span>}
      </div>

      {data.state.bullets.length > 0 && (
        <>
          <div className="section-header"><h2 className="section-title">{data.state.heading || 'Current state'}</h2></div>
          <ul className="pv-card pv-state">
            {data.state.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </>
      )}

      <div className="section-header"><h2 className="section-title"><FileText size={16} /> Doc freshness</h2></div>
      <div className="pv-card pv-docs">
        {data.docs.map(d => (
          <div className="pv-doc" key={d.name}>
            <span className="mono-cell">{d.name}</span>
            <span className="pv-muted">{d.exists ? `${ago(d.mtime ? d.mtime.replace('T', ' ').slice(0, 16) + 'Z' : null)}` : 'missing'}</span>
          </div>
        ))}
      </div>
      <p className="pv-muted" style={{ marginTop: 12 }}>Read-only view generated {new Date(data.generatedAt).toLocaleTimeString()} from the markdown docs; nothing here edits them.</p>
    </div>
  );
};

export default ProgressView;
