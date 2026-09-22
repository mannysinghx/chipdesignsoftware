from __future__ import annotations

import traceback
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..audit.canonical import format_ts
from ..audit.writer import utcnow
from ..deps import CurrentUser, feature, get_services, require_role
from ..models import User, UserSession
from ..security import hash_password, normalize_email, validate_password
from ..services import Services

router = APIRouter(prefix="/api/users", tags=["users"])
Role = Literal["viewer", "engineer", "approver", "admin"]


class CreateUserBody(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    display_name: str | None = Field(default=None, max_length=200)
    role: Role = "viewer"
    password: str = Field(min_length=1, max_length=1024)


class UpdateUserBody(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    role: Role | None = None
    is_active: bool | None = None


def _public(user: User) -> dict:
    return {
        "user_id": str(user.user_id),
        "email": user.email,
        "display_name": user.display_name,
        "role": user.role,
        "is_active": user.is_active,
        "created_at": format_ts(user.created_at),
        "updated_at": format_ts(user.updated_at),
    }


def create_user_record(services: Services, *, email: str, password: str, role: str, display_name: str | None, via: str) -> User:
    """Create a user and its audit event in one transaction. Used by the API and the CLI."""
    email = normalize_email(email)
    validate_password(password)
    now = utcnow()
    user = User(
        user_id=uuid.uuid4(),
        email=email,
        display_name=(display_name or email.split("@")[0]).strip(),
        role=role,
        password_hash=hash_password(password),
        is_active=True,
        created_at=now,
        updated_at=now,
    )
    try:
        with services.db.transaction() as session:
            session.add(user)
            session.flush()
            services.writer.append(
                session,
                feature="auth.user",
                action="created",
                target=("user", str(user.user_id)),
                details={"email": email, "role": role, "display_name": user.display_name, "via": via},
            )
    except IntegrityError:
        services.writer.commit_event(
            services.db,
            feature="auth.user",
            action="failed",
            result="error",
            target=("user", email),
            details={"email": email, "operation": "create", "reason": "email_exists", "via": via},
        )
        raise ValueError(f"a user with email {email} already exists") from None
    except Exception:
        services.writer.commit_event(
            services.db,
            feature="auth.user",
            action="failed",
            result="error",
            target=("user", email),
            details={"email": email, "operation": "create", "via": via},
            error=traceback.format_exc(),
        )
        raise
    return user


@router.get("", openapi_extra=feature("auth.user"))
def list_users(_: CurrentUser = Depends(require_role("admin")), services: Services = Depends(get_services)) -> dict:
    with services.db.read() as session:
        users = session.scalars(select(User).order_by(User.created_at)).all()
    return {"users": [_public(user) for user in users]}


@router.post("", openapi_extra=feature("auth.user"), status_code=201)
def create_user(
    body: CreateUserBody, _: CurrentUser = Depends(require_role("admin")), services: Services = Depends(get_services)
) -> dict:
    try:
        user = create_user_record(
            services, email=body.email, password=body.password, role=body.role, display_name=body.display_name, via="api"
        )
    except ValueError as exc:
        raise HTTPException(409 if "already exists" in str(exc) else 422, str(exc)) from None
    return {"user": _public(user)}


@router.patch("/{user_id}", openapi_extra=feature("auth.user"))
def update_user(
    user_id: uuid.UUID,
    body: UpdateUserBody,
    admin: CurrentUser = Depends(require_role("admin")),
    services: Services = Depends(get_services),
) -> dict:
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(422, "Nothing to update")
    if user_id == admin.user_id and (changes.get("role", "admin") != "admin" or changes.get("is_active") is False):
        raise HTTPException(409, "Admins cannot demote or deactivate themselves; ask another admin")
    with services.db.transaction() as session:
        user = session.get(User, user_id)
        if user is None:
            raise HTTPException(404, "User not found")
        before = {key: getattr(user, key) for key in changes}
        for key, value in changes.items():
            setattr(user, key, value)
        user.updated_at = utcnow()
        revoked = 0
        if changes.get("is_active") is False:
            for user_session in session.scalars(
                select(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
            ):
                user_session.revoked_at = user.updated_at
                revoked += 1
        services.writer.append(
            session,
            feature="auth.user",
            action="updated",
            target=("user", str(user_id)),
            details={"email": user.email, "before": before, "after": changes, "sessions_revoked": revoked},
        )
    return {"user": _public(user)}
