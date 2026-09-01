module aimem_secded_formal (
  input  wire [6:0]  fault_index,
  output wire proof_ok
);
  localparam [63:0] DATA_PATTERN = 64'h0123456789abcdef;
  wire [71:0] encoded;
  wire [71:0] fault_mask = 72'b1 << fault_index;
  wire [63:0] decoded;
  wire corrected;
  wire uncorrectable;
  wire [6:0] syndrome;

  aimem_secded_64_encoder encoder (.data_in(DATA_PATTERN), .code_out(encoded));
  aimem_secded_64_decoder decoder (
    .code_in(encoded ^ fault_mask), .data_out(decoded), .corrected(corrected),
    .uncorrectable(uncorrectable), .syndrome(syndrome)
  );

  assign proof_ok = fault_index >= 72 || (decoded == DATA_PATTERN && corrected && !uncorrectable);
endmodule
