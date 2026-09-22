"""Browser event ingestion.

The Studio UI records every interaction locally and flushes batches here. Each
accepted event becomes its own audit row under its ui.* feature, attributed to
the signed-in user (or to an anonymous browser session when that is allowed).
Event ids are client-generated UUIDs, so retries are idempotent.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ..audit.canonical import dumps_canonical, sanitize
from ..audit.context import ActorRef, current_context, new_span_id
from ..audit.writer import AuditValidationError
from ..deps import CurrentUser, feature, get_services, optional_user
from ..features import UndeclaredActionError, UnknownFeatureError
from ..services import Services

router = APIRouter(prefix="/api/events", tags=["events"])

MAX_BODY_BYTES = 2 * 1024 * 1024
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
BUILD_RE = re.compile(r"^[A-Za-z0-9._:+-]{1,64}$")
CLIENT_RESULTS = frozenset({"ok", "error", "info"})
MAX_ID_CHARS = 300


class Rejection(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _uuid(value: object, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise Rejection(f"invalid_{field}") from None


def _client_ts(value: object) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        raise Rejection("invalid_client_ts") from None
    if parsed.tzinfo is None:
        raise Rejection("invalid_client_ts")
    return parsed


def _prepare(services: Services, raw: object, *, actor: ActorRef, session_id: str) -> dict:
    if not isinstance(raw, dict):
        raise Rejection("not_an_object")
    feature_id, action = raw.get("feature"), raw.get("action")
    if not isinstance(feature_id, str) or not isinstance(action, str):
        raise Rejection("missing_feature_or_action")
    try:
        feature_def = services.registry.require(feature_id, action)
    except UnknownFeatureError:
        raise Rejection("unknown_feature") from None
    except UndeclaredActionError:
        raise Rejection("undeclared_action") from None
    if feature_def.kind != "ui":
        raise Rejection("not_a_ui_feature")

    details = raw.get("details") or {}
    if not isinstance(details, dict):
        raise Rejection("details_not_an_object")
    details = {**sanitize(details), "ui_session_id": session_id}
    if len(dumps_canonical(details).encode("utf-8")) > services.settings.max_ui_details_bytes:
        raise Rejection("details_too_large")

    target = raw.get("target")
    target_pair = None
    if target is not None:
        if not isinstance(target, dict) or not isinstance(target.get("type"), str) or not isinstance(target.get("id"), str):
            raise Rejection("invalid_target")
        if len(target["type"]) > MAX_ID_CHARS or len(target["id"]) > MAX_ID_CHARS:
            raise Rejection("invalid_target")
        target_pair = (target["type"], target["id"])

    trace_id = raw.get("trace_id")
    if trace_id is not None and (not isinstance(trace_id, str) or not TRACE_ID_RE.match(trace_id) or trace_id == "0" * 32):
        raise Rejection("invalid_trace_id")
    result = raw.get("result", "ok")
    if result not in CLIENT_RESULTS:
        raise Rejection("invalid_result")
    error = raw.get("error")
    if error is not None and not isinstance(error, str):
        raise Rejection("invalid_error")
    parent = raw.get("parent_event_id")

    try:
        return services.writer.prepare(
            feature=feature_id,
            action=action,
            result=result,
            actor=actor,
            source="ui",
            target=target_pair,
            details=details,
            error=error[:20_000] if error else None,
            event_id=_uuid(raw.get("event_id"), "event_id"),
            parent_event_id=_uuid(parent, "parent_event_id") if parent else None,
            trace_id=trace_id,
            span_id=new_span_id(),
            client_ts=_client_ts(raw.get("client_ts")),
        )
    except AuditValidationError as exc:
        raise Rejection(f"invalid_event: {exc}") from None


def _ingest(services: Services, payload: object, user: CurrentUser | None, client_ip: str | None) -> dict:
    context = current_context()
    if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
        raise HTTPException(422, "Body must be an object with an 'events' list")
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not SESSION_ID_RE.match(session_id):
        raise HTTPException(422, "session_id must be 8-64 letters, digits, or dashes")
    build = payload.get("app_build")
    build = build if isinstance(build, str) and BUILD_RE.match(build) else None
    events = payload["events"]
    if len(events) > services.settings.max_ui_batch:
        raise HTTPException(413, f"At most {services.settings.max_ui_batch} events per batch")

    if user is not None:
        actor = ActorRef("human", user.email, f"ui@{build}" if build else "ui", authenticated=True, role=user.role)
    elif services.settings.allow_anonymous_ui_events:
        actor = ActorRef("anonymous", f"browser:{session_id}", f"ui@{build}" if build else "ui")
    else:
        if context is not None:
            context.policy_decisions.append({"rule": "ui.anonymous_events", "decision": "deny"})
        raise HTTPException(401, "Sign in to record browser events")

    limiter_key = user.email if user else f"ip:{client_ip}"
    if not services.ui_limiter.allow(limiter_key, cost=max(1, len(events))):
        if context is not None:
            context.policy_decisions.append({"rule": "ui.rate_limit", "decision": "deny", "events": len(events)})
        raise HTTPException(429, "Too many browser events; they stay buffered in the page and will be retried")

    rows, rejected = [], []
    for index, raw in enumerate(events):
        try:
            rows.append(_prepare(services, raw, actor=actor, session_id=session_id))
        except Rejection as rejection:
            event_id = raw.get("event_id") if isinstance(raw, dict) else None
            rejected.append({"index": index, "event_id": event_id, "reason": rejection.reason})

    written = []
    if rows:
        with services.db.transaction() as session:
            written = services.writer.append_rows(session, rows, skip_existing=True)
    summary = {
        "received": len(events),
        "accepted": len(written),
        "duplicates": len(rows) - len(written),
        "rejected": len(rejected),
        "ui_session_id": session_id,
    }
    if context is not None:
        context.notes["ui_batch"] = summary
    return {**summary, "rejections": rejected, "head_seq": written[-1]["seq"] if written else None}


@router.post("/ui", openapi_extra=feature("ui.ingest"))
async def ingest_ui_events(
    request: Request,
    user: CurrentUser | None = Depends(optional_user),
    services: Services = Depends(get_services),
) -> dict:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(413, "Batch too large")
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(413, "Batch too large")
    # The browser sends text/plain so the POST is a CORS simple request (no preflight per flush).
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "Body must be JSON") from None
    client_ip = request.client.host if request.client else None
    return await run_in_threadpool(_ingest, services, payload, user, client_ip)
