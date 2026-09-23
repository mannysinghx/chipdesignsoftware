// What every structure in the Silicon macro view is: names, roles,
// materials, and layers for hover, selection, and on-screen labels.
//
// Identification works from a primitive's own geometry (material, shape,
// vertical band, footprint) plus the floorplan region under it, so labels and
// the hover read-out always describe geometry that is actually drawn. The
// wording stays honest about the illustration: where the view renders top
// metal in gold for contrast, the material says so.

import {
  CPP, EDGE_BLOCKS, FLOATS_PER_INSTANCE, PHYS, ROW, SRAM_STRIP, STACK, TILES, cellAt, cellLayout, describeLocation, formatLength, insideRect, leafAt, peRect, railSupply, tileAt,
  type CellType, type ChunkData, type FocusStop, type Leaf, type MaterialKey, type Rect, type ShapeKey,
} from './silicon-macro.ts';
import { netFlow, type TracePiece } from './silicon-trace.ts';
import { PART_ORDER, flowOfPhase, partOfPhase, type PartId } from './silicon-part-ids.ts';

export type { PartId } from './silicon-part-ids.ts';

export type PartInfo = { title: string; role: string; material: string; layer: string };

const FEOL = 'Front end (transistors)';
const MOL = 'Middle of line (contacts)';
const LOCAL = 'Local interconnect';
const INTERMEDIATE = 'Intermediate metal';
const SEMI = 'Semi-global metal';
const TOP = 'Top metal';
const BACKSIDE = 'Below the transistors';
const TOP_CU = 'Thick copper (rendered gold)';

