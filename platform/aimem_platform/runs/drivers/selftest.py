"""Sandbox self-test: records what the run can and cannot do.

Run inside the sandbox; it writes <out>/selftest.json. The adapter turns the
observations into a verdict, so a sandbox that silently lost its isolation fails.
"""

import hashlib
import json
import os
import platform
import socket
import sys
from pathlib import Path


def attempt_write(path: Path) -> str:
    try:
        path.write_text("probe")
        path.unlink()
        return "writable"
    except OSError:
        return "read-only"


def main() -> None:
    out = Path(sys.argv[1])
    inputs = Path(sys.argv[2])
    checks = {}
    try:
        socket.create_connection(("1.1.1.1", 443), timeout=3).close()
        checks["network_ip"] = "reachable"
    except OSError:
        checks["network_ip"] = "blocked"
    try:
        socket.getaddrinfo("example.com", 443)
        checks["network_dns"] = "reachable"
    except OSError:
        checks["network_dns"] = "blocked"
    checks["root_filesystem"] = attempt_write(Path("/aimem-selftest-probe"))
    checks["inputs"] = attempt_write(inputs / "aimem-selftest-probe")
    checks["outputs"] = attempt_write(out / "aimem-selftest-probe")
    checks["uid"] = os.getuid()
    hashes = {
        str(path.relative_to(inputs)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(inputs.rglob("*"))
        if path.is_file()
    }
    report = {"checks": checks, "machine": platform.machine(), "python": sys.version.split()[0], "input_hashes": hashes}
    (out / "selftest.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(checks, sort_keys=True))


if __name__ == "__main__":
    main()
