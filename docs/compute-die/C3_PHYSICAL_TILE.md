# C3 Result: The A1 Tile in Silicon Layout, and the 3 nm Projection

**Status (27 September 2026):** C3's exit criteria are met. The A1 tensor tile (`a1_mma_tile`, RTL commit `317c297`, unchanged since C2) was placed and routed on three open process kits with a native arm64 build of OpenROAD-flow-scripts:

- sky130 passes DRC and LVS, with timing from OpenSTA.
- ASAP7 routes with zero violations.
- A 3 nm-class projection is labelled `modeled`, with its method and band.

Everything ran on the Mac with open-source tools only; build and run history is in [`OPS_LOG.md`](../OPS_LOG.md).

## Exit criteria

| Criterion | Result |
|---|---|
| sky130: DRC 0 | **Met.** KLayout DRC with the ORFS sky130hd deck: 0 items (43 min) |
| sky130: LVS match | **Met, with one qualification.** Netgen: "Circuits match uniquely", with 257,481 devices and 296,087 nets on each side. Six library cell types (`a2111oi_2`, `a211oi_4`, `a21boi_2`, `a21oi_2`, `ha_4`, `o211a_4`) use their layout-extracted definitions (see LVS below). For those six, LVS checks instance connectivity, not cell internals. Every other cell and all of the tile's wiring are checked at transistor level |
| sky130: timing from OpenSTA | **Met.** 19.5 MHz; the slowest path is stage 2 |
| ASAP7: routes cleanly | **Met.** Detailed routing 0 violations; equivalence proved after repair and at the end |
| Projection labelled `modeled`, with method and band | **Met.** [`c3-projection-3nm.json`](../../design/physical/projection/c3-projection-3nm.json), made by [`project_3nm.py`](../../tools/physical/projection/project_3nm.py), checked by `tests/c3-projection.test.ts` (6 tests; one planted error caught) |

## Measured results

| | sky130hd (130 nm, manufacturable) | ASAP7 (7 nm, predictive) | GT2N (2 nm, predictive) |
|---|---|---|---|
| Stage reached | Fully signed off (DRC, LVS) | Fully routed | Global routing (see below) |
| Clock | 19.5 MHz | 141.1 MHz typical corner (196.7 MHz best case) | 368.5 MHz (global-route estimate) |
| Standard-cell area | 2.42 mm² | 0.0345 mm² | 0.0111 mm² |
| Cells | 352,816 | 334,972 (757,230 with fill) | 393,905 |
| Power, default activity | 1.17 W at 25 MHz | 0.566 W at 250 MHz (typical) | 0.19 W at 400 MHz |
| Equivalence (kepler-formal) | Identical, after repair and at the end | Identical, after repair and at the end | Identical, after repair |
| Slowest path | Stage 2: 17-term align and sum | Stage 2 | Stage 2 |

On every kit the slowest path is stage 2, the exact 17-term align-and-sum. Re-balancing the pipeline is the clearest speed lever (C4).

## The 3 nm-class projection (`modeled`: predictive, not foundry)

The method was fixed in C0: run the same tile on ASAP7 and GT2N, then adjust the range between them by IRDS pitch ratios. In IRDS notation (gate pitch, tightest metal pitch):