export const PARTS = {
  // Front end
  fin: { title: 'Fin', role: 'FinFET channel: a thin silicon ridge that the gate wraps on three sides', material: 'Silicon', layer: FEOL },
  gate: { title: 'Metal gate', role: 'High-k metal gate crossing the fins; each gate-over-fin crossing is a transistor', material: 'TiN / W over HfO₂', layer: FEOL },
  'gate-dummy': { title: 'Dummy gate', role: 'Unused gate at a cell edge that keeps the gate pitch regular for lithography', material: 'TiN / W over HfO₂', layer: FEOL },
  'gate-switching': { title: 'Switching gate', role: 'Metal gate shown toggling: animated switching activity', material: 'TiN / W over HfO₂', layer: FEOL },
  'bitcell-gate': { title: 'Bitcell gate', role: 'Pass-gate, pull-down, or pull-up gate of a six-transistor SRAM bitcell', material: 'TiN / W over HfO₂', layer: FEOL },
  'epi-n': { title: 'NMOS source/drain', role: 'Raised phosphorus-doped silicon epitaxy grown on the NMOS fins', material: 'Si:P epitaxy', layer: FEOL },
  'epi-p': { title: 'PMOS source/drain', role: 'Raised boron-doped silicon-germanium epitaxy grown on the PMOS fins', material: 'SiGe:B epitaxy', layer: FEOL },
  'contact-md': { title: 'Source/drain contact', role: 'Trench contact (MD) from a transistor drain up to M0: where a cell output leaves the transistors', material: 'Tungsten', layer: MOL },
  'contact-power': { title: 'Power source contact', role: 'Trench contact that ties a transistor source to its supply rail (VDD for PMOS, VSS for NMOS)', material: 'Tungsten', layer: MOL },
  'contact-vg': { title: 'Gate contact', role: 'Contact (VG) that lands on a gate to wire its input', material: 'Tungsten', layer: MOL },
  'well-tap': { title: 'Well tap', role: 'Ties the n-well or p-substrate to its supply to prevent latch-up', material: 'Tungsten', layer: MOL },
  vbpr: { title: 'Via to buried rail (VBPR)', role: 'Short via from a power source contact down to the buried power rail beneath the fins', material: 'Tungsten / ruthenium', layer: MOL },
  // Below the transistors
  bpr: { title: 'Buried power rail', role: 'VDD/VSS rail sunk below the fins, freeing M0 tracks for signals', material: 'Copper', layer: BACKSIDE },
  'nano-tsv': { title: 'Nano-TSV', role: 'Backside power delivery: feeds a buried rail from the wafer backside', material: 'Copper', layer: BACKSIDE },
  'backside-rail': { title: 'Backside power rail', role: 'Power network on the thinned wafer backside, under the transistors', material: 'Copper', layer: 'Backside metal' },
  dtc: { title: 'Deep-trench capacitor', role: 'Decoupling capacitor etched microns deep into the silicon to steady the supply', material: 'TiN / doped poly-Si fill', layer: 'Silicon substrate' },
  'dtc-liner': { title: 'Trench dielectric', role: 'Insulator lining the deep trench: the capacitor dielectric', material: 'High-k / SiO₂', layer: 'Silicon substrate' },
  tsv: { title: 'Through-silicon via (TSV)', role: 'Copper via through 60 µm of silicon: the vertical link to a 3D-stacked die', material: 'Copper', layer: 'Silicon substrate' },
  'tsv-liner': { title: 'TSV liner', role: 'Oxide sleeve that isolates the TSV from the silicon around it', material: 'SiO₂', layer: 'Silicon substrate' },
  // Local interconnect
  'm0-rail': { title: 'M0 power rail', role: 'Supply rail on a cell-row boundary, shared by the rows above and below', material: 'Copper', layer: `${LOCAL} M0` },
  'm0-wire': { title: 'M0 wire', role: 'Connects transistors inside a standard cell', material: 'Copper', layer: `${LOCAL} M0` },
  'decap-plate': { title: 'Decap cell plate', role: 'M0 plate of a decoupling-capacitor cell', material: 'Copper', layer: `${LOCAL} M0` },
  'sram-supply': { title: 'Bitcell supply line', role: 'VDD/VSS line shared by a row of SRAM bitcells', material: 'Copper', layer: `${LOCAL} M0` },
  v0: { title: 'V0 via', role: 'Connects M0 up to M1', material: 'Tungsten', layer: `${LOCAL} V0` },
  'bitcell-via': { title: 'Bitcell via stack', role: 'Stacked vias from a bitcell up to its bit and word lines', material: 'Tungsten', layer: `${LOCAL} V0–V1` },
  'm1-pin': { title: 'M1 input pin', role: 'Standard-cell input pin: routing lands here through a V1 via and the signal drops through V0 and M0 to a gate contact', material: 'Copper', layer: `${LOCAL} M1` },
  'm1-out': { title: 'M1 output pin', role: 'Standard-cell output pin joining the NMOS and PMOS drains; routing leaves from here through a V1 via', material: 'Copper', layer: `${LOCAL} M1` },
  'bit-line': { title: 'Bit line (BL/BLB)', role: 'Complementary SRAM column lines that read and write the bitcells', material: 'Copper', layer: `${LOCAL} M1` },
  'dtc-strap': { title: 'Trench-capacitor strap', role: 'M1 strap tying the tops of deep-trench capacitors to the supply', material: 'Copper', layer: `${LOCAL} M1` },
  v1: { title: 'V1 via', role: 'Connects an M1 pin up to an M2 route', material: 'Tungsten / cobalt', layer: `${LOCAL} V1` },
  m2: { title: 'M2 route', role: 'Horizontal wire of a net between cell pins in a row', material: 'Copper', layer: `${LOCAL} M2` },
  'word-line': { title: 'Word line', role: 'SRAM row line that opens a row of bitcells for access', material: 'Copper', layer: `${LOCAL} M2` },
  v2: { title: 'V2 via', role: 'Connects M2 up to M3', material: 'Tungsten', layer: `${LOCAL} V2` },
  m3: { title: 'M3 route', role: 'Vertical wire of a net between cells in neighbouring rows', material: 'Copper', layer: `${LOCAL} M3` },
  'm3-pad': { title: 'M3 landing pad', role: 'M3 pad where a via stack from the intermediate layers lands before the net drops to a cell pin', material: 'Copper', layer: `${LOCAL} M3` },
  'ladder-pad': { title: 'Power ladder pad', role: 'Pad on a local layer where a power via ladder passes on its way down to an M0 rail', material: 'Copper', layer: LOCAL },
  v3: { title: 'V3 via stack', role: 'Stacked vias through the thin upper local layers (M4–M7, not drawn) between M3 and Mx1', material: 'Copper / tungsten', layer: 'Local to intermediate' },
  'clock-net': { title: 'Clock net', role: 'Local clock wire from a clock buffer to the clock pins of flip-flops', material: 'Copper', layer: LOCAL },
  'tsv-plug': { title: 'TSV plug', role: 'Copper column carrying the TSV up through the local layers', material: 'Copper', layer: LOCAL },
  'tsv-landing': { title: 'TSV landing pad', role: 'M3 pad where the TSV plug meets the metal stack', material: 'Copper', layer: `${LOCAL} M3` },
  // Intermediate metal
  mx1: { title: 'Mx1 route', role: 'Block-level routing between cells and macros', material: 'Copper', layer: `${INTERMEDIATE} Mx1` },
  mx2: { title: 'Mx2 route', role: 'Block-level routing between cells and macros', material: 'Copper', layer: `${INTERMEDIATE} Mx2` },
  mx3: { title: 'Mx3 route', role: 'Wider block-level routing across the PE', material: 'Copper', layer: `${INTERMEDIATE} Mx3` },
  vx1: { title: 'Via (Vx1)', role: 'Connects Mx1 and Mx2 routes where they cross', material: 'Tungsten', layer: `${INTERMEDIATE} Vx1` },
  vx2: { title: 'Via (Vx2)', role: 'Connects Mx2 and Mx3 routes where they cross', material: 'Tungsten', layer: `${INTERMEDIATE} Vx2` },
  vx3: { title: 'Via (Vx3)', role: 'Connects an Mx4 power strap down to the layers below', material: 'Tungsten', layer: `${INTERMEDIATE} Vx3` },
  'mx-pad': { title: 'Via landing pad', role: 'Pad where a route ends and its via stack continues down toward the cells', material: 'Copper', layer: INTERMEDIATE },
  'power-ladder': { title: 'Power via ladder', role: 'Stacked vias carrying VDD or VSS from an Mx4 strap down toward the M0 rails', material: 'Copper / tungsten', layer: INTERMEDIATE },
  'mx4-strap': { title: 'Mx4 power strap', role: 'Local power grid strap over the logic', material: 'Copper', layer: `${INTERMEDIATE} Mx4` },
  'bit-line-strap': { title: 'Bit-line strap', role: 'Strap that lowers the resistance of long SRAM lines', material: 'Copper', layer: `${INTERMEDIATE} Mx1` },
  'global-bit-line': { title: 'Global bit line', role: 'Carries data from SRAM sub-arrays to the sense amplifiers', material: 'Copper', layer: `${INTERMEDIATE} Mx2` },
  'word-line-strap': { title: 'Word-line strap', role: 'Strap that speeds up long SRAM word lines', material: 'Copper', layer: `${INTERMEDIATE} Mx3` },
  // Semi-global metal
  'tsv-via-stack': { title: 'TSV via stack', role: 'Vias stacked from the TSV landing pad up to the semi-global straps', material: 'Tungsten', layer: `${INTERMEDIATE}–${SEMI}` },
  vx4: { title: 'Strap via stack', role: 'Via stack joining an Mx4 power strap to the semi-global straps above it', material: 'Tungsten', layer: `${INTERMEDIATE}–${SEMI}` },
  'systolic-bus': { title: 'Systolic data bus', role: 'Passes operands between neighbouring tensor PEs; pulses show data moving', material: 'Copper', layer: SEMI },
  'pe-pins': { title: 'PE bus drop', role: 'Via stack where a bus line drops into (or rises from) the PE logic below', material: 'Tungsten', layer: `${SEMI}–${INTERMEDIATE}` },
  'weight-bus': { title: 'Weight feed bus', role: 'Carries weights from a tile SRAM macro into the top of its PE columns', material: 'Copper', layer: SEMI },
  'activation-bus': { title: 'Activation feed bus', role: 'Carries activations from the tile router into the left edge of each PE row', material: 'Copper', layer: SEMI },
  'result-bus': { title: 'Result drain bus', role: 'Collects partial sums from the bottom of the PE array into the vector unit and back to the router', material: 'Copper', layer: SEMI },
  'semi-global-strap': { title: 'Semi-global power strap', role: 'Tile-level power grid between the top mesh and the local straps', material: 'Copper', layer: `${SEMI} My1/My2` },
  'strap-via': { title: 'Strap via', role: 'Connects crossing semi-global straps of the same supply (Vy1)', material: 'Tungsten', layer: `${SEMI} Vy1` },
  'strap-stack': { title: 'Ring via stack', role: 'Via stack joining a semi-global strap to the tile power ring above it', material: 'Tungsten', layer: SEMI },
  'router-xbar': { title: 'Router crossbar wire', role: 'Switch fabric inside the tile router; pulses show packets', material: 'Copper', layer: SEMI },
  'noc-drop': { title: 'NoC drop', role: 'Via stack joining a NoC lane to the tile router crossbar below it', material: 'Tungsten', layer: SEMI },
  'phy-lane': { title: 'PHY lane', role: 'Memory interface lane in the PHY driver strip, between the NoC and the lane drivers', material: 'Copper', layer: SEMI },
  'lane-drop': { title: 'Lane drop', role: 'Via stack joining a PHY NoC bundle line to its lane in the driver strip', material: 'Tungsten', layer: SEMI },
  'bump-stack': { title: 'Bump via stack', role: 'Stacked vias from a microbump down to the transmitter/receiver directly beneath it', material: 'Copper / tungsten', layer: 'Top metal to semi-global' },
  'io-pad': { title: 'I/O driver pad', role: 'Pad of the transmitter/receiver under a microbump, where the bump via stack lands', material: 'Copper', layer: SEMI },
  'io-guard': { title: 'I/O cell guard ring', role: 'Guard ring isolating an I/O cell', material: 'Copper', layer: SEMI },
  'esd-finger': { title: 'ESD protection finger', role: 'Finger of the diode that shunts electrostatic discharge at an I/O', material: 'Copper', layer: SEMI },
  'sram-ring': { title: 'SRAM power ring', role: 'Power ring around an SRAM macro', material: 'Copper', layer: SEMI },
  'sram-strap': { title: 'SRAM strap', role: 'Semi-global strap over an SRAM array', material: 'Copper', layer: SEMI },
  'tsv-strap-pad': { title: 'TSV strap pad', role: 'Semi-global pad where a TSV via stack meets the straps', material: 'Copper', layer: SEMI },
  'tsv-riser': { title: 'TSV riser', role: 'Via stack from a TSV strap pad up to the SRAM spine, carrying stacked-die data into the L2 banks', material: 'Tungsten', layer: SEMI },
  'inductor-guard': { title: 'Inductor guard ring', role: 'Keeps substrate noise away from the PLL inductor', material: 'Copper', layer: SEMI },
  'inductor-underpass': { title: 'Inductor underpass', role: 'Brings the spiral inductor terminal out from its centre', material: 'Copper', layer: SEMI },
  'channel-bus': { title: 'Channel bus', role: 'Long global wire in a channel between compute tiles, joining the logic at the two ends of the channel', material: 'Copper', layer: SEMI },
  'channel-drop': { title: 'Channel bus drop', role: 'Via stack from a channel bus down to the cells at an end of its channel', material: 'Tungsten', layer: `${SEMI}–${INTERMEDIATE}` },
  'clock-spine': { title: 'Clock spine', role: 'Tile clock spine fed by the global clock tree, driving the local clock buffers', material: 'Copper', layer: SEMI },
  'noc-lane': { title: 'NoC lane', role: 'Network-on-chip link between tiles, SRAM, and PHYs; pulses are packets', material: 'Copper', layer: SEMI },
  'noc-junction': { title: 'NoC junction', role: 'Vias joining horizontal and vertical NoC links where the network branches', material: 'Tungsten', layer: SEMI },
  // Top metal and bumps
  'tile-ring': { title: 'Tile power ring', role: 'Power ring around a compute tile', material: TOP_CU, layer: TOP },
  'ring-stack': { title: 'Mesh-to-ring via stack', role: 'Via stack feeding a tile power ring from the global mesh above it', material: 'Tungsten', layer: TOP },
  'sram-spine': { title: 'SRAM strip spine', role: 'Data spine along the shared SRAM strip', material: 'Copper', layer: TOP },
  'spine-drop': { title: 'Spine junction', role: 'Via joining the SRAM spine to a NoC lane that crosses the strip', material: 'Tungsten', layer: TOP },
  'global-strap': { title: 'Global power strap', role: 'Top-metal VDD/VSS mesh that feeds the whole die', material: TOP_CU, layer: TOP },
  'top-via': { title: 'Top-metal via stack', role: 'Connects crossing global straps of the same supply', material: 'Tungsten', layer: TOP },
  'mesh-stack': { title: 'Mesh via stack', role: 'Via stack from the global mesh down to a tile power ring', material: 'Tungsten', layer: TOP },
  inductor: { title: 'PLL inductor', role: 'Spiral inductor of an LC-tank PLL oscillator (clock generation)', material: TOP_CU, layer: TOP },
  'pad-lead': { title: 'Pad lead', role: 'Connects an I/O pad into the I/O ring', material: 'Copper', layer: TOP },
  'pad-frame': { title: 'Pad frame', role: 'Metal frame under an I/O pad', material: 'Copper', layer: TOP },
  'bond-pad': { title: 'I/O pad', role: 'Pad for the die’s control and test I/O', material: 'Al/Cu pad (rendered gold)', layer: TOP },
  'pad-stack': { title: 'I/O pad via stack', role: 'Vias joining an I/O pad to its lead, and the lead down to the ESD protection of its I/O cell', material: 'Tungsten', layer: TOP },
  'power-bump': { title: 'Power bump', role: 'Bump that brings VDD or VSS from the package into the global power mesh', material: 'Cu pillar + SnAg cap', layer: 'Bump' },
  'clock-trunk': { title: 'Clock trunk', role: 'Global clock H-tree from the PLLs to every compute tile', material: 'Copper', layer: TOP },
  ubm: { title: 'Under-bump metallization', role: 'Solderable pad the microbump pillar is built on', material: 'Ni / Au', layer: 'Bump' },
  pillar: { title: 'Cu pillar microbump', role: 'Copper pillar joining the die to the interposer (memory PHY signals)', material: 'Copper', layer: 'Bump' },
  'solder-cap': { title: 'Solder cap', role: 'Tin-silver cap that is reflowed to bond the pillar', material: 'SnAg solder', layer: 'Bump' },
  'seal-ring': { title: 'Seal ring', role: 'Metal wall around the die edge that stops cracks and moisture', material: 'Copper / gold', layer: 'Full stack' },
  // Package (static meshes in the engine)
  'die-surface': { title: 'Silicon die surface', role: 'Die-photo texture of the floorplan; zoom in to reveal the structures it summarizes', material: 'Silicon with passivation', layer: 'Die' },
  'die-top': { title: 'Silicon substrate', role: 'Bulk silicon the transistors are built in; isolation oxide fills the gaps between devices', material: 'Silicon / SiO₂ isolation', layer: 'Substrate' },
  die: { title: 'Accelerator die', role: 'The AI accelerator: 30 compute tiles, a shared SRAM strip, and 8 memory PHYs', material: 'Silicon', layer: 'Package' },
  'die-section': { title: 'Silicon substrate (cut)', role: 'Bulk silicon under the transistors, shown in cross-section', material: 'Silicon', layer: 'Substrate' },
  interposer: { title: 'Silicon interposer', role: 'Passive silicon that wires the die to the memory stacks', material: 'Silicon', layer: 'Package' },
  'rdl-trace': { title: 'Interposer RDL trace', role: 'Fine copper wire on the interposer joining a die memory PHY to its HBM stack', material: 'Copper', layer: 'Interposer RDL' },
  'interposer-tsv': { title: 'Interposer TSV', role: 'Copper via through the interposer silicon from its RDL down to a C4 bump', material: 'Copper', layer: 'Interposer' },
  hbm: { title: 'HBM memory stack', role: 'Stack of DRAM dies on a base die, beside the accelerator', material: 'Silicon / mold', layer: 'Package' },
  substrate: { title: 'Package substrate', role: 'Organic laminate that fans signals and power out to the board', material: 'Build-up laminate, solder mask', layer: 'Package' },
  'c4-bump': { title: 'C4 bump', role: 'Solder bump joining the interposer to the package substrate', material: 'SnAg solder on Cu', layer: 'Interposer underside' },
  capacitor: { title: 'Decoupling capacitor', role: 'Ceramic capacitor that steadies the supply near the die', material: 'MLCC', layer: 'Package' },
  bga: { title: 'BGA solder ball', role: 'Solder ball joining the package to the circuit board (sampled pitch)', material: 'SAC solder', layer: 'Package underside' },
  metal: { title: 'Metal structure', role: 'Interconnect metal', material: 'Metal', layer: 'Metal stack' },
} as const satisfies Record<PartId, PartInfo>;

