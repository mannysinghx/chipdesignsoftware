from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import yaml

FEATURE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
ACTION_RE = re.compile(r"^[a-z][a-z0-9_]*$")
KINDS = frozenset({"api", "ui", "system", "cli"})
HTTP_REQUEST = "http_request"


class RegistryError(ValueError):
    """The registry file is malformed."""


class UnknownFeatureError(LookupError):
    """An event, route, or client named a feature that is not registered."""


class UndeclaredActionError(LookupError):
    """An event used an action its feature does not declare."""


@dataclass(frozen=True)
class Feature:
    id: str
    kind: str
    phase: int
    owner: str
    title: str
    events: tuple[str, ...]
    may_emit: tuple[str, ...] = field(default_factory=tuple)

    @property
    def allowed(self) -> frozenset[str]:
        return frozenset(self.events) | frozenset(self.may_emit)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "phase": self.phase,
            "owner": self.owner,
            "title": self.title,
            "events": list(self.events),
            "may_emit": list(self.may_emit),
        }


class FeatureRegistry:
    def __init__(self, features: list[Feature], *, version: int, digest: str, path: Path | None = None):
        self._features = {feature.id: feature for feature in features}
        self.version = version
        self.digest = digest
        self.path = path

    @classmethod
    def load(cls, path: Path) -> "FeatureRegistry":
        raw = path.read_bytes()
        try:
            document = yaml.safe_load(raw)
        except yaml.YAMLError as exc:
            raise RegistryError(f"{path}: invalid YAML: {exc}") from exc
        return cls.from_document(document, digest=hashlib.sha256(raw).hexdigest(), path=path)

    @classmethod
    def from_document(cls, document: object, *, digest: str, path: Path | None = None) -> "FeatureRegistry":
        if not isinstance(document, dict) or not isinstance(document.get("features"), list):
            raise RegistryError("registry must be a mapping with a 'features' list")
        version = document.get("version")
        if version != 1:
            raise RegistryError(f"unsupported registry version {version!r}")

        features: list[Feature] = []
        seen: set[str] = set()
        for index, entry in enumerate(document["features"]):
            where = f"features[{index}]"
            if not isinstance(entry, dict):
                raise RegistryError(f"{where} must be a mapping")
            feature_id = entry.get("id")
            if not isinstance(feature_id, str) or not FEATURE_ID_RE.match(feature_id):
                raise RegistryError(f"{where}: invalid id {feature_id!r}")
            if feature_id in seen:
                raise RegistryError(f"{where}: duplicate id {feature_id}")
            seen.add(feature_id)
            kind = entry.get("kind")
            if kind not in KINDS:
                raise RegistryError(f"{feature_id}: kind must be one of {sorted(KINDS)}")
            events = tuple(entry.get("events") or ())
            may_emit = tuple(entry.get("may_emit") or ())
            if not events:
                raise RegistryError(f"{feature_id}: at least one required event is needed")
            for action in (*events, *may_emit):
                if not isinstance(action, str) or not ACTION_RE.match(action):
                    raise RegistryError(f"{feature_id}: invalid action {action!r}")
            if len(set(events) | set(may_emit)) != len(events) + len(may_emit):
                raise RegistryError(f"{feature_id}: an action is listed twice")
            if kind == "api" and HTTP_REQUEST not in events:
                raise RegistryError(f"{feature_id}: api features must require {HTTP_REQUEST}")
            if kind != "api" and HTTP_REQUEST in (*events, *may_emit):
                raise RegistryError(f"{feature_id}: only api features may emit {HTTP_REQUEST}")
            for key in ("owner", "title"):
                if not isinstance(entry.get(key), str) or not entry[key].strip():
                    raise RegistryError(f"{feature_id}: {key} is required")
            phase = entry.get("phase")
            if not isinstance(phase, int) or phase < 0:
                raise RegistryError(f"{feature_id}: phase must be a non-negative integer")
            features.append(Feature(feature_id, kind, phase, entry["owner"], entry["title"], events, may_emit))
        return cls(features, version=version, digest=digest, path=path)

    def __iter__(self) -> Iterator[Feature]:
        return iter(self._features.values())

    def __len__(self) -> int:
        return len(self._features)

    def __contains__(self, feature_id: object) -> bool:
        return feature_id in self._features

    def get(self, feature_id: str) -> Feature:
        try:
            return self._features[feature_id]
        except KeyError:
            raise UnknownFeatureError(f"feature {feature_id!r} is not registered in features.yaml") from None

    def require(self, feature_id: str, action: str) -> Feature:
        feature = self.get(feature_id)
        if action not in feature.allowed:
            raise UndeclaredActionError(
                f"feature {feature_id!r} does not declare action {action!r} (allowed: {sorted(feature.allowed)})"
            )
        return feature

    def by_kind(self, kind: str) -> list[Feature]:
        return [feature for feature in self if feature.kind == kind]

    def as_dict(self) -> dict:
        return {
            "version": self.version,
            "digest": self.digest,
            "features": [feature.as_dict() for feature in self],
        }
