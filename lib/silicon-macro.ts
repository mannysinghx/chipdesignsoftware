// Procedural silicon model behind the Silicon macro view.
//
// The die outline, the compute-tile array, the shared SRAM strip, and the
// eight edge memory PHYs follow ACCELERATOR_FLOORPLAN and the package twin
// (planned evidence). Everything inside them -- the metal stack, standard
// cells, transistors, TSVs, and deep-trench capacitors -- is generated from a
// deterministic hash so the die reads like a dense advanced-node AI
// accelerator. It is an illustration: not layout, not GDS, and not a PDK.
//
// Units are millimetres (um() and nm() convert). +y points up from the
// silicon surface: the front end sits at y ≈ 0, the metal stack above it, and
// TSVs, buried power rails, and deep trenches below it.
//
// Geometry is streamed in five detail levels. Level 0 is the whole die and is
// built once. Levels 1-4 are square chunks generated on demand around the
// camera target; every primitive is placed from global coordinates, so a chunk
// is identical whenever it is regenerated and neighbouring chunks meet without
// seams.

import { ACCELERATOR_FLOORPLAN, OPEN_TITAN_REFERENCE } from './reference-microchip.ts';
import { PACKAGE_GEOMETRY, SCENE_MM_PER_UNIT, STACK_PLACEMENTS, acceleratorPhyAnchor, type StackSide } from './package-connectors.ts';
import { FLOW, packPhase, type Flow, type PartId } from './silicon-part-ids.ts';

export const um = (value: number) => value * 1e-3;
export const nm = (value: number) => value * 1e-6;

// ---------------------------------------------------------------------------
// Deterministic hashing (integer only, so every platform agrees)
// ---------------------------------------------------------------------------

function avalanche(value: number) {
  let h = value;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h;
}

export function hash(a: number, b = 0, c = 0, d = 0): number {
  let h = avalanche(0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b));
  h = avalanche(h ^ Math.imul(b | 0, 0xc2b2ae35));
  h = avalanche(h ^ Math.imul(c | 0, 0x27d4eb2f));
  h = avalanche(h ^ Math.imul(d | 0, 0x165667b1));
  return h >>> 0;
}

/** Uniform in [0, 1) from integer coordinates. */
export const rand = (a: number, b = 0, c = 0, d = 0) => hash(a, b, c, d) / 4294967296;

// ---------------------------------------------------------------------------
// Floorplan
// ---------------------------------------------------------------------------

export type Rect = { x0: number; z0: number; x1: number; z1: number };

const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0, z0, x1, z1 });
const centered = (cx: number, cz: number, width: number, depth: number) => rect(cx - width / 2, cz - depth / 2, cx + width / 2, cz + depth / 2);
export const rectsOverlap = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
export const insideRect = (r: Rect, x: number, z: number) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1;
const rectCenter = (r: Rect): [number, number] => [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2];
/** Sorted distinct values, keeping the exact doubles (no string rounding). */
const distinct = (values: number[]) => [...values].sort((a, b) => a - b).filter((value, index, sorted) => index === 0 || value - sorted[index - 1] > 1e-9);

const MM = SCENE_MM_PER_UNIT;

export const DIE = {
  width: PACKAGE_GEOMETRY.accelerator.width * MM,
  depth: PACKAGE_GEOMETRY.accelerator.depth * MM,
  /** Thinned substrate below the front end. */
  thickness: 0.25,
  sealBand: 0.06,
  ioBand: 0.5,
  decapBand: 0.95,
} as const;

export const DIE_RECT = centered(0, 0, DIE.width, DIE.depth);

export type SramMacro = { id: string; label: string; rect: Rect; array: Rect };

function sramMacro(id: string, label: string, r: Rect, periph = 0.04): SramMacro {
  // Word-line drivers on the west edge, sense amplifiers and I/O on the south edge.
  return { id, label, rect: r, array: rect(r.x0 + periph, r.z0, r.x1, r.z1 - periph * 0.75) };
}

export const TILE_RING = 0.03;
export const PE_COLUMNS = 16;
export const PE_ROWS = 12;
export const PE_GAP = 0.012;
const PE_RF = { u0: 0.006, u1: 0.056, v0: 0.006, v1: 0.066, periph: 0.006 };

export type Tile = {
  index: number;
  col: number;
  row: number;
  label: string;
  rect: Rect;
  sram: SramMacro[];
  peArray: Rect;
  pePitchX: number;
  pePitchZ: number;
  router: Rect;
  vector: Rect;
};

const T = ACCELERATOR_FLOORPLAN.computeTiles;
const S = ACCELERATOR_FLOORPLAN.sharedSram;

function buildTile(index: number, col: number, row: number, cx: number, cz: number): Tile {
  const r = centered(cx, cz, T.tileWidth * MM, T.tileDepth * MM);
  const width = r.x1 - r.x0;
  const macroWidth = (width - 2 * TILE_RING - 3 * 0.04) / 4;
  const sram = Array.from({ length: 4 }, (_, k) => {
    const x0 = r.x0 + TILE_RING + k * (macroWidth + 0.04);
    return sramMacro(`tile-${index}-sram-${k}`, `Tile SRAM ${k + 1}`, rect(x0, r.z0 + TILE_RING, x0 + macroWidth, r.z0 + 0.55));
  });
  const peArray = rect(r.x0 + 0.06, r.z0 + 0.59, r.x1 - 0.06, r.z1 - 0.37);
  return {
    index,
    col,
    row,
    label: `Compute tile ${col + 1}·${row + 1}`,
    rect: r,
    sram,
    peArray,
    pePitchX: (peArray.x1 - peArray.x0) / PE_COLUMNS,
    pePitchZ: (peArray.z1 - peArray.z0) / PE_ROWS,
    router: rect(r.x0 + TILE_RING, r.z1 - 0.33, r.x0 + 0.43, r.z1 - TILE_RING),
    vector: rect(r.x0 + 0.47, r.z1 - 0.33, r.x1 - TILE_RING, r.z1 - TILE_RING),
  };
}

// Same placement rule as the package twin: tile columns sit either side of
// the shared SRAM strip.
export const TILES: Tile[] = (() => {
  const tiles: Tile[] = [];
  for (let row = 0; row < T.rows; row += 1) for (let column = 0; column < T.columns; column += 1) {
    const sideIndex = column < T.columns / 2 ? column - T.columns / 2 : column - T.columns / 2 + 1;
    const x = Math.sign(sideIndex) * (S.width / 2 + 0.04 + T.tileWidth / 2) + (sideIndex - Math.sign(sideIndex)) * T.pitchX;
    const z = (row - (T.rows - 1) / 2) * T.pitchZ;
    tiles.push(buildTile(tiles.length, column, row, x * MM, z * MM));
  }
  return tiles;
})();

export const TILE_ARRAY_RECT: Rect = TILES.reduce((bounds, tile) => rect(Math.min(bounds.x0, tile.rect.x0), Math.min(bounds.z0, tile.rect.z0), Math.max(bounds.x1, tile.rect.x1), Math.max(bounds.z1, tile.rect.z1)), rect(Infinity, Infinity, -Infinity, -Infinity));

export function peRect(tile: Tile, i: number, j: number): Rect {
  const x0 = tile.peArray.x0 + i * tile.pePitchX;
  const z0 = tile.peArray.z0 + j * tile.pePitchZ;
  return rect(x0, z0, x0 + tile.pePitchX - PE_GAP, z0 + tile.pePitchZ - PE_GAP);
}

export const SRAM_STRIP = (() => {
  const r = centered(0, 0, S.width * MM, S.depth * MM);
  const tsvBand = rect(-0.09, r.z0 + 0.04, 0.09, r.z1 - 0.04);
  const rows = 24;
  const macroDepth = (r.z1 - r.z0 - (rows + 1) * 0.04) / rows;
  const macros: SramMacro[] = [];
  for (let k = 0; k < rows; k += 1) {
    const z0 = r.z0 + 0.04 + k * (macroDepth + 0.04);
    macros.push(sramMacro(`strip-w-${k}`, `L2 SRAM bank W${k + 1}`, rect(r.x0 + 0.04, z0, tsvBand.x0 - 0.02, z0 + macroDepth)));
    macros.push(sramMacro(`strip-e-${k}`, `L2 SRAM bank E${k + 1}`, rect(tsvBand.x1 + 0.02, z0, r.x1 - 0.04, z0 + macroDepth)));
  }
  return { rect: r, tsvBand, macros, rows, macroDepth };
})();

export type Phy = { index: number; side: StackSide; label: string; rect: Rect; drivers: Rect; bumps: Rect };

const DRIVER_STRIP = 0.35;

// The twin's PHY anchors meet at the die corners (a north PHY and a west PHY
// share about 0.13 × 2.3 mm). In plan view that overlap would put two bump
// fields on one spot, so each PHY is shortened by CORNER_TRIM at both ends.
const CORNER_TRIM = 0.15;

export const PHYS: Phy[] = STACK_PLACEMENTS.map((placement) => {
  const anchor = acceleratorPhyAnchor(placement);
  const horizontal = placement.side === 'north' || placement.side === 'south';
  const r = centered(anchor.x * MM, anchor.z * MM, anchor.width * MM - (horizontal ? 2 * CORNER_TRIM : 0), anchor.depth * MM - (horizontal ? 0 : 2 * CORNER_TRIM));
  const split = {
    north: [rect(r.x0, r.z1 - DRIVER_STRIP, r.x1, r.z1), rect(r.x0, r.z0, r.x1, r.z1 - DRIVER_STRIP)],
    south: [rect(r.x0, r.z0, r.x1, r.z0 + DRIVER_STRIP), rect(r.x0, r.z0 + DRIVER_STRIP, r.x1, r.z1)],
    west: [rect(r.x1 - DRIVER_STRIP, r.z0, r.x1, r.z1), rect(r.x0, r.z0, r.x1 - DRIVER_STRIP, r.z1)],
    east: [rect(r.x0, r.z0, r.x0 + DRIVER_STRIP, r.z1), rect(r.x0 + DRIVER_STRIP, r.z0, r.x1, r.z1)],
  }[placement.side];
  return { index: placement.index, side: placement.side, label: `Memory PHY ${placement.index + 1} (${placement.side} edge)`, rect: r, drivers: split[0], bumps: split[1] };
});

export type EdgeBlockId = 'north' | 'south' | 'west' | 'east';
export type EdgeBlock = { id: EdgeBlockId; label: string; rect: Rect; sram: SramMacro[]; inductors: Array<{ cx: number; cz: number; size: number }> };

// The free band between each pair of PHYs holds the uncore: host interface,
// clock generation, chip-to-chip links, and debug.
export const EDGE_BLOCKS: EdgeBlock[] = (() => {
  const hx = DIE.width / 2 - DIE.decapBand;
  const hz = DIE.depth / 2 - DIE.decapBand;
  const north = rect(-1.5, -hz, 1.5, SRAM_STRIP.rect.z0 - 0.18);
  const south = rect(-1.5, SRAM_STRIP.rect.z1 + 0.18, 1.5, hz);
  const west = rect(-hx, -1.5, TILE_ARRAY_RECT.x0 - 0.2, 1.5);
  const east = rect(TILE_ARRAY_RECT.x1 + 0.2, -1.5, hx, 1.5);
  const [ncx] = rectCenter(north);
  return [
    { id: 'north', label: 'Host interface + management core', rect: north, sram: [sramMacro('north-sram-0', 'Management SRAM 1', rect(ncx + 0.1, north.z0 + 0.25, north.x1 - 0.12, north.z0 + 1.35)), sramMacro('north-sram-1', 'Management SRAM 2', rect(ncx + 0.1, north.z0 + 1.45, north.x1 - 0.12, north.z0 + 2.55))], inductors: [] },
    { id: 'south', label: 'Clock generation (LC PLLs)', rect: south, sram: [], inductors: [{ cx: -0.72, cz: south.z1 - 0.95, size: 0.46 }, { cx: 0.72, cz: south.z1 - 0.95, size: 0.46 }] },
    { id: 'west', label: 'Chip-to-chip SerDes', rect: west, sram: [], inductors: [{ cx: (west.x0 + west.x1) / 2, cz: 0.95, size: 0.34 }] },
    { id: 'east', label: 'Debug, DFT, and telemetry', rect: east, sram: [], inductors: [] },
  ];
})();

export const IO_PADS = (() => {
  const banks: Array<{ side: StackSide; count: number }> = [
    { side: 'north', count: 18 },
    { side: 'south', count: 18 },
    { side: 'west', count: 18 },
    { side: 'east', count: OPEN_TITAN_REFERENCE.asicPadCount - 54 },
  ];
  const inset = 0.27;
  const pads: Array<{ side: StackSide; index: number; rect: Rect }> = [];
  for (const bank of banks) {
    const horizontal = bank.side === 'north' || bank.side === 'south';
    const half = (horizontal ? DIE.width : DIE.depth) / 2;
    for (let index = 0; index < bank.count; index += 1) {
      const along = -0.82 * half + (1.64 * half * index) / Math.max(1, bank.count - 1);
      const x = horizontal ? along : bank.side === 'west' ? -DIE.width / 2 + inset : DIE.width / 2 - inset;
      const z = horizontal ? (bank.side === 'north' ? -DIE.depth / 2 + inset : DIE.depth / 2 - inset) : along;
      pads.push({ side: bank.side, index, rect: horizontal ? centered(x, z, 0.16, 0.24) : centered(x, z, 0.24, 0.16) });
    }
  }
  return pads;
})();

export type Leaf = 'outside' | 'seal' | 'io' | 'decap' | 'phy-bumps' | 'phy-drivers' | 'sram' | 'sram-periph' | 'tsv' | 'logic' | 'router' | 'channel' | 'analog';

export function tileAt(x: number, z: number): Tile | null {
  for (const tile of TILES) if (insideRect(tile.rect, x, z)) return tile;
  return null;
}

function macroLeaf(macros: SramMacro[], x: number, z: number): Leaf | null {
  for (const macro of macros) if (insideRect(macro.rect, x, z)) return insideRect(macro.array, x, z) ? 'sram' : 'sram-periph';
  return null;
}

function tileLeaf(tile: Tile, x: number, z: number): Leaf {
  const r = tile.rect;
  if (x < r.x0 + TILE_RING || x >= r.x1 - TILE_RING || z < r.z0 + TILE_RING || z >= r.z1 - TILE_RING) return 'decap';
  const sram = macroLeaf(tile.sram, x, z);
  if (sram) return sram;
  if (insideRect(tile.peArray, x, z)) {
    const u = x - tile.peArray.x0;
    const v = z - tile.peArray.z0;
    const lu = u - Math.floor(u / tile.pePitchX) * tile.pePitchX;
    const lv = v - Math.floor(v / tile.pePitchZ) * tile.pePitchZ;
    if (lu > tile.pePitchX - PE_GAP || lv > tile.pePitchZ - PE_GAP) return 'channel';
    if (lu >= PE_RF.u0 && lu < PE_RF.u1 && lv >= PE_RF.v0 && lv < PE_RF.v1) return lu < PE_RF.u0 + PE_RF.periph || lv > PE_RF.v1 - PE_RF.periph ? 'sram-periph' : 'sram';
    return 'logic';
  }
  if (insideRect(tile.router, x, z)) return 'router';
  if (insideRect(tile.vector, x, z)) return 'logic';
  return 'channel';
}

function stripLeaf(x: number, z: number): Leaf {
  if (insideRect(SRAM_STRIP.tsvBand, x, z)) return 'tsv';
  return macroLeaf(SRAM_STRIP.macros, x, z) ?? 'channel';
}

function blockLeaf(block: EdgeBlock, x: number, z: number): Leaf {
  const sram = macroLeaf(block.sram, x, z);
  if (sram) return sram;
  for (const inductor of block.inductors) if (Math.abs(x - inductor.cx) < inductor.size * 0.62 && Math.abs(z - inductor.cz) < inductor.size * 0.62) return 'analog';
  if (block.id === 'west') return x < (block.rect.x0 + block.rect.x1) / 2 ? 'phy-drivers' : 'analog';
  if (block.id === 'south' && z > block.rect.z1 - 1.5) return 'analog';
  return 'logic';
}

/** Functional region at a point on the die surface. */
export function leafAt(x: number, z: number): Leaf {
  const hx = DIE.width / 2;
  const hz = DIE.depth / 2;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax >= hx || az >= hz) return 'outside';
  const edge = Math.min(hx - ax, hz - az);
  if (edge < DIE.sealBand) return 'seal';
  if (edge < DIE.ioBand) return 'io';
  for (const phy of PHYS) if (insideRect(phy.rect, x, z)) return insideRect(phy.drivers, x, z) ? 'phy-drivers' : 'phy-bumps';
  for (const block of EDGE_BLOCKS) if (insideRect(block.rect, x, z)) return blockLeaf(block, x, z);
  if (insideRect(SRAM_STRIP.rect, x, z)) return stripLeaf(x, z);
  const tile = tileAt(x, z);
  if (tile) return tileLeaf(tile, x, z);
  if (edge < DIE.decapBand) return 'decap';
  if (insideRect(TILE_ARRAY_RECT, x, z)) return 'channel';
  return 'logic';
}

const LEAF_TEXT: Record<Leaf, string> = {
  outside: 'Package',
  seal: 'Seal ring',
  io: 'I/O cell ring',
  decap: 'Decoupling + deep-trench capacitors',
  'phy-bumps': 'Microbump field',
  'phy-drivers': 'Lane drivers + training',
  sram: 'SRAM bitcell array',
  'sram-periph': 'SRAM periphery',
  tsv: 'TSV column',
  logic: 'Standard-cell logic',
  router: 'NoC router',
  channel: 'Routing channel',
  analog: 'Analog + inductors',
};

/** Human-readable path to a point: die region › block › leaf. */
export function describeLocation(x: number, z: number): string[] {
  const leaf = leafAt(x, z);
  if (leaf === 'outside') return ['Package substrate'];
  const path: string[] = [];
  const phy = PHYS.find((item) => insideRect(item.rect, x, z));
  const block = EDGE_BLOCKS.find((item) => insideRect(item.rect, x, z));
  const tile = tileAt(x, z);
  if (phy) path.push(phy.label);
  else if (block) path.push(block.label);
  else if (insideRect(SRAM_STRIP.rect, x, z)) {
    path.push('Shared L2 SRAM strip');
    const macro = SRAM_STRIP.macros.find((item) => insideRect(item.rect, x, z));
    if (macro) path.push(macro.label);
  } else if (tile) {
    path.push(tile.label);
    const macro = tile.sram.find((item) => insideRect(item.rect, x, z));
    if (macro) path.push(macro.label);
    else if (insideRect(tile.peArray, x, z)) {
      const i = Math.floor((x - tile.peArray.x0) / tile.pePitchX);
      const j = Math.floor((z - tile.peArray.z0) / tile.pePitchZ);
      path.push(`Tensor PE ${String(i + 1).padStart(2, '0')}·${String(j + 1).padStart(2, '0')}`);
    } else if (insideRect(tile.router, x, z)) path.push('Tile router');
    else if (insideRect(tile.vector, x, z)) path.push('Vector + control unit');
  } else if (leaf !== 'seal' && leaf !== 'io') path.push(leaf === 'decap' ? 'Power-delivery band' : 'Uncore fabric');
  path.push(LEAF_TEXT[leaf]);
  return path;
}

// ---------------------------------------------------------------------------
// Vertical stack (heights in mm; front end at y = 0)
// ---------------------------------------------------------------------------

type Band = readonly [number, number];
const band = (y0Um: number, y1Um: number): Band => [um(y0Um), um(y1Um)];

// Every metal layer reaches the next one through a via band, so a net can
// climb from a transistor to a bump. Some via bands stand in for layers the
// view does not draw: V3 is the stacked-via column through the thin upper
// local layers (M4-M7 on a real die) between M3 and Mx1.
export const STACK = {
  fin: band(0, 0.05),
  gate: band(0, 0.08),
  epi: band(0.02, 0.062),
  contact: band(0.062, 0.098),
  m0: band(0.1, 0.128),
  v0: band(0.128, 0.15),
  m1: band(0.15, 0.18),
  v1: band(0.18, 0.205),
  m2: band(0.205, 0.235),
  v2: band(0.235, 0.262),
  m3: band(0.262, 0.3),
  v3: band(0.306, 0.8),
  mx1: band(0.8, 1.1),
  vx1: band(1.1, 1.4),
  mx2: band(1.4, 1.72),
  vx2: band(1.72, 2.1),
  mx3: band(2.1, 2.5),
  vx3: band(2.5, 2.8),
  mx4: band(2.8, 3.2),
  vx4: band(3.23, 3.7),
  sysH: band(3.7, 4.1),
  vs: band(4.1, 4.15),
  sysV: band(4.15, 4.5),
  vy0: band(4.5, 4.6),
  my1: band(4.6, 5.4),
  vy1: band(5.4, 6.2),
  my2: band(6.2, 7.0),
  vc0: band(7.0, 7.05),
  chanH: band(7.05, 7.3),
  vc1: band(7.3, 7.32),
  chanV: band(7.32, 7.55),
  vn: band(7.55, 7.6),
  noc: band(7.6, 8.4),
  nocH: band(7.6, 7.95),
  vnj: band(7.95, 8.05),
  nocV: band(8.05, 8.4),
  vr: band(8.4, 8.5),
  ring: band(8.5, 9.1),
  vz0: band(9.1, 9.2),
  mz1: band(9.2, 10.8),
  vz1: band(10.8, 11.4),
  mz2: band(11.4, 13.0),
  pad: band(13.0, 14.5),
  ubm: band(13.0, 14.6),
  pillar: band(14.62, 20.5),
  solder: band(20.5, 23.0),
  bpr: band(-0.05, -0.012),
  vbpr: band(-0.012, 0.062),
  nanoTsv: band(-0.6, -0.05),
  backside: band(-0.68, -0.6),
  dtc: band(-1.6, 0.002),
  tsv: band(-60, 0.098),
} as const;

