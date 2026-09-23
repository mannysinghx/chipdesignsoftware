"""Sparse gather engine: strided address generation under random backpressure."""

from __future__ import annotations

import random

from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, ReadOnly, RisingEdge

from reference import gather_addresses
from tb import tb_test


async def reset(dut) -> None:
    Clock(dut.clk, 10, unit="ns").start()
    dut.rst_n.value = 0
    dut.descriptor_valid.value = 0
    dut.address_ready.value = 0
    dut.base_address.value = 0
    dut.stride_bytes.value = 0
    dut.element_count.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await FallingEdge(dut.clk)


async def run_descriptor(dut, base: int, stride: int, count: int, ready_probability: float) -> list[tuple[int, bool]]:
    """Present one descriptor, then collect every emitted (address, last) pair."""
    while not int(dut.descriptor_ready.value):
        await FallingEdge(dut.clk)
    dut.base_address.value = base
    dut.stride_bytes.value = stride
    dut.element_count.value = count
    dut.descriptor_valid.value = 1
    await RisingEdge(dut.clk)
    await FallingEdge(dut.clk)
    dut.descriptor_valid.value = 0

    emitted: list[tuple[int, bool]] = []
    idle_cycles = 0
    while idle_cycles < 4:
        dut.address_ready.value = int(random.random() < ready_probability)
        await RisingEdge(dut.clk)
        await ReadOnly()
        if int(dut.address_valid.value):
            emitted.append((int(dut.address.value), bool(int(dut.address_last.value))))
        busy = int(dut.busy.value)
        assert int(dut.descriptor_ready.value) == int(not busy), "descriptor_ready must be the inverse of busy"
        idle_cycles = 0 if busy or int(dut.address_valid.value) else idle_cycles + 1
        await FallingEdge(dut.clk)
    dut.address_ready.value = 0
    return emitted


@tb_test()
async def directed_descriptor_emits_strided_addresses(dut):
    await reset(dut)
    emitted = await run_descriptor(dut, 0x1000, 64, 5, 1.0)
    assert emitted == gather_addresses(0x1000, 64, 5)


@tb_test()
async def zero_length_descriptor_is_ignored(dut):
    await reset(dut)
    emitted = await run_descriptor(dut, 0x2000, 8, 0, 1.0)
    assert emitted == []
    assert int(dut.busy.value) == 0


@tb_test()
async def addresses_wrap_at_48_bits(dut):
    await reset(dut)
    base = (1 << 48) - 16
    emitted = await run_descriptor(dut, base, 8, 4, 1.0)
    assert emitted == gather_addresses(base, 8, 4)


@tb_test()
async def random_descriptors_under_backpressure(dut):
    await reset(dut)
    for _ in range(30):
        base = random.getrandbits(48)
        stride = random.getrandbits(16)
        count = random.randint(1, 20)
        emitted = await run_descriptor(dut, base, stride, count, random.choice([0.3, 0.7, 1.0]))
        assert emitted == gather_addresses(base, stride, count), f"descriptor base={base:#x} stride={stride} count={count}"
