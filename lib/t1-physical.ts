import { evaluateT1, type T1Config } from './t1-model.ts';

export type T1PhysicalProxy = ReturnType<typeof evaluateT1PhysicalProxy>;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function evaluateT1PhysicalProxy(config: T1Config) {
  const architecture = evaluateT1(config, []);
  const activity = config.activityPercent / 100;
  const power = {
    interfaceWatts: architecture.interfacePowerProxyWatts * activity,
    controllerNocWatts: (8.2 + architecture.channels * 0.085 + architecture.rawBandwidthTbps * 0.8) * activity,
    sramWatts: config.sramMib * 0.1 * activity,
    dramWatts: (config.dramTiers * 2.4 + config.capacityGib * 0.05) * activity,
  };
  const totalPowerWatts = power.interfaceWatts + power.controllerNocWatts + power.sramWatts + power.dramWatts;
  const stackPenaltyC = (config.dramTiers - 1) * 0.7 + Math.max(0, config.laneRateGbps - 8) * 0.5;
  const baseTemperatureC = 35 + totalPowerWatts * config.coolingResistanceKPerW * 0.85 + stackPenaltyC;
  const routingCongestionPercent = clamp(
    32 + config.payloadLanes / 128 + Math.max(0, config.laneRateGbps - 8) * 2.5 + Math.max(0, config.packageRouteLengthMm - 10) * 1.8 + (config.bondPitchUm - 2) * 5,
    0,
    100,
  );
  const packageSkewPs = config.packageRouteLengthMm * (0.6 + Math.max(0, config.laneRateGbps - 8) * 0.05);
  const irDropProxyMv = totalPowerWatts * 0.42 + config.payloadLanes / 256 + (config.bondPitchUm - 2) * 2.2;
  const regions = Array.from({ length: 8 }, (_, region) => {
    const loadPercent = clamp(config.activityPercent + (((region * 19 + config.capacityGib) % 17) - 8), 20, 98);
    const congestionPercent = clamp(routingCongestionPercent + (((region * 13) % 15) - 7), 0, 100);
    const temperatureC = baseTemperatureC + (loadPercent - config.activityPercent) * 0.16 + (region >= 4 ? 1.1 : 0);
    return { id: `R${region}`, loadPercent, congestionPercent, temperatureC };
  });
  const hotspotC = Math.max(...regions.map((region) => region.temperatureC));
  const thermalMarginC = 85 - hotspotC;
  const routingRisk = routingCongestionPercent < 65 ? 'low' as const : routingCongestionPercent < 82 ? 'watch' as const : 'high' as const;
  const thermalRisk = thermalMarginC >= 10 ? 'low' as const : thermalMarginC >= 0 ? 'watch' as const : 'high' as const;
  const packageRisk = packageSkewPs <= 8 && irDropProxyMv <= 38 ? 'low' as const : packageSkewPs <= 13 && irDropProxyMv <= 48 ? 'watch' as const : 'high' as const;
  const coolingSweep = [0.45, 0.65, 0.85, 1.05].map((resistanceKPerW) => ({
    resistanceKPerW,
    hotspotC: hotspotC + totalPowerWatts * (resistanceKPerW - config.coolingResistanceKPerW) * 0.85,
  }));

  return {
    power: { ...power, totalPowerWatts },
    routing: { congestionPercent: routingCongestionPercent, risk: routingRisk },
    package: { skewPs: packageSkewPs, irDropProxyMv, bondPitchUm: config.bondPitchUm, risk: packageRisk },
    thermal: { hotspotC, marginC: thermalMarginC, resistanceKPerW: config.coolingResistanceKPerW, risk: thermalRisk },
    regions,
    coolingSweep,
    evidenceClass: 'Coupled analytical physical/package/thermal proxy',
    solverHandoffs: [
      { stage: 'Digital P&R', tools: 'Yosys · OpenROAD · OpenSTA · KLayout', nextArtifact: 'Placed/routed proxy, SPEF, timing and congestion reports' },
      { stage: 'Package EM', tools: 'FreeCAD · Gmsh · openEMS · scikit-rf', nextArtifact: 'Meshed route geometry, S-parameters, skew and loss' },
      { stage: 'Thermal/stress', tools: 'Gmsh · Elmer', nextArtifact: 'Mesh-converged transient temperature and stress fields' },
      { stage: 'Cooling', tools: 'OpenFOAM', nextArtifact: 'Selected cold-plate pressure, flow and heat-transfer solution' },
    ],
  };
}
