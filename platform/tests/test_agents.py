"""Phase 2 agents: state machine, policy, worktree write scope, model gateway, budgets, missions, approvals."""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from aimem_platform.agents import fsm, policy
from aimem_platform.agents import mission as mission_module
from aimem_platform.agents import worktree
from aimem_platform.agents.gateway import AnthropicProvider, GatewayError, OllamaProvider
from aimem_platform.agents.prompts import SELF_CHECK_SCHEMA
from aimem_platform.agents.roles import BY_NODE, ROLES
from aimem_platform.audit.canonical import clean_text
from aimem_platform.models import TASK_STATES, AgentTask, Mission
from aimem_platform.runs.reconstruct import compare_with_record
from aimem_platform.runs.runners import LocalRunner
from aimem_platform.services import build_services

from agents_support import APPROVER, ENGINEER, answer, evidence_task, launched_mission, scripted_gateway, selftest_roles
from conftest import events_since, find, head_seq


@pytest.fixture
def local_services(env):
    services = build_services(env.settings.model_copy(update={"runner": "local"}))
    yield services
    services.close()


def _task(services, mission_id, node) -> AgentTask:
    return next(task for task in mission_module._tasks(services, mission_id) if task.node == node)


# ---------------------------------------------------------------------------
# state machine and policy (no database)
# ---------------------------------------------------------------------------
def test_the_state_machine_has_exactly_the_planned_edges():
    assert set(fsm.FORWARD) | fsm.TERMINAL == set(TASK_STATES)
    for current, following in zip(fsm.FORWARD, fsm.FORWARD[1:]):
        fsm.check(current, following)
        fsm.check(current, "NEEDS_WORK")
    fsm.check("PLAN_PROPOSED", "REJECTED")
    for final in ("ACCEPTED", "REJECTED", "NEEDS_WORK"):
        fsm.check("REVIEW_REQUIRED", final)
    for current, target in (("CREATED", "PLAN_PROPOSED"), ("CONTEXT_VALIDATED", "ACCEPTED"), ("RUNNING_TOOLS", "REJECTED"), ("ACCEPTED", "CREATED"), ("NEEDS_WORK", "CREATED")):
        with pytest.raises(fsm.IllegalTransition):
            fsm.check(current, target)


def test_plans_are_checked_against_the_allowlist_and_each_tools_parameters():
    tools, required = ("rtl.lint", "rtl.sim", "worktree.write"), ("rtl.lint", "rtl.sim")
    good = [{"tool": "rtl.lint", "params": {}}, {"tool": "rtl.sim", "params": {"seed": 7}}]
    allowed = policy.plan(tools, required, good)
    assert (allowed.decision, allowed.rule) == ("allow", "plan.read_only")
    assert policy.plan(tools, required, [*good, {"tool": "physical.orfs", "params": {}}]).rule == "plan.tool_allowlist"
    assert policy.plan(tools, required, [{"tool": "rtl.lint", "params": {"seed": 1}}, good[1]]).rule == "plan.params_schema"
    assert policy.plan(tools, required, [*good, {"tool": "worktree.write", "params": {"path": "x"}}]).rule == "plan.params_schema"
    assert policy.plan(tools, required, good[:1]).rule == "plan.required_tools"


def test_review_asks_a_person_for_found_defects_and_disagreements():
    assert policy.review("rtl", True, True, []).rule == "review.tool_evidence"
    assert policy.review("rtl", True, True, ["rtl.sim fail: 20/21 tests pass"]).rule == "review.tool_failures"
    assert policy.review("rtl", True, False, []).rule == "review.self_check_disagrees"
    assert policy.review("evidence", True, True, []).rule == "review.evidence_bundle"
    assert policy.review("rtl", False, True, []).decision == "deny"


def test_model_routes_follow_the_launch_decision(env):
    settings = env.settings
    assert policy.route(settings, "local").allowed
    assert policy.route(settings, "hosted").rule == "model.route.hosted_key" and not policy.route(settings, "hosted").allowed
    assert policy.route(settings.model_copy(update={"anthropic_api_key": "sk-test"}), "hosted").allowed
    assert policy.route(settings, "scripted").allowed and not policy.route(settings.model_copy(update={"environment": "dev"}), "scripted").allowed


