"""Normalized hashes for reproducibility comparisons.

Raw file hashes are always recorded. For comparing two runs, some outputs carry
values that say nothing about the design: GDSII stores modification and access
dates in every BGNLIB and BGNSTR record, and tool JSON can carry wall-clock,
CPU, memory, host, and date readings. Those (and only those) are ignored before
hashing.

Every manifest entry names the scheme that produced its hash and, for JSON, the
exact keys it dropped, so a comparison states exactly what was ignored. Two
hashes are comparable only when their schemes are equal (see
reconstruct.compare_manifests). What a scheme ignores never changes in place: a
change is a new scheme name. Before bumping one, note that /api/evidence
compares output_manifest_hash across runs with the same spec without looking at
schemes, which is sound only while old and new hashes agree on recorded outputs.
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
from pathlib import Path, PurePosixPath

RAW_SCHEME = "raw-v1"
GDS_SCHEME = "gds-v1"
JSON_SCHEME = "json-v2"

GDS_BGNLIB = 0x01
GDS_BGNSTR = 0x05
GDS_DATE_PAYLOAD = 24

# json-v2 drops a key, at any depth, when its trailing tokens are one of these.
# Only the end of a key is matched because the end says what the value is:
# `detailedroute__mem__peak` is a peak-memory reading, while `peak_bandwidth_gbps`
# is a bandwidth and `hostTrafficReductionPercent` a percentage. Everything else
# is compared; an output with another volatile key declares it in its adapter.
VOLATILE_SUFFIXES = frozenset({
    ("runtime", "total"),  # ORFS METRICS2.1 <stage>__runtime__total: wall-clock time
    ("cpu", "total"),  # ORFS METRICS2.1 <stage>__cpu__total: CPU time
    ("mem", "peak"),  # ORFS METRICS2.1 <stage>__mem__peak: peak memory
    ("timestamp",),
    ("time", "stamp"),
    ("date",),  # e.g. ORFS run__flow__generate_date
    ("hostname",),
    ("host", "name"),
})

# Entries recorded before schemes were named (every run up to 2026-09-22) carry
# only a description, which identifies exactly one scheme. json-v1 dropped, at any
# depth, every key whose lowercase form contained runtime, elapsed, cpu, mem,
# timestamp, time__, __time, wall, peak, host, or date, so it could drop design
# keys such as `candidates` or `aimem_bank`; its hashes compare only with json-v1.
LEGACY_SCHEMES: dict[str, tuple[str, tuple[str, ...]]] = {
    "none": (RAW_SCHEME, ()),
    "GDSII BGNLIB/BGNSTR dates zeroed": (GDS_SCHEME, ()),
    "canonical JSON without timing, memory, host, or date keys": ("json-v1", ()),
    "uid removed": ("json-v1", ("uid",)),
}

_TOKEN = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+")


def normalize(relative: str, data: bytes, declared: tuple[str, ...] = ()) -> dict:
    """The manifest entry for one reproducible output: its normalized hash, the scheme
    that produced it, and what was ignored. `declared` lists exact keys (JSON pointers,
    e.g. /checks/uid) that a JSON output also drops."""
    suffix = PurePosixPath(relative).suffix
    if declared and suffix != ".json":
        raise ValueError(f"{relative}: declared drops apply only to JSON outputs")
    if suffix == ".gds":
        return {"sha256": gds_sha256(data), "scheme": GDS_SCHEME, "normalization": f"{GDS_SCHEME}: GDSII BGNLIB/BGNSTR dates zeroed"}
    if suffix == ".json":
        digest, dropped = json_sha256(data, declared)
        return {
            "sha256": digest,
            "scheme": JSON_SCHEME,
            "declared": list(declared),
            "dropped": dropped,
            "normalization": f"{JSON_SCHEME}: canonical JSON {_without(dropped)}",
        }
    return {"sha256": hashlib.sha256(data).hexdigest(), "scheme": RAW_SCHEME, "normalization": f"{RAW_SCHEME}: bytes as written"}


def scheme_of(entry: dict) -> tuple[str, tuple[str, ...]] | None:
    """What produced a manifest entry's hash: (scheme, declared drops), or None if unknown."""
    if "scheme" in entry:
        return entry["scheme"], tuple(entry.get("declared", ()))
    return LEGACY_SCHEMES.get(entry.get("normalization"))


def gds_normalized_sha256(path: Path) -> str:
    return gds_sha256(path.read_bytes())


def gds_sha256(data: bytes) -> str:
    data = bytearray(data)
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


def json_sha256(data: bytes, declared: tuple[str, ...] = ()) -> tuple[str, list[str]]:
    """Canonical JSON without json-v2 volatile keys (at any depth) and the declared pointers.

    Returns the hash and the sorted JSON pointers of every dropped key. The text is
    serialized exactly as json-v1 serialized it, so a document both schemes drop the
    same keys from has the same hash under both.
    """
    for pointer in declared:
        if not pointer.startswith("/"):
            raise ValueError(f"declared drops are JSON pointers such as /checks/uid, not {pointer!r}")
    exact = frozenset(declared)
    dropped: list[str] = []

    def scrub(value, pointer: str):
        if isinstance(value, dict):
            kept = {}
            for key, item in value.items():
                child = f"{pointer}/{key.replace('~', '~0').replace('/', '~1')}"
                if child in exact or volatile_key(key):
                    dropped.append(child)
                else:
                    kept[key] = scrub(item, child)
            return kept
        if isinstance(value, list):
            return [scrub(item, f"{pointer}/{index}") for index, item in enumerate(value)]
        return value

    document = scrub(json.loads(data), "")
    text = json.dumps(document, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest(), sorted(dropped)


def key_tokens(key: str) -> tuple[str, ...]:
    """Lowercase words split at non-alphanumerics and camelCase: detailedroute__mem__peak -> (detailedroute, mem, peak)."""
    return tuple(token.lower() for token in _TOKEN.findall(key))


def volatile_key(key: str) -> bool:
    tokens = key_tokens(key)
    return any(tokens[-len(suffix) :] == suffix for suffix in VOLATILE_SUFFIXES)


def _without(dropped: list[str], shown: int = 8) -> str:
    if not dropped:
        return "with nothing dropped"
    more = f" and {len(dropped) - shown} more" if len(dropped) > shown else ""
    return f"without {', '.join(dropped[:shown])}{more}"
