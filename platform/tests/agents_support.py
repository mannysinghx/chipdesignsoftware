"""Helpers for agent tests: a scripted model, and roles whose tools run on the local runner.

The real RTL, formal, and physical adapters need the pinned toolchains in Docker, so these
tests point the tool nodes at the sandbox self-test adapter instead. Everything else (the
state machine, gateway, budgets, policies, approvals, worktrees, bundle) is the real code.
"""

from __future__ import annotations

import dataclasses

from aimem_platform.agents import mission as mission_module
from aimem_platform.agents.gateway import ModelGateway, ScriptedProvider
from aimem_platform.audit.context import ActorRef

ENGINEER = ActorRef("human", "engineer@aimem.test", None, authenticated=True, role="engineer")
APPROVER = ActorRef("human", "approver@aimem.test", None, authenticated=True, role="approver")
TOOL_NODES = ("rtl", "formal", "physical")


def selftest_roles(monkeypatch) -> None:
    roles = tuple(
        dataclasses.replace(role, tools=("platform.selftest", "worktree.write"), required=("platform.selftest",)) if role.node in TOOL_NODES else role
        for role in mission_module.ROLES
    )
    monkeypatch.setattr(mission_module, "ROLES", roles)
    monkeypatch.setattr(mission_module, "BY_NODE", {role.node: role for role in roles})


def answer(system: str, prompt: str, schema: dict, *, note_path: str = "notes/plan.md", extra_steps: list[dict] | None = None, complete: bool = True) -> dict:
    """A well-behaved agent: run every allowed tool once and leave a note in the worktree."""
    if "steps" in schema["properties"]:
        tools = [variant["properties"]["tool"]["const"] for variant in schema["properties"]["steps"]["items"]["anyOf"]]
        steps = [{"tool": tool, "purpose": "produce this node's evidence", "params": {}} for tool in tools if tool != "worktree.write"]
        steps.append({"tool": "worktree.write", "purpose": "record the plan", "params": {"path": note_path, "content": "scripted plan\n"}})
        return {"summary": "scripted plan", "steps": steps + (extra_steps or []), "risks": ["scripted"]}
    return {"evidence_complete": complete, "findings": ["scripted finding"], "unresolved": [], "confidence": "high"}


def scripted_gateway(services, respond=answer) -> ModelGateway:
    return ModelGateway(services, "scripted", ScriptedProvider(respond), model="scripted")


def launched_mission(services, *, actor=ENGINEER):
    mission = mission_module.create_mission(services, "t0-closure", actor=actor, route="scripted")
    mission_module.decide(services, target="mission", target_id=mission.mission_id, decision="approved", reason="test launch", actor=APPROVER)
    return mission


def evidence_task(services, mission_id):
    return next(task for task in mission_module._tasks(services, mission_id) if task.node == "evidence")
