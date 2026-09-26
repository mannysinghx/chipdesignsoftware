# C0 Research Dossier: AIMEM-A1 Compute Die

**Date:** 26 September 2026
**Step:** C0 of [`COMPUTE_DIE_PLAN.md`](../COMPUTE_DIE_PLAN.md)
**Evidence class:** `planned`. This is research. Nothing here is executed, modeled, or measured by this project.
**Machine-readable companion:** [`design/spec/compute-die-targets.json`](../../design/spec/compute-die-targets.json), checked by `tests/compute-die-targets.test.ts`

## How this was researched

Three research agents surveyed vendor pages, papers, benchmark repositories, and GitHub on 2026-09-26. The lead author then re-checked, from the primary sources, every number that became a calibration target:
- the HGX, DGX B200, and H100 pages, including their sparse and dense footnotes
- all 16 MLPerf rows in the targets file, recomputed from the MLCommons summary files
- the GEMM and bandwidth figures in the ThunderKittens, Hopper-microbenchmark, and B200-roofline papers
- the Accel-Sim 2.0 and Ten-Four papers

Confidence labels: **high** = primary source, checked; **med** = primary source with a caveat, or a reputable third party; **low** = a single secondary source. Anything unverified says so.

---

## 1. Findings that shape the design

1. **LLM serving is limited by memory, not compute, and the measurements show it.**
   - HGX B300 has 1.5× the FP4 peak of HGX B200, the same FP8 and BF16 peaks, and the same 8 TB/s bandwidth. On MLPerf Llama 2 70B Offline it is only **1.11×** faster (112,954 vs 101,527 tokens/s per 8-GPU system; rounds 6.0-0073 and 5.1-0069).
   - The Rubin preview (MLPerf v6.1, DeepSeek-R1 Offline) delivers **16,435 tokens/s per GPU against GB300's 9,441 (1.74×)**. That is less than either its compute gain (dense FP4 about 2.3×) or its bandwidth gain (up to 2.75×).
   - Raw FLOPS is the easiest thing to match on paper and the least decisive. Bytes moved per token, which is AIMEM's premise, decides the outcome.
