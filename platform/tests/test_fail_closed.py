"""When the audit log cannot be written, actions are refused or flagged; they never happen silently."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from aimem_platform.app import create_app
from aimem_platform.audit.writer import AuditUnavailableError, audited_step
from aimem_platform.services import build_services

from conftest import events_since, find, head_seq


class Broken(RuntimeError):
    pass


def break_after(writer, calls_allowed: int):
    real = writer.commit_event
    state = {"calls": 0}

    def flaky(db, **fields):
        state["calls"] += 1
        if state["calls"] > calls_allowed:
            raise Broken("database unavailable")
        return real(db, **fields)

    writer.commit_event = flaky
    return state


def test_step_does_not_run_when_the_started_event_cannot_be_written(services):
    break_after(services.writer, 0)
    ran = []
    with pytest.raises(AuditUnavailableError):
        with audited_step(services.db, services.writer, feature="cli.command"):
            ran.append(True)
    assert ran == []


def test_step_failure_is_recorded_with_its_traceback(services):
    before = head_seq(services)
    with pytest.raises(ZeroDivisionError):
        with audited_step(services.db, services.writer, feature="cli.command", details={"command": "divide"}):
            1 / 0
    events = events_since(services, before)
    assert [event["action"] for event in events] == ["started", "failed"]
    failed = events[1]
    assert failed["result"] == "error"
    assert "ZeroDivisionError" in failed["error"] and "Traceback" in failed["error"]
    assert failed["parent_event_id"] == events[0]["event_id"]
    assert failed["trace_id"] == events[0]["trace_id"]


def test_step_that_ran_but_could_not_be_logged_goes_to_the_fallback_log(services):
    break_after(services.writer, 1)
    with pytest.raises(AuditUnavailableError):
        with audited_step(services.db, services.writer, feature="cli.command", details={"command": "fallback-probe"}):
            pass
    lines = services.writer.fallback_path.read_text().strip().splitlines()
    record = json.loads(lines[-1])
    assert record["event"]["action"] == "finished"
    assert record["event"]["details"]["command"] == "fallback-probe"
    assert "database unavailable" in record["audit_error"]


def test_responses_are_withheld_when_the_request_event_cannot_be_written(env):
    services = build_services(env.settings)
    app = create_app(env.settings, services=services)
    with TestClient(app) as client:
        assert client.get("/api/features").status_code == 200
        break_after(services.writer, 0)
        response = client.get("/api/features")
    assert response.status_code == 503
    assert response.json()["error"] == "audit_unavailable"
    assert "features" not in response.json()


def test_the_service_refuses_to_start_without_its_audit_log(env):
    services = build_services(env.settings)
    break_after(services.writer, 0)
    app = create_app(env.settings, services=services)
    with pytest.raises(RuntimeError, match="refuses to start"):
        with TestClient(app):
            pass
    services.close()


def test_health_reports_fallback_events_as_degraded(client, services):
    services.writer.fallback_path.parent.mkdir(parents=True, exist_ok=True)
    before = services.writer.fallback_count()
    with services.writer.fallback_path.open("a") as handle:
        handle.write('{"probe": true}\n')
    body = client.get("/api/health").json()
    assert body["fallback_events"] == before + 1
    assert body["status"] == "degraded"
    assert find(events_since(services, head_seq(services) - 1), feature="system.health", action="http_request")
