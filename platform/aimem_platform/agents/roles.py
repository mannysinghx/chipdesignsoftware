"""The eight open nodes of the orchestration DAG (lib/agent-orchestration.ts) as agent roles.

A role fixes what its agent may use (tools), what it must run (required), and which
repository files form its read-only context. The agent's version is a digest of its role
and prompt templates, so any change to either is a new, separately attributable agent.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass

from ..runs.adapters import ADAPTERS
from . import prompts


@dataclass(frozen=True)
class Role:
    node: str
    agent: str
    title: str
    depends_on: tuple[str, ...]
    tools: tuple[str, ...]
    required: tuple[str, ...]
    context: tuple[str, ...]  # repository globs, read-only
    objective: str
    stop_rule: str
    evidence_without_tools: str = "planned"

    @property
    def plan_schema(self) -> dict:
        return prompts.plan_schema({tool: params_schema(tool) for tool in self.tools})

    @property
    def version(self) -> str:
        digest = hashlib.sha256(
            json.dumps({"role": asdict(self), "templates": prompts.TEMPLATE_DIGEST, "plan_schema": self.plan_schema}, sort_keys=True).encode()
        ).hexdigest()
        return f"1-{digest[:12]}"


ROLES: tuple[Role, ...] = (
    Role(
        "contract", "Contract Agent", "Requirements curator", (),
        ("worktree.write",), (),
        ("design/spec/aimem-t0.json", "design/spec/aimem-t0.schema.json", "design/spec/t0-completion.json"),
        "Extract the T0 acceptance criteria this mission's evidence must address, as a table with one row per gate: id, metric, operator, target, unit, and the evidence class it requires.",
        "Reject ambiguous units, unlabeled derivations, and conflicting targets.",
    ),
    Role(
        "architecture", "Architecture Agent", "Architecture compiler", ("contract",),
        ("worktree.write",), (),
        ("design/spec/aimem-t0.json", "evidence/t0-evidence.json"),
        "Check the T0 hierarchy, address map, and parameter contract for internal consistency; list each check with the values compared, their units, and the result.",
        "Reject invalid dimensions or organization arithmetic.",
    ),
    Role(
        "performance", "Performance Agent", "Workload and performance", ("architecture",),
        ("worktree.write",), (),
        ("evidence/ramulator-correlation.json", "evidence/ramulator2-raw.json"),
        "Summarize the existing Ramulator2 correlation evidence with its numbers and units; state that it is not re-executed in Phase 2 because the adapter is deferred.",
        "Keep analytical, cycle, and external-reference evidence distinct.",
    ),
    Role(
        "rtl", "RTL Agent", "RTL implementation", ("architecture",),
        ("rtl.lint", "rtl.sim", "worktree.write"), ("rtl.lint", "rtl.sim"),
        ("rtl/*.sv",),
        "Produce lint and simulation evidence for the committed T0 RTL; report every defect the tools find.",
        "Reject unsynthesizable logic, hidden stubs, and unconstrained clocks.",
    ),
    Role(
        "formal", "Formal Agent", "Formal verification", ("rtl",),
        ("formal.sby", "worktree.write"), ("formal.sby",),
        ("formal/*.sby",),
        "Produce SymbiYosys proof, cover, and counterexample evidence for the committed T0 RTL.",
        "Never present bounded proof as unbounded or silicon evidence.",
    ),
    Role(
        "physical", "Physical Agent", "Physical implementation proxy", ("rtl",),
        ("physical.orfs", "worktree.write"), ("physical.orfs",),
        ("design/physical/orfs/aimem_t0_channel/config.mk", "design/physical/orfs/aimem_t0_channel/constraint.sdc"),
        "Produce the public-PDK (sky130hd) floorplan-to-GDS, DRC, LVS, and timing evidence for aimem_t0_channel.",
        "Never relabel public-PDK results as qualified-node signoff.",
    ),
    Role(
        "multiphysics", "Multiphysics Agent", "Package and multiphysics", ("performance", "physical"),
        ("worktree.write",), (),
        ("evidence/physical-synthesis.json",),
        "List the package and multiphysics studies still missing and the inputs each needs; no solver adapter exists yet (stub), so this node produces no results.",
        "Require mesh, boundary, material, and convergence provenance.",
    ),
    Role(
        "evidence", "Evidence Agent", "Evidence and policy assembly", ("performance", "formal", "multiphysics"),
        ("evidence.bundle", "worktree.write"), ("evidence.bundle",),
        ("design/agents/orchestration-contract.json",),
        "Assemble the provenance-linked evidence bundle and a promotion recommendation for human review.",
        "Fail closed on missing artifacts, signatures, owners, or evidence class.",
    ),
)
BY_NODE = {role.node: role for role in ROLES}

def params_schema(tool: str) -> dict:
    """A tool's parameters as an output-schema object: types only (both routes reject numeric and length limits)."""
    if tool == "worktree.write":
        properties, required = {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]
    elif tool in ADAPTERS:
        declared = ADAPTERS[tool].params_model.model_json_schema().get("properties", {})
        properties, required = {name: {"type": spec["type"]} for name, spec in declared.items()}, []
    else:
        properties, required = {}, []
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TOOL_DESCRIPTIONS = {
    **{adapter.id: f"{adapter.title}. {adapter.description}" for adapter in ADAPTERS.values()},
    "rtl.sim": f"{ADAPTERS['rtl.sim'].title}. {ADAPTERS['rtl.sim'].description} Optional integer param: seed "
    f"(default {ADAPTERS['rtl.sim'].params_model().seed}, the seed of the recorded regression; omit it to reproduce that evidence).",
    "worktree.write": "Write a note inside your own task worktree. Params: path (relative) and content. Nothing else is writable.",
    "evidence.bundle": "Assemble the provenance-linked evidence bundle from the mission's accepted tasks. No params.",
}
