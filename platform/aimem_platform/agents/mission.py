"""Missions: create, approve, and advance agent tasks over the open-node DAG.

A mission starts `pending_launch` and does nothing until a person launches it.
advance() then moves every task whose upstream tasks are ACCEPTED through the state
machine, one audited transition at a time, until the mission completes, halts, or waits
for a person (policy.py names those points). Everything lands in the mission's trace:
task transitions, model calls, tool calls and the tool runs they started, policy
decisions, and approvals. Agents never approve anything; people do (decide()).
"""

from __future__ import annotations

import hashlib
import json
import traceback
import uuid

from sqlalchemy import func, select

from .. import __version__
from ..audit.canonical import dumps_canonical, format_ts
from ..audit.context import ActorRef, new_trace_id
from ..audit.writer import utcnow
from ..models import EVIDENCE_CLASSES, AgentTask, Mission, Run
from ..runs.adapters import ADAPTERS
from ..runs.reproduce import run_inline
from ..runs.service import _new_artifact_row, git_state, submit_run
from ..services import Services
from . import fsm, policy, worktree
from .gateway import BudgetExceeded, GatewayError, ModelGateway, empty_usage, model_for
from .prompts import PLAN, SELF_CHECK, SELF_CHECK_SCHEMA
from .roles import BY_NODE, ROLES, TOOL_DESCRIPTIONS, Role

KINDS = {"t0-closure": "Reproduce open-source T0 evidence and prepare the measured-silicon validation package."}
DECISIONS = ("approved", "rejected", "needs_work")
POLICY_ACTOR = ActorRef("system", "aimem-policy", __version__, authenticated=True)
EXCERPT_CHARS = 6000
EVIDENCE_RANK = {"measured": 5, "executed": 4, "modeled": 3, "planned": 2, "restricted": 1, "unclassified": 0}


class MissionConflict(RuntimeError):
    """The mission or task is not in a state that allows the request."""


def agent_actor(task: AgentTask) -> ActorRef:
    return ActorRef("agent", f"agent:{task.node}", task.agent_version, authenticated=True)


def _request(kind: str, decision: policy.Decision, now) -> dict:
    """A pending approval: what a person is asked to decide, and the rule that asked. decide() adds "decided"."""
    return {"kind": kind, "rule": decision.rule, "policy_reason": decision.reason, "requested_at": format_ts(now)}


def _loads(text: str | None, default=None):
    return json.loads(text) if text else default


# ---------------------------------------------------------------------------
# create and decide
# ---------------------------------------------------------------------------
def create_mission(services: Services, kind: str, *, actor: ActorRef, route: str | None = None) -> Mission:
    if kind not in KINDS:
        raise ValueError(f"unknown mission {kind!r}; Phase 2 runs: {', '.join(KINDS)}")
    settings = services.settings
    route = route or settings.agent_route
    decision = policy.route(settings, route)
    if not decision.allowed:
        raise PermissionError(decision.reason)
    now = utcnow()
    launch = policy.launch()
    mission = Mission(
        mission_id=uuid.uuid4(), kind=kind, status="pending_launch", requested_by=actor.id, trace_id=new_trace_id(),
        model_route=route, model=model_for(settings, route),
        budget_json=dumps_canonical({"task_tokens": settings.task_max_tokens, "mission_tokens": settings.mission_max_tokens, "mission_usd": settings.mission_max_usd}),
        usage_json=dumps_canonical(empty_usage()),
        approval_json=dumps_canonical(_request("launch", launch, now)),
        created_at=now,
    )
    with services.db.transaction() as session:
        session.add(mission)
        session.flush()
        created = services.writer.append(
            session, feature="agent.mission", action="created", actor=actor, target=("mission", str(mission.mission_id)), trace_id=mission.trace_id,
            details={"kind": kind, "objective": KINDS[kind], "route": route, "route_rule": decision.rule, "model": mission.model,
                     "budget": _loads(mission.budget_json), "nodes": [role.node for role in ROLES], "boundaries": sorted(policy.BOUNDARY_NODES)},
            policy_decision=launch.as_dict(),
        )
        mission.root_event_id = created["event_id"]
        for role in ROLES:
            task = AgentTask(
                task_id=uuid.uuid4(), mission_id=mission.mission_id, node=role.node, agent=role.agent, agent_version=role.version, state="CREATED",
                depends_on_json=dumps_canonical(list(role.depends_on)), tools_json=dumps_canonical(list(role.tools)),
                worktree=f"worktrees/{mission.mission_id}/{role.node}", usage_json=dumps_canonical(empty_usage()), created_at=now, updated_at=now,
            )
            session.add(task)
            session.flush()
            event = services.writer.append(
                session, feature="agent.task", action="created", actor=actor, target=("agent_task", str(task.task_id)), trace_id=mission.trace_id,
                parent_event_id=created["event_id"],
                details={"node": role.node, "agent": role.agent, "agent_version": role.version, "depends_on": list(role.depends_on), "tools": list(role.tools)},
            )
            task.root_event_id = event["event_id"]
        for node in sorted(policy.BOUNDARY_NODES):
            services.writer.append(
                session, feature="agent.task", action="policy_decision", result="denied", actor=POLICY_ACTOR, target=("mission", str(mission.mission_id)),
                trace_id=mission.trace_id, parent_event_id=created["event_id"], details={"node": node, "subject": "boundary"},
                policy_decision=policy.boundary(node).as_dict(),
            )
    return mission


