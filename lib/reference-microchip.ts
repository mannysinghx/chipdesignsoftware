export type ReferenceMacro = {
  id: string;
  label: string;
  referencePattern: string;
  aimemRole: string;
  domain: 'main' | 'always-on';
  x: number;
  z: number;
  width: number;
  depth: number;
};

export const OPEN_TITAN_REFERENCE = {
  name: 'OpenTitan Earl Grey',
  top: 'chip_earlgrey_asic',
  licenseClass: 'open-source hardware reference',
  powerDomains: ['Main', 'Always-on'],
  clocks: ['sys', 'io', 'usb', 'aon'],
  busLevels: 2,
  asicPadCount: 71,
  ioBanks: 4,
  memoryMacros: ['192 KiB boot ROM', '2 MiB RRAM'],
  processStackReference: ['li1', 'met1', 'met2', 'met3', 'met4', 'met5', 'rdl', 'bump'],
  sources: [
    'https://opentitan.org/book/hw/top_earlgrey/doc/design/index.html',
    'https://opentitan.org/book/hw/top_earlgrey/ip_autogen/pinmux/doc/targets.html',
    'https://skywater-pdk.readthedocs.io/en/main/rules/summary.html',
    'https://skywater-pdk.readthedocs.io/en/main/rules/rcx.html',
  ],
} as const;

// Physical organization patterns are adapted to AIMEM functions. These are not
// claims that Earl Grey contains AIMEM blocks or that this is either chip's GDS.
export const AIMEM_REFERENCE_MACROS: ReferenceMacro[] = [
  { id: 'command', label: 'Command processor', referencePattern: 'processor island', aimemRole: 'Host commands and firmware sequencing', domain: 'main', x: -1.75, z: -1.35, width: 1.35, depth: 1.05 },
  { id: 'sram-a', label: 'SRAM bank A', referencePattern: 'memory macro', aimemRole: 'Scheduling and metadata SRAM', domain: 'main', x: -0.2, z: -1.45, width: 1.45, depth: 0.85 },
  { id: 'sram-b', label: 'SRAM bank B', referencePattern: 'memory macro', aimemRole: 'Gather and buffering SRAM', domain: 'main', x: 1.45, z: -1.45, width: 1.4, depth: 0.85 },
  { id: 'xbar-fast', label: 'High-speed NoC', referencePattern: 'high-speed bus cluster', aimemRole: 'Memory traffic crossbar and DMA fabric', domain: 'main', x: -0.9, z: 0.15, width: 2.35, depth: 0.72 },
  { id: 'xbar-slow', label: 'Control NoC', referencePattern: 'low-speed bus cluster', aimemRole: 'Telemetry, configuration, and service fabric', domain: 'always-on', x: 1.55, z: 0.1, width: 1.05, depth: 0.7 },
  { id: 'ecc', label: 'ECC + repair', referencePattern: 'security accelerator island', aimemRole: 'SECDED, lane repair, and fault containment', domain: 'main', x: -1.75, z: 1.35, width: 1.35, depth: 0.95 },
  { id: 'clock', label: 'Clock / reset', referencePattern: 'clock and reset manager', aimemRole: 'Clock trees, reset distribution, and power sequencing', domain: 'always-on', x: -0.15, z: 1.38, width: 1.25, depth: 0.9 },
  { id: 'telemetry', label: 'Telemetry + safety', referencePattern: 'always-on controller island', aimemRole: 'Sensors, watchdogs, logs, and safe-state control', domain: 'always-on', x: 1.45, z: 1.35, width: 1.4, depth: 0.95 },
];

export const SKY130_VISUAL_LAYERS = [
  { id: 'li1', direction: 'horizontal', role: 'Local cell interconnect' },
  { id: 'met1', direction: 'vertical', role: 'Standard-cell routing' },
  { id: 'met2', direction: 'horizontal', role: 'Local signal routing' },
  { id: 'met3', direction: 'vertical', role: 'Block-level signal routing' },
  { id: 'met4', direction: 'horizontal', role: 'Global clock and signal routing' },
  { id: 'met5', direction: 'mesh', role: 'Power distribution and global straps' },
] as const;

// ---------------------------------------------------------------------------
// X1 intelligent base die: floorplan blocks are placed on the 12 × 12 mm
// architectural die from the versioned area budget in aimem-x1-production.json.
// Local +z is the accelerator-facing edge, so the PHY strip always lands next to
// the accelerator memory PHY that serves the stack.
// ---------------------------------------------------------------------------

export const X1_BASE_DIE_MM = 12;

export const X1_BASE_DIE_AREA_BUDGET_MM2 = {
  sram: 43,
  phy: 29,
  controller_and_noc: 18,
  ai_memory_engines: 12,
  ecc_and_ras: 8,
  pmu_dft_security: 6,
  power_clock_bonding_keepout: 28,
  total: 144,
} as const;

