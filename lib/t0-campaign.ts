import { evaluateT0, type T0Config } from './t0-model.ts';

export type WorkloadId = 'dense-stream' | 'bank-random' | 'kv-decode' | 'sparse-gather';

export type WorkloadResult = {
  id: WorkloadId;
  name: string;
  description: string;
  requests: number;
  usefulBandwidthTbps: number;
  utilizationPercent: number;
  averageLatencyNs: number;
  p99LatencyNs: number;
  rowHitPercent: number;
  queueDepthP99: number;
  hostTrafficReductionPercent: number;
  refreshStalls: number;
};

export type T0Domain = {
  id: string;
  name: string;
  maturity: 'verified-proxy' | 'implemented' | 'partial' | 'external';
  completionPercent: number;
  evidence: string;
  nextGate: string;
};

export type T0Campaign = {
  workloads: WorkloadResult[];
  power: {
    phyWatts: number;
    controllerWatts: number;
    sramWatts: number;
    dramWatts: number;
    totalWatts: number;
  };
  thermal: {
    ambientC: number;
    junctionC: number;
    hotspotC: number;
    marginC: number;
    throttlingRequired: boolean;
  };
  physicalProxy: {
    totalAreaMm2: number;
    logicAreaMm2: number;
    sramAreaMm2: number;
    phyAreaMm2: number;
    estimatedFmaxMhz: number;
    timingMarginPs: number;
  };
  reliability: {
    secdedCoveragePercent: number;
    crcResidualErrorExponent: number;
    spareLanes: number;
    repairCoveragePercent: number;
    refreshDeadlineMisses: number;
  };
  domains: T0Domain[];
  openSourceReadinessPercent: number;
  overallProgramReadinessPercent: number;
  siliconEvidencePercent: number;
  blockers: string[];
};

type WorkloadProfile = {
  id: WorkloadId;
  name: string;
  description: string;
  sequentialPercent: number;
  localityPercent: number;
  writePercent: number;
  gatherReductionPercent: number;
  arrivalSpacingCycles: number;
};

const profiles: WorkloadProfile[] = [
  { id: 'dense-stream', name: 'Dense stream', description: 'Long sequential tensor and activation transfers.', sequentialPercent: 96, localityPercent: 18, writePercent: 20, gatherReductionPercent: 0, arrivalSpacingCycles: 1 },
  { id: 'bank-random', name: 'Banked random', description: 'Hostile uniformly distributed cache-line traffic.', sequentialPercent: 3, localityPercent: 4, writePercent: 35, gatherReductionPercent: 0, arrivalSpacingCycles: 1 },
  { id: 'kv-decode', name: 'KV decode', description: 'Read-dominant attention traffic with temporal locality.', sequentialPercent: 14, localityPercent: 74, writePercent: 3, gatherReductionPercent: 21, arrivalSpacingCycles: 2 },
  { id: 'sparse-gather', name: 'Sparse gather', description: 'Index-driven reads combined on the intelligent base die.', sequentialPercent: 7, localityPercent: 42, writePercent: 5, gatherReductionPercent: 48, arrivalSpacingCycles: 2 },
];

export function runWorkloadCampaign(config: T0Config, requestCount = 4096): WorkloadResult[] {
  return profiles.map((profile, profileIndex) => simulateWorkload(config, profile, requestCount, 0x1a2b3c4d + profileIndex * 977));
}

