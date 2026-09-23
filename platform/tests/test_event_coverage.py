"""CI gate: every registered feature emits every action it declares.

Each feature in features.yaml needs a scenario here that drives the real system
(HTTP API, CLI, migrations, service lifecycle). Adding a feature without a
scenario fails test_every_feature_has_a_scenario; a scenario that stops
emitting a declared action fails test_every_required_action_is_emitted.

ui.* scenarios submit events through the real ingestion endpoint. Emission by
the actual browser is checked separately by scripts/ui-audit-smoke.mjs.
"""

from __future__ import annotations

import hashlib
import io
import json
import secrets
import uuid
from dataclasses import dataclass, field
from typing import Callable

import pytest
from fastapi.testclient import TestClient

from aimem_platform import cli
from aimem_platform.agents import mission as missions
from aimem_platform.app import create_app
from aimem_platform.audit.context import ActorRef
from aimem_platform.operations import coverage_report
from aimem_platform.runs.reproduce import reproduce_run
from aimem_platform.runs.runners import LocalRunner
from aimem_platform.runs.service import run_worker, toolchains_for
from aimem_platform.services import Services, build_services

from agents_support import APPROVER, evidence_task, launched_mission, scripted_gateway, selftest_roles
from conftest import PlatformEnv, events_since, head_seq, upgrade


@dataclass
class Ctx:
    client: TestClient
    login: Callable[[str], dict]
    services: Services
    env: PlatformEnv
    monkeypatch: pytest.MonkeyPatch
    cache: dict = field(default_factory=dict)


def ui(ctx: Ctx, feature_id: str) -> None:
    feature = ctx.services.registry.get(feature_id)
    events = [
        {"event_id": str(uuid.uuid4()), "feature": feature_id, "action": action, "trace_id": secrets.token_hex(16), "details": {"scenario": True}}
        for action in feature.events
    ]
    body = json.dumps({"session_id": "coverage-scenario", "events": events})
    response = ctx.client.post("/api/events/ui", content=body, headers={"content-type": "text/plain"})
    assert response.status_code == 200 and response.json()["accepted"] == len(events), response.text


def lifecycle(ctx: Ctx) -> None:
    services = build_services(ctx.env.settings)
    with TestClient(create_app(ctx.env.settings, services=services)) as client:
        assert client.get("/api/health").status_code == 200


def migrate(ctx: Ctx) -> None:
    upgrade(ctx.env.owner_url)


def cli_command(ctx: Ctx) -> None:
    ctx.monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert cli.main(["tail", "--limit", "1"], settings=ctx.env.settings) == 0


def health(ctx: Ctx) -> None:
    assert ctx.client.get("/api/health").status_code == 200


def registry(ctx: Ctx) -> None:
    assert ctx.client.get("/api/features").status_code == 200


def docs(ctx: Ctx) -> None:
    assert ctx.client.get("/api/openapi.json").status_code == 200
    assert ctx.client.get("/api/docs").status_code == 200


def unrouted(ctx: Ctx) -> None:
    assert ctx.client.get("/api/no-such-route").status_code == 404


