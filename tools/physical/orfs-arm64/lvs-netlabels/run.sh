#!/usr/bin/env bash
# LVS with net-name hints for a finished sky130hd run (see def_net_labels.py for why).
# Usage: run.sh <run dir name, e.g. sky130hd-20260927T144910Z>
# Writes only into <run>/lvs_netlabels/; the run's own results are not touched.
set -euo pipefail
EDA="${AIMEM_EDA:-/Volumes/aimem-eda}"
DEPS_IMAGE="aimem/orfs-arm64-deps:2d29bdaf8"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="runs/a1_mma_tile/${1:?run dir}"
TOP=a1_mma_tile
B="${EDA}/${RUN}"; OUT="${B}/lvs_netlabels"
mkdir -p "${OUT}"
python3 "${HERE}/def_net_labels.py" "${B}/results/sky130hd/${TOP}/base/6_final.def" \
  "${B}/objects/sky130hd/${TOP}/base/6_final_concat.cdl" "${TOP}" "${OUT}/labels.tsv" | tee "${OUT}/labels.log"
docker run --rm --name "aimem-a1-lvs-netlabels" --platform linux/arm64 \
  -v "${EDA}:/work" -v "${EDA}/tmp:/tmp" -v "${HERE}:/work/in/lvs:ro" -e HOME=/work/home \
  aimem/orfs-arm64-deps:2d29bdaf8 bash -euo pipefail -c "
    W=/work/${RUN}; O=\$W/lvs_netlabels
    /usr/local/klayout -b -r /work/in/lvs/add_labels.py -rd in_gds=\$W/results/sky130hd/${TOP}/base/6_final.gds \
      -rd labels=\$O/labels.tsv -rd out_gds=\$O/6_final_netlabels.gds -rd top_cell=${TOP}
    /usr/local/klayout -b -rd in_gds=\$O/6_final_netlabels.gds \
      -rd cdl_file=\$W/objects/sky130hd/${TOP}/base/6_final_concat.cdl \
      -rd top_cell=${TOP} -rd report_file=\$O/6_lvs_netlabels.lvsdb \
      -r /work/src/OpenROAD-flow-scripts/flow/platforms/sky130hd/lvs/sky130hd.lylvs" 2>&1 | tee "${OUT}/lvs.log"
