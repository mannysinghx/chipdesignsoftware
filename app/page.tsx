'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { evaluateT0Campaign, type T0Campaign } from '@/lib/t0-campaign';
import { DEFAULT_T0_CONFIG, evaluateT0, runT0Sweep, type GateStatus, type T0Config } from '@/lib/t0-model';
import { DEFAULT_T1_CONFIG, evaluateT1, type T1Config } from '@/lib/t1-model';
import correlation from '@/evidence/ramulator-correlation.json';
import physicalEvidence from '@/evidence/physical-synthesis.json';

type View = 'readiness' | 'architecture' | 'workloads' | 'correlation' | 'explore' | 'gates' | 't1';
type SweepPoint = ReturnType<typeof runT0Sweep>[number];

const views: Array<{ id: View; label: string }> = [
  { id: 'readiness', label: 'Readiness' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'workloads', label: 'Workloads' },
  { id: 'correlation', label: 'Correlation' },
  { id: 'explore', label: 'Experiment' },
  { id: 'gates', label: 'Gates' },
  { id: 't1', label: 'T1 scale-up' },
];

const hierarchy = [
  { id: 'system', label: 'T0 system', meta: '1/8 scale' },
  { id: 'stack', label: '4-tier DRAM stack', meta: '256–512 MB' },
  { id: 'base', label: 'Base die', meta: '16 MB SRAM' },
  { id: 'noc', label: 'NoC regions', meta: '2 regions' },
  { id: 'channels', label: 'Physical channels', meta: '16 × 64-bit' },
  { id: 'pseudo', label: 'Pseudochannels', meta: '32 × 32-bit' },
  { id: 'banks', label: 'Bank fabric', meta: '512 banks' },
];

const t1Hierarchy = [
  { id: 't1-system', label: 'T1 engineering sample', meta: '8-high · 32–64 GB' },
  { id: 't1-stack', label: 'Eight-tier stack', meta: '2× T0 height' },
  { id: 't1-base', label: '2 nm-class base die', meta: 'foundry lane' },
  { id: 't1-noc', label: 'NoC regions', meta: '8 derived regions' },
  { id: 't1-channels', label: 'Physical channels', meta: '64 × 64-bit' },
  { id: 't1-pseudo', label: 'Pseudochannels', meta: '128 × 32-bit' },
  { id: 't1-banks', label: 'Bank fabric', meta: '2,048 derived banks' },
];

