// Physical package geometry, stack placement, and the real-life connector chain
// for the AIMEM-X1 2.5D twin. Reference pitches and technologies follow public
// HBM-class / silicon-interposer packaging conventions; every count rendered in
// the 3D twin is a sampled representation, never a released ball map, bump map,
// TSV map, or bond map.

export type StackSide = 'north' | 'south' | 'east' | 'west';

export type StackPlacement = {
  index: number;
  side: StackSide;
  x: number;
  z: number;
  rotationY: number;
};

export type ConnectorEvidence = 'modeled' | 'planned' | 'restricted';

export type ConnectorLevel = {
  order: number;
  id: string;
  label: string;
  from: string;
  to: string;
  technology: string;
  referencePitch: string;
  perUnit: string;
  rendered: boolean;
  sampled: number;
  evidence: ConnectorEvidence;
  note: string;
};

// Scene scale: the X1 base die is a 12 × 12 mm architectural floorplan rendered
// as a 2.45-unit square, so 1 scene unit ≈ 4.9 mm in plan. Vertical dimensions
// are exaggerated so tiers, bonds, and bumps remain individually selectable.
export const SCENE_MM_PER_UNIT = 12 / 2.45;

export const PACKAGE_GEOMETRY = {
  substrate: { width: 18.4, depth: 17, thickness: 0.32, top: -0.62 },
  bga: { radius: 0.13, y: -1.06 },
  c4: { radius: 0.05, height: 0.11, bottom: -0.62 },
  interposer: { width: 13.6, depth: 12.8, thickness: 0.52, top: 0.01 },
  stiffener: { outerWidth: 17.4, outerDepth: 16, band: 0.55, height: 0.46 },
  microbump: { radius: 0.035, height: 0.065, bottom: 0.01 },
  dieBottom: 0.075,
  accelerator: { width: 6.2, depth: 5.3, thickness: 0.95 },
  baseDie: { size: 2.45, thickness: 0.34 },
  dramTier: { size: 2.35, thickness: 0.13, pitch: 0.18, bondGap: 0.05 },
  hybridBond: { radius: 0.03, height: 0.04 },
  tsv: { radius: 0.02 },
  stackGap: 0.35,
  verticalExaggeration: 'about 20×; a real 16-high stack is under 1 mm tall',
} as const;

export const CONNECTOR_SAMPLING = {
  bga: { columns: 17, rows: 15, pitch: 1.0 },
  c4: { columns: 37, rows: 35, pitch: 0.36 },
  interposerTsvAccelerator: { columns: 12, rows: 10, pitch: 0.5 },
  interposerTsvStack: { columns: 4, rows: 4, pitch: 0.5 },
  acceleratorMicrobumps: { columns: 17, rows: 14, pitch: 0.34 },
  baseMicrobumps: { columns: 7, rows: 7, pitch: 0.3 },
  tsv: { columns: 4, rows: 4, pitch: 0.24 },
  hybridBond: { columns: 6, rows: 6, pitch: 0.3 },
  routeTracesPerBundle: 16,
  capacitors: 12,
} as const;

const halfWidth = PACKAGE_GEOMETRY.accelerator.width / 2;
const halfDepth = PACKAGE_GEOMETRY.accelerator.depth / 2;
const stackHalf = PACKAGE_GEOMETRY.baseDie.size / 2;
const slotOffset = stackHalf + 0.15;
const northZ = -(halfDepth + PACKAGE_GEOMETRY.stackGap + stackHalf);
const westX = -(halfWidth + PACKAGE_GEOMETRY.stackGap + stackHalf);

// Two stacks per accelerator edge so every base-die PHY is directly adjacent
// to an accelerator memory PHY. The order keeps 1-, 2-, and 4-stack
// configurations balanced around the die.
export const STACK_PLACEMENTS: StackPlacement[] = [
  { index: 0, side: 'north', x: -slotOffset, z: northZ, rotationY: 0 },
  { index: 1, side: 'south', x: slotOffset, z: -northZ, rotationY: Math.PI },
  { index: 2, side: 'north', x: slotOffset, z: northZ, rotationY: 0 },
  { index: 3, side: 'south', x: -slotOffset, z: -northZ, rotationY: Math.PI },
  { index: 4, side: 'west', x: westX, z: -slotOffset, rotationY: Math.PI / 2 },
  { index: 5, side: 'east', x: -westX, z: slotOffset, rotationY: -Math.PI / 2 },
  { index: 6, side: 'west', x: westX, z: slotOffset, rotationY: Math.PI / 2 },
  { index: 7, side: 'east', x: -westX, z: -slotOffset, rotationY: -Math.PI / 2 },
];

