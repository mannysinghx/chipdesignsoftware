// Evaluates the C1 performance model against the frozen targets.
//   --calibration-only  prints calibration results and never computes a held-out prediction
//   (default)           also predicts the held-out chip and writes evidence/c1-perf-model.json
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { ASSUMPTIONS, calibrate, evaluateMlperfRow, peakReproduction } from '../lib/perf-model.ts';

export async function buildEvidence({ includeHeldOut }) {
  const targetsText = await readFile(new URL('../design/spec/compute-die-targets.json', import.meta.url), 'utf8');
  const modelText = await readFile(new URL('../lib/perf-model.ts', import.meta.url), 'utf8');
  const targets = JSON.parse(targetsText);
  const tolerances = targets.calibration.tolerances_relative;
  const calibration = calibrate(targets);
  const heldOut = new Set(targets.calibration.held_out_chips);

  const peaks = [...targets.calibration.calibration_chips, ...targets.calibration.held_out_chips].map((id) => peakReproduction(targets, id));
  const calibrationRows = targets.measured.mlperf_inference
    .filter((row) => row.use === 'calibrate')
    .map((row) => evaluateMlperfRow(targets, calibration, row))
    .map((row) => ({ ...row, withinTolerance: row.relativeError !== null && Math.abs(row.relativeError) <= tolerances.mlperf_per_accelerator_calibration }));

  const evidence = {
    evidence_class: 'modeled',
    step: 'C1',
    targets_sha256: createHash('sha256').update(targetsText).digest('hex'),
    model_sha256: createHash('sha256').update(modelText).digest('hex'),
    assumptions: ASSUMPTIONS,
    peak_reproduction: peaks,
    calibration: {
      families: calibration.families,
      serving_efficiency: calibration.servingEfficiency,
      serving_rows: calibration.servingRows,
      rows: calibrationRows,
      all_within_tolerance: calibrationRows.every((row) => row.withinTolerance),
      max_abs_relative_error: Math.max(...calibrationRows.map((row) => Math.abs(row.relativeError))),
    },
  };

  if (includeHeldOut) {
    const rows = targets.measured.mlperf_inference
      .filter((row) => heldOut.has(row.chip))
      .map((row) => evaluateMlperfRow(targets, calibration, row))
      .map((row) => ({ ...row, withinTolerance: row.relativeError !== null && Math.abs(row.relativeError) <= tolerances.mlperf_per_accelerator_held_out }));
    evidence.held_out = {
      chips: [...heldOut],
      rows,
      tolerance: tolerances.mlperf_per_accelerator_held_out,
      passed: rows.every((row) => row.withinTolerance),
      max_abs_relative_error: Math.max(...rows.map((row) => Math.abs(row.relativeError))),
    };
    evidence.cross_checks = targets.measured.mlperf_inference
      .filter((row) => row.use === 'cross-check')
      .map((row) => ({ id: row.id, chip: row.chip, note: 'No microarchitecture model for this chip in C1; not evaluated' }));
  }
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const calibrationOnly = process.argv.includes('--calibration-only');
  const evidence = await buildEvidence({ includeHeldOut: !calibrationOnly });
  if (calibrationOnly) {
    console.log(JSON.stringify(evidence, null, 2));
  } else {
    await writeFile(new URL('../evidence/c1-perf-model.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Wrote evidence/c1-perf-model.json (held out passed: ${evidence.held_out.passed})`);
  }
}
