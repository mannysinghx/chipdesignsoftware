import type { GateResult } from './t0-model.ts';

export type T1Config = {
  dramTiers: 8;
  payloadLanes: 4096;
  channelWidthBits: 64;
  pseudochannelsPerChannel: 2;
  banksPerPseudochannel: 16;
  sramMib: 64;
  capacityGib: 32 | 64;
  laneRateGbps: 8 | 12;
  assumedPhyEnergyPjPerBit: number;
};

export type T1ProofProgram = {
  id: string;
  title: string;
  status: 'ready-to-model' | 'proxy-only' | 'external';
  objective: string;
  openSourceStack: string;
  exitGate: string;
};

export const DEFAULT_T1_CONFIG: T1Config = {
  dramTiers: 8,
  payloadLanes: 4096,
  channelWidthBits: 64,
  pseudochannelsPerChannel: 2,
  banksPerPseudochannel: 16,
  sramMib: 64,
  capacityGib: 32,
  laneRateGbps: 8,
  assumedPhyEnergyPjPerBit: 0.18,
};

export function evaluateT1(config: T1Config, t0Gates: GateResult[]) {
  const channels = config.payloadLanes / config.channelWidthBits;
  const pseudochannels = channels * config.pseudochannelsPerChannel;
  const banks = pseudochannels * config.banksPerPseudochannel;
  const rawBandwidthTbps = (config.payloadLanes * config.laneRateGbps) / 8 / 1000;
  const interfacePowerProxyWatts = (config.payloadLanes * config.laneRateGbps * config.assumedPhyEnergyPjPerBit) / 1000;
  const verifiedT0Gates = t0Gates.filter((gate) => gate.status === 'pass').length;
  const provisionalT0Gates = t0Gates.filter((gate) => gate.status === 'provisional').length;
  const blockedT0Gates = t0Gates.length - verifiedT0Gates - provisionalT0Gates;

  const proofPrograms: T1ProofProgram[] = [
    {
      id: 'routing',
      title: 'Large-scale routing',
      status: 'ready-to-model',
      objective: 'Partition 4,096 payload lanes across 64 channels and quantify congestion, timing, clocking, and repair overhead.',
      openSourceStack: 'Yosys · OpenROAD · OpenSTA · KLayout',
      exitGate: 'Routed public-PDK proxy with explained constraints and no hidden unconstrained paths.',
    },
    {
      id: 'process',
      title: '2 nm implementation',
      status: 'external',
      objective: 'Translate the node-portable RTL and physical intent into a foundry-qualified 2 nm implementation.',
      openSourceStack: 'OpenROAD public-PDK proxy · restricted foundry adapter later',
      exitGate: 'Qualified PDK, SRAM/PHY IP, extraction, and foundry signoff evidence.',
    },
    {
      id: 'thermal',
      title: 'Eight-tier thermal stack',
      status: 'ready-to-model',
      objective: 'Couple workload activity, interface power, refresh, throttling, and cooling across an eight-high stack.',
      openSourceStack: 'Gmsh · Elmer · OpenFOAM · Python',
      exitGate: 'Mesh-converged nominal and worst-case transients with traceable material assumptions.',
    },
    {
      id: 'package',
      title: 'Production-style package',
      status: 'proxy-only',
      objective: 'Study escape routing, power delivery, skew, repair, interposer topology, and hybrid-bond test access.',
      openSourceStack: 'FreeCAD · openEMS · scikit-rf · KiCad',
      exitGate: 'Reviewed geometry and behavioral margin study; silicon test vehicle remains mandatory.',
    },
  ];

  return {
    channels,
    pseudochannels,
    banks,
    rawBandwidthTbps,
    interfacePowerProxyWatts,
    sramPerRegionMib: config.sramMib / 8,
    verifiedT0Gates,
    provisionalT0Gates,
    blockedT0Gates,
    entryDecision: verifiedT0Gates === t0Gates.length ? 'go' as const : 'hold' as const,
    proofPrograms,
  };
}
