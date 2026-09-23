# OpenROAD-flow-scripts design config for aimem_t0_channel on the public sky130hd platform.
# Paths are the sandbox layout the platform's physical.orfs adapter mounts:
#   /work/in/rtl   RTL inputs          /work/in/orfs   this directory
export DESIGN_NAME     = aimem_t0_channel
export DESIGN_NICKNAME = aimem_t0_channel
export PLATFORM        = sky130hd

export VERILOG_FILES = /work/in/rtl/aimem_secded_64.sv /work/in/rtl/aimem_t0_channel.sv
export SDC_FILE      = /work/in/orfs/constraint.sdc

# ~230 I/O pins: a moderate utilization leaves enough die perimeter for pin placement.
export CORE_UTILIZATION = 30
export TNS_END_PERCENT  = 100

# The image's kepler-formal equivalence checker (LEC after CTS repair) dies with SIGILL under
# macOS x86 emulation (Rosetta implements AVX2 but not every instruction the binary uses).
# Disabled on every machine so local and CI runs are identical; netlist equivalence is a
# tracked Phase 1 gap, not a silent skip.
export LEC_CHECK = 0
