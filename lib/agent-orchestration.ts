export type AgentMission = 't0-closure' | 't1-qualification' | 'x1-production';
export type AgentRunStatus = 'idle' | 'running' | 'paused' | 'blocked';
export type AgentNodeStatus = 'queued' | 'active' | 'complete' | 'blocked';

export type AgentNode = {
  id: string;
  title: string;
  agent: string;
  lane: 'open' | 'external' | 'restricted' | 'human';
  dependsOn: string[];
  tools: string;
  consumes: string;
  artifact: string;
  stopRule: string;
  status: AgentNodeStatus;
};

export const AGENT_MISSIONS = {
  't0-closure': {
    label: 'T0 evidence closure',
    objective: 'Reproduce open-source T0 evidence and prepare the measured-silicon validation package.',
    boundary: 'Silicon test vehicle, lab measurements, and reviewed pass/fail evidence.',
  },
  't1-qualification': {
    label: 'T1 qualification',
    objective: 'Prepare the eight-high, 4,096-lane T1 engineering-sample evidence campaign.',
    boundary: 'Measured T0 gates plus qualified 2 nm, SRAM, PHY, bond, package, and signoff inputs.',
  },
  'x1-production': {
    label: 'Production X1',
    objective: 'Prepare the 16-high, 8,192-lane production system plan and its gated release package.',
    boundary: 'Measured T1 qualification, 16-high package vehicles, production signoff, and human release authorization.',
  },
} as const;

const OPEN_NODES = [
  {
    id: 'contract', title: 'Requirements curator', agent: 'Contract Agent', lane: 'open' as const, dependsOn: [],
    tools: 'Git · JSON Schema · Markdown', consumes: 'Source architecture, constraints, change request',
    artifact: 'Versioned requirements graph and acceptance criteria', stopRule: 'Reject ambiguous units, unlabeled derivations, and conflicting targets.',
  },
  {
    id: 'architecture', title: 'Architecture compiler', agent: 'Architecture Agent', lane: 'open' as const, dependsOn: ['contract'],
    tools: 'Python · NetworkX · NumPy', consumes: 'Requirements graph and selected mission',
    artifact: 'Machine-readable hierarchy, address map, and parameter contract', stopRule: 'Reject invalid dimensions or organization arithmetic.',
  },
  {
    id: 'performance', title: 'Workload and performance', agent: 'Performance Agent', lane: 'open' as const, dependsOn: ['architecture'],
    tools: 'Ramulator2 · DRAMsim3 · Python', consumes: 'Traffic traces, address mapping, scheduler policy',
    artifact: 'Reproducible bandwidth, latency, locality, and queueing report', stopRule: 'Keep analytical, cycle, and external-reference evidence distinct.',
  },
  {
    id: 'rtl', title: 'RTL implementation', agent: 'RTL Agent', lane: 'open' as const, dependsOn: ['architecture'],
    tools: 'Yosys · Verilator · cocotb', consumes: 'Block contract, interfaces, clocks, reset, and behavior',
    artifact: 'Synthesizable RTL, lint, simulation, and generic synthesis evidence', stopRule: 'Reject unsynthesizable logic, hidden stubs, and unconstrained clocks.',
  },
  {
    id: 'formal', title: 'Formal verification', agent: 'Formal Agent', lane: 'open' as const, dependsOn: ['rtl'],
    tools: 'SymbiYosys · yosys-smtbmc · Boolector', consumes: 'RTL, assumptions, assertions, and bounded targets',
    artifact: 'Proof logs, counterexamples, coverage, and explicit bound limits', stopRule: 'Never present bounded proof as unbounded or silicon evidence.',
  },
  {
    id: 'physical', title: 'Physical implementation proxy', agent: 'Physical Agent', lane: 'open' as const, dependsOn: ['rtl'],
    tools: 'OpenROAD · OpenSTA · KLayout · Magic · Netgen', consumes: 'Synthesized design, public PDK, clocks, floorplan, and constraints',
    artifact: 'Public-PDK floorplan, timing, congestion, DRC/LVS, and PPA proxy', stopRule: 'Never relabel public-PDK results as qualified-node signoff.',
  },
  {
    id: 'multiphysics', title: 'Package and multiphysics', agent: 'Multiphysics Agent', lane: 'open' as const, dependsOn: ['performance', 'physical'],
    tools: 'Gmsh · Elmer · OpenFOAM · openEMS · scikit-rf · FreeCAD · KiCad', consumes: 'Geometry, activity, power map, materials, cooling, and link assumptions',
    artifact: 'Thermal, mechanical, link, and package proxy with solver handoffs', stopRule: 'Require mesh, boundary, material, and convergence provenance.',
  },
  {
    id: 'evidence', title: 'Evidence and policy assembly', agent: 'Evidence Agent', lane: 'open' as const, dependsOn: ['performance', 'formal', 'multiphysics'],
    tools: 'OPA/Rego · in-toto · Sigstore · OpenTelemetry', consumes: 'All signed artifacts, hashes, logs, limitations, and gate policies',
    artifact: 'Provenance-linked evidence bundle and promotion recommendation', stopRule: 'Fail closed on missing artifacts, signatures, owners, or evidence class.',
  },
] as const;

