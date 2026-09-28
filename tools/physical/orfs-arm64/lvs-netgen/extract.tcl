# Magic: extract a SPICE netlist from the final GDS for Netgen LVS (the standard
# open-source sky130 sequence, as in OpenLane's extract_spice.tcl). Read the GDS as
# layout, extract devices and connectivity only (no parasitics), write LVS-style SPICE.
drc off
gds readonly true
gds rescale false
gds read $::env(IN_GDS)
load $::env(TOP) -dereference
cd $::env(OUT_DIR)
extract do local
extract no capacitance
extract no coupling
extract no resistance
extract no adjust
extract unique
extract all
ext2spice lvs
ext2spice -o $::env(OUT_DIR)/$::env(TOP).spice $::env(TOP).ext
quit -noprompt
