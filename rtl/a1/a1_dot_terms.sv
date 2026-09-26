// AIMEM-A1 dot product, stage 1 of 3: decode, exact products, MX scales, anchors, the largest anchor,
// and each term's alignment distance. Part of a1_fp_dot4 (see that file for the arithmetic specification).
// Operands are 64-bit rows packing 4 BF16, 8 FP8, or 16 FP4 elements (element k at bits [w*k +: w]).
// Product slots: 0-3 serve every format (up to 8x8-bit significands), 4-7 serve FP8 and FP4 (4x4),
// 8-15 serve FP4 only (2x2). Slot 16 is the FP32 addend.
//
// Term bundle (306 bits):
//   {fmt[1:0], have_live, any_nan, inf_pos, inf_neg, all_neg, top_anchor[10:0],
//    c:{sign, use, dist[5:0], m[23:0]},
//    slots 8-15: 8 x {sign, use, dist[5:0], p[3:0]}, slots 4-7: 4 x {sign, use, dist[5:0], p[7:0]},
//    slots 0-3: 4 x {sign, use, dist[5:0], p[15:0]}}
// use = the term is finite, nonzero, and within the 40-bit window; dist = its right shift.
module a1_dot_terms (
  input  wire [1:0]   fmt,
  input  wire [63:0]  a,
  input  wire [63:0]  b,
  input  wire [31:0]  c,
  input  wire [7:0]   scale_a,  // OCP MX E8M0: 2^(s - 127), 255 = NaN
  input  wire [7:0]   scale_b,
  output wire [305:0] terms
);
  localparam [1:0] E4M3 = 2'd0, E5M2 = 2'd1, BF16 = 2'd2, E2M1 = 2'd3;

  // Decoded element, packed as {sign, nan, inf, zero, m[7:0], e[10:0]}: value = (-1)^sign * m * 2^e.
  function automatic [22:0] decode(input [15:0] x, input [1:0] f);
    reg [7:0] ex;
    reg [6:0] mant;
    reg sign, is_nan, is_inf, is_zero;
    reg [7:0] m;
    reg signed [10:0] e;
    begin
      case (f)
        E4M3: begin  // bias 7, no Inf; NaN = S.1111.111
          sign = x[7]; ex = {4'd0, x[6:3]}; mant = {4'd0, x[2:0]};
          is_nan = (ex == 8'd15) && (mant == 7'd7);
          is_inf = 1'b0;
          m = (ex == 8'd0) ? {5'd0, mant[2:0]} : {5'd1, mant[2:0]};
          e = (ex == 8'd0) ? -11'sd9 : $signed({3'd0, ex}) - 11'sd10;
        end
        E5M2: begin  // bias 15, IEEE-style Inf and NaN
          sign = x[7]; ex = {3'd0, x[6:2]}; mant = {5'd0, x[1:0]};
          is_nan = (ex == 8'd31) && (mant != 7'd0);
          is_inf = (ex == 8'd31) && (mant == 7'd0);
          m = (ex == 8'd0) ? {6'd0, mant[1:0]} : {6'd1, mant[1:0]};
          e = (ex == 8'd0) ? -11'sd16 : $signed({3'd0, ex}) - 11'sd17;
        end
        BF16: begin  // bias 127
          sign = x[15]; ex = x[14:7]; mant = x[6:0];
          is_nan = (ex == 8'd255) && (mant != 7'd0);
          is_inf = (ex == 8'd255) && (mant == 7'd0);
          m = (ex == 8'd0) ? {1'b0, mant} : {1'b1, mant};
          e = (ex == 8'd0) ? -11'sd133 : $signed({3'd0, ex}) - 11'sd134;
        end
        default: begin  // E2M1 (FP4), bias 1, no Inf or NaN
          sign = x[3]; ex = {6'd0, x[2:1]}; mant = {6'd0, x[0]};
          is_nan = 1'b0;
          is_inf = 1'b0;
          m = (ex == 8'd0) ? {7'd0, mant[0]} : {7'd1, mant[0]};
          e = (ex == 8'd0) ? -11'sd1 : $signed({3'd0, ex}) - 11'sd2;
        end
      endcase
      is_zero = (ex == 8'd0) && (mant == 7'd0);
      decode = {sign, is_nan, is_inf, is_zero, m, e};
    end
  endfunction

  // Element k of a row in the current format, right-aligned in 16 bits.
  function automatic [15:0] element(input [63:0] row, input [1:0] f, input integer k);
    begin
      case (f)
        BF16:    element = (k < 4) ? row[16*k +: 16] : 16'd0;
        E2M1:    element = {12'd0, row[4*k +: 4]};
        default: element = (k < 8) ? {8'd0, row[8*k +: 8]} : 16'd0;
      endcase
    end
  endfunction

  wire [4:0] slot_count = (fmt == BF16) ? 5'd4 : (fmt == E2M1) ? 5'd16 : 5'd8;
  wire signed [10:0] prod_width_m1 = (fmt == E4M3) ? 11'sd7 : (fmt == E5M2) ? 11'sd5 : (fmt == BF16) ? 11'sd15 : 11'sd3;
  wire signed [10:0] scale_shift = $signed({3'd0, scale_a}) + $signed({3'd0, scale_b}) - 11'sd254;
  wire scale_nan = (scale_a == 8'hFF) || (scale_b == 8'hFF);

  wire [16:0]  t_sign, t_live, t_nan, t_inf, t_present;
  wire [186:0] t_anchor;  // 17 x signed 11-bit
  wire [63:0] prod_wide;    // slots 0-3:  4 x 16-bit products
  wire [31:0] prod_mid;     // slots 4-7:  4 x 8-bit
  wire [31:0] prod_narrow;  // slots 8-15: 8 x 4-bit

  genvar gk;
  generate
    for (gk = 0; gk < 16; gk = gk + 1) begin : slot
      wire present = gk < slot_count;
      wire [22:0] da = decode(element(a, fmt, gk), fmt);
      wire [22:0] db = decode(element(b, fmt, gk), fmt);
      wire a_nan = da[21], a_inf = da[20], a_zero = da[19];
      wire b_nan = db[21], b_inf = db[20], b_zero = db[19];
      wire p_nan = present && (a_nan || b_nan || (a_inf && b_zero) || (a_zero && b_inf));
      wire p_inf = present && !p_nan && (a_inf || b_inf);
      wire p_zero = !present || (!p_nan && !p_inf && (a_zero || b_zero));
      // Multipliers sized for the widest format that uses the slot.
      if (gk < 4) begin : wide
        assign prod_wide[16*gk +: 16] = {8'd0, da[18:11]} * {8'd0, db[18:11]};
      end else if (gk < 8) begin : mid
        assign prod_mid[8*(gk-4) +: 8] = {4'd0, da[14:11]} * {4'd0, db[14:11]};
        wire unused_bf16_bits = ^{da[18:15], db[18:15]};  // BF16 never reaches slots 4-15
      end else begin : narrow
        assign prod_narrow[4*(gk-8) +: 4] = {2'd0, da[12:11]} * {2'd0, db[12:11]};
        wire unused_wide_bits = ^{da[18:13], db[18:13]};  // only FP4 reaches slots 8-15
      end
      assign t_present[gk] = present;
      assign t_sign[gk] = da[22] ^ db[22];
      assign t_nan[gk] = p_nan;
      assign t_inf[gk] = p_inf;
      assign t_live[gk] = !p_nan && !p_inf && !p_zero;
      assign t_anchor[11*gk +: 11] = $signed(da[10:0]) + $signed(db[10:0]) + scale_shift + prod_width_m1;
    end
  endgenerate

  // FP32 addend: value = m * 2^e, width 24, anchor e + 23.
  wire [7:0]  c_ex = c[30:23];
  wire        c_nan = (c_ex == 8'hFF) && (c[22:0] != 23'd0);
  wire        c_inf = (c_ex == 8'hFF) && (c[22:0] == 23'd0);
  wire        c_zero = (c_ex == 8'h00) && (c[22:0] == 23'd0);
  wire signed [10:0] c_e = (c_ex == 8'h00) ? -11'sd149 : $signed({3'd0, c_ex}) - 11'sd150;
  wire [23:0] c_m = {(c_ex != 8'h00), c[22:0]};
  assign t_present[16] = 1'b1;
  assign t_sign[16] = c[31];
  assign t_nan[16] = c_nan;
  assign t_inf[16] = c_inf;
  assign t_live[16] = !c_nan && !c_inf && !c_zero;
  assign t_anchor[176 +: 11] = c_e + 11'sd23;

  wire have_live = |t_live;
  wire any_nan = scale_nan || |t_nan;
  wire inf_pos = |(t_inf & ~t_sign);
  wire inf_neg = |(t_inf & t_sign);
  wire all_neg = &(t_sign | ~t_present);  // sign of an all-zero result: every present term negative

  reg signed [10:0] top_anchor;
  reg signed [10:0] anchor_k;
  reg [10:0] gap;
  reg [16:0] t_use;
  reg [101:0] t_dist;  // 17 x 6 bits
  integer k;

  always @* begin
    top_anchor = -11'sd1024;
    for (k = 0; k < 17; k = k + 1) begin
      anchor_k = t_anchor[11*k +: 11];
      if (t_live[k] && anchor_k > top_anchor) top_anchor = anchor_k;
    end
    for (k = 0; k < 17; k = k + 1) begin
      anchor_k = t_anchor[11*k +: 11];
      gap = top_anchor - anchor_k;
      t_use[k] = t_live[k] && (gap < 11'd40);
      t_dist[6*k +: 6] = gap[5:0];
    end
  end

  genvar gs;
  wire [95:0] wide_fields;
  wire [63:0] mid_fields;
  wire [95:0] narrow_fields;
  generate
    for (gs = 0; gs < 4; gs = gs + 1) begin : pack_wide
      assign wide_fields[24*gs +: 24] = {t_sign[gs], t_use[gs], t_dist[6*gs +: 6], prod_wide[16*gs +: 16]};
    end
    for (gs = 4; gs < 8; gs = gs + 1) begin : pack_mid
      assign mid_fields[16*(gs-4) +: 16] = {t_sign[gs], t_use[gs], t_dist[6*gs +: 6], prod_mid[8*(gs-4) +: 8]};
    end
    for (gs = 8; gs < 16; gs = gs + 1) begin : pack_narrow
      assign narrow_fields[12*(gs-8) +: 12] = {t_sign[gs], t_use[gs], t_dist[6*gs +: 6], prod_narrow[4*(gs-8) +: 4]};
    end
  endgenerate

  assign terms = {fmt, have_live, any_nan, inf_pos, inf_neg, all_neg, top_anchor,
                  t_sign[16], t_use[16], t_dist[96 +: 6], c_m, narrow_fields, mid_fields, wide_fields};
endmodule
