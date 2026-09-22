"""Canonical serialization and hashing for audit events.

Structured fields (details, cost, policy decision, redaction) are stored as the
exact canonical JSON text that was hashed, not as JSONB. JSONB rewrites numbers
and key order on the way in, so recomputing a hash from JSONB can report
tampering that never happened. Storing the hashed bytes makes verification a
pure recomputation.
"""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import PurePath

GENESIS_HASH = "0" * 64
HASH_VERSION = 1

# Every column except `hash`, in the order they are documented. Changing this
# list requires a new HASH_VERSION so older rows still verify.
HASH_FIELDS: dict[int, tuple[str, ...]] = {
    1: (
        "hash_version",
        "seq",
        "event_id",
        "ts",
        "trace_id",
        "span_id",
        "parent_event_id",
        "actor_type",
        "actor_id",
        "actor_version",
        "authenticated",
        "source",
        "feature",
        "action",
        "result",
        "target_type",
        "target_id",
        "input_hash",
        "output_hash",
        "error",
        "details_json",
        "cost_json",
        "evidence_class",
        "policy_json",
        "redaction_json",
        "client_ts",
        "prev_hash",
    )
}

MAX_DEPTH = 32


def clean_text(value: str) -> str:
    """Make a string storable in Postgres TEXT without losing what it said."""
    value = value.replace("\x00", "\\u0000")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        value = value.encode("utf-8", "backslashreplace").decode("utf-8")
    return value


def format_ts(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("audit timestamps must be timezone-aware")
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def sanitize(value: object, _depth: int = 0) -> object:
    """Convert arbitrary Python data into JSON-safe, Postgres-safe values."""
    if _depth > MAX_DEPTH:
        raise ValueError("audit details are nested too deeply")
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else repr(value)
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, datetime):
        return format_ts(value)
    if isinstance(value, (uuid.UUID, PurePath, Decimal)):
        return str(value)
    if isinstance(value, bytes):
        return {"sha256": hashlib.sha256(value).hexdigest(), "bytes": len(value)}
    if isinstance(value, Mapping):
        return {clean_text(str(key)): sanitize(item, _depth + 1) for key, item in value.items()}
    if isinstance(value, (set, frozenset)):
        items = [sanitize(item, _depth + 1) for item in value]
        return sorted(items, key=dumps_canonical)
    if isinstance(value, (list, tuple)):
        return [sanitize(item, _depth + 1) for item in value]
    return clean_text(repr(value))


def dumps_canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def to_json_text(value: object) -> str | None:
    return None if value is None else dumps_canonical(sanitize(value))


def _normalize(value: object) -> object:
    if isinstance(value, datetime):
        return format_ts(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def hash_payload(row: Mapping[str, object]) -> str:
    fields = HASH_FIELDS[int(row["hash_version"])]
    return dumps_canonical({name: _normalize(row.get(name)) for name in fields})


def compute_event_hash(row: Mapping[str, object]) -> str:
    return hashlib.sha256(hash_payload(row).encode("utf-8")).hexdigest()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
