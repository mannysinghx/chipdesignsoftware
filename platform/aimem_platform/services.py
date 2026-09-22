from __future__ import annotations

from dataclasses import dataclass

from .artifacts import ArtifactStore
from .audit.context import SYSTEM_ACTOR, ActorRef
from .audit.verifier import AnchorStore
from .audit.writer import AuditWriter
from .config import Settings
from .db import Database
from .features import FeatureRegistry
from .ratelimit import SlidingWindowLimiter


@dataclass
class Services:
    settings: Settings
    registry: FeatureRegistry
    db: Database
    writer: AuditWriter
    artifacts: ArtifactStore
    anchors: AnchorStore
    ui_limiter: SlidingWindowLimiter
    login_limiter: SlidingWindowLimiter

    def close(self) -> None:
        self.db.dispose()


def build_services(
    settings: Settings,
    *,
    database_url: str | None = None,
    default_actor: ActorRef = SYSTEM_ACTOR,
    default_source: str = "system",
) -> Services:
    registry = FeatureRegistry.load(settings.features_path)
    db = Database(database_url or settings.database_url)
    writer = AuditWriter(
        registry,
        default_actor=default_actor,
        default_source=default_source,
        fallback_path=settings.fallback_path,
    )
    return Services(
        settings=settings,
        registry=registry,
        db=db,
        writer=writer,
        artifacts=ArtifactStore(settings.artifact_root),
        anchors=AnchorStore(settings.anchor_path(db.name)),
        ui_limiter=SlidingWindowLimiter(settings.ui_events_per_minute),
        login_limiter=SlidingWindowLimiter(settings.login_attempts_per_minute),
    )
