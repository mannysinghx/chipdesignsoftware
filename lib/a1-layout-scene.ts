// Turns decoded A1 layout blocks into the instanced boxes the Silicon macro
// view draws, at true layer heights (the PDK's). Pure TypeScript, no three.js:
// the engine uploads what this returns, and the tests run it directly.
//
// Scene units are millimetres, as in the rest of the Silicon macro view. The
// tile's centre sits at the origin; DEF +x is scene +x and DEF +y is scene -z,
// so north is at the top of the screen when looking straight down. +y is up
// from the silicon surface.
//
// Each drawn box also records what it is (`what`: layer and category) and what
// it belongs to (`ref`: a net, or a cell of the chunk), for picking, labels,
// and the selection panel.

import {
  LAYER, LAYER_IDS, NO_NET, PURPOSE, kindLayer, kindPurpose, placeRect, placedPinRects, rebuildFill, rebuildPowerStacks,
  type CellClass, type LayerId, type LayoutBlock, type LayoutManifest, type SupplyLine,
} from './a1-layout-format.ts';
import { FLOATS_PER_INSTANCE } from './silicon-macro.ts';
import { FLOW, packPhase } from './silicon-part-ids.ts';

export const MM_PER_NM = 1e-6;
export const MM_PER_UM = 1e-3;

export const LAYOUT_MATERIALS = ['metal', 'plug', 'local', 'poly', 'ndiff', 'pdiff', 'well', 'logic', 'sequential', 'clockcell', 'physical', 'silicon'] as const;
export type LayoutMaterial = typeof LAYOUT_MATERIALS[number];

/** What a drawn box is, stored with its layer as layer | category << 5. */
export const CATEGORIES = ['wire', 'patch', 'pin', 'rail', 'strap', 'cut', 'pad', 'stack-cut', 'stack-pad', 'footprint', 'device', 'well'] as const;
export type Category = typeof CATEGORIES[number];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((id, index) => [id, index])) as Record<Category, number>;
export const packWhat = (layer: number, category: number) => (category << 5) | layer;
export const whatLayer = (what: number): LayerId => LAYER_IDS[what & 31];
export const whatCategory = (what: number): Category => CATEGORIES[what >> 5];

export type LayoutBatch = { material: LayoutMaterial; shape: 'box'; data: Float32Array; count: number; ref: Int32Array; what: Uint16Array };

/** A placed cell a chunk draws: `inst` is its instance number, or -1 for a rebuilt filler. */
export type ChunkCell = { macro: number; x: number; y: number; orient: number; inst: number };

export type LayoutChunk = {
  id: string;
  kind: 'global' | 'tile' | 'cells';
  ix: number;
  iy: number;
  /** Scene position the instance offsets are relative to. */
  origin: [number, number, number];
  /** Plan extent in scene units (x and z). */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  batches: LayoutBatch[];
  instances: number;
  yMin: number;
  yMax: number;
  cells: ChunkCell[];
};

export type LibCell = {
  geom: Array<[number, number, number, number, number]>;
  pins: number[][];
  transistors: number;
  /** Each transistor's channel (poly over diffusion), cell-local DBU: type (0 NMOS, 1 PMOS), x0, y0, x1, y1, width and length (nm), gate pin (-1: internal). */
  channels?: Array<[number, number, number, number, number, number, number, number]>;
  /** The library netlist's devices: type (0 NMOS, 1 PMOS), width and length (nm), gate, drain, source nets. */
  devices?: Array<[number, number, number, string, string, string]>;
};
export type LayoutLibrary = { macros: LibCell[] };

/** Where the tile sits: DEF → scene. */
export type Frame = { cx: number; cy: number; z: Record<LayerId, [number, number]> };

export function frameOf(manifest: LayoutManifest): Frame {
  const [x0, y0, x1, y1] = manifest.die;
  const z = Object.fromEntries(manifest.layers.map((layer) => [layer.id, [layer.z0 * MM_PER_UM, layer.z1 * MM_PER_UM]])) as Record<LayerId, [number, number]>;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z };
}

