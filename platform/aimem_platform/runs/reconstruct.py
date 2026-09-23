"""Rebuild a run from the audit log alone and compare it with the runs table.

Exit criterion: "every run is fully reconstructable from audit_events alone".
The reconstruction reads only audit_events (plus the content-addressed store to
confirm inputs still exist by hash). It re-derives the spec hash from the
recorded spec, so an altered spec in either place is detected.
"""

from __future__ import annotations

import hashlib
import json
import uuid

from sqlalchemy import select

from ..audit.canonical import dumps_canonical, sanitize
from ..models import AuditEvent, Run, RunFile
from ..services import Services
from .spec import RunSpec

FINAL_ACTIONS = ("finished", "errored", "timed_out", "cancelled", "abandoned")


def _events(services: Services, run_id: str) -> list[AuditEvent]:
    with services.db.read() as session:
        return list(
            session.scalars(
                select(AuditEvent)
                .where(AuditEvent.target_type == "run", AuditEvent.target_id == run_id, AuditEvent.feature.in_(("run.lifecycle", "run.cancel")))
                .order_by(AuditEvent.seq)
            )
        )


def reconstruct_run(services: Services, run_id: uuid.UUID | str) -> dict:
    run_id = str(run_id)
    events = _events(services, run_id)
    if not events:
        raise LookupError(f"no audit events for run {run_id}")
    by_action: dict[str, AuditEvent] = {}
    for event in events:
        by_action.setdefault(event.action, event)
    queued = by_action.get("queued")
    if queued is None:
        raise LookupError(f"run {run_id} has no queued event")
    queued_details = json.loads(queued.details_json)
    spec_document = queued_details["spec"]
    problems: list[str] = []
    try:
        spec = RunSpec.from_dict(spec_document)
        spec_hash = spec.spec_hash()
    except (KeyError, ValueError) as exc:
        spec, spec_hash = None, None
        problems.append(f"recorded spec is invalid: {exc}")
    if spec_hash and queued.input_hash != f"sha256:{spec_hash}":
        problems.append("queued event input_hash does not match the recorded spec")

    inputs = [{"path": path, "sha256": digest, "available": services.artifacts.exists(digest)} for path, digest in (spec.inputs if spec else [])]
    for item in inputs:
        if not item["available"]:
            problems.append(f"input {item['path']} is missing from the artifact store")

    outputs_event = by_action.get("outputs_recorded")
    outputs = json.loads(outputs_event.details_json) if outputs_event else None
    final = next((event for event in reversed(events) if event.action in FINAL_ACTIONS), None)
    final_details = json.loads(final.details_json) if final and final.details_json else None
    if outputs is not None:
        recomputed = hashlib.sha256(
            dumps_canonical(sanitize({path: value["sha256"] for path, value in outputs["reproducible"].items()})).encode()
        ).hexdigest()
        if recomputed != outputs["output_manifest_hash"]:
            problems.append("output manifest hash does not match its recorded entries")

    return {
        "run_id": run_id,
        "trace_id": queued.trace_id,
        "events": [{"seq": event.seq, "action": event.action, "result": event.result, "hash": event.hash} for event in events],
        "adapter": queued_details["adapter"],
        "spec": spec_document,
        "spec_hash": spec_hash,
        "inputs": inputs,
        "outputs": outputs,
        "final": {"action": final.action, "status": final_details.get("status") if final_details else None, "details": final_details} if final else None,
        "problems": problems,
    }


def compare_with_record(services: Services, run_id: uuid.UUID | str) -> dict:
    """Does the runs table agree with what the audit log says happened?"""
    rebuilt = reconstruct_run(services, run_id)
    with services.db.read() as session:
        run = session.get(Run, uuid.UUID(str(run_id)))
        files = session.scalars(select(RunFile).where(RunFile.run_id == uuid.UUID(str(run_id)))).all()
    if run is None:
        raise LookupError("run not found")
    checks = {
        "spec": json.loads(run.spec_json) == rebuilt["spec"],
        "spec_hash": run.spec_hash == rebuilt["spec_hash"],
        "inputs": sorted((f.path, f.sha256) for f in files if f.role == "input") == sorted((i["path"], i["sha256"]) for i in rebuilt["inputs"]),
        "inputs_available": all(item["available"] for item in rebuilt["inputs"]),
    }
    if rebuilt["final"] is not None:
        checks["status"] = run.status == rebuilt["final"]["status"]
    if rebuilt["outputs"] is not None:
        checks["outputs"] = sorted((f.path, f.sha256) for f in files if f.role == "output") == sorted(
            (item["path"], item["sha256"]) for item in rebuilt["outputs"]["outputs"]
        )
        checks["output_manifest_hash"] = run.output_manifest_hash == rebuilt["outputs"]["output_manifest_hash"]
    return {
        "reconstructed": rebuilt,
        "checks": checks,
        "consistent": all(checks.values()) and not rebuilt["problems"],
    }


def compare_manifests(first: dict, second: dict) -> dict:
    """Compare two reproducible-output maps (path -> {"sha256", "normalization"})."""
    paths = sorted(set(first) | set(second))
    mismatches = [
        {"path": path, "first": first.get(path, {}).get("sha256"), "second": second.get(path, {}).get("sha256")}
        for path in paths
        if first.get(path, {}).get("sha256") != second.get(path, {}).get("sha256")
    ]
    return {"compared": len(paths), "matched": len(paths) - len(mismatches), "mismatches": mismatches, "identical": not mismatches}
