module aimem_secded_64_encoder (
  input  wire [63:0] data_in,
  output reg  [71:0] code_out
);
  integer position;
  integer data_index;
  integer parity_index;
  reg parity_value;

  always @* begin
    code_out = 72'b0;
    data_index = 0;
    for (position = 1; position <= 71; position = position + 1) begin
      if (position != 1 && position != 2 && position != 4 && position != 8 &&
          position != 16 && position != 32 && position != 64) begin
        code_out[position-1] = data_in[data_index];
        data_index = data_index + 1;
      end
    end
    for (parity_index = 0; parity_index < 7; parity_index = parity_index + 1) begin
      parity_value = 1'b0;
      for (position = 1; position <= 71; position = position + 1)
        if ((position & (1 << parity_index)) != 0)
          parity_value = parity_value ^ code_out[position-1];
      code_out[(1 << parity_index)-1] = parity_value;
    end
    code_out[71] = ^code_out[70:0];
  end
endmodule

module aimem_secded_64_decoder (
  input  wire [71:0] code_in,
  output reg  [63:0] data_out,
  output reg         corrected,
  output reg         uncorrectable,
  output reg  [6:0]  syndrome
);
  integer position;
  integer data_index;
  integer parity_index;
  reg parity_value;
  reg overall_mismatch;
  reg [71:0] corrected_code;

  always @* begin
    syndrome = 7'b0;
    for (parity_index = 0; parity_index < 7; parity_index = parity_index + 1) begin
      parity_value = 1'b0;
      for (position = 1; position <= 71; position = position + 1)
        if ((position & (1 << parity_index)) != 0)
          parity_value = parity_value ^ code_in[position-1];
      syndrome[parity_index] = parity_value;
    end

    overall_mismatch = ^code_in;
    corrected_code = code_in;
    corrected = 1'b0;
    uncorrectable = 1'b0;
    if (syndrome != 0 && overall_mismatch) begin
      corrected_code[syndrome-1] = ~corrected_code[syndrome-1];
      corrected = 1'b1;
    end else if (syndrome == 0 && overall_mismatch) begin
      corrected_code[71] = ~corrected_code[71];
      corrected = 1'b1;
    end else if (syndrome != 0 && !overall_mismatch) begin
      uncorrectable = 1'b1;
    end

    data_out = 64'b0;
    data_index = 0;
    for (position = 1; position <= 71; position = position + 1) begin
      if (position != 1 && position != 2 && position != 4 && position != 8 &&
          position != 16 && position != 32 && position != 64) begin
        data_out[data_index] = corrected_code[position-1];
        data_index = data_index + 1;
      end
    end
  end
endmodule
