// SymbiYosys harness for a1_fp_dot4: arithmetic invariants proved for every input (combinational,
// so a depth-1 proof covers the whole input space). Term-order independence is proved on the sum
// stage alone (a1_dot_sum_sby.sv), where it does not have to reason through the multipliers. Bit-exactness against the golden model is checked
// by cosimulation (verification/a1); these properties hold for any correct implementation of the spec.
module a1_fp_dot4_sby (
  input wire clk
);
  (* anyseq *) reg [1:0]  fmt;
  (* anyseq *) reg [63:0] a;
  (* anyseq *) reg [63:0] b;
  (* anyseq *) reg [31:0] c;
  (* anyseq *) reg [63:0] noise;

  localparam [63:0] UPPER_BYTES = 64'hFF00_FF00_FF00_FF00;
  localparam [31:0] QNAN = 32'h7FC00000;

  wire [31:0] d, d_swapped, d_noisy;
  a1_fp_dot4 base    (.fmt(fmt), .a(a), .b(b), .c(c), .d(d));
  a1_fp_dot4 swapped (.fmt(fmt), .a(b), .b(a), .c(c), .d(d_swapped));
  a1_fp_dot4 noisy   (.fmt(fmt), .a(a ^ (noise & UPPER_BYTES)), .b(b ^ ({noise[31:0], noise[63:32]} & UPPER_BYTES)), .c(c), .d(d_noisy));

  // Property groups are proved as separate tasks (a1_dot4.sby) so that each has its own solver budget.
  always @(*) begin
`ifdef CHECK_SPECIALS
    if (fmt == 2'd0 || fmt == 2'd1) assert (d == d_noisy);          // FP8 ignores the upper byte of a lane
    if (d[30:23] == 8'h00) assert (d[22:0] == 23'd0);               // outputs flush to zero, never subnormal
    if (d[30:23] == 8'hFF && d[22:0] != 23'd0) assert (d == QNAN);  // only the canonical NaN is produced
    if (c[30:23] == 8'hFF && c[22:0] != 23'd0) assert (d == QNAN);  // a NaN addend propagates
`endif
`ifdef CHECK_SWAP
    assert (d == d_swapped);                                        // a*b == b*a, lane by lane
`endif
    cover (d[30:23] != 8'h00 && d[30:23] != 8'hFF && fmt == 2'd2);  // a normal BF16 result is reachable
    cover (d == QNAN && fmt == 2'd0);                               // an E4M3 NaN result is reachable
  end
endmodule
