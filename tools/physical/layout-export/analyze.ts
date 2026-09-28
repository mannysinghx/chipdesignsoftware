// Analyses the exporter adds to the A1 layout data, each from a named source:
//
//   readFacts         the run's own reports: areas, cell counts, power, timing, IR drop, DRC, LVS, LEC
//   readCriticalPath  the worst setup path, cell by cell, from the finish timing report
//   assignRoles       which dot-product unit and pipeline stage each cell serves, traced through the netlist
//   parseCdl          each library cell's transistors (type, W, L, gate net) from the platform CDL
//   extractChannels   the same transistors found in the cell's GDS (poly over diffusion), with their gate pin
//   ioBusesOf         the tile's I/O pins grouped into buses along the edges
//   clockTreeOf       the clock tree: every cell that drives a clock net, and what drives it

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- facts

export type Facts = {
  source: string;
  period: number;
  area: { die: number; core: number; cells: number; utilization: number };
  counts: { cells: number; all: number; byClass: Record<string, number> };
  power: { total: number; internal: number; switching: number; leakage: number };
  timing: { fmax: number; setupWs: number; setupTns: number; setupViolations: number; holdWs: number; holdViolations: number; skewSetup: number; skewHold: number; maxSlewViolations: number; maxCapViolations: number };
  ir: { vddWorst: number; vssWorst: number; vddAverage: number; vssAverage: number };
  drc: { count: number; source: string } | null;
  lvs: { result: string; devices: number; nets: number; source: string } | null;
  lec: { result: string; source: string } | null;
};

const ORFS_CLASSES: Record<string, string> = {
  multi_input_combinational_cell: 'Combinational gates',
  inverter: 'Inverters',
  sequential_cell: 'Flip-flops',
  timing_repair_buffer: 'Timing-repair buffers',
  clock_buffer: 'Clock buffers',
  clock_inverter: 'Clock inverters',
  antenna_cell: 'Antenna diodes',
  tap_cell: 'Well taps',
  fill_cell: 'Fillers',
};

/** Facts about the run, read from its report files (null where a file is missing). */
export function readFacts(runDir: string, platform: string, design: string): Facts {
  const logs = path.join(runDir, 'logs', platform, design, 'base');
  const reports = path.join(runDir, 'reports', platform, design, 'base');
  const metrics = JSON.parse(readFileSync(path.join(logs, '6_report.json'), 'utf8')) as Record<string, number>;
  const m = (key: string) => {
    const value = metrics[key];
    if (typeof value !== 'number') throw new Error(`6_report.json has no ${key}`);
    return value;
  };
  const byClass: Record<string, number> = {};
  for (const [key, label] of Object.entries(ORFS_CLASSES)) byClass[label] = m(`finish__design__instance__count__class:${key}`);
  const finish = readFileSync(path.join(reports, '6_finish.rpt'), 'utf8');
  const periodMatch = finish.match(/\n\s+([\d.]+)\s+[\d.]+\s+clock core_clk \(rise edge\)/g)?.map((line) => Number(line.trim().split(/\s+/)[0])).filter((value) => value > 0);
  if (!periodMatch?.length) throw new Error('no capture clock edge in 6_finish.rpt');
  const drcFile = path.join(reports, '6_drc_count.rpt');
  const lvsFile = path.join(runDir, 'lvs_netgen', 'netgen_lvs_libcells2.rpt');
  const lecFile = path.join(logs, '6_final_lec_check.log');
  let lvs: Facts['lvs'] = null;
  if (existsSync(lvsFile)) {
    const text = readFileSync(lvsFile, 'utf8');
    const result = text.match(/Final result: (.+?)\.?\s*$/m)?.[1] ?? 'unknown';
    const devices = [...text.matchAll(/Number of devices: (\d+)\s*\|Number of devices: (\d+)/g)].map((match) => [Number(match[1]), Number(match[2])]).sort((a, b) => b[0] - a[0])[0];
    const nets = [...text.matchAll(/Number of nets: (\d+)\s*\|Number of nets: (\d+)/g)].map((match) => [Number(match[1]), Number(match[2])]).sort((a, b) => b[0] - a[0])[0];
    if (devices && nets && devices[0] === devices[1] && nets[0] === nets[1]) lvs = { result, devices: devices[0], nets: nets[0], source: 'lvs_netgen/netgen_lvs_libcells2.rpt' };
  }
  const lec = existsSync(lecFile) ? (readFileSync(lecFile, 'utf8').match(/Circuits are [A-Z ]+/g) ?? []).at(-1) ?? null : null;
  return {
    source: `${path.basename(runDir)}: logs/…/6_report.json, reports/…/6_finish.rpt`,
    period: periodMatch[0],
    area: { die: m('finish__design__die__area'), core: m('finish__design__core__area'), cells: m('finish__design__instance__area__stdcell'), utilization: m('finish__design__instance__utilization') },
    counts: { cells: m('finish__design__instance__count__stdcell'), all: m('finish__design__instance__count'), byClass },
    power: { total: m('finish__power__total'), internal: m('finish__power__internal__total'), switching: m('finish__power__switching__total'), leakage: m('finish__power__leakage__total') },
    timing: {
      fmax: m('finish__timing__fmax'), setupWs: m('finish__timing__setup__ws'), setupTns: m('finish__timing__setup__tns'), setupViolations: m('finish__timing__drv__setup_violation_count'),
      holdWs: m('finish__timing__hold__ws'), holdViolations: m('finish__timing__drv__hold_violation_count'), skewSetup: m('finish__clock__skew__setup'), skewHold: m('finish__clock__skew__hold'),
      maxSlewViolations: m('finish__timing__drv__max_slew'), maxCapViolations: m('finish__timing__drv__max_cap'),
    },
    ir: {
      vddWorst: m('finish__design_powergrid__drop__worst__net:VDD__corner:default'), vssWorst: m('finish__design_powergrid__drop__worst__net:VSS__corner:default'),
      vddAverage: m('finish__design_powergrid__drop__average__net:VDD__corner:default'), vssAverage: m('finish__design_powergrid__drop__average__net:VSS__corner:default'),
    },
    drc: existsSync(drcFile) ? { count: Number(readFileSync(drcFile, 'utf8').trim()), source: 'reports/…/6_drc_count.rpt (KLayout)' } : null,
    lvs,
    lec: lec ? { result: lec, source: 'logs/…/6_final_lec_check.log (kepler-formal)' } : null,
  };
}