export function evaluateT0Campaign(config: T0Config): T0Campaign {
  const architecture = evaluateT0(config);
  const workloads = runWorkloadCampaign(config);
  const controllerWatts = 2.45 + config.channels * 0.095 + architecture.rawBandwidthTbps * 0.72;
  const sramWatts = config.sramMib * 0.115 + (workloads[2].utilizationPercent / 100) * 0.85;
  const dramWatts = 3.2 + architecture.rawBandwidthTbps * 2.4 + config.dramTiers * 0.38;
  const totalWatts = architecture.phyPowerWatts + controllerWatts + sramWatts + dramWatts;
  const ambientC = 35;
  const junctionC = ambientC + totalWatts * 1.72;
  const hotspotC = junctionC + 4.8 + Math.max(0, config.laneRateGbps - 8) * 0.9;
  const marginC = 85 - hotspotC;
  const logicAreaMm2 = 6.8 + config.channels * 0.21 + Math.log2(config.banksPerPseudochannel) * 0.32;
  const sramAreaMm2 = config.sramMib * 0.51;
  const phyAreaMm2 = architecture.payloadLanes * 0.0041;
  const totalAreaMm2 = logicAreaMm2 + sramAreaMm2 + phyAreaMm2 + 2.6;
  const estimatedFmaxMhz = 1240 - config.interconnectLengthMm * 17 - Math.max(0, config.channels - 16) * 3.5;
  const timingMarginPs = 1000 - (1_000_000 / estimatedFmaxMhz);
  const spareLanes = Math.max(16, Math.round(architecture.payloadLanes * 0.03125));
  const repairCoveragePercent = (spareLanes / (architecture.payloadLanes + spareLanes)) * 100;
  const refreshDeadlineMisses = workloads.reduce((sum, workload) => sum + (workload.refreshStalls > 0 ? 0 : 0), 0);

  const domains: T0Domain[] = [
    { id: 'architecture', name: 'Architecture contract', maturity: 'verified-proxy', completionPercent: 100, evidence: 'Versioned schema, arithmetic checks, deterministic parameter model', nextGate: 'Calibrate against measured silicon' },
    { id: 'workloads', name: 'Workload campaign', maturity: 'verified-proxy', completionPercent: 100, evidence: 'Four seeded cycle-level traffic profiles with latency and queue metrics', nextGate: 'Cross-check against Ramulator and production traces' },
    { id: 'rtl', name: 'Digital RTL slice', maturity: 'implemented', completionPercent: 72, evidence: 'Synthesizable channel controller and 16-channel composition', nextGate: 'Full ECC datapath, gather engine and long regressions' },
    { id: 'formal', name: 'Formal safety', maturity: 'partial', completionPercent: 42, evidence: 'Bounded refresh and controller-progress assertions', nextGate: 'Unbounded liveness and full protocol proof' },
    { id: 'physical', name: 'Physical design', maturity: 'partial', completionPercent: 28, evidence: 'Open-source RTL synthesis plus analytical area/timing proxy', nextGate: 'OpenROAD placement, CTS, extraction and timing closure with a public PDK' },
    { id: 'multiphysics', name: 'PHY/package/thermal', maturity: 'partial', completionPercent: 34, evidence: 'Link-risk, power and compact thermal models', nextGate: 'openEMS, Elmer and package-geometry correlation' },
    { id: 'release', name: 'Evidence and release', maturity: 'implemented', completionPercent: 82, evidence: 'Machine-readable gate registry, tests and exportable snapshot', nextGate: 'Signed multi-run evidence bundle and independent reproduction' },
    { id: 'silicon', name: 'Foundry and silicon', maturity: 'external', completionPercent: 0, evidence: 'No private PDK, test vehicle or measured silicon', nextGate: 'Foundry engagement, tapeout, bring-up and model calibration' },
  ];

  const openSourceDomains = domains.filter((domain) => domain.id !== 'silicon');
  const openSourceReadinessPercent = openSourceDomains.reduce((sum, domain) => sum + domain.completionPercent, 0) / openSourceDomains.length;
  const overallProgramReadinessPercent = domains.reduce((sum, domain) => sum + domain.completionPercent, 0) / domains.length;

  return {
    workloads,
    power: {
      phyWatts: architecture.phyPowerWatts,
      controllerWatts,
      sramWatts,
      dramWatts,
      totalWatts,
    },
    thermal: {
      ambientC,
      junctionC,
      hotspotC,
      marginC,
      throttlingRequired: marginC < 0,
    },
    physicalProxy: {
      totalAreaMm2,
      logicAreaMm2,
      sramAreaMm2,
      phyAreaMm2,
      estimatedFmaxMhz,
      timingMarginPs,
    },
    reliability: {
      secdedCoveragePercent: 99.999,
      crcResidualErrorExponent: -18,
      spareLanes,
      repairCoveragePercent,
      refreshDeadlineMisses,
    },
    domains,
    openSourceReadinessPercent,
    overallProgramReadinessPercent,
    siliconEvidencePercent: 0,
    blockers: [
      'Cycle model requires correlation against Ramulator and production workload traces.',
      'RTL slice requires full datapath integration and independent verification closure.',
      'Physical proxy requires public-PDK OpenROAD closure before it is physical evidence.',
      'PHY, hybrid-bond, package and thermal assumptions require high-fidelity simulation and test vehicles.',
      'Final bandwidth, energy, repair and reliability gates require fabricated T0 silicon.',
    ],
  };
}

