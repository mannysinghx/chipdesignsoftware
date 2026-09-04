import test from 'node:test';
import assert from 'node:assert/strict';
import rtlEvidence from '../evidence/rtl-synthesis.json' with { type: 'json' };
import { DIGITAL_MODULES, evaluateDigitalImplementation } from '../lib/digital-implementation.ts';

test('digital workspace is anchored to the checked-in RTL evidence', () => {
  const result = evaluateDigitalImplementation('current', rtlEvidence);
  assert.equal(result.evidence.top, 'aimem_t0_top');
  assert.equal(result.evidence.channels, 16);
  assert.equal(result.evidence.cells, 19582);
  assert.equal(result.evidence.formal_proofs, 2);
});

test('module inventory matches the five implementation blocks', () => {
  assert.equal(DIGITAL_MODULES.length, 5);
  assert.equal(DIGITAL_MODULES.reduce((sum, module) => sum + module.lines, 0), 386);
});

test('open-source evidence does not overstate digital closure', () => {
  const result = evaluateDigitalImplementation('current', rtlEvidence);
  assert.equal(result.passCount, 5);
  assert.equal(result.provisionalCount, 1);
  assert.equal(result.plannedCount, 3);
  assert.equal(result.releaseDecision, 'hold');
});

test('review scopes expose increasing campaign depth without claiming execution', () => {
  const current = evaluateDigitalImplementation('current', rtlEvidence);
  const regression = evaluateDigitalImplementation('regression', rtlEvidence);
  const closure = evaluateDigitalImplementation('closure', rtlEvidence);
  assert.ok(current.review.proofDepth < regression.review.proofDepth);
  assert.ok(regression.review.proofDepth < closure.review.proofDepth);
  assert.ok(regression.review.transactions < closure.review.transactions);
  assert.equal(current.passCount, closure.passCount);
});
