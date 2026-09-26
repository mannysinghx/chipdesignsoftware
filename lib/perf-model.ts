// C1 performance model (version 2) for the AIMEM-A1 compute-die plan (docs/COMPUTE_DIE_PLAN.md).
// Roofline kernels with sustained rates measured on real chips, composed into an LLM serving
// model. Every output is evidence class `modeled`.
//
// Version 2 adds a power ceiling: sustained tensor throughput is the lesser of an architectural
// ceiling and what the chip's power rating can feed, with energy per FLOP proportional to operand
// bits. Version 1 (evidence/c1-perf-model-v1.json) scaled with peak FLOPS and overpredicted B300.
//
// Parameters come only from calibration data, in three groups:
//   1. Sustained BF16 tensor throughput per watt, per GPU family, from measured large GEMMs.
//   2. Memory efficiency per GPU family, from measured sustained HBM bandwidth.
//   3. One global serving efficiency, fitted across the calibration chips' MLPerf rows.
// A family with no calibration data uses the mean of the calibrated families (declared before
// version 2 was built). Held-out chips are never read by calibrate(); tests/perf-model.test.ts proves it.

export type Precision = 'bf16' | 'fp8' | 'fp4';
export type Family = 'hopper' | 'blackwell' | 'cdna4';

type Figure = { value: number };
type ReferenceChip = {
  id: string;
  peak_dense_tflops: Partial<Record<Precision | 'tf32', Figure>>;
  memory: { capacity_gb: Figure; bandwidth_tbps: Figure };
  scale_up_tbps?: Figure;
  power_w?: Figure & { conflict?: { alternatives: { value: number }[] } };
};
type MlperfRow = {
  id: string;
  chip: string;
  model: string;
  scenario: 'Offline' | 'Server';
  system_result_tokens_per_s: number;
  accelerators: number;
  weights: Precision;
  mean_output_tokens: number;
  use: string;
};
type GemmRow = { chip: string; precision: Precision; achieved_tflops?: number; achieved_tflops_range?: [number, number]; use: string };
type BandwidthRow = { chip: string; family?: Family; achieved_tbps?: number; achieved_tbps_range?: [number, number]; peak_tbps?: number; use: string };
export type { MlperfRow };
type ModelConfig = { hidden: number; layers: number; heads: number; kv_heads: number; head_dim: number; ffn: number; vocab: number };
type MlperfWorkload = { model: string; mean_input_tokens: number; server_ttft_ms: number; server_tpot_ms: number };

export type Targets = {
  reference_chips: ReferenceChip[];
  measured: { mlperf_inference: MlperfRow[]; gemm: GemmRow[]; memory_bandwidth: BandwidthRow[] };
  models: Record<string, ModelConfig>;
  benchmarks: { mlperf_workloads: Record<string, MlperfWorkload | string> };
  calibration: { calibration_chips: string[]; held_out_chips: string[]; regression_chips?: string[]; tolerances_relative: Record<string, number> };
};

// Tensor throughput per SM per clock (dense FLOP). Peaks are reproduced from these with
// one implied tensor clock per chip; NVIDIA does not publish the tensor clock.
export const MICROARCH: Record<string, { family: Family; sms: number; flopsPerClockPerSm: Partial<Record<Precision, number>>; statedClockGhz?: number; basis: string }> = {
  'h100-sxm': { family: 'hopper', sms: 132, flopsPerClockPerSm: { bf16: 4096, fp8: 8192 }, basis: '2x A100 per SM (1,024 dense FP16 FMA/clk/SM on A100); 132 SMs per the Hopper blog' },
  'h200-sxm': { family: 'hopper', sms: 132, flopsPerClockPerSm: { bf16: 4096, fp8: 8192 }, basis: 'Same GH100 die as H100' },
  'b200-hgx': { family: 'blackwell', sms: 148, flopsPerClockPerSm: { bf16: 8192, fp8: 16384, fp4: 32768 }, basis: 'Chips and Cheese: 1,024 16-bit MAC/clk per SM sub-partition, 4 per SM; FP8 2x, FP4 4x' },
  'b300-hgx': { family: 'blackwell', sms: 160, flopsPerClockPerSm: { bf16: 8192, fp8: 16384, fp4: 49152 }, basis: 'Blackwell Ultra blog: 160 SMs; NVFP4 at 3x the FP8 rate' },
  'gb300-nvl72': { family: 'blackwell', sms: 160, flopsPerClockPerSm: { bf16: 8192, fp8: 16384, fp4: 49152 }, basis: 'Same Blackwell Ultra die as B300, higher power bin' },
  mi355x: { family: 'cdna4', sms: 256, flopsPerClockPerSm: { bf16: 4096, fp8: 8192, fp4: 16384 }, statedClockGhz: 2.4, basis: 'AMD: 256 CUs at 2.4 GHz peak engine clock; AMD rounds its peaks to about two significant figures' },
};

