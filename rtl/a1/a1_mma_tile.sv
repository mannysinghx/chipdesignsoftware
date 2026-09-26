// AIMEM-A1 tensor tile (C2 of docs/COMPUTE_DIE_PLAN.md), pipelined.
// A 4x4xK matrix-multiply-accumulate per accepted command, D = C + Xa Xb (A x B), into an accumulator
// memory of ACC_ENTRIES 4x4 FP32 tiles held beside the array (the TMEM idea: accumulators never pass
// through a register file). Sixteen dot-product units, each split into the three stages of a1_fp_dot4.
// Each 64-bit operand row packs K = 4 BF16, 8 FP8, or 16 FP4 elements, so one step does 64, 128, or 256
// multiplies from the same 512 operand bits. Xa (per A row) and Xb (per B column) are OCP MX E8M0 scales.
//
// Commands (valid/ready): ZERO acc[i] <- +0 | LOAD acc[i] <- cmd_c | MMA acc[i] <- acc[i] + A x B |
// READ -> one response with acc[i]. Responses (valid/ready) are held stable until taken.
// Operands: row i of A at cmd_a[64i +: 64] and column j of B at cmd_b[64j +: 64], elements packed as in
// a1_fp_dot4; scale of A row i at cmd_scale_a[8i +: 8], of B column j at cmd_scale_b[8j +: 8];
// C/D[i][j] at 32*(4i+j). fmt: 0 = FP8 E4M3, 1 = FP8 E5M2, 2 = BF16, 3 = FP4 E2M1.
//
// Pipeline (in order, one command per cycle):
//   S1  MMA reads its accumulator; decode and multiply (a1_dot_terms)
//   S2  align and sum (a1_dot_sum)
//   S3  normalize and round (a1_dot_round); ZERO, LOAD, and MMA commit; READ reads and responds
// READ reads at S3, after every older write has committed. The one hazard is an MMA whose accumulator
// an older command in S1 or S2 will write: it is held until that write commits. A chain of MMAs into
// one accumulator therefore runs at one per 3 cycles; rotating over 3 or more accumulators runs at one
// per cycle. A READ that cannot hand over its response (rsp_valid && !rsp_ready) stalls the pipeline.
//
// Formal: read with -D FORMAL to check the embedded properties below; add -D A1_ABSTRACT_DATAPATH to
// replace the arithmetic with unconstrained values so the control proof covers any datapath result.
module a1_mma_tile #(
  parameter integer ACC_ENTRIES = 4,
  parameter integer IDX_W = 2
) (
  input  wire              clk,
  input  wire              rst_n,
  input  wire              cmd_valid,
  output wire              cmd_ready,
  input  wire [1:0]        cmd_op,
  input  wire [1:0]        cmd_fmt,
  input  wire [IDX_W-1:0]  cmd_acc,
  input  wire [255:0]      cmd_a,
  input  wire [255:0]      cmd_b,
  input  wire [31:0]       cmd_scale_a,
  input  wire [31:0]       cmd_scale_b,
  input  wire [511:0]      cmd_c,
  output reg               rsp_valid,
  input  wire              rsp_ready,
  output reg  [511:0]      rsp_data
);
  localparam [1:0] OP_ZERO = 2'd0, OP_LOAD = 2'd1, OP_MMA = 2'd2, OP_READ = 2'd3;

  reg [511:0] acc [0:ACC_ENTRIES-1];

  // Pipeline registers. LOAD carries its data to the commit stage.
  reg             s1_valid, s2_valid, s3_valid;
  reg [1:0]       s1_op, s2_op, s3_op;
  reg [1:0]       s1_fmt;
  reg [IDX_W-1:0] s1_idx, s2_idx, s3_idx;
  reg [255:0]     s1_a, s1_b;
  reg [31:0]      s1_scale_a, s1_scale_b;
  reg [511:0]     s1_c, s2_c, s3_c;

  // A READ in S3 whose response slot is still occupied holds the whole pipeline.
  wire stall = s3_valid && (s3_op == OP_READ) && rsp_valid && !rsp_ready;
  // An MMA reads its accumulator in S1; commands now in S1 or S2 would not have committed by then.
  wire hazard = (cmd_op == OP_MMA) &&
                ((s1_valid && s1_op != OP_READ && s1_idx == cmd_acc) ||
                 (s2_valid && s2_op != OP_READ && s2_idx == cmd_acc));
  assign cmd_ready = !stall && !hazard;
  wire accept = cmd_valid && cmd_ready;

  wire [511:0] mma_d;  // S3 result of an MMA

`ifdef A1_ABSTRACT_DATAPATH
  (* anyseq *) reg [511:0] abstract_d;
  assign mma_d = abstract_d;
`else
  wire [511:0]  s1_acc = acc[s1_idx];
  reg  [4895:0] s2_terms;    // 16 x 306
  reg  [991:0]  s3_partial;  // 16 x 62
  wire [4895:0] s1_terms_next;
  wire [991:0]  s2_partial_next;

  genvar gi, gj;
  generate
    for (gi = 0; gi < 4; gi = gi + 1) begin : row
      for (gj = 0; gj < 4; gj = gj + 1) begin : col
        localparam integer N = 4 * gi + gj;
        a1_dot_terms u_terms (
          .fmt(s1_fmt),
          .a(s1_a[64*gi +: 64]),
          .b(s1_b[64*gj +: 64]),
          .c(s1_acc[32*N +: 32]),
          .scale_a(s1_scale_a[8*gi +: 8]),
          .scale_b(s1_scale_b[8*gj +: 8]),
          .terms(s1_terms_next[306*N +: 306])
        );
        a1_dot_sum u_sum (.terms(s2_terms[306*N +: 306]), .partial(s2_partial_next[62*N +: 62]));
        a1_dot_round u_round (.partial(s3_partial[62*N +: 62]), .d(mma_d[32*N +: 32]));
      end
    end
  endgenerate

  always @(posedge clk) begin
    if (!stall) begin
      s2_terms <= s1_terms_next;
      s3_partial <= s2_partial_next;
    end
  end