def decide(services: Services, *, target: str, target_id: uuid.UUID, decision: str, reason: str | None, actor: ActorRef) -> dict:
    """A person's decision on a pending mission launch, plan, or review."""
    if actor.type != "human":
        raise PermissionError("only a person can approve, reject, or send back")
    if decision not in DECISIONS:
        raise ValueError(f"decision must be one of {', '.join(DECISIONS)}")
    reason = (reason or "").strip() or None
    if decision != "approved" and not reason:
        raise ValueError("a reason is required to reject or send back")
    now = utcnow()
    decided = {"decision": decision, "by": actor.id, "at": format_ts(now), "reason": reason}
    with services.db.transaction() as session:
        if target == "mission":
            mission = session.get(Mission, target_id, with_for_update=True)
            if mission is None:
                raise LookupError("mission not found")
            if mission.status != "pending_launch":
                raise MissionConflict(f"the mission is {mission.status}, not waiting to be launched")
            if decision == "needs_work":
                raise ValueError("a launch is approved or rejected")
            mission.approval_json = dumps_canonical({**_loads(mission.approval_json, {}), "decided": decided})
            common = dict(actor=actor, target=("mission", str(mission.mission_id)), trace_id=mission.trace_id, parent_event_id=mission.root_event_id)
            services.writer.append(session, feature="approval.decide", action=decision, details={"subject": "launch", "reason": reason}, **common)
            if decision == "approved":
                mission.status, mission.launched_at = "running", now
                services.writer.append(session, feature="agent.mission", action="launched", details={"by": actor.id, "reason": reason}, **common)
            else:
                mission.status, mission.finished_at, mission.error = "rejected", now, f"launch rejected by {actor.id}: {reason}"
                services.writer.append(session, feature="agent.mission", action="rejected", result="error", details={"by": actor.id, "reason": reason}, **common)
            return {"mission_id": str(mission.mission_id), "status": mission.status}
        if target != "task":
            raise ValueError("target must be mission or task")
        task = session.get(AgentTask, target_id, with_for_update=True)
        if task is None:
            raise LookupError("task not found")
        mission = session.get(Mission, task.mission_id, with_for_update=True)
        pending = _loads(task.approval_json)
        if not pending or "decided" in pending:
            raise MissionConflict(f"{task.node} has no decision pending (state {task.state})")
        outcome = {"plan": {"approved": "APPROVED_IF_REQUIRED", "rejected": "REJECTED", "needs_work": "NEEDS_WORK"},
                   "review": {"approved": "ACCEPTED", "rejected": "REJECTED", "needs_work": "NEEDS_WORK"}}[pending["kind"]][decision]
        task.approval_json = dumps_canonical({**pending, "decided": decided})
        services.writer.append(
            session, feature="approval.decide", action=decision, actor=actor, target=("agent_task", str(task.task_id)), trace_id=mission.trace_id,
            parent_event_id=task.root_event_id, details={"subject": pending["kind"], "node": task.node, "rule": pending.get("rule"), "reason": reason},
        )
        halt = None if decision == "approved" else f"{pending['kind']} {decision.replace('_', ' ')} by {actor.id}: {reason}"
        _move(services, session, mission, task, outcome, actor=actor, details={"decided_by": actor.id, "reason": reason}, halt_reason=halt)
        _settle(services, session, mission)
        return {"task_id": str(task.task_id), "node": task.node, "state": task.state, "mission_status": mission.status}


# ---------------------------------------------------------------------------
# advance
# ---------------------------------------------------------------------------
def advance(services: Services, mission_id: uuid.UUID, *, runner, gateway: ModelGateway | None = None) -> Mission:
    """Move the mission's runnable tasks forward until it completes, halts, or waits for a person.

    One worker at a time per mission: a session advisory lock is held for the whole call, and a
    second caller returns at once instead of racing the first through the state machine.
    """
    mission = _mission(services, mission_id)
    if mission.status != "running":
        return mission
    key = int.from_bytes(hashlib.sha256(b"aimem-mission:" + mission_id.bytes).digest()[:8], "big", signed=True)
    with services.db.engine.connect() as lock:
        if not lock.execute(select(func.pg_try_advisory_lock(key))).scalar():
            return mission
        try:
            return _advance_locked(services, mission_id, runner=runner, gateway=gateway)
        finally:
            lock.execute(select(func.pg_advisory_unlock(key)))