const BOUNDARY_NODES = [
  {
    id: 'silicon', title: 'Measured silicon validation', agent: 'Lab + Silicon Team', lane: 'external' as const, dependsOn: ['evidence'],
    tools: 'ATE · BERT · thermal instrumentation · lab telemetry', consumes: 'Test vehicle, bring-up plan, measurement limits',
    artifact: 'Reviewed measured results mapped to gate IDs', stopRule: 'Physical hardware and accountable reviewers are mandatory.',
  },
  {
    id: 'foundry', title: 'Restricted foundry execution', agent: 'Foundry Enclave Agent', lane: 'restricted' as const, dependsOn: ['silicon'],
    tools: 'Qualified PDK/IP/signoff stack inside authorized enclave', consumes: 'Signed manifest and mounted proprietary inputs',
    artifact: 'Allowlisted signoff metrics, hashes, provenance, and sanitized findings', stopRule: 'No proprietary source artifact may leave the enclave.',
  },
  {
    id: 'release', title: 'Fabrication release decision', agent: 'Human Review Board', lane: 'human' as const, dependsOn: ['foundry'],
    tools: 'Policy record · approvals · waiver register', consumes: 'Measured evidence, signoff package, risks, cost, schedule',
    artifact: 'Signed go, rework, or hold decision', stopRule: 'An AI agent may recommend but can never authorize irreversible spend.',
  },
] as const;

export const AGENT_RUNTIME_STACK = [
  ['Agent graph', 'LangGraph', 'Stateful agent routing and tool-use policies'],
  ['Durable workflow', 'Temporal', 'Retries, timers, approvals, and long-running jobs'],
  ['Local model serving', 'vLLM', 'Open-weight model inference inside controlled infrastructure'],
  ['Model gateway', 'LiteLLM', 'Consistent routing, budgets, fallbacks, and audit metadata'],
  ['Event backbone', 'NATS JetStream', 'Task events, evidence notifications, and backpressure'],
  ['System of record', 'PostgreSQL', 'Requirements, runs, gates, ownership, and decisions'],
  ['Artifact storage', 'MinIO', 'Content-addressed traces, reports, logs, models, and bundles'],
  ['Policy engine', 'OPA/Rego', 'Fail-closed promotion and data-boundary rules'],
  ['Provenance', 'in-toto + Sigstore', 'Signed supply-chain and evidence attestations'],
  ['Observability', 'OpenTelemetry + Grafana', 'Traces, metrics, logs, cost, and runtime health'],
] as const;

export function evaluateAgentMission(mission: AgentMission, completedOpenNodes: number, runStatus: AgentRunStatus) {
  const safeCount = OPEN_NODES.length;
  const completed = Math.max(0, Math.min(safeCount, completedOpenNodes));
  const openNodes: AgentNode[] = OPEN_NODES.map((node, index) => ({
    ...node,
    dependsOn: [...node.dependsOn],
    status: index < completed ? 'complete' : runStatus === 'running' && index === completed ? 'active' : 'queued',
  }));
  const boundaryNodes: AgentNode[] = BOUNDARY_NODES.map((node) => ({ ...node, dependsOn: [...node.dependsOn], status: 'blocked' }));
  const nodes = [...openNodes, ...boundaryNodes];
  const currentNode = openNodes.find((node) => node.status === 'active') ?? (completed === safeCount ? boundaryNodes[0] : openNodes[completed]);
  const artifactsReady = openNodes.filter((node) => node.status === 'complete').map((node) => node.artifact);

  return {
    mission: AGENT_MISSIONS[mission],
    nodes,
    openNodes,
    boundaryNodes,
    safeNodeCount: safeCount,
    completedOpenNodes: completed,
    progressPercent: Math.round((completed / safeCount) * 100),
    currentNode,
    artifactsReady,
    safeAutomationComplete: completed === safeCount,
    decision: 'hold' as const,
    blockedCount: boundaryNodes.length,
    activeCount: nodes.filter((node) => node.status === 'active').length,
  };
}
