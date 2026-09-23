// Test wrapper: the SECDED encoder feeding the decoder through an injected fault mask.
module tb_secded (
  input  wire [63:0] data_in,
  input  wire [71:0] fault_mask,
  output wire [71:0] code,
  output wire [63:0] data_out,
  output wire        corrected,
  output wire        uncorrectable,
  output wire [6:0]  syndrome
);
  aimem_secded_64_encoder encoder (.data_in(data_in), .code_out(code));
  aimem_secded_64_decoder decoder (
    .code_in(code ^ fault_mask),
    .data_out(data_out),
    .corrected(corrected),
    .uncorrectable(uncorrectable),
    .syndrome(syndrome)
  );
endmodule
