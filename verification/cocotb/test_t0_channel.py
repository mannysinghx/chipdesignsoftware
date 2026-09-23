"""T0 channel controller: command protocol, row-buffer latency, ECC datapath, refresh priority, liveness."""

from __future__ import annotations

import random

import cocotb
from cocotb.triggers import FallingEdge, ReadOnly, RisingEdge

from channel_driver import ChannelPort, reset
from tb import tb_test

MISS_LATENCY = 4  # accept → ACTIVATE → ACCESS → RESPOND → response
HIT_LATENCY = 3   # accept → ACCESS → RESPOND → response

IDLE_INPUTS = {"cmd_valid": 0, "cmd_write": 0, "cmd_bank": 0, "cmd_row": 0, "cmd_wdata": 0, "fault_mask": 0}


async def invariant_monitor(dut) -> None:
    """Checked every cycle: the controller stays live and never accepts commands while a refresh is due."""
    while True:
        await RisingEdge(dut.clk)
        await ReadOnly()
        if int(dut.rst_n.value):
            assert int(dut.controller_live.value) == 1, "controller_live dropped"
            if int(dut.refresh_urgent.value):
                assert int(dut.cmd_ready.value) == 0, "cmd_ready while refresh is urgent"


async def start(dut) -> ChannelPort:
    await reset(dut, inputs=IDLE_INPUTS)
    cocotb.start_soon(invariant_monitor(dut))
    return ChannelPort(dut)


@tb_test()
async def row_miss_then_row_hit_latency(dut):
    port = await start(dut)
    first = await port.transact(bank=3, row=0x0055, wdata=0x1111_2222_3333_4444)
    second = await port.transact(bank=3, row=0x0055, wdata=0x5555_6666_7777_8888)
    other_row = await port.transact(bank=3, row=0x0056, wdata=0x9)
    assert first.latency == MISS_LATENCY, f"row miss latency {first.latency}"
    assert second.latency == HIT_LATENCY, f"row hit latency {second.latency}"
    assert other_row.latency == MISS_LATENCY, "a different row in an open bank must re-activate"
    assert (first.data, second.data) == (0x1111_2222_3333_4444, 0x5555_6666_7777_8888)


@tb_test()
async def banks_keep_independent_open_rows(dut):
    port = await start(dut)
    await port.transact(bank=1, row=10, wdata=1)
    await port.transact(bank=2, row=20, wdata=2)
    assert (await port.transact(bank=1, row=10, wdata=3)).latency == HIT_LATENCY
    assert (await port.transact(bank=2, row=20, wdata=4)).latency == HIT_LATENCY


@tb_test()
async def single_bit_faults_return_corrected_data(dut):
    port = await start(dut)
    for position in (0, 5, 31, 63, 70, 71):
        data = random.getrandbits(64)
        response = await port.transact(bank=0, row=7, wdata=data, fault_mask=1 << position)
        assert response.data == data, f"fault at bit {position} not corrected"


@tb_test()
async def ecc_status_is_valid_with_the_response(dut):
    """Every response field, including ECC status, must be valid in the cycle rsp_valid is high."""
    port = await start(dut)
    single = await port.transact(bank=4, row=1, wdata=0xDEAD_BEEF_CAFE_F00D, fault_mask=1 << 9)
    double = await port.transact(bank=4, row=1, wdata=0xDEAD_BEEF_CAFE_F00D, fault_mask=(1 << 9) | (1 << 40))
    clean = await port.transact(bank=4, row=1, wdata=0x1234)
    assert (clean.corrected, clean.uncorrectable) == (0, 0)
    assert single.corrected == 1, (
        "ecc_corrected is not asserted with rsp_valid for a single-bit fault "
        f"(it pulsed before the response: {single.flags_seen_before_response})"
    )
    assert double.uncorrectable == 1, (
        "ecc_uncorrectable is not asserted with rsp_valid for a double-bit fault "
        f"(it pulsed before the response: {double.flags_seen_before_response})"
    )


@tb_test()
async def random_traffic_matches_the_row_buffer_model(dut):
    port = await start(dut)
    open_rows: dict[int, int] = {}
    for _ in range(150):
        bank = random.randrange(16)
        row = random.choice([0, 1, 2, random.getrandbits(16)])
        data = random.getrandbits(64)
        fault = 1 << random.randrange(72) if random.random() < 0.3 else 0
        refreshes_before = port.refreshes_seen
        response = await port.transact(bank=bank, row=row, wdata=data, fault_mask=fault, write=random.getrandbits(1))
        if port.refreshes_seen != refreshes_before:
            open_rows.clear()  # a refresh closes every row before this command was accepted
        expected = HIT_LATENCY if open_rows.get(bank) == row else MISS_LATENCY
        assert response.latency == expected, f"bank {bank} row {row}: latency {response.latency}, expected {expected}"
        assert response.data == data
        open_rows[bank] = row


# Built with REFRESH_LIMIT=24 (see run_regression.py) so refresh behavior is reachable quickly.
@tb_test()
async def refresh_takes_priority_and_closes_rows(dut):
    port = await start(dut)
    limit = int(dut.REFRESH_LIMIT.value)
    await port.transact(bank=6, row=0x77, wdata=1)
    cycles = 0
    while not int(dut.refresh_urgent.value):
        await FallingEdge(dut.clk)
        cycles += 1
        assert cycles <= limit + 8, "refresh never became urgent"
    assert int(dut.cmd_ready.value) == 0
    response = await port.transact(bank=6, row=0x77, wdata=2)
    assert response.latency == MISS_LATENCY, "a refresh must close open rows"
    assert int(dut.refresh_urgent.value) == 0