`endif

  integer e;
  always @(posedge clk) begin
    if (!rst_n) begin
      for (e = 0; e < ACC_ENTRIES; e = e + 1) acc[e] <= 512'd0;
      s1_valid <= 1'b0;
      s2_valid <= 1'b0;
      s3_valid <= 1'b0;
      rsp_valid <= 1'b0;
      rsp_data <= 512'd0;
    end else begin
      if (rsp_valid && rsp_ready) rsp_valid <= 1'b0;
      if (!stall) begin
        // commit at S3
        if (s3_valid) begin
          case (s3_op)
            OP_ZERO: acc[s3_idx] <= 512'd0;
            OP_LOAD: acc[s3_idx] <= s3_c;
            OP_MMA:  acc[s3_idx] <= mma_d;
            OP_READ: begin
              rsp_valid <= 1'b1;
              rsp_data <= acc[s3_idx];
            end
          endcase
        end
        // advance
        s3_valid <= s2_valid;
        s3_op <= s2_op;
        s3_idx <= s2_idx;
        s3_c <= s2_c;
        s2_valid <= s1_valid;
        s2_op <= s1_op;
        s2_idx <= s1_idx;
        s2_c <= s1_c;
        s1_valid <= accept;
        s1_op <= cmd_op;
        s1_fmt <= cmd_fmt;
        s1_idx <= cmd_acc;
        s1_a <= cmd_a;
        s1_b <= cmd_b;
        s1_scale_a <= cmd_scale_a;
        s1_scale_b <= cmd_scale_b;
        s1_c <= cmd_c;
      end
    end
  end

`ifdef FORMAL
  // One accumulator entry, chosen by the solver, is tracked by a shadow updated at commit (S3), when
  // the accumulator itself is. ZERO and LOAD make the shadow exact; an MMA into it makes it unknown.
  // A READ of the tracked entry must return the shadow.
  (* anyconst *) reg [IDX_W-1:0] f_idx;
  reg         f_past_valid = 1'b0;
  reg         f_shadow_valid = 1'b0;
  reg [511:0] f_shadow = 512'd0;
  reg         f_expect_valid = 1'b0;
  reg [511:0] f_expect = 512'd0;
  reg [2:0]   f_reads = 3'd0;  // accepted READs whose response has not been taken

  wire commit = !stall && s3_valid;
  wire [2:0] f_reads_in_pipe = {2'd0, s1_valid && s1_op == OP_READ} + {2'd0, s2_valid && s2_op == OP_READ}
                             + {2'd0, s3_valid && s3_op == OP_READ} + {2'd0, rsp_valid};

  always @(posedge clk) begin
    f_past_valid <= 1'b1;
    if (!rst_n) begin
      f_shadow_valid <= 1'b1;
      f_shadow <= 512'd0;
      f_expect_valid <= 1'b0;
      f_reads <= 3'd0;
    end else begin
      f_reads <= f_reads + {2'd0, accept && cmd_op == OP_READ} - {2'd0, rsp_valid && rsp_ready};
      if (rsp_valid && rsp_ready) f_expect_valid <= 1'b0;
      if (commit && s3_op == OP_READ) begin
        f_expect_valid <= f_shadow_valid && (s3_idx == f_idx);
        f_expect <= f_shadow;
      end else if (commit && s3_idx == f_idx) begin
        f_shadow_valid <= s3_op != OP_MMA;
        f_shadow <= (s3_op == OP_LOAD) ? s3_c : 512'd0;
      end
    end
  end

  always @(*) begin
    if (f_past_valid && rst_n) begin
      assert (!stall || !cmd_ready);                          // nothing is accepted while stalled
      assert (f_reads == f_reads_in_pipe);                    // no READ is lost or duplicated
      assert (!f_expect_valid || rsp_valid);
      assert (!f_shadow_valid || acc[f_idx] == f_shadow);     // commits land in the addressed entry only
      assert (!(rsp_valid && f_expect_valid) || rsp_data == f_expect);  // READ returns that entry
      if (s1_valid && s1_op == OP_MMA) begin                  // an MMA never reads a stale accumulator
        assert (!(s2_valid && s2_op != OP_READ && s2_idx == s1_idx));
        assert (!(s3_valid && s3_op != OP_READ && s3_idx == s1_idx));
      end
    end
  end

  always @(posedge clk) begin
    if (f_past_valid && rst_n && $past(rst_n) && $past(rsp_valid && !rsp_ready)) begin
      assert (rsp_valid);                                     // a response is held until taken
      assert (rsp_data == $past(rsp_data));
    end
    if (f_past_valid && rst_n && !$past(rst_n)) assert (!rsp_valid);  // reset leaves no response
    if (f_past_valid && rst_n) begin
      cover (rsp_valid && !rsp_ready && f_expect_valid);      // backpressure on a checked response
      cover (rsp_valid && rsp_ready && f_expect_valid && rsp_data != 512'd0);  // LOAD then READ back
      cover (s1_valid && s2_valid && s3_valid && s1_op == OP_MMA && s2_op == OP_MMA && s3_op == OP_MMA);  // full pipe
      cover (cmd_valid && hazard && !stall);                  // an MMA held by the accumulator hazard
    end
  end
`endif
endmodule
