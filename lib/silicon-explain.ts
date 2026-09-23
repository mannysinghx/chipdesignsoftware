// What each structure in the Silicon macro view does, what it connects to,
// and how it is made. Shown in the selection panel when a part is clicked.
//
// The fabrication steps describe the standard industrial processes for an
// advanced FinFET logic node with backside power, 2.5D packaging, and HBM
// (replacement metal gate, dual-damascene copper, via-middle TSVs, copper
// pillar microbumps, CoWoS-class interposers). They explain how such a part
// is built in general; the view itself is illustrative, not a process record.

import type { PartId } from './silicon-part-ids.ts';

export type Explanation = {
  /** What it does in the circuit. */
  does: string;
  /** What it joins, below, above, and alongside. */
  connects: string;
  /** How it is made, in process order. */
  made: string[];
};

// ------------------------------------------------------------ shared steps

const FIN: string[] = [
  'Fin lines are drawn at a relaxed pitch by lithography, then self-aligned quadruple patterning (spacers deposited on a mandrel, twice) quarters the pitch to about 27 nm.',
  'Reactive-ion etching cuts the pattern into the silicon wafer, leaving ridges about 50 nm tall and 7 nm wide.',
  'Shallow-trench-isolation oxide fills the spaces, is polished flat (CMP), and is recessed so only the top of each fin stands proud.',
  'Well implants and anneals set the NMOS (p-type) and PMOS (n-type) regions under the fins.',
];

const GATE: string[] = [
  'A sacrificial polysilicon "dummy" gate is patterned across the fins and wrapped in silicon-nitride spacers that set the gate length (about 16 nm).',
  'After the source/drain epitaxy is grown and the gaps are filled with dielectric and polished, the polysilicon is etched out, leaving a trench over the fins (replacement metal gate).',
  'Atomic-layer deposition lines the trench with a thin interfacial oxide and a hafnium-oxide high-k dielectric, then work-function metals (TiN, TiAl) tuned separately for NMOS and PMOS.',
  'Tungsten fills the rest, and chemical-mechanical polishing (CMP) planarizes it; a gate-cut etch splits gates where NMOS and PMOS must not share one.',
];

const EPI_N: string[] = [
  'The fins beside each gate are etched back (recessed) using the gate spacers as a mask.',
  'Phosphorus-doped silicon is regrown epitaxially (selective CVD) on the exposed fin, raising the source/drain above the fin top.',
  'A fast anneal activates the dopant; the raised volume lowers the contact resistance.',
];

const EPI_P: string[] = [
  'The fins beside each gate are recessed using the gate spacers as a mask.',
  'Boron-doped silicon-germanium is regrown epitaxially; the larger germanium lattice compresses the channel and speeds up holes.',
  'A fast anneal activates the dopant.',
];

const CONTACT: string[] = [
  'Contact trenches are etched through the interlayer dielectric down to the source/drain epitaxy or the gate.',
  'A titanium/titanium-nitride liner is deposited; titanium reacts with the silicon to form a low-resistance silicide.',
  'Tungsten (or cobalt/ruthenium at the smallest sizes) fills the trench by CVD, and CMP removes the excess.',
];

const LOCAL_WIRE: string[] = [
  'A low-k dielectric (carbon-doped oxide) is deposited over the layer below.',
  'EUV lithography, with self-aligned multi-patterning at the tightest pitches, prints the wire trenches (and the via holes under them).',
  'Reactive-ion etching opens trenches and via holes together (dual damascene).',
  'A barrier and liner a few atoms thick (TaN/Ta, cobalt, or ruthenium) and a copper seed are deposited, then copper is electroplated to fill everything.',
  'CMP polishes the copper back to the dielectric, leaving isolated wires; a SiCN cap seals them before the next layer.',
];

const UPPER_WIRE: string[] = [
  'A thicker low-k dielectric is deposited; wires here are wider, so 193 nm immersion lithography prints them.',
  'Trenches and the via holes beneath them are etched together (dual damascene).',
  'Barrier, copper seed, electroplated copper fill, and CMP, as on every copper layer; a dielectric cap seals the layer.',
];

const THICK_WIRE: string[] = [
  'Thick dielectric (several µm) is deposited over the upper intermediate layers.',
  'Wide trenches are patterned and etched, or copper is plated through a thick photoresist mold.',
  'Copper several micrometres thick is electroplated and polished: thick, wide lines have the low resistance power and long wires need.',
];

const VIA: string[] = [
  'The via hole is etched through the dielectric between two metal layers, in the same patterning step as the wire trench above it.',
  'Barrier, seed, and fill go in together with that wire (dual damascene), so via and wire are one piece of metal.',
  'At the lowest levels, vias are filled with tungsten, cobalt, or ruthenium, which fill tiny holes better than copper.',
];

const VIA_STACK: string[] = [
  'A stack is not built at once: each layer\'s via and landing pad is made in that layer\'s own damascene steps.',
  'The layout places a via and a pad at the same spot on every layer it passes, so they line up into one vertical column.',
  'Redundant or larger vias are used where current is high, to limit electromigration.',
];

const BURIED_RAIL: string[] = [
  'Before the transistors are built, a trench is etched between the cell rows, through the isolation oxide into the silicon.',
  'It is lined with an insulator and filled with a refractory metal (ruthenium or tungsten) that survives the later high-temperature front-end steps, then recessed below the fin tops.',
  'The transistors are then built above it; short vias later connect it to the source contacts.',
];

const BACKSIDE: string[] = [
  'After the front side is finished, the wafer is bonded face-down onto a carrier wafer.',
  'The original substrate is ground and etched away until only a thin layer of silicon remains under the transistors.',
  'Nano-TSVs are etched from the back onto the buried power rails and filled with metal; a backside metal network and its bumps are built on top by damascene steps.',
];

