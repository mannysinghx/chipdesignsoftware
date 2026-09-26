import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  calibrate,
  chipModel,
  gemmSeconds,
  maxPrefillUtilization,
  modelParameters,
  peakReproduction,
  type Targets,
} from '../lib/perf-model.ts';
import { buildEvidence } from '../scripts/evaluate-perf-model.mjs';

const targetsText = readFileSync(new URL('../design/spec/compute-die-targets.json', import.meta.url), 'utf8');
const targets: Targets = JSON.parse(targetsText);
const evidence = JSON.parse(readFileSync(new URL('../evidence/c1-perf-model.json', import.meta.url), 'utf8'));
const tolerances = targets.calibration.tolerances_relative;

// The first and only held-out run used this model. Any later model version has seen B300's
// result and must be validated against a newly declared held-out set (docs/COMPUTE_DIE_PLAN.md, C1).
const HELD_OUT_CONSUMED_BY_MODEL_SHA256 = '9cf9786b8973045dd3d3526f98191ce50bde2fbc434c341a8f6abadecd942de2';

// Calibration rows outside tolerance when the model was frozen, recorded instead of tuned away.
const KNOWN_CALIBRATION_MISSES = new Set(['5.0-0060 llama3.1-405b Server']);

function closeTo(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${path}: ${actual} vs ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual) && actual.length === expected.length, `${path}: array shape`);
    expected.forEach((value, index) => closeTo((actual as unknown[])[index], value, `${path}[${index}]`));
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual as object).sort(), Object.keys(expected).sort(), `${path}: keys`);
    for (const [key, value] of Object.entries(expected)) closeTo((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

test('C1 peaks: one implied tensor clock per chip reproduces every benchmark precision exactly', () => {
  for (const id of [...targets.calibration.calibration_chips, ...targets.calibration.held_out_chips]) {
    const result = peakReproduction(targets, id);
    assert.ok(result.impliedTensorClockGhz > 1.5 && result.impliedTensorClockGhz < 2.1, `${id} clock ${result.impliedTensorClockGhz}`);
    for (const row of result.rows) assert.ok(Math.abs(row.relativeError) <= tolerances.peak_reproduction, `${id} ${row.precision}`);
  }
});

test('parameter counts derived from the model configs match the published sizes within 2%', () => {
  for (const id of ['llama2-70b', 'llama3.1-405b']) {
    const params = modelParameters(targets.models[id] as never);
    const published = (targets.models[id] as unknown as { params_billion: number }).params_billion * 1e9;
    assert.ok(Math.abs(params.total / published - 1) < 0.02, `${id}: ${params.total} vs ${published}`);
  }
  assert.equal(modelParameters(targets.models['llama3.1-405b'] as never).kvBytesPerToken, 2 * 126 * 8 * 128);
});

test('calibration never reads the held-out chip: changing its measurements changes nothing', () => {
  const tampered: Targets = JSON.parse(targetsText);
  const heldOut = new Set(tampered.calibration.held_out_chips);
  for (const row of tampered.measured.mlperf_inference) if (heldOut.has(row.chip)) row.system_result_tokens_per_s *= 7;
  tampered.measured.gemm.push({ chip: 'b300-hgx', precision: 'bf16', achieved_tflops: 1, use: 'calibrate' });
  tampered.measured.memory_bandwidth.push({ chip: 'b300-hgx', achieved_tbps: 0.1, use: 'calibrate' });
  assert.deepEqual(calibrate(tampered), calibrate(targets));
});

test('GEMM and bandwidth calibration reproduce their measured rows within tolerance', () => {
  const calibration = calibrate(targets);
  for (const row of targets.measured.gemm.filter((entry) => entry.use === 'calibrate')) {
    const chip = chipModel(targets, row.chip);
    const measured = row.achieved_tflops ?? (row.achieved_tflops_range![0] + row.achieved_tflops_range![1]) / 2;
    const size = 16384;
    const modeled = gemmSeconds(chip, calibration.families[chip.family], size, size, size, row.precision).achievedTflops;
    assert.ok(Math.abs(modeled / measured - 1) <= tolerances.gemm_achieved, `${row.chip} ${row.precision}: ${modeled} vs ${measured}`);
  }
  assert.ok(calibration.families.hopper.memory > 0.85 && calibration.families.hopper.memory < 0.95);
  assert.ok(calibration.families.blackwell.memory > 0.8 && calibration.families.blackwell.memory < 0.95);
});

test('the TTFT queue bound tightens as a prefill takes more of the latency limit', () => {
  assert.equal(maxPrefillUtilization(7, 6), 0);
  const long = maxPrefillUtilization(1.2, 6);
  const short = maxPrefillUtilization(0.1, 6);
  assert.ok(long > 0 && long < short && short <= 1);
});

test('evidence/c1-perf-model.json is exactly what the frozen targets and model produce', async () => {
  const modelSha = createHash('sha256').update(readFileSync(new URL('../lib/perf-model.ts', import.meta.url))).digest('hex');
  assert.equal(evidence.model_sha256, modelSha, 'the model changed; regenerate the evidence and declare a new held-out set');
  assert.equal(evidence.targets_sha256, createHash('sha256').update(targetsText).digest('hex'));
  closeTo(await buildEvidence({ includeHeldOut: true }), evidence);
});

test('calibration: every MLPerf row is within tolerance except the recorded misses', () => {
  const misses = evidence.calibration.rows
    .filter((row: { withinTolerance: boolean }) => !row.withinTolerance)
    .map((row: { id: string; model: string; scenario: string }) => `${row.id} ${row.model} ${row.scenario}`);
  assert.deepEqual(new Set(misses), KNOWN_CALIBRATION_MISSES);
  assert.equal(evidence.calibration.serving_rows, 10);
});

test('the held-out result is recorded against the model that consumed it', () => {
  assert.equal(evidence.model_sha256, HELD_OUT_CONSUMED_BY_MODEL_SHA256);
  assert.deepEqual(evidence.held_out.chips, ['b300-hgx']);
  assert.equal(evidence.held_out.rows.length, 4);
  assert.equal(evidence.held_out.passed, false, 'recorded outcome: the frozen model overpredicts B300');
  assert.equal(evidence.evidence_class, 'modeled');
});
