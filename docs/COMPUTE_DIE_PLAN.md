# AIMEM-A1: an AI Compute Die Built and Improved by Agents

**Plan date:** 26 September 2026
**Status:** C0 (research and targets) done on 26 September 2026: all four exit criteria met (see [C0 status](#c0-status-2026-09-26)). C1 versions 1 and 2 were built and evaluated the same day. Version 2 adds a power ceiling. All three Offline held-out rows (GB300 NVL72, MI355X) are within 20%, but two Server rows are not, so the model **still fails its held-out check** and may not be used for A1 claims (see [C1 status](#c1-status-2026-09-26-version-2)). The next C1 step is the owner's choice; C2 to C6 are proposed.
**Extends:** [`RSI_PLATFORM_PLAN.md`](RSI_PLATFORM_PLAN.md). That plan builds the machinery that lets agents improve designs (L1), themselves (L2), and their models (L3). This plan adds what they build next: a compute die that pairs with the AIMEM memory stacks. It also sets the autonomy policy for running those loops unattended.

---

## 1. Goal, and what "as fast as NVIDIA" can mean here

**Goal:** agents research existing CPUs, GPUs, DPUs, and AI accelerators, then design an AI compute die (working name **AIMEM-A1**) whose architecture matches a current NVIDIA part on the same workloads. They keep improving the die, the platform, and the 3D view from verified feedback.

**What can and cannot be claimed.** Performance equal to a shipping NVIDIA GPU depends on manufacturing that no design platform provides:
- a leading-edge foundry node (NVIDIA Rubin: 336 billion transistors, 3 nm-class)
- CoWoS-class packaging
- HBM supply
- commercial signoff tools
- a tape-out budget in the hundreds of millions of dollars

This platform has open PDKs only (sky130 today; ASAP7, a predictive 7 nm kit that cannot be manufactured, later). On sky130 the T0 channel reached 169.5 MHz; NVIDIA parts run near 2 GHz at roughly 1,000× the transistor density.

So "as fast as" is defined as three claims, each with its own evidence class. The existing evidence policy applies unchanged: nothing upgrades `modeled` to `executed`, and nothing becomes `measured` without silicon.

| Claim | How it is shown | Evidence class |
|---|---|---|
| The performance model is trustworthy | It reproduces published and **measured** NVIDIA numbers (GEMM efficiency, MLPerf per-GPU throughput) within stated tolerances, and predicts a held-out chip it was not calibrated on | modeled, calibrated |
| AIMEM-A1 matches the target on paper | The same calibrated model, run on the A1 architecture at a 3 nm-class projection, meets the target on the sealed benchmark set | modeled |
| The building blocks are real | Tile RTL passes simulation against a golden model and formal checks, and goes through place-and-route on open PDKs | executed (public PDK) |

**Never claimed:** that A1 "is as fast as" an NVIDIA chip in silicon, or any `measured` figure. UI labels and agent outputs must use the wording above; the evidence-class policy rejects anything else.

---

## 2. Decisions recorded 2026-09-26

The owner accepted the recommendations below in chat.

| # | Decision | Detail |
|---|---|---|
| 1 | **Autonomy** | Loops run unattended within hard budgets. People approve only promotions, spending or deploys, and boundary actions (section 4). |
| 2 | **Target** | NVIDIA **B200** per package is the calibration and primary target. **Rubin** is the stretch target. H100 and H200 are calibration points. B300 is held out to test the model's predictions (section 6, C1). |
| 3 | **Compute** | Nothing heavy runs until C3. The Mac's data volume is 97% full (34 GB free on 2026-09-26). Before C3, either free at least 100 GB or add a native x86-64 Linux worker. The worker is recommended because it also removes two recorded workarounds: Rosetta crashing ORFS's equivalence check (`LEC_CHECK=0`), and cocotb running on Icarus instead of Verilator. **Open:** which option. |
| 4 | **Model route** | Unchanged: local `qwen3.6:35b` by default. Hosted Claude only when the owner sets a key, a monthly spend ceiling, and a mission opts in. **Open:** the ceiling. Until one is set, hosted stays off. |

---

## 3. How this fits what exists

- **AIMEM is the memory; A1 is the compute.** AIMEM is a 3D-stacked DRAM with near-memory gather, prefetch, KV-cache management, and compression on its base die. Every AI chip's decode speed is bound by memory bandwidth. A1 is designed around AIMEM's interface and operations, which is the project's differentiator, instead of treating memory as a generic HBM port.
- **The 3D twin's accelerator is a placeholder today.** In C6 it becomes the A1 die, bound to executed tile results and modeled full-chip figures, each labeled.
- **The RSI loops are the "agents keep building it" part.** RSI Phases 0 to 2 are built (audit backbone, sandboxed EDA runs, real agents with approvals). Phase 3 (sealed evaluator plus L1 design evolution) is the prerequisite for C4. Phase 4 (L2 agent self-improvement) and Phase 5 (L3 fine-tuning) close the recursion. This plan does not duplicate them. It supplies their first large target and the benchmarks their evaluator scores.

---

## 4. Autonomy policy

**Runs unattended**, under the runtime-enforced token, spend, CPU-hour, and wall-clock ceilings from the RSI plan:
- research refreshes (new papers, new vendor figures) written as dossier proposals
- candidate generation: RTL diffs, flow parameters, architecture parameters, 3D-view changes in a worktree
- every verification and scoring run: simulation, formal, synthesis, place and route, the performance model, the UI smoke test, and frame-rate and glare checks
- archiving candidates with their scores and lineage
- scheduled cycles: L1 on every accepted design change, and L2 weekly (once built)

**Needs the owner's approval in chat**:
1. Promoting anything to `active`: an agent version, prompt, policy, or model weights; or a design candidate that replaces a baseline.
2. Merging to `main`. This deploys to Vercel production and runs CI.
3. Spending: enabling or raising the hosted-model route, cloud compute, or any purchase.
4. Changing the evaluator, benchmarks, held-out split, gate policies, or this autonomy policy. Agents can never write these (RSI invariant 1).
5. Boundary actions: foundry contact, NDAs, tape-out, any message sent outside the platform.
6. Editing existing RTL the owner has not approved changes to. For example, the known ECC-status defect in `rtl/aimem_t0_channel.sv` stays unfixed until the owner says so.

**Relaxing a class.** A narrow class, such as "promote a flow-parameter candidate that only changes ORFS knobs", may become automatic only after all of the following:
- at least 10 consecutive promotions in that class were approved without changes
- planted-shortcut probes for that class were blocked
- the owner approves the relaxation, which is recorded here and in `OPS_LOG.md`

Relaxations can be revoked at any time.

**Why not remove approval entirely:** a self-improving loop that promotes its own changes is the main route to reward hacking. The loop learns to satisfy the grader instead of the goal. The approvals above sit only at points where a wrong decision is expensive or hard to undo; everything between them runs unattended.

---

## 5. Architecture direction (provisional, finalized at the end of C0)

This design borrows mechanisms that shipping chips have proven. The C0 dossier ranks them with sources; the first draft is:

| From | Mechanism | Why |
|---|---|---|
| GPU | Streaming-multiprocessor tiles with tensor (matrix) units | Most FLOPS per mm² for dense matrix work, which dominates prefill and training |
| GPU | Asynchronous tensor DMA (TMA-style) and on-tile accumulator memory (TMEM-style) | Keeps matrix units fed without spending register-file bandwidth |
| GPU | Microscaled low-precision formats (MXFP8, MXFP4, NVFP4) | Doubles throughput per halving of bits, at acceptable accuracy |
| CPU | RISC-V control cores per cluster | Scheduling, synchronization, and exceptions without a host round trip. Out-of-order speculation stays out of the datapath |
| DPU | On-die RDMA and collective engine (in-network-reduction style) | Scale-out without a separate NIC in the critical path |
| TPU and dataflow chips | Systolic dataflow inside a tile, large distributed SRAM, compiler-scheduled movement | Energy per operation and predictable utilization |
| AIMEM | Near-memory gather, prefetch, KV management, compression | Cuts bytes moved per decode token, the actual limit for LLM inference |

---

## 6. Steps

Each step has testable exit criteria and is additive: existing views, models, tests, and evidence keep working.

### C0 status (2026-09-26)

**Built:** [`docs/compute-die/C0_RESEARCH_DOSSIER.md`](compute-die/C0_RESEARCH_DOSSIER.md), [`design/spec/compute-die-targets.json`](../design/spec/compute-die-targets.json), and `tests/compute-die-targets.test.ts` (9 tests; a mutation check planted four errors and all four were caught).

What C0 changed in this plan:
- **The architecture direction holds, with three additions:** an accumulator memory per tile, a fused softmax/exponent unit, and a splittable array for small-batch decode and MoE experts.
- **Measured data confirms the memory thesis.** HGX B300 has 1.5× B200's FP4 peak but the same bandwidth, and it is only 1.11× faster on MLPerf Llama 2 70B.
- **C1 calibrates on sustained, measured figures.** Datasheet rooflines overstate B200 by 1.5 to 2×.
- **Blocks and tools chosen:**
  - the Vortex "Ten-Four" dot-product unit as the C2 datapath candidate, with RedMulE as the baseline
  - Ibex and OpenPiton's router for C5
  - an in-repo TypeScript model for C1, cross-checked by GenZ
  - Timeloop/Accelergy for tile energy
  - Chisel generators deferred; NVDLA and an unlicensed MX library excluded

### C0: Research dossier and targets

**Build**
- `docs/compute-die/C0_RESEARCH_DOSSIER.md`: the architecture survey (GPU, CPU, DPU, TPU, dataflow chips), reference numbers, measured data, open RTL blocks, PDKs, and modeling tools, each with licenses. Every figure has a source; every FLOPS figure says dense or sparse; source conflicts are listed, not resolved silently.
- `design/spec/compute-die-targets.json`: machine-readable reference chips, the benchmark workloads, the metrics, and the calibration tolerances. Evidence class `planned`.
- `tests/compute-die-targets.test.ts`: checks the targets file for internal consistency (every number sourced, dense and sparse never mixed, precision ratios consistent, calibration and held-out sets disjoint).

**Exit criteria**
- Every reference number in the targets file has a source URL and a dense/sparse flag, enforced by the test.
- The benchmark set is defined precisely enough for C1 to compute it: GEMM shapes, attention shapes, and decode and prefill scenarios with model, batch, sequence length, and precision.
- Open blocks and tools are chosen, with licenses compatible with the project.
- The architecture direction in section 5 is confirmed or revised from the dossier.

### C1 status (2026-09-26, version 2)

Owner-approved held-out set: GB300 NVL72 and MI355X, declared before building. The model adds a power ceiling (the family's measured BF16 TFLOPS per watt × power rating × 16 ÷ operand bits) and fits no new parameters.

| Criterion | Result |
|---|---|
| Peaks | Met (MI355X within AMD's rounding) |
| Calibration | 9 of 10 within ±15% (H200 405B Server −18.9%) |
| Held out | **Failed:** 4 of 6 within ±20%. Offline +0.3%, +8.2%, +17.8%; Server −12.8%, +21.4%, +30.2% |

Power explains Blackwell's throughput; rack-scale Server behavior and AMD without calibration data do not fit. The options for qualifying a model are in [`C1_PERF_MODEL.md`](compute-die/C1_PERF_MODEL.md#what-would-qualify-a-model-for-a1-claims-needs-the-owners-decision) and need the owner's decision.

### C1 status (2026-09-26, version 1)

**Built:** [`lib/perf-model.ts`](../lib/perf-model.ts) (frozen at sha256 `9cf9786b…`), [`scripts/evaluate-perf-model.mjs`](../scripts/evaluate-perf-model.mjs), [`evidence/c1-perf-model.json`](../evidence/c1-perf-model.json), and `tests/perf-model.test.ts` (8 tests, including the check that calibration never reads the held-out chip). Full results: [`compute-die/C1_PERF_MODEL.md`](compute-die/C1_PERF_MODEL.md).

| Exit criterion | Result |
|---|---|
| Peaks reproduced exactly | Met: one implied tensor clock per chip, zero error |
| Calibration within tolerance | Partly met: 9 of 10 MLPerf rows within ±15%; H200 405B Server at −19.7% |
| Held-out B300 predicted and recorded | Recorded. **Failed:** +26.6% to +41.3% against ±20% |

**What it means:** throughput does not follow peak FLOPS. B300 has 1.5× B200's FP4 peak and delivers 1.11× the throughput; power is the most likely missing term. A1 must therefore be judged at a power budget. B300 is consumed as a held-out set. Version 2 needs a new held-out set, which is an evaluator change the owner approves before the model is built.

### C1: Calibrated performance model

**Build:** a roofline-plus-utilization model in `lib/` (TypeScript, like the existing 15 models) or a pinned open simulator behind a tool adapter (chosen in C0). It takes a chip description and a workload, and returns time, throughput, and bytes moved per operation.

**Exit criteria**
- Peak figures for H100, H200, and B200 are reproduced exactly from their microarchitecture parameters.
- Measured GEMM efficiency and MLPerf per-GPU throughput for the calibration chips are reproduced within the tolerances fixed in the targets file.
- **Held-out check:** with no retuning, the model predicts B300. The error is recorded whether it passes or not. A model that fails this check cannot be used to make claims about A1.

### C2: Tensor-tile RTL

**Build:** one tensor tile, starting from the open block chosen in C0. It covers MAC array, accumulator memory, and tile DMA, with FP8 (E4M3/E5M2) and BF16 inputs, FP32 accumulation, and MX scaling.

**Exit criteria**
- Bit-exact against a NumPy golden model on directed and random tests.
- Formal proofs on the control and handshake logic, with cover and vacuity checks.
- Verilator lint clean.
- Runs through the existing sandboxed adapters, so every run is audited and reproducible.

### C3: Physical tile on open PDKs, and the scaling projection

**Build:** the tile through OpenROAD-flow-scripts on sky130hd and ASAP7. A documented method projects area, frequency, and power to a 3 nm-class node, with an uncertainty band.

**Exit criteria**
- sky130: DRC 0 and LVS match, with timing from OpenSTA.
- ASAP7: routes cleanly.
- The projection is labeled `modeled` and carries its method and band.

**Needs:** decision 3 resolved (disk or worker).

### C4: Agents improve the tile (RSI L1)

**Build:** the tile becomes an L1 target once RSI Phase 3 (sealed evaluator) exists. Agents evolve tile, dataflow, and flow parameters; the sealed PPA grader scores them.

**Exit criteria**
- An evolved tile that passes the full regression and improves area, timing, or energy per operation over the C2/C3 baseline, promoted with the owner's approval.
- A planted "edit the testbench" shortcut is blocked and logged.

### C5: Reduced-scale full chip

**Build:** 4 to 16 tiles, RISC-V control cores, NoC, DMA, a collective engine, and an AIMEM channel interface.

**Exit criteria**
- One transformer layer (attention plus MLP) runs in simulation and matches the golden model.
- The C1 model's prediction for this reduced chip agrees with its simulated cycle count within tolerance. That closes the loop between the model and the RTL.
- Full-chip A1 figures are published only as `modeled` projections from this calibrated chain.

### C6: The 3D twin shows A1

The twin's accelerator placeholder becomes the A1 die. Tiles and blocks bind to executed results; full-chip figures bind to modeled projections; each is labeled.

---

## 7. Self-improving 3D view

Agents may propose 3D-view changes in a worktree at any time. A proposal can be promoted only if the grader passes, and agents cannot edit the grader:
- `npm run smoke:ui-audit`: every control logged, no failures
- frame-rate floors per zoom rung, measured headless on the M4 Max GPU (currently 409 to 644 fps uncapped)
- the glare metric (near-white share of the canvas over fixed poses), no higher than production plus a fixed tolerance
- screenshot diffs against owner-approved baselines
- the existing geometry and net tests (`tests/silicon-*.test.ts`)
- the **vetoed-changes list**: glare and bright lighting, random crossing vias, and sticky camera flags. Any change the owner rejects is added to the list, so no agent can bring it back.

Micro-agents that review screenshots and file feedback supply proposals, never verdicts. Merging still needs approval (section 4, item 2), because it deploys to production.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Modeled parity misread as real parity | Evidence classes; the wording rules in section 1; UI badges |
| A model tuned to fit rather than predict | Measured calibration data plus a held-out chip (B300) |
| Vendor figures quoted sparse vs dense, or in conflict | Dense/sparse flag enforced by test; conflicts listed in the dossier |
| Reward hacking in unattended loops | Sealed grader, planted probes, and approval at promotion |
| Disk and compute exhaustion | Hard budgets; nothing heavy before decision 3 is resolved |
| License incompatibility of borrowed RTL | Licenses recorded per block in C0; only permissive or compatible licenses |
| 3D-view regressions the owner already rejected | Vetoed-changes list in the grader |

---

## 9. Sources

Vendor and third-party sources are listed in the C0 dossier next to every figure. Headline figures used in this plan:
- NVIDIA Technical Blog, "Inside the NVIDIA Vera Rubin Platform": https://developer.nvidia.com/blog/inside-the-nvidia-rubin-platform-six-new-chips-one-ai-supercomputer/
- Rubin transistor count (secondary): https://tech-insider.org/nvidia-gtc-2026-rubin-gpu-analysis/
