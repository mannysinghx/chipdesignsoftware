# OpenROAD-flow-scripts config for the AIMEM-A1 tensor tile (a1_mma_tile, C3 of
# docs/COMPUTE_DIE_PLAN.md) on the ASAP7 predictive 7 nm platform (academic PDK,
# not manufacturable; used to bracket the 3 nm-class projection with gt2n).
# Paths are the layout tools/physical/orfs-arm64/run-tile.sh mounts.
export DESIGN_NAME     = a1_mma_tile
export DESIGN_NICKNAME = a1_mma_tile
export PLATFORM        = asap7

export VERILOG_FILES = /work/in/rtl/a1_dot_terms.sv /work/in/rtl/a1_dot_sum.sv \
                       /work/in/rtl/a1_dot_round.sv /work/in/rtl/a1_mma_tile.sv
export SDC_FILE      = /work/in/orfs/constraint.sdc

# First-pass values; ~1,610 I/O pins need perimeter, so utilization starts below
# the ASAP7 example designs (70).
export CORE_UTILIZATION  = 40
export CORE_ASPECT_RATIO = 1
export CORE_MARGIN       = 2
export PLACE_DENSITY     = 0.60
export TNS_END_PERCENT   = 100

# sky130hd run 1 found a ~260-gate ripple-carry critical path in stage 1; swap adders/
# multipliers to faster architectures here too.
export SWAP_ARITH_OPERATORS = 1
# Required by ORFS for SWAP_ARITH_OPERATORS (as in its sky130hd/aes example).
export OPENROAD_HIERARCHICAL = 1
