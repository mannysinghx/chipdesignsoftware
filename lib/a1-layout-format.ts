// Data format of the real A1 tile layout shown in the Silicon macro view's
// "A1 layout" mode. The exporter (tools/physical/layout-export) reads the
// routed sky130hd DEF, the SkyWater cell library GDS and LEF, and the layer
// heights from the PDK's Magic tech file, and writes:
//
//   manifest.json   provenance, die, layer stack, via and cell tables, tile index, statistics
//   lib.json.gz     every library cell's own drawn geometry (diffusion, poly, contacts, li1, met1)
//   global.bin.gz   the met4/met5 power grid, the via4 arrays between them, and the I/O pins
//   tiles/X_Y.bin.gz  everything else, cut into square tiles: placed cells, routed wires and
//                   vias with their nets, met1 power rails and the rail-to-strap via stacks
//   nets/K.json.gz  net names, kinds, and pins, in chunks of NET_CHUNK nets
//   insts/K.json.gz instance names, in chunks of INST_CHUNK instances
//   overview-*.png  per-layer coverage maps for the whole-tile view
//
// Every coordinate is in DEF database units (1 nm) unless named otherwise.
// Binary blocks are little-endian, column by column (one array per field),
// so each column compresses on its own.
//
// Nothing is approximated, but two things are rebuilt rather than stored, and
// the exporter proves both against the DEF before it writes anything: filler
// cells (rebuildFill) and which net each cell pin is on (the via or wire that
// lands on the pin's shape; see pinNet in the viewer). Instances are numbered
// in the order the tiles store them, so a tile's cells are firstInst,
// firstInst + 1, ...; filler cells have no number and no name.

export const LAYOUT_FORMAT = 'aimem-layout/1';
export const BLOCK_MAGIC = 0x544c3141; // 'A1LT'
export const BLOCK_VERSION = 4;
export const NET_CHUNK = 2048;
export const INST_CHUNK = 4096;
/** Net index meaning "no net" (an unconnected cell pin). */
export const NO_NET = 0xffffffff;

// ---------------------------------------------------------------------------
// Layers, bottom to top. Heights come from the manifest (the PDK tech file).
// ---------------------------------------------------------------------------

export const LAYER_IDS = [
  'nwell', 'ndiff', 'pdiff', 'ntap', 'ptap', 'poly', 'licon', 'pcon', 'li1', 'mcon',
  'met1', 'via', 'met2', 'via2', 'met3', 'via3', 'met4', 'via4', 'met5',
] as const;
export type LayerId = typeof LAYER_IDS[number];
export const LAYER = Object.fromEntries(LAYER_IDS.map((id, index) => [id, index])) as Record<LayerId, number>;

/** Routing layers in DEF order, with the cut layer above each (null for met5). */
export const ROUTING_LAYERS = ['li1', 'met1', 'met2', 'met3', 'met4', 'met5'] as const satisfies readonly LayerId[];
export const CUT_ABOVE: Record<typeof ROUTING_LAYERS[number], LayerId | null> = { li1: 'mcon', met1: 'via', met2: 'via2', met3: 'via3', met4: 'via4', met5: null };

/** What a drawn rectangle is for. Packed with its layer into one byte. */
export const PURPOSES = ['wire', 'patch', 'pin', 'rail', 'stripe', 'cut', 'enclosure'] as const;
export type Purpose = typeof PURPOSES[number];
export const PURPOSE = Object.fromEntries(PURPOSES.map((id, index) => [id, index])) as Record<Purpose, number>;

export const packKind = (layer: number, purpose: number) => (purpose << 5) | layer;
export const kindLayer = (kind: number) => kind & 31;
export const kindPurpose = (kind: number) => kind >> 5;

/** DEF orientations, in the order stored. */
export const ORIENTS = ['N', 'S', 'E', 'W', 'FN', 'FS', 'FE', 'FW'] as const;
export type Orient = typeof ORIENTS[number];

/**
 * A cell-local point (x, y), relative to the placed lower-left corner, for a
 * cell of size w × h placed at `orient`. DEF applies the orientation, then
 * moves the cell's bounding box to the placement point. The flipped
 * rotations follow OpenDB: FE = MYR90, FW = MXR90.
 */
