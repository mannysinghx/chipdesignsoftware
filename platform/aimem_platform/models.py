from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index, MetaData, SmallInteger, Text, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

SCHEMA = "aimem"

NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

ROLES = ("viewer", "engineer", "approver", "admin")
EVIDENCE_CLASSES = ("executed", "modeled", "planned", "restricted", "measured", "unclassified")


class Base(DeclarativeBase):
    metadata = MetaData(schema=SCHEMA, naming_convention=NAMING)


class AuditEvent(Base):
    """One row per action. Append-only: a trigger rejects UPDATE, DELETE, and TRUNCATE,
    and the runtime role holds only INSERT and SELECT."""

    __tablename__ = "audit_events"
    __table_args__ = (
        CheckConstraint("seq > 0", name="seq_positive"),
        CheckConstraint("actor_type IN ('human','agent','system','evaluator','anonymous')", name="actor_type"),
        CheckConstraint("result IN ('ok','error','denied','pending','info')", name="result"),
        CheckConstraint("source IN ('api','ui','cli','system','worker','migration')", name="source"),
        CheckConstraint("trace_id ~ '^[0-9a-f]{32}$'", name="trace_id_format"),
        CheckConstraint("span_id ~ '^[0-9a-f]{16}$'", name="span_id_format"),
        CheckConstraint("hash ~ '^[0-9a-f]{64}$' AND prev_hash ~ '^[0-9a-f]{64}$'", name="hash_format"),
        Index("ix_audit_events_ts", "ts"),
        Index("ix_audit_events_feature_seq", "feature", "seq"),
        Index("ix_audit_events_trace_id", "trace_id"),
        Index("ix_audit_events_actor_id_seq", "actor_id", "seq"),
        Index("ix_audit_events_target", "target_type", "target_id"),
        Index("ix_audit_events_source_seq", "source", "seq"),
    )

    seq: Mapped[int] = mapped_column(BigInteger, nullable=False, unique=True)
    event_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    hash_version: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    trace_id: Mapped[str] = mapped_column(Text, nullable=False)
    span_id: Mapped[str] = mapped_column(Text, nullable=False)
    parent_event_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    actor_type: Mapped[str] = mapped_column(Text, nullable=False)
    actor_id: Mapped[str] = mapped_column(Text, nullable=False)
    actor_version: Mapped[str | None] = mapped_column(Text)
    authenticated: Mapped[bool] = mapped_column(Boolean, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    feature: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    result: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str | None] = mapped_column(Text)
    target_id: Mapped[str | None] = mapped_column(Text)
    input_hash: Mapped[str | None] = mapped_column(Text)
    output_hash: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    details_json: Mapped[str | None] = mapped_column(Text)
    cost_json: Mapped[str | None] = mapped_column(Text)
    evidence_class: Mapped[str | None] = mapped_column(Text)
    policy_json: Mapped[str | None] = mapped_column(Text)
    redaction_json: Mapped[str | None] = mapped_column(Text)
    client_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    prev_hash: Mapped[str] = mapped_column(Text, nullable=False)
    hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('viewer','engineer','approver','admin')", name="role"),
        CheckConstraint("email = lower(email) AND position('@' in email) > 1", name="email_normalized"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class UserSession(Base):
    __tablename__ = "user_sessions"

    session_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.user_id"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    client_ip: Mapped[str | None] = mapped_column(Text)
    user_agent: Mapped[str | None] = mapped_column(Text)


class Artifact(Base):
    """Metadata for a content-addressed blob. The bytes live under var/artifacts/sha256/."""

    __tablename__ = "artifacts"
    __table_args__ = (
        CheckConstraint("sha256 ~ '^[0-9a-f]{64}$'", name="sha256_format"),
        CheckConstraint(
            "evidence_class IN ('executed','modeled','planned','restricted','measured','unclassified')",
            name="evidence_class",
        ),
    )

    sha256: Mapped[str] = mapped_column(Text, primary_key=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    media_type: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_class: Mapped[str] = mapped_column(Text, nullable=False)
    provenance_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
