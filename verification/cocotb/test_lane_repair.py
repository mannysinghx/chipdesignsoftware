"""Lane repair: remapping of failed lanes onto spares, checked against the reference model."""

from __future__ import annotations

import random

from cocotb.triggers import Timer

from reference import lane_repair
from tb import tb_test

LANES, SPARES, MAP_BITS = 64, 2, 7


async def check(dut, mask: int) -> None:
    dut.fail_mask.value = mask
    await Timer(1, unit="ns")
    expected_map, expected_repairable, expected_count = lane_repair(mask, LANES, SPARES, MAP_BITS)
    packed = int(dut.lane_map.value)
    actual_map = [(packed >> (lane * MAP_BITS)) & ((1 << MAP_BITS) - 1) for lane in range(LANES)]
    assert actual_map == expected_map, f"lane map mismatch for mask {mask:#018x}"
    assert int(dut.repairable.value) == int(expected_repairable), f"repairable mismatch for {mask:#018x}"
    assert int(dut.failure_count.value) == expected_count


@tb_test()
async def healthy_lanes_map_to_themselves(dut):
    await check(dut, 0)


@tb_test()
async def failures_up_to_the_spare_count_are_repaired(dut):
    await check(dut, 1 << 17)
    await check(dut, (1 << 3) | (1 << 60))
    await check(dut, 1 << 63)


@tb_test()
async def failures_beyond_the_spares_are_reported_unrepairable(dut):
    await check(dut, (1 << 1) | (1 << 2) | (1 << 3))
    await check(dut, (1 << 64) - 1)


@tb_test()
async def random_failure_patterns_match_the_model(dut):
    for _ in range(250):
        failures = random.choice([0, 1, 2, 3, 5, 12])
        mask = 0
        for lane in random.sample(range(LANES), failures):
            mask |= 1 << lane
        await check(dut, mask)
