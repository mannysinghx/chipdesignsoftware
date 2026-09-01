import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_T0_CONFIG, evaluateT0, runT0Sweep } from '../lib/t0-model.ts';
import { evaluateT0Campaign } from '../lib/t0-campaign.ts';

const rtl = JSON.parse(await readFile('evidence/rtl-synthesis.json', 'utf8'));
const architecture = evaluateT0(DEFAULT_T0_CONFIG);
const campaign = evaluateT0Campaign(DEFAULT_T0_CONFIG);
const rankedSweep = runT0Sweep(DEFAULT_T0_CONFIG)
  .map((candidate) => ({
    lane_rate_gbps: candidate.config.laneRateGbps,
    sram_mib: candidate.config.sramMib,
    raw_bandwidth_tbps: candidate.evaluation.rawBandwidthTbps,
    streaming_bandwidth_tbps: candidate.evaluation.streamingBandwidthTbps,
    phy_power_watts: candidate.evaluation.phyPowerWatts,
    analytical_gates_passed: candidate.evaluation.gates.filter((gate) => gate.status === 'pass').length,
  }))
  .sort((a, b) => (b.streaming_bandwidth_tbps - b.phy_power_watts * 0.05) - (a.streaming_bandwidth_tbps - a.phy_power_watts * 0.05));

const bundle = {
  schema_version: '1.0',
  milestone: 'AIMEM-X1 T0 open-source engineering readiness',
  revision: '0.3.0',
  evidence_policy: 'Proxy and formal evidence never upgrades a silicon-required gate.',
  baseline: DEFAULT_T0_CONFIG,
  architecture,
  campaign,
  rtl,
  ranked_sweep: rankedSweep,
  provenance: {
    deterministic: true,
    workload_seed_family: 'aimem-t0-0x1a2b3c4d',
    request_count_per_workload: 4096,
    source_files: [
      'design/spec/aimem-t0.json',
      'design/spec/t0-completion.json',
      'lib/t0-model.ts',
      'lib/t0-campaign.ts',
      'lib/t0-reliability.ts',
      'rtl/aimem_secded_64.sv',
      'rtl/aimem_sparse_gather.sv',
      'rtl/aimem_lane_repair.sv',
      'rtl/aimem_t0_channel.sv',
      'rtl/aimem_t0_top.sv',
      'formal/aimem_t0_channel_formal.sv',
      'formal/aimem_secded_formal.sv'
    ]
  }
};

const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
const digest = createHash('sha256').update(serialized).digest('hex');
await writeFile('evidence/t0-evidence.json', serialized);
await writeFile('evidence/manifest.json', `${JSON.stringify({
  schema_version: '1.0',
  artifact: 't0-evidence.json',
  sha256: digest,
  reproducible: true,
  external_gates_remain_unverified: true
}, null, 2)}\n`);

console.log(`Evidence bundle generated: sha256:${digest}`);
