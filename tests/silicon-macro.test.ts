import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCELERATOR_FLOORPLAN } from '../lib/reference-microchip.ts';
import { PACKAGE_GEOMETRY, SCENE_MM_PER_UNIT, STACK_PLACEMENTS, acceleratorPhyAnchor } from '../lib/package-connectors.ts';
import {
  CHANNEL_RECTS, DIE, DIE_RECT, EDGE_BLOCKS, FLOATS_PER_INSTANCE, FOCUS_STOPS, LEVELS, PHYS, PRESETS, SILICON_EVIDENCE, SRAM_STRIP, STACK, TILES,
  CPP, ROW, chunkBounds, craterFor, describeLocation, focusStopFor, formatLength, generateChunk, generateGlobal, generatePackageWiring, leafAt, rectsOverlap, scaleBar, sectionCaps, snapSection,
  um, windowChunks, zoomPanPath, type Batch, type ChunkData, type Rect,
} from '../lib/silicon-macro.ts';

const instances = (batch: Batch) => Array.from({ length: batch.count }, (_, k) => batch.data.subarray(k * FLOATS_PER_INSTANCE, (k + 1) * FLOATS_PER_INSTANCE));
const contains = (outer: Rect, inner: Rect) => inner.x0 >= outer.x0 - 1e-12 && inner.x1 <= outer.x1 + 1e-12 && inner.z0 >= outer.z0 - 1e-12 && inner.z1 <= outer.z1 + 1e-12;

test('die outline, tile array, SRAM strip, and PHYs follow the planned accelerator floorplan', () => {
  assert.ok(Math.abs(DIE.width - PACKAGE_GEOMETRY.accelerator.width * SCENE_MM_PER_UNIT) < 1e-9);
  assert.ok(Math.abs(DIE.depth - PACKAGE_GEOMETRY.accelerator.depth * SCENE_MM_PER_UNIT) < 1e-9);
  assert.equal(TILES.length, ACCELERATOR_FLOORPLAN.computeTiles.columns * ACCELERATOR_FLOORPLAN.computeTiles.rows);
  assert.equal(PHYS.length, STACK_PLACEMENTS.length);
  STACK_PLACEMENTS.forEach((placement, index) => {
    const anchor = acceleratorPhyAnchor(placement);
    const phy = PHYS[index];
    assert.ok(Math.abs((phy.rect.x0 + phy.rect.x1) / 2 - anchor.x * SCENE_MM_PER_UNIT) < 1e-9);
    assert.ok(Math.abs((phy.rect.z0 + phy.rect.z1) / 2 - anchor.z * SCENE_MM_PER_UNIT) < 1e-9);
  });
  const blocks: Array<[string, Rect]> = [
    ...TILES.map((tile): [string, Rect] => [tile.label, tile.rect]),
    ...PHYS.map((phy): [string, Rect] => [phy.label, phy.rect]),
    ...EDGE_BLOCKS.map((block): [string, Rect] => [block.label, block.rect]),
    ['SRAM strip', SRAM_STRIP.rect],
  ];
  const core: Rect = { x0: DIE_RECT.x0 + DIE.ioBand, z0: DIE_RECT.z0 + DIE.ioBand, x1: DIE_RECT.x1 - DIE.ioBand, z1: DIE_RECT.z1 - DIE.ioBand };
  for (const [name, r] of blocks) assert.ok(contains(core, r), `${name} leaves the core`);
  for (let a = 0; a < blocks.length; a += 1) for (let b = a + 1; b < blocks.length; b += 1) {
    assert.equal(rectsOverlap(blocks[a][1], blocks[b][1]), false, `${blocks[a][0]} overlaps ${blocks[b][0]}`);
  }
  for (const tile of TILES) {
    assert.ok(contains(tile.rect, tile.peArray));
    for (const macro of tile.sram) assert.ok(contains(tile.rect, macro.rect) && contains(macro.rect, macro.array));
  }
  for (const channel of CHANNEL_RECTS) for (const tile of TILES) assert.equal(rectsOverlap(channel.rect, tile.rect), false);
});

