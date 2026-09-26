// AIMEM-A1 fused 4-term dot product with FP32 accumulate (C2 of docs/COMPUTE_DIE_PLAN.md).
//   d = round_fp32(c + a0*b0 + a1*b1 + a2*b2 + a3*b3)
// Combinational. The arithmetic is specified by verification/a1/golden.py and must match it bit for bit:
// exact products, alignment of every term into a 40-bit window below the largest term (truncating),
// an exact integer sum, one round-to-nearest-even to FP32, overflow to Inf, and flush-to-zero outputs.
// fmt: 0 = FP8 E4M3, 1 = FP8 E5M2, 2 = BF16. FP8 operands use bits [7:0] of each 16-bit lane.
// Architecture follows the fused dot-product structure of Vortex's Ten-Four unit (arXiv 2512.00053),
// written from scratch so that it has no Vortex dependencies.
module a1_fp_dot4 (
  input  wire [1:0]  fmt,
  input  wire [63:0] a,  // lane k at [16k +: 16]
  input  wire [63:0] b,
  input  wire [31:0] c,
  output reg  [31:0] d
);
  localparam [31:0] QNAN = 32'h7FC00000;

  // Decoded operand, packed as {sign, nan, inf, zero, m[7:0], e[10:0]}: value = (-1)^sign * m * 2^e.
  function automatic [22:0] decode(input [15:0] x, input [1:0] f);
    reg [7:0] ex;
    reg [6:0] mant;
    reg sign, is_nan, is_inf, is_zero;
    reg [7:0] m;
    reg signed [10:0] e;
    begin
      case (f)
        2'd0: begin  // E4M3, bias 7, no Inf; NaN = S.1111.111
          sign = x[7]; ex = {4'd0, x[6:3]}; mant = {4'd0, x[2:0]};
          is_nan = (ex == 8'd15) && (mant == 7'd7);
          is_inf = 1'b0;
          m = (ex == 8'd0) ? {5'd0, mant[2:0]} : {5'd1, mant[2:0]};
          e = (ex == 8'd0) ? -11'sd9 : $signed({3'd0, ex}) - 11'sd10;
        end
        2'd1: begin  // E5M2, bias 15, IEEE-style Inf and NaN
          sign = x[7]; ex = {3'd0, x[6:2]}; mant = {5'd0, x[1:0]};
          is_nan = (ex == 8'd31) && (mant != 7'd0);
          is_inf = (ex == 8'd31) && (mant == 7'd0);
          m = (ex == 8'd0) ? {6'd0, mant[1:0]} : {6'd1, mant[1:0]};
          e = (ex == 8'd0) ? -11'sd16 : $signed({3'd0, ex}) - 11'sd17;
        end
        default: begin  // BF16, bias 127
          sign = x[15]; ex = x[14:7]; mant = x[6:0];
          is_nan = (ex == 8'd255) && (mant != 7'd0);
          is_inf = (ex == 8'd255) && (mant == 7'd0);
          m = (ex == 8'd0) ? {1'b0, mant} : {1'b1, mant};
          e = (ex == 8'd0) ? -11'sd133 : $signed({3'd0, ex}) - 11'sd134;
        end
      endcase
      is_zero = (ex == 8'd0) && (mant == 7'd0);
      decode = {sign, is_nan, is_inf, is_zero, m, e};
    end
  endfunction

  // Products sit at the top of the 40-bit window: shift = 40 - 2q (q = 4, 3, 8 significand bits).
  wire [5:0] prod_top_shift = (fmt == 2'd0) ? 6'd32 : (fmt == 2'd1) ? 6'd34 : 6'd24;
  wire signed [10:0] prod_width_m1 = (fmt == 2'd0) ? 11'sd7 : (fmt == 2'd1) ? 11'sd5 : 11'sd15;

  // Per-term data for 4 products and the addend (term 4), packed by index.
  wire [4:0]  t_sign, t_live, t_nan, t_inf;
  wire [54:0] t_anchor;  // 5 x signed 11-bit
  wire [199:0] t_top;    // 5 x 40-bit significand placed at the top of the window

  genvar gk;
  generate
    for (gk = 0; gk < 4; gk = gk + 1) begin : lane
      wire [22:0] da = decode(a[16*gk +: 16], fmt);
      wire [22:0] db = decode(b[16*gk +: 16], fmt);
      wire a_s = da[22], a_nan = da[21], a_inf = da[20], a_zero = da[19];
      wire b_s = db[22], b_nan = db[21], b_inf = db[20], b_zero = db[19];
      wire [7:0] a_m = da[18:11], b_m = db[18:11];
      wire signed [10:0] a_e = da[10:0], b_e = db[10:0];
      wire p_nan = a_nan || b_nan || (a_inf && b_zero) || (a_zero && b_inf);
      wire p_inf = !p_nan && (a_inf || b_inf);
      wire p_zero = !p_nan && !p_inf && (a_zero || b_zero);
      wire [15:0] product = {8'd0, a_m} * {8'd0, b_m};
      assign t_sign[gk] = a_s ^ b_s;
      assign t_nan[gk] = p_nan;
      assign t_inf[gk] = p_inf;
      assign t_live[gk] = !p_nan && !p_inf && !p_zero;
      assign t_anchor[11*gk +: 11] = a_e + b_e + prod_width_m1;
      assign t_top[40*gk +: 40] = {24'd0, product} << prod_top_shift;
    end
  endgenerate

  // FP32 addend: value = m * 2^e, width 24, anchor e + 23.
  wire [7:0]  c_ex = c[30:23];
  wire        c_nan = (c_ex == 8'hFF) && (c[22:0] != 23'd0);
  wire        c_inf = (c_ex == 8'hFF) && (c[22:0] == 23'd0);
  wire        c_zero = (c_ex == 8'h00) && (c[22:0] == 23'd0);
  wire signed [10:0] c_e = (c_ex == 8'h00) ? -11'sd149 : $signed({3'd0, c_ex}) - 11'sd150;
  assign t_sign[4] = c[31];
  assign t_nan[4] = c_nan;
  assign t_inf[4] = c_inf;
  assign t_live[4] = !c_nan && !c_inf && !c_zero;
  assign t_anchor[44 +: 11] = c_e + 11'sd23;
  assign t_top[160 +: 40] = {(c_ex != 8'h00), c[22:0], 16'd0};

  wire any_nan = |t_nan;
  wire inf_pos = |(t_inf & ~t_sign);
  wire inf_neg = |(t_inf & t_sign);
  wire all_neg = &t_sign;  // decides the sign of an all-zero result
  wire have_live = |t_live;

  reg signed [10:0] top_anchor;
  reg signed [10:0] anchor_k;
  reg [10:0] shift_dist;
  reg [39:0] aligned;
  reg signed [43:0] sum;
  reg [42:0] mag;
  reg [5:0]  lz;
  reg [42:0] norm;
  reg        round_up;
  reg [23:0] rounded;  // {carry, 23 fraction bits}; the hidden bit is norm[42]
  reg signed [11:0] biased;
  integer    k;

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
