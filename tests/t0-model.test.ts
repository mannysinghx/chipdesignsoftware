import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_T0_CONFIG, evaluateT0, runT0Sweep } from '../lib/t0-model.ts';

test('default T0 organization matches the pathfinder baseline', () => {
  const result = evaluateT0(DEFAULT_T0_CONFIG);
  assert.equal(result.payloadLanes, 1024);
  assert.equal(result.pseudochannels, 32);
  assert.equal(result.banks, 512);
  assert.equal(result.rawBandwidthTbps, 1.024);
  assert.equal(result.perChannelBandwidthGbps, 64);
});

test('eco mode fails the raw T0 bandwidth gate', () => {
  const result = evaluateT0({ ...DEFAULT_T0_CONFIG, laneRateGbps: 4 });
  assert.equal(result.rawBandwidthTbps, 0.512);
  assert.equal(result.gates.find((gate) => gate.id === 'T0-BW-RAW')?.status, 'fail');
});

test('long turbo route is classified as high risk', () => {
  const result = evaluateT0({ ...DEFAULT_T0_CONFIG, laneRateGbps: 12, interconnectLengthMm: 10 });
  assert.equal(result.linkRisk, 'high');
});

test('sweep covers four lane rates and three SRAM sizes', () => {
  const sweep = runT0Sweep(DEFAULT_T0_CONFIG);
  assert.equal(sweep.length, 12);
  assert.deepEqual([...new Set(sweep.map(({ config }) => config.laneRateGbps))], [4, 8, 10, 12]);
  assert.deepEqual([...new Set(sweep.map(({ config }) => config.sramMib))], [8, 16, 32]);
});