test('regions resolve to the expected functional leaf', () => {
  const tile = TILES[0];
  const pe = { x: tile.peArray.x0 + tile.pePitchX * 0.6, z: tile.peArray.z0 + tile.pePitchZ * 0.6 };
  assert.equal(leafAt(pe.x, pe.z), 'logic');
  assert.equal(leafAt(tile.peArray.x0 + tile.pePitchX - um(4), pe.z), 'channel');
  assert.equal(leafAt(0, 0.5), 'tsv');
  assert.equal(leafAt((SRAM_STRIP.macros[0].array.x0 + SRAM_STRIP.macros[0].array.x1) / 2, (SRAM_STRIP.macros[0].array.z0 + SRAM_STRIP.macros[0].array.z1) / 2), 'sram');
  assert.equal(leafAt((PHYS[0].bumps.x0 + PHYS[0].bumps.x1) / 2, (PHYS[0].bumps.z0 + PHYS[0].bumps.z1) / 2), 'phy-bumps');
  assert.equal(leafAt(0, -DIE.depth / 2 + um(20)), 'seal');
  assert.equal(leafAt(0, -DIE.depth / 2 + 0.3), 'io');
  assert.equal(leafAt(DIE.width, 0), 'outside');
  assert.deepEqual(describeLocation(pe.x, pe.z).slice(0, 1), [tile.label]);
});

test('the metal stack is ordered from the front end to the bumps', () => {
  const order = ['fin', 'contact', 'm0', 'v0', 'm1', 'v1', 'm2', 'v2', 'm3', 'v3', 'mx1', 'vx1', 'mx2', 'vx2', 'mx3', 'vx3', 'mx4', 'vx4', 'sysH', 'vs', 'sysV', 'vy0', 'my1', 'vy1', 'my2', 'vc0', 'chanH', 'vc1', 'chanV', 'vn', 'nocH', 'vnj', 'nocV', 'vr', 'ring', 'vz0', 'mz1', 'vz1', 'mz2', 'pad'] as const;
  for (let k = 1; k < order.length; k += 1) assert.ok(STACK[order[k]][0] >= STACK[order[k - 1]][1] - 1e-12, `${order[k]} starts below ${order[k - 1]}`);
  // Every metal layer meets the next through a via band with no gap between
  // them, except where a crater floor needs a sliver of dielectric (M3/V3).
  const joined = ['contact', 'm0', 'v0', 'm1', 'v1', 'm2', 'v2', 'm3', 'v3', 'mx1', 'vx1', 'mx2', 'vx2', 'mx3', 'vx3', 'mx4', 'vx4', 'sysH', 'vs', 'sysV', 'vy0', 'my1', 'vy1', 'my2', 'vc0', 'chanH', 'vc1', 'chanV', 'vn', 'nocH', 'vnj', 'nocV', 'vr', 'ring', 'vz0', 'mz1', 'vz1', 'mz2'] as const;
  for (let k = 1; k < joined.length; k += 1) assert.ok(STACK[joined[k]][0] - STACK[joined[k - 1]][1] <= um(0.03) + 1e-12, `${joined[k - 1]} and ${joined[k]} leave a gap`);
  for (const deep of ['bpr', 'nanoTsv', 'backside', 'dtc', 'tsv'] as const) assert.ok(STACK[deep][0] < 0, `${deep} does not reach below the surface`);
});

