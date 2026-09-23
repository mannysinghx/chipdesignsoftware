'use client';

import { useCallback, useEffect, useState } from 'react';
import { track } from '@/lib/ui-audit';
import { useUiAuditSnapshot } from '@/lib/ui-audit-react';
import { artifactUrl, platformFetch, type EvidenceItem, type PlatformRun } from '@/lib/platform-api';

type Reconstruction = { consistent: boolean; checks: Record<string, boolean>; reconstructed: { problems: string[]; events: Array<{ seq: number; action: string; result: string }> } };
type User = { email: string; role: string; display_name: string };

const RUNNING = new Set(['queued', 'running']);

function short(hash: string | null | undefined, size = 12): string {
  return hash ? hash.slice(0, size) : '—';
}

function when(ts: string | null): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function duration(run: PlatformRun): string {
  const ms = run.summary?.execution?.wall_ms;
  if (typeof ms === 'number') return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  if (run.started_at && !run.finished_at) return 'running…';
  return '—';
}

function verdictClass(run: PlatformRun | null): string {
  if (!run) return 'none';
  if (RUNNING.has(run.status)) return 'running';
  return run.verdict === 'pass' ? 'pass' : run.verdict === 'fail' ? 'fail' : 'error';
}

function keyMetrics(run: PlatformRun): Array<[string, string]> {
  const metrics = (run.summary?.metrics ?? {}) as Record<string, unknown>;
  switch (run.adapter) {
    case 'rtl.lint':
      return [['Errors', String(metrics.errors ?? '—')], ['Warnings', String(metrics.warnings ?? '—')]];
    case 'rtl.sim':
      return [['Passed', `${metrics.passed ?? '—'}/${metrics.total ?? '—'}`], ['Seed', String(metrics.seed ?? '—')]];
    case 'formal.sby': {
      const tasks = (metrics.tasks ?? {}) as Record<string, string>;
      const passing = Object.values(tasks).filter((status) => status === 'PASS').length;
      return [['Tasks passing', `${passing}/${Object.keys(tasks).length}`], ['Failing', ((metrics.failing as string[]) ?? []).join(', ') || 'none']];
    }
    case 'physical.orfs':
      return [
        ['DRC', String(metrics.drc_violations ?? '—')],
        ['LVS', String(metrics.lvs ?? '—')],
        ['fmax', metrics.fmax_mhz ? `${metrics.fmax_mhz} MHz` : '—'],
        ['WNS @ contract', metrics.setup_wns_ns !== undefined ? `${metrics.setup_wns_ns} ns` : '—'],
        ['Cells', String(metrics.stdcell_count ?? '—')],
      ];
    case 'platform.selftest': {
      const checks = (metrics.checks ?? {}) as Record<string, unknown>;
      return [['Network', String(checks.network_ip ?? '—')], ['Root FS', String(checks.root_filesystem ?? '—')], ['UID', String(checks.uid ?? '—')]];
    }
    default:
      return [];
  }
}

