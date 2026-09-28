#!/usr/bin/env python3
"""Normalise device naming so Netgen can pair ORFS's sky130hd schematic with Magic's
extraction. Both edits only rename; they change no connectivity or sizes.

cdl  IN OUT : ORFS CDL writes transistors as primitive M devices with short models
              (nfet_01v8, pfet_01v8_hvt). Magic extracts them as sky130 device
              subcircuits, so rewrite `M<n> d g s b <model> ...` as
              `XM<n> d g s b sky130_fd_pr__<model> ...`. In the tie cell conb_1 the
              schematic ties HI/LO with 0-ohm resistors where the layout has two
              small poly resistors (res_generic_po, w 0.48 l 0.04 um); write those
              as the poly resistors (KLayout's deck instead merges both as shorts).
spice IN OUT: Magic labels the nfets inside some cells' special areas as
              sky130_fd_pr__special_nfet_01v8; the schematic has plain nfet_01v8
              for the same transistors. Map the name back.
"""
import re, sys

MODELS = {'nfet_01v8', 'nfet_01v8_lvt', 'pfet_01v8', 'pfet_01v8_hvt', 'pfet_01v8_lvt'}

def cdl(src, dst):
    n = ties = 0
    in_conb = False
    with open(src) as f, open(dst, 'w') as out:
        for line in f:
            parts = line.split()
            head = parts[0].upper() if parts else ''
            if head == '.SUBCKT':
                in_conb = parts[1].lower() == 'sky130_fd_sc_hd__conb_1'
            elif head == '.ENDS':
                in_conb = False
            if in_conb and len(parts) == 4 and head.startswith('R') and parts[3] == '0':
                line = f'X{parts[0]} {parts[1]} {parts[2]} sky130_fd_pr__res_generic_po w=0.48 l=0.04\n'
                ties += 1
            elif len(parts) >= 6 and parts[0][:1] in 'Mm' and parts[5] in MODELS:
                parts[0] = 'X' + parts[0]
                parts[5] = 'sky130_fd_pr__' + parts[5]
                line = ' '.join(parts) + '\n'
                n += 1
            out.write(line)
    print(f'cdl: rewrote {n} transistors, {ties} conb_1 tie resistors')

def spice(src, dst):
    text = open(src).read()
    n = text.count('sky130_fd_pr__special_nfet_01v8')
    open(dst, 'w').write(text.replace('sky130_fd_pr__special_nfet_01v8', 'sky130_fd_pr__nfet_01v8'))
    print(f'spice: renamed {n} special_nfet_01v8')

if __name__ == '__main__':
    {'cdl': cdl, 'spice': spice}[sys.argv[1]](sys.argv[2], sys.argv[3])
