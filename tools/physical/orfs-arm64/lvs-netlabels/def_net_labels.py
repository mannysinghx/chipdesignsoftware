#!/usr/bin/env python3
"""Pick one label point per routed net, for KLayout LVS name hints (sky130hd).

KLayout's netlist compare runs on one core and slows sharply on designs with many
look-alike structures (16 identical dot units in the A1 tile). Net names on the
layout side give it anchors. This reads the routed DEF and, for each signal net
whose name also appears in the schematic (CDL top cell), picks the midpoint of its
first non-zero-length wire segment on li1/met1-met5. The point lies inside that
net's own drawn metal, so connectivity is still extracted from geometry: a label on
a wrongly connected net shows up as a mismatch, not a pass.

Usage: def_net_labels.py <6_final.def> <6_final_concat.cdl> <top> <out.tsv>
Output rows: gds_layer <TAB> x_dbu <TAB> y_dbu <TAB> net_name   (DEF database units)
"""
import re, sys

LAYERS = {'li1': 67, 'met1': 68, 'met2': 69, 'met3': 70, 'met4': 71, 'met5': 72}
POINT = re.compile(r'\(\s*(-?\d+|\*)\s+(-?\d+|\*)(?:\s+-?\d+)?\s*\)')

def cdl_top_nets(path, top):
    text = open(path).read()
    start = text.index('.SUBCKT ' + top)
    body = text[start:text.index('.ENDS', start)]
    body = re.sub(r'\n\+', ' ', body)
    names = set()
    for line in body.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == '.SUBCKT':
            names.update(parts[2:])
        elif parts[0].startswith('X'):
            names.update(parts[1:-1])
    return names

def first_segment(route_lines):
    for line in route_lines:
        m = re.search(r'\b(?:ROUTED|NEW|FIXED)\s+(\S+)', line)
        if not m or m.group(1) not in LAYERS:
            continue
        layer = m.group(1)
        prev = None
        for px, py in POINT.findall(line[m.end():]):
            x = prev[0] if px == '*' else int(px)
            y = prev[1] if py == '*' else int(py)
            if prev is not None and (x, y) != prev:
                return layer, (prev[0] + x) // 2, (prev[1] + y) // 2
            prev = (x, y)
    return None

def main(def_path, cdl_path, top, out_path):
    wanted = cdl_top_nets(cdl_path, top)
    in_nets = False
    name, lines = None, []
    written = skipped_name = skipped_geom = 0
    with open(def_path) as f, open(out_path, 'w') as out:
        def flush():
            nonlocal written, skipped_name, skipped_geom
            if name is None:
                return
            plain = name.replace('\\', '')
            if plain not in wanted:
                skipped_name += 1
                return
            seg = first_segment(lines)
            if seg is None:
                skipped_geom += 1
                return
            layer, x, y = seg
            out.write(f'{LAYERS[layer]}\t{x}\t{y}\t{plain}\n')
            written += 1
        for raw in f:
            s = raw.strip()
            if s.startswith('NETS '):
                in_nets = True
                continue
            if not in_nets:
                continue
            if s.startswith('END NETS'):
                flush()
                break
            if s.startswith('- '):
                flush()
                name, lines = s.split()[1], []
            elif name is not None:
                lines.append(s)
    print(f'labels written {written}, skipped (not in schematic top) {skipped_name}, '
          f'skipped (no wire segment) {skipped_geom}')

if __name__ == '__main__':
    main(*sys.argv[1:5])
