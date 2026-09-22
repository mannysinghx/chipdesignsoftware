from __future__ import annotations

import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class StoredBlob:
    sha256: str
    size_bytes: int
    path: Path
    created: bool


class ArtifactStore:
    """Content-addressed blob store: bytes live at <root>/sha256/<aa>/<bb>/<sha256>.

    Writes are idempotent and atomic (temp file + rename), so a blob either
    exists completely or not at all. Metadata and the audit event for a write
    live in the database; a blob without a metadata row is an orphan from a
    failed request and is never served.
    """

    def __init__(self, root: Path):
        self.root = root

    def path_for(self, sha256: str) -> Path:
        if not SHA256_RE.match(sha256):
            raise ValueError("artifact ids are lowercase sha256 hex digests")
        return self.root / "sha256" / sha256[:2] / sha256[2:4] / sha256

    def put(self, data: bytes) -> StoredBlob:
        digest = hashlib.sha256(data).hexdigest()
        target = self.path_for(digest)
        if target.exists():
            return StoredBlob(digest, len(data), target, created=False)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(dir=target.parent, prefix=".incoming-")
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, target)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise
        return StoredBlob(digest, len(data), target, created=True)

    def exists(self, sha256: str) -> bool:
        return self.path_for(sha256).is_file()
