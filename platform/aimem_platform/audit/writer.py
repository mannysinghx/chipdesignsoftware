from __future__ import annotations

import logging
import re
import threading
import traceback
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import TYPE_CHECKING, Callable, Iterator

from opentelemetry import trace
from sqlalchemy import Connection, func, insert, select
from sqlalchemy.orm import Session

from ..features import FeatureRegistry
from ..models import AuditEvent
from .canonical import GENESIS_HASH, HASH_VERSION, clean_text, compute_event_hash, dumps_canonical, format_ts, sanitize, to_json_text
from .context import SOURCES, SYSTEM_ACTOR, ActorRef, current_context, new_span_id, new_trace_id
from .guard import note_audit_writes

if TYPE_CHECKING:
    from ..db import Database

log = logging.getLogger("aimem.audit")

# pg_advisory_xact_lock key ("AIMEMAUD"). Serializes appends so seq stays gapless
# and every row's prev_hash is the hash of the row before it.
AUDIT_LOCK_KEY = 0x41494D454D415544
RESULTS = frozenset({"ok", "error", "denied", "pending", "info"})
TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SPAN_ID_RE = re.compile(r"^[0-9a-f]{16}$")
HASH_REF_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_SERVER_DETAILS_BYTES = 256 * 1024


class AuditValidationError(ValueError):
    """An event was malformed. This is a programming error, not a runtime condition."""


class AuditUnavailableError(RuntimeError):
    """The audit log could not be written, so the action was refused or flagged."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _otel_ids() -> tuple[str, str] | None:
    context = trace.get_current_span().get_span_context()
    if context.is_valid:
        return format(context.trace_id, "032x"), format(context.span_id, "016x")
    return None


class AuditWriter:
    def __init__(
        self,
        registry: FeatureRegistry,
        *,
        default_actor: ActorRef = SYSTEM_ACTOR,
        default_source: str = "system",
        clock: Callable[[], datetime] = utcnow,
        fallback_path: Path | None = None,
    ):
        self.registry = registry
        self.default_actor = default_actor
        self.default_source = default_source
        self.clock = clock
        self.fallback_path = fallback_path
        self._fallback_lock = threading.Lock()

    # -- building -----------------------------------------------------------
    def prepare(
        self,
        *,
        feature: str,
        action: str,
        result: str = "ok",
        actor: ActorRef | None = None,
        source: str | None = None,
        target: tuple[str, str] | None = None,
        details: object = None,
        error: str | None = None,
        input_hash: str | None = None,
        output_hash: str | None = None,
        cost: object = None,
        evidence_class: str | None = None,
        policy_decision: object = None,
        redaction: object = None,
        parent_event_id: uuid.UUID | None = None,
        event_id: uuid.UUID | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
        client_ts: datetime | None = None,
    ) -> dict:
        """Validate an event and resolve defaults from the current audit context."""
        self.registry.require(feature, action)
        context = current_context()
        actor = actor or (context.actor if context else self.default_actor)
        source = source or (context.source if context else self.default_source)
        if result not in RESULTS:
            raise AuditValidationError(f"result must be one of {sorted(RESULTS)}, got {result!r}")
        if source not in SOURCES:
            raise AuditValidationError(f"source must be one of {sorted(SOURCES)}, got {source!r}")
        for name, value in (("input_hash", input_hash), ("output_hash", output_hash)):
            if value is not None and not HASH_REF_RE.match(value):
                raise AuditValidationError(f"{name} must look like sha256:<64 hex>, got {value!r}")
        if client_ts is not None and client_ts.tzinfo is None:
            raise AuditValidationError("client_ts must be timezone-aware")

        if trace_id is None:
            otel = _otel_ids()
            if otel:
                trace_id, span_id = otel[0], span_id or otel[1]
            elif context:
                trace_id, span_id = context.trace_id, span_id or context.span_id
            else:
                trace_id = new_trace_id()
        span_id = span_id or new_span_id()
        if not TRACE_ID_RE.match(trace_id) or trace_id == "0" * 32:
            raise AuditValidationError(f"invalid trace_id {trace_id!r}")
        if not SPAN_ID_RE.match(span_id):
            raise AuditValidationError(f"invalid span_id {span_id!r}")

        details_json = to_json_text(details)
        if details_json is not None and len(details_json.encode("utf-8")) > MAX_SERVER_DETAILS_BYTES:
            raise AuditValidationError(
                f"details for {feature}.{action} exceed {MAX_SERVER_DETAILS_BYTES} bytes; store large payloads as artifacts"
            )
        target_type, target_id = target if target is not None else (None, None)
        if parent_event_id is None and context is not None:
            parent_event_id = context.parent_event_id
        return {
            "event_id": event_id or uuid.uuid4(),
            "hash_version": HASH_VERSION,
            "trace_id": trace_id,
            "span_id": span_id,
            "parent_event_id": parent_event_id,
            "actor_type": actor.type,
            "actor_id": clean_text(actor.id),
            "actor_version": clean_text(actor.version) if actor.version else None,
            "authenticated": bool(actor.authenticated),
            "source": source,
            "feature": feature,
            "action": action,
            "result": result,
            "target_type": clean_text(str(target_type)) if target_type is not None else None,
            "target_id": clean_text(str(target_id)) if target_id is not None else None,
            "input_hash": input_hash,
            "output_hash": output_hash,
            "error": clean_text(error) if error else None,
            "details_json": details_json,
            "cost_json": to_json_text(cost),
            "evidence_class": evidence_class,
            "policy_json": to_json_text(policy_decision),
            "redaction_json": to_json_text(redaction),
            "client_ts": client_ts,
        }

    # -- appending ----------------------------------------------------------
    def append(self, into: Session | Connection, /, **fields) -> dict:
        """Append one event inside the caller's transaction (`into` is the Session or Connection)."""
        return self.append_rows(into, [self.prepare(**fields)])[0]

    def append_rows(self, into: Session | Connection, rows: list[dict], *, skip_existing: bool = False) -> list[dict]:
        """Chain and insert prepared rows under the append lock, inside the caller's transaction.

        With skip_existing, rows whose event_id is already stored (a client retry) are
        dropped instead of failing the batch.
        """
        if not rows:
            return []
        connection = into.connection() if isinstance(into, Session) else into
        connection.execute(select(func.pg_advisory_xact_lock(AUDIT_LOCK_KEY)))
        if skip_existing:
            unique: dict[uuid.UUID, dict] = {}
            for row in rows:
                unique.setdefault(row["event_id"], row)
            existing = set(
                connection.scalars(select(AuditEvent.event_id).where(AuditEvent.event_id.in_(list(unique))))
            )
            rows = [row for event_id, row in unique.items() if event_id not in existing]
            if not rows:
                return []
        head = connection.execute(
            select(AuditEvent.seq, AuditEvent.hash).order_by(AuditEvent.seq.desc()).limit(1)
        ).first()
        seq, previous = (head.seq, head.hash) if head else (0, GENESIS_HASH)
        now = self.clock()
        written = []
        for row in rows:
            seq += 1
            full = {**row, "seq": seq, "ts": now, "prev_hash": previous}
            full["hash"] = compute_event_hash(full)
            previous = full["hash"]
            written.append(full)
        connection.execute(insert(AuditEvent.__table__), written)
        if isinstance(into, Session):
            note_audit_writes(into, len(written))
        return written

    def commit_event(self, db: "Database", **fields) -> dict:
        """Write one event in its own transaction (request logs, step boundaries, failures)."""
        with db.transaction() as session:
            return self.append(session, **fields)

    # -- last resort --------------------------------------------------------
    def write_fallback(self, fields: dict, exc: BaseException) -> None:
        """Record an event that could not reach the database after its action already ran.

        The file is reported by /api/health, so a degraded audit path is visible instead of silent.
        """
        record = {
            "recorded_at": format_ts(utcnow()),
            "audit_error": f"{type(exc).__name__}: {exc}",
            "event": sanitize({key: value for key, value in fields.items() if key != "actor"}),
            "actor": sanitize(getattr(fields.get("actor"), "__dict__", None)),
        }
        log.error("audit write failed; event recorded in fallback log: %s", record["audit_error"])
        if self.fallback_path is None:
            return
        with self._fallback_lock:
            self.fallback_path.parent.mkdir(parents=True, exist_ok=True)
            with self.fallback_path.open("a", encoding="utf-8") as handle:
                handle.write(dumps_canonical(record) + "\n")

    def fallback_count(self) -> int:
        if self.fallback_path is None or not self.fallback_path.exists():
            return 0
        with self.fallback_path.open("r", encoding="utf-8") as handle:
            return sum(1 for line in handle if line.strip())


