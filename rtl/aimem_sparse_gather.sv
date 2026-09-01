module aimem_sparse_gather (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        descriptor_valid,
  output wire        descriptor_ready,
  input  wire [47:0] base_address,
  input  wire [15:0] stride_bytes,
  input  wire [15:0] element_count,
  output reg         address_valid,
  input  wire        address_ready,
  output reg  [47:0] address,
  output reg         address_last,
  output wire        busy
);
  reg [47:0] current_address;
  reg [15:0] active_stride;
  reg [15:0] remaining;

  assign busy = remaining != 0;
  assign descriptor_ready = !busy;

  always @(posedge clk) begin
    if (!rst_n) begin
      current_address <= 0;
      active_stride <= 0;
      remaining <= 0;
      address_valid <= 0;
      address <= 0;
      address_last <= 0;
    end else begin
      address_valid <= 0;
      address_last <= 0;
      if (descriptor_valid && descriptor_ready && element_count != 0) begin
        current_address <= base_address;
        active_stride <= stride_bytes;
        remaining <= element_count;
      end else if (busy && address_ready) begin
        address <= current_address;
        address_valid <= 1'b1;
        address_last <= remaining == 1;
        current_address <= current_address + active_stride;
        remaining <= remaining - 1'b1;
      end
    end
  end
endmodule
