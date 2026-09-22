from __future__ import annotations

import argparse
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, select, text

from aimem_platform.api.users import create_user_record
from aimem_platform.app import create_app
from aimem_platform.config import PLATFORM_ROOT, Settings
from aimem_platform.models import ROLES, AuditEvent
from aimem_platform.operations import serialize_event
from aimem_platform.services import Services, build_services


def _test_urls() -> tuple[str, str]:
    configured = Settings()
    app_url = os.environ.get("AIMEM_TEST_DATABASE_URL") or configured.test_database_url
    owner_url = os.environ.get("AIMEM_TEST_OWNER_DATABASE_URL") or configured.test_owner_database_url
    if not app_url or not owner_url:
        pytest.exit("Set AIMEM_TEST_DATABASE_URL and AIMEM_TEST_OWNER_DATABASE_URL (run platform/scripts/setup-local-db.sh)", returncode=2)
    for url in (app_url, owner_url):
        name = make_url(url).database or ""
        if not (name.startswith("aimem_platform") and name.endswith("_test")):
            pytest.exit(f"Refusing to run against database {name!r}: test databases must be named aimem_platform*_test", returncode=2)
    return app_url, owner_url


def reset_schema(owner_url: str) -> None:
    """Drop and rebuild the test schema through the real migration (which writes system.migrate)."""
    engine = create_engine(owner_url)
    with engine.begin() as connection:
        connection.execute(text("DROP SCHEMA IF EXISTS aimem CASCADE"))
    engine.dispose()
    upgrade(owner_url)


def upgrade(owner_url: str) -> None:
    config = Config(str(PLATFORM_ROOT / "alembic.ini"))
    config.cmd_opts = argparse.Namespace(x=[f"url={owner_url}"])
    command.upgrade(config, "head")


@dataclass
class PlatformEnv:
    settings: Settings
    owner_url: str
    emails: dict[str, str] = field(default_factory=dict)
    passwords: dict[str, str] = field(default_factory=dict)

    def seed(self) -> None:
        services = build_services(self.settings)
        try:
            for role in ROLES:
                email = f"{role}@aimem.test"
                password = secrets.token_urlsafe(18)
                create_user_record(services, email=email, password=password, role=role, display_name=f"Test {role}", via="test")
                self.emails[role] = email
                self.passwords[role] = password
        finally:
            services.close()

    def reset(self) -> None:
        reset_schema(self.owner_url)
        self.seed()


@pytest.fixture(scope="session")
def env(tmp_path_factory) -> PlatformEnv:
    app_url, owner_url = _test_urls()
    settings = Settings(
        _env_file=None,
        environment="test",
        database_url=app_url,
        owner_database_url=owner_url,
        var_dir=tmp_path_factory.mktemp("var"),
        cors_origins=["http://localhost:3000"],
        allow_anonymous_ui_events=True,
        login_attempts_per_minute=10_000,
        ui_events_per_minute=1_000_000,
    )
    test_env = PlatformEnv(settings, owner_url)
    test_env.reset()
    return test_env


@pytest.fixture
def services(env: PlatformEnv):
    built = build_services(env.settings)
    yield built
    built.close()


@pytest.fixture
def app(env: PlatformEnv, services: Services):
    return create_app(env.settings, services=services)


@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def login(client, env: PlatformEnv):
    """login('admin') -> Authorization headers for a bearer session of that role."""

    def _login(role: str) -> dict[str, str]:
        response = client.post(
            "/api/auth/login",
            json={"email": env.emails[role], "password": env.passwords[role]},
            headers={"x-aimem-client": "cli"},
        )
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['token']}"}

    return _login


def head_seq(services: Services) -> int:
    with services.db.read() as session:
        return session.scalar(select(AuditEvent.seq).order_by(AuditEvent.seq.desc()).limit(1)) or 0


def events_since(services: Services, seq: int) -> list[dict]:
    with services.db.read() as session:
        rows = session.scalars(select(AuditEvent).where(AuditEvent.seq > seq).order_by(AuditEvent.seq)).all()
    return [serialize_event(row) for row in rows]


def find(events: list[dict], **criteria) -> list[dict]:
    def matches(event: dict) -> bool:
        for key, expected in criteria.items():
            value = event
            for part in key.split("__"):
                value = value.get(part) if isinstance(value, dict) else None
            if value != expected:
                return False
        return True

    return [event for event in events if matches(event)]


def owner_engine(env: PlatformEnv):
    return create_engine(env.owner_url)


PLATFORM_DIR = Path(__file__).resolve().parent.parent
