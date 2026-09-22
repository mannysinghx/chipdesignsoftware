'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { getUiAudit, trackExport, type UiAuditEvent } from '@/lib/ui-audit';
import { useUiAuditSnapshot } from '@/lib/ui-audit-react';

type PlatformEvent = {
  seq: number;
  event_id: string;
  ts: string;
  trace_id: string;
  span_id: string;
  parent_event_id: string | null;
  actor: { type: string; id: string; version: string | null; authenticated: boolean };
  source: string;
  feature: string;
  action: string;
  result: string;
  target: { type: string | null; id: string | null } | null;
  input_hash: string | null;
  output_hash: string | null;
  error: string | null;
  details: Record<string, unknown> | null;
  cost: Record<string, unknown> | null;
  evidence_class: string | null;
  policy_decision: unknown;
  redaction: unknown;
  client_ts: string | null;
  hash_version: number;
  prev_hash: string;
  hash: string;
};

type Summary = {
  total: number;
  by_result: Record<string, number>;
  by_feature: Record<string, number>;
  transport_features: string[];
  chain_head: { seq: number; hash: string; ts: string | null };
  last_verification: PlatformEvent | null;
  fallback_events: number;
};

type Coverage = {
  coverage_percent: number;
  required_actions: number;
  covered_actions: number;
  features: Array<{ id: string; kind: string; title: string; missing: string[] }>;
  undeclared: Array<{ feature: string; action: string; count: number }>;
};

type User = { user_id: string; email: string; display_name: string; role: string };
type Tab = 'platform' | 'local';
type LoadState = 'idle' | 'loading' | 'ready' | 'signed-out' | 'unreachable';

const FEATURE_GROUPS = [
  ['', 'All features'],
  ['ui.', 'UI (every interaction)'],
  ['auth.', 'Identity'],
  ['audit.', 'Audit log'],
  ['artifact.', 'Artifacts'],
  ['system.', 'System'],
  ['cli.', 'CLI'],
  ['api.', 'API plumbing'],
] as const;

async function api<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function short(hash: string | null | undefined, size = 10): string {
  return hash ? hash.slice(0, size) : '—';
}

function time(ts: string | null): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