export const PART_IDS: PartId[] = [...PART_ORDER];
const PART_INDEX = new Map(PART_IDS.map((id, index) => [id, index]));
export const partIndex = (id: PartId) => PART_INDEX.get(id) ?? PART_INDEX.get('metal')!;

export const CELL_NAMES: Record<CellType, string> = {
  INV: 'inverter', BUF: 'buffer', NAND2: '2-input NAND', NOR2: '2-input NOR', NAND3: '3-input NAND', AOI21: 'AND-OR-invert',
  OAI22: 'OR-AND-invert', XOR2: '2-input XOR', MUX2: '2:1 multiplexer', FA: 'full adder', DFF: 'D flip-flop', TAP: 'well tap',
  FILL: 'filler', DECAP: 'decoupling capacitor',
};

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

/** A drawn primitive; `code` is its packed phase (part, flow, phase). */
export type PrimitiveRef = { level: number; material: MaterialKey; shape: ShapeKey; x: number; z: number; y0: number; y1: number; sx: number; sz: number; glow: number; code?: number };

const at = (y: number, value: number) => Math.abs(y - value) <= 2e-7;
const INDUCTORS: Rect[] = EDGE_BLOCKS.flatMap((block) => block.inductors.map((i) => ({ x0: i.cx - i.size * 0.62, z0: i.cz - i.size * 0.62, x1: i.cx + i.size * 0.62, z1: i.cz + i.size * 0.62 })));
const onRowBoundary = (z: number) => Math.abs(z / ROW - Math.round(z / ROW)) < 0.02;

