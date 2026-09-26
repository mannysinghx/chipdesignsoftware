// SymbiYosys harness for a1_fp_dot4: arithmetic invariants proved for every input (combinational,
// so a depth-1 proof covers the whole input space). Term-order independence is proved on the sum
// stage alone (a1_dot_sum_sby.sv), where it does not have to reason through the multipliers.
// Bit-exactness against the golden model is checked by cosimulation (verification/a1).
module a1_fp_dot4_sby (
  input wire clk
);
  (* anyseq *) reg [1:0]  fmt;
  (* anyseq *) reg [63:0] a;
  (* anyseq *) reg [63:0] b;
  (* anyseq *) reg [31:0] c;
  (* anyseq *) reg [7:0]  scale_a;
  (* anyseq *) reg [7:0]  scale_b;

  localparam [31:0] QNAN = 32'h7FC00000;

  wire [31:0] d, d_swapped;
  a1_fp_dot4 base    (.fmt(fmt), .a(a), .b(b), .c(c), .scale_a(scale_a), .scale_b(scale_b), .d(d));
  a1_fp_dot4 swapped (.fmt(fmt), .a(b), .b(a), .c(c), .scale_a(scale_b), .scale_b(scale_a), .d(d_swapped));

  // Property groups are proved as separate tasks (a1_dot4.sby) so that each has its own solver budget.
  // The swap proof runs once per format (SWAP_FMT): together the four tasks cover every fmt value, and
  // each finishes in seconds to minutes, where one all-formats proof ran for over 15 minutes.
  always @(*) begin
`ifdef CHECK_SPECIALS
    if (d[30:23] == 8'h00) assert (d[22:0] == 23'd0);               // outputs flush to zero, never subnormal
    if (d[30:23] == 8'hFF && d[22:0] != 23'd0) assert (d == QNAN);  // only the canonical NaN is produced
    if (c[30:23] == 8'hFF && c[22:0] != 23'd0) assert (d == QNAN);  // a NaN addend propagates
    if (scale_a == 8'hFF || scale_b == 8'hFF) assert (d == QNAN);   // a NaN MX scale propagates
`endif
`ifdef CHECK_SWAP
`ifdef SWAP_FMT
    assume (fmt == `SWAP_FMT);
`endif
    assert (d == d_swapped);                                        // (a, Xa) * (b, Xb) == (b, Xb) * (a, Xa)
`endif
    cover (d[30:23] != 8'h00 && d[30:23] != 8'hFF && fmt == 2'd3);  // a normal FP4 result is reachable
    cover (d == QNAN && fmt == 2'd0 && scale_a != 8'hFF && scale_b != 8'hFF);  // an E4M3 data NaN
  end
endmodule
