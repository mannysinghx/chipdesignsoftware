from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select

from ..audit.canonical import format_ts
from ..audit.context import current_context
from ..deps import CurrentUser, feature, get_services, require_role
from ..models import Run, RunFile
from ..runs.adapters import ADAPTERS, get_adapter
from ..runs.reconstruct import compare_with_record
from ..runs.service import TERMINAL, request_cancel, submit_run, workspace
from ..services import Services

router = APIRouter(prefix="/api", tags=["runs"])


class SubmitBody(BaseModel):
    adapter: str = Field(min_length=1, max_length=64)
    params: dict = Field(default_factory=dict)


def _loads(text: str | None):
    return json.loads(text) if text else None


def serialize_run(run: Run, files: list[RunFile] | None = None) -> dict:
    payload = {
        "run_id": str(run.run_id),
        "adapter": run.adapter,
        "adapter_version": run.adapter_version,
        "title": ADAPTERS[run.adapter].title if run.adapter in ADAPTERS else run.adapter,
        "status": run.status,
        "verdict": run.verdict,
        "spec_hash": run.spec_hash,
        "params": _loads(run.params_json),
        "requested_by": run.requested_by,
        "trace_id": run.trace_id,
        "git": _loads(run.git_json),
        "reproduction_of": str(run.reproduction_of) if run.reproduction_of else None,
        "queued_at": format_ts(run.queued_at),
        "started_at": format_ts(run.started_at) if run.started_at else None,
        "finished_at": format_ts(run.finished_at) if run.finished_at else None,
        "worker_id": run.worker_id,
        "runner": run.runner,
        "exit_code": run.exit_code,
        "summary": _loads(run.summary_json),
        "output_manifest_hash": run.output_manifest_hash,
        "evidence_class": run.evidence_class,
        "error": run.error,
        "cancel_requested": run.cancel_requested,
    }
    if files is not None:
        payload["spec"] = _loads(run.spec_json)
        payload["files"] = [
            {"role": file.role, "path": file.path, "sha256": file.sha256, "size_bytes": file.size_bytes, "normalized_sha256": file.normalized_sha256}
            for file in sorted(files, key=lambda item: (item.role, item.path))
        ]
    return payload


def _load(services: Services, run_id: uuid.UUID) -> tuple[Run, list[RunFile]]:
    with services.db.read() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(404, "Run not found")
        files = list(session.scalars(select(RunFile).where(RunFile.run_id == run_id)))
    return run, files


@router.get("/adapters", openapi_extra=feature("run.catalog"))
def list_adapters(_: CurrentUser = Depends(require_role("viewer"))) -> dict:
    return {"adapters": [adapter.describe() for adapter in ADAPTERS.values()]}


@router.post("/runs", openapi_extra=feature("run.submit"), status_code=201)
def create_run(body: SubmitBody, user: CurrentUser = Depends(require_role("engineer")), services: Services = Depends(get_services)) -> dict:
    try:
        get_adapter(body.adapter)
    except LookupError:
        raise HTTPException(404, f"Unknown adapter {body.adapter!r}") from None
    try:
        run = submit_run(services, body.adapter, body.params, actor=user.as_actor())
    except ValidationError as exc:
        raise HTTPException(422, json.loads(exc.json())) from None
    context = current_context()
    if context is not None:
        context.notes["run_id"] = str(run.run_id)
    return {"run": serialize_run(run)}


@router.get("/runs", openapi_extra=feature("run.query"))
def list_runs(
    adapter: str | None = Query(None, max_length=64),
    status: str | None = Query(None, max_length=16),
    limit: int = Query(50, ge=1, le=200),
    _: CurrentUser = Depends(require_role("viewer")),
    services: Services = Depends(get_services),
) -> dict:
    statement = select(Run).order_by(Run.queued_at.desc()).limit(limit)
    if adapter:
        statement = statement.where(Run.adapter == adapter)
    if status:
        statement = statement.where(Run.status == status)
    with services.db.read() as session:
        runs = session.scalars(statement).all()
    return {"runs": [serialize_run(run) for run in runs]}


@router.get("/runs/{run_id}", openapi_extra=feature("run.query"))
def get_run(run_id: uuid.UUID, _: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    run, files = _load(services, run_id)
    return {"run": serialize_run(run, files)}


@router.get("/runs/{run_id}/log", openapi_extra=feature("run.query"))
def get_run_log(
    run_id: uuid.UUID,
    offset: int = Query(0, ge=0),
    _: CurrentUser = Depends(require_role("viewer")),
    services: Services = Depends(get_services),
) -> dict:
    run, _files = _load(services, run_id)
    path = workspace(services, run_id).log
    text, next_offset = "", offset
    if path.exists():
        with path.open("rb") as handle:
            handle.seek(offset)
            chunk = handle.read(services.settings.run_log_chunk_bytes)
        text = chunk.decode("utf-8", errors="replace")
        next_offset = offset + len(chunk)
    return {"status": run.status, "text": text, "next_offset": next_offset, "complete": run.status in TERMINAL}


@router.post("/runs/{run_id}/cancel", openapi_extra=feature("run.cancel"))
def cancel_run(run_id: uuid.UUID, user: CurrentUser = Depends(require_role("engineer")), services: Services = Depends(get_services)) -> dict:
    try:
        run = request_cancel(services, run_id, actor=user.as_actor())
    except LookupError:
        raise HTTPException(404, "Run not found") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return {"run": serialize_run(run)}


@router.get("/runs/{run_id}/reconstruction", openapi_extra=feature("run.reconstruct"))
def reconstruction(run_id: uuid.UUID, _: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    try:
        return compare_with_record(services, run_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from None


@router.get("/evidence", openapi_extra=feature("evidence.query"))
def evidence(_: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    """The latest completed run of every adapter, with its reproduction status."""
    items = []
    with services.db.read() as session:
        for adapter in ADAPTERS.values():
            latest = session.scalars(
                select(Run).where(Run.adapter == adapter.id, Run.status.in_(("succeeded", "failed", "errored", "timed_out"))).order_by(Run.finished_at.desc()).limit(1)
            ).first()
            active = session.scalars(select(Run).where(Run.adapter == adapter.id, Run.status.in_(("queued", "running"))).limit(1)).first()
            reproduced = None
            if latest is not None and latest.output_manifest_hash:
                twins = session.scalars(
                    select(Run).where(
                        Run.spec_hash == latest.spec_hash, Run.run_id != latest.run_id, Run.status.in_(("succeeded", "failed"))
                    )
                ).all()
                if twins:
                    reproduced = {
                        "runs": len(twins),
                        "identical": all(twin.output_manifest_hash == latest.output_manifest_hash for twin in twins),
                    }
            items.append(
                {
                    "adapter": adapter.describe(),
                    "latest": serialize_run(latest) if latest else None,
                    "active": serialize_run(active) if active else None,
                    "reproduced": reproduced,
                }
            )
    return {"evidence": items}
