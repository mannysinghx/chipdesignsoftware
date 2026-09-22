from __future__ import annotations

import getpass
import secrets
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Iterator

from .. import __version__

ACTOR_TYPES = frozenset({"human", "agent", "system", "evaluator", "anonymous"})
SOURCES = frozenset({"api", "ui", "cli", "system", "worker", "migration"})


@dataclass(frozen=True)
class ActorRef:
    type: str
    id: str
    version: str | None = None
    authenticated: bool = False
    role: str | None = None

    def __post_init__(self) -> None:
        if self.type not in ACTOR_TYPES:
            raise ValueError(f"unknown actor type {self.type!r}")
        if not self.id:
            raise ValueError("actor id is required")


@dataclass
class AuditContext:
    """Per-request (or per-command) state that audit events inherit.

    The middleware creates one per HTTP request. Handlers mutate it: the auth
    dependency sets `actor`, RBAC appends `policy_decisions`, and handlers add
    `notes` that land in the request's http_request event.
    """

    trace_id: str
    span_id: str
    actor: ActorRef
    source: str
    parent_event_id: uuid.UUID | None = None
    policy_decisions: list[dict] = field(default_factory=list)
    notes: dict = field(default_factory=dict)
    client_ip: str | None = None
    user_agent: str | None = None


_CURRENT: ContextVar[AuditContext | None] = ContextVar("aimem_audit_context", default=None)


def current_context() -> AuditContext | None:
    return _CURRENT.get()


@contextmanager
def audit_context(context: AuditContext) -> Iterator[AuditContext]:
    token = _CURRENT.set(context)
    try:
        yield context
    finally:
        _CURRENT.reset(token)


def new_trace_id() -> str:
    return secrets.token_hex(16)


def new_span_id() -> str:
    return secrets.token_hex(8)


SYSTEM_ACTOR = ActorRef("system", "aimem-platform", __version__, authenticated=True)


def cli_actor() -> ActorRef:
    return ActorRef("system", f"cli:{getpass.getuser()}", __version__, authenticated=True)


def migration_actor() -> ActorRef:
    return ActorRef("system", f"alembic:{getpass.getuser()}", __version__, authenticated=True)


def anonymous_actor(client_ip: str | None) -> ActorRef:
    return ActorRef("anonymous", f"ip:{client_ip or 'unknown'}")
