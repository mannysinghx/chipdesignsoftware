"""Shared test decorator for the T0 cocotb regression."""

from __future__ import annotations

import functools

import cocotb
from cocotb.triggers import Timer


def tb_test(**kwargs):
    """cocotb.test that always lets pending signal writes settle before the test ends.

    With Icarus Verilog 14.0 (devel) and cocotb 2.1.0.dev (OSS CAD Suite 2026-09-22),
    vvp crashes with SIGSEGV at shutdown when a test ends while a scheduled write is
    still pending. Reproduced in isolation: a clocked test ending on a write crashes,
    and the same test followed by one 1 ns settle step exits cleanly.
    """

    def decorate(test):
        @functools.wraps(test)
        async def settled(dut):
            try:
                await test(dut)
            finally:
                await Timer(1, unit="ns")

        return cocotb.test(**kwargs)(settled)

    return decorate
