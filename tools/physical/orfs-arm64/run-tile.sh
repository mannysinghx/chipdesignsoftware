#!/usr/bin/env bash
# Run the A1 tile through ORFS on the native arm64 toolchain (build.sh first).
# Usage: [RESUME=<run dir>] run-tile.sh sky130hd|asap7 [make targets...]   (default: finish, plus drc lvs on sky130hd)
# Results: /Volumes/aimem-eda/runs/a1_mma_tile/<platform>-<UTC stamp>/{logs,reports,results}
set -euo pipefail

EDA="${AIMEM_EDA:-/Volumes/aimem-eda}"
DEPS_IMAGE="aimem/orfs-arm64-deps:2d29bdaf8"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLATFORM="${1:?platform: sky130hd or asap7}"; shift
CFG="${REPO}/design/physical/orfs/a1_mma_tile/${PLATFORM}"
test -f "${CFG}/config.mk" || { echo "no config for ${PLATFORM}" >&2; exit 1; }
if [[ $# -gt 0 ]]; then TARGETS="$*"; elif [[ "${PLATFORM}" == sky130hd ]]; then TARGETS="finish drc lvs"; else TARGETS="finish"; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -n "${RESUME:-}" ]]; then
  # RESUME=<run dir name, e.g. sky130hd-20260927T094756Z>: continue an interrupted run in place.
  # make redoes only the stages whose outputs are missing. The inputs must be unchanged.
  RUN="runs/a1_mma_tile/${RESUME}"
  test -f "${EDA}/${RUN}/inputs.txt" || { echo "no run ${RESUME}" >&2; exit 1; }
  now="$(cd "${REPO}" && shasum -a 256 rtl/a1/a1_dot_terms.sv rtl/a1/a1_dot_sum.sv rtl/a1/a1_dot_round.sv rtl/a1/a1_mma_tile.sv "design/physical/orfs/a1_mma_tile/${PLATFORM}"/*)"
  [[ "$(grep -E '^[0-9a-f]{64}  ' "${EDA}/${RUN}/inputs.txt")" == "${now}" ]] || { echo "inputs changed since ${RESUME}; start a new run" >&2; exit 1; }
  echo "resumed=${STAMP} targets=${TARGETS}" >> "${EDA}/${RUN}/inputs.txt"
  mv "${EDA}/${RUN}/run.log" "${EDA}/${RUN}/run-before-${STAMP}.log" 2>/dev/null || true
else
RUN="runs/a1_mma_tile/${PLATFORM}-${STAMP}"
mkdir -p "${EDA}/${RUN}"
# Record exactly what ran: repo commit + dirty state, input hashes, toolchain.
{
  echo "repo_head=$(git -C "${REPO}" rev-parse HEAD)"
  echo "repo_dirty=$(git -C "${REPO}" status --porcelain -- rtl/a1 design/physical/orfs/a1_mma_tile | wc -l | tr -d ' ')"
  echo "orfs=$(git -C "${EDA}/src/OpenROAD-flow-scripts" rev-parse HEAD)"
  echo "image=$(docker image inspect "${DEPS_IMAGE}" --format '{{.Id}}')"
  echo "targets=${TARGETS}"
  (cd "${REPO}" && shasum -a 256 rtl/a1/a1_dot_terms.sv rtl/a1/a1_dot_sum.sv rtl/a1/a1_dot_round.sv rtl/a1/a1_mma_tile.sv "design/physical/orfs/a1_mma_tile/${PLATFORM}"/*)
} > "${EDA}/${RUN}/inputs.txt"
fi

docker run --rm --name "aimem-a1-${PLATFORM}-${STAMP}" --platform linux/arm64 \
  -v "${EDA}:/work" -v "${EDA}/tmp:/tmp" -e HOME=/work/home \
  -v "${REPO}/rtl/a1:/work/in/rtl:ro" -v "${CFG}:/work/in/orfs:ro" \
  "${DEPS_IMAGE}" bash -euo pipefail -c "
    # The ORFS aarch64 installer builds KLayout into /usr/local/klayout (not on PATH).
    export KLAYOUT_CMD=/usr/local/klayout
    cd /work/src/OpenROAD-flow-scripts && source env.sh >/dev/null
    cd flow && make DESIGN_CONFIG=/work/in/orfs/config.mk WORK_HOME=/work/${RUN} ${TARGETS}" \
  2>&1 | tee "${EDA}/${RUN}/run.log"
echo "run dir: ${EDA}/${RUN}"