def _advance_locked(services: Services, mission_id: uuid.UUID, *, runner, gateway: ModelGateway | None) -> Mission:
    mission = _mission(services, mission_id)
    if mission.status != "running":
        return mission
    try:
        gateway = gateway or ModelGateway.for_mission(services, mission)
    except GatewayError as exc:
        task = _next_runnable(_tasks(services, mission_id))
        if task is not None:
            _stop(services, mission, task, f"the model gateway could not start: {exc}")
        return _mission(services, mission_id)
    while True:
        mission = _mission(services, mission_id)
        if mission.status != "running":
            return mission
        task = _next_runnable(_tasks(services, mission_id))
        if task is None:
            return mission
        try:
            _step(services, mission, task, BY_NODE[task.node], runner, gateway)
        except (BudgetExceeded, GatewayError, worktree.WriteDenied) as exc:
            _stop(services, mission, task, f"{type(exc).__name__}: {exc}")
        except Exception as exc:  # a platform defect: stop this task with the full traceback, never leave it mid-state
            _stop(services, mission, task, f"{type(exc).__name__}: {exc}", trace=traceback.format_exc())


def _step(services: Services, mission: Mission, task: AgentTask, role: Role, runner, gateway: ModelGateway) -> None:
    handler = {
        "CREATED": lambda: _validate_context(services, mission, task, role),
        "CONTEXT_VALIDATED": lambda: _propose_plan(services, mission, task, role, gateway),
        "APPROVED_IF_REQUIRED": lambda: _run_tools(services, mission, task, role, runner),
        "EVIDENCE_COLLECTED": lambda: _self_check(services, mission, task, role, gateway),
        "SELF_CHECKED": lambda: _gate_review(services, mission, task, role),
        "RUNNING_TOOLS": lambda: _stop(services, mission, task, "interrupted while running tools; its runs are in the mission trace"),
    }.get(task.state)
    if handler is None:
        raise MissionConflict(f"{task.node} is {task.state}; nothing to advance")
    handler()


def _next_runnable(tasks: list[AgentTask]) -> AgentTask | None:
    by_node = {task.node: task for task in tasks}
    for role in ROLES:
        task = by_node[role.node]
        if task.state in fsm.TERMINAL or _pending(task):
            continue
        if all(by_node[upstream].state == "ACCEPTED" for upstream in role.depends_on):
            return task
    return None


def _pending(task: AgentTask) -> bool:
    approval = _loads(task.approval_json)
    return bool(approval) and "decided" not in approval


# -- steps ---------------------------------------------------------------------
def _validate_context(services: Services, mission: Mission, task: AgentTask, role: Role) -> None:
    files, missing = _context_files(services, role)
    if missing:
        _stop(services, mission, task, f"context files missing: {', '.join(missing)}")
        return
    upstream = _upstream(services, mission, role)
    context = {"files": [{key: item[key] for key in ("path", "sha256", "bytes")} for item in files], "upstream": upstream}
    written = worktree.write(services, mission, task, "context.json", dumps_canonical(context).encode(), actor=agent_actor(task))
    with services.db.transaction() as session:
        current = session.get(AgentTask, task.task_id, with_for_update=True)
        current.context_json = dumps_canonical({**context, "sha256": written["sha256"]})
        _move(services, session, mission, current, "CONTEXT_VALIDATED", actor=agent_actor(task),
              details={"files": [[item["path"], item["sha256"]] for item in files], "context_sha256": written["sha256"]})


def _propose_plan(services: Services, mission: Mission, task: AgentTask, role: Role, gateway: ModelGateway) -> None:
    recorded = _loads(task.context_json)
    files, missing = _context_files(services, role)
    changed = sorted({item["path"] for item in recorded["files"]} ^ {item["path"] for item in files}) or [
        item["path"] for item, old in zip(files, recorded["files"]) if item["sha256"] != old["sha256"]
    ]
    if missing or changed:
        _stop(services, mission, task, f"context changed since it was validated: {', '.join(missing + changed)}")
        return
    answer = gateway.ask(
        mission=mission, task=task, actor=agent_actor(task), template=PLAN, schema=role.plan_schema, purpose="plan",
        values=_values(mission, role, context=_render_files(files), upstream=_render_upstream(recorded["upstream"])),
    )
    steps = [
        {"tool": step.get("tool"), "params": step.get("params") or {}, "purpose": str(step.get("purpose", ""))[:500]}
        for step in answer.get("steps", []) if isinstance(step, dict)
    ]
    decision = policy.plan(role.tools, role.required, steps)
    plan = {"summary": str(answer.get("summary", ""))[:2000], "steps": steps, "risks": [str(risk)[:500] for risk in answer.get("risks", [])][:20]}
    with services.db.transaction() as session:
        mission_row = session.get(Mission, mission.mission_id, with_for_update=True)
        current = session.get(AgentTask, task.task_id, with_for_update=True)
        current.plan_json = dumps_canonical({**plan, "decision": decision.as_dict()})
        shown = {"summary": plan["summary"], "steps": [{"tool": step["tool"], "purpose": step["purpose"]} for step in steps], "risks": plan["risks"]}
        _move(services, session, mission, current, "PLAN_PROPOSED", actor=agent_actor(task), details=shown, policy_decision=decision.as_dict())
        _gate(services, session, mission_row, current, decision, subject="plan", allow_to="APPROVED_IF_REQUIRED")


