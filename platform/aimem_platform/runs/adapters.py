"""Tool adapters: typed parameters in, a pinned sandboxed command out, a verdict back.

Each adapter declares exactly which repository files it reads (they are
snapshotted into the artifact store at submission), the command it runs, which
outputs are kept as artifacts, which outputs are compared for reproducibility,
and how raw results become a verdict and metrics. Commands are built here from
validated parameters; nothing from an API request reaches a shell.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from .normalize import normalize
from .runners import Execution
from .spec import Limits, RunSpec
from .toolchains import Toolchains

DRIVERS = Path(__file__).resolve().parent / "drivers"
COMMON_ENV = {"HOME": "/tmp", "LC_ALL": "C.UTF-8", "TZ": "UTC", "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"}
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


@dataclass
class Outcome:
    verdict: str  # pass | fail | error
    headline: str
    metrics: dict = field(default_factory=dict)
    evidence_class: str = "executed"  # one of models.EVIDENCE_CLASSES; qualifiers go in `limitations`
    limitations: str | None = None


class NoParams(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SimParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: int = Field(default=20260922, ge=0, le=2**31 - 1)


class Adapter:
    id: str
    version: str
    title: str
    description: str
    evidence: str
    image: str = "orfs"
    bundles: tuple[str, ...] = ()
    params_model: type[BaseModel] = NoParams
    limits: Limits = Limits()
    keep: tuple[str, ...] = ()  # output globs stored as artifacts
    reproducible_paths: tuple[str, ...] = ()  # output globs compared across runs
    json_drops: dict[str, tuple[str, ...]] = {}  # reproducible JSON path -> exact keys (JSON pointers) it also ignores

    # -- inputs ---------------------------------------------------------------
    def inputs(self, params: BaseModel, repo: Path) -> dict[str, Path]:
        raise NotImplementedError

    @staticmethod
    def _glob(repo: Path, pattern: str, into: str) -> dict[str, Path]:
        found = {f"{into}/{path.name}": path for path in sorted(repo.glob(pattern)) if path.is_file()}
        if not found:
            raise FileNotFoundError(f"no inputs match {pattern}")
        return found

    # -- command --------------------------------------------------------------
    def command(self, params: BaseModel) -> list[str]:
        raise NotImplementedError

    def env(self, params: BaseModel, toolchains: Toolchains) -> dict[str, str]:
        path = SYSTEM_PATH
        for name in self.bundles:
            path = f"{toolchains.bundles[name].bin}:{path}"
        return {**COMMON_ENV, "PATH": path}

    def build_spec(self, params: BaseModel, input_hashes: dict[str, str], toolchains: Toolchains) -> RunSpec:
        image = toolchains.images[self.image]
        return RunSpec(
            adapter=self.id,
            adapter_version=self.version,
            image=image.pinned,
            platform=image.platform,
            command=tuple(self.command(params)),
            env=tuple(sorted(self.env(params, toolchains).items())),
            inputs=tuple(sorted(input_hashes.items())),
            mounts=tuple(toolchains.bundles[name].as_mount() for name in self.bundles),
            params=params.model_dump(),
            limits=self.limits,
        )

    # -- outputs --------------------------------------------------------------
    def kept_outputs(self, out: Path) -> list[Path]:
        seen: dict[Path, None] = {}
        for pattern in self.keep:
            for path in sorted(out.glob(pattern)):
                if path.is_file():
                    seen.setdefault(path, None)
        return list(seen)

    def reproducible(self, out: Path) -> dict[str, dict]:
        """path -> {"sha256": normalized hash, "scheme", "normalization": what was ignored, ...} (see normalize.py)"""
        result = {}
        for pattern in self.reproducible_paths:
            for path in sorted(out.glob(pattern)):
                if path.is_file():
                    relative = str(path.relative_to(out))
                    result[relative] = self.normalized(relative, path.read_bytes())
        return result

    def normalized(self, relative: str, data: bytes) -> dict:
        return normalize(relative, data, self.json_drops.get(relative, ()))

    def summarize(self, out: Path, execution: Execution) -> Outcome:
        raise NotImplementedError

    def describe(self) -> dict:
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "evidence": self.evidence,
            "image": self.image,
            "bundles": list(self.bundles),
            "params_schema": self.params_model.model_json_schema(),
            "limits": {"cpus": self.limits.cpus, "memory_mb": self.limits.memory_mb, "timeout_s": self.limits.timeout_s},
        }


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


class SelfTestAdapter(Adapter):
    id = "platform.selftest"
    version = "1"
    title = "Sandbox self-test"
    description = "Proves the sandbox blocks the network, keeps the root filesystem and inputs read-only, and runs as a non-root user."
    evidence = "Runner isolation"
    limits = Limits(cpus=1.0, memory_mb=512, pids=128, timeout_s=120)
    keep = ("selftest.json",)
    reproducible_paths = ("selftest.json",)
    json_drops = {"selftest.json": ("/checks/uid",)}  # uid depends on the machine; everything else must match

    def inputs(self, params, repo):
        return {"driver/selftest.py": DRIVERS / "selftest.py"}

    def command(self, params):
        return ["python3", "/work/in/driver/selftest.py", "/work/out", "/work/in"]

    def summarize(self, out, execution):
        report = _read_json(out / "selftest.json")
        if execution.exit_code != 0 or report is None:
            return Outcome("error", "self-test did not produce a report")
        checks = report["checks"]
        if execution.runner != "docker":
            return Outcome("pass", "ran without a sandbox (local runner); isolation not claimed", {"checks": checks}, "modeled")
        expected = {"network_ip": "blocked", "network_dns": "blocked", "root_filesystem": "read-only", "inputs": "read-only", "outputs": "writable"}
        broken = {key: checks.get(key) for key, value in expected.items() if checks.get(key) != value}
        if checks.get("uid") == 0:
            broken["uid"] = 0
        if broken:
            return Outcome("fail", f"sandbox isolation broken: {broken}", {"checks": checks})
        return Outcome("pass", "network blocked, root filesystem and inputs read-only, non-root user", {"checks": checks})


class LintAdapter(Adapter):
    id = "rtl.lint"
    version = "1"
    title = "RTL lint (Verilator)"
    description = "Verilator -Wall lint of the full T0 hierarchy and of each block on its own."
    evidence = "DV-CLOSURE lint"
    bundles = ("oss-cad-suite",)
    limits = Limits(cpus=2.0, memory_mb=2048, pids=512, timeout_s=600)
    keep = ("lint.json", "lint.log")
    reproducible_paths = ("lint.json",)

    def inputs(self, params, repo):
        return {**self._glob(repo, "rtl/*.sv", "rtl"), "driver/lint.py": DRIVERS / "lint.py"}

    def command(self, params):
        return ["tabbypy3", "/work/in/driver/lint.py", "--rtl", "/work/in/rtl", "--out", "/work/out"]

    def summarize(self, out, execution):
        report = _read_json(out / "lint.json")
        if report is None:
            return Outcome("error", "lint produced no report")
        summary = report["summary"]
        metrics = {"errors": summary["errors"], "warnings": summary["warnings"], "by_code": summary["by_code"], "targets": len(report["targets"])}
        if summary["errors"]:
            return Outcome("fail", f"{summary['errors']} lint errors, {summary['warnings']} warnings", metrics)
        return Outcome("pass", f"no lint errors; {summary['warnings']} warnings to review", metrics)


class SimAdapter(Adapter):
    id = "rtl.sim"
    version = "1"
    title = "RTL simulation regression (cocotb + Icarus)"
    description = "Seeded cocotb regression of every T0 block against independent Python reference models."
    evidence = "DV-REGRESSION"
    bundles = ("oss-cad-suite",)
    params_model = SimParams
    limits = Limits(cpus=2.0, memory_mb=4096, pids=1024, timeout_s=1800)
    keep = ("results.json", "results/*.xml", "logs/*.log")
    reproducible_paths = ("results.json",)

    def inputs(self, params, repo):
        tb = {f"tb/{path.name}": path for path in sorted((repo / "verification/cocotb").glob("*")) if path.suffix in (".py", ".sv") and path.is_file()}
        return {**self._glob(repo, "rtl/*.sv", "rtl"), **tb}

    def command(self, params):
        return ["tabbypy3", "/work/in/tb/run_regression.py", "--rtl", "/work/in/rtl", "--out", "/work/out", "--seed", str(params.seed)]

    def summarize(self, out, execution):
        report = _read_json(out / "results.json")
        if report is None:
            return Outcome("error", "the regression produced no results")
        summary = report["summary"]
        failing = [f"{suite['name']}::{test['name']}" for suite in report["suites"] for test in suite["tests"] if test["status"] in ("failed", "error")]
        metrics = {**summary, "seed": report["seed"], "failing": failing, "suites": len(report["suites"])}
        if summary.get("error"):
            return Outcome("error", f"{summary['error']} simulator errors", metrics)
        if summary["failed"]:
            return Outcome("fail", f"{summary['passed']}/{summary['total']} tests pass; failing: {', '.join(failing)}", metrics)
        return Outcome("pass", f"all {summary['total']} tests pass (seed {report['seed']})", metrics)


class FormalAdapter(Adapter):
    id = "formal.sby"
    version = "1"
    title = "Formal verification (SymbiYosys)"
    description = "SECDED proofs for any data word, channel k-induction safety proof, cover checks, and the response protocol contract."
    evidence = "DV-CLOSURE formal"
    bundles = ("oss-cad-suite",)
    limits = Limits(cpus=4.0, memory_mb=6144, pids=1024, timeout_s=3600)
    keep = ("formal/results.json", "formal/*.sby.log", "formal/*/logfile.txt", "formal/*/status", "formal/*/engine_*/trace*.vcd")
    reproducible_paths = ("formal/results.json",)

    def inputs(self, params, repo):
        formal = {}
        for pattern in ("formal/*.sby", "formal/*_sby.sv", "formal/run_formal.py"):
            formal.update(self._glob(repo, pattern, "formal"))
        return {**self._glob(repo, "rtl/*.sv", "rtl"), **formal}

    def command(self, params):
        return ["tabbypy3", "/work/in/formal/run_formal.py", "--out", "/work/out/formal"]

    def summarize(self, out, execution):
        report = _read_json(out / "formal" / "results.json")
        if report is None:
            return Outcome("error", "formal produced no results")
        tasks = report["tasks"]
        failing = [f"{task['job']}:{task['task'] or 'default'}" for task in tasks if task["status"] != "PASS"]
        metrics = {"tasks": {f"{task['job']}:{task['task'] or 'default'}": task["status"] for task in tasks}, "failing": failing, "summary": report["summary"]}
        if any(task["status"] == "ERROR" for task in tasks):
            return Outcome("error", f"formal tool errors in {failing}", metrics)
        if failing:
            return Outcome("fail", f"{len(tasks) - len(failing)}/{len(tasks)} formal tasks pass; failing: {', '.join(failing)}", metrics)
        return Outcome("pass", f"all {len(tasks)} formal tasks pass", metrics)


class PhysicalAdapter(Adapter):
    id = "physical.orfs"
    version = "1"
    title = "Physical implementation (OpenROAD, sky130hd)"
    description = "aimem_t0_channel through synthesis, floorplan, placement, CTS, routing, GDS, KLayout DRC and LVS, with OpenSTA timing at the 800 MHz contract clock."
    evidence = "Physical proxy (public PDK)"
    limits = Limits(cpus=4.0, memory_mb=6144, pids=2048, timeout_s=5400)
    keep = (
        "physical.json",
        "orfs/results/*/*/*/6_final.*",
        "orfs/results/*/*/*/6_lvs.lvsdb",
        "orfs/reports/*/*/*/*",
        "orfs/logs/*/*/*/*.log",
        "orfs/logs/*/*/*/*.json",
    )
    reproducible_paths = ("orfs/results/*/*/*/6_final.gds", "orfs/results/*/*/*/6_final.def", "orfs/results/*/*/*/6_final.v", "physical.json")

    def inputs(self, params, repo):
        return {
            "rtl/aimem_secded_64.sv": repo / "rtl/aimem_secded_64.sv",
            "rtl/aimem_t0_channel.sv": repo / "rtl/aimem_t0_channel.sv",
            "orfs/config.mk": repo / "design/physical/orfs/aimem_t0_channel/config.mk",
            "orfs/constraint.sdc": repo / "design/physical/orfs/aimem_t0_channel/constraint.sdc",
            "driver/orfs_flow.sh": DRIVERS / "orfs_flow.sh",
            "driver/orfs_summary.py": DRIVERS / "orfs_summary.py",
        }

    def command(self, params):
        return ["bash", "/work/in/driver/orfs_flow.sh"]

    def env(self, params, toolchains):
        return {**super().env(params, toolchains), "NUM_CORES": "4"}

    def summarize(self, out, execution):
        report = _read_json(out / "physical.json")
        limitations = "public PDK (sky130hd) proxy of the advanced-node design; not signoff and not the production node"
        if report is None:
            return Outcome("error", "the physical flow produced no summary", limitations=limitations)
        metrics = report.get("metrics", {})
        if report.get("flow_exit") != 0:
            return Outcome("fail", f"the flow stopped at {report.get('last_stage')}", metrics, limitations=limitations)
        drc = metrics.get("drc_violations")
        lvs = metrics.get("lvs")
        timing = metrics.get("setup_wns_ns")
        headline = f"GDS written; DRC {drc} violations; LVS {lvs}; setup WNS {timing} ns at {metrics.get('clock_period_ns')} ns (fmax {metrics.get('fmax_mhz')} MHz)"
        if drc != 0 or lvs != "match":
            return Outcome("fail", headline, metrics, limitations=limitations)
        return Outcome("pass", headline, metrics, limitations=limitations)


ADAPTERS: dict[str, Adapter] = {
    adapter.id: adapter for adapter in (SelfTestAdapter(), LintAdapter(), SimAdapter(), FormalAdapter(), PhysicalAdapter())
}


def get_adapter(adapter_id: str) -> Adapter:
    try:
        return ADAPTERS[adapter_id]
    except KeyError:
        raise LookupError(f"unknown adapter {adapter_id!r}") from None
