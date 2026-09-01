'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_T0_CONFIG, evaluateT0, runT0Sweep, type GateStatus, type T0Config } from '@/lib/t0-model';

type View = 'architecture' | 'explore' | 'gates';
type SweepPoint = ReturnType<typeof runT0Sweep>[number];

const views: Array<{ id: View; label: string }> = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'explore', label: 'Experiment' },
  { id: 'gates', label: 'Evidence gates' },
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

export default function Home() {
  const [config, setConfig] = useState<T0Config>(DEFAULT_T0_CONFIG);
  const [view, setView] = useState<View>('architecture');
  const [selectedNode, setSelectedNode] = useState('system');
  const [selectedTier, setSelectedTier] = useState(3);
  const [runProgress, setRunProgress] = useState(0);
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'complete'>('idle');
  const [sweep, setSweep] = useState<SweepPoint[]>([]);
  const timer = useRef<number | null>(null);
  const evaluation = useMemo(() => evaluateT0(config), [config]);

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
      fidelity: 'analytical-proxy',
      generated_at: new Date().toISOString(),
      config,
      evaluation,
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="chip-mark" aria-hidden="true"><i /><i /><i /><i /></div>
          <div>
            <p className="eyebrow accent">AIMEM Design Studio</p>
            <h1>T0 Pathfinder</h1>
          </div>
        </div>

        <nav className="view-tabs" aria-label="Workspace views">
          {views.map((item) => (
            <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>{item.label}</button>
          ))}
        </nav>

        <div className="top-actions">
          <span className="baseline-status"><i /> Spec 0.1.0 · linked</span>
          <button className="ghost-button" onClick={exportSnapshot}>Export snapshot</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-rail">
          <section className="rail-section">
            <div className="section-heading"><span>Design hierarchy</span><b>7</b></div>
            <div className="hierarchy-list">
              {hierarchy.map((item, index) => (
                <button key={item.id} className={selectedNode === item.id ? 'selected' : ''} onClick={() => { setSelectedNode(item.id); setView('architecture'); }}>
                  <span className="tree-line" style={{ '--tree-depth': index === 0 ? 0 : 1 } as CSSProperties}><i /></span>
                  <span className="node-copy"><strong>{item.label}</strong><small>{item.meta}</small></span>
                </button>
              ))}
            </div>
          </section>

          <section className="rail-section evidence-summary">
            <div className="section-heading"><span>Evidence state</span><b>{passCount}/12</b></div>
            <div className="evidence-bar" aria-label={`${passCount} analytical gates pass, ${failCount} fail`}>
              <i className="pass" style={{ width: `${(passCount / 12) * 100}%` }} />
              <i className="fail" style={{ width: `${(failCount / 12) * 100}%` }} />
            </div>
            <div className="evidence-legend"><span><i className="dot pass" />{passCount} pass</span><span><i className="dot fail" />{failCount} fail</span><span><i className="dot pending" />{12 - passCount - failCount} pending</span></div>
          </section>

          <section className="assistant-card">
            <div className="assistant-head"><span className="agent-glyph">A</span><div><p>Architecture assistant</p><small>Rule + model evidence</small></div></div>
            <p className={`assistant-tag ${evaluation.recommendations[0]?.severity ?? 'good'}`}>{evaluation.recommendations[0]?.title}</p>
            <p className="assistant-detail">{evaluation.recommendations[0]?.detail}</p>
            <button onClick={() => setView('gates')}>Review evidence <span>→</span></button>
          </section>
        </aside>

        <section className="main-stage">
          <div className="stage-header">
            <div>
              <p className="eyebrow">{view === 'architecture' ? 'Executable architecture' : view === 'explore' ? 'Design-space experiment' : 'T0 decision matrix'}</p>
              <h2>{view === 'architecture' ? 'T0 memory system' : view === 'explore' ? 'Analytical sweep' : 'Evidence gates'}</h2>
              <p>{view === 'architecture' ? 'Four DRAM tiers over a distributed intelligent base die, connected by a 1,024-lane short-reach interface.' : view === 'explore' ? 'Compare lane rate and SRAM variants using transparent analytical proxies.' : 'Twelve source-derived gates separate assumptions from verified engineering evidence.'}</p>
            </div>
            <div className="stage-actions">
              <span className={`fidelity-pill ${runStatus}`}>{runStatus === 'running' ? `Running ${runProgress}%` : runStatus === 'complete' ? 'Sweep complete' : 'Analytical proxy'}</span>
              <button className="primary-button" onClick={startSweep}>{runStatus === 'running' ? 'Running sweep…' : 'Run architecture sweep'}</button>
            </div>
          </div>

          <div className="metric-strip">
            <Metric label="Raw bandwidth" value={evaluation.rawBandwidthTbps.toFixed(3)} unit="TB/s" accent />
            <Metric label="Streaming" value={evaluation.streamingBandwidthTbps.toFixed(3)} unit="TB/s" />
            <Metric label="Banked random" value={evaluation.randomBandwidthTbps.toFixed(3)} unit="TB/s" />
            <Metric label="PHY link power" value={evaluation.phyPowerWatts.toFixed(2)} unit="W" />
            <Metric label="Bank fabric" value={evaluation.banks.toLocaleString()} unit="banks" />
          </div>

          {view === 'architecture' && <ArchitectureView config={config} evaluation={evaluation} selectedTier={selectedTier} setSelectedTier={setSelectedTier} selectedNode={selectedNode} />}
          {view === 'explore' && <ExploreView config={config} evaluation={evaluation} sweep={sweep} runStatus={runStatus} runProgress={runProgress} startSweep={startSweep} />}
          {view === 'gates' && <GatesView gates={evaluation.gates} />}

          <footer className="provenance-bar">
            <span><i className="status-dot" /> Inputs recalculated locally</span>
            <span>Spec: aimem-t0.json · rev 0.1.0</span>
            <span>Fidelity: analytical proxy · not silicon evidence</span>
          </footer>
        </section>

        <ControlPanel config={config} updateConfig={updateConfig} evaluation={evaluation} startSweep={startSweep} onReset={() => setConfig(DEFAULT_T0_CONFIG)} />
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
            <div className="plot-label y">Streaming efficiency</div>
            <div className="pareto-plot">
              <div className="grid-lines" />
              {sweep.map((point, index) => {
                const x = ((point.evaluation.rawBandwidthTbps - 0.45) / 1.15) * 100;
                const y = ((point.config.streamingEfficiencyPercent - 72) / 24) * 100;
                const size = 8 + point.config.sramMib / 4;
                return <button key={index} className={`plot-dot sram-${point.config.sramMib}`} style={{ left: `${Math.max(3, Math.min(97, x))}%`, bottom: `${Math.max(4, Math.min(95, y))}%`, width: size, height: size }} title={`${point.config.laneRateGbps} Gb/s · ${point.config.sramMib} MB · ${point.evaluation.rawBandwidthTbps.toFixed(3)} TB/s`} />;
              })}
            </div>
            <div className="plot-axis"><span>0.5</span><span>Raw bandwidth (TB/s)</span><span>1.6</span></div>
            <div className="plot-legend"><span><i className="sram-8" />8 MB</span><span><i className="sram-16" />16 MB</span><span><i className="sram-32" />32 MB</span></div>
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
              const passes = point.evaluation.gates.filter((gate) => gate.status === 'pass').length;
              return <div className="table-row" key={`${point.config.laneRateGbps}-${point.config.sramMib}`}><span><b>{index + 1}</b>{point.config.laneRateGbps} Gb/s · {point.config.sramMib} MB</span><span>{point.evaluation.rawBandwidthTbps.toFixed(3)}</span><span>{point.evaluation.streamingBandwidthTbps.toFixed(3)}</span><span>{point.evaluation.phyPowerWatts.toFixed(2)}</span><span className={passes >= 5 ? 'pass-text' : 'watch-text'}>{passes}/5 analytical</span></div>;
            })}
          </div>
        ) : <div className="empty-table">No sweep result yet. Current configuration remains available in the live estimate above.</div>}
      </section>
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
  return <span className={`gate-icon ${status}`} aria-hidden="true">{status === 'pass' ? '✓' : status === 'fail' ? '!' : '·'}</span>;
}