function assertChunkWellFormed(chunk: ChunkData) {
  // Instances are float32, so allow float32 rounding at the chunk's scale.
  const eps = Math.max(1e-9, (chunk.bounds.x1 - chunk.bounds.x0) * 2e-6);
  for (const batch of chunk.batches) for (const v of instances(batch)) {
    for (const value of v) assert.ok(Number.isFinite(value));
    assert.ok(v[3] > 0 && v[4] > 0 && v[5] > 0, 'degenerate instance');
    if (batch.shape === 'box') {
      // Boxes are clipped to their chunk in plan.
      const x0 = v[0] + chunk.origin[0] - v[3] / 2;
      const z0 = v[2] + chunk.origin[2] - v[5] / 2;
      assert.ok(x0 >= chunk.bounds.x0 - eps && x0 + v[3] <= chunk.bounds.x1 + eps, 'box leaves its chunk in x');
      assert.ok(z0 >= chunk.bounds.z0 - eps && z0 + v[5] <= chunk.bounds.z1 + eps, 'box leaves its chunk in z');
    } else {
      assert.ok(v[0] + chunk.origin[0] >= chunk.bounds.x0 && v[0] + chunk.origin[0] < chunk.bounds.x1, 'cylinder axis outside its chunk');
    }
  }
}

test('chunks are deterministic, clipped to their bounds, and within budget', () => {
  const spots = [PRESETS[5], PRESETS[3], { x: 0, z: 1 }, { x: PHYS[0].rect.x0 + 3, z: PHYS[0].rect.z0 + 1 }, { x: 0.5, z: -DIE.depth / 2 + 0.3 }];
  // Levels 2 and 3 draw every net whole since the interconnect rebuild: each
  // route end has its via stack, and every cell its pins, contacts, and wires.
  // The M4 Max still renders every rung at 400+ fps uncapped (README).
  const budget = [0, 20000, 40000, 56000, 16000];
  for (const level of LEVELS.slice(1)) for (const spot of spots) {
    const keys = windowChunks(level, spot.x, spot.z, level.fullAt * 0.9);
    let total = 0;
    for (const key of keys.slice(0, 4)) {
      const a = generateChunk(key.level, key.ix, key.iz);
      const b = generateChunk(key.level, key.ix, key.iz);
      assert.deepEqual(a.batches.map((batch) => [batch.material, batch.shape, Array.from(batch.data)]), b.batches.map((batch) => [batch.material, batch.shape, Array.from(batch.data)]));
      assertChunkWellFormed(a);
    }
    for (const key of keys) total += generateChunk(key.level, key.ix, key.iz).instances;
    assert.ok(total <= budget[level.id], `level ${level.id} window at (${spot.x.toFixed(3)}, ${spot.z.toFixed(3)}) holds ${total} instances`);
  }
  const global = generateGlobal();
  assertChunkWellFormed(global);
  assert.ok(global.instances > 1000 && global.instances < 8000);
  assertChunkWellFormed(generatePackageWiring());
});

test('a wire split across two chunks keeps one tint and a continuous pulse path', () => {
  const level = LEVELS[2];
  const spot = PRESETS[3];
  // One chunk west of the PE centre, so the seam runs through dense MAC logic.
  const ix = Math.floor(spot.x / level.chunk) - 1;
  const iz = Math.floor(spot.z / level.chunk);
  const left = generateChunk(2, ix, iz);
  const right = generateChunk(2, ix + 1, iz);
  const edge = chunkBounds(level, ix, iz).x1;
  const eps = 1e-7;
  const atEdge = (chunk: ChunkData, side: 'x1' | 'x0') => chunk.batches.filter((batch) => batch.shape === 'box').flatMap((batch) => instances(batch).map((v) => ({ v, x0: v[0] + chunk.origin[0] - v[3] / 2, x1: v[0] + chunk.origin[0] + v[3] / 2, z: v[2] + chunk.origin[2], y: v[1] - v[4] / 2 }))).filter((item) => Math.abs((side === 'x1' ? item.x1 : item.x0) - edge) < eps && item.v[6] < 2);
  const a = atEdge(left, 'x1');
  const b = atEdge(right, 'x0');
  assert.ok(a.length > 20, 'expected wires crossing the chunk edge');
  let matched = 0;
  for (const item of a) {
    const partner = b.find((other) => Math.abs(other.z - item.z) < eps && Math.abs(other.y - item.y) < eps);
    if (!partner) continue;
    matched += 1;
    assert.equal(partner.v[6], item.v[6], 'tint differs across the seam');
    if (item.v[8] !== 0) assert.ok(Math.abs(partner.v[7] - (item.v[7] + item.v[3] * 1000)) < 1e-2, 'pulse path jumps across the seam');
  }
  assert.ok(matched >= a.length * 0.9, `${matched} of ${a.length} seam wires continue into the next chunk`);
});

