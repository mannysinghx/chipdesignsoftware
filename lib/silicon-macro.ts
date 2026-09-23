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
  mx1: band(0.8, 1.1),
  vx1: band(1.1, 1.4),
  mx2: band(1.4, 1.72),
  vx2: band(1.72, 2.1),
  mx3: band(2.1, 2.5),
  vx3: band(2.5, 2.8),
  mx4: band(2.8, 3.2),
  sysH: band(3.7, 4.1),
  sysV: band(4.15, 4.5),
  my1: band(4.6, 5.4),
  vy1: band(5.4, 6.2),
  my2: band(6.2, 7.0),
  chanH: band(7.05, 7.3),
  chanV: band(7.32, 7.55),
  noc: band(7.6, 8.4),
  ring: band(8.5, 9.1),
  mz1: band(9.2, 10.8),
  vz1: band(10.8, 11.4),
  mz2: band(11.4, 13.0),
  pad: band(13.0, 14.5),
  ubm: band(13.0, 14.6),
  pillar: band(14.62, 20.5),
  solder: band(20.5, 23.0),
  bpr: band(-0.05, -0.012),
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
};

export const LEVELS: LevelSpec[] = [
  { id: 0, name: 'Global metal', chunk: 0, radius: 0, activateAt: Infinity, fullAt: Infinity, pulse: { period: 1500, speed: 1500 } },
  { id: 1, name: 'Semi-global metal', chunk: 0.5, radius: 3, activateAt: 6, fullAt: 4.4, pulse: { period: 150, speed: 150 } },
  { id: 2, name: 'Intermediate metal', chunk: 0.1, radius: 2, activateAt: 0.45, fullAt: 0.33, pulse: { period: 28, speed: 26 } },
  { id: 3, name: 'Local interconnect', chunk: 0.003, radius: 2, activateAt: 0.014, fullAt: 0.0105, pulse: { period: 1.8, speed: 1.4 } },
  { id: 4, name: 'Front-end devices', chunk: 0.001, radius: 2, activateAt: 0.0046, fullAt: 0.0034, pulse: { period: 40, speed: 12 } },
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
 * data = [tint + axis flag, path start (µm), glow, pulse phase].
 * tint is in [0, 1); +2 marks a box whose glow path runs along z.
 * glow > 0 pulses forward along the path, < 0 backward.
 */
export const FLOATS_PER_INSTANCE = 10;

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
  private readonly buffers = new Map<string, number[]>();
  yMin = Infinity;
  yMax = -Infinity;

  constructor(bounds: Rect, origin: [number, number]) {
    this.bounds = bounds;
    this.ox = origin[0];
    this.oz = origin[1];
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
    const b = this.bounds;
    const cx0 = Math.max(x0, b.x0);
    const cx1 = Math.min(x1, b.x1);
    const cz0 = Math.max(z0, b.z0);
    const cz1 = Math.min(z1, b.z1);
    if (cx0 >= cx1 || cz0 >= cz1 || y0 >= y1) return;
    const alongX = x1 - x0 >= z1 - z0;
    // Tint comes from the unclipped box, so a wire split across chunks keeps
    // one colour. Shapes on one layer overlap where they cross; a small
    // tint-driven lift keeps their top faces from z-fighting.
    const tint = seed === undefined ? rand(nmIndex(x0), nmIndex(z0), nmIndex(y0 * 10), 17) : rand(seed, 23);
    const top = y1 + (y1 - y0) * 0.04 * tint;
    // The pulse path coordinate is the absolute position along the wire (µm),
    // so pulses stay continuous however the wire is clipped.
    const start = glow === 0 ? 0 : (alongX ? cx0 : cz0) * 1000;
    this.push(material, 'box', [(cx0 + cx1) / 2 - this.ox, (y0 + top) / 2, (cz0 + cz1) / 2 - this.oz, cx1 - cx0, top - y0, cz1 - cz0, tint + (alongX ? 0 : 2), start, glow, phase]);
  }

  /** Vertical cylinder, kept by the chunk that contains its axis. */
  cyl(material: MaterialKey, cx: number, cz: number, radius: number, y0: number, y1: number, glow = 0, phase = 0) {
    if (!insideRect(this.bounds, cx, cz) || y0 >= y1) return;
    const tint = rand(nmIndex(cx), nmIndex(cz), nmIndex(y0 * 10), 29);
    this.push(material, 'cyl', [cx - this.ox, (y0 + y1) / 2, cz - this.oz, radius * 2, y1 - y0, radius * 2, tint, 0, glow, phase]);
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

function emitRuns(builder: ChunkBuilder, layer: MazeLayer, runs: Run[]) {
  for (const run of runs) {
    const across = (run.track + 0.5) * layer.pitch;
    const half = layer.width / 2;
    const active = rand(layer.salt + 3, run.track, run.start) < layer.glowChance;
    const glow = active ? (rand(layer.salt + 4, run.track, run.start) < 0.5 ? 1 : -1) : 0;
    const phase = rand(layer.salt + 5, run.track, run.start);
    if (layer.horizontal) builder.box(layer.material, run.lo, run.hi, layer.y[0], layer.y[1], across - half, across + half, glow, phase);
    else builder.box(layer.material, across - half, across + half, layer.y[0], layer.y[1], run.lo, run.hi, glow, phase);
  }
}

/** Vias where a horizontal and a vertical run cross, thinned by hash. */
function emitVias(builder: ChunkBuilder, horizontal: { layer: MazeLayer; runs: Run[] }, vertical: { layer: MazeLayer; runs: Run[] }, y: Band, size: number, chance: number, material: MaterialKey = 'tungsten') {
  const byTrack = new Map<number, Run[]>();
  for (const run of vertical.runs) {
    const list = byTrack.get(run.track);
    if (list) list.push(run);
    else byTrack.set(run.track, [run]);
  }
  const vPitch = vertical.layer.pitch;
  for (const hRun of horizontal.runs) {
    const z = (hRun.track + 0.5) * horizontal.layer.pitch;
    const first = Math.ceil(hRun.lo / vPitch - 0.5);
    const last = Math.floor(hRun.hi / vPitch - 0.5);
    for (let track = first; track <= last; track += 1) {
      const runs = byTrack.get(track);
      if (!runs) continue;
      const x = (track + 0.5) * vPitch;
      if (!runs.some((run) => z > run.lo && z < run.hi)) continue;
      if (rand(horizontal.layer.salt + 7, hRun.track, track, vertical.layer.salt) >= chance) continue;
      builder.box(material, x - size / 2, x + size / 2, y[0], y[1], z - size / 2, z + size / 2);
    }
  }
}

/** Plain straps across a chunk, broken wherever `allowed` rejects the region. */
function emitStraps(builder: ChunkBuilder, leaves: LeafCache, options: { horizontal: boolean; pitch: number; offset: number; width: number; y: Band; material: MaterialKey; sample: number; allowed: (leaf: Leaf) => boolean; glowChance?: number; salt?: number }) {
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
    const glow = rand(salt, k) < (options.glowChance ?? 0) ? (k % 2 === 0 ? 1 : -1) : 0;
    const phase = rand(salt + 1, k);
    let runStart: number | null = null;
    const flush = (end: number) => {
      if (runStart === null) return;
      if (options.horizontal) builder.box(options.material, runStart, end, options.y[0], options.y[1], across - options.width / 2, across + options.width / 2, glow, phase, seed);
      else builder.box(options.material, across - options.width / 2, across + options.width / 2, options.y[0], options.y[1], runStart, end, glow, phase, seed);
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

export function generateGlobal(): ChunkData {
  const pad = 1;
  const builder = new ChunkBuilder(rect(DIE_RECT.x0 - pad, DIE_RECT.z0 - pad, DIE_RECT.x1 + pad, DIE_RECT.z1 + pad), [0, 0]);
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
    if (padItem.side === 'north') builder.box('copper', cx - lead / 2, cx + lead / 2, STACK.mz1[0], STACK.mz1[1], r.z1, -hz + DIE.ioBand);
    if (padItem.side === 'south') builder.box('copper', cx - lead / 2, cx + lead / 2, STACK.mz1[0], STACK.mz1[1], hz - DIE.ioBand, r.z0);
    if (padItem.side === 'west') builder.box('copper', r.x1, -hx + DIE.ioBand, STACK.mz1[0], STACK.mz1[1], cz - lead / 2, cz + lead / 2);
    if (padItem.side === 'east') builder.box('copper', hx - DIE.ioBand, r.x0, STACK.mz1[0], STACK.mz1[1], cz - lead / 2, cz + lead / 2);
  }

  // Global power mesh: gold straps in both directions, broken over the PHY
  // bump fields, with via stacks at every crossing.
  const strapPitch = 0.6;
  const strapWidth = um(24);
  const core = rect(-hx + DIE.ioBand, -hz + DIE.ioBand, hx - DIE.ioBand, hz - DIE.ioBand);
  const xs: number[] = [];
  const zs: number[] = [];
  for (let x = core.x0 + strapPitch / 2; x < core.x1; x += strapPitch) xs.push(x);
  for (let z = core.z0 + strapPitch / 2; z < core.z1; z += strapPitch) zs.push(z);
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
  for (const x of xs) for (const [a, b] of strapRuns(x, core.z0, core.z1, true)) builder.box('gold', x - strapWidth / 2, x + strapWidth / 2, STACK.mz2[0], STACK.mz2[1], a, b);
  for (const z of zs) for (const [a, b] of strapRuns(z, core.x0, core.x1, false)) builder.box('gold', a, b, STACK.mz1[0], STACK.mz1[1], z - strapWidth / 2, z + strapWidth / 2);
  for (const x of xs) for (const z of zs) {
    if (inAnyPhy(x, z)) continue;
    builder.box('tungsten', x - strapWidth / 2, x + strapWidth / 2, STACK.vz1[0], STACK.vz1[1], z - strapWidth / 2, z + strapWidth / 2);
  }

  // Tile power rings.
  for (const tile of TILES) {
    const r = tile.rect;
    const w = um(36);
    builder.box('gold', r.x0, r.x1, STACK.ring[0], STACK.ring[1], r.z0, r.z0 + w);
    builder.box('gold', r.x0, r.x1, STACK.ring[0], STACK.ring[1], r.z1 - w, r.z1);
    builder.box('gold', r.x0, r.x0 + w, STACK.ring[0], STACK.ring[1], r.z0 + w, r.z1 - w);
    builder.box('gold', r.x1 - w, r.x1, STACK.ring[0], STACK.ring[1], r.z0 + w, r.z1 - w);
  }

  // Network-on-chip: glowing lanes along every routing channel.
  const lane = (horizontal: boolean, across: number, from: number, to: number, lines: number, width: number, pitch: number, salt: number, y: Band = STACK.noc) => {
    for (let line = 0; line < lines; line += 1) {
      const offset = (line - (lines - 1) / 2) * pitch;
      const glow = line % 2 === 0 ? 0.6 : -0.6;
      const phase = rand(salt, line, Math.round(across * 1000));
      if (horizontal) builder.box('copper', from, to, y[0], y[1], across + offset - width / 2, across + offset + width / 2, glow, phase);
      else builder.box('copper', across + offset - width / 2, across + offset + width / 2, y[0], y[1], from, to, glow, phase);
    }
  };
  const columnEdges = distinct(TILES.map((tile) => tile.rect.x0));
  const columnRight = distinct(TILES.map((tile) => tile.rect.x1));
  const rowTop = distinct(TILES.map((tile) => tile.rect.z0));
  const rowBottom = distinct(TILES.map((tile) => tile.rect.z1));
  const a = TILE_ARRAY_RECT;
  const verticalLanes: number[] = [];
  for (let k = 0; k < columnEdges.length - 1; k += 1) {
    const gapStart = columnRight[k];
    const gapEnd = columnEdges[k + 1];
    if (gapEnd - gapStart > 1) {
      // The SRAM strip sits in this gap: one lane each side of it.
      verticalLanes.push((gapStart + SRAM_STRIP.rect.x0) / 2, (SRAM_STRIP.rect.x1 + gapEnd) / 2);
    } else verticalLanes.push((gapStart + gapEnd) / 2);
  }
  for (const x of verticalLanes) lane(false, x, a.z0 - 0.26, a.z1 + 0.26, 4, um(14), um(34), 301);
  const horizontalLanes = [a.z0 - 0.26, ...rowBottom.slice(0, -1).map((z, k) => (z + rowTop[k + 1]) / 2), a.z1 + 0.26];
  for (const z of horizontalLanes) lane(true, z, a.x0 - 0.26, a.x1 + 0.26, 4, um(14), um(34), 302);
  // SRAM strip spine over the TSV column.
  lane(false, 0, SRAM_STRIP.rect.z0, SRAM_STRIP.rect.z1, 6, um(10), um(24), 303, STACK.ring);
  // Tile routers onto the nearest horizontal lane.
  for (const tile of TILES) {
    const [rx] = rectCenter(tile.router);
    const nearest = horizontalLanes.reduce((best, z) => (Math.abs(z - tile.router.z1) < Math.abs(best - tile.router.z1) ? z : best), horizontalLanes[0]);
    lane(false, rx, Math.min(tile.router.z0 + 0.05, nearest), Math.max(tile.router.z0 + 0.05, nearest), 4, um(10), um(24), 304 + tile.index);
  }
  // Memory PHYs: three lane bundles from the driver strip to the array edge.
  for (const phy of PHYS) {
    const horizontal = phy.side === 'west' || phy.side === 'east';
    const d = phy.drivers;
    for (const f of [0.25, 0.5, 0.75]) {
      if (horizontal) {
        const z = phy.rect.z0 + (phy.rect.z1 - phy.rect.z0) * f;
        const from = phy.side === 'west' ? d.x0 : a.x1 + 0.26;
        const to = phy.side === 'west' ? a.x0 - 0.26 : d.x1;
        lane(true, z, Math.min(from, to), Math.max(from, to), 8, um(12), um(26), 401 + phy.index);
      } else {
        const x = phy.rect.x0 + (phy.rect.x1 - phy.rect.x0) * f;
        const from = phy.side === 'north' ? d.z0 : a.z1 + 0.26;
        const to = phy.side === 'north' ? a.z0 - 0.26 : d.z1;
        lane(false, x, Math.min(from, to), Math.max(from, to), 8, um(12), um(26), 401 + phy.index);
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

function level1(builder: ChunkBuilder) {
  const b = builder.bounds;
  const leaves = new LeafCache(um(10));

  emitStraps(builder, leaves, { horizontal: true, pitch: um(60), offset: um(30), width: um(5), y: STACK.my1, material: 'copper', sample: um(20), allowed: STRAP_ALLOWED });
  emitStraps(builder, leaves, { horizontal: false, pitch: um(60), offset: um(30), width: um(5), y: STACK.my2, material: 'copper', sample: um(20), allowed: STRAP_ALLOWED });
  // Vias at strap crossings.
  for (let x = Math.ceil((b.x0 - um(30)) / um(60)) * um(60) + um(30); x < b.x1; x += um(60)) {
    for (let z = Math.ceil((b.z0 - um(30)) / um(60)) * um(60) + um(30); z < b.z1; z += um(60)) {
      if (!STRAP_ALLOWED(leaves.at(x, z))) continue;
      builder.box('tungsten', x - um(2.5), x + um(2.5), STACK.vy1[0], STACK.vy1[1], z - um(2.5), z + um(2.5));
    }
  }

  // Systolic buses between neighbouring PEs; pulses sweep the anti-diagonals.
  for (const tile of TILES) {
    if (!rectsOverlap(tile.peArray, b)) continue;
    const i0 = Math.max(0, Math.floor((b.x0 - tile.peArray.x0) / tile.pePitchX) - 1);
    const i1 = Math.min(PE_COLUMNS - 1, Math.floor((b.x1 - tile.peArray.x0) / tile.pePitchX) + 1);
    const j0 = Math.max(0, Math.floor((b.z0 - tile.peArray.z0) / tile.pePitchZ) - 1);
    const j1 = Math.min(PE_ROWS - 1, Math.floor((b.z1 - tile.peArray.z0) / tile.pePitchZ) + 1);
    for (let i = i0; i <= i1; i += 1) for (let j = j0; j <= j1; j += 1) {
      const pe = peRect(tile, i, j);
      const [cx, cz] = rectCenter(pe);
      const wave = ((i + j) * 0.055 + tile.index * 0.137) % 1;
      for (let line = 0; line < 6; line += 1) {
        const offset = (line - 2.5) * um(3.2);
        if (i + 1 < PE_COLUMNS) builder.box('copper', pe.x1 - um(30), pe.x1 + PE_GAP + um(30), STACK.sysH[0], STACK.sysH[1], cz + offset - um(0.8), cz + offset + um(0.8), 1, wave + line * 0.004);
        if (j + 1 < PE_ROWS) builder.box('copper', cx + offset - um(0.8), cx + offset + um(0.8), STACK.sysV[0], STACK.sysV[1], pe.z1 - um(30), pe.z1 + PE_GAP + um(30), 1, wave + line * 0.004);
      }
      // PE pin stripes: the bus fans into the datapath.
      builder.box('copper', pe.x0 + um(70), pe.x1 - um(34), STACK.sysH[0], STACK.sysH[1], cz - um(12.5), cz - um(11));
      builder.box('copper', pe.x0 + um(70), pe.x1 - um(34), STACK.sysH[0], STACK.sysH[1], cz + um(11), cz + um(12.5));
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
  // pad, and the via stack up to the semi-global straps.
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
      }
    }
  }

  // PHY microbump fields and lane drivers.
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
          builder.box('gold', x - um(14), x + um(14), STACK.ubm[0], STACK.ubm[1], z - um(14), z + um(14));
          builder.cyl('copper', x, z, um(10.5), STACK.pillar[0], STACK.pillar[1]);
          builder.cyl('solder', x, z, um(11), STACK.solder[0], STACK.solder[1]);
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
          builder.box('copper', d.x0, d.x1, STACK.my1[0], STACK.my1[1], z - um(1.25), z + um(1.25), k % 3 === 0 ? (phy.side === 'west' ? 1 : -1) : 0, rand(501, phy.index, k));
        }
      } else {
        for (let x = Math.ceil((Math.max(b.x0, d.x0) - d.x0) / lanePitch) * lanePitch + d.x0 + um(9); x < Math.min(b.x1, d.x1); x += lanePitch) {
          const k = Math.round((x - d.x0) / lanePitch);
          builder.box('copper', x - um(1.25), x + um(1.25), STACK.my2[0], STACK.my2[1], d.z0, d.z1, k % 3 === 0 ? (phy.side === 'north' ? 1 : -1) : 0, rand(502, phy.index, k));
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
// Level 2: intermediate routing maze
// ---------------------------------------------------------------------------

const DENSITY: Partial<Record<Leaf, number>> = { logic: 0.5, router: 0.62, 'sram-periph': 0.4, channel: 0.3, analog: 0.18, 'phy-drivers': 0.34, 'phy-bumps': 0.24, io: 0.22 };
const mazeDensity = (scale: number) => (leaf: Leaf) => (DENSITY[leaf] ?? 0) * scale;

const L2_LAYERS: MazeLayer[] = [
  { salt: 1101, horizontal: true, pitch: um(1.0), width: um(0.42), y: STACK.mx1, cell: um(8), material: 'copper', occupancy: mazeDensity(1), glowChance: 0.035 },
  { salt: 1201, horizontal: false, pitch: um(1.0), width: um(0.42), y: STACK.mx2, cell: um(8), material: 'copper', occupancy: mazeDensity(0.95), glowChance: 0.035 },
  { salt: 1301, horizontal: true, pitch: um(1.5), width: um(0.62), y: STACK.mx3, cell: um(12), material: 'copper', occupancy: mazeDensity(0.8), glowChance: 0.05 },
];

function level2(builder: ChunkBuilder) {
  const b = builder.bounds;
  const leaves = new LeafCache(um(4));
  const runs = L2_LAYERS.map((layer) => mazeRuns(layer, b, leaves));
  L2_LAYERS.forEach((layer, index) => emitRuns(builder, layer, runs[index]));
  emitVias(builder, { layer: L2_LAYERS[0], runs: runs[0] }, { layer: L2_LAYERS[1], runs: runs[1] }, STACK.vx1, um(0.38), 0.07);
  emitVias(builder, { layer: L2_LAYERS[2], runs: runs[2] }, { layer: L2_LAYERS[1], runs: runs[1] }, STACK.vx2, um(0.38), 0.06);

  // Power straps on the top intermediate layer over all logic.
  emitStraps(builder, leaves, { horizontal: false, pitch: um(14), offset: um(7), width: um(1.8), y: STACK.mx4, material: 'copper', sample: um(4), allowed: (leaf) => leaf in DENSITY || leaf === 'decap' || leaf === 'sram' });

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

function visitRows(bounds: Rect, leaves: LeafCache, visit: RowVisitor) {
  const r0 = Math.floor(bounds.z0 / ROW);
  const r1 = Math.floor(bounds.z1 / ROW);
  const b0 = Math.floor(bounds.x0 / BLOCK);
  const b1 = Math.floor(bounds.x1 / BLOCK);
  for (let row = r0; row <= r1; row += 1) for (let block = b0; block <= b1; block += 1) {
    const leaf = leaves.at((block + 0.5) * BLOCK, (row + 0.5) * ROW);
    if (!ROW_LEAVES.includes(leaf)) continue;
    visit(row, block, leaf, blockCells(row, block, leaf));
  }
}

// ---------------------------------------------------------------------------
// Level 3: local interconnect M0-M3 over standard cells and SRAM
// ---------------------------------------------------------------------------

const M0_TRACKS = [0.054, 0.09, 0.126, 0.162].map(um);

const L3_M2: MazeLayer = { salt: 3201, horizontal: true, pitch: um(0.036), width: um(0.018), y: STACK.m2, cell: um(0.216), material: 'copper', occupancy: (leaf) => (leaf === 'sram' || leaf === 'tsv' || leaf === 'seal' || leaf === 'outside' || leaf === 'phy-bumps' ? 0 : leaf === 'decap' || leaf === 'channel' ? 0.14 : 0.3), glowChance: 0.03 };
const L3_M3: MazeLayer = { salt: 3301, horizontal: false, pitch: um(0.054), width: um(0.026), y: STACK.m3, cell: um(0.432), material: 'copper', occupancy: (leaf) => (leaf === 'sram' || leaf === 'tsv' || leaf === 'seal' || leaf === 'outside' || leaf === 'phy-bumps' ? 0 : 0.26), glowChance: 0.04 };

function level3(builder: ChunkBuilder) {
  const b = builder.bounds;
  const leaves = new LeafCache(um(0.108));

  visitRows(b, leaves, (row, blockIndex, leaf, cells) => {
    const x0 = blockIndex * BLOCK;
    const railZ = rowZ(row);
    // Rails at every row boundary: VSS below even rows, VDD below odd rows.
    builder.box('copper', x0, x0 + BLOCK, STACK.m0[0], STACK.m0[1], railZ - um(0.012), railZ + um(0.012), 0, 0, hash(3000, row));
    for (const cell of cells) {
      const cx0 = cell.start * CPP;
      const cx1 = (cell.start + cell.width) * CPP;
      if (cell.type === 'FILL' || cell.type === 'TAP') continue;
      if (cell.type === 'DECAP') {
        builder.box('copper', cx0 + um(0.01), cx1 - um(0.01), STACK.m0[0], STACK.m0[1], rowOffset(row, um(0.07)) - um(0.03), rowOffset(row, um(0.07)) + um(0.03));
        continue;
      }
      const wires = 1 + (cell.width > 3 ? 1 : 0) + (cell.width > 8 ? 1 : 0);
      for (let k = 0; k < wires; k += 1) {
        const track = M0_TRACKS[hash(3001, row, cell.start, k) % M0_TRACKS.length];
        const a = cell.start + Math.floor(rand(3002, row, cell.start, k) * (cell.width - 1));
        const span = 1 + Math.floor(rand(3003, row, cell.start, k) * Math.max(1, cell.width - (a - cell.start) - 1));
        const z = rowOffset(row, track);
        builder.box('copper', (a + 0.35) * CPP, (a + span + 0.65) * CPP, STACK.m0[0], STACK.m0[1], z - um(0.009), z + um(0.009), rand(3004, row, cell.start, k) < 0.04 ? 1 : 0, rand(3005, row, cell.start));
      }
      const pins = 1 + Math.floor(cell.width / 4);
      for (let k = 0; k < pins; k += 1) {
        const n = cell.start + 1 + Math.floor(rand(3006, row, cell.start, k) * Math.max(1, cell.width - 1));
        const x = n * CPP;
        const za = rowOffset(row, M0_TRACKS[0]);
        const zb = rowOffset(row, M0_TRACKS[3]);
        builder.box('copper', x - um(0.012), x + um(0.012), STACK.m1[0], STACK.m1[1], Math.min(za, zb) - um(0.012), Math.max(za, zb) + um(0.012));
        const via = rowOffset(row, M0_TRACKS[hash(3007, row, n) % 4]);
        builder.box('tungsten', x - um(0.01), x + um(0.01), STACK.v0[0], STACK.v0[1], via - um(0.01), via + um(0.01));
      }
    }
  });

  // Deep-trench capacitor farms: M1 straps tie the trench tops together.
  emitStraps(builder, leaves, { horizontal: false, pitch: um(0.2), offset: um(0.1), width: um(0.05), y: STACK.m1, material: 'copper', sample: um(0.1), allowed: (leaf) => leaf === 'decap' });

  const m2 = mazeRuns(L3_M2, b, leaves);
  const m3 = mazeRuns(L3_M3, b, leaves);
  emitRuns(builder, L3_M2, m2);
  emitRuns(builder, L3_M3, m3);
  emitVias(builder, { layer: L3_M2, runs: m2 }, { layer: L3_M3, runs: m3 }, STACK.v2, um(0.018), 0.1);

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

  visitRows(b, leaves, (row, blockIndex, leaf, cells) => {
    const x0 = blockIndex * BLOCK;
    const x1 = x0 + BLOCK;
    const railZ = rowZ(row);
    // Buried power rail under the boundary, nano-TSVs down to the backside
    // power network, and the backside rail itself.
    builder.box('copper', x0, x1, STACK.bpr[0], STACK.bpr[1], railZ - um(0.01), railZ + um(0.01), 0, 0, hash(4100, row));
    builder.box('copper', x0, x1, STACK.backside[0], STACK.backside[1], railZ - um(0.016), railZ + um(0.016), 0, 0, hash(4101, row));
    for (let n = 3; n < BLOCK_CPP; n += 8) {
      const x = (blockIndex * BLOCK_CPP + n) * CPP;
      builder.box('copper', x - um(0.007), x + um(0.007), STACK.nanoTsv[0], STACK.nanoTsv[1], railZ - um(0.007), railZ + um(0.007));
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
      for (let n = cell.start; n < cell.start + cell.width; n += 1) {
        const gx = (n + 0.5) * CPP;
        const dummy = cell.type === 'FILL' || n === cell.start + cell.width - 1;
        const cut = !dummy && rand(4002, row, n) < 0.3;
        const active = !dummy && rand(4003, row, n) < 0.14;
        const glow = active ? 0.45 : 0;
        const phase = rand(4004, row, n);
        const zLo = rowZ(row) + um(0.028);
        const zHi = rowZ(row) + ROW - um(0.028);
        const zMid = rowZ(row) + ROW / 2;
        if (cut) {
          builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zLo, zMid - um(0.009), glow, phase);
          builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zMid + um(0.009), zHi, glow, phase);
        } else builder.box('gate', gx - GATE_L / 2, gx + GATE_L / 2, STACK.gate[0], STACK.gate[1], zLo, zHi, glow, phase);
        if (!dummy && rand(4005, row, n) < 0.3) builder.box('tungsten', gx - um(0.007), gx + um(0.007), STACK.gate[1], STACK.contact[1], zMid - um(0.008), zMid + um(0.008));
        if (dummy || cell.type === 'DECAP') continue;
        // Raised source/drain epitaxy on both devices right of this gate.
        const sx = (n + 1) * CPP;
        if (n + 1 >= cell.start + cell.width) continue;
        for (const [fins, material] of [[FIN_N, 'epiN'], [FIN_P, 'epiP']] as const) {
          const za = rowOffset(row, fins[0]);
          const zb = rowOffset(row, fins[1]);
          const lo = Math.min(za, zb) - um(0.011);
          const hi = Math.max(za, zb) + um(0.011);
          builder.box(material, sx - um(0.015), sx + um(0.015), STACK.epi[0], STACK.epi[1], lo, hi);
          if (rand(4006, row, n, material === 'epiN' ? 1 : 2) < 0.62) builder.box('tungsten', sx - um(0.007), sx + um(0.007), STACK.contact[0], STACK.contact[1], lo + um(0.004), hi - um(0.004));
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
  const builder = new ChunkBuilder(bounds, [(bounds.x0 + bounds.x1) / 2, (bounds.z0 + bounds.z1) / 2]);
  if (rectsOverlap(bounds, DIE_RECT)) GENERATORS[levelId]?.(builder);
  return builder.finish(levelId, ix, iz);
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
      const alongPlaneAxis = (d[p + 6] >= 2) === (plane.axis === 2);
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
  { id: 'routing', label: 'Routing', layer: 'Intermediate routing, upper layers delayered', below: 0.04, targetY: STACK.mx4[1], floor: STACK.mx4[1] + um(0.05) },
  { id: 'cells', label: 'Standard cells', layer: 'Local interconnect M0–M3 over the cell rows', below: 0.012, targetY: STACK.m3[1], floor: STACK.m3[1] + um(0.01) },
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
