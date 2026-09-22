"""No log, no action at the database layer: domain writes cannot commit without an audit event."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, update

from aimem_platform.audit.guard import UnauditedWriteError
from aimem_platform.audit.writer import utcnow
from aimem_platform.models import Artifact, User


def artifact_row() -> Artifact:
    digest = uuid.uuid4().hex * 2
    return Artifact(
        sha256=digest,
        size_bytes=1,
        media_type="text/plain",
        name="guard-test.txt",
        evidence_class="unclassified",
        provenance_json="{}",
        created_at=utcnow(),
        created_by="guard-test",
    )


def test_orm_insert_without_an_audit_event_is_refused_and_rolled_back(services):
    row = artifact_row()
    with pytest.raises(UnauditedWriteError):
        with services.db.transaction() as session:
            session.add(row)
    with services.db.read() as session:
        assert session.get(Artifact, row.sha256) is None


def test_orm_insert_with_an_audit_event_commits(services):
    row = artifact_row()
    with services.db.transaction() as session:
        session.add(row)
        services.writer.append(session, feature="artifact.write", action="artifact_written", target=("artifact", row.sha256))
    with services.db.read() as session:
        assert session.get(Artifact, row.sha256) is not None


def test_core_update_without_an_audit_event_is_refused(services, env):
    with pytest.raises(UnauditedWriteError):
        with services.db.transaction() as session:
            session.execute(update(User).where(User.email == env.emails["viewer"]).values(display_name="changed silently"))
    with services.db.read() as session:
        assert session.scalar(select(User.display_name).where(User.email == env.emails["viewer"])) == "Test viewer"


def test_dirty_orm_object_without_an_audit_event_is_refused(services, env):
    with pytest.raises(UnauditedWriteError):
        with services.db.transaction() as session:
            user = session.scalar(select(User).where(User.email == env.emails["viewer"]))
            user.display_name = "changed silently"


def test_read_only_transactions_are_unaffected(services):
    with services.db.transaction() as session:
        session.scalars(select(User)).all()
