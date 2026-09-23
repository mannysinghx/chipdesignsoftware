"""Phase 2 agents: missions over the open-node DAG and their state-machine tasks.

Revision ID: 0003_agents
Revises: 0002_runs
Create Date: 2026-09-22
"""

from __future__ import annotations

import os
import re

import sqlalchemy as sa
from alembic import op

revision = "0003_agents"
down_revision = "0002_runs"
branch_labels = None
depends_on = None

SCHEMA = "aimem"
ROLE_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
STATES = (
    "CREATED", "CONTEXT_VALIDATED", "PLAN_PROPOSED", "APPROVED_IF_REQUIRED", "RUNNING_TOOLS",
    "EVIDENCE_COLLECTED", "SELF_CHECKED", "REVIEW_REQUIRED", "ACCEPTED", "REJECTED", "NEEDS_WORK",
)


def _app_role() -> str:
    role = os.environ.get("AIMEM_APP_ROLE", "aimem_platform_app")
    if not ROLE_RE.match(role):
        raise RuntimeError(f"AIMEM_APP_ROLE {role!r} is not a plain lowercase role name")
    return role


def upgrade() -> None:
    op.create_table(
        "missions",
        sa.Column("mission_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("requested_by", sa.Text(), nullable=False),
        sa.Column("trace_id", sa.Text(), nullable=False),
        sa.Column("root_event_id", sa.Uuid(), nullable=True),
        sa.Column("model_route", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("budget_json", sa.Text(), nullable=False),
        sa.Column("usage_json", sa.Text(), nullable=False),
        sa.Column("approval_json", sa.Text(), nullable=True),
        sa.Column("bundle_sha256", sa.Text(), nullable=True),
        sa.Column("summary_json", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("launched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("mission_id", name=op.f("pk_missions")),
        sa.CheckConstraint(
            "status IN ('pending_launch','running','awaiting_approval','completed','rejected','halted')",
            name=op.f("ck_missions_status"),
        ),
        sa.CheckConstraint("model_route IN ('local','hosted','scripted')", name=op.f("ck_missions_model_route")),
        sa.CheckConstraint("trace_id ~ '^[0-9a-f]{32}$'", name=op.f("ck_missions_trace_id_format")),
        schema=SCHEMA,
    )
    op.create_index(op.f("ix_missions_status_created_at"), "missions", ["status", "created_at"], schema=SCHEMA)

    op.create_table(
        "agent_tasks",
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("mission_id", sa.Uuid(), nullable=False),
        sa.Column("node", sa.Text(), nullable=False),
        sa.Column("agent", sa.Text(), nullable=False),
        sa.Column("agent_version", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("root_event_id", sa.Uuid(), nullable=True),
        sa.Column("depends_on_json", sa.Text(), nullable=False),
        sa.Column("tools_json", sa.Text(), nullable=False),
        sa.Column("worktree", sa.Text(), nullable=False),
        sa.Column("context_json", sa.Text(), nullable=True),
        sa.Column("plan_json", sa.Text(), nullable=True),
        sa.Column("evidence_json", sa.Text(), nullable=True),
        sa.Column("check_json", sa.Text(), nullable=True),
        sa.Column("approval_json", sa.Text(), nullable=True),
        sa.Column("usage_json", sa.Text(), nullable=False),
        sa.Column("halt_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("task_id", name=op.f("pk_agent_tasks")),
        sa.ForeignKeyConstraint(["mission_id"], [f"{SCHEMA}.missions.mission_id"], name=op.f("fk_agent_tasks_mission_id_missions")),
        sa.CheckConstraint("state IN (" + ",".join(f"'{state}'" for state in STATES) + ")", name=op.f("ck_agent_tasks_state")),
        schema=SCHEMA,
    )
    op.create_index(op.f("ix_agent_tasks_mission_id_node"), "agent_tasks", ["mission_id", "node"], unique=True, schema=SCHEMA)

    app = _app_role()
    op.execute(f"REVOKE ALL ON {SCHEMA}.missions, {SCHEMA}.agent_tasks FROM PUBLIC")
    # Missions and tasks change state as they run; nothing is ever deleted.
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON {SCHEMA}.missions, {SCHEMA}.agent_tasks TO {app}")


def downgrade() -> None:
    op.drop_table("agent_tasks", schema=SCHEMA)
    op.drop_table("missions", schema=SCHEMA)
