// AIMEM-A1 dot product, stage 3 of 3: normalize, round once to nearest even, pack, special values.
// Part of a1_fp_dot4 (see that file for the arithmetic specification).
// Term bundle: {have_live, any_nan, inf_pos, inf_neg, all_neg, t_sign[4:0], t_live[4:0], t_anchor[54:0], t_top[199:0]}
// Partial:     {have_live, any_nan, inf_pos, inf_neg, all_neg, top_anchor[10:0], sum[43:0]}

module a1_dot_round (
  input  wire [59:0] partial,
  output reg  [31:0] d
);
  localparam [31:0] QNAN = 32'h7FC00000;

  wire        have_live = partial[59];
  wire        any_nan = partial[58];
  wire        inf_pos = partial[57];
  wire        inf_neg = partial[56];
  wire        all_neg = partial[55];
  wire signed [10:0] top_anchor = partial[54:44];
  wire signed [43:0] sum = partial[43:0];

  reg [42:0] mag;
  reg [5:0]  lz;
  reg [42:0] norm;
  reg        round_up;
  reg [23:0] rounded;  // {carry, 23 fraction bits}; the hidden bit is norm[42]
  reg signed [11:0] biased;
  integer    k;

  always @* begin
    // normalize and round once, to nearest even
    mag = sum[43] ? (~sum[42:0] + 43'd1) : sum[42:0];  // |sum| < 2^43, so 43 bits are exact
    lz = 6'd43;
    for (k = 0; k < 43; k = k + 1) begin
      if (mag[k]) lz = 6'd42 - k[5:0];
    end
    norm = mag << lz;
    round_up = norm[18] && ((|norm[17:0]) || norm[19]);
    rounded = {1'b0, norm[41:19]} + {23'd0, round_up};
    biased = $signed({top_anchor[10], top_anchor}) + 12'sd130 - $signed({6'd0, lz})
             + (rounded[23] ? 12'sd1 : 12'sd0);

    if (any_nan || (inf_pos && inf_neg)) d = QNAN;
    else if (inf_pos || inf_neg) d = {inf_neg, 8'hFF, 23'd0};
    else if (!have_live) d = {all_neg, 31'd0};
    else if (!norm[42]) d = 32'd0;  // the leading bit is clear only when the exact sum is zero
    else if (biased >= 12'sd255) d = {sum[43], 8'hFF, 23'd0};
    else if (biased <= 12'sd0) d = {sum[43], 31'd0};
    else d = {sum[43], biased[7:0], rounded[22:0]};  // a carry leaves the fraction at zero
  end
endmodule