2. **Datasheet rooflines are 1.5 to 2× too optimistic.**
   - B200 sustains 1,100–1,400 of 2,250 TFLOPS (BF16 dense) and 6.8–7.1 of 8 TB/s ([arXiv 2605.04178](https://arxiv.org/abs/2605.04178), med).
   - H100 GEMMs reach about 78–81% of peak with the best kernels (ThunderKittens: 797 TF at 16384³, 767 TF at 4096³; [arXiv 2410.20399](https://arxiv.org/abs/2410.20399)).
   - The C1 model therefore calibrates on sustained, measured data and must pass a held-out chip before it may say anything about A1.
3. **KV-cache attention stays bandwidth-bound at every batch size.**
   - Weights are shared across a batch; each request's KV cache is not.
   - With GQA group g and 1-byte KV, decode attention does about 2g FLOP per byte (16 FLOP/B for Llama 2 70B, 32 for Llama 3.1 405B). Every chip's ridge point is in the hundreds to thousands.
   - NVIDIA's own Rubin platform now splits the work: prefill on Rubin CPX (GDDR7), attention with the KV cache on Rubin HBM, and MoE FFNs on Groq 3 LPX SRAM ([NVIDIA LPX blog](https://developer.nvidia.com/blog/inside-nvidia-groq-3-lpx-the-low-latency-inference-accelerator-for-the-nvidia-vera-rubin-platform), med: verified by the survey agent only). AIMEM's near-memory KV management targets exactly that split.
4. **Vendor figures need care.** Several traps were caught in C0 and are now encoded as rules in the targets file:
   - sparse figures quoted as headline numbers
   - two B200 power bins about 10% apart (HGX vs GB200)
   - NVIDIA's own pages disagreeing on Rubin: 22 vs 19.2 TB/s, and 3.6 vs 3.0 TB/s NVLink
   - a microbenchmark paper whose results exceed the dense peak ([arXiv 2512.02189](https://arxiv.org/abs/2512.02189), excluded)

**Ridge points** (dense peak ÷ peak bandwidth, FLOP per byte), computed from the targets file:

| Chip | BF16 | FP8 | FP4 |
|---|---|---|---|
| H100 SXM | 295 | 591 | — |
| B200 (HGX) | 281 | 563 | 1,125 |
| B300 (HGX) | 281 | 563 | 1,688 |
| MI355X | 313 | 625 | 1,263 |
| Rubin (22 TB/s, dense) | 182 | 795 | 1,591 |

---

## 2. Reference chips

Every figure, with source and confidence, is in the targets file. Summary (dense peaks per package):

| Chip | Role | FP4 | FP8 | BF16 | Memory | Bandwidth | Power |
|---|---|---|---|---|---|---|---|
| H100 SXM | calibration | — | 1,979 TF | 989.5 TF | 80 GB | 3.35 TB/s | 700 W |
| H200 SXM | calibration | — | 1,979 TF | 989.5 TF | 141 GB | 4.8 TB/s | 700 W |
| **B200 (HGX)** | **calibration + primary target** | 9 PF | 4.5 PF | 2.25 PF | 180 GB | 8 TB/s | ~1,000 W (low) |
| B300 (HGX) | **held out** | 13.5 PF | 4.5 PF | 2.25 PF | 270 GB | 8 TB/s | ~1,100 W (low) |
| Rubin | stretch target | 35 PF (50 PF quoted sparse) | 17.5 PF | 4 PF | 288 GB | 22 TB/s (conflict: 19.2) | not published |
| MI355X | comparator | 10.1 PF | 5 PF | 2.5 PF | 288 GB | 8 TB/s | 1,400 W |
| TPU v7 Ironwood | comparator | — | 4.6 PF | 2.3 PF | 192 GiB | 7.38 TB/s | not published |

Per-SM rates, derived by the research agent (med):
- **H100:** 4,096 BF16 FLOP per clock per SM at an implied 1.83 GHz tensor clock.
- **B200:** 8,192, from Chips and Cheese's measured 1,024 MACs per clock per sub-partition, at an implied 1.86 GHz.
- **B300:** 49,152 FP4 FLOP per clock per SM, 3× its FP8 rate (B200's ratio is 2×).
- **Rubin:** has 224 SMs, but no clock is published, so no per-clock rate can be derived.

**Not found anywhere:** die areas for B200, B300, Rubin, MI355X, and Ironwood; L2 size for B300 and Rubin; Rubin's clock and TDP. Per-mm² comparisons with these chips are therefore not possible yet.

---

## 3. Mechanisms to borrow, ranked

This is from the architecture survey; the survey's full citations are listed with each row's source. Complexity is for RTL; "open PDK" says whether a small-scale prototype is possible on sky130 or ASAP7.

| # | Mechanism | From | Bottleneck removed | Complexity | Open PDK |
|---|---|---|---|---|---|
| 1 | Descriptor-driven async tensor DMA with barrier completion; its descriptors target AIMEM gather and prefetch | Hopper TMA | Address-generation overhead; copy/compute overlap | Med | Yes |
| 2 | Matrix array with a dedicated accumulator memory, not the register file | Blackwell TMEM (256 KB/SM), TPU MXU, AMX/SME tiles | Register-file bandwidth and energy | Med | Yes (8×8–16×16) |
| 3 | Native microscaled MMA (MXFP8, MXFP4, NVFP4) | OCP MX spec, Blackwell | Bytes per parameter; multiplier area | Med | Yes |
| 4 | Large software-managed SRAM scratchpad instead of coherent caches | TPUv4i CMEM (1.7–2.2× on production apps), Groq, Tenstorrent | HBM traffic; nondeterminism | Low–Med | Yes |
| 5 | Separate sequencers for data movement, compute, and pack/unpack | Hopper warp specialization; Tensix's 5 RISC-V cores | Pipeline bubbles | Med | Yes |
| 6 | Tile array on a 2D NoC with hardware multicast | Tenstorrent, Cerebras, Dojo | Operand duplication; weight broadcast | Med–High | Yes (2×2–4×4) |
| 7 | Fused exponent/softmax unit beside the matrix unit | Blackwell Ultra (2× SFU exp, 10.7 T/s) | Non-GEMM attention time once GEMMs are fast | Low–Med | Yes |
| 8 | Splittable matrix array for small-M decode GEMMs | MatX; TPU MXU count vs size | Low utilization at small batch and per MoE expert | Med | Yes |
| 9 | Small in-order RISC-V control cores (no out-of-order execution) | Tenstorrent, Dojo | Host round trips; launch latency | Low | Yes |
| 10 | On-die collective and RDMA engine | Gaudi 3 (24×200 GbE on die), NVIDIA SHARP, DeepSeek's hardware asks | Compute cycles spent on communication; MoE all-to-all | High | Logic only (no SerDes) |
| 11 | Inline decompression at the consumer, paired with AIMEM's base-die compression | Blackwell decompression engine, A100 compute data compression | Effective bandwidth and capacity | Med | Yes |
| 12 | Descriptor interface to near-memory gather/scatter, with the work done on AIMEM | TPU SparseCore (5–7× on embeddings for 5% of die), TPUv4i | Irregular KV, embedding, and MoE access | Med | Yes |
| 13 | Cluster-shared scratchpad and two-tile cooperative MMA | Hopper DSMEM, Blackwell `cta_group::2` | L2 traffic; operand duplication | Med–High | Partial |
| 14 | Compiler-static, deterministic scheduling mode for decode | Groq | Tail latency; control overhead | Low HW / High compiler | Yes |
| 15 | Coherent chip-to-chip host link with shared page tables | Grace/Vera NVLink-C2C | Copies; host memory as a capacity tier | High | No (PHY) |

**Deliberately not borrowed:**
- **Out-of-order execution, branch prediction, and SMT in the datapath.** TPUv1 spent 2% of its die on control ([Jouppi, ISCA'17](https://arxiv.org/abs/1704.04760)).
- **Deep coherent cache hierarchies inside the compute array.**
- **DPU front-end functions:** NVMe-oF, TLS/IPsec, SDN, and multi-tenant isolation. They belong on a separate DPU, as with NVIDIA BlueField-4 and AMD Pensando.

**Area guidance** from published breakdowns:
- TPUv1: buffers 37%, compute 30%, I/O 10%, control 2%.
- TPUv4i: CMEM is 28% of the die.
- Heuristic: about a third each for SRAM and math, with 10–25% for PHY and SerDes. H100 and B200 have no vendor breakdown.

### Architecture direction: confirmed, with three additions

The direction in plan section 5 holds. C0 adds:
1. **An accumulator memory per tile** (mechanism 2). This is the main difference between Blackwell and Hopper.
2. **A fused softmax/exponent unit** (mechanism 7). Once GEMMs are fast, attention's non-GEMM time dominates.
3. **A splittable array** (mechanism 8), because the target workloads include small-batch decode and MoE experts, where large fixed arrays idle.

A1's differentiator stays mechanisms 1, 11, and 12: compute-die descriptors that hand gather, prefetch, KV placement, and compression to AIMEM's base die.

---

## 4. Open building blocks

The pinned toolchain is Yosys, Icarus, Verilator, SymbiYosys, cocotb, and OpenROAD-flow-scripts (ORFS). Chisel generators need a JVM, sbt or mill, and firtool, plus disk space the machine does not have now, so they are deferred.

| Block | Use in A1 | License | State | Fit with pinned tools | Decision |
|---|---|---|---|---|---|
| **Vortex tensor core "Ten-Four"** ([arXiv 2512.00053](https://arxiv.org/abs/2512.00053), [Vortex](https://github.com/vortexgpgpu/vortex)) | Fused mixed-precision dot-product unit: TF32, FP16, BF16, FP8, BF8, INT8, INT4, and MX, with FP32/INT32 accumulation | Vortex repo Apache-2.0; the paper is CC-BY-4.0 | 7 nm FinFET synthesis at 1.58 GHz (paper abstract). The survey agent reported ASAP7 at 1.571 GHz and 1,960 µm², unverified | SystemVerilog; Vortex ships sv2v and Yosys scripts | **C2 datapath candidate.** At C2 start, confirm the code location (a non-default branch was reported), its license header, and the FP8 E4M3/E5M2 encodings |
| **RedMulE** ([arXiv 2301.03904](https://arxiv.org/abs/2301.03904), [repo](https://github.com/pulp-platform/redmule)) | Standalone FP16/FP8 GEMM engine | SHL-0.51 (hardware) | 22 nm post-layout: 0.15 mm², 58.5 GFLOPS at 613 MHz, 755–920 GFLOPS/W | SystemVerilog + Bender; needs sv2v or yosys-slang | **C2 baseline** to compare the A1 tile against |
| MXCore ([repo](https://github.com/pulp-platform/MXCore)) | MX matrix-multiply reference | Apache-2.0 | Created 2026-09-15; no paper | SystemVerilog | Cross-check only; too new to build on |
| Precision-Scalable_MX ([repo](https://github.com/KULeuven-MICAS/Precision-Scalable_MX)) | MX MAC units | **None** | — | — | **Excluded:** no license, so not legally reusable |
| **Ibex** | Tile control core (C5) | Apache-2.0 | Silicon-proven; already an ORFS sky130hd design | Direct | **C5 control core** |
| Snitch cluster ([repo](https://github.com/pulp-platform/snitch_cluster)) | Later control/compute cluster | SHL-0.51 + Apache-2.0 | Silicon in Occamy (GF 12 nm) | yosys-slang shown working ([arXiv 2505.10060](https://arxiv.org/abs/2505.10060)) | Later option |
| **OpenPiton `dynamic_node`** | 2D mesh NoC router (C5) | BSD-3 (router; the OpenSPARC T1 parts are GPL-2.0 and not used) | Silicon in Piton (32 nm) | Already an ORFS design, pickled Verilog | **C5 NoC starting point** |
| FlooNoC ([repo](https://github.com/pulp-platform/FlooNoC)) | Wide-link AXI NoC | SHL-0.51 (hardware) | GF 12 nm implementation: 1.26 GHz, 0.15 pJ/B/hop | Needs yosys-slang | C5 upgrade if the router bottlenecks |
| Gemmini, Constellation, BOOM | Systolic generator, NoC generator, out-of-order core | BSD-3 | Silicon (Gemmini: TSMC 16 nm, Intel 22FFL) | Chisel: JVM toolchain and disk | Deferred |
| NVDLA | Inference accelerator | Non-SPDX NVIDIA license | Dormant since 2022 | tmake preprocessing | **Excluded** |
| Tenstorrent Tensix | — | Not open source | — | — | Not available: Tenstorrent publishes only peripheral RTL (Ocelot vector unit, UCIe bridge, debug IP) |

**To verify before C5:** a DMA engine (PULP iDMA is the obvious candidate). yosys-slang is available through the pinned ORFS image's `SYNTH_HDL_FRONTEND=slang` (section 6).

---

## 5. Modeling tools

| Tool | Models | License | Validation against real hardware | Decision |
|---|---|---|---|---|
| **Own TypeScript model in `lib/`** | Roofline plus calibrated sustained-efficiency terms, per workload | project | Must pass the C1 exit criteria (calibration + held-out B300) | **C1 primary.** Same pattern as the 15 existing models: fast, tested with `node:test`, no disk or Docker |
| **GenZ** ([repo](https://github.com/abhibambhaniya/GenZ-LLM-Analyzer), MIT) | Analytical LLM compute, memory, and network | MIT | 8×H100: 2.73% prefill and 1.85% decode geomean error ([arXiv 2406.01698](https://arxiv.org/abs/2406.01698)) | **C1 independent cross-check** behind a sandboxed adapter |
| Accel-Sim 2.0 ([repo](https://github.com/accel-sim/accel-sim-framework), BSD-2) | Cycle-level GPU simulation (SASS traces) | BSD-2 | H100: 99% correlation, 13.4% mean absolute cycle error ([arXiv 2608.22602](https://arxiv.org/abs/2608.22602), checked). The abstract names Blackwell; the README says B200 support is coming | Deferred: needs traces from real GPUs and a lot of disk |
| FlashGPU-sim ([arXiv 2609.15311](https://arxiv.org/abs/2609.15311)) | Cycle-level RTX 5090, H100, B200 | code license unverified | 5.24% cycle MAPE (to appear at MICRO 2026) | Watch; not usable until the code and license are confirmed |
| Timeloop + Accelergy ([Timeloop](https://github.com/NVlabs/timeloop), BSD-3; [Accelergy](https://github.com/Accelergy-Project/accelergy), MIT); AccelForge ([arXiv 2609.11906](https://arxiv.org/abs/2609.11906)) | Tile dataflow mapping, energy, area | BSD-3 / MIT | Eyeriss- and NVDLA-class designs, not GPUs | **C2–C4:** score tile dataflows and give the L1 loop an energy term |
| SCALE-Sim v3 ([repo](https://github.com/scalesim-project/scale-sim-v3), MIT) | Cycle-accurate systolic arrays, with Ramulator DRAM | MIT | None published against hardware | Alternative to Timeloop for systolic tiles |
| ASTRA-sim 2.x ([repo](https://github.com/astra-sim/astra-sim), MIT) | Collectives and distributed training | MIT | HGX-H100 NCCL all-reduce: 9.7–20.6% geomean error | C5, for the collective engine |
| Ramulator 2 ([repo](https://github.com/CMU-SAFARI/ramulator2), MIT) | Cycle-level DRAM; supports HBM4 | MIT | — | Already built locally for AIMEM; reuse for A1 memory traffic |
| Vidur, LLMCompass, LLM-Viewer, aiconfigurator | Serving simulation; analytical; roofline only; NVIDIA's own tool | MIT; BSD-3; MIT; Apache-2.0 | Vidur <9% (A100/H100); LLMCompass 4.1% end-to-end on A100; LLM-Viewer none; aiconfigurator none published | Not chosen: GenZ covers the same ground with better-validated Hopper results |

---

## 6. Process kits

**What the pinned toolchain has** (`platform/toolchains.lock.json`):
- The image is `openroad/orfs:26Q3-605-g2d29bdaf8`, built from ORFS commit [2d29bdaf8](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/tree/2d29bdaf8/flow/platforms) (2026-09-22).
- That commit ships the platforms `asap7`, `gf180`, `gt2n`, `ihp-sg13g2`, `nangate45`, and `sky130hd/hs`, and its `.dockerignore` excludes none of them. This was read from the source tree; the image itself was not inspected, so confirm at C3.
- It supports `SYNTH_HDL_FRONTEND=slang` (yosys-slang), which PULP-style SystemVerilog needs.
- It has **no** JVM, sbt, mill, or firtool.

| PDK | License | Manufacturable | Role |
|---|---|---|---|
| sky130hd | Apache-2.0 | Yes (SkyWater 130 nm) | C3 executed tile; the T0 channel already runs here (169.5 MHz, DRC/LVS clean) |
| ASAP7 | BSD-3-Clause | **No:** predictive 7 nm (2016). Its SRAMs are FakeRAM abstracts, so scratchpad PPA there is a placeholder | C3 low end of the advanced-node bracket |
| **GT2N** | BSD-3-Clause | **No:** predictive 2 nm nanosheet with backside power (ISCAS 2026), added to ORFS 2026-06-15 | C3 high end of the bracket |
| gf180, IHP sg13g2 | Apache-2.0 | Yes | Not needed now |
| nangate45 | Apache-2.0 (ORFS platform) | No | Not needed |

**Scaling to 3 nm-class (method chosen).** Published scaling tools stop at 7 nm. DeepScaleTool covers 130→7 nm with 1.7% area, 2.5% delay, and 5% power error ([arXiv 2102.10195](https://arxiv.org/abs/2102.10195)); Stillmaker & Baas covers 180→7 nm. Neither reaches 3 nm. C3 therefore:
1. runs the same tile on **ASAP7 and GT2N**, both in the pinned image;
2. reports the 3 nm-class estimate as the range between them, adjusted by IRDS pitch ratios ([2023 More Moore](https://irds.ieee.org/images/files/pdf/2023/2023IRDS_MM.pdf));
3. labels it `modeled`, "predictive, not foundry".

**Needs a platform change at C3:** the `physical.orfs` adapter is hard-wired to `aimem_t0_channel` on sky130hd.

## 7. C0 exit criteria

| Criterion | Status |
|---|---|
| Every reference number has a source URL and a dense/sparse flag, enforced by test | **Met.** `tests/compute-die-targets.test.ts`: 9 tests. A mutation check planted four errors (wrong sparse value, held-out chip leaking into calibration, unknown source, low-confidence data calibrating); all four were caught |
| The benchmark set is precise enough for C1 to compute | **Met.** GEMM square and transformer shapes, prefill and decode attention, and four serving scenarios, all derived from pinned model configs; a test checks the derivations |
| Open blocks and tools chosen, with licenses | **Met,** with two items left to verify before C5 (DMA engine, yosys-slang availability) |
| Architecture direction confirmed or revised | **Met.** Confirmed, with three additions (section 3) |

**Open items carried forward:**
- Owner decision 3 (disk or worker) before C3.
- Owner decision 4 (hosted-model spend ceiling).
- Die areas for B200, B300, and Rubin, needed for per-mm² comparisons and not published.

## 8. Next step (not started)

C1, the calibrated performance model, starts only when the owner asks. Its tolerances and held-out set are fixed in the targets file now. Changing them after C1 starts needs the owner's approval, like any other evaluator change.