/** Top of the whole stack (bumps excluded) and the tallest structure. */
export const STACK_TOP = STACK.pad[1];
export const STACK_MAX = STACK.solder[1];

// ---------------------------------------------------------------------------
// Detail levels
// ---------------------------------------------------------------------------

export type LevelSpec = {
  id: number;
  name: string;
  /** Chunk edge in mm (0 for the static global level). */
  chunk: number;
  /** Chunk window radius around the target, in chunks. */
  radius: number;
  /** Camera distance below which the level is drawn, and where its fade-in completes. */
  activateAt: number;
  fullAt: number;
  /** Glow pulses: spacing and speed along a wire, in µm and µm/s. */
  pulse: { period: number; speed: number };
  /**
   * Vias are far shorter than wires, so a pulse climbing one would flash by
   * unseen. Along a vertical conductor the pulse path counts each µm of
   * height this many times: pulses visibly climb and descend between layers.
   */
  viaStretch: number;
};

export const LEVELS: LevelSpec[] = [
  { id: 0, name: 'Global metal', chunk: 0, radius: 0, activateAt: Infinity, fullAt: Infinity, pulse: { period: 1500, speed: 1500 }, viaStretch: 200 },
  { id: 1, name: 'Semi-global metal', chunk: 0.5, radius: 3, activateAt: 6, fullAt: 4.4, pulse: { period: 150, speed: 150 }, viaStretch: 16 },
  { id: 2, name: 'Intermediate metal', chunk: 0.1, radius: 2, activateAt: 0.45, fullAt: 0.33, pulse: { period: 28, speed: 26 }, viaStretch: 8 },
  { id: 3, name: 'Local interconnect', chunk: 0.003, radius: 2, activateAt: 0.014, fullAt: 0.0105, pulse: { period: 1.8, speed: 1.4 }, viaStretch: 8 },
  { id: 4, name: 'Front-end devices', chunk: 0.001, radius: 2, activateAt: 0.0046, fullAt: 0.0034, pulse: { period: 40, speed: 12 }, viaStretch: 1 },
];

export function levelFade(level: LevelSpec, distance: number): number {
  if (!Number.isFinite(level.activateAt)) return 1;
  if (distance >= level.activateAt) return 0;
  if (distance <= level.fullAt) return 1;
  return (level.activateAt - distance) / (level.activateAt - level.fullAt);
}

export type ChunkKey = { level: number; ix: number; iz: number };
export const chunkId = (key: ChunkKey) => `${key.level}:${key.ix}:${key.iz}`;

export function chunkBounds(level: LevelSpec, ix: number, iz: number): Rect {
  return rect(ix * level.chunk, iz * level.chunk, (ix + 1) * level.chunk, (iz + 1) * level.chunk);
}

/**
 * Chunks to keep resident for a level: a square window around the target,
 * trimmed to the die, nearest first. Levels far coarser than the current
 * zoom keep only their inner ring; beyond it the die texture carries them.
 */
export function windowChunks(level: LevelSpec, targetX: number, targetZ: number, distance: number): ChunkKey[] {
  if (level.chunk <= 0 || distance >= level.activateAt) return [];
  const radius = level.activateAt > distance * 60 ? Math.min(1, level.radius) : level.radius;
  const cx = Math.floor(targetX / level.chunk);
  const cz = Math.floor(targetZ / level.chunk);
  const keys: Array<ChunkKey & { order: number }> = [];
  for (let dz = -radius; dz <= radius; dz += 1) for (let dx = -radius; dx <= radius; dx += 1) {
    const bounds = chunkBounds(level, cx + dx, cz + dz);
    if (!rectsOverlap(bounds, DIE_RECT)) continue;
    const [mx, mz] = rectCenter(bounds);
    keys.push({ level: level.id, ix: cx + dx, iz: cz + dz, order: Math.hypot(mx - targetX, mz - targetZ) });
  }
  return keys.sort((a, b) => a.order - b.order).map(({ level: id, ix, iz }) => ({ level: id, ix, iz }));
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export type MaterialKey = 'copper' | 'gold' | 'tungsten' | 'gate' | 'silicon' | 'epiN' | 'epiP' | 'oxide' | 'solder';
export type ShapeKey = 'box' | 'cyl';
export const MATERIAL_KEYS: MaterialKey[] = ['copper', 'gold', 'tungsten', 'gate', 'silicon', 'epiN', 'epiP', 'oxide', 'solder'];

/**
 * Packed per instance: offset xyz (chunk-local), size xyz, then
 * data = [tint + axis flag, path start (µm), glow, packed phase].
 * tint is in [0, 1); the flag adds 2 when the glow path runs along z and 4
 * when it runs along y (a via). glow > 0 pulses forward along the path,
 * < 0 backward. The packed phase carries the part and flow in its integer
 * part (see silicon-part-ids.ts); its fraction is the pulse phase.
 */
export const FLOATS_PER_INSTANCE = 10;

/** Axis a primitive's glow path runs along, from its packed tint. */
export const pathAxis = (tintAndFlag: number): 'x' | 'z' | 'y' => {
  const flag = Math.floor(tintAndFlag / 2);
  return flag === 0 ? 'x' : flag === 1 ? 'z' : 'y';
};

export { FLOW, type Flow };

/**
 * How a conductor is drawn and what it carries. `arc` and `entry` place it
 * on a continuous pulse path: `arc` is the path length (µm, vias stretched)
 * where the pulse enters, at the `entry` end of the primitive along its
 * axis, so pulses run unbroken from one primitive of a net into the next.
 */
export type Emit = {
  part?: PartId;
  flow?: Flow;
  glow?: number;
  phase?: number;
  arc?: number;
  entry?: 'min' | 'max';
  /** Glow-path axis; 'y' for vias. Default: the longer horizontal side. */
  axis?: 'x' | 'y' | 'z';
  /** Raise the top face by a tint-dependent sliver so coplanar shapes never z-fight. Default: on for wires, off for vias. */
  lift?: boolean;
  /** Fixes the tint for wires whose unclipped extent differs by chunk. */
  seed?: number;
};

export type Batch = { material: MaterialKey; shape: ShapeKey; data: Float32Array; count: number };

export type ChunkData = {
  level: number;
  ix: number;
  iz: number;
  origin: [number, number, number];
  bounds: Rect;
  batches: Batch[];
  instances: number;
  yMin: number;
  yMax: number;
};

// Sections draw liners behind the conductors they wrap.
const CAP_PRIORITY: Record<MaterialKey, number> = { copper: 0, gold: 0, tungsten: 0, gate: 0, silicon: 1, epiN: 0, epiP: 0, oxide: 2, solder: 0 };

const nmIndex = (value: number) => Math.round(value * 1e6);

export class ChunkBuilder {
  readonly bounds: Rect;
  readonly ox: number;
  readonly oz: number;
  readonly level: number;
  private readonly buffers = new Map<string, number[]>();
  yMin = Infinity;
  yMax = -Infinity;

  constructor(bounds: Rect, origin: [number, number], level = 0) {
    this.bounds = bounds;
    this.ox = origin[0];
    this.oz = origin[1];
    this.level = level;
  }

  private push(material: MaterialKey, shape: ShapeKey, values: number[]) {
    const key = `${material}|${shape}`;
    let buffer = this.buffers.get(key);
    if (!buffer) this.buffers.set(key, (buffer = []));
    for (const value of values) buffer.push(value);
    this.yMin = Math.min(this.yMin, values[1] - values[4] / 2);
    this.yMax = Math.max(this.yMax, values[1] + values[4] / 2);
  }

  /**
   * Axis-aligned box in die coordinates, clipped to the chunk in plan.
   * `seed` fixes the tint for wires whose unclipped extent differs by chunk.
   */
  box(material: MaterialKey, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, glow = 0, phase = 0, seed?: number) {
    this.seg(material, x0, x1, y0, y1, z0, z1, { glow, phase, seed });
  }

  /** A conductor or other box, with what it carries and its place on a pulse path. */
  seg(material: MaterialKey, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, emit: Emit = {}) {
    const b = this.bounds;
    const cx0 = Math.max(x0, b.x0);
    const cx1 = Math.min(x1, b.x1);
    const cz0 = Math.max(z0, b.z0);
    const cz1 = Math.min(z1, b.z1);
    if (cx0 >= cx1 || cz0 >= cz1 || y0 >= y1) return;
    const axis = emit.axis ?? (x1 - x0 >= z1 - z0 ? 'x' : 'z');
    // Tint comes from the unclipped box, so a wire split across chunks keeps
    // one colour. Shapes on one layer overlap where they cross; a small
    // tint-driven lift keeps their top faces from z-fighting.
    const tint = emit.seed === undefined ? rand(nmIndex(x0), nmIndex(z0), nmIndex(y0 * 10), 17) : rand(emit.seed, 23);
    const top = emit.lift ?? axis !== 'y' ? y1 + (y1 - y0) * 0.04 * tint : y1;
    let glow = emit.glow ?? 0;
    let start = 0;
    if (glow !== 0) {
      if (emit.arc !== undefined) {
        // Continuous path: the pulse enters at the `entry` end with path length `arc`.
        const stretch = axis === 'y' ? LEVELS[this.level].viaStretch : 1;
        const [a0, a1, c0] = axis === 'x' ? [x0, x1, cx0] : axis === 'z' ? [z0, z1, cz0] : [y0, y1, y0];
        if ((emit.entry ?? 'min') === 'min') {
          start = emit.arc + (c0 - a0) * 1000 * stretch;
          glow = Math.abs(glow);
        } else {
          start = -(emit.arc + (a1 - c0) * 1000 * stretch);
          glow = -Math.abs(glow);
        }
      } else {
        // The pulse path coordinate is the absolute position along the wire
        // (µm), so pulses stay continuous however the wire is clipped.
        start = (axis === 'x' ? cx0 : axis === 'z' ? cz0 : y0) * 1000;
      }
    }
    const flag = axis === 'x' ? 0 : axis === 'z' ? 2 : 4;
    this.push(material, 'box', [(cx0 + cx1) / 2 - this.ox, (y0 + top) / 2, (cz0 + cz1) / 2 - this.oz, cx1 - cx0, top - y0, cz1 - cz0, tint + flag, start, glow, packPhase(emit.part, emit.flow ?? FLOW.data, emit.phase ?? 0)]);
  }

  /**
   * A via: a vertical conductor centred at (x, z) whose glow path climbs (entry 'min')
   * or descends (entry 'max') between y0 and y1.
   */
  via(material: MaterialKey, x: number, z: number, halfX: number, halfZ: number, y0: number, y1: number, emit: Emit = {}) {
    this.seg(material, x - halfX, x + halfX, y0, y1, z - halfZ, z + halfZ, { lift: false, ...emit, axis: 'y' });
  }

  /** Vertical cylinder, kept by the chunk that contains its axis. */
  cyl(material: MaterialKey, cx: number, cz: number, radius: number, y0: number, y1: number, glow = 0, phase = 0, emit: Emit = {}) {
    if (!insideRect(this.bounds, cx, cz) || y0 >= y1) return;
    const tint = rand(nmIndex(cx), nmIndex(cz), nmIndex(y0 * 10), 29);
    const stretch = LEVELS[this.level].viaStretch;
    let start = 0;
    let g = emit.glow ?? glow;
    if (g !== 0 && emit.arc !== undefined) {
      start = (emit.entry ?? 'min') === 'min' ? emit.arc : -(emit.arc + (y1 - y0) * 1000 * stretch);
      g = (emit.entry ?? 'min') === 'min' ? Math.abs(g) : -Math.abs(g);
    }
    this.push(material, 'cyl', [cx - this.ox, (y0 + y1) / 2, cz - this.oz, radius * 2, y1 - y0, radius * 2, tint + (g !== 0 ? 4 : 0), start, g, packPhase(emit.part, emit.flow ?? FLOW.data, emit.phase ?? phase)]);
  }

  finish(level: number, ix: number, iz: number): ChunkData {
    const batches: Batch[] = [];
    let instances = 0;
    for (const [key, values] of this.buffers) {
      const [material, shape] = key.split('|') as [MaterialKey, ShapeKey];
      const count = values.length / FLOATS_PER_INSTANCE;
      instances += count;
      batches.push({ material, shape, data: new Float32Array(values), count });
    }
    batches.sort((a, b) => (a.material + a.shape).localeCompare(b.material + b.shape));
    return { level, ix, iz, origin: [this.ox, 0, this.oz], bounds: this.bounds, batches, instances, yMin: Number.isFinite(this.yMin) ? this.yMin : 0, yMax: Number.isFinite(this.yMax) ? this.yMax : 0 };
  }
}

// Leaf lookups repeat heavily inside a chunk (every maze cell asks), so each
// generator memoizes them on a grid matched to its cell size.
class LeafCache {
  private readonly cache = new Map<number, Leaf>();
  private readonly step: number;
  constructor(step: number) {
    this.step = step;
  }
  at(x: number, z: number): Leaf {
    const i = Math.floor(x / this.step);
    const j = Math.floor(z / this.step);
    const key = i * 4194304 + j;
    let leaf = this.cache.get(key);
    if (leaf === undefined) {
      leaf = leafAt((i + 0.5) * this.step, (j + 0.5) * this.step);
      this.cache.set(key, leaf);
    }
    return leaf;
  }
}

// ---------------------------------------------------------------------------
// Shared generators
// ---------------------------------------------------------------------------

type MazeLayer = {
  salt: number;
  horizontal: boolean;
  pitch: number;
  width: number;
  y: Band;
  cell: number;
  material: MaterialKey;
  occupancy: (leaf: Leaf) => number;
  glowChance: number;
};

type Run = { track: number; start: number; end: number; lo: number; hi: number };

/**
 * Manhattan routing on one layer. Each track is cut into cells; a cell is
 * occupied by hash against the local region's density, and maximal runs of
 * occupied cells become wire segments with random end insets.
 */
function mazeRuns(layer: MazeLayer, bounds: Rect, leaves: LeafCache): Run[] {
  const runs: Run[] = [];
  const across0 = layer.horizontal ? bounds.z0 : bounds.x0;
  const across1 = layer.horizontal ? bounds.z1 : bounds.x1;
  const along0 = layer.horizontal ? bounds.x0 : bounds.z0;
  const along1 = layer.horizontal ? bounds.x1 : bounds.z1;
  const occupied = (track: number, cell: number) => {
    const across = (track + 0.5) * layer.pitch;
    const along = (cell + 0.5) * layer.cell;
    const leaf = layer.horizontal ? leaves.at(along, across) : leaves.at(across, along);
    return rand(layer.salt, track, cell) < layer.occupancy(leaf);
  };
  const t0 = Math.floor(across0 / layer.pitch);
  const t1 = Math.ceil(across1 / layer.pitch);
  const c0 = Math.floor(along0 / layer.cell);
  const c1 = Math.floor(along1 / layer.cell);
  for (let track = t0; track < t1; track += 1) {
    const across = (track + 0.5) * layer.pitch;
    if (across < across0 || across >= across1) continue;
    let cell = c0;
    while (cell <= c1) {
      if (!occupied(track, cell)) {
        cell += 1;
        continue;
      }
      let start = cell;
      if (cell === c0) for (let guard = 0; guard < 48 && occupied(track, start - 1); guard += 1) start -= 1;
      let end = cell;
      while (occupied(track, end + 1) && end - start < 96) end += 1;
      const lo = start * layer.cell + layer.cell * (0.08 + 0.3 * rand(layer.salt + 1, track, start));
      const hi = (end + 1) * layer.cell - layer.cell * (0.08 + 0.3 * rand(layer.salt + 2, track, end));
      if (hi > lo) runs.push({ track, start, end, lo, hi });
      cell = end + 1;
    }
  }
  return runs;
}

/** Plain straps across a chunk, broken wherever `allowed` rejects the region. */
function emitStraps(builder: ChunkBuilder, leaves: LeafCache, options: { horizontal: boolean; pitch: number; offset: number; width: number; y: Band; material: MaterialKey; sample: number; allowed: (leaf: Leaf) => boolean; glowChance?: number; salt?: number; part?: PartId; flowOf?: (index: number) => Flow }) {
  const b = builder.bounds;
  const across0 = options.horizontal ? b.z0 : b.x0;
  const across1 = options.horizontal ? b.z1 : b.x1;
  const along0 = options.horizontal ? b.x0 : b.z0;
  const along1 = options.horizontal ? b.x1 : b.z1;
  const first = Math.ceil((across0 - options.offset) / options.pitch);
  const salt = options.salt ?? 71;
  for (let k = first; options.offset + k * options.pitch < across1; k += 1) {
    const across = options.offset + k * options.pitch;
    const seed = hash(salt, k, Math.round(across * 1e6));
    // Power straps carry their supply; the flow toggle shows it moving.
    const flow = options.flowOf?.(k);
    const glow = flow !== undefined ? POWER_GLOW * (k % 2 === 0 ? 1 : -1) : rand(salt, k) < (options.glowChance ?? 0) ? (k % 2 === 0 ? 1 : -1) : 0;
    const phase = rand(salt + 1, k);
    let runStart: number | null = null;
    const flush = (end: number) => {
      if (runStart === null) return;
      const emit: Emit = { glow, phase, seed, part: options.part, flow };
      if (options.horizontal) builder.seg(options.material, runStart, end, options.y[0], options.y[1], across - options.width / 2, across + options.width / 2, emit);
      else builder.seg(options.material, across - options.width / 2, across + options.width / 2, options.y[0], options.y[1], runStart, end, emit);
      runStart = null;
    };
    const s0 = Math.floor(along0 / options.sample);
    const s1 = Math.ceil(along1 / options.sample);
    for (let s = s0; s < s1; s += 1) {
      const mid = (s + 0.5) * options.sample;
      const ok = options.allowed(options.horizontal ? leaves.at(mid, across) : leaves.at(across, mid));
      if (ok && runStart === null) runStart = s * options.sample;
      if (!ok) flush(s * options.sample);
    }
    flush(s1 * options.sample);
  }
}

// ---------------------------------------------------------------------------
// Level 0: global metal (static, whole die)
// ---------------------------------------------------------------------------

const PHY_RECTS = PHYS.map((phy) => phy.rect);
const INDUCTOR_RECTS = EDGE_BLOCKS.flatMap((block) => block.inductors.map((inductor) => centered(inductor.cx, inductor.cz, inductor.size * 1.3, inductor.size * 1.3)));
const inAnyPhy = (x: number, z: number) => PHY_RECTS.some((r) => insideRect(r, x, z)) || INDUCTOR_RECTS.some((r) => insideRect(r, x, z));

function squareSpiral(builder: ChunkBuilder, cx: number, cz: number, size: number, turns: number, width: number, spacing: number, y: Band) {
  let half = size / 2;
  for (let turn = 0; turn < turns; turn += 1) {
    const inner = half - width;
    builder.box('gold', cx - half, cx + half, y[0], y[1], cz - half, cz - inner); // north
    builder.box('gold', cx + inner, cx + half, y[0], y[1], cz - half, cz + half); // east
    builder.box('gold', cx - half, cx + half, y[0], y[1], cz + inner, cz + half); // south
    // West side stops short so the next turn steps inward: the spiral opening.
    builder.box('gold', cx - half, cx - inner, y[0], y[1], cz - half + width + spacing, cz + half);
    half -= width + spacing;
  }
  // Underpass back out to the feed, one layer down.
  builder.box('copper', cx - size / 2 - um(40), cx - half, STACK.my2[0], STACK.my2[1], cz - width / 2, cz + width / 2);
}

/** The global power mesh: Mz2 straps along z at xs, Mz1 straps along x at zs; each alternates VDD, VSS by index. */
export const GLOBAL_MESH = (() => {
  const pitch = 0.6;
  const hx = DIE.width / 2;
  const hz = DIE.depth / 2;
  const core = rect(-hx + DIE.ioBand, -hz + DIE.ioBand, hx - DIE.ioBand, hz - DIE.ioBand);
  const xs: number[] = [];
  const zs: number[] = [];
  for (let x = core.x0 + pitch / 2; x < core.x1; x += pitch) xs.push(x);
  for (let z = core.z0 + pitch / 2; z < core.z1; z += pitch) zs.push(z);
  return { pitch, width: um(24), core, xs, zs };
})();

/** On-die network geometry, shared by the global level (lanes, junctions) and level 1 (drops into routers and PHY lanes). */
export const NOC = (() => {
  const a = TILE_ARRAY_RECT;
  const margin = 0.26;
  const columnEdges = distinct(TILES.map((tile) => tile.rect.x0));
  const columnRight = distinct(TILES.map((tile) => tile.rect.x1));
  const rowTop = distinct(TILES.map((tile) => tile.rect.z0));
  const rowBottom = distinct(TILES.map((tile) => tile.rect.z1));
  // Lanes in every channel, plus the two edge lanes that close the network
  // around the array (the east and west PHYs join the network there).
  const vertical: number[] = [a.x0 - margin];
  for (let k = 0; k < columnEdges.length - 1; k += 1) {
    const gapStart = columnRight[k];
    const gapEnd = columnEdges[k + 1];
    // The SRAM strip sits in the widest gap: one lane each side of it.
    if (gapEnd - gapStart > 1) vertical.push((gapStart + SRAM_STRIP.rect.x0) / 2, (SRAM_STRIP.rect.x1 + gapEnd) / 2);
    else vertical.push((gapStart + gapEnd) / 2);
  }
  vertical.push(a.x1 + margin);
  const horizontal = [a.z0 - margin, ...rowBottom.slice(0, -1).map((z, k) => (z + rowTop[k + 1]) / 2), a.z1 + margin];
  const span = { x0: a.x0 - margin, x1: a.x1 + margin, z0: a.z0 - margin, z1: a.z1 + margin };
  const lane = { lines: 4, width: um(14), pitch: um(34) };
  // Links run past the far line of the lane they join, so they meet every line.
  const overhang = um(60);
  const routerLane = (tile: Tile) => {
    const [x] = rectCenter(tile.router);
    const nearest = horizontal.reduce((best, z) => (Math.abs(z - tile.router.z1) < Math.abs(best - tile.router.z1) ? z : best), horizontal[0]);
    const start = tile.router.z0 + 0.05;
    return { x, lane: nearest, start, from: Math.min(start, nearest - overhang), to: Math.max(start, nearest + overhang) };
  };
  const phyBundles = (phy: Phy) => {
    const d = phy.drivers;
    return [0.25, 0.5, 0.75].map((f) => {
      if (phy.side === 'west' || phy.side === 'east') {
        const laneX = phy.side === 'west' ? a.x0 - margin : a.x1 + margin;
        return { horizontal: true, across: phy.rect.z0 + (phy.rect.z1 - phy.rect.z0) * f, from: phy.side === 'west' ? d.x0 : laneX - overhang, to: phy.side === 'west' ? laneX + overhang : d.x1, lane: laneX, lines: 8, width: um(12), pitch: um(26) };
      }
      const laneZ = phy.side === 'north' ? a.z0 - margin : a.z1 + margin;
      return { horizontal: false, across: phy.rect.x0 + (phy.rect.x1 - phy.rect.x0) * f, from: phy.side === 'north' ? d.z0 : laneZ - overhang, to: phy.side === 'north' ? laneZ + overhang : d.z1, lane: laneZ, lines: 8, width: um(12), pitch: um(26) };
    });
  };
  return { vertical, horizontal, span, lane, routerLane, phyBundles };
})();

export function generateGlobal(): ChunkData {
  const pad = 1;
  const builder = new ChunkBuilder(rect(DIE_RECT.x0 - pad, DIE_RECT.z0 - pad, DIE_RECT.x1 + pad, DIE_RECT.z1 + pad), [0, 0], 0);
  const hx = DIE.width / 2;
  const hz = DIE.depth / 2;

  // Seal ring: four concentric walls with stepped 45° corner chamfers.
  for (let ring = 0; ring < 4; ring += 1) {
    const inset = um(8 + ring * 12);
    const width = um(ring === 1 ? 7 : 5);
    const material: MaterialKey = ring === 1 ? 'gold' : 'copper';
    const top = ring === 1 ? STACK.pad[1] : STACK.mz2[1];
    const chamfer = um(150) - inset;
    const x0 = -hx + inset;
    const x1 = hx - inset;
    const z0 = -hz + inset;
    const z1 = hz - inset;
    builder.box(material, x0 + chamfer, x1 - chamfer, um(0.1), top, z0, z0 + width);
    builder.box(material, x0 + chamfer, x1 - chamfer, um(0.1), top, z1 - width, z1);
    builder.box(material, x0, x0 + width, um(0.1), top, z0 + chamfer, z1 - chamfer);
    builder.box(material, x1 - width, x1, um(0.1), top, z0 + chamfer, z1 - chamfer);
    const steps = 8;
    for (let step = 0; step < steps; step += 1) {
      const a = (chamfer * step) / steps;
      const b = (chamfer * (step + 1)) / steps;
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        // Corner at (sx*x, sz*z); walk from the x-edge toward the z-edge.
        const cxEdge = sx > 0 ? x1 : x0;
        const czEdge = sz > 0 ? z1 : z0;
        const xa = cxEdge - sx * (chamfer - a);
        const xb = cxEdge - sx * (chamfer - b);
        const zc = czEdge - sz * (b + a) / 2;
        builder.box(material, Math.min(xa, xb) - width / 2, Math.max(xa, xb) + width / 2, um(0.1), top, zc - width / 2 - (b - a) / 2, zc + width / 2 + (b - a) / 2);
      }
    }
  }

  // I/O pads with their leads into the ring.
  for (const padItem of IO_PADS) {
    const r = padItem.rect;
    builder.box('gold', r.x0, r.x1, STACK.pad[0], STACK.pad[1], r.z0, r.z1);
    const frame = um(10);
    builder.box('copper', r.x0 - frame, r.x1 + frame, STACK.mz2[0], STACK.mz2[1], r.z0 - frame, r.z0);
    builder.box('copper', r.x0 - frame, r.x1 + frame, STACK.mz2[0], STACK.mz2[1], r.z1, r.z1 + frame);
    const lead = um(22);
    const [cx, cz] = rectCenter(r);
    // Leads stop short of the core, clear of the mesh straps that start there.
    const leadEnd = DIE.ioBand - um(30);
    if (padItem.side === 'north') builder.box('copper', cx - lead / 2, cx + lead / 2, STACK.mz1[0], STACK.mz1[1], r.z1, -hz + leadEnd);
    if (padItem.side === 'south') builder.box('copper', cx - lead / 2, cx + lead / 2, STACK.mz1[0], STACK.mz1[1], hz - leadEnd, r.z0);
    if (padItem.side === 'west') builder.box('copper', r.x1, -hx + leadEnd, STACK.mz1[0], STACK.mz1[1], cz - lead / 2, cz + lead / 2);
    if (padItem.side === 'east') builder.box('copper', hx - leadEnd, r.x0, STACK.mz1[0], STACK.mz1[1], cz - lead / 2, cz + lead / 2);
    // The pad's frame joins its lead, and the lead drops through a via stack
    // onto the nearest ESD finger of its I/O cell (level 1 draws the cells).
    const horizontal = padItem.side === 'north' || padItem.side === 'south';
    const inward = padItem.side === 'north' || padItem.side === 'west' ? 1 : -1;
    const edgeFrom = horizontal ? (padItem.side === 'north' ? r.z1 : r.z0) : padItem.side === 'west' ? r.x1 : r.x0;
    const deep = (horizontal ? (padItem.side === 'north' ? -hz : hz) : padItem.side === 'west' ? -hx : hx) + inward * (DIE.ioBand - um(80));
    const along = horizontal ? cx : cz;
    const cell = Math.floor(along / um(60));
    const finger = Math.min(5, Math.max(0, Math.round((along - (cell + 0.5) * um(60) + um(22)) / um(8.8))));
    const fingerAt = (cell + 0.5) * um(60) - um(22) + finger * um(8.8);
    const emit: Emit = { part: 'pad-stack', glow: rand(221, padItem.index, padItem.side.length) < 0.25 ? 1 : 0, phase: rand(222, padItem.index) };
    if (horizontal) {
      builder.via('tungsten', cx, edgeFrom + inward * um(5), lead / 2 - um(2), um(4), STACK.vz1[0], STACK.vz1[1], emit);
      builder.via('tungsten', fingerAt, deep, um(1.4), um(4), STACK.my2[1], STACK.mz1[0], { ...emit, entry: 'max', arc: 0 });
    } else {
      builder.via('tungsten', edgeFrom + inward * um(5), cz, um(4), lead / 2 - um(2), STACK.vz1[0], STACK.vz1[1], emit);
      builder.via('tungsten', deep, fingerAt, um(4), um(1.4), STACK.my2[1], STACK.mz1[0], { ...emit, entry: 'max', arc: 0 });
    }
  }

  // Global power mesh: gold straps in both directions, alternating VDD and
  // VSS, broken over the PHY bump fields. Via stacks join crossing straps of
  // the same supply, and power bumps feed the mesh from the package.
  const { xs, zs, core, width: strapWidth } = GLOBAL_MESH;
  const strapRuns = (fixed: number, from: number, to: number, vertical: boolean) => {
    const runs: Array<[number, number]> = [];
    let start: number | null = null;
    const step = 0.05;
    for (let s = from; s <= to + 1e-9; s += step) {
      const blocked = vertical ? inAnyPhy(fixed, s) : inAnyPhy(s, fixed);
      if (!blocked && start === null) start = s;
      if ((blocked || s + step > to) && start !== null) {
        runs.push([start, blocked ? s - step / 2 : to]);
        start = null;
      }
    }
    return runs;
  };
  xs.forEach((x, i) => {
    for (const [a, b] of strapRuns(x, core.z0, core.z1, true)) builder.seg('gold', x - strapWidth / 2, x + strapWidth / 2, STACK.mz2[0], STACK.mz2[1], a, b, { part: 'global-strap', flow: strapFlow(i), glow: POWER_GLOW * (i % 2 === 0 ? 1 : -1), phase: rand(211, i) });
  });
  zs.forEach((z, j) => {
    for (const [a, b] of strapRuns(z, core.x0, core.x1, false)) builder.seg('gold', a, b, STACK.mz1[0], STACK.mz1[1], z - strapWidth / 2, z + strapWidth / 2, { part: 'global-strap', flow: strapFlow(j), glow: POWER_GLOW * (j % 2 === 0 ? 1 : -1), phase: rand(212, j) });
  });
  xs.forEach((x, i) => zs.forEach((z, j) => {
    const flow = strapFlow(i);
    if (flow !== strapFlow(j) || inAnyPhy(x, z)) return;
    const down = flow === FLOW.vdd;
    builder.via('tungsten', x, z, strapWidth / 2, strapWidth / 2, STACK.vz1[0], STACK.vz1[1], { part: 'top-via', flow, glow: POWER_GLOW, phase: rand(213, i, j), entry: down ? 'max' : 'min', arc: 0 });
    if ((i + j) % 4 !== 0) return;
    // A power bump on every fourth same-supply crossing.
    const emit: Emit = { part: 'power-bump', flow, glow: POWER_GLOW, phase: rand(214, i, j) };
    builder.seg('gold', x - um(14), x + um(14), STACK.ubm[0], STACK.ubm[1], z - um(14), z + um(14), emit);
    builder.cyl('copper', x, z, um(10.5), STACK.pillar[0], STACK.pillar[1], 0, 0, { ...emit, entry: down ? 'max' : 'min', arc: 0 });
    builder.cyl('solder', x, z, um(11), STACK.solder[0], STACK.solder[1], 0, 0, { ...emit, glow: 0 });
  }));

  // Tile power rings (VDD), fed from the mesh straps that cross their sides.
  for (const tile of TILES) {
    const r = tile.rect;
    const w = um(36);
    const emit: Emit = { part: 'tile-ring', flow: FLOW.vdd, glow: POWER_GLOW, phase: rand(215, tile.index) };
    builder.seg('gold', r.x0, r.x1, STACK.ring[0], STACK.ring[1], r.z0, r.z0 + w, emit);
    builder.seg('gold', r.x0, r.x1, STACK.ring[0], STACK.ring[1], r.z1 - w, r.z1, emit);
    builder.seg('gold', r.x0, r.x0 + w, STACK.ring[0], STACK.ring[1], r.z0 + w, r.z1 - w, emit);
    builder.seg('gold', r.x1 - w, r.x1, STACK.ring[0], STACK.ring[1], r.z0 + w, r.z1 - w, emit);
    zs.forEach((z, j) => {
      if (strapFlow(j) !== FLOW.vdd || z < r.z0 + w || z > r.z1 - w) return;
      for (const x of [r.x0 + w / 2, r.x1 - w / 2]) {
        if (inAnyPhy(x, z)) continue;
        builder.via('tungsten', x, z, um(12), um(10), STACK.vz0[0], STACK.vz0[1], { part: 'ring-stack', flow: FLOW.vdd, glow: POWER_GLOW, phase: rand(216, tile.index, j), entry: 'max', arc: 0 });
      }
    });
  }

  // Network-on-chip: horizontal links on one layer, vertical links on the
  // next, joined by junction vias wherever the network branches: between
  // lanes, at every tile router, and at every PHY bundle.
  const lane = (horizontal: boolean, across: number, from: number, to: number, lines: number, width: number, pitch: number, salt: number, y: Band, part: PartId = 'noc-lane') => {
    for (let line = 0; line < lines; line += 1) {
      const offset = (line - (lines - 1) / 2) * pitch;
      const emit: Emit = { part, glow: line % 2 === 0 ? 0.6 : -0.6, phase: rand(salt, line, Math.round(across * 1000)) };
      if (horizontal) builder.seg('copper', from, to, y[0], y[1], across + offset - width / 2, across + offset + width / 2, emit);
      else builder.seg('copper', across + offset - width / 2, across + offset + width / 2, y[0], y[1], from, to, emit);
    }
  };
  const junction = (x: number, z: number) => builder.via('tungsten', x, z, um(5), um(5), STACK.vnj[0], STACK.vnj[1], { part: 'noc-junction' });
  const { span, lane: noc } = NOC;
  const lineOffset = (line: number, lines: number, pitch: number) => (line - (lines - 1) / 2) * pitch;
  for (const x of NOC.vertical) lane(false, x, span.z0, span.z1, noc.lines, noc.width, noc.pitch, 301, STACK.nocV);
  for (const z of NOC.horizontal) lane(true, z, span.x0, span.x1, noc.lines, noc.width, noc.pitch, 302, STACK.nocH);
  for (const x of NOC.vertical) for (const z of NOC.horizontal) {
    for (let line = 0; line < noc.lines; line += 1) junction(x + lineOffset(line, noc.lines, noc.pitch), z + lineOffset(line, noc.lines, noc.pitch));
  }
  // SRAM strip spine over the TSV column, joined to each lane that crosses the strip.
  lane(false, 0, SRAM_STRIP.rect.z0, SRAM_STRIP.rect.z1, 6, um(10), um(24), 303, STACK.ring, 'sram-spine');
  for (const z of NOC.horizontal) {
    if (z < SRAM_STRIP.rect.z0 || z > SRAM_STRIP.rect.z1) continue;
    for (let line = 0; line < noc.lines; line += 1) builder.via('tungsten', lineOffset(line + 1, 6, um(24)), z + lineOffset(line, noc.lines, noc.pitch), um(4), um(4), STACK.nocH[1], STACK.ring[0], { part: 'spine-drop' });
  }
  // Tile routers onto the nearest horizontal lane.
  for (const tile of TILES) {
    const route = NOC.routerLane(tile);
    lane(false, route.x, route.from, route.to, 4, um(10), um(24), 304 + tile.index, STACK.nocV);
    for (let line = 0; line < 4; line += 1) junction(route.x + lineOffset(line, 4, um(24)), route.lane + lineOffset(line, noc.lines, noc.pitch));
  }
  // Memory PHYs: three lane bundles from the driver strip to the network's edge lanes.
  for (const phy of PHYS) {
    for (const bundle of NOC.phyBundles(phy)) {
      lane(bundle.horizontal, bundle.across, bundle.from, bundle.to, bundle.lines, bundle.width, bundle.pitch, 401 + phy.index, bundle.horizontal ? STACK.nocH : STACK.nocV);
      for (let line = 0; line < bundle.lines; line += 1) {
        const own = bundle.across + lineOffset(line, bundle.lines, bundle.pitch);
        const other = bundle.lane + lineOffset(line % noc.lines, noc.lines, noc.pitch);
        if (bundle.horizontal) junction(other, own);
        else junction(own, other);
      }
    }
  }

  // LC-PLL and SerDes inductors: square spirals on the top metal.
  for (const block of EDGE_BLOCKS) for (const inductor of block.inductors) {
    squareSpiral(builder, inductor.cx, inductor.cz, inductor.size, 4, um(18), um(12), STACK.mz2);
    const guard = inductor.size * 0.6;
    const w = um(10);
    builder.box('copper', inductor.cx - guard, inductor.cx + guard, STACK.my1[0], STACK.my1[1], inductor.cz - guard, inductor.cz - guard + w);
    builder.box('copper', inductor.cx - guard, inductor.cx + guard, STACK.my1[0], STACK.my1[1], inductor.cz + guard - w, inductor.cz + guard);
    builder.box('copper', inductor.cx - guard, inductor.cx - guard + w, STACK.my1[0], STACK.my1[1], inductor.cz - guard, inductor.cz + guard);
    builder.box('copper', inductor.cx + guard - w, inductor.cx + guard, STACK.my1[0], STACK.my1[1], inductor.cz - guard, inductor.cz + guard);
  }

  return builder.finish(0, 0, 0);
}

