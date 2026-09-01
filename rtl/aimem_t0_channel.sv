module aimem_t0_channel #(
  parameter integer BANKS = 16,
  parameter integer ROW_BITS = 16,
  parameter integer REFRESH_LIMIT = 1024
) (
  input  wire                  clk,
  input  wire                  rst_n,
  input  wire                  cmd_valid,
  output wire                  cmd_ready,
  input  wire                  cmd_write,
  input  wire [$clog2(BANKS)-1:0] cmd_bank,
  input  wire [ROW_BITS-1:0]   cmd_row,
  input  wire [63:0]           cmd_wdata,
  input  wire [71:0]           fault_mask,
  output reg                   rsp_valid,
  output reg  [63:0]           rsp_rdata,
  output reg                   ecc_corrected,
  output reg                   ecc_uncorrectable,
  output wire                  refresh_urgent,
  output wire                  controller_live
);
  localparam [2:0] IDLE = 3'd0;
  localparam [2:0] ACTIVATE = 3'd1;
  localparam [2:0] ACCESS = 3'd2;
  localparam [2:0] RESPOND = 3'd3;
  localparam [2:0] REFRESH = 3'd4;

  reg [2:0] state;
  reg [ROW_BITS-1:0] open_row [0:BANKS-1];
  reg [BANKS-1:0] row_open;
  reg [$clog2(BANKS)-1:0] active_bank;
  reg [ROW_BITS-1:0] active_row;
  reg active_write;
  reg [63:0] active_wdata;
  reg [71:0] active_fault_mask;
  reg [15:0] refresh_age;
  reg [3:0] operation_age;
  integer bank_index;
  wire [71:0] encoded_wdata;
  wire [63:0] corrected_wdata;
  wire ecc_decode_corrected;
  wire ecc_decode_uncorrectable;
  wire [6:0] ecc_syndrome;

  aimem_secded_64_encoder ecc_encoder (
    .data_in(active_wdata),
    .code_out(encoded_wdata)
  );

  aimem_secded_64_decoder ecc_decoder (
    .code_in(encoded_wdata ^ active_fault_mask),
    .data_out(corrected_wdata),
    .corrected(ecc_decode_corrected),
    .uncorrectable(ecc_decode_uncorrectable),
    .syndrome(ecc_syndrome)
  );

  assign refresh_urgent = refresh_age >= REFRESH_LIMIT;
  assign cmd_ready = state == IDLE && !refresh_urgent;
  assign controller_live = operation_age < 4'd12;

  always @(posedge clk) begin
    if (!rst_n) begin
      state <= IDLE;
      row_open <= {BANKS{1'b0}};
      active_bank <= 0;
      active_row <= 0;
      active_write <= 0;
      active_wdata <= 0;
      active_fault_mask <= 0;
      refresh_age <= 0;
      operation_age <= 0;
      rsp_valid <= 0;
      rsp_rdata <= 0;
      ecc_corrected <= 0;
      ecc_uncorrectable <= 0;
      for (bank_index = 0; bank_index < BANKS; bank_index = bank_index + 1)
        open_row[bank_index] <= 0;
    end else begin
      rsp_valid <= 0;
      ecc_corrected <= 0;
      ecc_uncorrectable <= 0;
      if (state == IDLE)
        operation_age <= 0;
      else
        operation_age <= operation_age + 1'b1;

      if (state != REFRESH && refresh_age < REFRESH_LIMIT + 16)
        refresh_age <= refresh_age + 1'b1;

      case (state)
        IDLE: begin
          if (refresh_urgent) begin
            state <= REFRESH;
          end else if (cmd_valid) begin
            active_bank <= cmd_bank;
            active_row <= cmd_row;
            active_write <= cmd_write;
            active_wdata <= cmd_wdata;
            active_fault_mask <= fault_mask;
            if (row_open[cmd_bank] && open_row[cmd_bank] == cmd_row)
              state <= ACCESS;
            else
              state <= ACTIVATE;
          end
        end
        ACTIVATE: begin
          row_open[active_bank] <= 1'b1;
          open_row[active_bank] <= active_row;
          state <= ACCESS;
        end
        ACCESS: begin
          rsp_rdata <= corrected_wdata;
          ecc_corrected <= ecc_decode_corrected;
          ecc_uncorrectable <= ecc_decode_uncorrectable;
          state <= RESPOND;
        end
        RESPOND: begin
          rsp_valid <= 1'b1;
          state <= IDLE;
        end
        REFRESH: begin
          refresh_age <= 0;
          row_open <= {BANKS{1'b0}};
          state <= IDLE;
        end
        default: state <= IDLE;
      endcase
    end
  end

`ifdef FORMAL
  always @(posedge clk) begin
    if (rst_n) begin
      assert(operation_age < 4'd12);
      assert(refresh_age <= REFRESH_LIMIT + 16);
      if (rsp_valid)
        assert(state == IDLE);
    end
  end
`endif
endmodule