test('the front end has transistors, and deep trenches and TSVs reach into the substrate', () => {
  const hero = PRESETS[5];
  const devices = generateChunk(4, Math.floor(hero.x / LEVELS[4].chunk), Math.floor(hero.z / LEVELS[4].chunk));
  const materials = new Set(devices.batches.map((batch) => batch.material));
  for (const material of ['silicon', 'gate', 'epiN', 'epiP', 'tungsten', 'copper'] as const) assert.ok(materials.has(material), `no ${material} in the device chunk`);
  assert.ok(devices.yMin < -um(0.5), 'backside power does not reach below the front end');
  const tsv = generateChunk(1, Math.floor(0 / LEVELS[1].chunk), Math.floor(1 / LEVELS[1].chunk));
  assert.ok(tsv.batches.some((batch) => batch.shape === 'cyl' && batch.material === 'copper'));
  assert.ok(tsv.yMin <= STACK.tsv[0] + 1e-12);
  const decap = generateChunk(4, 0, Math.floor((-DIE.depth / 2 + 0.7) / LEVELS[4].chunk));
  assert.ok(decap.batches.some((batch) => batch.shape === 'cyl' && batch.material === 'gate'), 'no deep-trench capacitors in the decap band');
});

test('section caps close every primitive the plane cuts', () => {
  const hero = PRESETS[5];
  const chunk = generateChunk(4, Math.floor(hero.x / LEVELS[4].chunk), Math.floor(hero.z / LEVELS[4].chunk));
  const plane = { axis: 0 as const, value: (chunk.bounds.x0 + chunk.bounds.x1) / 2 + um(0.0013), keep: 1 as const };
  const thickness = um(0.0005);
  const caps = sectionCaps(chunk, plane, thickness);
  let cut = 0;
  for (const batch of chunk.batches) for (const v of instances(batch)) {
    const x = v[0] + chunk.origin[0];
    if (x - v[3] / 2 < plane.value && x + v[3] / 2 > plane.value) cut += 1;
  }
  assert.equal(caps.reduce((sum, batch) => sum + batch.count, 0), cut);
  for (const batch of caps) for (const v of instances(batch)) {
    const x = v[0] + chunk.origin[0];
    assert.ok(x > plane.value && x - plane.value < thickness * 6, 'cap is not just inside the kept side');
    assert.ok(Math.abs(v[3] / thickness - 1) < 1e-6);
  }
  const cylinder: ChunkData = { ...chunk, origin: [0, 0, 0], batches: [{ material: 'copper', shape: 'cyl', count: 1, data: new Float32Array([0, 0, 0, 2, 1, 2, 0.5, 0, 0, 0]) }] };
  const [capped] = sectionCaps(cylinder, { axis: 2, value: 0.6, keep: -1 }, 0.01);
  assert.ok(Math.abs(capped.data[3] - 2 * Math.sqrt(1 - 0.36)) < 1e-6, 'cylinder cap is not its chord');
  assert.ok(capped.data[2] < 0.6);
});

test('section planes snap onto whole columns of vertical conductors', () => {
  const hero = PRESETS[5];
  // Transistor scale: x snaps onto a nano-TSV column, z onto a power rail.
  const x = snapSection(0, hero.x, hero.z, 0.001);
  assert.ok(Math.abs(x - hero.x) <= 4 * CPP + 1e-12);
  const chunk = generateChunk(4, Math.floor(hero.x / LEVELS[4].chunk), Math.floor(hero.z / LEVELS[4].chunk));
  const z = snapSection(2, hero.x, hero.z, 0.001);
  assert.ok(Math.abs(z / ROW - Math.round(z / ROW)) < 1e-9);
  const caps = sectionCaps(chunk, { axis: 2, value: z, keep: 1 }, um(0.0005));
  const deep = caps.flatMap((batch) => instances(batch)).filter((v) => v[1] - v[4] / 2 < -um(0.5));
  assert.ok(deep.length > 0, 'a rail-aligned cut should expose the nano-TSVs under the rail');
  // Tile scale near the SRAM strip: onto the TSV column.
  const tsv = snapSection(0, 0.011, 1.0, 0.8);
  assert.ok(Math.abs(tsv) < 1e-12 || Math.abs(Math.abs(tsv) - um(30)) < 1e-12);
  // Away from any column the plane stays where it was.
  assert.equal(snapSection(0, 5.1234, 3.21, 0.8), 5.1234);
});

