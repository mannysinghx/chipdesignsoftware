"""Golden model for the AIMEM-A1 tensor tile (C2). Pure Python integers: no floating point.

This file *is* the arithmetic specification. The RTL (rtl/a1/a1_fp_dot4.sv and its stages) must match
it bit for bit.

Fused dot product with accumulate over one 64-bit operand row a and column b:
    d = round_fp32(c + Xa * Xb * sum_k a_k * b_k)
The 64 bits hold n elements of the format, element k at bits [w*k +: w]:
    fmt 0 = FP8 E4M3 (OCP), w = 8,  n = 8
    fmt 1 = FP8 E5M2 (OCP), w = 8,  n = 8
    fmt 2 = BF16,           w = 16, n = 4
    fmt 3 = FP4 E2M1 (OCP MX), w = 4, n = 16
so each step does twice the multiplies for FP8 and four times for FP4, from the same operand bytes.
Xa and Xb are OCP MX E8M0 scales (2^(s - 127); s = 255 is NaN), one per operand row and column; plain
(unscaled) data uses s = 127. c and d are IEEE FP32.

Algorithm (the same for every format):
  1. Decode each operand to (class, sign, M, e) with value = (-1)^sign * M * 2^e. Subnormals are honored.
  2. Each product is exact: M = Ma * Mb (width 2q bits, q = significand bits incl. hidden: E4M3 4,
     E5M2 3, BF16 8, E2M1 2), e = ea + eb + (sa - 127) + (sb - 127). Its anchor (nominal MSB exponent)
     is e + 2q - 1. The addend c has width 24 and anchor e + 23.
  3. P = the largest anchor among nonzero terms. Every nonzero term is placed at the top of a
     W = 40-bit window and shifted right by (P - anchor), truncating: A = (M << (W - width)) >> (P - anchor).
  4. The signed integers are summed exactly: S = sum(+-A). The value is S * 2^(P - W + 1).
  5. S is rounded once to a 24-bit significand, round-to-nearest-even, using S's own bits.
  6. Results with a biased exponent >= 255 become +-Inf; results with a biased exponent <= 0 flush to
     +-0 (FTZ output; subnormal c inputs are still honored).

Special values:
  - Any NaN input or NaN scale, Inf * 0, or Infs of opposite sign -> canonical NaN 0x7FC00000.
    (E4M3 and E2M1 have no Inf; E2M1 has no NaN.)
  - Otherwise any Inf -> Inf with its sign.
  - No nonzero term: -0 only if every product and c is a negative zero, else +0.
  - Nonzero terms that cancel to S == 0 -> +0.
Truncation in step 3 discards bits more than W places below the largest term, so results can differ
from a correctly rounded sum; tests/test_golden_accuracy checks the resulting error bound.
"""

from __future__ import annotations

E4M3, E5M2, BF16, E2M1 = 0, 1, 2, 3
FORMATS = {E4M3: "e4m3", E5M2: "e5m2", BF16: "bf16", E2M1: "e2m1"}
ELEMENT_BITS = {E4M3: 8, E5M2: 8, BF16: 16, E2M1: 4}
UNIT_SCALE = 127  # E8M0 encoding of 1.0
WINDOW = 40
QNAN = 0x7FC00000

ZERO, FINITE, INF, NAN = "zero", "finite", "inf", "nan"

# (exponent bits, mantissa bits, bias, has_inf) per input format
LAYOUT = {E4M3: (4, 3, 7, False), E5M2: (5, 2, 15, True), BF16: (8, 7, 127, True), E2M1: (2, 1, 1, False)}


def significand_bits(fmt: int) -> int:
    return LAYOUT[fmt][1] + 1


def decode_input(x: int, fmt: int):
    """Returns (class, sign, M, e): value = (-1)^sign * M * 2^e."""
    exp_bits, man_bits, bias, has_inf = LAYOUT[fmt]
    width = 1 + exp_bits + man_bits
    x &= (1 << width) - 1
    sign = x >> (width - 1)
    exponent = (x >> man_bits) & ((1 << exp_bits) - 1)
    mantissa = x & ((1 << man_bits) - 1)
    top = (1 << exp_bits) - 1
    if fmt == E4M3 and exponent == top and mantissa == (1 << man_bits) - 1:
        return NAN, sign, 0, 0
    if has_inf and exponent == top:
        return (INF if mantissa == 0 else NAN), sign, 0, 0
    if exponent == 0:
        if mantissa == 0:
            return ZERO, sign, 0, 0
        return FINITE, sign, mantissa, 1 - bias - man_bits
    return FINITE, sign, (1 << man_bits) | mantissa, exponent - bias - man_bits


def decode_fp32(x: int):
    x &= 0xFFFFFFFF
    sign, exponent, mantissa = x >> 31, (x >> 23) & 0xFF, x & 0x7FFFFF
    if exponent == 0xFF:
        return (INF if mantissa == 0 else NAN), sign, 0, 0
    if exponent == 0:
        if mantissa == 0:
            return ZERO, sign, 0, 0
        return FINITE, sign, mantissa, -126 - 23
    return FINITE, sign, (1 << 23) | mantissa, exponent - 127 - 23


