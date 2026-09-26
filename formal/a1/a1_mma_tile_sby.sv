// SymbiYosys harness for a1_mma_tile with unconstrained commands and backpressure.
// Read with -D FORMAL (the tile's embedded properties) and -D A1_ABSTRACT_DATAPATH (the arithmetic
// is replaced by unconstrained values, so the control proof holds for any datapath result).
module a1_mma_tile_sby (
  input wire clk
);
  reg rst_n = 1'b0;
  always @(posedge clk) rst_n <= 1'b1;

  (* anyseq *) reg         cmd_valid;
  (* anyseq *) reg [1:0]   cmd_op;
  (* anyseq *) reg [1:0]   cmd_fmt;
  (* anyseq *) reg [1:0]   cmd_acc;
  (* anyseq *) reg [255:0] cmd_a;
  (* anyseq *) reg [255:0] cmd_b;
  (* anyseq *) reg [31:0]  cmd_scale_a;
  (* anyseq *) reg [31:0]  cmd_scale_b;
  (* anyseq *) reg [511:0] cmd_c;
  (* anyseq *) reg         rsp_ready;

  wire         cmd_ready;
  wire         rsp_valid;
  wire [511:0] rsp_data;

  a1_mma_tile #(.ACC_ENTRIES(4), .IDX_W(2)) dut (
    .clk(clk), .rst_n(rst_n), .cmd_valid(cmd_valid), .cmd_ready(cmd_ready), .cmd_op(cmd_op),
    .cmd_fmt(cmd_fmt), .cmd_acc(cmd_acc), .cmd_a(cmd_a), .cmd_b(cmd_b),
    .cmd_scale_a(cmd_scale_a), .cmd_scale_b(cmd_scale_b), .cmd_c(cmd_c),
    .rsp_valid(rsp_valid), .rsp_ready(rsp_ready), .rsp_data(rsp_data)
  );
endmodule