// ---------------------------------------------------------------------------
// Level 1: semi-global metal, systolic buses, TSVs, microbumps
// ---------------------------------------------------------------------------

const STRAP_ALLOWED = (leaf: Leaf) => leaf === 'logic' || leaf === 'channel' || leaf === 'sram' || leaf === 'sram-periph' || leaf === 'decap';

/** Routing channels between tiles (not the gaps inside a tile). */
export const CHANNEL_RECTS: Array<{ rect: Rect; horizontal: boolean }> = (() => {
  const a = TILE_ARRAY_RECT;
  const xs = distinct(TILES.map((tile) => tile.rect.x0));
  const xe = distinct(TILES.map((tile) => tile.rect.x1));
  const zs = distinct(TILES.map((tile) => tile.rect.z0));
  const ze = distinct(TILES.map((tile) => tile.rect.z1));
  const channels: Array<{ rect: Rect; horizontal: boolean }> = [];
  for (let k = 0; k < xs.length - 1; k += 1) {
    const x0 = xe[k];
    const x1 = xs[k + 1];
    if (x1 - x0 > 1) {
      channels.push({ rect: rect(x0, a.z0, SRAM_STRIP.rect.x0, a.z1), horizontal: false });
      channels.push({ rect: rect(SRAM_STRIP.rect.x1, a.z0, x1, a.z1), horizontal: false });
    } else channels.push({ rect: rect(x0, a.z0, x1, a.z1), horizontal: false });
  }
  for (let k = 0; k < zs.length - 1; k += 1) channels.push({ rect: rect(a.x0, ze[k], a.x1, zs[k + 1]), horizontal: true });
  return channels;
})();
const ALL_MACROS: SramMacro[] = [...SRAM_STRIP.macros, ...TILES.flatMap((tile) => tile.sram), ...EDGE_BLOCKS.flatMap((block) => block.sram)];

// Data paths of a compute tile. Weights leave the tile SRAM macros into the
// top of each PE column, activations leave the router up a trunk on the
// left and into each PE row, operands pass PE to PE on the systolic buses,
// and partial sums drain from the bottom row into the vector unit (or, under
// the router's columns, the router), which returns results to the router.
// Every bus line ends in a via stack dropping into the logic it connects:
// the stacks stand between the Mx4 power straps (mid-gap x) and land on an
// Mx3 track.
// Bus lines sit on grids that keep their drops in the gaps of every layer
// below: horizontal lines and vertical drops at multiples of 3 µm (between
// the Mx1 and Mx3 tracks), vertical lines at odd micrometres beside the
// middle of an Mx4 gap (between the Mx2 tracks and clear of the straps).
const SYS = { lines: 6, hSpacing: um(3), vSpacing: um(2), half: um(0.8), overlap: um(30), reach: um(16) } as const;
const mx4Gap = (x: number) => Math.round(x / MX4.pitch) * MX4.pitch;
const busZ = (z: number) => Math.round(z / um(3)) * um(3);
const bundleCenterZ = (z: number) => Math.round((z - um(1.5)) / um(3)) * um(3) + um(1.5);
const lineOffset = (line: number, lines: number, spacing: number) => (line - (lines - 1) / 2) * spacing;
const peCenter = (tile: Tile, i: number, j: number) => rectCenter(peRect(tile, i, j));
/** Systolic wavefront phase of PE (i, j): anti-diagonals pulse together. */
const wave = (tile: Tile, i: number, j: number) => ((((i + j) * 0.055 + tile.index * 0.137) % 1) + 1) % 1;

type Bus = { part: PartId; axis: 'x' | 'z'; across: number[]; from: number; to: number; dir: 1 | -1; phase: number; drops: Array<{ at: number; up: boolean }> };

