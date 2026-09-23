"""Summarize an OpenROAD-flow-scripts run into <out>/physical.json.

Deterministic fields only: metrics come from the flow's METRICS2.1 report,
the KLayout DRC violation count, and the KLayout LVS verdict.
"""

import argparse
import json
import re
from pathlib import Path

STAGES = [
    ("1_synth.log", "synthesis"),
    ("2_1_floorplan.log", "floorplan"),
    ("3_3_place_gp.log", "global placement"),
    ("3_5_place_dp.log", "detailed placement"),
    ("4_1_cts.log", "clock tree synthesis"),
    ("5_1_grt.log", "global routing"),
    ("5_2_route.log", "detailed routing"),
    ("6_report.log", "final report"),
    ("6_drc.log", "DRC"),
    ("6_lvs.log", "LVS"),
]


def lvs_verdict(log: Path) -> str | None:
    if not log.exists():
        return None
    text = log.read_text(errors="replace")
    # Only KLayout's explicit verdict lines count; "mismatch" appears in ordinary LVS messages.
    if re.search(r"netlists don'?t match|netlists do not match", text, re.IGNORECASE):
        return "mismatch"
    if re.search(r"congratulations! netlists match|^.*\bnetlists match\.?\s*$", text, re.IGNORECASE | re.MULTILINE):
        return "match"
    return "unknown"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--design", required=True)
    parser.add_argument("--platform", default="sky130hd")
    parser.add_argument("--variant", default="base")
    parser.add_argument("--flow-exit", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    suffix = Path(args.platform) / args.design / args.variant
    logs = args.work / "logs" / suffix
    reports = args.work / "reports" / suffix
    results = args.work / "results" / suffix

    last_stage = None
    for log_name, stage in STAGES:
        if (logs / log_name).exists():
            last_stage = stage

    finish = {}
    if (logs / "6_report.json").exists():
        finish = json.loads((logs / "6_report.json").read_text())

    def metric(key, scale=1.0, digits=4):
        value = finish.get(key)
        return None if value is None else round(float(value) * scale, digits)

    drc_count_file = reports / "6_drc_count.rpt"
    drc = int(drc_count_file.read_text().strip() or 0) if drc_count_file.exists() else None
    clock_file = results / "clock_period.txt"
    metrics = {
        "clock_period_ns": float(clock_file.read_text().strip()) if clock_file.exists() else None,
        "fmax_mhz": metric("finish__timing__fmax", 1e-6, 3),
        "setup_wns_ns": metric("finish__timing__setup__ws"),
        "setup_tns_ns": metric("finish__timing__setup__tns", digits=3),
        "hold_wns_ns": metric("finish__timing__hold__ws"),
        "hold_tns_ns": metric("finish__timing__hold__tns", digits=3),
        "die_area_um2": metric("finish__design__die__area", digits=1),
        "core_area_um2": metric("finish__design__core__area", digits=1),
        "stdcell_area_um2": metric("finish__design__instance__area__stdcell", digits=1),
        "stdcell_count": finish.get("finish__design__instance__count__stdcell"),
        "sequential_cells": finish.get("finish__design__instance__count__class:sequential_cell"),
        "timing_repair_buffers": finish.get("finish__design__instance__count__class:timing_repair_buffer"),
        "utilization": metric("finish__design__instance__utilization", digits=4),
        "power_w": metric("finish__power__total", digits=6),
        "drc_violations": drc,
        "lvs": lvs_verdict(logs / "6_lvs.log"),
        "gds": (results / "6_final.gds").exists(),
    }
    report = {
        "design": args.design,
        "platform": args.platform,
        "flow_exit": args.flow_exit,
        "last_stage": last_stage,
        "metrics": metrics,
        "note": "Public sky130hd proxy of the 800 MHz advanced-node contract; not signoff and not the production node.",
    }
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(metrics, sort_keys=True))


if __name__ == "__main__":
    main()
