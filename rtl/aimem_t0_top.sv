module aimem_t0_top #(
  parameter integer CHANNELS = 16,
  parameter integer BANKS_PER_CHANNEL = 16
) (
  input  wire                    clk,
  input  wire                    rst_n,
  input  wire [CHANNELS-1:0]     cmd_valid,
  output wire [CHANNELS-1:0]     cmd_ready,
  input  wire [CHANNELS-1:0]     cmd_write,
  input  wire [CHANNELS*4-1:0]   cmd_bank,
  input  wire [CHANNELS*16-1:0]  cmd_row,
  input  wire [CHANNELS*64-1:0]  cmd_wdata,
  output wire [CHANNELS-1:0]     rsp_valid,
  output wire [CHANNELS*64-1:0]  rsp_rdata,
  output wire [CHANNELS-1:0]     refresh_urgent,
  output wire                    all_controllers_live
);
  wire [CHANNELS-1:0] controller_live;
  wire [CHANNELS-1:0] ecc_corrected;
  genvar channel;

  generate
    for (channel = 0; channel < CHANNELS; channel = channel + 1) begin : channel_slice
      aimem_t0_channel #(
        .BANKS(BANKS_PER_CHANNEL),
        .ROW_BITS(16),
        .REFRESH_LIMIT(1024)
      ) controller (
        .clk(clk),
        .rst_n(rst_n),
        .cmd_valid(cmd_valid[channel]),
        .cmd_ready(cmd_ready[channel]),
        .cmd_write(cmd_write[channel]),
        .cmd_bank(cmd_bank[channel*4 +: 4]),
        .cmd_row(cmd_row[channel*16 +: 16]),
        .cmd_wdata(cmd_wdata[channel*64 +: 64]),
        .rsp_valid(rsp_valid[channel]),
        .rsp_rdata(rsp_rdata[channel*64 +: 64]),
        .ecc_corrected(ecc_corrected[channel]),
        .refresh_urgent(refresh_urgent[channel]),
        .controller_live(controller_live[channel])
      );
    end
  endgenerate

  assign all_controllers_live = &controller_live;
endmodule