export function placePoint(orient: number, w: number, h: number, x: number, y: number): [number, number] {
  switch (orient) {
    case 0: return [x, y];              // N  (R0)
    case 1: return [w - x, h - y];      // S  (R180)
    case 2: return [y, w - x];          // E  (R270)
    case 3: return [h - y, x];          // W  (R90)
    case 4: return [w - x, y];          // FN (MY)
    case 5: return [x, h - y];          // FS (MX)
    case 6: return [h - y, w - x];      // FE (MY, then R90)
    case 7: return [y, x];              // FW (MX, then R90)
    default: return [x, y];
  }
}

/** A cell-local rectangle placed at `orient`, as [x0, y0, x1, y1] relative to the placed lower-left corner. */
export function placeRect(orient: number, w: number, h: number, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const [ax, ay] = placePoint(orient, w, h, x0, y0);
  const [bx, by] = placePoint(orient, w, h, x1, y1);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type LayerInfo = {
  id: LayerId;
  label: string;
  /** Bottom and top above the silicon surface, µm (from the PDK tech file). */
  z0: number;
  z1: number;
  /** Routing layers only: preferred direction, track pitch and default width (µm). */
  direction?: 'horizontal' | 'vertical';
  pitch?: number;
  width?: number;
};

/** A via: its cut and enclosure rectangles around its origin, [layer, x0, y0, x1, y1]. */
export type ViaDef = { name: string; bottom: LayerId; cut: LayerId; top: LayerId; rects: Array<[number, number, number, number, number]> };

export type MacroPin = { name: string; dir: 'input' | 'output' | 'inout'; use: 'signal' | 'clock' | 'power' | 'ground' };

export type CellClass = 'logic' | 'sequential' | 'clock' | 'buffer' | 'fill' | 'tap' | 'diode' | 'decap';

export type MacroInfo = {
  name: string;
  /** Width and height, DBU. */
  w: number;
  h: number;
  cls: CellClass;
  pins: MacroPin[];
  /** Pins whose nets each placed cell records, in order (signal and clock pins). */
  signalPins: number[];
  /** Instances placed. */
  count: number;
};

export type TileEntry = { ix: number; iy: number; bytes: number; cells: number; rects: number; vias: number };

export type RegionGroup = {
  id: string;
  label: string;
  detail: string;
  /** Registers in the group. */
  count: number;
  /** Where most of them sit: the box holding the central 80 % in x and y, DBU. */
  box: [number, number, number, number];
  centroid: [number, number];
};

export type LayoutManifest = {
  format: typeof LAYOUT_FORMAT;
  design: string;
  platform: string;
  title: string;
  run: string;
  rtlCommit: string;
  generated: string;
  exporter: string;
  sources: Array<{ role: string; file: string; bytes: number; sha256: string }>;
  evidence: { drc: string; lvs: string; timing: string; statement: string };
  dbuPerMicron: number;
  die: [number, number, number, number];
  core: [number, number, number, number];
  rows: RowSpec;
  fill: FillSpec;
  /**
   * The supply via stack placed wherever a met4 strap crosses a met1 rail of
   * the same net: its vias and landing patches, relative to the crossing.
   * Rebuilt per tile rather than stored (the exporter checks every crossing).
   */
  powerStacks: { vias: number[]; patches: Array<[number, number, number, number, number]> };
  /** I/O pins, by index: name, direction, and net. */
  ioPins: Array<{ name: string; dir: string; net: number }>;
  layers: LayerInfo[];
  vias: ViaDef[];
  macros: MacroInfo[];
  tile: { size: number; nx: number; ny: number; entries: TileEntry[] };
  global: { bytes: number; rects: number; vias: number };
  nets: { count: number; chunk: number; chunks: number; vdd: number; vss: number; clock: number; signal: number; routed: number; clockIds: number[] };
  /** Stored (numbered) instances; `fill` more are rebuilt. */
  insts: { count: number; chunk: number; chunks: number; named: number; fill: number };
  overview: { size: number; files: { metal: string; cells: string }; channels: { metal: [string, string, string, string]; cells: [string, string, string, string] } };
  stats: {
    cells: Record<CellClass, number>;
    /** Wire length per routing layer, µm (power included separately). */
    wire: Record<string, number>;
    powerWire: Record<string, number>;
    vias: Record<string, number>;
    ioPins: number;
    transistors: number;
  };
  heroes: Record<'region' | 'routing' | 'cells' | 'devices', { x: number; y: number; note: string }>;
  groups: RegionGroup[];
  /** The run's own reports: areas, counts, power, timing, IR drop, DRC, LVS, LEC. */
  facts?: LayoutFacts;
  /** The worst setup path: its summary here, the cell-by-cell steps in `file` (a LayoutPath). */
  criticalPath?: Omit<LayoutPath, 'clock' | 'data'> & { file: string; cells: number; clockBuffers: number };
  /** The tile's I/O pins, grouped by bus, with the edge and span (DBU along it) each occupies. */
  ioBuses?: Array<{ name: string; dir: string; count: number; side: 'north' | 'south' | 'east' | 'west'; from: number; to: number; layers: string[] }>;
  /** How the stored cells divide among the 16 dot units and the three pipeline stages (cells-meta file). */
  roles?: { file: string; kinds: string[]; counts: { logic: number; assigned: number; shared: number; none: number; registers: number }; perUnit: number[]; units: Array<{ unit: number; count: number; x: number; y: number }>; stages: Array<{ unit: number; stage: number; count: number; x: number; y: number }> };
  /** Dot-unit map for the whole-tile view: grey level 16 × (unit + 1) where that unit's cells cover most of the pixel, 0 elsewhere. */
  unitsOverview?: { file: string; palette: string[] };
  /** The clock tree: every clock driver with its parent and the flip-flops it clocks (clock file). */
  clockTree?: { file: string; nodes: number; flops: number; levels: number };
};

export type LayoutFacts = {
  source: string;
  period: number;
  area: { die: number; core: number; cells: number; utilization: number };
  counts: { cells: number; all: number; byClass: Record<string, number> };
  power: { total: number; internal: number; switching: number; leakage: number };
  timing: { fmax: number; setupWs: number; setupTns: number; setupViolations: number; holdWs: number; holdViolations: number; skewSetup: number; skewHold: number; maxSlewViolations: number; maxCapViolations: number };
  ir: { vddWorst: number; vssWorst: number; vddAverage: number; vssAverage: number };
  drc: { count: number; source: string } | null;
  lvs: { result: string; devices: number; nets: number; source: string } | null;
  lec: { result: string; source: string } | null;
  transistors: { gds: number; cdl: number; cellsMatching: number; cellTypes: number };
};

export type LayoutPathStep = { inst: string; pin: string; cell: string; edge: 'rise' | 'fall'; time: number; delay: number; net: string | null; x: number; y: number; netId: number };
export type LayoutPath = { startpoint: string; endpoint: string; arrival: number; required: number; slack: number; period: number; stage: string; clock: LayoutPathStep[]; data: LayoutPathStep[] };

/** One clock-tree driver: position (cell centre, DBU), parent index (-1: the clk pin), flip-flops it clocks, depth. */
export type ClockTreeFile = { nodes: Array<[number, number, number, number, number]>; root: [number, number] };

// ---------------------------------------------------------------------------
// Blocks: the global block and every tile share one layout
// ---------------------------------------------------------------------------

/** Decoded block; coordinates are absolute DBU. */
export type LayoutBlock = {
  ix: number;
  iy: number;
  /** Instance index of the first stored cell; the rest follow in order. */
  firstInst: number;
  cells: { macro: Uint16Array; x: Int32Array; y: Int32Array; orient: Uint8Array };
  rects: { kind: Uint8Array; x0: Int32Array; y0: Int32Array; x1: Int32Array; y1: Int32Array; net: Uint32Array };
  vias: { def: Uint8Array; x: Int32Array; y: Int32Array; net: Uint32Array };
  /** Filler cells are not stored: rows row0 .. row0 + lead.length - 1 carry what rebuildFill needs. */
  row0: number;
  lead: Int32Array;
  tail: Int32Array;
};

export type BlockInput = {
  ix: number;
  iy: number;
  /** Origin (DBU) that coordinates are measured from. */
  ox: number;
  oy: number;
  firstInst: number;
  /** Stored cells, sorted by row then x. */
  cells: Array<{ macro: number; x: number; y: number; orient: number }>;
  rects: Array<{ kind: number; x0: number; y0: number; x1: number; y1: number; net: number }>;
  vias: Array<{ def: number; x: number; y: number; net: number }>;
  row0: number;
  lead: number[];
  tail: number[];
};

const HEADER_BYTES = 52;
/** Every stored coordinate is a multiple of the 5 nm manufacturing grid. */
export const BLOCK_GRID = 5;
const pad4 = (value: number) => (value + 3) & ~3;

type Prim = { via: boolean; type: number; x0: number; y0: number; x1: number; y1: number; net: number; source: number };

/**
 * Storage order of a block's wires and vias: net by net, and within a net in
 * route order (depth first through touching shapes), so that each position is
 * a short step from the one before. Vias count as 400 nm squares for touching.
 */
export function routeOrder(rects: BlockInput['rects'], vias: BlockInput['vias']): Prim[] {
  const prims: Prim[] = [
    ...rects.map((r, source) => ({ via: false, type: r.kind, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, net: r.net, source })),
    ...vias.map((v, source) => ({ via: true, type: v.def, x0: v.x, y0: v.y, x1: v.x, y1: v.y, net: v.net, source })),
  ];
  prims.sort((a, b) => a.net - b.net || Number(a.via) - Number(b.via) || a.type - b.type || a.x0 - b.x0 || a.y0 - b.y0 || a.x1 - b.x1 || a.y1 - b.y1);
  const out: Prim[] = [];
  const reach = (p: Prim) => (p.via ? 200 : 0);
  for (let start = 0; start < prims.length;) {
    let end = start;
    while (end < prims.length && prims[end].net === prims[start].net) end += 1;
    const group = prims.slice(start, end);
    const left = new Set(group.keys());
    // Start each route at its lowest-left shape (the group is sorted, so the first left).
    while (left.size > 0) {
      let first = -1;
      for (const k of left) if (first < 0 || group[k].x0 < group[first].x0 || (group[k].x0 === group[first].x0 && group[k].y0 < group[first].y0)) first = k;
      const stack = [first];
      left.delete(first);
      while (stack.length > 0) {
        const k = stack.pop()!;
        const a = group[k];
        out.push(a);
        const next: number[] = [];
        for (const j of left) {
          const b = group[j];
          const pad = reach(a) + reach(b);
          if (a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1) next.push(j);
        }
        for (let n = next.length - 1; n >= 0; n -= 1) {
          left.delete(next[n]);
          stack.push(next[n]);
        }
      }
    }
    start = end;
  }
  return out;
}

/** Via types are stored as 255 - definition, above every rect kind. */
const VIA_TYPE_BASE = 255;
const MAX_RECT_KIND = packKind(31, PURPOSES.length - 1);

/**
 * Serialize a block. Cells are stored at grid positions relative to the block
 * origin. Wires and vias share one stream in route order (routeOrder): each
 * one's position is a grid delta from the one before, and its net a delta
 * too (mostly zero); a wire adds its length, its width, and its direction.
 * Lengths use 16 bits when every value fits (tiles), else 32 (the global block).
 */
export function encodeBlock(input: BlockInput): Uint8Array {
  const prims = routeOrder(input.rects, input.vias);
  const cells = input.cells;
  const grid = (value: number) => {
    if (value % BLOCK_GRID !== 0) throw new Error(`coordinate ${value} is off the ${BLOCK_GRID} nm grid`);
    return value / BLOCK_GRID;
  };
  const cx = cells.map((c) => grid(c.x - input.ox));
  const cy = cells.map((c) => grid(c.y - input.oy));
  const type: number[] = [];
  const dx: number[] = [];
  const dy: number[] = [];
  const along: number[] = [];
  const across: number[] = [];
  const vertical: number[] = [];
  let px = input.ox;
  let py = input.oy;
  for (const p of prims) {
    if (p.via && p.type > VIA_TYPE_BASE - MAX_RECT_KIND - 1) throw new Error(`too many via definitions (${p.type})`);
    if (!p.via && p.type > MAX_RECT_KIND) throw new Error(`rect kind ${p.type} out of range`);
    type.push(p.via ? VIA_TYPE_BASE - p.type : p.type);
    dx.push(grid(p.x0 - px));
    dy.push(grid(p.y0 - py));
    px = p.x0;
    py = p.y0;
    if (!p.via) {
      // Length along the long side, width across it (nearly constant per layer), and which way it runs.
      const w = grid(p.x1 - p.x0);
      const h = grid(p.y1 - p.y0);
      vertical.push(h > w ? 1 : 0);
      along.push(Math.max(w, h));
      across.push(Math.min(w, h));
    }
  }
  const wide = [...cx, ...cy].some((value) => value < 0 || value > 0xffff)
    || [...dx, ...dy].some((value) => value < -0x8000 || value > 0x7fff)
    || [...along, ...across].some((value) => value > 0xffff);
  const cb = wide ? 4 : 2;
  const nC = cells.length;
  const nP = prims.length;
  const nR = along.length;
  const nRows = input.lead.length;
  let size = HEADER_BYTES;
  size = pad4(size + nC * 2) + pad4(nC * cb * 2) + pad4(nC);
  size = pad4(size + nP) + pad4(nP * cb * 2) + nP * 4;
  size = pad4(size + nR) + pad4(nR * cb * 2);
  size += nRows * 8;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let o = 0;
  const u8 = (value: number) => { view.setUint8(o, value); o += 1; };
  const u16 = (value: number) => { view.setUint16(o, value, true); o += 2; };
  const u32 = (value: number) => { view.setUint32(o, value >>> 0, true); o += 4; };
  const i32 = (value: number) => { view.setInt32(o, value, true); o += 4; };
  const unsigned = (value: number) => (wide ? u32(value) : u16(value));
  const signed = (value: number) => (wide ? i32(value) : (view.setInt16(o, value, true), (o += 2)));
  const align = () => { o = pad4(o); };
  u32(BLOCK_MAGIC); u16(BLOCK_VERSION); u16(wide ? 1 : 0);
  i32(input.ix); i32(input.iy); i32(input.ox); i32(input.oy);
  u32(nC); u32(nP); u32(nR); u32(input.firstInst); u32(BLOCK_GRID); u32(input.row0); u32(nRows);
  for (const c of cells) u16(c.macro);
  align();
  for (const value of cx) unsigned(value);
  for (const value of cy) unsigned(value);
  align();
  for (const c of cells) u8(c.orient);
  align();
  for (const value of type) u8(value);
  align();
  for (const value of dx) signed(value);
  for (const value of dy) signed(value);
  align();
  let previous = 0;
  for (const p of prims) { u32((p.net - previous) >>> 0); previous = p.net; }
  for (const value of vertical) u8(value);
  align();
  for (const value of along) unsigned(value);
  for (const value of across) unsigned(value);
  align();
  for (const value of input.lead) i32(value);
  for (const value of input.tail) i32(value);
  if (o !== size) throw new Error(`block size mismatch: wrote ${o}, planned ${size}`);
  return new Uint8Array(buffer);
}

/** Inverse of encodeBlock. Rects and vias come back in storage order. */
export function decodeBlock(bytes: Uint8Array): LayoutBlock {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BLOCK_MAGIC) throw new Error('not a layout block');
  const version = view.getUint16(4, true);
  if (version !== BLOCK_VERSION) throw new Error(`unsupported layout block version ${version}`);
  const wide = (view.getUint16(6, true) & 1) === 1;
  const ix = view.getInt32(8, true);
  const iy = view.getInt32(12, true);
  const ox = view.getInt32(16, true);
  const oy = view.getInt32(20, true);
  const nC = view.getUint32(24, true);
  const nP = view.getUint32(28, true);
  const nR = view.getUint32(32, true);
  const firstInst = view.getUint32(36, true);
  const g = view.getUint32(40, true);
  const row0 = view.getUint32(44, true);
  const nRows = view.getUint32(48, true);
  const nV = nP - nR;
  let o = HEADER_BYTES;
  const cb = wide ? 4 : 2;
  const align = () => { o = pad4(o); };
  const bytesOf = (n: number) => { const out = bytes.slice(o, o + n); o += n; return out; };
  const u16s = (n: number) => { const out = new Uint16Array(n); for (let k = 0; k < n; k += 1) out[k] = view.getUint16(o + k * 2, true); o += n * 2; return out; };
  const u32s = (n: number) => { const out = new Uint32Array(n); for (let k = 0; k < n; k += 1) out[k] = view.getUint32(o + k * 4, true); o += n * 4; return out; };
  const i32s = (n: number) => { const out = new Int32Array(n); for (let k = 0; k < n; k += 1) out[k] = view.getInt32(o + k * 4, true); o += n * 4; return out; };
  const unsigned = (n: number) => {
    const out = new Int32Array(n);
    for (let k = 0; k < n; k += 1) out[k] = (wide ? view.getUint32(o + k * 4, true) : view.getUint16(o + k * 2, true)) * g;
    o += n * cb;
    return out;
  };
  const signed = (n: number) => {
    const out = new Int32Array(n);
    for (let k = 0; k < n; k += 1) out[k] = (wide ? view.getInt32(o + k * 4, true) : view.getInt16(o + k * 2, true)) * g;
    o += n * cb;
    return out;
  };
  const macro = u16s(nC);
  align();
  const cx = unsigned(nC);
  const cy = unsigned(nC);
  align();
  const orient = bytesOf(nC);
  align();
  for (let k = 0; k < nC; k += 1) {
    cx[k] += ox;
    cy[k] += oy;
  }
  const type = bytesOf(nP);
  align();
  const dx = signed(nP);
  const dy = signed(nP);
  align();
  const netDelta = u32s(nP);
  const vertical = bytesOf(nR);
  align();
  const along = unsigned(nR);
  const across = unsigned(nR);
  align();
  const lead = i32s(nRows);
  const tail = i32s(nRows);
  const rects = { kind: new Uint8Array(nR), x0: new Int32Array(nR), y0: new Int32Array(nR), x1: new Int32Array(nR), y1: new Int32Array(nR), net: new Uint32Array(nR) };
  const vias = { def: new Uint8Array(nV), x: new Int32Array(nV), y: new Int32Array(nV), net: new Uint32Array(nV) };
  let px = ox;
  let py = oy;
  let net = 0;
  let r = 0;
  let v = 0;
  for (let k = 0; k < nP; k += 1) {
    px += dx[k];
    py += dy[k];
    net = (net + netDelta[k]) >>> 0;
    if (type[k] > MAX_RECT_KIND) {
      vias.def[v] = VIA_TYPE_BASE - type[k];
      vias.x[v] = px;
      vias.y[v] = py;
      vias.net[v] = net;
      v += 1;
    } else {
      rects.kind[r] = type[k];
      rects.x0[r] = px;
      rects.y0[r] = py;
      rects.x1[r] = px + (vertical[r] ? across[r] : along[r]);
      rects.y1[r] = py + (vertical[r] ? along[r] : across[r]);
      rects.net[r] = net;
      r += 1;
    }
  }
  return { ix, iy, firstInst, cells: { macro, x: cx, y: cy, orient }, rects, vias, row0, lead, tail };
}

