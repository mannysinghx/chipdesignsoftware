"""a1_tensor_core (a1_tile_dma + a1_mma_tile) end to end against the golden model.

A Python memory model serves the DMA's 64-bit reads with random request backpressure and random
latency, in order. Each descriptor's result is checked against golden.mma4 replayed over the exact
words the descriptor addresses. With ideal memory the DMA must issue exactly one MMA per 8 cycles (the
8 operand words of a step, one per cycle).
"""

from __future__ import annotations

import random
from collections import deque

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, ReadOnly, RisingEdge

import golden
from golden_accuracy import gaussian_value
from tb import pack, tb_test, unpack

OP_ZERO, OP_LOAD, OP_MMA, OP_READ = 0, 1, 2, 3
UNIT = golden.UNIT_SCALE
FORMATS = (golden.E4M3, golden.E5M2, golden.BF16, golden.E2M1)
DESC_FIELDS = ("fmt", "acc", "steps", "a_base", "a_row_stride", "a_step_stride", "b_base", "b_col_stride", "b_step_stride")


class Memory:
    """In-order 64-bit read memory with random request backpressure and latency, clocked by cocotb."""

    def __init__(self, dut, ready_probability=1.0, latency=(1, 1)):
        self.dut = dut
        self.words: dict[int, int] = {}
        self.ready_probability = ready_probability
        self.latency = latency
        self.queue: deque = deque()
        self.cycle = 0
        self.requests = 0

    def read(self, address: int) -> int:
        return self.words.get(address, 0)

    async def run(self):
        dut = self.dut
        dut.mem_req_ready.value = 0
        dut.mem_rsp_valid.value = 0
        dut.mem_rsp_data.value = 0
        while True:
            await FallingEdge(dut.clk)
            self.cycle += 1
            dut.mem_req_ready.value = int(random.random() < self.ready_probability)
            responding = bool(self.queue) and self.queue[0][0] <= self.cycle
            dut.mem_rsp_valid.value = int(responding)
            dut.mem_rsp_data.value = self.read(self.queue[0][1]) if responding else 0
            await ReadOnly()
            if int(dut.mem_req_valid.value) and int(dut.mem_req_ready.value):
                self.requests += 1
                due = max(self.cycle + random.randint(*self.latency), self.queue[-1][0] + 1 if self.queue else 0)
                self.queue.append((due, int(dut.mem_req_addr.value)))
            if responding:
                self.queue.popleft()


class DoneCounter:
    def __init__(self, dut):
        self.dut = dut
        self.count = 0
        self.mma_cycles: list[int] = []
        self.cycle = 0

    async def run(self):
        while True:
            await RisingEdge(self.dut.clk)
            await ReadOnly()
            self.cycle += 1
            if int(self.dut.done.value):
                self.count += 1
            if int(self.dut.dma.mma_valid.value) and int(self.dut.dma.mma_ready.value):
                self.mma_cycles.append(self.cycle)


async def reset(dut, memory: Memory) -> DoneCounter:
    Clock(dut.clk, 10, unit="ns").start()
    for name in ("cmd_valid", "cmd_op", "cmd_fmt", "cmd_acc", "cmd_a", "cmd_b", "cmd_scale_a", "cmd_scale_b", "cmd_c",
                 "rsp_ready", "desc_valid", "desc_scale_a", "desc_scale_b", *[f"desc_{field}" for field in DESC_FIELDS]):
        getattr(dut, name).value = 0
    dut.rst_n.value = 0
    cocotb.start_soon(memory.run())
    counter = DoneCounter(dut)
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    cocotb.start_soon(counter.run())
    await FallingEdge(dut.clk)
    return counter


async def host(dut, op, fmt=0, acc=0, c=None):
    """One host command; returns the response for READ."""
    dut.cmd_valid.value = 1
    dut.cmd_op.value = op
    dut.cmd_fmt.value = fmt
    dut.cmd_acc.value = acc
    dut.cmd_c.value = pack(c or [0] * 16, 32)
    dut.cmd_scale_a.value = pack([UNIT] * 4, 8)
    dut.cmd_scale_b.value = pack([UNIT] * 4, 8)
    while True:
        await ReadOnly()
        accepted = int(dut.cmd_ready.value)
        await FallingEdge(dut.clk)
        if accepted:
            break
    dut.cmd_valid.value = 0
    if op != OP_READ:
        return None
    dut.rsp_ready.value = 1
    while True:
        await ReadOnly()
        if int(dut.rsp_valid.value):
            data = unpack(int(dut.rsp_data.value), 32, 16)
            await FallingEdge(dut.clk)
            dut.rsp_ready.value = 0
            return data
        await FallingEdge(dut.clk)


async def descriptor(dut, desc: dict):
    for field in DESC_FIELDS:
        getattr(dut, f"desc_{field}").value = desc[field]
    dut.desc_scale_a.value = pack(desc["scales_a"], 8)
    dut.desc_scale_b.value = pack(desc["scales_b"], 8)
    dut.desc_valid.value = 1
    while True:
        await ReadOnly()
        accepted = int(dut.desc_ready.value)
        await FallingEdge(dut.clk)
        if accepted:
            break
    dut.desc_valid.value = 0