def _run_tools(services: Services, mission: Mission, task: AgentTask, role: Role, runner) -> None:
    plan = _loads(task.plan_json)
    with services.db.transaction() as session:
        current = session.get(AgentTask, task.task_id, with_for_update=True)
        _move(services, session, mission, current, "RUNNING_TOOLS", actor=agent_actor(task), details={"steps": len(plan["steps"])})
    results, first_runs = [], {}
    for index, step in enumerate(plan["steps"]):
        repeat = json.dumps([step["tool"], step["params"]], sort_keys=True)
        if step["tool"] in ADAPTERS and repeat in first_runs:
            # Same adapter, same parameters, same committed inputs: the deterministic run is not repeated.
            first = first_runs[repeat]
            services.writer.commit_event(
                services.db, feature="agent.task", action="tool_call", result="info", actor=agent_actor(task), target=("agent_task", str(task.task_id)),
                trace_id=mission.trace_id, parent_event_id=task.root_event_id,
                details={"node": task.node, "step": index, "tool": step["tool"], "duplicate_of": first["step"], "run_id": first["run_id"],
                         "reason": "identical tool and parameters; the deterministic run is not repeated"},
            )
            results.append({**first, "step": index, "duplicate_of": first["step"]})
            continue
        try:
            result = _run_step(services, mission, task, index, step, runner)
        except worktree.WriteDenied as exc:
            _stop(services, mission, task, f"step {index} was refused: {exc}")
            return
        if step["tool"] in ADAPTERS:
            first_runs[repeat] = result
        results.append(result)
    classes = [result["evidence_class"] for result in results if result.get("evidence_class")]
    evidence = {"steps": results, "evidence_class": min(classes, key=EVIDENCE_RANK.get) if classes else role.evidence_without_tools}
    with services.db.transaction() as session:
        current = session.get(AgentTask, task.task_id, with_for_update=True)
        current.evidence_json = dumps_canonical(evidence)
        shown = [{key: result.get(key) for key in ("tool", "run_id", "status", "verdict", "evidence_class", "path", "sha256", "duplicate_of") if result.get(key) is not None} for result in results]
        _move(services, session, mission, current, "EVIDENCE_COLLECTED", actor=agent_actor(task), details={"steps": shown, "evidence_class": evidence["evidence_class"]})


def _run_step(services: Services, mission: Mission, task: AgentTask, index: int, step: dict, runner) -> dict:
    tool, params, actor = step["tool"], step["params"], agent_actor(task)
    if tool == "worktree.write":
        return {"step": index, **worktree.write(services, mission, task, params["path"], params["content"].encode("utf-8"), actor=actor)}
    if tool == "evidence.bundle":
        return {"step": index, **assemble_bundle(services, mission, task)}
    call = services.writer.commit_event(
        services.db, feature="agent.task", action="tool_call", actor=actor, target=("agent_task", str(task.task_id)), trace_id=mission.trace_id,
        parent_event_id=task.root_event_id, details={"node": task.node, "step": index, "tool": tool, "params": params, "purpose": step["purpose"]},
    )
    run = submit_run(services, tool, params, actor=actor, trace=(mission.trace_id, call["event_id"]))
    finished = run_inline(services, runner, run)
    summary = _loads(finished.summary_json, {})
    return {
        "step": index, "tool": tool, "run_id": str(finished.run_id), "status": finished.status, "verdict": finished.verdict,
        "evidence_class": finished.evidence_class, "headline": summary.get("headline"), "limitations": summary.get("limitations"),
        "spec_hash": finished.spec_hash, "output_manifest_hash": finished.output_manifest_hash, "runner": finished.runner,
    }