/** The buses of one tile, as bundles of lines along x or z with drops at given positions. */
function tileBuses(tile: Tile): Bus[] {
  const buses: Bus[] = [];
  const horizontalLines = (cz: number) => Array.from({ length: SYS.lines }, (_, line) => bundleCenterZ(cz) + lineOffset(line, SYS.lines, SYS.hSpacing));
  const verticalLines = (cx: number) => Array.from({ length: SYS.lines }, (_, line) => mx4Gap(cx) + lineOffset(line, SYS.lines, SYS.vSpacing));
  for (let i = 0; i < PE_COLUMNS; i += 1) for (let j = 0; j < PE_ROWS; j += 1) {
    const pe = peRect(tile, i, j);
    const [cx, cz] = rectCenter(pe);
    const phase = wave(tile, i, j);
    if (i + 1 < PE_COLUMNS) buses.push({ part: 'systolic-bus', axis: 'x', across: horizontalLines(cz), from: pe.x1 - SYS.overlap, to: pe.x1 + PE_GAP + SYS.overlap, dir: 1, phase, drops: [{ at: mx4Gap(pe.x1 - SYS.reach), up: true }, { at: mx4Gap(pe.x1 + PE_GAP + SYS.reach), up: false }] });
    if (j + 1 < PE_ROWS) buses.push({ part: 'systolic-bus', axis: 'z', across: verticalLines(cx), from: pe.z1 - SYS.overlap, to: pe.z1 + PE_GAP + SYS.overlap, dir: 1, phase, drops: [{ at: busZ(pe.z1 - SYS.reach), up: true }, { at: busZ(pe.z1 + PE_GAP + SYS.reach), up: false }] });
  }
  // Weights: each SRAM macro feeds the four PE columns under it.
  for (let i = 0; i < PE_COLUMNS; i += 1) {
    const macro = tile.sram[Math.min(tile.sram.length - 1, Math.floor((i * tile.sram.length) / PE_COLUMNS))];
    const pe = peRect(tile, i, 0);
    const [cx] = rectCenter(pe);
    buses.push({ part: 'weight-bus', axis: 'z', across: verticalLines(cx), from: macro.rect.z1 - um(20), to: pe.z0 + SYS.overlap, dir: 1, phase: wave(tile, i, -1), drops: [{ at: busZ(macro.rect.z1 - um(12)), up: true }, { at: busZ(pe.z0 + SYS.reach), up: false }] });
  }
  // Activations: a trunk up the left corridor from the router, tapped by a branch into each PE row.
  const trunkX = tile.rect.x0 + TILE_RING + (tile.peArray.x0 - tile.rect.x0 - TILE_RING) / 2;
  const [, topZ] = peCenter(tile, 0, 0);
  buses.push({ part: 'activation-bus', axis: 'z', across: verticalLines(trunkX), from: topZ - SYS.hSpacing * 3, to: tile.router.z0 + um(20), dir: -1, phase: wave(tile, -1, -1), drops: [{ at: busZ(tile.router.z0 + um(12)), up: true }] });
  for (let j = 0; j < PE_ROWS; j += 1) {
    const pe = peRect(tile, 0, j);
    const [, cz] = rectCenter(pe);
    buses.push({ part: 'activation-bus', axis: 'x', across: horizontalLines(cz), from: mx4Gap(trunkX) - SYS.vSpacing * 3, to: pe.x0 + SYS.overlap, dir: 1, phase: wave(tile, -1, j), drops: [{ at: mx4Gap(pe.x0 + SYS.reach), up: false }] });
  }
  // Partial sums: down out of the bottom row into the vector unit or the router.
  for (let i = 0; i < PE_COLUMNS; i += 1) {
    const pe = peRect(tile, i, PE_ROWS - 1);
    const [cx] = rectCenter(pe);
    const into = mx4Gap(cx) >= tile.vector.x0 + um(8) ? tile.vector : tile.router;
    buses.push({ part: 'result-bus', axis: 'z', across: verticalLines(cx), from: pe.z1 - SYS.overlap, to: into.z0 + um(24), dir: 1, phase: wave(tile, i, PE_ROWS), drops: [{ at: busZ(pe.z1 - SYS.reach), up: true }, { at: busZ(into.z0 + um(16)), up: false }] });
  }
  // Results back from the vector unit to the router.
  const vz = (tile.vector.z0 + tile.vector.z1) / 2;
  buses.push({ part: 'result-bus', axis: 'x', across: horizontalLines(vz), from: tile.router.x1 - um(30), to: tile.vector.x0 + um(30), dir: -1, phase: wave(tile, PE_COLUMNS, PE_ROWS), drops: [{ at: mx4Gap(tile.vector.x0 + um(18)), up: true }, { at: mx4Gap(tile.router.x1 - um(18)), up: false }] });
  return buses;
}

/** Taps where the activation branches meet the trunk lines (line k to line k). */
function activationTaps(tile: Tile): Array<{ x: number; z: number }> {
  const taps: Array<{ x: number; z: number }> = [];
  const trunkX = mx4Gap(tile.rect.x0 + TILE_RING + (tile.peArray.x0 - tile.rect.x0 - TILE_RING) / 2);
  for (let j = 0; j < PE_ROWS; j += 1) {
    const [, cz] = peCenter(tile, 0, j);
    for (let line = 0; line < SYS.lines; line += 1) taps.push({ x: trunkX + lineOffset(line, SYS.lines, SYS.vSpacing), z: bundleCenterZ(cz) + lineOffset(line, SYS.lines, SYS.hSpacing) });
  }
  return taps;
}

const BUSES = new Map<number, Bus[]>();
const busesOf = (tile: Tile) => {
  let buses = BUSES.get(tile.index);
  if (!buses) BUSES.set(tile.index, (buses = tileBuses(tile)));
  return buses;
};

/** Where each bus line's drop lands on the cells: the thin via stack under it. */
function busDrops(bus: Bus): RouteEnd[] {
  const ends: RouteEnd[] = [];
  const top = STACK.mx1[0];
  bus.across.forEach((across, line) => {
    for (const drop of bus.drops) {
      const [x, z] = bus.axis === 'x' ? [drop.at, across] : [across, drop.at];
      ends.push({ x: m3Near(2, x), z, top, up: drop.up, active: true, phase: bus.phase + line * 0.004, drop: true });
    }
  });
  return ends;
}

// Bus drops of each tile, bucketed by cell row: level 3 asks per row block.
const BUS_DROPS = new Map<number, Map<number, RouteEnd[]>>();
function busDropsByRow(tile: Tile) {
  let rows = BUS_DROPS.get(tile.index);
  if (rows) return rows;
  rows = new Map();
  for (const bus of busesOf(tile)) {
    for (const end of busDrops(bus)) {
      const row = Math.floor(end.z / ROW);
      const list = rows.get(row);
      if (list) list.push(end);
      else rows.set(row, [end]);
    }
  }
  BUS_DROPS.set(tile.index, rows);
  return rows;
}

/** Bus drops of every tile landing inside `rect`. */
function busEndsIn(rect: Rect): RouteEnd[] {
  const ends: RouteEnd[] = [];
  for (const tile of TILES) {
    if (!rectsOverlap(rect, tile.rect)) continue;
    const rows = busDropsByRow(tile);
    for (let row = Math.floor(rect.z0 / ROW); row <= Math.floor(rect.z1 / ROW); row += 1) {
      for (const end of rows.get(row) ?? []) if (insideRect(rect, end.x, end.z)) ends.push(end);
    }
  }
  return ends;
}

const BUS_ZONES = new Map<number, Rect[]>();
/** Plan-view areas the buses and their drops occupy in a tile (for keeping power stacks clear). */
function busZones(tile: Tile): Rect[] {
  let zones = BUS_ZONES.get(tile.index);
  if (zones) return zones;
  zones = busesOf(tile).map((bus) => {
    const lo = Math.min(...bus.across) - SYS.half;
    const hi = Math.max(...bus.across) + SYS.half;
    const a = Math.min(bus.from, bus.to);
    const b = Math.max(bus.from, bus.to);
    return bus.axis === 'x' ? rect(a, lo, b, hi) : rect(lo, a, hi, b);
  });
  BUS_ZONES.set(tile.index, zones);
  return zones;
}

/** Whether a point is clear of every systolic and feed bus (by `margin`). */
function systolicClear(x: number, z: number, margin: number) {
  const tile = tileAt(x, z);
  if (!tile) return true;
  return busZones(tile).every((zone) => x < zone.x0 - margin || x > zone.x1 + margin || z < zone.z0 - margin || z > zone.z1 + margin);
}

/** TSV risers stay clear of the NoC lanes and channel buses that cross the SRAM strip. */
const tsvRiserClear = (z: number) => NOC.horizontal.every((lane) => Math.abs(z - lane) > um(90)) && CHANNEL_RECTS.every((c) => !c.horizontal || z < c.rect.z0 - um(20) || z > c.rect.z1 + um(20));

function emitBus(builder: ChunkBuilder, bus: Bus) {
  const stretch = LEVELS[1].viaStretch;
  const onSysH = bus.axis === 'x';
  const y = onSysH ? STACK.sysH : STACK.sysV;
  const glow = bus.dir;
  bus.across.forEach((across, line) => {
    const phase = bus.phase + line * 0.004;
    if (onSysH) builder.seg('copper', Math.min(bus.from, bus.to), Math.max(bus.from, bus.to), y[0], y[1], across - SYS.half, across + SYS.half, { part: bus.part, glow, phase, axis: 'x' });
    else builder.seg('copper', across - SYS.half, across + SYS.half, y[0], y[1], Math.min(bus.from, bus.to), Math.max(bus.from, bus.to), { part: bus.part, glow, phase, axis: 'z' });
    for (const drop of bus.drops) {
      // The line's own pulse coordinate at the drop, so the pulse runs on into it.
      const at = glow * drop.at * 1000;
      const x = onSysH ? drop.at : across;
      const z = onSysH ? across : drop.at;
      // A wide stack through the gaps of Mx4-Mx1, then a thin V3 stack onto
      // an M3 pad, where level 3 wires it to a pin of the PE's cells.
      const wide = (y[0] - STACK.mx1[0]) * 1000 * stretch;
      const thin = (STACK.v3[1] - STACK.v3[0]) * 1000 * LEVELS[1].viaStretch;
      const xs = m3Near(2, x);
      if (drop.up) {
        builder.via('tungsten', xs, z, DROP_HALF, DROP_HALF, STACK.v3[0], STACK.v3[1], { part: 'v3', glow: 1, phase, entry: 'min', arc: at - wide - thin });
        builder.via('tungsten', x, z, um(0.2), um(0.2), STACK.mx1[0], y[0], { part: 'pe-pins', glow: 1, phase, entry: 'min', arc: at - wide });
      } else {
        builder.via('tungsten', x, z, um(0.2), um(0.2), STACK.mx1[0], y[0], { part: 'pe-pins', glow: 1, phase, entry: 'max', arc: at });
        builder.via('tungsten', xs, z, DROP_HALF, DROP_HALF, STACK.v3[0], STACK.v3[1], { part: 'v3', glow: 1, phase, entry: 'max', arc: at + wide });
      }
    }
  });
}

function level1(builder: ChunkBuilder) {
  const b = builder.bounds;
  const leaves = new LeafCache(um(10));
  const stretch = LEVELS[1].viaStretch;

  // Semi-global power grid: My1 along x, My2 along z, alternating VDD and
  // VSS, with vias only where straps of the same supply cross.
  emitStraps(builder, leaves, { horizontal: true, pitch: MY.pitch, offset: MY.offset, width: um(5), y: STACK.my1, material: 'copper', sample: um(20), allowed: STRAP_ALLOWED, part: 'semi-global-strap', flowOf: strapFlow });
  emitStraps(builder, leaves, { horizontal: false, pitch: MY.pitch, offset: MY.offset, width: um(5), y: STACK.my2, material: 'copper', sample: um(20), allowed: STRAP_ALLOWED, part: 'semi-global-strap', flowOf: strapFlow });
  for (let k = Math.ceil((b.x0 - MY.offset) / MY.pitch); MY.offset + k * MY.pitch < b.x1; k += 1) {
    for (let m = Math.ceil((b.z0 - MY.offset) / MY.pitch); MY.offset + m * MY.pitch < b.z1; m += 1) {
      const x = MY.offset + k * MY.pitch;
      const z = MY.offset + m * MY.pitch;
      const flow = strapFlow(k);
      if (flow !== strapFlow(m) || !STRAP_ALLOWED(leaves.at(x, z))) continue;
      builder.via('tungsten', x, z, um(2.5), um(2.5), STACK.vy1[0], STACK.vy1[1], { part: 'strap-via', flow, glow: POWER_GLOW, phase: rand(1601, k, m), entry: flow === FLOW.vdd ? 'max' : 'min', arc: 0 });
    }
  }

  // Tiles: data paths, router drops into the crossbar, and power feeds.
  for (const tile of TILES) {
    const near = rect(tile.rect.x0 - 0.05, tile.rect.z0 - 0.05, tile.rect.x1 + 0.05, tile.rect.z1 + 0.05);
    if (!rectsOverlap(near, b)) continue;
    for (const bus of busesOf(tile)) {
      const lo = Math.min(...bus.across) - SYS.half;
      const hi = Math.max(...bus.across) + SYS.half;
      const zone = bus.axis === 'x' ? rect(Math.min(bus.from, bus.to), lo, Math.max(bus.from, bus.to), hi) : rect(lo, Math.min(bus.from, bus.to), hi, Math.max(bus.from, bus.to));
      if (rectsOverlap(zone, b)) emitBus(builder, bus);
    }
    for (const tap of activationTaps(tile)) if (insideRect(b, tap.x, tap.z)) builder.via('tungsten', tap.x, tap.z, um(0.7), um(0.7), STACK.sysH[1], STACK.sysV[0], { part: 'activation-bus' });

    // NoC drops: each router lane line comes down onto a crossbar wire.
    const route = NOC.routerLane(tile);
    const r = tile.router;
    for (let line = 0; line < 4; line += 1) {
      const lx = route.x + lineOffset(line, 4, um(24));
      const x = r.x0 + um(8) + Math.round((lx - r.x0 - um(8)) / um(6)) * um(6);
      builder.via('tungsten', x, route.start - um(0.01), um(1.2), um(3), STACK.my2[1], STACK.nocV[0], { part: 'noc-drop', glow: line % 2 === 0 ? 0.6 : -0.6, phase: rand(1611, tile.index, line), entry: line % 2 === 0 ? 'max' : 'min', arc: 0 });
    }

    // Power: VDD straps under the tile ring's top and bottom sides rise into
    // it, and straps of either supply reach the mesh straps above directly.
    const w = um(36);
    const clearOfRouter = (x: number) => Math.abs(x - route.x) > um(80);
    for (let k = Math.ceil((tile.rect.x0 + w - MY.offset) / MY.pitch); MY.offset + k * MY.pitch < tile.rect.x1 - w; k += 1) {
      const x = MY.offset + k * MY.pitch;
      if (!clearOfRouter(x)) continue;
      if (strapFlow(k) === FLOW.vdd) {
        for (const z of [tile.rect.z0 + w / 2, tile.rect.z1 - w / 2]) {
          if (STRAP_ALLOWED(leaves.at(x, z))) builder.via('tungsten', x, z, um(2), um(8), STACK.my2[1], STACK.ring[0], { part: 'strap-stack', flow: FLOW.vdd, glow: POWER_GLOW, phase: rand(1612, k, Math.round(z * 1e3)), entry: 'max', arc: 0 });
        }
      }
      GLOBAL_MESH.zs.forEach((z, j) => {
        const flow = strapFlow(j);
        if (flow !== strapFlow(k) || z < tile.rect.z0 + um(90) || z > tile.rect.z1 - um(90) || inAnyPhy(x, z)) return;
        if (!STRAP_ALLOWED(leaves.at(x, z)) || leaves.at(x, z) === 'channel') return;
        builder.via('tungsten', x, z, um(2), um(2), STACK.my2[1], STACK.mz1[0], { part: 'mesh-stack', flow, glow: POWER_GLOW, phase: rand(1613, k, j), entry: flow === FLOW.vdd ? 'max' : 'min', arc: -(STACK.mz1[0] - STACK.my2[1]) * 1000 * stretch * 0.5 });
      });
    }
  }

  // SRAM macros: power ring, bit-line straps, word-line straps.
  for (const macro of ALL_MACROS) {
    if (!rectsOverlap(macro.rect, b)) continue;
    const r = macro.rect;
    const w = um(8);
    builder.box('copper', r.x0, r.x1, STACK.my1[0], STACK.my1[1], r.z0, r.z0 + w);
    builder.box('copper', r.x0, r.x1, STACK.my1[0], STACK.my1[1], r.z1 - w, r.z1);
    builder.box('copper', r.x0, r.x0 + w, STACK.my2[0], STACK.my2[1], r.z0, r.z1);
    builder.box('copper', r.x1 - w, r.x1, STACK.my2[0], STACK.my2[1], r.z0, r.z1);
    const arr = macro.array;
    for (let x = arr.x0 + um(12); x < arr.x1 - um(6); x += um(16)) builder.box('copper', x - um(1), x + um(1), STACK.my2[0], STACK.my2[1], arr.z0 + w, arr.z1 - um(4));
  }

  // TSV column in the shared SRAM strip: copper core, oxide liner, landing
  // pad, and the via stack up to the semi-global straps. The outer columns
  // rise on into the SRAM spine, carrying the stacked die's data to the L2.
  const band = SRAM_STRIP.tsvBand;
  if (rectsOverlap(band, b)) {
    for (let column = -2; column <= 2; column += 1) {
      const x = column * um(30);
      const n0 = Math.max(0, Math.floor((b.z0 - band.z0 - um(20)) / um(30)));
      for (let n = n0; band.z0 + um(20) + n * um(30) < Math.min(b.z1, band.z1 - um(10)); n += 1) {
        const z = band.z0 + um(20) + n * um(30) + (column % 2 === 0 ? 0 : um(15));
        if (z >= band.z1 - um(10)) continue;
        builder.cyl('copper', x, z, um(2.5), STACK.tsv[0], STACK.tsv[1]);
        builder.cyl('oxide', x, z, um(3.1), STACK.tsv[0], um(0.02));
        if (!insideRect(b, x, z)) continue;
        // Plug through the local levels, landing pad, then the via stack. Each
        // piece stays inside one gap of the stack so delayering never slices it.
        builder.box('copper', x - um(2.2), x + um(2.2), STACK.m0[0], STACK.v2[1], z - um(2.2), z + um(2.2));
        builder.box('copper', x - um(4), x + um(4), STACK.m3[0], STACK.m3[1], z - um(4), z + um(4));
        builder.box('tungsten', x - um(1.4), x + um(1.4), STACK.m3[1] + um(0.012), STACK.my1[0], z - um(1.4), z + um(1.4));
        builder.box('copper', x - um(4.5), x + um(4.5), STACK.my1[0], STACK.my1[1], z - um(4.5), z + um(4.5));
        if (Math.abs(column) === 2 && n % 3 === 0 && tsvRiserClear(z)) {
          const active = rand(1621, column, n) < 0.35;
          builder.via('tungsten', x, z, um(2), um(2), STACK.my1[1], STACK.ring[0], { part: 'tsv-riser', glow: active ? 1 : 0, phase: rand(1622, column, n), entry: 'min', arc: 0 });
        }
      }
    }
  }

  // PHY microbump fields: every bump's via stack drops to the driver or
  // receiver directly beneath it (every third bump carries power), and the
  // NoC bundle lines drop into the lanes of the driver strip.
  for (const phy of PHYS) {
    if (rectsOverlap(phy.bumps, b)) {
      const pitch = um(45);
      const f = phy.bumps;
      const r0 = Math.max(0, Math.floor((b.z0 - f.z0) / pitch) - 1);
      const r1 = Math.floor((Math.min(b.z1, f.z1) - f.z0) / pitch) + 1;
      for (let row = r0; row <= r1; row += 1) {
        const z = f.z0 + um(24) + row * pitch;
        if (z >= f.z1 - um(20)) continue;
        const stagger = row % 2 === 0 ? 0 : pitch / 2;
        const c0 = Math.max(0, Math.floor((b.x0 - f.x0 - stagger) / pitch) - 1);
        for (let col = c0; ; col += 1) {
          const x = f.x0 + um(24) + stagger + col * pitch;
          if (x >= Math.min(b.x1, f.x1 - um(20))) break;
          if (!insideRect(b, x, z)) continue;
          const power = (row + col) % 3 === 0;
          const flow: Flow = power ? (row % 2 === 0 ? FLOW.vdd : FLOW.vss) : FLOW.data;
          const glow = power ? POWER_GLOW : rand(1631, phy.index, row, col) < 0.08 ? 1 : 0;
          const emit: Emit = { flow, glow, phase: rand(1632, phy.index, row, col) };
          builder.seg('gold', x - um(14), x + um(14), STACK.ubm[0], STACK.ubm[1], z - um(14), z + um(14), { ...emit, part: 'ubm', glow: 0 });
          builder.cyl('copper', x, z, um(10.5), STACK.pillar[0], STACK.pillar[1], 0, 0, { ...emit, part: 'pillar', entry: flow === FLOW.vss ? 'min' : 'max', arc: 0 });
          builder.cyl('solder', x, z, um(11), STACK.solder[0], STACK.solder[1], 0, 0, { part: 'solder-cap' });
          builder.via('copper', x, z, um(3), um(3), STACK.my2[1], STACK.ubm[0], { ...emit, part: 'bump-stack', entry: flow === FLOW.vss ? 'min' : 'max', arc: 0 });
          builder.seg('copper', x - um(6), x + um(6), STACK.my2[0], STACK.my2[1], z - um(6), z + um(6), { ...emit, part: 'io-pad', glow: 0 });
        }
      }
    }
    if (rectsOverlap(phy.drivers, b)) {
      const horizontal = phy.side === 'west' || phy.side === 'east';
      const d = phy.drivers;
      const lanePitch = um(18);
      if (horizontal) {
        for (let z = Math.ceil((Math.max(b.z0, d.z0) - d.z0) / lanePitch) * lanePitch + d.z0 + um(9); z < Math.min(b.z1, d.z1); z += lanePitch) {
          const k = Math.round((z - d.z0) / lanePitch);
          builder.seg('copper', d.x0, d.x1, STACK.my1[0], STACK.my1[1], z - um(1.25), z + um(1.25), { part: 'phy-lane', glow: k % 3 === 0 ? (phy.side === 'west' ? 1 : -1) : 0, phase: rand(501, phy.index, k) });
        }
      } else {
        for (let x = Math.ceil((Math.max(b.x0, d.x0) - d.x0) / lanePitch) * lanePitch + d.x0 + um(9); x < Math.min(b.x1, d.x1); x += lanePitch) {
          const k = Math.round((x - d.x0) / lanePitch);
          builder.seg('copper', x - um(1.25), x + um(1.25), STACK.my2[0], STACK.my2[1], d.z0, d.z1, { part: 'phy-lane', glow: k % 3 === 0 ? (phy.side === 'north' ? 1 : -1) : 0, phase: rand(502, phy.index, k) });
        }
      }
      for (const bundle of NOC.phyBundles(phy)) {
        for (let line = 0; line < bundle.lines; line += 1) {
          const across = bundle.across + lineOffset(line, bundle.lines, bundle.pitch);
          const along = horizontal ? (d.x0 + d.x1) / 2 : (d.z0 + d.z1) / 2;
          // The nearest driver lane, reached by a short stub on the lane layer.
          const laneAt = (horizontal ? d.z0 : d.x0) + um(9) + Math.round((across - (horizontal ? d.z0 : d.x0) - um(9)) / lanePitch) * lanePitch;
          const [x, z] = horizontal ? [along, across] : [across, along];
          const laneY = horizontal ? STACK.my1 : STACK.my2;
          const emit: Emit = { part: 'lane-drop', glow: line % 2 === 0 ? 0.6 : -0.6, phase: rand(1641, phy.index, line) };
          builder.via('tungsten', x, z, um(2), um(2), laneY[1], horizontal ? STACK.nocH[0] : STACK.nocV[0], { ...emit, entry: line % 2 === 0 ? 'max' : 'min', arc: 0 });
          if (horizontal) builder.seg('copper', x - um(2.5), x + um(2.5), laneY[0], laneY[1], Math.min(z, laneAt) - um(2.5), Math.max(z, laneAt) + um(2.5), { ...emit, axis: 'z' });
          else builder.seg('copper', Math.min(x, laneAt) - um(2.5), Math.max(x, laneAt) + um(2.5), laneY[0], laneY[1], z - um(2.5), z + um(2.5), { ...emit, axis: 'x' });
        }
      }
    }
  }

  // Routing channels between tiles: long parallel buses.
  for (const channel of CHANNEL_RECTS) {
    if (!rectsOverlap(channel.rect, b)) continue;
    const c = channel.rect;
    const pitch = um(7);
    if (channel.horizontal) {
      for (let k = Math.ceil((Math.max(b.z0, c.z0 + um(20)) - c.z0) / pitch); c.z0 + k * pitch < Math.min(b.z1, c.z1 - um(20)); k += 1) {
        const z = c.z0 + k * pitch;
        const seed = hash(601, k, Math.round(c.z0 * 1e4));
        builder.box('copper', c.x0, c.x1, STACK.chanH[0], STACK.chanH[1], z - um(0.7), z + um(0.7), rand(seed) < 0.1 ? (k % 2 ? 1 : -1) : 0, rand(seed, 1), seed);
      }
    } else {
      for (let k = Math.ceil((Math.max(b.x0, c.x0 + um(20)) - c.x0) / pitch); c.x0 + k * pitch < Math.min(b.x1, c.x1 - um(20)); k += 1) {
        const x = c.x0 + k * pitch;
        const seed = hash(602, k, Math.round(c.x0 * 1e4));
        builder.box('copper', x - um(0.7), x + um(0.7), STACK.chanV[0], STACK.chanV[1], c.z0, c.z1, rand(seed) < 0.1 ? (k % 2 ? 1 : -1) : 0, rand(seed, 1), seed);
      }
    }
  }

  // I/O cells: ESD finger pairs and a guard ring per cell.
  const hx = DIE.width / 2;
  const hz = DIE.depth / 2;
  const cellPitch = um(60);
  const ioEdge = (horizontal: boolean, fixed0: number, fixed1: number) => {
    const along0 = horizontal ? b.x0 : b.z0;
    const along1 = horizontal ? b.x1 : b.z1;
    for (let k = Math.floor(along0 / cellPitch); k * cellPitch < along1; k += 1) {
      const center = (k + 0.5) * cellPitch;
      const lo = Math.min(fixed0, fixed1);
      const hi = Math.max(fixed0, fixed1);
      if (horizontal ? leafAt(center, (lo + hi) / 2) !== 'io' : leafAt((lo + hi) / 2, center) !== 'io') continue;
      for (let finger = 0; finger < 6; finger += 1) {
        const f = center - um(22) + finger * um(8.8);
        if (horizontal) builder.box('copper', f - um(1.4), f + um(1.4), STACK.my2[0], STACK.my2[1], lo + um(40), hi - um(60));
        else builder.box('copper', lo + um(40), hi - um(60), STACK.my2[0], STACK.my2[1], f - um(1.4), f + um(1.4));
      }
      if (horizontal) builder.box('copper', center - um(27), center + um(27), STACK.my1[0], STACK.my1[1], lo + um(30), lo + um(34));
      else builder.box('copper', lo + um(30), lo + um(34), STACK.my1[0], STACK.my1[1], center - um(27), center + um(27));
    }
  };
  if (b.z0 < -hz + DIE.ioBand) ioEdge(true, -hz + DIE.sealBand, -hz + DIE.ioBand);
  if (b.z1 > hz - DIE.ioBand) ioEdge(true, hz - DIE.ioBand, hz - DIE.sealBand);
  if (b.x0 < -hx + DIE.ioBand) ioEdge(false, -hx + DIE.sealBand, -hx + DIE.ioBand);
  if (b.x1 > hx - DIE.ioBand) ioEdge(false, hx - DIE.ioBand, hx - DIE.sealBand);

  // Tile routers: a crossbar of active wires.
  for (const tile of TILES) {
    const r = tile.router;
    if (!rectsOverlap(r, b)) continue;
    for (let z = r.z0 + um(8); z < r.z1 - um(4); z += um(6)) builder.box('copper', r.x0 + um(6), r.x1 - um(6), STACK.my1[0], STACK.my1[1], z - um(1.2), z + um(1.2), rand(611, tile.index, Math.round(z * 1e4)) < 0.35 ? 1 : 0, rand(612, Math.round(z * 1e4)));
    for (let x = r.x0 + um(8); x < r.x1 - um(4); x += um(6)) builder.box('copper', x - um(1.2), x + um(1.2), STACK.my2[0], STACK.my2[1], r.z0 + um(6), r.z1 - um(6), rand(613, tile.index, Math.round(x * 1e4)) < 0.35 ? -1 : 0, rand(614, Math.round(x * 1e4)));
  }
}

