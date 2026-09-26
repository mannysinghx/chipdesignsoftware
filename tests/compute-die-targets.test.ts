import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type Figure = {
  value?: number;
  quoted_sparse?: number;
  source: string;
  confidence: string;
  conflict?: { alternatives: { value: number; source: string }[]; resolution: string };
};

const targets = JSON.parse(readFileSync(new URL('../design/spec/compute-die-targets.json', import.meta.url), 'utf8'));
const sources = new Set(Object.keys(targets.sources));
const chips = new Map<string, { role: string; peak_dense_tflops: Record<string, Figure> }>(
  targets.reference_chips.map((chip: { id: string }) => [chip.id, chip]),
);
const CONFIDENCE = ['high', 'med', 'low'];

function figures(node: unknown, path: string, found: [string, Figure][] = []): [string, Figure][] {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const record = node as Record<string, unknown>;
    if (typeof record.value === 'number' && 'source' in record) found.push([path, record as Figure]);
    for (const [key, child] of Object.entries(record)) figures(child, `${path}.${key}`, found);
  }
  return found;
}

test('compute-die targets stay planned: nothing here is executed or measured evidence', () => {
  assert.equal(targets.status, 'planned');
  assert.equal(targets.evidence_class, 'planned');
  assert.equal(targets.parity.evidence_class_of_any_parity_claim, 'modeled');
});

test('every reference figure names a known source and a confidence', () => {
  for (const chip of targets.reference_chips) {
    assert.ok(Object.keys(chip.peak_dense_tflops).length >= 2, `${chip.id} needs at least two peak precisions`);
    assert.ok(chip.memory.capacity_gb && chip.memory.bandwidth_tbps, `${chip.id} needs memory capacity and bandwidth`);
  }
  const all = targets.reference_chips.flatMap((chip: { id: string }) => figures(chip, chip.id));
  for (const [path, figure] of all) {
    assert.ok(sources.has(figure.source), `${path} cites unknown source ${figure.source}`);
    assert.ok(CONFIDENCE.includes(figure.confidence), `${path} has confidence ${figure.confidence}`);
    assert.ok(figure.value! > 0, `${path} must be positive`);
  }
});

test('peak figures are dense, and a quoted sparse figure is exactly twice the dense one', () => {
  for (const [id, chip] of chips) {
    for (const [precision, figure] of Object.entries(chip.peak_dense_tflops)) {
      if (figure.quoted_sparse !== undefined) {
        assert.equal(figure.value! * 2, figure.quoted_sparse, `${id} ${precision}: dense must be sparse / 2`);
      }
    }
  }
});

test('calibration and held-out chips keep the FP8 = 2 x BF16 tensor ratio of Hopper and Blackwell', () => {
  for (const id of [...targets.calibration.calibration_chips, ...targets.calibration.held_out_chips]) {
    const peaks = chips.get(id)!.peak_dense_tflops;
    assert.equal(peaks.fp8.value, peaks.bf16.value! * 2, `${id} FP8 vs BF16`);
  }
});

test('every source conflict records its alternatives and how it was resolved', () => {
  const conflicts = targets.reference_chips
    .flatMap((chip: { id: string }) => figures(chip, chip.id))
    .filter(([, figure]: [string, Figure]) => figure.conflict);
  assert.ok(conflicts.length >= 3, 'the known Rubin and B200 conflicts must stay recorded');
  for (const [path, figure] of conflicts) {
    assert.ok(figure.conflict!.alternatives.length > 0, `${path} conflict lists no alternative`);
    assert.ok(figure.conflict!.resolution.length > 20, `${path} conflict has no resolution`);
  }
});

