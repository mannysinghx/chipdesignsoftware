// AIMEM-A1 dot product, stage 3 of 3: normalize, round once to nearest even, pack, special values.
// Part of a1_fp_dot4 (see that file for the arithmetic specification).
module a1_dot_round (
  input  wire [61:0] partial,
  output reg  [31:0] d
);
  localparam [31:0] QNAN = 32'h7FC00000;

  wire        have_live = partial[61];
  wire        any_nan = partial[60];
  wire        inf_pos = partial[59];
  wire        inf_neg = partial[58];
  wire        all_neg = partial[57];
  wire signed [10:0] top_anchor = partial[56:46];
  wire signed [45:0] sum = partial[45:0];

  reg [44:0] mag;
  reg [5:0]  lz;
  reg [44:0] norm;
  reg        round_up;
  reg [23:0] rounded;  // {carry, 23 fraction bits}; the hidden bit is norm[44]
  reg signed [11:0] biased;
  integer    k;

  always @* begin
    mag = sum[45] ? (~sum[44:0] + 45'd1) : sum[44:0];  // |sum| < 2^45, so 45 bits are exact
    lz = 6'd45;
    for (k = 0; k < 45; k = k + 1) begin
      if (mag[k]) lz = 6'd44 - k[5:0];
    end
    norm = mag << lz;
    round_up = norm[20] && ((|norm[19:0]) || norm[21]);
    rounded = {1'b0, norm[43:21]} + {23'd0, round_up};
    // exponent of the leading bit = top_anchor - 40 + (45 - lz)
    biased = $signed({top_anchor[10], top_anchor}) + 12'sd132 - $signed({6'd0, lz})
             + (rounded[23] ? 12'sd1 : 12'sd0);

    if (any_nan || (inf_pos && inf_neg)) d = QNAN;
    else if (inf_pos || inf_neg) d = {inf_neg, 8'hFF, 23'd0};
    else if (!have_live) d = {all_neg, 31'd0};
    else if (!norm[44]) d = 32'd0;  // the leading bit is clear only when the exact sum is zero
    else if (biased >= 12'sd255) d = {sum[45], 8'hFF, 23'd0};
    else if (biased <= 12'sd0) d = {sum[45], 31'd0};
    else d = {sum[45], biased[7:0], rounded[22:0]};  // a carry leaves the fraction at zero
  end
endmodule
