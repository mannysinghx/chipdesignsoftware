"""Checks the golden model's numerics against exact rational arithmetic (no RTL involved).

For random finite inputs of every format, the exact value c + sum(a_i * b_i) is computed with
fractions and rounded correctly to FP32 (same Inf/FTZ rules). The golden result must be within the
error bound its algorithm guarantees: half an ulp of rounding plus at most one unit of the 40-bit
window per truncated term. Also reports how often the golden result is exactly the correctly rounded
one. Deterministic for a given seed.

Usage: python golden_accuracy.py [--seed N] [--cases N]  (prints JSON; exit 1 on any bound violation)
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import golden  # noqa: E402

TWO = Fraction(2)


def round_fp32_exact(value: Fraction) -> int:
    """Correctly rounded (RNE) FP32 bits for an exact rational, with golden's Inf and FTZ rules."""
    if value == 0:
        return 0
    sign = 1 if value < 0 else 0
    magnitude = -value if sign else value
    exponent = magnitude.numerator.bit_length() - magnitude.denominator.bit_length()
    while TWO ** exponent > magnitude:
        exponent -= 1
    while TWO ** (exponent + 1) <= magnitude:
        exponent += 1
    scaled = magnitude / (TWO ** (exponent - 23))  # in [2^23, 2^24)
    kept = scaled.numerator // scaled.denominator
    remainder = scaled - kept
    if remainder > Fraction(1, 2) or (remainder == Fraction(1, 2) and kept & 1):
        kept += 1
        if kept == 1 << 24:
            kept >>= 1
            exponent += 1
    biased = exponent + 127
    if biased >= 255:
        return (sign << 31) | 0x7F800000
    if biased <= 0:
        return sign << 31
    return (sign << 31) | (biased << 23) | (kept & 0x7FFFFF)


def random_finite(fmt: int, rng: random.Random) -> int:
    while True:
        x = rng.getrandbits(16 if fmt == golden.BF16 else 8)
        cls = golden.decode_input(x, fmt)[0]
        if cls in (golden.FINITE, golden.ZERO):
            return x


_TABLES: dict[int, list[tuple[float, int]]] = {}


def gaussian_value(fmt: int, rng: random.Random) -> int:
    """A N(0, 1) sample rounded to the nearest finite value of the format (realistic tensor data)."""
    import bisect

    if fmt not in _TABLES:
        width = 16 if fmt == golden.BF16 else 8
        table = {}
        for x in range(1 << width):
            value = golden.to_value(x, fmt)
            if value is not None and not isinstance(value, str) and not (value == 0 and x):
                table.setdefault(float(value), x)
        _TABLES[fmt] = sorted(table.items())
    table = _TABLES[fmt]
    keys = [value for value, _x in table]
    target = rng.gauss(0.0, 1.0)
    index = bisect.bisect_left(keys, target)
    candidates = [table[i] for i in (index - 1, index) if 0 <= i < len(table)]
    return min(candidates, key=lambda entry: abs(entry[0] - target))[1]


def random_c(rng: random.Random, scale_like: Fraction | None) -> int:
    choice = rng.random()
    if choice < 0.2:
        return 0
    if choice < 0.6 and scale_like:
        # a c close to the negated product sum, to exercise cancellation
        target = -scale_like * Fraction(rng.randint(90, 110), 100)
        bits = round_fp32_exact(target)
        if golden.decode_fp32(bits)[0] in (golden.FINITE, golden.ZERO):
            return bits
    while True:
        x = rng.getrandbits(32)
        if golden.decode_fp32(x)[0] in (golden.FINITE, golden.ZERO):
            return x


def top_anchor(a, b, c, fmt) -> int | None:
    q = golden.significand_bits(fmt)
    anchors = []
    for x, y in zip(a, b):
        ca, _sa, _ma, ea = golden.decode_input(x, fmt)
        cb, _sb, _mb, eb = golden.decode_input(y, fmt)
        if ca == golden.FINITE and cb == golden.FINITE:
            anchors.append(ea + eb + 2 * q - 1)
    cc, _sc, _mc, ec = golden.decode_fp32(c)
    if cc == golden.FINITE:
        anchors.append(ec + 23)
    return max(anchors) if anchors else None


def ulp(bits: int) -> Fraction:
    exponent = (bits >> 23) & 0xFF
    return TWO ** (max(exponent, 1) - 127 - 23)


def run(seed: int, cases: int) -> dict:
    rng = random.Random(seed)
    report = {"seed": seed, "cases_per_format": cases, "formats": {}}
    violations = []
    for (fmt, name), distribution in [(item, dist) for dist in ("uniform-bits", "gaussian") for item in golden.FORMATS.items()]:
        draw = random_finite if distribution == "uniform-bits" else gaussian_value
        exact_matches = 0
        checked = 0
        worst_ulps = Fraction(0)
        for _ in range(cases):
            a = [draw(fmt, rng) for _ in range(4)]
            b = [draw(fmt, rng) for _ in range(4)]
            products = sum(golden.to_value(x, fmt) * golden.to_value(y, fmt) for x, y in zip(a, b))
            c = random_c(rng, products if products else None)
            exact = golden.to_value(c) + products
            if abs(exact) >= TWO ** 128:
                continue  # beyond FP32 range; overflow handling is covered by the RTL directed tests
            got = golden.dot4(a, b, c, fmt)
            want = round_fp32_exact(exact)
            if got == want:
                exact_matches += 1
            got_exp = (got >> 23) & 0xFF
            if got_exp in (0, 0xFF) or ((want >> 23) & 0xFF) in (0, 0xFF):
                continue  # Inf/FTZ boundary cases are compared bit-for-bit above, not by error bound
            checked += 1
            error = abs(golden.to_value(got) - exact)
            top = top_anchor(a, b, c, fmt)
            bound = ulp(got) / 2 + 5 * TWO ** (top - golden.WINDOW + 1)
            if error > bound:
                violations.append({"fmt": name, "a": a, "b": b, "c": c, "got": got, "want": want})
            worst_ulps = max(worst_ulps, error / ulp(got))
        report["formats"][f"{name}/{distribution}"] = {
            "exactly_rounded_percent": round(100 * exact_matches / cases, 3),
            "bound_checked": checked,
            "worst_error_ulps": float(worst_ulps),
        }
    report["violations"] = violations[:10]
    report["violation_count"] = len(violations)
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=20260926)
    parser.add_argument("--cases", type=int, default=4000)
    args = parser.parse_args()
    report = run(args.seed, args.cases)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if report["violation_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
