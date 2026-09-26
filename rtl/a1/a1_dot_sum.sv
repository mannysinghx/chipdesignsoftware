// AIMEM-A1 dot product, stage 2 of 3: place each product at the top of the 40-bit window, shift it
// right by its alignment distance (truncating), and sum all 17 terms exactly.
// Part of a1_fp_dot4 (see that file for the arithmetic specification).
// Partial (62 bits): {have_live, any_nan, inf_pos, inf_neg, all_neg, top_anchor[10:0], sum[45:0]}
// |sum| < 17 * 2^40 < 2^45, so 46 signed bits are exact.
module a1_dot_sum (
  input  wire [305:0] terms,
  output wire [61:0]  partial
);
  localparam [1:0] E4M3 = 2'd0, E5M2 = 2'd1, BF16 = 2'd2;

  wire [1:0]  fmt = terms[305:304];
  wire [4:0]  flags = terms[303:299];
  wire [10:0] top_anchor = terms[298:288];
  wire [31:0] c_field = terms[287:256];
  wire [95:0] narrow_fields = terms[255:160];
  wire [63:0] mid_fields = terms[159:96];
  wire [95:0] wide_fields = terms[95:0];

  // Left shift that puts a product's nominal MSB at window bit 39: 40 - (product width).
  wire [5:0] top_shift = (fmt == E4M3) ? 6'd32 : (fmt == E5M2) ? 6'd34 : (fmt == BF16) ? 6'd24 : 6'd36;

  function automatic signed [45:0] term(input sign, input live, input [5:0] shift, input [39:0] placed);
    reg [39:0] aligned;
    begin
      aligned = live ? (placed >> shift) : 40'd0;
      term = sign ? -$signed({6'd0, aligned}) : $signed({6'd0, aligned});
    end
  endfunction

  reg signed [45:0] sum;
  integer k;
  always @* begin
    sum = term(c_field[31], c_field[30], c_field[29:24], {c_field[23:0], 16'd0});
    for (k = 0; k < 4; k = k + 1)
      sum = sum + term(wide_fields[24*k + 23], wide_fields[24*k + 22], wide_fields[24*k + 16 +: 6],
                       {24'd0, wide_fields[24*k +: 16]} << top_shift);
    for (k = 0; k < 4; k = k + 1)
      sum = sum + term(mid_fields[16*k + 15], mid_fields[16*k + 14], mid_fields[16*k + 8 +: 6],
                       {32'd0, mid_fields[16*k +: 8]} << top_shift);
    for (k = 0; k < 8; k = k + 1)
      sum = sum + term(narrow_fields[12*k + 11], narrow_fields[12*k + 10], narrow_fields[12*k + 4 +: 6],
                       {36'd0, narrow_fields[12*k +: 4]} << top_shift);
  end

  assign partial = {flags, top_anchor, sum};
endmodule