function value(input: unknown): string {
  if (input === null || input === undefined) return '∅';
  if (typeof input === 'string') return input.length > 40 ? `${input.slice(0, 39)}…` : input;
  const text = JSON.stringify(input);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** One-line human description of an event, for the timeline. */
export function describeEvent(event: { feature: string; action: string; details: Record<string, unknown> | null; error?: string | null }): string {
  const details = event.details ?? {};
  const control = (details.control as { label?: string } | undefined)?.label;
  switch (`${event.feature}.${event.action}`) {
    case 'ui.interaction.click':
      return `Clicked “${control ?? 'control'}”`;
    case 'ui.interaction.change':
      return `Changed “${control ?? 'input'}” → ${details.redacted ? '[redacted]' : value(details.value)}`;
    case 'ui.interaction.submit':
      return `Submitted “${control ?? 'form'}”`;
    case 'ui.interaction.key':
      return `Pressed ${value(details.key)}`;
    case 'ui.interaction.camera':
      return `Moved the 3D camera (${value(details.gestures)} gesture${details.gestures === 1 ? '' : 's'})`;
    case 'ui.view.changed':
    case 'ui.state.changed':
      return `${String(details.key)}: ${value(details.from)} → ${value(details.to)}`;
    case 'ui.param.edited':
      return `${String(details.model)}.${String(details.key)}: ${value(details.from)} → ${value(details.to)}`;
    case 'ui.export.exported':
      return `Exported ${value(details.file)} (${value(details.bytes)} bytes)`;
    case 'ui.twin.part_selected':
      return `Selected ${value(details.part)}`;
    case 'ui.twin.part_cleared':
      return 'Cleared the 3D selection';
    case 'ui.sweep.started':
      return 'Started the analytical architecture sweep';
    case 'ui.sweep.completed':
      return `Sweep completed (${value(details.points)} design points)`;
    case 'ui.agent_replay.started':
    case 'ui.agent_replay.paused':
    case 'ui.agent_replay.reset':
    case 'ui.agent_replay.completed':
      return `Agent replay ${event.action} · ${value(details.mission)}`;
    case 'ui.error.error':
    case 'ui.error.unhandled_rejection':
      return `Browser ${event.action === 'error' ? 'error' : 'unhandled rejection'}: ${value(details.message)}`;
    case 'ui.session.ended':
      return `Closed ${value(details.path)}`;
    case 'ui.session.started':
      return `Opened ${value(details.path)}`;
    case 'auth.session.login':
      return 'Signed in';
    case 'auth.session.login_failed':
      return `Sign-in refused (${value(details.reason)})`;
    case 'auth.session.logout':
      return 'Signed out';
    default:
      if (event.action === 'http_request') return `${String(details.method)} ${String(details.route ?? details.path)} → ${String(details.status)}`;
      if (event.error) return event.error.split('\n').filter(Boolean).slice(-1)[0] ?? event.action;
      return event.action.replaceAll('_', ' ');
  }
}

export default function ActivityWorkspace() {
  const snapshot = useUiAuditSnapshot();
  const apiBase = snapshot?.apiBase ?? null;
  const [tab, setTab] = useState<Tab>('platform');
  const [state, setState] = useState<LoadState>('idle');
  const [user, setUser] = useState<User | null>(null);
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [featureFilter, setFeatureFilter] = useState('');
  const [resultFilter, setResultFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showTransport, setShowTransport] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [selected, setSelected] = useState<PlatformEvent | UiAuditEvent | null>(null);
  const [trace, setTrace] = useState<PlatformEvent[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeTab: Tab = apiBase ? tab : 'local';

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (featureFilter) params.set('feature', featureFilter);
    if (resultFilter) params.set('result', resultFilter);
    if (search.trim()) params.set('q', search.trim());
    if (!showTransport) params.set('hide_transport', 'true');
    return params.toString();
  }, [featureFilter, resultFilter, search, showTransport]);

  const load = useCallback(async () => {
    if (!apiBase) return;
    setState('loading');
    try {
      const me = await api<{ user: User }>(apiBase, '/api/auth/me');
      if (me.status !== 200 || !me.body) {
        setUser(null);
        setState('signed-out');
        return;
      }
      setUser(me.body.user);
      const [list, stats, cover] = await Promise.all([
        api<{ events: PlatformEvent[]; next_before_seq: number | null }>(apiBase, `/api/audit/events?${query}`),
        api<Summary>(apiBase, '/api/audit/summary'),
        api<Coverage>(apiBase, '/api/audit/coverage'),
      ]);
      setEvents(list.body?.events ?? []);
      setNextBefore(list.body?.next_before_seq ?? null);
      setSummary(stats.body);
      setCoverage(cover.body);
      setState('ready');
    } catch {
      setState('unreachable');
    }
  }, [apiBase, query]);

  useEffect(() => {
    if (activeTab !== 'platform') return;
    // Debounced: typing in the search box changes `load` on every keystroke.
    const first = window.setTimeout(() => void load(), 250);
    if (!autoRefresh) return () => window.clearTimeout(first);
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [activeTab, autoRefresh, load]);

  const loadOlder = async () => {
    if (!apiBase || nextBefore === null) return;
    const older = await api<{ events: PlatformEvent[]; next_before_seq: number | null }>(apiBase, `/api/audit/events?${query}&before_seq=${nextBefore}`);
    setEvents((current) => [...current, ...(older.body?.events ?? [])]);
    setNextBefore(older.body?.next_before_seq ?? null);
  };

  const openEvent = async (event: PlatformEvent | UiAuditEvent) => {
    setSelected(event);
    setTrace([]);
    if (!apiBase || !('seq' in event)) return;
    const result = await api<{ events: PlatformEvent[] }>(apiBase, `/api/audit/traces/${event.trace_id}`);
    setTrace(result.body?.events ?? []);
  };

  const signIn = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (!apiBase) return;
    const data = new FormData(form.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ user: User; detail?: string }>(apiBase, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
      });
      if (result.status === 200) {
        await getUiAudit()?.retryNow();
        await load();
      } else {
        setMessage(result.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Invalid email or password.');
      }
    } catch {
      setMessage('The platform API is unreachable.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!apiBase) return;
    await api(apiBase, '/api/auth/logout', { method: 'POST' });
    setUser(null);
    setEvents([]);
    setState('signed-out');
  };

  const verifyChain = async () => {
    if (!apiBase) return;
    setBusy(true);
    try {
      const result = await api<{ ok: boolean; rows: number; head_seq: number; failures: Array<{ seq: number; reason: string }> }>(apiBase, '/api/audit/verify', { method: 'POST' });
      if (result.status === 403) setMessage('Chain verification requires the admin role.');
      else if (result.body) setMessage(result.body.ok ? `Chain verified: ${result.body.rows.toLocaleString()} events, head #${result.body.head_seq}, anchored.` : `Chain BROKEN at #${result.body.failures[0]?.seq} (${result.body.failures[0]?.reason}).`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const downloadEvents = () => {
    const rows = activeTab === 'platform' ? events : snapshot?.events ?? [];
    const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = activeTab === 'platform' ? 'aimem-audit-events.jsonl' : 'aimem-ui-events-this-page.jsonl';
    anchor.click();
    URL.revokeObjectURL(url);
    trackExport(anchor.download, text, { view: 'activity', tab: activeTab, rows: rows.length });
  };

  const hiddenTransport = summary && !showTransport ? summary.transport_features.reduce((sum, feature) => sum + (summary.by_feature[feature] ?? 0), 0) : 0;
  const localEvents = (snapshot?.events ?? []).filter((event) => (!featureFilter || event.feature.startsWith(featureFilter)) && (!resultFilter || event.result === resultFilter) && (!search.trim() || JSON.stringify(event).toLowerCase().includes(search.trim().toLowerCase())));
  const lastVerification = summary?.last_verification;

  return (
    <section className="activity-shell" data-audit-area="Activity">
      <div className="activity-head">
        <div>
          <p className="eyebrow accent">Audit backbone · Phase 0</p>
          <h2>Activity log</h2>
          <p>Every action in the platform (each click, edit, sign-in, API request, CLI command, and migration) is written to an append-only, hash-chained audit log. Nothing here can be edited or deleted; tampering breaks the chain.</p>
        </div>
        <div className="activity-pills">
          <span className={`activity-pill ${snapshot?.mode ?? 'local-only'}`}>{snapshot ? (snapshot.mode === 'local-only' ? 'Local only · no platform API' : snapshot.mode === 'connected' ? 'Connected' : snapshot.mode === 'unauthorized' ? 'Sign-in required' : 'API unreachable') : 'Starting'}</span>
          {summary && <span className="activity-pill neutral">Head #{summary.chain_head.seq.toLocaleString()} · {short(summary.chain_head.hash)}</span>}
          {coverage && <span className={`activity-pill ${coverage.coverage_percent === 100 ? 'connected' : 'offline'}`}>Coverage {coverage.coverage_percent}%</span>}
        </div>
      </div>

      <div className="activity-grid">
        <aside className="activity-side">
          <section className="activity-card">
            <h3>Session</h3>
            {!apiBase ? (
              <p className="activity-note">This page has no platform API configured, so events are kept in this browser tab only (see “This page”). Run the platform API locally, or set NEXT_PUBLIC_AIMEM_PLATFORM_API, to persist them.</p>
            ) : user ? (
              <div className="activity-user">
                <strong>{user.display_name}</strong>
                <span>{user.email}</span>
                <small className="activity-role">{user.role}</small>
                <button className="ghost-button" onClick={() => void signOut()}>Sign out</button>
              </div>
            ) : (
              <form className="activity-login" onSubmit={(event) => void signIn(event)} data-audit-area="Sign in">
                <label>Email<input name="email" type="email" autoComplete="username" required /></label>
                <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
                <button className="primary-button wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
                <p className="activity-note">Accounts are created by an admin: <code>aimem-platform create-user</code>.</p>
              </form>
            )}
            {message && <p className="activity-message" role="status">{message}</p>}
          </section>

          <section className="activity-card">
            <h3>Chain integrity</h3>
            {summary ? (
              <>
                <dl className="activity-facts">
                  <div><dt>Events</dt><dd>{summary.total.toLocaleString()}</dd></div>
                  <div><dt>Head</dt><dd>#{summary.chain_head.seq} · {short(summary.chain_head.hash, 12)}</dd></div>
                  <div><dt>Last check</dt><dd className={lastVerification ? (lastVerification.action === 'verified' ? 'good' : 'bad') : ''}>{lastVerification ? `${lastVerification.action === 'verified' ? 'Intact' : 'BROKEN'} · ${time(lastVerification.ts)}` : 'Never verified'}</dd></div>
                  <div><dt>Fallback log</dt><dd className={summary.fallback_events ? 'bad' : 'good'}>{summary.fallback_events ? `${summary.fallback_events} unsynced` : 'Empty'}</dd></div>
                </dl>
                <button className="ghost-button" onClick={() => void verifyChain()} disabled={busy || user?.role !== 'admin'} title={user?.role === 'admin' ? 'Recompute every hash and anchor the head' : 'Requires the admin role'}>Verify chain</button>
              </>
            ) : (
              <p className="activity-note">Sign in to see the chain head and run verification.</p>
            )}
          </section>

          <section className="activity-card">
            <h3>Feature coverage</h3>
            {coverage ? (
              <>
                <div className="activity-meter"><i style={{ width: `${coverage.coverage_percent}%` }} /></div>
                <p className="activity-note">{coverage.covered_actions}/{coverage.required_actions} required actions observed in the log. {coverage.undeclared.length ? `${coverage.undeclared.length} undeclared.` : 'No undeclared actions.'}</p>
                <ul className="activity-missing">
                  {coverage.features.filter((item) => item.missing.length).slice(0, 8).map((item) => <li key={item.id}><code>{item.id}</code> {item.missing.join(', ')}</li>)}
                </ul>
              </>
            ) : (
              <p className="activity-note">Coverage compares the log with every feature in features.yaml.</p>
            )}
          </section>

          <section className="activity-card">
            <h3>This page</h3>
            {snapshot && (
              <dl className="activity-facts">
                <div><dt>Recorded</dt><dd>{snapshot.counts.recorded}</dd></div>
                <div><dt>Delivered</dt><dd>{snapshot.counts.sent}</dd></div>
                <div><dt>Queued</dt><dd>{snapshot.counts.queued}</dd></div>
                <div><dt>Rejected</dt><dd className={snapshot.counts.rejected ? 'bad' : ''}>{snapshot.counts.rejected}</dd></div>
                <div><dt>Session</dt><dd>{snapshot.sessionId.slice(0, 8)}</dd></div>
              </dl>
            )}
            {snapshot?.lastError && <p className="activity-message">{snapshot.lastError}</p>}
          </section>
        </aside>

        <div className="activity-main">
          <div className="activity-toolbar">
            <div className="activity-tabs" role="tablist" aria-label="Event source">
              <button role="tab" aria-selected={activeTab === 'platform'} className={activeTab === 'platform' ? 'active' : ''} disabled={!apiBase} onClick={() => setTab('platform')}>Platform log</button>
              <button role="tab" aria-selected={activeTab === 'local'} className={activeTab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>This page ({snapshot?.events.length ?? 0})</button>
            </div>
            <select aria-label="Feature group" value={featureFilter} onChange={(event) => setFeatureFilter(event.target.value)}>
              {FEATURE_GROUPS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <select aria-label="Result" value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}>
              <option value="">Any result</option>
              <option value="ok">ok</option>
              <option value="error">error</option>
              <option value="denied">denied</option>
              <option value="pending">pending</option>
            </select>
            <input aria-label="Search events" type="search" placeholder="Search details, errors, actors…" defaultValue={search} onChange={(event) => setSearch(event.target.value)} />
            {activeTab === 'platform' && (
              <>
                <label className="activity-check"><input type="checkbox" checked={showTransport} onChange={(event) => setShowTransport(event.target.checked)} /> Reads &amp; transport{hiddenTransport ? ` (${hiddenTransport.toLocaleString()} hidden)` : ''}</label>
                <label className="activity-check"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> Auto-refresh</label>
                <button className="ghost-button" onClick={() => void load()}>Refresh</button>
              </>
            )}
            <button className="ghost-button" onClick={downloadEvents}>Download JSONL</button>
          </div>

          {activeTab === 'platform' && state === 'signed-out' && <div className="activity-empty">Sign in to read the platform audit log. Your actions on this page are still being recorded and will be delivered.</div>}
          {activeTab === 'platform' && state === 'unreachable' && <div className="activity-empty">The platform API at {apiBase} is unreachable. Start it with <code>npm run platform:dev</code>; events are queued in this page meanwhile.</div>}

          <div className="activity-table">
            <div className="activity-row head" aria-hidden="true"><span>#</span><span>Time</span><span>{activeTab === 'platform' ? 'Actor' : 'Delivery'}</span><span>Feature · action</span><span>Result</span><span>What happened</span></div>
            <ol aria-label="Audit events">
              {activeTab === 'platform'
                ? events.map((event) => (
                    <li key={event.event_id}>
                      <button className={`activity-row${selected && 'seq' in selected && selected.event_id === event.event_id ? ' selected' : ''}`} onClick={() => void openEvent(event)}>
                        <span>{event.seq}</span>
                        <span>{time(event.ts)}</span>
                        <span title={event.actor.id}>{event.actor.id}</span>
                        <span><b>{event.feature}</b>.{event.action}</span>
                        <span className={`activity-result ${event.result}`}>{event.result}</span>
                        <span>{describeEvent(event)}</span>
                      </button>
                    </li>
                  ))
                : localEvents.map((event, index) => (
                    <li key={event.event_id}>
                      <button className={`activity-row${selected && !('seq' in selected) && selected.event_id === event.event_id ? ' selected' : ''}`} onClick={() => void openEvent(event)}>
                        <span>{localEvents.length - index}</span>
                        <span>{time(event.client_ts)}</span>
                        <span>{event.status}</span>
                        <span><b>{event.feature}</b>.{event.action}</span>
                        <span className={`activity-result ${event.result}`}>{event.result}</span>
                        <span>{describeEvent(event)}{event.reason ? ` · rejected: ${event.reason}` : ''}</span>
                      </button>
                    </li>
                  ))}
            </ol>
            {activeTab === 'platform' && nextBefore !== null && <button className="ghost-button activity-more" onClick={() => void loadOlder()}>Load older events</button>}
          </div>

          {selected && (
            <section className="activity-detail" aria-label="Event detail">
              <div className="activity-detail-head">
                <h3>{selected.feature}.{selected.action}</h3>
                <button className="ghost-button" onClick={() => setSelected(null)} aria-label="Close event detail">Close</button>
              </div>
              {'seq' in selected && (
                <dl className="activity-facts wide">
                  <div><dt>Seq</dt><dd>{selected.seq}</dd></div>
                  <div><dt>Actor</dt><dd>{selected.actor.type}: {selected.actor.id}{selected.actor.version ? ` (${selected.actor.version})` : ''}</dd></div>
                  <div><dt>Source</dt><dd>{selected.source}</dd></div>
                  <div><dt>Trace</dt><dd><code>{selected.trace_id}</code></dd></div>
                  <div><dt>Hash</dt><dd><code>{selected.hash}</code></dd></div>
                  <div><dt>Prev hash</dt><dd><code>{selected.prev_hash}</code></dd></div>
                </dl>
              )}
              {'seq' in selected && trace.length > 1 && (
                <div className="activity-trace">
                  <h4>Trace ({trace.length} events)</h4>
                  <ol>
                    {trace.map((item) => (
                      <li key={item.event_id} className={item.event_id === selected.event_id ? 'current' : ''} style={{ marginLeft: item.parent_event_id ? 14 : 0 }}>
                        <code>#{item.seq}</code> <b>{item.feature}</b>.{item.action} <span className={`activity-result ${item.result}`}>{item.result}</span> <small>{item.actor.id}</small>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {selected.error && <pre className="activity-error">{selected.error}</pre>}
              <pre className="activity-json">{JSON.stringify(selected, null, 2)}</pre>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
