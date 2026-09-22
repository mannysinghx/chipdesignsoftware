from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..audit.canonical import format_ts
from ..audit.context import ActorRef, current_context
from ..audit.writer import utcnow
from ..deps import CurrentUser, feature, get_services, optional_user, session_token
from ..models import User, UserSession
from ..security import dummy_hash, new_session_token, normalize_email, token_digest, verify_password
from ..services import Services

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@router.post("/login", openapi_extra=feature("auth.session"))
def login(body: LoginBody, request: Request, response: Response, services: Services = Depends(get_services)) -> dict:
    context = current_context()
    try:
        email = normalize_email(body.email)
    except ValueError:
        raise HTTPException(422, "Enter a valid email address") from None
    client_ip = _client_ip(request)

    if not services.login_limiter.allow(f"{client_ip}|{email}"):
        services.writer.commit_event(
            services.db,
            feature="auth.session",
            action="login_failed",
            result="denied",
            target=("user", email),
            details={"email": email, "reason": "rate_limited"},
            policy_decision={"rule": "auth.login_rate_limit", "decision": "deny"},
        )
        raise HTTPException(429, "Too many sign-in attempts. Wait a minute and try again.")

    with services.db.read() as session:
        user = session.scalar(select(User).where(User.email == email))
    password_ok = verify_password(body.password, user.password_hash if user else dummy_hash())
    if user is None or not password_ok or not user.is_active:
        reason = "unknown_email" if user is None else "wrong_password" if not password_ok else "inactive_user"
        # The log keeps the exact reason; the response stays generic so it cannot be used to probe accounts.
        services.writer.commit_event(
            services.db,
            feature="auth.session",
            action="login_failed",
            result="denied",
            target=("user", email),
            details={"email": email, "reason": reason},
        )
        raise HTTPException(401, "Invalid email or password")

    now = utcnow()
    token = new_session_token()
    actor = ActorRef("human", user.email, None, authenticated=True, role=user.role)
    user_session = UserSession(
        user_id=user.user_id,
        token_hash=token_digest(token),
        created_at=now,
        expires_at=now + timedelta(hours=services.settings.session_ttl_hours),
        client_ip=client_ip,
        user_agent=(request.headers.get("user-agent") or "")[:300] or None,
    )
    with services.db.transaction() as session:
        session.add(user_session)
        session.flush()
        services.writer.append(
            session,
            feature="auth.session",
            action="login",
            actor=actor,
            target=("user", str(user.user_id)),
            details={"session_id": str(user_session.session_id), "expires_at": format_ts(user_session.expires_at), "role": user.role},
        )
    if context is not None:
        context.actor = actor

    response.set_cookie(
        services.settings.cookie_name,
        token,
        max_age=services.settings.session_ttl_hours * 3600,
        httponly=True,
        secure=services.settings.cookie_secure,
        samesite=services.settings.cookie_samesite,
        path="/",
    )
    payload = {
        "user": {"user_id": str(user.user_id), "email": user.email, "display_name": user.display_name, "role": user.role},
        "expires_at": format_ts(user_session.expires_at),
    }
    # Browsers get an HttpOnly cookie only. Scripts and the CLI ask for the bearer token explicitly.
    if request.headers.get("x-aimem-client") == "cli":
        payload["token"] = token
    return payload


@router.post("/logout", openapi_extra=feature("auth.session"))
def logout(
    request: Request,
    response: Response,
    user: CurrentUser | None = Depends(optional_user),
    services: Services = Depends(get_services),
) -> dict:
    response.delete_cookie(services.settings.cookie_name, path="/")
    token = session_token(request, services.settings.cookie_name)
    if user is None or token is None:
        return {"signed_out": False, "reason": "no active session"}
    with services.db.transaction() as session:
        user_session = session.get(UserSession, user.session_id)
        user_session.revoked_at = utcnow()
        services.writer.append(
            session,
            feature="auth.session",
            action="logout",
            target=("user", str(user.user_id)),
            details={"session_id": str(user.session_id)},
        )
    return {"signed_out": True}


@router.get("/me", openapi_extra=feature("auth.session"))
def me(user: CurrentUser | None = Depends(optional_user)) -> dict:
    if user is None:
        raise HTTPException(401, "Not signed in")
    return {"user": user.as_dict()}
