#!/usr/bin/env bash
set -euo pipefail

ORFS_REPO="https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts.git"
ORFS_COMMIT="774ff7546d041ecad757c52b9608e7ca7d66ef93"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE_DIR="${ROOT_DIR}/.cache/openroad-flow-scripts"

if [[ ! -d "${CACHE_DIR}/.git" ]]; then
  mkdir -p "${ROOT_DIR}/.cache"
  git clone --filter=blob:none --sparse "${ORFS_REPO}" "${CACHE_DIR}"
fi

git -C "${CACHE_DIR}" fetch --quiet origin "${ORFS_COMMIT}"
git -C "${CACHE_DIR}" checkout --quiet --detach "${ORFS_COMMIT}"
git -C "${CACHE_DIR}" sparse-checkout set flow/platforms/sky130hd

test -f "${CACHE_DIR}/flow/platforms/sky130hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib"
echo "Pinned OpenROAD sky130hd platform ready"
