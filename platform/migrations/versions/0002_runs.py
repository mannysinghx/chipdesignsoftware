"""Phase 1 runs: sandboxed tool executions and the files they consumed and produced.

Revision ID: 0002_runs
Revises: 0001_audit_backbone
Create Date: 2026-09-22
"""

from __future__ import annotations

import os
import re

import sqlalchemy as sa
from alembic import op

revision = "0002_runs"
down_revision = "0001_audit_backbone"
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
        "runs",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("adapter", sa.Text(), nullable=False),
        sa.Column("adapter_version", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("verdict", sa.Text(), nullable=True),
        sa.Column("spec_json", sa.Text(), nullable=False),
        sa.Column("spec_hash", sa.Text(), nullable=False),
        sa.Column("params_json", sa.Text(), nullable=False),
        sa.Column("requested_by", sa.Text(), nullable=False),
        sa.Column("trace_id", sa.Text(), nullable=False),
        sa.Column("git_json", sa.Text(), nullable=True),
        sa.Column("reproduction_of", sa.Uuid(), nullable=True),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("worker_id", sa.Text(), nullable=True),
        sa.Column("runner", sa.Text(), nullable=True),
        sa.Column("exit_code", sa.BigInteger(), nullable=True),
        sa.Column("summary_json", sa.Text(), nullable=True),
        sa.Column("output_manifest_hash", sa.Text(), nullable=True),
        sa.Column("evidence_class", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.PrimaryKeyConstraint("run_id", name=op.f("pk_runs")),
        sa.CheckConstraint(
            "status IN ('queued','running','succeeded','failed','errored','timed_out','cancelled')",
            name=op.f("ck_runs_status"),
        ),
        sa.CheckConstraint("spec_hash ~ '^[0-9a-f]{64}$'", name=op.f("ck_runs_spec_hash_format")),
        sa.CheckConstraint("trace_id ~ '^[0-9a-f]{32}$'", name=op.f("ck_runs_trace_id_format")),
        schema=SCHEMA,
    )
    op.create_index(op.f("ix_runs_status_queued_at"), "runs", ["status", "queued_at"], schema=SCHEMA)
    op.create_index(op.f("ix_runs_adapter_queued_at"), "runs", ["adapter", "queued_at"], schema=SCHEMA)

    op.create_table(
        "run_files",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("normalized_sha256", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("run_id", "role", "path", name=op.f("pk_run_files")),
        sa.ForeignKeyConstraint(["run_id"], [f"{SCHEMA}.runs.run_id"], name=op.f("fk_run_files_run_id_runs")),
        sa.CheckConstraint("role IN ('input','output','log')", name=op.f("ck_run_files_role")),
        sa.CheckConstraint("sha256 ~ '^[0-9a-f]{64}$'", name=op.f("ck_run_files_sha256_format")),
        schema=SCHEMA,
    )

    app = _app_role()
    op.execute(f"REVOKE ALL ON {SCHEMA}.runs, {SCHEMA}.run_files FROM PUBLIC")
    # Runs change state as they execute; the files they touched are recorded once.
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON {SCHEMA}.runs TO {app}")
    op.execute(f"GRANT SELECT, INSERT ON {SCHEMA}.run_files TO {app}")


def downgrade() -> None:
    op.drop_table("run_files", schema=SCHEMA)
    op.drop_table("runs", schema=SCHEMA)