// ---------------------------------------------------------------------------
// Filler cells, rebuilt
// ---------------------------------------------------------------------------

export type RowSpec = { count: number; height: number; site: number; x0: number; y0: number; x1: number; orient0: number };
export type FillSpec = { sites: number[]; macros: number[] };

/**
 * The filler cells of one block. The placer filled every gap in every row
 * greedily, largest filler first, left to right; the exporter checks this
 * against the DEF for every row, so the rebuild is exact. A gap reaching into
 * the block from the left starts at `lead`, one reaching out to the right
 * ends at `tail`; the stored cells supply the gaps between.
 */
export function rebuildFill(block: Pick<LayoutBlock, 'cells' | 'row0' | 'lead' | 'tail'>, rows: RowSpec, fill: FillSpec, widthOf: (macro: number) => number, ox: number, size: number): Array<{ macro: number; x: number; y: number; orient: number }> {
  const out: Array<{ macro: number; x: number; y: number; orient: number }> = [];
  const byRow = new Map<number, number[]>();
  for (let k = 0; k < block.cells.macro.length; k += 1) {
    const row = Math.round((block.cells.y[k] - rows.y0) / rows.height);
    const list = byRow.get(row) ?? [];
    list.push(k);
    byRow.set(row, list);
  }
  for (let r = 0; r < block.lead.length; r += 1) {
    const row = block.row0 + r;
    const y = rows.y0 + row * rows.height;
    const orient = row % 2 === 0 ? rows.orient0 : rows.orient0 === 0 ? 5 : 0;
    const emit = (start: number, end: number) => {
      let gap = Math.round((end - start) / rows.site);
      let at = start;
      fill.sites.forEach((sites, index) => {
        while (gap >= sites) {
          if (at >= ox && at < ox + size) out.push({ macro: fill.macros[index], x: at, y, orient });
          at += sites * rows.site;
          gap -= sites;
        }
      });
    };
    let cursor = block.lead[r];
    for (const k of (byRow.get(row) ?? []).sort((a, b) => block.cells.x[a] - block.cells.x[b])) {
      if (block.cells.x[k] > cursor) emit(cursor, block.cells.x[k]);
      cursor = Math.max(cursor, block.cells.x[k] + widthOf(block.cells.macro[k]));
    }
    if (block.tail[r] > cursor) emit(cursor, block.tail[r]);
  }
  return out;
}

