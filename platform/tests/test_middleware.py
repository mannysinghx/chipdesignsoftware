from __future__ import annotations

import secrets

from fastapi import APIRouter

from conftest import events_since, find, head_seq


def last_request(services, before: int) -> dict:
    requests = [event for event in events_since(services, before) if event["action"] == "http_request"]
    assert len(requests) == 1, requests
    return requests[0]


def test_every_request_is_logged_under_its_route_feature(client, services):
    before = head_seq(services)
    assert client.get("/api/health").status_code == 200
    event = last_request(services, before)
    assert event["feature"] == "system.health" and event["result"] == "ok"
    assert event["details"]["route"] == "/api/health" and event["details"]["status"] == 200
    assert event["cost"]["wall_ms"] >= 0
    assert event["actor"]["type"] == "anonymous"


def test_unrouted_preflight_and_wrong_method_requests_are_logged(client, services):
    before = head_seq(services)
    assert client.get("/api/definitely-not-here").status_code == 404
    assert last_request(services, before)["feature"] == "api.unrouted"

    before = head_seq(services)
    preflight = client.options(
        "/api/audit/events", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"}
    )
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert last_request(services, before)["feature"] == "api.preflight"

    before = head_seq(services)
    assert client.delete("/api/health").status_code == 405
    event = last_request(services, before)
    assert event["feature"] == "system.health" and event["result"] == "error"


def test_incoming_traceparent_is_propagated_to_events_and_response(client, services):
    trace_id = secrets.token_hex(16)
    before = head_seq(services)
    response = client.get("/api/features", headers={"traceparent": f"00-{trace_id}-{secrets.token_hex(8)}-01"})
    assert response.headers["x-aimem-trace-id"] == trace_id
    assert last_request(services, before)["trace_id"] == trace_id


def test_unhandled_exceptions_are_logged_with_a_traceback(env, services):
    from fastapi.testclient import TestClient

    from aimem_platform.app import create_app
    from aimem_platform.deps import feature

    app = create_app(env.settings, services=services)
    boom = APIRouter()

    @boom.get("/api/boom", openapi_extra=feature("system.health"))
    def explode() -> dict:
        raise KeyError("kaboom")

    app.include_router(boom)
    with TestClient(app, raise_server_exceptions=False) as client:
        before = head_seq(services)
        assert client.get("/api/boom").status_code == 500
    event = find(events_since(services, before), action="http_request")[0]
    assert event["result"] == "error" and event["details"]["status"] == 500
    assert "KeyError: 'kaboom'" in event["error"]
