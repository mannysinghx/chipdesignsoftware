import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FOUNDRY_INPUTS, evaluateFoundryReadiness } from '../lib/foundry-readiness.ts';
import { DEFAULT_T0_CONFIG, evaluateT0 } from '../lib/t0-model.ts';

const t0Gates = evaluateT0(DEFAULT_T0_CONFIG).gates;

test('foundry entry remains on hold with the default evidence set', () => {
  const result = evaluateFoundryReadiness(t0Gates);
  assert.equal(result.decision, 'hold');
  assert.equal(result.fabricationAuthorized, false);
  assert.equal(result.verifiedT0Gates, 0);
  assert.equal(result.readyInputs, 1);
  assert.equal(result.restrictedInputs, 6);
});

test('qualified inputs alone cannot authorize fabrication', () => {
  const inputs = DEFAULT_FOUNDRY_INPUTS.map((input) => ({ ...input, status: 'ready' as const }));
  const result = evaluateFoundryReadiness(t0Gates, inputs);
  assert.equal(result.fabricationAuthorized, false);
  assert.match(result.blockers[0], /T0 gates/);
});

test('full measured gate closure and qualified inputs make the package ready for human review', () => {
  const gates = t0Gates.map((gate) => ({ ...gate, status: 'pass' as const, evidence: 'Reviewed measured evidence' }));
  const inputs = DEFAULT_FOUNDRY_INPUTS.map((input) => ({ ...input, status: 'ready' as const }));
  const result = evaluateFoundryReadiness(gates, inputs);
  assert.equal(result.decision, 'ready-for-review');
  assert.equal(result.fabricationAuthorized, true);
  assert.deepEqual(result.blockers, ['A named human review board—not an AI agent—must authorize irreversible fabrication spend.']);
});

test('restricted inputs never allow raw proprietary exports', () => {
  const restrictedInputs = DEFAULT_FOUNDRY_INPUTS.filter((input) => input.sensitivity === 'restricted');
  assert.ok(restrictedInputs.length > 0);
  for (const input of restrictedInputs) {
    assert.match(input.exportPolicy, /restricted|return|leave/i);
    assert.doesNotMatch(input.exportPolicy, /full source may remain open/i);
  }
});