// Local stack coordinates: +z points toward the accelerator (the PHY edge).
export function stackLocalToWorld(placement: StackPlacement, localX: number, localZ: number): [number, number] {
  const cos = Math.cos(placement.rotationY);
  const sin = Math.sin(placement.rotationY);
  return [placement.x + localX * cos + localZ * sin, placement.z - localX * sin + localZ * cos];
}

// Accelerator-side memory PHY anchor that faces a given stack.
export function acceleratorPhyAnchor(placement: StackPlacement): { x: number; z: number; width: number; depth: number } {
  const inset = 0.45;
  const length = 2.1;
  const thickness = 0.5;
  if (placement.side === 'north') return { x: placement.x, z: -halfDepth + inset, width: length, depth: thickness };
  if (placement.side === 'south') return { x: placement.x, z: halfDepth - inset, width: length, depth: thickness };
  if (placement.side === 'west') return { x: -halfWidth + inset, z: placement.z, width: thickness, depth: length };
  return { x: halfWidth - inset, z: placement.z, width: thickness, depth: length };
}

export function evaluateConnectorChain(stackCount: number, dramTiers: number) {
  const stacks = Math.max(1, Math.min(STACK_PLACEMENTS.length, stackCount));
  const sampling = CONNECTOR_SAMPLING;
  const bga = sampling.bga.columns * sampling.bga.rows;
  const c4 = sampling.c4.columns * sampling.c4.rows;
  const interposerTsv = sampling.interposerTsvAccelerator.columns * sampling.interposerTsvAccelerator.rows + stacks * sampling.interposerTsvStack.columns * sampling.interposerTsvStack.rows;
  const rdlTraces = stacks * sampling.routeTracesPerBundle;
  const acceleratorMicrobumps = sampling.acceleratorMicrobumps.columns * sampling.acceleratorMicrobumps.rows;
  const baseMicrobumps = stacks * sampling.baseMicrobumps.columns * sampling.baseMicrobumps.rows;
  const tsvPerTier = sampling.tsv.columns * sampling.tsv.rows;
  const baseTsv = stacks * tsvPerTier;
  const dramTsv = stacks * Math.max(0, dramTiers - 1) * tsvPerTier;
  const bondsPerInterface = sampling.hybridBond.columns * sampling.hybridBond.rows;
  const hybridBonds = stacks * dramTiers * bondsPerInterface;
  const capacitors = sampling.capacitors;

  const levels: ConnectorLevel[] = [
    { order: 1, id: 'bga', label: 'BGA solder balls', from: 'System board', to: 'Package substrate', technology: 'SAC solder ball grid array', referencePitch: '0.8–1.0 mm pitch class', perUnit: 'full-area package array', rendered: true, sampled: bga, evidence: 'modeled', note: 'Power, ground, reference clocks, management, and host high-speed lanes leave the package here.' },
    { order: 2, id: 'substrate-vias', label: 'Substrate build-up vias + PTH', from: 'BGA lands', to: 'Substrate top routing', technology: 'Laser microvias in build-up layers and plated through-holes in the core', referencePitch: 'tens of µm microvias · ~150–300 µm PTH', perUnit: 'inside the organic laminate', rendered: false, sampled: 0, evidence: 'modeled', note: 'Enclosed inside the substrate laminate, so the twin does not render them.' },
    { order: 3, id: 'c4', label: 'C4 flip-chip bumps', from: 'Package substrate', to: 'Silicon interposer', technology: 'Controlled-collapse solder bumps on copper pillars', referencePitch: '130–180 µm pitch class', perUnit: 'full-area under the interposer', rendered: true, sampled: c4, evidence: 'modeled', note: 'Carry every power rail, ground, and board-facing signal into the interposer.' },
    { order: 4, id: 'interposer-tsv', label: 'Interposer TSVs', from: 'C4 bump side', to: 'Interposer RDL', technology: 'Through-silicon vias in a thin silicon interposer', referencePitch: '≈10 µm diameter in ≈100 µm silicon', perUnit: 'clustered under each die footprint', rendered: true, sampled: interposerTsv, evidence: 'modeled', note: 'Vertical feed-throughs for power delivery and board-facing I/O beneath the dies.' },
    { order: 5, id: 'interposer-rdl', label: 'Interposer RDL route bundles', from: 'Accelerator memory PHY', to: 'Base-die PHY', technology: 'Fine-pitch damascene copper redistribution layers', referencePitch: 'sub-µm to 2 µm lines · 12 modeled routing layers', perUnit: `${sampling.routeTracesPerBundle} sampled traces per stack bundle`, rendered: true, sampled: rdlTraces, evidence: 'modeled', note: 'Short-reach parallel memory lanes stay on the interposer between adjacent dies.' },
    { order: 6, id: 'microbump-accelerator', label: 'Accelerator microbumps', from: 'Interposer RDL', to: 'Accelerator die', technology: 'Copper-pillar microbumps with solder cap', referencePitch: '40–55 µm pitch class', perUnit: 'full-area under the accelerator', rendered: true, sampled: acceleratorMicrobumps, evidence: 'planned', note: 'Signal, power, and ground contacts; assignment requires the accelerator bump map.' },
    { order: 7, id: 'microbump-base', label: 'Base-die microbumps', from: 'Interposer RDL', to: 'Intelligent base die', technology: 'Copper-pillar microbumps with solder cap', referencePitch: '40–55 µm pitch class', perUnit: `${sampling.baseMicrobumps.columns * sampling.baseMicrobumps.rows} sampled per stack`, rendered: true, sampled: baseMicrobumps, evidence: 'modeled', note: 'Land the base-die PHY, power, and ground on the interposer.' },
    { order: 8, id: 'base-tsv', label: 'Base-die TSVs', from: 'Base-die microbump side', to: 'Base-die bond side', technology: 'Through-silicon vias in the logic base die', referencePitch: '5–10 µm diameter · ~40 µm pitch class', perUnit: `${tsvPerTier} sampled per base die`, rendered: true, sampled: baseTsv, evidence: 'modeled', note: 'Lift lane, power, and ground connections from the flipped base die up into the stack.' },
    { order: 9, id: 'hybrid-bond', label: 'Cu–Cu hybrid-bond interfaces', from: 'Base die / lower tier', to: 'DRAM tier above', technology: 'Die-to-wafer copper-to-copper hybrid bonding', referencePitch: '≤ 10 µm pitch class', perUnit: `${bondsPerInterface} sampled per interface · ${dramTiers} interfaces per stack`, rendered: true, sampled: hybridBonds, evidence: 'restricted', note: 'Bumpless vertical interface; 16-high bond yield and repair evidence is absent.' },
    { order: 10, id: 'dram-tsv', label: 'DRAM tier TSVs', from: 'Tier bond side', to: 'Next tier', technology: 'Through-silicon vias in each thinned DRAM tier', referencePitch: '5–10 µm diameter · ~40 µm pitch class', perUnit: `${tsvPerTier} sampled per tier · top tier has none`, rendered: true, sampled: dramTsv, evidence: 'restricted', note: 'Vertical lane, ECC, spare, and power conductors; the top tier terminates the column.' },
    { order: 11, id: 'decoupling', label: 'Die-side decoupling capacitors', from: 'Substrate power planes', to: 'Interposer power inlet', technology: 'Surface-mount MLCC near the interposer edge', referencePitch: '0201–0402 body class', perUnit: `${capacitors} rendered`, rendered: true, sampled: capacitors, evidence: 'modeled', note: 'Mid-frequency power-delivery decoupling; on-interposer deep-trench capacitors are not modeled.' },
    { order: 12, id: 'stiffener', label: 'Stiffener ring', from: 'Substrate top', to: 'Lid seating surface', technology: 'Metal stiffener bonded around the interposer', referencePitch: 'package-scale', perUnit: '1 rendered', rendered: true, sampled: 4, evidence: 'modeled', note: 'Controls warpage of the large organic substrate.' },
    { order: 13, id: 'underfill', label: 'Capillary underfill', from: 'Die edges', to: 'Interposer and substrate', technology: 'Epoxy underfill encapsulating bump fields', referencePitch: 'fills 20–60 µm bump gaps', perUnit: 'every bump field', rendered: false, sampled: 0, evidence: 'modeled', note: 'Not rendered because it would hide the bump arrays it protects.' },
    { order: 14, id: 'lid', label: 'Heat spreader lid + TIM', from: 'Die backsides', to: 'Cooling solution', technology: 'Integrated heat spreader over thermal interface material', referencePitch: 'package-scale', perUnit: 'covers all dies', rendered: false, sampled: 0, evidence: 'modeled', note: 'Not rendered because it would occlude the entire die field.' },
  ];

  return {
    stackCount: stacks,
    dramTiers,
    levels,
    renderedLevels: levels.filter((level) => level.rendered).length,
    unrenderedLevels: levels.filter((level) => !level.rendered).map((level) => level.id),
    renderedSamples: levels.reduce((sum, level) => sum + level.sampled, 0),
    hybridBondInterfaces: stacks * dramTiers,
    tsvSegments: stacks * dramTiers,
    assumptions: [
      'Reference pitches are public HBM-class and silicon-interposer packaging conventions, not a qualified assembly flow',
      'Rendered arrays are sampled; production ball, bump, TSV, and bond maps require package and die layout',
      `Vertical scale is ${PACKAGE_GEOMETRY.verticalExaggeration}`,
    ],
  };
}