def _self_check(services: Services, mission: Mission, task: AgentTask, role: Role, gateway: ModelGateway) -> None:
    evidence = _loads(task.evidence_json)
    checks = _deterministic_checks(services, role, task, evidence)
    deterministic_ok = all(check["ok"] for check in checks)
    answer = gateway.ask(
        mission=mission, task=task, actor=agent_actor(task), template=SELF_CHECK, schema=SELF_CHECK_SCHEMA, purpose="self_check",
        values=_values(mission, role, expected_class=_expected_class(role), evidence=_render_evidence(services, evidence),
                       checks="\n".join(f"- {'PASS' if c['ok'] else 'FAIL'} {c['check']}: {c['detail']}" for c in checks)),
    )
    agent = {
        "evidence_complete": bool(answer.get("evidence_complete")),
        "findings": [str(item)[:500] for item in answer.get("findings", [])][:30],
        "unresolved": [str(item)[:500] for item in answer.get("unresolved", [])][:30],
        "confidence": answer.get("confidence") if answer.get("confidence") in ("low", "medium", "high") else "low",
    }
    with services.db.transaction() as session:
        current = session.get(AgentTask, task.task_id, with_for_update=True)
        current.check_json = dumps_canonical({"deterministic": checks, "deterministic_ok": deterministic_ok, "agent": agent})
        _move(services, session, mission, current, "SELF_CHECKED", actor=agent_actor(task), details={"deterministic_ok": deterministic_ok, **agent})


def _gate_review(services: Services, mission: Mission, task: AgentTask, role: Role) -> None:
    check = _loads(task.check_json)
    failing = [f"{step['tool']} {step['verdict']}: {step.get('headline')}" for step in _loads(task.evidence_json)["steps"]
               if step.get("run_id") and step.get("verdict") in ("fail", "error") and "duplicate_of" not in step]
    decision = policy.review(role.node, check["deterministic_ok"], check["agent"]["evidence_complete"], failing)
    with services.db.transaction() as session:
        mission_row = session.get(Mission, mission.mission_id, with_for_update=True)
        current = session.get(AgentTask, task.task_id, with_for_update=True)
        _move(services, session, mission, current, "REVIEW_REQUIRED", actor=agent_actor(task), policy_decision=decision.as_dict())
        _gate(services, session, mission_row, current, decision, subject="review", allow_to="ACCEPTED")


def _deterministic_checks(services: Services, role: Role, task: AgentTask, evidence: dict) -> list[dict]:
    checks = []
    ran = {step["tool"] for step in evidence["steps"]}
    for tool in role.required:
        checks.append({"check": f"ran {tool}", "ok": tool in ran, "detail": "in the plan and executed" if tool in ran else "not run"})
    for step in evidence["steps"]:
        if step["tool"] in ADAPTERS and "duplicate_of" not in step:
            finished = step["status"] in ("succeeded", "failed")
            checks.append({"check": f"{step['tool']} run {step['run_id'][:8]} finished", "ok": finished, "detail": f"status {step['status']}, verdict {step['verdict']}"})
            classified = step.get("evidence_class") in EVIDENCE_CLASSES
            checks.append({"check": f"{step['tool']} evidence class recorded", "ok": classified, "detail": str(step.get("evidence_class"))})
        elif step["tool"] == "evidence.bundle":
            stored = services.artifacts.exists(step["sha256"])
            checks.append({"check": "evidence bundle stored", "ok": stored, "detail": step["sha256"]})
    context = _loads(task.context_json, {})
    checks.append({"check": "context recorded by hash", "ok": bool(context.get("sha256")), "detail": str(context.get("sha256"))})
    return checks


# -- gates, moves, and mission status ---------------------------------------------
def _gate(services, session, mission_row: Mission, task: AgentTask, decision: policy.Decision, *, subject: str, allow_to: str) -> None:
    """Record a policy decision and act on it inside the caller's transaction."""
    result = {"allow": "ok", "deny": "denied", "require_approval": "pending"}[decision.decision]
    services.writer.append(
        session, feature="agent.task", action="policy_decision", result=result, actor=POLICY_ACTOR, target=("agent_task", str(task.task_id)),
        trace_id=mission_row.trace_id, parent_event_id=task.root_event_id, details={"node": task.node, "subject": subject}, policy_decision=decision.as_dict(),
    )
    if decision.decision == "allow":
        _move(services, session, mission_row, task, allow_to, actor=POLICY_ACTOR, policy_decision=decision.as_dict())
    elif decision.decision == "require_approval":
        task.approval_json = dumps_canonical(_request(subject, decision, utcnow()))
    else:
        _move(services, session, mission_row, task, "NEEDS_WORK", actor=POLICY_ACTOR, policy_decision=decision.as_dict(),
              halt_reason=f"{subject} denied ({decision.rule}): {decision.reason}")
    _settle(services, session, mission_row)


def _move(services, session, mission: Mission, task: AgentTask, target: str, *, actor: ActorRef, details: dict | None = None,
          policy_decision: dict | None = None, halt_reason: str | None = None) -> dict:
    fsm.check(task.state, target)
    previous, now = task.state, utcnow()
    task.state, task.updated_at = target, now
    if target in fsm.TERMINAL:
        task.finished_at = now
    if halt_reason:
        task.halt_reason = halt_reason
    return services.writer.append(
        session, feature="agent.task", action=fsm.action(target), result="error" if target in ("REJECTED", "NEEDS_WORK") else "ok",
        actor=actor, target=("agent_task", str(task.task_id)), trace_id=mission.trace_id, parent_event_id=task.root_event_id,
        details={"node": task.node, "from": previous, "to": target, **(details or {})}, policy_decision=policy_decision, error=halt_reason,
    )


