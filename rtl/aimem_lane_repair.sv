module aimem_lane_repair #(
  parameter integer LANES = 64,
  parameter integer SPARES = 2,
  parameter integer MAP_BITS = 7
) (
  input  wire [LANES-1:0] fail_mask,
  output reg  [LANES*MAP_BITS-1:0] lane_map,
  output reg                   repairable,
  output reg  [MAP_BITS-1:0]  failure_count
);
  integer lane;
  integer spare_index;

  always @* begin
    lane_map = 0;
    failure_count = 0;
    spare_index = 0;
    for (lane = 0; lane < LANES; lane = lane + 1) begin
      if (fail_mask[lane]) begin
        failure_count = failure_count + 1'b1;
        if (spare_index < SPARES) begin
          lane_map[lane*MAP_BITS +: MAP_BITS] = LANES + spare_index;
          spare_index = spare_index + 1;
        end else begin
          lane_map[lane*MAP_BITS +: MAP_BITS] = lane;
        end
      end else begin
        lane_map[lane*MAP_BITS +: MAP_BITS] = lane;
      end
    end
    repairable = failure_count <= SPARES;
  end
endmodule