- ASAP7 is G54M36.
- GT2N is G42M24.
- The IRDS 2023 "3nm+" node is **G48M24** ([More Moore, Table MM-7](https://irds.ieee.org/images/files/pdf/2023/2023IRDS_MM.pdf)).

How each quantity is projected:

- **Area.** Each measured tile is scaled by the ratio of gate pitch × metal pitch. From ASAP7 (7.5 tracks, frontside power) this gives the high bound; from GT2N (6 tracks, backside power) the low bound.
- **Clock and energy.** These interpolate in log space between the two kits: the central value uses the combined pitch product, and the band uses gate pitch alone and metal pitch alone.

| Quantity (one tile) | Low | Central | High |
|---|---|---|---|
| Cell area | 0.0127 mm² | 0.0161 mm² | 0.0205 mm² |
| Clock | 221 MHz | 303 MHz | 369 MHz |
| Energy per cycle | 476 pJ | 653 pJ | 1,090 pJ |

| Format | Peak per tile (central) | TFLOPS per W (worst / central / best) | TFLOPS per mm² (central) |
|---|---|---|---|
| BF16 | 0.039 TFLOPS | 0.12 / 0.20 / 0.27 | 2.4 |
| FP8 | 0.078 TFLOPS | 0.24 / 0.39 / 0.54 | 4.8 |
| FP4 | 0.155 TFLOPS | 0.47 / 0.78 / 1.08 | 9.6 |

**What this means for C1.** C1 fitted Blackwell's chip-level BF16 efficiency at 1.25 TFLOPS per W. This tile's central BF16 figure is 0.20 TFLOPS per W, about 6× lower, and it covers the tile alone, before any memory or interconnect. That gap is a result, not a rounding error. Three parts of it are known:

- The power uses OpenSTA's default switching activity, not a workload trace.
- The design has no clock gating.
- The tile's exact multi-format datapath spends about 10 pJ per BF16 multiply-add.

Measuring real activity from the cosimulation, and then lowering the energy, is the work of C4. Until then, C1's A1 TFLOPS-per-W stays a stated assumption, now with this measured bracket beside it.

**Caveats carried in the JSON:**
- GT2N stopped after global routing, so its clock end is optimistic.
- ASAP7 was optimized at its best-case corner and re-timed at typical, so its clock end is pessimistic.
- Energy per cycle is taken as the same for every format.

## Toolchain, and what failed on the way

| Item | Outcome |
|---|---|
| Native arm64 ORFS (commit `2d29bdaf8`) | Built from source on a case-sensitive APFS image on the Extreme Pro, after five attempts. Bazel's hermetic toolchain could not link Qt on aarch64, so OpenROAD is built with CMake and GCC, like the pinned x86 image. Its default remote cache (a third-party service) is off |
| Rosetta workaround removed | The equivalence check (kepler-formal) now runs natively; T0 had to disable it |
| sky130 run 1 | Global routing failed on congestion: a 10 ns target made timing repair grow the design from 40% to 59% |
| sky130 run 2 | Detailed routing stalled at 93 violations. A power stripe sat 0.68 µm from 560 edge pins; the fix was widening the core margin from 2 to 10 µm |
| sky130 antenna repair | 6,286 diodes over 5 rounds; 38 nets and 43 pins remain flagged. Antennas are not a C3 criterion |
| KLayout LVS | Its netlist compare runs on one core and did not finish in 6.8 h, or in 2.8 h with net-name labels. Both runs were stopped at the owner's direction |
| GT2N detailed routing | Needs more than the 39 GB Docker VM: it peaked at 38.6 GB with both 8 and 4 threads. Results stop at global routing |
| Drive disconnect | Both external drives dropped once mid-run. The disk image verified clean, and the runs resumed from their last completed stage |

## LVS in detail

The sign-off LVS is Magic 8.3.684 plus Netgen 1.5.324, built from source, with the sky130A tech files generated by open_pdks 1.0.608's own preprocessor. On the `gcd` test design it first matched KLayout's pass ("Circuits match uniquely").

It needed renames only (`lvs-netgen/normalize.py`), because ORFS's CDL and Magic name the same devices differently:
- the schematic's transistors are rewritten into sky130's device form;
- the tie cell's 0-ohm resistors become the layout's poly resistors;
- Magic's `special_nfet_01v8` becomes `nfet_01v8`.

Six cell types model folded transistor stacks differently in the ORFS CDL. The CDL has one series pair with `m=2` and a shared middle node; the SkyWater layout has two separate stacks. `lvs-netgen/library_cells.py` takes those six cells' definitions from their layout netlists, keeping the schematic's pin order. A first attempt did not keep it and scrambled the instances; that was caught and fixed.

## The layout in 3D (Silicon macro view, "A1 layout")

The Silicon macro view has a second mode, **A1 layout**, next to the illustrative model. It draws this sky130hd tile as routed: every wire, via, supply rail, strap, and placed cell comes from the final DEF (`6_final.def` of run `sky130hd-20260927T144910Z`), and each cell's own transistors, contacts, li1, and met1 come from the SkyWater `sky130_fd_sc_hd` library GDS. Layer heights are the PDK's own, from the sky130A Magic tech file (for example met1 at 1.3761 µm and 0.36 µm thick). Heights are to scale; nothing is exaggerated.

`tools/physical/layout-export/export-layout.ts` makes the data in `public/layouts/a1-sky130hd/`. It uses Node only, no third-party packages. It reads the DEF, LEF, and GDS with its own small parsers and cuts the tile into 64 µm tiles that the view streams as you zoom. It stores three things as rules instead of shapes, and before it writes anything it checks each rule against the DEF for every instance:

| Rebuilt, not stored | Rule | Check |
|---|---|---|
| Filler cells | Every gap in every row is filled greedily: `fill_8`, then 4, 2, 1, left to right | All 671,016 fillers rebuilt exactly (937 of 937 rows) |
| Supply via stacks | A via2/via3/via4-to-met4 stack at each crossing of a met4 strap and a met1 rail of the same supply | All 88,172 crossings rebuilt exactly; no other supply via is left over |
| Which net each cell pin is on | The metal that lands on the pin's shape (an mcon pad or a met1 wire) | 908,706 pins found on the metal, 3,652 unconnected, **0** disagree with the DEF |

The exporter also checks that every tile decodes back to exactly the shapes it was given.

The view shows:

- **Tile:** the met5/met4 power grid over real per-layer coverage. It also shows where each of the 16 dot-product units' registers landed; the RTL's own bus layout assigns every flip-flop to a unit (for example `s2_terms[306k +: 306]`).
- **Region and Routing:** the routed met1–met4 signal nets, with the cells colored by kind.
- **Cells:** li1 and met1 inside the standard cells, labelled with their real instance names.
- **Transistors:** diffusion, poly gates, contacts, and the n-well.

Clicking a wire gives its real net name, length, vias, and layers, plus the pins it joins (driver first), all read off the metal. Clicking a cell gives its instance, its function, and each pin's net. Pulses on a signal net start at the pin that drives it and run outward. Where the driver is not loaded, the wire stays dark rather than pulse the wrong way. The pulse timing is not simulated.

Size: the data totals 25.7 MB across 1,900 files. The largest share is the tiles (20.5 MB, in 5 nm units, stored as deltas along each net's route). A view downloads only what it shows: 1.2 MB for the whole tile, about 3–4 MB after zooming into a region. `tests/a1-layout.test.ts` checks the format round trip, the three rules above, the cell-name decoding, and that the shipped data is complete and uses the PDK's layer stack. It caught a planted decoder bug.

To regenerate after a new run:

```
node --experimental-strip-types --max-old-space-size=14000 tools/physical/layout-export/export-layout.ts \
  --def <EDA>/runs/a1_mma_tile/<run>/results/sky130hd/a1_mma_tile/base/6_final.def \
  --platform <EDA>/src/OpenROAD-flow-scripts/flow/platforms/sky130hd \
  --tech <EDA>/tools/lvs/sky130A/sky130A.tech \
  --run <run> --out public/layouts/a1-sky130hd
```

## Files

- Configs: `design/physical/orfs/a1_mma_tile/{sky130hd,asap7,gt2n}/`
- Toolchain and runs: `tools/physical/orfs-arm64/`, which holds:
  - `build.sh` and `run-tile.sh`, including a `RESUME` option
  - `lvs-netlabels/`
  - `lvs-netgen/`
- Projection: `design/physical/projection/`, `tools/physical/projection/project_3nm.py`, `tests/c3-projection.test.ts`
- Runs and layouts (not in git): the `aimem-eda` image on the Extreme Pro, under `runs/a1_mma_tile/`
- The layout as the Silicon macro view draws it: `public/layouts/a1-sky130hd/`, made by `tools/physical/layout-export/`; the viewer is `app/components/SiliconLayoutView.tsx` and `app/components/silicon/layout-engine.ts`, over `lib/a1-layout-format.ts`, `lib/a1-layout-scene.ts`, and `lib/a1-layout-parts.ts`
