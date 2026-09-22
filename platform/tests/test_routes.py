"""The API refuses to start unless every route names a registered api feature."""

from __future__ import annotations

import pytest
from fastapi import APIRouter

from aimem_platform.api import ROUTERS
from aimem_platform.app import RouteFeatureError, validate_route_features
from aimem_platform.deps import feature


def router_with(**openapi_extra) -> APIRouter:
    router = APIRouter()

    @router.get("/probe", openapi_extra=openapi_extra or None)
    def probe() -> dict:
        return {}

    return router


def test_every_shipped_route_has_a_registered_api_feature(services):
    table = validate_route_features(ROUTERS, services.registry)
    assert len(table) >= 20
    features = {feature_id for _, _, feature_id in table}
    assert {"auth.session", "audit.query", "audit.verify_chain", "artifact.write", "ui.ingest"} <= features


def test_route_without_a_feature_is_refused(services):
    with pytest.raises(RouteFeatureError, match="does not declare a feature"):
        validate_route_features([router_with()], services.registry)


def test_route_with_an_unknown_feature_is_refused(services):
    with pytest.raises(RouteFeatureError, match="not registered"):
        validate_route_features([router_with(**feature("made.up"))], services.registry)


def test_route_with_a_non_api_feature_is_refused(services):
    with pytest.raises(RouteFeatureError, match="ui feature"):
        validate_route_features([router_with(**feature("ui.view"))], services.registry)