/** Which part a drawn primitive is. */
export function identifyPrimitive(p: PrimitiveRef): PartId {
  // Structures that record their own part (nets, via stacks, feeds) need no guessing.
  const recorded = p.code === undefined ? null : partOfPhase(p.code);
  if (recorded) return recorded;
  const { material: m, shape, y0 } = p;
  const narrow = Math.min(p.sx, p.sz);
  const leaf = (): Leaf => leafAt(p.x, p.z);
  if (shape === 'cyl') {
    if (at(y0, STACK.tsv[0])) return m === 'oxide' ? 'tsv-liner' : 'tsv';
    if (at(y0, STACK.dtc[0])) return m === 'oxide' ? 'dtc-liner' : 'dtc';
    if (m === 'solder') return 'solder-cap';
    if (at(y0, STACK.pillar[0])) return 'pillar';
    return 'metal';
  }
  // Tall walls and plugs first: they start on shared band bottoms.
  if (at(y0, STACK.m0[0]) && p.y1 > STACK.mx1[0]) return 'seal-ring';
  if (at(y0, STACK.m0[0]) && p.y1 > STACK.m3[0]) return 'tsv-plug';
  if (m === 'silicon') return 'fin';
  if (m === 'epiN') return 'epi-n';
  if (m === 'epiP') return 'epi-p';
  if (m === 'gate') {
    if (leaf() === 'sram') return 'bitcell-gate';
    if (p.glow !== 0) return 'gate-switching';
    const hit = cellAt(p.x, p.z);
    const n = Math.floor(p.x / CPP);
    if (hit && (hit.cell.type === 'FILL' || n === hit.cell.start + hit.cell.width - 1)) return 'gate-dummy';
    return 'gate';
  }
  if (m === 'tungsten') {
    if (at(y0, STACK.fin[1])) return 'well-tap';
    if (at(y0, STACK.contact[0])) return 'contact-md';
    if (at(y0, STACK.gate[1])) return 'contact-vg';
    if (at(y0, STACK.v0[0])) return p.y1 > STACK.v1[0] ? 'bitcell-via' : 'v0';
    if (at(y0, STACK.v2[0])) return 'v2';
    if (at(y0, STACK.vx1[0])) return 'vx1';
    if (at(y0, STACK.vx2[0])) return 'vx2';
    if (at(y0, STACK.vy1[0])) return 'strap-via';
    if (at(y0, STACK.vz1[0])) return 'top-via';
    if (y0 > STACK.m3[1] && y0 < STACK.mx1[0]) return 'tsv-via-stack';
    return 'metal';
  }
  if (m === 'gold') {
    if (at(y0, STACK.ring[0])) return 'tile-ring';
    if (at(y0, STACK.pad[0])) return leafAt(p.x, p.z) === 'io' ? 'bond-pad' : 'ubm';
    if (at(y0, STACK.mz2[0]) && INDUCTORS.some((r) => insideRect(r, p.x, p.z))) return 'inductor';
    if (at(y0, STACK.mz1[0]) || at(y0, STACK.mz2[0])) return 'global-strap';
    return 'metal';
  }
  // Copper by band.
  if (at(y0, STACK.bpr[0])) return 'bpr';
  if (at(y0, STACK.nanoTsv[0])) return 'nano-tsv';
  if (at(y0, STACK.backside[0])) return 'backside-rail';
  if (at(y0, STACK.m0[0])) {
    const l = leaf();
    if (l === 'sram') return 'sram-supply';
    if (narrow > 0.00004) return 'decap-plate';
    return onRowBoundary(p.z) && p.sx > p.sz ? 'm0-rail' : 'm0-wire';
  }
  if (at(y0, STACK.m1[0])) {
    const l = leaf();
    return l === 'sram' ? 'bit-line' : l === 'decap' ? 'dtc-strap' : 'm1-pin';
  }
  if (at(y0, STACK.m2[0])) return leaf() === 'sram' ? 'word-line' : 'm2';
  if (at(y0, STACK.m3[0])) return leaf() === 'tsv' ? 'tsv-landing' : 'm3';
  if (at(y0, STACK.mx1[0])) return leaf() === 'sram' ? 'bit-line-strap' : 'mx1';
  if (at(y0, STACK.mx2[0])) return leaf() === 'sram' ? 'global-bit-line' : 'mx2';
  if (at(y0, STACK.mx3[0])) return leaf() === 'sram' ? 'word-line-strap' : 'mx3';
  if (at(y0, STACK.mx4[0])) return 'mx4-strap';
  if (at(y0, STACK.sysH[0]) || at(y0, STACK.sysV[0])) return p.glow !== 0 ? 'systolic-bus' : 'pe-pins';
  if (at(y0, STACK.my1[0]) || at(y0, STACK.my2[0])) {
    const l = leaf();
    const upper = at(y0, STACK.my2[0]);
    if (l === 'router') return 'router-xbar';
    if (l === 'phy-drivers') return 'phy-lane';
    if (l === 'io') return upper ? 'esd-finger' : 'io-guard';
    if (l === 'tsv') return 'tsv-strap-pad';
    if (l === 'analog') return upper ? 'inductor-underpass' : 'inductor-guard';
    if (narrow > 0.0065) return 'sram-ring';
    if (narrow < 0.003 && (l === 'sram' || l === 'sram-periph')) return 'sram-strap';
    return 'semi-global-strap';
  }
  if (at(y0, STACK.chanH[0]) || at(y0, STACK.chanV[0])) return 'channel-bus';
  if (at(y0, STACK.noc[0])) return 'noc-lane';
  if (at(y0, STACK.ring[0])) return 'sram-spine';
  if (at(y0, STACK.mz1[0])) return 'pad-lead';
  if (at(y0, STACK.mz2[0])) return 'pad-frame';
  if (at(y0, STACK.my2[0])) return 'inductor-underpass';
  return 'metal';
}