export default function Home() {
  const [config, setConfig] = useState<T0Config>(DEFAULT_T0_CONFIG);
  const [view, setView] = useState<View>('t1');
  const [selectedNode, setSelectedNode] = useState('system');
  const [selectedTier, setSelectedTier] = useState(3);
  const [runProgress, setRunProgress] = useState(0);
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'complete'>('idle');
  const [sweep, setSweep] = useState<SweepPoint[]>([]);
  const [t1Config, setT1Config] = useState<T1Config>(DEFAULT_T1_CONFIG);
  const timer = useRef<number | null>(null);
  const evaluation = useMemo(() => evaluateT0(config), [config]);
  const campaign = useMemo(() => evaluateT0Campaign(config), [config]);
  const t1Evaluation = useMemo(() => evaluateT1(t1Config, evaluation.gates), [t1Config, evaluation.gates]);
  const activeHierarchy = view === 't1' ? t1Hierarchy : hierarchy;

  useEffect(() => () => {
    if (timer.current !== null) window.clearInterval(timer.current);
  }, []);

  const updateConfig = <K extends keyof T0Config>(key: K, value: T0Config[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setRunStatus('idle');
    setRunProgress(0);
  };

  const startSweep = () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    setView('explore');
    setRunStatus('running');
    setRunProgress(7);
    setSweep([]);
    timer.current = window.setInterval(() => {
      setRunProgress((current) => {
        const next = Math.min(100, current + 9 + Math.round(Math.random() * 7));
        if (next >= 100) {
          if (timer.current !== null) window.clearInterval(timer.current);
          timer.current = null;
          setSweep(runT0Sweep(config));
          setRunStatus('complete');
          return 100;
        }
        return next;
      });
    }, 110);
  };

  const exportSnapshot = () => {
    const snapshot = {
      schema_version: '1.0',
      product: 'AIMEM-X1 T0 Pathfinder',
      fidelity: 'multi-domain-open-source-proxy',
      generated_at: new Date().toISOString(),
      config,
      evaluation,
      campaign,
      t1: view === 't1' ? { config: t1Config, evaluation: t1Evaluation, evidence_class: 'draft analytical scale-up baseline' } : undefined,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'aimem-t0-snapshot.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const passCount = evaluation.gates.filter((gate) => gate.status === 'pass').length;
  const failCount = evaluation.gates.filter((gate) => gate.status === 'fail').length;
  const provisionalCount = evaluation.gates.filter((gate) => gate.status === 'provisional').length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="chip-mark" aria-hidden="true"><i /><i /><i /><i /></div>
          <div>
            <p className="eyebrow accent">AIMEM Design Studio</p>
            <h1>{view === 't1' ? 'T1 Pathfinder' : 'T0 Pathfinder'}</h1>
          </div>
        </div>

        <nav className="view-tabs" aria-label="Workspace views">
          {views.map((item) => (
            <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>{item.label}</button>
          ))}
        </nav>

        <div className="top-actions">
          <span className="baseline-status"><i /> Spec 0.4.0 · correlated</span>
          <button className="ghost-button" onClick={exportSnapshot}>Export evidence</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-rail">
          <section className="rail-section">
            <div className="section-heading"><span>{view === 't1' ? 'T1 derived hierarchy' : 'Design hierarchy'}</span><b>{activeHierarchy.length}</b></div>
            <div className="hierarchy-list">
              {activeHierarchy.map((item, index) => (
                <button key={item.id} className={(view === 't1' ? index === 0 : selectedNode === item.id) ? 'selected' : ''} onClick={() => { if (view !== 't1') { setSelectedNode(item.id); setView('architecture'); } }}>
                  <span className="tree-line" style={{ '--tree-depth': index === 0 ? 0 : 1 } as CSSProperties}><i /></span>
                  <span className="node-copy"><strong>{item.label}</strong><small>{item.meta}</small></span>
                </button>
              ))}
            </div>
          </section>

          <section className="rail-section evidence-summary">
            <div className="section-heading"><span>{view === 't1' ? 'T1 entry verification' : 'Open-source readiness'}</span><b>{view === 't1' ? `${t1Evaluation.verifiedT0Gates}/12` : `${campaign.openSourceReadinessPercent.toFixed(0)}%`}</b></div>
            <div className="evidence-bar" aria-label={`${passCount} analytical gates pass, ${failCount} fail`}>
              <i className="pass" style={{ width: `${(passCount / 12) * 100}%` }} />
              <i className="provisional" style={{ width: `${(provisionalCount / 12) * 100}%` }} />
              <i className="fail" style={{ width: `${(failCount / 12) * 100}%` }} />
            </div>
            <div className="evidence-legend"><span><i className="dot provisional" />{provisionalCount} proxy</span><span><i className="dot fail" />{failCount} fail</span><span><i className="dot pending" />{12 - passCount - provisionalCount - failCount} external</span></div>
          </section>

          <section className="assistant-card">
            <div className="assistant-head"><span className="agent-glyph">A</span><div><p>{view === 't1' ? 'T1 scale-up agent' : 'T0 program agent'}</p><small>Evidence-aware guidance</small></div></div>
            <p className="assistant-tag watch">{view === 't1' ? 'Digital planning may proceed; physical entry remains on hold' : 'Open-source milestone implemented; silicon remains gated'}</p>
            <p className="assistant-detail">{view === 't1' ? 'Close measured T0 gates before committing a 2 nm implementation or production-style package.' : campaign.blockers[0]}</p>
            <button onClick={() => setView(view === 't1' ? 'gates' : 'readiness')}>{view === 't1' ? 'Audit T0 gates' : 'Review readiness'} <span>→</span></button>
          </section>
        </aside>

        <section className="main-stage">
          <div className="stage-header">
            <div>
              <p className="eyebrow">{view === 't1' ? 'Next hardware milestone' : view === 'readiness' ? 'Program control plane' : view === 'architecture' ? 'Executable architecture' : view === 'workloads' ? 'Deterministic cycle campaign' : view === 'correlation' ? 'Independent memory reference' : view === 'explore' ? 'Design-space experiment' : 'T0 decision matrix'}</p>
              <h2>{view === 't1' ? 'T1 engineering sample' : view === 'readiness' ? 'T0 evidence readiness' : view === 'architecture' ? 'T0 memory system' : view === 'workloads' ? 'Workload verification' : view === 'correlation' ? 'Ramulator2 correlation' : view === 'explore' ? 'Analytical sweep' : 'Evidence gates'}</h2>
              <p>{view === 't1' ? 'Plan the 8-high, 4,096-lane scale-up while preserving the boundary between open-source engineering proxies and foundry-qualified evidence.' : view === 'readiness' ? 'One traceable view of architecture, RTL, formal, physical, thermal, release, and external silicon evidence.' : view === 'architecture' ? 'Four DRAM tiers over a distributed intelligent base die, connected by a 1,024-lane short-reach interface.' : view === 'workloads' ? 'Seeded request-level simulations expose bandwidth, latency, row locality, queueing, gather value, and refresh interference.' : view === 'correlation' ? 'A pinned official Ramulator2 HBM3 lane checks workload ordering, row locality, and the internal model’s absolute latency scale.' : view === 'explore' ? 'Compare lane rate and SRAM variants using transparent analytical proxies.' : 'Twelve source-derived gates separate assumptions from verified engineering evidence.'}</p>
            </div>
            <div className="stage-actions">
              <span className={`fidelity-pill ${view === 't1' ? 'running' : runStatus}`}>{view === 't1' ? 'Draft baseline · entry hold' : runStatus === 'running' ? `Running ${runProgress}%` : runStatus === 'complete' ? 'Sweep complete' : 'Evidence rev 0.4'}</span>
              <button className="primary-button" onClick={view === 't1' ? () => setView('gates') : startSweep}>{view === 't1' ? 'Review T0 entry gates' : runStatus === 'running' ? 'Running sweep…' : 'Run architecture sweep'}</button>
            </div>
          </div>

          {view === 't1' ? (
            <div className="metric-strip">
              <Metric label="Raw bandwidth" value={t1Evaluation.rawBandwidthTbps.toFixed(3)} unit="TB/s" accent />
              <Metric label="Payload lanes" value={t1Config.payloadLanes.toLocaleString()} unit="lanes" />
              <Metric label="DRAM tiers" value={String(t1Config.dramTiers)} unit="high" />
              <Metric label="Base-die SRAM" value={String(t1Config.sramMib)} unit="MB" />
              <Metric label="Verified T0 gates" value={String(t1Evaluation.verifiedT0Gates)} unit="/12" />
            </div>
          ) : (
            <div className="metric-strip">
              <Metric label="Raw bandwidth" value={evaluation.rawBandwidthTbps.toFixed(3)} unit="TB/s" accent />
              <Metric label="Dense stream" value={campaign.workloads[0].usefulBandwidthTbps.toFixed(3)} unit="TB/s" />
              <Metric label="Total power proxy" value={campaign.power.totalWatts.toFixed(1)} unit="W" />
              <Metric label="Thermal hotspot" value={campaign.thermal.hotspotC.toFixed(1)} unit="°C" />
              <Metric label="OSS readiness" value={campaign.openSourceReadinessPercent.toFixed(0)} unit="%" />
            </div>
          )}

          {view === 'readiness' && <ReadinessView campaign={campaign} />}
          {view === 'architecture' && <ArchitectureView config={config} evaluation={evaluation} selectedTier={selectedTier} setSelectedTier={setSelectedTier} selectedNode={selectedNode} />}
          {view === 'workloads' && <WorkloadsView campaign={campaign} />}
          {view === 'correlation' && <CorrelationView />}
          {view === 'explore' && <ExploreView config={config} evaluation={evaluation} sweep={sweep} runStatus={runStatus} runProgress={runProgress} startSweep={startSweep} />}
          {view === 'gates' && <GatesView gates={evaluation.gates} />}
          {view === 't1' && <T1ScaleUpView config={t1Config} evaluation={t1Evaluation} />}

          <footer className="provenance-bar">
            <span><i className="status-dot" /> Inputs recalculated locally</span>
            <span>{view === 't1' ? 'Spec: aimem-t1.json · draft baseline 0.1.0' : 'Spec: aimem-t0.json · evidence rev 0.4.0'}</span>
            <span>{view === 't1' ? 'Fidelity: derived architecture + open-source planning proxies · foundry evidence absent' : 'Fidelity: analytical + Ramulator2 + RTL/formal + Sky130 proxy · not silicon evidence'}</span>
          </footer>
        </section>

        {view === 't1' ? <T1ControlPanel config={t1Config} updateConfig={setT1Config} evaluation={t1Evaluation} /> : <ControlPanel config={config} updateConfig={updateConfig} evaluation={evaluation} startSweep={startSweep} onReset={() => setConfig(DEFAULT_T0_CONFIG)} />}
      </div>
    </main>
  );
}

function ArchitectureView({ config, evaluation, selectedTier, setSelectedTier, selectedNode }: {
  config: T0Config;
  evaluation: ReturnType<typeof evaluateT0>;
  selectedTier: number;
  setSelectedTier: (tier: number) => void;
  selectedNode: string;
}) {
  const channelsPerTier = Math.ceil(config.channels / config.dramTiers);
  const banksPerTier = Math.ceil(evaluation.banks / config.dramTiers);
  return (
    <div className="architecture-grid">
      <section className="panel stack-panel">
        <PanelTitle label="Physical organization" meta={`Focus · ${hierarchy.find((node) => node.id === selectedNode)?.label}`} />
        <div className="stack-canvas">
          <div className="spreader"><span>Top heat spreader</span><i /></div>
          <div className="tier-stack">
            {Array.from({ length: config.dramTiers }).map((_, index) => {
              const tier = config.dramTiers - 1 - index;
              const heat = 61 + tier * 3 + (config.laneRateGbps - 8) * 1.3;
              return (
                <button key={tier} className={`dram-tier ${selectedTier === tier ? 'selected' : ''}`} onClick={() => setSelectedTier(tier)}>
                  <div><strong>DRAM tier {tier}</strong><small>{channelsPerTier} channels · {banksPerTier} banks</small></div>
                  <span><i className="heat-dot" style={{ '--heat': `${Math.min(100, heat)}%` } as CSSProperties} />{heat.toFixed(0)}°C proxy</span>
                </button>
              );
            })}
            <div className="base-die">
              <div><span className="die-label">INTELLIGENT BASE DIE</span><strong>{config.sramMib} MB SRAM</strong><small>Schedulers · ECC · gather · refresh · telemetry</small></div>
              <div className="die-regions" aria-label="Two network-on-chip regions">{Array.from({ length: 2 }).map((_, region) => <i key={region}>{region}</i>)}</div>
            </div>
          </div>
          <div className="bond-line"><span /><small>Cu-Cu hybrid-bond concept</small><span /></div>
          <div className="interface-block"><strong>{evaluation.payloadLanes.toLocaleString()} payload lanes</strong><span>{config.laneRateGbps} Gb/s NRZ · {evaluation.rawBandwidthTbps.toFixed(3)} TB/s physical</span></div>
        </div>
      </section>

      <div className="architecture-side">
        <section className="panel noc-panel">
          <PanelTitle label="Distributed base-die fabric" meta="2 regions · 8 channels each" />
          <div className="noc-map">
            {[0, 1].map((region) => (
              <div key={region} className="noc-region">
                <div className="region-head"><span>R{region}</span><small>{config.sramMib / 2} MB SRAM</small></div>
                <div className="channel-grid">{Array.from({ length: config.channels / 2 }).map((_, channel) => <i key={channel} title={`Channel ${region * (config.channels / 2) + channel}`} style={{ '--load': `${38 + ((channel * 11 + region * 17) % 48)}%` } as CSSProperties} />)}</div>
              </div>
            ))}
            <span className="noc-link"><i /><i /><i /></span>
          </div>
        </section>

        <section className="panel bank-panel">
          <PanelTitle label="Pseudochannel fabric" meta={`${evaluation.pseudochannels} pseudochannels · ${config.banksPerPseudochannel} banks each`} />
          <div className="bank-grid" aria-label={`${evaluation.pseudochannels} pseudochannels`}>
            {Array.from({ length: evaluation.pseudochannels }).map((_, index) => <i key={index} title={`Pseudochannel ${index}`} style={{ '--bank-load': `${28 + ((index * 19) % 67)}%` } as CSSProperties} />)}
          </div>
          <div className="parallelism-row"><span>Bank parallelism proxy</span><strong>{evaluation.bankParallelismScore.toFixed(0)}%</strong></div>
          <div className="thin-meter"><i style={{ width: `${evaluation.bankParallelismScore}%` }} /></div>
        </section>

        <section className="panel throughput-panel">
          <PanelTitle label="Useful delivery" meta="Physical and workload proxies remain distinct" />
          <ThroughputBar label="Physical raw" value={evaluation.rawBandwidthTbps} max={1.6} color="mint" />
          <ThroughputBar label="Streaming proxy" value={evaluation.streamingBandwidthTbps} max={1.6} color="blue" />
          <ThroughputBar label="Random proxy" value={evaluation.randomBandwidthTbps} max={1.6} color="amber" />
        </section>
      </div>
    </div>
  );
}

function T1ScaleUpView({ config, evaluation }: {
  config: T1Config;
  evaluation: ReturnType<typeof evaluateT1>;
}) {
  const scaleDeltas = [
    ['Stack height', '4 → 8', '2× tiers'],
    ['Payload interface', '1,024 → 4,096', '4× lanes'],
    ['Physical channels', '16 → 64', '4× channels'],
    ['Bank fabric', '512 → 2,048', '4× banks · derived'],
    ['Base-die SRAM', '16 → 64 MB', '4× capacity'],
    ['Nominal bandwidth', '1.024 → 4.096', '4× TB/s'],
  ];
  const sequence = [
    ['01', 'Freeze the T1 contract', 'Version all source-defined targets and explicitly tag derived channel, bank, and region assumptions.', 'active'],
    ['02', 'Scale digital models', 'Extend traces, address mapping, NoC traffic, controller composition, ECC, refresh, and repair to 64 channels.', 'next'],
    ['03', 'Run physical and multiphysics proxies', 'Sweep public-PDK routing plus eight-tier thermal, link, power-delivery, and package geometry studies.', 'next'],
    ['04', 'Authorize foundry entry', 'Proceed only after measured T0 gates pass and qualified 2 nm, SRAM, PHY, bond, and signoff inputs exist.', 'blocked'],
  ];

  return (
    <div className="t1-layout">
      <section className="panel t1-hero">
        <div className="t1-stack-visual" aria-label="Eight-tier T1 stack over an intelligent base die">
          {Array.from({ length: config.dramTiers }).map((_, index) => <i key={index} style={{ '--tier-index': index } as CSSProperties} />)}
          <span>64 MB intelligent base die</span>
        </div>
        <div className="t1-hero-copy">
          <p className="eyebrow accent">T1 baseline opened</p>
          <h3>Scale the pathfinder toward a production-style engineering sample.</h3>
          <p>The open-source lane can begin architecture, RTL, routing-proxy, link, and thermal work now. A physical 2 nm commitment remains gated on measured T0 silicon and qualified foundry inputs.</p>
          <div className="readiness-tags"><span className="good">{config.dramTiers}-high stack</span><span className="good">{config.payloadLanes.toLocaleString()} lanes</span><span className="good">{config.capacityGib} GB target</span><span className="pending">Foundry entry: hold</span></div>
        </div>
        <div className="t1-decision"><span>Entry decision</span><strong>{evaluation.entryDecision}</strong><small>{evaluation.verifiedT0Gates}/12 T0 gates have measured passing evidence</small></div>
      </section>

      <section className="panel t1-scale-panel">
        <PanelTitle label="T0 → T1 scale delta" meta="Source targets plus explicitly marked derivations" />
        <div className="t1-scale-grid">{scaleDeltas.map(([label, value, note]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div>
      </section>

      <section className="panel t1-entry-panel">
        <PanelTitle label="T1 entry audit" meta="Proxy evidence cannot satisfy a measured gate" />
        <div className="t1-entry-summary">
          <div><strong>{evaluation.verifiedT0Gates}</strong><span>verified</span></div>
          <div><strong>{evaluation.provisionalT0Gates}</strong><span>provisional</span></div>
          <div><strong>{evaluation.blockedT0Gates}</strong><span>unverified / failed</span></div>
        </div>
        <div className="t1-entry-bar" aria-label={`${evaluation.verifiedT0Gates} verified, ${evaluation.provisionalT0Gates} provisional, ${evaluation.blockedT0Gates} blocked T0 gates`}>
          <i className="verified" style={{ width: `${(evaluation.verifiedT0Gates / 12) * 100}%` }} />
          <i className="provisional" style={{ width: `${(evaluation.provisionalT0Gates / 12) * 100}%` }} />
          <i className="blocked" style={{ width: `${(evaluation.blockedT0Gates / 12) * 100}%` }} />
        </div>
        <p>Digital scale-up work is authorized as research. Tapeout, package commitment, and claims of T1 readiness are not.</p>
      </section>

      <section className="panel t1-proof-panel">
        <PanelTitle label="T1 proof programs" meta="Four source-defined outcomes" />
        <div className="t1-proof-grid">
          {evaluation.proofPrograms.map((program) => (
            <article key={program.id}>
              <div className="t1-proof-head"><span>{program.id}</span><b className={program.status}>{program.status.replaceAll('-', ' ')}</b></div>
              <h3>{program.title}</h3>
              <p>{program.objective}</p>
              <dl><div><dt>Open-source stack</dt><dd>{program.openSourceStack}</dd></div><div><dt>Exit evidence</dt><dd>{program.exitGate}</dd></div></dl>
            </article>
          ))}
        </div>
      </section>

      <section className="panel t1-sequence-panel">
        <PanelTitle label="Execution sequence" meta="Evidence before irreversible spend" />
        <div className="t1-sequence">{sequence.map(([number, title, detail, status]) => <article key={number} className={status}><b>{number}</b><div><h3>{title}</h3><p>{detail}</p></div><span>{status}</span></article>)}</div>
      </section>

      <section className="gate-note"><strong>Open-source boundary</strong><p>The product, models, RTL, public-PDK research flows, and first-order multiphysics studies remain open source. Qualified 2 nm implementation, production SRAM/PHY IP, hybrid-bond process data, and foundry signoff cannot be truthfully replaced by public proxies.</p></section>
    </div>
  );
}

function ExploreView({ config, evaluation, sweep, runStatus, runProgress, startSweep }: {
  config: T0Config;
  evaluation: ReturnType<typeof evaluateT0>;
  sweep: SweepPoint[];
  runStatus: 'idle' | 'running' | 'complete';
  runProgress: number;
  startSweep: () => void;
}) {
  const ranked = [...sweep].sort((a, b) => {
    const scoreA = a.evaluation.streamingBandwidthTbps - a.evaluation.phyPowerWatts * 0.05;
    const scoreB = b.evaluation.streamingBandwidthTbps - b.evaluation.phyPowerWatts * 0.05;
    return scoreB - scoreA;
  });
  const chartTicks = [...new Map(sweep.map((point) => [point.config.laneRateGbps, point])).values()]
    .sort((a, b) => a.config.laneRateGbps - b.config.laneRateGbps)
    .map((point) => ({
      laneRate: point.config.laneRateGbps,
      bandwidth: point.evaluation.rawBandwidthTbps,
      position: Math.max(3, Math.min(97, ((point.evaluation.rawBandwidthTbps - 0.45) / 1.15) * 100)),
    }));
  const workloads = [
    { name: 'Dense stream', value: evaluation.streamingBandwidthTbps, detail: `${config.streamingEfficiencyPercent}% bus efficiency`, color: 'mint' },
    { name: 'Banked random', value: evaluation.randomBandwidthTbps, detail: `${config.randomEfficiencyPercent}% banked efficiency`, color: 'amber' },
    { name: 'KV decode proxy', value: evaluation.rawBandwidthTbps * (0.39 + Math.min(0.22, config.sramMib / 100)), detail: `${config.sramMib} MB metadata / hot-line layer`, color: 'blue' },
    { name: 'Gather proxy', value: evaluation.randomBandwidthTbps * 1.18, detail: 'Useful delivery; not physical bandwidth', color: 'violet' },
  ];

  return (
    <div className="explore-layout">
      <section className="panel sweep-panel">
        <PanelTitle label="Lane rate × SRAM sweep" meta="12 deterministic analytical candidates" />
        {runStatus !== 'complete' ? (
          <div className="run-state">
            <div className={`run-orbit ${runStatus}`}><i /><i /><i /><span>{runStatus === 'running' ? `${runProgress}%` : '12'}</span></div>
            <h3>{runStatus === 'running' ? 'Evaluating candidates' : 'Experiment ready'}</h3>
            <p>{runStatus === 'running' ? 'Recalculating bandwidth, PHY link power, efficiencies, gates, and route risk.' : 'Sweep 4/8/10/12 Gb/s across 8/16/32 MB SRAM variants.'}</p>
            {runStatus === 'running' ? <div className="run-progress"><i style={{ width: `${runProgress}%` }} /></div> : <button className="primary-button" onClick={startSweep}>Run 12 candidates</button>}
          </div>
        ) : (
          <div className="pareto-wrap">
            <div className="chart-summary"><strong>Higher is better</strong><span>Compare efficiency vertically and raw bandwidth horizontally.</span></div>
            <div className="pareto-chart">
              <div className="y-axis-title">Streaming efficiency (%)</div>
              <div className="y-axis-ticks" aria-hidden="true"><span>96%</span><span>88%</span><span>80%</span><span>72%</span></div>
              <div className="plot-stack">
                <div className="plot-lane-labels" aria-label="Lane rate by candidate group">
                  {chartTicks.map((tick) => <span key={tick.laneRate} style={{ left: `${tick.position}%` }}>{tick.laneRate} Gb/s</span>)}
                </div>
                <div className="pareto-plot">
                  <div className="grid-lines" />
                  {sweep.map((point, index) => {
                    const x = ((point.evaluation.rawBandwidthTbps - 0.45) / 1.15) * 100;
                    const y = ((point.config.streamingEfficiencyPercent - 72) / 24) * 100;
                    const size = 8 + point.config.sramMib / 4;
                    const label = `${point.config.laneRateGbps} Gb/s, ${point.config.sramMib} MB SRAM, ${point.config.streamingEfficiencyPercent}% efficiency, ${point.evaluation.rawBandwidthTbps.toFixed(3)} TB/s`;
                    return <span key={index} tabIndex={0} aria-label={label} data-label={label} className={`plot-dot sram-${point.config.sramMib}`} style={{ left: `${Math.max(3, Math.min(97, x))}%`, bottom: `${Math.max(4, Math.min(95, y))}%`, width: size, height: size }} />;
                  })}
                </div>
                <div className="x-axis-ticks" aria-hidden="true">
                  {chartTicks.map((tick) => <span key={tick.laneRate} style={{ left: `${tick.position}%` }}>{tick.bandwidth.toFixed(3)}</span>)}
                </div>
                <div className="x-axis-title">Raw bandwidth (TB/s)</div>
              </div>
            </div>
            <div className="plot-legend"><strong>SRAM capacity</strong><span><i className="sram-8" />8 MB</span><span><i className="sram-16" />16 MB</span><span><i className="sram-32" />32 MB</span><em>Hover or focus a point for exact values</em></div>
          </div>
        )}
      </section>

      <section className="panel workload-panel">
        <PanelTitle label="Workload projections" meta="Useful data delivery proxies" />
        <div className="workload-grid">{workloads.map((workload) => <div key={workload.name} className="workload-card"><span className={`workload-icon ${workload.color}`} /><div><p>{workload.name}</p><strong>{workload.value.toFixed(3)} <small>TB/s</small></strong><span>{workload.detail}</span></div></div>)}</div>
      </section>

      <section className="panel candidates-panel">
        <PanelTitle label="Top candidates" meta={ranked.length ? 'Ranked by streaming delivery minus link-power penalty' : 'Run the sweep to rank variants'} />
        {ranked.length ? (
          <div className="candidate-table">
            <div className="table-row head"><span>Candidate</span><span>Raw</span><span>Stream</span><span>PHY W</span><span>Gates</span></div>
            {ranked.slice(0, 6).map((point, index) => {
              const proxies = point.evaluation.gates.filter((gate) => gate.status === 'pass' || gate.status === 'provisional').length;
              return <div className="table-row" key={`${point.config.laneRateGbps}-${point.config.sramMib}`}><span><b>{index + 1}</b>{point.config.laneRateGbps} Gb/s · {point.config.sramMib} MB</span><span>{point.evaluation.rawBandwidthTbps.toFixed(3)}</span><span>{point.evaluation.streamingBandwidthTbps.toFixed(3)}</span><span>{point.evaluation.phyPowerWatts.toFixed(2)}</span><span className={proxies >= 5 ? 'pass-text' : 'watch-text'}>{proxies}/5 proxy</span></div>;
            })}
          </div>
        ) : <div className="empty-table">No sweep result yet. Current configuration remains available in the live estimate above.</div>}
      </section>
    </div>
  );
}

function ReadinessView({ campaign }: { campaign: T0Campaign }) {
  return (
    <div className="readiness-layout">
      <section className="panel readiness-hero">
        <div className="readiness-dial" style={{ '--readiness': `${campaign.openSourceReadinessPercent}%` } as CSSProperties}>
          <div><strong>{campaign.openSourceReadinessPercent.toFixed(0)}%</strong><span>open-source</span></div>
        </div>
        <div className="readiness-copy">
          <p className="eyebrow accent">T0 completion contract</p>
          <h3>Engineering workspace implemented. Silicon proof remains external.</h3>
          <p>The product now connects deterministic workloads, a synthesizable 16-channel controller composition, bounded formal safety, generic synthesis, compact physical and thermal models, and traceable decision gates.</p>
          <div className="readiness-tags"><span className="good">13 automated tests</span><span className="good">16 RTL channels</span><span className="good">2 formal proofs</span><span className="pending">2 silicon-only gates</span></div>
        </div>
        <div className="silicon-score"><span>Measured silicon evidence</span><strong>{campaign.siliconEvidencePercent.toFixed(0)}%</strong><small>Foundry and measured-silicon work is intentionally zero until real evidence exists.</small></div>
      </section>

      <section className="panel domain-panel">
        <PanelTitle label="Evidence domains" meta="Completion is evidence-weighted, not task-count theater" />
        <div className="domain-grid">
          {campaign.domains.map((domain) => (
            <article className="domain-card" key={domain.id}>
              <div className="domain-head"><span className={`maturity ${domain.maturity}`}>{domain.maturity.replace('-', ' ')}</span><strong>{domain.completionPercent}%</strong></div>
              <h3>{domain.name}</h3>
              <p>{domain.evidence}</p>
              <div className="domain-meter"><i style={{ width: `${domain.completionPercent}%` }} /></div>
              <small>Next gate · {domain.nextGate}</small>
            </article>
          ))}
        </div>
      </section>

      <div className="proxy-grid">
        <section className="panel proxy-panel">
          <PanelTitle label="Power and thermal proxy" meta={`${campaign.thermal.marginC.toFixed(1)}°C modeled margin`} />
          <div className="power-stack">
            {[
              ['PHY', campaign.power.phyWatts, 'mint'],
              ['Controller', campaign.power.controllerWatts, 'blue'],
              ['SRAM', campaign.power.sramWatts, 'violet'],
              ['DRAM', campaign.power.dramWatts, 'amber'],
            ].map(([label, value, color]) => (
              <div key={String(label)}><span>{label}</span><div><i className={String(color)} style={{ width: `${(Number(value) / campaign.power.totalWatts) * 100}%` }} /></div><strong>{Number(value).toFixed(2)} W</strong></div>
            ))}
          </div>
          <div className="proxy-footer"><span>Total <strong>{campaign.power.totalWatts.toFixed(2)} W</strong></span><span>Hotspot <strong>{campaign.thermal.hotspotC.toFixed(1)}°C</strong></span></div>
        </section>

        <section className="panel proxy-panel">
          <PanelTitle label="Physical-design proxy" meta="Sky130 mapped · pre-placement only" />
          <div className="physical-metrics">
            <div><span>Mapped cells</span><strong>{physicalEvidence.mapped_cells.toLocaleString()}<small>cells</small></strong></div>
            <div><span>Cell area</span><strong>{(physicalEvidence.chip_area_um2 / 1000).toFixed(1)}<small>kµm²</small></strong></div>
            <div><span>Sequential cells</span><strong>{physicalEvidence.sequential_cells}<small>cells</small></strong></div>
            <div><span>Synthesis target</span><strong>{physicalEvidence.clock_target_mhz}<small>MHz</small></strong></div>
          </div>
        </section>
      </div>

      <section className="panel reliability-panel">
        <PanelTitle label="Reliability closure" meta="Deterministic fault campaign + synthesized datapaths" />
        <div className="reliability-grid">
          <div><span>Single-bit correction</span><strong>{campaign.reliability.singleBitCorrections}/{campaign.reliability.singleBitInjections}</strong><small>All 72 codeword positions × 5 patterns</small></div>
          <div><span>Double-bit detection</span><strong>{campaign.reliability.doubleBitDetections.toLocaleString()}/{campaign.reliability.doubleBitInjections.toLocaleString()}</strong><small>Every two-bit pair on the reference pattern</small></div>
          <div><span>Lane repair cases</span><strong>{campaign.reliability.laneRepairCasesPassed}/4</strong><small>0–2 faults repaired; 3 faults rejected</small></div>
          <div><span>Gather reference</span><strong>{campaign.reliability.gatherReferenceAddresses}</strong><small>Strided addresses checked per descriptor</small></div>
        </div>
      </section>

      <section className="panel blocker-panel">
        <PanelTitle label="T0 closure blockers" meta="These cannot be converted into passes by an AI agent" />
        <div className="blocker-list">{campaign.blockers.map((blocker, index) => <div key={blocker}><b>{String(index + 1).padStart(2, '0')}</b><p>{blocker}</p><span>{index < 3 ? 'engineering' : 'external'}</span></div>)}</div>
      </section>
    </div>
  );
}

function WorkloadsView({ campaign }: { campaign: T0Campaign }) {
  return (
    <div className="workloads-layout">
      <section className="panel workload-campaign-panel">
        <PanelTitle label="Seeded cycle campaign" meta={`${campaign.workloads.reduce((sum, item) => sum + item.requests, 0).toLocaleString()} deterministic requests`} />
        <div className="campaign-table">
          <div className="campaign-row campaign-head"><span>Workload</span><span>Useful BW</span><span>Util.</span><span>Avg latency</span><span>P99</span><span>Row hits</span><span>Q99</span></div>
          {campaign.workloads.map((workload) => (
            <div className="campaign-row" key={workload.id}>
              <span><strong>{workload.name}</strong><small>{workload.description}</small></span>
              <span>{workload.usefulBandwidthTbps.toFixed(3)} TB/s</span>
              <span>{workload.utilizationPercent.toFixed(1)}%</span>
              <span>{workload.averageLatencyNs.toFixed(1)} ns</span>
              <span>{workload.p99LatencyNs.toFixed(1)} ns</span>
              <span>{workload.rowHitPercent.toFixed(1)}%</span>
              <span>{workload.queueDepthP99}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="workload-summary-grid">
        {campaign.workloads.map((workload) => (
          <article className="panel workload-result" key={workload.id}>
            <div className="workload-result-head"><span>{workload.id}</span><strong>{workload.usefulBandwidthTbps.toFixed(3)} TB/s</strong></div>
            <div className="workload-arc" style={{ '--arc': `${workload.utilizationPercent}%` } as CSSProperties}><i /></div>
            <div className="workload-result-copy"><strong>{workload.utilizationPercent.toFixed(1)}% physical utilization</strong><span>{workload.hostTrafficReductionPercent}% host traffic reduction · {workload.refreshStalls} modeled refresh stalls</span></div>
          </article>
        ))}
      </div>

      <section className="gate-note"><strong>Campaign fidelity</strong><p>This deterministic request-level model is reproducible and useful for architecture decisions. Ramulator2 correlation is linked; absolute-latency calibration, RTL simulation, extracted timing, and measured silicon remain open.</p></section>
    </div>
  );
}

function CorrelationView() {
  return (
    <div className="correlation-layout">
      <section className="panel correlation-hero">
        <div><span>Latency rank agreement</span><strong>{correlation.latency_rank_spearman.toFixed(2)}</strong><small>Spearman ρ · four workloads</small></div>
        <div><span>Row-locality error</span><strong>{correlation.row_hit_mean_absolute_error_pp.toFixed(2)}<em>pp</em></strong><small>Mean absolute error</small></div>
        <div className="calibration-gap"><span>Latency calibration gap</span><strong>{correlation.mean_latency_scale_factor.toFixed(2)}<em>×</em></strong><small>Ramulator2 / internal mean</small></div>
        <p>{correlation.finding}</p>
      </section>

      <section className="panel correlation-table-panel">
        <PanelTitle label="Workload-by-workload comparison" meta="HBM3 6.4 Gb/s · representative 32-bit channel" />
        <div className="correlation-table">
          <div className="correlation-row correlation-head"><span>Workload</span><span>Internal latency</span><span>Ramulator2 latency</span><span>Scale gap</span><span>Internal row hits</span><span>Ramulator2 row hits</span><span>Δ row hits</span></div>
          {correlation.results.map((result) => (
            <div className="correlation-row" key={result.id}>
              <span><strong>{result.name}</strong><small>{result.ramulator_classification_coverage_percent.toFixed(1)}% requests classified</small></span>
              <span>{result.internal_average_latency_ns.toFixed(1)} ns</span>
              <span>{result.ramulator_average_read_latency_ns.toFixed(1)} ns</span>
              <span className="watch-text">{result.latency_scale_factor.toFixed(2)}×</span>
              <span>{result.internal_row_hit_percent.toFixed(1)}%</span>
              <span>{result.ramulator_row_hit_percent.toFixed(1)}%</span>
              <span className={Math.abs(result.row_hit_delta_pp) < 2 ? 'pass-text' : 'watch-text'}>{result.row_hit_delta_pp > 0 ? '+' : ''}{result.row_hit_delta_pp.toFixed(1)} pp</span>
            </div>
          ))}
        </div>
      </section>

      <div className="correlation-notes">
        <section className="panel evidence-contract">
          <PanelTitle label="Reproducibility contract" meta="Official open-source simulator" />
          <dl><div><dt>Simulator</dt><dd>{correlation.simulator}</dd></div><div><dt>Pinned commit</dt><dd>{correlation.ramulator_commit.slice(0, 12)}</dd></div><div><dt>Memory proxy</dt><dd>{correlation.proxy}</dd></div><div><dt>Evidence class</dt><dd>Cycle-accurate public proxy</dd></div></dl>
        </section>
        <section className="panel calibration-panel">
          <PanelTitle label="Calibration decision" meta="Ordering accepted · scale rejected" />
          <div className="calibration-status"><span className="good">Accept</span><p>Relative workload ordering and row-locality behavior.</p></div>
          <div className="calibration-status"><span className="watch">Rework</span><p>Absolute latency constants and downstream bandwidth assumptions.</p></div>
          <div className="calibration-status"><span className="pending">Hold</span><p>Silicon gates; no proxy can upgrade them.</p></div>
        </section>
      </div>
    </div>
  );
}

function GatesView({ gates }: { gates: ReturnType<typeof evaluateT0>['gates'] }) {
  const groups = [
    { title: 'Modeled now', gates: gates.slice(0, 5) },
    { title: 'Requires tool or silicon evidence', gates: gates.slice(5) },
  ];
  return (
    <div className="gates-layout">
      {groups.map((group) => (
        <section className="panel gate-group" key={group.title}>
          <PanelTitle label={group.title} meta={`${group.gates.length} gates`} />
          <div className="gate-list">
            {group.gates.map((gate) => (
              <article key={gate.id} className="gate-row">
                <GateIcon status={gate.status} />
                <div className="gate-title"><small>{gate.id}</small><strong>{gate.title}</strong></div>
                <div><small>Target</small><span>{gate.target}</span></div>
                <div><small>Current</small><span>{gate.observed}</span></div>
                <div><small>Evidence</small><span>{gate.evidence}</span></div>
                <span className={`status-badge ${gate.status}`}>{gate.status}</span>
              </article>
            ))}
          </div>
        </section>
      ))}
      <section className="gate-note"><strong>Evidence policy</strong><p>Analytical results can expose risk and guide experiments. They cannot mark formal, RTL, physical, or silicon gates as verified.</p></section>
    </div>
  );
}

function T1ControlPanel({ config, updateConfig, evaluation }: {
  config: T1Config;
  updateConfig: (config: T1Config) => void;
  evaluation: ReturnType<typeof evaluateT1>;
}) {
  return (
    <aside className="control-rail">
      <div className="control-head"><div><p className="eyebrow">Scale-up variables</p><h2>T1 baseline</h2></div><button onClick={() => updateConfig(DEFAULT_T1_CONFIG)}>Reset</button></div>
      <div className="control-scroll">
        <ControlGroup title="Source-defined modes">
          <SegmentedControl label="Capacity target" value={config.capacityGib} options={[32, 64]} unit="GB" onChange={(value) => updateConfig({ ...config, capacityGib: value as 32 | 64 })} />
          <SegmentedControl label="Lane rate" value={config.laneRateGbps} options={[8, 12]} unit="Gb/s" onChange={(value) => updateConfig({ ...config, laneRateGbps: value as 8 | 12 })} />
          <RangeControl label="PHY energy assumption" value={config.assumedPhyEnergyPjPerBit} min={0.1} max={0.3} step={0.01} unit="pJ/bit" onChange={(value) => updateConfig({ ...config, assumedPhyEnergyPjPerBit: value })} />
        </ControlGroup>
        <ControlGroup title="Fixed architecture">
          <div className="t1-fixed-list"><span><b>8</b> DRAM tiers</span><span><b>4,096</b> payload lanes</span><span><b>64</b> physical channels</span><span><b>128</b> pseudochannels</span><span><b>2,048</b> derived banks</span><span><b>64 MB</b> SRAM</span></div>
        </ControlGroup>
        <ControlGroup title="Live analytical outputs">
          <div className="t1-output-list"><span>Raw bandwidth <b>{evaluation.rawBandwidthTbps.toFixed(3)} TB/s</b></span><span>Interface power proxy <b>{evaluation.interfacePowerProxyWatts.toFixed(2)} W</b></span><span>SRAM / region <b>{evaluation.sramPerRegionMib.toFixed(0)} MB</b></span></div>
        </ControlGroup>
        <section className="route-risk high"><span>T1 physical entry</span><strong>{evaluation.entryDecision}</strong><p>Measured T0 gates, qualified 2 nm inputs, and package evidence are mandatory before commitment.</p></section>
      </div>
      <div className="control-footer"><p>All values are local analytical planning data; no foundry or silicon evidence is implied.</p></div>
    </aside>
  );
}

function ControlPanel({ config, updateConfig, evaluation, startSweep, onReset }: {
  config: T0Config;
  updateConfig: <K extends keyof T0Config>(key: K, value: T0Config[K]) => void;
  evaluation: ReturnType<typeof evaluateT0>;
  startSweep: () => void;
  onReset: () => void;
}) {
  return (
    <aside className="control-rail">
      <div className="control-head"><div><p className="eyebrow">Design variables</p><h2>T0 configuration</h2></div><button onClick={onReset}>Reset</button></div>
      <div className="control-scroll">
        <ControlGroup title="Interface">
          <SegmentedControl label="Lane rate" value={config.laneRateGbps} options={[4, 8, 10, 12]} unit="Gb/s" onChange={(value) => updateConfig('laneRateGbps', value)} />
          <SegmentedControl label="Channels" value={config.channels} options={[8, 16, 32]} onChange={(value) => updateConfig('channels', value)} />
          <RangeControl label="Route length" value={config.interconnectLengthMm} min={2} max={15} step={1} unit="mm" onChange={(value) => updateConfig('interconnectLengthMm', value)} />
          <RangeControl label="PHY energy" value={config.phyEnergyPjPerBit} min={0.08} max={0.25} step={0.01} unit="pJ/bit" onChange={(value) => updateConfig('phyEnergyPjPerBit', value)} />
        </ControlGroup>
        <ControlGroup title="Memory organization">
          <SegmentedControl label="Banks / pseudochannel" value={config.banksPerPseudochannel} options={[8, 16, 32]} onChange={(value) => updateConfig('banksPerPseudochannel', value)} />
          <SegmentedControl label="Row size" value={config.rowSizeBytes} options={[256, 512, 1024]} unit="B" onChange={(value) => updateConfig('rowSizeBytes', value)} />
          <SegmentedControl label="SRAM" value={config.sramMib} options={[8, 16, 32]} unit="MB" onChange={(value) => updateConfig('sramMib', value)} />
          <RangeControl label="SRAM hit latency" value={config.sramHitLatencyNs} min={6} max={14} step={0.2} unit="ns" onChange={(value) => updateConfig('sramHitLatencyNs', value)} />
        </ControlGroup>
        <ControlGroup title="Workload proxies">
          <RangeControl label="Streaming efficiency" value={config.streamingEfficiencyPercent} min={60} max={96} step={1} unit="%" onChange={(value) => updateConfig('streamingEfficiencyPercent', value)} />
          <RangeControl label="Random efficiency" value={config.randomEfficiencyPercent} min={40} max={84} step={1} unit="%" onChange={(value) => updateConfig('randomEfficiencyPercent', value)} />
        </ControlGroup>
        <section className={`route-risk ${evaluation.linkRisk}`}><span>Link routing risk</span><strong>{evaluation.linkRisk}</strong><p>{config.laneRateGbps >= 12 ? 'Turbo prefers routes below about 5 mm.' : 'Nominal 8 Gb/s targets routes at or below about 10 mm.'}</p></section>
      </div>
      <div className="control-footer"><button className="primary-button wide" onClick={startSweep}>Run 12-point sweep</button><p>Local analytical model · no external data sent</p></div>
    </aside>
  );
}

function ControlGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="control-group"><h3>{title}</h3>{children}</section>;
}

function SegmentedControl({ label, value, options, unit, onChange }: { label: string; value: number; options: number[]; unit?: string; onChange: (value: number) => void }) {
  return <div className="control"><div className="control-label"><label>{label}</label><span>{value}{unit ? ` ${unit}` : ''}</span></div><div className="segments">{options.map((option) => <button key={option} className={value === option ? 'active' : ''} onClick={() => onChange(option)} aria-pressed={value === option}>{option}</button>)}</div></div>;
}

function RangeControl({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  const percentage = ((value - min) / (max - min)) * 100;
  return <div className="control"><div className="control-label"><label>{label}</label><span>{Number.isInteger(step) ? value : value.toFixed(step < 0.1 ? 2 : 1)} {unit}</span></div><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} style={{ '--range-value': `${percentage}%` } as CSSProperties} /><div className="range-ends"><span>{min}</span><span>{max}</span></div></div>;
}

function Metric({ label, value, unit, accent = false }: { label: string; value: string; unit: string; accent?: boolean }) {
  return <div className={`metric ${accent ? 'accent' : ''}`}><span>{label}</span><strong>{value}<small>{unit}</small></strong></div>;
}

function PanelTitle({ label, meta }: { label: string; meta: string }) {
  return <div className="panel-title"><h3>{label}</h3><span>{meta}</span></div>;
}

function ThroughputBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return <div className="throughput-row"><div><span>{label}</span><strong>{value.toFixed(3)} TB/s</strong></div><div className="bar-track"><i className={color} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /></div></div>;
}

function GateIcon({ status }: { status: GateStatus }) {
  return <span className={`gate-icon ${status}`} aria-hidden="true">{status === 'pass' ? '✓' : status === 'fail' ? '!' : status === 'provisional' ? '~' : '·'}</span>;
}
