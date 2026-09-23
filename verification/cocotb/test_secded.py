"""SECDED (72,64): encoder against an independent reference, and exhaustive single/double fault behavior."""

from __future__ import annotations

import itertools
import random

from cocotb.triggers import Timer

from reference import MASK_72, secded_encode
from tb import tb_test

EDGE_WORDS = [0, (1 << 64) - 1, 0x5555_5555_5555_5555, 0xAAAA_AAAA_AAAA_AAAA, 0x0123_4567_89AB_CDEF]


async def settle(dut, data: int, mask: int) -> None:
    dut.data_in.value = data
    dut.fault_mask.value = mask
    await Timer(1, unit="ns")


@tb_test()
async def encoder_matches_reference(dut):
    words = EDGE_WORDS + [random.getrandbits(64) for _ in range(300)]
    for word in words:
        await settle(dut, word, 0)
        assert int(dut.code.value) == secded_encode(word), f"code mismatch for {word:#018x}"
        assert int(dut.data_out.value) == word
        assert int(dut.corrected.value) == 0 and int(dut.uncorrectable.value) == 0
        assert int(dut.syndrome.value) == 0


@tb_test()
async def every_single_bit_fault_is_corrected(dut):
    for word in EDGE_WORDS + [random.getrandbits(64) for _ in range(6)]:
        for position in range(72):
            await settle(dut, word, 1 << position)
            assert int(dut.data_out.value) == word, f"bit {position} not corrected for {word:#018x}"
            assert int(dut.corrected.value) == 1, f"bit {position}: corrected flag missing"
            assert int(dut.uncorrectable.value) == 0, f"bit {position}: flagged uncorrectable"


@tb_test()
async def every_double_bit_fault_is_detected(dut):
    pairs = list(itertools.combinations(range(72), 2))
    for word in (EDGE_WORDS[4], random.getrandbits(64)):
        for first, second in pairs:
            await settle(dut, word, (1 << first) | (1 << second))
            assert int(dut.uncorrectable.value) == 1, f"bits {first},{second} not detected for {word:#018x}"
            assert int(dut.corrected.value) == 0, f"bits {first},{second} miscorrected"
    dut._log.info("checked %d double-bit fault pairs per word", len(pairs))


@tb_test()
async def syndrome_names_the_faulty_position(dut):
    word = EDGE_WORDS[4]
    for position in range(71):
        await settle(dut, word, 1 << position)
        assert int(dut.syndrome.value) == position + 1
    await settle(dut, word, 1 << 71)
    assert int(dut.syndrome.value) == 0, "an overall-parity fault has a zero syndrome"
    assert int(dut.code.value) & ~MASK_72 == 0