def _settle(services, session, mission: Mission) -> None:
    """Derive the mission's status from its tasks, inside the transaction that changed them."""
    if mission.status not in ("running", "awaiting_approval"):
        return
    tasks = session.scalars(select(AgentTask).where(AgentTask.mission_id == mission.mission_id)).all()
    by_node = {task.node: task for task in tasks}
    stopped = next((task for task in tasks if task.state in ("REJECTED", "NEEDS_WORK")), None)
    if stopped is not None:
        status = "rejected" if stopped.state == "REJECTED" else "halted"
    elif by_node["evidence"].state == "ACCEPTED":
        status = "completed"
    elif any(_pending(task) for task in tasks):
        status = "awaiting_approval"
    else:
        status = "running"
    if status == mission.status:
        return
    mission.status = status
    if status in ("running", "awaiting_approval"):
        return  # the task event written in this transaction records why
    now = utcnow()
    mission.finished_at = now
    details = {"usage": _loads(mission.usage_json)}
    if stopped is not None:
        mission.error = f"{stopped.node}: {stopped.halt_reason}"
        details.update(node=stopped.node, reason=stopped.halt_reason)
    else:
        bundle = next(step for step in _loads(by_node["evidence"].evidence_json)["steps"] if step["tool"] == "evidence.bundle")
        mission.bundle_sha256 = bundle["sha256"]
        mission.summary_json = dumps_canonical({"bundle_sha256": bundle["sha256"], "decision": bundle["decision"], "gates": bundle["gates"]})
        details.update(bundle_sha256=bundle["sha256"], decision=bundle["decision"])
    services.writer.append(
        session, feature="agent.mission", action=status, result="ok" if status == "completed" else "error", actor=POLICY_ACTOR,
        target=("mission", str(mission.mission_id)), trace_id=mission.trace_id, parent_event_id=mission.root_event_id, details=details,
        output_hash=f"sha256:{mission.bundle_sha256}" if status == "completed" else None,
    )


def _stop(services: Services, mission: Mission, task: AgentTask, reason: str, *, trace: str | None = None) -> None:
    """End a task as NEEDS_WORK with the reason, and let the mission status follow."""
    with services.db.transaction() as session:
        mission_row = session.get(Mission, mission.mission_id, with_for_update=True)
        current = session.get(AgentTask, task.task_id, with_for_update=True)
        if current.state in fsm.TERMINAL:
            return
        _move(services, session, mission_row, current, "NEEDS_WORK", actor=POLICY_ACTOR, halt_reason=reason, details={"traceback": trace} if trace else None)
        _settle(services, session, mission_row)


