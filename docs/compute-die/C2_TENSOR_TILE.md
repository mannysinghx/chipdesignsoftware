# C2 Result: Tensor Tile RTL

## Increment 2b: MX scaling, FP4, and packed elements (26 September 2026)

**What changed:**
- **Packed elements.** A 64-bit operand row now packs **4 BF16, 8 FP8, or 16 FP4** elements, so one MMA step does 64, 128, or 256 multiplies from the same 512 operand bits. This is how tensor cores reach FP8 = 2× and FP4 = 4× the BF16 rate, and it is the throughput C1's model assumes.
- **FP4.** FP4 E2M1 (OCP MX) takes format code 3.
- **MX scales.** Each A row and each B column carries an OCP MX **E8M0 scale** (a power of two; 255 is NaN). Software holds a block's scale constant across the commands that span its 32 elements.
- **B layout.** B is now given as columns, so each dot unit reads one contiguous row of A and one column of B.
- **Pipeline re-cut.** Stage 1 now ends at each term's alignment distance: 306 bits per dot, against 270 before, although the dot product grew from 5 to 17 terms. Stage 2 aligns and sums 17 terms exactly; stage 3 rounds.

**Product slots and area.** Slots 0–3 carry 8×8-bit multipliers (every format), slots 4–7 carry 4×4 (FP8 and FP4), and slots 8–15 carry 2×2 (FP4 only). Size in generic Yosys cells:

| | Increment 1 | Increment 2b |
|---|---|---|
| Dot unit | 6.6k | 16.8k |
| Tile (cells) | 106k | 285k |
| Tile (flip-flops) | 2.6k | 10.5k |

C3 turns these into mm² on real process kits.

| Check | Result |
|---|---|
| Cosimulation | **18/18** (2 min). New: exhaustive FP4 products in **every one of the 16 slots**, FP8 products in all 8 slots, random MX scales including NaN and the extremes, scale-transfer invariance (Xa·2, Xb/2 give the same result), and an MXFP4 K = 64 loop over two scaled 32-element blocks |
| Accuracy against exact arithmetic (4,000 cases per format and distribution) | No bound violations. With a realistic K-loop accumulator, **all four formats are 100% exactly rounded, worst 0.5 ulp** |
| Planted bugs | 5 of 5 caught: FP4 subnormal exponent, MX scale bias, crossed FP4 slot wiring, FP4 window placement, NaN scale ignored |
| Lint | 0 errors, 0 warnings |
| Proofs | **10/10** (audited run `bb87850d`, about 20 min). Covered: special values (FTZ, canonical NaN, NaN data and NaN scale propagation); operand-and-scale swap per format; order independence of all 17 terms, all classes rotated at once (17 min); the pipelined tile control proof. The new order proof was mutation-checked: an asymmetric FP4 slot shift fails in 2 s |
| Audited runs | `a1.lint` d1b88e15, `a1.sim` c3171609 (18/18), `a1.formal` bb87850d (10/10). All rebuild from the audit log 7/7; lint and simulation reproduce identically |

**Accuracy caveat, measured and not hidden.** When an accumulator of arbitrary magnitude meets products that cancel exactly, the products still set the alignment window, and a much smaller accumulator loses low bits. Example: FP4 products that cancel exactly, with c = 5.7×10⁻¹¹, return c with 3 significant bits. This follows from the specified max-exponent truncation, which GPU tensor cores share, and the error bound holds. The effect appears only in the "arbitrary c" distribution (FP4 99.0% exactly rounded); realistic accumulators are unaffected. A fix would be a separate full-precision path for the accumulator: exact product sum first, then one correctly rounded add. That is a design option for a later increment, not a defect.

**Formal cost.** Operand swap over all four formats with 16 multiplier slots ran for over 15 minutes. Proving it once per format (fixing `fmt` lets the solver drop unused slots) takes 3 s, 3 s, 80 s, and 144 s, and the four tasks together cover every value of `fmt`. The FP8 upper-byte property from increment 1 no longer applies, since every bit of a row is now an element; NaN-scale propagation replaces it.

## Increment 2a: pipelining (26 September 2026)

The tile is now a 3-stage pipeline, as C3's physical flow needs.
- **Stage modules.** The dot unit is split into three: `a1_dot_terms` (decode and multiply), `a1_dot_sum` (align and exact sum), and `a1_dot_round` (normalize and round). `a1_fp_dot4` is their composition, so the existing golden cosimulation, exhaustive tests, and proofs cover exactly the logic the pipeline uses.
- **Accumulator ordering.**
  - An MMA reads its accumulator in stage 1 and commits in stage 3.
  - A READ reads at stage 3, after every older write, so it never sees stale data.
  - ZERO and LOAD commit in program order.