test('calibration, held-out, and target roles are disjoint and consistent', () => {
  const calibration = new Set<string>(targets.calibration.calibration_chips);
  const heldOut = new Set<string>(targets.calibration.held_out_chips);
  for (const id of heldOut) assert.ok(!calibration.has(id), `${id} is both calibration and held out`);
  for (const id of [...calibration, ...heldOut]) assert.ok(chips.has(id), `${id} is not a reference chip`);
  assert.ok(calibration.has(targets.parity.primary_target), 'the primary target must be a calibration chip');
  assert.equal(chips.get(targets.parity.stretch_target)!.role, 'stretch-target');
  for (const id of heldOut) assert.equal(chips.get(id)!.role, 'held-out');
  for (const id of targets.calibration.regression_chips ?? []) {
    assert.equal(chips.get(id)!.role, 'regression', `${id} is a consumed held-out chip`);
    assert.ok(!calibration.has(id) && !heldOut.has(id), `${id} cannot calibrate or validate again`);
    for (const row of targets.measured.mlperf_inference.filter((entry: { chip: string }) => entry.chip === id)) assert.equal(row.use, 'regression');
  }
  const history = targets.calibration.held_out_history;
  const consumed = history.flatMap((entry: { chips: string[] }) => entry.chips.filter((chip) => !heldOut.has(chip)));
  for (const chip of consumed) assert.ok(!calibration.has(chip), `${chip} was consumed and must not calibrate`);
});

test('measured data: MLPerf rows are per system, and low-confidence data never calibrates', () => {
  const rows = [
    ...targets.measured.mlperf_inference,
    ...targets.measured.gemm,
    ...targets.measured.memory_bandwidth,
  ];
  for (const row of rows) {
    assert.ok(sources.has(row.source), `measured row cites unknown source ${row.source}`);
    assert.ok(CONFIDENCE.includes(row.confidence));
    if (row.use === 'calibrate') assert.notEqual(row.confidence, 'low', `${row.source} is low confidence but calibrates`);
  }
  for (const row of targets.measured.mlperf_inference) {
    assert.ok(chips.has(row.chip), `${row.id} names unknown chip ${row.chip}`);
    assert.ok(Number.isInteger(row.accelerators) && row.accelerators > 0);
    assert.equal('per_accelerator' in row, false, 'per-accelerator throughput is computed, never stored');
    const chipRole = chips.get(row.chip)!.role;
    if (row.use === 'held-out') assert.equal(chipRole, 'held-out', `${row.id} is held out on a non-held-out chip`);
    if (targets.calibration.held_out_chips.includes(row.chip)) assert.equal(row.use, 'held-out', `${row.id} leaks the held-out chip into calibration`);
  }
  const b200 = targets.measured.mlperf_inference.find((row: { id: string; model: string; scenario: string }) =>
    row.id === '5.1-0069' && row.model === 'llama2-70b-99' && row.scenario === 'Offline');
  assert.ok(Math.abs(b200.system_result_tokens_per_s / b200.accelerators - 12690.875) < 1e-6);
});

test('transformer GEMM and attention shapes follow from the pinned model configs', () => {
  const modelIds = new Set([...targets.benchmarks.transformer_gemm.models, ...targets.benchmarks.attention.models]);
  for (const id of modelIds) {
    const model = targets.models[id];
    assert.ok(model, `benchmark uses unknown model ${id}`);
    assert.equal(model.heads * model.head_dim, model.hidden, `${id} heads x head_dim must equal hidden`);
    assert.equal(model.heads % model.kv_heads, 0, `${id} GQA groups must divide heads`);
  }
  const groups = Object.fromEntries([...modelIds].map((id) => [id, targets.models[id].heads / targets.models[id].kv_heads]));
  assert.deepEqual(groups, { 'llama2-70b': 8, 'llama3.1-405b': 16 });
  const llama405 = targets.models['llama3.1-405b'];
  assert.equal((llama405.heads + 2 * llama405.kv_heads) * llama405.head_dim, 18432, 'fused QKV width');
  for (const scenario of targets.benchmarks.llm_serving) assert.ok(targets.models[scenario.model], `${scenario.id} names unknown model`);
});

test('calibration tolerances are set, and held out is never stricter than calibration', () => {
  const tolerances = targets.calibration.tolerances_relative;
  for (const value of Object.values(tolerances)) assert.ok((value as number) > 0 && (value as number) < 1);
  assert.ok(tolerances.mlperf_per_accelerator_held_out >= tolerances.mlperf_per_accelerator_calibration);
});