// Energy per tensor FLOP is taken as proportional to operand bits (NVFP4/MXFP4 carry block
// scales, about half a bit per value). The ceiling applies when power is not the limit: H800
// reached 94-96% of peak with low-toggle inputs (arXiv 2501.12084).
export const OPERAND_BITS: Record<Precision, number> = { bf16: 16, fp8: 8, fp4: 4.5 };
export const ARCHITECTURAL_CEILING = 0.95;

export const BYTES_PER_PARAM: Record<Precision, number> = {
  bf16: 2,
  fp8: 1,
  fp4: 0.5 + 1 / 16, // NVFP4: 4-bit values plus one E4M3 scale per 16-value block
};

// Fixed structural assumptions. They are not fitted; changing one is a model change.
export const ASSUMPTIONS = {
  memoryReserveFraction: 0.1, // activations, workspace, and runtime context kept out of weights + KV cache
  kvCacheBytes: 1, // FP8 KV cache, as used by the MLPerf submissions modeled here
  activationBytes: 2, // BF16 activations exchanged by tensor-parallel all-reduce
  allReduceLatencySeconds: 10e-6, // fixed cost per all-reduce on NVLink
  tensorParallelOptions: [1, 2, 4, 8],
} as const;

export type ChipModel = {
  id: string;
  family: Family;
  peakTflops: Partial<Record<Precision, number>>;
  bandwidthTbps: number;
  capacityGb: number;
  scaleUpPerDirectionTbps: number;
  powerW: number;
};

export type FamilyEfficiency = { bf16TflopsPerWatt: number; memory: number };

export type Calibration = {
  families: Record<Family, FamilyEfficiency & { gemmRows: number; memoryRows: number; source: 'calibrated' | 'mean-of-calibrated-families' }>;
  servingEfficiency: number;
  servingRows: number;
};

