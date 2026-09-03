import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_X1_CONFIG, evaluateX1 } from '../lib/x1-model.ts';

test('default X1 configuration matches the production architecture target', () => {
  const result = evaluateX1(DEFAULT_X1_CONFIG);
  assert.equal(result.rawBandwidthPerStackTbps, 8.192);
  assert.equal(result.aggregateRawBandwidthTbps, 65.536);
  assert.equal(result.totalCapacityGib, 1024);
  assert.equal(result.pseudochannelsPerStack, 256);
  assert.equal(result.banksPerStack, 4096);
  assert.equal(result.subarraysPerStack, 524288);
  assert.equal(result.protectedConductorsPerStack, 9472);
});

test('performance states reproduce source-defined per-stack bandwidth', () => {
  assert.equal(evaluateX1({ ...DEFAULT_X1_CONFIG, performanceState: 'performance' }).rawBandwidthPerStackTbps, 10.24);
  assert.equal(evaluateX1({ ...DEFAULT_X1_CONFIG, performanceState: 'turbo' }).rawBandwidthPerStackTbps, 12.288);
  assert.equal(evaluateX1({ ...DEFAULT_X1_CONFIG, performanceState: 'turbo' }).aggregateRawBandwidthTbps, 98.304);
});

test('64 GB stack mode produces 512 GB across eight stacks', () => {
  const result = evaluateX1({ ...DEFAULT_X1_CONFIG, capacityGibPerStack: 64 });
  assert.equal(result.totalCapacityGib, 512);
});

test('accelerator fabric caps delivered bandwidth and is named as the bottleneck', () => {
  const result = evaluateX1({ ...DEFAULT_X1_CONFIG, acceleratorFabricTbps: 32 });
  assert.equal(result.deliveredBandwidthTbps, 32);
  assert.equal(result.bottleneck, 'accelerator fabric');
});

test('production promotion remains blocked without qualified T1 evidence', () => {
  const result = evaluateX1(DEFAULT_X1_CONFIG);
  assert.equal(result.decision, 'hold');
  assert.equal(result.t1QualificationGatesPassed, 0);
  assert.ok(result.gates.some((gate) => gate.id === 'X1-T1-QUAL' && gate.status === 'blocked'));
});
