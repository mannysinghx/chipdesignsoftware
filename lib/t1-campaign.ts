import { runWorkloadCampaign, type WorkloadResult } from './t0-campaign.ts';
import type { T0Config } from './t0-model.ts';
import { evaluateT1, type T1Config } from './t1-model.ts';

export type T1ModeResult = {
  laneRateGbps: 8 | 12;
  rawBandwidthTbps: number;
  streamingBandwidthTbps: number;
  randomBandwidthTbps: number;
  interfacePowerProxyWatts: number;
  routingClass: 'nominal-study' | 'experimental-study';
};

export type T1DigitalCampaign = {
  workloads: WorkloadResult[];
  modes: T1ModeResult[];
  fabric: {
    regions: number;
    channelsPerRegion: number;
    pseudochannelsPerRegion: number;
    banksPerRegion: number;
    regionLoadsPercent: number[];
  };
  modelContract: {
    requestCount: number;
    seedPolicy: string;
    evidenceClass: string;
    limitations: string[];
  };
};

export function evaluateT1DigitalCampaign(config: T1Config): T1DigitalCampaign {
  const requestCount = 4096;
  const t0CompatibleConfig = toCycleModelConfig(config);
  const workloads = runWorkloadCampaign(t0CompatibleConfig, requestCount);
  const modes = ([8, 12] as const).map((laneRateGbps) => {
    const candidate = { ...config, laneRateGbps };
    const evaluation = evaluateT1(candidate, []);
    const streamingEfficiency = laneRateGbps === 8 ? 0.84 : 0.78;
    const randomEfficiency = laneRateGbps === 8 ? 0.63 : 0.56;
    return {
      laneRateGbps,
      rawBandwidthTbps: evaluation.rawBandwidthTbps,
      streamingBandwidthTbps: evaluation.rawBandwidthTbps * streamingEfficiency,
      randomBandwidthTbps: evaluation.rawBandwidthTbps * randomEfficiency,
      interfacePowerProxyWatts: evaluation.interfacePowerProxyWatts,
      routingClass: laneRateGbps === 8 ? 'nominal-study' as const : 'experimental-study' as const,
    };
  });
  const averageUtilization = workloads.reduce((sum, workload) => sum + workload.utilizationPercent, 0) / workloads.length;
  const regionLoadsPercent = Array.from({ length: 8 }, (_, region) => {
    const deterministicSkew = ((region * 17 + config.capacityGib) % 13) - 6;
    return Math.max(20, Math.min(96, averageUtilization + deterministicSkew));
  });

  return {
    workloads,
    modes,
    fabric: {
      regions: 8,
      channelsPerRegion: 8,
      pseudochannelsPerRegion: 16,
      banksPerRegion: 256,
      regionLoadsPercent,
    },
    modelContract: {
      requestCount,
      seedPolicy: 'Fixed per-workload seeds inherited from the T0 campaign',
      evidenceClass: 'Deterministic request-level T1 scale proxy',
      limitations: [
        'No extracted 2 nm timing or production SRAM/PHY macro data',
        'Eight-region NoC contention is represented by deterministic load skew, not packet-level simulation',
        'Absolute latency remains uncalibrated against T1 silicon',
      ],
    },
  };
}

function toCycleModelConfig(config: T1Config): T0Config {
  return {
    channels: config.payloadLanes / config.channelWidthBits,
    channelWidthBits: config.channelWidthBits,
    pseudochannelsPerChannel: config.pseudochannelsPerChannel,
    banksPerPseudochannel: config.banksPerPseudochannel,
    dramTiers: config.dramTiers,
    laneRateGbps: config.laneRateGbps,
    sramMib: config.sramMib,
    rowSizeBytes: 512,
    streamingEfficiencyPercent: config.laneRateGbps === 8 ? 84 : 78,
    randomEfficiencyPercent: config.laneRateGbps === 8 ? 63 : 56,
    phyEnergyPjPerBit: config.assumedPhyEnergyPjPerBit,
    interconnectLengthMm: 12,
    sramHitLatencyNs: 9.5,
  };
}
