#!/usr/bin/env bash
set -euo pipefail

RAMULATOR_REPO="https://github.com/CMU-SAFARI/ramulator2.git"
RAMULATOR_COMMIT="0c4eaeb00d88e668d8b5a0cbdd7d6276be921a41"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE_DIR="${ROOT_DIR}/.cache/ramulator2"

if [[ ! -d "${CACHE_DIR}/.git" ]]; then
  mkdir -p "${ROOT_DIR}/.cache"
  git clone "${RAMULATOR_REPO}" "${CACHE_DIR}"
fi

git -C "${CACHE_DIR}" fetch --quiet origin "${RAMULATOR_COMMIT}"
git -C "${CACHE_DIR}" checkout --quiet --detach "${RAMULATOR_COMMIT}"

# Compatibility overlay for Apple Clang 21. The official simulator commit is
# pinned above; only the vendored fmt revision and dependent-template syntax
# are adjusted. Both changes are idempotent and recorded in the evidence.
perl -0pi -e 's/GIT_TAG        10\.2\.1/GIT_TAG        11.2.0/' "${CACHE_DIR}/CMakeLists.txt"
perl -0pi -e 's/config\[name\]\.as<T>\(\)/config[name].template as<T>()/' "${CACHE_DIR}/src/ramulator/base/param.h"

cmake --fresh -S "${CACHE_DIR}" -B "${CACHE_DIR}/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "${CACHE_DIR}/build" -j "${AIMEM_BUILD_JOBS:-4}"

PYTHONPATH="${CACHE_DIR}/python" python3 -c "import ramulator; print('Ramulator2 Python binding ready')"
