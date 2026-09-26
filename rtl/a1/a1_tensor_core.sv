// AIMEM-A1 tensor core (C2 increment 2c of docs/COMPUTE_DIE_PLAN.md): a1_tile_dma feeding a1_mma_tile,
// plus a host command port for ZERO, LOAD, READ, and direct MMAs. The DMA's MMAs take priority; a host
// command is accepted in cycles where the DMA presents none. A host that waits for `done` before
// reading an accumulator sees every MMA of that descriptor.
module a1_tensor_core #(
  parameter integer ACC_ENTRIES = 4,
  parameter integer IDX_W = 2
) (
  input  wire              clk,
  input  wire              rst_n,
  // host commands and responses (as a1_mma_tile)
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
  output wire              rsp_valid,
  input  wire              rsp_ready,
  output wire [511:0]      rsp_data,
  // descriptors (as a1_tile_dma)
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
  output wire              done,
  output wire              busy
);
  localparam [1:0] OP_MMA = 2'd2;

  wire              mma_valid, mma_ready;
  wire [1:0]        mma_fmt;
  wire [IDX_W-1:0]  mma_acc;
  wire [255:0]      mma_a, mma_b;
  wire [31:0]       mma_scale_a, mma_scale_b;
  wire              tile_ready;

  a1_tile_dma #(.IDX_W(IDX_W)) dma (
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

  // The DMA wins the tile's command port whenever it presents an MMA.
  wire use_dma = mma_valid;
  assign mma_ready = use_dma && tile_ready;
  assign cmd_ready = !use_dma && tile_ready;

  a1_mma_tile #(.ACC_ENTRIES(ACC_ENTRIES), .IDX_W(IDX_W)) tile (
    .clk(clk), .rst_n(rst_n),
    .cmd_valid(use_dma || cmd_valid), .cmd_ready(tile_ready),
    .cmd_op(use_dma ? OP_MMA : cmd_op),
    .cmd_fmt(use_dma ? mma_fmt : cmd_fmt),
    .cmd_acc(use_dma ? mma_acc : cmd_acc),
    .cmd_a(use_dma ? mma_a : cmd_a),
    .cmd_b(use_dma ? mma_b : cmd_b),
    .cmd_scale_a(use_dma ? mma_scale_a : cmd_scale_a),
    .cmd_scale_b(use_dma ? mma_scale_b : cmd_scale_b),
    .cmd_c(cmd_c),
    .rsp_valid(rsp_valid), .rsp_ready(rsp_ready), .rsp_data(rsp_data)
  );
endmodule
