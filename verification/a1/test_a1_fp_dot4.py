"""a1_fp_dot4 against the golden model (verification/a1/golden.py), bit for bit.

Operands are 64-bit rows packing 4 BF16, 8 FP8, or 16 FP4 elements, with OCP MX E8M0 scales. Covers
every special-value rule (including NaN scales), exhaustive single products for both FP8 formats,
exhaustive FP4 products in every one of the 16 product slots, single FP8 products in every slot, random
bit patterns and random scales, realistic Gaussian data with cancelling addends, and the rule that a
scale factor can move between the two operands without changing the result.
"""

from __future__ import annotations

import random

from cocotb.triggers import Timer

import golden
from golden_accuracy import gaussian_value, random_c
from tb import tb_test

FORMATS = (golden.E4M3, golden.E5M2, golden.BF16, golden.E2M1)
RANDOM_CASES = 2500
UNIT = golden.UNIT_SCALE


async def evaluate(dut, a: int, b: int, c: int, fmt: int, scale_a: int = UNIT, scale_b: int = UNIT) -> int:
    dut.fmt.value = fmt
    dut.a.value = a
    dut.b.value = b
    dut.c.value = c
    dut.scale_a.value = scale_a
    dut.scale_b.value = scale_b
    await Timer(1, unit="ns")
    return int(dut.d.value)


async def check(dut, a, b, c, fmt, scale_a=UNIT, scale_b=UNIT, label=""):
    got = await evaluate(dut, a, b, c, fmt, scale_a, scale_b)
    want = golden.dot(a, b, c, fmt, scale_a, scale_b)
    assert got == want, (f"{label} fmt={golden.FORMATS[fmt]} a={a:#018x} b={b:#018x} c={c:#010x} "
                         f"scales=({scale_a},{scale_b}): rtl {got:#010x} golden {want:#010x}")


def row(values, fmt):
    return golden.pack_row(values, fmt)


def count(fmt):
    return 64 // golden.ELEMENT_BITS[fmt]


ONE = {golden.E4M3: 0x38, golden.E5M2: 0x3C, golden.BF16: 0x3F80, golden.E2M1: 0x2}
NAN = {golden.E4M3: 0x7F, golden.E5M2: 0x7E, golden.BF16: 0x7FC1}
INF = {golden.E5M2: 0x7C, golden.BF16: 0x7F80}
MAX = {golden.E4M3: 0x7E, golden.E5M2: 0x7B, golden.BF16: 0x7F7F, golden.E2M1: 0x7}
TINY = {golden.E4M3: 0x01, golden.E5M2: 0x01, golden.BF16: 0x0001, golden.E2M1: 0x1}
SIGN = {golden.E4M3: 0x80, golden.E5M2: 0x80, golden.BF16: 0x8000, golden.E2M1: 0x8}


@tb_test()
async def special_values_follow_the_spec(dut):
    for fmt in FORMATS:
        n, one, sign = count(fmt), ONE[fmt], SIGN[fmt]
        ones = row([one] * n, fmt)
        if fmt in NAN:
            for lane in range(n):  # a NaN in any element of either operand
                values = [one] * n
                values[lane] = NAN[fmt]
                await check(dut, row(values, fmt), ones, 0, fmt, label="nan-a")
                await check(dut, ones, row(values, fmt), 0, fmt, label="nan-b")
        await check(dut, ones, ones, 0x7FC00001, fmt, label="nan-c")
        await check(dut, ones, ones, 0x7F800000, fmt, label="inf-c")
        await check(dut, ones, ones, 0, fmt, 0xFF, UNIT, label="nan scale a")
        await check(dut, 0, 0, 0, fmt, UNIT, 0xFF, label="nan scale b, zero data")
        await check(dut, 0, 0, 0x80000000, fmt, label="+0 products, -0 c")
        await check(dut, row([sign] * n, fmt), ones, 0x80000000, fmt, label="all negative zeros")
        await check(dut, row([one, sign | one] + [0] * (n - 2), fmt), row([one, one] + [0] * (n - 2), fmt), 0, fmt, label="exact cancellation")
        await check(dut, row([MAX[fmt]] * n, fmt), row([MAX[fmt]] * n, fmt), 0x7F7FFFFF, fmt, label="overflow")
        await check(dut, row([MAX[fmt]] * n, fmt), row([MAX[fmt]] * n, fmt), 0, fmt, 254, 254, label="scale overflow")
        await check(dut, row([TINY[fmt]] * n, fmt), row([TINY[fmt]] * n, fmt), 0, fmt, label="subnormal products")
        await check(dut, ones, ones, 0, fmt, 0, 0, label="scale underflow (FTZ)")
        await check(dut, row([TINY[fmt]] * n, fmt), ones, 0x00400000, fmt, label="subnormal c")
        if fmt in INF:
            inf, zeros = INF[fmt], [0] * (n - 1)
            await check(dut, row([inf] + zeros, fmt), row([0] + zeros, fmt), 0, fmt, label="inf*0")
            await check(dut, row([inf, inf | sign] + zeros[1:], fmt), row([one, one] + zeros[1:], fmt), 0, fmt, label="inf-inf")
            await check(dut, row([inf] + zeros, fmt), row([one] + zeros, fmt), 0xFF800000, fmt, label="inf+(-inf c)")


