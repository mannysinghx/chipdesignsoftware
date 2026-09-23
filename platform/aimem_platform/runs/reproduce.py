"""Re-execute a run from its audit record and compare normalized outputs (run.reproduce)."""

from __future__ import annotations

import hashlib
import uuid

from sqlalchemy import select

from ..audit.context import ActorRef
from ..audit.writer import utcnow
from ..models import Run
from ..services import Services
from .adapters import Adapter, get_adapter
from .normalize import scheme_of
from .reconstruct import compare_manifests, reconstruct_run
from .service import execute_run, submit_spec, worker_identity
from .spec import RunSpec


def claim_specific(services: Services, run_id: uuid.UUID, *, runner_name: str) -> Run:
    worker_id = worker_identity()
    with services.db.transaction() as session:
        run = session.scalars(select(Run).where(Run.run_id == run_id, Run.status == "queued").with_for_update(skip_locked=True)).first()
        if run is None:
            raise RuntimeError(f"run {run_id} is not queued (another worker may have claimed it)")
        run.status = "running"
        run.started_at = utcnow()
        run.worker_id = worker_id
        run.runner = runner_name
        services.writer.append(
            session, feature="run.lifecycle", action="claimed", target=("run", str(run_id)), trace_id=run.trace_id,
            details={"worker": worker_id, "runner": runner_name, "claimed_directly": True},
        )
        return run


def run_inline(services: Services, runner, run: Run) -> Run:
    """Claim a just-submitted run and execute it in this process (CLI and CI)."""
    return execute_run(services, runner, claim_specific(services, run.run_id, runner_name=runner.name), keep_workspace=services.settings.keep_run_workspaces)


def renormalize_recorded(services: Services, adapter: Adapter, outputs: dict, current: dict) -> tuple[dict, list[dict]]:
    """A recorded run's reproducible outputs, re-hashed where `current` uses another scheme.

    Hashes from two schemes are never compared. Every output a run kept is still in
    the content-addressed store under the raw hash its outputs_recorded event lists,
    so a file recorded under an older scheme is re-hashed from those bytes under the
    current one. Each such file is listed with what happened; one whose bytes are gone
    keeps its recorded entry and compares as incomparable.
    """
    raw = {item["path"]: item["sha256"] for item in outputs["outputs"]}
    recorded = dict(outputs["reproducible"])
    notes = []
    for path, entry in outputs["reproducible"].items():
        if path not in current or scheme_of(entry) == scheme_of(current[path]):
            continue
        digest = raw.get(path)
        note = {"path": path, "recorded": entry.get("normalization"), "raw_sha256": digest}
        if digest is None or not services.artifacts.exists(digest):
            note["error"] = "the raw output is not in the artifact store"
        else:
            data = services.artifacts.path_for(digest).read_bytes()
            if hashlib.sha256(data).hexdigest() != digest:
                note["error"] = "the stored bytes do not match their hash"
            else:
                recorded[path] = adapter.normalized(path, data)
                note["rehashed"] = recorded[path]["normalization"]
        notes.append(note)
    return recorded, notes


def reproduce_run(services: Services, runner, run_id: uuid.UUID | str, *, actor: ActorRef) -> dict:
    original = reconstruct_run(services, run_id)  # audit log only
    if original["problems"]:
        raise RuntimeError(f"run {run_id} cannot be reproduced: {original['problems']}")
    if original["outputs"] is None:
        raise RuntimeError(f"run {run_id} recorded no outputs to compare")
    spec = RunSpec.from_dict(original["spec"])
    reproduction = submit_spec(services, spec, actor=actor, reproduction_of=uuid.UUID(str(run_id)))
    finished = run_inline(services, runner, reproduction)
    repeated = reconstruct_run(services, reproduction.run_id)
    current = (repeated["outputs"] or {}).get("reproducible", {})
    recorded, renormalized = renormalize_recorded(services, get_adapter(spec.adapter), original["outputs"], current)
    comparison = {**compare_manifests(recorded, current), "renormalized": renormalized}
    services.writer.commit_event(
        services.db,
        feature="run.reproduce",
        action="compared",
        result="ok" if comparison["identical"] else "error",
        actor=actor,
        target=("run", str(run_id)),
        details={
            "original_run": str(run_id),
            "reproduction_run": str(reproduction.run_id),
            "spec_hash": original["spec_hash"],
            "runner": runner.name,
            "reproduction_status": finished.status,
            **comparison,
        },
    )
    return {"original_run": str(run_id), "reproduction_run": str(reproduction.run_id), "reproduction_status": finished.status, **comparison}
