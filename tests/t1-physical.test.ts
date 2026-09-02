import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_T1_CONFIG } from '../lib/t1-model.ts';
import { evaluateT1PhysicalProxy } from '../lib/t1-physical.ts';

test('baseline T1 proxy couples power, routing, package and eight regions', () => {
  const result = evaluateT1PhysicalProxy(DEFAULT_T1_CONFIG);
  assert.equal(result.regions.length, 8);
  assert.ok(result.power.totalPowerWatts > 0);
  assert.ok(result.thermal.marginC > 0);
  assert.equal(result.solverHandoffs.length, 4);
});

test('turbo mode increases interface power, skew and hotspot temperature', () => {
  const nominal = evaluateT1PhysicalProxy(DEFAULT_T1_CONFIG);
  const turbo = evaluateT1PhysicalProxy({ ...DEFAULT_T1_CONFIG, laneRateGbps: 12 });
  assert.ok(turbo.power.interfaceWatts > nominal.power.interfaceWatts);
  assert.ok(turbo.package.skewPs > nominal.package.skewPs);
  assert.ok(turbo.thermal.hotspotC > nominal.thermal.hotspotC);
});

test('poor cooling crosses the provisional thermal limit', () => {
  const result = evaluateT1PhysicalProxy({ ...DEFAULT_T1_CONFIG, coolingResistanceKPerW: 1.2, activityPercent: 95 });
  assert.ok(result.thermal.hotspotC > 85);
  assert.equal(result.thermal.risk, 'high');
});
