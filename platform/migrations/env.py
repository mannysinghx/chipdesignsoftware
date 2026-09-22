"""Alembic environment.

Migrations run as the owner role, and each run records a system.migrate event
inside the migration transaction: the schema change and its audit event commit
or roll back together.
"""

from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine, inspect, make_url, pool, text

from aimem_platform.audit.context import migration_actor
from aimem_platform.audit.writer import AuditWriter
from aimem_platform.config import get_settings
from aimem_platform.features import FeatureRegistry
from aimem_platform.models import SCHEMA, Base

config = context.config


def _database_url() -> str:
    url = context.get_x_argument(as_dictionary=True).get("url") or get_settings().owner_database_url
    if not url:
        raise SystemExit("Set AIMEM_OWNER_DATABASE_URL in platform/.env or pass `alembic -x url=...` (owner role).")
    return url


def _record_migration(connection, before: tuple[str, ...]) -> None:
    if not inspect(connection).has_table("audit_events", schema=SCHEMA):
        return  # downgraded below the audit backbone; nothing to write to
    after = tuple(context.get_context().get_current_heads())
    settings = get_settings()
    writer = AuditWriter(FeatureRegistry.load(settings.features_path), default_actor=migration_actor(), default_source="migration")
    writer.append(
        connection,
        feature="system.migrate",
        action="finished",
        target=("database", make_url(connection.engine.url).database or "unknown"),
        details={"from_revisions": list(before), "to_revisions": list(after), "changed": before != after},
    )


def run_migrations_offline() -> None:
    raise SystemExit("Offline (SQL script) migrations are not supported: every migration must write its audit event.")


def run_migrations_online() -> None:
    engine = create_engine(_database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        connection.commit()
        context.configure(
            connection=connection,
            target_metadata=Base.metadata,
            version_table_schema=SCHEMA,
            include_schemas=True,
        )
        with context.begin_transaction():
            before = tuple(context.get_context().get_current_heads())
            context.run_migrations()
            _record_migration(connection, before)


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
