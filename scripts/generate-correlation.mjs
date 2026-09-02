import { readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_T0_CONFIG } from '../lib/t0-model.ts';
import { runWorkloadCampaign } from '../lib/t0-campaign.ts';

const raw = JSON.parse(await readFile('evidence/ramulator2-raw.json', 'utf8'));
const internal = runWorkloadCampaign(DEFAULT_T0_CONFIG);
const hbmTickNs = 0.3125;

const results = internal.map((workload) => {
  const reference = raw.results.find((entry) => entry.id === workload.id);
  if (!reference) throw new Error(`Missing Ramulator2 result for ${workload.id}`);
  const ramulatorLatencyNs = reference.average_read_latency_ticks * hbmTickNs;
  const classified = reference.row_hits + reference.row_misses + reference.row_conflicts;
  return {
    id: workload.id,
    name: workload.name,
    internal_average_latency_ns: workload.averageLatencyNs,
    ramulator_average_read_latency_ns: ramulatorLatencyNs,
    latency_scale_factor: ramulatorLatencyNs / workload.averageLatencyNs,
    internal_row_hit_percent: workload.rowHitPercent,
    ramulator_row_hit_percent: reference.row_hit_percent,
    row_hit_delta_pp: reference.row_hit_percent - workload.rowHitPercent,
    ramulator_requests_per_tick: reference.throughput_requests_per_tick,
    ramulator_classification_coverage_percent: 100 * classified / reference.requests,
  };
});

function ranks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = new Array(values.length);
  sorted.forEach((entry, rank) => { output[entry.index] = rank + 1; });
  return output;
}

function pearson(left, right) {
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / left.length;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / right.length;
  const numerator = left.reduce((sum, value, index) => sum + (value - meanLeft) * (right[index] - meanRight), 0);
  const leftMagnitude = Math.sqrt(left.reduce((sum, value) => sum + (value - meanLeft) ** 2, 0));
  const rightMagnitude = Math.sqrt(right.reduce((sum, value) => sum + (value - meanRight) ** 2, 0));
  return numerator / (leftMagnitude * rightMagnitude);
}

const latencyRankSpearman = pearson(
  ranks(results.map((entry) => entry.internal_average_latency_ns)),
  ranks(results.map((entry) => entry.ramulator_average_read_latency_ns)),
);
const rowHitMae = results.reduce((sum, entry) => sum + Math.abs(entry.row_hit_delta_pp), 0) / results.length;
const latencyScaleMean = results.reduce((sum, entry) => sum + entry.latency_scale_factor, 0) / results.length;

const correlation = {
  schema_version: '1.0',
  status: 'correlated-with-calibration-gap',
  simulator: raw.simulator,
  ramulator_commit: raw.ramulator_commit,
  proxy: raw.dram_proxy,
  hbm_tick_ns: hbmTickNs,
  latency_rank_spearman: latencyRankSpearman,
  row_hit_mean_absolute_error_pp: rowHitMae,
  mean_latency_scale_factor: latencyScaleMean,
  finding: 'Workload latency ordering agrees, but the internal cycle model is optimistic in absolute latency and must be calibrated before signoff use.',
  limitations: [
    'The public HBM3 proxy is one representative 32-bit channel; AIMEM uses a different 16-channel physical concept.',
    'Host traffic reduction from sparse gather is an architectural value metric, not a Ramulator throughput metric.',
    'Correlation does not upgrade any silicon-required gate.',
  ],
  results,
};

await writeFile('evidence/ramulator-correlation.json', `${JSON.stringify(correlation, null, 2)}\n`);
console.log(`Correlation generated: latency rank ρ=${latencyRankSpearman.toFixed(2)}, row-hit MAE=${rowHitMae.toFixed(2)} pp.`);
