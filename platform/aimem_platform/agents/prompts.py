"""Versioned prompt templates and the JSON schemas that constrain model output.

Schemas stay within what both routes enforce: every object sets additionalProperties
false, with no numeric or string-length constraints. Changing a template changes every
agent version (roles.Role.version), so outputs stay attributable to the exact prompt.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

PREAMBLE = (
    "You are {agent}, one role in the AIMEM Design Studio, an evidence-first chip design platform. "
    "You coordinate; deterministic tools produce the evidence. Use only the tools listed. "
    "Never invent evidence, never claim signoff or silicon results, and never upgrade an evidence class "
    "(executed, modeled, planned). Answer with JSON that matches the required schema."
)


@dataclass(frozen=True)
class Template:
    name: str
    version: str
    system: str
    user: str

    @property
    def id(self) -> str:
        return f"{self.name}/{self.version}"

    def render(self, **values) -> tuple[str, str]:
        return self.system.format(**values), self.user.format(**values)


PLAN = Template(
    "plan",
    "1",
    PREAMBLE,
    "Mission: {mission}\n"
    "Your node: {title}\n"
    "Objective: {objective}\n"
    "Stop rule: {stop_rule}\n\n"
    "Tools you may use:\n{tools}\n"
    "Tools this node must run: {required}\n\n"
    "Read-only context (sha256 is of each whole file):\n{context}\n\n"
    "Accepted upstream results:\n{upstream}\n\n"
    "Propose the smallest plan that produces this node's evidence. Each step names one tool, its params, "
    "and its purpose. Use worktree.write only for short notes inside your own worktree.",
)

SELF_CHECK = Template(
    "self_check",
    "2",
    PREAMBLE,
    "Mission: {mission}\n"
    "Your node: {title}\n"
    "Objective: {objective}\n"
    "Stop rule: {stop_rule}\n"
    "Evidence class this node can produce: {expected_class}\n\n"
    "Evidence collected (from the platform's records; notes you wrote are shown with their content):\n{evidence}\n\n"
    "Deterministic checks:\n{checks}\n\n"
    "Is this node's evidence complete and honestly classified for its objective? Defects the tools found are "
    "findings, not missing evidence. List the findings, anything unresolved, and your confidence.",
)

TEMPLATE_DIGEST = hashlib.sha256(
    json.dumps([[t.id, t.system, t.user] for t in (PLAN, SELF_CHECK)]).encode()
).hexdigest()


def plan_schema(params: dict[str, dict]) -> dict:
    """One exact step variant per tool: the tool is a constant and its params follow that tool's own schema."""
    variants = [
        {
            "type": "object",
            "properties": {"tool": {"const": tool}, "purpose": {"type": "string"}, "params": schema},
            "required": ["tool", "purpose", "params"],
            "additionalProperties": False,
        }
        for tool, schema in params.items()
    ]
    return {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "steps": {"type": "array", "items": {"anyOf": variants}},
            "risks": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["summary", "steps", "risks"],
        "additionalProperties": False,
    }


SELF_CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "evidence_complete": {"type": "boolean"},
        "findings": {"type": "array", "items": {"type": "string"}},
        "unresolved": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["evidence_complete", "findings", "unresolved", "confidence"],
    "additionalProperties": False,
}
