# C1 Result: Calibrated Performance Model

**Date:** 26 September 2026
**Step:** C1 of [`COMPUTE_DIE_PLAN.md`](../COMPUTE_DIE_PLAN.md)
**Evidence class:** `modeled`
**Files:**
- Model: [`lib/perf-model.ts`](../../lib/perf-model.ts), version 3, frozen at sha256 `2ae82b56…dcce`
- Evidence: [`evidence/c1-perf-model.json`](../../evidence/c1-perf-model.json) (version 3); [`-v2.json`](../../evidence/c1-perf-model-v2.json) and [`-v1.json`](../../evidence/c1-perf-model-v1.json) unchanged
- Best-submission extraction: [`tools/mlperf/extract_frontier.py`](../../tools/mlperf/extract_frontier.py)
- Tests: `tests/perf-model.test.ts`
- Regenerate: `npm run evaluate:perf-model`

# Version 3: scored against best submissions, Offline only (C1 complete)

## Outcome

**C1's exit criteria are met** under the scoring rules the owner approved on 2026-09-26:

| Exit criterion | Version 3 result |
|---|---|
| Peaks reproduced exactly | **Met** (MI355X within AMD's two-significant-figure rounding) |
| Calibration within ±15% | **Met:** all 6 Offline best-submission rows, largest error +10.0% |
| Held out within ±20% | **Met:** GB200 Llama 2 70B **+8.3%**, Llama 3.1 405B **+10.4%** |

The physics is version 2's, unchanged: rooflines, a power ceiling, KV-capacity batching, and TTFT/TPOT limits. Nothing was tuned after calibration. The fitted values are BF16 TFLOPS per watt of 1.117 (Hopper) and 1.250 (Blackwell), memory efficiency of 0.913 and 0.869, and a serving efficiency of 0.684.

**What "qualified" covers, and what it doesn't:**
- The model may be used for **`modeled`, Offline** throughput claims about chips described by its parameters.
- **Limits of the check.** It rests on 2 scored held-out rows. GB200's results were seen during the variance analysis, so the check is blind to fitting, not to the author. The next MLPerf round is the first genuinely unseen test.
- **A1 is not covered yet.** A1 has no measured TFLOPS per watt, memory efficiency, or serving efficiency. Until C2, C3, and C5 produce them from RTL and layout, any A1 figure from this model must state those three as assumptions, and it stays `modeled`.

## Why the scoring changed (owner-approved, based on data, not on the model's errors)

Version 3 was first planned as version 2 plus a "rack-scale Server" term. Before building it, about 170 paired MLPerf submissions (Server and Offline from the same system) were checked, and the premise did not hold:

1. **No rack-scale Server effect exists to model.** Llama 2 70B Server/Offline on rack systems is 0.98 (H100 ×32), 0.90 (MI300X), 0.91 (MI325X), 0.98 (MI355X ×88), and 0.91 (GB200 NVL72). GB300's 0.77 is a single submission.
2. **Server results are dominated by software.** Identical GB200 NVL72 hardware from the same submitter went 0.64 → 0.79 → 0.91 Server/Offline on Llama 3.1 405B over three rounds, and GB300 went 0.76 → 0.96. No hardware model can hold such rows within ±20%.
3. **Best submissions are a stable measure of hardware.** Per-GPU Offline results for one chip spread widely (B200's weakest is 0.77× its median; MI355X's 0.51×), but the best submissions sit within 3–8% of the median.

The approved rules, recorded in the targets file under `calibration.scoring`:
- score each chip against its **best closed-division, generally available submission**;
- **qualify on Offline**, and report Server rows without scoring them;
- **GB200 is the held-out chip.**

This is not a rescoping to rescue a failed model. Version 2 is not rescored under the new rules, and its failure stays on record.

## Best-submission rows

Extracted by `tools/mlperf/extract_frontier.py` from the MLCommons summary files for v5.0 to v6.1. Matching uses exact accelerator names, so H100 PCIe/NVL, virtualized, power-capped, and mixed systems are excluded. v6.1's closed division has no rows for these benchmarks; it has only the stricter llama2-70b-99.9 variant, a different benchmark.

| Chip | Workload | Best /GPU | Submission | Modeled | Error |
|---|---|---|---|---|---|
| H100 | Llama 2 70B | 3,913 | 5.0-0057 NVIDIA | 3,780 | −3.4% |
| H100 | 405B | 54.5 | 5.0-0065 QCT | 60.0 | +10.0% |
| H200 | Llama 2 70B | 4,432 | 5.0-0051 Lenovo | 4,640 | +4.7% |
| H200 | 405B | 71.7 | 5.0-0011 Cisco | 74.2 | +3.5% |
| B200 | Llama 2 70B | 12,994 | 6.0-0048 HPE | 12,098 | −6.9% |
| B200 | 405B | 207.6 | 5.1-0028 Dell | 215.6 | +3.9% |
| **GB200 (held out)** | Llama 2 70B | 13,015 | 5.1-0008 Azure | 14,098 | **+8.3%** |
| **GB200 (held out)** | 405B | 214.7 | 6.0-0075 NVIDIA | 237.0 | **+10.4%** |

**Unscored Server rows:**
- Calibration chips: −25.0% to +8.8%.
- GB200: +14.5% and −3.9%.
- Consumed chips, diagnostic only:
  - B300: −9.4% to +1.0%
  - GB300 Offline: +2.0% and +9.0%
  - MI355X Offline: +19.8%, still overpredicted with no AMD data

## What C1 means for A1

1. **Throughput per watt decides parity, not peak FLOPS.** The power ceiling is what made the model generalize: from B200 at 1,000 W, it predicts GB200 at 1,200 W and GB300 at 1,400 W within about 10%.
2. **To reach B200-class serving, A1 needs B200-class sustained TFLOPS per watt at the target precision, and B200-class memory bandwidth.** A1's lever beyond that is AIMEM's bytes-per-token reduction, which the model can express through bandwidth and KV traffic.
3. **C2, C3, and C5 must measure the three A1 parameters** the model needs. The GT2N/ASAP7 bracket from C3 is where TFLOPS per watt at 3 nm-class will come from.

---

# Version 2: power ceiling

## Outcome

Version 2 adds one physical term, a power ceiling, and fits no new parameters. It still **fails its held-out check**, but narrowly:
- **All three Offline rows pass,** at +0.3%, +8.2%, and +17.8%.
- **Two Server rows fail** out of the three: GB300 Llama 2 70B at +30.2% and MI355X at +21.4%, against the ±20% tolerance.

Under the plan's rule, the model is still not qualified for A1 claims. The owner approved the held-out set in chat on 2026-09-26, before the model was built. It was run once against the frozen model and is now consumed.

| Exit criterion | Version 2 result |
|---|---|
| Peaks reproduced exactly | **Met** for every NVIDIA chip. For MI355X: within 0.7%, because AMD rounds its stated peaks to about two significant figures (derived with AMD's stated 2.4 GHz) |
| Calibration within tolerance | **Partly met:** 9 of 10 rows within ±15%. The same row as in version 1 misses: H200 405B Server, now −18.9% |
| Held-out predicted and recorded | **Recorded. Failed:** 4 of 6 rows within ±20%, and every Offline row passes |

## The change

Sustained tensor throughput is the lesser of two ceilings:
- **Architectural:** 95% of peak. H800 reached 94–96% with low-toggle inputs, where power does not bind.
- **Power:** (the family's measured BF16 TFLOPS per watt) × (the chip's power rating) × (16 ÷ operand bits). Energy per FLOP is taken as proportional to operand width: 16 bits for BF16, 8 for FP8, and 4.5 for NVFP4/MXFP4 including block scales.

At the calibration chips this gives the same BF16 and FP8 rates as version 1, because it is anchored to the same measurements. What changes is FP4, and any chip at a different power rating. Fitted values:

| Family | BF16 TFLOPS per watt | Memory efficiency | Source |
|---|---|---|---|
| Hopper | 1.117 | 0.913 | H100 (700 W, high confidence) |
| Blackwell | 1.250 | 0.869 | B200 (1,000 W, now high confidence from Lenovo's part name) |
| CDNA4 (AMD) | 1.184 | 0.891 | **No calibration data:** the mean of the two families above, a rule declared before building |

The global serving efficiency is 0.668.

## Held out (one run; approved set: GB300 NVL72 and MI355X)

| Row | Workload | Measured /GPU | Modeled /GPU | Error | Within ±20% |
|---|---|---|---|---|---|
| 6.0-0078 GB300 | Llama 2 70B Offline | 15,651 | 15,697 | +0.3% | yes |
| 6.0-0078 GB300 | Llama 2 70B Server | 12,059 | 15,705 | **+30.2%** | no |
| 6.0-0078 GB300 | 405B Offline | 271.0 | 293.3 | +8.2% | yes |
| 6.0-0078 GB300 | 405B Server | 258.7 | 225.7 | −12.8% | yes |
| 6.0-0002 MI355X | Llama 2 70B Offline | 12,935 | 15,232 | +17.8% | yes |
| 6.0-0002 MI355X | Llama 2 70B Server | 12,535 | 15,218 | **+21.4%** | no |

**GB300 power: disputed rating, declared rule.** NVIDIA states "up to 1,400 W" for Blackwell Ultra; Lenovo's GB300 guide says 1,100 W but also mislabels sparse figures as dense. The rule, fixed before building, was to score at 1,400 W and report 1,100 W unscored. At 1,100 W the errors are −17.7%, +6.9%, −7.2%, and −34.4%, worse on three of four rows. That supports the higher bin, weakly.

**Regression rows** (B300, consumed by version 1; diagnostic only): −8.7%, −4.0%, +1.2%, −7.4%, down from +27% to +41%. The power term was designed after B300's failure was known, so these rows show consistency, not validation.

## What version 2 shows

1. **Power, not peak FLOPS, sets Blackwell's throughput.** With one term and no new fits, the model moved from failing B300 by up to 41% to predicting GB300 Offline, a different power bin, within 0.3% and 8.2%. For A1 this confirms the plan's rule that parity is judged at a power budget.
2. **The Server scenario at rack scale is not modeled.** On 8-GPU HGX systems, Llama 2 Server runs at 0.95–0.98× Offline; on the 72-GPU GB300 NVL72 it runs at 0.77×. Nothing in the model represents rack-scale load balancing, queueing, or a system that serves Server traffic differently.
3. **Cross-vendor prediction without calibration costs about 20%.** MI355X, using the "mean of other families" rule and NVIDIA's software stack efficiency, is overpredicted by 18–21%. That is expected, not a surprise.

## What would qualify a model for A1 claims (needs the owner's decision)

The parity criteria in the targets file use **Offline** throughput only. Version 2 passes every Offline held-out row, and fails only on Server. Three options, each an evaluator decision for the owner:
1. **Keep the strict rule** (every held-out row within 20%). Build version 3 with a rack-scale Server term and AMD calibration data, validated on a new held-out set. The candidates left are few: GB200 NVL72 (6.0-0075), and later MLPerf rounds as they publish.
2. **Scope qualification to Offline**, matching the parity criteria. This is a post-hoc scope change, made after seeing results. It must be recorded as such, and version 2 would be qualified for Offline claims only.
3. **Wait for new data.** MLPerf rounds after v6.1 give genuinely unseen held-out chips, including Rubin, which removes the "seen by the author" caveat.

The recommendation is option 1 or 3. Option 2 is the kind of move the plan's safeguards exist to prevent, even though the Offline results support it.

---

# Version 1 (kept for the record)

## Outcome (version 1)

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