/** A met4 strap or met1 rail of a supply net. */
export type SupplyLine = { net: number; x0: number; y0: number; x1: number; y1: number };

/**
 * The supply via stacks whose crossing point lies inside [ox, ox + size) ×
 * [oy, oy + size): one at every crossing of a met4 strap and a met1 rail of
 * the same net, each the manifest's vias and patches placed at the crossing.
 */
export function rebuildPowerStacks(straps: SupplyLine[], rails: SupplyLine[], stacks: LayoutManifest['powerStacks'], ox: number, oy: number, size: number) {
  const vias: Array<{ def: number; x: number; y: number; net: number }> = [];
  const patches: Array<{ kind: number; x0: number; y0: number; x1: number; y1: number; net: number }> = [];
  for (const strap of straps) {
    const x = (strap.x0 + strap.x1) / 2;
    if (x < ox || x >= ox + size) continue;
    for (const rail of rails) {
      if (rail.net !== strap.net) continue;
      const y = (rail.y0 + rail.y1) / 2;
      if (y < oy || y >= oy + size || x < rail.x0 || x > rail.x1 || y < strap.y0 || y > strap.y1) continue;
      for (const def of stacks.vias) vias.push({ def, x, y, net: strap.net });
      for (const [kind, x0, y0, x1, y1] of stacks.patches) patches.push({ kind, x0: x + x0, y0: y + y0, x1: x + x1, y1: y + y1, net: strap.net });
    }
  }
  return { vias, patches };
}

