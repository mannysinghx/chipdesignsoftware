from __future__ import annotations

import json
import secrets
import uuid

from conftest import events_since, find, head_seq


def ui_event(feature: str, action: str, **extra) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "feature": feature,
        "action": action,
        "client_ts": "2026-09-22T22:15:00.123Z",
        "trace_id": secrets.token_hex(16),
        "details": {"view": "twin"},
        **extra,
    }


def post(client, events, *, session_id="browser-session-1", headers=None, as_text=True):
    body = json.dumps({"session_id": session_id, "app_build": "0.1.0", "events": events})
    return client.post(
        "/api/events/ui",
        content=body,
        headers={"content-type": "text/plain;charset=UTF-8" if as_text else "application/json", **(headers or {})},
    )


def test_anonymous_batches_are_stored_and_retries_are_idempotent(client, services):
    click = ui_event("ui.interaction", "click", target={"type": "control", "id": "Export evidence"})
    view = ui_event("ui.view", "changed", parent_event_id=click["event_id"], trace_id=click["trace_id"], details={"from": "twin", "to": "x1"})
    before = head_seq(services)
    response = post(client, [click, view])
    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 2 and response.json()["rejected"] == 0
    retry = post(client, [click, view])
    assert retry.json()["accepted"] == 0 and retry.json()["duplicates"] == 2

    events = events_since(services, before)
    stored = [event for event in events if event["source"] == "ui"]
    assert [event["event_id"] for event in stored] == [click["event_id"], view["event_id"]]
    assert stored[0]["actor"] == {"type": "anonymous", "id": "browser:browser-session-1", "version": "ui@0.1.0", "authenticated": False}
    assert stored[1]["parent_event_id"] == click["event_id"] and stored[1]["trace_id"] == click["trace_id"]
    assert stored[0]["client_ts"] == "2026-09-22T22:15:00.123000Z"
    assert stored[0]["details"]["ui_session_id"] == "browser-session-1"
    batches = find(events, feature="ui.ingest", action="http_request")
    assert batches[0]["details"]["ui_batch"]["accepted"] == 2
    assert batches[1]["details"]["ui_batch"]["duplicates"] == 2


def test_signed_in_batches_are_attributed_to_the_user(client, login, services, env):
    before = head_seq(services)
    assert post(client, [ui_event("ui.param", "edited")], headers=login("engineer"), as_text=False).status_code == 200
    stored = [event for event in events_since(services, before) if event["source"] == "ui"]
    assert stored[0]["actor"]["id"] == env.emails["engineer"] and stored[0]["actor"]["authenticated"] is True


def test_invalid_events_are_rejected_individually(client, services):
    good = ui_event("ui.export", "exported")
    batch = [
        good,
        ui_event("ui.made_up", "click"),
        ui_event("ui.view", "exploded"),
        ui_event("ui.ingest", "http_request"),
        {**ui_event("ui.view", "changed"), "event_id": "not-a-uuid"},
        ui_event("ui.view", "changed", details={"blob": "x" * 20_000}),
        ui_event("ui.view", "changed", trace_id="XYZ"),
        ui_event("ui.view", "changed", result="denied"),
        "not an object",
    ]
    response = post(client, batch)
    body = response.json()
    assert body["accepted"] == 1
    assert [item["reason"] for item in body["rejections"]] == [
        "unknown_feature",
        "undeclared_action",
        "not_a_ui_feature",
        "invalid_event_id",
        "details_too_large",
        "invalid_trace_id",
        "invalid_result",
        "not_an_object",
    ]


def test_batch_shape_is_validated(client):
    assert post(client, [], session_id="x").status_code == 422
    too_many = [ui_event("ui.view", "changed") for _ in range(201)]
    assert post(client, too_many).status_code == 413
    assert client.post("/api/events/ui", content=b"{not json", headers={"content-type": "text/plain"}).status_code == 400


def test_anonymous_events_can_be_disabled(env, services):
    from fastapi.testclient import TestClient

    from aimem_platform.app import create_app

    settings = env.settings.model_copy(update={"allow_anonymous_ui_events": False})
    services.settings = settings
    with TestClient(create_app(settings, services=services)) as client:
        assert post(client, [ui_event("ui.view", "changed")]).status_code == 401