# -- evidence bundle ------------------------------------------------------------------
def assemble_bundle(services: Services, mission: Mission, task: AgentTask) -> dict:
    """The evidence.bundle tool: every accepted gate by hash, the failing verdicts, the boundaries, and a hold."""
    tasks = [item for item in _tasks(services, mission.mission_id) if item.node != "evidence"]
    gates, failing = [], []
    for item in tasks:
        evidence, check, context = _loads(item.evidence_json, {}), _loads(item.check_json, {}), _loads(item.context_json, {})
        runs = [
            {key: step.get(key) for key in ("tool", "run_id", "status", "verdict", "evidence_class", "headline", "limitations", "spec_hash", "output_manifest_hash", "runner")}
            for step in evidence.get("steps", []) if step.get("run_id") and "duplicate_of" not in step
        ]
        failing += [f"{item.node}: {run['tool']} {run['verdict']} ({run['headline']})" for run in runs if run["verdict"] in ("fail", "error")]
        gates.append({
            "node": item.node, "agent": f"agent:{item.node}@{item.agent_version}", "state": item.state, "evidence_class": evidence.get("evidence_class"),
            "context_sha256": context.get("sha256"), "runs": runs,
            # The agent's own claims from its self-check: advisory, never evidence.
            "agent_findings": check.get("agent", {}).get("findings", []), "agent_unresolved": check.get("agent", {}).get("unresolved", []),
        })
    classes = [gate["evidence_class"] for gate in gates if gate["evidence_class"]]
    weakest = min(classes, key=EVIDENCE_RANK.get) if classes else "unclassified"
    reasons = [*(f"failing: {item}" for item in failing), *(f"hard stop {node}: {text}" for node, text in sorted(policy.BOUNDARY_NODES.items())),
               "physical results are a public-PDK (sky130hd) proxy, not signoff"]
    with services.db.read() as session:
        usage = _loads(session.get(Mission, mission.mission_id).usage_json)
    bundle = {
        "schema": "aimem.evidence-bundle/1",
        "mission": {"mission_id": str(mission.mission_id), "kind": mission.kind, "objective": KINDS[mission.kind], "trace_id": mission.trace_id,
                    "requested_by": mission.requested_by, "model_route": mission.model_route, "model": mission.model},
        "gates": gates, "failing": failing,
        "boundaries": [{"node": node, "decision": "hard_stop", "reason": text} for node, text in sorted(policy.BOUNDARY_NODES.items())],
        "decision": "hold", "reasons": reasons, "evidence_class": weakest, "llm_usage": usage,
    }
    data = dumps_canonical(bundle).encode("utf-8")
    blob = services.artifacts.put(data)
    actor = agent_actor(task)
    common = dict(actor=actor, target=("mission", str(mission.mission_id)), trace_id=mission.trace_id, parent_event_id=task.root_event_id)
    with services.db.transaction() as session:
        row = _new_artifact_row(session, blob.sha256, blob.size_bytes, "evidence-bundle.json", "application/json", weakest, {
            "artifact_id": blob.sha256, "mission_id": str(mission.mission_id), "task_id": str(task.task_id),
            "git_revision": git_state(services.settings.repo_root, [])["revision"], "tool_identity": {"agent": actor.id, "agent_version": actor.version, "platform": __version__},
            "input_hashes": sorted({f"sha256:{run['output_manifest_hash']}" for gate in gates for run in gate["runs"] if run.get("output_manifest_hash")}),
            "output_hash": f"sha256:{blob.sha256}", "evidence_class": weakest, "limitations": "an assembly of the gates it lists; the decision is hold",
            "owner": mission.requested_by, "timestamp": format_ts(utcnow()), "signature": None,
        }, actor.id)
        if row is not None:
            session.add(row)
        for gate in gates:
            services.writer.append(
                session, feature="evidence.bundle", action="gate_evaluated", **common,
                details={"node": gate["node"], "state": gate["state"], "evidence_class": gate["evidence_class"],
                         "runs": [[run["tool"], run["verdict"]] for run in gate["runs"]], "agent_findings": len(gate["agent_findings"])},
            )
        services.writer.append(session, feature="evidence.bundle", action="artifact_written", output_hash=f"sha256:{blob.sha256}", evidence_class=weakest, **common,
                               details={"gates": len(gates), "failing": failing, "decision": "hold", "bytes": len(data)})
    return {"tool": "evidence.bundle", "sha256": blob.sha256, "decision": "hold", "gates": len(gates), "evidence_class": weakest}


# -- context rendering -------------------------------------------------------------
def _context_files(services: Services, role: Role) -> tuple[list[dict], list[str]]:
    repo, files, missing = services.settings.repo_root, [], []
    for pattern in role.context:
        matches = sorted(path for path in repo.glob(pattern) if path.is_file())
        if not matches:
            missing.append(pattern)
        for path in matches:
            data = path.read_bytes()
            files.append({"path": str(path.relative_to(repo)), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "text": data.decode("utf-8", "replace")})
    return files, missing


def _upstream(services: Services, mission: Mission, role: Role) -> list[dict]:
    by_node = {task.node: task for task in _tasks(services, mission.mission_id)}
    summaries = []
    for node in role.depends_on:
        task = by_node[node]
        plan, evidence, check = _loads(task.plan_json, {}), _loads(task.evidence_json, {}), _loads(task.check_json, {})
        summaries.append({
            "node": node, "summary": plan.get("summary"), "evidence_class": evidence.get("evidence_class"),
            "runs": [[step["tool"], step.get("verdict"), step.get("headline")] for step in evidence.get("steps", []) if step.get("run_id") and "duplicate_of" not in step],
            "findings": check.get("agent", {}).get("findings", []),
        })
    return summaries


def _values(mission: Mission, role: Role, **extra) -> dict:
    return {
        "agent": role.agent, "mission": KINDS[mission.kind], "title": role.title, "objective": role.objective, "stop_rule": role.stop_rule,
        "tools": "\n".join(f"- {tool}: {TOOL_DESCRIPTIONS[tool]}" for tool in role.tools), "required": ", ".join(role.required) or "none", **extra,
    }


def _render_files(files: list[dict]) -> str:
    blocks = []
    for item in files:
        text = item["text"]
        note = f", excerpt: first {EXCERPT_CHARS} of {len(text)} characters" if len(text) > EXCERPT_CHARS else ""
        blocks.append(f"--- {item['path']} (sha256 {item['sha256']}, {item['bytes']} bytes{note}) ---\n{text[:EXCERPT_CHARS]}")
    return "\n".join(blocks) or "(none)"


def _render_upstream(upstream: list[dict]) -> str:
    return json.dumps(upstream, indent=1, sort_keys=True) if upstream else "(none: this node has no upstream tasks)"


