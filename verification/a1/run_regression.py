"""Seeded regression for the A1 tensor tile RTL (cocotb + Icarus), plus the golden model's accuracy check.

Usage: python run_regression.py --rtl ../../rtl/a1 --out ./out [--seed 20260926] [--suite NAME ...]

Writes out/results.json with only deterministic fields (test names, outcomes, simulated time, seed,
tool versions, golden accuracy figures), in the same shape as verification/cocotb/run_regression.py,
so the platform summarizes both the same way. Logs go to out/logs/ and JUnit files to out/results/.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from pathlib import Path

from cocotb_tools.runner import get_runner

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import golden_accuracy  # noqa: E402


@dataclass(frozen=True)
class Suite:
    name: str
    toplevel: str
    sources: tuple[str, ...]
    module: str


SUITES = [
    Suite("fp_dot4", "a1_fp_dot4", ("a1_fp_dot4.sv",), "test_a1_fp_dot4"),
    Suite("mma_tile", "a1_mma_tile", ("a1_fp_dot4.sv", "a1_mma_tile.sv"), "test_a1_mma_tile"),
]


def tool_versions() -> dict:
    versions = {"python": sys.version.split()[0]}
    try:
        import cocotb

        versions["cocotb"] = cocotb.__version__
    except Exception:  # pragma: no cover - reported, not fatal
        versions["cocotb"] = "unknown"
    try:
        versions["iverilog"] = subprocess.run(["iverilog", "-V"], capture_output=True, text=True).stdout.splitlines()[0]
    except Exception:
        versions["iverilog"] = "unknown"
    return versions


def failure_from_log(log_text: str, module: str, test: str) -> str:
    start = log_text.find(f"running {module}.{test}")
    end = log_text.find(f"{module}.{test} failed", start)
    block = log_text[start:end if end != -1 else None] if start != -1 else ""
    lines = [line.strip() for line in block.splitlines() if "Error" in line or line.strip().startswith("assert")]
    return "\n".join(lines[-6:])[:4000]


def parse_results(xml_path: Path, log_path: Path, module: str) -> list[dict]:
    if not xml_path.exists():
        return [{"name": "<suite>", "status": "error", "message": "no results were produced"}]
    log_text = log_path.read_text(errors="replace") if log_path.exists() else ""
    tests = []
    for case in ElementTree.parse(xml_path).getroot().iter("testcase"):
        name = case.get("name")
        entry = {"name": name, "status": "passed", "sim_time_ns": round(float(case.get("sim_time_ns") or 0), 3)}
        failure, error, skipped = case.find("failure"), case.find("error"), case.find("skipped")
        if failure is not None or error is not None:
            node = failure if failure is not None else error
            entry["status"] = "failed"
            message = ((node.get("message") or "") + "\n" + (node.text or "")).strip()
            entry["message"] = (message or failure_from_log(log_text, module, name))[:4000]
        elif skipped is not None:
            entry["status"] = "skipped"
        tests.append(entry)
    return tests


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rtl", type=Path, default=HERE.parent.parent / "rtl" / "a1")
    parser.add_argument("--out", type=Path, default=HERE / "out")
    parser.add_argument("--seed", type=int, default=20260926)
    parser.add_argument("--suite", action="append", default=[])
    args = parser.parse_args()

    out = args.out.resolve()
    for sub in ("build", "results", "logs"):
        shutil.rmtree(out / sub, ignore_errors=True)
        (out / sub).mkdir(parents=True, exist_ok=True)
    os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, [str(HERE), os.environ.get("PYTHONPATH", "")]))
    runner = get_runner("icarus")
    report = {"seed": args.seed, "simulator": "icarus", "tools": tool_versions(), "suites": []}

    if not args.suite or "golden_accuracy" in args.suite:
        accuracy = golden_accuracy.run(args.seed, 4000)
        report["golden_accuracy"] = accuracy
        status = "passed" if accuracy["violation_count"] == 0 else "failed"
        test = {"name": "error_bound_holds_against_exact_arithmetic", "status": status, "sim_time_ns": 0.0}
        if status == "failed":
            test["message"] = json.dumps(accuracy["violations"])[:4000]
        report["suites"].append({"name": "golden_accuracy", "toplevel": None, "parameters": {}, "simulator_exit": 0, "tests": [test]})

    for suite in SUITES:
        if args.suite and suite.name not in args.suite:
            continue
        build_dir = out / "build" / suite.name
        results_xml = out / "results" / f"{suite.name}.xml"
        runner.build(
            sources=[args.rtl / name for name in suite.sources],
            hdl_toplevel=suite.toplevel,
            build_args=["-g2012"],
            build_dir=build_dir,
            always=True,
            timescale=("1ns", "1ps"),
            log_file=out / "logs" / f"{suite.name}.build.log",
        )
        simulator_exit = 0
        try:
            runner.test(
                test_module=suite.module,
                hdl_toplevel=suite.toplevel,
                seed=args.seed,
                build_dir=build_dir,
                test_dir=HERE,
                results_xml=str(results_xml),
                extra_env={"PYTHONPATH": os.environ["PYTHONPATH"]},
                timescale=("1ns", "1ps"),
                log_file=out / "logs" / f"{suite.name}.log",
            )
        except SystemExit as exc:  # the runner exits with the simulator's code; keep going and report it
            simulator_exit = exc.code if isinstance(exc.code, int) else 1
        tests = parse_results(results_xml, out / "logs" / f"{suite.name}.log", suite.module)
        if simulator_exit:
            tests.append({"name": "<simulator exit>", "status": "error", "message": f"simulator exited with code {simulator_exit}"})
        report["suites"].append({"name": suite.name, "toplevel": suite.toplevel, "parameters": {}, "simulator_exit": simulator_exit, "tests": tests})

    counts = {"passed": 0, "failed": 0, "skipped": 0, "error": 0}
    for suite in report["suites"]:
        for test in suite["tests"]:
            counts[test["status"]] = counts.get(test["status"], 0) + 1
    report["summary"] = {**counts, "total": sum(counts.values())}
    (out / "results.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report["summary"]))
    return 0 if counts["failed"] == 0 and counts["error"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
