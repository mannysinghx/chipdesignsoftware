# C1 Result: Calibrated Performance Model, Version 1

**Date:** 26 September 2026
**Step:** C1 of [`COMPUTE_DIE_PLAN.md`](../COMPUTE_DIE_PLAN.md)
**Evidence class:** `modeled`
**Files:**
- Model: [`lib/perf-model.ts`](../../lib/perf-model.ts), frozen at sha256 `9cf9786b…2de2`
- Evidence: [`evidence/c1-perf-model.json`](../../evidence/c1-perf-model.json)
- Tests: `tests/perf-model.test.ts`
- Regenerate: `npm run evaluate:perf-model`

## Outcome

Version 1 reproduces peaks exactly and fits 9 of 10 calibration rows within ±15%. It **fails its held-out check**: it overpredicts B300 by 27% to 41%. Under the plan's rule, this model may not be used to make any claim about A1. The failure is recorded, not tuned away. It points to a missing physical term, power, which is exactly the term A1's parity case depends on.

| Exit criterion | Result |
|---|---|
| Peaks for H100, H200, and B200 reproduced exactly from microarchitecture | **Met**, for B300 as well. One implied tensor clock per chip reproduces BF16, FP8, and FP4 with zero error: H100/H200 1.830 GHz, B200 1.856 GHz, B300 1.717 GHz. NVIDIA does not publish tensor clocks; these are derived |
| Measured GEMM efficiency and MLPerf per-GPU throughput within tolerance | **Partly met.** GEMM and bandwidth fit within tolerance; they define their own parameters, so this shows consistency, not validation. MLPerf: **9 of 10 rows within ±15%**. H200 Llama 3.1 405B Server is at −19.7% |
| Held-out B300 predicted without retuning; error recorded | **Recorded. Failed:** +26.6% to +41.3% against a ±20% tolerance |

## What the model is

The model builds kernel rooflines, uses measured sustained efficiencies, and composes them into continuous-batching LLM serving.
- **Kernels.** GEMM time is max(FLOPs ÷ (peak × GEMM efficiency), bytes ÷ (bandwidth × memory efficiency)). Attention reads the whole KV context per token. Tensor-parallel all-reduces cost a fixed latency plus bytes over NVLink.
- **Serving.** Each iteration makes one token for every sequence in the batch, plus the prefill of the requests that start in its place (chunked prefill).
  - The batch is limited by KV-cache memory.
  - The tensor-parallel degree (1, 2, 4, 8) is chosen for the best throughput per GPU, as a submitter would.
  - In the Server scenario, the batch must also meet MLPerf's TPOT limit and a p99 time-to-first-token queue bound (Poisson arrivals, exponential waiting tail).
- **Fitted parameters,** all from calibration data only:

| Parameter | Hopper | Blackwell | Source |
|---|---|---|---|
| GEMM efficiency | 0.790 | 0.556 | ThunderKittens on H100 (797 and 767 TF); B200 sustained 1,100–1,400 TF |
| Memory efficiency | 0.913 | 0.869 | H800 PCIe measured (same GH100 die); B200 sustained 6.8–7.1 TB/s |
| Serving efficiency (decode only) | 0.658 (global) | | Golden-section fit over the 10 calibration MLPerf rows |

- **Fixed assumptions,** not fitted:
  - 10% of memory reserved
  - FP8 KV cache
  - BF16 activations
  - 10 µs per all-reduce
  - NVFP4 at 0.5625 bytes per parameter
- **Workloads:**
  - Llama 2 70B mean input: **221.3 tokens**, measured by tokenizing MLPerf's 24,576 OpenOrca prompts with MLPerf's own template (no published figure exists).
  - Llama 3.1 405B: mean input 9,400 tokens (MLCommons).
  - Output lengths: each row's own TOKENS_PER_SAMPLE.

## Calibration (frozen model)

| Row | Chip | Workload | Measured /GPU | Modeled /GPU | Error | Config the model chose |
|---|---|---|---|---|---|---|
| 5.0-0057 | H100 | Llama 2 70B Offline | 3,913 | 3,683 | −5.9% | TP2, batch 1,247 |
| 5.0-0057 | H100 | Llama 2 70B Server | 3,888 | 3,687 | −5.2% | TP2, batch 1,245 |
| 5.0-0060 | H200 | Llama 2 70B Offline | 4,374 | 4,522 | +3.4% | TP1, batch 963 |
| 5.0-0060 | H200 | Llama 2 70B Server | 4,134 | 4,525 | +9.5% | TP1, TPOT-limited |
| 5.0-0060 | H200 | 405B Offline | 70.1 | 72.6 | +3.6% | TP8, batch 242 |
| 5.0-0060 | H200 | 405B Server | 36.4 | 29.2 | **−19.7%** | TP8, TTFT-queue-limited |
| 5.1-0069 | B200 | Llama 2 70B Offline | 12,691 | 13,003 | +2.5% | TP1, batch 2,100 |
| 5.1-0069 | B200 | Llama 2 70B Server | 12,390 | 13,014 | +5.0% | TP1, batch 2,097 |
| 5.1-0069 | B200 | 405B Offline | 203.0 | 228.1 | +12.3% | TP4, batch 167 |
| 5.1-0069 | B200 | 405B Server | 155.1 | 175.7 | +13.3% | TP4, TTFT-queue-limited |