/** Part index for every instance of a chunk, batch by batch. */
export function identifyChunk(chunk: ChunkData): Uint8Array[] {
  return chunk.batches.map((batch) => {
    const out = new Uint8Array(batch.count);
    const d = batch.data;
    for (let k = 0; k < batch.count; k += 1) {
      const o = k * 10;
      out[k] = partIndex(identifyPrimitive({
        level: chunk.level, material: batch.material, shape: batch.shape,
        x: d[o] + chunk.origin[0], z: d[o + 2] + chunk.origin[2], y0: d[o + 1] - d[o + 4] / 2, y1: d[o + 1] + d[o + 4] / 2,
        sx: d[o + 3], sz: d[o + 5], glow: d[o + 8], code: d[o + 9],
      }));
    }
    return out;
  });
}

export type PartDescription = PartInfo & { id: PartId; size: string; location: string[]; notes: string[] };

/** The pin of a standard cell at a point (M1 pins sit at whole gate pitches), if any. */
export function pinAt(x: number, z: number): { cell: CellType; pin: string; dir: 'in' | 'out' | 'clk'; row: number } | null {
  const hit = cellAt(x, z);
  if (!hit) return null;
  const k = Math.round(x / CPP);
  const pin = cellLayout(hit.cell.type)?.pins.find((item) => hit.cell.start + item.k === k);
  return pin ? { cell: hit.cell.type, pin: pin.name, dir: pin.dir, row: hit.row } : null;
}

export type NetSummary = {
  /** Distinct pieces (a wire split across two chunks counts once). */
  pieces: number;
  truncated: boolean;
  /** The net runs on beyond the loaded area (zoom out or follow it to see the rest). */
  open: boolean;
  flow: 'data' | 'vdd' | 'vss' | 'clock';
  /** Layers the net passes through, bottom to top, with the parts on each. */
  layers: Array<{ layer: string; parts: string[]; count: number }>;
  /** Cell pins the net joins: its driver first, then what it drives. */
  pins: string[];
  /** Transistor gates the net switches. */
  gates: number;
};

/** What a traced net is, from its pieces: the layers it climbs through and the pins it joins. */
export function summarizeNet(pieces: TracePiece[], truncated: boolean, open = truncated): NetSummary {
  const layers = new Map<string, { y: number; parts: Set<string>; count: number }>();
  const pins = new Map<string, { text: string; out: boolean }>();
  // Chunks clip wires at their edges; the halves share a part, a height, and
  // the coordinate across the wire, so they count as one piece.
  const logical = new Set<string>();
  let gates = 0;
  for (const piece of pieces) {
    const batch = piece.record.data.batches[piece.batch];
    const d = batch.data;
    const o = piece.index * FLOATS_PER_INSTANCE;
    const ref: PrimitiveRef = {
      level: piece.record.level, material: batch.material, shape: batch.shape,
      x: d[o] + piece.record.data.origin[0], z: d[o + 2] + piece.record.data.origin[2],
      y0: d[o + 1] - d[o + 4] / 2, y1: d[o + 1] + d[o + 4] / 2, sx: d[o + 3], sz: d[o + 5], glow: d[o + 8], code: d[o + 9],
    };
    const id = identifyPrimitive(ref);
    const along = Math.floor(d[o + 6] / 2);
    const across = along === 0 ? `z${Math.round(ref.z * 1e7)}` : along === 1 ? `x${Math.round(ref.x * 1e7)}` : `${Math.round(ref.x * 1e7)}:${Math.round(ref.z * 1e7)}`;
    const identity = `${id}|${Math.round(ref.y0 * 1e7)}|${across}`;
    if (logical.has(identity)) continue;
    logical.add(identity);
    if (id === 'gate' || id === 'gate-switching') gates += 1;
    const part = PARTS[id];
    const entry = layers.get(part.layer) ?? { y: ref.y0, parts: new Set<string>(), count: 0 };
    entry.y = Math.min(entry.y, ref.y0);
    entry.parts.add(part.title);
    entry.count += 1;
    layers.set(part.layer, entry);
    if (id === 'm1-pin' || id === 'm1-out') {
      const found = pinAt(ref.x, ref.z);
      if (found) pins.set(`${found.row}:${Math.round(ref.x / CPP)}`, { text: `${found.cell} ${found.dir === 'out' ? 'output' : found.dir === 'clk' ? 'clock input' : 'input'} ${found.pin}`, out: found.dir === 'out' });
    }
  }
  const flow = (['data', 'vdd', 'vss', 'clock'] as const)[netFlow(pieces)];
  return {
    pieces: logical.size,
    truncated,
    open,
    flow,
    layers: [...layers.entries()].sort((a, b) => a[1].y - b[1].y).map(([layer, entry]) => ({ layer, parts: [...entry.parts], count: entry.count })),
    pins: [...pins.values()].sort((a, b) => Number(b.out) - Number(a.out)).map((item) => item.text),
    gates,
  };
}

