export type PhysicalReviewScope = 'mapped' | 'implementation' | 'signoff';
export type PhysicalStageStatus = 'pass' | 'ready' | 'planned' | 'restricted';

export type PhysicalEvidence = {
  status: string;
  tool: string;
  top: string;
  platform: string;
  platform_commit: string;
  liberty_corner: string;
  clock_target_mhz: number;
  mapped_cells: number;
  sequential_cells: number;
  chip_area_um2: number;
  cell_histogram: Record<string, number>;
  checks: string[];
  limitations: string[];
};

export const PHYSICAL_STAGES = [
  { id: 'rtl', title: 'RTL handoff', tool: 'Yosys', status: 'pass', artifact: 'Elaborated aimem_t0_channel', detail: 'Synthesizable channel and SECDED sources are versioned.' },
  { id: 'mapping', title: 'Technology mapping', tool: 'Yosys + ABC', status: 'pass', artifact: 'Sky130 standard-cell netlist', detail: 'All functional cells map to the public Sky130 HD library.' },
  { id: 'constraints', title: 'Timing contract', tool: 'SDC', status: 'ready', artifact: 'Versioned 800 MHz constraint set', detail: 'Clock, uncertainty, I/O delay, reset exception, and output load are declared.' },
  { id: 'floorplan', title: 'Floorplan', tool: 'OpenROAD', status: 'planned', artifact: 'Placed DEF', detail: 'Choose utilization, die/core margins, pin plan, macro placeholders, and power intent.' },
  { id: 'placement', title: 'Placement', tool: 'OpenROAD', status: 'planned', artifact: 'Legalized placement + congestion report', detail: 'Global and detailed placement must close density and congestion limits.' },
  { id: 'cts', title: 'Clock tree', tool: 'TritonCTS', status: 'planned', artifact: 'Clock-tree report', detail: 'Slew, insertion delay, skew, buffering, and clock power require implementation evidence.' },
  { id: 'routing', title: 'Routing', tool: 'FastRoute + TritonRoute', status: 'planned', artifact: 'Routed DEF', detail: 'Global and detailed routing must resolve antenna, congestion, and design-rule violations.' },
  { id: 'extraction', title: 'Parasitic extraction', tool: 'OpenRCX', status: 'planned', artifact: 'SPEF', detail: 'Interconnect resistance and capacitance must replace wireload assumptions.' },
  { id: 'timing', title: 'Post-route timing', tool: 'OpenSTA', status: 'planned', artifact: 'Setup and hold reports', detail: 'All declared corners and modes need reviewed slack, slew, and capacitance evidence.' },
  { id: 'verification', title: 'Physical verification', tool: 'KLayout + Magic + Netgen', status: 'planned', artifact: 'DRC and LVS reports', detail: 'Layout geometry and extracted connectivity must match the approved source.' },
  { id: 'production', title: 'Production signoff', tool: 'Qualified foundry enclave', status: 'restricted', artifact: 'Authorized signoff package', detail: 'Production PDK, SRAM, PHY, bond, EM/IR, reliability, and signoff remain restricted.' },
] as const;

const REVIEW_SCOPES = {
  mapped: { label: 'Mapped evidence', objective: 'Review the reproduced standard-cell mapping and declared constraints.', visibleThrough: 'constraints' },
  implementation: { label: 'Implementation plan', objective: 'Prepare the public-PDK floorplan-through-physical-verification execution contract.', visibleThrough: 'verification' },
  signoff: { label: 'Signoff boundary', objective: 'Expose the exact boundary between public proxy results and qualified production signoff.', visibleThrough: 'production' },
} as const;

export function evaluatePhysicalImplementation(scope: PhysicalReviewScope, utilizationPercent: number, evidence: PhysicalEvidence) {
  const utilization = Math.max(35, Math.min(80, utilizationPercent));
  const coreAreaUm2 = evidence.chip_area_um2 / (utilization / 100);
  const coreSideUm = Math.sqrt(coreAreaUm2);
  const dieSideUm = coreSideUm + 40;
  const sequentialPercent = (evidence.sequential_cells / evidence.mapped_cells) * 100;
  const topCells = Object.entries(evidence.cell_histogram)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name: name.replace('sky130_fd_sc_hd__', ''), count, percent: (count / evidence.mapped_cells) * 100 }));
  const routingPressure = Math.round(Math.min(100, utilization * 0.78 + sequentialPercent * 0.65));
  const clockRisk = utilization >= 70 ? 'high' : utilization >= 60 ? 'watch' : 'reviewable';

  return {
    scope: REVIEW_SCOPES[scope],
    stages: PHYSICAL_STAGES,
    evidence,
    utilizationPercent: utilization,
    coreAreaUm2,
    coreSideUm,
    dieSideUm,
    sequentialPercent,
    combinationalCells: evidence.mapped_cells - evidence.sequential_cells,
    topCells,
    routingPressure,
    clockRisk,
    passedStages: PHYSICAL_STAGES.filter((stage) => stage.status === 'pass').length,
    readyStages: PHYSICAL_STAGES.filter((stage) => stage.status === 'ready').length,
    plannedStages: PHYSICAL_STAGES.filter((stage) => stage.status === 'planned').length,
    restrictedStages: PHYSICAL_STAGES.filter((stage) => stage.status === 'restricted').length,
    decision: 'hold' as const,
    nextArtifact: 'Placed DEF with floorplan provenance, utilization, pin plan, power intent, congestion report, and source hashes',
  };
}
