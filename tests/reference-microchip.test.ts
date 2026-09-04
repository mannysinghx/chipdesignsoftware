import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMEM_REFERENCE_MACROS, OPEN_TITAN_REFERENCE, SKY130_VISUAL_LAYERS } from '../lib/reference-microchip.ts';

test('real-chip reference preserves published Earl Grey organization facts', () => {
  assert.equal(OPEN_TITAN_REFERENCE.top, 'chip_earlgrey_asic');
  assert.equal(OPEN_TITAN_REFERENCE.powerDomains.length, 2);
  assert.equal(OPEN_TITAN_REFERENCE.clocks.length, 4);
  assert.equal(OPEN_TITAN_REFERENCE.busLevels, 2);
  assert.equal(OPEN_TITAN_REFERENCE.asicPadCount, 71);
  assert.equal(OPEN_TITAN_REFERENCE.ioBanks, 4);
});

test('AIMEM adaptation includes functional macros in both power domains', () => {
  assert.equal(AIMEM_REFERENCE_MACROS.length, 8);
  assert.ok(AIMEM_REFERENCE_MACROS.some((macro) => macro.domain === 'main'));
  assert.ok(AIMEM_REFERENCE_MACROS.some((macro) => macro.domain === 'always-on'));
  assert.equal(new Set(AIMEM_REFERENCE_MACROS.map((macro) => macro.id)).size, AIMEM_REFERENCE_MACROS.length);
});

test('physical visualization follows the public SKY130 local-to-global metal stack', () => {
  assert.deepEqual(SKY130_VISUAL_LAYERS.map((layer) => layer.id), ['li1', 'met1', 'met2', 'met3', 'met4', 'met5']);
});

import { readFileSync } from 'node:fs';
import { ACCELERATOR_FLOORPLAN, BASE_DIE_FLOORPLAN, X1_BASE_DIE_AREA_BUDGET_MM2, X1_BASE_DIE_MM, floorplanAreaMm2, floorplanBudgetCheck } from '../lib/reference-microchip.ts';

test('base-die area budget matches the versioned X1 production spec', () => {
  const spec = JSON.parse(readFileSync(new URL('../design/spec/aimem-x1-production.json', import.meta.url), 'utf8'));
  assert.deepEqual(X1_BASE_DIE_AREA_BUDGET_MM2, spec.base_die_area_budget_mm2);
  assert.deepEqual(spec.stack.architectural_floorplan_mm, [X1_BASE_DIE_MM, X1_BASE_DIE_MM]);
});

test('base-die floorplan tiles the die without gaps or overlaps and tracks the budget', () => {
  const half = X1_BASE_DIE_MM / 2;
  for (const block of BASE_DIE_FLOORPLAN) {
    assert.ok(block.xMm[0] >= -half && block.xMm[1] <= half && block.zMm[0] >= -half && block.zMm[1] <= half, `${block.id} leaves the die`);
    assert.ok(block.xMm[1] > block.xMm[0] && block.zMm[1] > block.zMm[0]);
  }
  for (let a = 0; a < BASE_DIE_FLOORPLAN.length; a += 1) for (let b = a + 1; b < BASE_DIE_FLOORPLAN.length; b += 1) {
    const first = BASE_DIE_FLOORPLAN[a];
    const second = BASE_DIE_FLOORPLAN[b];
    const overlap = first.xMm[0] < second.xMm[1] && second.xMm[0] < first.xMm[1] && first.zMm[0] < second.zMm[1] && second.zMm[0] < first.zMm[1];
    assert.equal(overlap, false, `${first.id} overlaps ${second.id}`);
  }
  const check = floorplanBudgetCheck();
  assert.ok(Math.abs(check.placedTotal - check.dieAreaMm2) < 1e-9, 'floorplan does not tile the full die');
  assert.ok(check.maxDeviationPercent <= 8, `budget deviation ${check.maxDeviationPercent.toFixed(1)}% exceeds 8%`);
  const phy = BASE_DIE_FLOORPLAN.find((block) => block.id === 'phy')!;
  assert.equal(phy.zMm[1], half, 'PHY strip must sit on the accelerator-facing edge');
  assert.ok(Math.abs(floorplanAreaMm2(phy) - X1_BASE_DIE_AREA_BUDGET_MM2.phy) < 1);
});

test('accelerator floorplan exposes one memory PHY per adjacent stack', () => {
  assert.equal(ACCELERATOR_FLOORPLAN.memoryPhys, 8);
  assert.ok(ACCELERATOR_FLOORPLAN.computeTiles.columns * ACCELERATOR_FLOORPLAN.computeTiles.rows >= 20);
});
