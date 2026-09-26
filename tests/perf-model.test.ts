import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ARCHITECTURAL_CEILING,
  calibrate,
  chipModel,
  gemmSeconds,
  maxPrefillUtilization,
  modelParameters,
  peakReproduction,
  sustainedTflops,
  type Targets,
} from '../lib/perf-model.ts';
import { buildEvidence } from '../scripts/evaluate-perf-model.mjs';

const targetsText = readFileSync(new URL('../design/spec/compute-die-targets.json', import.meta.url), 'utf8');
const targets: Targets = JSON.parse(targetsText);
const evidence = JSON.parse(readFileSync(new URL('../evidence/c1-perf-model.json', import.meta.url), 'utf8'));
const evidenceV1 = JSON.parse(readFileSync(new URL('../evidence/c1-perf-model-v1.json', import.meta.url), 'utf8'));
const evidenceV2 = JSON.parse(readFileSync(new URL('../evidence/c1-perf-model-v2.json', import.meta.url), 'utf8'));
const tolerances = targets.calibration.tolerances_relative;

// Each held-out set is run once, against one frozen model, and is then consumed. A later model
// version must be validated against a newly declared, owner-approved held-out set.
const V1_MODEL_SHA256 = '9cf9786b8973045dd3d3526f98191ce50bde2fbc434c341a8f6abadecd942de2'; // consumed b300-hgx
const V2_MODEL_SHA256 = 'c28c0e0a0fa280f5a027a98b2ae1d621b71e9abff0ff78774dadd60dc24d18b4'; // consumed gb300-nvl72, mi355x
const V3_MODEL_SHA256 = '2ae82b5650a74e101fd098394dbb2c1c300f2770f59588e5dfbf2ad1caebcdce'; // consumed gb200-nvl

// Calibration rows outside tolerance when the model was frozen, recorded instead of tuned away.
const KNOWN_CALIBRATION_MISSES = new Set<string>();

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

test('C1 peaks: one tensor clock per chip reproduces every benchmark precision', () => {
  const nvidia = [...targets.calibration.calibration_chips, 'b300-hgx', 'gb300-nvl72', ...targets.calibration.held_out_chips];
  for (const id of nvidia) {
    const result = peakReproduction(targets, id);
    assert.ok(result.impliedTensorClockGhz > 1.5 && result.impliedTensorClockGhz < 2.1, `${id} clock ${result.impliedTensorClockGhz}`);
    for (const row of result.rows) assert.ok(Math.abs(row.relativeError) <= tolerances.peak_reproduction, `${id} ${row.precision}`);
  }
  // AMD states its clock (2.4 GHz) and rounds its peaks to about two significant figures.
  for (const row of peakReproduction(targets, 'mi355x').rows) assert.ok(Math.abs(row.relativeError) < 0.01, `mi355x ${row.precision}`);
});

test('the power ceiling keeps calibration chips on their measured rate and scales FP4 by operand bits', () => {
  const calibration = calibrate(targets);
  const h100 = chipModel(targets, 'h100-sxm');
  const b200 = chipModel(targets, 'b200-hgx');
  assert.ok(Math.abs(sustainedTflops(h100, calibration.families.hopper, 'bf16') - (797 + 767) / 2) < 1e-6);
  assert.ok(Math.abs(sustainedTflops(b200, calibration.families.blackwell, 'bf16') - 1250) < 1e-6);
  assert.ok(Math.abs(sustainedTflops(b200, calibration.families.blackwell, 'fp8') - 2500) < 1e-6);
  assert.ok(Math.abs(sustainedTflops(b200, calibration.families.blackwell, 'fp4') - 1250 * 16 / 4.5) < 1e-6);
  const unpowered = { ...b200, powerW: 1e9 };
  assert.equal(sustainedTflops(unpowered, calibration.families.blackwell, 'fp4'), 9000 * ARCHITECTURAL_CEILING);
  assert.equal(calibration.families.cdna4.source, 'mean-of-calibrated-families');
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
  assert.deepEqual([...heldOut], ['gb200-nvl']);
  for (const row of [...tampered.measured.mlperf_inference, ...tampered.measured.mlperf_frontier]) {
    if (heldOut.has(row.chip)) {
      row.system_result_tokens_per_s *= 7;
      row.use = 'calibrate';
    }
  }
  for (const chip of heldOut) {
    tampered.measured.gemm.push({ chip, precision: 'bf16', achieved_tflops: 1, use: 'calibrate' });
    tampered.measured.memory_bandwidth.push({ chip, achieved_tbps: 0.1, use: 'calibrate' });
  }
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
  assert.equal(evidence.calibration.serving_rows, 6);
  assert.ok(evidence.calibration.rows.every((row: { scenario: string }) => row.scenario === 'Offline'), 'only scored scenarios calibrate');
});

test('version 1 keeps its recorded held-out result: B300, failed', () => {
  assert.equal(evidenceV1.model_sha256, V1_MODEL_SHA256);
  assert.deepEqual(evidenceV1.held_out.chips, ['b300-hgx']);
  assert.equal(evidenceV1.held_out.passed, false);
  const history = (targets.calibration as unknown as { held_out_history: { model_sha256?: string }[] }).held_out_history;
  assert.equal(history[0].model_sha256, V1_MODEL_SHA256);
});

test('version 2 keeps its recorded held-out result: GB300 and MI355X, failed on Server rows', () => {
  assert.equal(evidenceV2.model_version, 2);
  assert.equal(evidenceV2.model_sha256, V2_MODEL_SHA256);
  assert.deepEqual(evidenceV2.held_out.chips, ['gb300-nvl72', 'mi355x']);
  assert.equal(evidenceV2.held_out.passed, false);
  const failed = evidenceV2.held_out.rows.filter((row: { withinTolerance: boolean }) => !row.withinTolerance)
    .map((row: { id: string; model: string; scenario: string }) => `${row.id} ${row.model} ${row.scenario}`);
  assert.deepEqual(new Set(failed), new Set(['6.0-0002 llama2-70b-99 Server', '6.0-0078 llama2-70b-99 Server']));
});

test('version 3 scores Offline best submissions and records its held-out result against the model that consumed it', () => {
  assert.equal(evidence.model_version, 3);
  assert.equal(evidence.model_sha256, V3_MODEL_SHA256);
  assert.deepEqual(evidence.scoring.qualification_scenarios, ['Offline']);
  assert.deepEqual(evidence.held_out.chips, ['gb200-nvl']);
  assert.equal(evidence.held_out.rows.length, 2);
  assert.ok(evidence.held_out.rows.every((row: { scenario: string }) => row.scenario === 'Offline'));
  assert.equal(evidence.held_out.passed, true, 'recorded outcome: GB200 Offline within 20%');
  assert.ok(evidence.held_out.unscored_rows.every((row: { scenario: string }) => row.scenario === 'Server'));
  const history = (targets.calibration as unknown as { held_out_history: { version: string; model_sha256?: string }[] }).held_out_history;
  assert.equal(history.find((entry) => entry.version === 'C1 v2')!.model_sha256, V2_MODEL_SHA256);
  assert.equal(evidence.evidence_class, 'modeled');
});
