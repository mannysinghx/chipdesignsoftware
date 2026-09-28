// Export a routed OpenROAD layout (DEF + the cell library's GDS and LEF) as the
// tiled data the Silicon macro view's "A1 layout" mode draws. See
// lib/a1-layout-format.ts for the files it writes. Open-source inputs only;
// nothing is fetched.
//
//   node --experimental-strip-types --max-old-space-size=12000 \
//     tools/physical/layout-export/export-layout.ts \
//     --def <run>/results/sky130hd/a1_mma_tile/base/6_final.def \
//     --platform <ORFS>/flow/platforms/sky130hd \
//     --tech <EDA>/tools/lvs/sky130A/sky130A.tech \
//     --run sky130hd-20260927T144910Z --out public/layouts/a1-sky130hd

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  INST_CHUNK, LAYER, LAYER_IDS, LAYOUT_FORMAT, NET_CHUNK, NO_NET, PURPOSE, ROUTING_LAYERS,
  decodeBlock, encodeBlock, kindLayer, kindPurpose, packKind, pinNet, placedPinRects, rebuildFill, rebuildPowerStacks, tileKey,
  type BlockInput, type CellClass, type InstChunk, type LayerId, type LayerInfo, type LayoutManifest, type MacroInfo, type NetChunk, type NetShape, type RegionGroup, type SupplyLine, type TileEntry, type ViaDef,
} from '../../../lib/a1-layout-format.ts';
import { parseDef } from './parse-def.ts';
import { parseLef } from './parse-lef.ts';
import { encodePng } from './png.ts';
import { flattenCell, readGds } from './read-gds.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<Array<[string, string]>>((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]]] : pairs), []));
const need = (key: string) => {
  if (!args[key]) throw new Error(`--${key} is required`);
  return args[key];
};
const DEF = need('def');
const PLATFORM = need('platform');
const TECH = need('tech');
const RUN = need('run');
const OUT = path.resolve(need('out'));
const TILE_UM = Number(args['tile-um'] ?? 64);
const OVERVIEW = Number(args['overview-px'] ?? 1024);
const RTL_COMMIT = args['rtl-commit'] ?? '317c297';
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)} s] ${message}`);

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const unescape = (name: string) => name.replace(/\\(.)/g, '$1');

// ---------------------------------------------------------------- inputs
const TLEF = path.join(PLATFORM, 'lef', 'sky130_fd_sc_hd.tlef');
const CLEF = path.join(PLATFORM, 'lef', 'sky130_fd_sc_hd_merged.lef');
const LIB_GDS = path.join(PLATFORM, 'gds', 'sky130_fd_sc_hd.gds');

const lef = parseLef([TLEF, CLEF]);
log(`LEF: ${lef.layers.size} layers, ${lef.vias.size} vias, ${lef.macros.size} cells`);

// Layer heights from the PDK's Magic tech file ("height <layers> <z> <thickness>", µm).
const heights = new Map<string, [number, number]>();
for (const line of readFileSync(TECH, 'utf8').split('\n')) {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'height' || t.length < 4) continue;
  for (const name of t[1].split(',')) heights.set(name, [Number(t[2]), Number(t[3])]);
}
const TECH_NAME: Record<LayerId, string> = {
  nwell: 'nwell', ndiff: 'alldiff', pdiff: 'alldiff', ntap: 'alldiff', ptap: 'alldiff', poly: 'allpoly', licon: 'alldiffcont', pcon: 'pc',
  li1: 'allli', mcon: 'mcon', met1: 'allm1', via: 'v1', met2: 'allm2', via2: 'v2', met3: 'allm3', via3: 'v3', met4: 'allm4', via4: 'v4', met5: 'allm5',
};
const LABEL: Record<LayerId, string> = {
  nwell: 'N-well', ndiff: 'N+ diffusion', pdiff: 'P+ diffusion', ntap: 'N-well tap', ptap: 'Substrate tap', poly: 'Polysilicon',
  licon: 'Diffusion contact (licon)', pcon: 'Poly contact (licon)', li1: 'Local interconnect (li1)', mcon: 'li1–met1 contact (mcon)',
  met1: 'Metal 1', via: 'Via 1', met2: 'Metal 2', via2: 'Via 2', met3: 'Metal 3', via3: 'Via 3', met4: 'Metal 4', via4: 'Via 4', met5: 'Metal 5',
};
const layers: LayerInfo[] = LAYER_IDS.map((id) => {
  const found = heights.get(TECH_NAME[id]);
  if (!found) throw new Error(`no height for ${id} (${TECH_NAME[id]}) in ${TECH}`);
  const info: LayerInfo = { id, label: LABEL[id], z0: found[0], z1: Number((found[0] + found[1]).toFixed(4)) };
  const routing = lef.layers.get(id);
  if (routing?.type === 'ROUTING') Object.assign(info, { direction: routing.direction, pitch: routing.pitch, width: routing.width });
  return info;
});
log(`stack: ${layers.map((l) => `${l.id} ${l.z0}–${l.z1}`).join(', ')}`);

const lefLayersOfVia = (name: string): [string, string] | null => {
  const via = lef.vias.get(name);
  if (!via) return null;
  const routing = [...new Set(via.rects.map((r) => r.layer))].filter((layer) => (ROUTING_LAYERS as readonly string[]).includes(layer));
  return routing.length === 2 ? [routing[0], routing[1]] : null;
};
const def = parseDef(DEF, { defaultWidth: (layer) => Math.round((lef.layers.get(layer)?.width ?? 0) * lef.dbu), viaLayers: lefLayersOfVia });
log(`DEF: ${def.components.names.length} components, ${def.nets.names.length} nets, ${def.rects.kind.length} rects, ${def.vias.def.length} vias, ${def.ioPins.length} I/O pins; ${def.warnings.length} warnings`);
for (const warning of def.warnings.slice(0, 20)) console.warn(`  warning: ${warning}`);
if (def.dbu !== lef.dbu) throw new Error(`DEF DBU ${def.dbu} != LEF DBU ${lef.dbu}`);

// ------------------------------------------------------------------ vias
const viaDefs: ViaDef[] = def.viaNames.map((name) => {
  const generated = def.generatedVias.find((via) => via.name === name);
  const rects = generated?.rects ?? lef.vias.get(name)?.rects ?? [];
  if (rects.length === 0) throw new Error(`via ${name} has no geometry`);
  const cut = rects.find((r) => !(ROUTING_LAYERS as readonly string[]).includes(r.layer))!.layer as LayerId;
  const metals = [...new Set(rects.map((r) => r.layer).filter((layer) => layer !== cut))].sort((a, b) => LAYER[a as LayerId] - LAYER[b as LayerId]) as LayerId[];
  return { name, bottom: metals[0], cut, top: metals[1], rects: rects.map((r) => [LAYER[r.layer as LayerId], r.x0, r.y0, r.x1, r.y1] as [number, number, number, number, number]) };
});

// ---------------------------------------------------------------- macros
function classify(name: string): CellClass {
  const base = name.replace('sky130_fd_sc_hd__', '');
  if (base.startsWith('fill')) return 'fill';
  if (base.startsWith('tap')) return 'tap';
  if (base.startsWith('diode')) return 'diode';
  if (base.startsWith('decap')) return 'decap';
  if (base.startsWith('clk') || base.startsWith('dlyg') || base.startsWith('dlymetal')) return 'clock';
  if (/^(buf|bufbuf|bufinv|probe_p|lpflow_.*buf)/.test(base)) return 'buffer';
  if (/^(e?df|e?sdf|dl[xr]|dlclkp|sdlclkp|edfxbp|dfbbn|dfbbp|dfsbp|dfrbp|dfrtp|dfrtn|dfstp|dfxbp|dfxtp)/.test(base)) return 'sequential';
  return 'logic';
}
const usedMacros = [...new Set(def.components.macro)].sort();
const macroIndex = new Map(usedMacros.map((name, index) => [name, index]));
const macros: MacroInfo[] = usedMacros.map((name) => {
  const m = lef.macros.get(name);
  if (!m) throw new Error(`cell ${name} is not in the LEF`);
  const pins = m.pins.map((pin) => ({
    name: pin.name,
    dir: pin.direction === 'OUTPUT' ? 'output' as const : pin.direction === 'INOUT' ? 'inout' as const : 'input' as const,
    use: pin.use === 'CLOCK' ? 'clock' as const : pin.use === 'POWER' ? 'power' as const : pin.use === 'GROUND' ? 'ground' as const : 'signal' as const,
  }));
  return { name, w: m.w, h: m.h, cls: classify(name), pins, signalPins: pins.flatMap((pin, index) => (pin.use === 'signal' || pin.use === 'clock' ? [index] : [])), count: 0 };
});
const compMacro = Uint16Array.from(def.components.macro, (name) => macroIndex.get(name)!);
for (const m of compMacro) macros[m].count += 1;

// ------------------------------------------------------ library geometry
const gds = readGds(LIB_GDS);
if (Math.abs(gds.dbuInMeters - 1e-9) > 1e-15) throw new Error(`library GDS unit ${gds.dbuInMeters} m, expected 1 nm`);
type R = [number, number, number, number];
const overlap = (a: R, b: R): R | null => {
  const r: R = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
};
const touches = (a: R, b: R) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const GDS_LAYER: Record<string, string> = { '64/20': 'nwell', '65/20': 'diff', '65/44': 'tap', '66/20': 'poly', '66/44': 'licon', '67/20': 'li1', '67/44': 'mcon', '68/20': 'met1', '93/44': 'nsdm', '94/20': 'psdm' };
let libTransistors = 0;
const library = macros.map((macro, index) => {
  const byLayer = new Map<string, R[]>();
  for (const r of flattenCell(gds, macro.name)) {
    const name = GDS_LAYER[`${r.layer}/${r.datatype}`];
    if (!name) continue;
    const list = byLayer.get(name) ?? [];
    list.push([r.x0, r.y0, r.x1, r.y1]);
    byLayer.set(name, list);
  }
  const get = (name: string) => byLayer.get(name) ?? [];
  const geom: Array<[number, number, number, number, number]> = [];
  const add = (layer: LayerId, r: R) => geom.push([LAYER[layer], r[0], r[1], r[2], r[3]]);
  const implant = (list: R[], nLayer: LayerId, pLayer: LayerId) => {
    for (const r of list) {
      for (const n of get('nsdm')) { const o = overlap(r, n); if (o) add(nLayer, o); }
      for (const p of get('psdm')) { const o = overlap(r, p); if (o) add(pLayer, o); }
    }
  };
  implant(get('diff'), 'ndiff', 'pdiff');
  implant(get('tap'), 'ntap', 'ptap');
  for (const r of get('poly')) add('poly', r);
  for (const r of get('licon')) add(get('poly').some((p) => overlap(r, p)) ? 'pcon' : 'licon', r);
  for (const r of get('li1')) add('li1', r);
  for (const r of get('mcon')) add('mcon', r);
  // The met1 supply rails are drawn once per row from the DEF (FOLLOWPIN), not per cell.
  const lefMacro = lef.macros.get(macro.name)!;
  const rails = lefMacro.pins.filter((pin) => pin.use === 'POWER' || pin.use === 'GROUND').flatMap((pin) => pin.rects.filter((r) => r.layer === 'met1').map((r) => [r.x0, r.y0, r.x1, r.y1] as R));
  for (const r of get('met1')) if (!rails.some((rail) => r[0] >= rail[0] && r[1] >= rail[1] && r[2] <= rail[2] && r[3] <= rail[3])) add('met1', r);
  // Transistors: connected patches of poly over diffusion.
  const channels: R[] = [];
  for (const d of get('diff')) for (const p of get('poly')) { const o = overlap(d, p); if (o) channels.push(o); }
  const parent = channels.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  for (let a = 0; a < channels.length; a += 1) for (let b = a + 1; b < channels.length; b += 1) if (touches(channels[a], channels[b])) parent[find(a)] = find(b);
  const transistors = new Set(channels.map((_, k) => find(k))).size;
  libTransistors += transistors * macros[index].count;
  const pinRects = lefMacro.pins.flatMap((pin, pinIndex) => (macro.signalPins.includes(pinIndex) ? pin.rects.filter((r) => LAYER[r.layer as LayerId] !== undefined).map((r) => [pinIndex, LAYER[r.layer as LayerId], r.x0, r.y0, r.x1, r.y1]) : []));
  return { geom, pins: pinRects, transistors };
});
log(`library: ${library.reduce((sum, cell) => sum + cell.geom.length, 0)} shapes over ${macros.length} cells; ${libTransistors} transistors placed; ${gds.nonManhattan} non-Manhattan shapes`);

// ------------------------------------------------------------------- nets
const N = def.nets.names.length;
const VDD = N;
const VSS = N + 1;
const netOf = (raw: number) => (raw === -1 ? VDD : raw === -2 ? VSS : raw);
const netByName = new Map(def.nets.names.map((name, index) => [name, index]));
// I/O pin shapes (the supply pins duplicate the met5 straps and are left out).
for (const pin of def.ioPins) {
  if (pin.use === 'POWER' || pin.use === 'GROUND') continue;
  const net = netByName.get(pin.net);
  if (net === undefined) continue;
  for (const r of pin.rects) {
    if (LAYER[r.layer as LayerId] === undefined) continue;
    def.rects.kind.push(packKind(LAYER[r.layer as LayerId], PURPOSE.pin));
    def.rects.x0.push(r.x0); def.rects.y0.push(r.y0); def.rects.x1.push(r.x1); def.rects.y1.push(r.y1);
    def.rects.net.push(net); def.rects.centerline.push(0);
  }
}

// Each placed cell's signal-pin nets from the DEF (to check the viewer's derivation against).
const pinIndex = macros.map((m) => new Map(m.pins.map((pin, index) => [pin.name, index])));
const defPinNet = new Map<number, number>(); // inst * 64 + pin -> net
for (let n = 0; n < N; n += 1) {
  for (let k = def.nets.pinStart[n]; k < def.nets.pinStart[n + 1]; k += 1) {
    const inst = def.nets.pinInst.get(k);
    if (inst < 0) continue; // an I/O pin
    const pin = pinIndex[compMacro[inst]].get(def.nets.pinName[k]);
    if (pin === undefined) throw new Error(`net ${def.nets.names[n]}: ${def.nets.pinName[k]} is not a pin of ${macros[compMacro[inst]].name}`);
    defPinNet.set(inst * 64 + pin, n);
  }
}

// Per-net geometry summary: box, length, layers, vias.
const netBox = new Int32Array((N + 2) * 4);
for (let k = 0; k < netBox.length; k += 4) { netBox[k] = 2 ** 31 - 1; netBox[k + 1] = 2 ** 31 - 1; netBox[k + 2] = -(2 ** 31); netBox[k + 3] = -(2 ** 31); }
const netLength = new Float64Array(N + 2);
const netLayers = new Uint8Array(N + 2);
const netVias = new Uint32Array(N + 2);
const grow = (net: number, x0: number, y0: number, x1: number, y1: number) => {
  const o = net * 4;
  if (x0 < netBox[o]) netBox[o] = x0;
  if (y0 < netBox[o + 1]) netBox[o + 1] = y0;
  if (x1 > netBox[o + 2]) netBox[o + 2] = x1;
  if (y1 > netBox[o + 3]) netBox[o + 3] = y1;
};
const wire: Record<string, number> = Object.fromEntries(ROUTING_LAYERS.map((l) => [l, 0]));
const powerWire: Record<string, number> = Object.fromEntries(ROUTING_LAYERS.map((l) => [l, 0]));
const R = def.rects;
for (let k = 0; k < R.kind.length; k += 1) {
  const net = netOf(R.net.get(k));
  const layer = LAYER_IDS[kindLayer(R.kind.get(k))];
  grow(net, R.x0.get(k), R.y0.get(k), R.x1.get(k), R.y1.get(k));
  const routingIndex = (ROUTING_LAYERS as readonly string[]).indexOf(layer);
  if (routingIndex < 0) continue;
  const length = R.centerline.get(k) / def.dbu;
  netLength[net] += length;
  netLayers[net] |= 1 << routingIndex;
  (net >= N ? powerWire : wire)[layer] += length;
}
const viaCounts: Record<string, number> = {};
const V = def.vias;
for (let k = 0; k < V.def.length; k += 1) {
  const net = netOf(V.net.get(k));
  const via = viaDefs[V.def.get(k)];
  netVias[net] += 1;
  for (const [, x0, y0, x1, y1] of via.rects) grow(net, V.x.get(k) + x0, V.y.get(k) + y0, V.x.get(k) + x1, V.y.get(k) + y1);
  viaCounts[via.cut] = (viaCounts[via.cut] ?? 0) + 1;
}

// ---------------------------------------------------------------- tiling
const [dieX0, dieY0, dieX1, dieY1] = def.die;
const T = Math.round(TILE_UM * def.dbu);
const nx = Math.ceil((dieX1 - dieX0) / T);
const ny = Math.ceil((dieY1 - dieY0) / T);
const rowSpec = { count: def.rows.count, height: def.rows.height, site: def.rows.site, x0: def.rows.x0, y0: def.rows.y0, x1: def.rows.x1, orient0: def.rows.orient0 };
const FILL_SITES = [8, 4, 2, 1];
const fillMacros = FILL_SITES.map((sites) => macroIndex.get(`sky130_fd_sc_hd__fill_${sites}`) ?? -1);
if (fillMacros.some((m) => m < 0)) throw new Error('a filler cell size is missing from the design');
const fillSpec = { sites: FILL_SITES, macros: fillMacros };
const isFill = (m: number) => fillMacros.includes(m);

type Tile = BlockInput & { fills: Array<{ macro: number; x: number; y: number }>; defInst: number[] };
const tiles: Tile[] = [];
for (let iy = 0; iy < ny; iy += 1) for (let ix = 0; ix < nx; ix += 1) {
  tiles.push({ ix, iy, ox: dieX0 + ix * T, oy: dieY0 + iy * T, firstInst: 0, cells: [], rects: [], vias: [], row0: 0, lead: [], tail: [], fills: [], defInst: [] });
}
const tileIndexAt = (x: number, y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - dieY0) / T))) * nx + Math.min(nx - 1, Math.max(0, Math.floor((x - dieX0) / T)));
const global: BlockInput = { ix: -1, iy: -1, ox: dieX0, oy: dieY0, firstInst: 0, cells: [], rects: [], vias: [], row0: 0, lead: [], tail: [] };

// Cells by origin, sorted by row then x within each tile; fillers are kept aside to check the rebuild.
const byPosition = Array.from(compMacro.keys()).sort((a, b) => def.components.y[a] - def.components.y[b] || def.components.x[a] - def.components.x[b]);
for (const inst of byPosition) {
  const tile = tiles[tileIndexAt(def.components.x[inst], def.components.y[inst])];
  const cell = { macro: compMacro[inst], x: def.components.x[inst], y: def.components.y[inst], orient: def.components.orient[inst] };
  if (isFill(cell.macro)) tile.fills.push(cell);
  else {
    tile.cells.push(cell);
    tile.defInst.push(inst);
  }
}
// Instances are numbered in tile order.
const viewOf = new Int32Array(compMacro.length).fill(-1);
const defOf: number[] = [];
for (const tile of tiles) {
  tile.firstInst = defOf.length;
  for (const inst of tile.defInst) {
    viewOf[inst] = defOf.length;
    defOf.push(inst);
  }
}
// Row gaps crossing each tile's left and right edges.
const rowCells: number[][] = Array.from({ length: rowSpec.count }, () => []);
for (const inst of byPosition) if (!isFill(compMacro[inst])) rowCells[Math.round((def.components.y[inst] - rowSpec.y0) / rowSpec.height)].push(inst);
for (const tile of tiles) {
  const first = Math.max(0, Math.ceil((tile.oy - rowSpec.y0) / rowSpec.height));
  const last = Math.min(rowSpec.count - 1, Math.ceil((tile.oy + T - rowSpec.y0) / rowSpec.height) - 1);
  tile.row0 = first;
  for (let row = first; row <= last; row += 1) {
    let lead = rowSpec.x0;
    let tail = rowSpec.x1;
    for (const inst of rowCells[row]) {
      const x = def.components.x[inst];
      if (x < tile.ox) lead = Math.max(lead, x + macros[compMacro[inst]].w);
      else if (x >= tile.ox + T) {
        tail = x;
        break;
      }
    }
    tile.lead.push(lead);
    tile.tail.push(tail);
  }
}
// Supply via stacks: found at every same-net crossing of a met4 strap and a
// met1 rail, checked shape for shape against the DEF, then rebuilt by the
// viewer instead of stored.
const straps: SupplyLine[] = [];
const rails: SupplyLine[] = [];
for (let k = 0; k < R.kind.length; k += 1) {
  const kind = R.kind.get(k);
  const net = netOf(R.net.get(k));
  if (net < N) continue;
  const line = { net, x0: R.x0.get(k), y0: R.y0.get(k), x1: R.x1.get(k), y1: R.y1.get(k) };
  if (kindPurpose(kind) === PURPOSE.stripe && kindLayer(kind) === LAYER.met4) straps.push(line);
  else if (kindPurpose(kind) === PURPOSE.rail && kindLayer(kind) === LAYER.met1) rails.push(line);
}
const skipRect = new Uint8Array(R.kind.length);
const skipVia = new Uint8Array(V.def.length);
const powerStacks: LayoutManifest['powerStacks'] = { vias: [], patches: [] };
{
  // The stack's shape, learned from the first crossing, then required at every crossing.
  const crossing = (() => {
    for (const strap of straps) for (const rail of rails) {
      const x = (strap.x0 + strap.x1) / 2;
      const y = (rail.y0 + rail.y1) / 2;
      if (rail.net === strap.net && x >= rail.x0 && x <= rail.x1 && y >= strap.y0 && y <= strap.y1) return { x, y, net: strap.net };
    }
    return null;
  })();
  const powerVias = new Map<string, number[]>();
  for (let k = 0; k < V.def.length; k += 1) {
    if (netOf(V.net.get(k)) < N || viaDefs[V.def.get(k)].bottom === 'met4') continue;
    const at = `${V.x.get(k)}:${V.y.get(k)}`;
    const list = powerVias.get(at) ?? [];
    list.push(k);
    powerVias.set(at, list);
  }
  const powerPatches = new Map<string, number[]>();
  for (let k = 0; k < R.kind.length; k += 1) {
    if (netOf(R.net.get(k)) < N || kindPurpose(R.kind.get(k)) !== PURPOSE.patch) continue;
    const at = `${(R.x0.get(k) + R.x1.get(k)) / 2}:${(R.y0.get(k) + R.y1.get(k)) / 2}`;
    const list = powerPatches.get(at) ?? [];
    list.push(k);
    powerPatches.set(at, list);
  }
  if (crossing) {
    const key = `${crossing.x}:${crossing.y}`;
    powerStacks.vias = (powerVias.get(key) ?? []).map((k) => V.def.get(k)).sort((a, b) => LAYER[viaDefs[a].cut] - LAYER[viaDefs[b].cut]);
    powerStacks.patches = (powerPatches.get(key) ?? []).map((k) => [R.kind.get(k), R.x0.get(k) - crossing.x, R.y0.get(k) - crossing.y, R.x1.get(k) - crossing.x, R.y1.get(k) - crossing.y] as [number, number, number, number, number]).sort((a, b) => a[0] - b[0]);
  }
  const rebuilt = rebuildPowerStacks(straps, rails, powerStacks, dieX0, dieY0, Math.max(dieX1 - dieX0, dieY1 - dieY0) + 1);
  const viaKey = (def: number, x: number, y: number, net: number) => `${def}:${x}:${y}:${net}`;
  const actualVias = new Map<string, number>();
  for (const list of powerVias.values()) for (const k of list) actualVias.set(viaKey(V.def.get(k), V.x.get(k), V.y.get(k), netOf(V.net.get(k))), k);
  const rectKey = (kind: number, x0: number, y0: number, x1: number, y1: number, net: number) => `${kind}:${x0}:${y0}:${x1}:${y1}:${net}`;
  const actualPatches = new Map<string, number>();
  for (const list of powerPatches.values()) for (const k of list) actualPatches.set(rectKey(R.kind.get(k), R.x0.get(k), R.y0.get(k), R.x1.get(k), R.y1.get(k), netOf(R.net.get(k))), k);
  let missing = 0;
  for (const v of rebuilt.vias) {
    const k = actualVias.get(viaKey(v.def, v.x, v.y, v.net));
    if (k === undefined) missing += 1;
    else skipVia[k] = 1;
  }
  for (const r of rebuilt.patches) {
    const k = actualPatches.get(rectKey(r.kind, r.x0, r.y0, r.x1, r.y1, r.net));
    if (k === undefined) missing += 1;
    else skipRect[k] = 1;
  }
  const leftover = [...actualVias.values()].filter((k) => !skipVia[k]).length + [...actualPatches.values()].filter((k) => !skipRect[k]).length;
  if (missing > 0) throw new Error(`power stacks: ${missing} rebuilt shapes are not in the DEF`);
  log(`power stacks: ${rebuilt.vias.length / Math.max(1, powerStacks.vias.length)} crossings rebuilt exactly (${rebuilt.vias.length} vias, ${rebuilt.patches.length} patches); ${leftover} other supply vias and patches stay stored`);
}

// Rects: the met4/met5 straps and I/O pins go to the global block whole; the rest is cut at tile edges.
for (let k = 0; k < R.kind.length; k += 1) {
  if (skipRect[k]) continue;
  const kind = R.kind.get(k);
  const purpose = kindPurpose(kind);
  const layer = kindLayer(kind);
  const net = netOf(R.net.get(k));
  const x0 = R.x0.get(k);
  const y0 = R.y0.get(k);
  const x1 = R.x1.get(k);
  const y1 = R.y1.get(k);
  if (purpose === PURPOSE.pin || (purpose === PURPOSE.stripe && layer >= LAYER.met4)) {
    global.rects.push({ kind, x0, y0, x1, y1, net });
    continue;
  }
  const i0 = Math.max(0, Math.floor((x0 - dieX0) / T));
  const i1 = Math.min(nx - 1, Math.floor((x1 - 1 - dieX0) / T));
  const j0 = Math.max(0, Math.floor((y0 - dieY0) / T));
  const j1 = Math.min(ny - 1, Math.floor((y1 - 1 - dieY0) / T));
  for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) {
    const tile = tiles[j * nx + i];
    const cx0 = Math.max(x0, tile.ox);
    const cy0 = Math.max(y0, tile.oy);
    const cx1 = Math.min(x1, tile.ox + T);
    const cy1 = Math.min(y1, tile.oy + T);
    if (cx0 < cx1 && cy0 < cy1) tile.rects.push({ kind, x0: cx0, y0: cy0, x1: cx1, y1: cy1, net });
  }
}
// Vias: the met4-met5 supply arrays go to the global block, the rest to the tile holding their origin.
for (let k = 0; k < V.def.length; k += 1) {
  if (skipVia[k]) continue;
  const index = V.def.get(k);
  const net = netOf(V.net.get(k));
  const entry = { def: index, x: V.x.get(k), y: V.y.get(k), net };
  if (net >= N && viaDefs[index].bottom === 'met4') global.vias.push(entry);
  else tiles[tileIndexAt(entry.x, entry.y)].vias.push(entry);
}
log(`tiling: ${nx} × ${ny} tiles of ${TILE_UM} µm; ${defOf.length} stored cells; global block ${global.rects.length} rects, ${global.vias.length} vias`);

// ----------------------------------------------------- check the rebuilds
// 1. Filler cells: rebuild every tile's from the stored cells and compare with the DEF's.
{
  let checked = 0;
  for (const tile of tiles) {
    const block = decodeBlock(encodeBlock(tile));
    const rebuilt = rebuildFill(block, rowSpec, fillSpec, (m) => macros[m].w, tile.ox, T).map((c) => `${c.macro}:${c.x}:${c.y}`).sort();
    const actual = tile.fills.map((c) => `${c.macro}:${c.x}:${c.y}`).sort();
    if (rebuilt.length !== actual.length || rebuilt.some((key, k) => key !== actual[k])) throw new Error(`tile ${tile.ix},${tile.iy}: rebuilt ${rebuilt.length} fillers, the DEF has ${actual.length}`);
    checked += actual.length;
  }
  log(`fillers: all ${checked} rebuilt exactly from row gaps`);
}
// 2. Every block decodes to exactly the shapes it was given.
{
  const same = (block: BlockInput) => {
    const decoded = decodeBlock(encodeBlock(block));
    const r = decoded.rects;
    const got = Array.from(r.kind, (kind, k) => `${kind}:${r.x0[k]}:${r.y0[k]}:${r.x1[k]}:${r.y1[k]}:${r.net[k]}`).sort();
    const want = block.rects.map((x) => `${x.kind}:${x.x0}:${x.y0}:${x.x1}:${x.y1}:${x.net}`).sort();
    const v = decoded.vias;
    const gotV = Array.from(v.def, (d, k) => `${d}:${v.x[k]}:${v.y[k]}:${v.net[k]}`).sort();
    const wantV = block.vias.map((x) => `${x.def}:${x.x}:${x.y}:${x.net}`).sort();
    const c = decoded.cells;
    const gotC = Array.from(c.macro, (m, k) => `${m}:${c.x[k]}:${c.y[k]}:${c.orient[k]}`).join('|');
    const wantC = block.cells.map((x) => `${x.macro}:${x.x}:${x.y}:${x.orient}`).join('|');
    return got.length === want.length && got.every((key, k) => key === want[k]) && gotV.length === wantV.length && gotV.every((key, k) => key === wantV[k]) && gotC === wantC && decoded.firstInst === block.firstInst;
  };
  const bad = [...tiles, global].filter((block) => !same(block));
  if (bad.length > 0) throw new Error(`${bad.length} blocks do not decode to their shapes`);
  log(`round trip: all ${tiles.length + 1} blocks decode to exactly their shapes`);
}
// 3. Pin nets: the metal on each signal pin must be the net the DEF connects it to.
{
  const BUCKET = 2000;
  const index = new Map<number, NetShape[]>();
  const key = (layer: number, gx: number, gy: number) => (layer * 4096 + gx) * 4096 + gy;
  const insert = (layer: number, shape: NetShape) => {
    for (let gx = Math.floor(shape.x0 / BUCKET); gx <= Math.floor(shape.x1 / BUCKET); gx += 1) for (let gy = Math.floor(shape.y0 / BUCKET); gy <= Math.floor(shape.y1 / BUCKET); gy += 1) {
      const list = index.get(key(layer, gx, gy));
      if (list) list.push(shape);
      else index.set(key(layer, gx, gy), [shape]);
    }
  };
  for (let k = 0; k < R.kind.length; k += 1) {
    const net = netOf(R.net.get(k));
    const layer = kindLayer(R.kind.get(k));
    if (net < N && layer <= LAYER.met1) insert(layer, { x0: R.x0.get(k), y0: R.y0.get(k), x1: R.x1.get(k), y1: R.y1.get(k), net });
  }
  for (let k = 0; k < V.def.length; k += 1) {
    const net = netOf(V.net.get(k));
    if (net >= N) continue;
    for (const [layer, x0, y0, x1, y1] of viaDefs[V.def.get(k)].rects) if (layer <= LAYER.met1) insert(layer, { x0: V.x.get(k) + x0, y0: V.y.get(k) + y0, x1: V.x.get(k) + x1, y1: V.y.get(k) + y1, net });
  }
  const shapesOn = function* (layer: number, x0: number, y0: number, x1: number, y1: number) {
    for (let gx = Math.floor(x0 / BUCKET); gx <= Math.floor(x1 / BUCKET); gx += 1) for (let gy = Math.floor(y0 / BUCKET); gy <= Math.floor(y1 / BUCKET); gy += 1) yield* index.get(key(layer, gx, gy)) ?? [];
  };
  let agree = 0;
  let unconnected = 0;
  const wrong: string[] = [];
  for (const inst of defOf) {
    const m = macros[compMacro[inst]];
    for (const pin of m.signalPins) {
      const expected = defPinNet.get(inst * 64 + pin) ?? NO_NET;
      const found = pinNet(placedPinRects(library[compMacro[inst]].pins, pin, m, def.components.x[inst], def.components.y[inst], def.components.orient[inst]), shapesOn);
      if (found.net === expected && !found.conflict) {
        if (expected === NO_NET) unconnected += 1;
        else agree += 1;
      } else if (expected !== NO_NET && def.nets.pinStart[expected + 1] - def.nets.pinStart[expected] === 1 && found.net === NO_NET) {
        // A net with this pin alone has no routing to find: count it as unconnected.
        unconnected += 1;
      } else wrong.push(`${def.components.names[inst]}/${m.pins[pin].name}: DEF ${expected === NO_NET ? '-' : def.nets.names[expected]}, metal ${found.net === NO_NET ? '-' : def.nets.names[found.net]}${found.conflict ? ' (conflict)' : ''}`);
    }
  }
  log(`pin nets: ${agree} found on the metal, ${unconnected} unconnected, ${wrong.length} disagree`);
  for (const line of wrong.slice(0, 12)) console.warn(`  ${line}`);
  if (wrong.length > 0) throw new Error(`${wrong.length} pin nets cannot be derived from the metal`);
}

// --------------------------------------------------------------- output
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'tiles'), { recursive: true });
mkdirSync(path.join(OUT, 'nets'), { recursive: true });
mkdirSync(path.join(OUT, 'insts'), { recursive: true });
let totalBytes = 0;
const write = (relative: string, bytes: Uint8Array | string) => {
  writeFileSync(path.join(OUT, relative), bytes);
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
  totalBytes += size;
  return size;
};
const gz = (bytes: Uint8Array | string) => gzipSync(bytes, { level: 9 });

const entries: TileEntry[] = [];
let tileBytes = 0;
for (const tile of tiles) {
  if (tile.cells.length === 0 && tile.fills.length === 0 && tile.rects.length === 0 && tile.vias.length === 0) continue;
  const bytes = write(`tiles/${tileKey(tile.ix, tile.iy)}.bin.gz`, gz(encodeBlock(tile)));
  tileBytes += bytes;
  entries.push({ ix: tile.ix, iy: tile.iy, bytes, cells: tile.cells.length + tile.fills.length, rects: tile.rects.length, vias: tile.vias.length });
}
const globalBytes = write('global.bin.gz', gz(encodeBlock(global)));
log(`tiles: ${entries.length} files, ${(tileBytes / 1e6).toFixed(2)} MB; global ${(globalBytes / 1e3).toFixed(0)} kB`);

// Nets, in chunks.
let netBytes = 0;
const netChunks = Math.ceil(N / NET_CHUNK);
for (let c = 0; c < netChunks; c += 1) {
  const first = c * NET_CHUNK;
  const last = Math.min(N, first + NET_CHUNK);
  const chunk: NetChunk = { first, names: [], use: '', tiles: [], length: [], layers: [], vias: [] };
  const tileOf = (value: number, origin: number, count: number) => Math.min(count - 1, Math.max(0, Math.floor((value - origin) / T)));
  for (let n = first; n < last; n += 1) {
    chunk.names.push(unescape(def.nets.names[n]));
    chunk.use += def.nets.use[n] === 'CLOCK' ? 'c' : 's';
    const o = n * 4;
    chunk.tiles.push(netBox[o] <= netBox[o + 2] ? [tileOf(netBox[o], dieX0, nx), tileOf(netBox[o + 1], dieY0, ny), tileOf(netBox[o + 2] - 1, dieX0, nx), tileOf(netBox[o + 3] - 1, dieY0, ny)] : []);
    chunk.length.push(Math.round(netLength[n] * 10) / 10);
    chunk.layers.push(netLayers[n]);
    chunk.vias.push(netVias[n]);
  }
  netBytes += write(`nets/${c}.json.gz`, gz(JSON.stringify(chunk)));
}
log(`nets: ${netChunks} chunks, ${(netBytes / 1e6).toFixed(2)} MB`);
if (defOf.some((inst) => viewOf[inst] < 0)) throw new Error('an instance was not numbered');

// Instance names in tile order (tap cells stay unnamed).
let instBytes = 0;
let named = 0;
const instChunks = Math.ceil(defOf.length / INST_CHUNK);
for (let c = 0; c < instChunks; c += 1) {
  const first = c * INST_CHUNK;
  const chunk: InstChunk = { first, names: [] };
  for (let k = first; k < Math.min(defOf.length, first + INST_CHUNK); k += 1) {
    const inst = defOf[k];
    const keep = macros[compMacro[inst]].cls !== 'tap';
    chunk.names.push(keep ? unescape(def.components.names[inst]) : null);
    if (keep) named += 1;
  }
  instBytes += write(`insts/${c}.json.gz`, gz(JSON.stringify(chunk)));
}
log(`instances: ${instChunks} chunks, ${named} named, ${(instBytes / 1e6).toFixed(2)} MB`);

const libBytes = write('lib.json.gz', gz(JSON.stringify({ macros: library })));
log(`library geometry: ${(libBytes / 1e3).toFixed(0)} kB`);

// ------------------------------------------------------ overview images
const W = dieX1 - dieX0;
const H = dieY1 - dieY0;
const px = OVERVIEW;
const cover = Array.from({ length: 8 }, () => new Float32Array(px * px));
const raster = (channel: number, x0: number, y0: number, x1: number, y1: number) => {
  const u0 = (x0 - dieX0) * (px / W);
  const u1 = (x1 - dieX0) * (px / W);
  const v0 = (dieY1 - y1) * (px / H);
  const v1 = (dieY1 - y0) * (px / H);
  const target = cover[channel];
  for (let j = Math.max(0, Math.floor(v0)); j < Math.min(px, Math.ceil(v1)); j += 1) {
    const dv = Math.min(v1, j + 1) - Math.max(v0, j);
    for (let i = Math.max(0, Math.floor(u0)); i < Math.min(px, Math.ceil(u1)); i += 1) target[j * px + i] += (Math.min(u1, i + 1) - Math.max(u0, i)) * dv;
  }
};
// Metal: li1+met1, met2, met3, met4 signal routing (supply metal is drawn as geometry).
for (let k = 0; k < R.kind.length; k += 1) {
  const layer = kindLayer(R.kind.get(k));
  const purpose = kindPurpose(R.kind.get(k));
  if (purpose === PURPOSE.rail || purpose === PURPOSE.stripe || netOf(R.net.get(k)) >= N) continue;
  const channel = layer <= LAYER.met1 ? 0 : layer === LAYER.met2 ? 1 : layer === LAYER.met3 ? 2 : layer === LAYER.met4 ? 3 : -1;
  if (channel >= 0) raster(channel, R.x0.get(k), R.y0.get(k), R.x1.get(k), R.y1.get(k));
}
// Cells: combinational logic, registers, clock tree and buffers, physical-only cells.
const CELL_CHANNEL: Record<CellClass, number> = { logic: 4, sequential: 5, clock: 6, buffer: 6, fill: 7, tap: 7, diode: 7, decap: 7 };
for (let inst = 0; inst < compMacro.length; inst += 1) {
  const m = macros[compMacro[inst]];
  raster(CELL_CHANNEL[m.cls], def.components.x[inst], def.components.y[inst], def.components.x[inst] + m.w, def.components.y[inst] + m.h);
}
// Coverage is kept to 16 levels: plenty for a map at this scale, and it compresses far better.
const LEVELS = Number(args['overview-levels'] ?? 16);
const image = (channels: number[]) => {
  const pixels = new Uint8Array(px * px * 4);
  for (let k = 0; k < px * px; k += 1) for (let c = 0; c < 4; c += 1) pixels[k * 4 + c] = Math.round(Math.round(Math.min(1, cover[channels[c]][k]) * (LEVELS - 1)) * (255 / (LEVELS - 1)));
  return encodePng(pixels, px, px, 4);
};
const metalBytes = write('overview-metal.png', image([0, 1, 2, 3]));
const cellBytes = write('overview-cells.png', image([4, 5, 6, 7]));
log(`overview: metal ${(metalBytes / 1e3).toFixed(0)} kB, cells ${(cellBytes / 1e3).toFixed(0)} kB`);

// -------------------------------------------------------- register groups
// Every register bit belongs to one of the tile's 16 dot-product units, from
// the RTL's own layout of its buses (rtl/a1/a1_mma_tile.sv): unit k = 4i + j
// computes element (i, j) of D. Its product terms are s2_terms[306k +: 306],
// its partial sum s3_partial[62k +: 62], and its accumulators, C/D data, and
// response bits are acc[e], s1_c, s2_c, s3_c, and rsp_data at [32k +: 32].
// Where each unit's registers were placed shows where the placer put its logic.
const SLICE: Record<string, number> = { s2_terms: 306, s3_partial: 62, acc: 32, s1_c: 32, s2_c: 32, s3_c: 32, rsp_data: 32 };
const unitMembers: number[][] = Array.from({ length: 16 }, () => []);
let unassigned = 0;
for (let inst = 0; inst < compMacro.length; inst += 1) {
  if (macros[compMacro[inst]].cls !== 'sequential') continue;
  const name = unescape(def.components.names[inst]).replace(/\$.*/, '');
  const base = name.replace(/\[.*/, '');
  const bits = [...name.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  const width = SLICE[base];
  if (width === undefined || bits.length === 0) {
    unassigned += 1;
    continue;
  }
  const unit = Math.floor(bits[bits.length - 1] / width);
  if (unit < 0 || unit > 15) throw new Error(`register ${name} maps to unit ${unit}`);
  unitMembers[unit].push(inst);
}
const quantile = (values: number[], q: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * (values.length - 1))))];
const groups: RegionGroup[] = unitMembers.map((list, unit) => {
  const i = unit >> 2;
  const j = unit & 3;
  const xs = list.map((inst) => def.components.x[inst] + macros[compMacro[inst]].w / 2).sort((a, b) => a - b);
  const ys = list.map((inst) => def.components.y[inst] + macros[compMacro[inst]].h / 2).sort((a, b) => a - b);
  return {
    id: `dot-${i}-${j}`,
    label: `Dot unit D[${i}][${j}]`,
    detail: `Row ${i} of A times column ${j} of B: its product terms, partial sum, 4 accumulators, and element (${i}, ${j}) of the C/D data`,
    count: list.length,
    box: [quantile(xs, 0.1), quantile(ys, 0.1), quantile(xs, 0.9), quantile(ys, 0.9)],
    centroid: [quantile(xs, 0.5), quantile(ys, 0.5)],
  };
});
log(`register groups: 16 dot units of ${Math.min(...groups.map((g) => g.count))}–${Math.max(...groups.map((g) => g.count))} flip-flops, 80 % boxes ${Math.round(Math.min(...groups.map((g) => (g.box[2] - g.box[0]) / 1000)))}–${Math.round(Math.max(...groups.map((g) => (g.box[2] - g.box[0]) / 1000)))} µm wide; ${unassigned} shared (operands, scales, control)`);

// ------------------------------------------------------------- heroes
// The region stop looks at the dot unit nearest the middle of the tile.
const middle = [(dieX0 + dieX1) / 2, (dieY0 + dieY1) / 2];
const central = [...groups].sort((a, b) => Math.hypot(a.centroid[0] - middle[0], a.centroid[1] - middle[1]) - Math.hypot(b.centroid[0] - middle[0], b.centroid[1] - middle[1]))[0];
const anchor = central?.centroid ?? middle;
const nearestOf = (test: (m: MacroInfo) => boolean) => {
  let best = -1;
  let bestDistance = Infinity;
  for (let inst = 0; inst < compMacro.length; inst += 1) {
    const m = macros[compMacro[inst]];
    if (!test(m)) continue;
    const d = Math.hypot(def.components.x[inst] + m.w / 2 - anchor[0], def.components.y[inst] + m.h / 2 - anchor[1]);
    if (d < bestDistance) { bestDistance = d; best = inst; }
  }
  return best;
};
const heroCell = nearestOf((m) => m.name.endsWith('__fa_1'));
const heroCenter = (inst: number) => ({ x: def.components.x[inst] + macros[compMacro[inst]].w / 2, y: def.components.y[inst] + macros[compMacro[inst]].h / 2 });
const heroFa = heroCenter(heroCell);
const heroes: LayoutManifest['heroes'] = {
  region: { x: anchor[0], y: anchor[1], note: `Middle of ${central?.label ?? 'the tile'}` },
  routing: { x: heroFa.x, y: heroFa.y, note: `Around ${unescape(def.components.names[heroCell])}` },
  cells: { x: heroFa.x, y: heroFa.y, note: `Full adder ${unescape(def.components.names[heroCell])}` },
  devices: { x: heroFa.x, y: heroFa.y, note: `Transistors of ${unescape(def.components.names[heroCell])}` },
};

// ------------------------------------------------------------- manifest
const cellsByClass = Object.fromEntries((['logic', 'sequential', 'clock', 'buffer', 'fill', 'tap', 'diode', 'decap'] as CellClass[]).map((cls) => [cls, macros.filter((m) => m.cls === cls).reduce((sum, m) => sum + m.count, 0)])) as Record<CellClass, number>;
// Source paths are recorded from the EDA volume's runs/ directory, not the local home directory.
const runsPath = (file: string) => (file.includes('/runs/') ? file.slice(file.indexOf('/runs/') + 1) : path.basename(file));
const manifest: LayoutManifest = {
  format: LAYOUT_FORMAT,
  design: def.design,
  platform: 'sky130hd',
  title: 'AIMEM-A1 tensor tile · SkyWater SKY130 (sky130_fd_sc_hd)',
  run: RUN,
  rtlCommit: RTL_COMMIT,
  generated: new Date().toISOString(),
  exporter: 'tools/physical/layout-export/export-layout.ts',
  sources: [
    { role: 'Routed layout (DEF)', file: `aimem-eda:${runsPath(DEF)}`, bytes: statSync(DEF).size, sha256: sha256(DEF) },
    { role: 'Cell library layout (GDS)', file: 'ORFS flow/platforms/sky130hd/gds/sky130_fd_sc_hd.gds', bytes: statSync(LIB_GDS).size, sha256: sha256(LIB_GDS) },
    { role: 'Cell library abstract (LEF)', file: 'ORFS flow/platforms/sky130hd/lef/sky130_fd_sc_hd_merged.lef', bytes: statSync(CLEF).size, sha256: sha256(CLEF) },
    { role: 'Technology LEF', file: 'ORFS flow/platforms/sky130hd/lef/sky130_fd_sc_hd.tlef', bytes: statSync(TLEF).size, sha256: sha256(TLEF) },
    { role: 'Layer heights (Magic tech file, open_pdks 1.0.608)', file: 'aimem-eda:tools/lvs/sky130A/sky130A.tech', bytes: statSync(TECH).size, sha256: sha256(TECH) },
  ],
  evidence: {
    drc: 'KLayout DRC with the ORFS sky130hd deck: 0 items',
    lvs: 'Magic 8.3.684 + Netgen 1.5.324: circuits match uniquely (6 library cell types compared at connectivity level)',
    timing: 'OpenSTA: 19.5 MHz at the 40 ns target; slowest path in stage 2',
    statement: 'Every wire, via, and placed cell is drawn from the routed DEF of the C3 sky130hd run; each cell\'s transistors, contacts, li1, and met1 come from the SkyWater library GDS it references; layer heights are the PDK\'s. Heights are to scale. Wire widths, spacing, and positions are exact to the 1 nm database unit.',
  },
  dbuPerMicron: def.dbu,
  die: def.die,
  core: [def.rows.x0, def.rows.y0, def.rows.x1, def.rows.y1 + def.rows.height],
  rows: rowSpec,
  fill: fillSpec,
  powerStacks,
  ioPins: def.ioPins.map((pin) => ({ name: unescape(pin.name), dir: pin.direction.toLowerCase(), net: pin.use === 'POWER' ? VDD : pin.use === 'GROUND' ? VSS : netByName.get(pin.net) ?? -1 })),
  layers,
  vias: viaDefs,
  macros,
  tile: { size: T, nx, ny, entries },
  global: { bytes: globalBytes, rects: global.rects.length, vias: global.vias.length },
  nets: { count: N, chunk: NET_CHUNK, chunks: netChunks, vdd: VDD, vss: VSS, clock: def.nets.use.filter((u) => u === 'CLOCK').length, signal: def.nets.use.filter((u) => u !== 'CLOCK').length, clockIds: def.nets.use.flatMap((u, n) => (u === 'CLOCK' ? [n] : [])), routed: Array.from({ length: N }, (_, n) => (netBox[n * 4] <= netBox[n * 4 + 2] ? 1 : 0)).reduce((s: number, v) => s + v, 0) },
  insts: { count: defOf.length, chunk: INST_CHUNK, chunks: instChunks, named, fill: compMacro.length - defOf.length },
  overview: { size: px, files: { metal: 'overview-metal.png', cells: 'overview-cells.png' }, channels: { metal: ['li1 + met1', 'met2', 'met3', 'met4'], cells: ['logic', 'sequential', 'clock + buffer', 'physical'] } },
  stats: {
    cells: cellsByClass,
    wire: Object.fromEntries(Object.entries(wire).map(([k, v]) => [k, Math.round(v)])),
    powerWire: Object.fromEntries(Object.entries(powerWire).map(([k, v]) => [k, Math.round(v)])),
    vias: viaCounts,
    ioPins: def.ioPins.filter((pin) => pin.use !== 'POWER' && pin.use !== 'GROUND').length,
    transistors: libTransistors,
  },
  heroes,
  groups,
};
const manifestText = JSON.stringify(manifest);
write('manifest.json', manifestText);
log(`manifest ${(Buffer.byteLength(manifestText) / 1e3).toFixed(0)} kB`);
log(`total ${(totalBytes / 1e6).toFixed(2)} MB in ${OUT}`);
