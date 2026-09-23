# OpenSTA translation of design/physical/aimem-t0-channel.sdc (the timing contract).
# Same 1.25 ns (800 MHz) clock, uncertainty, I/O delays, reset false path, and output load;
# `remove_from_collection` is not an OpenSTA command, so inputs use `all_inputs -no_clocks`.
# 800 MHz is the advanced-node target; on public sky130hd this is expected to report negative slack.
current_design aimem_t0_channel

create_clock -name core_clk -period 1.250 [get_ports clk]
set_clock_uncertainty 0.100 [get_clocks core_clk]
set_input_delay 0.150 -clock core_clk [all_inputs -no_clocks]
set_output_delay 0.150 -clock core_clk [all_outputs]
set_false_path -from [get_ports rst_n]
set_load 0.020 [all_outputs]
