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
  input  wire [CHANNELS*72-1:0]  fault_mask,
  input  wire [CHANNELS*64-1:0]  lane_fail_mask,
  output wire [CHANNELS-1:0]     rsp_valid,
  output wire [CHANNELS*64-1:0]  rsp_rdata,
  output wire [CHANNELS-1:0]     ecc_corrected,
  output wire [CHANNELS-1:0]     ecc_uncorrectable,
  output wire [CHANNELS-1:0]     lane_repairable,
  output wire [CHANNELS*448-1:0] lane_map,
  output wire [CHANNELS-1:0]     refresh_urgent,
  output wire                    all_controllers_live,
  input  wire                    gather_descriptor_valid,
  output wire                    gather_descriptor_ready,
  input  wire [47:0]             gather_base_address,
  input  wire [15:0]             gather_stride_bytes,
  input  wire [15:0]             gather_element_count,
  output wire                    gather_address_valid,
  input  wire                    gather_address_ready,
  output wire [47:0]             gather_address,
  output wire                    gather_address_last,
  output wire                    gather_busy
);
  wire [CHANNELS-1:0] controller_live;
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
        .fault_mask(fault_mask[channel*72 +: 72]),
        .rsp_valid(rsp_valid[channel]),
        .rsp_rdata(rsp_rdata[channel*64 +: 64]),
        .ecc_corrected(ecc_corrected[channel]),
        .ecc_uncorrectable(ecc_uncorrectable[channel]),
        .refresh_urgent(refresh_urgent[channel]),
        .controller_live(controller_live[channel])
      );

      aimem_lane_repair lane_repair (
        .fail_mask(lane_fail_mask[channel*64 +: 64]),
        .lane_map(lane_map[channel*448 +: 448]),
        .repairable(lane_repairable[channel]),
        .failure_count()
      );
    end
  endgenerate

  aimem_sparse_gather gather_engine (
    .clk(clk),
    .rst_n(rst_n),
    .descriptor_valid(gather_descriptor_valid),
    .descriptor_ready(gather_descriptor_ready),
    .base_address(gather_base_address),
    .stride_bytes(gather_stride_bytes),
    .element_count(gather_element_count),
    .address_valid(gather_address_valid),
    .address_ready(gather_address_ready),
    .address(gather_address),
    .address_last(gather_address_last),
    .busy(gather_busy)
  );

  assign all_controllers_live = &controller_live;
endmodule
