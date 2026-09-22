"""The audit table is append-only at two independent layers: privileges and triggers."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from conftest import owner_engine

STATEMENTS = {
    "update": "UPDATE aimem.audit_events SET action = 'tampered' WHERE seq = 1",
    "delete": "DELETE FROM aimem.audit_events WHERE seq = 1",
    "truncate": "TRUNCATE aimem.audit_events",
}


@pytest.mark.parametrize("operation", sorted(STATEMENTS))
def test_runtime_role_has_no_mutation_privilege(services, operation):
    with pytest.raises(DBAPIError, match="permission denied"):
        with services.db.engine.begin() as connection:
            connection.execute(text(STATEMENTS[operation]))


@pytest.mark.parametrize("operation", sorted(STATEMENTS))
def test_owner_is_blocked_by_the_append_only_trigger(env, operation):
    engine = owner_engine(env)
    try:
        with pytest.raises(DBAPIError, match="append-only"):
            with engine.begin() as connection:
                connection.execute(text(STATEMENTS[operation]))
    finally:
        engine.dispose()