const DEEP_TRENCH: string[] = [
  'Deep reactive-ion etching cuts narrow holes microns deep into the silicon.',
  'Atomic-layer deposition lines them with a high-k dielectric: the capacitor\'s insulator.',
  'TiN or doped polysilicon fills the hole as one plate; the doped silicon around it is the other; a strap on M1 ties the tops to the supply.',
];

const TSV: string[] = [
  'After the transistors (via-middle), a hole about 5 µm wide and 60 µm deep is etched with the Bosch deep-etch process, which alternates etching and sidewall passivation.',
  'An oxide liner insulates it from the silicon, then a tantalum barrier and copper seed are sputtered.',
  'Copper is electroplated bottom-up to fill it, annealed, and polished.',
  'Later the wafer is thinned from the back until the copper is exposed, so the via runs clean through.',
];

const BUMP: string[] = [
  'A titanium/copper seed is sputtered over the passivated wafer and covered with thick photoresist that has openings over each pad.',
  'Copper is electroplated into each opening to form a pillar, then nickel and a tin-silver solder cap are plated on top.',
  'The resist and the exposed seed are stripped, and a reflow melts the cap into a dome.',
  'At assembly the die is flipped onto the interposer and the caps are soldered (thermocompression or mass reflow), then underfill epoxy fills the gaps.',
];

const PAD: string[] = [
  'The last copper layer is capped with a passivation stack (silicon nitride and oxide).',
  'Openings are etched through the passivation over each pad location.',
  'Aluminium (or a copper pad finish) is deposited and patterned, and the under-bump metallization is plated for the bump that will sit on it.',
];

const LOGIC_BLOCK: string[] = [
  'Architects describe the block in RTL (Verilog or SystemVerilog), which is verified by simulation and formal proofs.',
  'Logic synthesis maps it onto a standard-cell library (gates, flip-flops, adders).',
  'Place-and-route tools place millions of cells in rows and route every net on M0 to the upper layers, then timing, power, and design-rule sign-off checks follow.',
  'The layout is made on the wafer by the same front-end (transistors) and back-end (metal) steps as the rest of the die.',
];

const SRAM_BLOCK: string[] = [
  'A memory compiler generates the macro from a foundry-qualified bitcell: a dense, hand-optimized 6-transistor layout.',
  'Bitcells are tiled into arrays with word-line drivers, sense amplifiers, and I/O placed around them.',
  'The arrays are built by the same front-end and metal steps as logic, with SRAM-specific design rules.',
];

// ------------------------------------------------------------ per part

