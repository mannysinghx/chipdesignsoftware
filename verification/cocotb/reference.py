"""Independent Python reference models for the T0 RTL blocks."""

from __future__ import annotations

PARITY_POSITIONS = frozenset({1, 2, 4, 8, 16, 32, 64})
DATA_POSITIONS = [position for position in range(1, 72) if position not in PARITY_POSITIONS]
MASK_72 = (1 << 72) - 1


def secded_encode(data: int) -> int:
    """(72,64) extended Hamming code: data in non-power-of-two positions 1..71, parity at 2^k, overall parity at bit 71."""
    code = 0
    for index, position in enumerate(DATA_POSITIONS):
        if (data >> index) & 1:
            code |= 1 << (position - 1)
    for parity in range(7):
        bit = 0
        for position in range(1, 72):
            if position & (1 << parity) and (code >> (position - 1)) & 1:
                bit ^= 1
        if bit:
            code |= 1 << ((1 << parity) - 1)
    if bin(code).count("1") & 1:
        code |= 1 << 71
    return code


def lane_repair(fail_mask: int, lanes: int = 64, spares: int = 2, map_bits: int = 7) -> tuple[list[int], bool, int]:
    """First `spares` failing lanes remap to spare lanes LANES.., later failures stay in place."""
    lane_map: list[int] = []
    failures = 0
    spare = 0
    for lane in range(lanes):
        if (fail_mask >> lane) & 1:
            failures += 1
            if spare < spares:
                lane_map.append(lanes + spare)
                spare += 1
                continue
        lane_map.append(lane)
    return lane_map, failures <= spares, failures % (1 << map_bits)


def gather_addresses(base: int, stride: int, count: int) -> list[tuple[int, bool]]:
    """(address, last) sequence of a strided gather descriptor, with 48-bit wraparound."""
    return [((base + index * stride) % (1 << 48), index == count - 1) for index in range(count)]
