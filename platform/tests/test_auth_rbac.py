from __future__ import annotations

from sqlalchemy import select

from aimem_platform.models import AuditEvent
from aimem_platform.ratelimit import SlidingWindowLimiter

from conftest import events_since, find, head_seq


def test_login_sets_an_httponly_cookie_and_attributes_the_request(client, env, services):
    before = head_seq(services)
    response = client.post("/api/auth/login", json={"email": env.emails["viewer"], "password": env.passwords["viewer"]})
    assert response.status_code == 200
    assert "token" not in response.json(), "browsers get the cookie only"
    cookie = response.headers["set-cookie"]
    assert "aimem_session=" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie
    events = events_since(services, before)
    login = find(events, feature="auth.session", action="login")
    request = find(events, feature="auth.session", action="http_request")
    assert login and login[0]["actor"]["id"] == env.emails["viewer"]
    assert request and request[0]["actor"]["id"] == env.emails["viewer"] and request[0]["result"] == "ok"
    assert login[0]["trace_id"] == request[0]["trace_id"], "domain and request events share the request trace"
    me = client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["user"]["role"] == "viewer"


def test_failed_logins_are_logged_with_the_real_reason_but_a_generic_response(client, env, services):
    before = head_seq(services)
    wrong = client.post("/api/auth/login", json={"email": env.emails["viewer"], "password": "definitely-wrong-password"})
    unknown = client.post("/api/auth/login", json={"email": "nobody@aimem.test", "password": "whatever-password"})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    failures = find(events_since(services, before), feature="auth.session", action="login_failed")
    assert [event["details"]["reason"] for event in failures] == ["wrong_password", "unknown_email"]
    assert all(event["result"] == "denied" for event in failures)


def test_login_rate_limit_is_enforced_and_logged(client, env, services):
    services.login_limiter = SlidingWindowLimiter(2)
    before = head_seq(services)
    statuses = [
        client.post("/api/auth/login", json={"email": env.emails["viewer"], "password": "wrong-password-123"}).status_code
        for _ in range(3)
    ]
    assert statuses == [401, 401, 429]
    reasons = [event["details"]["reason"] for event in find(events_since(services, before), feature="auth.session", action="login_failed")]
    assert reasons == ["wrong_password", "wrong_password", "rate_limited"]


def test_role_checks_record_policy_decisions(client, login, services):
    before = head_seq(services)
    anonymous = client.get("/api/audit/events")
    viewer = client.post("/api/audit/verify", headers=login("viewer"))
    assert anonymous.status_code == 401 and viewer.status_code == 403
    requests = [
        event
        for event in events_since(services, before)
        if event["action"] == "http_request" and event["feature"] in {"audit.query", "audit.verify_chain"}
    ]
    anonymous_event, viewer_event = requests[0], requests[-1]
    assert anonymous_event["result"] == "denied"
    assert anonymous_event["policy_decision"] == [{"rule": "rbac.authenticated", "decision": "deny", "required_role": "viewer", "actual_role": None}]
    assert viewer_event["result"] == "denied"
    assert viewer_event["policy_decision"][-1] == {"rule": "rbac.min_role", "decision": "deny", "required_role": "admin", "actual_role": "viewer"}
    allowed = client.get("/api/audit/events?limit=1", headers=login("viewer"))
    assert allowed.status_code == 200


def test_logout_revokes_the_session(client, login, services):
    headers = login("engineer")
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    before = head_seq(services)
    assert client.post("/api/auth/logout", headers=headers).json() == {"signed_out": True}
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert find(events_since(services, before), feature="auth.session", action="logout")


def test_user_administration_is_audited(client, login, services, env):
    admin = login("admin")
    before = head_seq(services)
    created = client.post(
        "/api/users",
        headers=admin,
        json={"email": "New.Person@AIMEM.test", "role": "engineer", "password": "a-long-enough-password"},
    )
    assert created.status_code == 201, created.text
    user = created.json()["user"]
    assert user["email"] == "new.person@aimem.test"
    duplicate = client.post("/api/users", headers=admin, json={"email": "new.person@aimem.test", "password": "a-long-enough-password"})
    assert duplicate.status_code == 409
    short = client.post("/api/users", headers=admin, json={"email": "short@aimem.test", "password": "short"})
    assert short.status_code == 422
    patched = client.patch(f"/api/users/{user['user_id']}", headers=admin, json={"role": "approver", "is_active": False})
    assert patched.status_code == 200 and patched.json()["user"]["role"] == "approver"
    events = events_since(services, before)
    assert find(events, feature="auth.user", action="created", details__email="new.person@aimem.test")
    assert find(events, feature="auth.user", action="failed", details__reason="email_exists")
    updated = find(events, feature="auth.user", action="updated")
    assert updated[0]["details"]["before"] == {"role": "engineer", "is_active": True}
    assert updated[0]["details"]["after"] == {"role": "approver", "is_active": False}

    admin_id = client.get("/api/auth/me", headers=admin).json()["user"]["user_id"]
    assert client.patch(f"/api/users/{admin_id}", headers=admin, json={"role": "viewer"}).status_code == 409


def test_passwords_never_reach_the_audit_log(client, env, services, login):
    login("admin")
    client.post("/api/auth/login", json={"email": env.emails["viewer"], "password": "leaky-wrong-password"})
    secrets_to_find = [*env.passwords.values(), "leaky-wrong-password", "a-long-enough-password"]
    with services.db.read() as session:
        rows = session.scalars(select(AuditEvent)).all()
        blobs = [" ".join(filter(None, (row.details_json, row.error, row.target_id, row.policy_json))) for row in rows]
    for secret in secrets_to_find:
        assert not any(secret in blob for blob in blobs), "a password was written to the audit log"
