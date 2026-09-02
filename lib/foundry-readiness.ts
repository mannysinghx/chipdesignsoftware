import type { GateResult } from './t0-model.ts';

export type FoundryInputStatus = 'ready' | 'planned' | 'absent';
export type FoundrySensitivity = 'open' | 'restricted';

export type FoundryInput = {
  id: string;
  domain: string;
  title: string;
  status: FoundryInputStatus;
  sensitivity: FoundrySensitivity;
  requiredArtifact: string;
  owner: string;
  exportPolicy: string;
};

export type FoundryApproval = {
  id: string;
  title: string;
  owner: string;
  status: 'complete' | 'planned' | 'blocked';
  exitEvidence: string;
};

export type BoundaryStage = {
  id: string;
  title: string;
  zone: 'open' | 'boundary' | 'restricted' | 'return';
  accepts: string;
  emits: string;
};

export const DEFAULT_FOUNDRY_INPUTS: FoundryInput[] = [
  {
    id: 'control-contract',
    domain: 'Control plane',
    title: 'Versioned job-manifest contract',
    status: 'ready',
    sensitivity: 'open',
    requiredArtifact: 'Machine-readable inputs, tool identity, limits, requested checks, and output allowlist.',
    owner: 'Platform engineering',
    exportPolicy: 'Full schema and example manifests may remain open.',
  },
  {
    id: 'enclave-runner',
    domain: 'Security',
    title: 'Isolated execution adapter',
    status: 'planned',
    sensitivity: 'open',
    requiredArtifact: 'Ephemeral runner, signed container allowlist, secret injection, network deny rules, and audit events.',
    owner: 'Security + infrastructure',
    exportPolicy: 'Runner source may be open; credentials and mounted artifacts may not.',
  },
  {
    id: 'pdk',
    domain: 'Process',
    title: 'Qualified 2 nm PDK and rule decks',
    status: 'absent',
    sensitivity: 'restricted',
    requiredArtifact: 'Authorized technology files, timing models, extraction rules, DRC/LVS decks, and version notice.',
    owner: 'Foundry interface',
    exportPolicy: 'Only tool status, sanitized counts, hashes, and approved reports may leave the enclave.',
  },
  {
    id: 'sram',
    domain: 'Memory IP',
    title: 'Production SRAM compiler and macros',
    status: 'absent',
    sensitivity: 'restricted',
    requiredArtifact: '64 MB implementation plan, generated views, characterization corners, repair, redundancy, and test collateral.',
    owner: 'Memory IP lead',
    exportPolicy: 'No compiler, netlist, layout, liberty, or characterization source leaves the enclave.',
  },
  {
    id: 'phy',
    domain: 'Interface IP',
    title: 'Production PHY and I/O models',
    status: 'absent',
    sensitivity: 'restricted',
    requiredArtifact: 'Qualified 4,096-lane PHY implementation, electrical models, timing views, repair hooks, and bring-up plan.',
    owner: 'PHY lead',
    exportPolicy: 'Only approved margins, pass/fail state, report hashes, and provenance may leave the enclave.',
  },
  {
    id: 'bond-package',
    domain: 'Assembly',
    title: 'Hybrid-bond and package stack',
    status: 'absent',
    sensitivity: 'restricted',
    requiredArtifact: 'Qualified pitch, stackup, materials, keep-outs, yield assumptions, test access, and assembly tolerances.',
    owner: 'Package + foundry teams',
    exportPolicy: 'Geometry and process data stay restricted; approved aggregate margins may return.',
  },
  {
    id: 'signoff',
    domain: 'Signoff',
    title: 'Extraction and signoff tool decks',
    status: 'absent',
    sensitivity: 'restricted',
    requiredArtifact: 'Approved RC extraction, STA, power integrity, reliability, DRC, LVS, density, and fill configurations.',
    owner: 'Physical-design lead',
    exportPolicy: 'Return signed summaries, violations, waivers, hashes, and approved debug excerpts only.',
  },
  {
    id: 'manufacturing-test',
    domain: 'Productization',
    title: 'Manufacturing and test collateral',
    status: 'absent',
    sensitivity: 'restricted',
    requiredArtifact: 'DFT architecture, memory BIST/repair, wafer/package test, screening, traceability, and characterization plan.',
    owner: 'DFT + product engineering',
    exportPolicy: 'Approved coverage and readiness summaries may return; vectors and manufacturing data remain restricted.',
  },
];