export const sceneX = (frame: Frame, x: number) => (x - frame.cx) * MM_PER_NM;
export const sceneZ = (frame: Frame, y: number) => -(y - frame.cy) * MM_PER_NM;
export const defX = (frame: Frame, x: number) => x / MM_PER_NM + frame.cx;
export const defY = (frame: Frame, z: number) => -z / MM_PER_NM + frame.cy;

export const MATERIAL_OF_LAYER: Record<LayerId, LayoutMaterial> = {
  nwell: 'well', ndiff: 'ndiff', pdiff: 'pdiff', ntap: 'ndiff', ptap: 'pdiff', poly: 'poly', licon: 'plug', pcon: 'plug', li1: 'local', mcon: 'plug',
  met1: 'metal', via: 'plug', met2: 'metal', via2: 'plug', met3: 'metal', via3: 'plug', met4: 'metal', via4: 'plug', met5: 'metal',
};
export const MATERIAL_OF_CLASS: Record<CellClass, LayoutMaterial> = { logic: 'logic', sequential: 'sequential', clock: 'clockcell', buffer: 'clockcell', fill: 'physical', tap: 'physical', diode: 'physical', decap: 'physical' };

/** Pulse spacing and speed along a path (µm and µm/s), and how much each µm of via height counts. */
export const PULSE = { period: 16, speed: 12, viaStretch: 6 } as const;
export const POWER_GLOW = 0.32;

