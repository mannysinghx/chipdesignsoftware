from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from ..agents.mission import KINDS, MissionConflict, create_mission, decide, mission_view, pending_approvals, serialize_mission
from ..audit.context import current_context
from ..deps import CurrentUser, feature, get_services, require_role
from ..models import Mission
from ..services import Services

router = APIRouter(prefix="/api", tags=["agents"])


class MissionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(min_length=1, max_length=64)
    route: Literal["local", "hosted"] | None = None


class DecisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: Literal["mission", "task"]
    id: uuid.UUID
    decision: Literal["approved", "rejected", "needs_work"]
    reason: str | None = Field(default=None, max_length=2000)


@router.post("/missions", openapi_extra=feature("mission.submit"), status_code=201)
def submit_mission(body: MissionBody, user: CurrentUser = Depends(require_role("engineer")), services: Services = Depends(get_services)) -> dict:
    if body.kind not in KINDS:
        raise HTTPException(404, f"Unknown mission {body.kind!r}")
    try:
        mission = create_mission(services, body.kind, actor=user.as_actor(), route=body.route)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from None
    context = current_context()
    if context is not None:
        context.notes["mission_id"] = str(mission.mission_id)
    return {"mission": mission_view(services, mission.mission_id)}


@router.get("/missions", openapi_extra=feature("mission.query"))
def list_missions(
    limit: int = Query(20, ge=1, le=100), _: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)
) -> dict:
    with services.db.read() as session:
        missions = session.scalars(select(Mission).order_by(Mission.created_at.desc()).limit(limit)).all()
    return {"missions": [serialize_mission(mission) for mission in missions]}


@router.get("/missions/{mission_id}", openapi_extra=feature("mission.query"))
def get_mission(mission_id: uuid.UUID, _: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    try:
        return {"mission": mission_view(services, mission_id)}
    except LookupError:
        raise HTTPException(404, "Mission not found") from None


@router.get("/approvals", openapi_extra=feature("approval.inbox"))
def approvals(_: CurrentUser = Depends(require_role("viewer")), services: Services = Depends(get_services)) -> dict:
    return {"approvals": pending_approvals(services)}


@router.post("/approvals", openapi_extra=feature("approval.decide"))
def decide_approval(body: DecisionBody, user: CurrentUser = Depends(require_role("approver")), services: Services = Depends(get_services)) -> dict:
    try:
        result = decide(services, target=body.target, target_id=body.id, decision=body.decision, reason=body.reason, actor=user.as_actor())
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from None
    except MissionConflict as exc:
        raise HTTPException(409, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    context = current_context()
    if context is not None:
        context.notes["decision"] = {"target": body.target, "id": str(body.id), "decision": body.decision}
    return {"decision": result}
