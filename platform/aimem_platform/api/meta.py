from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse
from sqlalchemy import select, text

from .. import __version__
from ..audit.canonical import GENESIS_HASH, format_ts
from ..deps import feature, get_services
from ..models import AuditEvent
from ..services import Services

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health", openapi_extra=feature("system.health"))
def health(services: Services = Depends(get_services)) -> dict:
    with services.db.read() as session:
        session.execute(text("SELECT 1"))
        head = session.execute(select(AuditEvent.seq, AuditEvent.hash, AuditEvent.ts).order_by(AuditEvent.seq.desc()).limit(1)).first()
        schema = session.execute(text("SELECT version_num FROM aimem.alembic_version")).scalars().all()
    fallback = services.writer.fallback_count()
    return {
        "status": "degraded" if fallback else "ok",
        "version": __version__,
        "environment": services.settings.environment,
        "database": services.db.name,
        "schema_revision": schema,
        "chain_head": {"seq": head.seq, "hash": head.hash, "ts": format_ts(head.ts)} if head else {"seq": 0, "hash": GENESIS_HASH, "ts": None},
        "fallback_events": fallback,
        "registry": {"digest": services.registry.digest, "features": len(services.registry)},
    }


@router.get("/features", openapi_extra=feature("feature.registry"))
def features(services: Services = Depends(get_services)) -> dict:
    return services.registry.as_dict()


@router.get("/openapi.json", openapi_extra=feature("api.docs"), include_in_schema=False)
def openapi_document(request: Request) -> dict:
    return request.app.openapi()


@router.get("/docs", openapi_extra=feature("api.docs"), include_in_schema=False, response_class=HTMLResponse)
def openapi_ui() -> HTMLResponse:
    return get_swagger_ui_html(openapi_url="/api/openapi.json", title=f"AIMEM Platform API {__version__}")