## Held out (one run, frozen model)

| Row | Workload | Measured /GPU | Modeled /GPU | Error |
|---|---|---|---|---|
| 6.0-0073 | Llama 2 70B Offline | 14,119 | 17,990 | +27.4% |
| 6.0-0073 | Llama 2 70B Server | 13,415 | 17,974 | +34.0% |
| 6.0-0073 | 405B Offline | 243.9 | 308.9 | +26.6% |
| 6.0-0073 | 405B Server | 182.5 | 257.9 | +41.3% |

## How it was kept honest

1. **Targets frozen first.** The targets file was frozen (sha256 `1eaa29ae…`) before any model output existed. The pre-freeze amendments were:
   - each MLPerf row's measured output length;
   - the MLPerf input lengths and latency limits;
   - promotion of the H800 bandwidth row to calibrate the Hopper family, since it is the only high-confidence Hopper bandwidth measurement.
2. **Calibration runs blind to held-out data.** `calibrate()` filters out held-out chips before reading anything. A test multiplies B300's results by 7 and adds fake B300 calibration rows, and the calibration does not change. A mutation check that let calibration read B300 was caught by that test and by the evidence check.
3. **One revision, on calibration rows only.** The first version missed Llama 3.1 405B, with H200 405B Server at +52%. Two structural fixes followed, with no new fitted parameters:
   - The decode-overhead factor no longer applies to prefill, which is large, efficient GEMMs.
   - The Server scenario gained the time-to-first-token queue bound. Server-to-Offline ratios fall with the prefill-to-TTFT ratio: H200 405B 0.52, B200 405B 0.76, Llama 2 about 0.95.

   Tuning stopped when one row remained at −19.7%, rather than fitting that row.
4. **The held-out test ran once,** after the model's hash was recorded. `tests/perf-model.test.ts` pins that hash. Any change to the model fails the evidence test until the evidence is regenerated, and the test says a new held-out set is needed.
5. **Blind to fitting, not to the author.** B300's MLPerf results were visible in C0. The held-out check therefore protects against fitting, not against structural choices made by someone who had seen the numbers. Version 1's structure did not anticipate B300's result anyway.

## What the failure means

The model scales throughput with peak tensor FLOPS once a workload is compute-bound. Llama 2 70B on Blackwell FP4 is compute-bound in the model, so B300's 1.5× FP4 peak becomes about 1.4× modeled throughput. Measured, it is 1.11×.

The most likely cause is **power**. HGX B300 gets about 10% more board power than HGX B200 (~1,100 W vs ~1,000 W; both low-confidence secondary figures) to drive 1.5× the FP4 math. At full FP4 load it would then run power-limited, below its peak clock. Other contributors cannot be separated with the data available:
- operand bandwidth into a 3×-rate FP4 datapath;
- non-GEMM work (norms, sampling, scheduling) that does not speed up;
- software maturity.

**For A1 this is the central result of C1.** A chip does not match B200 by matching its peak FLOPS; it must deliver the throughput **at a power budget**. The next model version needs an energy term per operation and per byte, calibrated on calibration chips, and must be validated on a new held-out set.

## Not done in C1

- **GenZ cross-check** (planned in C0). Deferred to the next model version; comparing against a model that failed its held-out check adds little.
- **Rubin, MI355X, and TPU.** These have no microarchitecture entry and no family efficiencies, so they are not evaluated.
- **A1.** No A1 figures are produced, by rule, until a model passes its held-out check.

## Proposed next step: C1 v2 (needs the owner's approval, because it declares a new held-out set)

1. **Add a power term.** Sustained throughput becomes min(roofline, power budget ÷ energy per FLOP and per byte), calibrated from the calibration chips. Board power and die energy figures are low-confidence today, so this also needs better power sources.
2. **Declare a new held-out set before building.** Candidates:
   - MLPerf 6.0-0078, GB300 NVL72: the same Blackwell Ultra die at a different power bin (~1,400 W), which directly tests a power model;
   - MLPerf 6.0-0002, MI355X: a different vendor, which tests generality.

   Both were visible in C0, so again blind to fitting only.
3. **Keep B300 as a regression row,** not as validation, since version 1 consumed it.
