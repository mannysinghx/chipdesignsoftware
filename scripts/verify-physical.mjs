import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runYosys, Exit, version } from '@yowasp/yosys';

const libertyPath = '.cache/openroad-flow-scripts/flow/platforms/sky130hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const files = {
  rtl: {
    'aimem_secded_64.sv': encoder.encode(await readFile('rtl/aimem_secded_64.sv', 'utf8')),
    'aimem_t0_channel.sv': encoder.encode(await readFile('rtl/aimem_t0_channel.sv', 'utf8')),
  },
  pdk: {
    'sky130.lib': encoder.encode(await readFile(libertyPath, 'utf8')),
  },
};

let synthesisLog = '';
const capture = (bytes) => {
  if (bytes) synthesisLog += typeof bytes === 'string' ? bytes : decoder.decode(bytes);
};

let outputs;
try {
  outputs = await runYosys([
    '-p',
    'read_verilog -sv rtl/aimem_secded_64.sv rtl/aimem_t0_channel.sv; hierarchy -top aimem_t0_channel; synth -top aimem_t0_channel -flatten -noabc; dfflibmap -liberty pdk/sky130.lib; abc -liberty pdk/sky130.lib -D 1250; clean; stat -liberty pdk/sky130.lib; write_json sky130-channel.json',
  ], files, { stdout: capture, stderr: capture, decodeASCII: true });
} catch (error) {
  if (error instanceof Exit) {
    throw new Error(`Sky130 mapping failed with Yosys exit ${error.code}\n${synthesisLog.slice(-8000)}`);
  }
  throw error;
}

const netlistBytes = outputs?.['sky130-channel.json'];
if (!(netlistBytes instanceof Uint8Array) && typeof netlistBytes !== 'string') {
  throw new Error(`Yosys did not emit sky130-channel.json; emitted: ${Object.keys(outputs ?? {}).join(', ')}`);
}
const netlist = JSON.parse(typeof netlistBytes === 'string' ? netlistBytes : decoder.decode(netlistBytes));
const top = netlist.modules?.aimem_t0_channel;
if (!top) throw new Error('Mapped netlist is missing aimem_t0_channel.');

const allCells = Object.values(top.cells ?? {});
const cells = allCells.filter((cell) => cell.type !== '$scopeinfo');
const cellHistogram = cells.reduce((histogram, cell) => {
  histogram[cell.type] = (histogram[cell.type] ?? 0) + 1;
  return histogram;
}, {});
const mappedCells = cells.filter((cell) => cell.type.startsWith('sky130_fd_sc_hd__')).length;
const sequentialCells = cells.filter((cell) => /df|dlatch/i.test(cell.type)).length;
const areaMatch = synthesisLog.match(/Chip area for module '\\aimem_t0_channel':\s*([0-9.]+)/);
const chipAreaUm2 = areaMatch ? Number(areaMatch[1]) : null;

if (mappedCells !== cells.length) {
  const unmapped = [...new Set(cells.filter((cell) => !cell.type.startsWith('sky130_fd_sc_hd__')).map((cell) => cell.type))];
  throw new Error(`Sky130 mapping left ${cells.length - mappedCells} cells unmapped: ${unmapped.join(', ')}`);
}

const report = {
  schema_version: '1.0',
  status: 'passed',
  tool: `YoWASP Yosys ${version}`,
  top: 'aimem_t0_channel',
  platform: 'OpenROAD sky130hd public platform',
  platform_commit: '774ff7546d041ecad757c52b9608e7ca7d66ef93',
  liberty_corner: 'sky130_fd_sc_hd__tt_025C_1v80',
  clock_target_mhz: 800,
  mapped_cells: mappedCells,
  metadata_cells_ignored: allCells.length - cells.length,
  sequential_cells: sequentialCells,
  chip_area_um2: chipAreaUm2,
  cell_histogram: Object.fromEntries(Object.entries(cellHistogram).sort((a, b) => b[1] - a[1])),
  checks: [
    'One complete AIMEM T0 channel elaborated',
    'Sequential cells mapped with dfflibmap',
    'Combinational logic mapped with ABC against public Sky130 liberty',
    'No generic cells remain in the mapped netlist',
    'OpenROAD handoff constraints and output contract are versioned',
  ],
  limitations: [
    'Mapped-cell area is pre-placement and excludes routing, clock-tree, filler, tap and power-grid overhead.',
    'ABC target delay is a synthesis objective, not post-route timing evidence.',
    'Sky130 is an open proxy platform, not the AIMEM production process.',
  ],
};

await mkdir('evidence', { recursive: true });
await writeFile('evidence/physical-synthesis.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`Physical proxy passed: ${mappedCells} Sky130 cells${chipAreaUm2 ? `, ${chipAreaUm2.toFixed(1)} um^2` : ''}.`);
