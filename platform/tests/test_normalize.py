"""json-v2 normalization: exact token rules, declared drops, named schemes, like-with-like comparison."""

from __future__ import annotations

import json
from fnmatch import fnmatch
from types import SimpleNamespace

import pytest

from aimem_platform.artifacts import ArtifactStore
from aimem_platform.runs.adapters import ADAPTERS, SelfTestAdapter
from aimem_platform.runs.normalize import json_sha256, key_tokens, normalize, volatile_key
from aimem_platform.runs.reconstruct import compare_manifests
from aimem_platform.runs.reproduce import renormalize_recorded

# Design keys that json-v1's substring markers dropped (date, mem, host, wall, runtime,
# peak), plus keys from this repository's own models and specs, and ORFS constants.
KEPT = [
    "candidates", "update_count", "validated", "aimem_bank", "member", "memory_bank", "ai_memory_engines",
    "ghost_cells", "firewall", "host", "hostTrafficReductionPercent", "memorySystemPowerWatts",
    "peak_bandwidth_gbps", "recommended_open_source_runtime", "sim_time_ns", "elapsed_cycles",
    "run__flow__platform__time_units", "finish__timing__setup__ws", "timing_repair_buffers",
]
DROPPED = [
    "flow__runtime__total", "detailedroute__mem__peak", "synth__cpu__total", "timestamp", "buildTimestamp",
    "time_stamp", "run__flow__generate_date", "hostname", "worker_host_name",
]


def as_bytes(document) -> bytes:
    return json.dumps(document).encode()


@pytest.mark.parametrize("key", KEPT)
def test_design_keys_are_kept(key):
    assert not volatile_key(key)
    assert json_sha256(as_bytes({key: 1}))[0] != json_sha256(as_bytes({key: 2}))[0]


@pytest.mark.parametrize("key", DROPPED)
def test_volatile_keys_are_dropped(key):
    assert volatile_key(key)
    assert json_sha256(as_bytes({key: 1, "cells": 4883})) == json_sha256(as_bytes({key: 2, "cells": 4883}))


def test_keys_split_into_tokens_at_separators_and_camel_case():
    assert key_tokens("detailedroute__mem__peak") == ("detailedroute", "mem", "peak")
    assert key_tokens("hostTrafficReductionPercent") == ("host", "traffic", "reduction", "percent")
    assert key_tokens("HTTPServer.max-conn:2") == ("http", "server", "max", "conn", "2")
    assert key_tokens("aimem_bank") == ("aimem", "bank")


def test_orfs_metrics_differ_only_in_design_values():
    base = {
        "run__flow__generate_date": "2026-09-22 18:04", "run__flow__platform__time_units": "1ns",
        "floorplan__runtime__total": "0:01.23", "floorplan__cpu__total": 1.1, "floorplan__mem__peak": 181234,
        "finish__timing__setup__ws": -4.64876, "finish__design__instance__count__stdcell": 4883,
    }
    rerun = {**base, "run__flow__generate_date": "2026-09-23 09:00", "floorplan__runtime__total": "0:02.01", "floorplan__cpu__total": 1.9, "floorplan__mem__peak": 190000}
    changed = {**base, "finish__design__instance__count__stdcell": 4884}
    assert json_sha256(as_bytes(base)) == json_sha256(as_bytes(rerun))
    assert json_sha256(as_bytes(base))[0] != json_sha256(as_bytes(changed))[0]
    assert json_sha256(as_bytes(base))[1] == ["/floorplan__cpu__total", "/floorplan__mem__peak", "/floorplan__runtime__total", "/run__flow__generate_date"]


def test_an_entry_names_its_scheme_and_every_key_it_dropped():
    document = {"stages": [{"name": "route", "route__runtime__total": "0:12"}], "checks": {"uid": 501, "timestamp": 1}, "a/b": {"date": 1}}
    entry = normalize("x.json", as_bytes(document), ("/checks/uid",))
    assert entry["scheme"] == "json-v2" and entry["declared"] == ["/checks/uid"]
    assert entry["dropped"] == ["/a~1b/date", "/checks/timestamp", "/checks/uid", "/stages/0/route__runtime__total"]
    assert entry["normalization"] == "json-v2: canonical JSON without " + ", ".join(entry["dropped"])
    assert normalize("y.json", as_bytes({"cells": 1}))["normalization"] == "json-v2: canonical JSON with nothing dropped"
    assert normalize("6_final.def", b"DESIGN x ;")["scheme"] == "raw-v1"


def test_declared_drops_are_exact_paths():
    first = normalize("s.json", as_bytes({"checks": {"uid": 1}, "other": {"uid": 1}}), ("/checks/uid",))
    second = normalize("s.json", as_bytes({"checks": {"uid": 2}, "other": {"uid": 2}}), ("/checks/uid",))
    assert first["dropped"] == ["/checks/uid"] and first["sha256"] != second["sha256"]
    with pytest.raises(ValueError):
        normalize("s.json", b"{}", ("uid",))
    with pytest.raises(ValueError):
        normalize("6_final.def", b"", ("/uid",))


