import assert from 'node:assert/strict';
import test from 'node:test';
import { CELL_WIDTH, FLOATS_PER_INSTANCE, LEVELS, PRESETS, cellLayout, generateChunk, generateGlobal, windowChunks, type CellType } from '../lib/silicon-macro.ts';
import { EXPLAIN, explainRegion } from '../lib/silicon-explain.ts';
import { FLOW, PART_ORDER, flowOfPhase, packPhase, partOfPhase } from '../lib/silicon-part-ids.ts';
import { PARTS, identifyPrimitive, summarizeNet, type PartId } from '../lib/silicon-parts.ts';
import { traceNet, type TraceRecord } from '../lib/silicon-trace.ts';

// The Silicon macro view draws every interconnect as part of a net: these
// tests trace nets through the generated geometry, as a circuit extractor
// would, and check that they are whole, separate, and never touch a supply.

const SUPPLY = new Set<PartId>([
  'm0-rail', 'contact-power', 'vbpr', 'bpr', 'nano-tsv', 'backside-rail', 'power-ladder', 'ladder-pad', 'decap-plate', 'mx4-strap', 'vx4',
  'semi-global-strap', 'strap-via', 'strap-stack', 'mesh-stack', 'global-strap', 'top-via', 'tile-ring', 'ring-stack', 'power-bump', 'sram-ring', 'sram-supply',
]);

function records(spot: { x: number; z: number }, counts: Array<[number, number]>, global = false): TraceRecord[] {
  const out: TraceRecord[] = [];
  for (const [level, count] of counts) {
    for (const key of windowChunks(LEVELS[level], spot.x, spot.z, LEVELS[level].fullAt * 0.9).slice(0, count)) out.push({ id: `${key.level}:${key.ix}:${key.iz}`, level: key.level, data: generateChunk(key.level, key.ix, key.iz) });
  }
  if (global) out.push({ id: 'global', level: 0, data: generateGlobal() });
  return out;
}

function partOf(record: TraceRecord, batch: number, index: number): PartId {
  const b = record.data.batches[batch];
  const d = b.data;
  const o = index * FLOATS_PER_INSTANCE;
  return identifyPrimitive({ level: record.level, material: b.material, shape: b.shape, x: d[o] + record.data.origin[0], z: d[o + 2] + record.data.origin[2], y0: d[o + 1] - d[o + 4] / 2, y1: d[o + 1] + d[o + 4] / 2, sx: d[o + 3], sz: d[o + 5], glow: d[o + 8], code: d[o + 9] });
}

function seedsOf(record: TraceRecord, parts: PartId[]) {
  const seeds: Array<{ record: TraceRecord; batch: number; index: number }> = [];
  record.data.batches.forEach((batch, b) => {
    for (let k = 0; k < batch.count; k += 1) if (parts.includes(partOf(record, b, k))) seeds.push({ record, batch: b, index: k });
  });
  return seeds;
}

/** Every net reached from the seeds (each traced once). */
function netsFrom(seeds: ReturnType<typeof seedsOf>, all: TraceRecord[], limit = 3000) {
  const seen = new Set<string>();
  const nets: Array<{ parts: PartId[]; result: ReturnType<typeof traceNet> }> = [];
  for (const seed of seeds) {
    if (seen.has(`${seed.record.id}/${seed.batch}/${seed.index}`)) continue;
    const result = traceNet(seed, all, limit);
    for (const piece of result.pieces) seen.add(`${piece.record.id}/${piece.batch}/${piece.index}`);
    nets.push({ parts: result.pieces.map((piece) => partOf(piece.record, piece.batch, piece.index)), result });
  }
  return nets;
}

test('part identity and flow ride in the pulse phase and round-trip', () => {
  for (const part of PART_ORDER) for (const flow of [FLOW.data, FLOW.vdd, FLOW.vss, FLOW.clock]) {
    const packed = Math.fround(packPhase(part, flow, 0.73));
    assert.equal(partOfPhase(packed), part);
    assert.equal(flowOfPhase(packed), flow);
    assert.ok(Math.abs((packed % 1) - 0.73 * 0.999) < 1e-3, 'the pulse phase survives float32 packing');
  }
  assert.equal(partOfPhase(packPhase(undefined, FLOW.data, 0.5)), null);
});

test('every part has a name, an explanation, and fabrication steps', () => {
  for (const part of PART_ORDER) {
    assert.ok(PARTS[part], `${part} has no name`);
    const explanation = EXPLAIN[part];
    assert.ok(explanation && explanation.does.length > 20 && explanation.connects.length > 10, `${part} is not explained`);
    assert.ok(explanation.made.length > 0 && explanation.made.every((step) => step.length > 20), `${part} has no fabrication steps`);
  }
  for (const id of ['sram-strip', 'phy-0', 'block-south', 'tile-3', 'pe-array-3', 'tile-3-sram-1', 'router-3', 'vector-3', 'pe-3-4-5', 'rf-3-4-5', 'tsv-column']) {
    assert.ok(explainRegion(id, 'Region'), `region ${id} is not explained`);
  }
  assert.match(explainRegion('cell-12:40', 'NAND2 · 2-input NAND')!.does, /both inputs/);
});

