import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  LAYER, NO_NET, PURPOSE, decodeBlock, encodeBlock, packKind, pinNet, placeRect, placedPinRects, rebuildFill, rebuildPowerStacks, tileKey,
  type BlockInput, type LayoutManifest,
} from '../lib/a1-layout-format.ts';
import { describeCell } from '../lib/a1-layout-parts.ts';
import { buildCellChunk, buildRoutingChunk, frameOf, pathArcs, strapsOf, whatCategory, whatLayer, type LayoutLibrary } from '../lib/a1-layout-scene.ts';

// The Silicon macro view's "A1 layout" mode draws the real routed A1 tile
// from data exported by tools/physical/layout-export. These tests check the
// format round-trips exactly, that the rebuilt parts (filler cells, supply via
// stacks, pin nets) follow the rules the exporter proved against the DEF, and
// that the shipped data is whole and consistent.

const DATA = new URL('../public/layouts/a1-sky130hd/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, DATA));
const manifest = JSON.parse(read('manifest.json').toString()) as LayoutManifest;
const library = JSON.parse(gunzipSync(read('lib.json.gz')).toString()) as LayoutLibrary;

test('blocks round-trip exactly, narrow and wide', () => {
  const tile: BlockInput = {
    ix: 3, iy: 7, ox: 192000, oy: 448000, firstInst: 1234,
    cells: [{ macro: 5, x: 192460, y: 448000, orient: 0 }, { macro: 9, x: 200000, y: 450720, orient: 5 }],
    rects: [
      { kind: packKind(LAYER.met1, PURPOSE.wire), x0: 192500, y0: 449000, x1: 196000, y1: 449140, net: 17 },
      { kind: packKind(LAYER.met2, PURPOSE.wire), x0: 195860, y0: 448500, x1: 196000, y1: 452000, net: 17 },
      { kind: packKind(LAYER.met1, PURPOSE.rail), x0: 192000, y0: 447760, x1: 256000, y1: 448240, net: 4000 },
    ],
    vias: [{ def: 2, x: 195930, y: 449070, net: 17 }, { def: 1, x: 192570, y: 449070, net: 17 }],
    row0: 0, lead: [192000, 193000], tail: [256000, 250000],
  };
  const back = decodeBlock(encodeBlock(tile));
  assert.equal(back.firstInst, 1234);
  assert.deepEqual([...back.cells.x], [192460, 200000]);
  assert.deepEqual([...back.cells.orient], [0, 5]);
  const rects = Array.from(back.rects.kind, (kind, k) => [kind, back.rects.x0[k], back.rects.y0[k], back.rects.x1[k], back.rects.y1[k], back.rects.net[k]].join(':')).sort();
  assert.deepEqual(rects, tile.rects.map((r) => [r.kind, r.x0, r.y0, r.x1, r.y1, r.net].join(':')).sort());
  const vias = Array.from(back.vias.def, (def, k) => [def, back.vias.x[k], back.vias.y[k], back.vias.net[k]].join(':')).sort();
  assert.deepEqual(vias, tile.vias.map((v) => [v.def, v.x, v.y, v.net].join(':')).sort());
  assert.deepEqual([...back.lead], tile.lead);
  // A 2.5 mm strap needs 32-bit fields.
  const wide = decodeBlock(encodeBlock({ ...tile, ox: 0, oy: 0, rects: [{ kind: packKind(LAYER.met5, PURPOSE.stripe), x0: 10120, y0: 2539680, x1: 2562080, y1: 2541280, net: 1 }], vias: [], cells: [], lead: [], tail: [] }));
  assert.equal(wide.rects.x1[0], 2562080);
  assert.throws(() => encodeBlock({ ...tile, rects: [{ ...tile.rects[0], x0: 192501 }] }), /grid/);
});

test('placement orientations follow DEF: N, S, FN, FS keep the cell in its box', () => {
  const [w, h] = [1380, 2720];
  assert.deepEqual(placeRect(0, w, h, 100, 200, 300, 400), [100, 200, 300, 400]);
  assert.deepEqual(placeRect(5, w, h, 100, 200, 300, 400), [100, h - 400, 300, h - 200]); // FS mirrors y
  assert.deepEqual(placeRect(4, w, h, 100, 200, 300, 400), [w - 300, 200, w - 100, 400]); // FN mirrors x
  assert.deepEqual(placeRect(1, w, h, 100, 200, 300, 400), [w - 300, h - 400, w - 100, h - 200]); // S rotates 180
});

test('fillers are rebuilt greedily, largest first, left to right in every gap', () => {
  const rows = { count: 2, height: 2720, site: 460, x0: 0, y0: 0, x1: 460 * 30, orient0: 0 };
  const fill = { sites: [8, 4, 2, 1], macros: [80, 40, 20, 10] };
  const width = (macro: number) => (macro === 7 ? 460 * 3 : 460);
  // Row 0: a 3-site cell at site 5; gaps of 5 sites (4 + 1) and 22 sites (8 + 8 + 4 + 2).
  const block = { cells: { macro: Uint16Array.from([7]), x: Int32Array.from([460 * 5]), y: Int32Array.from([0]), orient: Uint8Array.from([0]) }, row0: 0, lead: Int32Array.from([0, 0]), tail: Int32Array.from([460 * 30, 460 * 30]) };
  const fills = rebuildFill(block, rows, fill, width, 0, 460 * 30);
  const row0 = fills.filter((f) => f.y === 0).map((f) => [f.x / 460, f.macro]);
  assert.deepEqual(row0, [[0, 40], [4, 10], [8, 80], [16, 80], [24, 40], [28, 20]]);
  // Row 1 is flipped (FS) and empty: 30 sites = 8 + 8 + 8 + 4 + 2.
  assert.deepEqual(fills.filter((f) => f.y === 2720).map((f) => [f.macro, f.orient]), [[80, 5], [80, 5], [80, 5], [40, 5], [20, 5]]);
  // A tile only keeps fillers whose origin is inside it.
  assert.ok(rebuildFill(block, rows, fill, width, 460 * 10, 460 * 10).every((f) => f.x >= 460 * 10 && f.x < 460 * 20));
});

test('supply via stacks sit only where a strap crosses a rail of the same net', () => {
  const stacks = { vias: [3, 2, 1], patches: [[packKind(LAYER.met2, PURPOSE.patch), -770, -185, 770, 185]] as Array<[number, number, number, number, number]> };
  const straps = [{ net: 100, x0: 49200, y0: 0, x1: 50800, y1: 99999 }];
  const rails = [{ net: 100, x0: 0, y0: 9760, x1: 99999, y1: 10240 }, { net: 101, x0: 0, y0: 12480, x1: 99999, y1: 12960 }];
  const rebuilt = rebuildPowerStacks(straps, rails, stacks, 0, 0, 64000);
  assert.deepEqual(rebuilt.vias.map((v) => [v.def, v.x, v.y, v.net]), [[3, 50000, 10000, 100], [2, 50000, 10000, 100], [1, 50000, 10000, 100]]);
  assert.deepEqual(rebuilt.patches.map((p) => [p.x0, p.y0, p.x1, p.y1]), [[49230, 9815, 50770, 10185]]);
});

test('a pin takes the net of the metal that lands on it, and flags two nets', () => {
  const shapes = [{ x0: 900, y0: 1100, x1: 1070, y1: 1270, net: 42 }, { x0: 0, y0: 0, x1: 100, y1: 100, net: 7 }];
  const pin: Array<[number, number, number, number, number]> = [[LAYER.li1, 940, 1075, 1275, 1325]];
  assert.deepEqual(pinNet(pin, () => shapes), { net: 42, conflict: false });
  assert.deepEqual(pinNet([[LAYER.li1, 2000, 2000, 2100, 2100]], () => shapes), { net: NO_NET, conflict: false });
  assert.equal(pinNet(pin, () => [...shapes, { x0: 1000, y0: 1200, x1: 1100, y1: 1300, net: 43 }]).conflict, true);
  // Placed pin shapes follow the cell's orientation.
  const placed = placedPinRects([[0, LAYER.li1, 940, 1075, 1275, 1325]], 0, { w: 1380, h: 2720 }, 10000, 20000, 5);
  assert.deepEqual(placed, [[LAYER.li1, 10940, 20000 + 2720 - 1325, 11275, 20000 + 2720 - 1075]]);
});

test('cell names decode to what the SkyWater cells do', () => {
  assert.equal(describeCell('sky130_fd_sc_hd__a21oi_1').what, 'AND-OR-invert: (A1·A2) + B1, inverted');
  assert.equal(describeCell('sky130_fd_sc_hd__o21bai_1').what, 'OR-AND-invert: (A1+A2) · ¬B1, inverted');
  assert.equal(describeCell('sky130_fd_sc_hd__a2bb2o_1').what, 'AND-OR: (¬A1·¬A2) + (B1·B2)');
  assert.equal(describeCell('sky130_fd_sc_hd__nor4bb_1').what, '4-input NOR, two inputs inverted');
  assert.equal(describeCell('sky130_fd_sc_hd__edfxtp_1').what, 'D flip-flop with enable (rising clock)');
  assert.equal(describeCell('sky130_fd_sc_hd__fill_8').drive, '8 sites wide');
  assert.equal(describeCell('sky130_fd_sc_hd__and2_0').drive, 'minimum drive');
  // Every cell the tile uses has a description, not just its name.
  for (const m of manifest.macros) assert.notEqual(describeCell(m.name).what, describeCell(m.name).family, m.name);
});

test('signal pulses walk out from the driver through touching metal', () => {
  const um = 1e-3;
  const nodes = [
    { x0: 0, y0: 0, x1: 170, y1: 170, lo: 0.9 * um, hi: 1.7 * um, via: true }, // pin via (li1 to met1)
    { x0: 0, y0: 15, x1: 5000, y1: 155, lo: 1.38 * um, hi: 1.74 * um, via: false }, // met1 wire
    { x0: 4900, y0: 0, x1: 5070, y1: 170, lo: 1.38 * um, hi: 2.37 * um, via: true }, // via up to met2
    { x0: 4915, y0: 0, x1: 5055, y1: 9000, lo: 2.0 * um, hi: 2.37 * um, via: false }, // met2 wire
    { x0: 20000, y0: 0, x1: 21000, y1: 140, lo: 1.38 * um, hi: 1.74 * um, via: false }, // not connected
  ];
  const arcs = pathArcs(nodes, 0, 6);
  assert.equal(arcs[0].arc, 0);
  assert.ok(arcs[1].arc > 0 && arcs[2].arc > arcs[1].arc && arcs[3].arc > arcs[2].arc, JSON.stringify(arcs));
  assert.equal(arcs[4].arc, -1);
});

test('the shipped layout is whole: every tile listed is there, and the stack is the PDK\'s', () => {
  assert.equal(manifest.format, 'aimem-layout/1');
  assert.equal(manifest.design, 'a1_mma_tile');
  assert.equal(manifest.insts.count + manifest.insts.fill, 1023832);
  assert.equal(manifest.nets.count, 294474);
  // Heights from the sky130A Magic tech file (µm): each layer sits on the one below.
  const z = Object.fromEntries(manifest.layers.map((layer) => [layer.id, [layer.z0, layer.z1]]));
  assert.deepEqual(z.met1, [1.3761, 1.7361]);
  assert.deepEqual(z.met5, [5.3711, 6.6311]);
  for (const [below, above] of [['li1', 'mcon'], ['mcon', 'met1'], ['met1', 'via'], ['via', 'met2'], ['met2', 'via2'], ['via2', 'met3'], ['met3', 'via3'], ['via3', 'met4'], ['met4', 'via4'], ['via4', 'met5']]) assert.ok(Math.abs(z[below][1] - z[above][0]) < 1e-3, `${below} → ${above}`);
  let total = 0;
  for (const entry of manifest.tile.entries) {
    const file = new URL(`tiles/${tileKey(entry.ix, entry.iy)}.bin.gz`, DATA);
    assert.ok(existsSync(file), tileKey(entry.ix, entry.iy));
    assert.equal(statSync(file).size, entry.bytes);
    total += entry.bytes;
  }
  // The whole routed tile, exact, stays within a budget the repository can carry.
  assert.ok(total < 24e6, `tiles are ${(total / 1e6).toFixed(1)} MB`);
  for (let c = 0; c < manifest.nets.chunks; c += 1) assert.ok(existsSync(new URL(`nets/${c}.json.gz`, DATA)));
  for (let c = 0; c < manifest.insts.chunks; c += 1) assert.ok(existsSync(new URL(`insts/${c}.json.gz`, DATA)));
  assert.equal(library.macros.length, manifest.macros.length);
  assert.equal(manifest.groups.length, 16);
});

test('a real tile decodes, rebuilds its fillers, and builds drawable chunks', () => {
  const entry = manifest.tile.entries.find((item) => item.ix === 20 && item.iy === 20)!;
  const block = decodeBlock(gunzipSync(read(`tiles/${tileKey(20, 20)}.bin.gz`)));
  const global = decodeBlock(gunzipSync(read('global.bin.gz')));
  const ctx = { manifest, frame: frameOf(manifest), library, clockNets: new Set(manifest.nets.clockIds), straps: strapsOf(global) };
  const routing = buildRoutingChunk(ctx, block, 'tile:20_20', 'tile');
  // Stored cells plus rebuilt fillers are every cell the exporter placed in this tile.
  assert.equal(routing.cells.length, entry.cells);
  assert.equal(routing.cells.filter((cell) => cell.inst < 0).length, entry.cells - block.cells.macro.length);
  const kinds = new Set(routing.batches.flatMap((batch) => Array.from(batch.what, (what) => `${whatCategory(what)}:${whatLayer(what)}`)));
  for (const kind of ['wire:met1', 'wire:met2', 'cut:via', 'rail:met1', 'stack-cut:via3', 'footprint:nwell']) assert.ok(kinds.has(kind), kind);
  // Heights are true to scale: nothing above met5's top (plus the anti-z-fight lift).
  assert.ok(routing.yMax <= 6.6311e-3 * 1.05 && routing.yMin >= 0);
  const cells = buildCellChunk(ctx, block, 'cells:20_20', routing.cells);
  const deviceKinds = new Set(cells.batches.flatMap((batch) => Array.from(batch.what, (what) => whatLayer(what))));
  for (const layer of ['ndiff', 'pdiff', 'poly', 'licon', 'li1', 'mcon', 'nwell']) assert.ok(deviceKinds.has(layer as never), layer);
  for (const batch of [...routing.batches, ...cells.batches]) {
    assert.equal(batch.data.length, batch.count * 10);
    assert.equal(batch.ref.length, batch.count);
    assert.ok(batch.data.every(Number.isFinite));
  }
});
