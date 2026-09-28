# OpenROAD-flow-scripts config for the AIMEM-A1 tensor tile (a1_mma_tile, C3 of
# docs/COMPUTE_DIE_PLAN.md) on the public sky130hd platform.
# Paths are the layout tools/physical/orfs-arm64/run-tile.sh mounts:
#   /work/in/rtl   rtl/a1 (read-only)        /work/in/orfs   this directory
export DESIGN_NAME     = a1_mma_tile
export DESIGN_NICKNAME = a1_mma_tile
export PLATFORM        = sky130hd

export VERILOG_FILES = /work/in/rtl/a1_dot_terms.sv /work/in/rtl/a1_dot_sum.sv \
                       /work/in/rtl/a1_dot_round.sv /work/in/rtl/a1_mma_tile.sv
export SDC_FILE      = /work/in/orfs/constraint.sdc

# ~1,610 I/O pins (512-bit A/B operands, 512-bit C in, 512-bit D out).
# Run 1 (40%, 10 ns) failed global routing: timing repair grew the cells to 59% utilization
# (81.6% routing demand). Run 2 relaxes the clock (constraint.sdc) and starts at 30%.
export CORE_UTILIZATION       = 30
export CORE_ASPECT_RATIO      = 1
# Run 2 detailed routing stalled at 93 met3 spacing violations, all at the right die edge:
# the last VDD met4 stripe (with its met3 via pads) sat flush at the core edge, 0.68 um from
# the 560 right-edge met3 pins, leaving no pin-access room. 10 um gives an access channel.
export CORE_MARGIN            = 10
export PLACE_DENSITY_LB_ADDON = 0.2
export PLACE_PINS_ARGS        = -min_distance 2 -min_distance_in_tracks
export TNS_END_PERCENT        = 100

# Run 1's critical path (stage 1, s1_fmt -> s2_terms) was ~260 gates of ripple-carry
# arithmetic. Let OpenROAD swap adders/multipliers to faster architectures.
export SWAP_ARITH_OPERATORS   = 1
# Required by ORFS for SWAP_ARITH_OPERATORS (as in its sky130hd/aes example).
export OPENROAD_HIERARCHICAL = 1

# LEC_CHECK is left at the ORFS default (on when kepler-formal is built). The native
# arm64 toolchain exists to remove the Rosetta crash that forced LEC_CHECK=0 for T0.
