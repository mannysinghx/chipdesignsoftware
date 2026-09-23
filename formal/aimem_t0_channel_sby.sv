// SymbiYosys harness for aimem_t0_channel with unconstrained command and fault inputs.
// Read with -D FORMAL so the controller's own embedded assertions are checked too.
// Define PROTOCOL_CHECKS (channel_protocol.sby) to add the response-alignment contract.
module aimem_t0_channel_sby (
  input wire clk
);
  reg rst_n = 1'b0;
  always @(posedge clk) rst_n <= 1'b1;

  (* anyseq *) reg        cmd_valid;
  (* anyseq *) reg        cmd_write;
  (* anyseq *) reg [3:0]  cmd_bank;
  (* anyseq *) reg [15:0] cmd_row;
  (* anyseq *) reg [63:0] cmd_wdata;
  (* anyseq *) reg [71:0] fault_mask;

  wire        cmd_ready;
  wire        rsp_valid;
  wire [63:0] rsp_rdata;
  wire        ecc_corrected;
  wire        ecc_uncorrectable;
  wire        refresh_urgent;
  wire        controller_live;

  aimem_t0_channel #(.REFRESH_LIMIT(16)) dut (
    .clk(clk), .rst_n(rst_n), .cmd_valid(cmd_valid), .cmd_ready(cmd_ready),
    .cmd_write(cmd_write), .cmd_bank(cmd_bank), .cmd_row(cmd_row),
    .cmd_wdata(cmd_wdata), .fault_mask(fault_mask), .rsp_valid(rsp_valid), .rsp_rdata(rsp_rdata),
    .ecc_corrected(ecc_corrected), .ecc_uncorrectable(ecc_uncorrectable),
    .refresh_urgent(refresh_urgent), .controller_live(controller_live)
  );

  // Scoreboard: the one command in flight (the controller handles one at a time).
  reg        pending = 1'b0;
  reg [63:0] held_wdata = 64'b0;
  reg [71:0] held_mask = 72'b0;
  always @(posedge clk) begin
    if (!rst_n) begin
      pending <= 1'b0;
    end else if (cmd_valid && cmd_ready) begin
      pending <= 1'b1;
      held_wdata <= cmd_wdata;
      held_mask <= fault_mask;
    end else if (rsp_valid) begin
      pending <= 1'b0;
    end
  end

  wire single_fault = held_mask != 72'b0 && (held_mask & (held_mask - 72'd1)) == 72'b0;

  always @(posedge clk) begin
    if (rst_n) begin
      assert (controller_live);
      if (refresh_urgent) assert (!cmd_ready);
      if (rsp_valid) assert (pending);
      if (rsp_valid && (held_mask == 72'b0 || single_fault)) assert (rsp_rdata == held_wdata);
`ifdef PROTOCOL_CHECKS
      // Every response field is valid with rsp_valid, including ECC status.
      if (rsp_valid && single_fault) assert (ecc_corrected);
      if (rsp_valid && held_mask == 72'b0) assert (!ecc_corrected && !ecc_uncorrectable);
`endif
      cover (rsp_valid);
      cover (rsp_valid && single_fault);
      cover (refresh_urgent);
    end
  end
endmodule
