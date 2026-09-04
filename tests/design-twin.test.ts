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
  assert.deepEqual(TWIN_OVERLAYS.map((overlay) => overlay.id), ['circuitry', 'architecture', 'bandwidth', 'power', 'thermal', 'evidence']);
  assert.equal(TWIN_HIERARCHY.length, 8);
});

test('build progress clamps to the available sequence', () => {
  assert.equal(twinStageProgress(-5), 8);
  assert.equal(twinStageProgress(5), 50);
  assert.equal(twinStageProgress(99), 100);
});

import { ALL_TWIN_OVERLAYS, DEFAULT_TWIN_OVERLAYS, normalizeTwinOverlays, toggleTwinOverlay, twinOverlaySummary, twinOverlaysAreComplete, type TwinOverlay } from '../lib/design-twin.ts';

test('overlay selection covers every overlay and starts on a single default', () => {
  assert.deepEqual(ALL_TWIN_OVERLAYS, TWIN_OVERLAYS.map((overlay) => overlay.id));
  assert.deepEqual(DEFAULT_TWIN_OVERLAYS, ['circuitry']);
  assert.equal(twinOverlaysAreComplete(ALL_TWIN_OVERLAYS), true);
  assert.equal(twinOverlaysAreComplete(DEFAULT_TWIN_OVERLAYS), false);
});

test('toggling overlays keeps canonical order, dedupes, and never empties the set', () => {
  assert.deepEqual(toggleTwinOverlay(['circuitry'], 'power'), ['circuitry', 'power']);
  assert.deepEqual(toggleTwinOverlay(['power', 'circuitry'], 'architecture'), ['circuitry', 'architecture', 'power']);
  assert.deepEqual(toggleTwinOverlay(['circuitry', 'power'], 'power'), ['circuitry']);
  assert.deepEqual(toggleTwinOverlay(['circuitry'], 'circuitry'), ['circuitry'], 'the last overlay cannot be turned off');
  assert.deepEqual(normalizeTwinOverlays([]), DEFAULT_TWIN_OVERLAYS);
  assert.deepEqual(normalizeTwinOverlays(['power', 'power', 'circuitry'] as TwinOverlay[]), ['circuitry', 'power']);
  const everyOverlayOn = ALL_TWIN_OVERLAYS.reduce<TwinOverlay[]>((active, id) => toggleTwinOverlay(active, id), DEFAULT_TWIN_OVERLAYS);
  assert.deepEqual(everyOverlayOn, ALL_TWIN_OVERLAYS);
});

test('overlay summary names a single overlay and counts a composite', () => {
  assert.equal(twinOverlaySummary(['power']), 'power overlay');
  assert.equal(twinOverlaySummary(['circuitry', 'power']), '2 overlays composited');
  assert.equal(twinOverlaySummary(ALL_TWIN_OVERLAYS), 'all 6 overlays composited');
});