/** Full read-out for the selection panel. */
export function describePrimitive(p: PrimitiveRef, id: PartId = identifyPrimitive(p)): PartDescription {
  const part = PARTS[id];
  const height = p.y1 - p.y0;
  const size = p.shape === 'cyl'
    ? `Ø ${formatLength(p.sx)} × ${formatLength(height)}`
    : `${formatLength(Math.max(p.sx, p.sz))} × ${formatLength(Math.min(p.sx, p.sz))} × ${formatLength(height)} thick`;
  const notes: string[] = [];
  // Float32 instance data puts a layer's base a hair off its band: compare with slack.
  const cell = p.y0 < STACK.m3[1] + 1e-8 && p.y0 > STACK.bpr[0] - 1e-8 ? cellAt(p.x, p.z) : null;
  if (cell) {
    const width = cell.cell.width;
    const pin = id === 'm1-pin' || id === 'm1-out' ? pinAt(p.x, p.z) : null;
    notes.push(`${pin ? `Pin ${pin.pin} of a` : 'In a'} ${cell.cell.type} cell (${CELL_NAMES[cell.cell.type]}), ${width} gate pitch${width === 1 ? '' : 'es'} wide, row ${cell.row.toLocaleString()}`);
  }
  const flow = p.code === undefined ? 0 : flowOfPhase(p.code);
  if (flow === 1 || flow === 2) notes.push(`Carries ${flow === 1 ? 'VDD (supply)' : 'VSS (ground return)'}`);
  else if (id === 'm0-rail' || id === 'bpr' || id === 'backside-rail' || id === 'nano-tsv') notes.push(`Carries ${railSupply(Math.round(p.z / ROW))}`);
  if (flow === 3) notes.push('Carries the clock');
  if (p.glow !== 0 && id !== 'gate-switching') {
    notes.push(flow === 1 || flow === 2 ? 'Turn on Power flow to see the supply moving through it' : flow === 3 ? 'Turn on Clock flow to see the clock edges travel' : 'Active net: the moving light shows data in flight');
  }
  const location = id === 'rdl-trace' ? ['Silicon interposer', 'Between a memory PHY and its HBM stack'] : describeLocation(p.x, p.z);
  return { id, ...part, size, location, notes };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Parts worth a floating label at each zoom stop (most useful first). */
export const LABEL_PLAN: Record<FocusStop['id'], PartId[]> = {
  package: ['rdl-trace'],
  die: ['global-strap', 'noc-lane', 'noc-junction', 'power-bump', 'bond-pad', 'seal-ring', 'inductor', 'tile-ring', 'top-via'],
  tile: ['systolic-bus', 'weight-bus', 'activation-bus', 'result-bus', 'semi-global-strap', 'tile-ring', 'channel-bus', 'noc-lane', 'noc-drop', 'global-strap', 'strap-via', 'router-xbar', 'sram-ring', 'tsv', 'pillar', 'bump-stack', 'phy-lane'],
  block: ['mx1', 'mx2', 'mx3', 'vx1', 'v3', 'mx4-strap', 'vx4', 'systolic-bus', 'pe-pins', 'semi-global-strap', 'global-strap', 'global-bit-line', 'word-line-strap', 'tsv-strap-pad', 'ubm'],
  routing: ['mx1', 'mx2', 'mx3', 'vx1', 'vx2', 'v3', 'power-ladder', 'mx4-strap', 'systolic-bus', 'semi-global-strap'],
  cells: ['m0-rail', 'm0-wire', 'm1-pin', 'm1-out', 'v0', 'v1', 'm2', 'v2', 'm3', 'm3-pad', 'clock-net', 'bit-line', 'word-line', 'bitcell-via', 'mx1', 'tsv-landing', 'dtc-strap'],
  devices: ['fin', 'gate', 'gate-dummy', 'gate-switching', 'epi-n', 'epi-p', 'contact-md', 'contact-power', 'contact-vg', 'vbpr', 'well-tap', 'bitcell-gate', 'dtc', 'bpr', 'nano-tsv', 'backside-rail', 'm0-rail'],
};

/** Rendered material of each labelled part, for legend swatches ('glow' marks animated nets). */
const PART_LOOK: Partial<Record<PartId, { material: MaterialKey; glow?: boolean }>> = {
  fin: { material: 'silicon' }, gate: { material: 'gate' }, 'gate-dummy': { material: 'gate' }, 'gate-switching': { material: 'gate', glow: true },
  'bitcell-gate': { material: 'gate' }, 'epi-n': { material: 'epiN' }, 'epi-p': { material: 'epiP' }, 'contact-md': { material: 'tungsten', glow: true },
  'contact-power': { material: 'tungsten' }, vbpr: { material: 'tungsten' },
  'contact-vg': { material: 'tungsten', glow: true }, 'well-tap': { material: 'tungsten' }, bpr: { material: 'copper' }, 'nano-tsv': { material: 'copper' },
  'backside-rail': { material: 'copper' }, dtc: { material: 'gate' }, 'dtc-liner': { material: 'oxide' }, tsv: { material: 'copper' }, 'tsv-liner': { material: 'oxide' },
  'm0-rail': { material: 'copper' }, 'm0-wire': { material: 'copper', glow: true }, 'decap-plate': { material: 'copper' }, 'sram-supply': { material: 'copper' },
  v0: { material: 'tungsten', glow: true }, 'bitcell-via': { material: 'tungsten' }, 'm1-pin': { material: 'copper' }, 'm1-out': { material: 'copper' }, 'bit-line': { material: 'copper', glow: true },
  'dtc-strap': { material: 'copper' }, v1: { material: 'tungsten', glow: true }, m2: { material: 'copper', glow: true }, 'word-line': { material: 'copper', glow: true }, v2: { material: 'tungsten', glow: true },
  m3: { material: 'copper', glow: true }, 'm3-pad': { material: 'copper', glow: true }, 'clock-net': { material: 'copper', glow: true }, 'tsv-plug': { material: 'copper' }, 'tsv-landing': { material: 'copper' },
  v3: { material: 'tungsten', glow: true }, 'power-ladder': { material: 'tungsten' }, 'ladder-pad': { material: 'copper' },
  mx1: { material: 'copper', glow: true }, mx2: { material: 'copper', glow: true }, mx3: { material: 'copper', glow: true }, vx1: { material: 'tungsten', glow: true },
  vx2: { material: 'tungsten', glow: true }, 'mx4-strap': { material: 'copper' }, 'global-bit-line': { material: 'copper', glow: true }, 'word-line-strap': { material: 'copper' },
  vx4: { material: 'tungsten' }, 'systolic-bus': { material: 'copper', glow: true }, 'pe-pins': { material: 'tungsten', glow: true },
  'weight-bus': { material: 'copper', glow: true }, 'activation-bus': { material: 'copper', glow: true }, 'result-bus': { material: 'copper', glow: true },
  'semi-global-strap': { material: 'copper' }, 'strap-via': { material: 'tungsten' }, 'strap-stack': { material: 'tungsten' }, 'mesh-stack': { material: 'tungsten' },
  'router-xbar': { material: 'copper', glow: true }, 'noc-drop': { material: 'tungsten', glow: true }, 'phy-lane': { material: 'copper', glow: true }, 'bump-stack': { material: 'copper' },
  'sram-ring': { material: 'copper' }, 'tsv-strap-pad': { material: 'copper' },
  'channel-bus': { material: 'copper', glow: true }, 'channel-drop': { material: 'tungsten' }, 'noc-lane': { material: 'copper', glow: true }, 'noc-junction': { material: 'tungsten' }, 'tile-ring': { material: 'gold' },
  'global-strap': { material: 'gold' }, 'top-via': { material: 'tungsten' }, 'power-bump': { material: 'solder' },
  inductor: { material: 'gold' }, 'bond-pad': { material: 'gold' }, ubm: { material: 'gold' }, pillar: { material: 'copper' }, 'solder-cap': { material: 'solder' },
  'seal-ring': { material: 'copper' }, 'die-surface': { material: 'silicon' }, die: { material: 'silicon' }, hbm: { material: 'silicon' },
  interposer: { material: 'silicon' }, substrate: { material: 'silicon' }, capacitor: { material: 'solder' }, bga: { material: 'solder' },
  'rdl-trace': { material: 'copper', glow: true }, 'c4-bump': { material: 'solder' },
};

/** Approximate on-screen colour of each material, for legend swatches. */
export const MATERIAL_SWATCH: Record<MaterialKey, string> = {
  copper: '#c9825f', gold: '#e2bd62', tungsten: '#9aa1aa', gate: '#b3a184', silicon: '#4b525d', epiN: '#6d84a6', epiP: '#9a8062', oxide: '#8ea4ba', solder: '#c6c7cc',
};

export type LegendItem = { id: PartId; title: string; layer: string; role: string; swatch: string; glow: boolean };

const PACKAGE_LEGEND: PartId[] = ['die', 'hbm', 'interposer', 'rdl-trace', 'substrate', 'c4-bump', 'capacitor', 'bga'];

/** What each zoom stop shows, for the on-screen legend. */
export function legendFor(stop: FocusStop['id']): LegendItem[] {
  const ids: PartId[] = stop === 'package' ? PACKAGE_LEGEND : stop === 'die' ? [...LABEL_PLAN.die, 'die-surface', 'hbm'] : LABEL_PLAN[stop];
  return ids.map((id) => {
    const look = PART_LOOK[id] ?? { material: 'copper' as MaterialKey };
    return { id, title: PARTS[id].title, layer: PARTS[id].layer, role: PARTS[id].role, swatch: MATERIAL_SWATCH[look.material], glow: Boolean(look.glow) };
  });
}

/** Parts in the legend of any stop that lack a swatch entry (kept empty by a test). */
export const legendGaps = () => FOCUS_STOP_IDS.flatMap((stop) => legendFor(stop).filter((item) => !PART_LOOK[item.id]).map((item) => `${stop}:${item.id}`));
const FOCUS_STOP_IDS: FocusStop['id'][] = ['package', 'die', 'tile', 'block', 'routing', 'cells', 'devices'];

export type RegionLabel = { id: string; title: string; detail: string; x: number; y: number; z: number; priority: number; rect: Rect };

const center = (r: Rect): [number, number] => [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2];
const topOfStack = STACK.pad[1];

function nearestTile(x: number, z: number) {
  return tileAt(x, z) ?? TILES.reduce((best, tile) => {
    const [bx, bz] = center(best.rect);
    const [tx, tz] = center(tile.rect);
    return Math.hypot(tx - x, tz - z) < Math.hypot(bx - x, bz - z) ? tile : best;
  }, TILES[0]);
}

/** Floorplan labels for the regions in view at a zoom stop. */
export function regionLabels(stop: FocusStop['id'], x: number, z: number): RegionLabel[] {
  const labels: RegionLabel[] = [];
  const add = (id: string, title: string, detail: string, r: Rect, y: number, priority: number) => {
    const [cx, cz] = center(r);
    labels.push({ id, title, detail, x: cx, y, z: cz, priority, rect: r });
  };
  if (stop === 'die') {
    add('sram-strip', 'Shared L2 SRAM strip', '48 banks around a TSV column', SRAM_STRIP.rect, topOfStack, 3);
    for (const phy of PHYS) add(`phy-${phy.index}`, `Memory PHY ${phy.index + 1}`, 'Microbump field and lane drivers facing an HBM stack', phy.bumps, topOfStack, 2.5);
    for (const block of EDGE_BLOCKS) add(`block-${block.id}`, block.label, 'Uncore block', block.rect, topOfStack, 2.5);
    for (const tile of TILES) add(`tile-${tile.index}`, tile.label, '16 × 12 tensor PEs, 4 SRAM macros, a router, and a vector unit', tile.rect, topOfStack, 1);
  }
  if (stop === 'tile' || stop === 'block') {
    const tile = nearestTile(x, z);
    if (stop === 'tile') {
      add(`pe-array-${tile.index}`, 'Tensor PE array', `${tile.label}: 16 × 12 multiply-accumulate PEs in a systolic grid`, tile.peArray, STACK.my2[1], 3);
      tile.sram.forEach((macro, k) => add(`${macro.id}`, `Tile SRAM ${k + 1}`, 'Local scratchpad SRAM macro', macro.rect, STACK.my2[1], 2));
      add(`router-${tile.index}`, 'Tile router', 'Network-on-chip router for this tile', tile.router, STACK.my2[1], 2);
      add(`vector-${tile.index}`, 'Vector + control unit', 'Vector ALUs and the tile sequencer', tile.vector, STACK.my2[1], 2);
    }
    if (stop === 'block' && insideRect(tile.peArray, x, z)) {
      const i = Math.min(15, Math.max(0, Math.floor((x - tile.peArray.x0) / tile.pePitchX)));
      const j = Math.min(11, Math.max(0, Math.floor((z - tile.peArray.z0) / tile.pePitchZ)));
      const pe = peRect(tile, i, j);
      add(`pe-${tile.index}-${i}-${j}`, `Tensor PE ${String(i + 1).padStart(2, '0')}·${String(j + 1).padStart(2, '0')}`, 'Multiply-accumulate datapath in standard cells', pe, STACK.mx4[1], 3);
      add(`rf-${tile.index}-${i}-${j}`, 'Register file', 'Small SRAM holding this PE’s operands', { x0: pe.x0 + 0.006, z0: pe.z0 + 0.006, x1: pe.x0 + 0.056, z1: pe.z0 + 0.066 }, STACK.mx4[1], 2.5);
    }
    if (insideRect(SRAM_STRIP.rect, x, z)) add('tsv-column', 'TSV column', 'Through-silicon vias to a 3D-stacked SRAM die', SRAM_STRIP.tsvBand, STACK.my1[1], 2.5);
  }
  if (stop === 'cells' || stop === 'devices') {
    // Name the standard cells around the target: the logic gates themselves.
    const seen = new Set<string>();
    const reach = stop === 'cells' ? 6 : 2;
    for (let dr = -reach; dr <= reach; dr += 1) for (let dx = -reach * 4; dx <= reach * 4; dx += 1) {
      const px = x + dx * CPP * 2;
      const pz = z + dr * ROW;
      const hit = cellAt(px, pz);
      if (!hit || hit.cell.type === 'FILL' || hit.cell.type === 'TAP') continue;
      const key = `${hit.row}:${hit.cell.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cx = (hit.cell.start + hit.cell.width / 2) * CPP;
      const cz = (hit.row + 0.5) * ROW;
      const y = stop === 'cells' ? STACK.m3[1] : STACK.contact[1];
      const rect = { x0: hit.cell.start * CPP, z0: hit.row * ROW, x1: (hit.cell.start + hit.cell.width) * CPP, z1: (hit.row + 1) * ROW };
      labels.push({ id: `cell-${key}`, title: `${hit.cell.type} · ${CELL_NAMES[hit.cell.type]}`, detail: `Standard cell, ${hit.cell.width} gate pitches wide`, x: cx, y, z: cz, priority: 2 - Math.hypot(cx - x, cz - z) * 1e3, rect });
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Cross-section ruler
// ---------------------------------------------------------------------------

export type RulerBand = { id: string; label: string; y0: number; y1: number };

/** Layer bands, bottom to top, for labelling a cross-section. */
export const STACK_RULER: RulerBand[] = [
  { id: 'substrate', label: 'Silicon substrate', y0: -0.25, y1: STACK.tsv[0] },
  { id: 'tsv', label: 'TSV depth (60 µm)', y0: STACK.tsv[0], y1: STACK.dtc[0] },
  { id: 'dtc', label: 'Deep-trench capacitors', y0: STACK.dtc[0], y1: STACK.backside[0] },
  { id: 'backside', label: 'Backside power rails', y0: STACK.backside[0], y1: STACK.backside[1] },
  { id: 'nano-tsv', label: 'Nano-TSVs', y0: STACK.nanoTsv[0], y1: STACK.nanoTsv[1] },
  { id: 'bpr', label: 'Buried power rails', y0: STACK.bpr[0], y1: STACK.bpr[1] },
  { id: 'feol', label: 'Transistors: fins, gates, contacts', y0: 0, y1: STACK.contact[1] },
  { id: 'm0', label: 'M0', y0: STACK.m0[0], y1: STACK.m0[1] },
  { id: 'm1', label: 'M1', y0: STACK.m1[0], y1: STACK.m1[1] },
  { id: 'm2', label: 'M2', y0: STACK.m2[0], y1: STACK.m2[1] },
  { id: 'm3', label: 'M3', y0: STACK.m3[0], y1: STACK.m3[1] },
  { id: 'mx1', label: 'Mx1', y0: STACK.mx1[0], y1: STACK.mx1[1] },
  { id: 'mx2', label: 'Mx2', y0: STACK.mx2[0], y1: STACK.mx2[1] },
  { id: 'mx3', label: 'Mx3', y0: STACK.mx3[0], y1: STACK.mx3[1] },
  { id: 'mx4', label: 'Mx4 power', y0: STACK.mx4[0], y1: STACK.mx4[1] },
  { id: 'sys', label: 'Systolic buses', y0: STACK.sysH[0], y1: STACK.sysV[1] },
  { id: 'my1', label: 'My1 straps', y0: STACK.my1[0], y1: STACK.my1[1] },
  { id: 'my2', label: 'My2 straps', y0: STACK.my2[0], y1: STACK.my2[1] },
  { id: 'chan', label: 'Channel buses', y0: STACK.chanH[0], y1: STACK.chanV[1] },
  { id: 'noc', label: 'NoC lanes', y0: STACK.noc[0], y1: STACK.noc[1] },
  { id: 'ring', label: 'Tile rings', y0: STACK.ring[0], y1: STACK.ring[1] },
  { id: 'mz1', label: 'Top metal Mz1', y0: STACK.mz1[0], y1: STACK.mz1[1] },
  { id: 'mz2', label: 'Top metal Mz2', y0: STACK.mz2[0], y1: STACK.mz2[1] },
  { id: 'pad', label: 'Pads + UBM', y0: STACK.pad[0], y1: STACK.ubm[1] },
  { id: 'pillar', label: 'Cu pillars', y0: STACK.pillar[0], y1: STACK.pillar[1] },
  { id: 'solder', label: 'Solder caps', y0: STACK.solder[0], y1: STACK.solder[1] },
];

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export type RayHit = { batch: number; index: number; t: number };

/**
 * Nearest primitive a ray hits in one chunk, in world units along the ray.
 * `tMin` starts the ray late (the section plane: a cut primitive is hit on its
 * cut face). `skip` drops hits the view does not draw, such as points cleared
 * by the delayering crater; it receives the world point where the ray enters.
 */
export function pickChunk(
  chunk: ChunkData,
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  tMin = 0,
  tMax = Infinity,
  skip?: (x: number, top: number, z: number) => boolean,
): RayHit | null {
  const ox = origin[0] - chunk.origin[0];
  const oy = origin[1];
  const oz = origin[2] - chunk.origin[2];
  const [dx, dy, dz] = dir;
  const ix = 1 / dx;
  const iy = 1 / dy;
  const iz = 1 / dz;
  // Whole-chunk bounds first (cylinders may overhang a little).
  const hx = (chunk.bounds.x1 - chunk.bounds.x0) * 0.56;
  const hz = (chunk.bounds.z1 - chunk.bounds.z0) * 0.56;
  if (!slab(ox, ix, -hx, hx, oy, iy, chunk.yMin, chunk.yMax, oz, iz, -hz, hz, tMin, tMax)) return null;
  let best: RayHit | null = null;
  let limit = tMax;
  for (let b = 0; b < chunk.batches.length; b += 1) {
    const batch = chunk.batches[b];
    const d = batch.data;
    const box = batch.shape === 'box';
    for (let k = 0; k < batch.count; k += 1) {
      const o = k * 10;
      const cx = d[o];
      const cy = d[o + 1];
      const cz = d[o + 2];
      const sx = d[o + 3] / 2;
      const sy = d[o + 4] / 2;
      const sz = d[o + 5] / 2;
      const t = box
        ? slabEnter(ox, ix, cx - sx, cx + sx, oy, iy, cy - sy, cy + sy, oz, iz, cz - sz, cz + sz, tMin, limit)
        : cylinderEnter(ox, oy, oz, dx, dy, dz, cx, cz, sx, cy - sy, cy + sy, tMin, limit);
      if (t === null) continue;
      if (skip && skip(origin[0] + t * dx, oy + t * dy, origin[2] + t * dz)) continue;
      best = { batch: b, index: k, t };
      limit = t;
    }
  }
  return best;
}

function slab(ox: number, ix: number, x0: number, x1: number, oy: number, iy: number, y0: number, y1: number, oz: number, iz: number, z0: number, z1: number, tMin: number, tMax: number) {
  return slabEnter(ox, ix, x0, x1, oy, iy, y0, y1, oz, iz, z0, z1, tMin, tMax) !== null;
}

/**
 * Entry distance of a ray into an axis-aligned box, clamped to [tMin, tMax].
 * Unrolled and allocation-free: hover and label placement call it per primitive.
 */
function slabEnter(ox: number, ix: number, x0: number, x1: number, oy: number, iy: number, y0: number, y1: number, oz: number, iz: number, z0: number, z1: number, tMin: number, tMax: number): number | null {
  let t0 = tMin;
  let t1 = tMax;
  let a: number;
  let b: number;
  // A ray parallel to a slab (infinite inverse) is inside it or misses entirely.
  if (Number.isFinite(ix)) {
    a = (x0 - ox) * ix;
    b = (x1 - ox) * ix;
    if (a > t0 && a <= b) t0 = a; else if (b > t0 && b < a) t0 = b;
    if (a > b) { if (a < t1) t1 = a; } else if (b < t1) t1 = b;
    if (t0 > t1) return null;
  } else if (ox < x0 || ox > x1) return null;
  if (Number.isFinite(iy)) {
    a = (y0 - oy) * iy;
    b = (y1 - oy) * iy;
    if (a > t0 && a <= b) t0 = a; else if (b > t0 && b < a) t0 = b;
    if (a > b) { if (a < t1) t1 = a; } else if (b < t1) t1 = b;
    if (t0 > t1) return null;
  } else if (oy < y0 || oy > y1) return null;
  if (Number.isFinite(iz)) {
    a = (z0 - oz) * iz;
    b = (z1 - oz) * iz;
    if (a > t0 && a <= b) t0 = a; else if (b > t0 && b < a) t0 = b;
    if (a > b) { if (a < t1) t1 = a; } else if (b < t1) t1 = b;
    if (t0 > t1) return null;
  } else if (oz < z0 || oz > z1) return null;
  return t0;
}

/** Entry distance of a ray into a vertical cylinder (side or caps). */
function cylinderEnter(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cz: number, r: number, y0: number, y1: number, tMin: number, tMax: number): number | null {
  let best: number | null = null;
  const px = ox - cx;
  const pz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a > 1e-30) {
    const b = 2 * (px * dx + pz * dz);
    const c = px * px + pz * pz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t < tMin || t > tMax) continue;
        const y = oy + t * dy;
        if (y >= y0 && y <= y1 && (best === null || t < best)) best = t;
      }
      // Starting inside the side wall (e.g. at a section plane) counts as a hit at tMin.
      if (c <= 0) {
        const y = oy + tMin * dy;
        if (y >= y0 && y <= y1) best = best === null ? tMin : Math.min(best, tMin);
      }
    }
  }
  if (Math.abs(dy) > 1e-30) {
    for (const yCap of [y0, y1]) {
      const t = (yCap - oy) / dy;
      if (t < tMin || t > tMax) continue;
      const qx = px + t * dx;
      const qz = pz + t * dz;
      if (qx * qx + qz * qz <= r * r && (best === null || t < best)) best = t;
    }
  }
  return best;
}
