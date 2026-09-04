'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { evaluateT0Campaign, type T0Campaign } from '@/lib/t0-campaign';
import { DEFAULT_T0_CONFIG, evaluateT0, runT0Sweep, type GateStatus, type T0Config } from '@/lib/t0-model';
import { evaluateT1DigitalCampaign, type T1DigitalCampaign } from '@/lib/t1-campaign';
import { DEFAULT_T1_CONFIG, evaluateT1, type T1Config } from '@/lib/t1-model';
import { evaluateT1PhysicalProxy, type T1PhysicalProxy } from '@/lib/t1-physical';
import { evaluateFoundryReadiness } from '@/lib/foundry-readiness';
import { DEFAULT_X1_CONFIG, evaluateX1, X1_STATE_TABLE, type X1Config, type X1PerformanceState } from '@/lib/x1-model';
import { AGENT_MISSIONS, AGENT_RUNTIME_STACK, evaluateAgentMission, type AgentMission, type AgentRunStatus } from '@/lib/agent-orchestration';
import { DIGITAL_MODULES, evaluateDigitalImplementation, type DigitalReviewScope } from '@/lib/digital-implementation';
import { evaluatePhysicalImplementation, type PhysicalReviewScope } from '@/lib/physical-implementation';
import correlation from '@/evidence/ramulator-correlation.json';
import rtlEvidence from '@/evidence/rtl-synthesis.json';
import physicalEvidence from '@/evidence/physical-synthesis.json';

type View = 'readiness' | 'architecture' | 'workloads' | 'correlation' | 'explore' | 'gates' | 'digital' | 'physical' | 't1' | 'foundry' | 'x1' | 'agents' | 'guide';
type UserLevel = 'beginner' | 'practitioner' | 'expert';
type SweepPoint = ReturnType<typeof runT0Sweep>[number];

