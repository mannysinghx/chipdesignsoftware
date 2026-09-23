"""Verilator lint of the T0 RTL. Writes <out>/lint.json (deterministic) and <out>/lint.log."""

import argparse
import json
import re
import subprocess
from pathlib import Path

# (top module, files) pairs: the full hierarchy plus each block on its own.
TARGETS = [
    ("aimem_t0_top", ["aimem_secded_64.sv", "aimem_lane_repair.sv", "aimem_sparse_gather.sv", "aimem_t0_channel.sv", "aimem_t0_top.sv"]),
    ("aimem_t0_channel", ["aimem_secded_64.sv", "aimem_t0_channel.sv"]),
    ("aimem_sparse_gather", ["aimem_sparse_gather.sv"]),
    ("aimem_lane_repair", ["aimem_lane_repair.sv"]),
    ("aimem_secded_64_encoder", ["aimem_secded_64.sv"]),
    ("aimem_secded_64_decoder", ["aimem_secded_64.sv"]),
]
MESSAGE = re.compile(r"^%(Warning|Error)(?:-([A-Z0-9_]+))?: ([^:]+):(\d+):(\d+): (.*)$")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rtl", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    version = subprocess.run(["verilator", "--version"], capture_output=True, text=True).stdout.strip()

    findings: dict[tuple, dict] = {}
    targets = []
    log_lines = []
    for top, files in TARGETS:
        command = ["verilator", "--lint-only", "-Wall", "-Wno-fatal", "--top-module", top, *[str(args.rtl / name) for name in files]]
        completed = subprocess.run(command, capture_output=True, text=True)
        log_lines.append(f"$ {' '.join(command)}\n{completed.stdout}{completed.stderr}")
        counts = {"errors": 0, "warnings": 0}
        for line in (completed.stdout + completed.stderr).splitlines():
            match = MESSAGE.match(line.strip())
            if not match:
                continue
            severity, code, path, line_no, _column, text = match.groups()
            key = (severity, code or "", Path(path).name, int(line_no), text.strip())
            counts["errors" if severity == "Error" else "warnings"] += 1
            entry = findings.setdefault(
                key,
                {"severity": severity.lower(), "code": code or "", "file": key[2], "line": key[3], "message": key[4], "targets": []},
            )
            if top not in entry["targets"]:
                entry["targets"].append(top)
        targets.append({"top": top, "files": files, "exit_code": completed.returncode, **counts})

    ordered = sorted(findings.values(), key=lambda item: (item["file"], item["line"], item["code"], item["message"]))
    by_code: dict[str, int] = {}
    for item in ordered:
        by_code[item["code"] or item["severity"]] = by_code.get(item["code"] or item["severity"], 0) + 1
    report = {
        "tool": version,
        "targets": targets,
        "findings": ordered,
        "summary": {
            "errors": sum(1 for item in ordered if item["severity"] == "error"),
            "warnings": sum(1 for item in ordered if item["severity"] == "warning"),
            "by_code": dict(sorted(by_code.items())),
        },
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "lint.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (args.out / "lint.log").write_text("\n".join(log_lines))
    print(json.dumps(report["summary"]))
    return 1 if report["summary"]["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