// ---------------------------------------------------------------------------
// Cell pins and their nets
// ---------------------------------------------------------------------------

export type NetShape = { x0: number; y0: number; x1: number; y1: number; net: number };

/**
 * The net on a cell pin, found the way an extractor would: the routed metal
 * (a via's landing pad or a wire) that overlaps one of the pin's shapes on
 * the same layer. `pinRects` are [layer, x0, y0, x1, y1] in absolute DBU;
 * `shapesOn` returns the routed shapes on a layer near a box. `conflict` is
 * set if two different nets overlap the pin (never, in a DRC-clean layout).
 */
export function pinNet(pinRects: ReadonlyArray<readonly [number, number, number, number, number]>, shapesOn: (layer: number, x0: number, y0: number, x1: number, y1: number) => Iterable<NetShape>): { net: number; conflict: boolean } {
  let net = NO_NET;
  let conflict = false;
  for (const [layer, x0, y0, x1, y1] of pinRects) {
    for (const shape of shapesOn(layer, x0, y0, x1, y1)) {
      if (shape.x0 >= x1 || shape.x1 <= x0 || shape.y0 >= y1 || shape.y1 <= y0) continue;
      if (net === NO_NET) net = shape.net;
      else if (shape.net !== net) conflict = true;
    }
  }
  return { net, conflict };
}

