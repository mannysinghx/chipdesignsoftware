// AIMEM-A1 tensor tile, increment 1 (C2 of docs/COMPUTE_DIE_PLAN.md).
// A 4x4x4 matrix-multiply-accumulate step per accepted command, D = C + A x B, into an
// accumulator memory of ACC_ENTRIES 4x4 FP32 tiles held beside the array (the TMEM idea: the
// accumulators never pass through a register file). Sixteen a1_fp_dot4 units, one per output.
//
// Commands (valid/ready): ZERO acc[i] <- +0 | LOAD acc[i] <- cmd_c | MMA acc[i] <- acc[i] + A x B |
// READ -> one response with acc[i]. Responses (valid/ready) are held stable until taken, and a
// command is accepted only when its response slot is free: cmd_ready = !rsp_valid || rsp_ready.
// Operand lanes are row-major: A[i][k] at cmd_a[16*(4i+k) +: 16], B[k][j] at cmd_b[16*(4k+j) +: 16],
// C/D[i][j] at 32*(4i+j). An MMA completes in the cycle it is accepted (single-cycle datapath;
// pipelining is left to the physical step, C3).
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
  input  wire [511:0]      cmd_c,
  output reg               rsp_valid,
  input  wire              rsp_ready,
  output reg  [511:0]      rsp_data
);
  localparam [1:0] OP_ZERO = 2'd0, OP_LOAD = 2'd1, OP_MMA = 2'd2, OP_READ = 2'd3;

  reg [511:0] acc [0:ACC_ENTRIES-1];
  wire [511:0] acc_sel = acc[cmd_acc];
  wire [511:0] mma_d;

  assign cmd_ready = !rsp_valid || rsp_ready;
  wire accept = cmd_valid && cmd_ready;

`ifdef A1_ABSTRACT_DATAPATH
  (* anyseq *) reg [511:0] abstract_d;
  assign mma_d = abstract_d;
`else
  genvar gi, gj;
  generate
    for (gi = 0; gi < 4; gi = gi + 1) begin : row
      for (gj = 0; gj < 4; gj = gj + 1) begin : col
        a1_fp_dot4 dot (
          .fmt(cmd_fmt),
          .a(cmd_a[64*gi +: 64]),
          .b({cmd_b[16*(12+gj) +: 16], cmd_b[16*(8+gj) +: 16], cmd_b[16*(4+gj) +: 16], cmd_b[16*gj +: 16]}),
          .c(acc_sel[32*(4*gi+gj) +: 32]),
          .d(mma_d[32*(4*gi+gj) +: 32])
        );
      end
    end
  endgenerate
`endif

  integer e;
  always @(posedge clk) begin
    if (!rst_n) begin
      for (e = 0; e < ACC_ENTRIES; e = e + 1) acc[e] <= 512'd0;
      rsp_valid <= 1'b0;
      rsp_data <= 512'd0;
    end else begin
      if (rsp_valid && rsp_ready) rsp_valid <= 1'b0;
      if (accept) begin
        case (cmd_op)
          OP_ZERO: acc[cmd_acc] <= 512'd0;
          OP_LOAD: acc[cmd_acc] <= cmd_c;
          OP_MMA:  acc[cmd_acc] <= mma_d;
          OP_READ: begin
            rsp_valid <= 1'b1;
            rsp_data <= acc_sel;
          end
        endcase
      end
    end
  end

`ifdef FORMAL
  // One accumulator entry, chosen by the solver, is tracked by a shadow copy. ZERO and LOAD make the
  // shadow exact; an MMA into it makes it unknown. A READ of the tracked entry must return the shadow.
  (* anyconst *) reg [IDX_W-1:0] f_idx;
  reg         f_past_valid = 1'b0;
  reg         f_shadow_valid = 1'b0;
  reg [511:0] f_shadow = 512'd0;
  reg         f_expect_valid = 1'b0;
  reg [511:0] f_expect = 512'd0;
  reg         f_outstanding = 1'b0;

  always @(posedge clk) begin
    f_past_valid <= 1'b1;
    if (!rst_n) begin
      f_shadow_valid <= 1'b1;
      f_shadow <= 512'd0;
      f_expect_valid <= 1'b0;
      f_outstanding <= 1'b0;
    end else begin
      if (rsp_valid && rsp_ready) begin
        f_expect_valid <= 1'b0;
        f_outstanding <= 1'b0;
      end
      if (accept) begin
        if (cmd_op == OP_READ) begin
          f_outstanding <= 1'b1;
          f_expect_valid <= f_shadow_valid && (cmd_acc == f_idx);
          f_expect <= f_shadow;
        end else if (cmd_acc == f_idx) begin
          f_shadow_valid <= cmd_op != OP_MMA;
          f_shadow <= (cmd_op == OP_LOAD) ? cmd_c : 512'd0;
        end
      end
    end
  end

  always @(*) begin
    if (f_past_valid && rst_n) begin
      assert (cmd_ready == (!rsp_valid || rsp_ready));
      assert (rsp_valid == f_outstanding);                    // exactly one response per accepted READ
      assert (!f_expect_valid || rsp_valid);
      assert (!f_shadow_valid || acc[f_idx] == f_shadow);     // writes land in the addressed entry only
      assert (!(rsp_valid && f_expect_valid) || rsp_data == f_expect);  // READ returns that entry
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
    end
  end
`endif
endmodule
