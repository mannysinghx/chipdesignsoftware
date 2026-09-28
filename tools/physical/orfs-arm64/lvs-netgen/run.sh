#!/usr/bin/env bash
# Netgen LVS for a finished sky130hd run: Magic extracts SPICE from 6_final.gds, Netgen
# compares it with the run's 6_final_concat.cdl (the same schematic KLayout uses).
# Usage: run.sh <run dir name>. Writes only into <run>/lvs_netgen/.
set -euo pipefail
EDA="${AIMEM_EDA:-/Volumes/aimem-eda}"
LVS_IMAGE="aimem/orfs-arm64-lvs:m8.3.684-n1.5.324"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="runs/a1_mma_tile/${1:?run dir}"; TOP=a1_mma_tile
mkdir -p "${EDA}/${RUN}/lvs_netgen"
# Validated first on the gcd smoke run: "Final result: Circuits match uniquely".
python3 "${HERE}/normalize.py" cdl "${EDA}/${RUN}/objects/sky130hd/${TOP}/base/6_final_concat.cdl" \
  "${EDA}/${RUN}/lvs_netgen/schematic.cdl"
docker run --rm --name aimem-a1-lvs-netgen --platform linux/arm64 \
  -v "${EDA}:/work" -v "${EDA}/tmp:/tmp" -v "${HERE}:/work/in/lvs:ro" -e HOME=/work/home \
  -e IN_GDS="/work/${RUN}/results/sky130hd/${TOP}/base/6_final.gds" -e TOP="${TOP}" -e OUT_DIR="/work/${RUN}/lvs_netgen" \
  "${LVS_IMAGE}" bash -euo pipefail -c "
    P=/work/tools/lvs; O=\$OUT_DIR
    /usr/bin/time -v \$P/bin/magic -dnull -noconsole -T \$P/sky130A/sky130A.tech /work/in/lvs/extract.tcl > \$O/magic.log 2>&1
    python3 /work/in/lvs/normalize.py spice \$O/${TOP}.spice \$O/layout.spice
    /usr/bin/time -v \$P/bin/netgen -batch lvs \"\$O/layout.spice ${TOP}\" \
      \"\$O/schematic.cdl ${TOP}\" \
      \$P/sky130A/sky130A_setup.tcl \$O/netgen_lvs.rpt -json > \$O/netgen.log 2>&1
    tail -5 \$O/netgen_lvs.rpt"