// Sustained tensor throughput: the lesser of the architectural ceiling and the power ceiling.
export function sustainedTflops(chip: ChipModel, efficiency: FamilyEfficiency, precision: Precision) {
  const architectural = chip.peakTflops[precision]! * ARCHITECTURAL_CEILING;
  const power = efficiency.bf16TflopsPerWatt * chip.powerW * (OPERAND_BITS.bf16 / OPERAND_BITS[precision]);
  return Math.min(architectural, power);
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const midpoint = (value: number | undefined, range: [number, number] | undefined) => value ?? (range![0] + range![1]) / 2;

export function chipModel(targets: Targets, id: string, powerOverrideW?: number): ChipModel {
  const chip = targets.reference_chips.find((entry) => entry.id === id);
  const arch = MICROARCH[id];
  if (!chip || !arch) throw new Error(`No reference chip and microarchitecture for ${id}`);
  const peakTflops: Partial<Record<Precision, number>> = {};
  for (const precision of ['bf16', 'fp8', 'fp4'] as const) {
    const figure = chip.peak_dense_tflops[precision];
    if (figure) peakTflops[precision] = figure.value;
  }
  return {
    id,
    family: arch.family,
    peakTflops,
    bandwidthTbps: chip.memory.bandwidth_tbps.value,
    capacityGb: chip.memory.capacity_gb.value,
    scaleUpPerDirectionTbps: (chip.scale_up_tbps?.value ?? 0) / 2,
    powerW: powerOverrideW ?? chip.power_w?.value ?? Number.NaN,
  };
}

// Peak reproduction: one implied clock (from BF16) must reproduce every other precision.
export function peakReproduction(targets: Targets, id: string) {
  const arch = MICROARCH[id];
  const chip = chipModel(targets, id);
  const clockGhz = arch.statedClockGhz ?? (chip.peakTflops.bf16! * 1e12) / (arch.sms * arch.flopsPerClockPerSm.bf16! * 1e9);
  const rows = (Object.keys(arch.flopsPerClockPerSm) as Precision[]).map((precision) => {
    const modeledTflops = (arch.sms * arch.flopsPerClockPerSm[precision]! * clockGhz * 1e9) / 1e12;
    const targetTflops = chip.peakTflops[precision]!;
    return { precision, targetTflops, modeledTflops, relativeError: modeledTflops / targetTflops - 1 };
  });
  return { chip: id, impliedTensorClockGhz: clockGhz, rows };
}

export function modelParameters(config: ModelConfig) {
  const attention = 2 * config.hidden * config.heads * config.head_dim + 2 * config.hidden * config.kv_heads * config.head_dim;
  const mlp = 3 * config.hidden * config.ffn;
  const perLayer = attention + mlp;
  const lmHead = config.vocab * config.hidden;
  return {
    linear: config.layers * perLayer + lmHead, // parameters multiplied per token (all layers + LM head)
    total: config.layers * perLayer + 2 * lmHead, // plus the input embedding table
    kvBytesPerToken: 2 * config.layers * config.kv_heads * config.head_dim * ASSUMPTIONS.kvCacheBytes,
  };
}

// Roofline time of one GEMM, M x N x K, with operands read once and the output written once.
export function gemmSeconds(chip: ChipModel, efficiency: FamilyEfficiency, m: number, n: number, k: number, precision: Precision) {
  const flops = 2 * m * n * k;
  const bytes = (m * k + k * n) * BYTES_PER_PARAM[precision] + m * n * ASSUMPTIONS.activationBytes;
  const compute = flops / (sustainedTflops(chip, efficiency, precision) * 1e12);
  const memory = bytes / (chip.bandwidthTbps * 1e12 * efficiency.memory);
  return { seconds: Math.max(compute, memory), bound: compute >= memory ? 'compute' : 'memory', achievedTflops: flops / Math.max(compute, memory) / 1e12 };
}

type ServingWorkload = {
  model: ModelConfig;
  weights: Precision;
  scenario: 'Offline' | 'Server';
  inputTokens: number;
  outputTokens: number;
  accelerators: number;
  ttftMs: number;
  tpotMs: number;
};

export type ServingPrediction = {
  perAcceleratorTokensPerS: number;
  tensorParallel: number;
  batch: number;
  iterationMs: number;
  prefillShare: number;
  limitedBy: 'kv-capacity' | 'tpot' | 'ttft-queue';
  decodeBound: 'compute' | 'memory';
};

// Highest prefill utilization that keeps p99 time-to-first-token within the limit, with Poisson
// arrivals and an exponential waiting-time tail: P(wait > ttft - service) = rho * exp(-(1 - rho) * (ttft - service) / service).
export function maxPrefillUtilization(prefillSeconds: number, ttftSeconds: number, tailProbability = 0.01) {
  if (prefillSeconds >= ttftSeconds) return 0;
  const slack = (ttftSeconds - prefillSeconds) / prefillSeconds;
  const tail = (rho: number) => rho * Math.exp(-(1 - rho) * slack);
  if (tail(1 - 1e-9) <= tailProbability) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (tail(middle) <= tailProbability) low = middle; else high = middle;
  }
  return low;
}