// ---------------------------------------------------------------------------
// Level 2: intermediate routing
// ---------------------------------------------------------------------------

const DENSITY: Partial<Record<Leaf, number>> = { logic: 0.5, router: 0.62, 'sram-periph': 0.4, channel: 0.3, analog: 0.18, 'phy-drivers': 0.34, 'phy-bumps': 0.24, io: 0.22 };
const mazeDensity = (scale: number) => (leaf: Leaf) => (DENSITY[leaf] ?? 0) * scale;

const L2_LAYERS: MazeLayer[] = [
  { salt: 1101, horizontal: true, pitch: um(1.0), width: um(0.42), y: STACK.mx1, cell: um(13), material: 'copper', occupancy: mazeDensity(0.86), glowChance: 0.06 },
  { salt: 1201, horizontal: false, pitch: um(1.0), width: um(0.42), y: STACK.mx2, cell: um(13), material: 'copper', occupancy: mazeDensity(0.82), glowChance: 0.06 },
  { salt: 1301, horizontal: true, pitch: um(1.5), width: um(0.62), y: STACK.mx3, cell: um(19), material: 'copper', occupancy: mazeDensity(0.7), glowChance: 0.07 },
];

// Every route on Mx1-Mx3 belongs to a net with one driver, and every end
// goes somewhere. An Mx2 or Mx3 route starts on a track centre of the layer
// below; if a route of that layer passes there, the two join through a via
// (Vx1 or Vx2) and this route is a branch of that net, flowing away from the
// junction. Every other end drops a V3 via stack to the cells, where level 3
// lands it on an M3 pad and wires it to a cell pin: the end the cells drive
// ("up") and the end that drives the cells. Drops from Mx2 and Mx3 ends pass
// the lower layers between their tracks, so they never touch another net.
const MX_PITCH = um(1);
const onTrack = (value: number, pitch: number) => (Math.round(value / pitch - 0.5) + 0.5) * pitch;
const onGap = (value: number, pitch: number) => Math.round(value / pitch) * pitch;
const DROP_HALF = um(0.025);

// Local M3 tracks come in four classes, x = (4m + class + 0.5) gate pitches:
// classes 0 and 1 carry nets between neighbouring rows (alternating by row
// pair), class 2 the drops from the intermediate layers, and class 3 the
// power ladders. No two uses ever share a track.
const m3Track = (cls: number, m: number) => (4 * m + cls + 0.5) * CPP;
const m3Near = (cls: number, x: number) => m3Track(cls, Math.round((x / CPP - cls - 0.5) / 4));
const m3From = (cls: number, x: number) => m3Track(cls, Math.ceil((x / CPP - cls - 0.5) / 4));
const m3To = (cls: number, x: number) => m3Track(cls, Math.floor((x / CPP - cls - 0.5) / 4));

type RouteRun = Run & { layer: 0 | 1 | 2; across: number; dir: 1 | -1; active: boolean; phase: number; joined: boolean };

/** One end of a route or bus line where a via stack meets the cells. `up`: a cell drives the net from here. */
export type RouteEnd = { x: number; z: number; top: number; up: boolean; active: boolean; phase: number; drop: boolean };

/** Where the lo end of an Mx2 (layer 1) or Mx3 (layer 2) route meets the layer below. */
const loDropAt = (run: { layer: number; across: number; lo: number }): [number, number] => (run.layer === 1 ? [m3Near(2, run.across), run.lo] : [m3Near(2, run.lo), run.across]);

function routeRuns(layerIndex: 0 | 1 | 2, bounds: Rect, leaves: LeafCache, joins = true): RouteRun[] {
  const layer = L2_LAYERS[layerIndex];
  const runs: RouteRun[] = [];
  for (const run of mazeRuns(layer, bounds, leaves)) {
    // Mx2/Mx3: the lo end on a track centre of the layer below, the hi end between its tracks.
    const lo = layerIndex === 0 ? run.lo : onTrack(run.lo, MX_PITCH);
    const hi = layerIndex === 0 ? run.hi : onGap(run.hi, MX_PITCH);
    if (hi - lo < MX_PITCH * 0.49) continue;
    const across = (run.track + 0.5) * layer.pitch;
    let joined = false;
    if (joins && layerIndex > 0) {
      const [x, z] = loDropAt({ layer: layerIndex, across, lo });
      joined = routeCovers(layerIndex === 1 ? 0 : 1, x, z, leaves);
    }
    runs.push({
      ...run, lo, hi, layer: layerIndex, across, joined,
      dir: joined || rand(layer.salt + 4, run.track, run.start) < 0.5 ? 1 : -1,
      active: rand(layer.salt + 3, run.track, run.start) < layer.glowChance,
      phase: rand(layer.salt + 5, run.track, run.start),
    });
  }
  return runs;
}

/** Whether a route of Mx1 (0) or Mx2 (1) is drawn at a point, or close enough that a via stack there would touch it. */
function routeCovers(layerIndex: 0 | 1, x: number, z: number, leaves: LeafCache): boolean {
  const e = um(0.02);
  const reach = layerIndex === 0 ? 0 : um(0.15);
  const margin = um(0.08);
  const along = layerIndex === 0 ? x : z;
  return routeRuns(layerIndex, { x0: x - e, x1: x + e, z0: z - e, z1: z + e }, leaves, false).some((run) => along >= run.lo - reach - margin && along <= run.hi + reach + margin);
}

function routeEnds(run: RouteRun): [RouteEnd, RouteEnd] {
  const common = { top: L2_LAYERS[run.layer].y[0], active: run.active, phase: run.phase };
  if (run.layer === 0) {
    const z = run.across;
    return [{ ...common, x: m3From(2, run.lo + um(0.03)), z, up: run.dir > 0, drop: true }, { ...common, x: m3To(2, run.hi - um(0.03)), z, up: run.dir < 0, drop: true }];
  }
  const [lx, lz] = loDropAt(run);
  const [hx, hz] = run.layer === 1 ? [m3Near(2, run.across), run.hi] : [m3Near(2, run.hi), run.across];
  return [{ ...common, x: lx, z: lz, up: run.dir > 0, drop: !run.joined }, { ...common, x: hx, z: hz, up: run.dir < 0, drop: true }];
}

/** Via stacks from routes and bus lines that land inside `rect`, in a fixed order. */
function routeEndsIn(rect: Rect, leaves: LeafCache): RouteEnd[] {
  const pad = um(0.7);
  const ends: RouteEnd[] = [];
  const queries: Array<[0 | 1 | 2, Rect]> = [
    [0, { x0: rect.x0 - pad, x1: rect.x1 + pad, z0: rect.z0, z1: rect.z1 }],
    [1, { x0: rect.x0 - pad, x1: rect.x1 + pad, z0: rect.z0 - pad, z1: rect.z1 + pad }],
    [2, { x0: rect.x0 - pad, x1: rect.x1 + pad, z0: rect.z0, z1: rect.z1 }],
  ];
  for (const [layer, bounds] of queries) for (const run of routeRuns(layer, bounds, leaves)) for (const end of routeEnds(run)) if (end.drop && insideRect(rect, end.x, end.z)) ends.push(end);
  ends.push(...busEndsIn(rect));
  return ends.sort((a, b) => a.x - b.x || a.z - b.z);
}

function emitRoute(builder: ChunkBuilder, run: RouteRun) {
  const layer = L2_LAYERS[run.layer];
  const half = layer.width / 2;
  // Mx2 and Mx3 ends overhang the track they land on, as a via landing does.
  const reach = run.layer === 0 ? 0 : um(0.15);
  const glow = run.active ? run.dir : 0;
  const part: PartId = run.layer === 0 ? 'mx1' : run.layer === 1 ? 'mx2' : 'mx3';
  if (layer.horizontal) builder.seg(layer.material, run.lo - reach, run.hi + reach, layer.y[0], layer.y[1], run.across - half, run.across + half, { glow, phase: run.phase, part });
  else builder.seg(layer.material, run.across - half, run.across + half, layer.y[0], layer.y[1], run.lo - reach, run.hi + reach, { glow, phase: run.phase, part });
  const stretch = LEVELS[2].viaStretch;
  for (const end of routeEnds(run)) {
    if (!end.drop) {
      // A branch: this route turns off the route below through one via.
      const y = run.layer === 1 ? STACK.vx1 : STACK.vx2;
      builder.via('tungsten', end.x, end.z, um(0.19), um(0.19), y[0], y[1], { part: run.layer === 1 ? 'vx1' : 'vx2', glow: glow === 0 ? 0 : 1, phase: run.phase, entry: 'min', arc: run.dir * (layer.horizontal ? end.x : end.z) * 1000 - (y[1] - y[0]) * 1000 * stretch });
      continue;
    }
    // The route's own pulse coordinate where the stack meets it, so the
    // pulse runs on unbroken into (or out of) the stack.
    const at = run.dir * (layer.horizontal ? end.x : end.z) * 1000;
    const height = (end.top - STACK.v3[0]) * 1000 * stretch;
    builder.via('tungsten', end.x, end.z, DROP_HALF, DROP_HALF, STACK.v3[0], end.top, {
      part: 'v3', glow: glow === 0 ? 0 : 1, phase: run.phase,
      ...(end.up ? { entry: 'min' as const, arc: at - height } : { entry: 'max' as const, arc: at }),
    });
  }
}

// Power: Mx4 straps alternate VDD and VSS. Via ladders carry each supply
// down to the M0 rails of the same supply, at spots chosen in the gaps
// between the Mx1-Mx3 tracks (every 6 µm near a rail, every other strap), and
// via stacks join the straps to the My1 straps above them.
const MX4 = { pitch: um(14), offset: um(7) } as const;
const LADDER_SPACING = um(6);
const MX4_ALLOWED = (leaf: Leaf) => leaf in DENSITY || leaf === 'decap' || leaf === 'sram';
const MY = { pitch: um(60), offset: um(30) } as const;
/** Straps of every power grid alternate VDD, VSS by index. */
const strapFlow = (index: number): Flow => (((index % 2) + 2) % 2 === 0 ? FLOW.vdd : FLOW.vss);
const supplyFlow = (row: number): Flow => (railSupply(row) === 'VDD' ? FLOW.vdd : FLOW.vss);
/** Region the way a generator with a leaf cache of `step` sees it. */
const leafAtStep = (x: number, z: number, step: number) => leafAt((Math.floor(x / step) + 0.5) * step, (Math.floor(z / step) + 0.5) * step);
export const POWER_GLOW = 0.32;

export type Ladder = { x: number; z: number; row: number; flow: Flow };

/** Power ladders whose foot (on an M0 rail) lies inside `rect`. */
export function laddersIn(rect: Rect): Ladder[] {
  const ladders: Ladder[] = [];
  const k0 = Math.ceil((rect.x0 - um(0.2) - MX4.offset) / MX4.pitch);
  const k1 = Math.floor((rect.x1 + um(0.2) - MX4.offset) / MX4.pitch);
  const n0 = Math.ceil((rect.z0 - um(0.2)) / LADDER_SPACING);
  const n1 = Math.floor((rect.z1 + um(0.2)) / LADDER_SPACING);
  for (let k = k0; k <= k1; k += 1) for (let n = n0; n <= n1; n += 1) {
    const row = Math.round((n * LADDER_SPACING) / ROW);
    const flow = supplyFlow(row);
    if (flow !== strapFlow(k)) continue;
    const strap = MX4.offset + k * MX4.pitch;
    const x = m3Near(3, strap);
    const z = row * ROW;
    if (!insideRect(rect, x, z)) continue;
    if (!ROW_LEAVES.includes(rowBlockLeaf(row, Math.floor(x / BLOCK))) || !MX4_ALLOWED(leafAtStep(strap, z, um(4)))) continue;
    ladders.push({ x, z, row, flow });
  }
  return ladders;
}

/** Stacks from Mx4 straps up to My1 straps of the same supply, clear of the systolic buses. */
function strapStacksIn(rect: Rect): Array<{ x: number; z: number; flow: Flow }> {
  const stacks: Array<{ x: number; z: number; flow: Flow }> = [];
  const k0 = Math.ceil((rect.x0 - MX4.offset) / MX4.pitch);
  const k1 = Math.floor((rect.x1 - MX4.offset) / MX4.pitch);
  const m0 = Math.ceil((rect.z0 - MY.offset) / MY.pitch);
  const m1 = Math.floor((rect.z1 - MY.offset) / MY.pitch);
  for (let k = k0; k <= k1; k += 1) for (let m = m0; m <= m1; m += 1) {
    const flow = strapFlow(k);
    if (flow !== strapFlow(m)) continue;
    const x = MX4.offset + k * MX4.pitch;
    const z = MY.offset + m * MY.pitch;
    // Both straps are drawn there (each generator samples regions its own way).
    if (!MX4_ALLOWED(leafAtStep(x, z, um(4)))) continue;
    const sample = um(20);
    if (!STRAP_ALLOWED(leafAtStep((Math.floor(x / sample) + 0.5) * sample, z, um(10)))) continue;
    if (!systolicClear(x, z, um(3))) continue;
    stacks.push({ x, z, flow });
  }
  return stacks;
}