async def wait_done(counter: DoneCounter, target: int, dut, limit=20000):
    for _ in range(limit):
        if counter.count >= target:
            return
        await FallingEdge(dut.clk)
    raise AssertionError(f"done count {counter.count}, expected {target}")


def random_descriptor(rng, memory: Memory, fmt, acc, steps, scaled=False):
    """Lay out A and B in memory at random strides (multiples of 8 bytes) and return the descriptor."""
    n = 64 // golden.ELEMENT_BITS[fmt]
    desc = {
        "fmt": fmt, "acc": acc, "steps": steps,
        "a_base": 8 * rng.randrange(0, 1 << 16), "a_row_stride": 8 * rng.randint(1, 64), "a_step_stride": 8 * rng.randint(0, 512),
        "b_base": 8 * rng.randrange(1 << 17, 1 << 18), "b_col_stride": 8 * rng.randint(1, 64), "b_step_stride": 8 * rng.randint(0, 512),
        "scales_a": [rng.randint(UNIT - 5, UNIT + 5) for _ in range(4)] if scaled else [UNIT] * 4,
        "scales_b": [rng.randint(UNIT - 5, UNIT + 5) for _ in range(4)] if scaled else [UNIT] * 4,
    }
    for step in range(steps):
        for i in range(4):
            for base, step_stride, stride in (("a_base", "a_step_stride", "a_row_stride"), ("b_base", "b_step_stride", "b_col_stride")):
                address = desc[base] + step * desc[step_stride] + i * desc[stride]
                if address not in memory.words:
                    memory.words[address] = golden.pack_row([gaussian_value(fmt, rng) for _ in range(n)], fmt)
    return desc


def expected(memory: Memory, desc: dict, acc_state: list[int]) -> list[int]:
    for step in range(desc["steps"]):
        rows = [memory.read(desc["a_base"] + step * desc["a_step_stride"] + i * desc["a_row_stride"]) for i in range(4)]
        cols = [memory.read(desc["b_base"] + step * desc["b_step_stride"] + j * desc["b_col_stride"]) for j in range(4)]
        acc_state = golden.mma4(rows, cols, acc_state, desc["fmt"], desc["scales_a"], desc["scales_b"])
    return acc_state


@tb_test()
async def descriptor_k_loop_matches_golden_under_memory_stalls(dut):
    memory = Memory(dut, ready_probability=0.7, latency=(1, 6))
    counter = await reset(dut, memory)
    rng = random.Random(random.getrandbits(32))
    for number, fmt in enumerate(FORMATS):
        acc = number % 4
        await host(dut, OP_ZERO, fmt, acc)
        desc = random_descriptor(rng, memory, fmt, acc, steps=rng.randint(3, 9), scaled=fmt == golden.E2M1)
        await descriptor(dut, desc)
        await wait_done(counter, number + 1, dut)
        got = await host(dut, OP_READ, fmt, acc)
        assert got == expected(memory, desc, [0] * 16), f"fmt {golden.FORMATS[fmt]}"


@tb_test()
async def ideal_memory_sustains_one_mma_per_eight_cycles(dut):
    memory = Memory(dut, ready_probability=1.0, latency=(1, 1))
    counter = await reset(dut, memory)
    rng = random.Random(random.getrandbits(32))
    fmt = golden.E4M3
    await host(dut, OP_ZERO, fmt, 1)
    desc = random_descriptor(rng, memory, fmt, 1, steps=16)
    await descriptor(dut, desc)
    await wait_done(counter, 1, dut)
    gaps = [later - earlier for earlier, later in zip(counter.mma_cycles, counter.mma_cycles[1:])]
    assert gaps == [8] * 15, f"MMA issue gaps {gaps}, expected 8 (one 64-bit word per cycle)"
    assert memory.requests == 16 * 8
    assert await host(dut, OP_READ, fmt, 1) == expected(memory, desc, [0] * 16)


@tb_test()
async def zero_step_descriptor_signals_done(dut):
    memory = Memory(dut)
    counter = await reset(dut, memory)
    desc = {field: 0 for field in DESC_FIELDS} | {"scales_a": [UNIT] * 4, "scales_b": [UNIT] * 4}
    await descriptor(dut, desc)
    await wait_done(counter, 1, dut, limit=10)
    assert memory.requests == 0


@tb_test()
async def descriptors_back_to_back_and_host_commands_between(dut):
    memory = Memory(dut, ready_probability=0.8, latency=(1, 4))
    counter = await reset(dut, memory)
    rng = random.Random(random.getrandbits(32))
    fmt = golden.BF16
    loaded = [rng.getrandbits(32) & 0xBFFFFFFF for _ in range(16)]
    await host(dut, OP_LOAD, fmt, 0, loaded)
    await host(dut, OP_ZERO, fmt, 2)
    first = random_descriptor(rng, memory, fmt, 0, steps=5)
    second = random_descriptor(rng, memory, fmt, 2, steps=4)
    await descriptor(dut, first)
    await descriptor(dut, second)  # accepted once the first completes
    await wait_done(counter, 2, dut)
    assert await host(dut, OP_READ, fmt, 0) == expected(memory, first, loaded)
    assert await host(dut, OP_READ, fmt, 2) == expected(memory, second, [0] * 16)
