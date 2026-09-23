"""Normalized hashes for reproducibility comparisons.

Raw file hashes are always recorded. For comparing two runs, some formats embed
wall-clock metadata that says nothing about the design: GDSII stores
modification and access dates in every BGNLIB and BGNSTR record. Those 24-byte
date payloads (and only those) are zeroed before hashing. Every normalization
is named, so a comparison states exactly what was ignored.
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

GDS_BGNLIB = 0x01
GDS_BGNSTR = 0x05
GDS_DATE_PAYLOAD = 24


def gds_normalized_sha256(path: Path) -> str:
    data = bytearray(path.read_bytes())
    offset = 0
    while offset + 4 <= len(data):
        (length,) = struct.unpack(">H", data[offset : offset + 2])
        record_type = data[offset + 2]
        if length < 4:
            break  # padding at the end of the stream
        if record_type in (GDS_BGNLIB, GDS_BGNSTR) and length - 4 == GDS_DATE_PAYLOAD:
            data[offset + 4 : offset + length] = bytes(GDS_DATE_PAYLOAD)
        offset += length
    return hashlib.sha256(bytes(data)).hexdigest()


def json_normalized_sha256(path: Path, drop_keys: frozenset[str] = frozenset()) -> str:
    """Canonical JSON with volatile keys (timings, memory, paths) removed at any depth."""

    def scrub(value):
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items() if not _volatile(key, drop_keys)}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value

    document = scrub(json.loads(path.read_text()))
    text = json.dumps(document, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


VOLATILE_MARKERS = ("runtime", "elapsed", "cpu", "mem", "timestamp", "time__", "__time", "wall", "peak", "host", "date")


def _volatile(key: str, drop_keys: frozenset[str]) -> bool:
    lowered = key.lower()
    return key in drop_keys or any(marker in lowered for marker in VOLATILE_MARKERS)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()