function level2(builder: ChunkBuilder) {
  const b = builder.bounds;
  const leaves = new LeafCache(um(4));
  const runs = ([0, 1, 2] as const).map((layer) => routeRuns(layer, b, leaves));
  for (const list of runs) for (const run of list) emitRoute(builder, run);

  // Power straps on the top intermediate layer over all logic.
  emitStraps(builder, leaves, { horizontal: false, pitch: MX4.pitch, offset: MX4.offset, width: um(1.8), y: STACK.mx4, material: 'copper', sample: um(4), allowed: MX4_ALLOWED, part: 'mx4-strap', flowOf: strapFlow });
  const stretch = LEVELS[2].viaStretch;
  for (const ladder of laddersIn(b)) {
    // VDD flows down the ladder to the rail; VSS returns up it.
    builder.via('tungsten', ladder.x, ladder.z, um(0.05), um(0.05), STACK.v3[0], STACK.mx4[0], { part: 'power-ladder', flow: ladder.flow, glow: POWER_GLOW, phase: rand(1501, Math.round(ladder.x * 1e4), ladder.row), entry: ladder.flow === FLOW.vdd ? 'max' : 'min', arc: 0 });
  }
  for (const stack of strapStacksIn(b)) {
    builder.via('tungsten', stack.x, stack.z, um(0.6), um(0.6), STACK.mx4[1], STACK.my1[0], { part: 'vx4', flow: stack.flow, glow: POWER_GLOW, phase: rand(1502, Math.round(stack.x * 1e4), Math.round(stack.z * 1e4)), entry: stack.flow === FLOW.vdd ? 'max' : 'min', arc: -(STACK.my1[0] - STACK.mx4[1]) * 1000 * stretch * 0.5 });
  }

  // SRAM arrays: global bit lines, word-line straps, and read bursts.
  emitStraps(builder, leaves, { horizontal: false, pitch: um(0.9), offset: 0, width: um(0.34), y: STACK.mx2, material: 'copper', sample: um(4), allowed: (leaf) => leaf === 'sram', glowChance: 0.02, salt: 1401 });
  emitStraps(builder, leaves, { horizontal: true, pitch: um(3.6), offset: 0, width: um(0.5), y: STACK.mx3, material: 'copper', sample: um(4), allowed: (leaf) => leaf === 'sram' });
  emitStraps(builder, leaves, { horizontal: true, pitch: um(1.8), offset: um(0.9), width: um(0.3), y: STACK.mx1, material: 'copper', sample: um(4), allowed: (leaf) => leaf === 'sram' });
}

// ---------------------------------------------------------------------------
// Standard-cell rows (shared by levels 3 and 4)
// ---------------------------------------------------------------------------

/** Contacted gate pitch, cell-row height, and cell-block width. */
export const CPP = um(0.054);
export const ROW = um(0.216);
export const BLOCK_CPP = 32;
const BLOCK = BLOCK_CPP * CPP;

export type CellType = 'INV' | 'BUF' | 'NAND2' | 'NOR2' | 'NAND3' | 'AOI21' | 'OAI22' | 'XOR2' | 'MUX2' | 'FA' | 'DFF' | 'TAP' | 'FILL' | 'DECAP';
export const CELL_WIDTH: Record<CellType, number> = { INV: 2, BUF: 3, NAND2: 3, NOR2: 3, NAND3: 4, AOI21: 4, OAI22: 5, XOR2: 6, MUX2: 7, FA: 12, DFF: 14, TAP: 1, FILL: 1, DECAP: 4 };

const MIXES: Record<'datapath' | 'control' | 'sparse' | 'io', Array<[CellType, number]>> = {
  datapath: [['FA', 5], ['XOR2', 4], ['NAND2', 4], ['DFF', 3], ['AOI21', 3], ['INV', 3], ['MUX2', 2], ['NOR2', 2], ['DECAP', 1]],
  control: [['NAND2', 5], ['NOR2', 4], ['INV', 4], ['DFF', 3], ['AOI21', 3], ['OAI22', 2], ['NAND3', 2], ['BUF', 2], ['MUX2', 1], ['DECAP', 1]],
  sparse: [['BUF', 4], ['INV', 3], ['FILL', 4], ['DECAP', 3], ['DFF', 1]],
  io: [['BUF', 3], ['INV', 3], ['DECAP', 3], ['NAND2', 1], ['FILL', 2]],
};

export type PlacedCell = { type: CellType; start: number; width: number };

export const ROW_LEAVES: Leaf[] = ['logic', 'router', 'sram-periph', 'channel', 'analog', 'phy-drivers', 'phy-bumps', 'io'];

function mixFor(leaf: Leaf) {
  if (leaf === 'channel' || leaf === 'decap') return MIXES.sparse;
  if (leaf === 'io' || leaf === 'phy-drivers' || leaf === 'phy-bumps' || leaf === 'analog') return MIXES.io;
  if (leaf === 'router' || leaf === 'sram-periph') return MIXES.control;
  return MIXES.datapath;
}

/**
 * Cells of one fixed-width block in one row. Blocks are independent, so any
 * chunk can rebuild the cells it needs without walking the whole row. Every
 * block starts with a well tap and ends with filler.
 */
export function blockCells(row: number, block: number, leaf: Leaf): PlacedCell[] {
  const mix = mixFor(leaf);
  const total = mix.reduce((sum, [, weight]) => sum + weight, 0);
  const cells: PlacedCell[] = [{ type: 'TAP', start: block * BLOCK_CPP, width: 1 }];
  let used = 1;
  for (let k = 0; used < BLOCK_CPP; k += 1) {
    let pick = rand(2001, row, block, k) * total;
    let type: CellType = mix[0][0];
    for (const [candidate, weight] of mix) {
      pick -= weight;
      if (pick < 0) {
        type = candidate;
        break;
      }
    }
    let width = CELL_WIDTH[type];
    if (used + width > BLOCK_CPP) {
      type = 'FILL';
      width = BLOCK_CPP - used;
    }
    cells.push({ type, start: block * BLOCK_CPP + used, width });
    used += width;
  }
  return cells;
}

/** Row z-extent and whether it is mirrored (odd rows flip N and P). */
const rowZ = (row: number) => row * ROW;
const rowFlipped = (row: number) => (row & 1) === 1;
/** z of a feature at offset `offset` from a row's VSS edge. */
const rowOffset = (row: number, offset: number) => (rowFlipped(row) ? rowZ(row) + ROW - offset : rowZ(row) + offset);

type RowVisitor = (row: number, blockIndex: number, leaf: Leaf, cells: PlacedCell[]) => void;

/**
 * Region of one row block, from its exact centre. Wiring (level 3),
 * transistors (level 4), and cellAt() must all agree on it, so it is never
 * read through a quantized leaf cache.
 */
const rowBlockLeaf = (row: number, block: number) => leafAt((block + 0.5) * BLOCK, (row + 0.5) * ROW);

function visitRows(bounds: Rect, visit: RowVisitor) {
  const r0 = Math.floor(bounds.z0 / ROW);
  const r1 = Math.floor(bounds.z1 / ROW);
  const b0 = Math.floor(bounds.x0 / BLOCK);
  const b1 = Math.floor(bounds.x1 / BLOCK);
  for (let row = r0; row <= r1; row += 1) for (let block = b0; block <= b1; block += 1) {
    const leaf = rowBlockLeaf(row, block);
    if (!ROW_LEAVES.includes(leaf)) continue;
    visit(row, block, leaf, blockCells(row, block, leaf));
  }
}

export type CellHit = { row: number; block: number; leaf: Leaf; cell: PlacedCell; n: number; vdd: 'top' | 'bottom' };

/** The standard cell under a point, if the point lies in a cell row. */
export function cellAt(x: number, z: number): CellHit | null {
  const row = Math.floor(z / ROW);
  const block = Math.floor(x / BLOCK);
  const leaf = rowBlockLeaf(row, block);
  if (!ROW_LEAVES.includes(leaf)) return null;
  const n = Math.floor(x / CPP);
  const cell = blockCells(row, block, leaf).find((item) => n >= item.start && n < item.start + item.width);
  // Even rows have VSS on their lower edge and VDD on the upper one; odd rows flip.
  return cell ? { row, block, leaf, cell, n, vdd: rowFlipped(row) ? 'bottom' : 'top' } : null;
}

/** Supply carried by the rail on a row boundary (the rail below row `row`). */
export const railSupply = (row: number): 'VDD' | 'VSS' => (rowFlipped(row) ? 'VDD' : 'VSS');

/** [lower, upper] z of a span given as offsets from a row's VSS edge. */
const zSpan = (row: number, a: number, b: number): [number, number] => {
  const za = rowOffset(row, a);
  const zb = rowOffset(row, b);
  return za < zb ? [za, zb] : [zb, za];
};

// ---------------------------------------------------------------------------
// Standard-cell layouts: pins, contacts, and the wiring inside each cell
// ---------------------------------------------------------------------------
//
// Every logic cell has a fixed layout, shared by the transistors (level 4)
// and the local wiring (level 3), so the two always meet:
//   * input pins on M1 drop through V0 to an M0 wire and a gate contact;
//   * the output pin on M1 joins the NMOS and PMOS drains through V0 and M0;
//   * source contacts reach the supply rails at the cell edges and, through
//     vias, the buried power rails below the fins;
//   * multi-stage cells route internal nodes to the gates of later stages.
// Positions count gate pitches from the cell's left edge: source/drain
// position k sits at x = k CPP, gate column n at x = (n + 0.5) CPP.

/** M0 track offsets from a row's VSS edge: 0 over the NMOS fins, 3 over the PMOS fins, 1-2 in between. */
const M0_TRACKS = [0.054, 0.09, 0.126, 0.162].map(um);
/** Source/drain contact extents from the VSS edge, over the NMOS and the PMOS fins. */
const MD_N: Band = [um(0.038), um(0.079)];
const MD_P: Band = [um(0.137), um(0.178)];

type CellIo = { inputs: string[]; outputs: string[]; clock?: string; stages?: boolean };
const CELL_IO: Partial<Record<CellType, CellIo>> = {
  INV: { inputs: ['A'], outputs: ['Y'] },
  BUF: { inputs: ['A'], outputs: ['Y'], stages: true },
  NAND2: { inputs: ['A', 'B'], outputs: ['Y'] },
  NOR2: { inputs: ['A', 'B'], outputs: ['Y'] },
  NAND3: { inputs: ['A', 'B', 'C'], outputs: ['Y'] },
  AOI21: { inputs: ['A1', 'A2', 'B'], outputs: ['Y'] },
  OAI22: { inputs: ['A1', 'A2', 'B1', 'B2'], outputs: ['Y'] },
  XOR2: { inputs: ['A', 'B'], outputs: ['Y'], stages: true },
  MUX2: { inputs: ['A', 'B', 'S'], outputs: ['Y'], stages: true },
  FA: { inputs: ['A', 'B', 'CI'], outputs: ['S', 'CO'], stages: true },
  DFF: { inputs: ['D'], outputs: ['Q'], clock: 'CK', stages: true },
};

export type CellPin = { name: string; dir: 'in' | 'out' | 'clk'; k: number };
export type CellLayout = {
  /** Pins: vertical M1 bars at source/drain positions. */
  pins: CellPin[];
  /** Gate contacts on gate column n, under M0 track `track`. */
  gateContacts: Array<{ n: number; track: number }>;
  /** Source/drain contacts: tied to the rails, drains on an output, or an internal node spanning both devices. */
  contacts: Array<{ k: number; role: 'power' | 'out' | 'int' }>;
  /** M0 wires from k0 to k1 gate pitches along a track. */
  m0: Array<{ track: number; k0: number; k1: number; pin?: string }>;
  v0: Array<{ k: number; track: number }>;
};

const LAYOUTS = new Map<CellType, CellLayout | null>();

/** Layout of a cell type, in gate pitches from the cell's left edge (null for taps, fillers, and decaps). */
export function cellLayout(type: CellType): CellLayout | null {
  const cached = LAYOUTS.get(type);
  if (cached !== undefined) return cached;
  const io = CELL_IO[type];
  if (!io) {
    LAYOUTS.set(type, null);
    return null;
  }
  const w = CELL_WIDTH[type];
  const outs = io.outputs.length > 1 ? [w - 4, w - 1] : [w - 1];
  const role = (k: number): 'power' | 'out' | 'int' | null => {
    if (outs.includes(k)) return 'out';
    if (k === 0) return 'power';
    if (!io.stages) return k % 2 === 0 ? 'power' : null;
    return k % 2 === 1 ? 'int' : 'power';
  };
  // Inputs spread over the positions left of the first output; in
  // multi-stage cells they avoid the internal nodes (odd positions).
  const inputs = [...io.inputs, ...(io.clock ? [io.clock] : [])];
  const spacing = inputs.length > 1 ? (outs[0] - 1) / (inputs.length - 1) : 0;
  const taken = new Set<number>();
  const pins: CellPin[] = inputs.map((name, index) => {
    let k = Math.round(index * spacing);
    if (io.stages && k % 2 === 1) k -= 1;
    while (taken.has(k)) k += io.stages ? 2 : 1;
    taken.add(k);
    return { name, dir: name === io.clock ? 'clk' as const : 'in' as const, k };
  });
  io.outputs.forEach((name, index) => pins.push({ name, dir: 'out', k: outs[index] }));

  const contacts: CellLayout['contacts'] = [];
  for (let k = 0; k < w; k += 1) {
    const r = role(k);
    if (r) contacts.push({ k, role: r });
  }
  // M0 wires: drains on tracks 0 and 3, inputs and internal nodes on 1 and 2.
  const lanes: Array<Array<[number, number]>> = [[], [], [], []];
  const free = (track: number, a: number, b: number) => lanes[track].every(([c, d]) => b + 0.2 <= c || d + 0.2 <= a);
  const m0: CellLayout['m0'] = [];
  const v0: CellLayout['v0'] = [];
  const gateContacts: CellLayout['gateContacts'] = [];
  for (const pin of pins) {
    if (pin.dir !== 'out') continue;
    // The drain contact spans both devices; one M0 wire and V0 lift it to the pin.
    lanes[0].push([pin.k - 0.3, pin.k + 0.3]);
    m0.push({ track: 0, k0: pin.k - 0.3, k1: pin.k + 0.3, pin: pin.name });
    v0.push({ k: pin.k, track: 0 });
  }
  const driven = new Set<number>();
  pins.filter((pin) => pin.dir !== 'out').forEach((pin, index) => {
    // Pin k feeds the gate just to its right.
    const a = pin.k - 0.25;
    const b = pin.k + 0.75;
    const track = (index % 2 === 0 ? [1, 2] : [2, 1]).find((t) => free(t, a, b));
    if (track === undefined) return;
    lanes[track].push([a, b]);
    m0.push({ track, k0: a, k1: b, pin: pin.name });
    v0.push({ k: pin.k, track });
    gateContacts.push({ n: pin.k, track });
    driven.add(pin.k);
  });
  if (io.stages) {
    // Each internal node (odd position) drives the free gates either side of it with one wire.
    for (let k = 1; k < w - 1; k += 2) {
      if (role(k) !== 'int') continue;
      const gates = [k - 1, k].filter((n) => n >= 0 && n <= w - 2 && !driven.has(n));
      if (gates.length === 0) continue;
      const a = Math.min(k, ...gates.map((n) => n + 0.5)) - 0.15;
      const b = Math.max(k, ...gates.map((n) => n + 0.5)) + 0.15;
      const track = [1, 2].find((t) => free(t, a, b));
      if (track === undefined) continue;
      lanes[track].push([a, b]);
      m0.push({ track, k0: a, k1: b });
      for (const n of gates) {
        gateContacts.push({ n, track });
        driven.add(n);
      }
    }
  }
  const layout = { pins, gateContacts, contacts, m0, v0 };
  LAYOUTS.set(type, layout);
  return layout;
}

/** Whether a standard cell switches in the animation (its gates and output light up). */
const cellActive = (row: number, cell: PlacedCell) => rand(4003, row, cell.start) < 0.18;

// ---------------------------------------------------------------------------
// Local routing: nets between cell pins on M2 and M3
// ---------------------------------------------------------------------------
//
// Every local net joins an output pin to input pins through V1 and M2 and,
// between rows, V2 and M3. Routing is decided per row block, so any chunk
// rebuilds exactly the nets it shows, and nothing crosses a block edge:
//   * nets inside a row block run on M2 tracks 2-3 of the row;
//   * nets between a row and the row above use M2 track 4 of the lower row,
//     track 1 of the upper row, and an M3 track of class (row mod 2);
//   * via stacks from the intermediate layers land on class-2 M3 pads and
//     join a pin on tracks 2-3; power ladders use class-3 tracks at the rails.
// Tracks 0 and 5 stay free: pins reach only tracks 1-4.

const M2_PITCH = um(0.036);
const m2Z = (row: number, j: number) => rowZ(row) + (j + 0.5) * M2_PITCH;
const M2_HALF = um(0.009);
const M3_HALF = um(0.013);
const V_HALF = um(0.01);
/** How far a wire runs past the via at each of its ends. */
const REACH = um(0.014);
const LANE_GAP = um(0.02);

type PinAt = { row: number; k: number; x: number; name: string; dir: 'in' | 'out' | 'clk'; cell: PlacedCell };
type Piece = { kind: 'm2' | 'm3' | 'v1' | 'v2' | 'pad'; x0: number; x1: number; z0: number; z1: number; arc: number; entry: 'min' | 'max' };
type LocalNet = { flow: Flow; active: boolean; phase: number; pieces: Piece[] };
type Port = RouteEnd & { pin: PinAt | null };
type InputClass = 'row' | 'below' | 'above' | 'port' | 'clock' | 'none';

const viaSpan = (band: Band) => (band[1] - band[0]) * 1000 * LEVELS[3].viaStretch;

/** Builds the pieces of one net in order, keeping the pulse path length. */
class Trace {
  readonly pieces: Piece[];
  arc: number;
  constructor(pieces: Piece[], arc = 0) {
    this.pieces = pieces;
    this.arc = arc;
  }
  fork() {
    return new Trace(this.pieces, this.arc);
  }
  via(kind: 'v1' | 'v2', x: number, z: number, up: boolean) {
    this.pieces.push({ kind, x0: x - V_HALF, x1: x + V_HALF, z0: z - V_HALF, z1: z + V_HALF, arc: this.arc, entry: up ? 'min' : 'max' });
    this.arc += viaSpan(kind === 'v1' ? STACK.v1 : STACK.v2);
    return this;
  }
  /** M2 along x from `from` to `to`, reaching past both ends. */
  m2(z: number, from: number, to: number) {
    const forward = to >= from;
    this.pieces.push({ kind: 'm2', x0: Math.min(from, to) - REACH, x1: Math.max(from, to) + REACH, z0: z - M2_HALF, z1: z + M2_HALF, arc: this.arc - REACH * 1000, entry: forward ? 'min' : 'max' });
    this.arc += Math.abs(to - from) * 1000;
    return this;
  }
  /** M3 along z from `from` to `to`. */
  m3(x: number, from: number, to: number) {
    const forward = to >= from;
    this.pieces.push({ kind: 'm3', x0: x - M3_HALF, x1: x + M3_HALF, z0: Math.min(from, to) - REACH, z1: Math.max(from, to) + REACH, arc: this.arc - REACH * 1000, entry: forward ? 'min' : 'max' });
    this.arc += Math.abs(to - from) * 1000;
    return this;
  }
  pad(x: number, z: number) {
    const half = um(0.027);
    this.pieces.push({ kind: 'pad', x0: x - half, x1: x + half, z0: z - half, z1: z + half, arc: this.arc, entry: 'min' });
    return this;
  }
}

/**
 * From a source pin along M2 on `z` to every sink, branching both ways from
 * the source, then down a V1 into each sink pin.
 */
function fanOut(trace: Trace, z: number, from: number, sinks: number[]) {
  const left = sinks.filter((x) => x < from);
  const right = sinks.filter((x) => x >= from);
  const start = trace.arc;
  if (left.length > 0) trace.fork().m2(z, from, Math.min(...left));
  if (right.length > 0) trace.fork().m2(z, from, Math.max(...right));
  for (const x of sinks) new Trace(trace.pieces, start + Math.abs(x - from) * 1000).via('v1', x, z, false);
}

function nearestPin(pins: PinAt[], x: number, accept: (pin: PinAt) => boolean) {
  let best: PinAt | null = null;
  for (const pin of pins) if (accept(pin) && (!best || Math.abs(pin.x - x) < Math.abs(best.x - x))) best = pin;
  return best;
}

