export type X1PerformanceState = 'eco' | 'nominal' | 'performance' | 'turbo';

export type X1Config = {
  dramTiers: 16;
  payloadLanesPerStack: 8192;
  channelsPerStack: 128;
  channelWidthBits: 64;
  pseudochannelsPerChannel: 2;
  banksPerPseudochannel: 16;
  subarraysPerBank: 128;
  sramMibPerStack: 128;
  nocRegionsPerStack: 16;
  capacityGibPerStack: 64 | 128;
  performanceState: X1PerformanceState;
  stackCount: 1 | 2 | 4 | 8;
  workloadDemandPercent: number;
  usefulEfficiencyPercent: number;
  acceleratorFabricTbps: number;
  interposerRoutingLayers: number;
  distributedComputePorts: number;
};

export const X1_STATE_TABLE = {
  eco: { id: 'P2', laneRateGbps: 4, stackPowerEnvelopeWatts: 28 },
  nominal: { id: 'P3', laneRateGbps: 8, stackPowerEnvelopeWatts: 45 },
  performance: { id: 'P4', laneRateGbps: 10, stackPowerEnvelopeWatts: 55 },
  turbo: { id: 'P5', laneRateGbps: 12, stackPowerEnvelopeWatts: 65 },
} as const;

export const DEFAULT_X1_CONFIG: X1Config = {
  dramTiers: 16,
  payloadLanesPerStack: 8192,
  channelsPerStack: 128,
  channelWidthBits: 64,
  pseudochannelsPerChannel: 2,
  banksPerPseudochannel: 16,
  subarraysPerBank: 128,
  sramMibPerStack: 128,
  nocRegionsPerStack: 16,
  capacityGibPerStack: 128,
  performanceState: 'nominal',
  stackCount: 8,
  workloadDemandPercent: 85,
  usefulEfficiencyPercent: 85,
  acceleratorFabricTbps: 48,
  interposerRoutingLayers: 12,
  distributedComputePorts: 32,
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function evaluateX1(config: X1Config) {
  const state = X1_STATE_TABLE[config.performanceState];
  const pseudochannelsPerStack = config.channelsPerStack * config.pseudochannelsPerChannel;
  const banksPerStack = pseudochannelsPerStack * config.banksPerPseudochannel;
  const subarraysPerStack = banksPerStack * config.subarraysPerBank;
  const rawBandwidthPerStackTbps = (config.payloadLanesPerStack * state.laneRateGbps) / 8 / 1000;
  const aggregateRawBandwidthTbps = rawBandwidthPerStackTbps * config.stackCount;
  const memoryUsefulCeilingTbps = aggregateRawBandwidthTbps * (config.usefulEfficiencyPercent / 100);
  const requestedBandwidthTbps = aggregateRawBandwidthTbps * (config.workloadDemandPercent / 100);
  const deliveredBandwidthTbps = Math.min(memoryUsefulCeilingTbps, requestedBandwidthTbps, config.acceleratorFabricTbps);
  const computeIngestUtilizationPercent = clamp((deliveredBandwidthTbps / config.acceleratorFabricTbps) * 100, 0, 100);
  const memoryUtilizationPercent = clamp((deliveredBandwidthTbps / aggregateRawBandwidthTbps) * 100, 0, 100);
  const totalCapacityGib = config.capacityGibPerStack * config.stackCount;
  const protectedConductorsPerStack = config.channelsPerStack * (config.channelWidthBits + 8 + 2);
  const totalPayloadLanes = config.payloadLanesPerStack * config.stackCount;
  const totalProtectedConductors = protectedConductorsPerStack * config.stackCount;
  const routeBundles = Math.ceil(totalPayloadLanes / 256);
  const routeBundleCapacity = config.interposerRoutingLayers * config.distributedComputePorts * 0.9;
  const routingPressurePercent = clamp((routeBundles / routeBundleCapacity) * 100, 0, 160);
  const stackPowerWatts = state.stackPowerEnvelopeWatts * (0.55 + config.workloadDemandPercent * 0.0045);
  const memorySystemPowerWatts = stackPowerWatts * config.stackCount;
  const computeLimited = config.acceleratorFabricTbps < Math.min(memoryUsefulCeilingTbps, requestedBandwidthTbps);

  const gates = [
    { id: 'X1-CONTRACT', title: 'Production architecture contract', status: 'architected' as const, evidence: 'Source-defined 16-high, 8,192-lane, 128-channel target.' },
    { id: 'X1-SCALE-MATH', title: 'Capacity and bandwidth arithmetic', status: 'architected' as const, evidence: 'Deterministic calculations from the versioned X1 contract.' },
    { id: 'X1-INGEST', title: 'Accelerator ingest balance', status: computeLimited ? 'risk' as const : 'proxy' as const, evidence: `${config.acceleratorFabricTbps.toFixed(1)} TB/s modeled accelerator fabric versus ${memoryUsefulCeilingTbps.toFixed(1)} TB/s memory useful ceiling.` },
    { id: 'X1-ROUTING', title: 'Eight-stack interposer routing', status: routingPressurePercent > 100 ? 'risk' as const : 'proxy' as const, evidence: `${routeBundles} route bundles across ${config.interposerRoutingLayers} layers and ${config.distributedComputePorts} distributed ports.` },
    { id: 'X1-POWER', title: 'Stack power envelope', status: stackPowerWatts <= 65 ? 'proxy' as const : 'risk' as const, evidence: `${stackPowerWatts.toFixed(1)} W activity-scaled planning estimate; source limit is 65 W turbo envelope.` },
    { id: 'X1-T1-QUAL', title: 'T1 engineering-sample qualification', status: 'blocked' as const, evidence: 'No measured T1 routing, 2 nm, eight-tier thermal, or production-package evidence exists.' },
    { id: 'X1-BOND-YIELD', title: 'Sixteen-tier bond yield and repair', status: 'blocked' as const, evidence: 'Requires known-good-die, 16-high assembly, repair, and yield evidence.' },
    { id: 'X1-PRODUCTION', title: 'Production foundry release', status: 'blocked' as const, evidence: 'Requires qualified production PDK, IP, package, signoff, DFT, manufacturing, and human release authorization.' },
  ];

  return {
    state,
    pseudochannelsPerStack,
    banksPerStack,
    subarraysPerStack,
    rawBandwidthPerStackTbps,
    aggregateRawBandwidthTbps,
    memoryUsefulCeilingTbps,
    requestedBandwidthTbps,
    deliveredBandwidthTbps,
    computeIngestUtilizationPercent,
    memoryUtilizationPercent,
    totalCapacityGib,
    protectedConductorsPerStack,
    totalPayloadLanes,
    totalProtectedConductors,
    routeBundles,
    routingPressurePercent,
    stackPowerWatts,
    memorySystemPowerWatts,
    bottleneck: computeLimited ? 'accelerator fabric' as const : requestedBandwidthTbps < memoryUsefulCeilingTbps ? 'workload demand' as const : 'memory efficiency' as const,
    decision: 'hold' as const,
    t1QualificationGatesPassed: 0,
    t1QualificationGatesRequired: 4,
    gates,
  };
}
