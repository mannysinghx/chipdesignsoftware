export type ReferenceMacro = {
  id: string;
  label: string;
  referencePattern: string;
  aimemRole: string;
  domain: 'main' | 'always-on';
  x: number;
  z: number;
  width: number;
  depth: number;
};

export const OPEN_TITAN_REFERENCE = {
  name: 'OpenTitan Earl Grey',
  top: 'chip_earlgrey_asic',
  licenseClass: 'open-source hardware reference',
  powerDomains: ['Main', 'Always-on'],
  clocks: ['sys', 'io', 'usb', 'aon'],
  busLevels: 2,
  asicPadCount: 71,
  ioBanks: 4,
  memoryMacros: ['192 KiB boot ROM', '2 MiB RRAM'],
  processStackReference: ['li1', 'met1', 'met2', 'met3', 'met4', 'met5', 'rdl', 'bump'],
  sources: [
    'https://opentitan.org/book/hw/top_earlgrey/doc/design/index.html',
    'https://opentitan.org/book/hw/top_earlgrey/ip_autogen/pinmux/doc/targets.html',
    'https://skywater-pdk.readthedocs.io/en/main/rules/summary.html',
    'https://skywater-pdk.readthedocs.io/en/main/rules/rcx.html',
  ],
} as const;

// Physical organization patterns are adapted to AIMEM functions. These are not
// claims that Earl Grey contains AIMEM blocks or that this is either chip's GDS.
export const AIMEM_REFERENCE_MACROS: ReferenceMacro[] = [
  { id: 'command', label: 'Command processor', referencePattern: 'processor island', aimemRole: 'Host commands and firmware sequencing', domain: 'main', x: -1.75, z: -1.35, width: 1.35, depth: 1.05 },
  { id: 'sram-a', label: 'SRAM bank A', referencePattern: 'memory macro', aimemRole: 'Scheduling and metadata SRAM', domain: 'main', x: -0.2, z: -1.45, width: 1.45, depth: 0.85 },
  { id: 'sram-b', label: 'SRAM bank B', referencePattern: 'memory macro', aimemRole: 'Gather and buffering SRAM', domain: 'main', x: 1.45, z: -1.45, width: 1.4, depth: 0.85 },
  { id: 'xbar-fast', label: 'High-speed NoC', referencePattern: 'high-speed bus cluster', aimemRole: 'Memory traffic crossbar and DMA fabric', domain: 'main', x: -0.9, z: 0.15, width: 2.35, depth: 0.72 },
  { id: 'xbar-slow', label: 'Control NoC', referencePattern: 'low-speed bus cluster', aimemRole: 'Telemetry, configuration, and service fabric', domain: 'always-on', x: 1.55, z: 0.1, width: 1.05, depth: 0.7 },
  { id: 'ecc', label: 'ECC + repair', referencePattern: 'security accelerator island', aimemRole: 'SECDED, lane repair, and fault containment', domain: 'main', x: -1.75, z: 1.35, width: 1.35, depth: 0.95 },
  { id: 'clock', label: 'Clock / reset', referencePattern: 'clock and reset manager', aimemRole: 'Clock trees, reset distribution, and power sequencing', domain: 'always-on', x: -0.15, z: 1.38, width: 1.25, depth: 0.9 },
  { id: 'telemetry', label: 'Telemetry + safety', referencePattern: 'always-on controller island', aimemRole: 'Sensors, watchdogs, logs, and safe-state control', domain: 'always-on', x: 1.45, z: 1.35, width: 1.4, depth: 0.95 },
];

export const SKY130_VISUAL_LAYERS = [
  { id: 'li1', direction: 'horizontal', role: 'Local cell interconnect' },
  { id: 'met1', direction: 'vertical', role: 'Standard-cell routing' },
  { id: 'met2', direction: 'horizontal', role: 'Local signal routing' },
  { id: 'met3', direction: 'vertical', role: 'Block-level signal routing' },
  { id: 'met4', direction: 'horizontal', role: 'Global clock and signal routing' },
  { id: 'met5', direction: 'mesh', role: 'Power distribution and global straps' },
] as const;
