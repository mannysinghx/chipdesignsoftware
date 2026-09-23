#!/usr/bin/env bash
# Physical flow for aimem_t0_channel on sky130hd, inside the pinned OpenROAD-flow-scripts image.
# Inputs are read-only under /work/in; everything the flow writes goes to /work/out/orfs.
set -uo pipefail

FLOW=/OpenROAD-flow-scripts/flow
make -C "$FLOW" \
  DESIGN_CONFIG=/work/in/orfs/config.mk \
  WORK_HOME=/work/out/orfs \
  NUM_CORES="${NUM_CORES:-4}" \
  finish drc lvs
status=$?

python3 /work/in/driver/orfs_summary.py \
  --work /work/out/orfs \
  --design aimem_t0_channel \
  --flow-exit "$status" \
  --out /work/out/physical.json
exit "$status"