- **The one hazard.** An MMA whose accumulator an older in-flight command will write is held by a scoreboard until that write commits.
- **Throughput.** A dependent chain into one accumulator is accepted exactly every 3 cycles; rotating over 3 or more accumulators sustains one MMA per cycle, the way tensor cores hide accumulator latency. Tests pin both rates exactly.

| Check | Result |
|---|---|
| Cosimulation | 15/15, including the new exact-throughput tests |
| Tile control proof (k-induction, base case 8) | Pass. The invariants were rewritten for the pipeline: a committed shadow of one accumulator, no MMA ever reads an accumulator with an older uncommitted write, and in-flight READs plus the response slot always equal accepted READs minus taken responses. Four covers are reached: a hazard hold, a full pipeline, backpressure, and LOAD then READ back |
| Dot-unit proofs | Pass: operand swap (42 s) and special values. Term-order independence is now proved on the sum stage for any term bundle (about 30 s) |
| Lint | 0 errors, 0 warnings |
| Audited runs | `a1.lint` 899d1d52, `a1.sim` 0d54a1e6, `a1.formal` 07d25c90 (7/7 tasks, 7 min). Each rebuilds from the audit log 7/7; lint and simulation reproduce identically |

**Planted bugs, all caught:**
- a scoreboard that forgets stage 2 (also caught by 4 cosimulation tests);
- no stall under backpressure;
- a commit to the wrong entry.

With a base-case depth of 4 these showed as `UNKNOWN`: the induction step failed, but no concrete trace was found. The depth was raised to 8 so each produces a real counterexample trace.

**Formal performance, a lesson recorded in the job files.** Splitting the unit into modules made two whole-unit proofs slow: operand swap went from 47 s to over 10 minutes, and term-order independence did not finish in 30 minutes. The fixes:
- `prep -flatten` restores swap to 42 s;
- order independence moved to the sum stage, where it needs no multipliers.

The first audited formal run (`1cdc2e29`) used the unflattened jobs; it was stopped after 30 minutes and is recorded as errored.

---

# Increment 1

**Date:** 26 September 2026
**Step:** C2 of [`COMPUTE_DIE_PLAN.md`](../COMPUTE_DIE_PLAN.md)
**Evidence class:** `executed` (simulation, formal, and lint, run in the pinned sandbox). This is not silicon and not a physical implementation.

**Files:**
- RTL: [`rtl/a1/a1_fp_dot4.sv`](../../rtl/a1/a1_fp_dot4.sv), [`rtl/a1/a1_mma_tile.sv`](../../rtl/a1/a1_mma_tile.sv)
- Golden model and specification: [`verification/a1/golden.py`](../../verification/a1/golden.py)
- Accuracy check: [`verification/a1/golden_accuracy.py`](../../verification/a1/golden_accuracy.py)
- Tests: `verification/a1/test_a1_fp_dot4.py`, `verification/a1/test_a1_mma_tile.py`; runner `verification/a1/run_regression.py`
- Formal: `formal/a1/` (harnesses, `a1_dot4.sby`, `a1_tile.sby`, `run_formal.py`)
- Platform adapters `a1.lint`, `a1.sim`, `a1.formal` (`platform/aimem_platform/runs/adapters.py`), with `platform/tests/test_a1_adapters.py`

## What increment 1 is

| Block | What it does |
|---|---|
| `a1_fp_dot4` | Fused dot product with accumulate: d = round(c + a0·b0 + a1·b1 + a2·b2 + a3·b3) for FP8 E4M3, FP8 E5M2, or BF16 inputs, with FP32 addend and result. About 6,600 generic gates (Yosys). |
| `a1_mma_tile` | A 4×4×4 matrix-multiply-accumulate per accepted command (D = C + A×B), using sixteen dot units, into an accumulator memory of four 4×4 FP32 tiles held beside the array. This is the Blackwell TMEM idea: accumulators never pass through a register file. Commands are ZERO, LOAD, MMA, and READ over valid/ready, with backpressure. About 106,000 generic cells, including 2,560 flip-flops. |

