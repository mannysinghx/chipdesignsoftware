from __future__ import annotations

import mimetypes
import re
import traceback

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from ..artifacts import SHA256_RE
from ..audit.canonical import dumps_canonical, format_ts, sanitize
from ..audit.context import current_context
from ..audit.writer import utcnow
from ..deps import CurrentUser, feature, get_services, require_role
from ..models import EVIDENCE_CLASSES, Artifact
from ..services import Services

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])
HASH_REF_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
MEDIA_TYPE_RE = re.compile(r"^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$")


def _header_text(request: Request, name: str, limit: int) -> str | None:
    value = request.headers.get(name)
    if value is None:
        return None
    value = "".join(ch for ch in value if ch.isprintable()).strip()
    return value[:limit] or None


def _public(artifact: Artifact) -> dict:
    return {
        "sha256": artifact.sha256,
        "name": artifact.name,
        "media_type": artifact.media_type,
        "size_bytes": artifact.size_bytes,
        "evidence_class": artifact.evidence_class,
        "created_at": format_ts(artifact.created_at),
        "created_by": artifact.created_by,
    }


def _store(services: Services, user: CurrentUser, data: bytes, meta: dict) -> dict:
    blob = services.artifacts.put(data)
    output_hash = f"sha256:{blob.sha256}"
    now = utcnow()
    provenance = {
        "artifact_id": blob.sha256,
        "mission_id": None,
        "task_id": None,
        "git_revision": meta["git_revision"],
        "tool_identity": meta["tool_identity"],
        "input_hashes": meta["input_hashes"],
        "output_hash": output_hash,
        "evidence_class": meta["evidence_class"],
        "limitations": meta["limitations"],
        "owner": user.email,
        "timestamp": format_ts(now),
        "signature": None,
    }
    try:
        with services.db.transaction() as session:
            existing = session.get(Artifact, blob.sha256)
            if existing is None:
                session.add(
                    Artifact(
                        sha256=blob.sha256,
                        size_bytes=blob.size_bytes,
                        media_type=meta["media_type"],
                        name=meta["name"],
                        evidence_class=meta["evidence_class"],
                        provenance_json=dumps_canonical(sanitize(provenance)),
                        created_at=now,
                        created_by=user.email,
                    )
                )
            services.writer.append(
                session,
                feature="artifact.write",
                action="artifact_written",
                target=("artifact", blob.sha256),
                output_hash=output_hash,
                evidence_class=meta["evidence_class"],
                details={
                    "name": meta["name"],
                    "media_type": meta["media_type"],
                    "size_bytes": blob.size_bytes,
                    "deduplicated": existing is not None,
                    "blob_created": blob.created,
                    "provenance": provenance,
                },
            )
            record = existing or session.get(Artifact, blob.sha256)
            payload = _public(record)
    except Exception:
        services.writer.commit_event(
            services.db,
            feature="artifact.write",
            action="failed",
            result="error",
            target=("artifact", blob.sha256),
            output_hash=output_hash,
            details={"name": meta["name"], "size_bytes": blob.size_bytes},
            error=traceback.format_exc(),
        )
        raise
    return {"artifact": payload, "deduplicated": existing is not None}


@router.post("", openapi_extra=feature("artifact.write"), status_code=201)
async def upload_artifact(
    request: Request,
    user: CurrentUser = Depends(require_role("engineer")),
    services: Services = Depends(get_services),
) -> dict:
    limit = services.settings.max_artifact_bytes
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, f"Artifacts are limited to {limit} bytes")
    name = _header_text(request, "x-artifact-name", 255)
    if not name:
        raise HTTPException(422, "The X-Artifact-Name header is required")
    evidence_class = (request.headers.get("x-evidence-class") or "unclassified").strip().lower()
    if evidence_class not in EVIDENCE_CLASSES:
        raise HTTPException(422, f"X-Evidence-Class must be one of {', '.join(EVIDENCE_CLASSES)}")
    media_type = (request.headers.get("content-type") or "application/octet-stream").split(";")[0].strip().lower()
    if not MEDIA_TYPE_RE.match(media_type):
        media_type = "application/octet-stream"
    input_hashes = [item.strip() for item in (request.headers.get("x-input-hashes") or "").split(",") if item.strip()]
    if any(not HASH_REF_RE.match(item) for item in input_hashes):
        raise HTTPException(422, "X-Input-Hashes must be comma-separated sha256:<hex> values")
    data = await request.body()
    if len(data) > limit:
        raise HTTPException(413, f"Artifacts are limited to {limit} bytes")
    if not data:
        raise HTTPException(422, "Artifact body is empty")
    meta = {
        "name": name,
        "evidence_class": evidence_class,
        "media_type": media_type,
        "git_revision": _header_text(request, "x-git-revision", 64),
        "tool_identity": _header_text(request, "x-tool-identity", 200),
        "input_hashes": input_hashes,
        "limitations": _header_text(request, "x-limitations", 2000),
    }
    return await run_in_threadpool(_store, services, user, data, meta)


@router.get("", openapi_extra=feature("artifact.list"))
def list_artifacts(_: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    with services.db.read() as session:
        artifacts = session.scalars(select(Artifact).order_by(Artifact.created_at.desc()).limit(500)).all()
    context = current_context()
    if context is not None:
        context.notes["returned"] = len(artifacts)
    return {"artifacts": [_public(artifact) for artifact in artifacts]}


@router.get("/{sha256}", openapi_extra=feature("artifact.read"))
def download_artifact(sha256: str, _: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)):
    if not SHA256_RE.match(sha256):
        raise HTTPException(422, "Artifact ids are lowercase sha256 hex digests")
    with services.db.read() as session:
        artifact = session.get(Artifact, sha256)
    if artifact is None or not services.artifacts.exists(sha256):
        raise HTTPException(404, "Artifact not found")
    services.writer.commit_event(
        services.db,
        feature="artifact.read",
        action="artifact_read",
        target=("artifact", sha256),
        output_hash=f"sha256:{sha256}",
        evidence_class=artifact.evidence_class,
        details={"name": artifact.name, "size_bytes": artifact.size_bytes},
    )
    media_type = artifact.media_type
    if media_type == "application/octet-stream":
        # Blobs registered before their type was known (e.g. layout images) still render inline.
        media_type = mimetypes.guess_type(artifact.name)[0] or media_type
    inline = media_type.startswith("image/")
    return FileResponse(
        services.artifacts.path_for(sha256),
        media_type=media_type,
        filename=artifact.name,
        content_disposition_type="inline" if inline else "attachment",
    )