export default function RunsWorkspace() {
  const snapshot = useUiAuditSnapshot();
  const apiBase = snapshot?.apiBase ?? null;
  const [user, setUser] = useState<User | null>(null);
  const [state, setState] = useState<'idle' | 'ready' | 'signed-out' | 'unreachable'>('idle');
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [runs, setRuns] = useState<PlatformRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlatformRun | null>(null);
  const [log, setLog] = useState('');
  const [logOffset, setLogOffset] = useState(0);
  const [reconstruction, setReconstruction] = useState<Reconstruction | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!apiBase) return;
    try {
      const me = await platformFetch<{ user: User }>('/api/auth/me');
      if (me.status !== 200 || !me.body) {
        setUser(null);
        setState('signed-out');
        return;
      }
      setUser(me.body.user);
      const [items, list] = await Promise.all([
        platformFetch<{ evidence: EvidenceItem[] }>('/api/evidence'),
        platformFetch<{ runs: PlatformRun[] }>('/api/runs?limit=50'),
      ]);
      setEvidence(items.body?.evidence ?? []);
      setRuns(list.body?.runs ?? []);
      setState('ready');
    } catch {
      setState('unreachable');
    }
  }, [apiBase]);

  const anyActive = runs.some((run) => RUNNING.has(run.status));
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), anyActive ? 4000 : 20000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load, anyActive]);

  // Run detail and live log tail for the selected run.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let offset = 0;
    let buffer = '';
    const poll = async () => {
      const [run, chunk] = await Promise.all([
        platformFetch<{ run: PlatformRun }>(`/api/runs/${selectedId}`),
        platformFetch<{ text: string; next_offset: number; complete: boolean }>(`/api/runs/${selectedId}/log?offset=${offset}`),
      ]);
      if (cancelled) return;
      if (run.body) setDetail(run.body.run);
      if (chunk.body) {
        buffer = (buffer + chunk.body.text).slice(-200_000);
        offset = chunk.body.next_offset;
        setLog(buffer);
        setLogOffset(offset);
        if (!chunk.body.complete) timer = window.setTimeout(() => void poll(), 2000);
      }
    };
    let timer = window.setTimeout(() => void poll(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedId]);

  const selectRun = (runId: string) => {
    setSelectedId(runId);
    setDetail(null);
    setLog('');
    setLogOffset(0);
    setReconstruction(null);
  };

  const startRun = async (adapterId: string) => {
    setMessage(null);
    const result = await platformFetch<{ run: PlatformRun; detail?: string }>('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter: adapterId, params: {} }),
    });
    if (result.status === 201 && result.body) {
      track('ui.state', 'changed', { key: 'runs.submitted', from: null, to: result.body.run.run_id });
      selectRun(result.body.run.run_id);
      await load();
    } else {
      setMessage(result.status === 403 ? 'Starting runs requires the engineer role.' : `Could not start the run (${result.status}).`);
    }
  };

  const cancel = async (runId: string) => {
    const result = await platformFetch<{ run: PlatformRun }>(`/api/runs/${runId}/cancel`, { method: 'POST' });
    setMessage(result.status === 200 ? 'Cancellation requested.' : `Could not cancel (${result.status}).`);
    await load();
  };

  const reconstruct = async (runId: string) => {
    const result = await platformFetch<Reconstruction>(`/api/runs/${runId}/reconstruction`);
    setReconstruction(result.body);
  };

  const canRun = user && ['engineer', 'approver', 'admin'].includes(user.role);
  const outputs = detail?.files?.filter((file) => file.role === 'output') ?? [];
  const images = outputs.filter((file) => /\.(png|webp)$/i.test(file.path));
  const execution = (detail?.spec?.execution ?? {}) as Record<string, unknown>;

  return (
    <section className="runs-shell" data-audit-area="Runs">
      <div className="activity-head">
        <div>
          <p className="eyebrow accent">Real tool execution · Phase 1</p>
          <h2>Tool runs</h2>
          <p>Each run executes pinned tools in a sandbox with no network, a read-only root filesystem, and no Linux capabilities. Inputs and outputs are content-addressed, and every run can be rebuilt from the audit log alone.</p>
        </div>
        <div className="activity-pills">
          <span className={`activity-pill ${apiBase ? (state === 'ready' ? 'connected' : state === 'unreachable' ? 'offline' : 'unauthorized') : 'local-only'}`}>
            {!apiBase ? 'No platform API' : state === 'ready' ? `Signed in · ${user?.role}` : state === 'unreachable' ? 'API unreachable' : state === 'signed-out' ? 'Sign in on the Activity tab' : 'Connecting'}
          </span>
        </div>
      </div>

      {!apiBase && <div className="activity-empty">Runs need the platform API and a worker. Locally: <code>npm run platform:dev</code> and <code>npm run platform:worker</code>.</div>}
      {apiBase && state === 'signed-out' && <div className="activity-empty">Sign in on the Activity tab to see and start runs.</div>}
      {message && <p className="activity-message" role="status">{message}</p>}

      <div className="runs-evidence">
        {evidence.map((item) => {
          const run = item.active ?? item.latest;
          return (
            <article key={item.adapter.id} className={`runs-card ${verdictClass(run)}`}>
              <header>
                <div>
                  <small>{item.adapter.evidence}</small>
                  <h3>{item.adapter.title}</h3>
                </div>
                <span className={`runs-verdict ${verdictClass(run)}`}>{run ? (RUNNING.has(run.status) ? run.status : run.verdict ?? run.status) : 'no run yet'}</span>
              </header>
              <p>{run?.summary?.headline ?? item.adapter.description}</p>
              {run && !RUNNING.has(run.status) && (
                <dl className="runs-metrics">
                  {keyMetrics(run).map(([label, value]) => (
                    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
                  ))}
                </dl>
              )}
              <footer>
                <small>
                  {run ? `${when(run.finished_at ?? run.queued_at)} · ${duration(run)}` : 'never run'}
                  {item.reproduced ? ` · reproduced ${item.reproduced.identical ? 'identically' : 'with differences'} (${item.reproduced.runs}×)` : ''}
                </small>
                <div>
                  {run && <button className="ghost-button" onClick={() => selectRun(run.run_id)}>Details</button>}
                  <button className="primary-button" disabled={!canRun || Boolean(item.active)} onClick={() => void startRun(item.adapter.id)} title={canRun ? 'Queue a sandboxed run' : 'Requires the engineer role'}>
                    {item.active ? 'Running…' : 'Run'}
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
      </div>

      <div className="runs-grid">
        <div className="activity-table">
          <div className="activity-row head runs-row" aria-hidden="true"><span>Started</span><span>Adapter</span><span>Status</span><span>Duration</span><span>Spec</span><span>Headline</span></div>
          <ol aria-label="Run history">
            {runs.map((run) => (
              <li key={run.run_id}>
                <button className={`activity-row runs-row${selectedId === run.run_id ? ' selected' : ''}`} onClick={() => selectRun(run.run_id)}>
                  <span>{when(run.queued_at)}</span>
                  <span>{run.adapter}{run.reproduction_of ? ' (repro)' : ''}</span>
                  <span className={`activity-result ${run.verdict === 'pass' ? 'ok' : RUNNING.has(run.status) ? 'pending' : run.status === 'cancelled' ? 'denied' : 'error'}`}>{run.status}</span>
                  <span>{duration(run)}</span>
                  <span>{short(run.spec_hash, 8)}</span>
                  <span>{run.summary?.headline ?? '—'}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        {detail && (
          <section className="activity-detail runs-detail" aria-label="Run detail">
            <div className="activity-detail-head">
              <h3>{detail.title} · {detail.status}</h3>
              <div className="runs-actions">
                {RUNNING.has(detail.status) && canRun && <button className="ghost-button" onClick={() => void cancel(detail.run_id)}>Cancel</button>}
                <button className="ghost-button" onClick={() => void reconstruct(detail.run_id)}>Rebuild from audit log</button>
                <button className="ghost-button" onClick={() => setSelectedId(null)} aria-label="Close run detail">Close</button>
              </div>
            </div>
            <dl className="activity-facts wide">
              <div><dt>Run</dt><dd><code>{detail.run_id}</code></dd></div>
              <div><dt>Spec hash</dt><dd><code>{detail.spec_hash}</code></dd></div>
              <div><dt>Image</dt><dd><code>{String(execution.image ?? '—')}</code></dd></div>
              <div><dt>Toolchains</dt><dd>{((execution.mounts as Array<{ volume: string; identity: string }>) ?? []).map((mount) => `${mount.volume} (${short(mount.identity)})`).join(', ') || 'image only'}</dd></div>
              <div><dt>Command</dt><dd><code>{((execution.command as string[]) ?? []).join(' ')}</code></dd></div>
              <div><dt>Isolation</dt><dd>{detail.summary?.isolation ? `${String(detail.summary.isolation.kind)} · network ${String(detail.summary.isolation.network ?? 'host')} · root FS ${String(detail.summary.isolation.root_filesystem ?? 'host')}` : '—'}</dd></div>
              <div><dt>Requested by</dt><dd>{detail.requested_by}{detail.git?.revision ? ` · git ${short(detail.git.revision, 8)}${detail.git.inputs_differ_from_revision ? ' (inputs modified)' : ''}` : ''}</dd></div>
              <div><dt>Evidence</dt><dd>{detail.evidence_class ?? '—'} · outputs {short(detail.output_manifest_hash)}</dd></div>
            </dl>

            {reconstruction && (
              <div className={`runs-reconstruction ${reconstruction.consistent ? 'good' : 'bad'}`}>
                <strong>{reconstruction.consistent ? 'Rebuilt from the audit log: consistent with the run record' : 'Audit log and run record DISAGREE'}</strong>
                <ul>{Object.entries(reconstruction.checks).map(([name, ok]) => <li key={name}>{ok ? '✓' : '✗'} {name.replaceAll('_', ' ')}</li>)}</ul>
                <small>{reconstruction.reconstructed.events.length} lifecycle events · {reconstruction.reconstructed.problems.join('; ') || 'no problems'}</small>
              </div>
            )}

            {images.length > 0 && (
              <div className="runs-images">
                {images.slice(0, 6).map((file) => {
                  const url = artifactUrl(file.sha256);
                  return url ? (
                    <figure key={file.path}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated artifact from the platform API */}
                      <img src={url} alt={`${file.path} from run ${detail.run_id}`} loading="lazy" />
                      <figcaption>{file.path.split('/').pop()}</figcaption>
                    </figure>
                  ) : null;
                })}
              </div>
            )}

            <details className="runs-files">
              <summary>{detail.files?.length ?? 0} files (inputs, outputs, log) by SHA-256</summary>
              <ul>
                {(detail.files ?? []).map((file) => {
                  const url = artifactUrl(file.sha256);
                  return (
                    <li key={`${file.role}:${file.path}`}>
                      <span className={`runs-role ${file.role}`}>{file.role}</span>
                      {url ? <a href={url} target="_blank" rel="noreferrer">{file.path}</a> : file.path}
                      <code>{short(file.sha256)}</code>
                      <small>{file.size_bytes.toLocaleString()} B</small>
                    </li>
                  );
                })}
              </ul>
            </details>

            <div className="runs-log-head"><strong>Log</strong><small>{logOffset.toLocaleString()} bytes{RUNNING.has(detail.status) ? ' · live' : ''}</small></div>
            <pre className="activity-json runs-log">{log || 'No output yet.'}</pre>
          </section>
        )}
      </div>
    </section>
  );
}
