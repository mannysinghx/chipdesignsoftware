"""Execution backends.

DockerRunner is the sandbox: no network, read-only root filesystem, every Linux
capability dropped, no privilege escalation, a non-root user, CPU/memory/PID
limits, a wall-clock timeout, and only the inputs (read-only), the output
directory, and pinned toolchain volumes mounted. Nothing from the host
environment is passed in; the spec's env is the whole environment.

LocalRunner is NOT a sandbox. It exists for tests and for machines without
Docker, and every run it executes is recorded with isolation "none".
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .spec import RunSpec

WORK = "/work"


@dataclass
class Execution:
    status: str  # exited | timed_out | cancelled | oom | error
    exit_code: int | None
    wall_ms: int
    runner: str
    isolation: dict = field(default_factory=dict)
    error: str | None = None


class DockerRunner:
    name = "docker"

    def __init__(self, docker_bin: str = "docker", poll_s: float = 0.5, cancel_poll_s: float = 2.0):
        self.docker_bin = docker_bin
        self.poll_s = poll_s
        self.cancel_poll_s = cancel_poll_s

    def isolation(self, spec: RunSpec) -> dict:
        return {
            "kind": "docker",
            "network": "none",
            "root_filesystem": "read-only",
            "capabilities": "all dropped",
            "no_new_privileges": True,
            "user": f"{os.getuid()}:{os.getgid()}",
            "cpus": spec.limits.cpus,
            "memory_mb": spec.limits.memory_mb,
            "pids": spec.limits.pids,
            "timeout_s": spec.limits.timeout_s,
            "mounts": ["/work/in (read-only)", "/work/out", *[f"{mount.target} (read-only, {mount.volume})" for mount in spec.mounts]],
        }

    def command(self, spec: RunSpec, workdir: Path, name: str) -> list[str]:
        command = [
            self.docker_bin, "run", "--name", name,
            "--platform", spec.platform,
            "--network", "none",
            "--read-only",
            "--tmpfs", "/tmp:rw,exec,size=4g",
            "--cpus", str(spec.limits.cpus),
            "--memory", f"{spec.limits.memory_mb}m",
            "--memory-swap", f"{spec.limits.memory_mb}m",
            "--pids-limit", str(spec.limits.pids),
            "--security-opt", "no-new-privileges",
            "--cap-drop", "ALL",
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--workdir", WORK,
            "-v", f"{workdir / 'in'}:{WORK}/in:ro",
            "-v", f"{workdir / 'out'}:{WORK}/out",
        ]
        for mount in spec.mounts:
            command += ["-v", f"{mount.volume}:{mount.target}:ro"]
        for key, value in spec.env:
            command += ["-e", f"{key}={value}"]
        return [*command, spec.image, *spec.command]

    def execute(self, spec: RunSpec, workdir: Path, log_path: Path, *, run_id: str, cancel_requested: Callable[[], bool]) -> Execution:
        name = f"aimem-run-{run_id.replace('-', '')[:16]}"
        began = time.monotonic()
        subprocess.run([self.docker_bin, "rm", "-f", name], capture_output=True)
        killed_for = None
        with log_path.open("ab") as log:
            process = subprocess.Popen(self.command(spec, workdir, name), stdout=log, stderr=subprocess.STDOUT)
            deadline = began + spec.limits.timeout_s
            next_cancel_check = began
            while process.poll() is None:
                now = time.monotonic()
                if killed_for is None and now >= next_cancel_check:
                    next_cancel_check = now + self.cancel_poll_s
                    if cancel_requested():
                        killed_for = "cancelled"
                if killed_for is None and now > deadline:
                    killed_for = "timed_out"
                if killed_for is not None:
                    subprocess.run([self.docker_bin, "kill", name], capture_output=True)
                    process.wait(timeout=60)
                    break
                time.sleep(self.poll_s)
        exit_code = process.returncode
        inspect = subprocess.run(
            [self.docker_bin, "inspect", "--format", "{{.State.OOMKilled}}", name], capture_output=True, text=True
        )
        oom = inspect.stdout.strip() == "true"
        subprocess.run([self.docker_bin, "rm", "-f", name], capture_output=True)
        wall_ms = int((time.monotonic() - began) * 1000)
        status = killed_for or ("oom" if oom else "exited")
        error = None
        if status == "exited" and exit_code in (125, 126, 127):
            status, error = "error", f"docker could not start the container (exit {exit_code}); see the run log"
        return Execution(status, exit_code, wall_ms, self.name, self.isolation(spec), error)


class LocalRunner:
    """Runs the command on the host with /work mapped to the run directory. No isolation."""

    name = "local"

    def __init__(self, poll_s: float = 0.05):
        self.poll_s = poll_s

    def isolation(self, spec: RunSpec) -> dict:
        return {"kind": "none", "note": "host process; for tests and machines without Docker"}

    def execute(self, spec: RunSpec, workdir: Path, log_path: Path, *, run_id: str, cancel_requested: Callable[[], bool]) -> Execution:
        def local(value: str) -> str:
            return value.replace(WORK, str(workdir))

        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        env.update({key: local(value) for key, value in spec.env})
        began = time.monotonic()
        killed_for = None
        with log_path.open("ab") as log:
            process = subprocess.Popen([local(part) for part in spec.command], stdout=log, stderr=subprocess.STDOUT, env=env, cwd=workdir)
            while process.poll() is None:
                if cancel_requested():
                    killed_for = "cancelled"
                elif time.monotonic() - began > spec.limits.timeout_s:
                    killed_for = "timed_out"
                if killed_for:
                    process.kill()
                    process.wait()
                    break
                time.sleep(self.poll_s)
        wall_ms = int((time.monotonic() - began) * 1000)
        return Execution(killed_for or "exited", process.returncode, wall_ms, self.name, self.isolation(spec))


def make_runner(kind: str, docker_bin: str = "docker"):
    if kind == "docker":
        return DockerRunner(docker_bin)
    if kind == "local":
        return LocalRunner()
    raise ValueError(f"unknown runner {kind!r}")