def test_each_plan_step_is_pinned_to_its_tools_own_parameters():
    variants = {v["properties"]["tool"]["const"]: v["properties"]["params"] for v in BY_NODE["rtl"].plan_schema["properties"]["steps"]["items"]["anyOf"]}
    assert set(variants) == {"rtl.lint", "rtl.sim", "worktree.write"}
    assert variants["rtl.lint"]["properties"] == {}, "lint takes no parameters, so the model cannot invent one"
    assert variants["rtl.sim"]["properties"] == {"seed": {"type": "integer"}}
    assert variants["worktree.write"]["required"] == ["path", "content"]


def test_output_schemas_stay_within_what_both_routes_enforce():
    def objects(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                yield node
            for value in node.values():
                yield from objects(value)
        elif isinstance(node, list):
            for value in node:
                yield from objects(value)

    for schema in (*(role.plan_schema for role in ROLES), SELF_CHECK_SCHEMA):
        assert all(item.get("additionalProperties") is False for item in objects(schema))
        text = json.dumps(schema)
        assert not any(word in text for word in ("minimum", "maximum", "minLength", "maxLength", "multipleOf"))


# ---------------------------------------------------------------------------
# providers (no network)
# ---------------------------------------------------------------------------
def test_the_ollama_route_constrains_output_to_the_schema_and_reports_tokens():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(path=request.url.path, body=json.loads(request.content))
        return httpx.Response(200, json={"model": "qwen3.6:35b", "message": {"content": '{"ok": true}'}, "prompt_eval_count": 120, "eval_count": 8, "done_reason": "stop"})

    provider = OllamaProvider("http://ollama.test", "qwen3.6:35b", context_tokens=32768, think=False, timeout=5, transport=httpx.MockTransport(handler))
    completion = provider.complete("system", "prompt", {"type": "object"}, 256)
    assert seen["path"] == "/api/chat"
    body = seen["body"]
    assert body["format"] == {"type": "object"} and body["stream"] is False and body["think"] is False
    assert body["options"] == {"temperature": 0, "seed": 0, "num_ctx": 32768, "num_predict": 256}
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert (completion.text, completion.tokens_in, completion.tokens_out, completion.stop) == ('{"ok": true}', 120, 8, "stop")

    down = OllamaProvider("http://ollama.test", "m", context_tokens=1, think=None, timeout=5, transport=httpx.MockTransport(lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused"))))
    with pytest.raises(GatewayError, match="not reachable") as caught:
        down.complete("s", "p", {}, 1)
    assert caught.value.retryable


def test_the_hosted_route_reads_structured_output_and_handles_refusals():
    calls = []

    def response(stop_reason, text='{"ok": true}'):
        return SimpleNamespace(
            stop_reason=stop_reason, model="claude-opus-5", stop_details=SimpleNamespace(category="cyber"),
            content=[SimpleNamespace(type="text", text=text)], usage=SimpleNamespace(input_tokens=90, output_tokens=6),
        )

    replies = iter([response("end_turn"), response("refusal")])
    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **kwargs: calls.append(kwargs) or next(replies))))
    provider = AnthropicProvider("sk-test", "https://api.anthropic.com", "claude-opus-5", timeout=5, client=client)
    completion = provider.complete("system", "prompt", {"type": "object", "additionalProperties": False}, 512)
    assert (completion.text, completion.tokens_in, completion.tokens_out) == ('{"ok": true}', 90, 6)
    request = calls[0]
    assert request["output_config"] == {"format": {"type": "json_schema", "schema": {"type": "object", "additionalProperties": False}}}
    assert request["fallbacks"] == "default" and request["betas"] == ["server-side-fallback-2026-07-01"] and request["model"] == "claude-opus-5"
    with pytest.raises(GatewayError, match="declined"):
        provider.complete("system", "prompt", {}, 512)


