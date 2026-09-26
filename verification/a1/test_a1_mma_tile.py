"""a1_mma_tile against a golden model of the tile: an accumulator array updated by golden.mma4.

Every READ response is compared with the golden accumulator state, and the handshake rule
cmd_ready == !rsp_valid || rsp_ready is checked on every cycle.
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
FORMATS = (golden.E4M3, golden.E5M2, golden.BF16)


class TileModel:
    def __init__(self) -> None:
        self.acc = [[0] * 16 for _ in range(ENTRIES)]

    def apply(self, op, fmt, index, a, b, c):
        if op == OP_ZERO:
            self.acc[index] = [0] * 16
        elif op == OP_LOAD:
            self.acc[index] = list(c)
        elif op == OP_MMA:
            self.acc[index] = golden.mma4(a, b, self.acc[index], fmt)
        return list(self.acc[index]) if op == OP_READ else None


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
    dut.cmd_c.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await FallingEdge(dut.clk)


def operands(fmt, rng, gaussian=True):
    draw = (lambda: gaussian_value(fmt, rng)) if gaussian else (lambda: rng.getrandbits(16 if fmt == golden.BF16 else 8))
    return [draw() for _ in range(16)], [draw() for _ in range(16)]


async def run_stream(dut, commands, ready_probability=1.0):
    """Drive (op, fmt, index, a, b, c) commands; return the READ responses in order, checking the handshake."""
    responses = []
    pending = list(commands)
    idle = 0
    while pending or idle < 3:
        if pending:
            op, fmt, index, a, b, c = pending[0]
            dut.cmd_valid.value = 1
            dut.cmd_op.value = op
            dut.cmd_fmt.value = fmt
            dut.cmd_acc.value = index
            dut.cmd_a.value = pack(a, 16)
            dut.cmd_b.value = pack(b, 16)
            dut.cmd_c.value = pack(c, 32)
        else:
            dut.cmd_valid.value = 0
        dut.rsp_ready.value = int(random.random() < ready_probability)
        await ReadOnly()
        rsp_valid, rsp_ready, cmd_ready = int(dut.rsp_valid.value), int(dut.rsp_ready.value), int(dut.cmd_ready.value)
        assert cmd_ready == int((not rsp_valid) or rsp_ready), "cmd_ready must equal !rsp_valid || rsp_ready"
        if rsp_valid and rsp_ready:
            responses.append(unpack(int(dut.rsp_data.value), 32, 16))
        accepted = bool(pending) and cmd_ready
        await RisingEdge(dut.clk)
        await FallingEdge(dut.clk)
        if accepted:
            pending.pop(0)
        idle = 0 if (pending or int(dut.rsp_valid.value)) else idle + 1
    dut.cmd_valid.value = 0
    dut.rsp_ready.value = 0
    return responses


@tb_test()
async def reset_clears_every_accumulator(dut):
    await reset(dut)
    zeros = [0] * 16
    responses = await run_stream(dut, [(OP_READ, 0, i, zeros, zeros, zeros) for i in range(ENTRIES)])
    assert responses == [[0] * 16] * ENTRIES


@tb_test()
async def load_then_read_returns_the_tile(dut):
    await reset(dut)
    tiles = [[random.getrandbits(32) for _ in range(16)] for _ in range(ENTRIES)]
    zeros = [0] * 16
    commands = [(OP_LOAD, 0, i, zeros, zeros, tiles[i]) for i in range(ENTRIES)]
    commands += [(OP_READ, 0, i, zeros, zeros, zeros) for i in reversed(range(ENTRIES))]
    assert await run_stream(dut, commands) == list(reversed(tiles))


@tb_test()
async def single_mma_matches_golden_in_every_format(dut):
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    for fmt in FORMATS:
        model = TileModel()
        a, b = operands(fmt, rng)
        c = [random.getrandbits(32) & 0xBFFFFFFF for _ in range(16)]  # finite, moderate-magnitude addends
        zeros = [0] * 16
        commands = [(OP_LOAD, fmt, 1, a, b, c), (OP_MMA, fmt, 1, a, b, c), (OP_READ, fmt, 1, a, b, c)]
        expected = [response for command in commands if (response := model.apply(*command)) is not None]
        assert await run_stream(dut, commands) == expected, f"fmt {golden.FORMATS[fmt]}"
        await run_stream(dut, [(OP_ZERO, fmt, 1, zeros, zeros, zeros)])


@tb_test()
async def k_loop_accumulates_like_golden(dut):
    """A K = 32 reduction as 8 successive MMAs into one accumulator, per format."""
    await reset(dut)
    rng = random.Random(random.getrandbits(32))
    for fmt in FORMATS:
        model = TileModel()
        zeros = [0] * 16
        commands = [(OP_ZERO, fmt, 2, zeros, zeros, zeros)]
        for _ in range(8):
            a, b = operands(fmt, rng)
            commands.append((OP_MMA, fmt, 2, a, b, zeros))
        commands.append((OP_READ, fmt, 2, zeros, zeros, zeros))
        expected = [response for command in commands if (response := model.apply(*command)) is not None]
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
        command = (op, fmt, index, a, b, c)
        commands.append(command)
        if (response := model.apply(*command)) is not None:
            expected.append(response)
    responses = await run_stream(dut, commands, ready_probability=0.6)
    assert len(responses) == len(expected), f"{len(responses)} responses for {len(expected)} READs"
    for number, (got, want) in enumerate(zip(responses, expected)):
        assert got == want, f"response {number}: rtl {[hex(x) for x in got]} golden {[hex(x) for x in want]}"
