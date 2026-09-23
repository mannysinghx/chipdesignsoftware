"""Re-execute a run from its audit record and compare normalized outputs (run.reproduce)."""

from __future__ import annotations

import uuid

from sqlalchemy import select

from ..audit.context import ActorRef
from ..audit.writer import utcnow
from ..models import Run
from ..services import Services
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
    comparison = compare_manifests(original["outputs"]["reproducible"], (repeated["outputs"] or {}).get("reproducible", {}))
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