/** Row-block routing with memoized pins and drops, for one chunk's generation. */
function localRouter() {
  const leaves = new LeafCache(um(4));
  const pinMemo = new Map<string, PinAt[]>();
  const portMemo = new Map<string, Port[]>();
  const claimMemo = new Map<string, Set<number>>();

  const pins = (row: number, block: number): PinAt[] => {
    const key = `${row}:${block}`;
    let found = pinMemo.get(key);
    if (found) return found;
    found = [];
    const leaf = rowBlockLeaf(row, block);
    if (ROW_LEAVES.includes(leaf)) {
      for (const cell of blockCells(row, block, leaf)) {
        const layout = cellLayout(cell.type);
        if (!layout) continue;
        for (const pin of layout.pins) found.push({ row, k: cell.start + pin.k, x: (cell.start + pin.k) * CPP, name: pin.name, dir: pin.dir, cell });
      }
    }
    pinMemo.set(key, found);
    return found;
  };

  // Drops from the intermediate layers: a stack the cells drive leaves from
  // the nearest output pin; a stack that drives the cells feeds the nearest
  // free input pin, which then takes no other net.
  const ports = (row: number, block: number): Port[] => {
    const key = `${row}:${block}`;
    let found = portMemo.get(key);
    if (found) return found;
    const rect = { x0: block * BLOCK, x1: (block + 1) * BLOCK, z0: rowZ(row), z1: rowZ(row) + ROW };
    const here = pins(row, block);
    const claimed = new Set<number>();
    found = routeEndsIn(rect, leaves).map((end) => {
      const pin = nearestPin(here, end.x, (candidate) => (end.up ? candidate.dir === 'out' : candidate.dir === 'in' && !claimed.has(candidate.k)));
      if (pin && !end.up) claimed.add(pin.k);
      return { ...end, pin };
    });
    portMemo.set(key, found);
    claimMemo.set(key, claimed);
    return found;
  };

  const inputClass = (pin: PinAt, block: number): InputClass => {
    if (pin.dir === 'clk') return 'clock';
    ports(pin.row, block);
    if (claimMemo.get(`${pin.row}:${block}`)?.has(pin.k)) return 'port';
    const h = rand(5101, pin.row, pin.k);
    return h < 0.5 ? 'row' : h < 0.72 ? 'below' : h < 0.94 ? 'above' : 'none';
  };

  const netState = (key: number, salt: number) => ({ active: rand(5201, key, salt) < 0.2, phase: rand(5202, key, salt) });

  /** Nets inside one row block, and the drops that land in it. */
  function rowNets(row: number, block: number): LocalNet[] {
    const here = pins(row, block);
    const nets: LocalNet[] = [];
    const lanes: Record<2 | 3, Array<[number, number]>> = { 2: [], 3: [] };
    const place = (a: number, b: number): 2 | 3 | null => {
      for (const j of [2, 3] as const) {
        if (lanes[j].every(([c, d]) => b + LANE_GAP <= c || d + LANE_GAP <= a)) {
          lanes[j].push([a, b]);
          return j;
        }
      }
      return null;
    };
    for (const port of ports(row, block)) {
      const pieces: Piece[] = [];
      const net: LocalNet = { flow: FLOW.data, active: port.active, phase: port.phase, pieces };
      nets.push(net);
      const pin = port.pin;
      const j = pin ? place(Math.min(pin.x, port.x) - REACH, Math.max(pin.x, port.x) + REACH) : null;
      if (!pin || j === null) {
        new Trace(pieces).pad(port.x, port.z);
        continue;
      }
      const z = m2Z(row, j);
      if (port.up) new Trace(pieces).via('v1', pin.x, z, true).m2(z, pin.x, port.x).via('v2', port.x, z, true).m3(port.x, z, port.z).pad(port.x, port.z);
      else new Trace(pieces).pad(port.x, port.z).m3(port.x, port.z, z).via('v2', port.x, z, false).m2(z, port.x, pin.x).via('v1', pin.x, z, false);
    }
    // Clock pins take the block's clock buffer; other inputs the nearest output in the row.
    const outs = here.filter((pin) => pin.dir === 'out');
    const clockBuffer = outs.find((pin) => pin.cell.type === 'BUF' || pin.cell.type === 'INV') ?? null;
    const groups = new Map<number, { source: PinAt; sinks: PinAt[]; flow: Flow }>();
    for (const pin of here) {
      if (pin.dir === 'out') continue;
      const cls = inputClass(pin, block);
      let source: PinAt | null = null;
      if (cls === 'clock') source = clockBuffer && clockBuffer.cell !== pin.cell ? clockBuffer : null;
      else if (cls === 'row') {
        source = nearestPin(outs, pin.x - CPP * 3, (out) => out.cell !== pin.cell && out !== clockBuffer);
      }
      if (!source) continue;
      const group = groups.get(source.k) ?? { source, sinks: [], flow: cls === 'clock' ? FLOW.clock : FLOW.data };
      group.sinks.push(pin);
      groups.set(source.k, group);
    }
    for (const group of [...groups.values()].sort((a, b) => a.source.x - b.source.x)) {
      const xs = group.sinks.map((pin) => pin.x);
      const j = place(Math.min(group.source.x, ...xs) - REACH, Math.max(group.source.x, ...xs) + REACH);
      if (j === null) continue;
      const z = m2Z(row, j);
      const state = netState(row * 4099 + group.source.k, 1);
      const pieces: Piece[] = [];
      nets.push({ flow: group.flow, active: group.flow === FLOW.clock || state.active, phase: state.phase, pieces });
      fanOut(new Trace(pieces).via('v1', group.source.x, z, true), z, group.source.x, xs);
    }
    return nets;
  }

  /** Nets between row `row` and the row above it, in one block. */
  function pairNets(row: number, block: number): LocalNet[] {
    const lower = pins(row, block);
    const upper = pins(row + 1, block);
    if (lower.length === 0 || upper.length === 0) return [];
    const groups = new Map<string, { source: PinAt; sinks: PinAt[] }>();
    const add = (source: PinAt | null, sink: PinAt) => {
      if (!source) return;
      const key = `${source.row}:${source.k}`;
      const group = groups.get(key) ?? { source, sinks: [] };
      group.sinks.push(sink);
      groups.set(key, group);
    };
    for (const pin of lower) if (pin.dir === 'in' && inputClass(pin, block) === 'above') add(nearestPin(upper, pin.x, (out) => out.dir === 'out'), pin);
    for (const pin of upper) if (pin.dir === 'in' && inputClass(pin, block) === 'below') add(nearestPin(lower, pin.x, (out) => out.dir === 'out'), pin);
    const cls = ((row % 2) + 2) % 2;
    const lanes = { lower: [] as Array<[number, number]>, upper: [] as Array<[number, number]> };
    const free = (lane: Array<[number, number]>, a: number, b: number) => lane.every(([c, d]) => b + LANE_GAP <= c || d + LANE_GAP <= a);
    const used = new Set<number>();
    const bx0 = block * BLOCK + CPP;
    const bx1 = (block + 1) * BLOCK - CPP;
    const nets: LocalNet[] = [];
    for (const group of [...groups.values()].sort((a, b) => a.source.x - b.source.x || a.source.row - b.source.row)) {
      const fromLower = group.source.row === row;
      const xs = group.sinks.map((pin) => pin.x);
      const lo = Math.max(bx0, Math.min(group.source.x, ...xs) - 2 * CPP);
      const hi = Math.min(bx1, Math.max(group.source.x, ...xs) + 2 * CPP);
      const candidates: number[] = [];
      for (let x = m3From(cls, lo); x <= hi; x += 4 * CPP) candidates.push(x);
      candidates.sort((a, b) => Math.abs(a - group.source.x) - Math.abs(b - group.source.x));
      const sourceLane = fromLower ? lanes.lower : lanes.upper;
      const sinkLane = fromLower ? lanes.upper : lanes.lower;
      const zs = fromLower ? m2Z(row, 4) : m2Z(row + 1, 1);
      const zk = fromLower ? m2Z(row + 1, 1) : m2Z(row, 4);
      for (const xm of candidates) {
        const key = Math.round(xm / CPP);
        if (used.has(key)) continue;
        const sa = Math.min(group.source.x, xm) - REACH;
        const sb = Math.max(group.source.x, xm) + REACH;
        const ka = Math.min(xm, ...xs) - REACH;
        const kb = Math.max(xm, ...xs) + REACH;
        if (!free(sourceLane, sa, sb) || !free(sinkLane, ka, kb)) continue;
        sourceLane.push([sa, sb]);
        sinkLane.push([ka, kb]);
        used.add(key);
        const state = netState(group.source.row * 4099 + group.source.k, 2);
        const pieces: Piece[] = [];
        nets.push({ flow: FLOW.data, active: state.active, phase: state.phase, pieces });
        const trace = new Trace(pieces).via('v1', group.source.x, zs, true).m2(zs, group.source.x, xm).via('v2', xm, zs, true).m3(xm, zs, zk).via('v2', xm, zk, false);
        fanOut(trace, zk, xm, xs);
        break;
      }
    }
    return nets;
  }

  return { pins, rowNets, pairNets };
}

function emitLocalNet(builder: ChunkBuilder, net: LocalNet) {
  const clock = net.flow === FLOW.clock;
  for (const piece of net.pieces) {
    const emit: Emit = { glow: net.active ? (clock ? 0.8 : 1) : 0, phase: net.phase, flow: net.flow, arc: piece.arc, entry: piece.entry };
    if (piece.kind === 'm2') builder.seg('copper', piece.x0, piece.x1, STACK.m2[0], STACK.m2[1], piece.z0, piece.z1, { ...emit, part: clock ? 'clock-net' : 'm2', axis: 'x' });
    else if (piece.kind === 'm3') builder.seg('copper', piece.x0, piece.x1, STACK.m3[0], STACK.m3[1], piece.z0, piece.z1, { ...emit, part: clock ? 'clock-net' : 'm3', axis: 'z' });
    else if (piece.kind === 'v1') builder.via('tungsten', (piece.x0 + piece.x1) / 2, (piece.z0 + piece.z1) / 2, V_HALF, V_HALF, STACK.v1[0], STACK.v1[1], { ...emit, part: 'v1' });
    else if (piece.kind === 'v2') builder.via('tungsten', (piece.x0 + piece.x1) / 2, (piece.z0 + piece.z1) / 2, V_HALF, V_HALF, STACK.v2[0], STACK.v2[1], { ...emit, part: 'v2' });
    // Pads stop just under the cells crater floor, where the V3 stack above lands.
    else builder.seg('copper', piece.x0, piece.x1, STACK.m3[0], um(0.303), piece.z0, piece.z1, { ...emit, part: 'm3-pad', lift: false });
  }
}

// ---------------------------------------------------------------------------
// Level 3: local interconnect M0-M3 over standard cells and SRAM
// ---------------------------------------------------------------------------

function level3(builder: ChunkBuilder) {
  const b = builder.bounds;
  const leaves = new LeafCache(um(0.108));
  const router = localRouter();

  visitRows(b, (row, blockIndex, _leaf, cells) => {
    const x0 = blockIndex * BLOCK;
    const railZ = rowZ(row);
    // Rails at every row boundary: VSS below even rows, VDD below odd rows.
    builder.seg('copper', x0, x0 + BLOCK, STACK.m0[0], STACK.m0[1], railZ - um(0.012), railZ + um(0.012), { seed: hash(3000, row), part: 'm0-rail', flow: supplyFlow(row), glow: POWER_GLOW, phase: rand(3010, row, blockIndex) });
    for (const cell of cells) {
      const cx0 = cell.start * CPP;
      const cx1 = (cell.start + cell.width) * CPP;
      if (cell.type === 'DECAP') {
        // Clear of the next cell's input wire, which starts a quarter pitch before that cell.
        builder.seg('copper', cx0 + um(0.01), cx1 - CPP * 0.45, STACK.m0[0], STACK.m0[1], rowOffset(row, um(0.07)) - um(0.03), rowOffset(row, um(0.07)) + um(0.03), { part: 'decap-plate' });
        continue;
      }
      const layout = cellLayout(cell.type);
      if (!layout) continue;
      const active = cellActive(row, cell);
      const phase = rand(4004, row, cell.start);
      for (const wire of layout.m0) {
        const z = rowOffset(row, M0_TRACKS[wire.track]);
        builder.seg('copper', (cell.start + wire.k0) * CPP, (cell.start + wire.k1) * CPP, STACK.m0[0], STACK.m0[1], z - um(0.009), z + um(0.009), { part: 'm0-wire', glow: active ? 0.7 : 0, phase });
      }
      for (const via of layout.v0) {
        const z = rowOffset(row, M0_TRACKS[via.track]);
        builder.via('tungsten', (cell.start + via.k) * CPP, z, um(0.01), um(0.01), STACK.v0[0], STACK.v0[1], { part: 'v0', glow: active ? 0.7 : 0, phase, arc: 0, entry: via.track === 0 ? 'min' : 'max' });
      }
      const [za, zb] = zSpan(row, M0_TRACKS[0] - um(0.012), M0_TRACKS[3] + um(0.012));
      for (const pin of layout.pins) {
        const x = (cell.start + pin.k) * CPP;
        builder.seg('copper', x - um(0.012), x + um(0.012), STACK.m1[0], STACK.m1[1], za, zb, { part: pin.dir === 'out' ? 'm1-out' : 'm1-pin', axis: 'z' });
      }
    }
  });

  // Local nets: inside each row block, between neighbouring rows, and from the drops.
  const rowFrom = Math.floor(b.z0 / ROW);
  const rowTo = Math.floor(b.z1 / ROW);
  for (let block = Math.floor(b.x0 / BLOCK); block <= Math.floor(b.x1 / BLOCK); block += 1) {
    for (let row = rowFrom; row <= rowTo; row += 1) for (const net of router.rowNets(row, block)) emitLocalNet(builder, net);
    for (let row = rowFrom - 1; row <= rowTo; row += 1) for (const net of router.pairNets(row, block)) emitLocalNet(builder, net);
  }

  // Power ladders reach the rails: pads on M3-M1 and vias down to the M0 rail.
  for (const ladder of laddersIn({ x0: b.x0 - um(0.05), z0: b.z0 - um(0.05), x1: b.x1 + um(0.05), z1: b.z1 + um(0.05) })) {
    const { x, z, flow } = ladder;
    const down = flow === FLOW.vdd;
    const emit: Emit = { flow, glow: POWER_GLOW, phase: rand(3501, Math.round(x * 1e6), ladder.row) };
    const pad = (y: Band, top: number, hx: number, hz: number) => builder.seg('copper', x - hx, x + hx, y[0], top, z - hz, z + hz, { ...emit, part: 'ladder-pad', lift: false });
    const via = (y: Band, arc: number) => builder.via('tungsten', x, z, um(0.01), um(0.01), y[0], y[1], { ...emit, part: 'power-ladder', entry: down ? 'max' : 'min', arc });
    pad(STACK.m3, um(0.303), um(0.027), um(0.027));
    via(STACK.v2, 0);
    pad(STACK.m2, STACK.m2[1], um(0.016), um(0.015));
    via(STACK.v1, viaSpan(STACK.v2));
    pad(STACK.m1, STACK.m1[1], um(0.012), um(0.015));
    via(STACK.v0, viaSpan(STACK.v2) + viaSpan(STACK.v1));
  }

  // Deep-trench capacitor farms: M1 straps tie the trench tops together.
  emitStraps(builder, leaves, { horizontal: false, pitch: um(0.2), offset: um(0.1), width: um(0.05), y: STACK.m1, material: 'copper', sample: um(0.1), allowed: (leaf) => leaf === 'decap' });

  // SRAM: bit-line pairs on M1, word lines on M2, cell contacts.
  const bitcell = { w: 2 * CPP, h: ROW };
  const c0 = Math.floor(b.x0 / bitcell.w);
  const c1 = Math.floor(b.x1 / bitcell.w);
  const r0 = Math.floor(b.z0 / bitcell.h);
  const r1 = Math.floor(b.z1 / bitcell.h);
  for (let c = c0; c <= c1; c += 1) {
    const xa = c * bitcell.w + um(0.027);
    const xb = c * bitcell.w + um(0.081);
    let runStart: number | null = null;
    for (let r = r0; r <= r1 + 1; r += 1) {
      const isSram = r <= r1 && leaves.at((c + 0.5) * bitcell.w, (r + 0.5) * bitcell.h) === 'sram';
      if (isSram && runStart === null) runStart = r;
      if (!isSram && runStart !== null) {
        const za = runStart * bitcell.h;
        const zb = r * bitcell.h;
        const active = rand(3401, c, Math.floor(runStart / 64)) < 0.05 ? 1 : 0;
        builder.box('copper', xa - um(0.01), xa + um(0.01), STACK.m1[0], STACK.m1[1], za, zb, active, rand(3402, c));
        builder.box('copper', xb - um(0.01), xb + um(0.01), STACK.m1[0], STACK.m1[1], za, zb, -active, rand(3402, c));
        runStart = null;
      }
    }
  }
  for (let r = r0; r <= r1; r += 1) {
    let runStart: number | null = null;
    for (let c = c0; c <= c1 + 1; c += 1) {
      const isSram = c <= c1 && leaves.at((c + 0.5) * bitcell.w, (r + 0.5) * bitcell.h) === 'sram';
      if (isSram && runStart === null) runStart = c;
      if (!isSram && runStart !== null) {
        const z = (r + 0.5) * bitcell.h;
        builder.box('copper', runStart * bitcell.w, c * bitcell.w, STACK.m2[0], STACK.m2[1], z - um(0.012), z + um(0.012));
        builder.box('copper', runStart * bitcell.w, c * bitcell.w, STACK.m0[0], STACK.m0[1], r * bitcell.h - um(0.01), r * bitcell.h + um(0.01));
        for (let k = runStart; k < c; k += 1) {
          const x = (k + 0.5) * bitcell.w;
          builder.box('tungsten', x - um(0.009), x + um(0.009), STACK.v0[0], STACK.v1[1], z - um(0.03) - um(0.009), z - um(0.03) + um(0.009));
        }
        runStart = null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Level 4: transistors, buried power rails, backside power, deep trenches
// ---------------------------------------------------------------------------

const FIN_N = [0.045, 0.072].map(um);
const FIN_P = [0.144, 0.171].map(um);
const FIN_W = um(0.007);
const GATE_L = um(0.016);

function level4(builder: ChunkBuilder) {
  const b = builder.bounds;
  const leaves = new LeafCache(um(0.054));

  visitRows(b, (row, blockIndex, leaf, cells) => {
    const x0 = blockIndex * BLOCK;
    const x1 = x0 + BLOCK;
    const railZ = rowZ(row);
    const railFlow = supplyFlow(row);
    // Buried power rail under the boundary, nano-TSVs down to the backside
    // power network, and the backside rail itself. Power arrives from the
    // backside: VDD climbs the nano-TSVs into the buried rail, VSS returns down.
    builder.seg('copper', x0, x1, STACK.bpr[0], STACK.bpr[1], railZ - um(0.01), railZ + um(0.01), { seed: hash(4100, row), part: 'bpr', flow: railFlow, glow: POWER_GLOW, phase: rand(4110, row) });
    builder.seg('copper', x0, x1, STACK.backside[0], STACK.backside[1], railZ - um(0.016), railZ + um(0.016), { seed: hash(4101, row), part: 'backside-rail', flow: railFlow, glow: POWER_GLOW, phase: rand(4111, row) });
    for (let n = 3; n < BLOCK_CPP; n += 8) {
      const x = (blockIndex * BLOCK_CPP + n) * CPP;
      builder.via('copper', x, railZ, um(0.007), um(0.007), STACK.nanoTsv[0], STACK.nanoTsv[1], { part: 'nano-tsv', flow: railFlow, glow: POWER_GLOW, phase: rand(4112, row), entry: railFlow === FLOW.vdd ? 'min' : 'max', arc: 0 });
    }

    // Fins run through the block and break at diffusion breaks.
    let finStart = cells[0].start;
    const breakAfter = (index: number) => {
      const next = cells[index + 1];
      return !next || next.type === 'TAP' || next.type === 'FILL' || cells[index].type === 'TAP' || rand(4001, row, next.start) < 0.3;
    };
    cells.forEach((cell, index) => {
      if (!breakAfter(index)) return;
      const end = cell.start + cell.width;
      if (end - finStart >= 1 && cell.type !== 'TAP') {
        for (const offset of [...FIN_N, ...FIN_P]) {
          const z = rowOffset(row, offset);
          builder.box('silicon', (finStart + 0.15) * CPP, (end - 0.15) * CPP, STACK.fin[0], STACK.fin[1], z - FIN_W / 2, z + FIN_W / 2);
        }
      }
      finStart = end;
    });

    for (const cell of cells) {
      if (cell.type === 'TAP') {
        const x = (cell.start + 0.5) * CPP;
        builder.box('tungsten', x - um(0.012), x + um(0.012), STACK.fin[1], STACK.contact[1], rowOffset(row, um(0.03)) - um(0.012), rowOffset(row, um(0.03)) + um(0.012));
        continue;
      }
      if (cell.type === 'DECAP') {
        const x = (cell.start + cell.width / 2) * CPP;
        const z = rowOffset(row, um(0.108));
        builder.cyl('oxide', x, z, um(0.036), STACK.dtc[0], 0);
        builder.cyl('gate', x, z, um(0.029), STACK.dtc[0], STACK.dtc[1]);
      }
      const layout = cellLayout(cell.type);
      const active = layout !== null && cellActive(row, cell);
      const phase = rand(4004, row, cell.start);
      const contacted = new Map((layout?.gateContacts ?? []).map((contact) => [cell.start + contact.n, contact.track]));
      const zLo = rowZ(row) + um(0.028);
      const zHi = rowZ(row) + ROW - um(0.028);
      const zMid = rowZ(row) + ROW / 2;
      for (let n = cell.start; n < cell.start + cell.width; n += 1) {
        const gx = (n + 0.5) * CPP;
        const dummy = cell.type === 'FILL' || cell.type === 'DECAP' || n === cell.start + cell.width - 1;
        const track = contacted.get(n);
        // Gates with a contact switch when their cell does; a few uncontacted
        // gates are cut between the NMOS and PMOS devices.
        const cut = !dummy && track === undefined && rand(4002, row, n) < 0.3;
        const glow = active && track !== undefined ? 0.45 : 0;
        if (cut) {
          builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zLo, zMid - um(0.009), 0, phase);
          builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zMid + um(0.009), zHi, 0, phase);
        } else builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zLo, zHi, glow, phase);
        if (track !== undefined) {
          const z = rowOffset(row, M0_TRACKS[track]);
          builder.via('tungsten', gx, z, um(0.007), um(0.008), STACK.gate[1], STACK.contact[1], { part: 'contact-vg', glow, phase, entry: 'max', arc: 0 });
        }
      }
      if (!layout) continue;
      // Raised source/drain epitaxy on both devices at every diffusion position of the cell.
      for (let k = cell.start; k < cell.start + cell.width; k += 1) {
        const sx = k * CPP;
        for (const [fins, material] of [[FIN_N, 'epiN'], [FIN_P, 'epiP']] as const) {
          const [lo, hi] = zSpan(row, fins[0] - um(0.011), fins[1] + um(0.011));
          builder.box(material, sx - um(0.015), sx + um(0.015), STACK.epi[0], STACK.epi[1], lo, hi);
        }
      }
      const md = (sx: number, span: [number, number], emit: Emit) => builder.seg('tungsten', sx - um(0.007), sx + um(0.007), STACK.contact[0], STACK.contact[1], span[0], span[1], { axis: 'z', ...emit });
      for (const contact of layout.contacts) {
        const sx = (cell.start + contact.k) * CPP;
        if (contact.role === 'power') {
          // NMOS source to the VSS rail, PMOS source to the VDD rail, each with
          // a via down to the buried power rail under that edge.
          md(sx, zSpan(row, 0, MD_N[1]), { part: 'contact-power', flow: FLOW.vss, glow: POWER_GLOW, phase });
          md(sx, zSpan(row, MD_P[0], ROW), { part: 'contact-power', flow: FLOW.vdd, glow: POWER_GLOW, phase });
          const [va, vb] = zSpan(row, 0, um(0.01));
          builder.via('tungsten', sx, (va + vb) / 2, um(0.007), (vb - va) / 2, STACK.vbpr[0], STACK.vbpr[1], { part: 'vbpr', flow: FLOW.vss, glow: POWER_GLOW, phase, entry: 'max', arc: 0 });
          const [wa, wb] = zSpan(row, ROW - um(0.01), ROW);
          builder.via('tungsten', sx, (wa + wb) / 2, um(0.007), (wb - wa) / 2, STACK.vbpr[0], STACK.vbpr[1], { part: 'vbpr', flow: FLOW.vdd, glow: POWER_GLOW, phase, entry: 'min', arc: 0 });
        } else {
          // Drains of an output, or an internal node: one contact joining the NMOS and PMOS sides.
          md(sx, zSpan(row, MD_N[0], MD_P[1]), { part: 'contact-md', glow: active ? 0.45 : 0, phase: phase + (contact.role === 'out' ? 0.12 : 0.06) });
        }
      }
    }
  });

  // SRAM bitcells: 6T pairs with regular gates, shared contacts, and fins.
  const cellW = 2 * CPP;
  const c0 = Math.floor(b.x0 / cellW);
  const c1 = Math.floor(b.x1 / cellW);
  const r0 = Math.floor(b.z0 / ROW);
  const r1 = Math.floor(b.z1 / ROW);
  for (let r = r0; r <= r1; r += 1) {
    let runStart: number | null = null;
    for (let c = c0; c <= c1 + 1; c += 1) {
      const isSram = c <= c1 && leaves.at((c + 0.5) * cellW, (r + 0.5) * ROW) === 'sram';
      if (isSram && runStart === null) runStart = c;
      if (!isSram && runStart !== null) {
        for (const offset of [0.036, 0.081, 0.135, 0.18].map(um)) {
          const z = rowOffset(r, offset);
          builder.box('silicon', runStart * cellW + um(0.006), c * cellW - um(0.006), STACK.fin[0], STACK.fin[1], z - FIN_W / 2, z + FIN_W / 2);
        }
        runStart = null;
      }
      if (!isSram) continue;
      for (let g = 0; g < 2; g += 1) {
        const gx = c * cellW + (g + 0.5) * CPP;
        const split = (g + c + r) % 2 === 0;
        const zLo = rowZ(r) + um(0.02);
        const zHi = rowZ(r) + ROW - um(0.02);
        const zMid = rowZ(r) + ROW * (split ? 0.38 : 0.62);
        builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zLo, zMid - um(0.008), 0, 0);
        builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zMid + um(0.008), zHi, 0, 0);
      }
      const sx = (c + 1) * cellW;
      const na = rowOffset(r, um(0.024));
      const nb = rowOffset(r, um(0.093));
      builder.box('epiN', sx - um(0.015), sx + um(0.015), STACK.epi[0], STACK.epi[1], Math.min(na, nb), Math.max(na, nb));
      builder.box('tungsten', sx - um(0.007), sx + um(0.007), STACK.contact[0], STACK.contact[1], rowZ(r) + um(0.04), rowZ(r) + um(0.07));
      builder.box('epiP', c * cellW + CPP - um(0.015), c * cellW + CPP + um(0.015), STACK.epi[0], STACK.epi[1], Math.min(rowOffset(r, um(0.125)), rowOffset(r, um(0.19))), Math.max(rowOffset(r, um(0.125)), rowOffset(r, um(0.19))));
      builder.box('tungsten', c * cellW + CPP - um(0.007), c * cellW + CPP + um(0.007), STACK.contact[0], STACK.contact[1], rowZ(r) + um(0.14), rowZ(r) + um(0.17));
    }
  }

  // Deep-trench capacitor farms in the power-delivery bands.
  const pitch = um(0.2);
  for (let i = Math.floor(b.x0 / pitch); i * pitch < b.x1; i += 1) for (let j = Math.floor(b.z0 / pitch); j * pitch < b.z1; j += 1) {
    const x = (i + 0.5) * pitch;
    const z = (j + 0.5) * pitch;
    if (leaves.at(x, z) !== 'decap' || (i + j) % 7 === 0) continue;
    builder.cyl('oxide', x, z, um(0.052), STACK.dtc[0], 0);
    builder.cyl('gate', x, z, um(0.042), STACK.dtc[0], STACK.dtc[1]);
  }
}

