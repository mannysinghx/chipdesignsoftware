import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_T0_CONFIG } from '../lib/t0-model.ts';
import { evaluateT0Campaign, runWorkloadCampaign } from '../lib/t0-campaign.ts';

test('campaign is deterministic and covers four representative traffic classes', () => {
  const first = runWorkloadCampaign(DEFAULT_T0_CONFIG, 1024);
  const second = runWorkloadCampaign(DEFAULT_T0_CONFIG, 1024);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((result) => result.id), ['dense-stream', 'bank-random', 'kv-decode', 'sparse-gather']);
});

test('baseline compact thermal model stays below the provisional hotspot limit', () => {
  const campaign = evaluateT0Campaign(DEFAULT_T0_CONFIG);
  assert.ok(campaign.thermal.hotspotC < 85);
  assert.equal(campaign.thermal.throttlingRequired, false);
});

test('silicon evidence cannot be marked complete by the open-source proxy flow', () => {
  const campaign = evaluateT0Campaign(DEFAULT_T0_CONFIG);
  const silicon = campaign.domains.find((domain) => domain.id === 'silicon');
  assert.equal(silicon?.maturity, 'external');
  assert.equal(silicon?.completionPercent, 0);
  assert.ok(campaign.openSourceReadinessPercent > campaign.overallProgramReadinessPercent);
  assert.equal(campaign.siliconEvidencePercent, 0);
});

test('higher lane rate increases modeled power and hotspot temperature', () => {
  const nominal = evaluateT0Campaign(DEFAULT_T0_CONFIG);
  const turbo = evaluateT0Campaign({ ...DEFAULT_T0_CONFIG, laneRateGbps: 12 });
  assert.ok(turbo.power.totalWatts > nominal.power.totalWatts);
  assert.ok(turbo.thermal.hotspotC > nominal.thermal.hotspotC);
});
