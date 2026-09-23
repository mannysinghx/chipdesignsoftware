// SymbiYosys harness: SECDED properties for ANY 64-bit data word and ANY fault positions.
// (The older aimem_secded_formal.sv proves the single-bit case for one fixed data pattern.)
module aimem_secded_sby (
  input wire clk
);
  (* anyconst *) reg [63:0] data;
  (* anyconst *) reg [6:0] first;
  (* anyconst *) reg [6:0] second;

  wire [71:0] code;
  wire [71:0] single_mask = 72'b1 << first;
  wire [71:0] double_mask = (72'b1 << first) | (72'b1 << second);

  wire [63:0] clean_data, single_data, double_data;
  wire clean_corrected, single_corrected, double_corrected;
  wire clean_uncorrectable, single_uncorrectable, double_uncorrectable;
  wire [6:0] clean_syndrome, single_syndrome, double_syndrome;

  aimem_secded_64_encoder encoder (.data_in(data), .code_out(code));
  aimem_secded_64_decoder clean_decoder (
    .code_in(code), .data_out(clean_data), .corrected(clean_corrected),
    .uncorrectable(clean_uncorrectable), .syndrome(clean_syndrome)
  );
  aimem_secded_64_decoder single_decoder (
    .code_in(code ^ single_mask), .data_out(single_data), .corrected(single_corrected),
    .uncorrectable(single_uncorrectable), .syndrome(single_syndrome)
  );
  aimem_secded_64_decoder double_decoder (
    .code_in(code ^ double_mask), .data_out(double_data), .corrected(double_corrected),
    .uncorrectable(double_uncorrectable), .syndrome(double_syndrome)
  );

  always @* begin
    // A clean word decodes to itself with no flags.
    assert (clean_data == data && !clean_corrected && !clean_uncorrectable && clean_syndrome == 7'd0);
    // Any single-bit fault is corrected.
    if (first < 7'd72)
      assert (single_data == data && single_corrected && !single_uncorrectable);
    // Any double-bit fault is detected and never miscorrected.
    if (first < 7'd72 && second < 7'd72 && first != second)
      assert (double_uncorrectable && !double_corrected);

    // Vacuity: the fault cases are reachable.
    cover (first < 7'd72 && second < 7'd72 && first != second);
    cover (first == 7'd71);
  end
endmodule