/** A macro's pin shapes placed at a cell's position and orientation: [layer, x0, y0, x1, y1] absolute. */
export function placedPinRects(pinRects: ReadonlyArray<readonly number[]>, pin: number, macro: { w: number; h: number }, x: number, y: number, orient: number): Array<[number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number]> = [];
  for (const r of pinRects) {
    if (r[0] !== pin) continue;
    const [a, b, c, d] = placeRect(orient, macro.w, macro.h, r[2], r[3], r[4], r[5]);
    out.push([r[1], x + a, y + b, x + c, y + d]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Net and instance chunks
// ---------------------------------------------------------------------------

/** One chunk of nets: parallel arrays, one entry per net. */
export type NetChunk = {
  first: number;
  names: string[];
  /** 's' signal, 'c' clock; one character per net. */
  use: string;
  /**
   * Tiles holding the net's metal, [ix0, iy0, ix1, iy1] (empty when unrouted).
   * The net's pins are not stored: the viewer finds them on this metal, as it
   * finds any cell pin's net (checked against the DEF for every pin).
   */
  tiles: number[][];
  /** Routed centreline length, µm (one decimal). */
  length: number[];
  /** Routing layers the net uses: bit k = ROUTING_LAYERS[k]. */
  layers: number[];
  vias: number[];
};

/** One chunk of instance names (null for filler, tap, and other unnamed physical cells). */
export type InstChunk = { first: number; names: Array<string | null> };

export const netChunkOf = (net: number) => Math.floor(net / NET_CHUNK);
export const instChunkOf = (inst: number) => Math.floor(inst / INST_CHUNK);
export const tileKey = (ix: number, iy: number) => `${ix}_${iy}`;