def elements(row: int, fmt: int) -> list[int]:
    """The n elements packed in a 64-bit operand row, element 0 in the low bits."""
    width = ELEMENT_BITS[fmt]
    return [(row >> (width * k)) & ((1 << width) - 1) for k in range(64 // width)]


def dot(a_row: int, b_col: int, c: int, fmt: int, scale_a: int = UNIT_SCALE, scale_b: int = UNIT_SCALE) -> int:
    """Bit-exact reference for a1_fp_dot4: one 64-bit row of A, one 64-bit column of B, FP32 c."""
    q = significand_bits(fmt)
    scale_nan = scale_a == 0xFF or scale_b == 0xFF
    scale_shift = (scale_a - UNIT_SCALE) + (scale_b - UNIT_SCALE)
    terms = []  # (class, sign, M, e, width)
    for x, y in zip(elements(a_row, fmt), elements(b_col, fmt)):
        ca, sa, ma, ea = decode_input(x, fmt)
        cb, sb, mb, eb = decode_input(y, fmt)
        sign = sa ^ sb
        if NAN in (ca, cb) or (INF in (ca, cb) and ZERO in (ca, cb)):
            terms.append((NAN, sign, 0, 0, 2 * q))
        elif INF in (ca, cb):
            terms.append((INF, sign, 0, 0, 2 * q))
        elif ZERO in (ca, cb):
            terms.append((ZERO, sign, 0, 0, 2 * q))
        else:
            terms.append((FINITE, sign, ma * mb, ea + eb + scale_shift, 2 * q))
    cc, sc, mc, ec = decode_fp32(c)
    terms.append((cc, sc, mc, ec, 24))
    if scale_nan:
        return QNAN

    classes = [term[0] for term in terms]
    if NAN in classes:
        return QNAN
    inf_signs = {term[1] for term in terms if term[0] == INF}
    if len(inf_signs) == 2:
        return QNAN
    if inf_signs:
        return (inf_signs.pop() << 31) | 0x7F800000

    finite = [term for term in terms if term[0] == FINITE]
    if not finite:
        return 0x80000000 if all(term[1] == 1 for term in terms) else 0

    anchors = [e + width - 1 for (_cls, _s, _m, e, width) in finite]
    top = max(anchors)
    total = 0
    for (_cls, sign, m, e, width), anchor in zip(finite, anchors):
        aligned = (m << (WINDOW - width)) >> (top - anchor)
        total += -aligned if sign else aligned
    if total == 0:
        return 0

    sign = 1 if total < 0 else 0
    magnitude = abs(total)
    length = magnitude.bit_length()
    exponent = top - WINDOW + length  # exponent of the leading bit
    if length > 24:
        drop = length - 24
        kept = magnitude >> drop
        remainder = magnitude & ((1 << drop) - 1)
        half = 1 << (drop - 1)
        if remainder > half or (remainder == half and kept & 1):
            kept += 1
            if kept == 1 << 24:
                kept >>= 1
                exponent += 1
    else:
        kept = magnitude << (24 - length)
    biased = exponent + 127
    if biased >= 255:
        return (sign << 31) | 0x7F800000
    if biased <= 0:
        return sign << 31
    return (sign << 31) | (biased << 23) | (kept & 0x7FFFFF)


def mma4(a_rows: list[int], b_cols: list[int], c: list[int], fmt: int,
         scales_a: list[int] | None = None, scales_b: list[int] | None = None) -> list[int]:
    """D = C + A x B for one tile step. a_rows[i], b_cols[j]: 64-bit packed operands; c[i*4+j] FP32.
    scales_a[i] and scales_b[j] are E8M0 (default 1.0). Returns d[i*4+j]."""
    scales_a = scales_a or [UNIT_SCALE] * 4
    scales_b = scales_b or [UNIT_SCALE] * 4
    return [dot(a_rows[i], b_cols[j], c[i * 4 + j], fmt, scales_a[i], scales_b[j]) for i in range(4) for j in range(4)]


def pack_row(values: list[int], fmt: int) -> int:
    width = ELEMENT_BITS[fmt]
    return sum((value & ((1 << width) - 1)) << (width * k) for k, value in enumerate(values))


def to_value(x: int, fmt: int | None = None):
    """Exact rational value of an input (fmt) or FP32 (fmt None); None for NaN, +-'inf' strings for Inf."""
    from fractions import Fraction

    cls, sign, m, e = decode_fp32(x) if fmt is None else decode_input(x, fmt)
    if cls == NAN:
        return None
    if cls == INF:
        return "-inf" if sign else "inf"
    value = Fraction(m) * (Fraction(2) ** e)
    return -value if sign else value