**Deferred to increment 2** (all in the plan's C2 build list, not done here):
- MX block scaling and FP4
- the tile DMA (TMA-style)
- pipelining: the MMA currently completes in the cycle it is accepted, which is correct but a long timing path; C3's physical flow needs registers

## Design decisions

1. **Written from scratch; Vortex's Ten-Four is the architectural reference.** Its code is Apache-2.0, but it depends on Vortex's whole-GPU configuration (`VX_define.vh`, `VX_gpu_pkg`) and nine library modules. A bit-exact golden model would also mean reverse-engineering its rounding algorithm. The plan's C0 condition was to confirm the code was usable at C2 start; it was not usable as a drop-in block.
2. **The golden model is the specification,** in pure-Python integers rather than NumPy. The arithmetic is defined as:
   - exact products;
   - every term aligned into a 40-bit window below the largest term, truncating;
   - an exact integer sum;
   - one round-to-nearest-even to FP32;
   - overflow to Inf, and flush-to-zero outputs;
   - subnormal inputs honored, NaN and Inf handled per IEEE, E4M3 without Inf.

   NumPy float arithmetic cannot express the truncating window, and the sandbox does not guarantee NumPy. This deviates from the plan's wording ("NumPy golden model"), not from its intent.
3. **Truncation is the same trade-off GPU tensor cores make.** Against exact rational arithmetic, over 4,000 cases per format and distribution, with no bound violation in any of them:

| Data | E4M3 | E5M2 | BF16 |
|---|---|---|---|
| Gaussian N(0,1), with cancelling addends: exactly rounded | 100% | 99.9% | 100% |
| Gaussian: worst error | 0.5 ulp | 0.5 ulp | 0.5 ulp |
| Uniform random bit patterns: exactly rounded | 99.6% | 99.4% | 57.6% |

   On uniform bit patterns the large errors come only from engineered cancellation across exponent spreads of up to 2²⁵⁰, which real tensors do not have. The guaranteed bound (half an ulp plus one unit of the 40-bit window per term) holds everywhere.
4. **A1 has its own adapters, so T0 is untouched.** The T0 adapters glob only the top of `rtl/` and their own test directories, so T0 run inputs and spec hashes are unchanged. A platform test proves it. The A1 lint driver reuses T0's `lint.py` unchanged by importing it.

## Results

| Exit criterion (plan C2) | Result |
|---|---|
| Bit-exact against the golden model, directed and random | **Met.** 13 of 13 tests pass. They cover every special-value rule, round-half-to-even ties, **exhaustive** single products for both FP8 formats (131,072 cases), random bit patterns and Gaussian data in every format (18,000 cases), the FP8 upper-byte rule, and tile tests: reset, LOAD/READ, single MMA, K = 32 accumulation chains, and 400 random commands under 60% backpressure with the handshake checked every cycle |
| Formal proofs on control and handshake, with cover and vacuity checks | **Met.** Tile control is proved **unbounded, by k-induction** for any datapath result, with two cover checks reached. The dot unit's invariants are proved for **every input**: operand swap (47 s), lane order (324 s), and special values (377 s: FP8 upper byte, flush-to-zero, canonical NaN, NaN propagation), with two cover checks reached |
| Verilator lint clean | **Met.** 0 errors, 0 warnings, `-Wall`, on both targets |
| Runs through the sandboxed adapters, audited and reproducible | **Met** for all three: lint (run `b1362665`), simulation (run `3b4f3f65`), and formal (run `dfa9baf3`, 6/6 tasks in about 6 minutes). Each was re-executed from its audit record with identical outputs and rebuilt from the audit log with 7 of 7 checks consistent |

**The tests were shown to catch bugs.** Ten bugs were planted, one at a time, in scratch copies of the RTL, and each was caught:
- **In simulation:** no sticky bit, round-half-up, an off-by-one E5M2 subnormal exponent, `cmd_ready` stuck high, and swapped B lanes.
- **By the tile proof:** a write to the wrong entry, a response dropped under backpressure, and `cmd_ready` stuck high, each failing on the assertion written for it.
- **By the dot proofs:** a non-canonical NaN and an asymmetric exponent, each with a counterexample in seconds.

**Bugs found while writing the RTL, before any tool ran:**
- **A truncated product.** An 8×8 product written inside a concatenation, where Verilog evaluates at 8 bits and silently drops the top half.
- **Task outputs to arrays.** Task outputs written into unpacked arrays, which Yosys does not reliably support.

Both were fixed before the first simulation.

## What C2 means for A1

C2 proves the arithmetic and control of one tile. It does **not** yet produce the numbers C1's model needs: sustained TFLOPS per watt, memory efficiency, and serving efficiency. The generic gate counts above are not a process node. C3 turns this tile into area, frequency, and power on sky130 and on the ASAP7–GT2N bracket, after pipelining (increment 2). C3 also needs owner decision 3 (disk space or a separate worker).
