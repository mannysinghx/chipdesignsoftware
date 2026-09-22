from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select

from .audit.context import ActorRef, current_context
from .audit.writer import utcnow
from .models import ROLES, User, UserSession
from .security import token_digest
from .services import Services

FEATURE_KEY = "x-aimem-feature"
ROLE_RANK = {role: rank for rank, role in enumerate(ROLES)}


def feature(feature_id: str) -> dict:
    """openapi_extra marker that names a route's feature. Startup fails if a route lacks one."""
    return {FEATURE_KEY: feature_id}


def get_services(request: Request) -> Services:
    return request.app.state.services


@dataclass(frozen=True)
class CurrentUser:
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str
    session_id: uuid.UUID

    def as_actor(self) -> ActorRef:
        return ActorRef("human", self.email, None, authenticated=True, role=self.role)

    def as_dict(self) -> dict:
        return {"user_id": str(self.user_id), "email": self.email, "display_name": self.display_name, "role": self.role}


def session_token(request: Request, cookie_name: str) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return request.cookies.get(cookie_name) or None


def optional_user(request: Request, services: Services = Depends(get_services)) -> CurrentUser | None:
    """Resolve the session, and attribute the request's audit events to its user."""
    token = session_token(request, services.settings.cookie_name)
    if not token:
        return None
    with services.db.read() as session:
        row = session.execute(
            select(UserSession, User)
            .join(User, User.user_id == UserSession.user_id)
            .where(
                UserSession.token_hash == token_digest(token),
                UserSession.revoked_at.is_(None),
                UserSession.expires_at > utcnow(),
                User.is_active.is_(True),
            )
        ).first()
    context = current_context()
    if row is None:
        if context is not None:
            context.notes["auth"] = "invalid_or_expired_session"
        return None
    user_session, user = row
    current = CurrentUser(user.user_id, user.email, user.display_name, user.role, user_session.session_id)
    if context is not None:
        context.actor = current.as_actor()
    return current


def _decide(rule: str, decision: str, required: str, actual: str | None) -> None:
    context = current_context()
    if context is not None:
        context.policy_decisions.append({"rule": rule, "decision": decision, "required_role": required, "actual_role": actual})


def require_role(minimum: str):
    if minimum not in ROLE_RANK:
        raise ValueError(f"unknown role {minimum!r}")

    def dependency(user: CurrentUser | None = Depends(optional_user)) -> CurrentUser:
        if user is None:
            _decide("rbac.authenticated", "deny", minimum, None)
            raise HTTPException(401, "Sign in required", headers={"WWW-Authenticate": "Bearer"})
        if ROLE_RANK[user.role] < ROLE_RANK[minimum]:
            _decide("rbac.min_role", "deny", minimum, user.role)
            raise HTTPException(403, f"This action requires the {minimum} role")
        _decide("rbac.min_role", "allow", minimum, user.role)
        return user

    return dependency