def preflight(ctx: Ctx) -> None:
    response = ctx.client.options("/api/events/ui", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    assert response.status_code == 200


def ingest(ctx: Ctx) -> None:
    ui(ctx, "ui.view")


def session(ctx: Ctx) -> None:
    ctx.client.post("/api/auth/login", json={"email": ctx.env.emails["viewer"], "password": "not-the-password"})
    headers = ctx.login("viewer")
    assert ctx.client.post("/api/auth/logout", headers=headers).json()["signed_out"] is True


def users(ctx: Ctx) -> None:
    admin = ctx.login("admin")
    email = f"scenario-{uuid.uuid4().hex[:8]}@aimem.test"
    created = ctx.client.post("/api/users", headers=admin, json={"email": email, "password": "scenario-password-123"})
    assert created.status_code == 201
    user_id = created.json()["user"]["user_id"]
    assert ctx.client.patch(f"/api/users/{user_id}", headers=admin, json={"display_name": "Scenario"}).status_code == 200


def query(ctx: Ctx) -> None:
    headers = ctx.login("viewer")
    assert ctx.client.get("/api/audit/events?limit=5", headers=headers).status_code == 200
    assert ctx.client.get("/api/audit/summary", headers=headers).status_code == 200


def coverage(ctx: Ctx) -> None:
    assert ctx.client.get("/api/audit/coverage", headers=ctx.login("viewer")).status_code == 200


def verify(ctx: Ctx) -> None:
    assert ctx.client.post("/api/audit/verify", headers=ctx.login("admin")).json()["ok"] is True


def _artifact(ctx: Ctx) -> str:
    data = f"coverage scenario {uuid.uuid4()}".encode()
    response = ctx.client.post(
        "/api/artifacts",
        content=data,
        headers={**ctx.login("engineer"), "content-type": "text/plain", "x-artifact-name": "scenario.txt"},
    )
    assert response.status_code == 201
    return hashlib.sha256(data).hexdigest()


def artifact_write(ctx: Ctx) -> None:
    _artifact(ctx)


def artifact_read(ctx: Ctx) -> None:
    digest = _artifact(ctx)
    assert ctx.client.get(f"/api/artifacts/{digest}", headers=ctx.login("viewer")).status_code == 200


def artifact_list(ctx: Ctx) -> None:
    assert ctx.client.get("/api/artifacts", headers=ctx.login("viewer")).status_code == 200


def _completed_run(ctx: Ctx) -> str:
    created = ctx.client.post("/api/runs", headers=ctx.login("engineer"), json={"adapter": "platform.selftest"})
    assert created.status_code == 201, created.text
    run_worker(ctx.services, LocalRunner(), once=True)
    return created.json()["run"]["run_id"]


def run_catalog(ctx: Ctx) -> None:
    assert ctx.client.get("/api/adapters", headers=ctx.login("viewer")).status_code == 200


def run_submit(ctx: Ctx) -> None:
    _completed_run(ctx)


def run_query(ctx: Ctx) -> None:
    run_id = _completed_run(ctx)
    viewer = ctx.login("viewer")
    assert ctx.client.get("/api/runs", headers=viewer).status_code == 200
    assert ctx.client.get(f"/api/runs/{run_id}", headers=viewer).status_code == 200
    assert ctx.client.get(f"/api/runs/{run_id}/log", headers=viewer).status_code == 200


def run_cancel(ctx: Ctx) -> None:
    engineer = ctx.login("engineer")
    created = ctx.client.post("/api/runs", headers=engineer, json={"adapter": "platform.selftest"})
    assert ctx.client.post(f"/api/runs/{created.json()['run']['run_id']}/cancel", headers=engineer).status_code == 200


def run_reconstruct(ctx: Ctx) -> None:
    run_id = _completed_run(ctx)
    assert ctx.client.get(f"/api/runs/{run_id}/reconstruction", headers=ctx.login("viewer")).json()["consistent"] is True


def evidence_query(ctx: Ctx) -> None:
    assert ctx.client.get("/api/evidence", headers=ctx.login("viewer")).status_code == 200


def run_lifecycle(ctx: Ctx) -> None:
    _completed_run(ctx)


def worker_lifecycle(ctx: Ctx) -> None:
    run_worker(ctx.services, LocalRunner(), once=True)


def run_reproduce(ctx: Ctx) -> None:
    run_id = _completed_run(ctx)
    actor = ActorRef("human", ctx.env.emails["engineer"], None, authenticated=True, role="engineer")
    assert reproduce_run(ctx.services, LocalRunner(), run_id, actor=actor)["identical"] is True


def mission_submit(ctx: Ctx) -> None:
    assert ctx.client.post("/api/missions", headers=ctx.login("engineer"), json={"kind": "t0-closure"}).status_code == 201


def mission_query(ctx: Ctx) -> None:
    viewer = ctx.login("viewer")
    listed = ctx.client.get("/api/missions", headers=viewer).json()["missions"]
    assert ctx.client.get(f"/api/missions/{listed[0]['mission_id']}", headers=viewer).status_code == 200


def approval_inbox(ctx: Ctx) -> None:
    assert ctx.client.get("/api/approvals", headers=ctx.login("viewer")).status_code == 200


def approval_decide(ctx: Ctx) -> None:
    engineer, approver = ctx.login("engineer"), ctx.login("approver")
    for decision in ("approved", "rejected"):
        mission_id = ctx.client.post("/api/missions", headers=engineer, json={"kind": "t0-closure"}).json()["mission"]["mission_id"]
        body = {"target": "mission", "id": mission_id, "decision": decision, "reason": "coverage scenario"}
        assert ctx.client.post("/api/approvals", headers=approver, json=body).status_code == 200


def completed_mission(ctx: Ctx) -> None:
    """One scripted mission, launched and accepted by people, covers agent.mission, agent.task, and evidence.bundle."""
    if "mission" in ctx.cache:
        return
    selftest_roles(ctx.monkeypatch)
    mission = launched_mission(ctx.services)
    missions.advance(ctx.services, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(ctx.services))
    missions.decide(ctx.services, target="task", target_id=evidence_task(ctx.services, mission.mission_id).task_id, decision="approved", reason="coverage", actor=APPROVER)
    ctx.cache["mission"] = missions.mission_view(ctx.services, mission.mission_id)
    assert ctx.cache["mission"]["status"] == "completed"


def budget_limit(ctx: Ctx) -> None:
    tight = build_services(ctx.env.settings.model_copy(update={"task_max_tokens": 50}))
    try:
        mission = launched_mission(tight)
        assert missions.advance(tight, mission.mission_id, runner=LocalRunner(), gateway=scripted_gateway(tight)).status == "halted"
    finally:
        tight.close()


class _PresentDocker:
    """Docker stand-in where every pinned toolchain is already installed."""

    def __init__(self, marker: str):
        self.marker = marker

    def run(self, *args, check=False, input_text=None):
        import subprocess

        stdout = self.marker if args[:1] == ("run",) else ""
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")


def toolchain_provision(ctx: Ctx) -> None:
    toolchains = toolchains_for(ctx.services)
    marker = next(iter(toolchains.bundles.values())).sha256
    result = toolchains.ensure(ctx.services, _PresentDocker(marker), allow_download=False)
    assert all(action["action"] == "present" for action in result["actions"])


SCENARIOS: dict[str, Callable[[Ctx], None]] = {
    "system.lifecycle": lifecycle,
    "system.migrate": migrate,
    "system.health": health,
    "feature.registry": registry,
    "api.docs": docs,
    "api.unrouted": unrouted,
    "api.preflight": preflight,
    "ui.ingest": ingest,
    "auth.session": session,
    "auth.user": users,
    "audit.query": query,
    "audit.coverage": coverage,
    "audit.verify_chain": verify,
    "artifact.write": artifact_write,
    "artifact.read": artifact_read,
    "artifact.list": artifact_list,
    "cli.command": cli_command,
    "run.catalog": run_catalog,
    "run.submit": run_submit,
    "run.query": run_query,
    "run.cancel": run_cancel,
    "run.reconstruct": run_reconstruct,
    "evidence.query": evidence_query,
    "run.lifecycle": run_lifecycle,
    "worker.lifecycle": worker_lifecycle,
    "run.reproduce": run_reproduce,
    "toolchain.provision": toolchain_provision,
    "mission.submit": mission_submit,
    "mission.query": mission_query,
    "approval.inbox": approval_inbox,
    "approval.decide": approval_decide,
    "agent.mission": completed_mission,
    "agent.task": completed_mission,
    "evidence.bundle": completed_mission,
    "budget.limit": budget_limit,
    **{feature_id: (lambda ctx, feature_id=feature_id: ui(ctx, feature_id)) for feature_id in (
        "ui.session", "ui.interaction", "ui.view", "ui.state", "ui.param",
        "ui.export", "ui.sweep", "ui.agent_replay", "ui.twin", "ui.error",
    )},
}


def test_every_feature_has_a_scenario(services):
    registered = {feature.id for feature in services.registry}
    assert set(SCENARIOS) == registered, {
        "features without a scenario": sorted(registered - set(SCENARIOS)),
        "scenarios for unregistered features": sorted(set(SCENARIOS) - registered),
    }


def test_every_required_action_is_emitted(client, login, services, env, monkeypatch):
    ctx = Ctx(client, login, services, env, monkeypatch)
    before = head_seq(services)
    for scenario in SCENARIOS.values():
        scenario(ctx)
    observed = {(event["feature"], event["action"]) for event in events_since(services, before)}
    missing = [f"{feature.id}.{action}" for feature in services.registry for action in feature.events if (feature.id, action) not in observed]
    assert not missing, f"declared actions never emitted: {missing}"

    report = coverage_report(services)
    assert report["undeclared"] == [], "the log contains actions that are not in features.yaml"
    assert report["coverage_percent"] == 100.0
