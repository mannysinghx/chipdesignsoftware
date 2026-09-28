# KLayout (pya) script: copy a GDS and add net-name texts (datatype 5) to the top cell.
# Run: klayout -b -r add_labels.py -rd in_gds=... -rd labels=... -rd out_gds=... -rd top_cell=...
import pya
layout = pya.Layout()
layout.read(in_gds)
top = layout.cell(top_cell)
dbu_scale = 1.0  # DEF and GDS both use 1000 units per um for sky130hd; checked below
if abs(layout.dbu - 0.001) > 1e-12:
    raise RuntimeError(f'unexpected GDS dbu {layout.dbu}')
layers = {}
count = 0
with open(labels) as f:
    for row in f:
        gds, x, y, name = row.rstrip('\n').split('\t')
        li = layers.get(gds)
        if li is None:
            li = layers[gds] = layout.layer(int(gds), 5)
        top.shapes(li).insert(pya.Text(name, pya.Trans(int(x), int(y))))
        count += 1
layout.write(out_gds)
print(f'added {count} net labels, wrote {out_gds}')
