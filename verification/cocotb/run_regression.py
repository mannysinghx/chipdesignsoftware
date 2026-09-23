"""Seeded cocotb regression for the T0 RTL (Icarus Verilog).

Usage: python run_regression.py --rtl ../../rtl --out ./out [--seed 20260922] [--suite NAME ...]

Writes out/results.json, which contains only deterministic fields (test names,
outcomes, simulated time, seed, tool versions), so two runs with the same
inputs produce byte-identical results for the reproducibility check. Wall-clock
timings and full logs go to out/logs/ and out/results/*.xml.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass, field
from pathlib import Path

from cocotb_tools.runner import get_runner

HERE = Path(__file__).resolve().parent

CHANNEL_TESTS = [
    "row_miss_then_row_hit_latency",
    "banks_keep_independent_open_rows",
    "single_bit_faults_return_corrected_data",
    "ecc_status_is_valid_with_the_response",
    "random_traffic_matches_the_row_buffer_model",
]


@dataclass(frozen=True)
class Suite:
    name: str
    toplevel: str
    sources: tuple[str, ...]
    module: str
    parameters: dict = field(default_factory=dict)
    testcases: tuple[str, ...] = ()


SUITES = [
    Suite("secded", "tb_secded", ("rtl:aimem_secded_64.sv", "tb:tb_secded.sv"), "test_secded"),
    Suite("lane_repair", "aimem_lane_repair", ("rtl:aimem_lane_repair.sv",), "test_lane_repair"),
    Suite("sparse_gather", "aimem_sparse_gather", ("rtl:aimem_sparse_gather.sv",), "test_sparse_gather"),
    Suite("t0_channel", "aimem_t0_channel", ("rtl:aimem_secded_64.sv", "rtl:aimem_t0_channel.sv"), "test_t0_channel", testcases=tuple(CHANNEL_TESTS)),
    Suite(
        "t0_channel_refresh",
        "aimem_t0_channel",
        ("rtl:aimem_secded_64.sv", "rtl:aimem_t0_channel.sv"),
        "test_t0_channel",
        parameters={"REFRESH_LIMIT": 24},
        testcases=("refresh_takes_priority_and_closes_rows",),
    ),
    Suite(
        "t0_top",
        "aimem_t0_top",
        tuple(f"rtl:{name}" for name in ("aimem_secded_64.sv", "aimem_lane_repair.sv", "aimem_sparse_gather.sv", "aimem_t0_channel.sv", "aimem_t0_top.sv")),
        "test_t0_top",
    ),
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
    """cocotb 2.x leaves the JUnit failure message empty; recover the assertion text from the simulator log."""
    start = log_text.find(f"running {module}.{test}")
    end = log_text.find(f"{module}.{test} failed", start)
    block = log_text[start:end if end != -1 else None] if start != -1 else ""
    lines = [line.strip() for line in block.splitlines() if "Error" in line or line.strip().startswith("assert")]
    return "\n".join(lines[-6:])[:4000]


def parse_results(xml_path: Path, log_path: Path, module: str, selected: tuple[str, ...]) -> list[dict]:
    tests = []
    if not xml_path.exists():
        return [{"name": "<suite>", "status": "error", "message": "no results were produced"}]
    log_text = log_path.read_text(errors="replace") if log_path.exists() else ""
    for case in ElementTree.parse(xml_path).getroot().iter("testcase"):
        name = case.get("name")
        if selected and name not in selected:
            continue  # filtered out of this suite on purpose; it runs in another suite
        entry = {"name": name, "status": "passed", "sim_time_ns": round(float(case.get("sim_time_ns") or 0), 3)}
        failure = case.find("failure")
        error = case.find("error")
        skipped = case.find("skipped")
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
    parser.add_argument("--rtl", type=Path, default=HERE.parent.parent / "rtl")
    parser.add_argument("--out", type=Path, default=HERE / "out")
    parser.add_argument("--seed", type=int, default=20260922)
    parser.add_argument("--suite", action="append", default=[])
    args = parser.parse_args()

    out = args.out.resolve()
    for sub in ("build", "results", "logs"):
        shutil.rmtree(out / sub, ignore_errors=True)
        (out / sub).mkdir(parents=True, exist_ok=True)
    os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, [str(HERE), os.environ.get("PYTHONPATH", "")]))
    runner = get_runner("icarus")
    selected = [suite for suite in SUITES if not args.suite or suite.name in args.suite]

    report = {"seed": args.seed, "simulator": "icarus", "tools": tool_versions(), "suites": []}
    for suite in selected:
        sources = [(args.rtl if kind == "rtl" else HERE) / name for kind, name in (entry.split(":", 1) for entry in suite.sources)]
        build_dir = out / "build" / suite.name
        results_xml = out / "results" / f"{suite.name}.xml"
        runner.build(
            sources=sources,
            hdl_toplevel=suite.toplevel,
            parameters=suite.parameters,
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
                testcase=list(suite.testcases) or None,
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
        tests = parse_results(results_xml, out / "logs" / f"{suite.name}.log", suite.module, suite.testcases)
        if simulator_exit:
            tests.append({"name": "<simulator exit>", "status": "error", "message": f"simulator exited with code {simulator_exit}"})
        report["suites"].append(
            {"name": suite.name, "toplevel": suite.toplevel, "parameters": suite.parameters, "simulator_exit": simulator_exit, "tests": tests}
        )

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