export const EXPLAIN: Record<PartId, Explanation> = {
  // Front end and contacts
  fin: {
    does: 'The channel of a FinFET transistor. Current flows along the fin from source to drain when the gate wrapped over it turns the transistor on.',
    connects: 'The gate crosses over it; raised source/drain epitaxy grows on it either side of each gate. It carries no wiring of its own.',
    made: FIN,
  },
  gate: {
    does: 'Switches the transistor: a voltage on the gate turns on the channel in every fin it crosses. One gate usually controls the NMOS and PMOS pair of a logic stage.',
    connects: 'Down: wraps three sides of the fins. Up: a gate contact (VG) joins it to the M0 wire of the input that drives it.',
    made: GATE,
  },
  'gate-dummy': {
    does: 'Keeps the gate pitch perfectly regular at cell edges so lithography prints every gate the same; it switches nothing.',
    connects: 'Not contacted; it isolates neighbouring cells (a diffusion break).',
    made: GATE,
  },
  'gate-switching': {
    does: 'A gate shown switching: the pulse marks a signal arriving from its input net and turning the transistor pair on or off.',
    connects: 'Up: its gate contact and M0 wire lead to the cell\'s input pin; the cell output it drives lights up just after.',
    made: GATE,
  },
  'bitcell-gate': {
    does: 'A gate of a six-transistor SRAM bitcell: two pass gates connect the cell to the bit lines, and four transistors form the cross-coupled latch that holds one bit.',
    connects: 'Pass gates are driven by the word line; the latch gates are wired to each other inside the cell.',
    made: GATE,
  },
  'epi-n': {
    does: 'The source or drain of an NMOS transistor: where electrons enter and leave the channel.',
    connects: 'Grows on the fins beside a gate; a source/drain contact lands on top.',
    made: EPI_N,
  },
  'epi-p': {
    does: 'The source or drain of a PMOS transistor: where holes enter and leave the channel. The germanium strains the channel to make PMOS faster.',
    connects: 'Grows on the fins beside a gate; a source/drain contact lands on top.',
    made: EPI_P,
  },
  'contact-md': {
    does: 'Collects the current of a transistor drain (or an internal node) and lifts it to the wiring: this is where a cell\'s output leaves the transistors.',
    connects: 'Down: the NMOS and PMOS source/drain epitaxy it spans. Up: an M0 wire, then V0 to the cell\'s M1 output pin.',
    made: CONTACT,
  },
  'contact-power': {
    does: 'Ties a transistor source to its supply: VSS for the NMOS side, VDD for the PMOS side. This is where power enters each logic stage.',
    connects: 'Down: the source epitaxy, and at the cell edge a VBPR via to the buried power rail. Alongside: the M0 power rail rests on its end.',
    made: CONTACT,
  },
  'contact-vg': {
    does: 'Brings an input signal onto a gate.',
    connects: 'Down: the metal gate. Up: an M0 wire, then a V0 via to the cell\'s M1 input pin.',
    made: CONTACT,
  },
  'well-tap': {
    does: 'Holds the p-substrate at VSS and the n-well at VDD, so parasitic diodes stay off and the cell cannot latch up.',
    connects: 'Down: heavily doped silicon in the well. Up: the supply rail.',
    made: CONTACT,
  },
  vbpr: {
    does: 'Carries supply current between a buried power rail and a transistor\'s source contact.',
    connects: 'Down: the buried power rail between the rows. Up: the power source contact.',
    made: ['Etched down beside the fins through the isolation oxide onto the buried rail, after the transistors are built.', 'Lined and filled with tungsten or ruthenium together with (or just before) the source/drain contacts.'],
  },
  // Below the transistors
  bpr: {
    does: 'A VDD or VSS rail sunk below the fins. Moving the rails under the transistors frees M0 tracks for signals and shrinks cells.',
    connects: 'Up: VBPR vias to the power source contacts of both rows it borders. Down: nano-TSVs to the backside power network.',
    made: BURIED_RAIL,
  },
  'nano-tsv': {
    does: 'Delivers supply current from the backside power network up into a buried power rail.',
    connects: 'Down: a backside power rail. Up: the buried power rail.',
    made: BACKSIDE,
  },
  'backside-rail': {
    does: 'Part of the power network on the back of the thinned wafer. Power reaches the transistors from below, so signal wiring on the front side is not crowded by power straps.',
    connects: 'Up: nano-TSVs into the buried rails. Down: the backside power grid and its bumps.',
    made: BACKSIDE,
  },
  dtc: {
    does: 'A decoupling capacitor dug deep into the silicon. It stores charge right next to the logic and releases it during sudden current surges, keeping the supply steady.',
    connects: 'Top: an M1 strap to the supply rail. Sides: the surrounding silicon is its other plate.',
    made: DEEP_TRENCH,
  },
  'dtc-liner': {
    does: 'The capacitor\'s insulator: a very thin high-k film between the trench fill and the silicon.',
    connects: 'Separates the two plates of the deep-trench capacitor.',
    made: ['Deposited by atomic-layer deposition, one atomic layer at a time, so it coats the deep trench evenly from top to bottom.'],
  },
  tsv: {
    does: 'A copper via straight through the silicon: the vertical link from this die to the die stacked under it, carrying data and power.',
    connects: 'Top: a copper plug through the local layers to an M3 landing pad, then a via stack up to the semi-global layers. Bottom: a bump or hybrid bond on the stacked die.',
    made: TSV,
  },
  'tsv-liner': {
    does: 'Insulates the TSV from the silicon around it, so signals do not leak into the substrate.',
    connects: 'Wraps the TSV copper.',
    made: ['Oxide is deposited by CVD on the sidewalls right after the deep etch, before the barrier and copper.'],
  },
  // Local interconnect
  'm0-rail': {
    does: 'Front-side supply rail along a cell-row boundary, shared by the rows above and below: VSS below even rows, VDD below odd rows.',
    connects: 'Down: the ends of the power source contacts. Up: power via ladders from the Mx4 straps land on it through V0.',
    made: LOCAL_WIRE,
  },
  'm0-wire': {
    does: 'The lowest wiring layer, inside a standard cell: it joins transistor contacts to each other and to the cell\'s pins.',
    connects: 'Down: gate contacts (inputs) and drain contacts (outputs). Up: V0 vias to the M1 pins.',
    made: LOCAL_WIRE,
  },
  'decap-plate': {
    does: 'Plate of a decoupling-capacitor cell: gate-oxide capacitance between VDD and VSS placed in the gaps between logic.',
    connects: 'Joins the capacitor transistors to the supply rails.',
    made: LOCAL_WIRE,
  },
  'sram-supply': {
    does: 'Brings VDD and VSS along a row of SRAM bitcells to the latches that hold the bits.',
    connects: 'Down: the bitcells\' supply contacts. At the array edge: the SRAM power ring.',
    made: LOCAL_WIRE,
  },
  v0: {
    does: 'Links M0 to M1: at inputs the signal comes down it from the pin; at outputs it rises from the drains to the pin.',
    connects: 'Down: an M0 wire. Up: an M1 pin.',
    made: VIA,
  },
  'bitcell-via': {
    does: 'Stacked vias that connect an SRAM bitcell to its bit lines and word line.',
    connects: 'Down: the bitcell contacts. Up: the bit lines on M1 and the word line on M2.',
    made: VIA,
  },
  'm1-pin': {
    does: 'An input pin of a standard cell: the point where routing delivers a signal into the cell.',
    connects: 'Up: a V1 via from the M2 wire of the net that drives it. Down: V0, an M0 wire, and a gate contact onto the gate it switches.',
    made: LOCAL_WIRE,
  },
  'm1-out': {
    does: 'The output pin of a standard cell: it joins the NMOS and PMOS drains so the cell can pull its output high or low.',
    connects: 'Down: V0 onto the M0 wire over the drain contact. Up: V1 vias into every net the cell drives.',
    made: LOCAL_WIRE,
  },
  'bit-line': {
    does: 'Complementary column lines (BL and BLB) of an SRAM array: a read lets one of them discharge; a write forces the new value onto both.',
    connects: 'Down: the pass-gate contacts of every bitcell in the column. At the array edge: the sense amplifier and write driver.',
    made: LOCAL_WIRE,
  },
  'dtc-strap': {
    does: 'Ties the tops of many deep-trench capacitors together and to the supply.',
    connects: 'Down: the trench capacitor fills. Along: the supply network of the power-delivery band.',
    made: LOCAL_WIRE,
  },
  v1: {
    does: 'Links a cell pin on M1 to the routing on M2: every net enters or leaves a cell through a V1.',
    connects: 'Down: an M1 pin. Up: an M2 wire.',
    made: VIA,
  },
  m2: {
    does: 'Carries a signal along a cell row, from the output pin of one cell to the input pins of the cells it drives.',
    connects: 'Down: a V1 via onto each pin of its net. Up: V2 vias to M3 where the net leaves the row.',
    made: LOCAL_WIRE,
  },
  'word-line': {
    does: 'SRAM row line: raising it opens the pass gates of a whole row of bitcells for a read or write.',
    connects: 'Down: the pass gates of the row. At the array edge: the word-line driver.',
    made: LOCAL_WIRE,
  },
  v2: {
    does: 'Links M2 and M3: a net climbs through it to change direction and cross into another row.',
    connects: 'Down: an M2 wire. Up: an M3 wire or landing pad.',
    made: VIA,
  },
  m3: {
    does: 'Carries a signal across cell rows, joining a driver in one row to the cells it drives in the next.',
    connects: 'Down: V2 vias to the M2 wires in each row.',
    made: LOCAL_WIRE,
  },
  'm3-pad': {
    does: 'Landing pad where a via stack from the intermediate layers reaches the local wiring: here a long route begins or ends at a cell.',
    connects: 'Up: the V3 via stack to an Mx route. Down: V2 onto an M2 wire leading to a cell pin.',
    made: LOCAL_WIRE,
  },
  'ladder-pad': {
    does: 'Landing pad on a local layer for a power via ladder on its way from the Mx4 straps down to an M0 rail.',
    connects: 'Above and below: the vias of the ladder.',
    made: VIA_STACK,
  },
  'tsv-plug': {
    does: 'Carries the TSV up through the transistor and local wiring levels.',
    connects: 'Down: the TSV. Up: the M3 landing pad.',
    made: LOCAL_WIRE,
  },
  'tsv-landing': {
    does: 'The pad where a TSV meets the metal stack.',
    connects: 'Down: the TSV plug. Up: the via stack to the semi-global straps.',
    made: LOCAL_WIRE,
  },
  v3: {
    does: 'A stack of vias through the thin upper local layers (M4 to M7 on a real die, not drawn here) that links an intermediate route to the cells.',
    connects: 'Down: an M3 landing pad. Up: the end of an Mx1, Mx2, or Mx3 route, and any route it passes on the way.',
    made: VIA_STACK,
  },
  'clock-net': {
    does: 'Distributes the clock locally: from a clock buffer to the clock pins of the flip-flops around it, so they all capture data on the same edge.',
    connects: 'Down: V1 onto the buffer\'s output pin and every flip-flop clock pin it serves.',
    made: LOCAL_WIRE,
  },
  // Intermediate metal
  mx1: {
    does: 'Block-level routing: carries signals tens of micrometres between groups of cells, faster than chaining local wires.',
    connects: 'Down: at each end a V3 via stack to the cells. Across: Vx1 vias to Mx2 routes where nets turn.',
    made: UPPER_WIRE,
  },
  mx2: {
    does: 'Block-level routing at right angles to Mx1.',
    connects: 'Down: Vx1 to Mx1 where routes turn; at each end a via stack down to the cells. Up: Vx2 to Mx3.',
    made: UPPER_WIRE,
  },
  mx3: {
    does: 'Wider block-level routing for longer runs across a PE.',
    connects: 'Down: Vx2 to Mx2; at each end a via stack down to the cells.',
    made: UPPER_WIRE,
  },
  vx1: {
    does: 'Links crossing Mx1 and Mx2 routes of the same net, where a route turns a corner.',
    connects: 'Down: Mx1. Up: Mx2.',
    made: VIA,
  },
  vx2: {
    does: 'Links crossing Mx2 and Mx3 routes of the same net.',
    connects: 'Down: Mx2. Up: Mx3.',
    made: VIA,
  },
  vx3: {
    does: 'Carries supply current down from an Mx4 power strap.',
    connects: 'Down: the power via ladder. Up: an Mx4 strap.',
    made: VIA,
  },
  'mx-pad': {
    does: 'Landing pad where a route\'s via stack passes a lower layer.',
    connects: 'Above and below: the vias of the stack.',
    made: VIA_STACK,
  },
  'mx4-strap': {
    does: 'Local power grid over the logic, alternating VDD and VSS. It spreads current from the semi-global grid across the cells.',
    connects: 'Up: via stacks to My1 straps of the same supply. Down: power via ladders to the M0 rails.',
    made: UPPER_WIRE,
  },
  'power-ladder': {
    does: 'A column of stacked vias and pads that carries VDD or VSS from an Mx4 strap down to an M0 rail: how front-side power reaches the cells.',
    connects: 'Up: an Mx4 strap. Down: pads on M3, M2, and M1 and a V0 onto the rail.',
    made: VIA_STACK,
  },
  'bit-line-strap': {
    does: 'Parallels a long SRAM line on a thicker layer to lower its resistance, so reads and writes stay fast.',
    connects: 'Down: periodic vias to the SRAM line it straps.',
    made: UPPER_WIRE,
  },
  'global-bit-line': {
    does: 'Carries read data from the SRAM sub-arrays to the sense amplifiers and out of the macro.',
    connects: 'Down: the local bit-line multiplexers of each sub-array. Out: the macro\'s I/O.',
    made: UPPER_WIRE,
  },
  'word-line-strap': {
    does: 'Speeds up long SRAM word lines by paralleling them with a low-resistance strap.',
    connects: 'Down: periodic vias to the word line.',
    made: UPPER_WIRE,
  },
  'tsv-via-stack': {
    does: 'Carries a TSV\'s signal or supply from its landing pad up to the semi-global layers.',
    connects: 'Down: the TSV landing pad on M3. Up: a strap pad on My1.',
    made: VIA_STACK,
  },
  // Semi-global metal
  vx4: {
    does: 'Carries supply current between the semi-global straps and the Mx4 grid.',
    connects: 'Down: an Mx4 strap. Up: a My1 strap of the same supply.',
    made: VIA_STACK,
  },
  'systolic-bus': {
    does: 'Passes operands from each tensor PE to its neighbour: activations flow right along the rows and weights flow down the columns, so every multiply-accumulate unit is fed every cycle. Pulses show the data wavefronts.',
    connects: 'Down: at each end, a via stack drops between the lower layers\' tracks to a cell pin in the PE: an output register drives the line, and an input register in the next PE receives it. Alongside: the next PE in the row or column.',
    made: UPPER_WIRE,
  },
  'pe-pins': {
    does: 'Where a bus line enters or leaves a processing element: data drops down it into the PE\'s registers, or rises from the PE onto the bus.',
    connects: 'Up: the bus line. Down: through the gaps between the Mx4-Mx1 tracks to a V3 stack, an M3 pad, and a cell pin in the PE.',
    made: VIA_STACK,
  },
  'weight-bus': {
    does: 'Streams weights from a tile SRAM macro into the top of a PE column, where the systolic buses carry them on down the column.',
    connects: 'Up from: the SRAM macro\'s sense amplifiers (via stack). Down into: the top PE of the column (via stack).',
    made: UPPER_WIRE,
  },
  'activation-bus': {
    does: 'Streams activations from the tile router up a trunk on the left of the PE array and into the first PE of every row.',
    connects: 'The trunk rises from the router; each row branch taps the trunk through vias and drops into the row\'s first PE.',
    made: UPPER_WIRE,
  },
  'result-bus': {
    does: 'Drains partial sums from the bottom row of PEs into the vector unit (which applies activations and pooling) and carries results back to the router for the NoC.',
    connects: 'Rises from the bottom PEs; drops into the vector unit or the router.',
    made: UPPER_WIRE,
  },
  'semi-global-strap': {
    does: 'Tile-level power grid, alternating VDD and VSS: it carries current from the global mesh and tile rings down toward the local grids.',
    connects: 'Up: via stacks to the tile ring and global mesh. Across: Vy1 vias to crossing straps of the same supply. Down: stacks to the Mx4 straps.',
    made: UPPER_WIRE,
  },
  'strap-via': {
    does: 'Joins crossing My1 and My2 straps of the same supply, meshing them into one low-resistance grid.',
    connects: 'Down: a My1 strap. Up: a My2 strap.',
    made: VIA,
  },
  'strap-stack': {
    does: 'Feeds a VDD strap from the tile power ring above it.',
    connects: 'Up: the tile ring. Down: a My2 strap.',
    made: VIA_STACK,
  },
  'router-xbar': {
    does: 'The switch fabric inside a tile router: it steers each packet from its input port to the right output port (the tile, or north, south, east, or west).',
    connects: 'Up: NoC drops from the network lanes. Across: the tile\'s activation and result buses.',
    made: UPPER_WIRE,
  },
  'noc-drop': {
    does: 'Brings packets between a network-on-chip lane and the tile router below it.',
    connects: 'Up: a NoC lane line. Down: a router crossbar wire.',
    made: VIA_STACK,
  },
  'phy-lane': {
    does: 'A lane in the memory PHY\'s driver strip, where high-speed drivers, receivers, and training logic convert between the NoC and the HBM interface.',
    connects: 'Up: lane drops from the PHY\'s NoC bundle. Out: the driver circuits that feed the microbumps.',
    made: UPPER_WIRE,
  },
  'lane-drop': {
    does: 'Joins a line of the PHY\'s NoC bundle to its lane in the driver strip.',
    connects: 'Up: the NoC bundle line. Down: a short stub onto the lane.',
    made: VIA_STACK,
  },
  'bump-stack': {
    does: 'Carries a microbump\'s signal or supply straight down into the die, to the transmitter, receiver, or power grid beneath it.',
    connects: 'Up: the bump\'s under-bump metallization. Down: the I/O driver pad on My2.',
    made: VIA_STACK,
  },
  'io-pad': {
    does: 'Top of the I/O circuit under a microbump: the transmitter drives the HBM link from here and the receiver listens here.',
    connects: 'Up: the bump via stack. Down: the driver and receiver transistors.',
    made: UPPER_WIRE,
  },
  'io-guard': {
    does: 'Guard ring around an I/O cell: it collects stray substrate current so noisy I/O cannot disturb nearby logic.',
    connects: 'Down: substrate and well taps.',
    made: UPPER_WIRE,
  },
  'esd-finger': {
    does: 'Finger of the electrostatic-discharge protection diode: it shunts a static spike on the pad to a supply rail before it can destroy the transistors.',
    connects: 'Up: the pad via stack. Down: the diode junctions and the supply.',
    made: UPPER_WIRE,
  },
  'sram-ring': {
    does: 'Power ring around an SRAM macro that feeds its arrays and periphery evenly from all sides.',
    connects: 'Up: the semi-global straps. In: the SRAM supply lines.',
    made: UPPER_WIRE,
  },
  'sram-strap': {
    does: 'Semi-global strap over an SRAM array, carrying supply across it.',
    connects: 'Down: the array\'s supply grid. Along: the macro\'s power ring.',
    made: UPPER_WIRE,
  },
  'tsv-strap-pad': {
    does: 'Pad where a TSV\'s via stack reaches the semi-global layers.',
    connects: 'Down: the TSV via stack. Up: a TSV riser into the SRAM spine (outer columns).',
    made: UPPER_WIRE,
  },
  'tsv-riser': {
    does: 'Carries data from the stacked SRAM die, arriving through a TSV, up into the SRAM spine and the L2 banks.',
    connects: 'Down: a TSV strap pad. Up: an SRAM spine line.',
    made: VIA_STACK,
  },
  'inductor-guard': {
    does: 'Guard ring around a PLL inductor that keeps substrate noise and eddy currents away from the oscillator.',
    connects: 'Down: substrate ties.',
    made: UPPER_WIRE,
  },
  'inductor-underpass': {
    does: 'Brings the inner end of the spiral inductor out, passing under its turns on a lower layer.',
    connects: 'Up: the spiral\'s inner end. Out: the oscillator circuit.',
    made: UPPER_WIRE,
  },
  'channel-bus': {
    does: 'Long parallel wires in the channels between tiles that carry wide global signals across the array.',
    connects: 'Along the channel between tiles.',
    made: UPPER_WIRE,
  },
  'clock-spine': {
    does: 'A tile\'s clock spine: it takes the global clock from the H-tree and spreads it to the local clock buffers.',
    connects: 'Up: the global clock trunk. Down: the local clock buffers.',
    made: UPPER_WIRE,
  },
  // Global metal
  'noc-lane': {
    does: 'A link of the on-chip network: packets of data travel along it between tiles, the shared SRAM, the memory PHYs, and the host interface. Pulses are packets in flight.',
    connects: 'Horizontal links on one layer, vertical links on the next; junction vias join them where the network branches. Drops lead down into each tile router and PHY.',
    made: UPPER_WIRE,
  },
  'noc-junction': {
    does: 'Joins a horizontal and a vertical NoC link where the network branches, at a router node or a PHY entry.',
    connects: 'Down: a horizontal lane line. Up: a vertical lane line (or router/PHY link).',
    made: VIA,
  },
  'tile-ring': {
    does: 'VDD ring around a compute tile that distributes supply current evenly along the tile\'s edges.',
    connects: 'Up: ring stacks to the global mesh straps. Down: strap stacks into the tile\'s semi-global straps.',
    made: THICK_WIRE,
  },
  'ring-stack': {
    does: 'Feeds a tile power ring from a global VDD strap crossing above it.',
    connects: 'Up: a global strap (Mz1). Down: the tile ring.',
    made: VIA_STACK,
  },
  'sram-spine': {
    does: 'Data spine along the shared L2 SRAM strip that links its 48 banks, the TSV column, and the NoC.',
    connects: 'Down: spine junctions to the NoC lanes crossing the strip; TSV risers from the stacked SRAM die.',
    made: THICK_WIRE,
  },
  'spine-drop': {
    does: 'Joins the SRAM spine to a NoC lane crossing the strip, so tiles on both sides reach the L2 banks.',
    connects: 'Up: a spine line. Down: a horizontal NoC lane line.',
    made: VIA,
  },
  'global-strap': {
    does: 'The top-level power mesh, alternating VDD and VSS across the whole die. Thick, wide copper keeps the supply voltage drop (IR drop) to a few percent.',
    connects: 'Up: power bumps from the package. Across: top vias join straps of the same supply. Down: ring stacks and mesh stacks toward every tile.',
    made: THICK_WIRE,
  },
  'top-via': {
    does: 'Joins crossing global straps of the same supply into one mesh, so current can take the shortest path.',
    connects: 'Down: an Mz1 strap. Up: an Mz2 strap.',
    made: VIA,
  },
  'mesh-stack': {
    does: 'Drops supply current from the global mesh straight into a tile\'s semi-global grid.',
    connects: 'Up: a global strap (Mz1). Down: a My2 strap of the same supply.',
    made: VIA_STACK,
  },
  inductor: {
    does: 'Spiral inductor of an LC oscillator in a phase-locked loop: with a capacitor it sets the frequency of the clock that the global clock tree distributes.',
    connects: 'Inner end: an underpass on a lower layer. Outer end: the oscillator core.',
    made: THICK_WIRE,
  },
  'pad-lead': {
    does: 'Carries an I/O pad\'s signal inward to its I/O cell.',
    connects: 'Up: a via to the pad frame. Down: a via stack onto the ESD protection of the I/O cell.',
    made: THICK_WIRE,
  },
  'pad-frame': {
    does: 'Metal frame under an I/O pad that anchors it and spreads its current.',
    connects: 'Above: the pad. Below: a via to the pad lead.',
    made: THICK_WIRE,
  },
  'bond-pad': {
    does: 'External connection for the die\'s control, test, and debug I/O.',
    connects: 'Down: the pad frame, the lead, and the I/O cell\'s ESD protection and driver.',
    made: PAD,
  },
  'pad-stack': {
    does: 'Vias that carry an I/O signal from the pad to its lead, and from the lead down into its I/O cell.',
    connects: 'Top: the pad frame. Bottom: an ESD finger of the I/O cell.',
    made: VIA_STACK,
  },
  'power-bump': {
    does: 'Brings VDD or VSS from the package into the global power mesh. Thousands of these share the current of the whole die.',
    connects: 'Up: the interposer and package supply planes. Down: a global strap of its supply.',
    made: BUMP,
  },
  'clock-trunk': {
    does: 'The global clock H-tree: equal-length branches carry the PLL clock to every tile so all of them see the edge at the same moment.',
    connects: 'From the PLLs to each tile\'s clock spine.',
    made: THICK_WIRE,
  },
  // Bumps
  ubm: {
    does: 'Under-bump metallization: a solderable, diffusion-blocking pad that the bump is built on.',
    connects: 'Down: the pad or top metal (and a via stack into the die). Up: the copper pillar.',
    made: ['Titanium adhesion layer and copper seed are sputtered over the pad opening.', 'Nickel is plated as a barrier so solder cannot eat into the copper, with a thin gold or copper finish.'],
  },
  pillar: {
    does: 'Copper pillar of a microbump: the vertical link from the die to the interposer, carrying memory PHY signals (or power).',
    connects: 'Down: the under-bump metallization. Up: its solder cap, bonded to the interposer.',
    made: BUMP,
  },
  'solder-cap': {
    does: 'Tin-silver cap that melts during assembly to bond the pillar to the interposer pad.',
    connects: 'Between the copper pillar and the interposer landing pad.',
    made: BUMP,
  },
  'seal-ring': {
    does: 'A continuous wall of metal and vias around the die edge that stops saw-induced cracks and moisture from reaching the circuits.',
    connects: 'Every metal and via layer, stacked unbroken; tied to ground.',
    made: ['Built by the same damascene steps as every metal layer: each layer adds a ring of metal and a ring-shaped via, so they stack into one wall.', 'The die is later sawn from the wafer outside it.'],
  },
  // Package
  'die-surface': {
    does: 'The top of the accelerator die seen from afar: tiles, SRAM, PHYs, and power mesh in one view. Zoom in to see the actual wiring and transistors.',
    connects: 'Everything below it.',
    made: LOGIC_BLOCK,
  },
  'die-top': {
    does: 'The bulk silicon the transistors are built in, with isolation oxide between devices.',
    connects: 'Fins rise from it; deep trenches and TSVs go down into it.',
    made: ['A 300 mm single-crystal silicon wafer, grown by the Czochralski process, sliced, and polished.', 'Front-end steps build the transistors in its top layer; the back is later thinned.'],
  },
  die: {
    does: 'The AI accelerator: 30 compute tiles of systolic tensor PEs, a shared L2 SRAM strip, 8 memory PHYs to the HBM stacks, and the NoC that ties them together.',
    connects: 'Microbumps down to the interposer, and through it to the HBM stacks and the package.',
    made: ['Front end (FEOL): fins, gates, source/drain, and contacts are built into the wafer surface, hundreds of process steps.', 'Back end (BEOL): a dozen or more copper layers are added one by one by dual damascene.', 'Bumps are plated, the wafer is tested, thinned, and diced, and good dies are flip-chip bonded onto the interposer.'],
  },
  'die-section': {
    does: 'Bulk silicon under the transistors, shown cut open.',
    connects: 'TSVs and deep trenches run through it.',
    made: ['Thinned from the back after the front side is finished, to shorten the TSVs and help heat escape.'],
  },
  interposer: {
    does: 'A slab of silicon with very fine wiring that sits under the accelerator and the HBM stacks, connecting them with thousands of short, dense wires no organic package could hold.',
    connects: 'Up: microbumps of the die and stacks. Inside: RDL wiring and TSVs. Down: C4 bumps to the package substrate.',
    made: ['A silicon wafer gets TSVs (deep etch, oxide liner, copper fill), then several copper redistribution layers by damascene steps.', 'Dies and HBM stacks are bonded on top (chip-on-wafer), the wafer is thinned to expose the TSVs, C4 bumps are added, and it is diced and mounted on the substrate.'],
  },
  'rdl-trace': {
    does: 'Carries a memory channel between a die PHY and its HBM stack: short, dense, parallel wires on the interposer.',
    connects: 'Each end: microbumps up into the accelerator PHY and the HBM base die.',
    made: ['Patterned in the interposer\'s redistribution layers by the same damascene or semi-additive copper steps as on-die metal, at micrometre pitch.'],
  },
  'interposer-tsv': {
    does: 'Carries power and board-facing signals vertically through the interposer.',
    connects: 'Up: the RDL. Down: a C4 bump.',
    made: TSV,
  },
  hbm: {
    does: 'High-bandwidth memory: a stack of DRAM dies on a logic base die, joined by thousands of TSVs, feeding the accelerator through a very wide interface.',
    connects: 'Down: microbumps onto the interposer; interposer wiring to its accelerator PHY.',
    made: ['DRAM wafers are made by a memory process and given TSVs.', 'Dies are thinned to tens of micrometres and stacked on the base die with microbumps or hybrid bonding, then molded.', 'The finished stack is tested and bonded onto the interposer next to the accelerator.'],
  },
  substrate: {
    does: 'Organic package substrate: fans the interposer\'s connections out to the coarse pitch of the circuit board and carries power planes.',
    connects: 'Up: C4 bumps from the interposer. Down: BGA balls to the board. Inside: many copper layers with microvias.',
    made: ['A glass-fibre core gets plated through-holes.', 'Build-up film layers are laminated on both sides; laser-drilled microvias and semi-additive copper plating form each wiring layer.', 'Solder mask and surface finish are added, then the pads are bumped.'],
  },
  'c4-bump': {
    does: 'Solder bump joining the interposer to the package substrate, carrying power, ground, and board-facing signals.',
    connects: 'Up: an interposer TSV. Down: a substrate pad.',
    made: BUMP,
  },
  capacitor: {
    does: 'Ceramic decoupling capacitor near the die that smooths supply noise at frequencies the on-die capacitors cannot.',
    connects: 'Its two end terminals solder to the substrate\'s VDD and VSS planes.',
    made: ['Hundreds of thin ceramic (barium titanate) layers alternate with nickel electrodes, are co-fired, then terminated with plated end caps (MLCC).'],
  },
  bga: {
    does: 'Solder ball joining the package to the circuit board: power, ground, and I/O all cross here.',
    connects: 'Up: a substrate pad. Down: the board.',
    made: ['Tin-silver-copper solder spheres are placed on the substrate pads with flux and reflowed to bond.'],
  },
  metal: {
    does: 'Interconnect metal: part of the wiring stack that carries signals and power between the transistors and the bumps.',
    connects: 'Vias to the layers above and below it.',
    made: LOCAL_WIRE,
  },
};

