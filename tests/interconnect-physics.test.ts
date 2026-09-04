import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_INTERCONNECT_INPUTS, evaluateCircuitTopology, evaluateInterconnectPhysics } from '../lib/interconnect-physics.ts';

test('interconnect physics returns finite positive electrical quantities', () => {
  const result = evaluateInterconnectPhysics(DEFAULT_INTERCONNECT_INPUTS);
  for (const value of [result.resistanceOhms, result.flightTimePs, result.rcDelayPs, result.totalElectricalDelayPs, result.energyPerTransitionPj, result.aggregateDynamicPowerWatts, result.currentDensityMAcm2]) {
    assert.ok(Number.isFinite(value) && value > 0);
  }
  assert.ok(result.totalElectricalDelayPs > result.flightTimePs);
});

test('longer routes increase resistance, capacitance, flight time, and energy', () => {
  const short = evaluateInterconnectPhysics({ ...DEFAULT_INTERCONNECT_INPUTS, routeLengthMm: 4 });
  const long = evaluateInterconnectPhysics({ ...DEFAULT_INTERCONNECT_INPUTS, routeLengthMm: 20 });
  assert.ok(long.resistanceOhms > short.resistanceOhms);
  assert.ok(long.capacitanceFf > short.capacitanceFf);
  assert.ok(long.flightTimePs > short.flightTimePs);
  assert.ok(long.energyPerTransitionPj > short.energyPerTransitionPj);
});

test('X1 topology accounts for every hierarchical circuit endpoint', () => {
  assert.deepEqual(evaluateCircuitTopology(8, 16), {
    stackCount: 8,
    dramTiers: 128,
    intelligentBaseDies: 8,
    nocRegions: 128,
    physicalChannels: 1024,
    pseudochannels: 2048,
    banks: 32768,
    subarrays: 4194304,
    payloadLanes: 65536,
    protectedConductors: 75776,
    routeBundles: 256,
    hybridBondInterfaces: 128,
  });
});
