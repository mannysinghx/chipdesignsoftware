"""a1_mma_tile against a golden model of the tile: an accumulator array updated by golden.mma4.

A and B travel as four packed 64-bit rows (of A) and columns (of B): 4 BF16, 8 FP8, or 16 FP4 elements
each, with an OCP MX E8M0 scale per row and per column.

Every READ response is compared with the golden accumulator state. The tile is pipelined (3 stages),
so the tests also pin its throughput: a dependent chain into one accumulator is accepted exactly every
3 cycles, and rotating over accumulators sustains one command per cycle. The exact ready rule is
proved formally (formal/a1/a1_tile.sby).
"""

from __future__ import annotations

import random

from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, ReadOnly, RisingEdge

import golden
from golden_accuracy import gaussian_value
from tb import pack, tb_test, unpack

OP_ZERO, OP_LOAD, OP_MMA, OP_READ = 0, 1, 2, 3
ENTRIES = 4
FORMATS = (golden.E4M3, golden.E5M2, golden.BF16, golden.E2M1)
UNIT = golden.UNIT_SCALE
ZERO_ROWS = [0] * 4
ZERO_TILE = [0] * 16
UNIT_SCALES = [UNIT] * 4
DRAIN_CYCLES = 8  # longer than the pipeline latency (a READ responds 4 cycles after it is accepted)


class TileModel:
    def __init__(self) -> None:
        self.acc = [[0] * 16 for _ in range(ENTRIES)]

    def apply(self, op, fmt, index, a, b, c, scales_a, scales_b):
        if op == OP_ZERO:
            self.acc[index] = [0] * 16
        elif op == OP_LOAD:
            self.acc[index] = list(c)
        elif op == OP_MMA:
            self.acc[index] = golden.mma4(a, b, self.acc[index], fmt, scales_a, scales_b)
        return list(self.acc[index]) if op == OP_READ else None


def command(op, fmt, index, a=ZERO_ROWS, b=ZERO_ROWS, c=ZERO_TILE, scales_a=UNIT_SCALES, scales_b=UNIT_SCALES):
    return (op, fmt, index, a, b, c, scales_a, scales_b)


async def reset(dut) -> None:
    Clock(dut.clk, 10, unit="ns").start()
    dut.rst_n.value = 0
    dut.cmd_valid.value = 0
    dut.rsp_ready.value = 0
    dut.cmd_op.value = 0
    dut.cmd_fmt.value = 0
    dut.cmd_acc.value = 0
    dut.cmd_a.value = 0
    dut.cmd_b.value = 0
    dut.cmd_scale_a.value = 0
    dut.cmd_scale_b.value = 0
    dut.cmd_c.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await FallingEdge(dut.clk)


def operands(fmt, rng, gaussian=True):
    """Four packed rows of A and four packed columns of B."""
    n = 64 // golden.ELEMENT_BITS[fmt]
    if gaussian:
        packed = lambda: golden.pack_row([gaussian_value(fmt, rng) for _ in range(n)], fmt)  # noqa: E731
    else:
        packed = lambda: rng.getrandbits(64)  # noqa: E731
    return [packed() for _ in range(4)], [packed() for _ in range(4)]


async def run_stream(dut, commands, ready_probability=1.0, accept_cycles=None):
    """Drive commands (see command()); return the READ responses in order.

    If accept_cycles is a list, the cycle number of every accepted command is appended to it."""
    responses = []
    cycle = 0
    pending = list(commands)
    idle = 0
    while pending or idle < DRAIN_CYCLES:
        if pending:
            op, fmt, index, a, b, c, scales_a, scales_b = pending[0]
            dut.cmd_valid.value = 1
            dut.cmd_op.value = op
            dut.cmd_fmt.value = fmt
            dut.cmd_acc.value = index
            dut.cmd_a.value = pack(a, 64)
            dut.cmd_b.value = pack(b, 64)
            dut.cmd_scale_a.value = pack(scales_a, 8)
            dut.cmd_scale_b.value = pack(scales_b, 8)
            dut.cmd_c.value = pack(c, 32)
        else:
            dut.cmd_valid.value = 0
        dut.rsp_ready.value = int(random.random() < ready_probability)
        await ReadOnly()
        rsp_valid, rsp_ready, cmd_ready = int(dut.rsp_valid.value), int(dut.rsp_ready.value), int(dut.cmd_ready.value)
        if rsp_valid and rsp_ready:
            responses.append(unpack(int(dut.rsp_data.value), 32, 16))
        accepted = bool(pending) and cmd_ready
        if accepted and accept_cycles is not None:
            accept_cycles.append(cycle)
        await RisingEdge(dut.clk)
        await FallingEdge(dut.clk)
        cycle += 1
        if accepted:
            pending.pop(0)
        idle = 0 if (pending or int(dut.rsp_valid.value)) else idle + 1
    dut.cmd_valid.value = 0
    dut.rsp_ready.value = 0
    return responses


@tb_test()
async def reset_clears_every_accumulator(dut):
    await reset(dut)
    responses = await run_stream(dut, [command(OP_READ, 0, i) for i in range(ENTRIES)])
    assert responses == [[0] * 16] * ENTRIES


@tb_test()
async def load_then_read_returns_the_tile(dut):
    await reset(dut)
    tiles = [[random.getrandbits(32) for _ in range(16)] for _ in range(ENTRIES)]
    commands = [command(OP_LOAD, 0, i, c=tiles[i]) for i in range(ENTRIES)]
    commands += [command(OP_READ, 0, i) for i in reversed(range(ENTRIES))]
    assert await run_stream(dut, commands) == list(reversed(tiles))


