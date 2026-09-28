#!/usr/bin/env bash
# Native arm64 build of OpenROAD-flow-scripts for C3, from open source only.
#
# Why: the pinned x86 image (platform/toolchains.lock.json, "orfs") runs under
# Rosetta, which crashes ORFS's equivalence check (LEC_CHECK=0 workaround).
# This builds the same ORFS commit natively for aarch64 Linux instead.
#
# Where: everything large lives on the aimem-eda volume (a case-sensitive APFS
# sparse image on the Extreme Pro disk, mounted at /Volumes/aimem-eda):
# sources, build trees, Bazel caches, temp files, and the installed tools.
# Only the system packages from the "deps" stage live in a local Docker image.
#
# Usage: build.sh deps    # system + common deps, committed as $DEPS_IMAGE
#        build.sh tools   # yosys, OpenROAD, kepler-formal into tools/install
#        build.sh check   # print tool versions from the built install
set -euo pipefail

EDA="${AIMEM_EDA:-/Volumes/aimem-eda}"
ORFS_COMMIT="2d29bdaf8deac950a317b16b547034829e3fbe0c"   # = image tag 26Q3-605-g2d29bdaf8
BASE_IMAGE="ubuntu@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02"  # 22.04 arm64, same OS as the x86 image
DEPS_IMAGE="aimem/orfs-arm64-deps:2d29bdaf8"
THREADS="${THREADS:-8}"
# OpenROAD's Bazel Qt (GUI) links these system libraries; the ORFS installer only adds them on x86.
GUI_LIBS="libice-dev libsm-dev libx11-xcb-dev libdbus-1-dev libfontconfig-dev libxkbcommon-dev libxkbcommon-x11-dev
  libxcb-cursor-dev libxcb-icccm4-dev libxcb-image0-dev libxcb-keysyms1-dev libxcb-randr0-dev libxcb-render0-dev
  libxcb-render-util0-dev libxcb-shape0-dev libxcb-shm0-dev libxcb-sync-dev libxcb-util-dev libxcb-xfixes0-dev libxcb-xkb-dev"
ORFS="/work/src/OpenROAD-flow-scripts"

test -d "${EDA}/src/OpenROAD-flow-scripts/.git" || { echo "missing ${EDA}/src/OpenROAD-flow-scripts" >&2; exit 1; }
head="$(git -C "${EDA}/src/OpenROAD-flow-scripts" rev-parse HEAD)"
[[ "${head}" == "${ORFS_COMMIT}" ]] || { echo "ORFS is at ${head}, expected ${ORFS_COMMIT}" >&2; exit 1; }
mkdir -p "${EDA}/tmp" "${EDA}/home" "${EDA}/logs"

run() {  # run <name> <image> <script>
  docker run --name "$1" --platform linux/arm64 --shm-size=8g \
    -v "${EDA}:/work" -v "${EDA}/tmp:/tmp" -e HOME=/work/home -e THREADS="${THREADS}" \
    "$2" bash -euo pipefail -c "$3"
}

case "${1:-}" in
  deps)
    docker rm "aimem-orfs-arm64-deps-build" >/dev/null 2>&1 || true
    # The installer installs Docker when `docker` is absent; a stub skips that.
    run aimem-orfs-arm64-deps-build "${BASE_IMAGE}" "
      ln -s /bin/true /usr/local/bin/docker
      cd ${ORFS} && ./etc/DependencyInstaller.sh -all -threads=\${THREADS}
      rm /usr/local/bin/docker
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${GUI_LIBS//$'\n'/ }
      apt-get clean && rm -rf /var/lib/apt/lists/*"
    docker commit aimem-orfs-arm64-deps-build "${DEPS_IMAGE}"
    docker rm aimem-orfs-arm64-deps-build
    ;;
  gui-libs)  # add GUI_LIBS to an existing deps image (already part of "deps" for fresh builds)
    docker rm "aimem-orfs-arm64-gui-libs" >/dev/null 2>&1 || true
    docker run --name aimem-orfs-arm64-gui-libs --platform linux/arm64 "${DEPS_IMAGE}" bash -euo pipefail -c "
      apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${GUI_LIBS//$'\n'/ }
      apt-get clean && rm -rf /var/lib/apt/lists/*"
    docker commit aimem-orfs-arm64-gui-libs "${DEPS_IMAGE}"
    docker rm aimem-orfs-arm64-gui-libs
    ;;
  tools)
    docker rm "aimem-orfs-arm64-tools-build" >/dev/null 2>&1 || true
    # OpenROAD is built with CMake + GCC 11 (-cmake-build), the same method as the pinned x86 image's
    # binary (openroad/ubuntu22.04-builder-gcc). The default Bazel build was tried first and fails on
    # aarch64: its hermetic LLVM toolchain links against bundled glibc stubs, so the Ubuntu system
    # libraries Qt needs (xcb, dbus, fontconfig; built for glibc 2.35) leave dlopen@GLIBC_2.34 and
    # stat@GLIBC_2.33 undefined. (The Bazel route also reads a third-party remote cache,
    # bazel.precisioninno.com, which the owner's open-source-only rule excludes.)
    run aimem-orfs-arm64-tools-build "${DEPS_IMAGE}" "
      git config --global --add safe.directory '*'
      cd ${ORFS} && ./build_openroad.sh --local --no_init --threads \${THREADS} --openroad-args -cmake-build"
    docker rm aimem-orfs-arm64-tools-build
    ;;
  check)
    docker run --rm --platform linux/arm64 -v "${EDA}:/work" "${DEPS_IMAGE}" bash -c "
      uname -m; cd ${ORFS}
      tools/install/OpenROAD/bin/openroad -version; tools/install/yosys/bin/yosys -V
      /usr/local/klayout -v; ls tools/install/kepler-formal/bin"
    ;;
  *) sed -n 2,16p "$0"; exit 2 ;;
esac
