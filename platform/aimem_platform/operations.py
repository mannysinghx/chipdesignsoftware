"""Operations shared by the API and the CLI."""

from __future__ import annotations

import json
from collections.abc import Mapping

from sqlalchemy import func, select

from .audit.canonical import format_ts
from .audit.verifier import VerificationResult, verify_chain
from .audit.writer import StepHandle
from .models import AuditEvent
from .services import Services


def _load(text: str | None) -> object:
    return None if text is None else json.loads(text)


def serialize_event(row: Mapping | AuditEvent) -> dict:
    get = row.get if isinstance(row, Mapping) else (lambda key: getattr(row, key))
    target_type, target_id = get("target_type"), get("target_id")
    parent = get("parent_event_id")
    client_ts = get("client_ts")
    return {
        "seq": get("seq"),
        "event_id": str(get("event_id")),
        "ts": format_ts(get("ts")),
        "trace_id": get("trace_id"),
        "span_id": get("span_id"),
        "parent_event_id": str(parent) if parent else None,
        "actor": {
            "type": get("actor_type"),
            "id": get("actor_id"),
            "version": get("actor_version"),
            "authenticated": get("authenticated"),
        },
        "source": get("source"),
        "feature": get("feature"),
        "action": get("action"),
        "result": get("result"),
        "target": {"type": target_type, "id": target_id} if target_type or target_id else None,
        "input_hash": get("input_hash"),
        "output_hash": get("output_hash"),
        "error": get("error"),
        "details": _load(get("details_json")),
        "cost": _load(get("cost_json")),
        "evidence_class": get("evidence_class"),
        "policy_decision": _load(get("policy_json")),
        "redaction": _load(get("redaction_json")),
        "client_ts": format_ts(client_ts) if client_ts else None,
        "hash_version": get("hash_version"),
        "prev_hash": get("prev_hash"),
        "hash": get("hash"),
    }


def coverage_report(services: Services) -> dict:
    """Compare every registered feature's required actions with what the log actually contains."""
    with services.db.read() as session:
        observed_rows = session.execute(
            select(AuditEvent.feature, AuditEvent.action, func.count()).group_by(AuditEvent.feature, AuditEvent.action)
        ).all()
    observed: dict[tuple[str, str], int] = {(feature, action): count for feature, action, count in observed_rows}

    features = []
    required_total = 0
    required_covered = 0
    for feature in services.registry:
        actions = []
        for action in feature.events:
            count = observed.get((feature.id, action), 0)
            required_total += 1
            required_covered += 1 if count else 0
            actions.append({"action": action, "required": True, "count": count})
        for action in feature.may_emit:
            actions.append({"action": action, "required": False, "count": observed.get((feature.id, action), 0)})
        features.append(
            {
                "id": feature.id,
                "kind": feature.kind,
                "title": feature.title,
                "actions": actions,
                "missing": [item["action"] for item in actions if item["required"] and not item["count"]],
            }
        )

    undeclared = []
    for (feature_id, action), count in sorted(observed.items()):
        if feature_id not in services.registry or action not in services.registry.get(feature_id).allowed:
            undeclared.append({"feature": feature_id, "action": action, "count": count})

    return {
        "registry_digest": services.registry.digest,
        "required_actions": required_total,
        "covered_actions": required_covered,
        "coverage_percent": round(100 * required_covered / required_total, 1) if required_total else 100.0,
        "features": features,
        "undeclared": undeclared,
    }


def verify_and_anchor(services: Services, step: StepHandle) -> VerificationResult:
    """Verify the chain and anchors; on success, anchor the verified head outside the database."""
    anchors = services.anchors.load()
    with services.db.read() as session:
        result = verify_chain(session.connection(), anchors=anchors)
    step.details.update(
        {
            "rows": result.rows,
            "head_seq": result.head_seq,
            "head_hash": result.head_hash,
            "anchors_checked": result.anchors_checked,
            "duration_ms": result.duration_ms,
            "failures": [failure.__dict__ for failure in result.failures],
            "truncated_failures": result.truncated_failures,
            "anchor_file": str(services.anchors.path),
        }
    )
    step.target = ("audit_chain", services.db.name)
    if result.ok:
        if result.rows:
            step.details["anchor"] = services.anchors.append(result.head_seq, result.head_hash)
    else:
        step.finished_action = "break_detected"
        step.result = "error"
    return result
