"""Pinned toolchains: container images by digest and tool bundles by SHA-256.

`ensure` is the only place that downloads or builds anything, and it is an
audited step (toolchain.provision). Runs themselves never touch the network.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from ..audit.writer import audited_step
from .spec import Mount

MARKER = ".aimem-bundle-sha256"


@dataclass(frozen=True)
class ImageRef:
    name: str
    ref: str
    digest: str
    platform: str

    @property
    def pinned(self) -> str:
        return f"{self.ref.rsplit(':', 1)[0]}@{self.digest}"


@dataclass(frozen=True)
class BundleRef:
    name: str
    release: str
    url: str
    sha256: str
    size_bytes: int
    volume: str
    mount: str
    bin: str
    host_image: str

    @property
    def filename(self) -> str:
        return self.url.rsplit("/", 1)[-1]

    def as_mount(self) -> Mount:
        return Mount(volume=self.volume, target=self.mount, identity=self.sha256)


class DockerCLI:
    """Thin wrapper so tests can substitute a fake Docker."""

    def __init__(self, binary: str = "docker"):
        self.binary = binary

    def run(self, *args: str, check: bool = False, input_text: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([self.binary, *args], capture_output=True, text=True, check=check, input=input_text)

    def available(self) -> bool:
        try:
            return self.run("info", "--format", "{{.ServerVersion}}").returncode == 0
        except FileNotFoundError:
            return False


class Toolchains:
    def __init__(self, lock_path: Path, cache_dir: Path):
        data = json.loads(lock_path.read_text())
        self.lock_digest = hashlib.sha256(lock_path.read_bytes()).hexdigest()
        self.images = {name: ImageRef(name, item["ref"], item["digest"], item["platform"]) for name, item in data["images"].items()}
        self.bundles = {
            name: BundleRef(
                name=name,
                release=item["release"],
                url=item["url"],
                sha256=item["sha256"],
                size_bytes=item["size_bytes"],
                volume=item["volume"],
                mount=item["mount"],
                bin=item["bin"],
                host_image=item["host_image"],
            )
            for name, item in data["bundles"].items()
        }
        self.cache_dir = cache_dir

    # -- status ---------------------------------------------------------------
    def image_present(self, docker: DockerCLI, image: ImageRef) -> bool:
        return docker.run("image", "inspect", image.pinned).returncode == 0

    def bundle_ready(self, docker: DockerCLI, bundle: BundleRef) -> bool:
        if docker.run("volume", "inspect", bundle.volume).returncode != 0:
            return False
        host = self.images[bundle.host_image]
        probe = docker.run(
            "run", "--rm", "--network", "none", "--platform", host.platform, "-v", f"{bundle.volume}:{bundle.mount}:ro",
            host.pinned, "cat", f"{bundle.mount}/{MARKER}",
        )
        return probe.returncode == 0 and probe.stdout.strip() == bundle.sha256

    def status(self, docker: DockerCLI) -> dict:
        return {
            "images": {name: self.image_present(docker, image) for name, image in self.images.items()},
            "bundles": {name: self.bundle_ready(docker, bundle) for name, bundle in self.bundles.items()},
        }

    # -- provisioning ---------------------------------------------------------
    def _download(self, bundle: BundleRef) -> Path:
        target = self.cache_dir / bundle.filename
        if target.exists() and _sha256_file(target) == bundle.sha256:
            return target
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(dir=self.cache_dir, prefix=".download-")
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "wb") as handle, urllib.request.urlopen(bundle.url, timeout=60) as response:
            while chunk := response.read(1 << 20):
                digest.update(chunk)
                handle.write(chunk)
        if digest.hexdigest() != bundle.sha256:
            Path(temp_name).unlink(missing_ok=True)
            raise RuntimeError(f"{bundle.filename}: SHA-256 mismatch; refusing to use it")
        os.replace(temp_name, target)
        return target

    def ensure(self, services, docker: DockerCLI, *, allow_download: bool = True) -> dict:
        """Make every pinned toolchain available locally. Audited as toolchain.provision."""
        actions: list[dict] = []
        with audited_step(
            services.db,
            services.writer,
            feature="toolchain.provision",
            target=("toolchains", self.lock_digest),
            details={"lock_digest": self.lock_digest},
        ) as step:
            for image in self.images.values():
                if self.image_present(docker, image):
                    actions.append({"toolchain": image.name, "action": "present", "image": image.pinned})
                    continue
                if not allow_download:
                    raise RuntimeError(f"image {image.pinned} is missing and downloads are disabled")
                docker.run("pull", "--platform", image.platform, image.pinned, check=True)
                actions.append({"toolchain": image.name, "action": "pulled", "image": image.pinned})
            for bundle in self.bundles.values():
                if self.bundle_ready(docker, bundle):
                    actions.append({"toolchain": bundle.name, "action": "present", "volume": bundle.volume})
                    continue
                if not allow_download and not (self.cache_dir / bundle.filename).exists():
                    raise RuntimeError(f"bundle {bundle.filename} is missing and downloads are disabled")
                archive = self._download(bundle)
                host = self.images[bundle.host_image]
                docker.run("volume", "create", bundle.volume, check=True)
                docker.run(
                    "run", "--rm", "--network", "none", "--platform", host.platform,
                    "-v", f"{bundle.volume}:{bundle.mount}", "-v", f"{archive.parent}:/dl:ro", host.pinned,
                    "sh", "-c", f"tar -xzf /dl/{archive.name} -C {bundle.mount} && echo {bundle.sha256} > {bundle.mount}/{MARKER}",
                    check=True,
                )
                actions.append({"toolchain": bundle.name, "action": "installed", "volume": bundle.volume, "sha256": bundle.sha256})
            step.details["actions"] = actions
        return {"lock_digest": self.lock_digest, "actions": actions}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()
