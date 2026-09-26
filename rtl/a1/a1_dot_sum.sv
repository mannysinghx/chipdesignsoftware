// AIMEM-A1 dot product, stage 2 of 3: largest anchor, truncating alignment, exact sum.
// Part of a1_fp_dot4 (see that file for the arithmetic specification).
// Term bundle: {have_live, any_nan, inf_pos, inf_neg, all_neg, t_sign[4:0], t_live[4:0], t_anchor[54:0], t_top[199:0]}
// Partial:     {have_live, any_nan, inf_pos, inf_neg, all_neg, top_anchor[10:0], sum[43:0]}

module a1_dot_sum (
  input  wire [269:0] terms,
  output wire [59:0]  partial
);
  wire [4:0]   flags = terms[269:265];
  wire [4:0]   t_sign = terms[264:260];
  wire [4:0]   t_live = terms[259:255];
  wire [54:0]  t_anchor = terms[254:200];
  wire [199:0] t_top = terms[199:0];

  reg signed [10:0] top_anchor;
  reg signed [10:0] anchor_k;
  reg [10:0] shift_dist;
  reg [39:0] aligned;
  reg signed [43:0] sum;
  integer k;

  always @* begin
    // largest anchor among nonzero finite terms
    top_anchor = -11'sd1024;
    for (k = 0; k < 5; k = k + 1) begin
      anchor_k = t_anchor[11*k +: 11];
      if (t_live[k] && anchor_k > top_anchor) top_anchor = anchor_k;
    end

    // align each term (truncating) and sum exactly
    sum = 44'sd0;
    for (k = 0; k < 5; k = k + 1) begin
      anchor_k = t_anchor[11*k +: 11];
      shift_dist = top_anchor - anchor_k;
      aligned = (t_live[k] && shift_dist < 11'd40) ? (t_top[40*k +: 40] >> shift_dist) : 40'd0;
      if (t_sign[k]) sum = sum - $signed({4'd0, aligned});
      else sum = sum + $signed({4'd0, aligned});
    end
  end

  assign partial = {flags, top_anchor, sum};
endmodule
