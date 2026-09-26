// SymbiYosys harness for a1_tile_dma with unconstrained descriptors, memory, and MMA backpressure.
// Read with -D FORMAL to check the DMA's embedded properties (credit, buffer, handshake, completion).
module a1_tile_dma_sby (
  input wire clk
);
  reg rst_n = 1'b0;
  always @(posedge clk) rst_n <= 1'b1;

  (* anyseq *) reg        desc_valid;
  (* anyseq *) reg [1:0]  desc_fmt;
  (* anyseq *) reg [1:0]  desc_acc;
  (* anyseq *) reg [15:0] desc_steps;
  (* anyseq *) reg [31:0] desc_a_base, desc_a_row_stride, desc_a_step_stride;
  (* anyseq *) reg [31:0] desc_b_base, desc_b_col_stride, desc_b_step_stride;
  (* anyseq *) reg [31:0] desc_scale_a, desc_scale_b;
  (* anyseq *) reg        mem_req_ready;
  (* anyseq *) reg        mem_rsp_valid;
  (* anyseq *) reg [63:0] mem_rsp_data;
  (* anyseq *) reg        mma_ready;

  wire desc_ready, mem_req_valid, mem_rsp_ready, mma_valid, done, busy;
  wire [31:0] mem_req_addr, mma_scale_a, mma_scale_b;
  wire [1:0] mma_fmt, mma_acc;
  wire [255:0] mma_a, mma_b;

  a1_tile_dma #(.IDX_W(2)) dut (
    .clk(clk), .rst_n(rst_n),
    .desc_valid(desc_valid), .desc_ready(desc_ready), .desc_fmt(desc_fmt), .desc_acc(desc_acc),
    .desc_steps(desc_steps), .desc_a_base(desc_a_base), .desc_a_row_stride(desc_a_row_stride),
    .desc_a_step_stride(desc_a_step_stride), .desc_b_base(desc_b_base), .desc_b_col_stride(desc_b_col_stride),
    .desc_b_step_stride(desc_b_step_stride), .desc_scale_a(desc_scale_a), .desc_scale_b(desc_scale_b),
    .mem_req_valid(mem_req_valid), .mem_req_ready(mem_req_ready), .mem_req_addr(mem_req_addr),
    .mem_rsp_valid(mem_rsp_valid), .mem_rsp_ready(mem_rsp_ready), .mem_rsp_data(mem_rsp_data),
    .mma_valid(mma_valid), .mma_ready(mma_ready), .mma_fmt(mma_fmt), .mma_acc(mma_acc),
    .mma_a(mma_a), .mma_b(mma_b), .mma_scale_a(mma_scale_a), .mma_scale_b(mma_scale_b),
    .done(done), .busy(busy)
  );
endmodule
