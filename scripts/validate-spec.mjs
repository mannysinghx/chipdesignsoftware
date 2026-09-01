import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const spec = JSON.parse(await readFile(new URL('../design/spec/aimem-t0.json', import.meta.url), 'utf8'));
const completion = JSON.parse(await readFile(new URL('../design/spec/t0-completion.json', import.meta.url), 'utf8'));

assert.equal(spec.id, 'aimem-x1-t0');
assert.equal(spec.revision, '0.3.0');
assert.equal(spec.status, 'modeled');
assert.equal(spec.dram.tiers, 4);
assert.equal(spec.dram.channels * spec.dram.channel_width_bits, spec.interface.payload_lanes);
assert.equal(spec.dram.channels * spec.dram.pseudochannels_per_channel, 32);
assert.equal(spec.dram.channels * spec.dram.pseudochannels_per_channel * spec.dram.banks_per_pseudochannel, 512);

const nominalBandwidth = spec.interface.payload_lanes * spec.interface.lane_rate_gbps.nominal / 8 / 1000;
assert.equal(nominalBandwidth, spec.interface.nominal_raw_bandwidth_tbps);
assert.equal(spec.decision_gates.length, 12);
assert.equal(new Set(spec.decision_gates.map((gate) => gate.id)).size, spec.decision_gates.length);
assert.ok(spec.open_source_evidence.rtl.includes('16-channel top-level composition'));
assert.ok(spec.open_source_evidence.rtl.includes('SECDED ECC datapath'));
assert.equal(spec.open_source_evidence.formal.length, 2);
assert.equal(completion.complete_when.length, 7);
assert.equal(completion.external_silicon_gates.length, 5);
assert.match(completion.policy, /unverified/);

console.log(`Validated ${spec.name} ${spec.revision}: ${spec.interface.payload_lanes} lanes, ${nominalBandwidth.toFixed(3)} TB/s, ${spec.decision_gates.length} gates.`);
