// What each structure in the real A1 layout is: the SkyWater SKY130 layers,
// the standard cells by family, and plain-English explanations for the
// selection panel of the Silicon macro view's "A1 layout" mode.
//
// The layers, heights, cell names, pins, and connectivity are the PDK's and
// the routed design's. The "how it is made" steps describe a typical 130 nm
// aluminium-interconnect CMOS process of the kind SKY130 is; SkyWater's exact
// recipe is not part of the open PDK, so no step claims more than that.

import type { CellClass, LayerId, Purpose } from './a1-layout-format.ts';

export type Explanation = { does: string; connects: string; made: string[] };

// ------------------------------------------------------------- the steps

const FRONT_END = [
  'Shallow trenches are etched into the silicon around each active area and filled with oxide, which isolates the transistors from each other.',
  'Implants form the wells: an n-well under the PMOS transistors; the p-type substrate serves the NMOS transistors.',
  'A thin gate oxide is grown, then polysilicon is deposited and patterned into gates.',
  'N+ and P+ implants dope the diffusion on either side of each gate, self-aligned to it; an anneal activates them and a silicide lowers their resistance.',
];
const CONTACTS = [
  'Oxide is deposited over the transistors and polished flat.',
  'Contact holes are etched down to the diffusion and the polysilicon.',
  'The holes are filled with metal and the excess is polished off, leaving a plug in each hole.',
];
const LOCAL = [
  'The local interconnect is deposited as a thin film directly on the contact plugs.',
  'Lithography and etching pattern it into the short links inside each cell: the cell pins and the connections between its transistors.',
];
const METAL = [
  'An aluminium-alloy film, with thin barrier layers above and below it, is sputtered over the whole wafer.',
  'Lithography prints the wires and a plasma etch removes the aluminium between them (a subtractive process, unlike the copper damascene of newer nodes).',
  'Oxide fills the gaps between the wires and is polished flat for the next layer.',
];
const VIA = [
  'Via holes are etched through the oxide down to the metal layer below.',
  'The holes are filled with a metal plug (tungsten is typical in aluminium processes) and polished back, ready for the metal layer above.',
];

// ---------------------------------------------------------------- layers

export type LayerText = { title: string; role: string; material: string; explain: Explanation };