// ------------------------------------------------------------ regions and cells

const CELL_WORDS: Record<string, string> = {
  INV: 'Inverts its input: one NMOS/PMOS pair.',
  BUF: 'Two inverters in a row: it restores a weak signal and drives long wires or many loads (here it also drives the local clock).',
  NAND2: 'Outputs 0 only when both inputs are 1: two NMOS in series, two PMOS in parallel.',
  NOR2: 'Outputs 1 only when both inputs are 0: two NMOS in parallel, two PMOS in series.',
  NAND3: 'Three-input NAND.',
  AOI21: 'AND-OR-invert: computes NOT((A1 AND A2) OR B) in a single stage.',
  OAI22: 'OR-AND-invert: computes NOT((A1 OR A2) AND (B1 OR B2)) in a single stage.',
  XOR2: 'Outputs 1 when its inputs differ: the heart of adders and comparators.',
  MUX2: 'Selects input A or B according to S.',
  FA: 'Full adder: adds bits A, B, and a carry-in to give a sum (S) and a carry-out (CO); chains of them add numbers in the multipliers.',
  DFF: 'D flip-flop: captures D on each rising clock edge and holds it for a cycle; the pipeline registers of every PE are made of these.',
  DECAP: 'Decoupling capacitor: gate-oxide capacitance between VDD and VSS that steadies the supply.',
};

