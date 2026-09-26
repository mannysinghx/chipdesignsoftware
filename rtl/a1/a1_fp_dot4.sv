// AIMEM-A1 fused 4-term dot product with FP32 accumulate (C2 of docs/COMPUTE_DIE_PLAN.md).
//   d = round_fp32(c + a0*b0 + a1*b1 + a2*b2 + a3*b3)
// The arithmetic is specified by verification/a1/golden.py and must match it bit for bit: exact
// products, alignment of every term into a 40-bit window below the largest term (truncating), an exact
// integer sum, one round-to-nearest-even to FP32, overflow to Inf, and flush-to-zero outputs.
// fmt: 0 = FP8 E4M3, 1 = FP8 E5M2, 2 = BF16. FP8 operands use bits [7:0] of each 16-bit lane.
// Architecture follows the fused dot-product structure of Vortex's Ten-Four unit (arXiv 2512.00053),
// written from scratch so that it has no Vortex dependencies.
//
// Three combinational stages, so the tile can pipeline them (a1_mma_tile registers between them):
//   a1_dot_terms  decode, exact products, anchors, special-value flags   -> 270-bit term bundle
//   a1_dot_sum    largest anchor, truncating alignment, exact sum         -> 60-bit partial
//   a1_dot_round  normalize, round once, pack, special values             -> FP32
// a1_fp_dot4 is the unpipelined composition of the three.

// Term bundle: {have_live, any_nan, inf_pos, inf_neg, all_neg, t_sign[4:0], t_live[4:0], t_anchor[54:0], t_top[199:0]}
// Partial:     {have_live, any_nan, inf_pos, inf_neg, all_neg, top_anchor[10:0], sum[43:0]}

module a1_fp_dot4 (
  input  wire [1:0]  fmt,
  input  wire [63:0] a,  // lane k at [16k +: 16]
  input  wire [63:0] b,
  input  wire [31:0] c,
  output wire [31:0] d
);
  wire [269:0] terms;
  wire [59:0]  partial;
  a1_dot_terms stage_terms (.fmt(fmt), .a(a), .b(b), .c(c), .terms(terms));
  a1_dot_sum   stage_sum   (.terms(terms), .partial(partial));
  a1_dot_round stage_round (.partial(partial), .d(d));
endmodule
