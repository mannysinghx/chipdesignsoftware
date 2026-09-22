"""Database-layer enforcement of "no log, no action".

Sessions of class AuditedSession count domain writes (ORM flushes and DML
statements on any table other than audit_events) and audit writes. A commit
that changed domain rows without writing at least one audit event in the same
transaction raises UnauditedWriteError, and the transaction rolls back.

Writes that bypass the Session entirely (raw connections, text() DML) are
caught by the static check in tests/test_static_audit_lint.py.
"""

from __future__ import annotations

from sqlalchemy import event
from sqlalchemy.orm import ORMExecuteState, Session, SessionTransaction

AUDIT_TABLE = "audit_events"
DOMAIN_WRITES = "aimem_domain_writes"
AUDIT_WRITES = "aimem_audit_writes"


class UnauditedWriteError(RuntimeError):
    """A transaction tried to commit domain changes without an audit event."""


def _is_audit_object(obj: object) -> bool:
    return getattr(getattr(obj, "__table__", None), "name", None) == AUDIT_TABLE


def note_audit_writes(session: Session, count: int) -> None:
    session.info[AUDIT_WRITES] = session.info.get(AUDIT_WRITES, 0) + count


def _note_domain_writes(session: Session, count: int) -> None:
    session.info[DOMAIN_WRITES] = session.info.get(DOMAIN_WRITES, 0) + count


def install_write_guard(session_class: type[Session]) -> None:
    @event.listens_for(session_class, "before_flush")
    def _count_orm_changes(session: Session, flush_context, instances) -> None:
        changed = [obj for obj in (*session.new, *session.deleted) if not _is_audit_object(obj)]
        changed += [obj for obj in session.dirty if not _is_audit_object(obj) and session.is_modified(obj)]
        if changed:
            _note_domain_writes(session, len(changed))

    @event.listens_for(session_class, "do_orm_execute")
    def _count_dml(state: ORMExecuteState) -> None:
        if state.is_insert or state.is_update or state.is_delete:
            table = getattr(state.statement, "table", None)
            if getattr(table, "name", None) != AUDIT_TABLE:
                _note_domain_writes(state.session, 1)

    @event.listens_for(session_class, "before_commit")
    def _require_audit_event(session: Session) -> None:
        # before_commit fires before the final autoflush, so flush now to count pending changes.
        session.flush()
        if session.info.get(DOMAIN_WRITES, 0) and not session.info.get(AUDIT_WRITES, 0):
            writes = session.info.get(DOMAIN_WRITES, 0)
            raise UnauditedWriteError(
                f"refusing to commit {writes} domain write(s) without an audit event in the same transaction"
            )

    @event.listens_for(session_class, "after_transaction_end")
    def _reset(session: Session, transaction: SessionTransaction) -> None:
        if transaction.parent is None:
            session.info.pop(DOMAIN_WRITES, None)
            session.info.pop(AUDIT_WRITES, None)