// ---------------------------------------------------------------------------
// Chunk entry point
// ---------------------------------------------------------------------------

const GENERATORS: Array<((builder: ChunkBuilder) => void) | null> = [null, level1, level2, level3, level4];

export function generateChunk(levelId: number, ix: number, iz: number): ChunkData {
  const level = LEVELS[levelId];
  const bounds = chunkBounds(level, ix, iz);
  const builder = new ChunkBuilder(bounds, [(bounds.x0 + bounds.x1) / 2, (bounds.z0 + bounds.z1) / 2], levelId);
  if (rectsOverlap(bounds, DIE_RECT)) GENERATORS[levelId]?.(builder);
  return builder.finish(levelId, ix, iz);
}

// ---------------------------------------------------------------------------
// Package: interposer wiring between the die and the memory stacks
// ---------------------------------------------------------------------------

/** Heights of the package layers under the die (mm; the die's silicon ends at -DIE.thickness). */
export const PACKAGE_Y = {
  interposerTop: -DIE.thickness - 0.02,
  interposerBottom: -DIE.thickness - 0.12,
  substrateTop: -DIE.thickness - 0.21,
} as const;

/**
 * Redistribution-layer bundles on the interposer: every memory PHY reaches
 * its HBM stack through short, dense wiring (drawn as sixteen bundles per
 * stack, each standing for many traces). They run from under the PHY's bump
 * field to under the stack's base die; pulses show reads and writes.
 */
export function generatePackageWiring(): ChunkData {
  const hx = (PACKAGE_GEOMETRY.interposer.width * MM) / 2;
  const hz = (PACKAGE_GEOMETRY.interposer.depth * MM) / 2;
  const builder = new ChunkBuilder(rect(-hx, -hz, hx, hz), [0, 0], 0);
  const y0 = PACKAGE_Y.interposerTop;
  const y1 = y0 + 0.004;
  const bundles = 16;
  const width = 0.13;
  for (const phy of PHYS) {
    const placement = STACK_PLACEMENTS[phy.index];
    const [bx, bz] = rectCenter(phy.bumps);
    const sx = placement.x * MM;
    const sz = placement.z * MM;
    const alongX = phy.side === 'west' || phy.side === 'east';
    for (let k = 0; k < bundles; k += 1) {
      const emit: Emit = { part: 'rdl-trace', glow: k % 2 === 0 ? 1 : -1, phase: rand(701, phy.index, k) };
      if (alongX) {
        const z = phy.rect.z0 + ((k + 0.5) * (phy.rect.z1 - phy.rect.z0)) / bundles;
        builder.seg('copper', Math.min(bx, sx), Math.max(bx, sx), y0, y1, z - width / 2, z + width / 2, emit);
      } else {
        const x = phy.rect.x0 + ((k + 0.5) * (phy.rect.x1 - phy.rect.x0)) / bundles;
        builder.seg('copper', x - width / 2, x + width / 2, y0, y1, Math.min(bz, sz), Math.max(bz, sz), emit);
      }
    }
  }
  return builder.finish(0, 0, 0);
}

// ---------------------------------------------------------------------------
// Cross-sections
// ---------------------------------------------------------------------------

export type SectionPlane = {
  /** 0: the plane is x = value; 2: the plane is z = value. */
  axis: 0 | 2;
  value: number;
  /** Side that stays visible: +1 keeps coordinates above `value`. */
  keep: 1 | -1;
};

/**
 * Moves a section plane onto the nearest column of vertical conductors, so a
 * cut always shows them whole: nano-TSVs and power rails at transistor
 * scale, the TSV column in the shared SRAM strip at tile scale.
 */
export function snapSection(axis: 0 | 2, x: number, z: number, distance: number): number {
  const value = axis === 0 ? x : z;
  if (distance < 0.03) {
    if (axis === 0) return (Math.round((value / CPP - 3) / 8) * 8 + 3) * CPP;
    return Math.round(value / ROW) * ROW;
  }
  const band = SRAM_STRIP.tsvBand;
  const nearBand = x > band.x0 - 0.2 && x < band.x1 + 0.2 && z > band.z0 && z < band.z1;
  if (distance < 2.5 && nearBand) {
    if (axis === 0) return clampValue(Math.round(value / um(30)) * um(30), -um(60), um(60));
    return band.z0 + um(20) + Math.round((value - band.z0 - um(20)) / um(30)) * um(30);
  }
  return value;
}

const clampValue = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/**
 * Solid faces where a vertical section plane cuts a chunk's primitives: one
 * thin box per cut, just inside the kept half-space so clipping leaves it.
 */
export function sectionCaps(chunk: ChunkData, plane: SectionPlane, thickness: number): Batch[] {
  const origin = plane.axis === 0 ? chunk.origin[0] : chunk.origin[2];
  const v = plane.value - origin;
  const other = plane.axis === 0 ? 2 : 0;
  const out = new Map<MaterialKey, number[]>();
  for (const batch of chunk.batches) {
    const list = out.get(batch.material) ?? [];
    const offset = plane.keep * thickness * (1 + 2 * CAP_PRIORITY[batch.material]);
    for (let k = 0; k < batch.count; k += 1) {
      const p = k * FLOATS_PER_INSTANCE;
      const d = batch.data;
      const c = d[p + plane.axis];
      const half = d[p + 3 + plane.axis] / 2;
      if (c - half >= v || c + half <= v) continue;
      let span = d[p + 3 + other];
      if (batch.shape === 'cyl') {
        const distance = Math.abs(c - v);
        span = 2 * Math.sqrt(Math.max(0, half * half - distance * distance));
      }
      const axis = pathAxis(d[p + 6]);
      const alongPlaneAxis = (axis === 'x' && plane.axis === 0) || (axis === 'z' && plane.axis === 2);
      const start = alongPlaneAxis && d[p + 8] !== 0 ? d[p + 7] + (v - (c - half)) * 1000 : d[p + 7];
      // Cut faces of active wires glow at half strength: light inside the metal, not a lamp.
      const values = [0, d[p + 1], 0, 0, d[p + 4], 0, d[p + 6], start, d[p + 8] * 0.5, d[p + 9]];
      values[plane.axis] = v + offset;
      values[other] = d[p + other];
      values[3 + plane.axis] = thickness;
      values[3 + other] = span;
      list.push(...values);
    }
    if (list.length) out.set(batch.material, list);
  }
  return [...out.entries()].map(([material, values]) => ({ material, shape: 'box' as const, data: new Float32Array(values), count: values.length / FLOATS_PER_INSTANCE }));
}

// ---------------------------------------------------------------------------
// Camera: zoom stops, delayering crater, fly paths
// ---------------------------------------------------------------------------

export type FocusStop = {
  id: 'package' | 'die' | 'tile' | 'block' | 'routing' | 'cells' | 'devices';
  label: string;
  layer: string;
  /** Upper camera distance for this stop (mm). */
  below: number;
  /** Orbit-target height (mm). */
  targetY: number;
  /** Everything above this height is cleared around the target (null: no crater). */
  floor: number | null;
};

export const FOCUS_STOPS: FocusStop[] = [
  { id: 'package', label: 'Package', layer: 'Accelerator die and eight memory stacks on the interposer', below: Infinity, targetY: STACK_TOP, floor: null },
  { id: 'die', label: 'Die', layer: 'Global power mesh, seal ring, and I/O pads', below: 60, targetY: STACK_TOP, floor: null },
  { id: 'tile', label: 'Compute tile', layer: 'Semi-global metal and systolic buses', below: 6, targetY: STACK.noc[1], floor: null },
  { id: 'block', label: 'Tensor PE', layer: 'Intermediate routing maze', below: 0.45, targetY: STACK.mx4[1], floor: STACK.ubm[1] + um(0.01) },
  { id: 'routing', label: 'Routing', layer: 'Intermediate routing, upper layers delayered', below: 0.04, targetY: STACK.mx4[1], floor: STACK.mx4[1] + um(0.02) },
  { id: 'cells', label: 'Standard cells', layer: 'Local interconnect M0–M3 over the cell rows', below: 0.012, targetY: STACK.m3[1], floor: STACK.m3[1] + um(0.004) },
  { id: 'devices', label: 'Transistors', layer: 'Fins, gates, epitaxy, and contacts (metal delayered)', below: 0.0032, targetY: um(0.055), floor: (STACK.contact[1] + STACK.m0[0]) / 2 },
];

/** Stop for a camera distance, with 8 % hysteresis around each boundary. */
export function focusStopFor(distance: number, current?: FocusStop['id']): FocusStop {
  const index = FOCUS_STOPS.findIndex((stop) => stop.id === current);
  let chosen = 0;
  for (let k = 0; k < FOCUS_STOPS.length; k += 1) if (distance < FOCUS_STOPS[k].below) chosen = k;
  if (index >= 0 && Math.abs(chosen - index) === 1) {
    const boundary = chosen > index ? FOCUS_STOPS[chosen].below : FOCUS_STOPS[index].below;
    if (Math.abs(Math.log(distance / boundary)) < Math.log(1.08)) return FOCUS_STOPS[index];
  }
  return FOCUS_STOPS[chosen];
}

/**
 * Delayering crater: everything above `floor` within `radius` of the target is
 * cleared, and the cut rises with `slope` beyond it, leaving terraces that
 * show each layer the camera passed. The radius covers the camera's own
 * column, so nothing can come between the camera and what it looks at.
 */
export function craterFor(stop: FocusStop, distance: number, polar: number) {
  if (stop.floor === null) return null;
  return { floor: stop.floor, radius: distance * (Math.sin(polar) + 1.1), slope: 0.25 };
}

/** Near and far planes that keep depth precision at every zoom. */
export function clipPlanesFor(distance: number) {
  return { near: Math.max(distance * 0.04, 1e-7), far: Math.max(distance * 400, 1) };
}

/**
 * Smooth, efficient zooming and panning (van Wijk & Nuij, 2003): the path in
 * (position, view width) that feels uniform across orders of magnitude.
 * Returns the path length S and a sampler for s in [0, S].
 */
export function zoomPanPath(from: { x: number; z: number; width: number }, to: { x: number; z: number; width: number }, rho = 1.35) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  const w0 = from.width;
  const w1 = to.width;
  if (distance < 1e-9 * Math.max(w0, w1)) {
    const k = w1 < w0 ? -1 : 1;
    const length = Math.abs(Math.log(w1 / w0)) / rho;
    return { length, at: (s: number) => ({ x: from.x, z: from.z, width: w0 * Math.exp(k * rho * s) }) };
  }
  const rho2 = rho * rho;
  const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * distance * distance) / (2 * w0 * rho2 * distance);
  const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * distance * distance) / (2 * w1 * rho2 * distance);
  const r0 = -Math.asinh(b0);
  const r1 = -Math.asinh(b1);
  const length = (r1 - r0) / rho;
  const ux = dx / distance;
  const uz = dz / distance;
  return {
    length,
    at: (s: number) => {
      const u = (w0 / rho2) * Math.cosh(r0) * Math.tanh(rho * s + r0) - (w0 / rho2) * Math.sinh(r0);
      return { x: from.x + ux * u, z: from.z + uz * u, width: (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0) };
    },
  };
}

export function formatLength(mm: number): string {
  const trim = (value: number) => (value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(value % 1 === 0 ? 0 : 1) : value.toFixed(value % 1 === 0 ? 0 : 2).replace(/0$/, ''));
  if (mm >= 1) return `${trim(mm)} mm`;
  if (mm >= 1e-3) return `${trim(mm * 1e3)} µm`;
  return `${trim(mm * 1e6)} nm`;
}

/** Round scale-bar length (1, 2, 5 × 10ⁿ) closest to `targetPx` pixels. */
export function scaleBar(mmPerPixel: number, targetPx = 110) {
  const raw = mmPerPixel * targetPx;
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const nice = [1, 2, 5, 10].map((m) => m * base).reduce((best, value) => (Math.abs(Math.log(value / raw)) < Math.abs(Math.log(best / raw)) ? value : best));
  return { mm: nice, px: nice / mmPerPixel, label: formatLength(nice) };
}

// ---------------------------------------------------------------------------
// Presets: one path from the package to a single transistor
// ---------------------------------------------------------------------------

export type ViewPreset = { id: FocusStop['id']; label: string; x: number; z: number; distance: number; polar: number; azimuth: number };

const HERO_TILE = TILES.find((tile) => tile.col === 4 && tile.row === 2) ?? TILES[0];
const HERO_PE = peRect(HERO_TILE, 9, 5);

function findHeroCell(): { x: number; z: number } {
  // First datapath block near the middle of the hero PE with a full adder.
  const [cx, cz] = rectCenter(HERO_PE);
  const startRow = Math.floor((cz + 0.02) / ROW);
  const startBlock = Math.floor((cx + 0.02) / BLOCK);
  for (let dr = 0; dr < 40; dr += 1) for (let db = 0; db < 8; db += 1) {
    const row = startRow + dr;
    const block = startBlock + db;
    const leaf = leafAt((block + 0.5) * BLOCK, (row + 0.5) * ROW);
    if (leaf !== 'logic') continue;
    const cell = blockCells(row, block, leaf).find((item) => item.type === 'FA' || item.type === 'XOR2');
    if (cell) return { x: (cell.start + cell.width / 2) * CPP, z: rowZ(row) + ROW / 2 };
  }
  return { x: cx, z: cz };
}

export const PRESETS: ViewPreset[] = (() => {
  const [tx, tz] = rectCenter(HERO_TILE.rect);
  const [px, pz] = rectCenter(HERO_PE);
  const hero = findHeroCell();
  return [
    { id: 'package', label: 'Package', x: 0, z: 0, distance: 150, polar: 0.92, azimuth: 0.62 },
    { id: 'die', label: 'Die', x: 0, z: 0, distance: 43, polar: 0.62, azimuth: 0.4 },
    { id: 'tile', label: 'Tile', x: tx, z: tz, distance: 4.4, polar: 0.78, azimuth: 0.55 },
    { id: 'block', label: 'Tensor PE', x: px, z: pz, distance: 0.3, polar: 0.86, azimuth: 0.62 },
    { id: 'cells', label: 'Cells', x: hero.x, z: hero.z, distance: 0.0085, polar: 0.82, azimuth: 0.7 },
    { id: 'devices', label: 'Transistors', x: hero.x, z: hero.z, distance: 0.0011, polar: 0.98, azimuth: 0.78 },
  ];
})();

export const SILICON_EVIDENCE = {
  class: 'illustrative',
  statement: 'Procedural visualization. Die outline, tile array, shared SRAM strip, and edge PHYs follow the planned accelerator floorplan; every structure inside them is generated for illustration and is not layout, GDS, or PDK data.',
} as const;
