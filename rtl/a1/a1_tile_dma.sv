// AIMEM-A1 tile DMA (C2 increment 2c of docs/COMPUTE_DIE_PLAN.md): a descriptor-driven operand engine in
// the spirit of Hopper's Tensor Memory Accelerator. One descriptor runs a K-loop into one accumulator:
// for each of `steps` MMA steps it fetches the 4 rows of A and the 4 columns of B (eight 64-bit words)
// from memory and issues one MMA to a1_mma_tile, with the descriptor's MX scales.
//
// Addresses (bytes) for step s:
//   A row i:    a_base + s * a_step_stride + i * a_row_stride
//   B column j: b_base + s * b_step_stride + j * b_col_stride
// The memory port is valid/ready for requests and returns 64-bit words in request order. Two 8-word fill
// buffers (ping-pong) take responses; a request is issued only when they can absorb every outstanding
// response (16 words of credit), so responses never stall (mem_rsp_ready is always high) and the next
// step's words stream in while the current step completes. A full fill buffer moves to the issue
// buffer, which presents the MMA. With one 64-bit word per cycle the engine sustains at most one MMA per 8 cycles; the tile
// can take one per cycle, so operand bandwidth, not math, sets the rate at this port width.
// `done` pulses in the cycle the descriptor's last MMA is accepted (or when a descriptor has 0 steps).
module a1_tile_dma #(
  parameter integer IDX_W = 2
) (
  input  wire              clk,
  input  wire              rst_n,
  // descriptor
  input  wire              desc_valid,
  output wire              desc_ready,
  input  wire [1:0]        desc_fmt,
  input  wire [IDX_W-1:0]  desc_acc,
  input  wire [15:0]       desc_steps,
  input  wire [31:0]       desc_a_base,
  input  wire [31:0]       desc_a_row_stride,
  input  wire [31:0]       desc_a_step_stride,
  input  wire [31:0]       desc_b_base,
  input  wire [31:0]       desc_b_col_stride,
  input  wire [31:0]       desc_b_step_stride,
  input  wire [31:0]       desc_scale_a,
  input  wire [31:0]       desc_scale_b,
  // memory read port
  output wire              mem_req_valid,
  input  wire              mem_req_ready,
  output wire [31:0]       mem_req_addr,
  input  wire              mem_rsp_valid,
  output wire              mem_rsp_ready,
  input  wire [63:0]       mem_rsp_data,
  // MMA commands to a1_mma_tile
  output wire              mma_valid,
  input  wire              mma_ready,
  output reg  [1:0]        mma_fmt,
  output reg  [IDX_W-1:0]  mma_acc,
  output reg  [255:0]      mma_a,
  output reg  [255:0]      mma_b,
  output reg  [31:0]       mma_scale_a,
  output reg  [31:0]       mma_scale_b,
  output reg               done,
  output wire              busy
);
  reg        active;
  reg [15:0] steps, req_step, issued;
  reg [2:0]  req_word;          // next word to request within req_step: 0-3 A rows, 4-7 B columns
  reg [31:0] a_step_base, b_step_base, word_offset;
  reg [31:0] a_row_stride, a_step_stride, b_col_stride, b_step_stride;

  reg [511:0] fill0, fill1;     // words arrive in order per step: A rows 0-3, then B columns 0-3
  reg [3:0]   count0, count1;   // words received into each fill buffer
  reg         wr_buf, rd_buf;   // buffer receiving responses / next buffer to issue
  reg [4:0]   inflight;         // requested, not yet received
  reg         ready_valid;      // a complete step waits in the issue buffer

  assign busy = active;
  assign desc_ready = !active;
  assign mem_rsp_ready = 1'b1;
  assign mma_valid = ready_valid;

  wire requesting = active && (req_step != steps);
  wire [5:0] held = {2'd0, count0} + {2'd0, count1} + {1'b0, inflight};
  assign mem_req_valid = requesting && (held < 6'd16);
  wire [31:0] word_base = (req_word < 3'd4) ? a_step_base : b_step_base;
  assign mem_req_addr = word_base + word_offset;

  wire req_fire = mem_req_valid && mem_req_ready;
  wire rsp_fire = mem_rsp_valid && mem_rsp_ready;
  wire mma_fire = mma_valid && mma_ready;
  // A full fill buffer moves to the issue buffer when that is empty or being taken this cycle.
  wire rd_full = rd_buf ? (count1 == 4'd8) : (count0 == 4'd8);
  wire fill_complete = rd_full && (!ready_valid || mma_fire);
  wire last_issue = mma_fire && (issued + 16'd1 == steps);

  always @(posedge clk) begin
    if (!rst_n) begin
      active <= 1'b0;
      steps <= 16'd0;
      req_step <= 16'd0;
      issued <= 16'd0;
      req_word <= 3'd0;
      word_offset <= 32'd0;
      count0 <= 4'd0;
      count1 <= 4'd0;
      wr_buf <= 1'b0;
      rd_buf <= 1'b0;
      inflight <= 5'd0;
      ready_valid <= 1'b0;
      done <= 1'b0;
    end else begin
      done <= 1'b0;
      if (desc_valid && desc_ready) begin
        if (desc_steps == 16'd0) begin
          done <= 1'b1;
        end else begin
          active <= 1'b1;
          steps <= desc_steps;
          req_step <= 16'd0;
          issued <= 16'd0;
          req_word <= 3'd0;
          word_offset <= 32'd0;
          a_step_base <= desc_a_base;
          b_step_base <= desc_b_base;
          a_row_stride <= desc_a_row_stride;
          a_step_stride <= desc_a_step_stride;
          b_col_stride <= desc_b_col_stride;
          b_step_stride <= desc_b_step_stride;
          mma_fmt <= desc_fmt;
          mma_acc <= desc_acc;
          mma_scale_a <= desc_scale_a;
          mma_scale_b <= desc_scale_b;
        end
      end

      // request side: walk A rows, then B columns, then move to the next step
      if (req_fire) begin
        req_word <= req_word + 3'd1;
        if (req_word == 3'd3 || req_word == 3'd7) word_offset <= 32'd0;
        else word_offset <= word_offset + ((req_word < 3'd4) ? a_row_stride : b_col_stride);
        if (req_word == 3'd7) begin
          req_step <= req_step + 16'd1;
          a_step_base <= a_step_base + a_step_stride;
          b_step_base <= b_step_base + b_step_stride;
        end
      end
      inflight <= inflight + {4'd0, req_fire} - {4'd0, rsp_fire};

      // fill side: responses go to wr_buf; a buffer that reaches 8 words hands over to the other one
      if (rsp_fire) begin
        if (wr_buf) fill1[64*count1[2:0] +: 64] <= mem_rsp_data;
        else fill0[64*count0[2:0] +: 64] <= mem_rsp_data;
        if ((wr_buf ? count1 : count0) == 4'd7) wr_buf <= !wr_buf;
      end
      if (fill_complete) begin
        ready_valid <= 1'b1;
        mma_a <= rd_buf ? fill1[255:0] : fill0[255:0];
        mma_b <= rd_buf ? fill1[511:256] : fill0[511:256];
        rd_buf <= !rd_buf;
      end
      count0 <= (fill_complete && !rd_buf) ? 4'd0 : count0 + {3'd0, rsp_fire && !wr_buf};
      count1 <= (fill_complete && rd_buf) ? 4'd0 : count1 + {3'd0, rsp_fire && wr_buf};

      // issue side
      if (mma_fire && !fill_complete) ready_valid <= 1'b0;
      if (mma_fire) issued <= issued + 16'd1;
      if (last_issue) begin
        active <= 1'b0;
        done <= 1'b1;
      end
    end
  end

`ifdef FORMAL
  // Environment: memory answers only what was asked.
  reg f_past_valid = 1'b0;
  always @(posedge clk) f_past_valid <= 1'b1;
  always @(*) if (rst_n && f_past_valid) assume (!mem_rsp_valid || inflight != 5'd0);

  reg [15:0] f_issued_this_desc = 16'd0;
  always @(posedge clk) begin
    if (!rst_n || (desc_valid && desc_ready)) f_issued_this_desc <= 16'd0;
    else if (mma_fire) f_issued_this_desc <= f_issued_this_desc + 16'd1;
  end

  always @(*) begin
    if (rst_n && f_past_valid) begin
      assert (held <= 6'd16);                                     // credit never exceeded
      assert (count0 <= 4'd8 && count1 <= 4'd8);
      assert (!(rsp_fire && (wr_buf ? count1 : count0) == 4'd8));  // a response never lands in a full buffer
      assert (!active ? !ready_valid && held == 6'd0 : 1'b1);      // idle means nothing is buffered or presented
      assert (active || rd_buf == wr_buf);                         // each completed step flips both buffer pointers
      assert (!active || issued <= steps);
      assert (!active || req_step <= steps);
      assert (!active || issued == f_issued_this_desc);            // issued counts this descriptor's MMAs
      if (active && req_step == steps) assert (req_word == 3'd0);
      if (active) begin
        assert (issued <= req_step);                               // a step is issued only after it is fetched
        // Every word fetched for a step not yet issued is in flight, in a fill buffer, or in the issue buffer.
        assert ({(req_step - issued), 3'd0} + {16'd0, req_word} == {13'd0, held} + (ready_valid ? 19'd8 : 19'd0));
        // Ping-pong order. Different buffers: the read one is full and the write one is filling. Same
        // buffer: either the other is empty and this one is filling, or both are full (the write pointer
        // wrapped onto the older full buffer, which holds all credit, so no response can arrive).
        if (rd_buf != wr_buf) assert ((rd_buf ? count1 : count0) == 4'd8 && (wr_buf ? count1 : count0) < 4'd8);
        else assert (((rd_buf ? count0 : count1) == 4'd0 && (rd_buf ? count1 : count0) < 4'd8) ||
                     (count0 == 4'd8 && count1 == 4'd8));
      end
    end
  end

  always @(posedge clk) begin
    if (f_past_valid && rst_n && $past(rst_n) && $past(mma_valid && !mma_ready)) begin
      assert (mma_valid);                                           // an MMA is held until taken...
      assert (mma_a == $past(mma_a) && mma_b == $past(mma_b));      // ...with its operands stable
      assert (mma_fmt == $past(mma_fmt) && mma_acc == $past(mma_acc));
    end
    if (f_past_valid && rst_n && $past(rst_n) && $past(last_issue)) assert (done && !active);
    if (f_past_valid && rst_n) begin
      cover (done && $past(steps) == 16'd2);                        // a two-step descriptor completes
      cover (mma_valid && !mma_ready && held == 6'd16);             // backpressure with both buffers full
    end
  end
`endif
endmodule