# ---------------------------------------------------------------------------
# worktree write scope (exit criterion: agents cannot write outside their worktree)
# ---------------------------------------------------------------------------
def test_writes_outside_the_task_worktree_are_refused_and_logged(local_services, tmp_path):
    mission = mission_module.create_mission(local_services, "t0-closure", actor=ENGINEER, route="scripted")
    task = _task(local_services, mission.mission_id, "rtl")
    root = worktree.root_for(local_services, task)
    root.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "link").symlink_to(outside, target_is_directory=True)
    repo_rtl = sorted((local_services.settings.repo_root / "rtl").glob("*.sv"))
    before = {path: path.read_bytes() for path in repo_rtl}
    actor = mission_module.agent_actor(task)
    seq = head_seq(local_services)
    attempts = ["../formal/x.txt", "../../../../rtl/aimem_t0_channel.sv", str(outside / "abs.txt"), "a/../../x", "link/escape.txt", "nul\x00byte", "back\\slash", "", "."]
    for path in attempts:
        with pytest.raises(worktree.WriteDenied):
            worktree.write(local_services, mission, task, path, b"forbidden", actor=actor)
    assert list(outside.iterdir()) == [] and {path: path.read_bytes() for path in repo_rtl} == before
    denied = find(events_since(local_services, seq), feature="agent.task", action="policy_decision", result="denied")
    assert len(denied) == len(attempts)
    assert all(event["policy_decision"]["rule"] == "worktree.write_scope" and event["actor"]["type"] == "agent" for event in denied)
    assert [event["details"]["path"] for event in denied] == [clean_text(path) for path in attempts]

    written = worktree.write(local_services, mission, task, "notes/ok.md", b"allowed\n", actor=actor)
    assert (root / "notes/ok.md").read_bytes() == b"allowed\n" and local_services.artifacts.exists(written["sha256"])
    [call] = find(events_since(local_services, seq), feature="agent.task", action="tool_call")
    assert call["output_hash"] == f"sha256:{written['sha256']}" and call["trace_id"] == mission.trace_id


# ---------------------------------------------------------------------------
# missions
# ---------------------------------------------------------------------------
def test_a_mission_does_nothing_until_a_person_launches_it(local_services):
    mission = mission_module.create_mission(local_services, "t0-closure", actor=ENGINEER, route="scripted")
    calls = []
    gateway = scripted_gateway(local_services, lambda *args: calls.append(args) or answer(*args))
    assert mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=gateway).status == "pending_launch"
    assert calls == [] and {task.state for task in mission_module._tasks(local_services, mission.mission_id)} == {"CREATED"}
    view = mission_module.mission_view(local_services, mission.mission_id)
    assert [task["node"] for task in view["tasks"]] == [role.node for role in ROLES]
    assert {boundary["node"] for boundary in view["boundaries"]} == {"silicon", "foundry", "release"}
    with pytest.raises(PermissionError):
        mission_module.decide(local_services, target="mission", target_id=mission.mission_id, decision="approved", reason=None, actor=mission_module.agent_actor(_task(local_services, mission.mission_id, "rtl")))