export type BaseDieBudgetKey = Exclude<keyof typeof X1_BASE_DIE_AREA_BUDGET_MM2, 'total'>;

export type FloorplanBlock = {
  id: string;
  label: string;
  budget: BaseDieBudgetKey;
  role: string;
  referencePattern: string;
  xMm: [number, number];
  zMm: [number, number];
};

export const BASE_DIE_FLOORPLAN: FloorplanBlock[] = [
  { id: 'phy', label: 'Memory PHY strip', budget: 'phy', role: 'Lane drivers, receivers, training, and repair muxes facing the accelerator', referencePattern: 'edge PHY band', xMm: [-6, 6], zMm: [3.6, 6] },
  { id: 'sram-a', label: 'SRAM bank A', budget: 'sram', role: 'Scheduling and metadata SRAM', referencePattern: 'memory macro', xMm: [-6, -2.65], zMm: [-1.7, 3.6] },
  { id: 'tsv-field', label: 'TSV + bond keep-out field', budget: 'power_clock_bonding_keepout', role: 'Vertical TSV column, hybrid-bond landing, power and clock keep-out', referencePattern: 'bond and feed-through keep-out', xMm: [-2.65, 2.65], zMm: [-1.7, 3.6] },
  { id: 'ctrl-noc', label: 'Controller + NoC', budget: 'controller_and_noc', role: 'Channel controllers, refresh, and the 16-region base-die NoC', referencePattern: 'processor island + high-speed bus cluster', xMm: [2.65, 6], zMm: [-1.7, 3.6] },
  { id: 'sram-b', label: 'SRAM bank B', budget: 'sram', role: 'Gather and buffering SRAM', referencePattern: 'memory macro', xMm: [-6, 0], zMm: [-6, -1.7] },
  { id: 'ai-engines', label: 'AI memory engines', budget: 'ai_memory_engines', role: 'Gather, scatter, compression, and near-memory operators', referencePattern: 'accelerator island', xMm: [0, 2.8], zMm: [-6, -1.7] },
  { id: 'ecc-ras', label: 'ECC + RAS', budget: 'ecc_and_ras', role: 'SECDED, lane repair, scrubbing, and fault containment', referencePattern: 'security accelerator island', xMm: [2.8, 6], zMm: [-4.2, -1.7] },
  { id: 'pmu-dft-sec', label: 'PMU / DFT / security', budget: 'pmu_dft_security', role: 'Power sequencing, clock and reset, test access, and root of trust', referencePattern: 'always-on controller island + clock manager', xMm: [2.8, 6], zMm: [-6, -4.2] },
];

export function floorplanAreaMm2(block: FloorplanBlock) {
  return (block.xMm[1] - block.xMm[0]) * (block.zMm[1] - block.zMm[0]);
}

export function floorplanBudgetCheck() {
  const placed = BASE_DIE_FLOORPLAN.reduce<Record<string, number>>((sums, block) => {
    sums[block.budget] = (sums[block.budget] ?? 0) + floorplanAreaMm2(block);
    return sums;
  }, {});
  const rows = (Object.keys(X1_BASE_DIE_AREA_BUDGET_MM2) as Array<keyof typeof X1_BASE_DIE_AREA_BUDGET_MM2>)
    .filter((key): key is BaseDieBudgetKey => key !== 'total')
    .map((key) => {
      const budgetMm2 = X1_BASE_DIE_AREA_BUDGET_MM2[key];
      const placedMm2 = placed[key] ?? 0;
      return { key, budgetMm2, placedMm2, deviationPercent: ((placedMm2 - budgetMm2) / budgetMm2) * 100 };
    });
  const placedTotal = rows.reduce((sum, row) => sum + row.placedMm2, 0);
  return { rows, placedTotal, dieAreaMm2: X1_BASE_DIE_MM * X1_BASE_DIE_MM, maxDeviationPercent: Math.max(...rows.map((row) => Math.abs(row.deviationPercent))) };
}

// Accelerator die organization: a reticle-class compute die with a central
// shared-SRAM strip, a compute-tile array, and eight edge memory PHYs (one per
// adjacent stack). This is a planned customer die, not AIMEM RTL.
export const ACCELERATOR_FLOORPLAN = {
  computeTiles: { columns: 6, rows: 5, tileWidth: 0.58, tileDepth: 0.62, pitchX: 0.66, pitchZ: 0.72, label: 'Compute tile array' },
  sharedSram: { width: 0.58, depth: 3.6, label: 'Shared L2 / scratchpad SRAM strip' },
  memoryPhys: 8,
  nocLines: 5,
  notes: [
    'Shown face-up for inspection; the fabricated die is flip-chip mounted face-down onto its microbumps.',
    'Compute-tile count, L2 size, and PHY assignment are planning placeholders for the accelerator partner.',
  ],
} as const;
