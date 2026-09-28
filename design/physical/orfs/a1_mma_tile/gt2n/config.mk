# OpenROAD-flow-scripts config for the AIMEM-A1 tensor tile (a1_mma_tile, C3 of
# docs/COMPUTE_DIE_PLAN.md) on GT2N, a predictive 2 nm GAAFET PDK with backside
# power delivery (academic, not manufacturable). With ASAP7 it brackets the 3 nm-class
# projection. Paths are the layout tools/physical/orfs-arm64/run-tile.sh mounts.
export DESIGN_NAME     = a1_mma_tile
export DESIGN_NICKNAME = a1_mma_tile
export PLATFORM        = gt2n

export VERILOG_FILES = /work/in/rtl/a1_dot_terms.sv /work/in/rtl/a1_dot_sum.sv \
                       /work/in/rtl/a1_dot_round.sv /work/in/rtl/a1_mma_tile.sv
export SDC_FILE      = /work/in/orfs/constraint.sdc

# Same starting point as ASAP7 run 1 (40%, margin 2), which routed with 0 violations.
# Backside power means no front-side stripe at the core edge (the sky130 run 2 stall).
export CORE_UTILIZATION       = 40
export CORE_ASPECT_RATIO      = 1
export CORE_MARGIN            = 2
export PLACE_DENSITY_LB_ADDON = 0.20
export TNS_END_PERCENT        = 100

# Faster adder/multiplier architectures, as on sky130hd and ASAP7.
export SWAP_ARITH_OPERATORS = 1
export OPENROAD_HIERARCHICAL = 1

# As ORFS's gt2n/aes example: skip post-GRT incremental repair (a congestion workaround)
# and cap routing at M10 (M11-M13 carry little and enlarge the detailed-route grid).
export SKIP_INCREMENTAL_REPAIR = 1
export MAX_ROUTING_LAYER       = M10