// --------------------------------------------------------- critical path

export type PathStep = { inst: string; pin: string; cell: string; edge: 'rise' | 'fall'; time: number; delay: number; net: string | null };
export type CriticalPath = { startpoint: string; endpoint: string; arrival: number; required: number; slack: number; clock: PathStep[]; data: PathStep[] };

/** The worst setup path from the "report_checks -path_delay max" section of the finish report. */
export function readCriticalPath(reportFile: string): CriticalPath {
  const lines = readFileSync(reportFile, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'finish report_checks -path_delay max');
  if (start < 0) throw new Error('no max-delay path in the finish report');
  let startpoint = '';
  let endpoint = '';
  const steps: PathStep[] = [];
  let arrival = NaN;
  let required = NaN;
  let slack = NaN;
  for (let k = start + 1; k < lines.length; k += 1) {
    const line = lines[k];
    const trimmed = line.trim();
    if (trimmed.startsWith('Startpoint:')) startpoint = trimmed.slice(11).trim();
    else if (trimmed.startsWith('Endpoint:')) endpoint = trimmed.slice(9).trim();
    else if (trimmed.endsWith('data arrival time') && Number.isNaN(arrival)) arrival = Number(trimmed.split(/\s+/)[0]);
    else if (trimmed.endsWith('data required time') && Number.isNaN(required)) required = Number(trimmed.split(/\s+/)[0]);
    else if (trimmed.includes('slack (')) {
      slack = Number(trimmed.split(/\s+/)[0]);
      break;
    } else if (trimmed.endsWith('(net)') && steps.length > 0 && Number.isNaN(arrival)) steps[steps.length - 1].net = trimmed.slice(0, -5).trim();
    else if (Number.isNaN(arrival)) {
      // "... <delay> <time> ^|v inst/pin (cell)" — the last three tokens name the pin.
      const match = trimmed.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+([v^])\s+(\S+)\s+\(([^)]+)\)$/);
      if (!match) continue;
      const [, delay, time, edge, name, cell] = match;
      const slash = name.lastIndexOf('/');
      steps.push({ inst: slash < 0 ? name : name.slice(0, slash), pin: slash < 0 ? '' : name.slice(slash + 1), cell, edge: edge === '^' ? 'rise' : 'fall', time: Number(time), delay: Number(delay), net: null });
    }
  }
  const launch = steps.findIndex((step) => step.inst === startpoint && step.pin === 'CLK');
  if (launch < 0 || Number.isNaN(slack)) throw new Error('could not read the critical path');
  return { startpoint, endpoint, arrival, required, slack, clock: steps.slice(0, launch + 1), data: steps.slice(launch + 1) };
}

