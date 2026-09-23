"""Shared driver for one aimem_t0_channel command interface (also used through aimem_t0_top slices)."""

from __future__ import annotations

from dataclasses import dataclass, field

from cocotb.clock import Clock
from cocotb.triggers import FallingEdge, RisingEdge


@dataclass
class Response:
    latency: int
    data: int
    corrected: int
    uncorrectable: int
    flags_seen_before_response: dict = field(default_factory=dict)


class ChannelPort:
    """Drives a command and waits for its response. Inputs change on falling edges only."""

    def __init__(self, dut, index: int | None = None):
        self.dut = dut
        self.index = index  # None for the bare channel; a slice index for aimem_t0_top
        self.refreshes_seen = 0

    # -- slice helpers ------------------------------------------------------
    def _read(self, name: str, width: int = 1) -> int:
        value = int(getattr(self.dut, name).value)
        if self.index is None:
            return value
        return (value >> (self.index * width)) & ((1 << width) - 1)

    def _write(self, name: str, value: int, width: int = 1) -> None:
        handle = getattr(self.dut, name)
        if self.index is None:
            handle.value = value
            return
        current = int(handle.value)
        mask = ((1 << width) - 1) << (self.index * width)
        handle.value = (current & ~mask) | ((value << (self.index * width)) & mask)

    def ready(self) -> int:
        return self._read("cmd_ready")

    def refresh_urgent(self) -> int:
        return self._read("refresh_urgent")

    # -- transactions -------------------------------------------------------
    async def transact(self, bank: int, row: int, wdata: int, fault_mask: int = 0, write: int = 1, max_cycles: int = 32) -> Response:
        urgent_seen = False
        while not self.ready():
            urgent_seen = urgent_seen or bool(self.refresh_urgent())
            await FallingEdge(self.dut.clk)
        if urgent_seen:
            self.refreshes_seen += 1
        self._write("cmd_bank", bank, 4)
        self._write("cmd_row", row, 16)
        self._write("cmd_wdata", wdata, 64)
        self._write("fault_mask", fault_mask, 72)
        self._write("cmd_write", write)
        self._write("cmd_valid", 1)
        await RisingEdge(self.dut.clk)  # the accepting edge
        await FallingEdge(self.dut.clk)
        self._write("cmd_valid", 0)

        seen = {"corrected": 0, "uncorrectable": 0}
        for cycle in range(1, max_cycles + 1):
            if self._read("rsp_valid"):
                return Response(
                    latency=cycle,
                    data=self._read("rsp_rdata", 64),
                    corrected=self._read("ecc_corrected"),
                    uncorrectable=self._read("ecc_uncorrectable"),
                    flags_seen_before_response=seen,
                )
            seen["corrected"] |= self._read("ecc_corrected")
            seen["uncorrectable"] |= self._read("ecc_uncorrectable")
            await FallingEdge(self.dut.clk)
        raise AssertionError(f"no response within {max_cycles} cycles")


async def reset(dut, *, inputs: dict[str, int]) -> None:
    Clock(dut.clk, 10, unit="ns").start()
    dut.rst_n.value = 0
    for name, value in inputs.items():
        getattr(dut, name).value = value
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await FallingEdge(dut.clk)
