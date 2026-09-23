import assert from 'node:assert/strict';
import test from 'node:test';
import { DIE, EDGE_BLOCKS, LEVELS, PHYS, PRESETS, ROW, STACK, TILES, cellAt, generateChunk, generateGlobal, type ChunkData } from '../lib/silicon-macro.ts';
import { LABEL_PLAN, PARTS, PART_IDS, STACK_RULER, describePrimitive, identifyChunk, legendFor, legendGaps, regionLabels, type PartId } from '../lib/silicon-parts.ts';

const partsIn = (chunk: ChunkData) => {
  const found = new Map<PartId, number>();
  identifyChunk(chunk).forEach((ids) => ids.forEach((index) => found.set(PART_IDS[index], (found.get(PART_IDS[index]) ?? 0) + 1)));
  return found;
};
const chunkAt = (level: number, x: number, z: number) => generateChunk(level, Math.floor(x / LEVELS[level].chunk), Math.floor(z / LEVELS[level].chunk));
const hero = PRESETS[5];

test('every primitive the generator draws has a specific name', () => {
  const spots: Array<[number, number, number]> = [
    [4, hero.x, hero.z], [3, hero.x, hero.z], [2, PRESETS[3].x, PRESETS[3].z], [1, PRESETS[3].x, PRESETS[3].z],
    [1, 0, 1], [2, 0, 1], [3, -0.6, 2], [4, -0.6, 2],
    [1, PHYS[0].rect.x0 + 3, PHYS[0].rect.z0 + 1], [1, 0.5, -DIE.depth / 2 + 0.3], [4, 0, -DIE.depth / 2 + 0.7], [3, 0, -DIE.depth / 2 + 0.7],
    // The PLL inductors are top metal, so the global layer (checked below) covers them.
    [1, TILES[7].router.x0 + 0.1, TILES[7].router.z0 + 0.1], [2, EDGE_BLOCKS[1].inductors[0].cx, EDGE_BLOCKS[1].inductors[0].cz + 0.5],
  ];
  for (const [level, x, z] of spots) {
    const found = partsIn(chunkAt(level, x, z));
    assert.ok(found.size > 0, `nothing drawn at level ${level} (${x}, ${z})`);
    assert.equal(found.get('metal') ?? 0, 0, `unnamed primitives at level ${level} (${x.toFixed(3)}, ${z.toFixed(3)}): ${[...found.keys()].join(', ')}`);
  }
  assert.equal(partsIn(generateGlobal()).get('metal') ?? 0, 0);
});

test('each zoom level shows the parts it should', () => {
  const expect = (chunk: ChunkData, parts: PartId[]) => {
    const found = partsIn(chunk);
    for (const part of parts) assert.ok(found.has(part), `missing ${part}; found ${[...found.keys()].join(', ')}`);
  };
  expect(chunkAt(4, hero.x, hero.z), ['fin', 'gate', 'gate-dummy', 'epi-n', 'epi-p', 'contact-md', 'contact-vg', 'well-tap', 'bpr', 'nano-tsv', 'backside-rail']);
  expect(chunkAt(3, hero.x, hero.z), ['m0-rail', 'm0-wire', 'm1-pin', 'v0', 'm2', 'm3', 'v2']);
  expect(chunkAt(2, PRESETS[3].x, PRESETS[3].z), ['mx1', 'mx2', 'mx3', 'vx1', 'mx4-strap']);
  expect(chunkAt(1, PRESETS[3].x, PRESETS[3].z), ['systolic-bus', 'pe-pins', 'semi-global-strap', 'strap-via']);
  expect(chunkAt(1, 0, 1), ['tsv', 'tsv-liner', 'tsv-plug', 'tsv-landing', 'tsv-via-stack', 'tsv-strap-pad']);
  expect(chunkAt(1, PHYS[0].rect.x0 + 3, PHYS[0].rect.z0 + 1), ['ubm', 'pillar', 'solder-cap']);
  expect(chunkAt(4, 0, -DIE.depth / 2 + 0.7), ['dtc', 'dtc-liner']);
  expect(generateGlobal(), ['global-strap', 'top-via', 'tile-ring', 'noc-lane', 'bond-pad', 'seal-ring', 'inductor', 'pad-lead', 'pad-frame', 'sram-spine', 'inductor-guard', 'inductor-underpass']);
});

