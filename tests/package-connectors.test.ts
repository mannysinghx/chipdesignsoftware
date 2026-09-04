import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTOR_SAMPLING, PACKAGE_GEOMETRY, STACK_PLACEMENTS, acceleratorPhyAnchor, evaluateConnectorChain, stackLocalToWorld } from '../lib/package-connectors.ts';

test('eight stacks sit directly adjacent to the four accelerator edges without overlapping', () => {
  assert.equal(STACK_PLACEMENTS.length, 8);
  const half = PACKAGE_GEOMETRY.baseDie.size / 2;
  const accelHalfWidth = PACKAGE_GEOMETRY.accelerator.width / 2;
  const accelHalfDepth = PACKAGE_GEOMETRY.accelerator.depth / 2;
  for (const placement of STACK_PLACEMENTS) {
    const overlapsAccelerator = Math.abs(placement.x) - half < accelHalfWidth && Math.abs(placement.z) - half < accelHalfDepth;
    assert.equal(overlapsAccelerator, false, `stack ${placement.index} overlaps the accelerator`);
    const gap = placement.side === 'north' || placement.side === 'south' ? Math.abs(placement.z) - half - accelHalfDepth : Math.abs(placement.x) - half - accelHalfWidth;
    assert.ok(Math.abs(gap - PACKAGE_GEOMETRY.stackGap) < 1e-9, `stack ${placement.index} is not adjacent to its edge`);
    assert.ok(Math.abs(placement.x) + half <= PACKAGE_GEOMETRY.interposer.width / 2);
    assert.ok(Math.abs(placement.z) + half <= PACKAGE_GEOMETRY.interposer.depth / 2);
  }
  for (let a = 0; a < STACK_PLACEMENTS.length; a += 1) for (let b = a + 1; b < STACK_PLACEMENTS.length; b += 1) {
    const dx = Math.abs(STACK_PLACEMENTS[a].x - STACK_PLACEMENTS[b].x);
    const dz = Math.abs(STACK_PLACEMENTS[a].z - STACK_PLACEMENTS[b].z);
    assert.ok(dx >= PACKAGE_GEOMETRY.baseDie.size || dz >= PACKAGE_GEOMETRY.baseDie.size, `stacks ${a} and ${b} overlap`);
  }
  assert.deepEqual(STACK_PLACEMENTS.slice(0, 2).map((placement) => placement.side), ['north', 'south']);
  assert.deepEqual(new Set(STACK_PLACEMENTS.slice(0, 4).map((placement) => placement.side)), new Set(['north', 'south']));
});

test('local stack +z always points at the accelerator PHY that faces it', () => {
  for (const placement of STACK_PLACEMENTS) {
    const [x, z] = stackLocalToWorld(placement, 0, 1);
    const towardAccelerator = Math.hypot(x, z) < Math.hypot(placement.x, placement.z);
    assert.ok(towardAccelerator, `stack ${placement.index} local +z points away from the accelerator`);
    const phy = acceleratorPhyAnchor(placement);
    assert.ok(Math.abs(phy.x) < PACKAGE_GEOMETRY.accelerator.width / 2 && Math.abs(phy.z) < PACKAGE_GEOMETRY.accelerator.depth / 2);
    const aligned = placement.side === 'north' || placement.side === 'south' ? phy.x === placement.x : phy.z === placement.z;
    assert.ok(aligned, `PHY for stack ${placement.index} is not aligned with its stack`);
  }
});

test('connector chain covers board-to-DRAM with every level ordered and counted', () => {
  const chain = evaluateConnectorChain(8, 16);
  assert.deepEqual(chain.levels.map((level) => level.id), ['bga', 'substrate-vias', 'c4', 'interposer-tsv', 'interposer-rdl', 'microbump-accelerator', 'microbump-base', 'base-tsv', 'hybrid-bond', 'dram-tsv', 'decoupling', 'stiffener', 'underfill', 'lid']);
  assert.deepEqual(chain.levels.map((level) => level.order), chain.levels.map((_, index) => index + 1));
  assert.deepEqual(chain.unrenderedLevels, ['substrate-vias', 'underfill', 'lid']);
  assert.equal(chain.renderedLevels, 11);
  assert.equal(chain.hybridBondInterfaces, 128);
  const byId = Object.fromEntries(chain.levels.map((level) => [level.id, level.sampled]));
  assert.equal(byId.bga, CONNECTOR_SAMPLING.bga.columns * CONNECTOR_SAMPLING.bga.rows);
  assert.equal(byId['interposer-tsv'], 120 + 8 * 16);
  assert.equal(byId['interposer-rdl'], 128);
  assert.equal(byId['microbump-base'], 8 * 49);
  assert.equal(byId['base-tsv'], 128);
  assert.equal(byId['dram-tsv'], 8 * 15 * 16);
  assert.equal(byId['hybrid-bond'], 8 * 16 * 36);
  assert.equal(chain.renderedSamples, chain.levels.reduce((sum, level) => sum + level.sampled, 0));
  for (const level of chain.levels) if (!level.rendered) assert.equal(level.sampled, 0);
});

test('connector chain scales with stack count and clamps to the placement table', () => {
  const one = evaluateConnectorChain(1, 16);
  const eight = evaluateConnectorChain(8, 16);
  const twelve = evaluateConnectorChain(12, 16);
  assert.equal(one.hybridBondInterfaces, 16);
  assert.ok(one.renderedSamples < eight.renderedSamples);
  assert.equal(twelve.stackCount, 8);
  assert.equal(twelve.renderedSamples, eight.renderedSamples);
});