export const LAYER_TEXT: Record<LayerId, LayerText> = {
  nwell: { title: 'N-well', role: 'n-type region of the substrate that the PMOS transistors are built in', material: 'Doped silicon', explain: { does: 'Holds the PMOS transistors of every cell in this half of the row; it is tied to VDD through well-tap cells so it never forward-biases.', connects: 'Runs continuously along the cell rows; reached from VDD by the n-tap diffusion of the tap cells.', made: FRONT_END.slice(0, 2) } },
  ndiff: { title: 'N+ diffusion', role: 'source and drain of NMOS transistors', material: 'Phosphorus/arsenic-doped silicon', explain: { does: 'Where a gate crosses it, this is an NMOS transistor: the gate turns the channel between the two sides on and off. NMOS pulls outputs down to ground.', connects: 'Contacts (licon) take its source to the VGND rail and its drain up to li1, where the cell output is wired.', made: FRONT_END } },
  pdiff: { title: 'P+ diffusion', role: 'source and drain of PMOS transistors', material: 'Boron-doped silicon', explain: { does: 'Where a gate crosses it, this is a PMOS transistor, built in the n-well. PMOS pulls outputs up to VDD.', connects: 'Contacts (licon) take its source to the VPWR rail and its drain up to li1.', made: FRONT_END } },
  ntap: { title: 'N-well tap', role: 'ties the n-well to VDD', material: 'N+ doped silicon', explain: { does: 'Keeps the n-well at VDD so the PMOS bodies are biased and latch-up cannot start.', connects: 'A contact and li1 join it to the VPWR rail.', made: FRONT_END } },
  ptap: { title: 'Substrate tap', role: 'ties the p-substrate to ground', material: 'P+ doped silicon', explain: { does: 'Keeps the substrate at ground under the NMOS transistors.', connects: 'A contact and li1 join it to the VGND rail.', made: FRONT_END } },
  poly: { title: 'Polysilicon', role: 'transistor gates and the short links between them', material: 'Doped polysilicon (silicided)', explain: { does: 'Each place it crosses diffusion is a transistor gate: its voltage switches that transistor. Elsewhere it links gates that share an input.', connects: 'Poly contacts (licon) connect it up to li1, where the cell inputs arrive.', made: FRONT_END } },
  licon: { title: 'Diffusion contact (licon)', role: 'joins a transistor source or drain to li1', material: 'Metal plug', explain: { does: 'Carries current between a transistor and the cell wiring.', connects: 'Diffusion below, li1 above.', made: CONTACTS } },
  pcon: { title: 'Poly contact (licon)', role: 'joins a gate to li1', material: 'Metal plug', explain: { does: 'Brings a cell input from li1 down onto a transistor gate.', connects: 'Polysilicon below, li1 above.', made: CONTACTS } },
  li1: { title: 'Local interconnect (li1)', role: 'wiring inside each standard cell, and the cell pins', material: 'Thin resistive film', explain: { does: 'Wires the transistors of a cell together and forms its pins, where the router lands.', connects: 'Contacts (licon) below; mcon contacts up to met1 above.', made: [...CONTACTS, ...LOCAL] } },
  mcon: { title: 'li1–met1 contact (mcon)', role: 'joins li1 to metal 1', material: 'Metal plug', explain: { does: 'Where the router reaches a cell pin, and where the cells\' li1 supply straps meet the met1 rails.', connects: 'li1 below, met1 above.', made: VIA } },
  met1: { title: 'Metal 1', role: 'the first routed layer (horizontal) and the supply rails', material: 'Aluminium alloy', explain: { does: 'Carries short signal routes between neighbouring cells, and the VDD/VSS rails along every row boundary.', connects: 'mcon down to li1 and the cell pins; via up to met2.', made: METAL } },
  via: { title: 'Via 1', role: 'joins met1 and met2', material: 'Metal plug', explain: { does: 'Lets a route change from horizontal met1 to vertical met2.', connects: 'met1 below, met2 above.', made: VIA } },
  met2: { title: 'Metal 2', role: 'vertical routing', material: 'Aluminium alloy', explain: { does: 'Carries routes across the rows. On this tile, met2 holds the second-largest share of the wiring.', connects: 'via down to met1, via2 up to met3.', made: METAL } },
  via2: { title: 'Via 2', role: 'joins met2 and met3', material: 'Metal plug', explain: { does: 'Lets a route change from vertical met2 to horizontal met3.', connects: 'met2 below, met3 above.', made: VIA } },
  met3: { title: 'Metal 3', role: 'longer horizontal routing', material: 'Aluminium alloy (thicker)', explain: { does: 'Carries longer routes between blocks; thicker than met1/met2, so it is less resistive.', connects: 'via2 down to met2, via3 up to met4.', made: METAL } },
  via3: { title: 'Via 3', role: 'joins met3 and met4', material: 'Metal plug', explain: { does: 'Lets a route change between met3 and met4, and carries the supply down from the met4 straps.', connects: 'met3 below, met4 above.', made: VIA } },
  met4: { title: 'Metal 4', role: 'long vertical routes and the vertical power straps', material: 'Aluminium alloy (thicker)', explain: { does: 'Carries the longest vertical routes and the VDD/VSS straps that feed the rows.', connects: 'via3 down to met3, via4 up to met5.', made: METAL } },
  via4: { title: 'Via 4', role: 'joins met4 and met5', material: 'Metal plug (large)', explain: { does: 'Joins the two top layers of the power grid where a met5 strap crosses a met4 strap of the same supply.', connects: 'met4 below, met5 above.', made: VIA } },
  met5: { title: 'Metal 5', role: 'top metal: the horizontal power straps', material: 'Aluminium alloy (thickest)', explain: { does: 'Distributes VDD and VSS across the whole tile in wide, low-resistance straps.', connects: 'via4 down to the met4 straps.', made: METAL } },
};

/** Titles for structures whose purpose matters more than their layer. */
export function shapeTitle(layer: LayerId, purpose: Purpose, supply: 'VDD' | 'VSS' | null): string {
  if (purpose === 'rail') return `${supply ?? 'Supply'} rail (met1)`;
  if (purpose === 'stripe') return `${supply ?? 'Supply'} strap (${layer})`;
  if (purpose === 'pin') return `I/O pin (${layer})`;
  if (purpose === 'patch' && supply) return `${supply} via landing (${layer})`;
  if (purpose === 'patch') return `${LAYER_TEXT[layer].title} patch`;
  if (supply) return `${supply} ${LAYER_TEXT[layer].title.toLowerCase()}`;
  return layer.startsWith('met') ? `${LAYER_TEXT[layer].title} wire` : LAYER_TEXT[layer].title;
}

// ----------------------------------------------------------------- cells

const FAMILY: Record<string, string> = {
  inv: 'inverter', buf: 'buffer', bufbuf: 'two-stage buffer', bufinv: 'buffered inverter', clkbuf: 'clock buffer', clkinv: 'clock inverter', clkinvlp: 'low-power clock inverter',
  clkdlybuf4s50: 'clock delay buffer', conb: 'constant tie cell (logic 1 and 0)', fa: 'full adder', ha: 'half adder', mux2: '2:1 multiplexer', mux2i: '2:1 multiplexer, inverting',
  mux4: '4:1 multiplexer', xor2: '2-input XOR', xnor2: '2-input XNOR', dfxtp: 'D flip-flop (rising clock)', edfxtp: 'D flip-flop with enable (rising clock)',
  diode: 'antenna diode', tapvpwrvgnd: 'well tap', fill: 'filler', decap: 'decoupling capacitor',
};

