import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runYosys, Exit, version } from '@yowasp/yosys';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const files = {
  rtl: {
    'aimem_t0_channel.sv': encoder.encode(await readFile('rtl/aimem_t0_channel.sv', 'utf8')),
    'aimem_t0_top.sv': encoder.encode(await readFile('rtl/aimem_t0_top.sv', 'utf8')),
  },
  formal: {
    'aimem_t0_channel_formal.sv': encoder.encode(await readFile('formal/aimem_t0_channel_formal.sv', 'utf8')),
  },
};

let synthesisLog = '';
const capture = (bytes) => {
  if (bytes) synthesisLog += typeof bytes === 'string' ? bytes : decoder.decode(bytes);
};

async function run(args) {
  try {
    return await runYosys(args, files, { stdout: capture, stderr: capture, decodeASCII: true });
  } catch (error) {
    if (error instanceof Exit) {
      throw new Error(`Yosys exited with ${error.code}\n${synthesisLog.slice(-6000)}`);
    }
    throw error;
  }
}

const synthesisFiles = await run([
  '-p',
  'read_verilog -sv rtl/aimem_t0_channel.sv rtl/aimem_t0_top.sv; hierarchy -top aimem_t0_top; proc; flatten; opt; memory; opt; stat; write_json synth.json',
]);

const netlistBytes = synthesisFiles?.['synth.json'];
if (!(netlistBytes instanceof Uint8Array) && typeof netlistBytes !== 'string') {
  throw new Error(`Yosys did not emit synth.json; emitted: ${Object.keys(synthesisFiles ?? {}).join(', ')}`);
}
const netlist = JSON.parse(typeof netlistBytes === 'string' ? netlistBytes : decoder.decode(netlistBytes));
const topModule = netlist.modules?.aimem_t0_top;
if (!topModule) throw new Error('Synthesized netlist is missing aimem_t0_top.');
const cellCount = Object.keys(topModule.cells ?? {}).length;
const wireCount = Object.keys(topModule.netnames ?? {}).length;
const wireBitCount = Object.values(topModule.netnames ?? {}).reduce((sum, net) => sum + (net.bits?.length ?? 0), 0);

await run([
  '-p',
  'read_verilog -formal -D FORMAL -sv rtl/aimem_t0_channel.sv formal/aimem_t0_channel_formal.sv; prep -top aimem_t0_channel_formal; flatten; async2sync; memory_map; opt; sat -verify -prove-asserts -seq 32 -set-init-zero',
]);

const report = {
  schema_version: '1.0',
  tool: `YoWASP Yosys ${version}`,
  top: 'aimem_t0_top',
  channels: 16,
  status: 'passed',
  cells: cellCount,
  wires: wireCount,
  wire_bits: wireBitCount,
  checks: [
    'SystemVerilog parsed',
    '16-channel hierarchy elaborated',
    'Processes lowered',
    'Memories normalized',
    'Generic synthesis completed',
    '32-cycle bounded safety proof completed',
  ],
  limitations: [
    'Generic cells only; no foundry liberty mapping',
    'Bounded assertions are not an unbounded liveness proof',
    'ECC datapath and gather engine remain interface-level placeholders',
  ],
};

await mkdir('evidence', { recursive: true });
await writeFile('evidence/rtl-synthesis.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`RTL verification passed: ${report.channels} channels, ${report.cells} generic cells, ${report.wires} wires.`);
