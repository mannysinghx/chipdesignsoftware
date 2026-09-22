from __future__ import annotations

import pytest

from aimem_platform.config import PLATFORM_ROOT
from aimem_platform.features import FeatureRegistry, RegistryError, UndeclaredActionError, UnknownFeatureError


def registry_from(features: list[dict]) -> FeatureRegistry:
    return FeatureRegistry.from_document({"version": 1, "features": features}, digest="test")


def feature(**overrides) -> dict:
    base = {"id": "demo.thing", "kind": "api", "phase": 0, "owner": "platform", "title": "Demo", "events": ["http_request"]}
    return {**base, **overrides}


def test_the_real_registry_loads_and_is_consistent():
    registry = FeatureRegistry.load(PLATFORM_ROOT / "features.yaml")
    assert len(registry) >= 25
    assert len(registry.digest) == 64
    for item in registry.by_kind("api"):
        assert "http_request" in item.events
    for kind in ("api", "ui", "system", "cli"):
        assert registry.by_kind(kind), f"expected at least one {kind} feature"


@pytest.mark.parametrize(
    "features, message",
    [
        ([feature(), feature()], "duplicate"),
        ([feature(id="NoDots")], "invalid id"),
        ([feature(kind="robot")], "kind"),
        ([feature(events=[])], "at least one"),
        ([feature(events=["Bad-Action", "http_request"])], "invalid action"),
        ([feature(events=["read"])], "must require http_request"),
        ([feature(kind="ui", events=["http_request"])], "only api features"),
        ([feature(events=["http_request", "x"], may_emit=["x"])], "listed twice"),
        ([feature(owner="")], "owner"),
        ([feature(phase=-1)], "phase"),
    ],
)
def test_malformed_registries_are_rejected(features, message):
    with pytest.raises(RegistryError, match=message):
        registry_from(features)


def test_require_rejects_unknown_features_and_undeclared_actions():
    registry = registry_from([feature(events=["http_request", "done"], may_emit=["failed"])])
    assert registry.require("demo.thing", "done").id == "demo.thing"
    assert registry.require("demo.thing", "failed").id == "demo.thing"
    with pytest.raises(UnknownFeatureError):
        registry.require("demo.other", "done")
    with pytest.raises(UndeclaredActionError):
        registry.require("demo.thing", "exploded")


def test_unsupported_version_is_rejected():
    with pytest.raises(RegistryError, match="version"):
        FeatureRegistry.from_document({"version": 2, "features": []}, digest="x")