@tb_test()
async def single_mma_matches_golden_in_every_format(dut):
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    for fmt in FORMATS:
        model = TileModel()
        a, b = operands(fmt, rng)
        c = [random.getrandbits(32) & 0xBFFFFFFF for _ in range(16)]  # finite, moderate-magnitude addends
        commands = [command(OP_LOAD, fmt, 1, c=c), command(OP_MMA, fmt, 1, a, b), command(OP_READ, fmt, 1)]
        expected = [response for item in commands if (response := model.apply(*item)) is not None]
        assert await run_stream(dut, commands) == expected, f"fmt {golden.FORMATS[fmt]}"
        await run_stream(dut, [command(OP_ZERO, fmt, 1)])


@tb_test()
async def k_loop_accumulates_like_golden(dut):
    """8 successive MMAs into one accumulator per format: K = 32 BF16, 64 FP8, or 128 FP4."""
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    for fmt in FORMATS:
        model = TileModel()
        commands = [command(OP_ZERO, fmt, 2)]
        for _ in range(8):
            a, b = operands(fmt, rng)
            commands.append(command(OP_MMA, fmt, 2, a, b))
        commands.append(command(OP_READ, fmt, 2))
        expected = [response for item in commands if (response := model.apply(*item)) is not None]
        assert await run_stream(dut, commands) == expected, f"fmt {golden.FORMATS[fmt]}"


@tb_test()
async def random_command_stream_under_backpressure(dut):
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    model = TileModel()
    commands, expected = [], []
    for _ in range(400):
        op = rng.choice((OP_ZERO, OP_LOAD, OP_MMA, OP_MMA, OP_MMA, OP_READ, OP_READ))
        fmt = rng.choice(FORMATS)
        index = rng.randrange(ENTRIES)
        a, b = operands(fmt, rng, gaussian=rng.random() < 0.7)
        c = [rng.getrandbits(32) for _ in range(16)]
        scaled = rng.random() < 0.3
        scales_a = [rng.randint(UNIT - 10, UNIT + 10) for _ in range(4)] if scaled else UNIT_SCALES
        scales_b = [rng.randint(UNIT - 10, UNIT + 10) for _ in range(4)] if scaled else UNIT_SCALES
        item = command(op, fmt, index, a, b, c, scales_a, scales_b)
        commands.append(item)
        if (response := model.apply(*item)) is not None:
            expected.append(response)
    responses = await run_stream(dut, commands, ready_probability=0.6)
    assert len(responses) == len(expected), f"{len(responses)} responses for {len(expected)} READs"
    for number, (got, want) in enumerate(zip(responses, expected)):
        assert got == want, f"response {number}: rtl {[hex(x) for x in got]} golden {[hex(x) for x in want]}"


@tb_test()
async def dependent_chain_is_accepted_every_third_cycle(dut):
    """An MMA must wait for the previous MMA into the same accumulator to commit (3-stage pipeline)."""
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    fmt = golden.BF16
    model = TileModel()
    commands = []
    for _ in range(12):
        a, b = operands(fmt, rng)
        commands.append(command(OP_MMA, fmt, 3, a, b))
    commands.append(command(OP_READ, fmt, 3))
    expected = [response for item in commands if (response := model.apply(*item)) is not None]
    cycles: list[int] = []
    assert await run_stream(dut, commands, accept_cycles=cycles) == expected
    gaps = [later - earlier for earlier, later in zip(cycles, cycles[1:12])]
    assert gaps == [3] * 11, f"dependent MMAs accepted at gaps {gaps}, expected every 3 cycles"


@tb_test()
async def rotating_accumulators_sustain_one_mma_per_cycle(dut):
    """MMAs rotating over all accumulators never wait: a K-loop interleaved across 4 output tiles."""
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    fmt = golden.E4M3
    model = TileModel()
    commands = []
    for step in range(32):
        a, b = operands(fmt, rng)
        commands.append(command(OP_MMA, fmt, step % ENTRIES, a, b))
    commands += [command(OP_READ, fmt, index) for index in range(ENTRIES)]
    expected = [response for item in commands if (response := model.apply(*item)) is not None]
    cycles: list[int] = []
    assert await run_stream(dut, commands, accept_cycles=cycles) == expected
    assert cycles[:32] == list(range(cycles[0], cycles[0] + 32)), "rotating MMAs must be accepted on consecutive cycles"


@tb_test()
async def mx_scaled_fp4_k_loop(dut):
    """MXFP4: K = 64 as two 32-element blocks (2 MMAs each), each block with its own row and column scales."""
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    fmt = golden.E2M1
    model = TileModel()
    commands = [command(OP_ZERO, fmt, 0)]
    for _block in range(2):
        scales_a = [rng.randint(UNIT - 6, UNIT + 6) for _ in range(4)]
        scales_b = [rng.randint(UNIT - 6, UNIT + 6) for _ in range(4)]
        for _half in range(2):  # 16 FP4 elements per MMA, 32 per block
            a, b = operands(fmt, rng)
            commands.append(command(OP_MMA, fmt, 0, a, b, scales_a=scales_a, scales_b=scales_b))
    commands.append(command(OP_READ, fmt, 0))
    expected = [response for item in commands if (response := model.apply(*item)) is not None]
    assert await run_stream(dut, commands) == expected
