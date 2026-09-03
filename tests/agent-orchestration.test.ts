import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAgentMission } from '../lib/agent-orchestration.ts';

test('mission begins with the requirements curator active', () => {
  const result = evaluateAgentMission('x1-production', 0, 'running');
  assert.equal(result.currentNode.id, 'contract');
  assert.equal(result.activeCount, 1);
  assert.equal(result.progressPercent, 0);
});

test('open-source replay completes exactly eight safe automation nodes', () => {
  const result = evaluateAgentMission('t1-qualification', 8, 'blocked');
  assert.equal(result.safeNodeCount, 8);
  assert.equal(result.completedOpenNodes, 8);
  assert.equal(result.artifactsReady.length, 8);
  assert.equal(result.progressPercent, 100);
  assert.equal(result.safeAutomationComplete, true);
});

test('mission always stops at physical, restricted, and human boundaries', () => {
  const result = evaluateAgentMission('t0-closure', 8, 'blocked');
  assert.deepEqual(result.boundaryNodes.map((node) => node.lane), ['external', 'restricted', 'human']);
  assert.ok(result.boundaryNodes.every((node) => node.status === 'blocked'));
  assert.equal(result.currentNode.id, 'silicon');
  assert.equal(result.decision, 'hold');
});

test('completed node count is clamped to the safe workflow size', () => {
  assert.equal(evaluateAgentMission('x1-production', 99, 'blocked').completedOpenNodes, 8);
  assert.equal(evaluateAgentMission('x1-production', -4, 'idle').completedOpenNodes, 0);
});

test('each automated node declares a toolchain, artifact, and stop rule', () => {
  const result = evaluateAgentMission('x1-production', 0, 'idle');
  for (const node of result.openNodes) {
    assert.ok(node.tools.length > 0);
    assert.ok(node.artifact.length > 0);
    assert.ok(node.stopRule.length > 0);
  }
});
