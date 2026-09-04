import test from 'node:test';
import assert from 'node:assert/strict';
import evidence from '../evidence/physical-synthesis.json' with { type: 'json' };
import { PHYSICAL_STAGES, evaluatePhysicalImplementation } from '../lib/physical-implementation.ts';

test('physical workspace is anchored to reproduced Sky130 mapping evidence', () => {
  const result = evaluatePhysicalImplementation('mapped', 55, evidence);
  assert.equal(result.evidence.top, 'aimem_t0_channel');
  assert.equal(result.evidence.mapped_cells, 2447);
  assert.equal(result.evidence.chip_area_um2, 26766.9216);
  assert.equal(result.passedStages, 2);
});

test('physical stage chain preserves public and restricted boundaries', () => {
  assert.equal(PHYSICAL_STAGES.length, 11);
  assert.equal(PHYSICAL_STAGES.at(-1)?.status, 'restricted');
  assert.equal(PHYSICAL_STAGES.at(-1)?.id, 'production');
});

test('floorplan sizing responds deterministically to utilization', () => {
  const relaxed = evaluatePhysicalImplementation('implementation', 45, evidence);
  const dense = evaluatePhysicalImplementation('implementation', 75, evidence);
  assert.ok(relaxed.coreAreaUm2 > dense.coreAreaUm2);
  assert.ok(relaxed.dieSideUm > dense.dieSideUm);
  assert.ok(relaxed.routingPressure < dense.routingPressure);
});

test('utilization is bounded and planning never clears release hold', () => {
  const low = evaluatePhysicalImplementation('signoff', 1, evidence);
  const high = evaluatePhysicalImplementation('signoff', 100, evidence);
  assert.equal(low.utilizationPercent, 35);
  assert.equal(high.utilizationPercent, 80);
  assert.equal(low.decision, 'hold');
  assert.equal(high.decision, 'hold');
  assert.equal(high.restrictedStages, 1);
});
