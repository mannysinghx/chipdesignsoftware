// Evaluates the C1 performance model (version 3) against the frozen targets. Rows are each chip's
// best MLPerf submission; only the scoring scenarios (Offline) count toward pass or fail.
//   --calibration-only  prints calibration and regression results; never predicts a held-out chip
//   (default)           also predicts the held-out chips and writes evidence/c1-perf-model.json
// Earlier versions' evidence is kept, unchanged, in evidence/c1-perf-model-v1.json and -v2.json.
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
  const scored = new Set(targets.calibration.scoring.qualification_scenarios);
  const frontier = targets.measured.mlperf_frontier;

  const regressionChips = new Set(targets.calibration.regression_chips ?? []);
  const peaks = [...targets.calibration.calibration_chips, ...regressionChips, ...targets.calibration.held_out_chips].map((id) => peakReproduction(targets, id));
  const calibrationRows = frontier
    .filter((row) => row.use === 'calibrate')
    .map((row) => evaluateMlperfRow(targets, calibration, row))
    .map((row) => ({ ...row, withinTolerance: row.relativeError !== null && Math.abs(row.relativeError) <= tolerances.mlperf_per_accelerator_calibration }));

  const evidence = {
    evidence_class: 'modeled',
    step: 'C1',
    model_version: 3,
    scoring: targets.calibration.scoring,
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
      server_report: frontier.filter((row) => row.use === 'report').map((row) => evaluateMlperfRow(targets, calibration, row)),
    },
    regression: {
      note: 'Consumed held-out chips, reported for diagnosis only; not validation',
      rows: frontier
        .filter((row) => regressionChips.has(row.chip))
        .map((row) => evaluateMlperfRow(targets, calibration, row)),
    },
  };

  if (includeHeldOut) {
    const all = frontier
      .filter((row) => heldOut.has(row.chip))
      .map((row) => evaluateMlperfRow(targets, calibration, row));
    const rows = all.filter((row) => scored.has(row.scenario))
      .map((row) => ({ ...row, withinTolerance: row.relativeError !== null && Math.abs(row.relativeError) <= tolerances.mlperf_per_accelerator_held_out }));
    evidence.held_out = {
      chips: [...heldOut],
      rows,
      tolerance: tolerances.mlperf_per_accelerator_held_out,
      passed: rows.length > 0 && rows.every((row) => row.withinTolerance),
      max_abs_relative_error: Math.max(...rows.map((row) => Math.abs(row.relativeError))),
      unscored_rows: all.filter((row) => !scored.has(row.scenario)),
    };
    // Unscored sensitivity for held-out chips whose power rating is disputed (declared in the targets).
    evidence.held_out.power_sensitivity = targets.reference_chips
      .filter((chip) => heldOut.has(chip.id) && chip.power_w?.conflict)
      .flatMap((chip) => chip.power_w.conflict.alternatives.map((alternative) => ({
        chip: chip.id,
        power_w: alternative.value,
        scored: false,
        rows: frontier
          .filter((row) => row.chip === chip.id)
          .map((row) => evaluateMlperfRow(targets, calibration, row, alternative.value)),
      })));
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
