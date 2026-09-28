// Streaming DEF reader for the layout exporter. It keeps what the viewer
// draws and describes: placed components, I/O pins, the power grid, and every
// routed segment and via with the net it belongs to. Wires become rectangles
// here, with the DEF extension rules applied (regular wiring extends half its
// width past each end unless the point gives an extension; special wiring is
// flush), so the viewer draws exactly the metal the router placed.

import { readFileSync } from 'node:fs';
import { ORIENTS, PURPOSE, packKind, LAYER, type LayerId } from '../../../lib/a1-layout-format.ts';

export class IntList {
  data: Int32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Int32Array(capacity);
  }
  push(value: number) {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length] = value;
    this.length += 1;
  }
  get(index: number) {
    return this.data[index];
  }
}

/** A via definition from the DEF VIAS section, generated from its rule. */
export type DefGeneratedVia = { name: string; layers: [string, string, string]; rects: Array<{ layer: string; x0: number; y0: number; x1: number; y1: number }> };

export type IoPin = { name: string; net: string; direction: string; use: string; rects: Array<{ layer: string; x0: number; y0: number; x1: number; y1: number }> };

/** Everything the exporter needs from the DEF. */
export type DefDesign = {
  design: string;
  dbu: number;
  die: [number, number, number, number];
  rows: { count: number; height: number; site: number; x0: number; y0: number; x1: number; y1: number; orient0: number };
  generatedVias: DefGeneratedVia[];
  components: { names: string[]; macro: string[]; x: Int32Array; y: Int32Array; orient: Uint8Array };
  ioPins: IoPin[];
  nets: {
    names: string[];
    use: string[];
    /** Connections: for net n, entries pinStart[n] .. pinStart[n + 1]: component index (or -1 - I/O pin index) and pin name. */
    pinStart: number[];
    pinInst: IntList;
    pinName: string[];
    ndr: Array<string | null>;
  };
  /** Rectangles: packed kind, corners, and net (-1: VDD, -2: VSS, n >= 0: net n). */
  rects: { kind: IntList; x0: IntList; y0: IntList; x1: IntList; y1: IntList; net: IntList; centerline: IntList };
  /** Vias: definition name index into viaNames, origin, and net. */
  vias: { def: IntList; x: IntList; y: IntList; net: IntList };
  viaNames: string[];
  nondefaultWidths: Map<string, Map<string, number>>;
  warnings: string[];
};

type Tokens = string[];

const ROUTING = new Set(['li1', 'met1', 'met2', 'met3', 'met4', 'met5']);

/**
 * Parse a DEF file. `defaultWidth(layer)` gives each routing layer's default
 * wire width in DBU (from the tech LEF); `viaLayers(name)` names a fixed via's
 * bottom and top routing layers, so a wire continuing after a via changes layer.
 */
