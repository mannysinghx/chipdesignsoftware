import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// C3: the A1 tile's 3 nm-class projection (tools/physical/projection/project_3nm.py).
// This recomputes the headline figures from the measured inputs independently of the
// Python script, so a change to either the inputs or the method shows up here.

type Endpoint = {
  gate_pitch_nm: number;
  tightest_metal_pitch_nm: number;
  irds_style_label: string;
  cell_area_um2: number;
  fmax_mhz: number;
  power_w: number;
  power_clock_period_ns: number;
  stage: string;
};
type Band = Record<'low' | 'central' | 'high', number>;

const read = (path: string) => JSON.parse(readFileSync(new URL(`../design/physical/projection/${path}`, import.meta.url), 'utf8'));
const inputs = read('c3-inputs.json');
const projection = read('c3-projection-3nm.json');
const a7: Endpoint = inputs.endpoints.asap7;
const g2: Endpoint = inputs.endpoints.gt2n;
const target = inputs.target;

const product = (e: { gate_pitch_nm: number; tightest_metal_pitch_nm: number }) => e.gate_pitch_nm * e.tightest_metal_pitch_nm;
const fraction = (lo: number, x: number, hi: number) => Math.log(lo / x) / Math.log(lo / hi);
const lerp = (x7: number, x2: number, t: number) => Math.exp((1 - t) * Math.log(x7) + t * Math.log(x2));
const close = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.abs(expected), `${what}: ${actual} != ${expected}`);
const ordered = (band: Band, what: string) =>
  assert.ok(band.low <= band.central && band.central <= band.high, `${what} band out of order: ${JSON.stringify(band)}`);

test('the projection is labelled modeled and predictive, never measured silicon', () => {
  assert.equal(projection.label, 'modeled');
  assert.match(projection.qualifier, /predictive, not foundry/);
  assert.ok(projection.caveats.length >= 4);
});

test('pitch labels match the pitches, and the target is IRDS 2023 3nm+ G48M24', () => {
  for (const e of [a7, g2]) {
    assert.equal(e.irds_style_label, `G${e.gate_pitch_nm}M${e.tightest_metal_pitch_nm}`);
  }
  assert.equal(target.irds_label, 'G48M24');
  assert.equal(`G${target.gate_pitch_nm}M${target.tightest_metal_pitch_nm}`, target.irds_label);
  assert.match(target.source, /Table MM-7/);
});

test('the 3 nm-class target lies between the two measured kits on every pitch', () => {
  assert.ok(product(g2) < product(target) && product(target) < product(a7));
  assert.ok(g2.gate_pitch_nm < target.gate_pitch_nm && target.gate_pitch_nm < a7.gate_pitch_nm);
  assert.ok(g2.tightest_metal_pitch_nm <= target.tightest_metal_pitch_nm && target.tightest_metal_pitch_nm < a7.tightest_metal_pitch_nm);
});

test('recomputed area, clock, energy and efficiency match the committed projection', () => {
  const t = fraction(product(a7), product(target), product(g2));
  close(projection.t.central_pitch_product, t, 't');
  close(projection.cell_area_um2.high, (a7.cell_area_um2 * product(target)) / product(a7), 'area high');
  close(projection.cell_area_um2.low, (g2.cell_area_um2 * product(target)) / product(g2), 'area low');
  close(projection.fmax_mhz.central, lerp(a7.fmax_mhz, g2.fmax_mhz, t), 'fmax central');
  const e7 = a7.power_w * a7.power_clock_period_ns * 1e3;
  const e2 = g2.power_w * g2.power_clock_period_ns * 1e3;
  const energy = lerp(e7, e2, t);
  close(projection.energy_per_cycle_pj.central, energy, 'energy central');
  close(projection.derived.bf16.tflops_per_w.central, inputs.flops_per_cycle.bf16 / energy, 'BF16 TFLOPS/W');
});

test('every band is ordered and efficiency scales with operand width', () => {
  ordered(projection.cell_area_um2, 'area');
  ordered(projection.fmax_mhz, 'fmax');
  ordered(projection.energy_per_cycle_pj, 'energy');
  for (const fmt of ['bf16', 'fp8', 'fp4']) {
    const w = projection.derived[fmt].tflops_per_w;
    assert.ok(w.worst <= w.central && w.central <= w.best, `${fmt} TFLOPS/W out of order`);
  }
  close(projection.derived.fp8.tflops_per_w.central, 2 * projection.derived.bf16.tflops_per_w.central, 'FP8 = 2 x BF16');
  close(projection.derived.fp4.tflops_per_w.central, 4 * projection.derived.bf16.tflops_per_w.central, 'FP4 = 4 x BF16');
});

test('the GT2N endpoint is marked as a post-global-route estimate', () => {
  assert.match(g2.stage, /global routing only/);
  assert.ok(projection.caveats.some((c: string) => /post-global-route/.test(c)));
});
