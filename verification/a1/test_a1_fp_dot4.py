"""a1_fp_dot4 against the golden model (verification/a1/golden.py), bit for bit.

Covers every special-value rule, exhaustive single products for both FP8 formats, random bit patterns
(which include NaN, Inf, zeros, and subnormals), realistic Gaussian data with cancelling addends, and
the rule that FP8 formats ignore the upper byte of each lane.
"""

from __future__ import annotations

import random

from cocotb.triggers import Timer

import golden
from golden_accuracy import gaussian_value, random_c
from tb import pack, tb_test

FORMATS = (golden.E4M3, golden.E5M2, golden.BF16)
RANDOM_CASES = 3000


async def evaluate(dut, a: list[int], b: list[int], c: int, fmt: int) -> int:
    dut.fmt.value = fmt
    dut.a.value = pack(a, 16)
    dut.b.value = pack(b, 16)
    dut.c.value = c
    await Timer(1, unit="ns")
    return int(dut.d.value)


async def check(dut, a, b, c, fmt, label=""):
    got = await evaluate(dut, a, b, c, fmt)
    want = golden.dot4(a, b, c, fmt)
    assert got == want, f"{label} fmt={golden.FORMATS[fmt]} a={[hex(x) for x in a]} b={[hex(x) for x in b]} c={c:#010x}: rtl {got:#010x} golden {want:#010x}"


ONE = {golden.E4M3: 0x38, golden.E5M2: 0x3C, golden.BF16: 0x3F80}
NAN = {golden.E4M3: 0x7F, golden.E5M2: 0x7E, golden.BF16: 0x7FC1}
INF = {golden.E5M2: 0x7C, golden.BF16: 0x7F80}
MAX = {golden.E4M3: 0x7E, golden.E5M2: 0x7B, golden.BF16: 0x7F7F}
TINY = {golden.E4M3: 0x01, golden.E5M2: 0x01, golden.BF16: 0x0001}  # smallest subnormal


@tb_test()
async def special_values_follow_the_spec(dut):
    for fmt in FORMATS:
        one, nan, zero = ONE[fmt], NAN[fmt], 0
        sign = 0x8000 if fmt == golden.BF16 else 0x80
        for lane in range(4):  # a NaN in any lane of either operand
            a = [one] * 4
            a[lane] = nan
            await check(dut, a, [one] * 4, 0, fmt, "nan-a")
            await check(dut, [one] * 4, a, 0, fmt, "nan-b")
        await check(dut, [one] * 4, [one] * 4, 0x7FC00001, fmt, "nan-c")
        await check(dut, [one] * 4, [one] * 4, 0x7F800000, fmt, "inf-c")
        await check(dut, [one] * 4, [one] * 4, 0xFF800000, fmt, "neg-inf-c")
        await check(dut, [zero] * 4, [zero] * 4, 0x80000000, fmt, "+0 products, -0 c")
        await check(dut, [sign] * 4, [one] * 4, 0x80000000, fmt, "all negative zeros")
        await check(dut, [one, sign | one, 0, 0], [one, one, 0, 0], 0, fmt, "exact cancellation")
        await check(dut, [MAX[fmt]] * 4, [MAX[fmt]] * 4, 0x7F7FFFFF, fmt, "overflow")
        await check(dut, [TINY[fmt]] * 4, [TINY[fmt]] * 4, 0, fmt, "subnormal products")
        await check(dut, [TINY[fmt]] * 4, [one] * 4, 0x00400000, fmt, "subnormal c")
        if fmt in INF:
            inf = INF[fmt]
            neg_inf = inf | sign
            await check(dut, [inf, 0, 0, 0], [zero, 0, 0, 0], 0, fmt, "inf*0")
            await check(dut, [inf, neg_inf, 0, 0], [one, one, 0, 0], 0, fmt, "inf-inf")
            await check(dut, [inf, 0, 0, 0], [one, 0, 0, 0], 0xFF800000, fmt, "inf+(-inf c)")
            await check(dut, [inf, one, 0, 0], [one, one, 0, 0], 0x3F800000, fmt, "inf wins")


@tb_test()
async def rounding_ties_go_to_even(dut):
    # c = 1.0 plus a BF16 product worth exactly half an ulp of 1.0 (2^-24): tie, stays even.
    half_ulp = 0x3380  # BF16 2^-24
    one = 0x3F80
    await check(dut, [half_ulp, 0, 0, 0], [one, 0, 0, 0], 0x3F800000, golden.BF16, "tie to even (down)")
    await check(dut, [half_ulp, 0, 0, 0], [one, 0, 0, 0], 0x3F800001, golden.BF16, "tie to even (up)")
    await check(dut, [half_ulp, half_ulp, 0, 0], [one, 0x3400, 0, 0], 0x3F800000, golden.BF16, "above half")


@tb_test()
async def exhaustive_single_products_e4m3(dut):
    for x in range(256):
        for y in range(256):
            await check(dut, [x, 0, 0, 0], [y, 0, 0, 0], 0, golden.E4M3, "exhaustive")


@tb_test()
async def exhaustive_single_products_e5m2(dut):
    for x in range(256):
        for y in range(256):
            await check(dut, [x, 0, 0, 0], [y, 0, 0, 0], 0, golden.E5M2, "exhaustive")


@tb_test()
async def random_bit_patterns(dut):
    for fmt in FORMATS:
        width = 16 if fmt == golden.BF16 else 8
        for _ in range(RANDOM_CASES):
            a = [random.getrandbits(width) for _ in range(4)]
            b = [random.getrandbits(width) for _ in range(4)]
            c = random.getrandbits(32)
            await check(dut, a, b, c, fmt, "random bits")


@tb_test()
async def random_gaussian_with_cancellation(dut):
    rng = random.Random(random.getrandbits(32))
    for fmt in FORMATS:
        for _ in range(RANDOM_CASES):
            a = [gaussian_value(fmt, rng) for _ in range(4)]
            b = [gaussian_value(fmt, rng) for _ in range(4)]
            products = sum(golden.to_value(x, fmt) * golden.to_value(y, fmt) for x, y in zip(a, b))
            c = random_c(rng, products if products else None)
            await check(dut, a, b, c, fmt, "gaussian")


@tb_test()
async def fp8_ignores_the_upper_byte(dut):
    for fmt in (golden.E4M3, golden.E5M2):
        for _ in range(500):
            a = [random.getrandbits(8) for _ in range(4)]
            b = [random.getrandbits(8) for _ in range(4)]
            c = random.getrandbits(32)
            clean = await evaluate(dut, a, b, c, fmt)
            noisy = await evaluate(dut, [x | (random.getrandbits(8) << 8) for x in a], [y | (random.getrandbits(8) << 8) for y in b], c, fmt)
            assert clean == noisy == golden.dot4(a, b, c, fmt)