@tb_test()
async def rounding_ties_go_to_even(dut):
    half_ulp, one = 0x3380, 0x3F80  # BF16 2^-24 and 1.0
    await check(dut, row([half_ulp, 0, 0, 0], golden.BF16), row([one, 0, 0, 0], golden.BF16), 0x3F800000, golden.BF16, label="tie down")
    await check(dut, row([half_ulp, 0, 0, 0], golden.BF16), row([one, 0, 0, 0], golden.BF16), 0x3F800001, golden.BF16, label="tie up")
    await check(dut, row([half_ulp, half_ulp, 0, 0], golden.BF16), row([one, 0x3400, 0, 0], golden.BF16), 0x3F800000, golden.BF16, label="above half")


@tb_test()
async def exhaustive_single_products_e4m3(dut):
    for x in range(256):
        for y in range(256):
            await check(dut, x, y, 0, golden.E4M3, label="exhaustive")


@tb_test()
async def exhaustive_single_products_e5m2(dut):
    for x in range(256):
        for y in range(256):
            await check(dut, x, y, 0, golden.E5M2, label="exhaustive")


@tb_test()
async def exhaustive_fp4_products_in_every_slot(dut):
    for slot in range(16):
        for x in range(16):
            for y in range(16):
                await check(dut, x << (4 * slot), y << (4 * slot), 0, golden.E2M1, label=f"slot {slot}")


@tb_test()
async def fp8_products_in_every_slot(dut):
    for fmt in (golden.E4M3, golden.E5M2):
        for slot in range(8):
            for _ in range(300):
                x, y = random.getrandbits(8), random.getrandbits(8)
                await check(dut, x << (8 * slot), y << (8 * slot), random.getrandbits(32), fmt, label=f"slot {slot}")


def random_scale() -> int:
    choice = random.random()
    if choice < 0.02:
        return 0xFF
    if choice < 0.05:
        return random.choice((0, 1, 253, 254))
    return random.randint(UNIT - 20, UNIT + 20)


@tb_test()
async def random_bit_patterns_and_scales(dut):
    for fmt in FORMATS:
        for _ in range(RANDOM_CASES):
            scale_a, scale_b = (random_scale(), random_scale()) if random.random() < 0.5 else (UNIT, UNIT)
            await check(dut, random.getrandbits(64), random.getrandbits(64), random.getrandbits(32), fmt, scale_a, scale_b, label="random")


@tb_test()
async def random_gaussian_with_cancellation(dut):
    rng = random.Random(random.getrandbits(32))
    for fmt in FORMATS:
        for _ in range(RANDOM_CASES):
            a_values = [gaussian_value(fmt, rng) for _ in range(count(fmt))]
            b_values = [gaussian_value(fmt, rng) for _ in range(count(fmt))]
            products = sum(golden.to_value(x, fmt) * golden.to_value(y, fmt) for x, y in zip(a_values, b_values))
            c = random_c(rng, products if products else None)
            await check(dut, row(a_values, fmt), row(b_values, fmt), c, fmt, label="gaussian")


@tb_test()
async def a_scale_factor_can_move_between_operands(dut):
    for fmt in FORMATS:
        for _ in range(500):
            a, b, c = random.getrandbits(64), random.getrandbits(64), random.getrandbits(32)
            scale_a, scale_b = random.randint(1, 253), random.randint(1, 253)
            first = await evaluate(dut, a, b, c, fmt, scale_a, scale_b)
            moved = await evaluate(dut, a, b, c, fmt, scale_a + 1, scale_b - 1)
            assert first == moved == golden.dot(a, b, c, fmt, scale_a, scale_b)
