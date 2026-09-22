"""Audit backbone: append-only hash-chained audit_events, users, sessions, artifacts.

Revision ID: 0001_audit_backbone
Revises:
Create Date: 2026-09-22
"""

from __future__ import annotations

import os
import re

import sqlalchemy as sa
from alembic import op

revision = "0001_audit_backbone"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = "aimem"
ROLE_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def _app_role() -> str:
    role = os.environ.get("AIMEM_APP_ROLE", "aimem_platform_app")
    if not ROLE_RE.match(role):
        raise RuntimeError(f"AIMEM_APP_ROLE {role!r} is not a plain lowercase role name")
    return role


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("hash_version", sa.SmallInteger(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("trace_id", sa.Text(), nullable=False),
        sa.Column("span_id", sa.Text(), nullable=False),
        sa.Column("parent_event_id", sa.Uuid(), nullable=True),
        sa.Column("actor_type", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Text(), nullable=False),
        sa.Column("actor_version", sa.Text(), nullable=True),
        sa.Column("authenticated", sa.Boolean(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("feature", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("result", sa.Text(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=True),
        sa.Column("target_id", sa.Text(), nullable=True),
        sa.Column("input_hash", sa.Text(), nullable=True),
        sa.Column("output_hash", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("details_json", sa.Text(), nullable=True),
        sa.Column("cost_json", sa.Text(), nullable=True),
        sa.Column("evidence_class", sa.Text(), nullable=True),
        sa.Column("policy_json", sa.Text(), nullable=True),
        sa.Column("redaction_json", sa.Text(), nullable=True),
        sa.Column("client_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("prev_hash", sa.Text(), nullable=False),
        sa.Column("hash", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("event_id", name=op.f("pk_audit_events")),
        sa.UniqueConstraint("seq", name=op.f("uq_audit_events_seq")),
        sa.UniqueConstraint("hash", name=op.f("uq_audit_events_hash")),
        sa.CheckConstraint("seq > 0", name=op.f("ck_audit_events_seq_positive")),
        sa.CheckConstraint(
            "actor_type IN ('human','agent','system','evaluator','anonymous')", name=op.f("ck_audit_events_actor_type")
        ),
        sa.CheckConstraint("result IN ('ok','error','denied','pending','info')", name=op.f("ck_audit_events_result")),
        sa.CheckConstraint(
            "source IN ('api','ui','cli','system','worker','migration')", name=op.f("ck_audit_events_source")
        ),
        sa.CheckConstraint("trace_id ~ '^[0-9a-f]{32}$'", name=op.f("ck_audit_events_trace_id_format")),
        sa.CheckConstraint("span_id ~ '^[0-9a-f]{16}$'", name=op.f("ck_audit_events_span_id_format")),
        sa.CheckConstraint(
            "hash ~ '^[0-9a-f]{64}$' AND prev_hash ~ '^[0-9a-f]{64}$'", name=op.f("ck_audit_events_hash_format")
        ),
        schema=SCHEMA,
    )
    for name, columns in (
        ("ix_audit_events_ts", ["ts"]),
        ("ix_audit_events_feature_seq", ["feature", "seq"]),
        ("ix_audit_events_trace_id", ["trace_id"]),
        ("ix_audit_events_actor_id_seq", ["actor_id", "seq"]),
        ("ix_audit_events_target", ["target_type", "target_id"]),
        ("ix_audit_events_source_seq", ["source", "seq"]),
    ):
        op.create_index(op.f(name), "audit_events", columns, schema=SCHEMA)

    op.create_table(
        "users",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
        sa.CheckConstraint("role IN ('viewer','engineer','approver','admin')", name=op.f("ck_users_role")),
        sa.CheckConstraint("email = lower(email) AND position('@' in email) > 1", name=op.f("ck_users_email_normalized")),
        schema=SCHEMA,
    )

    op.create_table(
        "user_sessions",
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("client_ip", sa.Text(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("session_id", name=op.f("pk_user_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_user_sessions_token_hash")),
        sa.ForeignKeyConstraint(["user_id"], [f"{SCHEMA}.users.user_id"], name=op.f("fk_user_sessions_user_id_users")),
        schema=SCHEMA,
    )
    op.create_index(op.f("ix_user_sessions_user_id"), "user_sessions", ["user_id"], schema=SCHEMA)

    op.create_table(
        "artifacts",
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("evidence_class", sa.Text(), nullable=False),
        sa.Column("provenance_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("sha256", name=op.f("pk_artifacts")),
        sa.CheckConstraint("sha256 ~ '^[0-9a-f]{64}$'", name=op.f("ck_artifacts_sha256_format")),
        sa.CheckConstraint(
            "evidence_class IN ('executed','modeled','planned','restricted','measured','unclassified')",
            name=op.f("ck_artifacts_evidence_class"),
        ),
        schema=SCHEMA,
    )

    # Append-only enforcement. Row triggers block UPDATE and DELETE; a statement
    # trigger blocks TRUNCATE. The runtime role additionally holds no UPDATE,
    # DELETE, or TRUNCATE privilege on this table.
    op.execute(
        f"""
        CREATE FUNCTION {SCHEMA}.audit_events_block_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION '{SCHEMA}.audit_events is append-only: % is not allowed', TG_OP
            USING ERRCODE = 'insufficient_privilege',
                  HINT = 'Audit events are never edited or deleted. Record a correcting event instead.';
        END
        $$;
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER audit_events_block_update_delete
          BEFORE UPDATE OR DELETE ON {SCHEMA}.audit_events
          FOR EACH ROW EXECUTE FUNCTION {SCHEMA}.audit_events_block_mutation();
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER audit_events_block_truncate
          BEFORE TRUNCATE ON {SCHEMA}.audit_events
          FOR EACH STATEMENT EXECUTE FUNCTION {SCHEMA}.audit_events_block_mutation();
        """
    )

    app = _app_role()
    op.execute(f"REVOKE ALL ON SCHEMA {SCHEMA} FROM PUBLIC")
    op.execute(f"GRANT USAGE ON SCHEMA {SCHEMA} TO {app}")
    op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA {SCHEMA} FROM PUBLIC")
    op.execute(f"GRANT SELECT, INSERT ON {SCHEMA}.audit_events TO {app}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON {SCHEMA}.users, {SCHEMA}.user_sessions TO {app}")
    op.execute(f"GRANT SELECT, INSERT ON {SCHEMA}.artifacts TO {app}")
    op.execute(f"GRANT SELECT ON {SCHEMA}.alembic_version TO {app}")


def downgrade() -> None:
    if os.environ.get("AIMEM_ALLOW_AUDIT_DROP") != "1":
        raise RuntimeError(
            "Refusing to drop the audit log. Set AIMEM_ALLOW_AUDIT_DROP=1 only for a disposable database."
        )
    op.drop_table("artifacts", schema=SCHEMA)
    op.drop_table("user_sessions", schema=SCHEMA)
    op.drop_table("users", schema=SCHEMA)
    op.execute(f"DROP TRIGGER IF EXISTS audit_events_block_truncate ON {SCHEMA}.audit_events")
    op.execute(f"DROP TRIGGER IF EXISTS audit_events_block_update_delete ON {SCHEMA}.audit_events")
    op.drop_table("audit_events", schema=SCHEMA)
    op.execute(f"DROP FUNCTION IF EXISTS {SCHEMA}.audit_events_block_mutation()")
