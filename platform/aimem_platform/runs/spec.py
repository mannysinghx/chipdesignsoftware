from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field

from ..audit.canonical import dumps_canonical, sanitize


@dataclass(frozen=True)
class Mount:
    """A read-only toolchain volume. `identity` is the SHA-256 of the bundle it was built from."""

    volume: str
    target: str
    identity: str


@dataclass(frozen=True)
class Limits:
    cpus: float = 4.0
    memory_mb: int = 6144
    pids: int = 2048
    timeout_s: int = 3600


@dataclass(frozen=True)
class RunSpec:
    adapter: str
    adapter_version: str
    image: str  # repository@sha256:digest
    platform: str
    command: tuple[str, ...]
    env: tuple[tuple[str, str], ...]
    inputs: tuple[tuple[str, str], ...]  # (path under /work/in, sha256)
    mounts: tuple[Mount, ...] = ()
    params: dict = field(default_factory=dict)
    limits: Limits = field(default_factory=Limits)

    def execution(self) -> dict:
        """Everything that determines the outputs. Limits only bound the run, so they are excluded."""
        return sanitize(
            {
                "adapter": self.adapter,
                "adapter_version": self.adapter_version,
                "image": self.image,
                "platform": self.platform,
                "command": list(self.command),
                "env": [list(pair) for pair in self.env],
                "inputs": [list(pair) for pair in self.inputs],
                "mounts": [asdict(mount) for mount in self.mounts],
                "params": self.params,
            }
        )

    def spec_hash(self) -> str:
        return hashlib.sha256(dumps_canonical(self.execution()).encode("utf-8")).hexdigest()

    def to_dict(self) -> dict:
        return {"execution": self.execution(), "limits": asdict(self.limits), "spec_hash": self.spec_hash()}

    @classmethod
    def from_dict(cls, data: dict) -> "RunSpec":
        execution = data["execution"]
        spec = cls(
            adapter=execution["adapter"],
            adapter_version=execution["adapter_version"],
            image=execution["image"],
            platform=execution["platform"],
            command=tuple(execution["command"]),
            env=tuple((key, value) for key, value in execution["env"]),
            inputs=tuple((path, digest) for path, digest in execution["inputs"]),
            mounts=tuple(Mount(**mount) for mount in execution["mounts"]),
            params=execution.get("params") or {},
            limits=Limits(**data.get("limits", {})),
        )
        if "spec_hash" in data and data["spec_hash"] != spec.spec_hash():
            raise ValueError("spec_hash does not match the recorded execution; the spec was altered")
        return spec
