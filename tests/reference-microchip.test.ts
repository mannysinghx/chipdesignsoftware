import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMEM_REFERENCE_MACROS, OPEN_TITAN_REFERENCE, SKY130_VISUAL_LAYERS } from '../lib/reference-microchip.ts';

test('real-chip reference preserves published Earl Grey organization facts', () => {
  assert.equal(OPEN_TITAN_REFERENCE.top, 'chip_earlgrey_asic');
  assert.equal(OPEN_TITAN_REFERENCE.powerDomains.length, 2);
  assert.equal(OPEN_TITAN_REFERENCE.clocks.length, 4);
  assert.equal(OPEN_TITAN_REFERENCE.busLevels, 2);
  assert.equal(OPEN_TITAN_REFERENCE.asicPadCount, 71);
  assert.equal(OPEN_TITAN_REFERENCE.ioBanks, 4);
});

test('AIMEM adaptation includes functional macros in both power domains', () => {
  assert.equal(AIMEM_REFERENCE_MACROS.length, 8);
  assert.ok(AIMEM_REFERENCE_MACROS.some((macro) => macro.domain === 'main'));
  assert.ok(AIMEM_REFERENCE_MACROS.some((macro) => macro.domain === 'always-on'));
  assert.equal(new Set(AIMEM_REFERENCE_MACROS.map((macro) => macro.id)).size, AIMEM_REFERENCE_MACROS.length);
});

test('physical visualization follows the public SKY130 local-to-global metal stack', () => {
  assert.deepEqual(SKY130_VISUAL_LAYERS.map((layer) => layer.id), ['li1', 'met1', 'met2', 'met3', 'met4', 'met5']);
});
