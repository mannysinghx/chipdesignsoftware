module aimem_t0_channel_formal;
  reg clk = 0;
  reg rst_n = 0;
  (* anyseq *) reg cmd_valid;
  (* anyseq *) reg cmd_write;
  (* anyseq *) reg [3:0] cmd_bank;
  (* anyseq *) reg [15:0] cmd_row;
  (* anyseq *) reg [63:0] cmd_wdata;
  wire cmd_ready;
  wire rsp_valid;
  wire [63:0] rsp_rdata;
  wire ecc_corrected;
  wire ecc_uncorrectable;
  wire refresh_urgent;
  wire controller_live;

  always @* clk = $global_clock;
  always @(posedge clk) rst_n <= 1'b1;

  aimem_t0_channel #(.REFRESH_LIMIT(16)) dut (
    .clk(clk), .rst_n(rst_n), .cmd_valid(cmd_valid), .cmd_ready(cmd_ready),
    .cmd_write(cmd_write), .cmd_bank(cmd_bank), .cmd_row(cmd_row),
    .cmd_wdata(cmd_wdata), .fault_mask(72'b0), .rsp_valid(rsp_valid), .rsp_rdata(rsp_rdata),
    .ecc_corrected(ecc_corrected), .ecc_uncorrectable(ecc_uncorrectable), .refresh_urgent(refresh_urgent),
    .controller_live(controller_live)
  );

  always @(posedge clk) begin
    if (rst_n) begin
      assert(controller_live);
      if (refresh_urgent)
        assert(!cmd_ready);
    end
  end
endmodule
