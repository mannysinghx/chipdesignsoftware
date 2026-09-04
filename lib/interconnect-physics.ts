export type InterconnectInputs = {
  routeLengthMm: number;
  traceWidthUm: number;
  traceThicknessUm: number;
  copperTemperatureC: number;
  dielectricRelativePermittivity: number;
  capacitanceFfPerMm: number;
  signalingVoltageV: number;
  laneCurrentMa: number;
  laneRateGbps: number;
  payloadLaneCount: number;
};

export const DEFAULT_INTERCONNECT_INPUTS: InterconnectInputs = {
  routeLengthMm: 12,
  traceWidthUm: 5,
  traceThicknessUm: 2,
  copperTemperatureC: 85,
  dielectricRelativePermittivity: 3.2,
  capacitanceFfPerMm: 20,
  signalingVoltageV: 0.6,
  laneCurrentMa: 2,
  laneRateGbps: 8,
  payloadLaneCount: 65_536,
};

const COPPER_RESISTIVITY_20C = 1.68e-8;
const COPPER_TEMPERATURE_COEFFICIENT = 0.00393;
const SPEED_OF_LIGHT_MPS = 299_792_458;

export function evaluateInterconnectPhysics(input: InterconnectInputs) {
  const lengthM = input.routeLengthMm / 1000;
  const areaM2 = input.traceWidthUm * 1e-6 * input.traceThicknessUm * 1e-6;
  const resistivityOhmM = COPPER_RESISTIVITY_20C * (1 + COPPER_TEMPERATURE_COEFFICIENT * (input.copperTemperatureC - 20));
  const resistanceOhms = resistivityOhmM * lengthM / areaM2;
  const velocityMps = SPEED_OF_LIGHT_MPS / Math.sqrt(input.dielectricRelativePermittivity);
  const flightTimePs = lengthM / velocityMps * 1e12;
  const capacitanceF = input.capacitanceFfPerMm * input.routeLengthMm * 1e-15;
  const rcDelayPs = 0.69 * resistanceOhms * capacitanceF * 1e12;
  const totalElectricalDelayPs = flightTimePs + rcDelayPs;
  const energyPerTransitionPj = 0.5 * capacitanceF * input.signalingVoltageV ** 2 * 1e12;
  const transitionRate = input.laneRateGbps * 1e9 * 0.5;
  const aggregateDynamicPowerWatts = energyPerTransitionPj * 1e-12 * transitionRate * input.payloadLaneCount;
  const laneCurrentA = input.laneCurrentMa / 1000;
  const joulePowerPerLaneMw = laneCurrentA ** 2 * resistanceOhms * 1000;
  const aggregateJoulePowerWatts = laneCurrentA ** 2 * resistanceOhms * input.payloadLaneCount;
  const currentDensityMAcm2 = laneCurrentA / areaM2 / 1e10;

  return {
    resistivityOhmM,
    resistanceOhms,
    velocityMps,
    flightTimePs,
    capacitanceFf: capacitanceF * 1e15,
    rcDelayPs,
    totalElectricalDelayPs,
    energyPerTransitionPj,
    aggregateDynamicPowerWatts,
    joulePowerPerLaneMw,
    aggregateJoulePowerWatts,
    currentDensityMAcm2,
    assumptions: [
      'Uniform copper geometry with temperature-adjusted bulk resistivity',
      'Propagation velocity uses c / sqrt(relative permittivity)',
      'First-order lumped RC delay; package discontinuities and return-path extraction are not included',
      'Dynamic power assumes 50% transition activity across every payload lane',
    ],
  };
}

export function evaluateCircuitTopology(stackCount: number, dramTiers: number) {
  return {
    stackCount,
    dramTiers: stackCount * dramTiers,
    intelligentBaseDies: stackCount,
    nocRegions: stackCount * 16,
    physicalChannels: stackCount * 128,
    pseudochannels: stackCount * 256,
    banks: stackCount * 4096,
    subarrays: stackCount * 524_288,
    payloadLanes: stackCount * 8192,
    protectedConductors: stackCount * 9472,
    routeBundles: stackCount * 32,
    hybridBondInterfaces: stackCount * dramTiers,
  };
}
