"""Policy decisions for agent missions. Every decision is logged with its rule.

People approve at these points; nothing else waits for a person:
  mission.launch               every mission, before any model or tool call (route, model, budget)
  plan.patch                   a plan that would change design files (no Phase 2 tool does yet)
  review.evidence_bundle       the evidence bundle, before the mission completes
  review.tool_failures         a node whose tool runs report a fail or error verdict (a found defect)
  review.self_check_disagrees  a node whose agent reports its evidence incomplete
Boundary nodes (measured silicon, foundry execution, fabrication release) are hard
stops: no agent task is ever created for them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from pydantic import ValidationError

from ..config import Settings
from ..runs.adapters import ADAPTERS

BOUNDARY_NODES = {
    "silicon": "Measured silicon validation needs physical hardware and accountable reviewers.",
    "foundry": "Restricted foundry execution needs an approved signed manifest inside an authorized enclave.",
    "release": "An AI agent may recommend but can never authorize irreversible spend or a fabrication release.",
}
DESIGN_WRITE_TOOLS: frozenset[str] = frozenset()  # patch tools arrive with the RTL loop; each will need plan.patch approval


@dataclass(frozen=True)
class Decision:
    decision: str  # allow | deny | require_approval
    rule: str
    reason: str

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"

    def as_dict(self) -> dict:
        return {"decision": self.decision, "rule": self.rule, "reason": self.reason}


def route(settings: Settings, name: str) -> Decision:
    if name == "local":
        return Decision("allow", "model.route.local", f"local model {settings.ollama_model} through Ollama")
    if name == "hosted":
        if settings.anthropic_api_key is None:
            return Decision("deny", "model.route.hosted_key", "no AIMEM_ANTHROPIC_API_KEY is configured in platform/.env")
        return Decision("allow", "model.route.hosted_opt_in", f"hosted model {settings.anthropic_model}; this mission opted in; public T0 data only")
    if name == "scripted":
        if settings.environment != "test":
            return Decision("deny", "model.route.scripted_tests_only", "the scripted model exists only for tests")
        return Decision("allow", "model.route.scripted_tests_only", "deterministic scripted model in the test environment")
    return Decision("deny", "model.route.unknown", f"unknown model route {name!r}")


def launch() -> Decision:
    return Decision("require_approval", "mission.launch", "a person launches every mission before any model or tool call")


def boundary(node: str) -> Decision:
    return Decision("deny", "boundary.hard_stop", BOUNDARY_NODES[node])


def plan(tools: tuple[str, ...], required: tuple[str, ...], steps: list[dict]) -> Decision:
    """Check a proposed plan against the role's tool allowlist and each tool's parameter schema."""
    for index, step in enumerate(steps):
        tool, params = step.get("tool"), step.get("params") or {}
        if tool not in tools:
            return Decision("deny", "plan.tool_allowlist", f"step {index} uses {tool!r}; this agent may use only {', '.join(tools)}")
        if tool in ADAPTERS:
            try:
                ADAPTERS[tool].params_model(**params)
            except ValidationError as exc:
                return Decision("deny", "plan.params_schema", f"step {index} ({tool}) has invalid parameters: {exc.errors()[0]['msg']}")
        elif tool == "worktree.write":
            if not isinstance(params.get("path"), str) or not isinstance(params.get("content"), str) or set(params) - {"path", "content"}:
                return Decision("deny", "plan.params_schema", f"step {index} (worktree.write) needs exactly a string path and content")
        elif params:
            return Decision("deny", "plan.params_schema", f"step {index} ({tool}) takes no parameters")
    planned = {step.get("tool") for step in steps}
    missing = [tool for tool in required if tool not in planned]
    if missing:
        return Decision("deny", "plan.required_tools", f"the plan must run {', '.join(missing)} to produce this node's evidence")
    if planned & DESIGN_WRITE_TOOLS:
        return Decision("require_approval", "plan.patch", "the plan changes design files")
    return Decision("allow", "plan.read_only", "only allowlisted tools on committed repository inputs, plus notes in the task worktree")


def review(node: str, deterministic_ok: bool, evidence_complete: bool, failing: list[str]) -> Decision:
    if not deterministic_ok:
        return Decision("deny", "review.deterministic_gate", "a required tool run did not finish or its evidence record is incomplete")
    if node == "evidence":
        return Decision("require_approval", "review.evidence_bundle", "a person accepts the evidence bundle before the mission completes")
    if failing:
        return Decision("require_approval", "review.tool_failures", f"the tools found failures ({'; '.join(failing)}); a person reviews them before the mission continues")
    if not evidence_complete:
        return Decision("require_approval", "review.self_check_disagrees", "the agent reports its evidence incomplete, so a person reviews it")
    return Decision("allow", "review.tool_evidence", "the deterministic checks pass and the agent reports its evidence complete")


def write(root: Path, relative: object) -> tuple[Decision, Path | None]:
    """Resolve a write request inside a task worktree, or explain why it is refused."""
    problem = _write_problem(root, relative)
    if problem:
        return Decision("deny", "worktree.write_scope", problem), None
    assert isinstance(relative, str)
    return Decision("allow", "worktree.write_scope", "inside the task worktree"), root.joinpath(*PurePosixPath(relative).parts)


def _write_problem(root: Path, relative: object) -> str | None:
    if not isinstance(relative, str) or not relative.strip():
        return "the path is empty"
    if "\x00" in relative or "\\" in relative:
        return "the path contains a NUL byte or a backslash"
    pure = PurePosixPath(relative)
    if pure.is_absolute() or re.match(r"^[A-Za-z]:", relative):
        return "absolute paths are outside the task worktree"
    if any(part == ".." for part in pure.parts):
        return "'..' would leave the task worktree"
    if root.is_symlink():
        return "the worktree root is a symlink"
    probe = root
    for part in pure.parts:
        probe = probe / part
        if probe.is_symlink():
            return f"{probe.relative_to(root)} is a symlink"
    real_root, real = root.resolve(), root.joinpath(*pure.parts).resolve()
    if real == real_root or real_root not in real.parents:
        return "the path resolves outside the task worktree"
    return None
