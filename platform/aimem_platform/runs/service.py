"""Run lifecycle: submit → claim → execute → finalize, every step audited.

Invariants:
- A run's queued event carries the complete spec (image and toolchain digests,
  command, environment, and every input's content hash), so the run can be
  rebuilt from the audit log alone (see reconstruct.py).
- The runs row and its lifecycle event always change in the same transaction.
- `started` is committed before the sandbox launches; if it cannot be written,
  the tool never runs.
- Nothing reaps a run automatically on API startup. Only a worker marks a run
  abandoned, and only when its container is provably gone.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import subprocess
import time
import traceback
import uuid
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select

from ..audit.canonical import dumps_canonical, format_ts, sanitize
from ..audit.context import ActorRef, AuditContext, audit_context, new_span_id, new_trace_id
from ..audit.writer import AuditUnavailableError, utcnow
from ..models import EVIDENCE_CLASSES, Artifact, Run, RunFile
from ..services import Services
from .adapters import Adapter, Outcome, get_adapter
from .runners import Execution
from .spec import RunSpec
from .toolchains import Toolchains

TERMINAL = frozenset({"succeeded", "failed", "errored", "timed_out", "cancelled"})


@dataclass
class Workspace:
    root: Path

    @property
    def inputs(self) -> Path:
        return self.root / "in"

    @property
    def outputs(self) -> Path:
        return self.root / "out"

    @property
    def log(self) -> Path:
        return self.root / "run.log"


def workspace(services: Services, run_id: uuid.UUID | str) -> Workspace:
    return Workspace(services.settings.var_dir / "runs" / str(run_id))


def toolchains_for(services: Services) -> Toolchains:
    return Toolchains(services.settings.toolchains_path, services.settings.repo_root / ".cache" / "toolchains")


def git_state(repo: Path, paths: list[Path]) -> dict:
    """Provenance only: the commit and whether the snapshotted inputs differed from it."""
    try:
        revision = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
        relative = [str(path.relative_to(repo)) for path in paths if repo in path.parents]
        dirty = subprocess.run(
            ["git", "-C", str(repo), "status", "--porcelain", "--", *relative], capture_output=True, text=True, timeout=10
        ).stdout.strip()
        return {"revision": revision or None, "inputs_differ_from_revision": bool(dirty)}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"revision": None, "inputs_differ_from_revision": None}


@dataclass(frozen=True)
class InputBlob:
    sha256: str
    size_bytes: int


def _new_artifact_row(session, sha: str, size: int, name: str, media_type: str, evidence_class: str, provenance: dict, owner: str) -> Artifact | None:
    """An artifacts row to add in the caller's audited transaction, or None if the blob is already registered."""
    if session.get(Artifact, sha) is not None:
        return None
    return Artifact(
        sha256=sha,
        size_bytes=size,
        media_type=media_type,
        name=name,
        evidence_class=evidence_class,
        provenance_json=dumps_canonical(sanitize(provenance)),
        created_at=utcnow(),
        created_by=owner,
    )


def _media_type(path: str) -> str:
    return {
        ".json": "application/json",
        ".log": "text/plain",
        ".txt": "text/plain",
        ".rpt": "text/plain",
        ".xml": "application/xml",
        ".vcd": "text/plain",
        ".v": "text/plain",
        ".sv": "text/plain",
        ".def": "text/plain",
        ".sdc": "text/plain",
        ".gds": "application/octet-stream",
        ".png": "image/png",
        ".webp": "image/webp",
        ".py": "text/x-python",
        ".sh": "text/x-shellscript",
    }.get(Path(path).suffix, "application/octet-stream")


# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------
def submit_run(services: Services, adapter_id: str, params: dict | None, *, actor: ActorRef, reproduction_of: uuid.UUID | None = None) -> Run:
    adapter = get_adapter(adapter_id)
    typed = adapter.params_model(**(params or {}))
    repo = services.settings.repo_root
    sources = adapter.inputs(typed, repo)
    hashes: dict[str, str] = {}
    blobs = {}
    for sandbox_path, host_path in sources.items():
        blob = services.artifacts.put(host_path.read_bytes())
        hashes[sandbox_path] = blob.sha256
        blobs[sandbox_path] = blob
    spec = adapter.build_spec(typed, hashes, toolchains_for(services))
    return _enqueue(services, adapter, spec, blobs, actor=actor, git=git_state(repo, list(sources.values())), reproduction_of=reproduction_of)


def submit_spec(services: Services, spec: RunSpec, *, actor: ActorRef, reproduction_of: uuid.UUID) -> Run:
    """Re-submit an exact spec (for reproduction). Every input must still be in the artifact store."""
    adapter = get_adapter(spec.adapter)
    blobs = {}
    for sandbox_path, digest in spec.inputs:
        if not services.artifacts.exists(digest):
            raise FileNotFoundError(f"input {sandbox_path} ({digest}) is no longer in the artifact store")
        blobs[sandbox_path] = InputBlob(digest, services.artifacts.path_for(digest).stat().st_size)
    return _enqueue(services, adapter, spec, blobs, actor=actor, git=None, reproduction_of=reproduction_of)


def _enqueue(services, adapter: Adapter, spec: RunSpec, blobs: dict, *, actor: ActorRef, git: dict | None, reproduction_of) -> Run:
    run_id = uuid.uuid4()
    trace_id = new_trace_id()
    now = utcnow()
    spec_document = spec.to_dict()
    run = Run(
        run_id=run_id,
        adapter=adapter.id,
        adapter_version=adapter.version,
        status="queued",
        spec_json=dumps_canonical(spec_document),
        spec_hash=spec.spec_hash(),
        params_json=dumps_canonical(sanitize(spec.params)),
        requested_by=actor.id,
        trace_id=trace_id,
        git_json=dumps_canonical(git) if git else None,
        reproduction_of=reproduction_of,
        queued_at=now,
        cancel_requested=False,
    )
    with services.db.transaction() as session:
        session.add(run)
        session.flush()
        for sandbox_path, blob in sorted(blobs.items()):
            row = _new_artifact_row(
                session, blob.sha256, blob.size_bytes, sandbox_path, _media_type(sandbox_path), "planned",
                {"role": "run input", "path": sandbox_path, "first_run": str(run_id)}, actor.id,
            )
            if row is not None:
                session.add(row)
            session.add(RunFile(run_id=run_id, role="input", path=sandbox_path, sha256=blob.sha256, size_bytes=blob.size_bytes))
        services.writer.append(
            session,
            feature="run.lifecycle",
            action="queued",
            actor=actor,
            target=("run", str(run_id)),
            trace_id=trace_id,
            input_hash=f"sha256:{spec.spec_hash()}",
            details={
                "adapter": adapter.id,
                "adapter_version": adapter.version,
                "title": adapter.title,
                "spec": spec_document,
                "git": git,
                "reproduction_of": str(reproduction_of) if reproduction_of else None,
            },
        )
    return run


# ---------------------------------------------------------------------------
# claim / execute
# ---------------------------------------------------------------------------
def worker_identity() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def claim_next(services: Services, *, worker_id: str, runner_name: str) -> Run | None:
    with services.db.transaction() as session:
        run = session.scalars(
            select(Run).where(Run.status == "queued").order_by(Run.queued_at).limit(1).with_for_update(skip_locked=True)
        ).first()
        if run is None:
            return None
        run.status = "running"
        run.started_at = utcnow()
        run.worker_id = worker_id
        run.runner = runner_name
        services.writer.append(
            session,
            feature="run.lifecycle",
            action="claimed",
            target=("run", str(run.run_id)),
            trace_id=run.trace_id,
            details={"worker": worker_id, "runner": runner_name},
        )
        return run


def _cancel_flag(services: Services, run_id: uuid.UUID) -> bool:
    with services.db.read() as session:
        return bool(session.scalar(select(Run.cancel_requested).where(Run.run_id == run_id)))