def test_a_t0_mission_runs_end_to_end_with_people_approving(env, local_services, client, login, monkeypatch):
    selftest_roles(monkeypatch)
    engineer, approver = login("engineer"), login("approver")
    created = client.post("/api/missions", headers=engineer, json={"kind": "t0-closure"})
    assert created.status_code == 201 and created.json()["mission"]["status"] == "pending_launch" and created.json()["mission"]["model_route"] == "local"
    assert client.post("/api/missions", headers=engineer, json={"kind": "t0-closure", "route": "hosted"}).status_code == 403
    assert client.post("/api/missions", headers=login("viewer"), json={"kind": "t0-closure"}).status_code == 403

    mission = mission_module.create_mission(local_services, "t0-closure", actor=ENGINEER, route="scripted")
    inbox = client.get("/api/approvals", headers=login("viewer")).json()["approvals"]
    assert any(item["id"] == str(mission.mission_id) and item["subject"] == "launch" for item in inbox)
    assert client.post("/api/approvals", headers=engineer, json={"target": "mission", "id": str(mission.mission_id), "decision": "approved"}).status_code == 403
    launched = client.post("/api/approvals", headers=approver, json={"target": "mission", "id": str(mission.mission_id), "decision": "approved", "reason": "go"})
    assert launched.status_code == 200 and launched.json()["decision"]["status"] == "running"

    before = head_seq(local_services)
    after_run = mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(local_services))
    assert after_run.status == "awaiting_approval"
    states = {task.node: task.state for task in mission_module._tasks(local_services, mission.mission_id)}
    assert states == {**{role.node: "ACCEPTED" for role in ROLES}, "evidence": "REVIEW_REQUIRED"}
    review = next(item for item in client.get("/api/approvals", headers=login("viewer")).json()["approvals"] if item.get("mission_id") == str(mission.mission_id))
    assert review["subject"] == "review" and review["node"] == "evidence" and review["rule"] == "review.evidence_bundle"

    accepted = client.post("/api/approvals", headers=approver, json={"target": "task", "id": review["id"], "decision": "approved", "reason": "bundle reviewed"})
    assert accepted.status_code == 200 and accepted.json()["decision"]["mission_status"] == "completed"
    assert client.post("/api/approvals", headers=approver, json={"target": "task", "id": review["id"], "decision": "approved"}).status_code == 409

    view = client.get(f"/api/missions/{mission.mission_id}", headers=login("viewer")).json()["mission"]
    assert view["status"] == "completed" and view["bundle_sha256"]
    bundle = json.loads(local_services.artifacts.path_for(view["bundle_sha256"]).read_text())
    assert bundle["decision"] == "hold" and len(bundle["gates"]) == 7 and {b["node"] for b in bundle["boundaries"]} == {"silicon", "foundry", "release"}
    assert all(gate["state"] == "ACCEPTED" for gate in bundle["gates"])
    rtl_gate = next(gate for gate in bundle["gates"] if gate["node"] == "rtl")
    assert rtl_gate["runs"] and rtl_gate["runs"][0]["tool"] == "platform.selftest" and rtl_gate["evidence_class"] == "modeled"
    assert bundle["evidence_class"] == "planned", "the bundle is only as strong as its weakest gate"
    assert view["usage"]["calls"] == 16 and view["usage"]["tokens"] > 0

    # Exit criterion: every model call and tool call is in the mission's trace, with the tool runs it started.
    trace = client.get(f"/api/audit/traces/{mission.trace_id}", headers=login("viewer")).json()["events"]
    in_trace = {(event["feature"], event["action"]) for event in trace}
    mission_events = [
        event for event in events_since(local_services, before)
        if event["feature"] in ("agent.task", "agent.mission", "evidence.bundle", "approval.decide", "budget.limit") and event["action"] != "http_request"
    ]
    assert mission_events and all(event["trace_id"] == mission.trace_id for event in mission_events)
    assert len(find(trace, feature="agent.task", action="llm_call")) == 16
    tool_calls = find(trace, feature="agent.task", action="tool_call")
    queued = find(trace, feature="run.lifecycle", action="queued")
    assert len(queued) == 3 and {event["parent_event_id"] for event in queued} <= {event["event_id"] for event in tool_calls}
    for action in ("finished", "outputs_recorded"):
        assert len(find(trace, feature="run.lifecycle", action=action)) == 3
    assert {("agent.mission", "created"), ("agent.mission", "launched"), ("agent.mission", "completed"), ("approval.decide", "approved"),
            ("evidence.bundle", "artifact_written"), ("agent.task", "accepted")} <= in_trace
    for run in mission_module.mission_runs(local_services, after_run):
        assert compare_with_record(local_services, run.run_id)["consistent"]
    llm = find(trace, feature="agent.task", action="llm_call")[0]
    assert local_services.artifacts.exists(llm["input_hash"].split(":")[1]) and local_services.artifacts.exists(llm["output_hash"].split(":")[1])
    assert llm["cost"]["tokens_in"] > 0 and llm["actor"]["type"] == "agent"


def test_rejecting_the_bundle_needs_a_reason_and_ends_the_mission(local_services, monkeypatch):
    selftest_roles(monkeypatch)
    mission = launched_mission(local_services)
    mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(local_services))
    review = evidence_task(local_services, mission.mission_id)
    with pytest.raises(ValueError, match="reason"):
        mission_module.decide(local_services, target="task", target_id=review.task_id, decision="rejected", reason=" ", actor=APPROVER)
    result = mission_module.decide(local_services, target="task", target_id=review.task_id, decision="rejected", reason="gates incomplete", actor=APPROVER)
    assert result["state"] == "REJECTED" and result["mission_status"] == "rejected"
    with local_services.db.read() as session:
        assert "gates incomplete" in session.get(Mission, mission.mission_id).error


def test_a_plan_outside_the_allowlist_is_denied_and_halts_the_mission(local_services):
    mission = launched_mission(local_services)
    rogue = lambda system, prompt, schema: {"summary": "x", "steps": [{"tool": "physical.orfs", "purpose": "not mine", "params": {}}], "risks": []}
    seq = head_seq(local_services)
    after = mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(local_services, rogue))
    contract = _task(local_services, mission.mission_id, "contract")
    assert after.status == "halted" and contract.state == "NEEDS_WORK" and "plan.tool_allowlist" in contract.halt_reason
    denial = find(events_since(local_services, seq), feature="agent.task", action="policy_decision", result="denied")
    assert denial and denial[0]["policy_decision"]["rule"] == "plan.tool_allowlist"
    assert find(events_since(local_services, seq), feature="agent.mission", action="halted")


