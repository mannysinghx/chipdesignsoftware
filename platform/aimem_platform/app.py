from __future__ import annotations

import platform as host_platform
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from . import __version__
from .api import ROUTERS
from .config import Settings, get_settings
from .deps import FEATURE_KEY
from .features import FeatureRegistry, UnknownFeatureError
from .middleware import AuditMiddleware
from .services import Services, build_services
from .telemetry import setup_tracing


class RouteFeatureError(RuntimeError):
    """A route has no registered feature, so its requests could not be attributed."""


class _AppRoutes:
    def __init__(self, routes):
        self.routes = routes


def validate_route_features(routers, registry: FeatureRegistry) -> list[tuple[str, str, str]]:
    """Refuse to start unless every route names a registered api feature.

    FastAPI 0.14x wraps included routers (app.routes holds _IncludedRouter
    objects), so the routers are validated directly; create_app refuses any
    route attached to the app some other way.
    """
    table = []
    for route in (route for router in routers for route in router.routes):
        if not isinstance(route, APIRoute):
            raise RouteFeatureError(f"route {getattr(route, 'path', route)!r} is not an APIRoute and cannot declare a feature")
        feature_id = (route.openapi_extra or {}).get(FEATURE_KEY)
        if not feature_id:
            raise RouteFeatureError(f"route {sorted(route.methods)} {route.path} does not declare a feature")
        try:
            feature = registry.get(feature_id)
        except UnknownFeatureError as exc:
            raise RouteFeatureError(f"route {route.path}: {exc}") from None
        if feature.kind != "api":
            raise RouteFeatureError(f"route {route.path} names {feature_id}, which is a {feature.kind} feature")
        for method in sorted(route.methods):
            table.append((method, route.path, feature_id))
    return table


def create_app(settings: Settings | None = None, *, services: Services | None = None) -> FastAPI:
    settings = settings or get_settings()
    setup_tracing(environment=settings.environment, console=settings.otel_console)
    services = services or build_services(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            services.writer.commit_event(
                services.db,
                feature="system.lifecycle",
                action="started",
                target=("service", "aimem-platform"),
                details={
                    "version": __version__,
                    "environment": settings.environment,
                    "database": services.db.name,
                    "registry_digest": services.registry.digest,
                    "features": len(services.registry),
                    "routes": len(route_table),
                    "python": host_platform.python_version(),
                    "cors_origins": settings.cors_origins,
                    "allow_anonymous_ui_events": settings.allow_anonymous_ui_events,
                },
            )
        except Exception as exc:
            raise RuntimeError(
                "The audit log is unavailable, so the platform refuses to start. "
                "Check the database and run `alembic upgrade head` in platform/."
            ) from exc
        try:
            yield
        finally:
            fields = dict(feature="system.lifecycle", action="stopped", target=("service", "aimem-platform"), details={"version": __version__})
            try:
                services.writer.commit_event(services.db, **fields)
            except Exception as exc:
                services.writer.write_fallback(fields, exc)
            services.close()

    app = FastAPI(
        title="AIMEM Platform API",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.services = services
    route_table = validate_route_features(ROUTERS, services.registry)
    for router in ROUTERS:
        app.include_router(router)
    # Anything attached to the app itself must also carry a feature. Included-router
    # wrappers were validated above through their routers.
    validate_route_features([_AppRoutes([route for route in app.routes if type(route).__name__ != "_IncludedRouter"])], services.registry)
    app.state.route_table = route_table

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
        allow_headers=[
            "content-type",
            "traceparent",
            "tracestate",
            "x-aimem-client",
            "x-artifact-name",
            "x-evidence-class",
            "x-git-revision",
            "x-tool-identity",
            "x-input-hashes",
            "x-limitations",
        ],
        expose_headers=["x-aimem-trace-id"],
        max_age=600,
    )
    # Added last, so it is the outermost middleware and sees every request, including preflights.
    app.add_middleware(AuditMiddleware)
    return app