test('standard cells are laid out with separate pins and non-overlapping wires', () => {
  for (const type of Object.keys(CELL_WIDTH) as CellType[]) {
    const layout = cellLayout(type);
    if (!layout) continue;
    const w = CELL_WIDTH[type];
    const positions = layout.pins.map((pin) => pin.k);
    assert.equal(new Set(positions).size, positions.length, `${type} pins share a position`);
    for (const pin of layout.pins) assert.ok(pin.k >= 0 && pin.k < w, `${type} pin ${pin.name} is outside the cell`);
    assert.ok(layout.pins.some((pin) => pin.dir === 'out') && layout.pins.some((pin) => pin.dir !== 'out'), `${type} lacks an input or an output`);
    for (const track of [0, 1, 2, 3]) {
      const wires = layout.m0.filter((wire) => wire.track === track).sort((a, b) => a.k0 - b.k0);
      for (let k = 1; k < wires.length; k += 1) assert.ok(wires[k].k0 >= wires[k - 1].k1, `${type} M0 wires overlap on track ${track}`);
    }
    // Every input reaches a gate contact on an active gate, through a V0.
    for (const pin of layout.pins.filter((item) => item.dir !== 'out')) {
      assert.ok(layout.v0.some((via) => via.k === pin.k), `${type} input ${pin.name} has no V0`);
      assert.ok(layout.gateContacts.some((contact) => contact.n === pin.k && contact.n <= w - 2), `${type} input ${pin.name} drives no gate`);
    }
    // Only merged contacts reach the tracks inputs use: no input wire may cross one.
    const merged = layout.contacts.filter((contact) => contact.role !== 'power').map((contact) => contact.k);
    for (const wire of layout.m0.filter((item) => item.pin && (item.track === 1 || item.track === 2))) {
      for (const k of merged) assert.ok(k + 0.13 < wire.k0 || k - 0.13 > wire.k1, `${type} input wire ${wire.pin} crosses the contact at ${k}`);
    }
  }
});

test('local nets join a driver to the cells it drives, through vias, and never touch a supply', () => {
  const all = records(PRESETS[5], [[3, 9], [4, 9]]);
  const center = all.find((record) => record.level === 3)!;
  const nets = netsFrom(seedsOf(center, ['m2']), all);
  assert.ok(nets.length > 40, `only ${nets.length} nets`);
  for (const { parts, result } of nets) {
    assert.equal(result.truncated, false);
    assert.ok(!parts.some((part) => SUPPLY.has(part)), `a signal net touches a supply: ${[...new Set(parts)].join(', ')}`);
    assert.ok(parts.includes('v1') && (parts.includes('m1-pin') || parts.includes('m1-out') || parts.includes('clock-net') || parts.includes('m3-pad')), 'a net without a pin');
    // One driver: chunk seams may split a pin, so count output pins by position.
    const summary = summarizeNet(result.pieces, false);
    assert.ok(summary.pins.filter((pin) => / output /.test(pin)).length <= 1, `two drivers: ${summary.pins.join(', ')}`);
  }
  // Nets reach down through the pins to the transistors.
  assert.ok(nets.some(({ parts }) => parts.includes('contact-vg') && parts.includes('gate')), 'no net reaches a gate');
  assert.ok(nets.some(({ parts }) => parts.includes('contact-md') && parts.includes('epi-n')), 'no net reaches a drain');
});

test('intermediate routes and systolic buses are separate nets that drop to the cells', () => {
  const all = records(PRESETS[3], [[1, 2], [2, 4]], true);
  const routes = netsFrom(seedsOf(all.find((record) => record.level === 2)!, ['mx1', 'mx2', 'mx3']), all);
  assert.ok(routes.length > 100, `only ${routes.length} route nets`);
  for (const { parts } of routes) {
    assert.ok(!parts.some((part) => SUPPLY.has(part)), `a route touches a supply: ${[...new Set(parts)].join(', ')}`);
    assert.ok(parts.length < 200, `routes merged into a ${parts.length}-piece net`);
    assert.ok(parts.includes('v3'), 'a route that never reaches the cells');
  }
  const buses = netsFrom(seedsOf(all.find((record) => record.level === 1)!, ['systolic-bus']), all);
  assert.ok(buses.length > 50);
  for (const { parts } of buses) {
    assert.ok(!parts.some((part) => SUPPLY.has(part)), 'a systolic line touches a supply');
    assert.deepEqual([...new Set(parts)].sort(), ['pe-pins', 'systolic-bus', 'v3'], 'a systolic line should be the line and its two drops');
  }
});

test('power flows from the bumps to the rails, and VDD never meets VSS', () => {
  const all = records(PRESETS[3], [[1, 2], [2, 4]], true);
  const nets = netsFrom(seedsOf(all.find((record) => record.level === 2)!, ['power-ladder']), all, 20000);
  assert.equal(nets.length, 2, 'the ladders should form exactly one VDD and one VSS network');
  for (const { parts, result } of nets) {
    for (const part of ['power-ladder', 'mx4-strap', 'vx4', 'semi-global-strap', 'global-strap', 'top-via', 'power-bump'] as PartId[]) assert.ok(parts.includes(part), `the supply never reaches ${part}`);
    const flows = new Set(result.pieces.map((piece) => flowOfPhase(piece.record.data.batches[piece.batch].data[piece.index * FLOATS_PER_INSTANCE + 9])).filter((flow) => flow === FLOW.vdd || flow === FLOW.vss));
    assert.equal(flows.size, 1, 'VDD and VSS pieces in one network');
  }
});
