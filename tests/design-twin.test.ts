import assert from 'node:assert/strict';
import test from 'node:test';
import { TWIN_BUILD_STEPS, TWIN_HIERARCHY, TWIN_OVERLAYS, twinStageCounts, twinStageProgress } from '../lib/design-twin.ts';

test('3D twin covers the end-to-end build with explicit evidence boundaries', () => {
  assert.equal(TWIN_BUILD_STEPS.length, 12);
  assert.deepEqual(twinStageCounts(), { executed: 5, modeled: 2, planned: 2, restricted: 3 });
  assert.equal(TWIN_BUILD_STEPS[0].id, 'requirements');
  assert.equal(TWIN_BUILD_STEPS.at(-1)?.id, 'release');
});

test('3D twin exposes every requested analytical overlay and hierarchy layer', () => {
  assert.deepEqual(TWIN_OVERLAYS.map((overlay) => overlay.id), ['architecture', 'bandwidth', 'power', 'thermal', 'evidence']);
  assert.equal(TWIN_HIERARCHY.length, 6);
});

test('build progress clamps to the available sequence', () => {
  assert.equal(twinStageProgress(-5), 8);
  assert.equal(twinStageProgress(5), 50);
  assert.equal(twinStageProgress(99), 100);
});