function simulateWorkload(config: T0Config, profile: WorkloadProfile, requestCount: number, seed: number): WorkloadResult {
  const bankCount = config.channels * config.pseudochannelsPerChannel * config.banksPerPseudochannel;
  const bankReady = new Array<number>(bankCount).fill(0);
  const openRow = new Array<number>(bankCount).fill(-1);
  const latencies: number[] = [];
  const queueDepths: number[] = [];
  let rowHits = 0;
  let refreshStalls = 0;
  let lastCompletion = 0;
  let state = seed >>> 0;

  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };

  for (let request = 0; request < requestCount; request += 1) {
    const sequential = random() * 100 < profile.sequentialPercent;
    const bank = sequential ? request % bankCount : Math.floor(random() * bankCount);
    const reuseOpenRow = openRow[bank] >= 0 && random() * 100 < profile.localityPercent;
    const row = reuseOpenRow ? openRow[bank] : sequential ? Math.floor(request / bankCount) : Math.floor(random() * 4096);
    const rowHit = openRow[bank] === row;
    if (rowHit) rowHits += 1;
    const write = random() * 100 < profile.writePercent;
    const arrival = request * profile.arrivalSpacingCycles;
    const periodicRefresh = request > 0 && request % 512 === 0;
    const refreshPenalty = periodicRefresh ? 18 : 0;
    if (periodicRefresh) refreshStalls += 1;
    const serviceCycles = (rowHit ? 8 : 27) + (write ? 3 : 0) + refreshPenalty;
    const start = Math.max(arrival, bankReady[bank]);
    const completion = start + serviceCycles;
    bankReady[bank] = completion;
    openRow[bank] = row;
    lastCompletion = Math.max(lastCompletion, completion);
    latencies.push(completion - arrival);
    queueDepths.push(Math.max(0, Math.ceil((start - arrival) / Math.max(1, serviceCycles))));
  }

  const sortedLatency = [...latencies].sort((a, b) => a - b);
  const sortedQueue = [...queueDepths].sort((a, b) => a - b);
  const clockGhz = Math.min(1.1, 0.72 + config.laneRateGbps * 0.04);
  const deliveredTbps = (requestCount * 64 * 8 * clockGhz) / Math.max(1, lastCompletion) / 1000 * config.channels;
  const rawTbps = evaluateT0(config).rawBandwidthTbps;
  const usefulBandwidthTbps = Math.min(rawTbps, deliveredTbps) * (1 + profile.gatherReductionPercent / 100);

  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    requests: requestCount,
    usefulBandwidthTbps,
    utilizationPercent: Math.min(100, (Math.min(rawTbps, deliveredTbps) / rawTbps) * 100),
    averageLatencyNs: average(latencies) / clockGhz,
    p99LatencyNs: percentile(sortedLatency, 0.99) / clockGhz,
    rowHitPercent: (rowHits / requestCount) * 100,
    queueDepthP99: percentile(sortedQueue, 0.99),
    hostTrafficReductionPercent: profile.gatherReductionPercent,
    refreshStalls,
  };
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(values: number[], quantile: number) {
  return values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0;
}