/** Explanation for a floorplan region label or a standard cell label, by its id and title. */
export function explainRegion(id: string, title: string): Explanation | null {
  if (id.startsWith('cell-')) {
    const type = title.split(' ')[0];
    return {
      does: CELL_WORDS[type] ?? 'A standard cell: a pre-designed logic gate from the library.',
      connects: 'Input pins and the output pin on M1; V1 vias join them to the M2/M3 nets that link it to other cells. Its sources tie to the VDD and VSS rails at the row edges.',
      made: ['Designed once for the library as a fixed layout of fins, gates, contacts, and M0 wires, then characterized for delay and power at every corner.', 'Placed in rows by the place-and-route tools and built by the same front-end and metal steps as the rest of the die.'],
    };
  }
  if (id === 'sram-strip') return { does: 'The shared L2 memory: 48 SRAM banks either side of a TSV column that reaches a stacked SRAM die. Every tile reads and writes it through the NoC.', connects: 'The SRAM spine links its banks; spine junctions join the NoC lanes crossing it; TSV risers bring in the stacked die.', made: SRAM_BLOCK };
  if (id.startsWith('phy-')) return { does: 'A memory PHY: 1,024 lanes of drivers and receivers that talk to one HBM stack, with training logic that aligns every lane\'s timing.', connects: 'Microbumps down to the interposer wiring toward its stack; a NoC bundle into the on-chip network.', made: ['Mixed-signal circuits (drivers, receivers, delay lines, PLL) laid out largely by hand, plus synthesized training and control logic.', 'Built with the rest of the die; its microbumps are plated with the die\'s bumps.'] };
  if (id.startsWith('block-')) return { does: title.includes('Clock') ? 'Generates the chip\'s clocks with LC phase-locked loops and sends them out on the global clock tree.' : title.includes('SerDes') ? 'High-speed serial links to other accelerators: each lane serializes wide on-chip data onto a pair of wires at tens of Gb/s.' : title.includes('Host') ? 'Connects the accelerator to the host processor and runs the management core that boots and monitors the chip.' : 'Debug, design-for-test scan control, and telemetry sensors (temperature, voltage).', connects: 'The NoC edge lanes and the I/O ring.', made: LOGIC_BLOCK };
  if (id.startsWith('tile-')) return { does: 'A compute tile: a 16 × 12 systolic array of tensor PEs that performs matrix multiplies, with four SRAM macros for weights, a router onto the NoC, and a vector unit for everything that is not a matrix multiply.', connects: 'Its router joins the NoC; weight buses feed the array from the SRAM; activation and result buses link the router, the array, and the vector unit.', made: LOGIC_BLOCK };
  if (id.startsWith('pe-array')) return { does: 'The systolic array: 192 multiply-accumulate PEs in a grid. Weights flow down the columns, activations flow across the rows, and each PE multiplies, adds, and passes its operands on, so data is reused without going back to memory.', connects: 'Systolic buses between neighbours; weight feeds from the SRAM at the top; activation feeds on the left; result drains at the bottom.', made: LOGIC_BLOCK };
  if (id.includes('-sram-')) return { does: 'A tile SRAM macro: fast local scratchpad holding the weights the PE array is working on.', connects: 'Weight buses from its sense amplifiers down into the PE columns under it; the router fills it from the NoC.', made: SRAM_BLOCK };
  if (id.startsWith('router-')) return { does: 'The tile\'s network-on-chip router: it moves packets between the tile and its neighbours in the mesh.', connects: 'NoC drops from the lane above; activation feed up into the array; results back from the vector unit.', made: LOGIC_BLOCK };
  if (id.startsWith('vector-')) return { does: 'The vector and control unit: activation functions, normalization, pooling, and the tile sequencer that orchestrates the array.', connects: 'Result drains from the array above; results out to the router.', made: LOGIC_BLOCK };
  if (id.startsWith('pe-')) return { does: 'One tensor processing element: a multiply-accumulate datapath built from adders and multipliers in standard cells, with pipeline flip-flops.', connects: 'Systolic buses in from the left and above, out to the right and below, each through via stacks into its datapath.', made: LOGIC_BLOCK };
  if (id.startsWith('rf-')) return { does: 'The PE\'s register file: a small, fast SRAM that holds operands and partial sums close to the multiplier.', connects: 'Read and write ports into the PE datapath.', made: SRAM_BLOCK };
  if (id === 'tsv-column') return { does: 'A column of through-silicon vias to a 3D-stacked SRAM die underneath, adding capacity to the L2.', connects: 'TSV via stacks up to strap pads, and risers into the SRAM spine.', made: TSV };
  return null;
}