// --------------------------------------------------- units and pipeline stages

export type Roles = {
  /** Per component: dot unit 0..15, 16 when several units share it, 255 when none (control, I/O, clock, physical). */
  unit: Uint8Array;
  /** Per component: see ROLE_KINDS. */
  kind: Uint8Array;
  counts: { logic: number; assigned: number; shared: number; none: number; registers: number };
};

/** What a cell is to the datapath. Logic kinds name the stage whose registers the cell feeds. */
export const ROLE_KINDS = [
  'none', 'stage-1 logic', 'stage-2 logic', 'stage-3 logic',
  'operand register', 'product-term register', 'partial-sum register', 'accumulator register', 'C/D data register', 'response register', 'control register',
] as const;

const REGISTER_KIND: Record<string, number> = { s1_a: 4, s1_b: 4, s1_scale_a: 4, s1_scale_b: 4, s2_terms: 5, s3_partial: 6, acc: 7, s1_c: 8, s2_c: 8, s3_c: 8, rsp_data: 9 };
const SLICE: Record<string, number> = { s2_terms: 306, s3_partial: 62, acc: 32, s1_c: 32, s2_c: 32, s3_c: 32, rsp_data: 32 };
/** The stage whose logic ends in each register: stage 1 fills s2_terms, stage 2 s3_partial, stage 3 the accumulators and the response. */
const STAGE_OF: Record<string, number> = { s2_terms: 1, s3_partial: 2, acc: 3, rsp_data: 3 };

/**
 * Which dot unit and stage each cell serves. Every register bit belongs to a
 * unit by the RTL's bus layout (rtl/a1/a1_mma_tile.sv) and to a stage by the
 * register it is; a combinational cell belongs to the units and stages whose
 * registers it feeds, found by walking backward from each register's data
 * inputs through the cells that drive them (never through a clock pin, never
 * past another register). A cell reached from one unit belongs to it; from
 * several, it is shared (the operand fan-out, the format decode).
 */
