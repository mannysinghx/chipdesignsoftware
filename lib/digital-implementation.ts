export type DigitalReviewScope = 'current' | 'regression' | 'closure';
export type DigitalCheckStatus = 'pass' | 'provisional' | 'planned';

export type DigitalEvidence = {
  tool: string;
  top: string;
  channels: number;
  status: string;
  formal_proofs: number;
  cells: number;
  wires: number;
  wire_bits: number;
  checks: string[];
  limitations: string[];
};

export const DIGITAL_MODULES = [
  {
    id: 'top', name: 'aimem_t0_top', role: 'Sixteen-channel composition', lines: 86,
    inputs: '16 command lanes · write data · fault masks · gather descriptor',
    outputs: 'Responses · repair maps · refresh urgency · controller liveness',
    contains: '16 channel controllers · 16 lane-repair blocks · one sparse-gather engine',
    evidence: 'Hierarchy elaborated and generic synthesis completed',
  },
  {
    id: 'channel', name: 'aimem_t0_channel', role: 'Bank and refresh controller', lines: 142,
    inputs: 'Command · bank · row · write data · injected fault mask',
    outputs: 'Response · ECC status · refresh urgency · liveness',
    contains: 'IDLE → ACTIVATE → ACCESS → RESPOND plus priority REFRESH',
    evidence: '32-cycle bounded safety proof and public-PDK cell mapping',
  },
  {
    id: 'ecc', name: 'aimem_secded_64', role: '72/64 SECDED datapath', lines: 79,
    inputs: '64-bit payload or 72-bit protected word',
    outputs: 'Protected codeword · corrected payload · syndrome · error class',
    contains: 'Hamming parity generation · overall parity · correction and detection',
    evidence: 'All 72 symbolic single-bit positions proven correct',
  },
  {
    id: 'gather', name: 'aimem_sparse_gather', role: 'Strided address generator', lines: 46,
    inputs: '48-bit base · 16-bit stride · element count · ready/valid',
    outputs: 'Address stream · last marker · busy state',
    contains: 'Descriptor capture · backpressure-safe iterative address generation',
    evidence: 'Reference-model tests pass; long randomized RTL regression remains planned',
  },
  {
    id: 'repair', name: 'aimem_lane_repair', role: 'Two-spare repair mapper', lines: 33,
    inputs: '64-bit failed-lane mask',
    outputs: '448-bit remap table · repairable flag · failure count',
    contains: 'Identity map with deterministic allocation of two spare lanes',
    evidence: 'Reference-model fault campaign passes; randomized RTL closure remains planned',
  },
] as const;

const BASE_CHECKS = [
  ['parse', 'SystemVerilog parse', 'pass', 'YoWASP Yosys', 'All five RTL modules parse as SystemVerilog.'],
  ['elaborate', 'Sixteen-channel elaboration', 'pass', 'YoWASP Yosys', 'aimem_t0_top elaborates with 16 controller and repair slices.'],
  ['synthesis', 'Generic synthesis', 'pass', 'YoWASP Yosys', 'Processes and memories lower to a generic structural netlist.'],
  ['controller-proof', 'Controller safety proof', 'pass', 'Yosys SAT', 'Refresh priority and controller progress hold for the declared 32-cycle bound.'],
  ['ecc-proof', 'SECDED correction proof', 'pass', 'Yosys SAT', 'Every symbolic single-bit position in the 72-bit word preserves the payload.'],
  ['fault-regression', 'ECC fault regression', 'provisional', 'Node reference model', 'Single and double-bit campaigns pass in the executable model, not yet a long RTL simulation.'],
  ['gather-regression', 'Gather backpressure regression', 'planned', 'Verilator + cocotb', 'Random stalls, descriptor overlap, zero count, and boundary addresses need RTL coverage.'],
  ['repair-regression', 'Lane-repair regression', 'planned', 'Verilator + cocotb', 'Exhaustive one/two-lane faults and sampled unrepairable masks need RTL coverage.'],
  ['datapath', 'Complete memory datapath', 'planned', 'RTL + memory model', 'Read/write storage behavior, queues, arbitration, and end-to-end completion are not integrated.'],
] as const;

const REVIEW_SCOPES = {
  current: {
    label: 'Current evidence', target: 'Reproduce the checked-in open-source evidence bundle.',
    transactions: 0, seeds: 0, proofDepth: 32, coverageTarget: 'Structural + two bounded properties',
  },
  regression: {
    label: 'Regression plan', target: 'Close randomized ECC, gather, repair, and controller protocol behavior.',
    transactions: 100000, seeds: 10000, proofDepth: 128, coverageTarget: '≥95% functional scenarios',
  },
  closure: {
    label: 'Digital closure plan', target: 'Integrate the full memory datapath and prepare independent verification review.',
    transactions: 1000000, seeds: 50000, proofDepth: 1024, coverageTarget: '≥98% functional + assertion coverage',
  },
} as const;

export function evaluateDigitalImplementation(scope: DigitalReviewScope, evidence: DigitalEvidence) {
  const review = REVIEW_SCOPES[scope];
  const checks = BASE_CHECKS.map(([id, title, status, tool, detail]) => ({
    id,
    title,
    status: status as DigitalCheckStatus,
    tool,
    detail,
  }));
  const passCount = checks.filter((check) => check.status === 'pass').length;
  const provisionalCount = checks.filter((check) => check.status === 'provisional').length;
  const plannedCount = checks.filter((check) => check.status === 'planned').length;
  const weightedReadiness = Math.round(((passCount + provisionalCount * 0.45) / checks.length) * 100);

  return {
    review,
    checks,
    passCount,
    provisionalCount,
    plannedCount,
    weightedReadiness,
    moduleCount: DIGITAL_MODULES.length,
    sourceLines: DIGITAL_MODULES.reduce((sum, module) => sum + module.lines, 0),
    evidence,
    releaseDecision: 'hold' as const,
    nextArtifact: 'Verilator + cocotb randomized regression bundle with seeds, waveforms, coverage, failures, and hashes',
  };
}