// Continuous-batching LLM serving on one tensor-parallel replica, repeated across the system.
// Each iteration produces one token for every sequence in the batch and runs the prefill for
// the requests that start in its place (batch / outputTokens of them), as chunked prefill does.
// Prefill is large GEMMs and runs at the measured GEMM efficiency; decode (small GEMMs, many
// kernels, scheduling, sampling) additionally runs at the fitted serving efficiency.
export function predictServing(chip: ChipModel, efficiency: FamilyEfficiency, servingEfficiency: number, workload: ServingWorkload): ServingPrediction | null {
  const params = modelParameters(workload.model);
  const { layers, heads, head_dim: headDim, hidden } = workload.model;
  const weightPeak = sustainedTflops(chip, efficiency, workload.weights) * 1e12;
  const attentionPeak = sustainedTflops(chip, efficiency, chip.peakTflops.fp8 ? 'fp8' : 'bf16') * 1e12;
  const bandwidth = chip.bandwidthTbps * 1e12 * efficiency.memory;
  const context = workload.inputTokens + workload.outputTokens / 2;
  let best: ServingPrediction | null = null;

  for (const tp of ASSUMPTIONS.tensorParallelOptions) {
    if (tp > workload.accelerators) continue;
    const usable = tp * chip.capacityGb * 1e9 * (1 - ASSUMPTIONS.memoryReserveFraction);
    const weightBytes = params.total * BYTES_PER_PARAM[workload.weights];
    if (weightBytes >= usable) continue;
    const kvBatch = Math.floor((usable - weightBytes) / (params.kvBytesPerToken * context));
    if (kvBatch < 1) continue;

    const allReduce = (tokens: number) => tp === 1 ? 0 : 2 * layers * (ASSUMPTIONS.allReduceLatencySeconds
      + (tokens * hidden * ASSUMPTIONS.activationBytes * 2 * (tp - 1) / tp) / (chip.scaleUpPerDirectionTbps * 1e12));
    const decodeParts = (batch: number) => {
      const gemmCompute = (2 * params.linear * batch) / (tp * weightPeak);
      const gemmMemory = (params.linear * BYTES_PER_PARAM[workload.weights]) / (tp * bandwidth);
      const attentionCompute = (4 * layers * heads * headDim * context * batch) / (tp * attentionPeak);
      const attentionMemory = (batch * params.kvBytesPerToken * context) / (tp * bandwidth);
      return {
        seconds: Math.max(gemmCompute, gemmMemory) + Math.max(attentionCompute, attentionMemory) + allReduce(batch),
        bound: (gemmCompute + attentionCompute >= gemmMemory + attentionMemory ? 'compute' : 'memory') as 'compute' | 'memory',
      };
    };
    const prefillSeconds = (2 * params.linear * workload.inputTokens) / (tp * weightPeak)
      + (2 * layers * heads * headDim * workload.inputTokens ** 2) / (tp * attentionPeak)
      + allReduce(workload.inputTokens);
    const iteration = (batch: number) => decodeParts(batch).seconds / servingEfficiency + prefillSeconds * batch / workload.outputTokens;
    const prefillUtilization = (batch: number) => (batch / iteration(batch) / workload.outputTokens) * prefillSeconds;

    let batch = kvBatch;
    let limitedBy: ServingPrediction['limitedBy'] = 'kv-capacity';
    if (workload.scenario === 'Server') {
      const tpot = workload.tpotMs / 1e3;
      const rhoMax = maxPrefillUtilization(prefillSeconds, workload.ttftMs / 1e3);
      const feasible = (candidate: number) => iteration(candidate) <= tpot && prefillUtilization(candidate) <= rhoMax;
      if (!feasible(1)) continue;
      if (!feasible(kvBatch)) {
        let low = 1;
        let high = kvBatch;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (feasible(middle)) low = middle; else high = middle - 1;
        }
        batch = low;
        limitedBy = iteration(batch + 1) > tpot ? 'tpot' : 'ttft-queue';
      }
    }
    const perAccelerator = batch / iteration(batch) / tp;
    if (!best || perAccelerator > best.perAcceleratorTokensPerS) {
      best = {
        perAcceleratorTokensPerS: perAccelerator,
        tensorParallel: tp,
        batch,
        iterationMs: iteration(batch) * 1e3,
        prefillShare: (prefillSeconds * batch / workload.outputTokens) / iteration(batch),
        limitedBy,
        decodeBound: decodeParts(batch).bound,
      };
    }
  }
  return best;
}

function familyOf(row: { chip: string; family?: Family }): Family | undefined {
  return row.family ?? MICROARCH[row.chip]?.family;
}

