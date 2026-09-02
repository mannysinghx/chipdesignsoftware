import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_T0_CONFIG, evaluateT0 } from '../lib/t0-model.ts';
import { DEFAULT_T1_CONFIG, evaluateT1 } from '../lib/t1-model.ts';

test('default T1 organization matches the engineering-sample baseline', () => {
  const result = evaluateT1(DEFAULT_T1_CONFIG, evaluateT0(DEFAULT_T0_CONFIG).gates);
  assert.equal(result.channels, 64);
  assert.equal(result.pseudochannels, 128);
  assert.equal(result.banks, 2048);
  assert.equal(result.rawBandwidthTbps, 4.096);
  assert.equal(result.sramPerRegionMib, 8);
});

test('experimental T1 mode reaches the source-defined raw bandwidth', () => {
  const result = evaluateT1({ ...DEFAULT_T1_CONFIG, laneRateGbps: 12 }, evaluateT0(DEFAULT_T0_CONFIG).gates);
  assert.equal(result.rawBandwidthTbps, 6.144);
});

test('T1 entry remains on hold while T0 gates are proxy or unverified', () => {
  const result = evaluateT1(DEFAULT_T1_CONFIG, evaluateT0(DEFAULT_T0_CONFIG).gates);
  assert.equal(result.entryDecision, 'hold');
  assert.equal(result.verifiedT0Gates, 0);
  assert.equal(result.provisionalT0Gates, 10);
  assert.equal(result.blockedT0Gates, 2);
});
