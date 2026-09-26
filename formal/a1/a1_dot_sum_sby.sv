// SymbiYosys harness for a1_dot_sum (stage 2 of the dot product): for ANY term bundle, reordering the
// product terms leaves the result unchanged, because every term is aligned on its own and the sum is
// exact. Proving this on the sum stage alone avoids the multipliers, which made the same property on
// the whole unit slow to prove. Operand symmetry through the multipliers is a1_dot4.sby's swap task.
module a1_dot_sum_sby (
  input wire clk
);
  (* anyseq *) reg [269:0] terms;

  // Bundle: {flags[4:0], t_sign[4:0], t_live[4:0], t_anchor[54:0], t_top[199:0]}; terms 0-3 are products,
  // term 4 is the addend. Rotate the four products by one position.
  wire [4:0]   flags = terms[269:265];
  wire [4:0]   sign = terms[264:260];
  wire [4:0]   live = terms[259:255];
  wire [54:0]  anchor = terms[254:200];
  wire [199:0] top = terms[199:0];
  wire [269:0] rotated = {flags,
                          sign[4], sign[0], sign[3:1],
                          live[4], live[0], live[3:1],
                          anchor[54:44], anchor[10:0], anchor[43:11],
                          top[199:160], top[39:0], top[159:40]};

  wire [59:0] partial, partial_rotated;
  a1_dot_sum base    (.terms(terms), .partial(partial));
  a1_dot_sum shifted (.terms(rotated), .partial(partial_rotated));

  always @(*) begin
    assert (partial == partial_rotated);
    cover (partial[43:0] != 44'd0 && live[3:0] == 4'hF);  // four live products summing to nonzero
  end
endmodule