test('the read-out names the cell, the supply, and the active nets', () => {
  const chunk = chunkAt(4, hero.x, hero.z);
  const ids = identifyChunk(chunk);
  let gate = false;
  let rail = false;
  chunk.batches.forEach((batch, b) => {
    for (let k = 0; k < batch.count; k += 1) {
      const o = k * 10;
      const d = batch.data;
      const ref = { level: 4, material: batch.material, shape: batch.shape, x: d[o] + chunk.origin[0], z: d[o + 2] + chunk.origin[2], y0: d[o + 1] - d[o + 4] / 2, y1: d[o + 1] + d[o + 4] / 2, sx: d[o + 3], sz: d[o + 5], glow: d[o + 8] };
      const id = PART_IDS[ids[b][k]];
      if (id === 'gate' && !gate) {
        const out = describePrimitive(ref, id);
        assert.match(out.notes.join(' '), /cell \(/);
        assert.equal(out.title, PARTS.gate.title);
        assert.match(out.size, /nm/);
        gate = true;
      }
      if (id === 'bpr' && !rail) {
        assert.match(describePrimitive(ref, id).notes.join(' '), /Carries (VDD|VSS)/);
        rail = true;
      }
    }
  });
  assert.ok(gate && rail);
});

test('region labels cover the die and name the standard cells around the target', () => {
  const die = regionLabels('die', 0, 0);
  assert.equal(die.filter((label) => label.id.startsWith('tile-')).length, TILES.length);
  assert.equal(die.filter((label) => label.id.startsWith('phy-')).length, PHYS.length);
  const cells = regionLabels('cells', hero.x, hero.z).filter((label) => label.id.startsWith('cell-'));
  assert.ok(cells.length >= 6, `only ${cells.length} cell labels`);
  for (const label of cells) {
    const hit = cellAt(label.x, label.z);
    assert.ok(hit && label.title.startsWith(hit.cell.type), `${label.title} is not the cell at its anchor`);
    assert.ok(Math.abs(label.z - (hit.row + 0.5) * ROW) < 1e-12);
  }
});

test('the cross-section ruler runs bottom to top', () => {
  for (let k = 0; k < STACK_RULER.length; k += 1) {
    assert.ok(STACK_RULER[k].y0 < STACK_RULER[k].y1, `${STACK_RULER[k].id} is empty`);
    if (k > 0) assert.ok(STACK_RULER[k].y0 >= STACK_RULER[k - 1].y0, `${STACK_RULER[k].id} is out of order`);
  }
  assert.ok(STACK_RULER.at(-1)!.y1 >= STACK.solder[1] - 1e-12);
});

test('picking returns the nearest drawn primitive and honours cuts', async () => {
  const { pickChunk } = await import('../lib/silicon-parts.ts');
  const chunk: ChunkData = {
    level: 1, ix: 0, iz: 0, origin: [10, 0, 0], bounds: { x0: 9, z0: -1, x1: 11, z1: 1 }, yMin: -1, yMax: 1, instances: 3,
    batches: [
      { material: 'copper', shape: 'box', count: 2, data: new Float32Array([0, 0.5, 0, 0.2, 0.2, 0.2, 0, 0, 0, 0, 0, -0.5, 0, 0.2, 0.2, 0.2, 0, 0, 0, 0]) },
      { material: 'copper', shape: 'cyl', count: 1, data: new Float32Array([0.5, 0, 0, 0.2, 1, 0.2, 0, 0, 0, 0]) },
    ],
  };
  // Straight down onto the upper box.
  const down = pickChunk(chunk, [10, 5, 0], [0, -1, 0]);
  assert.deepEqual([down?.batch, down?.index], [0, 0]);
  assert.ok(Math.abs(down!.t - 4.4) < 1e-6);
  // Skipping hits above y = 0.5 (as the crater would) reveals the lower box.
  const below = pickChunk(chunk, [10, 5, 0], [0, -1, 0], 0, Infinity, (_x, y) => y > 0.5);
  assert.deepEqual([below?.batch, below?.index], [0, 1]);
  // Side-on into the cylinder.
  const side = pickChunk(chunk, [8, 0, 0], [1, 0, 0]);
  assert.deepEqual([side?.batch, side?.index], [1, 0]);
  assert.ok(Math.abs(side!.t - 2.4) < 1e-6);
  // A ray starting at a section plane inside the upper box hits it at the plane.
  const cut = pickChunk(chunk, [9, 0.5, 0], [1, 0, 0], 1);
  assert.deepEqual([cut?.batch, cut?.index, cut?.t], [0, 0, 1]);
  // Missing everything.
  assert.equal(pickChunk(chunk, [10, 5, 5], [0, -1, 0]), null);
  // Oblique rays agree with a brute-force march through the boxes.
  const inBox = (p: number[], c: number[], h: number) => Math.abs(p[0] - c[0]) <= h && Math.abs(p[1] - c[1]) <= h && Math.abs(p[2] - c[2]) <= h;
  for (let k = 0; k < 200; k += 1) {
    const origin: [number, number, number] = [10 + Math.sin(k) * 2, 3 + Math.cos(k * 1.7), Math.sin(k * 2.3) * 2];
    const target = [10 + Math.sin(k * 0.7) * 0.15, Math.sin(k * 1.3) * 0.7, Math.cos(k * 0.9) * 0.15];
    const len = Math.hypot(target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]);
    const dir: [number, number, number] = [(target[0] - origin[0]) / len, (target[1] - origin[1]) / len, (target[2] - origin[2]) / len];
    const boxesOnly: ChunkData = { ...chunk, batches: [chunk.batches[0]] };
    const hit = pickChunk(boxesOnly, origin, dir);
    let marched: number | null = null;
    for (let t = 0; t < 8; t += 1e-4) {
      const p = [origin[0] + t * dir[0], origin[1] + t * dir[1], origin[2] + t * dir[2]];
      if (inBox(p, [10, 0.5, 0], 0.1) || inBox(p, [10, -0.5, 0], 0.1)) { marched = t; break; }
    }
    assert.equal(hit === null, marched === null, `ray ${k}: pick ${hit?.t} vs march ${marched}`);
    if (hit && marched !== null) assert.ok(Math.abs(hit.t - marched) < 2e-4, `ray ${k}: ${hit.t} vs ${marched}`);
  }
});

test('the legend covers every stop with swatches, and labelled parts are all in it', () => {
  assert.deepEqual(legendGaps(), []);
  for (const stop of ['die', 'tile', 'block', 'routing', 'cells', 'devices'] as const) {
    const ids = legendFor(stop).map((item) => item.id);
    for (const part of LABEL_PLAN[stop]) assert.ok(ids.includes(part), `${stop} legend lacks ${part}`);
  }
  assert.deepEqual(legendFor('package').map((item) => item.id), ['die', 'hbm', 'interposer', 'substrate', 'capacitor', 'bga']);
  assert.ok(legendFor('routing').some((item) => item.glow), 'animated nets are marked');
});
