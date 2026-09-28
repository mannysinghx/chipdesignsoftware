#!/usr/bin/env bash
# Build Magic + Netgen (open source, from source, native arm64) and the sky130A Magic
# tech file and Netgen setup from open_pdks, for a second sky130hd LVS path.
# Sources are pinned by commit below; installs go to <EDA>/tools/lvs on the Extreme Pro.
# The build container is committed as $LVS_IMAGE (deps image + Tcl/Tk runtime).
set -euo pipefail
EDA="${AIMEM_EDA:-/Volumes/aimem-eda}"
DEPS_IMAGE="aimem/orfs-arm64-deps:2d29bdaf8"
MAGIC_COMMIT=4f53bb3091d1     # 8.3.684, 2026-09-17
NETGEN_COMMIT=3cb047bd6b55    # 1.5.324, 2026-09-25
OPEN_PDKS_COMMIT=aa3fc215a80d # 1.0.608, 2026-09-19
LVS_IMAGE="aimem/orfs-arm64-lvs:m8.3.684-n1.5.324"
for r in magic:$MAGIC_COMMIT netgen:$NETGEN_COMMIT open_pdks:$OPEN_PDKS_COMMIT; do
  git -C "${EDA}/src/${r%%:*}" checkout --quiet "${r##*:}"
done
docker rm aimem-lvs-build >/dev/null 2>&1 || true
docker run --name aimem-lvs-build --platform linux/arm64 -v "${EDA}:/work" -v "${EDA}/tmp:/tmp" -e HOME=/work/home \
  "${DEPS_IMAGE}" bash -euo pipefail -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends tcsh m4 tcl-dev tk-dev libcairo2-dev libx11-dev libncurses-dev libglu1-mesa-dev >/dev/null
    P=/work/tools/lvs
    cd /work/src/magic && ./configure --prefix=$P --without-opengl >/work/logs/magic-configure.log 2>&1 \
      && make -j8 >/work/logs/magic-build.log 2>&1 && make install >>/work/logs/magic-build.log 2>&1
    cd /work/src/netgen && ./configure --prefix=$P >/work/logs/netgen-configure.log 2>&1 \
      && make -j8 >/work/logs/netgen-build.log 2>&1 && make install >>/work/logs/netgen-build.log 2>&1
    # sky130A tech files, preprocessed exactly as open_pdks does (sky130/Makefile.in SKY130A_DEFS)
    T=$P/sky130A; mkdir -p $T
    cd /work/src/open_pdks/sky130
    DEFS="-DTECHNAME=sky130A -DREVISION=1.0.608 -DMETAL5 -DMIM -DREDISTRIBUTION"
    python3 ../common/preproc.py $DEFS magic/sky130.tech $T/sky130A.tech
    python3 ../common/preproc.py $DEFS netgen/sky130_setup.tcl $T/sky130A_setup.tcl
    apt-get clean && rm -rf /var/lib/apt/lists/*
    $P/bin/magic --version; ls $P/bin; ls -la $T'
docker commit aimem-lvs-build "${LVS_IMAGE}" >/dev/null && docker rm aimem-lvs-build >/dev/null
echo "built ${LVS_IMAGE}"