def _render_evidence(services: Services, evidence: dict) -> str:
    steps = []
    for step in evidence.get("steps", []):
        if step["tool"] == "worktree.write" and services.artifacts.exists(step["sha256"]):
            text = services.artifacts.path_for(step["sha256"]).read_bytes().decode("utf-8", "replace")
            note = f" (excerpt: first {EXCERPT_CHARS} of {len(text)} characters)" if len(text) > EXCERPT_CHARS else ""
            step = {**step, "content": text[:EXCERPT_CHARS] + note}
        steps.append(step)
    return json.dumps({"evidence_class": evidence.get("evidence_class"), "steps": steps}, indent=1, sort_keys=True)


def _expected_class(role: Role) -> str:
    if role.node == "evidence":
        return "the weakest class among the gates it bundles (planned while any gate is planned); a bundle never upgrades a class"
    if any(tool in ADAPTERS for tool in role.required):
        return "executed when its tools ran in the Docker sandbox, modeled if they ran on the unsandboxed local runner"
    return f"{role.evidence_without_tools}: notes derived from the read-only context. This node runs no tools, so {role.evidence_without_tools} is the correct class, not a defect"


# -- reading ----------------------------------------------------------------------------
def _mission(services: Services, mission_id: uuid.UUID) -> Mission:
    with services.db.read() as session:
        mission = session.get(Mission, mission_id)
    if mission is None:
        raise LookupError("mission not found")
    return mission


def _tasks(services: Services, mission_id: uuid.UUID) -> list[AgentTask]:
    with services.db.read() as session:
        tasks = list(session.scalars(select(AgentTask).where(AgentTask.mission_id == mission_id)))
    order = {role.node: index for index, role in enumerate(ROLES)}
    return sorted(tasks, key=lambda task: order[task.node])


def serialize_task(task: AgentTask) -> dict:
    return {
        "task_id": str(task.task_id), "node": task.node, "agent": task.agent, "agent_version": task.agent_version, "state": task.state,
        "depends_on": _loads(task.depends_on_json, []), "tools": _loads(task.tools_json, []), "worktree": task.worktree,
        "context": _loads(task.context_json), "plan": _loads(task.plan_json), "evidence": _loads(task.evidence_json), "check": _loads(task.check_json),
        "approval": _loads(task.approval_json), "usage": _loads(task.usage_json), "halt_reason": task.halt_reason,
        "created_at": format_ts(task.created_at), "updated_at": format_ts(task.updated_at), "finished_at": format_ts(task.finished_at) if task.finished_at else None,
    }


def serialize_mission(mission: Mission, tasks: list[AgentTask] | None = None) -> dict:
    payload = {
        "mission_id": str(mission.mission_id), "kind": mission.kind, "objective": KINDS.get(mission.kind), "status": mission.status,
        "requested_by": mission.requested_by, "trace_id": mission.trace_id, "model_route": mission.model_route, "model": mission.model,
        "budget": _loads(mission.budget_json), "usage": _loads(mission.usage_json), "approval": _loads(mission.approval_json),
        "bundle_sha256": mission.bundle_sha256, "summary": _loads(mission.summary_json), "error": mission.error,
        "created_at": format_ts(mission.created_at), "launched_at": format_ts(mission.launched_at) if mission.launched_at else None,
        "finished_at": format_ts(mission.finished_at) if mission.finished_at else None,
        "boundaries": [{"node": node, "decision": "hard_stop", "reason": text} for node, text in sorted(policy.BOUNDARY_NODES.items())],
    }
    if tasks is not None:
        payload["tasks"] = [serialize_task(task) for task in tasks]
    return payload


def mission_view(services: Services, mission_id: uuid.UUID) -> dict:
    return serialize_mission(_mission(services, mission_id), _tasks(services, mission_id))


def pending_approvals(services: Services) -> list[dict]:
    with services.db.read() as session:
        launches = session.scalars(select(Mission).where(Mission.status == "pending_launch").order_by(Mission.created_at)).all()
        waiting = session.scalars(select(Mission).where(Mission.status == "awaiting_approval").order_by(Mission.created_at)).all()
        tasks = session.scalars(select(AgentTask).where(AgentTask.mission_id.in_([mission.mission_id for mission in waiting]))).all() if waiting else []
    items = [{**_loads(m.approval_json, {}), "target": "mission", "id": str(m.mission_id), "subject": "launch", "mission_id": str(m.mission_id),
              "mission_kind": m.kind, "model_route": m.model_route, "model": m.model, "budget": _loads(m.budget_json)} for m in launches]
    for task in tasks:
        if _pending(task):
            approval = _loads(task.approval_json)
            items.append({**approval, "target": "task", "id": str(task.task_id), "subject": approval["kind"], "mission_id": str(task.mission_id), "node": task.node,
                          "state": task.state, "plan": _loads(task.plan_json), "check": _loads(task.check_json)})
    return items


def mission_runs(services: Services, mission: Mission) -> list[Run]:
    with services.db.read() as session:
        return list(session.scalars(select(Run).where(Run.trace_id == mission.trace_id).order_by(Run.queued_at)))