const views: Array<{ id: View; label: string }> = [
  { id: 'readiness', label: 'Readiness' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'workloads', label: 'Workloads' },
  { id: 'correlation', label: 'Correlation' },
  { id: 'explore', label: 'Experiment' },
  { id: 'gates', label: 'Gates' },
  { id: 'digital', label: 'RTL + verification' },
  { id: 'physical', label: 'Physical implementation' },
  { id: 't1', label: 'T1 scale-up' },
  { id: 'foundry', label: 'Foundry readiness' },
  { id: 'x1', label: 'Production X1' },
  { id: 'agents', label: 'Agent operations' },
  { id: 'guide', label: 'User guide' },
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

const guideHierarchy = [
  { id: 'guide-start', label: 'Start here', meta: 'Choose your level' },
  { id: 'guide-workflow', label: 'End-to-end workflow', meta: '13 steps' },
  { id: 'guide-views', label: 'Platform views', meta: '12 workspaces' },
  { id: 'guide-roles', label: 'Role-based paths', meta: '6 disciplines' },
  { id: 'guide-evidence', label: 'Evidence language', meta: '4 statuses' },
  { id: 'guide-recipes', label: 'Practical recipes', meta: '8 walkthroughs' },
  { id: 'guide-help', label: 'Help & troubleshooting', meta: 'Common issues' },
];

const foundryHierarchy = [
  { id: 'foundry-boundary', label: 'Trust boundary', meta: '4 stages' },
  { id: 'foundry-inputs', label: 'Qualified inputs', meta: '8 contracts' },
  { id: 'foundry-approvals', label: 'Approval chain', meta: '6 decisions' },
  { id: 'foundry-policy', label: 'Release policy', meta: 'deny by default' },
  { id: 'foundry-roles', label: 'Human authority', meta: 'named owners' },
];

const x1Hierarchy = [
  { id: 'x1-system', label: 'Eight-stack system', meta: 'up to 1 TB' },
  { id: 'x1-stack', label: '16-high X1 stack', meta: '8,192 lanes' },
  { id: 'x1-base', label: '2 nm-class base die', meta: '128 MB SRAM' },
  { id: 'x1-noc', label: 'NoC regions', meta: '16 × 8 channels' },
  { id: 'x1-package', label: 'Active interposer', meta: 'distributed ports' },
  { id: 'x1-states', label: 'Performance states', meta: 'P0–P5' },
  { id: 'x1-gates', label: 'Production gates', meta: 'T1 evidence first' },
];

const agentHierarchy = [
  { id: 'agent-mission', label: 'Mission control', meta: '3 missions' },
  { id: 'agent-graph', label: 'Execution graph', meta: '11 agents' },
  { id: 'agent-events', label: 'Live event stream', meta: 'deterministic replay' },
  { id: 'agent-artifacts', label: 'Artifact ledger', meta: 'signed evidence' },
  { id: 'agent-runtime', label: 'Open-source runtime', meta: '10 components' },
  { id: 'agent-policy', label: 'Authority policy', meta: 'fail closed' },
];

const digitalHierarchy = [
  { id: 'digital-overview', label: 'Digital overview', meta: 'real evidence' },
  { id: 'digital-modules', label: 'RTL module graph', meta: '5 modules' },
  { id: 'digital-fsm', label: 'Controller state flow', meta: '5 states' },
  { id: 'digital-verification', label: 'Verification matrix', meta: '9 checks' },
  { id: 'digital-synthesis', label: 'Synthesis evidence', meta: 'open source' },
  { id: 'digital-closure', label: 'Closure backlog', meta: '3 gaps' },
];

const physicalHierarchy = [
  { id: 'physical-overview', label: 'Physical overview', meta: 'public-PDK proxy' },
  { id: 'physical-flow', label: 'Implementation flow', meta: '11 stages' },
  { id: 'physical-floorplan', label: 'Floorplan explorer', meta: 'live planning' },
  { id: 'physical-cells', label: 'Cell composition', meta: '2,447 mapped' },
  { id: 'physical-constraints', label: 'Timing contract', meta: '800 MHz target' },
  { id: 'physical-handoff', label: 'Signoff handoff', meta: '6 required outputs' },
];

export default function Home() {
  const [config, setConfig] = useState<T0Config>(DEFAULT_T0_CONFIG);
  const [view, setView] = useState<View>('physical');
  const [selectedNode, setSelectedNode] = useState('system');
  const [selectedTier, setSelectedTier] = useState(3);
  const [runProgress, setRunProgress] = useState(0);
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'complete'>('idle');
  const [sweep, setSweep] = useState<SweepPoint[]>([]);
  const [t1Config, setT1Config] = useState<T1Config>(DEFAULT_T1_CONFIG);
  const [x1Config, setX1Config] = useState<X1Config>(DEFAULT_X1_CONFIG);
  const [agentMission, setAgentMission] = useState<AgentMission>('x1-production');
  const [agentCompleted, setAgentCompleted] = useState(0);
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatus>('idle');
  const [digitalScope, setDigitalScope] = useState<DigitalReviewScope>('current');
  const [selectedDigitalModule, setSelectedDigitalModule] = useState('channel');
  const [physicalScope, setPhysicalScope] = useState<PhysicalReviewScope>('mapped');
  const [physicalUtilization, setPhysicalUtilization] = useState(55);
  const [selectedPhysicalStage, setSelectedPhysicalStage] = useState('mapping');
  const [userLevel, setUserLevel] = useState<UserLevel>('beginner');
  const timer = useRef<number | null>(null);
  const agentTimer = useRef<number | null>(null);
  const evaluation = useMemo(() => evaluateT0(config), [config]);
  const campaign = useMemo(() => evaluateT0Campaign(config), [config]);
  const t1Evaluation = useMemo(() => evaluateT1(t1Config, evaluation.gates), [t1Config, evaluation.gates]);
  const t1Campaign = useMemo(() => evaluateT1DigitalCampaign(t1Config), [t1Config]);
  const t1Physical = useMemo(() => evaluateT1PhysicalProxy(t1Config), [t1Config]);
  const foundryReadiness = useMemo(() => evaluateFoundryReadiness(evaluation.gates), [evaluation.gates]);
  const x1Evaluation = useMemo(() => evaluateX1(x1Config), [x1Config]);
  const agentEvaluation = useMemo(() => evaluateAgentMission(agentMission, agentCompleted, agentRunStatus), [agentMission, agentCompleted, agentRunStatus]);
  const digitalEvaluation = useMemo(() => evaluateDigitalImplementation(digitalScope, rtlEvidence), [digitalScope]);
  const physicalImplementation = useMemo(() => evaluatePhysicalImplementation(physicalScope, physicalUtilization, physicalEvidence), [physicalScope, physicalUtilization]);
  const activeHierarchy = view === 'guide' ? guideHierarchy : view === 'physical' ? physicalHierarchy : view === 'digital' ? digitalHierarchy : view === 'agents' ? agentHierarchy : view === 'x1' ? x1Hierarchy : view === 'foundry' ? foundryHierarchy : view === 't1' ? t1Hierarchy : hierarchy;

  useEffect(() => () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    if (agentTimer.current !== null) window.clearInterval(agentTimer.current);
  }, []);

  const resetAgentReplay = (mission: AgentMission = agentMission) => {
    if (agentTimer.current !== null) window.clearInterval(agentTimer.current);
    agentTimer.current = null;
    setAgentMission(mission);
    setAgentCompleted(0);
    setAgentRunStatus('idle');
  };

  const startAgentReplay = () => {
    if (agentTimer.current !== null) window.clearInterval(agentTimer.current);
    if (agentCompleted >= agentEvaluation.safeNodeCount) setAgentCompleted(0);
    setAgentRunStatus('running');
    agentTimer.current = window.setInterval(() => {
      setAgentCompleted((current) => {
        const next = Math.min(agentEvaluation.safeNodeCount, current + 1);
        if (next >= agentEvaluation.safeNodeCount) {
          if (agentTimer.current !== null) window.clearInterval(agentTimer.current);
          agentTimer.current = null;
          setAgentRunStatus('blocked');
        }
        return next;
      });
    }, 520);
  };

  const pauseAgentReplay = () => {
    if (agentTimer.current !== null) window.clearInterval(agentTimer.current);
    agentTimer.current = null;
    setAgentRunStatus('paused');
  };

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
      product: view === 'physical' ? 'AIMEM Design Studio Physical Implementation' : view === 'digital' ? 'AIMEM Design Studio Digital Implementation' : view === 'agents' ? 'AIMEM Design Studio Agent Mission Control' : view === 'x1' ? 'AIMEM-X1 Production Planner' : view === 't1' || view === 'foundry' ? 'AIMEM-X1 T1 Pathfinder' : 'AIMEM-X1 T0 Pathfinder',
      fidelity: 'multi-domain-open-source-proxy',
      generated_at: new Date().toISOString(),
      config,
      evaluation,
      campaign,
      t1: view === 't1' || view === 'foundry' ? { config: t1Config, evaluation: t1Evaluation, campaign: t1Campaign, physical: t1Physical, evidence_class: 'deterministic digital and coupled analytical physical proxy' } : undefined,
      foundry_readiness: view === 'foundry' ? foundryReadiness : undefined,
      production_x1: view === 'x1' ? { config: x1Config, evaluation: x1Evaluation, evidence_class: 'source-derived architecture plus deterministic system-planning proxies' } : undefined,
      agent_mission: view === 'agents' ? { mission: agentMission, run_status: agentRunStatus, evaluation: agentEvaluation, evidence_class: 'deterministic open-source orchestration replay' } : undefined,
      digital_implementation: view === 'digital' ? { scope: digitalScope, evaluation: digitalEvaluation, evidence_class: 'executed open-source RTL synthesis plus bounded formal and planned regressions' } : undefined,
      physical_implementation: view === 'physical' ? { scope: physicalScope, utilization_percent: physicalUtilization, evaluation: physicalImplementation, evidence_class: 'executed public-PDK mapping plus analytical floorplan planning' } : undefined,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = view === 'physical' ? 'aimem-physical-implementation-evidence.json' : view === 'digital' ? 'aimem-digital-implementation-evidence.json' : view === 'agents' ? 'aimem-agent-mission-evidence.json' : view === 'x1' ? 'aimem-x1-production-plan.json' : view === 'foundry' ? 'aimem-t1-foundry-readiness.json' : view === 't1' ? 'aimem-t1-snapshot.json' : 'aimem-t0-snapshot.json';
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
            <h1>{view === 'guide' ? 'Platform Guide' : view === 'physical' ? 'Physical Implementation' : view === 'digital' ? 'Digital Implementation' : view === 'agents' ? 'Agent Mission Control' : view === 'x1' ? 'Production X1' : view === 't1' || view === 'foundry' ? 'T1 Pathfinder' : 'T0 Pathfinder'}</h1>
          </div>
        </div>

        <nav className="view-tabs" aria-label="Workspace views">
          {views.map((item) => (
            <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); if (item.id === 'guide') setSelectedNode('guide-start'); }}>{item.label}</button>
          ))}
        </nav>

        <div className="top-actions">
          <span className="baseline-status"><i /> {view === 'guide' ? 'Guide · 3 levels · 6 roles' : view === 'physical' ? `${physicalEvidence.platform} · ${physicalEvidence.status}` : view === 'digital' ? `${rtlEvidence.tool} · ${rtlEvidence.status}` : view === 'agents' ? `${AGENT_MISSIONS[agentMission].label} · ${agentRunStatus}` : view === 'x1' ? 'Production target · HOLD' : view === 'foundry' ? 'Foundry contract · HOLD' : view === 't1' ? 'T1 · proxy rev 0.3' : 'Spec 0.4.0 · correlated'}</span>
          <button className="ghost-button" onClick={exportSnapshot}>Export evidence</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-rail">
          <section className="rail-section">
            <div className="section-heading"><span>{view === 'guide' ? 'Guide contents' : view === 'physical' ? 'Physical evidence flow' : view === 'digital' ? 'Digital evidence flow' : view === 'agents' ? 'Agent control plane' : view === 'x1' ? 'Production hierarchy' : view === 'foundry' ? 'Foundry-entry contract' : view === 't1' ? 'T1 derived hierarchy' : 'Design hierarchy'}</span><b>{activeHierarchy.length}</b></div>
            <div className="hierarchy-list">
              {activeHierarchy.map((item, index) => (
                <button key={item.id} className={(view === 't1' || view === 'foundry' || view === 'x1' || view === 'agents' || view === 'digital' || view === 'physical' ? index === 0 : selectedNode === item.id) ? 'selected' : ''} onClick={() => {
                  if (view === 'guide' || view === 'foundry' || view === 'x1' || view === 'agents' || view === 'digital' || view === 'physical') {
                    setSelectedNode(item.id);
                    document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  } else if (view !== 't1') {
                    setSelectedNode(item.id);
                    setView('architecture');
                  }
                }}>
                  <span className="tree-line" style={{ '--tree-depth': index === 0 ? 0 : 1 } as CSSProperties}><i /></span>
                  <span className="node-copy"><strong>{item.label}</strong><small>{item.meta}</small></span>
                </button>
              ))}
            </div>
          </section>

          <section className="rail-section evidence-summary">
            <div className="section-heading"><span>{view === 'guide' ? 'Guide coverage' : view === 'digital' ? 'Digital verification' : view === 'agents' ? 'Safe automation' : view === 'x1' ? 'T1 qualification' : view === 'foundry' ? 'Qualified inputs' : view === 't1' ? 'T1 entry verification' : 'Open-source readiness'}</span><b>{view === 'guide' ? 'E2E' : view === 'digital' ? `${digitalEvaluation.weightedReadiness}%` : view === 'agents' ? `${agentEvaluation.completedOpenNodes}/${agentEvaluation.safeNodeCount}` : view === 'x1' ? `${x1Evaluation.t1QualificationGatesPassed}/${x1Evaluation.t1QualificationGatesRequired}` : view === 'foundry' ? `${foundryReadiness.readyInputs}/${foundryReadiness.totalInputs}` : view === 't1' ? `${t1Evaluation.verifiedT0Gates}/12` : `${campaign.openSourceReadinessPercent.toFixed(0)}%`}</b></div>
            {view === 'guide' ? <><div className="evidence-bar" aria-label="End-to-end guide coverage complete"><i className="pass" style={{ width: '100%' }} /></div><div className="evidence-legend"><span><i className="dot pass" />Beginner</span><span><i className="dot provisional" />Practitioner</span><span><i className="dot pending" />Expert</span></div></> : view === 'digital' ? <><div className="evidence-bar" aria-label={`${digitalEvaluation.passCount} passed, ${digitalEvaluation.provisionalCount} provisional, ${digitalEvaluation.plannedCount} planned digital checks`}><i className="pass" style={{ width: `${(digitalEvaluation.passCount / digitalEvaluation.checks.length) * 100}%` }} /><i className="provisional" style={{ width: `${(digitalEvaluation.provisionalCount / digitalEvaluation.checks.length) * 100}%` }} /></div><div className="evidence-legend"><span><i className="dot pass" />{digitalEvaluation.passCount} pass</span><span><i className="dot provisional" />{digitalEvaluation.provisionalCount} proxy</span><span><i className="dot pending" />{digitalEvaluation.plannedCount} planned</span></div></> : view === 'agents' ? <><div className="evidence-bar" aria-label={`${agentEvaluation.completedOpenNodes} of ${agentEvaluation.safeNodeCount} safe automation nodes replayed`}><i className="pass" style={{ width: `${agentEvaluation.progressPercent}%` }} /></div><div className="evidence-legend"><span><i className="dot pass" />{agentEvaluation.completedOpenNodes} complete</span><span><i className="dot provisional" />{agentEvaluation.activeCount} active</span><span><i className="dot pending" />{agentEvaluation.blockedCount} boundary stops</span></div></> : view === 'x1' ? <><div className="evidence-bar" aria-label="Zero of four T1 production qualification gates have measured evidence"><i className="provisional" style={{ width: '25%' }} /></div><div className="evidence-legend"><span><i className="dot provisional" />Architecture modeled</span><span><i className="dot pending" />4 T1 gates blocked</span></div></> : view === 'foundry' ? <><div className="evidence-bar" aria-label={`${foundryReadiness.readyInputs} ready, ${foundryReadiness.plannedInputs} planned, ${foundryReadiness.absentInputs} absent inputs`}><i className="pass" style={{ width: `${(foundryReadiness.readyInputs / foundryReadiness.totalInputs) * 100}%` }} /><i className="provisional" style={{ width: `${(foundryReadiness.plannedInputs / foundryReadiness.totalInputs) * 100}%` }} /></div><div className="evidence-legend"><span><i className="dot pass" />{foundryReadiness.readyInputs} ready</span><span><i className="dot provisional" />{foundryReadiness.plannedInputs} planned</span><span><i className="dot pending" />{foundryReadiness.absentInputs} absent</span></div></> : <><div className="evidence-bar" aria-label={`${passCount} analytical gates pass, ${failCount} fail`}><i className="pass" style={{ width: `${(passCount / 12) * 100}%` }} /><i className="provisional" style={{ width: `${(provisionalCount / 12) * 100}%` }} /><i className="fail" style={{ width: `${(failCount / 12) * 100}%` }} /></div><div className="evidence-legend"><span><i className="dot provisional" />{provisionalCount} proxy</span><span><i className="dot fail" />{failCount} fail</span><span><i className="dot pending" />{12 - passCount - provisionalCount - failCount} external</span></div></>}
          </section>

          <section className="assistant-card">
            <div className="assistant-head"><span className="agent-glyph">A</span><div><p>{view === 'guide' ? 'Embedded guide' : view === 'physical' ? 'Physical implementation agent' : view === 'digital' ? 'RTL verification agent' : view === 'agents' ? 'Mission supervisor' : view === 'x1' ? 'Production systems agent' : view === 'foundry' ? 'Foundry entry agent' : view === 't1' ? 'T1 scale-up agent' : 'T0 program agent'}</p><small>Evidence-aware guidance</small></div></div>
            <p className="assistant-tag watch">{view === 'guide' ? 'Start with the guided workflow; every result links to its evidence class' : view === 'physical' ? 'Public-PDK cell mapping passes; place, route, extraction, timing, DRC/LVS, and production signoff remain open' : view === 'digital' ? 'Executed synthesis and bounded proof pass; complete datapath and randomized RTL closure remain open' : view === 'agents' ? 'Automation may prepare evidence; physical and human boundaries always stop the run' : view === 'x1' ? 'Production architecture may be explored; promotion remains blocked on T1 proof' : view === 'foundry' ? 'Foundry entry remains on hold; the secure handoff contract is prepared' : view === 't1' ? 'Digital planning may proceed; physical entry remains on hold' : 'Open-source milestone implemented; silicon remains gated'}</p>
            <p className="assistant-detail">{view === 'guide' ? 'Choose a level, follow the thirteen-step flow, then use the role paths and recipes for deeper work.' : view === 'physical' ? physicalImplementation.nextArtifact : view === 'digital' ? digitalEvaluation.nextArtifact : view === 'agents' ? agentEvaluation.currentNode.stopRule : view === 'x1' ? `Current system bottleneck: ${x1Evaluation.bottleneck}. Zero of four T1 qualification gates have measured evidence.` : view === 'foundry' ? foundryReadiness.blockers[0] : view === 't1' ? 'Close measured T0 gates before committing a 2 nm implementation or production-style package.' : campaign.blockers[0]}</p>
            <button onClick={() => setView(view === 'guide' ? 'readiness' : view === 'physical' ? 'digital' : view === 'digital' ? 'agents' : view === 'agents' ? 'foundry' : view === 'x1' ? 't1' : view === 'foundry' || view === 't1' ? 'gates' : 'readiness')}>{view === 'guide' ? 'Open first workspace' : view === 'physical' ? 'Review RTL source' : view === 'digital' ? 'Return to agent mission' : view === 'agents' ? 'Review trust boundary' : view === 'x1' ? 'Review T1 evidence' : view === 'foundry' || view === 't1' ? 'Audit T0 gates' : 'Review readiness'} <span>→</span></button>
          </section>
        </aside>

        <section className="main-stage">
          <div className="stage-header">
            <div>
              <p className="eyebrow">{view === 'guide' ? 'Embedded learning center' : view === 'physical' ? 'Public-PDK implementation evidence' : view === 'digital' ? 'Open-source execution evidence' : view === 'agents' ? 'Evidence-aware orchestration' : view === 'x1' ? 'Final architecture target' : view === 'foundry' ? 'Restricted-lane control plane' : view === 't1' ? 'Next hardware milestone' : view === 'readiness' ? 'Program control plane' : view === 'architecture' ? 'Executable architecture' : view === 'workloads' ? 'Deterministic cycle campaign' : view === 'correlation' ? 'Independent memory reference' : view === 'explore' ? 'Design-space experiment' : 'T0 decision matrix'}</p>
              <h2>{view === 'guide' ? 'End-to-end user guide' : view === 'physical' ? 'Physical implementation lab' : view === 'digital' ? 'RTL & verification lab' : view === 'agents' ? 'AI Agent Mission Control' : view === 'x1' ? 'Production X1 system planner' : view === 'foundry' ? 'T1 foundry-entry readiness' : view === 't1' ? 'T1 engineering sample' : view === 'readiness' ? 'T0 evidence readiness' : view === 'architecture' ? 'T0 memory system' : view === 'workloads' ? 'Workload verification' : view === 'correlation' ? 'Ramulator2 correlation' : view === 'explore' ? 'Analytical sweep' : 'Evidence gates'}</h2>
              <p>{view === 'guide' ? 'Learn the complete platform workflow at your experience level, then jump directly into each workspace with the right evidence expectations.' : view === 'physical' ? 'Trace the public-PDK flow from mapped cells and timing constraints through floorplanning, placement, clocking, routing, extraction, physical verification, and the restricted production boundary.' : view === 'digital' ? 'Inspect the real T0 RTL hierarchy, controller flow, bounded formal properties, synthesis metrics, verification status, and the exact artifacts still required for digital closure.' : view === 'agents' ? 'Coordinate requirements, architecture, performance, RTL, formal, physical, multiphysics, and evidence agents—then stop safely at silicon, foundry, and human approval boundaries.' : view === 'x1' ? 'Explore the source-defined 16-high, 8,192-lane production stack and its eight-stack accelerator system while preserving the T1 evidence gate.' : view === 'foundry' ? 'Prepare a secure, auditable path from the open-source control plane into a future authorized foundry enclave—without moving proprietary inputs into this platform.' : view === 't1' ? 'Plan the 8-high, 4,096-lane scale-up while preserving the boundary between open-source engineering proxies and foundry-qualified evidence.' : view === 'readiness' ? 'One traceable view of architecture, RTL, formal, physical, thermal, release, and external silicon evidence.' : view === 'architecture' ? 'Four DRAM tiers over a distributed intelligent base die, connected by a 1,024-lane short-reach interface.' : view === 'workloads' ? 'Seeded request-level simulations expose bandwidth, latency, row locality, queueing, gather value, and refresh interference.' : view === 'correlation' ? 'A pinned official Ramulator2 HBM3 lane checks workload ordering, row locality, and the internal model’s absolute latency scale.' : view === 'explore' ? 'Compare lane rate and SRAM variants using transparent analytical proxies.' : 'Twelve source-derived gates separate assumptions from verified engineering evidence.'}</p>
            </div>
            <div className="stage-actions">
              <span className={`fidelity-pill ${view === 'guide' || view === 'physical' || view === 'digital' || view === 't1' || view === 'foundry' || view === 'x1' || view === 'agents' ? 'running' : runStatus}`}>{view === 'guide' ? `${userLevel} path` : view === 'physical' ? `${physicalScope} · ${physicalEvidence.status}` : view === 'digital' ? `${digitalScope} · ${rtlEvidence.status}` : view === 'agents' ? `${agentRunStatus} · ${agentEvaluation.progressPercent}%` : view === 'x1' ? `${x1Evaluation.state.id} · production hold` : view === 'foundry' ? 'Policy enforced · hold' : view === 't1' ? 'Draft baseline · entry hold' : runStatus === 'running' ? `Running ${runProgress}%` : runStatus === 'complete' ? 'Sweep complete' : 'Evidence rev 0.4'}</span>
              <button className="primary-button" onClick={view === 'guide' ? () => setView('readiness') : view === 'physical' ? () => setPhysicalScope(physicalScope === 'mapped' ? 'implementation' : physicalScope === 'implementation' ? 'signoff' : 'mapped') : view === 'digital' ? () => setDigitalScope(digitalScope === 'current' ? 'regression' : digitalScope === 'regression' ? 'closure' : 'current') : view === 'agents' ? agentRunStatus === 'running' ? pauseAgentReplay : startAgentReplay : view === 'x1' ? () => setView('t1') : view === 'foundry' || view === 't1' ? () => setView('gates') : startSweep}>{view === 'guide' ? 'Start guided workflow' : view === 'physical' ? 'Advance implementation scope' : view === 'digital' ? 'Advance review scope' : view === 'agents' ? agentRunStatus === 'running' ? 'Pause replay' : agentRunStatus === 'blocked' ? 'Replay again' : 'Run mission replay' : view === 'x1' ? 'Review T1 qualification' : view === 'foundry' ? 'Review blocking gates' : view === 't1' ? 'Review T0 entry gates' : runStatus === 'running' ? 'Running sweep…' : 'Run architecture sweep'}</button>
            </div>
          </div>

          {view === 'guide' ? (
            <div className="metric-strip">
              <Metric label="Experience levels" value="3" unit="paths" accent />
              <Metric label="Workflow steps" value="13" unit="steps" />
              <Metric label="Platform views" value="12" unit="views" />
              <Metric label="Role tracks" value="6" unit="roles" />
              <Metric label="Evidence states" value="4" unit="states" />
            </div>
          ) : view === 'physical' ? (
            <div className="metric-strip">
              <Metric label="Mapped cells" value={physicalImplementation.evidence.mapped_cells.toLocaleString()} unit="Sky130" accent />
              <Metric label="Cell area" value={physicalImplementation.evidence.chip_area_um2.toLocaleString(undefined, { maximumFractionDigits: 0 })} unit="µm²" />
              <Metric label="Clock target" value={String(physicalImplementation.evidence.clock_target_mhz)} unit="MHz" />
              <Metric label="Flow stages" value={String(physicalImplementation.passedStages)} unit={`/${physicalImplementation.stages.length} pass`} />
              <Metric label="Physical decision" value="HOLD" unit="proxy" />
            </div>
          ) : view === 'digital' ? (
            <div className="metric-strip">
              <Metric label="RTL modules" value={String(digitalEvaluation.moduleCount)} unit="blocks" accent />
              <Metric label="Generic cells" value={digitalEvaluation.evidence.cells.toLocaleString()} unit="cells" />
              <Metric label="Formal proofs" value={String(digitalEvaluation.evidence.formal_proofs)} unit="bounded" />
              <Metric label="Evidence checks" value={String(digitalEvaluation.passCount)} unit={`/${digitalEvaluation.checks.length} pass`} />
              <Metric label="Digital decision" value="HOLD" unit="closure" />
            </div>
          ) : view === 'agents' ? (
            <div className="metric-strip">
              <Metric label="Mission progress" value={String(agentEvaluation.progressPercent)} unit="%" accent />
              <Metric label="Open agents" value={String(agentEvaluation.safeNodeCount)} unit="safe" />
              <Metric label="Artifacts ready" value={String(agentEvaluation.artifactsReady.length)} unit="signed targets" />
              <Metric label="Boundary stops" value={String(agentEvaluation.blockedCount)} unit="mandatory" />
              <Metric label="Release decision" value="HOLD" unit="human" />
            </div>
          ) : view === 'x1' ? (
            <div className="metric-strip">
              <Metric label="Per-stack raw" value={x1Evaluation.rawBandwidthPerStackTbps.toFixed(3)} unit="TB/s" accent />
              <Metric label="System capacity" value={x1Evaluation.totalCapacityGib >= 1024 ? (x1Evaluation.totalCapacityGib / 1024).toFixed(0) : String(x1Evaluation.totalCapacityGib)} unit={x1Evaluation.totalCapacityGib >= 1024 ? 'TB' : 'GB'} />
              <Metric label="Aggregate raw" value={x1Evaluation.aggregateRawBandwidthTbps.toFixed(3)} unit="TB/s" />
              <Metric label="Delivered proxy" value={x1Evaluation.deliveredBandwidthTbps.toFixed(1)} unit="TB/s" />
              <Metric label="T1 qualification" value={String(x1Evaluation.t1QualificationGatesPassed)} unit={`/${x1Evaluation.t1QualificationGatesRequired}`} />
            </div>
          ) : view === 'foundry' ? (
            <div className="metric-strip">
              <Metric label="Entry decision" value="HOLD" unit="policy" accent />
              <Metric label="Measured T0 gates" value={String(foundryReadiness.verifiedT0Gates)} unit={`/${foundryReadiness.requiredT0Gates}`} />
              <Metric label="Qualified inputs" value={String(foundryReadiness.readyInputs)} unit={`/${foundryReadiness.totalInputs}`} />
              <Metric label="Boundary stages" value={String(foundryReadiness.boundary.length)} unit="stages" />
              <Metric label="Human approvals" value={String(foundryReadiness.approvals.length)} unit="required" />
            </div>
          ) : view === 't1' ? (
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
          {view === 'digital' && <DigitalImplementationView evaluation={digitalEvaluation} selectedModule={selectedDigitalModule} setSelectedModule={setSelectedDigitalModule} />}
          {view === 'physical' && <PhysicalImplementationView evaluation={physicalImplementation} selectedStage={selectedPhysicalStage} setSelectedStage={setSelectedPhysicalStage} />}
          {view === 't1' && <T1ScaleUpView config={t1Config} evaluation={t1Evaluation} campaign={t1Campaign} physical={t1Physical} />}
          {view === 'foundry' && <FoundryReadinessView readiness={foundryReadiness} />}
          {view === 'x1' && <ProductionX1View config={x1Config} evaluation={x1Evaluation} />}
          {view === 'agents' && <AgentMissionControlView evaluation={agentEvaluation} runStatus={agentRunStatus} navigate={setView} />}
          {view === 'guide' && <GuideView level={userLevel} setLevel={setUserLevel} navigate={setView} />}

          <footer className="provenance-bar">
            <span><i className="status-dot" /> Inputs recalculated locally</span>
            <span>{view === 'guide' ? 'Guide: embedded · contextual · role-aware' : view === 'physical' ? 'Evidence: physical-synthesis.json · Sky130 public-platform mapping' : view === 'digital' ? 'Evidence: rtl-synthesis.json · reproducible open-source execution' : view === 'agents' ? 'Contract: orchestration-contract.json · open-source runtime' : view === 'x1' ? 'Spec: aimem-x1-production.json · architecture planning' : view === 'foundry' ? 'Contract: t1-enclave-handoff.json · schema 1.0.0' : view === 't1' ? 'Spec: aimem-t1.json · draft baseline 0.1.0' : 'Spec: aimem-t0.json · evidence rev 0.4.0'}</span>
            <span>{view === 'guide' ? 'Use the evidence labels before making any engineering decision' : view === 'physical' ? 'Pre-placement cell mapping · not routed timing, physical verification, production signoff, or silicon evidence' : view === 'digital' ? 'Generic synthesis + bounded proof · not timing closure, full RTL verification, or silicon evidence' : view === 'agents' ? 'Replay is deterministic visualization · no external tool or foundry job is launched' : view === 'x1' ? 'Fidelity: source-derived architecture + deterministic system proxy · T1 evidence absent' : view === 'foundry' ? 'No proprietary PDK, IP, package, or signoff data is bundled or exported' : view === 't1' ? 'Fidelity: derived architecture + open-source planning proxies · foundry evidence absent' : 'Fidelity: analytical + Ramulator2 + RTL/formal + Sky130 proxy · not silicon evidence'}</span>
          </footer>
        </section>

        {view === 'guide' ? <GuideControlPanel level={userLevel} setLevel={setUserLevel} navigate={setView} /> : view === 'physical' ? <PhysicalControlPanel scope={physicalScope} setScope={setPhysicalScope} utilization={physicalUtilization} setUtilization={setPhysicalUtilization} evaluation={physicalImplementation} selectedStage={selectedPhysicalStage} setSelectedStage={setSelectedPhysicalStage} navigate={setView} /> : view === 'digital' ? <DigitalControlPanel scope={digitalScope} setScope={setDigitalScope} evaluation={digitalEvaluation} selectedModule={selectedDigitalModule} setSelectedModule={setSelectedDigitalModule} navigate={setView} /> : view === 'agents' ? <AgentControlPanel mission={agentMission} evaluation={agentEvaluation} runStatus={agentRunStatus} onMissionChange={resetAgentReplay} onStart={startAgentReplay} onPause={pauseAgentReplay} onReset={() => resetAgentReplay()} navigate={setView} /> : view === 'x1' ? <X1ControlPanel config={x1Config} updateConfig={setX1Config} evaluation={x1Evaluation} navigate={setView} /> : view === 'foundry' ? <FoundryControlPanel readiness={foundryReadiness} navigate={setView} /> : view === 't1' ? <T1ControlPanel config={t1Config} updateConfig={setT1Config} evaluation={t1Evaluation} campaign={t1Campaign} physical={t1Physical} /> : <ControlPanel config={config} updateConfig={updateConfig} evaluation={evaluation} startSweep={startSweep} onReset={() => setConfig(DEFAULT_T0_CONFIG)} />}
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

function GuideView({ level, setLevel, navigate }: {
  level: UserLevel;
  setLevel: (level: UserLevel) => void;
  navigate: (view: View) => void;
}) {
  const levelContent = {
    beginner: { label: 'Beginner', time: '15-minute orientation', goal: 'Understand what the platform shows, change a safe parameter, and distinguish a model from proof.', detail: 'No chip-design or EDA background is required. Technical terms are explained where they first appear.' },
    practitioner: { label: 'Practitioner', time: '45-minute working session', goal: 'Run a reproducible comparison, inspect workload and gate evidence, and export a reviewable snapshot.', detail: 'Best for architects, performance engineers, RTL/verification engineers, and technical product staff.' },
    expert: { label: 'Expert', time: 'Evidence-review workflow', goal: 'Challenge assumptions, trace proxy fidelity, define replacement artifacts, and prepare cross-domain handoffs.', detail: 'Best for domain leads reviewing architecture, PPA, verification, package, thermal, or foundry readiness.' },
  } as const;
  const currentLevel = levelContent[level];
  const workflow: Array<{ number: string; title: string; view: View | null; action: string; output: string; stop: string }> = [
    { number: '01', title: 'Read the readiness summary', view: 'readiness', action: 'Start with the completion contract, domain maturity cards, reliability results, and blockers.', output: 'A shared understanding of what is implemented, provisional, external, or missing.', stop: 'Do not interpret open-source readiness as measured silicon readiness.' },
    { number: '02', title: 'Inspect the architecture', view: 'architecture', action: 'Select hierarchy nodes and DRAM tiers; review channels, pseudochannels, banks, SRAM, NoC regions, and useful-delivery proxies.', output: 'A concrete mental model of the current T0 organization and calculated bandwidth.', stop: 'Dimensions shown as concepts or assumptions still require physical evidence.' },
    { number: '03', title: 'Review workload behavior', view: 'workloads', action: 'Compare dense stream, banked random, KV decode, and sparse gather using identical seeded request counts.', output: 'Bandwidth, latency, row-locality, queueing, refresh, and host-traffic-reduction evidence.', stop: 'Request-level projections are not RTL timing or measured application performance.' },
    { number: '04', title: 'Check independent correlation', view: 'correlation', action: 'Compare the internal model with pinned Ramulator2 results and read the accept/rework/hold decision.', output: 'A transparent view of relative agreement and the remaining absolute-latency calibration gap.', stop: 'Never hide a scale mismatch because workload ordering agrees.' },
    { number: '05', title: 'Run a design-space experiment', view: 'explore', action: 'Adjust T0 controls, run the 12-point lane-rate/SRAM sweep, inspect the chart, and compare ranked candidates.', output: 'A reproducible candidate comparison with bandwidth, power, and proxy-gate context.', stop: 'Treat a favorable point as a hypothesis until higher-fidelity evidence replaces it.' },
    { number: '06', title: 'Audit decision gates', view: 'gates', action: 'Read each target, current observation, evidence type, and status before recommending promotion.', output: 'A requirement-by-requirement decision record and explicit list of missing proof.', stop: 'An agent explanation can never upgrade a gate without its named artifact.' },
    { number: '07', title: 'Inspect digital implementation', view: 'digital', action: 'Trace the five RTL modules, controller state flow, reproduced synthesis evidence, bounded proofs, and verification backlog.', output: 'A module-level digital evidence review with exact pass, provisional, and planned checks.', stop: 'Generic synthesis and bounded proof do not imply complete RTL verification, timing closure, production mapping, or silicon behavior.' },
    { number: '08', title: 'Plan physical implementation', view: 'physical', action: 'Review the mapped Sky130 cells, select each implementation stage, vary target utilization, and inspect the timing and evidence handoff contracts.', output: 'A public-PDK physical plan connected to reproduced mapping evidence and explicit required outputs.', stop: 'Floorplan dimensions and routing pressure are analytical planning values until OpenROAD artifacts replace them.' },
    { number: '09', title: 'Explore the T1 scale-up', view: 't1', action: 'Sweep capacity, lane rate, PHY energy, bond pitch, route length, cooling, and activity; inspect digital and multiphysics proxies.', output: 'A bounded 8-high, 4,096-lane T1 research plan with solver handoffs.', stop: 'Foundry entry stays on hold until measured T0 and qualified process/package evidence exists.' },
    { number: '10', title: 'Prepare foundry entry', view: 'foundry', action: 'Review the trust boundary, qualified inputs, approval chain, release policy, and named human owners.', output: 'A secure handoff contract that keeps proprietary inputs inside an authorized enclave.', stop: 'A prepared contract is not fabrication authorization; every measured gate, qualified input, and human approval remains mandatory.' },
    { number: '11', title: 'Balance the Production X1 system', view: 'x1', action: 'Sweep stack count, capacity, performance state, demand, efficiency, accelerator ingest, route layers, and distributed ports.', output: 'A deterministic 16-high stack and multi-stack system plan with an explicit bottleneck and production gate state.', stop: 'Production architecture exploration remains blocked from promotion until the four measured T1 qualification outcomes pass.' },
    { number: '12', title: 'Orchestrate an agent mission', view: 'agents', action: 'Choose T0 closure, T1 qualification, or Production X1; replay the open automation lane and inspect the dependency graph, event stream, artifacts, runtime, and authority policy.', output: 'A transparent execution plan that completes safe software work and stops at physical, restricted, and human boundaries.', stop: 'The replay is a deterministic orchestration visualization; it does not launch EDA, lab, or foundry jobs.' },
    { number: '13', title: 'Export and review', view: null, action: 'Use Export evidence in the header after setting the desired configuration. Store the JSON with the review decision and source revision.', output: 'A portable snapshot of configuration, calculations, campaign results, evidence class, and timestamp.', stop: 'The export records the current model state; it is not a signed release or signoff certificate.' },
  ];
  const workspaceCards: Array<{ view: View; title: string; purpose: string; firstQuestion: string }> = [
    { view: 'readiness', title: 'Readiness', purpose: 'Program-level evidence and blockers', firstQuestion: 'What is actually complete, and what still depends on external proof?' },
    { view: 'architecture', title: 'Architecture', purpose: 'T0 hierarchy and organization', firstQuestion: 'How do lanes, channels, banks, tiers, SRAM, and NoC regions connect?' },
    { view: 'workloads', title: 'Workloads', purpose: 'Deterministic traffic behavior', firstQuestion: 'Which access patterns benefit, stall, or create queue pressure?' },
    { view: 'correlation', title: 'Correlation', purpose: 'Independent-model comparison', firstQuestion: 'Where does Ramulator2 agree, and where must the internal model be recalibrated?' },
    { view: 'explore', title: 'Experiment', purpose: 'T0 parameter sweep and ranking', firstQuestion: 'Which candidate trades bandwidth, SRAM, PHY power, and risk most effectively?' },
    { view: 'gates', title: 'Gates', purpose: 'Requirement-level decision audit', firstQuestion: 'What evidence is required before a result can be called passing?' },
    { view: 'digital', title: 'RTL + verification', purpose: 'Executable digital implementation evidence', firstQuestion: 'Which modules and properties pass today, and what is still required for RTL closure?' },
    { view: 'physical', title: 'Physical implementation', purpose: 'Public-PDK mapping and implementation handoff', firstQuestion: 'What has physically mapped, and which place-and-route artifacts remain absent?' },
    { view: 't1', title: 'T1 scale-up', purpose: 'Next-milestone digital and physical proxies', firstQuestion: 'What breaks when the stack, lanes, SRAM, routing, and thermal load scale up?' },
    { view: 'foundry', title: 'Foundry readiness', purpose: 'Secure restricted-lane handoff', firstQuestion: 'Which inputs, controls, and human approvals are still required before fabrication review?' },
    { view: 'x1', title: 'Production X1', purpose: 'Full-stack and accelerator-system planning', firstQuestion: 'Can the package and accelerator consume the bandwidth exposed by up to eight production stacks?' },
    { view: 'agents', title: 'Agent operations', purpose: 'End-to-end governed orchestration', firstQuestion: 'Which agents may act now, what will they produce, and where must automation stop?' },
  ];
  const roles = [
    ['New user / executive', 'Readiness → Gates → Agents → X1', 'Focus on decision state, blockers, evidence class, ownership, and irreversible-spend boundaries.'],
    ['System architect', 'Architecture → Workloads → Experiment → Gates', 'Challenge organization, address mapping, efficiency assumptions, and rejected alternatives.'],
    ['Performance engineer', 'Workloads → Correlation → Experiment', 'Compare seeded workloads, inspect latency/locality gaps, and preserve input lineage.'],
    ['RTL / verification engineer', 'Architecture → Digital → Gates → Agents', 'Trace implementation blocks, audit bounded proofs, plan randomized regressions, and preserve evidence lineage.'],
    ['Physical / package / thermal engineer', 'Digital → Physical → T1 → Foundry', 'Replace analytical indicators with OpenROAD, openEMS, Elmer, and OpenFOAM artifacts, then define qualified signoff handoffs.'],
    ['Program or release lead', 'Readiness → Gates → Agents → Foundry → Export', 'Require reproducibility, review dependencies, record waivers, and prevent unsupported promotion.'],
  ];
  const evidenceStates = [
    ['Pass', 'The named verification method and required artifact satisfy the gate. Use only when the evidence contract is met.'],
    ['Provisional', 'A useful analytical, cycle, RTL, formal, or physical proxy exists, but higher-fidelity replacement evidence is still required.'],
    ['Fail', 'The current observation misses the target. Change the design or the approved requirement—never relabel the result.'],
    ['Unverified', 'The required evidence does not exist yet. Absence of a failure is not evidence of success.'],
  ];
  const recipes = [
    { title: 'Validate the T0 nominal baseline', level: 'Beginner', steps: ['Open Architecture and confirm 16 × 64-bit = 1,024 lanes.', 'Confirm 8 Gb/s produces 1.024 TB/s raw bandwidth.', 'Open Gates and verify the bandwidth result is provisional—not measured.', 'Export the snapshot and record the review purpose.'] },
    { title: 'Compare a T0 bandwidth variant', level: 'Practitioner', steps: ['Open Experiment.', 'Change lane rate, SRAM, route length, or PHY energy in the right rail.', 'Run the 12-point sweep and inspect exact chart values.', 'Compare the ranked candidates and review any failed or high-risk indicators.'] },
    { title: 'Stress the T1 cooling concept', level: 'Practitioner', steps: ['Open T1 scale-up.', 'Raise active workload and cooling resistance.', 'Compare hotspot and margin against the 85°C provisional limit.', 'Capture the configuration and define the Elmer/OpenFOAM artifact needed to replace the proxy.'] },
    { title: 'Prepare an expert evidence review', level: 'Expert', steps: ['Start at Readiness and list incomplete domains.', 'Use Correlation and Gates to identify model-calibration and proof gaps.', 'Use T1 solver handoffs to assign replacement artifacts and owners.', 'Export the evidence snapshot; attach decisions, waivers, expiry, and independent-review status outside the current prototype.'] },
    { title: 'Balance a Production X1 system', level: 'Expert', steps: ['Open Production X1 and select the intended stack count and P-state.', 'Set memory efficiency and workload demand, then size accelerator fabric ingest.', 'Increase route layers or distributed ports until routing pressure is reviewable.', 'Export the plan with the HOLD decision and assign the four missing T1 qualification artifacts.'] },
    { title: 'Replay a governed agent mission', level: 'Practitioner', steps: ['Open Agent operations and choose a T0, T1, or X1 mission.', 'Start the deterministic replay and watch each open-source agent complete.', 'Inspect the artifact ledger and mandatory silicon, foundry, and human stops.', 'Export the mission snapshot without relabeling the replay as real tool execution.'] },
    { title: 'Review digital implementation evidence', level: 'Expert', steps: ['Open RTL + verification and select each implementation module.', 'Compare the five passed checks with the provisional and planned work.', 'Advance from current evidence to regression and closure planning scopes.', 'Export the digital evidence snapshot with the HOLD decision and next artifact.'] },
    { title: 'Prepare a physical implementation handoff', level: 'Expert', steps: ['Open Physical implementation and audit the two reproduced mapping stages.', 'Adjust utilization to inspect planning geometry and routing pressure.', 'Select every placement-through-verification stage and read its required artifact.', 'Export the physical snapshot while keeping production signoff in the restricted lane.'] },
  ];

  return (
    <div className="guide-layout">
      <section className="panel guide-hero" id="guide-start">
        <div><p className="eyebrow accent">Choose your learning path</p><h3>From first orientation to evidence-review discipline.</h3><p>This guide explains what to click, what each result means, what it does not prove, and how to move a design decision from assumption to reproducible evidence.</p></div>
        <div className="guide-level-switch" role="group" aria-label="User experience level">{(Object.keys(levelContent) as UserLevel[]).map((item) => <button key={item} className={level === item ? 'active' : ''} onClick={() => setLevel(item)} aria-pressed={level === item}><strong>{levelContent[item].label}</strong><span>{levelContent[item].time}</span></button>)}</div>
        <div className="guide-level-summary"><span>Current path</span><strong>{currentLevel.label}</strong><p>{currentLevel.goal}</p><small>{currentLevel.detail}</small></div>
      </section>

      <section className="panel guide-workflow-panel" id="guide-workflow">
        <PanelTitle label="End-to-end operating workflow" meta={`${currentLevel.label} path · thirteen steps`} />
        <div className="guide-workflow">{workflow.map((step) => <article key={step.number}><b>{step.number}</b><div><h3>{step.title}</h3><p>{step.action}</p><dl><div><dt>Expected output</dt><dd>{step.output}</dd></div><div><dt>Evidence stop</dt><dd>{step.stop}</dd></div></dl></div>{step.view ? <button onClick={() => navigate(step.view)}>Open {step.view === 'explore' ? 'experiment' : step.view}<span>→</span></button> : <span className="guide-header-hint">Header action</span>}</article>)}</div>
      </section>

      <section className="panel guide-views-panel" id="guide-views">
        <PanelTitle label="Platform view map" meta="Where to go and why" />
        <div className="guide-view-grid">{workspaceCards.map((card, index) => <article key={card.view}><div><b>{String(index + 1).padStart(2, '0')}</b><span>{card.purpose}</span></div><h3>{card.title}</h3><p>{card.firstQuestion}</p><button onClick={() => navigate(card.view)}>Open workspace <span>→</span></button></article>)}</div>
      </section>

      <section className="panel guide-roles-panel" id="guide-roles">
        <PanelTitle label="Role-based learning paths" meta="Use the shortest path for your responsibility" />
        <div className="guide-role-grid">{roles.map(([role, path, focus]) => <article key={role}><h3>{role}</h3><span>{path}</span><p>{focus}</p></article>)}</div>
      </section>

      <section className="panel guide-evidence-panel" id="guide-evidence">
        <PanelTitle label="How to read evidence status" meta="The most important platform vocabulary" />
        <div className="guide-evidence-grid">{evidenceStates.map(([state, meaning]) => <article key={state} className={state.toLowerCase()}><span>{state}</span><p>{meaning}</p></article>)}</div>
        <div className="guide-rule"><strong>Core rule</strong><p>Models guide decisions; named artifacts justify decisions. AI-generated explanations, attractive charts, and successful software execution cannot substitute for missing RTL, formal, extracted, package, foundry, or silicon evidence.</p></div>
      </section>

      <section className="panel guide-recipes-panel" id="guide-recipes">
        <PanelTitle label="Practical walkthroughs" meta="Repeatable tasks for common goals" />
        <div className="guide-recipe-grid">{recipes.map((recipe) => <article key={recipe.title}><div><span>{recipe.level}</span><b>{recipe.steps.length} steps</b></div><h3>{recipe.title}</h3><ol>{recipe.steps.map((step) => <li key={step}>{step}</li>)}</ol></article>)}</div>
      </section>

      <section className="panel guide-help-panel" id="guide-help">
        <PanelTitle label="Help, accessibility, and troubleshooting" meta="Answers remain inside the product" />
        <div className="guide-help-grid">
          <div><h3>Controls and navigation</h3><p>Top tabs change workspaces. The left rail selects hierarchy or guide topics. The right rail changes the active model. Segmented buttons choose fixed modes; sliders update calculated results immediately. Reset restores the approved baseline.</p><p>Keyboard users can tab through controls and chart points. On smaller screens, top tabs and wide evidence tables scroll horizontally.</p></div>
          <div className="guide-faq"><details open><summary>Why did a metric change but a gate remain provisional?</summary><p>A recalculated value is still the same evidence class. The gate changes only when its required higher-fidelity artifact exists and satisfies the target.</p></details><details><summary>Why can useful gather bandwidth exceed physical bandwidth?</summary><p>The useful-delivery figure includes avoided host traffic. It is an application-level proxy, not extra physical interface bandwidth.</p></details><details><summary>Can this platform tape out a 2 nm chip using only open source?</summary><p>No. It can manage open architecture, RTL, public-PDK proxies, and first-order multiphysics work. Qualified 2 nm PDKs, production memory/PHY IP, hybrid-bond data, and signoff remain in the foundry lane.</p></details><details><summary>What should I export for a review?</summary><p>Set the intended configuration, export the evidence JSON, and record the design revision, review purpose, decision, owners, missing artifacts, and waiver expiry in your controlled review process.</p></details></div>
        </div>
      </section>
    </div>
  );
}

function T1ScaleUpView({ config, evaluation, campaign, physical }: {
  config: T1Config;
  evaluation: ReturnType<typeof evaluateT1>;
  campaign: T1DigitalCampaign;
  physical: T1PhysicalProxy;
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
    ['01', 'Freeze the T1 contract', 'Version all source-defined targets and explicitly tag derived channel, bank, and region assumptions.', 'complete'],
    ['02', 'Scale digital models', 'Extend traces, address mapping, NoC traffic, controller composition, ECC, refresh, and repair to 64 channels.', 'complete'],
    ['03', 'Run physical and multiphysics proxies', 'Sweep public-PDK routing plus eight-tier thermal, link, power-delivery, and package geometry studies.', 'complete'],
    ['04', 'Prepare foundry-entry authorization', 'Use the secure handoff workbench; promotion remains blocked until measured T0 gates and qualified foundry inputs exist.', 'active'],
  ];

  return (
    <div className="t1-layout">
      <section className="panel t1-hero">
        <div className="t1-stack-visual" aria-label="Eight-tier T1 stack over an intelligent base die">
          {Array.from({ length: config.dramTiers }).map((_, index) => <i key={index} style={{ '--tier-index': index } as CSSProperties} />)}
          <span>64 MB intelligent base die</span>
        </div>
        <div className="t1-hero-copy">
          <p className="eyebrow accent">T1 digital scale campaign active</p>
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

      <section className="panel t1-campaign-panel">
        <PanelTitle label="T1 deterministic workload campaign" meta={`${(campaign.workloads.length * campaign.modelContract.requestCount).toLocaleString()} seeded requests · 64-channel proxy`} />
        <div className="t1-campaign-table">
          <div className="t1-campaign-row head"><span>Workload</span><span>Useful BW</span><span>Utilization</span><span>Avg latency</span><span>P99 latency</span><span>Row hits</span><span>Requests</span></div>
          {campaign.workloads.map((workload) => <div className="t1-campaign-row" key={workload.id}><span><strong>{workload.name}</strong><small>{workload.description}</small></span><span>{workload.usefulBandwidthTbps.toFixed(3)} TB/s</span><span>{workload.utilizationPercent.toFixed(1)}%</span><span>{workload.averageLatencyNs.toFixed(1)} ns</span><span>{workload.p99LatencyNs.toFixed(1)} ns</span><span>{workload.rowHitPercent.toFixed(1)}%</span><span>{workload.requests.toLocaleString()}</span></div>)}
        </div>
        <div className="t1-campaign-note"><span>Evidence class</span><strong>{campaign.modelContract.evidenceClass}</strong><p>Deterministic and reproducible; not packet-level NoC, extracted timing, or silicon-calibrated latency.</p></div>
      </section>

      <div className="t1-digital-grid">
        <section className="panel t1-fabric-panel">
          <PanelTitle label="Eight-region fabric load" meta={`${campaign.fabric.channelsPerRegion} channels · ${campaign.fabric.banksPerRegion} banks per region`} />
          <div className="t1-fabric-map">{campaign.fabric.regionLoadsPercent.map((load, region) => <article key={region}><div><span>R{region}</span><b>{load.toFixed(1)}%</b></div><div className="t1-fabric-meter"><i style={{ width: `${load}%` }} /></div><small>{campaign.fabric.channelsPerRegion} channels · {campaign.fabric.pseudochannelsPerRegion} pseudochannels</small></article>)}</div>
        </section>

        <section className="panel t1-mode-panel">
          <PanelTitle label="Lane-rate sensitivity" meta="Same 4,096-lane interface" />
          <div className="t1-mode-table">
            <div className="t1-mode-row head"><span>Mode</span><span>Raw</span><span>Stream proxy</span><span>Random proxy</span><span>PHY proxy</span></div>
            {campaign.modes.map((mode) => <div className={`t1-mode-row ${mode.laneRateGbps === config.laneRateGbps ? 'selected' : ''}`} key={mode.laneRateGbps}><span><strong>{mode.laneRateGbps} Gb/s</strong><small>{mode.routingClass.replace('-', ' ')}</small></span><span>{mode.rawBandwidthTbps.toFixed(3)}</span><span>{mode.streamingBandwidthTbps.toFixed(3)}</span><span>{mode.randomBandwidthTbps.toFixed(3)}</span><span>{mode.interfacePowerProxyWatts.toFixed(2)} W</span></div>)}
          </div>
          <div className="t1-limitations"><strong>Model limits</strong>{campaign.modelContract.limitations.map((limitation) => <span key={limitation}>{limitation}</span>)}</div>
        </section>
      </div>

      <section className="panel t1-physical-panel">
        <PanelTitle label="Coupled physical + multiphysics proxy" meta={`${config.activityPercent}% activity · ${config.coolingResistanceKPerW.toFixed(2)} K/W cooling assumption`} />
        <div className="t1-physical-metrics">
          <div><span>Total active power</span><strong>{physical.power.totalPowerWatts.toFixed(1)}<small>W proxy</small></strong></div>
          <div><span>Stack hotspot</span><strong>{physical.thermal.hotspotC.toFixed(1)}<small>°C</small></strong></div>
          <div><span>Thermal margin</span><strong>{physical.thermal.marginC.toFixed(1)}<small>°C to 85°C</small></strong></div>
          <div><span>Routing congestion</span><strong>{physical.routing.congestionPercent.toFixed(0)}<small>% index</small></strong></div>
          <div><span>Package skew</span><strong>{physical.package.skewPs.toFixed(1)}<small>ps proxy</small></strong></div>
          <div><span>IR-drop indicator</span><strong>{physical.package.irDropProxyMv.toFixed(1)}<small>mV proxy</small></strong></div>
        </div>
        <div className="t1-risk-strip"><span className={physical.routing.risk}>Routing · {physical.routing.risk}</span><span className={physical.thermal.risk}>Thermal · {physical.thermal.risk}</span><span className={physical.package.risk}>Package · {physical.package.risk}</span><p>{physical.evidenceClass}; no extracted parasitics or field-solver result is claimed.</p></div>
      </section>

      <div className="t1-physics-detail">
        <section className="panel t1-region-physics">
          <PanelTitle label="Regional coupled state" meta="Load → congestion → temperature" />
          <div className="t1-region-grid">{physical.regions.map((region) => <article key={region.id}><div><strong>{region.id}</strong><span>{region.temperatureC.toFixed(1)}°C</span></div><div className="t1-region-bars"><i style={{ width: `${region.loadPercent}%` }} /><i style={{ width: `${region.congestionPercent}%` }} /></div><small>{region.loadPercent.toFixed(0)}% activity · {region.congestionPercent.toFixed(0)}% congestion</small></article>)}</div>
          <div className="t1-physics-legend"><span><i />Activity</span><span><i />Congestion</span></div>
        </section>

        <section className="panel t1-cooling-panel">
          <PanelTitle label="Cooling sensitivity" meta="Parametric resistance sweep" />
          <div className="t1-cooling-chart">
            {physical.coolingSweep.map((point) => <div key={point.resistanceKPerW}><span>{point.resistanceKPerW.toFixed(2)} K/W</span><div><i style={{ width: `${Math.min(100, Math.max(0, ((point.hotspotC - 45) / 50) * 100))}%` }} /></div><strong>{point.hotspotC.toFixed(1)}°C</strong></div>)}
          </div>
          <div className="t1-cooling-threshold"><i /><span>85°C provisional architecture limit</span></div>
        </section>
      </div>

      <section className="panel t1-handoff-panel">
        <PanelTitle label="Open-source solver handoffs" meta="Next artifacts required to replace analytical proxies" />
        <div className="t1-handoff-grid">{physical.solverHandoffs.map((handoff, index) => <article key={handoff.stage}><b>{String(index + 1).padStart(2, '0')}</b><div><h3>{handoff.stage}</h3><span>{handoff.tools}</span><p>{handoff.nextArtifact}</p></div></article>)}</div>
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

function FoundryReadinessView({ readiness }: {
  readiness: ReturnType<typeof evaluateFoundryReadiness>;
}) {
  const policies = [
    ['Measured evidence first', 'No promotion while any T0 gate lacks reviewed, measured passing evidence.'],
    ['Immutable execution', 'Reject unsigned manifests, unpinned tools, unhashed inputs, or undeclared checks.'],
    ['Deny export by default', 'Raw PDK, IP, package, netlist, layout, credential, and signoff artifacts remain inside the enclave.'],
    ['Human release authority', 'Agents may prepare, execute, summarize, and flag; only named human approvers may authorize tapeout.'],
    ['Time-bounded waivers', 'Every exception records its owner, rationale, scope, compensating control, and expiry.'],
  ];
  const roles = [
    ['Platform engineering', 'Own the open manifest schema, policy engine, evidence graph, and reproducible orchestration.'],
    ['Security + legal', 'Authorize identities, secrets, licenses, data residency, retention, exports, and incident response.'],
    ['Foundry + IP owners', 'Qualify and mount restricted PDK, SRAM, PHY, package, and signoff inputs inside the enclave.'],
    ['Domain leads', 'Review timing, power, physical verification, reliability, DFT, package, and thermal evidence.'],
    ['Release board', 'Resolve blockers and waivers, then make the final fabrication-spend decision.'],
  ];

  return (
    <div className="foundry-layout">
      <section className="panel foundry-hero">
        <div className="foundry-decision"><span>Fabrication decision</span><strong>{readiness.decision}</strong><small>Policy evaluation is automatic; final authorization always remains human.</small></div>
        <div className="foundry-hero-copy">
          <p className="eyebrow accent">Foundry handoff contract prepared</p>
          <h3>Keep the platform open. Keep qualified process data contained.</h3>
          <p>The open-source product can specify, orchestrate, audit, and visualize a restricted signoff job. Licensed PDK, IP, package, and manufacturing data is never bundled here and must be consumed only in an authorized environment.</p>
          <div className="readiness-tags"><span className="good">Open control contract ready</span><span className="good">Deny-by-default export</span><span className="pending">{readiness.verifiedT0Gates}/{readiness.requiredT0Gates} measured T0 gates</span><span className="pending">{readiness.readyInputs}/{readiness.totalInputs} qualified inputs</span></div>
        </div>
        <div className="foundry-prepared"><span>Platform preparation</span><strong>{readiness.platformPreparedPercent}%</strong><small>Counts implemented and planned control-plane work only. It is not foundry readiness.</small></div>
      </section>

      <section className="panel foundry-boundary-panel" id="foundry-boundary">
        <PanelTitle label="Trust-boundary data flow" meta="One-way, allowlisted evidence return" />
        <div className="foundry-flow">
          {readiness.boundary.map((stage, index) => <article key={stage.id} className={stage.zone}><div className="foundry-flow-head"><b>{String(index + 1).padStart(2, '0')}</b><span>{stage.zone}</span></div><h3>{stage.title}</h3><dl><div><dt>Accepts</dt><dd>{stage.accepts}</dd></div><div><dt>Emits</dt><dd>{stage.emits}</dd></div></dl>{index < readiness.boundary.length - 1 && <i aria-hidden="true">→</i>}</article>)}
        </div>
        <div className="foundry-boundary-rule"><strong>Boundary invariant</strong><p>No proprietary source artifact crosses back into the open control plane. Only explicitly approved metrics, sanitized findings, hashes, provenance, and human decisions may return.</p></div>
      </section>

      <section className="panel foundry-input-panel" id="foundry-inputs">
        <PanelTitle label="Qualified input matrix" meta={`${readiness.readyInputs} ready · ${readiness.plannedInputs} planned · ${readiness.absentInputs} absent`} />
        <div className="foundry-input-table">
          <div className="foundry-input-row head"><span>Domain / input</span><span>Sensitivity</span><span>Status</span><span>Owner</span><span>Required artifact and export rule</span></div>
          {readiness.inputs.map((input) => <div className="foundry-input-row" key={input.id}><span><strong>{input.title}</strong><small>{input.domain}</small></span><span className={`foundry-chip ${input.sensitivity}`}>{input.sensitivity}</span><span className={`foundry-chip ${input.status}`}>{input.status}</span><span>{input.owner}</span><span><b>{input.requiredArtifact}</b><small>{input.exportPolicy}</small></span></div>)}
        </div>
      </section>

      <section className="panel foundry-approval-panel" id="foundry-approvals">
        <PanelTitle label="Human approval chain" meta="No agent may self-promote a release" />
        <div className="foundry-approvals">
          {readiness.approvals.map((approval, index) => <article key={approval.id} className={approval.status}><b>{String(index + 1).padStart(2, '0')}</b><div><div><h3>{approval.title}</h3><span>{approval.status}</span></div><p>{approval.exitEvidence}</p><small>Accountable owner · {approval.owner}</small></div></article>)}
        </div>
      </section>

      <section className="panel foundry-policy-panel" id="foundry-policy">
        <PanelTitle label="Automatic release policy" meta="Every rule is fail closed" />
        <div className="foundry-policy-list">{policies.map(([title, detail], index) => <article key={title}><b>{String(index + 1).padStart(2, '0')}</b><div><h3>{title}</h3><p>{detail}</p></div></article>)}</div>
      </section>

      <section className="panel foundry-role-panel" id="foundry-roles">
        <PanelTitle label="Responsibility map" meta="Named ownership for every irreversible decision" />
        <div className="foundry-role-grid">{roles.map(([role, responsibility]) => <article key={role}><h3>{role}</h3><p>{responsibility}</p></article>)}</div>
      </section>

      <section className="gate-note foundry-hold-note"><strong>Current decision · HOLD</strong><p>{readiness.blockers.join(' ')} The next authorized action is to complete the isolated runner design and obtain real T0 and foundry evidence—not to infer a pass from public proxies.</p></section>
    </div>
  );
}

function ProductionX1View({ config, evaluation }: {
  config: X1Config;
  evaluation: ReturnType<typeof evaluateX1>;
}) {
  const scaleDeltas = [
    ['DRAM stack', '8 → 16', '2× tiers'],
    ['Payload lanes', '4,096 → 8,192', '2× width'],
    ['Physical channels', '64 → 128', '2× controllers'],
    ['Bank fabric', '2,048 → 4,096', '2× banks'],
    ['Base-die SRAM', '64 → 128 MB', '2× capacity'],
    ['Nominal raw BW', '4.096 → 8.192', '2× TB/s'],
  ];
  const areaBudget = [
    ['128 MB SRAM', 43], ['PHY', 29], ['Controller + NoC', 18], ['AI memory engines', 12],
    ['ECC / RAS', 8], ['PMU / DFT / security', 6], ['Power / clock / bonding', 28],
  ];
  const stateRows = [
    { id: 'P0', name: 'Deep idle', rate: 0, bandwidth: 0, envelope: 'PHY off · self-refresh' },
    { id: 'P1', name: 'Idle', rate: 0, bandwidth: 0, envelope: 'PHY trained · clocks gated' },
    ...Object.entries(X1_STATE_TABLE).map(([name, state]) => ({ id: state.id, name, rate: state.laneRateGbps, bandwidth: (config.payloadLanesPerStack * state.laneRateGbps) / 8 / 1000, envelope: `${state.stackPowerEnvelopeWatts} W planning envelope` })),
  ];
  const sequence = [
    ['01', 'Freeze production architecture', 'Version the 16-high stack, 8,192-lane interface, 16-region base die, active-interposer package, and operating-state contract.', 'complete'],
    ['02', 'Model system balance', 'Sweep stacks, memory efficiency, demand, accelerator ingest, routing layers, and distributed compute ports.', 'complete'],
    ['03', 'Qualify T1 engineering sample', 'Close measured large-scale routing, 2 nm implementation, eight-tier thermal, and production-package gates.', 'blocked'],
    ['04', 'Run restricted production signoff', 'Use qualified PDK, SRAM, PHY, bond, package, DFT, manufacturing, and signoff inputs inside the authorized enclave.', 'blocked'],
    ['05', 'Validate 16-high package vehicles', 'Demonstrate known-good-die assembly, yield, repair, signal margin, power integrity, and liquid-cooling behavior.', 'blocked'],
    ['06', 'Authorize production release', 'Require reviewed signoff, qualification, manufacturing readiness, commercial constraints, and named human approval.', 'blocked'],
  ];

  return (
    <div className="x1-layout">
      <section className="panel x1-hero" id="x1-system">
        <div className="x1-stack-hero" aria-label="Sixteen-tier AIMEM-X1 stack">
          {Array.from({ length: config.dramTiers }).map((_, index) => <i key={index} style={{ '--x1-tier': index } as CSSProperties} />)}
          <span>128 MB intelligent base die</span>
        </div>
        <div className="x1-hero-copy"><p className="eyebrow accent">Source-defined production architecture</p><h3>Model the full memory system before committing production capital.</h3><p>Each X1 stack exposes 8,192 payload lanes, 128 channels, 256 pseudochannels, 4,096 banks, 524,288 subarrays, and 128 MB memory-side SRAM. The system view tests whether the package and accelerator can actually use that scale.</p><div className="readiness-tags"><span className="good">{config.dramTiers}-high stack</span><span className="good">{config.stackCount} active stacks</span><span className="good">{evaluation.totalCapacityGib >= 1024 ? `${evaluation.totalCapacityGib / 1024} TB` : `${evaluation.totalCapacityGib} GB`}</span><span className="pending">Production: {evaluation.decision}</span></div></div>
        <div className="x1-decision"><span>Promotion decision</span><strong>{evaluation.decision}</strong><small>{evaluation.t1QualificationGatesPassed}/{evaluation.t1QualificationGatesRequired} measured T1 qualification gates passed</small></div>
      </section>

      <section className="panel x1-scale-panel" id="x1-stack"><PanelTitle label="T1 → Production X1" meta="Source-defined doubling path" /><div className="x1-scale-grid">{scaleDeltas.map(([label, value, note]) => <article key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</div></section>

      <section className="panel x1-balance-panel">
        <PanelTitle label="Live system balance" meta={`${evaluation.bottleneck} is limiting delivered bandwidth`} />
        <div className="x1-balance-grid"><div><span>Memory useful ceiling</span><strong>{evaluation.memoryUsefulCeilingTbps.toFixed(1)}<small>TB/s</small></strong></div><div><span>Workload request</span><strong>{evaluation.requestedBandwidthTbps.toFixed(1)}<small>TB/s</small></strong></div><div><span>Accelerator fabric</span><strong>{config.acceleratorFabricTbps.toFixed(1)}<small>TB/s</small></strong></div><div className="delivered"><span>Delivered proxy</span><strong>{evaluation.deliveredBandwidthTbps.toFixed(1)}<small>TB/s</small></strong></div></div>
        <div className="x1-bottleneck"><span>Bottleneck</span><strong>{evaluation.bottleneck}</strong><p>{evaluation.memoryUtilizationPercent.toFixed(0)}% memory-link utilization · {evaluation.computeIngestUtilizationPercent.toFixed(0)}% accelerator-ingest utilization</p></div>
      </section>

      <section className="panel x1-package-panel" id="x1-package">
        <PanelTitle label="Eight-stack accelerator topology" meta={`${evaluation.totalPayloadLanes.toLocaleString()} active payload lanes`} />
        <div className="x1-system-map"><div className="x1-memory-ring">{Array.from({ length: 8 }).map((_, index) => <article key={index} className={index < config.stackCount ? 'active' : ''}><div>{Array.from({ length: 8 }).map((__, layer) => <i key={layer} />)}</div><strong>X1 {index + 1}</strong><span>{index < config.stackCount ? `${config.capacityGibPerStack} GB · ${evaluation.rawBandwidthPerStackTbps.toFixed(3)} TB/s` : 'not populated'}</span></article>)}</div><div className="x1-interposer"><span>Active interposer</span><strong>{config.interposerRoutingLayers} routing layers · {evaluation.routeBundles} × 256-lane bundles</strong><div><i style={{ width: `${Math.min(100, evaluation.routingPressurePercent)}%` }} /></div><small>{evaluation.routingPressurePercent.toFixed(0)}% routing-pressure proxy</small></div><div className="x1-compute"><span>Distributed accelerator fabric</span><strong>{config.distributedComputePorts} perimeter ports</strong><small>{config.acceleratorFabricTbps.toFixed(1)} TB/s modeled ingest</small></div></div>
      </section>

      <section className="panel x1-state-panel" id="x1-states"><PanelTitle label="P0–P5 performance states" meta="Turbo requires temperature, power, error-rate, and signal-margin clearance" /><div className="x1-state-table"><div className="x1-state-row head"><span>State</span><span>Mode</span><span>Lane rate</span><span>Raw / stack</span><span>Power behavior</span></div>{stateRows.map((state) => <div key={state.id} className={`x1-state-row ${state.id === evaluation.state.id ? 'active' : ''}`}><span>{state.id}</span><strong>{state.name}</strong><span>{state.rate ? `${state.rate} Gb/s` : '—'}</span><span>{state.bandwidth ? `${state.bandwidth.toFixed(3)} TB/s` : '—'}</span><span>{state.envelope}</span></div>)}</div></section>

      <section className="panel x1-area-panel" id="x1-base"><PanelTitle label="2 nm-class base-die reservation" meta="12 mm × 12 mm architectural floorplan · not layout evidence" /><div className="x1-area-map">{areaBudget.map(([block, area]) => <article key={String(block)} style={{ '--area-share': `${(Number(area) / 144) * 100}%` } as CSSProperties}><span>{block}</span><strong>{area}<small>mm²</small></strong><div><i /></div></article>)}</div><div className="x1-area-total"><span>Reserved total</span><strong>144 mm²</strong><p>Area allocations are planning reservations only; qualified macro, PHY, keep-out, power-grid, and signoff data must replace them.</p></div></section>

      <section className="panel x1-noc-panel" id="x1-noc"><PanelTitle label="Sixteen-region memory-side NoC" meta="Local traffic first · no central crossbar" /><div className="x1-noc-grid">{Array.from({ length: config.nocRegionsPerStack }).map((_, index) => <article key={index}><span>N{index}</span><strong>8 channels</strong><small>16 pseudochannels · 256 banks · 8 MB SRAM</small><i style={{ width: `${42 + ((index * 17) % 48)}%` }} /></article>)}</div></section>

      <section className="panel x1-gate-panel" id="x1-gates"><PanelTitle label="Production evidence gates" meta="Architecture and proxy results never satisfy measured gates" /><div className="x1-gate-grid">{evaluation.gates.map((gate) => <article key={gate.id} className={gate.status}><div><span>{gate.id}</span><b>{gate.status}</b></div><h3>{gate.title}</h3><p>{gate.evidence}</p></article>)}</div></section>

      <section className="panel x1-sequence-panel"><PanelTitle label="Production execution sequence" meta="Evidence before irreversible spend" /><div className="t1-sequence">{sequence.map(([number, title, detail, status]) => <article key={number} className={status}><b>{number}</b><div><h3>{title}</h3><p>{detail}</p></div><span>{status}</span></article>)}</div></section>

      <section className="gate-note x1-hold-note"><strong>Current decision · HOLD</strong><p>The full production architecture is now explorable as a deterministic planning model. No production promotion is allowed until the T1 engineering sample closes large-scale routing, 2 nm implementation, eight-tier thermal, and production-package evidence.</p></section>
    </div>
  );
}

function AgentMissionControlView({ evaluation, runStatus, navigate }: {
  evaluation: ReturnType<typeof evaluateAgentMission>;
  runStatus: AgentRunStatus;
  navigate: (view: View) => void;
}) {
  const authorityRules = [
    ['May act', 'Plan work, execute approved open-source tools, compare results, summarize evidence, recommend next actions, and flag risk.'],
    ['Must disclose', 'Tool identity, inputs, hashes, evidence class, limitations, cost, runtime, failures, and every human or restricted dependency.'],
    ['Must stop', 'At missing measured evidence, unavailable hardware, restricted data without authorization, policy denial, or a human release decision.'],
    ['May never', 'Invent evidence, upgrade evidence class, conceal failed checks, exfiltrate restricted data, approve waivers, or authorize fabrication.'],
  ];
  const events = evaluation.nodes.map((node, index) => ({
    time: `T+${String(index * 7).padStart(2, '0')}s`,
    node,
    message: node.status === 'complete' ? `Artifact sealed · ${node.artifact}` : node.status === 'active' ? `Executing approved ${node.lane} workflow` : node.status === 'blocked' ? `Mandatory stop · ${node.stopRule}` : `Waiting on ${node.dependsOn.length ? node.dependsOn.join(', ') : 'mission start'}`,
  }));

  return (
    <div className="agent-layout">
      <section className="panel agent-hero" id="agent-mission">
        <div className={`agent-orbit ${runStatus}`}><i /><i /><i /><div><strong>{evaluation.progressPercent}%</strong><span>replayed</span></div></div>
        <div className="agent-hero-copy"><p className="eyebrow accent">{evaluation.mission.label}</p><h3>One governed mission across the complete chip-design evidence chain.</h3><p>{evaluation.mission.objective} The replay visualizes orchestration decisions locally; it does not launch remote EDA, lab, or foundry jobs.</p><div className="readiness-tags"><span className="good">8 open automation agents</span><span className="good">Signed artifact contract</span><span className="good">Policy before promotion</span><span className="pending">3 mandatory stops</span></div></div>
        <div className="agent-decision"><span>Release recommendation</span><strong>{evaluation.decision}</strong><small>{evaluation.mission.boundary}</small></div>
      </section>

      <section className="panel agent-graph-panel" id="agent-graph">
        <PanelTitle label="End-to-end execution graph" meta="Dependencies, tools, artifacts, and stop rules remain visible" />
        <div className="agent-lane-label"><span>Open automation lane</span><b>{evaluation.completedOpenNodes}/{evaluation.safeNodeCount} replayed</b></div>
        <div className="agent-graph-grid">{evaluation.openNodes.map((node, index) => <article key={node.id} className={node.status}><div className="agent-node-head"><b>{String(index + 1).padStart(2, '0')}</b><span>{node.status}</span></div><h3>{node.title}</h3><strong>{node.agent}</strong><p>{node.tools}</p><dl><div><dt>Consumes</dt><dd>{node.consumes}</dd></div><div><dt>Produces</dt><dd>{node.artifact}</dd></div></dl>{(node.id === 'rtl' || node.id === 'formal') && <button onClick={() => navigate('digital')}>Open digital evidence →</button>}{node.id === 'physical' && <button onClick={() => navigate('physical')}>Open physical evidence →</button>}{index < evaluation.openNodes.length - 1 && <i aria-hidden="true">→</i>}</article>)}</div>
        <div className="agent-lane-label boundary"><span>Mandatory boundary lane</span><b>No autonomous promotion</b></div>
        <div className="agent-boundary-grid">{evaluation.boundaryNodes.map((node, index) => <article key={node.id} className={node.lane}><div><b>{String(index + 9).padStart(2, '0')}</b><span>{node.lane}</span></div><h3>{node.title}</h3><strong>{node.agent}</strong><p>{node.stopRule}</p><small>Required artifact · {node.artifact}</small></article>)}</div>
      </section>

      <section className="panel agent-event-panel" id="agent-events"><PanelTitle label="Deterministic mission event stream" meta={`${runStatus} · no remote jobs launched`} /><div className="agent-event-stream">{events.map(({ time, node, message }) => <div key={node.id} className={node.status}><time>{time}</time><i /><span><strong>{node.agent}</strong><small>{message}</small></span><b>{node.status}</b></div>)}</div></section>

      <section className="panel agent-artifact-panel" id="agent-artifacts"><PanelTitle label="Evidence artifact ledger" meta="Content addressed · immutable after review" /><div className="agent-artifact-list">{evaluation.openNodes.map((node, index) => <article key={node.id} className={node.status}><div><b>{String(index + 1).padStart(2, '0')}</b><span>{node.status === 'complete' ? 'hash sealed' : 'expected'}</span></div><h3>{node.artifact}</h3><p>{node.stopRule}</p><small>Owner · {node.agent} · Evidence lane · {node.lane}</small></article>)}</div></section>

      <section className="panel agent-runtime-panel" id="agent-runtime"><PanelTitle label="Recommended open-source runtime" meta="Self-hostable production architecture" /><div className="agent-runtime-grid">{AGENT_RUNTIME_STACK.map(([layer, tool, purpose]) => <article key={layer}><span>{layer}</span><strong>{tool}</strong><p>{purpose}</p></article>)}</div><div className="agent-runtime-note"><strong>Implementation boundary</strong><p>This workspace currently implements the deterministic orchestration contract and visualization. The listed runtime components are the recommended open-source deployment stack for durable execution, storage, policy, provenance, and observability.</p></div></section>

      <section className="panel agent-policy-panel" id="agent-policy"><PanelTitle label="Agent authority policy" meta="Fail closed · human accountability retained" /><div className="agent-policy-grid">{authorityRules.map(([title, detail], index) => <article key={title}><b>{String(index + 1).padStart(2, '0')}</b><div><h3>{title}</h3><p>{detail}</p></div></article>)}</div></section>

      <section className="gate-note agent-hold-note"><strong>Mission result · HOLD</strong><p>Completing the open-source lane prepares a reviewable evidence package; it does not complete the program. The orchestrator stops at measured silicon, restricted foundry execution, and fabrication authorization because those require physical resources, licensed inputs, and accountable people.</p></section>
    </div>
  );
}

function DigitalImplementationView({ evaluation, selectedModule, setSelectedModule }: {
  evaluation: ReturnType<typeof evaluateDigitalImplementation>;
  selectedModule: string;
  setSelectedModule: (module: string) => void;
}) {
  const activeModule = DIGITAL_MODULES.find((item) => item.id === selectedModule) ?? DIGITAL_MODULES[0];
  const states = [
    ['IDLE', 'Accept command or prioritize refresh'],
    ['ACTIVATE', 'Open the requested bank row'],
    ['ACCESS', 'Execute data and ECC path'],
    ['RESPOND', 'Return result and status'],
  ];
  const closure = evaluation.checks.filter((check) => check.status !== 'pass');
  return (
    <div className="digital-layout">
      <section className="panel digital-hero" id="digital-overview">
        <div className="digital-score"><strong>{evaluation.weightedReadiness}%</strong><span>weighted digital readiness</span><i style={{ '--digital-score': `${evaluation.weightedReadiness}%` } as CSSProperties} /></div>
        <div><p className="eyebrow accent">Executed evidence · {evaluation.evidence.tool}</p><h3>The first agent stage backed by a real open-source RTL run.</h3><p>Five synthesizable modules form a 16-channel T0 slice. Generic synthesis and two bounded formal proofs pass; randomized RTL regressions, complete datapath integration, and independent closure remain explicit work.</p><div className="readiness-tags"><span className="good">RTL parse passed</span><span className="good">Hierarchy elaborated</span><span className="good">2 formal proofs</span><span className="pending">3 closure gaps</span></div></div>
        <div className="digital-decision"><span>Digital release</span><strong>{evaluation.releaseDecision}</strong><small>{evaluation.nextArtifact}</small></div>
      </section>

      <section className="panel digital-module-panel" id="digital-modules">
        <PanelTitle label="RTL module graph" meta={`${evaluation.moduleCount} modules · ${evaluation.sourceLines} source lines`} />
        <div className="digital-module-flow">{DIGITAL_MODULES.map((item, index) => <button key={item.id} className={selectedModule === item.id ? 'active' : ''} onClick={() => setSelectedModule(item.id)}><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{item.name}</strong><small>{item.role}</small></span>{index < DIGITAL_MODULES.length - 1 && <i>→</i>}</button>)}</div>
        <div className="digital-module-detail"><div><p className="eyebrow">Selected implementation block</p><h3>{activeModule.name}</h3><span>{activeModule.role} · {activeModule.lines} lines</span></div><dl><div><dt>Inputs</dt><dd>{activeModule.inputs}</dd></div><div><dt>Outputs</dt><dd>{activeModule.outputs}</dd></div><div><dt>Internal behavior</dt><dd>{activeModule.contains}</dd></div><div><dt>Evidence</dt><dd>{activeModule.evidence}</dd></div></dl></div>
      </section>

      <section className="panel digital-fsm-panel" id="digital-fsm">
        <PanelTitle label="Controller transaction flow" meta="Refresh has priority at the command boundary" />
        <div className="digital-fsm">{states.map(([state, detail], index) => <article key={state}><b>{state}</b><p>{detail}</p>{index < states.length - 1 && <i>→</i>}</article>)}</div>
        <div className="digital-refresh"><b>REFRESH</b><span>When refresh_age reaches the limit, cmd_ready deasserts, open rows close, and the age counter resets before new work is accepted.</span><strong>IDLE ↔ REFRESH</strong></div>
      </section>

      <section className="panel digital-verification-panel" id="digital-verification">
        <PanelTitle label="Verification and closure matrix" meta={`${evaluation.passCount} pass · ${evaluation.provisionalCount} provisional · ${evaluation.plannedCount} planned`} />
        <div className="digital-check-table"><div className="digital-check-row head"><span>ID</span><span>Check</span><span>Tool / evidence</span><span>Finding</span><span>Status</span></div>{evaluation.checks.map((check, index) => <div key={check.id} className={`digital-check-row ${check.status}`}><b>{String(index + 1).padStart(2, '0')}</b><strong>{check.title}</strong><span>{check.tool}</span><p>{check.detail}</p><em>{check.status}</em></div>)}</div>
      </section>

      <section className="panel digital-synthesis-panel" id="digital-synthesis">
        <PanelTitle label="Synthesis evidence" meta="Freshly reproduced in the open-source lane" />
        <div className="digital-synth-grid"><article><span>Generic cells</span><strong>{evaluation.evidence.cells.toLocaleString()}</strong><i style={{ width: '74%' }} /></article><article><span>Named wires</span><strong>{evaluation.evidence.wires.toLocaleString()}</strong><i style={{ width: '71%' }} /></article><article><span>Wire bits</span><strong>{evaluation.evidence.wire_bits.toLocaleString()}</strong><i style={{ width: '91%' }} /></article><article><span>Public-PDK mapped channel</span><strong>{physicalEvidence.mapped_cells.toLocaleString()}</strong><i style={{ width: '46%' }} /></article></div>
        <div className="digital-proof-list">{evaluation.evidence.checks.map((check, index) => <div key={check}><b>{String(index + 1).padStart(2, '0')}</b><span>{check}</span><em>recorded</em></div>)}</div>
      </section>

      <section className="panel digital-closure-panel" id="digital-closure">
        <PanelTitle label="Digital closure backlog" meta={`${evaluation.review.label} · planning scope, not executed evidence`} />
        <div className="digital-scope-summary"><div><span>Review objective</span><strong>{evaluation.review.target}</strong></div><div><span>Target transactions</span><strong>{evaluation.review.transactions ? evaluation.review.transactions.toLocaleString() : 'Current artifacts'}</strong></div><div><span>Seed budget</span><strong>{evaluation.review.seeds ? evaluation.review.seeds.toLocaleString() : 'Current artifacts'}</strong></div><div><span>Proof depth</span><strong>{evaluation.review.proofDepth} cycles</strong></div><div><span>Coverage target</span><strong>{evaluation.review.coverageTarget}</strong></div></div>
        <div className="digital-backlog">{closure.map((check) => <article key={check.id} className={check.status}><span>{check.status}</span><h3>{check.title}</h3><p>{check.detail}</p><small>Planned tool · {check.tool}</small></article>)}</div>
        <div className="digital-limitations"><strong>Evidence limitations</strong><ul>{evaluation.evidence.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div>
      </section>

      <section className="gate-note digital-hold-note"><strong>Current decision · HOLD</strong><p>Passing generic synthesis and bounded properties makes this a reproducible implementation slice—not a complete controller, timing-closed netlist, production-process result, or silicon qualification.</p></section>
    </div>
  );
}

function PhysicalImplementationView({ evaluation, selectedStage, setSelectedStage }: {
  evaluation: ReturnType<typeof evaluatePhysicalImplementation>;
  selectedStage: string;
  setSelectedStage: (stage: string) => void;
}) {
  const activeStage = evaluation.stages.find((stage) => stage.id === selectedStage) ?? evaluation.stages[1];
  const requiredOutputs = ['Placed DEF', 'Clock-tree report', 'Routed DEF', 'SPEF parasitics', 'Post-route setup and hold', 'DRC and LVS reports'];
  return (
    <div className="physical-lab-layout">
      <section className="panel physical-lab-hero" id="physical-overview">
        <div className="physical-chip-mark"><div>{Array.from({ length: 36 }).map((_, index) => <i key={index} />)}</div><span>Mapped channel</span></div>
        <div><p className="eyebrow accent">Executed evidence · {evaluation.evidence.platform}</p><h3>From synthesizable RTL to an auditable physical-design handoff.</h3><p>The complete T0 channel maps to public Sky130 standard cells. This lab separates reproduced mapping evidence from analytical floorplan planning, future open-source implementation, and restricted production signoff.</p><div className="readiness-tags"><span className="good">{evaluation.evidence.mapped_cells.toLocaleString()} mapped cells</span><span className="good">No generic cells</span><span className="good">SDC versioned</span><span className="pending">Route + signoff open</span></div></div>
        <div className="physical-lab-decision"><span>Physical release</span><strong>{evaluation.decision}</strong><small>{evaluation.nextArtifact}</small></div>
      </section>

      <section className="panel physical-flow-panel" id="physical-flow">
        <PanelTitle label="Implementation and signoff flow" meta={`${evaluation.passedStages} pass · ${evaluation.readyStages} ready · ${evaluation.plannedStages} planned · ${evaluation.restrictedStages} restricted`} />
        <div className="physical-stage-grid">{evaluation.stages.map((stage, index) => <button key={stage.id} className={`${stage.status} ${selectedStage === stage.id ? 'active' : ''}`} onClick={() => setSelectedStage(stage.id)}><div><b>{String(index + 1).padStart(2, '0')}</b><span>{stage.status}</span></div><h3>{stage.title}</h3><p>{stage.tool}</p>{index < evaluation.stages.length - 1 && <i>→</i>}</button>)}</div>
        <div className="physical-stage-detail"><div><span>Selected stage</span><strong>{activeStage.title}</strong><small>{activeStage.tool} · {activeStage.status}</small></div><p>{activeStage.detail}</p><div><span>Required artifact</span><strong>{activeStage.artifact}</strong></div></div>
      </section>

      <section className="panel physical-floorplan-panel" id="physical-floorplan">
        <PanelTitle label="Analytical floorplan explorer" meta={`${evaluation.utilizationPercent}% target utilization · planning only`} />
        <div className="physical-floorplan-body"><div className="physical-die" style={{ '--core-ratio': `${Math.max(58, 88 - (evaluation.dieSideUm - evaluation.coreSideUm) / evaluation.dieSideUm * 100)}%` } as CSSProperties}><span className="die-edge top">power + clock entry</span><span className="die-edge left">command + data in</span><div className="physical-core"><b>aimem_t0_channel</b><span>{evaluation.evidence.mapped_cells.toLocaleString()} cells</span><div>{Array.from({ length: 80 }).map((_, index) => <i key={index} className={index % 5 === 0 ? 'seq' : ''} />)}</div></div><span className="die-edge right">response + status</span><span className="die-edge bottom">test + telemetry</span></div><div className="physical-floorplan-metrics"><article><span>Mapped cell area</span><strong>{evaluation.evidence.chip_area_um2.toLocaleString(undefined, { maximumFractionDigits: 0 })} µm²</strong></article><article><span>Estimated core</span><strong>{evaluation.coreSideUm.toFixed(1)} × {evaluation.coreSideUm.toFixed(1)} µm</strong></article><article><span>Planning die</span><strong>{evaluation.dieSideUm.toFixed(1)} × {evaluation.dieSideUm.toFixed(1)} µm</strong></article><article><span>Routing pressure</span><strong>{evaluation.routingPressure}% · {evaluation.clockRisk}</strong></article><p>Core and die dimensions are first-order planning values derived from mapped-cell area and target utilization. They are not OpenROAD floorplan output.</p></div></div>
      </section>

      <section className="panel physical-cell-panel" id="physical-cells">
        <PanelTitle label="Mapped cell composition" meta={`${evaluation.evidence.sequential_cells} sequential · ${evaluation.combinationalCells.toLocaleString()} combinational`} />
        <div className="physical-cell-summary"><div><strong>{evaluation.sequentialPercent.toFixed(1)}%</strong><span>sequential share</span></div><div><strong>{(100 - evaluation.sequentialPercent).toFixed(1)}%</strong><span>combinational share</span></div></div>
        <div className="physical-cell-bars">{evaluation.topCells.map((cell, index) => <div key={cell.name}><b>{String(index + 1).padStart(2, '0')}</b><span>{cell.name}</span><i><em style={{ width: `${Math.max(4, (cell.count / evaluation.topCells[0].count) * 100)}%` }} /></i><strong>{cell.count}</strong></div>)}</div>
      </section>

      <section className="panel physical-constraint-panel" id="physical-constraints">
        <PanelTitle label="Versioned timing contract" meta="SDC inputs are ready; timing results are not" />
        <div className="physical-clock"><div><span>core_clk</span><strong>{(1000 / evaluation.evidence.clock_target_mhz).toFixed(3)} ns</strong><small>{evaluation.evidence.clock_target_mhz} MHz target</small></div><i /><div><span>Clock uncertainty</span><strong>0.100 ns</strong><small>8% of period</small></div></div>
        <div className="physical-constraint-list"><div><span>Input delay</span><b>0.150 ns</b></div><div><span>Output delay</span><b>0.150 ns</b></div><div><span>Output load</span><b>0.020</b></div><div><span>Reset</span><b>false path</b></div><div><span>Corner</span><b>TT · 25°C · 1.80 V</b></div></div>
        <p className="physical-constraint-note">The 800 MHz value is an implementation objective. It is not achieved timing until post-route setup and hold reports exist.</p>
      </section>

      <section className="panel physical-handoff-panel" id="physical-handoff">
        <PanelTitle label="Evidence handoff contract" meta={`${evaluation.scope.label} · ${evaluation.scope.objective}`} />
        <div className="physical-output-grid">{requiredOutputs.map((output, index) => <article key={output}><b>{String(index + 1).padStart(2, '0')}</b><div><h3>{output}</h3><p>{index < 4 ? 'Open-source implementation artifact · absent until the corresponding tool stage runs' : 'Reviewed verification artifact · absent until implementation converges'}</p></div><span>required</span></article>)}</div>
        <div className="physical-boundary"><strong>Production boundary</strong><p>Sky130 is a public research proxy. Qualified 2 nm libraries, SRAM and PHY macros, hybrid-bond rules, package extraction, EM/IR, reliability, and production signoff must remain inside the authorized foundry enclave.</p></div>
        <div className="physical-limit-list">{evaluation.evidence.limitations.map((limitation) => <span key={limitation}>{limitation}</span>)}</div>
      </section>

      <section className="gate-note physical-lab-hold"><strong>Current decision · HOLD</strong><p>Technology mapping passed. Physical implementation has not passed until placed and routed geometry, extracted parasitics, timing, DRC/LVS, power integrity, and independent review artifacts satisfy their contracts.</p></section>
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

function GuideControlPanel({ level, setLevel, navigate }: {
  level: UserLevel;
  setLevel: (level: UserLevel) => void;
  navigate: (view: View) => void;
}) {
  const topics = [
    ['Start here', 'guide-start'],
    ['Workflow', 'guide-workflow'],
    ['Views', 'guide-views'],
    ['Roles', 'guide-roles'],
    ['Evidence', 'guide-evidence'],
    ['Recipes', 'guide-recipes'],
    ['Help', 'guide-help'],
  ];
  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <aside className="control-rail guide-control-rail">
      <div className="control-head"><div><p className="eyebrow">Learning controls</p><h2>User guide</h2></div><button onClick={() => jump('guide-start')}>Top</button></div>
      <div className="control-scroll">
        <ControlGroup title="Experience level">
          <div className="guide-control-levels">{(['beginner', 'practitioner', 'expert'] as UserLevel[]).map((item) => <button key={item} className={level === item ? 'active' : ''} onClick={() => setLevel(item)} aria-pressed={level === item}>{item}</button>)}</div>
        </ControlGroup>
        <ControlGroup title="Guide topics">
          <div className="guide-topic-list">{topics.map(([label, id], index) => <button key={id} onClick={() => jump(id)}><b>{String(index + 1).padStart(2, '0')}</b><span>{label}</span><i>→</i></button>)}</div>
        </ControlGroup>
        <ControlGroup title="Start working">
          <div className="guide-start-list"><button onClick={() => navigate('readiness')}>T0 readiness <span>→</span></button><button onClick={() => navigate('architecture')}>T0 architecture <span>→</span></button><button onClick={() => navigate('digital')}>RTL + verification <span>→</span></button><button onClick={() => navigate('physical')}>Physical implementation <span>→</span></button><button onClick={() => navigate('t1')}>T1 scale-up <span>→</span></button><button onClick={() => navigate('foundry')}>Foundry readiness <span>→</span></button><button onClick={() => navigate('x1')}>Production X1 <span>→</span></button><button onClick={() => navigate('agents')}>Agent operations <span>→</span></button></div>
        </ControlGroup>
        <section className="route-risk low"><span>Guide principle</span><strong>Evidence first</strong><p>Use every chart with its evidence class, limitations, and next replacement artifact.</p></section>
      </div>
      <div className="control-footer"><button className="primary-button wide" onClick={() => navigate('readiness')}>Begin with readiness</button><p>Your selected guide level changes explanations, not engineering results.</p></div>
    </aside>
  );
}

function PhysicalControlPanel({ scope, setScope, utilization, setUtilization, evaluation, selectedStage, setSelectedStage, navigate }: {
  scope: PhysicalReviewScope;
  setScope: (scope: PhysicalReviewScope) => void;
  utilization: number;
  setUtilization: (utilization: number) => void;
  evaluation: ReturnType<typeof evaluatePhysicalImplementation>;
  selectedStage: string;
  setSelectedStage: (stage: string) => void;
  navigate: (view: View) => void;
}) {
  return (
    <aside className="control-rail physical-lab-control">
      <div className="control-head"><div><p className="eyebrow">Physical controls</p><h2>Implementation</h2></div><span className="control-hold">HOLD</span></div>
      <div className="control-scroll">
        <ControlGroup title="Review scope"><div className="digital-scope-control">{(['mapped', 'implementation', 'signoff'] as PhysicalReviewScope[]).map((item) => <button key={item} className={scope === item ? 'active' : ''} onClick={() => setScope(item)}><strong>{item === 'mapped' ? 'Mapped evidence' : item === 'implementation' ? 'Implementation plan' : 'Signoff boundary'}</strong><span>{item === 'mapped' ? 'Reproduced' : 'Planning only'}</span></button>)}</div></ControlGroup>
        <ControlGroup title="Floorplan assumption"><RangeControl label="Target utilization" value={utilization} min={35} max={80} step={5} unit="%" onChange={setUtilization} /><div className="t1-output-list"><span>Estimated core <b>{evaluation.coreSideUm.toFixed(1)} µm</b></span><span>Planning die <b>{evaluation.dieSideUm.toFixed(1)} µm</b></span><span>Routing pressure <b>{evaluation.routingPressure}%</b></span><span>Clock risk <b>{evaluation.clockRisk}</b></span></div></ControlGroup>
        <ControlGroup title="Inspect flow stage"><div className="physical-stage-control">{evaluation.stages.map((stage, index) => <button key={stage.id} className={`${stage.status} ${selectedStage === stage.id ? 'active' : ''}`} onClick={() => setSelectedStage(stage.id)}><b>{String(index + 1).padStart(2, '0')}</b><span>{stage.title}</span><em>{stage.status}</em></button>)}</div></ControlGroup>
        <ControlGroup title="Related workspaces"><div className="guide-start-list"><button onClick={() => navigate('digital')}>RTL + verification <span>→</span></button><button onClick={() => navigate('agents')}>Agent mission control <span>→</span></button><button onClick={() => navigate('foundry')}>Foundry boundary <span>→</span></button></div></ControlGroup>
        <section className="route-risk high"><span>Physical decision</span><strong>{evaluation.decision}</strong><p>{evaluation.nextArtifact}</p></section>
      </div>
      <div className="control-footer"><button className="primary-button wide" onClick={() => setScope(scope === 'mapped' ? 'implementation' : scope === 'implementation' ? 'signoff' : 'mapped')}>Advance implementation scope</button><p>Floorplan controls update planning geometry only; they cannot create implementation evidence.</p></div>
    </aside>
  );
}

function DigitalControlPanel({ scope, setScope, evaluation, selectedModule, setSelectedModule, navigate }: {
  scope: DigitalReviewScope;
  setScope: (scope: DigitalReviewScope) => void;
  evaluation: ReturnType<typeof evaluateDigitalImplementation>;
  selectedModule: string;
  setSelectedModule: (module: string) => void;
  navigate: (view: View) => void;
}) {
  return (
    <aside className="control-rail digital-control-rail">
      <div className="control-head"><div><p className="eyebrow">Digital controls</p><h2>RTL evidence</h2></div><span className="control-hold">HOLD</span></div>
      <div className="control-scroll">
        <ControlGroup title="Review scope"><div className="digital-scope-control">{(['current', 'regression', 'closure'] as DigitalReviewScope[]).map((item) => <button key={item} className={scope === item ? 'active' : ''} onClick={() => setScope(item)}><strong>{item === 'current' ? 'Current evidence' : item === 'regression' ? 'Regression plan' : 'Closure plan'}</strong><span>{item === 'current' ? 'Reproduced now' : 'Planning only'}</span></button>)}</div></ControlGroup>
        <ControlGroup title="Inspect module"><div className="digital-module-control">{DIGITAL_MODULES.map((module) => <button key={module.id} className={selectedModule === module.id ? 'active' : ''} onClick={() => setSelectedModule(module.id)}><span>{module.name}</span><b>{module.lines}</b></button>)}</div></ControlGroup>
        <ControlGroup title="Evidence summary"><div className="t1-output-list"><span>Top module <b>{evaluation.evidence.top}</b></span><span>Channels <b>{evaluation.evidence.channels}</b></span><span>Generic cells <b>{evaluation.evidence.cells.toLocaleString()}</b></span><span>Formal proofs <b>{evaluation.evidence.formal_proofs}</b></span><span>Passed checks <b>{evaluation.passCount}/{evaluation.checks.length}</b></span><span>Readiness <b>{evaluation.weightedReadiness}%</b></span></div></ControlGroup>
        <ControlGroup title="Related workspaces"><div className="guide-start-list"><button onClick={() => navigate('physical')}>Physical implementation <span>→</span></button><button onClick={() => navigate('agents')}>Agent mission control <span>→</span></button><button onClick={() => navigate('gates')}>T0 evidence gates <span>→</span></button><button onClick={() => navigate('architecture')}>T0 architecture <span>→</span></button></div></ControlGroup>
        <section className="route-risk high"><span>Digital decision</span><strong>{evaluation.releaseDecision}</strong><p>{evaluation.nextArtifact}</p></section>
      </div>
      <div className="control-footer"><button className="primary-button wide" onClick={() => setScope(scope === 'current' ? 'regression' : scope === 'regression' ? 'closure' : 'current')}>Advance review scope</button><p>Changing scope reveals planned targets; it never marks unexecuted work complete.</p></div>
    </aside>
  );
}

function AgentControlPanel({ mission, evaluation, runStatus, onMissionChange, onStart, onPause, onReset, navigate }: {
  mission: AgentMission;
  evaluation: ReturnType<typeof evaluateAgentMission>;
  runStatus: AgentRunStatus;
  onMissionChange: (mission: AgentMission) => void;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  navigate: (view: View) => void;
}) {
  return (
    <aside className="control-rail agent-control-rail">
      <div className="control-head"><div><p className="eyebrow">Orchestration controls</p><h2>Agent mission</h2></div><button onClick={onReset}>Reset</button></div>
      <div className="control-scroll">
        <ControlGroup title="Mission objective"><div className="agent-mission-select">{(Object.keys(AGENT_MISSIONS) as AgentMission[]).map((item) => <button key={item} className={mission === item ? 'active' : ''} onClick={() => onMissionChange(item)}><strong>{AGENT_MISSIONS[item].label}</strong><span>{AGENT_MISSIONS[item].objective}</span></button>)}</div></ControlGroup>
        <ControlGroup title="Replay control"><div className="agent-run-control"><button className="primary-button" onClick={runStatus === 'running' ? onPause : onStart}>{runStatus === 'running' ? 'Pause replay' : runStatus === 'blocked' ? 'Replay open lane' : 'Start mission replay'}</button><div><span>Open-lane progress</span><strong>{evaluation.completedOpenNodes}/{evaluation.safeNodeCount}</strong></div><div className="agent-control-meter"><i style={{ width: `${evaluation.progressPercent}%` }} /></div><p>Deterministic UI replay only. No external tool, compute cluster, lab, or foundry job is started.</p></div></ControlGroup>
        <ControlGroup title="Current agent"><div className="agent-current-card"><span>{evaluation.currentNode.status}</span><h3>{evaluation.currentNode.agent}</h3><p>{evaluation.currentNode.title}</p><small>{evaluation.currentNode.tools}</small></div></ControlGroup>
        <ControlGroup title="Evidence workspaces"><div className="guide-start-list"><button onClick={() => navigate('digital')}>RTL + verification <span>→</span></button><button onClick={() => navigate('physical')}>Physical implementation <span>→</span></button><button onClick={() => navigate('gates')}>T0 evidence gates <span>→</span></button><button onClick={() => navigate('foundry')}>Foundry boundary <span>→</span></button><button onClick={() => navigate('x1')}>Production X1 <span>→</span></button></div></ControlGroup>
        <section className="route-risk high"><span>Mission decision</span><strong>{evaluation.decision}</strong><p>{evaluation.mission.boundary}</p></section>
      </div>
      <div className="control-footer"><button className="primary-button wide" onClick={runStatus === 'running' ? onPause : onStart}>{runStatus === 'running' ? 'Pause safe replay' : 'Replay safe automation'}</button><p>Agents can recommend and prepare evidence. They cannot create missing physical proof or authorize fabrication.</p></div>
    </aside>
  );
}

function X1ControlPanel({ config, updateConfig, evaluation, navigate }: {
  config: X1Config;
  updateConfig: (config: X1Config) => void;
  evaluation: ReturnType<typeof evaluateX1>;
  navigate: (view: View) => void;
}) {
  return (
    <aside className="control-rail x1-control-rail">
      <div className="control-head"><div><p className="eyebrow">Production variables</p><h2>X1 system</h2></div><button onClick={() => updateConfig(DEFAULT_X1_CONFIG)}>Reset</button></div>
      <div className="control-scroll">
        <ControlGroup title="Stack configuration">
          <SegmentedControl label="Capacity / stack" value={config.capacityGibPerStack} options={[64, 128]} unit="GB" onChange={(value) => updateConfig({ ...config, capacityGibPerStack: value as 64 | 128 })} />
          <SegmentedControl label="Active stacks" value={config.stackCount} options={[1, 2, 4, 8]} onChange={(value) => updateConfig({ ...config, stackCount: value as 1 | 2 | 4 | 8 })} />
          <div className="control"><div className="control-label"><label>Performance state</label><span>{X1_STATE_TABLE[config.performanceState].id}</span></div><div className="x1-state-control">{(['eco', 'nominal', 'performance', 'turbo'] as X1PerformanceState[]).map((state) => <button key={state} className={config.performanceState === state ? 'active' : ''} onClick={() => updateConfig({ ...config, performanceState: state })}><b>{X1_STATE_TABLE[state].id}</b><span>{state}</span></button>)}</div></div>
        </ControlGroup>
        <ControlGroup title="Traffic balance">
          <RangeControl label="Workload demand" value={config.workloadDemandPercent} min={20} max={100} step={5} unit="%" onChange={(value) => updateConfig({ ...config, workloadDemandPercent: value })} />
          <RangeControl label="Useful efficiency" value={config.usefulEfficiencyPercent} min={50} max={95} step={1} unit="%" onChange={(value) => updateConfig({ ...config, usefulEfficiencyPercent: value })} />
          <RangeControl label="Accelerator fabric" value={config.acceleratorFabricTbps} min={16} max={100} step={2} unit="TB/s" onChange={(value) => updateConfig({ ...config, acceleratorFabricTbps: value })} />
        </ControlGroup>
        <ControlGroup title="Package distribution">
          <RangeControl label="Interposer route layers" value={config.interposerRoutingLayers} min={6} max={16} step={1} onChange={(value) => updateConfig({ ...config, interposerRoutingLayers: value })} />
          <SegmentedControl label="Distributed compute ports" value={config.distributedComputePorts} options={[8, 16, 24, 32]} onChange={(value) => updateConfig({ ...config, distributedComputePorts: value })} />
        </ControlGroup>
        <ControlGroup title="Live system outputs"><div className="t1-output-list"><span>Raw / stack <b>{evaluation.rawBandwidthPerStackTbps.toFixed(3)} TB/s</b></span><span>Aggregate raw <b>{evaluation.aggregateRawBandwidthTbps.toFixed(3)} TB/s</b></span><span>Delivered proxy <b>{evaluation.deliveredBandwidthTbps.toFixed(1)} TB/s</b></span><span>Memory-system power <b>{evaluation.memorySystemPowerWatts.toFixed(0)} W</b></span><span>Payload lanes <b>{evaluation.totalPayloadLanes.toLocaleString()}</b></span><span>Routing pressure <b>{evaluation.routingPressurePercent.toFixed(0)}%</b></span></div></ControlGroup>
        <section className={`route-risk ${evaluation.routingPressurePercent > 100 ? 'high' : 'watch'}`}><span>System limiter</span><strong>{evaluation.bottleneck}</strong><p>Production decision remains {evaluation.decision}; these are architecture calculations and planning proxies.</p></section>
      </div>
      <div className="control-footer"><button className="primary-button wide" onClick={() => navigate('t1')}>Review required T1 proof</button><p>Controls change the production planning model only. They cannot satisfy a measured qualification gate.</p></div>
    </aside>
  );
}

function FoundryControlPanel({ readiness, navigate }: {
  readiness: ReturnType<typeof evaluateFoundryReadiness>;
  navigate: (view: View) => void;
}) {
  return (
    <aside className="control-rail foundry-control-rail">
      <div className="control-head"><div><p className="eyebrow">Release controls</p><h2>Foundry entry</h2></div><span className="control-hold">HOLD</span></div>
      <div className="control-scroll">
        <ControlGroup title="Decision inputs">
          <div className="t1-output-list"><span>Measured T0 gates <b>{readiness.verifiedT0Gates}/{readiness.requiredT0Gates}</b></span><span>Qualified inputs <b>{readiness.readyInputs}/{readiness.totalInputs}</b></span><span>Planned inputs <b>{readiness.plannedInputs}</b></span><span>Absent inputs <b>{readiness.absentInputs}</b></span><span>Restricted inputs <b>{readiness.restrictedInputs}</b></span></div>
        </ControlGroup>
        <ControlGroup title="Execution lanes">
          <div className="foundry-lane-list"><div><b>01</b><span>Open lane<small>Plans, manifests, public proxies</small></span></div><div><b>02</b><span>Restricted lane<small>Qualified PDK, IP, package, signoff</small></span></div><div><b>03</b><span>Evidence return<small>Allowlisted metrics, hashes, decisions</small></span></div></div>
        </ControlGroup>
        <ControlGroup title="Review workspaces">
          <div className="guide-start-list"><button onClick={() => navigate('gates')}>T0 evidence gates <span>→</span></button><button onClick={() => navigate('t1')}>T1 scale-up evidence <span>→</span></button><button onClick={() => navigate('guide')}>Foundry guide path <span>→</span></button></div>
        </ControlGroup>
        <section className="route-risk high"><span>Fabrication policy</span><strong>{readiness.decision}</strong><p>{readiness.blockers[0]}</p></section>
      </div>
      <div className="control-footer"><button className="primary-button wide" onClick={() => navigate('gates')}>Review blocking gates</button><p>This workspace defines a handoff contract. It does not ingest proprietary data or approve tapeout.</p></div>
    </aside>
  );
}

function T1ControlPanel({ config, updateConfig, evaluation, campaign, physical }: {
  config: T1Config;
  updateConfig: (config: T1Config) => void;
  evaluation: ReturnType<typeof evaluateT1>;
  campaign: T1DigitalCampaign;
  physical: T1PhysicalProxy;
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
        <ControlGroup title="Physical proxy assumptions">
          <SegmentedControl label="Bond pitch" value={config.bondPitchUm} options={[2, 3, 5]} unit="µm" onChange={(value) => updateConfig({ ...config, bondPitchUm: value as 2 | 3 | 5 })} />
          <RangeControl label="Package route length" value={config.packageRouteLengthMm} min={5} max={20} step={1} unit="mm" onChange={(value) => updateConfig({ ...config, packageRouteLengthMm: value })} />
          <RangeControl label="Cooling resistance" value={config.coolingResistanceKPerW} min={0.35} max={1.2} step={0.05} unit="K/W" onChange={(value) => updateConfig({ ...config, coolingResistanceKPerW: value })} />
          <RangeControl label="Active workload" value={config.activityPercent} min={40} max={100} step={5} unit="%" onChange={(value) => updateConfig({ ...config, activityPercent: value })} />
        </ControlGroup>
        <ControlGroup title="Live analytical outputs">
          <div className="t1-output-list"><span>Raw bandwidth <b>{evaluation.rawBandwidthTbps.toFixed(3)} TB/s</b></span><span>Dense stream proxy <b>{campaign.workloads[0].usefulBandwidthTbps.toFixed(3)} TB/s</b></span><span>Total active power <b>{physical.power.totalPowerWatts.toFixed(1)} W</b></span><span>Stack hotspot <b>{physical.thermal.hotspotC.toFixed(1)}°C</b></span><span>Routing congestion <b>{physical.routing.congestionPercent.toFixed(0)}%</b></span><span>SRAM / region <b>{evaluation.sramPerRegionMib.toFixed(0)} MB</b></span></div>
        </ControlGroup>
        <section className={`route-risk ${physical.thermal.risk === 'high' || physical.routing.risk === 'high' || physical.package.risk === 'high' ? 'high' : 'watch'}`}><span>T1 proxy risk</span><strong>{physical.routing.risk} / {physical.thermal.risk} / {physical.package.risk}</strong><p>Routing, thermal, and package indicators respectively. Foundry entry remains {evaluation.entryDecision}.</p></section>
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
