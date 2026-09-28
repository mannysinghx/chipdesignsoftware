# a1_mma_tile on GT2N (time unit: ps, per the GT2N liberty). ASAP7 run 1 reached
# 196.7 MHz (~5.1 ns stage-2 path). First pass targets 2500 ps (400 MHz), roughly
# where a 2 nm nanosheet should land, so timing repair does not bloat the design;
# C3 sweeps the period afterwards.
current_design a1_mma_tile

set clk_period 2500
create_clock -name core_clk -period $clk_period [get_ports clk]
set_clock_uncertainty 25 [get_clocks core_clk]
set_input_delay  [expr $clk_period * 0.2] -clock core_clk [all_inputs -no_clocks]
set_output_delay [expr $clk_period * 0.2] -clock core_clk [all_outputs]
set_false_path -from [get_ports rst_n]
