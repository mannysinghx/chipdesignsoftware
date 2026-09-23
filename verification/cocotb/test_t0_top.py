"""aimem_t0_top integration: channel isolation, lane repair wiring, gather engine wiring, liveness."""

from __future__ import annotations

import random

from cocotb.triggers import FallingEdge, ReadOnly, RisingEdge

from channel_driver import ChannelPort, reset
from reference import gather_addresses, lane_repair
from tb import tb_test

CHANNELS = 16
IDLE_INPUTS = {
    "cmd_valid": 0,
    "cmd_write": 0,
    "cmd_bank": 0,
    "cmd_row": 0,
    "cmd_wdata": 0,
    "fault_mask": 0,
    "lane_fail_mask": 0,
    "gather_descriptor_valid": 0,
    "gather_address_ready": 0,
    "gather_base_address": 0,
    "gather_stride_bytes": 0,
    "gather_element_count": 0,
}


@tb_test()
async def each_channel_answers_only_its_own_command(dut):
    await reset(dut, inputs=IDLE_INPUTS)
    for channel in random.sample(range(CHANNELS), 4):
        port = ChannelPort(dut, channel)
        data = random.getrandbits(64)
        response = await port.transact(bank=channel % 16, row=channel, wdata=data)
        assert response.data == data
        others = int(dut.rsp_valid.value) & ~(1 << channel)
        assert others == 0, f"channel {channel}'s command produced responses on {others:#x}"
    assert int(dut.all_controllers_live.value) == 1


@tb_test()
async def lane_repair_is_wired_per_channel(dut):
    await reset(dut, inputs=IDLE_INPUTS)
    masks = {2: (1 << 3) | (1 << 10), 9: (1 << 1) | (1 << 2) | (1 << 3)}
    packed = 0
    for channel, mask in masks.items():
        packed |= mask << (channel * 64)
    dut.lane_fail_mask.value = packed
    await FallingEdge(dut.clk)
    lane_maps = int(dut.lane_map.value)
    repairable = int(dut.lane_repairable.value)
    for channel in range(CHANNELS):
        expected_map, expected_ok, _ = lane_repair(masks.get(channel, 0))
        chunk = (lane_maps >> (channel * 448)) & ((1 << 448) - 1)
        actual = [(chunk >> (lane * 7)) & 0x7F for lane in range(64)]
        assert actual == expected_map, f"channel {channel} lane map"
        assert (repairable >> channel) & 1 == int(expected_ok), f"channel {channel} repairable"


@tb_test()
async def gather_engine_is_reachable_through_the_top(dut):
    await reset(dut, inputs=IDLE_INPUTS)
    dut.gather_base_address.value = 0x4000
    dut.gather_stride_bytes.value = 128
    dut.gather_element_count.value = 3
    dut.gather_descriptor_valid.value = 1
    await RisingEdge(dut.clk)
    await FallingEdge(dut.clk)
    dut.gather_descriptor_valid.value = 0
    dut.gather_address_ready.value = 1
    emitted = []
    for _ in range(10):
        await RisingEdge(dut.clk)
        await ReadOnly()
        if int(dut.gather_address_valid.value):
            emitted.append((int(dut.gather_address.value), bool(int(dut.gather_address_last.value))))
    assert emitted == gather_addresses(0x4000, 128, 3)
