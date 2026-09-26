"""Shared test decorator for the A1 cocotb regression.

Same settle step as verification/cocotb/tb.py: with Icarus 14.0 (devel) and cocotb 2.1.0.dev from the
pinned OSS CAD Suite, vvp can crash at shutdown if a test ends with a signal write still pending, so
every test ends with one 1 ns settle step. Kept as a copy because each regression's sandbox mounts only
its own test directory.
"""

from __future__ import annotations

import functools

import cocotb
from cocotb.triggers import Timer


def tb_test(**kwargs):
    def decorate(test):
        @functools.wraps(test)
        async def settled(dut):
            try:
                await test(dut)
            finally:
                await Timer(1, unit="ns")

        return cocotb.test(**kwargs)(settled)

    return decorate


def pack(values: list[int], width: int) -> int:
    """Lane 0 in the least significant bits."""
    word = 0
    for index, value in enumerate(values):
        word |= (value & ((1 << width) - 1)) << (width * index)
    return word


def unpack(word: int, width: int, count: int) -> list[int]:
    return [(word >> (width * index)) & ((1 << width) - 1) for index in range(count)]
