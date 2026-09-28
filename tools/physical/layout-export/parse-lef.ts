// Minimal LEF reader for the layout exporter: routing and cut layers, fixed
// vias, and each cell's size, pins, and pin shapes. Distances are returned in
// database units (DBU) using the file's UNITS DATABASE MICRONS.

import { readFileSync } from 'node:fs';

export type LefLayer = { name: string; type: string; direction?: 'horizontal' | 'vertical'; pitch?: number; width?: number };
export type LefRect = { layer: string; x0: number; y0: number; x1: number; y1: number };
export type LefVia = { name: string; rects: LefRect[] };
export type LefPin = { name: string; direction: string; use: string; rects: LefRect[] };
export type LefMacro = { name: string; cls: string; w: number; h: number; pins: LefPin[]; obs: LefRect[] };
export type Lef = { dbu: number; layers: Map<string, LefLayer>; vias: Map<string, LefVia>; macros: Map<string, LefMacro> };

function lines(path: string): string[][] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.replace(/;/g, ' ; ').split(/\s+/).filter(Boolean));
}

/** Parse one or more LEF files into one model (the tech LEF first). */
export function parseLef(paths: string[], dbuOverride?: number): Lef {
  const out: Lef = { dbu: dbuOverride ?? 1000, layers: new Map(), vias: new Map(), macros: new Map() };
  for (const path of paths) {
    const all = lines(path);
    const um = (value: string) => Math.round(Number(value) * out.dbu);
    let k = 0;
    const rectOf = (layer: string, t: string[]): LefRect => ({ layer, x0: um(t[1]), y0: um(t[2]), x1: um(t[3]), y1: um(t[4]) });
    while (k < all.length) {
      const t = all[k];
      if (t[0] === 'UNITS') {
        for (k += 1; k < all.length && all[k][0] !== 'END'; k += 1) if (all[k][0] === 'DATABASE') out.dbu = dbuOverride ?? Number(all[k][2]);
        k += 1;
      } else if (t[0] === 'LAYER' && t.length === 2) {
        const layer: LefLayer = { name: t[1], type: '' };
        let widthSeen = false;
        for (k += 1; k < all.length && !(all[k][0] === 'END' && all[k][1] === t[1]); k += 1) {
          const s = all[k];
          if (s[0] === 'TYPE') layer.type = s[1];
          else if (s[0] === 'DIRECTION') layer.direction = s[1] === 'HORIZONTAL' ? 'horizontal' : 'vertical';
          else if (s[0] === 'PITCH') layer.pitch = Number(s[1]);
          else if (s[0] === 'WIDTH' && !widthSeen && s[2] === ';') {
            layer.width = Number(s[1]);
            widthSeen = true;
          }
        }
        out.layers.set(layer.name, layer);
        k += 1;
      } else if (t[0] === 'VIA' && t.length >= 2) {
        const via: LefVia = { name: t[1], rects: [] };
        let layer = '';
        for (k += 1; k < all.length && !(all[k][0] === 'END' && all[k][1] === t[1]); k += 1) {
          const s = all[k];
          if (s[0] === 'LAYER') layer = s[1];
          else if (s[0] === 'RECT') via.rects.push(rectOf(layer, s));
        }
        out.vias.set(via.name, via);
        k += 1;
      } else if (t[0] === 'VIARULE' || t[0] === 'SITE' || t[0] === 'PROPERTYDEFINITIONS' || t[0] === 'NONDEFAULTRULE') {
        const name = t[1];
        for (k += 1; k < all.length && !(all[k][0] === 'END' && (all[k][1] === name || t[0] === 'PROPERTYDEFINITIONS')); k += 1);
        k += 1;
      } else if (t[0] === 'MACRO') {
        const macro: LefMacro = { name: t[1], cls: '', w: 0, h: 0, pins: [], obs: [] };
        for (k += 1; k < all.length && !(all[k][0] === 'END' && all[k][1] === macro.name); k += 1) {
          const s = all[k];
          if (s[0] === 'CLASS') macro.cls = s.slice(1, s.indexOf(';')).join(' ');
          else if (s[0] === 'SIZE') {
            macro.w = um(s[1]);
            macro.h = um(s[3]);
          } else if (s[0] === 'PIN') {
            const pin: LefPin = { name: s[1], direction: 'INPUT', use: 'SIGNAL', rects: [] };
            let layer = '';
            for (k += 1; k < all.length && !(all[k][0] === 'END' && all[k][1] === pin.name); k += 1) {
              const p = all[k];
              if (p[0] === 'DIRECTION') pin.direction = p[1];
              else if (p[0] === 'USE') pin.use = p[1];
              else if (p[0] === 'LAYER') layer = p[1];
              else if (p[0] === 'RECT') pin.rects.push(rectOf(layer, p));
            }
            macro.pins.push(pin);
          } else if (s[0] === 'OBS') {
            let layer = '';
            for (k += 1; k < all.length && all[k][0] !== 'END'; k += 1) {
              const p = all[k];
              if (p[0] === 'LAYER') layer = p[1];
              else if (p[0] === 'RECT') macro.obs.push(rectOf(layer, p));
            }
          }
        }
        out.macros.set(macro.name, macro);
        k += 1;
      } else k += 1;
    }
  }
  return out;
}
