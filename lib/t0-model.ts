export type T0Config = {
  channels: number;
  channelWidthBits: number;
  pseudochannelsPerChannel: number;
  banksPerPseudochannel: number;
  dramTiers: number;
  laneRateGbps: number;
  sramMib: number;
  rowSizeBytes: number;
  streamingEfficiencyPercent: number;
  randomEfficiencyPercent: number;
  phyEnergyPjPerBit: number;
  interconnectLengthMm: number;
  sramHitLatencyNs: number;
};

export type GateStatus = 'pass' | 'fail' | 'unverified';

export type GateResult = {
  id: string;
  title: string;
  target: string;
  observed: string;
  status: GateStatus;
  evidence: string;
};

export type T0Evaluation = {
  payloadLanes: number;
  pseudochannels: number;
  banks: number;
  rawBandwidthTbps: number;
  streamingBandwidthTbps: number;
  randomBandwidthTbps: number;
  perChannelBandwidthGbps: number;
  phyPowerWatts: number;
  bankParallelismScore: number;
  linkRisk: 'low' | 'watch' | 'high';
  gates: GateResult[];
  recommendations: Array<{ severity: 'good' | 'watch' | 'risk'; title: string; detail: string }>;
};

export const DEFAULT_T0_CONFIG: T0Config = {
  channels: 16,
  channelWidthBits: 64,
  pseudochannelsPerChannel: 2,
  banksPerPseudochannel: 16,
  dramTiers: 4,
  laneRateGbps: 8,
  sramMib: 16,
  rowSizeBytes: 512,
  streamingEfficiencyPercent: 86,
  randomEfficiencyPercent: 66,
  phyEnergyPjPerBit: 0.15,
  interconnectLengthMm: 8,
  sramHitLatencyNs: 9.2,
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function evaluateT0(config: T0Config): T0Evaluation {
  const payloadLanes = config.channels * config.channelWidthBits;
  const pseudochannels = config.channels * config.pseudochannelsPerChannel;
  const banks = pseudochannels * config.banksPerPseudochannel;
  const rawBandwidthTbps = (payloadLanes * config.laneRateGbps) / 8 / 1000;
  const streamingBandwidthTbps = rawBandwidthTbps * (config.streamingEfficiencyPercent / 100);
  const randomBandwidthTbps = rawBandwidthTbps * (config.randomEfficiencyPercent / 100);
  const perChannelBandwidthGbps = (config.channelWidthBits * config.laneRateGbps) / 8;
  const phyPowerWatts = (payloadLanes * config.laneRateGbps * config.phyEnergyPjPerBit) / 1000;
  const bankParallelismScore = clamp(config.randomEfficiencyPercent + Math.log2(Math.max(1, banks / 512)) * 5, 0, 100);
  const preferredLength = config.laneRateGbps >= 12 ? 5 : config.laneRateGbps >= 10 ? 7 : 10;
  const lengthRatio = config.interconnectLengthMm / preferredLength;
  const linkRisk = lengthRatio <= 0.8 ? 'low' : lengthRatio <= 1 ? 'watch' : 'high';

  const gates: GateResult[] = [
    gate('T0-BW-RAW', 'Raw bandwidth', '> 1.000 TB/s', `${rawBandwidthTbps.toFixed(3)} TB/s`, rawBandwidthTbps > 1, 'Analytical'),
    gate('T0-BW-STREAM', 'Streaming efficiency', '≥ 85%', `${config.streamingEfficiencyPercent.toFixed(0)}%`, config.streamingEfficiencyPercent >= 85, 'Analytical proxy'),
    gate('T0-BW-RANDOM', 'Banked random efficiency', '≥ 65%', `${config.randomEfficiencyPercent.toFixed(0)}%`, config.randomEfficiencyPercent >= 65, 'Analytical proxy'),
    gate('T0-PHY-ENERGY', 'PHY energy', '< 0.20 pJ/bit', `${config.phyEnergyPjPerBit.toFixed(2)} pJ/bit`, config.phyEnergyPjPerBit < 0.2, 'Assumption'),
    gate('T0-SRAM-LATENCY', 'SRAM system hit', '< 10 ns', `${config.sramHitLatencyNs.toFixed(1)} ns`, config.sramHitLatencyNs < 10, 'Assumption'),
    unverifiedGate('T0-THERMAL', 'Thermal stability', 'No nominal runaway', 'Not simulated', 'Coupled model'),
    unverifiedGate('T0-BOND', 'Hybrid-bond reliability', 'Continuity + margin', 'No test vehicle', 'Silicon'),
    unverifiedGate('T0-GATHER', 'Gather value', 'Host traffic reduction > 0', 'RTL not connected', 'RTL'),
    unverifiedGate('T0-ECC', 'ECC fault campaign', 'All specified injections pass', 'RTL not connected', 'RTL'),
    unverifiedGate('T0-LANE-REPAIR', 'Lane repair', 'Remap + BERT pass', 'PHY model not connected', 'RTL / silicon'),
    unverifiedGate('T0-LIVENESS', 'Controller liveness', 'No deadlocks', 'Formal proof pending', 'Formal'),
    unverifiedGate('T0-REFRESH', 'Refresh safety', 'Zero missed deadlines', 'Formal proof pending', 'Formal'),
  ];

  const recommendations: T0Evaluation['recommendations'] = [];
  if (rawBandwidthTbps <= 1) recommendations.push({ severity: 'risk', title: 'Bandwidth gate is below T0 entry criteria', detail: 'Raise the lane rate or channel count before treating this configuration as a T0 candidate.' });
  else recommendations.push({ severity: 'good', title: 'Raw bandwidth clears the analytical T0 threshold', detail: 'The result still needs cycle, RTL, and silicon evidence before the gate is verified.' });
  if (config.streamingEfficiencyPercent < 85) recommendations.push({ severity: 'risk', title: 'Streaming utilization is insufficient', detail: 'Evaluate request coalescing, write/read turnaround, NoC width, and scheduler weights.' });
  if (config.randomEfficiencyPercent < 65) recommendations.push({ severity: 'risk', title: 'Random-access target is not met', detail: 'Sweep the address hash, bank count, and queue depth against hostile traces.' });
  if (linkRisk !== 'low') recommendations.push({ severity: linkRisk === 'high' ? 'risk' : 'watch', title: 'Interconnect margin needs attention', detail: `At ${config.laneRateGbps} Gb/s, ${config.interconnectLengthMm} mm is ${linkRisk === 'high' ? 'beyond' : 'near'} the initial routing target.` });
  if (config.rowSizeBytes !== 512) recommendations.push({ severity: 'watch', title: 'Row size differs from the AIMEM baseline', detail: 'Keep this variant in the sweep, but account for peripheral area and activation-energy changes.' });
  if (config.sramMib < 16) recommendations.push({ severity: 'watch', title: 'SRAM is below the T0 baseline', detail: 'Model KV metadata, gather descriptors, and hot-line capacity before reducing the slice.' });
  if (config.phyEnergyPjPerBit >= 0.2) recommendations.push({ severity: 'risk', title: 'PHY energy misses the pathfinder target', detail: 'Reduce swing, shorten routes, or revisit the lane-rate/width balance.' });

  return {
    payloadLanes,
    pseudochannels,
    banks,
    rawBandwidthTbps,
    streamingBandwidthTbps,
    randomBandwidthTbps,
    perChannelBandwidthGbps,
    phyPowerWatts,
    bankParallelismScore,
    linkRisk,
    gates,
    recommendations,
  };
}

export function runT0Sweep(config: T0Config) {
  const laneRates = [4, 8, 10, 12];
  const sramSizes = [8, 16, 32];
  return laneRates.flatMap((laneRateGbps) =>
    sramSizes.map((sramMib) => {
      const ratePenalty = laneRateGbps === 12 ? 4 : laneRateGbps === 10 ? 2 : laneRateGbps === 4 ? -1 : 0;
      const sramLift = Math.log2(sramMib / 16) * 1.5;
      const candidate = {
        ...config,
        laneRateGbps,
        sramMib,
        streamingEfficiencyPercent: clamp(config.streamingEfficiencyPercent - ratePenalty + sramLift, 50, 96),
        randomEfficiencyPercent: clamp(config.randomEfficiencyPercent - ratePenalty * 0.8 + sramLift * 1.3, 35, 88),
      };
      return { config: candidate, evaluation: evaluateT0(candidate) };
    }),
  );
}

function gate(id: string, title: string, target: string, observed: string, passed: boolean, evidence: string): GateResult {
  return { id, title, target, observed, status: passed ? 'pass' : 'fail', evidence };
}

function unverifiedGate(id: string, title: string, target: string, observed: string, evidence: string): GateResult {
  return { id, title, target, observed, status: 'unverified', evidence };
}
