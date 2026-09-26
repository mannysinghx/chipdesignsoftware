"""Run the SymbiYosys jobs for the A1 tensor tile RTL and write a deterministic summary.

Same runner as formal/run_formal.py (T0), with the A1 job list. Kept as a copy because each formal
adapter's sandbox mounts only its own directory.

Usage: python run_formal.py --out ./out [--job secded.sby ...]

Each job's work directories go under --out; out/results.json records only
deterministic facts (task, mode, status, failed assertion locations, trace
file names), so two runs with the same inputs produce identical results.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent

JOBS = [
    {"file": "a1_dot4.sby", "title": "Dot product: operand and scale swap, FTZ, canonical NaN, NaN data and scale propagation (all inputs)"},
    {"file": "a1_dot_sum.sby", "title": "Dot product sum stage: term order does not change the result (any term bundle)"},
    {"file": "a1_dma.sby", "title": "Tile DMA: credit and buffers never overflow, word conservation, MMA held until taken, completion (k-induction proof, cover)"},
    {"file": "a1_tile.sby", "title": "Tile control: one response per READ, held until taken, addressed writes and reads (k-induction proof, cover)"},
]
ASSERT_FAILED = re.compile(r"Assert(?:ion)? failed in ([^:]+): (\S+)")
MODE_LINE = re.compile(r"^\s*(?:(\w+):\s*)?mode\s+(\w+)", re.MULTILINE)


def task_modes(sby_file: Path) -> dict[str, str]:
    modes = {}
    for task, mode in MODE_LINE.findall(sby_file.read_text()):
        modes[task or ""] = mode
    return modes


def collect(workdir: Path, job: str, task: str, mode: str) -> dict:
    status_file = workdir / "status"
    status = status_file.read_text().split()[0] if status_file.exists() else "ERROR"
    log_text = (workdir / "logfile.txt").read_text(errors="replace") if (workdir / "logfile.txt").exists() else ""
    failed = sorted({f"{match[1]}" for match in ASSERT_FAILED.findall(log_text)})
    traces = sorted(str(path.relative_to(workdir)) for path in workdir.glob("engine_*/trace*.vcd"))
    return {"job": job, "task": task or None, "mode": mode, "status": status, "failed_assertions": failed, "traces": traces}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=HERE / "out")
    parser.add_argument("--job", action="append", default=[])
    args = parser.parse_args()
    out = args.out.resolve()
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)

    results = []
    for job in JOBS:
        if args.job and job["file"] not in args.job:
            continue
        sby_file = HERE / job["file"]
        stem = sby_file.stem
        modes = task_modes(sby_file)
        # sby resolves [files] against the working directory, so run from this directory; outputs go to --prefix.
        completed = subprocess.run(["sby", "-f", "--prefix", str(out / stem), str(sby_file)], capture_output=True, text=True, cwd=HERE)
        (out / f"{stem}.sby.log").write_text(completed.stdout + completed.stderr)
        tasks = [task for task in modes if task] or [""]
        for task in tasks:
            workdir = out / (f"{stem}_{task}" if task else stem)
            entry = collect(workdir, job["file"], task, modes.get(task) or modes.get("", "bmc"))
            entry["title"] = job["title"]
            results.append(entry)

    summary: dict[str, int] = {}
    for entry in results:
        summary[entry["status"]] = summary.get(entry["status"], 0) + 1
    report = {"engine": "smtbmc bitwuzla", "tasks": results, "summary": summary}
    (out / "results.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(summary))
    return 0 if set(summary) <= {"PASS"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