def test_an_identical_tool_step_is_not_run_twice(local_services, monkeypatch):
    selftest_roles(monkeypatch)
    mission = launched_mission(local_services)
    again = [{"tool": "platform.selftest", "purpose": "again", "params": {}}]
    twice = lambda system, prompt, schema: answer(system, prompt, schema, extra_steps=again if "platform.selftest" in json.dumps(schema) else [])
    mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(local_services, twice))
    steps = mission_module.mission_view(local_services, mission.mission_id)["tasks"][3]["evidence"]["steps"]
    runs = [step for step in steps if step["tool"] == "platform.selftest"]
    assert len(runs) == 2 and runs[1]["duplicate_of"] == runs[0]["step"] and runs[1]["run_id"] == runs[0]["run_id"]
    assert len(mission_module.mission_runs(local_services, mission)) == 3, "one run per tool node, none repeated"
    rtl = next(task for task in mission_module.mission_view(local_services, mission.mission_id)["tasks"] if task["node"] == "rtl")
    assert sum(1 for check in rtl["check"]["deterministic"] if check["check"].startswith("platform.selftest run")) == 1


def test_a_planned_write_outside_the_worktree_is_refused_before_any_file_changes(local_services, monkeypatch):
    target = local_services.settings.repo_root / "rtl" / "aimem_t0_channel.sv"
    original = target.read_bytes()
    mission = launched_mission(local_services)
    escape = lambda *args: answer(*args, note_path="../../../../rtl/aimem_t0_channel.sv")
    after = mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(local_services, escape))
    contract = _task(local_services, mission.mission_id, "contract")
    assert after.status == "halted" and contract.state == "NEEDS_WORK" and "refused" in contract.halt_reason
    assert target.read_bytes() == original


def test_a_budget_ceiling_stops_the_call_before_it_is_made(local_services):
    tight = build_services(local_services.settings.model_copy(update={"task_max_tokens": 50}))
    try:
        mission = launched_mission(tight)
        calls = []
        seq = head_seq(tight)
        after = mission_module.advance(tight, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(tight, lambda *args: calls.append(1) or answer(*args)))
        contract = _task(tight, mission.mission_id, "contract")
        assert calls == [] and after.status == "halted" and "BudgetExceeded" in contract.halt_reason
        events = events_since(tight, seq)
        hit = find(events, feature="budget.limit", action="limit_hit")
        assert hit and hit[0]["details"]["breaches"][0]["scope"] == "task_tokens" and find(events, feature="budget.limit", action="run_halted")
        assert not find(events, feature="agent.task", action="llm_call")
    finally:
        tight.close()


def test_an_unreachable_model_stops_the_task_with_the_reason(local_services):
    mission = launched_mission(local_services)
    from aimem_platform.agents.gateway import ModelGateway

    offline = OllamaProvider("http://ollama.test", "m", context_tokens=1, think=None, timeout=5, transport=httpx.MockTransport(lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused"))))
    seq = head_seq(local_services)
    after = mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=ModelGateway(local_services, "local", offline, model="m"))
    assert after.status == "halted" and "not reachable" in _task(local_services, mission.mission_id, "contract").halt_reason
    failed = find(events_since(local_services, seq), feature="agent.task", action="llm_call", result="error")
    assert failed and failed[0]["details"]["retryable"] is True


def test_only_one_worker_advances_a_mission_at_a_time(local_services, monkeypatch):
    from sqlalchemy import func, select

    import hashlib

    mission = launched_mission(local_services)
    key = int.from_bytes(hashlib.sha256(b"aimem-mission:" + mission.mission_id.bytes).digest()[:8], "big", signed=True)
    calls = []
    with local_services.db.engine.connect() as other_worker:
        assert other_worker.execute(select(func.pg_try_advisory_lock(key))).scalar()
        result = mission_module.advance(local_services, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(local_services, lambda *a: calls.append(1) or answer(*a)))
        other_worker.execute(select(func.pg_advisory_unlock(key)))
    assert result.status == "running" and calls == [] and _task(local_services, mission.mission_id, "contract").state == "CREATED"


def test_boundary_nodes_never_get_tasks(local_services):
    mission = mission_module.create_mission(local_services, "t0-closure", actor=ENGINEER, route="scripted")
    nodes = {task.node for task in mission_module._tasks(local_services, mission.mission_id)}
    assert nodes.isdisjoint(policy.BOUNDARY_NODES) and len(nodes) == 8
    with pytest.raises(ValueError):
        mission_module.create_mission(local_services, "x1-production", actor=ENGINEER, route="scripted")
    with pytest.raises(PermissionError):
        mission_module.create_mission(local_services, "t0-closure", actor=ENGINEER, route="hosted")