export function parseDef(path: string, options: { defaultWidth: (layer: string) => number; viaLayers: (name: string) => [string, string] | null }): DefDesign {
  const text = readFileSync(path, 'latin1');
  const out: DefDesign = {
    design: '', dbu: 1000, die: [0, 0, 0, 0],
    rows: { count: 0, height: 0, site: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, orient0: 0 },
    generatedVias: [],
    components: { names: [], macro: [], x: new Int32Array(0), y: new Int32Array(0), orient: new Uint8Array(0) },
    ioPins: [],
    nets: { names: [], use: [], pinStart: [0], pinInst: new IntList(1 << 20), pinName: [], ndr: [] },
    rects: { kind: new IntList(1 << 22), x0: new IntList(1 << 22), y0: new IntList(1 << 22), x1: new IntList(1 << 22), y1: new IntList(1 << 22), net: new IntList(1 << 22), centerline: new IntList(1 << 22) },
    vias: { def: new IntList(1 << 22), x: new IntList(1 << 22), y: new IntList(1 << 22), net: new IntList(1 << 22) },
    viaNames: [],
    nondefaultWidths: new Map(),
    warnings: [],
  };
  const viaIndex = new Map<string, number>();
  const viaId = (name: string) => {
    let id = viaIndex.get(name);
    if (id === undefined) {
      id = out.viaNames.length;
      out.viaNames.push(name);
      viaIndex.set(name, id);
    }
    return id;
  };
  const generatedLayers = new Map<string, [string, string]>();
  const layersOfVia = (name: string) => generatedLayers.get(name) ?? options.viaLayers(name);

  const addRect = (layer: string, purpose: number, x0: number, y0: number, x1: number, y1: number, net: number, centerline = 0) => {
    const id = LAYER[layer as LayerId];
    if (id === undefined) return;
    const r = out.rects;
    r.kind.push(packKind(id, purpose));
    r.x0.push(Math.min(x0, x1));
    r.y0.push(Math.min(y0, y1));
    r.x1.push(Math.max(x0, x1));
    r.y1.push(Math.max(y0, y1));
    r.net.push(net);
    r.centerline.push(centerline);
  };
  const addVia = (name: string, x: number, y: number, net: number) => {
    out.vias.def.push(viaId(name));
    out.vias.x.push(x);
    out.vias.y.push(y);
    out.vias.net.push(net);
  };

  // ------------------------------------------------------------ line reader
  let position = 0;
  const nextLine = (): string | null => {
    if (position >= text.length) return null;
    let end = text.indexOf('\n', position);
    if (end < 0) end = text.length;
    const line = text.slice(position, end);
    position = end + 1;
    return line;
  };
  /** Tokens of one statement: from the current line to the terminating ';'. */
  const statement = (first: string): Tokens => {
    const tokens = first.trim().split(/\s+/).filter(Boolean);
    while (tokens.at(-1) !== ';') {
      const line = nextLine();
      if (line === null) break;
      for (const token of line.trim().split(/\s+/)) if (token) tokens.push(token);
    }
    return tokens;
  };

  // --------------------------------------------------------- wiring paths
  /**
   * Walk a routing statement (the tokens after ROUTED/FIXED/COVER/NEW) and
   * emit its rectangles and vias. `special` wiring has an explicit width per
   * statement and flush ends; regular wiring uses the layer (or NDR) width
   * and extends half the width past each point unless an extension is given.
   */
  const walkWiring = (t: Tokens, start: number, net: number, special: boolean, ndr: string | null): number => {
    let k = start;
    let layer = '';
    let width = 0;
    let purpose: number = PURPOSE.wire;
    let prev: { x: number; y: number; ext: number | null } | null = null;
    const widthFor = (name: string) => out.nondefaultWidths.get(ndr ?? '')?.get(name) ?? options.defaultWidth(name);
    const segment = (a: { x: number; y: number; ext: number | null }, b: { x: number; y: number; ext: number | null }) => {
      const half = width / 2;
      const ea = a.ext ?? (special ? 0 : half);
      const eb = b.ext ?? (special ? 0 : half);
      if (a.y === b.y && a.x !== b.x) {
        const [lo, hi, elo, ehi] = a.x < b.x ? [a.x, b.x, ea, eb] : [b.x, a.x, eb, ea];
        addRect(layer, purpose, lo - elo, a.y - half, hi + ehi, a.y + half, net, hi - lo);
      } else if (a.x === b.x && a.y !== b.y) {
        const [lo, hi, elo, ehi] = a.y < b.y ? [a.y, b.y, ea, eb] : [b.y, a.y, eb, ea];
        addRect(layer, purpose, a.x - half, lo - elo, a.x + half, hi + ehi, net, hi - lo);
      } else if (a.x === b.x && a.y === b.y) {
        if (width > 0) addRect(layer, purpose, a.x - Math.max(half, ea), a.y - Math.max(half, ea), a.x + Math.max(half, ea), a.y + Math.max(half, ea), net);
      } else out.warnings.push(`diagonal segment on ${layer} (net ${net}) ignored`);
    };
    const begin = () => {
      layer = t[k];
      k += 1;
      if (special) {
        width = Number(t[k]);
        k += 1;
      } else width = widthFor(layer);
      purpose = PURPOSE.wire;
      prev = null;
    };
    begin();
    while (k < t.length) {
      const token = t[k];
      if (token === ';') return k;
      if (token === 'NEW') {
        k += 1;
        begin();
        continue;
      }
      if (token === '+') {
        // + SHAPE x | + MASK n | + STYLE n  (special wiring); a new top-level option ends the path.
        const option = t[k + 1];
        if (option === 'SHAPE') {
          const shape = t[k + 2];
          purpose = shape === 'FOLLOWPIN' ? PURPOSE.rail : shape === 'STRIPE' || shape === 'RING' || shape === 'COREWIRE' ? (ROUTING.has(layer) && width > 0 ? PURPOSE.stripe : PURPOSE.wire) : PURPOSE.patch;
          k += 3;
          continue;
        }
        if (option === 'MASK' || option === 'STYLE') {
          k += 3;
          continue;
        }
        return k;
      }
      if (token === 'TAPER') {
        width = options.defaultWidth(layer);
        k += 1;
        continue;
      }
      if (token === 'TAPERRULE' || token === 'STYLE' || token === 'MASK') {
        k += 2;
        continue;
      }
      if (token === 'VIRTUAL') {
        // A virtual point connects without metal: restart the path there.
        k += 1;
        continue;
      }
      if (token === '(') {
        const xs = t[k + 1];
        const ys = t[k + 2];
        let j = k + 3;
        let ext: number | null = null;
        if (t[j] !== ')') {
          ext = Number(t[j]);
          j += 1;
        }
        const p: { x: number; y: number; ext: number | null } = { x: xs === '*' ? (prev as { x: number } | null)?.x ?? 0 : Number(xs), y: ys === '*' ? (prev as { y: number } | null)?.y ?? 0 : Number(ys), ext };
        k = j + 1;
        if (prev) segment(prev, p);
        prev = p;
        continue;
      }
      if (token === 'RECT') {
        // RECT ( dx0 dy0 dx1 dy1 ) relative to the previous point.
        const base = prev as { x: number; y: number } | null;
        const [dx0, dy0, dx1, dy1] = [Number(t[k + 2]), Number(t[k + 3]), Number(t[k + 4]), Number(t[k + 5])];
        if (base) addRect(layer, PURPOSE.patch, base.x + dx0, base.y + dy0, base.x + dx1, base.y + dy1, net);
        k += 7;
        continue;
      }
      // A via at the previous point, possibly an array (DO n BY m STEP dx dy).
      const at = prev as { x: number; y: number } | null;
      if (at) {
        let columns = 1;
        let rows = 1;
        let sx = 0;
        let sy = 0;
        let j = k + 1;
        // An orientation may follow a via name in DEF 5.8; ignore it (all vias here are symmetric).
        if (ORIENTS.includes(t[j] as (typeof ORIENTS)[number])) j += 1;
        if (t[j] === 'DO') {
          columns = Number(t[j + 1]);
          rows = Number(t[j + 3]);
          sx = Number(t[j + 5]);
          sy = Number(t[j + 6]);
          j += 7;
        }
        for (let cx = 0; cx < columns; cx += 1) for (let cy = 0; cy < rows; cy += 1) addVia(token, at.x + cx * sx, at.y + cy * sy, net);
        const layers = layersOfVia(token);
        if (layers && !special) {
          // The path continues on the via's other layer.
          const other = layers[0] === layer ? layers[1] : layers[0];
          if (other !== layer) {
            layer = other;
            width = widthFor(layer);
          }
        }
        k = j;
        continue;
      }
      out.warnings.push(`unexpected wiring token ${token}`);
      k += 1;
    }
    return k;
  };

  // --------------------------------------------------------------- sections
  const componentNames: string[] = [];
  const componentMacro: string[] = [];
  const cx = new IntList(1 << 20);
  const cy = new IntList(1 << 20);
  const co = new IntList(1 << 20);
  const componentIndex = new Map<string, number>();

  for (let line = nextLine(); line !== null; line = nextLine()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const head = trimmed.split(/\s+/, 2);
    switch (head[0]) {
      case 'DESIGN':
        out.design = trimmed.split(/\s+/)[1];
        break;
      case 'UNITS':
        out.dbu = Number(trimmed.split(/\s+/)[3]);
        break;
      case 'DIEAREA': {
        const n = trimmed.match(/-?\d+/g)!.map(Number);
        out.die = [n[0], n[1], n[2], n[3]];
        break;
      }
      case 'ROW': {
        const t = trimmed.split(/\s+/);
        const x = Number(t[3]);
        const y = Number(t[4]);
        const count = Number(t[7]);
        const step = Number(t[11]);
        out.rows.count += 1;
        out.rows.site = step;
        out.rows.x0 = Math.min(out.rows.x0, x);
        if (y < out.rows.y0) out.rows.orient0 = Math.max(0, ORIENTS.indexOf(t[5] as (typeof ORIENTS)[number]));
        out.rows.y0 = Math.min(out.rows.y0, y);
        out.rows.x1 = Math.max(out.rows.x1, x + count * step);
        out.rows.y1 = Math.max(out.rows.y1, y);
        break;
      }
      case 'VIAS': {
        for (let l = nextLine(); l !== null && !l.trim().startsWith('END VIAS'); l = nextLine()) {
          if (!l.trim().startsWith('-')) continue;
          const t = statement(l);
          const name = t[1];
          const value = (key: string, n: number) => {
            const at = t.indexOf(key);
            return at < 0 ? null : t.slice(at + 1, at + 1 + n).map(Number);
          };
          const layersAt = t.indexOf('LAYERS');
          const layers: [string, string, string] = [t[layersAt + 1], t[layersAt + 2], t[layersAt + 3]];
          const [cw, ch] = value('CUTSIZE', 2)!;
          const [spx, spy] = value('CUTSPACING', 2)!;
          const [ebx, eby, etx, ety] = value('ENCLOSURE', 4)!;
          const [rows, cols] = value('ROWCOL', 2) ?? [1, 1];
          const [ox, oy] = value('ORIGIN', 2) ?? [0, 0];
          const [obx, oby, otx, oty] = value('OFFSET', 4) ?? [0, 0, 0, 0];
          const arrayW = cols * cw + (cols - 1) * spx;
          const arrayH = rows * ch + (rows - 1) * spy;
          const rects: DefGeneratedVia['rects'] = [];
          for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
            const x0 = -arrayW / 2 + c * (cw + spx) + ox;
            const y0 = -arrayH / 2 + r * (ch + spy) + oy;
            rects.push({ layer: layers[1], x0, y0, x1: x0 + cw, y1: y0 + ch });
          }
          rects.push({ layer: layers[0], x0: -arrayW / 2 - ebx + ox + obx, y0: -arrayH / 2 - eby + oy + oby, x1: arrayW / 2 + ebx + ox + obx, y1: arrayH / 2 + eby + oy + oby });
          rects.push({ layer: layers[2], x0: -arrayW / 2 - etx + ox + otx, y0: -arrayH / 2 - ety + oy + oty, x1: arrayW / 2 + etx + ox + otx, y1: arrayH / 2 + ety + oy + oty });
          out.generatedVias.push({ name, layers, rects });
          generatedLayers.set(name, [layers[0], layers[2]]);
        }
        break;
      }
      case 'NONDEFAULTRULES': {
        let rule = '';
        for (let l = nextLine(); l !== null && !l.trim().startsWith('END NONDEFAULTRULES'); l = nextLine()) {
          const t = l.trim().split(/\s+/);
          if (t[0] === '-') {
            rule = t[1];
            out.nondefaultWidths.set(rule, new Map());
          } else if (t[0] === '+' && t[1] === 'LAYER') {
            const widthAt = t.indexOf('WIDTH');
            if (widthAt > 0) out.nondefaultWidths.get(rule)!.set(t[2], Number(t[widthAt + 1]));
          }
        }
        break;
      }
      case 'COMPONENTS': {
        for (let l = nextLine(); l !== null && !l.trim().startsWith('END COMPONENTS'); l = nextLine()) {
          if (!l.trim().startsWith('-')) continue;
          const t = statement(l);
          const placed = t.findIndex((token) => token === 'PLACED' || token === 'FIXED' || token === 'COVER');
          if (placed < 0) {
            out.warnings.push(`unplaced component ${t[1]}`);
            continue;
          }
          componentIndex.set(t[1], componentNames.length);
          componentNames.push(t[1]);
          componentMacro.push(t[2]);
          cx.push(Number(t[placed + 2]));
          cy.push(Number(t[placed + 3]));
          const orient = ORIENTS.indexOf(t[placed + 5] as (typeof ORIENTS)[number]);
          co.push(orient < 0 ? 0 : orient);
        }
        break;
      }
      case 'PINS': {
        for (let l = nextLine(); l !== null && !l.trim().startsWith('END PINS'); l = nextLine()) {
          if (!l.trim().startsWith('-')) continue;
          const t = statement(l);
          const pin: IoPin = { name: t[1], net: t[1], direction: 'INPUT', use: 'SIGNAL', rects: [] };
          const local: Array<{ layer: string; x0: number; y0: number; x1: number; y1: number }> = [];
          let px = 0;
          let py = 0;
          let porient = 0;
          for (let k = 2; k < t.length; k += 1) {
            if (t[k] !== '+') continue;
            const key = t[k + 1];
            if (key === 'NET') pin.net = t[k + 2];
            else if (key === 'DIRECTION') pin.direction = t[k + 2];
            else if (key === 'USE') pin.use = t[k + 2];
            else if (key === 'LAYER') {
              let j = k + 3;
              if (t[j] === 'MASK' || t[j] === 'SPACING' || t[j] === 'DESIGNRULEWIDTH') j += 2;
              local.push({ layer: t[k + 2], x0: Number(t[j + 1]), y0: Number(t[j + 2]), x1: Number(t[j + 5]), y1: Number(t[j + 6]) });
            } else if (key === 'PLACED' || key === 'FIXED' || key === 'COVER') {
              px = Number(t[k + 3]);
              py = Number(t[k + 4]);
              porient = Math.max(0, ORIENTS.indexOf(t[k + 6] as (typeof ORIENTS)[number]));
            }
          }
          // Pin shapes rotate about the placement point.
          const turn = (x: number, y: number): [number, number] => {
            switch (porient) {
              case 1: return [-x, -y];
              case 2: return [y, -x];
              case 3: return [-y, x];
              case 4: return [-x, y];
              case 5: return [x, -y];
              case 6: return [-y, -x];
              case 7: return [y, x];
              default: return [x, y];
            }
          };
          for (const r of local) {
            const [ax, ay] = turn(r.x0, r.y0);
            const [bx, by] = turn(r.x1, r.y1);
            pin.rects.push({ layer: r.layer, x0: px + Math.min(ax, bx), y0: py + Math.min(ay, by), x1: px + Math.max(ax, bx), y1: py + Math.max(ay, by) });
          }
          out.ioPins.push(pin);
        }
        break;
      }
      case 'SPECIALNETS': {
        for (let l = nextLine(); l !== null && !l.trim().startsWith('END SPECIALNETS'); l = nextLine()) {
          if (!l.trim().startsWith('-')) continue;
          const t = statement(l);
          const name = t[1];
          const net = name === 'VDD' || name === 'VPWR' ? -1 : name === 'VSS' || name === 'VGND' ? -2 : null;
          if (net === null) {
            out.warnings.push(`special net ${name} skipped`);
            continue;
          }
          for (let k = 2; k < t.length; k += 1) {
            if (t[k] === '+' && (t[k + 1] === 'ROUTED' || t[k + 1] === 'FIXED' || t[k + 1] === 'COVER')) k = walkWiring(t, k + 2, net, true, null) - 1;
            else if (t[k] === '+' && t[k + 1] === 'RECT') {
              addRect(t[k + 2], PURPOSE.patch, Number(t[k + 4]), Number(t[k + 5]), Number(t[k + 8]), Number(t[k + 9]), net);
              k += 10;
            }
          }
        }
        break;
      }
      case 'NETS': {
        // COMPONENTS and PINS precede NETS, so every connection resolves as it is read.
        const ioPinIndex = new Map(out.ioPins.map((pin, index) => [pin.name, index]));
        const pins = out.nets;
        for (let l = nextLine(); l !== null && !l.trim().startsWith('END NETS'); l = nextLine()) {
          if (!l.trim().startsWith('-')) continue;
          const t = statement(l);
          const net = pins.names.length;
          pins.names.push(t[1]);
          let use = 'SIGNAL';
          let ndr: string | null = null;
          let k = 2;
          for (; k < t.length && t[k] === '('; k += 4) {
            // Components are >= 0; I/O pins are stored as -1 - their index.
            const index = t[k + 1] === 'PIN' ? ioPinIndex.get(t[k + 2]) : componentIndex.get(t[k + 1]);
            if (index === undefined) {
              out.warnings.push(`net ${t[1]}: unknown ${t[k + 1] === 'PIN' ? 'I/O pin' : 'component'} ${t[k + 1] === 'PIN' ? t[k + 2] : t[k + 1]}`);
              continue;
            }
            pins.pinInst.push(t[k + 1] === 'PIN' ? -1 - index : index);
            pins.pinName.push(t[k + 2]);
          }
          pins.pinStart.push(pins.pinInst.length);
          for (let j = k; j < t.length; j += 1) {
            if (t[j] !== '+') continue;
            if (t[j + 1] === 'USE') use = t[j + 2];
            else if (t[j + 1] === 'NONDEFAULTRULE') ndr = t[j + 2];
          }
          pins.use.push(use);
          pins.ndr.push(ndr);
          for (let j = k; j < t.length; j += 1) {
            if (t[j] === '+' && (t[j + 1] === 'ROUTED' || t[j + 1] === 'FIXED' || t[j + 1] === 'COVER' || t[j + 1] === 'NOSHIELD')) j = walkWiring(t, j + 2, net, false, ndr) - 1;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  out.components = {
    names: componentNames,
    macro: componentMacro,
    x: cx.data.slice(0, cx.length),
    y: cy.data.slice(0, cy.length),
    orient: Uint8Array.from(co.data.slice(0, co.length)),
  };
  out.rows.height = out.rows.count > 1 ? Math.round((out.rows.y1 - out.rows.y0) / (out.rows.count - 1)) : 0;
  return out;
}
