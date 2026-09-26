// SymbiYosys harness for a1_dot_sum (stage 2 of the dot product): for ANY term bundle, reordering the
// product terms within a slot class leaves the result unchanged, because every term is aligned on its
// own and the sum is exact. Proving this on the sum stage alone avoids the multipliers.
// Operand symmetry through the multipliers is a1_dot4.sby's swap task.
module a1_dot_sum_sby (
  input wire clk
);
  (* anyseq *) reg [305:0] terms;

  // Bundle (see a1_dot_terms.sv): {fmt, flags[4:0], top_anchor[10:0], c[31:0],
  //   narrow slots 8-15: 8 x 12 bits, mid slots 4-7: 4 x 16 bits, wide slots 0-3: 4 x 24 bits}
  wire [49:0] head = terms[305:256];
  wire [95:0] narrow = terms[255:160];
  wire [63:0] mid = terms[159:96];
  wire [95:0] wide = terms[95:0];
  // Rotate each class by one slot.
  wire [305:0] rotated = {head, narrow[11:0], narrow[95:12], mid[15:0], mid[63:16], wide[23:0], wide[95:24]};

  wire [61:0] partial, partial_rotated;
  a1_dot_sum base    (.terms(terms), .partial(partial));
  a1_dot_sum shifted (.terms(rotated), .partial(partial_rotated));

  always @(*) begin
    assert (partial == partial_rotated);
    cover (partial[45:0] != 46'd0 && terms[305:304] == 2'd3);  // an FP4 bundle summing to nonzero
  end
endmodule