def _materialize(services: Services, spec: RunSpec, space: Workspace) -> None:
    shutil.rmtree(space.root, ignore_errors=True)
    space.inputs.mkdir(parents=True)
    space.outputs.mkdir(parents=True)
    for sandbox_path, digest in spec.inputs:
        target = space.inputs / sandbox_path
        target.parent.mkdir(parents=True, exist_ok=True)
        source = services.artifacts.path_for(digest)
        shutil.copyfile(source, target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"input {sandbox_path} does not match its recorded hash {digest}")


def execute_run(services: Services, runner, run: Run, *, keep_workspace: bool = False) -> Run:
    """Execute a claimed run in the sandbox and record everything it produced."""
    adapter = get_adapter(run.adapter)
    spec = RunSpec.from_dict(json.loads(run.spec_json))
    space = workspace(services, run.run_id)
    actor = ActorRef("system", f"worker:{run.worker_id}", services.writer.default_actor.version, authenticated=True)
    context = AuditContext(trace_id=run.trace_id, span_id=new_span_id(), actor=actor, source="worker")
    with audit_context(context):
        try:
            _materialize(services, spec, space)
            services.writer.commit_event(
                services.db,
                feature="run.lifecycle",
                action="started",
                result="pending",
                target=("run", str(run.run_id)),
                details={"runner": runner.name, "isolation": runner.isolation(spec), "workspace": str(space.root)},
            )
        except Exception as exc:
            return _finalize_error(services, run, f"could not start: {type(exc).__name__}: {exc}", traceback.format_exc())

        try:
            execution = runner.execute(spec, space.root, space.log, run_id=str(run.run_id), cancel_requested=lambda: _cancel_flag(services, run.run_id))
        except Exception as exc:
            execution = Execution("error", None, 0, runner.name, runner.isolation(spec), f"{type(exc).__name__}: {exc}")

        try:
            outcome = adapter.summarize(space.outputs, execution) if execution.status == "exited" else None
        except Exception as exc:
            outcome = Outcome("error", f"summarizer failed: {type(exc).__name__}: {exc}")
        try:
            result = _finalize(services, run, adapter, spec, space, execution, outcome)
        except Exception as exc:
            # Never leave a run stuck in `running`: record why finalization failed. The
            # workspace is kept so the outputs can be inspected.
            return _finalize_error(services, run, f"finalization failed: {type(exc).__name__}: {str(exc).splitlines()[0]}", traceback.format_exc())
    if not keep_workspace and result.status in TERMINAL:
        shutil.rmtree(space.inputs, ignore_errors=True)
        shutil.rmtree(space.outputs, ignore_errors=True)
    return result


def _final_status(execution: Execution, outcome: Outcome | None) -> str:
    if execution.status in ("timed_out", "cancelled"):
        return execution.status
    if execution.status != "exited" or outcome is None or outcome.verdict == "error":
        return "errored"
    return "succeeded" if outcome.verdict == "pass" else "failed"