export function assignRoles(input: {
  names: string[];
  cellClass: (inst: number) => string;
  /** Per component: the nets on its data input pins (clock pins left out). */
  inputs: (inst: number) => number[];
  /** Per net: the component driving it, or -1. */
  driver: Int32Array;
}): Roles {
  const n = input.names.length;
  const unitMask = new Uint16Array(n);
  const stageMask = new Uint8Array(n);
  const kind = new Uint8Array(n);
  const unit = new Uint8Array(n).fill(255);
  const queue: number[] = [];
  let registers = 0;
  for (let inst = 0; inst < n; inst += 1) {
    if (input.cellClass(inst) !== 'sequential') continue;
    registers += 1;
    const name = input.names[inst].replace(/\$.*/, '');
    const base = name.replace(/\[.*/, '');
    const bits = [...name.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    kind[inst] = REGISTER_KIND[base] ?? 10;
    const width = SLICE[base];
    if (width !== undefined && bits.length > 0) {
      const u = Math.floor(bits[bits.length - 1] / width);
      unit[inst] = u;
      unitMask[inst] = 1 << u;
    }
    const stage = STAGE_OF[base];
    if (stage !== undefined) stageMask[inst] = 1 << (stage - 1);
    if (unitMask[inst] || stageMask[inst]) queue.push(inst);
  }
  // Backward: a register or a reached cell passes its bits to the cells driving its data inputs.
  while (queue.length > 0) {
    const inst = queue.pop()!;
    for (const net of input.inputs(inst)) {
      const d = input.driver[net];
      if (d < 0 || input.cellClass(d) === 'sequential') continue;
      const um = unitMask[d] | unitMask[inst];
      const sm = stageMask[d] | stageMask[inst];
      if (um === unitMask[d] && sm === stageMask[d]) continue;
      unitMask[d] = um;
      stageMask[d] = sm;
      queue.push(d);
    }
  }
  let logic = 0;
  let assigned = 0;
  let shared = 0;
  let none = 0;
  for (let inst = 0; inst < n; inst += 1) {
    if (input.cellClass(inst) === 'sequential') continue;
    const cls = input.cellClass(inst);
    if (cls !== 'logic' && cls !== 'buffer') continue;
    logic += 1;
    const um = unitMask[inst];
    if (um === 0) none += 1;
    else if ((um & (um - 1)) === 0) {
      unit[inst] = 31 - Math.clz32(um);
      assigned += 1;
    } else {
      unit[inst] = 16;
      shared += 1;
    }
    // The stage: the latest stage it feeds (a cell feeding two stages sits where they meet).
    const sm = stageMask[inst];
    kind[inst] = sm & 4 ? 3 : sm & 2 ? 2 : sm & 1 ? 1 : 0;
  }
  return { unit, kind, counts: { logic, assigned, shared, none, registers } };
}

// ------------------------------------------------------------ transistors

export type CdlDevice = { name: string; type: 'n' | 'p'; model: string; d: string; g: string; s: string; w: number; l: number; m: number };

/** Every subcircuit's transistors from a CDL/SPICE netlist. */
export function parseCdl(file: string): Map<string, { pins: string[]; devices: CdlDevice[] }> {
  const out = new Map<string, { pins: string[]; devices: CdlDevice[] }>();
  const lines: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw.startsWith('+') && lines.length > 0) lines[lines.length - 1] += ` ${raw.slice(1)}`;
    else lines.push(raw);
  }
  let current: { pins: string[]; devices: CdlDevice[] } | null = null;
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t[0]?.toUpperCase() === '.SUBCKT') {
      current = { pins: t.slice(2), devices: [] };
      out.set(t[1], current);
    } else if (t[0]?.toUpperCase() === '.ENDS') current = null;
    else if (current && /^M/i.test(t[0] ?? '')) {
      const params = Object.fromEntries(t.slice(6).filter((token) => token.includes('=')).map((token) => token.split('=') as [string, string]));
      const model = t[5];
      current.devices.push({ name: t[0], type: /pfet|pmos/i.test(model) ? 'p' : 'n', model, d: t[1], g: t[2], s: t[3], w: Number(params.w), l: Number(params.l), m: Number(params.m ?? 1) });
    }
  }
  return out;
}

type Box = [number, number, number, number];
const touches = (a: Box, b: Box) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const intersect = (a: Box, b: Box): Box | null => {
  const r: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
};
/** Connected groups of touching boxes (union-find). */
function components(boxes: Box[]): number[] {
  const parent = boxes.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  for (let a = 0; a < boxes.length; a += 1) for (let b = a + 1; b < boxes.length; b += 1) if (touches(boxes[a], boxes[b])) parent[find(a)] = find(b);
  return boxes.map((_, k) => find(k));
}

/** A transistor found in a cell's layout: its channel, type, W and L (µm), and the pin driving its gate (-1: an internal node). */
export type Channel = { type: 'n' | 'p'; box: Box; w: number; l: number; gate: number };

/**
 * The transistors of one cell, as an extractor finds them: every connected
 * patch of polysilicon over N+ or P+ diffusion. The gate's pin is traced from
 * the channel's poly through a poly contact to li1, and on to a LEF pin shape
 * that li1 touches.
 */
export function extractChannels(layers: { poly: Box[]; ndiff: Box[]; pdiff: Box[]; pcon: Box[]; li1: Box[] }, pins: Array<{ pin: number; box: Box }>, dbu: number): Channel[] {
  const polyGroup = components(layers.poly);
  const liGroup = components(layers.li1);
  // Which pin each li1 group reaches.
  const liPin = new Map<number, number>();
  layers.li1.forEach((box, k) => {
    for (const p of pins) if (overlaps(box, p.box) && !liPin.has(liGroup[k])) liPin.set(liGroup[k], p.pin);
  });
  // Which pin each poly group reaches, through its poly contacts.
  const polyPin = new Map<number, number>();
  for (const contact of layers.pcon) {
    const pk = layers.poly.findIndex((box) => overlaps(box, contact));
    const lk = layers.li1.findIndex((box) => overlaps(box, contact));
    if (pk < 0 || lk < 0) continue;
    const pin = liPin.get(liGroup[lk]);
    if (pin !== undefined && !polyPin.has(polyGroup[pk])) polyPin.set(polyGroup[pk], pin);
  }
  const out: Channel[] = [];
  for (const [type, diff] of [['n', layers.ndiff], ['p', layers.pdiff]] as const) {
    const pieces: Array<{ box: Box; poly: number }> = [];
    for (const d of diff) layers.poly.forEach((p, k) => {
      const o = intersect(d, p);
      if (o) pieces.push({ box: o, poly: polyGroup[k] });
    });
    const group = components(pieces.map((piece) => piece.box));
    const merged = new Map<number, { box: Box; poly: number }>();
    pieces.forEach((piece, k) => {
      const found = merged.get(group[k]);
      if (!found) merged.set(group[k], { box: [...piece.box], poly: piece.poly });
      else found.box = [Math.min(found.box[0], piece.box[0]), Math.min(found.box[1], piece.box[1]), Math.max(found.box[2], piece.box[2]), Math.max(found.box[3], piece.box[3])];
    });
    for (const { box, poly } of merged.values()) {
      const a = (box[2] - box[0]) / dbu;
      const b = (box[3] - box[1]) / dbu;
      out.push({ type, box, w: Math.round(Math.max(a, b) * 1000) / 1000, l: Math.round(Math.min(a, b) * 1000) / 1000, gate: polyPin.get(poly) ?? -1 });
    }
  }
  return out;
}

