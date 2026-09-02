import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateT1DigitalCampaign } from '../lib/t1-campaign.ts';
import { DEFAULT_T1_CONFIG } from '../lib/t1-model.ts';

test('T1 digital campaign is deterministic and covers four workloads', () => {
  const first = evaluateT1DigitalCampaign(DEFAULT_T1_CONFIG);
  const second = evaluateT1DigitalCampaign(DEFAULT_T1_CONFIG);
  assert.deepEqual(first, second);
  assert.equal(first.workloads.length, 4);
  assert.equal(first.fabric.regions, 8);
  assert.equal(first.fabric.channelsPerRegion, 8);
});

test('T1 mode study preserves source-defined bandwidth and power ordering', () => {
  const campaign = evaluateT1DigitalCampaign(DEFAULT_T1_CONFIG);
  assert.deepEqual(campaign.modes.map((mode) => mode.rawBandwidthTbps), [4.096, 6.144]);
  assert.ok(campaign.modes[1].interfacePowerProxyWatts > campaign.modes[0].interfacePowerProxyWatts);
});

test('T1 workload delivery respects physical bandwidth and explicit gather uplift', () => {
  const campaign = evaluateT1DigitalCampaign(DEFAULT_T1_CONFIG);
  assert.ok(campaign.workloads.filter((workload) => workload.hostTrafficReductionPercent === 0).every((workload) => workload.usefulBandwidthTbps <= 4.096));
  assert.ok(campaign.workloads.every((workload) => workload.usefulBandwidthTbps <= 4.096 * (1 + workload.hostTrafficReductionPercent / 100)));
});