def _finalize(services, run: Run, adapter: Adapter, spec: RunSpec, space: Workspace, execution: Execution, outcome: Outcome | None) -> Run:
    outputs = []
    for path in adapter.kept_outputs(space.outputs) if space.outputs.exists() else []:
        blob = services.artifacts.put(path.read_bytes())
        outputs.append((str(path.relative_to(space.outputs)), blob))
    log_blob = services.artifacts.put(space.log.read_bytes()) if space.log.exists() else None
    reproducible = adapter.reproducible(space.outputs) if space.outputs.exists() and execution.status == "exited" else {}
    manifest_hash = hashlib.sha256(dumps_canonical(sanitize({key: value["sha256"] for key, value in reproducible.items()})).encode()).hexdigest()
    status = _final_status(execution, outcome)
    evidence_class = (outcome.evidence_class if outcome else "executed") if status in ("succeeded", "failed") else "planned"
    if evidence_class not in EVIDENCE_CLASSES:
        raise ValueError(f"adapter {adapter.id} reported evidence class {evidence_class!r}; allowed: {', '.join(EVIDENCE_CLASSES)}")
    summary = {
        "verdict": outcome.verdict if outcome else None,
        "headline": outcome.headline if outcome else (execution.error or execution.status),
        "limitations": outcome.limitations if outcome else None,
        "metrics": outcome.metrics if outcome else {},
        "execution": {"status": execution.status, "exit_code": execution.exit_code, "wall_ms": execution.wall_ms, "runner": execution.runner},
        "isolation": execution.isolation,
    }
    now = utcnow()
    git = json.loads(run.git_json) if run.git_json else {}
    limitations = outcome.limitations if outcome else None
    with services.db.transaction() as session:
        current = session.get(Run, run.run_id, with_for_update=True)
        for relative, blob in outputs:
            # The 12-field provenance contract (design/agents/orchestration-contract.json).
            provenance = {
                "artifact_id": blob.sha256,
                "mission_id": None,
                "task_id": str(run.run_id),
                "git_revision": git.get("revision"),
                "tool_identity": {"adapter": f"{spec.adapter}@{spec.adapter_version}", "image": spec.image, "toolchains": [mount.identity for mount in spec.mounts]},
                "input_hashes": [f"sha256:{digest}" for _path, digest in spec.inputs],
                "output_hash": f"sha256:{blob.sha256}",
                "evidence_class": evidence_class,
                "limitations": limitations,
                "owner": run.requested_by,
                "timestamp": format_ts(now),
                "signature": None,
                "path": relative,
                "spec_hash": run.spec_hash,
            }
            row = _new_artifact_row(
                session, blob.sha256, blob.size_bytes, Path(relative).name, _media_type(relative), evidence_class,
                provenance, current.worker_id or "worker",
            )
            if row is not None:
                session.add(row)
            session.add(
                RunFile(
                    run_id=run.run_id, role="output", path=relative, sha256=blob.sha256, size_bytes=blob.size_bytes,
                    normalized_sha256=reproducible.get(relative, {}).get("sha256"),
                )
            )
        if log_blob is not None:
            row = _new_artifact_row(
                session, log_blob.sha256, log_blob.size_bytes, "run.log", "text/plain", "planned",
                {"role": "run log", "run": str(run.run_id)}, current.worker_id or "worker",
            )
            if row is not None:
                session.add(row)
            session.add(RunFile(run_id=run.run_id, role="log", path="run.log", sha256=log_blob.sha256, size_bytes=log_blob.size_bytes))
        current.status = status
        current.verdict = outcome.verdict if outcome else None
        current.finished_at = now
        current.exit_code = execution.exit_code
        current.summary_json = dumps_canonical(sanitize(summary))
        current.output_manifest_hash = manifest_hash
        current.evidence_class = evidence_class
        current.error = execution.error
        services.writer.append(
            session,
            feature="run.lifecycle",
            action="outputs_recorded",
            target=("run", str(run.run_id)),
            output_hash=f"sha256:{manifest_hash}",
            details={
                "outputs": [{"path": relative, "sha256": blob.sha256, "size_bytes": blob.size_bytes} for relative, blob in outputs],
                "log": {"sha256": log_blob.sha256, "size_bytes": log_blob.size_bytes} if log_blob else None,
                "reproducible": reproducible,
                "output_manifest_hash": manifest_hash,
            },
        )
        action = {"succeeded": "finished", "failed": "finished"}.get(status, status if status in ("timed_out", "cancelled") else "errored")
        services.writer.append(
            session,
            feature="run.lifecycle",
            action=action,
            result="ok" if status == "succeeded" else "error",
            target=("run", str(run.run_id)),
            output_hash=f"sha256:{manifest_hash}",
            evidence_class=evidence_class,
            error=execution.error,
            cost={"wall_ms": execution.wall_ms},
            details={"status": status, **summary},
        )
    return current


