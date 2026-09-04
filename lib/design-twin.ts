export type TwinOverlay = 'circuitry' | 'architecture' | 'bandwidth' | 'power' | 'thermal' | 'evidence';
export type TwinStageStatus = 'executed' | 'modeled' | 'planned' | 'restricted';

export type TwinBuildStep = {
  id: string;
  short: string;
  title: string;
  domain: string;
  status: TwinStageStatus;
  focus: 'system' | 'stack' | 'base' | 'interposer' | 'accelerator';
  evidence: string;
  artifact: string;
};

export const TWIN_OVERLAYS: Array<{ id: TwinOverlay; label: string; detail: string }> = [
  { id: 'circuitry', label: 'Micro-circuitry', detail: 'Hierarchical links, NoC meshes, TSVs, hybrid bonds, and animated package traffic.' },
  { id: 'architecture', label: 'Architecture', detail: 'Physical hierarchy, die roles, lanes, capacity, and package topology.' },
  { id: 'bandwidth', label: 'Bandwidth', detail: 'Per-stack supply and accelerator-ingest pressure from the X1 planning model.' },
  { id: 'power', label: 'Power', detail: 'Activity-scaled memory power envelope; values are planning proxies.' },
  { id: 'thermal', label: 'Thermal', detail: 'Relative vertical and package hotspot risk; no measured X1 thermal evidence exists.' },
  { id: 'evidence', label: 'Evidence', detail: 'Executed, modeled, planned, and restricted boundaries across the build.' },
];

export const TWIN_BUILD_STEPS: TwinBuildStep[] = [
  { id: 'requirements', short: '01', title: 'Requirements & contracts', domain: 'System', status: 'executed', focus: 'system', evidence: 'Versioned T0, T1, and X1 architecture contracts are loaded.', artifact: 'Traceable requirement set' },
  { id: 'architecture', short: '02', title: 'Architecture exploration', domain: 'System', status: 'executed', focus: 'system', evidence: 'Deterministic capacity, bandwidth, power, and workload models execute locally.', artifact: 'Selected architecture state' },
  { id: 'rtl', short: '03', title: 'RTL implementation', domain: 'Digital', status: 'executed', focus: 'base', evidence: 'A synthesizable T0 channel and SECDED datapath are versioned.', artifact: 'Elaborated RTL hierarchy' },
  { id: 'formal', short: '04', title: 'Formal & regression', domain: 'Verification', status: 'executed', focus: 'base', evidence: 'Bounded formal properties pass; full randomized closure remains open.', artifact: 'Proof and regression ledger' },
  { id: 'mapping', short: '05', title: 'Technology mapping', domain: 'Physical', status: 'executed', focus: 'base', evidence: '2,447 cells map to the public Sky130 HD library.', artifact: 'Mapped netlist + cell report' },
  { id: 'floorplan', short: '06', title: 'Floorplan & power intent', domain: 'Physical', status: 'planned', focus: 'base', evidence: 'Target utilization and geometry are analytical planning inputs.', artifact: 'Placed DEF + power plan' },
  { id: 'place-route', short: '07', title: 'Place, clock & route', domain: 'Physical', status: 'planned', focus: 'base', evidence: 'Placement, CTS, routing, and extraction have not been executed.', artifact: 'Routed DEF + SPEF' },
  { id: 'package', short: '08', title: 'Package & interposer', domain: 'Package', status: 'modeled', focus: 'interposer', evidence: 'Eight-stack topology and routing pressure are deterministic X1 proxies.', artifact: 'Package connectivity model' },
  { id: 'multiphysics', short: '09', title: 'Power, thermal & SI', domain: 'Multiphysics', status: 'modeled', focus: 'stack', evidence: 'Power and thermal overlays are planning proxies, not measured signoff.', artifact: 'Coupled analysis reports' },
  { id: 'signoff', short: '10', title: 'Foundry signoff', domain: 'Foundry', status: 'restricted', focus: 'interposer', evidence: 'Qualified PDK, IP, SRAM, PHY, DRC/LVS, EM/IR, and timing are absent.', artifact: 'Authorized signoff package' },
  { id: 'silicon', short: '11', title: 'Assembly & silicon test', domain: 'Manufacturing', status: 'restricted', focus: 'stack', evidence: 'Known-good-die, bond yield, repair, assembly, and silicon results are absent.', artifact: 'Manufacturing + characterization data' },
  { id: 'release', short: '12', title: 'Human release decision', domain: 'Governance', status: 'restricted', focus: 'accelerator', evidence: 'Production release remains HOLD until measured evidence and named approvals exist.', artifact: 'Signed release decision' },
];

export const TWIN_HIERARCHY = [
  { id: 'twin-system', label: 'X1 package twin', meta: '8 stacks · accelerator' },
  { id: 'twin-reference', label: 'Real-chip reference', meta: 'Earl Grey · SKY130' },
  { id: 'twin-circuit', label: 'Micro-circuit network', meta: '75,776 conductors' },
  { id: 'twin-accelerator', label: 'Accelerator die', meta: '48 TB/s fabric proxy' },
  { id: 'twin-interposer', label: 'Active interposer', meta: '12 routing layers' },
  { id: 'twin-stacks', label: 'Memory stacks', meta: '8 × 16-high' },
  { id: 'twin-base', label: 'Intelligent base dies', meta: '8 × 128 MB SRAM' },
  { id: 'twin-build', label: 'Build sequence', meta: '12 gated steps' },
];

export function twinStageCounts() {
  return TWIN_BUILD_STEPS.reduce<Record<TwinStageStatus, number>>((counts, step) => {
    counts[step.status] += 1;
    return counts;
  }, { executed: 0, modeled: 0, planned: 0, restricted: 0 });
}

export function twinStageProgress(activeStep: number) {
  return Math.round(((Math.max(0, Math.min(TWIN_BUILD_STEPS.length - 1, activeStep)) + 1) / TWIN_BUILD_STEPS.length) * 100);
}
