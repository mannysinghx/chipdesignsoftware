// Minimal GDSII reader for the layout exporter: each structure's boundaries,
// boxes, and paths as rectangles per (layer, datatype), flattened through
// structure references. Rectilinear polygons are cut into rectangles; the
// standard-cell libraries this reads are Manhattan, and anything else is
// approximated slab by slab (and counted, so the caller can report it).

import { readFileSync } from 'node:fs';

export type GdsRect = { layer: number; datatype: number; x0: number; y0: number; x1: number; y1: number };
export type GdsCell = { name: string; rects: GdsRect[]; refs: Array<{ name: string; x: number; y: number; mirrorX: boolean; angle: number }> };
export type Gds = { dbuInMeters: number; cells: Map<string, GdsCell>; nonManhattan: number };

const REC = {
  HEADER: 0x00, BGNLIB: 0x01, LIBNAME: 0x02, UNITS: 0x03, ENDLIB: 0x04, BGNSTR: 0x05, STRNAME: 0x06, ENDSTR: 0x07,
  BOUNDARY: 0x08, PATH: 0x09, SREF: 0x0a, AREF: 0x0b, TEXT: 0x0c, LAYER: 0x0d, DATATYPE: 0x0e, WIDTH: 0x0f, XY: 0x10,
  ENDEL: 0x11, SNAME: 0x12, COLROW: 0x13, NODE: 0x15, TEXTTYPE: 0x16, STRING: 0x19, STRANS: 0x1a, MAG: 0x1b, ANGLE: 0x1c,
  PATHTYPE: 0x21, BOX: 0x2d, BOXTYPE: 0x2e,
} as const;

/** GDSII 8-byte real: sign, excess-64 base-16 exponent, 56-bit mantissa. */
function real8(view: DataView, offset: number): number {
  const b0 = view.getUint8(offset);
  const sign = b0 & 0x80 ? -1 : 1;
  const exponent = (b0 & 0x7f) - 64;
  let mantissa = 0;
  for (let k = 1; k < 8; k += 1) mantissa = mantissa * 256 + view.getUint8(offset + k);
  return sign * (mantissa / 2 ** 56) * 16 ** exponent;
}

/** Cut a closed rectilinear polygon (DBU vertices) into rectangles, band by band in y. */
export function polygonToRects(points: Array<[number, number]>): { rects: Array<[number, number, number, number]>; manhattan: boolean } {
  const n = points.length;
  let manhattan = true;
  const edges: Array<{ x: number; y0: number; y1: number }> = [];
  const slanted: Array<{ xa: number; ya: number; xb: number; yb: number }> = [];
  for (let k = 0; k < n; k += 1) {
    const [ax, ay] = points[k];
    const [bx, by] = points[(k + 1) % n];
    if (ay === by) continue;
    if (ax === bx) edges.push({ x: ax, y0: Math.min(ay, by), y1: Math.max(ay, by) });
    else {
      manhattan = false;
      slanted.push({ xa: ax, ya: ay, xb: bx, yb: by });
    }
  }
  const ys = [...new Set(points.map((p) => p[1]))].sort((a, b) => a - b);
  const bands: Array<[number, number, number, number]> = [];
  for (let k = 0; k + 1 < ys.length; k += 1) {
    const y0 = ys[k];
    const y1 = ys[k + 1];
    const mid = (y0 + y1) / 2;
    // Crossings of the band's midline, even-odd.
    const xs: number[] = [];
    for (const edge of edges) if (edge.y0 <= mid && edge.y1 > mid) xs.push(edge.x);
    for (const s of slanted) {
      const lo = Math.min(s.ya, s.yb);
      const hi = Math.max(s.ya, s.yb);
      if (lo <= mid && hi > mid) xs.push(Math.round(s.xa + ((mid - s.ya) * (s.xb - s.xa)) / (s.yb - s.ya)));
    }
    xs.sort((a, b) => a - b);
    for (let j = 0; j + 1 < xs.length; j += 2) if (xs[j + 1] > xs[j]) bands.push([xs[j], y0, xs[j + 1], y1]);
  }
  // Merge vertically adjacent bands with the same x span.
  const merged: Array<[number, number, number, number]> = [];
  const open = new Map<string, [number, number, number, number]>();
  for (const band of bands) {
    const key = `${band[0]}:${band[2]}`;
    const previous = open.get(key);
    if (previous && previous[3] === band[1]) previous[3] = band[3];
    else {
      const copy: [number, number, number, number] = [...band];
      merged.push(copy);
      open.set(key, copy);
    }
  }
  return { rects: merged, manhattan };
}