export const FOUNDRY_BOUNDARY: BoundaryStage[] = [
  {
    id: 'open-control',
    title: 'Open control plane',
    zone: 'open',
    accepts: 'Architecture revision, requested checks, public proxy evidence, and review purpose.',
    emits: 'Canonical job request with no foundry secrets.',
  },
  {
    id: 'signed-manifest',
    title: 'Signed manifest gate',
    zone: 'boundary',
    accepts: 'Pinned tools, input hashes, resource limits, output allowlist, and named approvers.',
    emits: 'Authenticated, immutable execution authorization.',
  },
  {
    id: 'restricted-runner',
    title: 'Restricted enclave runner',
    zone: 'restricted',
    accepts: 'Mounted PDK/IP/package inputs and the approved manifest.',
    emits: 'Raw signoff artifacts retained inside the enclave.',
  },
  {
    id: 'evidence-return',
    title: 'Redacted evidence return',
    zone: 'return',
    accepts: 'Allowlisted metrics, sanitized violations, hashes, provenance, and human decisions.',
    emits: 'Reviewable evidence without proprietary source artifacts.',
  },
];

export const FOUNDRY_APPROVALS: FoundryApproval[] = [
  { id: 'architecture', title: 'Architecture baseline', owner: 'Chief architect', status: 'complete', exitEvidence: 'T1 contract is versioned; derived assumptions are labeled.' },
  { id: 't0-evidence', title: 'Measured T0 gate closure', owner: 'Silicon validation', status: 'blocked', exitEvidence: 'All 12 T0 gates carry reviewed measured passing evidence.' },
  { id: 'qualified-inputs', title: 'Qualified input intake', owner: 'Foundry program lead', status: 'blocked', exitEvidence: 'Every required PDK, IP, package, and test input is licensed, hashed, and mounted.' },
  { id: 'security', title: 'Security and legal authorization', owner: 'Security + legal', status: 'planned', exitEvidence: 'Data handling, access, retention, export controls, and audit policy are approved.' },
  { id: 'signoff-plan', title: 'Signoff plan review', owner: 'Design review board', status: 'planned', exitEvidence: 'Corners, checks, owners, waivers, and release criteria are signed.' },
  { id: 'tapeout', title: 'Tapeout authorization', owner: 'Executive review board', status: 'blocked', exitEvidence: 'All preceding approvals and signoff evidence are complete; no expired waiver remains.' },
];

export function evaluateFoundryReadiness(t0Gates: GateResult[], inputs: FoundryInput[] = DEFAULT_FOUNDRY_INPUTS) {
  const verifiedT0Gates = t0Gates.filter((gate) => gate.status === 'pass').length;
  const readyInputs = inputs.filter((input) => input.status === 'ready').length;
  const plannedInputs = inputs.filter((input) => input.status === 'planned').length;
  const absentInputs = inputs.filter((input) => input.status === 'absent').length;
  const restrictedInputs = inputs.filter((input) => input.sensitivity === 'restricted').length;
  const allInputsReady = readyInputs === inputs.length;
  const allT0GatesVerified = t0Gates.length > 0 && verifiedT0Gates === t0Gates.length;
  const fabricationAuthorized = allInputsReady && allT0GatesVerified;
  const platformPreparedPercent = Math.round(((readyInputs + plannedInputs * 0.5) / inputs.length) * 100);

  return {
    verifiedT0Gates,
    requiredT0Gates: t0Gates.length,
    readyInputs,
    plannedInputs,
    absentInputs,
    totalInputs: inputs.length,
    restrictedInputs,
    platformPreparedPercent,
    fabricationAuthorized,
    decision: fabricationAuthorized ? 'ready-for-review' as const : 'hold' as const,
    blockers: [
      ...(allT0GatesVerified ? [] : [`${t0Gates.length - verifiedT0Gates} T0 gates still lack measured passing evidence.`]),
      ...(allInputsReady ? [] : [`${inputs.length - readyInputs} qualified foundry inputs are not ready.`]),
      'A named human review board—not an AI agent—must authorize irreversible fabrication spend.',
    ],
    inputs,
    boundary: FOUNDRY_BOUNDARY,
    approvals: FOUNDRY_APPROVALS,
  };
}
