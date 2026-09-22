from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, not_, or_, select

from ..audit.canonical import GENESIS_HASH, format_ts
from ..audit.context import current_context
from ..audit.writer import audited_step
from ..deps import CurrentUser, feature, get_services, require_role
from ..models import AuditEvent
from ..operations import coverage_report, serialize_event, verify_and_anchor
from ..services import Services

router = APIRouter(prefix="/api/audit", tags=["audit"])
TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
# Transport and log-reading traffic. The Activity view hides these by default; they are still logged.
TRANSPORT_FEATURES = ("audit.query", "audit.coverage", "api.preflight", "ui.ingest", "system.health", "feature.registry", "api.docs")


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _feature_clause(value: str):
    """`ui.` or `ui.*` matches a prefix; anything else is an exact feature id."""
    value = value.strip()
    if value.endswith("*"):
        value = value[:-1]
    if value.endswith("."):
        return AuditEvent.feature.like(_like_escape(value) + "%", escape="\\")
    return AuditEvent.feature == value


@router.get("/events", openapi_extra=feature("audit.query"))
def list_events(
    feature_filter: str | None = Query(None, alias="feature", max_length=100),
    action: str | None = Query(None, max_length=64),
    actor: str | None = Query(None, max_length=300),
    actor_type: str | None = Query(None, max_length=16),
    result: str | None = Query(None, max_length=16),
    source: str | None = Query(None, max_length=16),
    trace_id: str | None = Query(None, max_length=32),
    target_id: str | None = Query(None, max_length=300),
    q: str | None = Query(None, max_length=200),
    exclude: str | None = Query(None, max_length=1000, description="Comma-separated feature ids or prefixes to hide"),
    hide_transport: bool = Query(False, description="Hide log reads, ingestion, health, and preflight traffic"),
    before_seq: int | None = Query(None, ge=1),
    after_seq: int | None = Query(None, ge=0),
    limit: int = Query(100, ge=1, le=500),
    _: CurrentUser = Depends(require_role("viewer")),
    services: Services = Depends(get_services),
) -> dict:
    clauses = []
    if feature_filter:
        clauses.append(_feature_clause(feature_filter))
    for column, value in (
        (AuditEvent.action, action),
        (AuditEvent.actor_id, actor),
        (AuditEvent.actor_type, actor_type),
        (AuditEvent.result, result),
        (AuditEvent.source, source),
        (AuditEvent.trace_id, trace_id),
        (AuditEvent.target_id, target_id),
    ):
        if value:
            clauses.append(column == value)
    excluded = [item for item in (exclude or "").split(",") if item.strip()]
    if hide_transport:
        excluded += list(TRANSPORT_FEATURES)
    if excluded:
        clauses.append(not_(or_(*[_feature_clause(item) for item in excluded])))
    if q:
        pattern = f"%{_like_escape(q)}%"
        clauses.append(
            or_(
                AuditEvent.details_json.ilike(pattern, escape="\\"),
                AuditEvent.error.ilike(pattern, escape="\\"),
                AuditEvent.target_id.ilike(pattern, escape="\\"),
                AuditEvent.actor_id.ilike(pattern, escape="\\"),
                AuditEvent.feature.ilike(pattern, escape="\\"),
                AuditEvent.action.ilike(pattern, escape="\\"),
            )
        )
    if before_seq is not None:
        clauses.append(AuditEvent.seq < before_seq)
    if after_seq is not None:
        clauses.append(AuditEvent.seq > after_seq)

    statement = select(AuditEvent).where(*clauses).order_by(AuditEvent.seq.desc()).limit(limit + 1)
    with services.db.read() as session:
        rows = session.scalars(statement).all()
    page = rows[:limit]
    context = current_context()
    if context is not None:
        context.notes["returned"] = len(page)
    return {
        "events": [serialize_event(row) for row in page],
        "next_before_seq": page[-1].seq if len(rows) > limit else None,
    }


@router.get("/events/{event_id}", openapi_extra=feature("audit.query"))
def get_event(event_id: uuid.UUID, _: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    with services.db.read() as session:
        row = session.get(AuditEvent, event_id)
    if row is None:
        raise HTTPException(404, "Event not found")
    return {"event": serialize_event(row)}


@router.get("/traces/{trace_id}", openapi_extra=feature("audit.query"))
def get_trace(trace_id: str, _: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    if not TRACE_ID_RE.match(trace_id):
        raise HTTPException(422, "trace_id must be 32 lowercase hex characters")
    with services.db.read() as session:
        rows = session.scalars(select(AuditEvent).where(AuditEvent.trace_id == trace_id).order_by(AuditEvent.seq).limit(2000)).all()
    return {"trace_id": trace_id, "events": [serialize_event(row) for row in rows]}


@router.get("/summary", openapi_extra=feature("audit.query"))
def summary(_: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    with services.db.read() as session:
        total = session.scalar(select(func.count()).select_from(AuditEvent)) or 0
        by_result = dict(session.execute(select(AuditEvent.result, func.count()).group_by(AuditEvent.result)).all())
        by_source = dict(session.execute(select(AuditEvent.source, func.count()).group_by(AuditEvent.source)).all())
        by_feature = dict(session.execute(select(AuditEvent.feature, func.count()).group_by(AuditEvent.feature)).all())
        head = session.execute(select(AuditEvent.seq, AuditEvent.hash, AuditEvent.ts).order_by(AuditEvent.seq.desc()).limit(1)).first()
        last_verification = session.scalars(
            select(AuditEvent)
            .where(AuditEvent.feature == "audit.verify_chain", AuditEvent.action.in_(("verified", "break_detected")))
            .order_by(AuditEvent.seq.desc())
            .limit(1)
        ).first()
    return {
        "total": total,
        "by_result": by_result,
        "by_source": by_source,
        "by_feature": by_feature,
        "transport_features": list(TRANSPORT_FEATURES),
        "chain_head": {"seq": head.seq, "hash": head.hash, "ts": format_ts(head.ts)} if head else {"seq": 0, "hash": GENESIS_HASH, "ts": None},
        "last_verification": serialize_event(last_verification) if last_verification else None,
        "fallback_events": services.writer.fallback_count(),
    }


@router.get("/coverage", openapi_extra=feature("audit.coverage"))
def coverage(_: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    return coverage_report(services)


@router.post("/verify", openapi_extra=feature("audit.verify_chain"))
def verify(_: CurrentUser = Depends(require_role("admin")), services: Services = Depends(get_services)) -> dict:
    with audited_step(
        services.db, services.writer, feature="audit.verify_chain", started="started", finished="verified", failed="failed"
    ) as step:
        result = verify_and_anchor(services, step)
    return {**result.as_dict(), "anchor": step.details.get("anchor")}
