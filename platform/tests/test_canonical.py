from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from aimem_platform.audit.canonical import (
    GENESIS_HASH,
    HASH_FIELDS,
    HASH_VERSION,
    clean_text,
    compute_event_hash,
    dumps_canonical,
    format_ts,
    sanitize,
)


def sample_row() -> dict:
    return {
        "hash_version": HASH_VERSION,
        "seq": 7,
        "event_id": uuid.UUID("12345678-1234-5678-1234-567812345678"),
        "ts": datetime(2026, 9, 22, 12, 0, 0, 123456, tzinfo=timezone.utc),
        "trace_id": "a" * 32,
        "span_id": "b" * 16,
        "parent_event_id": None,
        "actor_type": "human",
        "actor_id": "admin@aimem.test",
        "actor_version": None,
        "authenticated": True,
        "source": "api",
        "feature": "artifact.write",
        "action": "artifact_written",
        "result": "ok",
        "target_type": "artifact",
        "target_id": "f" * 64,
        "input_hash": None,
        "output_hash": "sha256:" + "f" * 64,
        "error": None,
        "details_json": '{"a":1}',
        "cost_json": None,
        "evidence_class": "executed",
        "policy_json": None,
        "redaction_json": None,
        "client_ts": None,
        "prev_hash": GENESIS_HASH,
    }


def test_hash_is_stable_and_covers_every_field():
    row = sample_row()
    baseline = compute_event_hash(row)
    assert baseline == compute_event_hash(dict(row))
    replacements = {
        "hash_version": HASH_VERSION,  # same value; skipped below
        "seq": 8,
        "event_id": uuid.uuid4(),
        "ts": row["ts"] + timedelta(microseconds=1),
        "trace_id": "c" * 32,
        "span_id": "d" * 16,
        "parent_event_id": uuid.uuid4(),
        "actor_type": "agent",
        "actor_id": "someone-else",
        "actor_version": "v2",
        "authenticated": False,
        "source": "ui",
        "feature": "artifact.read",
        "action": "artifact_read",
        "result": "error",
        "target_type": "user",
        "target_id": "0" * 64,
        "input_hash": "sha256:" + "0" * 64,
        "output_hash": None,
        "error": "boom",
        "details_json": '{"a":2}',
        "cost_json": '{"wall_ms":1}',
        "evidence_class": "modeled",
        "policy_json": "[]",
        "redaction_json": '["email"]',
        "client_ts": row["ts"],
        "prev_hash": "1" * 64,
    }
    assert set(replacements) == set(HASH_FIELDS[HASH_VERSION])
    for field, value in replacements.items():
        if field == "hash_version":
            continue
        changed = {**row, field: value}
        assert compute_event_hash(changed) != baseline, f"changing {field} must change the hash"


def test_timestamps_are_normalized_to_utc_microseconds():
    pacific = timezone(timedelta(hours=-7))
    moment = datetime(2026, 9, 22, 5, 0, 0, 1, tzinfo=pacific)
    assert format_ts(moment) == "2026-09-22T12:00:00.000001Z"
    with pytest.raises(ValueError):
        format_ts(datetime(2026, 9, 22))


def test_sanitize_makes_awkward_values_storable():
    value = sanitize(
        {
            "nan": float("nan"),
            "inf": float("-inf"),
            "bytes": b"abc",
            "set": {3, 1, 2},
            "nul": "a\x00b",
            "surrogate": "x\ud800y",
            "when": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "id": uuid.UUID(int=1),
            7: "int key",
        }
    )
    assert value["nan"] == "nan" and value["inf"] == "-inf"
    assert value["bytes"] == {"sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "bytes": 3}
    assert value["set"] == [1, 2, 3]
    assert value["nul"] == "a\\u0000b"
    assert value["surrogate"] == "x\\ud800y"
    assert value["when"] == "2026-01-01T00:00:00.000000Z"
    assert value["id"] == str(uuid.UUID(int=1))
    assert value["7"] == "int key"
    dumps_canonical(value)  # must not raise
    assert clean_text("plain") == "plain"


def test_canonical_json_sorts_keys_and_has_no_whitespace():
    assert dumps_canonical({"b": 1, "a": [1, {"d": 2, "c": 3}]}) == '{"a":[1,{"c":3,"d":2}],"b":1}'
