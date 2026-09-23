from .agents import router as agents_router
from .artifacts import router as artifacts_router
from .audit import router as audit_router
from .auth import router as auth_router
from .meta import router as meta_router
from .runs import router as runs_router
from .ui_events import router as ui_events_router
from .users import router as users_router

ROUTERS = [meta_router, auth_router, users_router, ui_events_router, audit_router, artifacts_router, runs_router, agents_router]

__all__ = ["ROUTERS"]
