import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLaneRepairMap, decodeSecded64, encodeSecded64, generateGatherAddresses, runReliabilityCampaign } from '../lib/t0-reliability.ts';

test('SECDED round-trips representative 64-bit patterns', () => {
  for (const pattern of [0n, 1n, 0xffffffffffffffffn, 0xa5a5a5a55a5a5a5an, 0x0123456789abcdefn]) {
    const decoded = decodeSecded64(encodeSecded64(pattern));
    assert.equal(decoded.data, pattern);
    assert.equal(decoded.corrected, false);
    assert.equal(decoded.uncorrectable, false);
  }
});

test('fault campaign corrects every single-bit error and detects every double-bit error', () => {
  const campaign = runReliabilityCampaign();
  assert.equal(campaign.singleBitInjections, 360);
  assert.equal(campaign.singleBitCorrections, 360);
  assert.equal(campaign.doubleBitInjections, 2556);
  assert.equal(campaign.doubleBitDetections, 2556);
});

test('two spare lanes repair any two unique lane failures', () => {
  const repair = buildLaneRepairMap(64, 2, [7, 41]);
  assert.equal(repair.repairable, true);
  assert.equal(repair.mapping[7], 64);
  assert.equal(repair.mapping[41], 65);
  assert.equal(buildLaneRepairMap(64, 2, [7, 41, 52]).repairable, false);
});

test('gather reference emits the expected strided address sequence', () => {
  assert.deepEqual(generateGatherAddresses(0x1000n, 128, 4), [0x1000n, 0x1080n, 0x1100n, 0x1180n]);
});
