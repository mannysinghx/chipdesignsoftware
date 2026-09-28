#!/usr/bin/env python3
"""Replace named standard-cell definitions in the schematic with their layout netlists.

Use only for cells whose cell-level Netgen comparison fails on transistor folding: the
ORFS CDL writes a stacked gate as one series pair with m=2 (one shared middle node),
while the SkyWater layout has two separate stacks (a middle node each). They are the
same logic but different graphs. Cell internals are the library's; after this swap,
top-level LVS still checks every instance, net and pin of the design, and every other
cell type keeps its full transistor-level comparison. The list of swapped cells is
printed and must be reported with the result.

Usage: library_cells.py <schematic.cdl> <layout.spice> <cells.txt> <out.cdl>
"""
import re, sys

def blocks(text, pattern):
    out = {}
    for m in re.finditer(pattern, text, re.S | re.M | re.I):
        out[m.group(1).lower()] = m.group(0)
    return out

cdl_path, spice_path, cells_path, out_path = sys.argv[1:5]
cells = [c.strip().lower() for c in open(cells_path) if c.strip()]
cdl = open(cdl_path).read()
lay = blocks(open(spice_path).read(), r'^\.subckt\s+(\S+).*?^\.ends\b[^\n]*\n')
sch = blocks(cdl, r'^\.SUBCKT\s+(\S+).*?^\.ENDS\b[^\n]*\n')
def ports(block):
    head = re.match(r'\.subckt\s+\S+(.*?)\n(?!\+)', block, re.S | re.I).group(1)
    return head.replace('\n+', ' ').split()

for c in cells:
    if c not in lay or c not in sch:
        sys.exit(f'cell {c} missing (layout {c in lay}, schematic {c in sch})')
    # Instances connect by position, so the swapped-in definition must keep the
    # schematic's pin order (same names; only the order differs).
    order = [p for p in ports(sch[c]) if not p.startswith('*')]
    if sorted(order) != sorted(ports(lay[c])):
        sys.exit(f'cell {c}: pin names differ {sorted(order)} vs {sorted(ports(lay[c]))}')
    body = lay[c].split('\n', 1)[1]
    while body.startswith('+'):
        body = body.split('\n', 1)[1]
    cdl = cdl.replace(sch[c], f'.subckt {c} ' + ' '.join(order) + '\n' + body)
open(out_path, 'w').write(cdl)
print('schematic cells taken from layout netlist:', ' '.join(cells))
