# a1_mma_tile on sky130hd. Run 1 used 10 ns and measured a 42.7 ns critical path in
# stage 1 (decode, multiply, 17-term exponent/alignment: s1_fmt -> s2_terms), not
# stage 2 as expected. Run 2 targets 40 ns (25 MHz), near the natural path, so timing
# repair does not bloat the design; C3 sweeps the period afterwards.
current_design a1_mma_tile

set clk_period 40.0
create_clock -name core_clk -period $clk_period [get_ports clk]
set_clock_uncertainty 0.25 [get_clocks core_clk]
set_input_delay  [expr $clk_period * 0.2] -clock core_clk [all_inputs -no_clocks]
set_output_delay [expr $clk_period * 0.2] -clock core_clk [all_outputs]
set_false_path -from [get_ports rst_n]
set_load 0.020 [all_outputs]
