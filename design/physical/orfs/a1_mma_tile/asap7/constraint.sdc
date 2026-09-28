# a1_mma_tile on ASAP7 (time unit: ps). sky130hd run 1 measured a ~260-gate stage-1
# path; at ~15 ps per ASAP7 gate that is ~4 ns, so the first run targets 4000 ps
# (250 MHz) to avoid repair bloat, and C3 sweeps the period afterwards.
current_design a1_mma_tile

set clk_period 4000
create_clock -name core_clk -period $clk_period [get_ports clk]
set_clock_uncertainty 25 [get_clocks core_clk]
set_input_delay  [expr $clk_period * 0.2] -clock core_clk [all_inputs -no_clocks]
set_output_delay [expr $clk_period * 0.2] -clock core_clk [all_outputs]
set_false_path -from [get_ports rst_n]
