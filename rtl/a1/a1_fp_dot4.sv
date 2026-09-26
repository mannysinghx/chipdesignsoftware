// AIMEM-A1 fused dot product with FP32 accumulate (C2 of docs/COMPUTE_DIE_PLAN.md).
//   d = round_fp32(c + Xa * Xb * sum_k a_k * b_k)
// a and b are 64-bit operand rows packing 4 BF16, 8 FP8, or 16 FP4 elements, so each step does 4, 8,
// or 16 multiplies from the same operand bytes. Xa and Xb are OCP MX E8M0 scales (127 = 1.0).
// fmt: 0 = FP8 E4M3, 1 = FP8 E5M2, 2 = BF16, 3 = FP4 E2M1 (OCP MX).
// The arithmetic is specified by verification/a1/golden.py and must match it bit for bit: exact
// products, alignment of every term into a 40-bit window below the largest term (truncating), an exact
// integer sum, one round-to-nearest-even to FP32, overflow to Inf, and flush-to-zero outputs.
// Architecture follows the fused dot-product structure of Vortex's Ten-Four unit (arXiv 2512.00053),
// written from scratch so that it has no Vortex dependencies.
//
// Three combinational stages, so the tile can pipeline them (a1_mma_tile registers between them):
//   a1_dot_terms  decode, exact products, scales, anchors, largest anchor, alignment distances
//   a1_dot_sum    place in the window, truncate, exact sum of 17 terms
//   a1_dot_round  normalize, round once, pack, special values
// a1_fp_dot4 is the unpipelined composition of the three.
module a1_fp_dot4 (
  input  wire [1:0]  fmt,
  input  wire [63:0] a,
  input  wire [63:0] b,
  input  wire [31:0] c,
  input  wire [7:0]  scale_a,
  input  wire [7:0]  scale_b,
  output wire [31:0] d
);
  wire [305:0] terms;
  wire [61:0]  partial;
  a1_dot_terms u_terms (.fmt(fmt), .a(a), .b(b), .c(c), .scale_a(scale_a), .scale_b(scale_b), .terms(terms));
  a1_dot_sum   u_sum   (.terms(terms), .partial(partial));
  a1_dot_round u_round (.partial(partial), .d(d));
endmodule