/** Read every structure of a GDSII file. Coordinates stay in the file's database units. */
export function readGds(path: string): Gds {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cells = new Map<string, GdsCell>();
  let dbuInMeters = 1e-9;
  let nonManhattan = 0;
  let cell: GdsCell | null = null;
  let element: null | { type: number; layer: number; datatype: number; width: number; xy: number[]; sname: string; mirrorX: boolean; angle: number } = null;
  let o = 0;
  while (o + 4 <= bytes.length) {
    const length = view.getUint16(o);
    const type = view.getUint8(o + 2);
    if (length < 4) break;
    const data = o + 4;
    const end = o + length;
    switch (type) {
      case REC.UNITS:
        dbuInMeters = real8(view, data + 8);
        break;
      case REC.BGNSTR:
        cell = { name: '', rects: [], refs: [] };
        break;
      case REC.STRNAME:
        if (cell) cell.name = bytes.subarray(data, end).toString('latin1').replace(/\0+$/, '');
        break;
      case REC.ENDSTR:
        if (cell) cells.set(cell.name, cell);
        cell = null;
        break;
      case REC.BOUNDARY: case REC.PATH: case REC.SREF: case REC.AREF: case REC.TEXT: case REC.BOX: case REC.NODE:
        element = { type, layer: 0, datatype: 0, width: 0, xy: [], sname: '', mirrorX: false, angle: 0 };
        break;
      case REC.LAYER:
        if (element) element.layer = view.getInt16(data);
        break;
      case REC.DATATYPE: case REC.BOXTYPE:
        if (element) element.datatype = view.getInt16(data);
        break;
      case REC.WIDTH:
        if (element) element.width = view.getInt32(data);
        break;
      case REC.SNAME:
        if (element) element.sname = bytes.subarray(data, end).toString('latin1').replace(/\0+$/, '');
        break;
      case REC.STRANS:
        if (element) element.mirrorX = (view.getUint16(data) & 0x8000) !== 0;
        break;
      case REC.ANGLE:
        if (element) element.angle = real8(view, data);
        break;
      case REC.XY:
        if (element) for (let k = data; k + 8 <= end; k += 8) element.xy.push(view.getInt32(k), view.getInt32(k + 4));
        break;
      case REC.ENDEL: {
        if (cell && element) {
          const e = element;
          if (e.type === REC.BOUNDARY || e.type === REC.BOX) {
            const points: Array<[number, number]> = [];
            for (let k = 0; k + 1 < e.xy.length; k += 2) points.push([e.xy[k], e.xy[k + 1]]);
            if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop();
            const { rects, manhattan } = polygonToRects(points);
            if (!manhattan) nonManhattan += 1;
            for (const [x0, y0, x1, y1] of rects) cell.rects.push({ layer: e.layer, datatype: e.datatype, x0, y0, x1, y1 });
          } else if (e.type === REC.PATH && e.width > 0) {
            const half = Math.abs(e.width) / 2;
            for (let k = 0; k + 3 < e.xy.length; k += 2) {
              const [ax, ay, bx, by] = [e.xy[k], e.xy[k + 1], e.xy[k + 2], e.xy[k + 3]];
              if (ax !== bx && ay !== by) nonManhattan += 1;
              cell.rects.push({ layer: e.layer, datatype: e.datatype, x0: Math.min(ax, bx) - (ay === by ? 0 : half), y0: Math.min(ay, by) - (ax === bx ? 0 : half), x1: Math.max(ax, bx) + (ay === by ? 0 : half), y1: Math.max(ay, by) + (ax === bx ? 0 : half) });
            }
          } else if (e.type === REC.SREF && e.xy.length >= 2) {
            cell.refs.push({ name: e.sname, x: e.xy[0], y: e.xy[1], mirrorX: e.mirrorX, angle: e.angle });
          }
        }
        element = null;
        break;
      }
      default:
        break;
    }
    o = end;
  }
  return { dbuInMeters, cells, nonManhattan };
}

/** A cell's rectangles with every structure reference flattened into it. */
export function flattenCell(gds: Gds, name: string, depth = 0): GdsRect[] {
  const cell = gds.cells.get(name);
  if (!cell || depth > 8) return [];
  const out = [...cell.rects];
  for (const ref of cell.refs) {
    const angle = ((Math.round(ref.angle) % 360) + 360) % 360;
    for (const r of flattenCell(gds, ref.name, depth + 1)) {
      const corners: Array<[number, number]> = [[r.x0, r.y0], [r.x1, r.y1]].map(([x, y]) => {
        const my = ref.mirrorX ? -y : y;
        const [rx, ry] = angle === 90 ? [-my, x] : angle === 180 ? [-x, -my] : angle === 270 ? [my, -x] : [x, my];
        return [rx + ref.x, ry + ref.y];
      });
      out.push({ layer: r.layer, datatype: r.datatype, x0: Math.min(corners[0][0], corners[1][0]), y0: Math.min(corners[0][1], corners[1][1]), x1: Math.max(corners[0][0], corners[1][0]), y1: Math.max(corners[0][1], corners[1][1]) });
    }
  }
  return out;
}