// ------------------------------------------------------------- I/O buses

export type IoBus = { name: string; dir: string; count: number; side: 'north' | 'south' | 'east' | 'west'; from: number; to: number; layers: string[] };

/** I/O pins grouped by bus (the name before its bit index), with the edge they sit on and their span along it (DBU). */
export function ioBusesOf(pins: Array<{ name: string; direction: string; use: string; rects: Array<{ layer: string; x0: number; y0: number; x1: number; y1: number }> }>, die: [number, number, number, number]): IoBus[] {
  const [x0, y0, x1, y1] = die;
  const groups = new Map<string, IoBus>();
  for (const pin of pins) {
    if (pin.use === 'POWER' || pin.use === 'GROUND' || pin.rects.length === 0) continue;
    const r = pin.rects[0];
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const distances: Array<[IoBus['side'], number]> = [['west', cx - x0], ['east', x1 - cx], ['south', cy - y0], ['north', y1 - cy]];
    const side = distances.sort((a, b) => a[1] - b[1])[0][0];
    const along = side === 'west' || side === 'east' ? cy : cx;
    const name = pin.name.replace(/\\/g, '').replace(/\[\d+\]$/, '');
    const key = `${name}|${side}`;
    const bus = groups.get(key);
    if (!bus) groups.set(key, { name, dir: pin.direction.toLowerCase(), count: 1, side, from: along, to: along, layers: [r.layer] });
    else {
      bus.count += 1;
      bus.from = Math.min(bus.from, along);
      bus.to = Math.max(bus.to, along);
      if (!bus.layers.includes(r.layer)) bus.layers.push(r.layer);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ clock tree

export type ClockNode = { inst: number; parent: number; flops: number; level: number };

/**
 * The clock tree: every component that drives a clock net, linked to the
 * component driving its own clock input (parent -1: the clk pin), with how
 * many flip-flops it clocks directly.
 */
export function clockTreeOf(input: { clockNets: number[]; driver: Int32Array; sinks: (net: number) => number[]; isFlop: (inst: number) => boolean; inputNet: (inst: number) => number }): ClockNode[] {
  const drivers = new Set<number>();
  for (const net of input.clockNets) if (input.driver[net] >= 0) drivers.add(input.driver[net]);
  const index = new Map<number, number>();
  const nodes: ClockNode[] = [...drivers].map((inst, k) => {
    index.set(inst, k);
    return { inst, parent: -1, flops: 0, level: 0 };
  });
  for (const node of nodes) {
    const up = input.inputNet(node.inst);
    const d = up >= 0 ? input.driver[up] : -1;
    node.parent = d >= 0 && index.has(d) ? index.get(d)! : -1;
  }
  for (const net of input.clockNets) {
    const d = input.driver[net];
    if (d < 0 || !index.has(d)) continue;
    nodes[index.get(d)!].flops += input.sinks(net).filter((sink) => input.isFlop(sink)).length;
  }
  // Depth from the root, for drawing the tree level by level.
  const depth = (k: number, guard = 0): number => (nodes[k].parent < 0 || guard > 64 ? 0 : 1 + depth(nodes[k].parent, guard + 1));
  for (let k = 0; k < nodes.length; k += 1) nodes[k].level = depth(k);
  return nodes;
}