def _finalize_error(services, run: Run, message: str, trace: str) -> Run:
    fields = dict(
        feature="run.lifecycle", action="errored", result="error", target=("run", str(run.run_id)),
        error=trace, details={"status": "errored", "headline": message},
    )
    try:
        with services.db.transaction() as session:
            current = session.get(Run, run.run_id, with_for_update=True)
            current.status = "errored"
            current.finished_at = utcnow()
            current.error = message
            current.summary_json = dumps_canonical({"verdict": None, "headline": message})
            services.writer.append(session, **fields)
            return current
    except Exception as exc:
        services.writer.write_fallback(fields, exc)
        raise AuditUnavailableError("a run failed to start and its failure could not be logged") from exc


# ---------------------------------------------------------------------------
# cancel / reap / worker loop
# ---------------------------------------------------------------------------
def request_cancel(services: Services, run_id: uuid.UUID, *, actor: ActorRef) -> Run:
    with services.db.transaction() as session:
        run = session.get(Run, run_id, with_for_update=True)
        if run is None:
            raise LookupError("run not found")
        if run.status in TERMINAL:
            raise ValueError(f"run already {run.status}")
        run.cancel_requested = True
        services.writer.append(
            session, feature="run.cancel", action="cancel_requested", actor=actor, target=("run", str(run_id)),
            trace_id=run.trace_id, details={"status_at_request": run.status},
        )
        if run.status == "queued":
            run.status = "cancelled"
            run.finished_at = utcnow()
            run.summary_json = dumps_canonical({"verdict": None, "headline": "cancelled before it started"})
            services.writer.append(
                session, feature="run.lifecycle", action="cancelled", result="error", actor=actor, target=("run", str(run_id)),
                trace_id=run.trace_id, details={"status": "cancelled", "headline": "cancelled before it started"},
            )
        return run


def reap_abandoned(services: Services, *, container_alive, grace: timedelta = timedelta(minutes=2)) -> list[str]:
    """Mark running runs whose container is provably gone as errored ('abandoned')."""
    reaped = []
    cutoff = utcnow() - grace
    with services.db.read() as session:
        candidates = session.scalars(select(Run).where(Run.status == "running", Run.started_at < cutoff)).all()
    for run in candidates:
        if container_alive(str(run.run_id)):
            continue
        with services.db.transaction() as session:
            current = session.get(Run, run.run_id, with_for_update=True)
            if current.status != "running":
                continue
            current.status = "errored"
            current.finished_at = utcnow()
            current.error = "abandoned: its worker stopped and the container no longer exists"
            current.summary_json = dumps_canonical({"verdict": None, "headline": current.error})
            services.writer.append(
                session, feature="run.lifecycle", action="abandoned", result="error", target=("run", str(run.run_id)),
                trace_id=current.trace_id, details={"status": "errored", "worker": current.worker_id, "headline": current.error},
            )
        reaped.append(str(run.run_id))
    return reaped


def docker_container_alive(docker_bin: str = "docker"):
    def alive(run_id: str) -> bool:
        name = f"aimem-run-{run_id.replace('-', '')[:16]}"
        result = subprocess.run([docker_bin, "ps", "-q", "--filter", f"name=^{name}$"], capture_output=True, text=True)
        return bool(result.stdout.strip()) or result.returncode != 0  # if Docker cannot answer, assume alive
    return alive


def run_worker(services: Services, runner, *, once: bool = False, poll_s: float = 1.0, stop=None, container_alive=None) -> int:
    worker_id = worker_identity()
    executed = 0
    services.writer.commit_event(
        services.db, feature="worker.lifecycle", action="started", source="worker",
        target=("worker", worker_id), details={"runner": runner.name, "once": once},
    )
    try:
        if container_alive is not None:
            reap_abandoned(services, container_alive=container_alive)
        while stop is None or not stop():
            run = claim_next(services, worker_id=worker_id, runner_name=runner.name)
            if run is None:
                if once:
                    break
                time.sleep(poll_s)
                continue
            execute_run(services, runner, run)
            executed += 1
    finally:
        services.writer.commit_event(
            services.db, feature="worker.lifecycle", action="stopped", source="worker",
            target=("worker", worker_id), details={"executed": executed},
        )
    return executed