test('zoom stops, crater, and presets cover package to transistor', () => {
  for (let k = 1; k < FOCUS_STOPS.length; k += 1) assert.ok(FOCUS_STOPS[k].below < FOCUS_STOPS[k - 1].below);
  for (const preset of PRESETS) assert.equal(focusStopFor(preset.distance).id, preset.id, `${preset.label} lands on the wrong stop`);
  assert.equal(focusStopFor(0.0125, 'cells').id, 'cells', 'hysteresis should hold the current stop');
  assert.equal(focusStopFor(0.02, 'cells').id, 'routing');
  const devices = focusStopFor(0.001);
  const crater = craterFor(devices, 0.001, 1.2);
  assert.ok(crater && crater.radius >= 0.001 * Math.sin(1.2) + 0.001, 'crater must contain the camera column');
  assert.ok(crater && crater.floor > STACK.contact[1] && crater.floor < STACK.m0[0], 'the device floor must sit in the contact/M0 gap');
  assert.equal(craterFor(focusStopFor(40), 40, 0.6), null);
  // Every floor must fall in a gap: no band may straddle it, or delayering
  // would leave a sliver of the layer behind.
  const bands = Object.entries(STACK).filter(([name]) => name !== 'tsv' && name !== 'dtc');
  for (const stopItem of FOCUS_STOPS) {
    if (stopItem.floor === null) continue;
    for (const [name, [y0, y1]] of bands) assert.ok(!(y0 < stopItem.floor && y1 > stopItem.floor), `${name} straddles the ${stopItem.id} floor`);
  }
  assert.equal(leafAt(PRESETS[5].x, PRESETS[5].z), 'logic');
  assert.equal(SILICON_EVIDENCE.class, 'illustrative');
});

test('fly paths stay finite across five orders of magnitude and end where asked', () => {
  const from = { x: 0, z: 0, width: 45 };
  const to = { x: PRESETS[5].x, z: PRESETS[5].z, width: 0.0011 };
  const path = zoomPanPath(from, to);
  assert.ok(Number.isFinite(path.length) && path.length > 0);
  const start = path.at(0);
  const end = path.at(path.length);
  assert.ok(Math.abs(start.x - from.x) < 1e-9 && Math.abs(start.width - from.width) < 1e-6);
  assert.ok(Math.abs(end.x - to.x) < 1e-6 && Math.abs(end.z - to.z) < 1e-6);
  assert.ok(Math.abs(end.width / to.width - 1) < 1e-6);
  let previous = Infinity;
  for (let k = 0; k <= 64; k += 1) {
    const point = path.at((path.length * k) / 64);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.width) && point.width > 0);
    assert.ok(point.width <= previous * (1 + 1e-9), 'zooming in should never zoom back out');
    previous = point.width;
  }
  const zoomOnly = zoomPanPath({ x: 1, z: 1, width: 1 }, { x: 1, z: 1, width: 1e-4 });
  assert.ok(Math.abs(zoomOnly.at(zoomOnly.length).width - 1e-4) < 1e-12);
});

test('scale bar picks round lengths in the right unit', () => {
  assert.equal(formatLength(2), '2 mm');
  assert.equal(formatLength(0.05), '50 µm');
  assert.equal(formatLength(2e-5), '20 nm');
  const bar = scaleBar(0.001, 110);
  assert.equal(bar.label, '100 µm');
  assert.ok(bar.px > 50 && bar.px < 220);
});