const hash01 = (a: number, b: number, c: number) => {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

type Emit = { what: number; ref: number; glow: number; flow: number; phase: number; axis: 'x' | 'z' | 'y'; start: number; lift: boolean };

/** Accumulates boxes per material for one chunk. */
export class LayoutBuilder {
  private readonly lists = new Map<LayoutMaterial, { values: number[]; ref: number[]; what: number[] }>();
  yMin = Infinity;
  yMax = -Infinity;
  readonly origin: [number, number, number];
  constructor(origin: [number, number, number]) {
    this.origin = origin;
  }

  /** A box from scene-space bounds (mm). */
  box(material: LayoutMaterial, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, emit: Emit) {
    if (x0 >= x1 || z0 >= z1 || y0 >= y1) return;
    const tint = hash01(Math.round(x0 * 1e7), Math.round(z0 * 1e7), Math.round(y0 * 1e8));
    // Coplanar shapes on one layer overlap where they meet; a tint-sized lift of the top face stops them z-fighting.
    const top = emit.lift ? y1 + (y1 - y0) * 0.04 * tint : y1;
    const flag = emit.axis === 'x' ? 0 : emit.axis === 'z' ? 2 : 4;
    let list = this.lists.get(material);
    if (!list) this.lists.set(material, (list = { values: [], ref: [], what: [] }));
    list.values.push((x0 + x1) / 2 - this.origin[0], (y0 + top) / 2, (z0 + z1) / 2 - this.origin[2], x1 - x0, top - y0, z1 - z0, tint + flag, emit.start, emit.glow, packPhase(undefined, emit.flow as 0 | 1 | 2 | 3, emit.phase));
    list.ref.push(emit.ref);
    list.what.push(emit.what);
    this.yMin = Math.min(this.yMin, y0);
    this.yMax = Math.max(this.yMax, top);
  }

  finish(id: string, kind: LayoutChunk['kind'], ix: number, iy: number, bounds: LayoutChunk['bounds'], cells: ChunkCell[]): LayoutChunk {
    const batches: LayoutBatch[] = [];
    let instances = 0;
    for (const material of LAYOUT_MATERIALS) {
      const list = this.lists.get(material);
      if (!list || list.ref.length === 0) continue;
      const count = list.ref.length;
      instances += count;
      batches.push({ material, shape: 'box', data: new Float32Array(list.values), count, ref: Int32Array.from(list.ref), what: Uint16Array.from(list.what) });
    }
    return { id, kind, ix, iy, origin: this.origin, bounds, batches, instances, yMin: Number.isFinite(this.yMin) ? this.yMin : 0, yMax: Number.isFinite(this.yMax) ? this.yMax : 0, cells };
  }
}

export type SceneContext = {
  manifest: LayoutManifest;
  frame: Frame;
  library: LayoutLibrary | null;
  /** Nets that carry the clock. */
  clockNets: ReadonlySet<number>;
  /** The global block's met4 straps, for rebuilding each tile's supply via stacks. */
  straps: SupplyLine[];
};

const flowOf = (ctx: SceneContext, net: number) => (net === ctx.manifest.nets.vdd ? FLOW.vdd : net === ctx.manifest.nets.vss ? FLOW.vss : ctx.clockNets.has(net) ? FLOW.clock : FLOW.data);

// ---------------------------------------------------------------------------
// Signal direction: pulses leave the driving pin and run out along the net
// ---------------------------------------------------------------------------

type Node = { x0: number; y0: number; x1: number; y1: number; lo: number; hi: number; via: boolean };

/**
 * Path length (µm) at which the pulse enters each shape of one net, found by
 * a breadth-first walk from `root` through touching shapes (a via touches the
 * wires on its two layers). Shapes the walk does not reach get -1.
 */
export function pathArcs(nodes: Node[], root: number, viaStretch: number): Array<{ arc: number; from: [number, number]; down: boolean }> {
  const out = nodes.map(() => ({ arc: -1, from: [0, 0] as [number, number], down: false }));
  if (root < 0 || root >= nodes.length) return out;
  const touches = (a: Node, b: Node) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1 && a.lo <= b.hi && b.lo <= a.hi && (a.via || b.via || (a.lo === b.lo && a.hi === b.hi));
  const centre = (n: Node): [number, number] => [(n.x0 + n.x1) / 2, (n.y0 + n.y1) / 2];
  out[root] = { arc: 0, from: centre(nodes[root]), down: false };
  const queue = [root];
  while (queue.length > 0) {
    const k = queue.shift()!;
    const a = nodes[k];
    // Where the pulse leaves this shape: its far end from where it entered (a via: its top or bottom).
    const [ex, ey] = out[k].from;
    const long = a.x1 - a.x0 >= a.y1 - a.y0;
    const exitArc = a.via ? out[k].arc + (a.hi - a.lo) * 1000 * viaStretch : out[k].arc + (long ? Math.max(Math.abs(a.x1 - ex), Math.abs(a.x0 - ex)) : Math.max(Math.abs(a.y1 - ey), Math.abs(a.y0 - ey))) * 1e-3;
    for (let j = 0; j < nodes.length; j += 1) {
      if (out[j].arc >= 0 || !touches(a, nodes[j])) continue;
      const b = nodes[j];
      // Entry point: the middle of the overlap, and the arc there.
      const px = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2;
      const py = (Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2;
      const along = a.via ? 0 : (long ? Math.abs(px - ex) : Math.abs(py - ey)) * 1e-3;
      // A via entered from the layer above carries the pulse down.
      out[j] = { arc: a.via ? exitArc : out[k].arc + along, from: [px, py], down: a.lo + a.hi > b.lo + b.hi };
      queue.push(j);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

/** The supply straps of the global block (met4), for rebuildPowerStacks. */
export function strapsOf(block: LayoutBlock): SupplyLine[] {
  const out: SupplyLine[] = [];
  const r = block.rects;
  for (let k = 0; k < r.kind.length; k += 1) if (kindPurpose(r.kind[k]) === PURPOSE.stripe && kindLayer(r.kind[k]) === LAYER.met4) out.push({ net: r.net[k], x0: r.x0[k], y0: r.y0[k], x1: r.x1[k], y1: r.y1[k] });
  return out;
}

const CATEGORY_OF_PURPOSE = [CATEGORY.wire, CATEGORY.patch, CATEGORY.pin, CATEGORY.rail, CATEGORY.strap, CATEGORY.cut, CATEGORY.pad];

/**
 * Wires, vias, rails, straps, pins, rebuilt supply via stacks, and one
 * outline per placed cell (the placement view at region zoom). Pulses on a
 * signal net start at its driving pin when the driver is in this block.
 */
export function buildRoutingChunk(ctx: SceneContext, block: LayoutBlock, id: string, kind: 'global' | 'tile', only?: 'rects' | 'vias'): LayoutChunk {
  const { manifest, frame } = ctx;
  const size = manifest.tile.size;
  const ox = kind === 'global' ? manifest.die[0] : manifest.die[0] + block.ix * size;
  const oy = kind === 'global' ? manifest.die[1] : manifest.die[1] + block.iy * size;
  const ex = kind === 'global' ? manifest.die[2] : ox + size;
  const ey = kind === 'global' ? manifest.die[3] : oy + size;
  const origin: [number, number, number] = [sceneX(frame, (ox + ex) / 2), 0, sceneZ(frame, (oy + ey) / 2)];
  const builder = new LayoutBuilder(origin);
  const bounds = { x0: sceneX(frame, ox), z0: sceneZ(frame, ey), x1: sceneX(frame, ex), z1: sceneZ(frame, oy) };

  // Shapes: stored rects and vias, plus the rebuilt supply via stacks of a tile.
  type Shape = { layer: LayerId; category: number; x0: number; y0: number; x1: number; y1: number; net: number; via: number };
  const shapes: Shape[] = [];
  const r = block.rects;
  // `only` splits a block in two (the global block: its straps are always drawn, its via arrays only up close).
  if (only !== 'vias') for (let k = 0; k < r.kind.length; k += 1) shapes.push({ layer: LAYER_IDS[kindLayer(r.kind[k])], category: CATEGORY_OF_PURPOSE[kindPurpose(r.kind[k])] ?? CATEGORY.wire, x0: r.x0[k], y0: r.y0[k], x1: r.x1[k], y1: r.y1[k], net: r.net[k], via: -1 });
  const viaList: Array<{ def: number; x: number; y: number; net: number; stack: boolean }> = [];
  if (only !== 'rects') for (let k = 0; k < block.vias.def.length; k += 1) viaList.push({ def: block.vias.def[k], x: block.vias.x[k], y: block.vias.y[k], net: block.vias.net[k], stack: false });
  if (kind === 'tile') {
    const rails: SupplyLine[] = [];
    for (let k = 0; k < r.kind.length; k += 1) if (kindPurpose(r.kind[k]) === PURPOSE.rail) rails.push({ net: r.net[k], x0: r.x0[k], y0: r.y0[k], x1: r.x1[k], y1: r.y1[k] });
    const stacks = rebuildPowerStacks(ctx.straps, rails, manifest.powerStacks, ox, oy, size);
    for (const v of stacks.vias) viaList.push({ ...v, stack: true });
    for (const p of stacks.patches) shapes.push({ layer: LAYER_IDS[kindLayer(p.kind)], category: CATEGORY.patch, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, net: p.net, via: -1 });
  }
  viaList.forEach((v, index) => {
    const def = manifest.vias[v.def];
    for (const [layer, a, b, c, d] of def.rects) {
      const id = LAYER_IDS[layer];
      const cut = id === def.cut;
      shapes.push({ layer: id, category: v.stack ? (cut ? CATEGORY['stack-cut'] : CATEGORY['stack-pad']) : cut ? CATEGORY.cut : CATEGORY.pad, x0: v.x + a, y0: v.y + b, x1: v.x + c, y1: v.y + d, net: v.net, via: index });
    }
  });

  // Signal direction per net: from the via on the driver's output pin, if the driver is here.
  const arcs = new Map<number, number>(); // shape index -> entry arc (µm)
  const entries = new Map<number, [number, number]>();
  const downward = new Set<number>();
  if (ctx.library && kind === 'tile') {
    const roots = new Map<number, number>(); // net -> via index
    const pinVias = new Map<string, number[]>();
    viaList.forEach((v, index) => {
      if (v.stack) return;
      const key = `${Math.floor(v.x / 2000)}:${Math.floor(v.y / 2000)}`;
      const list = pinVias.get(key) ?? [];
      list.push(index);
      pinVias.set(key, list);
    });
    for (let c = 0; c < block.cells.macro.length; c += 1) {
      const macro = manifest.macros[block.cells.macro[c]];
      const lib = ctx.library.macros[block.cells.macro[c]];
      for (const pin of macro.signalPins) {
        if (macro.pins[pin].dir !== 'output') continue;
        for (const [layer, x0, y0, x1, y1] of placedPinRects(lib.pins, pin, macro, block.cells.x[c], block.cells.y[c], block.cells.orient[c])) {
          for (let gx = Math.floor(x0 / 2000); gx <= Math.floor(x1 / 2000); gx += 1) for (let gy = Math.floor(y0 / 2000); gy <= Math.floor(y1 / 2000); gy += 1) {
            for (const index of pinVias.get(`${gx}:${gy}`) ?? []) {
              const v = viaList[index];
              const pad = manifest.vias[v.def].rects.find((rect) => rect[0] === layer);
              if (pad && v.x + pad[1] < x1 && v.x + pad[3] > x0 && v.y + pad[2] < y1 && v.y + pad[4] > y0 && !roots.has(v.net)) roots.set(v.net, index);
            }
          }
        }
      }
    }
    // Group shapes by net and walk each driven net.
    const byNet = new Map<number, number[]>();
    shapes.forEach((shape, index) => {
      if (shape.net >= manifest.nets.vdd) return;
      const list = byNet.get(shape.net) ?? [];
      list.push(index);
      byNet.set(shape.net, list);
    });
    for (const [net, members] of byNet) {
      const rootVia = roots.get(net);
      if (rootVia === undefined || members.length > 400) continue;
      // One node per wire, one per via (spanning its bottom to top layer).
      const nodes: Node[] = [];
      const nodeOf: number[] = [];
      const viaNode = new Map<number, number>();
      for (const index of members) {
        const s = shapes[index];
        if (s.via >= 0) {
          let n = viaNode.get(s.via);
          if (n === undefined) {
            const def = manifest.vias[viaList[s.via].def];
            n = nodes.length;
            viaNode.set(s.via, n);
            nodes.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, lo: frame.z[def.bottom][0], hi: frame.z[def.top][1], via: true });
          } else {
            const node = nodes[n];
            node.x0 = Math.min(node.x0, s.x0);
            node.y0 = Math.min(node.y0, s.y0);
            node.x1 = Math.max(node.x1, s.x1);
            node.y1 = Math.max(node.y1, s.y1);
          }
          nodeOf.push(n);
        } else {
          nodeOf.push(nodes.length);
          nodes.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, lo: frame.z[s.layer][0], hi: frame.z[s.layer][1], via: false });
        }
      }
      const walked = pathArcs(nodes, viaNode.get(rootVia) ?? -1, PULSE.viaStretch);
      members.forEach((index, k) => {
        const found = walked[nodeOf[k]];
        if (found.arc < 0) return;
        arcs.set(index, found.arc);
        entries.set(index, found.from);
        if (found.down) downward.add(index);
      });
    }
  }

  const netPhase = (net: number) => hash01(net, 7, 13);
  shapes.forEach((s, index) => {
    const [z0, z1] = frame.z[s.layer];
    const x0 = sceneX(frame, s.x0);
    const x1 = sceneX(frame, s.x1);
    const zA = sceneZ(frame, s.y1);
    const zB = sceneZ(frame, s.y0);
    const flow = flowOf(ctx, s.net);
    const supply = flow === FLOW.vdd || flow === FLOW.vss;
    const cut = s.category === CATEGORY.cut || s.category === CATEGORY['stack-cut'];
    const horizontal = s.x1 - s.x0 >= s.y1 - s.y0;
    let axis: Emit['axis'] = cut ? 'y' : horizontal ? 'x' : 'z';
    let glow = s.category === CATEGORY.pin ? 0 : supply ? POWER_GLOW : 1;
    let start = 0;
    const arc = arcs.get(index);
    if (cut) {
      // VDD runs down from the straps, VSS back up; a signal goes the way its walk entered.
      start = arc ?? 0;
      if (flow === FLOW.vdd || downward.has(index)) glow = -Math.abs(glow);
      if (arc === undefined && !supply) glow = 0;
    } else if (arc !== undefined) {
      const [px, py] = entries.get(index)!;
      const fromMin = horizontal ? Math.abs(px - s.x0) <= Math.abs(px - s.x1) : Math.abs(py - s.y0) <= Math.abs(py - s.y1);
      // Scene z runs against DEF y, so "min" along z is the DEF top edge.
      const minEnd = horizontal ? fromMin : !fromMin;
      const length = (horizontal ? s.x1 - s.x0 : s.y1 - s.y0) * 1e-3;
      if (minEnd) start = arc;
      else {
        start = -(arc + length);
        glow = -glow;
      }
    } else {
      // Direction unknown here (the driver is in another tile): signal wires stay dark
      // rather than pulse the wrong way; supply metal pulses along its length.
      start = (horizontal ? x0 : zA) * 1000;
      axis = horizontal ? 'x' : 'z';
      if (!supply) glow = 0;
    }
    const material = MATERIAL_OF_LAYER[s.layer];
    builder.box(material, x0, x1, z0, z1, zA, zB, { what: packWhat(LAYER[s.layer], s.category), ref: s.net, glow, flow, phase: netPhase(s.net), axis, start, lift: !cut });
  });

  // Cell outlines: every placed cell, fillers included (rebuilt from the row gaps).
  const cells: ChunkCell[] = [];
  if (kind === 'tile') {
    for (let c = 0; c < block.cells.macro.length; c += 1) cells.push({ macro: block.cells.macro[c], x: block.cells.x[c], y: block.cells.y[c], orient: block.cells.orient[c], inst: block.firstInst + c });
    for (const f of rebuildFill(block, manifest.rows, manifest.fill, (m) => manifest.macros[m].w, ox, size)) cells.push({ ...f, inst: -1 });
    const inset = 25; // nm: a hairline between neighbouring cells
    const top = frame.z.ndiff[0] * 0.5;
    cells.forEach((cell, slot) => {
      const m = manifest.macros[cell.macro];
      builder.box(MATERIAL_OF_CLASS[m.cls], sceneX(frame, cell.x + inset), sceneX(frame, cell.x + m.w - inset), 0, top, sceneZ(frame, cell.y + m.h - inset), sceneZ(frame, cell.y + inset), { what: packWhat(LAYER.nwell, CATEGORY.footprint), ref: slot, glow: 0, flow: 0, phase: 0, axis: 'x', start: 0, lift: false });
    });
  }
  return builder.finish(id, kind, block.ix, block.iy, bounds, cells);
}

/**
 * Inside every cell of a tile: the library's own diffusion, poly, contacts,
 * li1, and met1, placed and oriented as the DEF places the cell; plus the
 * n-well, continuous along each pair of rows.
 */
export function buildCellChunk(ctx: SceneContext, block: LayoutBlock, id: string, cells: ChunkCell[]): LayoutChunk {
  const { manifest, frame, library } = ctx;
  const size = manifest.tile.size;
  const ox = manifest.die[0] + block.ix * size;
  const oy = manifest.die[1] + block.iy * size;
  const origin: [number, number, number] = [sceneX(frame, ox + size / 2), 0, sceneZ(frame, oy + size / 2)];
  const builder = new LayoutBuilder(origin);
  const bounds = { x0: sceneX(frame, ox), z0: sceneZ(frame, oy + size), x1: sceneX(frame, ox + size), z1: sceneZ(frame, oy) };
  if (!library) return builder.finish(id, 'cells', block.ix, block.iy, bounds, cells);
  cells.forEach((cell, slot) => {
    const m = manifest.macros[cell.macro];
    for (const [layer, a, b, c, d] of library.macros[cell.macro].geom) {
      const [x0, y0, x1, y1] = placeRect(cell.orient, m.w, m.h, a, b, c, d);
      const id = LAYER_IDS[layer];
      const [z0, z1] = frame.z[id];
      const cut = id === 'licon' || id === 'pcon' || id === 'mcon';
      builder.box(MATERIAL_OF_LAYER[id], sceneX(frame, cell.x + x0), sceneX(frame, cell.x + x1), z0, z1, sceneZ(frame, cell.y + y1), sceneZ(frame, cell.y + y0), { what: packWhat(layer, CATEGORY.device), ref: slot, glow: 0, flow: 0, phase: 0, axis: cut ? 'y' : 'x', start: 0, lift: !cut });
    }
  });
  // N-well: an N row carries it at the top of its cells, the FS row above at the bottom of its own,
  // so each such pair of rows shares one continuous strip (the cells' own n-well, merged).
  const rows = manifest.rows;
  const [wz0, wz1] = frame.z.nwell;
  for (let k = 0; k < block.lead.length; k += 1) {
    const row = block.row0 + k;
    const orient = row % 2 === 0 ? rows.orient0 : rows.orient0 === 0 ? 5 : 0;
    const y = rows.y0 + row * rows.height;
    // Only N rows start a strip (an FS bottom row has its own, below it).
    if (orient !== 0 && row !== 0) continue;
    const lo = orient === 0 ? y + 1305 : y - 190;
    const hi = orient !== 0 ? y + rows.height - 1305 : row + 1 < rows.count ? y + rows.height + (rows.height - 1305) : y + 2910;
    const x0 = Math.max(ox, rows.x0 - 190);
    const x1 = Math.min(ox + size, rows.x1 + 190);
    builder.box('well', sceneX(frame, x0), sceneX(frame, x1), wz0, wz1, sceneZ(frame, hi), sceneZ(frame, lo), { what: packWhat(LAYER.nwell, CATEGORY.well), ref: -1, glow: 0, flow: 0, phase: 0, axis: 'x', start: 0, lift: false });
  }
  return builder.finish(id, 'cells', block.ix, block.iy, bounds, cells);
}

export { FLOATS_PER_INSTANCE, NO_NET };

// ---------------------------------------------------------------------------
// The region view: upper routing and cell outlines only
// ---------------------------------------------------------------------------

const COARSE_LAYERS = new Set<number>([LAYER.met3, LAYER.met4, LAYER.met5]);

/**
 * A tile as the region stop draws it, from far enough that met1, met2, and
 * the vias are sub-pixel: its met3–met5 signal wiring and the outline of
 * every stored (non-filler) cell, coloured by kind. Built from the same block
 * as the full tile, so the two never differ where they overlap.
 */
export function buildCoarseChunk(ctx: SceneContext, block: LayoutBlock, id: string): LayoutChunk {
  const { manifest, frame } = ctx;
  const size = manifest.tile.size;
  const ox = manifest.die[0] + block.ix * size;
  const oy = manifest.die[1] + block.iy * size;
  const origin: [number, number, number] = [sceneX(frame, ox + size / 2), 0, sceneZ(frame, oy + size / 2)];
  const builder = new LayoutBuilder(origin);
  const bounds = { x0: sceneX(frame, ox), z0: sceneZ(frame, oy + size), x1: sceneX(frame, ox + size), z1: sceneZ(frame, oy) };
  const r = block.rects;
  for (let k = 0; k < r.kind.length; k += 1) {
    const layer = kindLayer(r.kind[k]);
    const purpose = kindPurpose(r.kind[k]);
    if (!COARSE_LAYERS.has(layer) || r.net[k] >= manifest.nets.vdd || (purpose !== PURPOSE.wire && purpose !== PURPOSE.patch)) continue;
    const id = LAYER_IDS[layer];
    const [z0, z1] = frame.z[id];
    const horizontal = r.x1[k] - r.x0[k] >= r.y1[k] - r.y0[k];
    builder.box('metal', sceneX(frame, r.x0[k]), sceneX(frame, r.x1[k]), z0, z1, sceneZ(frame, r.y1[k]), sceneZ(frame, r.y0[k]), { what: packWhat(layer, purpose === PURPOSE.wire ? CATEGORY.wire : CATEGORY.patch), ref: r.net[k], glow: 0, flow: 0, phase: 0, axis: horizontal ? 'x' : 'z', start: 0, lift: true });
  }
  const cells: ChunkCell[] = [];
  const inset = 25;
  const top = frame.z.ndiff[0] * 0.5;
  for (let c = 0; c < block.cells.macro.length; c += 1) {
    const cell = { macro: block.cells.macro[c], x: block.cells.x[c], y: block.cells.y[c], orient: block.cells.orient[c], inst: block.firstInst + c };
    const m = manifest.macros[cell.macro];
    if (m.cls === 'tap') continue;
    const slot = cells.length;
    cells.push(cell);
    builder.box(MATERIAL_OF_CLASS[m.cls], sceneX(frame, cell.x + inset), sceneX(frame, cell.x + m.w - inset), 0, top, sceneZ(frame, cell.y + m.h - inset), sceneZ(frame, cell.y + inset), { what: packWhat(LAYER.nwell, CATEGORY.footprint), ref: slot, glow: 0, flow: 0, phase: 0, axis: 'x', start: 0, lift: false });
  }
  return builder.finish(id, 'tile', block.ix, block.iy, bounds, cells);
}

// ---------------------------------------------------------------------------
// Roles of the stored cells (dot unit and pipeline stage)
// ---------------------------------------------------------------------------

export type CellRoles = { unit: Uint8Array; kind: Uint8Array };

/** The cells-meta file: units, then kinds, one byte each per stored instance. */
export function decodeRoles(bytes: Uint8Array): CellRoles {
  const n = bytes.length / 2;
  return { unit: bytes.subarray(0, n), kind: bytes.subarray(n) };
}

export const unitLabel = (unit: number) => `D[${unit >> 2}][${unit & 3}]`;

// ---------------------------------------------------------------------------
// What is in view
// ---------------------------------------------------------------------------

export type ViewStats = {
  cells: Record<string, number>;
  /** Stored cells per dot unit (16), then shared, then none. */
  units: number[];
  /** Logic cells per stage (1, 2, 3). */
  stages: [number, number, number];
  registers: Record<string, number>;
  transistors: number;
  nets: number;
  /** Wire length per routing layer (µm) and vias per cut layer. */
  wire: Record<string, number>;
  vias: Record<string, number>;
};

/**
 * Counts over the chunks' cells and shapes whose centres fall inside `rect`
 * (scene millimetres). Chunks are counted once per tile: pass the full tile
 * where it is loaded, the region chunk elsewhere.
 */
export function viewStats(chunks: LayoutChunk[], rect: { x0: number; z0: number; x1: number; z1: number }, manifest: LayoutManifest, library: LayoutLibrary | null, roles: CellRoles | null, roleKinds: readonly string[]): ViewStats {
  const out: ViewStats = { cells: {}, units: Array.from({ length: 18 }, () => 0), stages: [0, 0, 0], registers: {}, transistors: 0, nets: 0, wire: {}, vias: {} };
  const frame = frameOf(manifest);
  const inside = (x: number, z: number) => x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
  const nets = new Set<number>();
  for (const chunk of chunks) {
    const [ox, , oz] = chunk.origin;
    for (const cell of chunk.cells) {
      const m = manifest.macros[cell.macro];
      if (!inside(sceneX(frame, cell.x + m.w / 2), sceneZ(frame, cell.y + m.h / 2))) continue;
      out.cells[m.cls] = (out.cells[m.cls] ?? 0) + 1;
      if (library) out.transistors += library.macros[cell.macro].transistors;
      // Physical cells (fillers, taps, antenna diodes, decaps) serve no unit or stage.
      if (!roles || cell.inst < 0 || m.cls === 'fill' || m.cls === 'tap' || m.cls === 'diode' || m.cls === 'decap') continue;
      const unit = roles.unit[cell.inst];
      out.units[unit < 16 ? unit : unit === 16 ? 16 : 17] += 1;
      const kind = roles.kind[cell.inst];
      if (kind >= 1 && kind <= 3) out.stages[kind - 1] += 1;
      else if (kind >= 4) out.registers[roleKinds[kind]] = (out.registers[roleKinds[kind]] ?? 0) + 1;
    }
    for (const batch of chunk.batches) {
      for (let k = 0; k < batch.count; k += 1) {
        const what = batch.what[k];
        const category = whatCategory(what);
        if (category !== 'wire' && category !== 'cut') continue;
        const o = k * FLOATS_PER_INSTANCE;
        if (!inside(batch.data[o] + ox, batch.data[o + 2] + oz)) continue;
        const layer = whatLayer(what);
        if (category === 'cut') out.vias[layer] = (out.vias[layer] ?? 0) + 1;
        else out.wire[layer] = (out.wire[layer] ?? 0) + Math.max(batch.data[o + 3], batch.data[o + 5]) * 1000;
        if (batch.ref[k] < manifest.nets.vdd) nets.add(batch.ref[k]);
      }
    }
  }
  out.nets = nets.size;
  return out;
}
