// Identity of every structure the Silicon macro generator draws, and the
// kind of flow a conductor carries. Kept free of imports so the generator
// (silicon-macro.ts) and the describer (silicon-parts.ts) can both use it.
//
// Each drawn primitive packs its part and flow into the integer part of its
// pulse-phase float: phase = (partCode * 4 + flow) + phase01. The shader
// reads only fract() for the pulse timing and the flow for the pulse colour,
// so the identity costs no extra vertex data.

export const PART_ORDER = [
  // Front end and contacts
  'fin', 'gate', 'gate-dummy', 'gate-switching', 'bitcell-gate', 'epi-n', 'epi-p', 'contact-md', 'contact-power', 'contact-vg', 'well-tap', 'vbpr',
  // Below the transistors
  'bpr', 'nano-tsv', 'backside-rail', 'dtc', 'dtc-liner', 'tsv', 'tsv-liner',
  // Local interconnect
  'm0-rail', 'm0-wire', 'decap-plate', 'sram-supply', 'v0', 'bitcell-via', 'm1-pin', 'm1-out', 'bit-line', 'dtc-strap', 'v1', 'm2', 'word-line', 'v2', 'm3',
  'm3-pad', 'ladder-pad', 'tsv-plug', 'tsv-landing', 'v3', 'clock-net',
  // Intermediate metal
  'mx1', 'mx2', 'mx3', 'vx1', 'vx2', 'vx3', 'mx-pad', 'mx4-strap', 'power-ladder', 'bit-line-strap', 'global-bit-line', 'word-line-strap', 'tsv-via-stack',
  // Semi-global metal
  'vx4', 'systolic-bus', 'pe-pins', 'weight-bus', 'activation-bus', 'result-bus', 'semi-global-strap', 'strap-via', 'strap-stack', 'router-xbar', 'noc-drop',
  'phy-lane', 'lane-drop', 'bump-stack', 'io-pad', 'io-guard', 'esd-finger', 'sram-ring', 'sram-strap', 'tsv-strap-pad', 'tsv-riser',
  'inductor-guard', 'inductor-underpass', 'channel-bus', 'clock-spine',
  // Global metal
  'noc-lane', 'noc-junction', 'tile-ring', 'ring-stack', 'sram-spine', 'spine-drop', 'global-strap', 'top-via', 'mesh-stack', 'inductor', 'pad-lead', 'pad-frame', 'bond-pad', 'pad-stack',
  'power-bump', 'clock-trunk',
  // Bumps
  'ubm', 'pillar', 'solder-cap', 'seal-ring',
  // Package
  'die-surface', 'die-top', 'die', 'die-section', 'interposer', 'rdl-trace', 'interposer-tsv', 'hbm', 'substrate', 'c4-bump', 'capacitor', 'bga',
  'metal',
] as const;

export type PartId = typeof PART_ORDER[number];

const CODE = new Map<PartId, number>(PART_ORDER.map((id, index) => [id, index + 1]));

/** 1-based code of a part (0 means "not recorded": identify from geometry). */
export const partCode = (id: PartId) => CODE.get(id) ?? 0;

/** What a conductor carries: data signals, the two supplies, or the clock. */
export const FLOW = { data: 0, vdd: 1, vss: 2, clock: 3 } as const;
export type Flow = typeof FLOW[keyof typeof FLOW];
export const FLOW_NAMES = ['data', 'vdd', 'vss', 'clock'] as const;
export type FlowName = typeof FLOW_NAMES[number];

/** Pack a part, a flow, and a pulse phase in [0, 1) into one float. */
export const packPhase = (part: PartId | undefined, flow: Flow, phase: number) => (part ? partCode(part) : 0) * 4 + flow + (phase - Math.floor(phase)) * 0.999;

/** The part recorded in a packed phase, if any. */
export function partOfPhase(packed: number): PartId | null {
  const code = Math.floor(Math.floor(packed) / 4);
  return code > 0 && code <= PART_ORDER.length ? PART_ORDER[code - 1] : null;
}

/** The flow recorded in a packed phase. */
export const flowOfPhase = (packed: number): Flow => (Math.floor(packed) % 4) as Flow;