def test_json_v2_serializes_exactly_like_json_v1():
    # Hashes pinned from the json-v1 implementation (commit 4ccff97). Every recorded hash stays
    # comparable only while a document both schemes drop the same keys from hashes the same.
    selftest = {
        "checks": {"inputs": "read-only", "network_dns": "blocked", "network_ip": "blocked", "outputs": "writable", "root_filesystem": "read-only", "uid": 1000},
        "input_hashes": {"driver/selftest.py": "ab" * 32}, "machine": "x86_64", "python": "3.12.3",
    }
    physical = {
        "design": "aimem_t0_channel", "platform": "sky130hd", "flow_exit": 0, "last_stage": "LVS",
        "metrics": {"clock_period_ns": 1.25, "fmax_mhz": 169.527, "setup_wns_ns": -4.6488, "timing_repair_buffers": 12, "power_w": 0.174144, "lvs": "match", "gds": True, "drc_violations": 0},
        "note": "Public sky130hd proxy — not signoff.",
    }
    assert SelfTestAdapter().normalized("selftest.json", as_bytes(selftest))["sha256"] == "29774d61b5e48828c691b1d6b637e4cd4e2f4783cb2fd3bda604882924d84f09"
    assert ADAPTERS["physical.orfs"].normalized("physical.json", as_bytes(physical))["sha256"] == "78d345aba1be2dd311a03a8ee753db8ebc7bfeffacbd057b71aea1bae9d31ebe"


def test_adapter_drops_name_reproducible_json_outputs():
    for adapter in ADAPTERS.values():
        for path, pointers in adapter.json_drops.items():
            assert path.endswith(".json") and any(fnmatch(path, pattern) for pattern in adapter.reproducible_paths), (adapter.id, path)
            assert pointers and all(pointer.startswith("/") for pointer in pointers), (adapter.id, path)


LINT_V1 = {"sha256": "a" * 64, "normalization": "canonical JSON without timing, memory, host, or date keys"}


def test_hashes_from_different_schemes_are_never_compared():
    current = normalize("lint.json", as_bytes({"summary": {"errors": 0}}))
    same_hash_other_scheme = {**LINT_V1, "sha256": current["sha256"]}
    result = compare_manifests({"lint.json": same_hash_other_scheme}, {"lint.json": current})
    assert result["identical"] is False and result["matched"] == 0 and result["mismatches"] == []
    assert result["incomparable"] == [{"path": "lint.json", "first": "json-v1", "second": "json-v2"}]
    assert result["normalization"]["lint.json"] == sorted([LINT_V1["normalization"], current["normalization"]])

    declared = normalize("s.json", as_bytes({"checks": {"uid": 1}}), ("/checks/uid",))
    undeclared = normalize("s.json", as_bytes({"checks": {}}))
    assert compare_manifests({"s.json": declared}, {"s.json": undeclared})["incomparable"] == [
        {"path": "s.json", "first": "json-v2 declared /checks/uid", "second": "json-v2"}
    ]
    unknown = {"f.json": {"sha256": "b" * 64, "normalization": "hand-written"}}
    assert compare_manifests(unknown, unknown)["identical"] is False


def test_gds_and_raw_hashes_stay_comparable_with_records_from_before_schemes():
    gds, raw = normalize("6_final.gds", b"\x00\x06\x00\x02\x02\x58"), normalize("6_final.def", b"DESIGN x ;")
    legacy = {
        "6_final.gds": {"sha256": gds["sha256"], "normalization": "GDSII BGNLIB/BGNSTR dates zeroed"},
        "6_final.def": {"sha256": raw["sha256"], "normalization": "none"},
    }
    result = compare_manifests(legacy, {"6_final.gds": gds, "6_final.def": raw})
    assert result["identical"] and result["matched"] == 2 and result["incomparable"] == []


def test_a_comparison_states_what_was_ignored():
    first = normalize("s.json", as_bytes({"checks": {"uid": 1}, "timestamp": 5}), ("/checks/uid",))
    second = normalize("s.json", as_bytes({"checks": {"uid": 2}}), ("/checks/uid",))
    result = compare_manifests({"s.json": first}, {"s.json": second})
    assert result["identical"] and result["normalization"]["s.json"] == [
        "json-v2: canonical JSON without /checks/uid",
        "json-v2: canonical JSON without /checks/uid, /timestamp",
    ]


def test_a_recorded_file_whose_bytes_are_gone_stays_incomparable(tmp_path):
    services = SimpleNamespace(artifacts=ArtifactStore(tmp_path))
    data = as_bytes({"checks": {"uid": 7, "network_ip": "blocked"}})
    stored = services.artifacts.put(data).sha256
    current = {"selftest.json": SelfTestAdapter().normalized("selftest.json", data)}
    legacy = {"sha256": "0" * 64, "normalization": "uid removed"}

    recorded, notes = renormalize_recorded(services, SelfTestAdapter(), {"outputs": [{"path": "selftest.json", "sha256": stored}], "reproducible": {"selftest.json": legacy}}, current)
    assert recorded["selftest.json"] == current["selftest.json"] and notes[0]["rehashed"] and compare_manifests(recorded, current)["identical"]

    gone = "f" * 64
    recorded, notes = renormalize_recorded(services, SelfTestAdapter(), {"outputs": [{"path": "selftest.json", "sha256": gone}], "reproducible": {"selftest.json": legacy}}, current)
    assert recorded["selftest.json"] == legacy and notes == [{"path": "selftest.json", "recorded": "uid removed", "raw_sha256": gone, "error": "the raw output is not in the artifact store"}]
    assert compare_manifests(recorded, current)["incomparable"]