export function servingWorkload(targets: Targets, row: MlperfRow): ServingWorkload {
  const workload = targets.benchmarks.mlperf_workloads[row.model] as MlperfWorkload;
  return {
    model: targets.models[workload.model],
    weights: row.weights,
    scenario: row.scenario,
    inputTokens: workload.mean_input_tokens,
    outputTokens: row.mean_output_tokens,
    accelerators: row.accelerators,
    ttftMs: workload.server_ttft_ms,
    tpotMs: workload.server_tpot_ms,
  };
}

// Reads only rows marked `calibrate` that belong to calibration chips (or, for bandwidth, a
// calibration family). Held-out chips and their rows are filtered out before anything is read.
export function calibrate(targets: Targets): Calibration {
  const calibrationChips = new Set(targets.calibration.calibration_chips);
  const heldOut = new Set(targets.calibration.held_out_chips);
  const allowed = (row: { chip: string; use: string }) => row.use === 'calibrate' && !heldOut.has(row.chip);
  const families = {} as Calibration['families'];
  for (const family of ['hopper', 'blackwell', 'cdna4'] as const) {
    // Sustained throughput per watt, normalized to BF16 by operand bits.
    const gemm = targets.measured.gemm.filter((row) => allowed(row) && calibrationChips.has(row.chip) && familyOf(row) === family)
      .map((row) => {
        const chip = chipModel(targets, row.chip);
        return midpoint(row.achieved_tflops, row.achieved_tflops_range) * (OPERAND_BITS[row.precision] / OPERAND_BITS.bf16) / chip.powerW;
      });
    const memory = targets.measured.memory_bandwidth.filter((row) => allowed(row) && familyOf(row) === family && (calibrationChips.has(row.chip) || row.family))
      .map((row) => midpoint(row.achieved_tbps, row.achieved_tbps_range) / (row.peak_tbps ?? chipModel(targets, row.chip).bandwidthTbps));
    if (gemm.length && memory.length) {
      families[family] = { bf16TflopsPerWatt: mean(gemm), memory: mean(memory), gemmRows: gemm.length, memoryRows: memory.length, source: 'calibrated' };
    }
  }
  const calibrated = Object.values(families);
  if (!calibrated.length) throw new Error('No calibrated family');
  for (const family of ['hopper', 'blackwell', 'cdna4'] as const) {
    if (families[family]) continue;
    families[family] = {
      bf16TflopsPerWatt: mean(calibrated.map((entry) => entry.bf16TflopsPerWatt)),
      memory: mean(calibrated.map((entry) => entry.memory)),
      gemmRows: 0,
      memoryRows: 0,
      source: 'mean-of-calibrated-families',
    };
  }

  const rows = targets.measured.mlperf_inference.filter((row) => allowed(row) && calibrationChips.has(row.chip));
  const logError = (servingEfficiency: number) => rows.reduce((sum, row) => {
    const chip = chipModel(targets, row.chip);
    const prediction = predictServing(chip, families[chip.family], servingEfficiency, servingWorkload(targets, row));
    const measured = row.system_result_tokens_per_s / row.accelerators;
    return sum + (prediction ? Math.log(prediction.perAcceleratorTokensPerS / measured) ** 2 : Number.POSITIVE_INFINITY);
  }, 0);
  // Golden-section search for the serving efficiency minimizing squared log error.
  let low = 0.05;
  let high = 1;
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let step = 0; step < 80; step += 1) {
    const left = high - ratio * (high - low);
    const right = low + ratio * (high - low);
    if (logError(left) <= logError(right)) high = right; else low = left;
  }
  return { families, servingEfficiency: (low + high) / 2, servingRows: rows.length };
}

export function evaluateMlperfRow(targets: Targets, calibration: Calibration, row: MlperfRow, powerOverrideW?: number) {
  const chip = chipModel(targets, row.chip, powerOverrideW);
  const prediction = predictServing(chip, calibration.families[chip.family], calibration.servingEfficiency, servingWorkload(targets, row));
  const measured = row.system_result_tokens_per_s / row.accelerators;
  return {
    id: row.id,
    chip: row.chip,
    model: row.model,
    scenario: row.scenario,
    weights: row.weights,
    measuredPerAccelerator: measured,
    predictedPerAccelerator: prediction?.perAcceleratorTokensPerS ?? null,
    relativeError: prediction ? prediction.perAcceleratorTokensPerS / measured - 1 : null,
    detail: prediction,
  };
}
