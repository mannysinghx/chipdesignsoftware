#!/usr/bin/env python3
"""Run deterministic AIMEM-X1 T0 traffic through official Ramulator2 HBM3."""

from __future__ import annotations

import json
import os
from pathlib import Path

import ramulator


ROOT = Path(__file__).resolve().parents[2]
TRACE_DIR = ROOT / ".cache" / "aimem-traces"
OUTPUT = ROOT / "evidence" / "ramulator2-raw.json"
REQUESTS = int(os.environ.get("AIMEM_RAMULATOR_REQUESTS", "4096"))

PROFILES = (
    {"id": "dense-stream", "seed": 0x1A2B3C4D, "sequential_percent": 96, "locality_percent": 18, "write_percent": 20},
    {"id": "bank-random", "seed": 0x1A2B401E, "sequential_percent": 3, "locality_percent": 4, "write_percent": 35},
    {"id": "kv-decode", "seed": 0x1A2B43EF, "sequential_percent": 14, "locality_percent": 74, "write_percent": 3},
    {"id": "sparse-gather", "seed": 0x1A2B47C0, "sequential_percent": 7, "locality_percent": 42, "write_percent": 5},
)


def address(bank_linear: int, row: int, column: int) -> int:
    """Return an HBM3 byte address encoded for ChRaBaRoCo mapping."""
    pseudochannel = bank_linear // 16
    bankgroup = (bank_linear // 4) % 4
    bank = bank_linear % 4
    line_address = column | (row << 5) | (bank << 19) | (bankgroup << 21) | (pseudochannel << 23)
    return line_address << 5


def write_trace(profile: dict[str, int | str]) -> Path:
    TRACE_DIR.mkdir(parents=True, exist_ok=True)
    path = TRACE_DIR / f"{profile['id']}.trace"
    state = int(profile["seed"])
    open_rows = [-1] * 32

    def random_value() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 0x100000000

    lines = []
    for request in range(REQUESTS):
        sequential = random_value() * 100 < int(profile["sequential_percent"])
        bank = request % 32 if sequential else int(random_value() * 32)
        reuse = open_rows[bank] >= 0 and random_value() * 100 < int(profile["locality_percent"])
        row = open_rows[bank] if reuse else request // 32 if sequential else int(random_value() * 4096)
        open_rows[bank] = row
        op = "ST" if random_value() * 100 < int(profile["write_percent"]) else "LD"
        addr = address(bank, row, request % 32)
        lines.append(f"{op} 0x{addr:x}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def controller() -> ramulator.controller.HBM34:
    dram = ramulator.dram.HBM3(
        org_preset="HBM3_4Gb",
        timing_preset="HBM3_6400Mbps",
    )
    return ramulator.controller.HBM34(
        dram=dram,
        scheduler=ramulator.scheduler.FRFCFS(),
        refresh_manager=ramulator.refresh_manager.HBM34PerBankRefresh(),
        row_policy=ramulator.row_policy.Open(),
        addr_mapper=ramulator.addr_mapper.ChRaBaRoCo(),
    )


def run_profile(profile: dict[str, int | str]) -> dict[str, int | float | str]:
    trace_path = write_trace(profile)
    frontend = ramulator.frontend.LoadStoreTrace(clock_ratio=1, path=str(trace_path))
    memory = ramulator.memory_system.GenericDRAM(
        clock_ratio=1,
        controllers=[controller()],
        channel_mapper=ramulator.channel_mapper.CacheLineInterleave(),
    )
    simulation = ramulator.Simulation(frontend, memory)
    simulation.run()
    stats = simulation.stats["memory_system"]["controller"]
    reads = int(stats["num_read_reqs"])
    writes = int(stats["num_write_reqs"])
    completed = max(1, reads + writes)
    classified = int(stats["row_hits"]) + int(stats["row_misses"]) + int(stats["row_conflicts"])
    return {
        "id": profile["id"],
        "requests": REQUESTS,
        "controller_ticks": int(stats["cycles"]),
        "average_read_latency_ticks": float(stats["avg_read_latency"]),
        "read_requests": reads,
        "write_requests": writes,
        "row_hits": int(stats["row_hits"]),
        "row_misses": int(stats["row_misses"]),
        "row_conflicts": int(stats["row_conflicts"]),
        "row_hit_percent": 100.0 * int(stats["row_hits"]) / max(1, classified),
        "throughput_requests_per_tick": completed / max(1, int(stats["cycles"])),
    }


def main() -> None:
    results = [run_profile(profile) for profile in PROFILES]
    payload = {
        "schema_version": "1.0",
        "simulator": "Ramulator2 2.1",
        "ramulator_commit": "0c4eaeb00d88e668d8b5a0cbdd7d6276be921a41",
        "compatibility_overlay": "fmt 11.2.0 + dependent-template disambiguation for Apple Clang 21",
        "dram_proxy": "HBM3_4Gb @ 6400 Mb/s, one representative 32-bit channel",
        "scope": "Cycle-accurate public-memory proxy; not AIMEM silicon signoff",
        "requests_per_workload": REQUESTS,
        "results": results,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Ramulator2 evidence written to {OUTPUT}")


if __name__ == "__main__":
    main()