@dataclass
class StepHandle:
    """Mutable outcome of an audited step; the finished event reads it."""

    started_event_id: uuid.UUID
    trace_id: str
    target: tuple[str, str] | None = None
    details: dict = field(default_factory=dict)
    result: str = "ok"
    finished_action: str | None = None
    output_hash: str | None = None
    evidence_class: str | None = None


@contextmanager
def audited_step(
    db: "Database",
    writer: AuditWriter,
    *,
    feature: str,
    started: str = "started",
    finished: str = "finished",
    failed: str = "failed",
    target: tuple[str, str] | None = None,
    details: dict | None = None,
    actor: ActorRef | None = None,
    source: str | None = None,
    input_hash: str | None = None,
) -> Iterator[StepHandle]:
    """Run an action that is not a single database transaction (a command, a tool, a verification).

    A `started` event is committed first; if that fails, the action never runs.
    The body's outcome is then recorded as `finished` (or the handle's
    finished_action) or `failed` with the full traceback.
    """
    base = {"actor": actor, "source": source}
    try:
        start = writer.commit_event(
            db, feature=feature, action=started, result="pending", target=target, details=details, input_hash=input_hash, **base
        )
    except Exception as exc:
        raise AuditUnavailableError(f"could not record {feature}.{started}; the action was not run") from exc

    handle = StepHandle(start["event_id"], start["trace_id"], target=target)
    common = {"parent_event_id": start["event_id"], "trace_id": start["trace_id"], **base}
    began = perf_counter()
    try:
        yield handle
    except BaseException as exc:
        fields = dict(
            feature=feature,
            action=failed,
            result="error",
            target=handle.target,
            details={**(details or {}), **handle.details, "exception": type(exc).__name__},
            error=traceback.format_exc(),
            cost={"wall_ms": round((perf_counter() - began) * 1000, 3)},
            **common,
        )
        try:
            writer.commit_event(db, **fields)
        except Exception as audit_exc:
            writer.write_fallback(fields, audit_exc)
        raise
    fields = dict(
        feature=feature,
        action=handle.finished_action or finished,
        result=handle.result,
        target=handle.target,
        details={**(details or {}), **handle.details},
        output_hash=handle.output_hash,
        evidence_class=handle.evidence_class,
        cost={"wall_ms": round((perf_counter() - began) * 1000, 3)},
        **common,
    )
    try:
        writer.commit_event(db, **fields)
    except Exception as audit_exc:
        writer.write_fallback(fields, audit_exc)
        raise AuditUnavailableError(
            f"{feature} completed but its {fields['action']} event could not be written; see the fallback log"
        ) from audit_exc