function gateFamily(base: string): string | null {
  const simple = base.match(/^(and|nand|or|nor)(\d)(b{0,2})$/);
  if (simple) {
    const [, op, n, inverted] = simple;
    return `${n}-input ${op.toUpperCase()}${inverted ? `, ${inverted.length === 1 ? 'one input' : 'two inputs'} inverted` : ''}`;
  }
  // AND-OR (a...o/oi) and OR-AND (o...a/ai): each digit is one term's input
  // count; "bb" inverts both inputs of the term before it, a trailing "b"
  // inverts the last single input (sky130 names such inputs *_N).
  const compound = base.match(/^([ao])([\db]+?)(oi|o|ai|a)$/);
  if (!compound) return null;
  const [, first, middle, out] = compound;
  const tokens = middle.match(/\d(bb)?|b/g) ?? [];
  const inner = first === 'a' ? '·' : '+';
  const outer = first === 'a' ? ' + ' : ' · ';
  const terms: string[] = [];
  let letter = 0;
  for (const token of tokens) {
    if (token === 'b') {
      if (terms.length > 0) terms[terms.length - 1] = `¬${terms[terms.length - 1]}`;
      continue;
    }
    const size = Number(token[0]);
    const name = 'ABCDE'[letter];
    letter += 1;
    const inputs = Array.from({ length: size }, (_, k) => `${token.endsWith('bb') ? '¬' : ''}${name}${k + 1}`);
    terms.push(size === 1 ? inputs[0] : `(${inputs.join(inner)})`);
  }
  if (terms.length === 0) return null;
  const inverted = out.endsWith('i');
  return `${first === 'a' ? 'AND-OR' : 'OR-AND'}${inverted ? '-invert' : ''}: ${terms.join(outer)}${inverted ? ', inverted' : ''}`;
}

export type CellText = { family: string; title: string; drive: string | null; what: string };

/** Plain description of a SkyWater sky130_fd_sc_hd cell from its name. */
export function describeCell(name: string): CellText {
  const base = name.replace(/^sky130_fd_sc_hd__/, '');
  const match = base.match(/^(.*)_(\d+)$/);
  const family = match ? match[1] : base;
  const drive = match ? match[2] : null;
  const what = FAMILY[family] ?? gateFamily(family) ?? family;
  // Physical cells carry a size in their suffix (sites wide), not a drive strength.
  const physical = family === 'fill' || family === 'decap' || family === 'tapvpwrvgnd' || family === 'diode' || family === 'conb';
  const strength = drive === null ? null : family === 'fill' || family === 'decap' ? `${drive} site${drive === '1' ? '' : 's'} wide` : physical ? null : drive === '0' ? 'minimum drive' : `drive ×${drive}`;
  return { family, title: `${family}_${drive ?? ''}`.replace(/_$/, ''), drive: strength, what };
}

export const CELL_CLASS_TEXT: Record<CellClass, { title: string; role: string; swatch: string }> = {
  logic: { title: 'Logic cell', role: 'combinational gates: adders, XORs, AND-OR-inverts, multiplexers', swatch: '#8f8ea0' },
  sequential: { title: 'Register', role: 'flip-flops holding the pipeline state', swatch: '#5b8fd6' },
  clock: { title: 'Clock-tree cell', role: 'buffers and inverters of the clock tree', swatch: '#c070e0' },
  buffer: { title: 'Buffer', role: 'repeaters inserted to drive long wires and large fan-outs', swatch: '#b09a70' },
  fill: { title: 'Filler cell', role: 'no logic: continues the wells and rails through gaps in a row', swatch: '#3a3d45' },
  tap: { title: 'Well tap', role: 'ties the n-well and substrate to the supplies', swatch: '#4a5a4f' },
  diode: { title: 'Antenna diode', role: 'protects a gate from charge collected by long wires during manufacture', swatch: '#6a6f5a' },
  decap: { title: 'Decap cell', role: 'on-chip decoupling capacitance', swatch: '#4d4a5c' },
};

export const CELL_EXPLAIN: Explanation = {
  does: 'A standard cell is a pre-designed logic gate from the SkyWater library: its transistors, contacts, and li1 wiring are fixed; the router only connects its pins.',
  connects: 'Its pins are li1 shapes; the router lands on them with an mcon contact from met1. It draws power from the met1 rails along the top and bottom of its row.',
  made: ['Built in the same process steps as every other structure: the transistors first, then contacts, li1, and the metal layers above.', 'The placer put it in a row of fixed-height sites; the filler cells were added last to close the gaps.'],
};
