"""Hash-chain verification and external anchors.

The chain proves that no row was edited or removed from the middle: every row
stores the hash of the row before it, and seq must be gapless from 1. Deleting
rows from the tail leaves a valid shorter chain, so each successful
verification also appends the verified head (seq, hash) to an anchor file
outside the database. A later verification fails if any anchored row is
missing or different.
"""

from __future__ import annotations

import json
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from time import perf_counter

from sqlalchemy import Connection, select

from ..models import AuditEvent
from .canonical import GENESIS_HASH, compute_event_hash, dumps_canonical, format_ts
from .writer import utcnow

BATCH = 2000


@dataclass
class ChainFailure:
    seq: int
    reason: str
    expected: str | int | None = None
    actual: str | int | None = None
    event_id: str | None = None


@dataclass
class VerificationResult:
    ok: bool
    rows: int
    head_seq: int
    head_hash: str
    anchors_checked: int
    duration_ms: float
    failures: list[ChainFailure] = field(default_factory=list)
    truncated_failures: bool = False

    @property
    def first_failure(self) -> ChainFailure | None:
        return self.failures[0] if self.failures else None

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "rows": self.rows,
            "head_seq": self.head_seq,
            "head_hash": self.head_hash,
            "anchors_checked": self.anchors_checked,
            "duration_ms": self.duration_ms,
            "failures": [asdict(failure) for failure in self.failures],
            "truncated_failures": self.truncated_failures,
        }


class AnchorStore:
    """Append-only JSON-lines file of verified chain heads."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def load(self) -> list[dict]:
        if not self.path.exists():
            return []
        anchors = []
        with self.path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    anchors.append(json.loads(line))
        return anchors

    def append(self, seq: int, head_hash: str) -> dict:
        anchor = {"seq": seq, "hash": head_hash, "anchored_at": format_ts(utcnow())}
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(dumps_canonical(anchor) + "\n")
        return anchor


def verify_chain(connection: Connection, *, anchors: list[dict] | None = None, max_failures: int = 50) -> VerificationResult:
    began = perf_counter()
    table = AuditEvent.__table__
    failures: list[ChainFailure] = []
    truncated = False

    def fail(failure: ChainFailure) -> None:
        nonlocal truncated
        if len(failures) < max_failures:
            failures.append(failure)
        else:
            truncated = True

    expected_seq = 1
    previous = GENESIS_HASH
    rows = 0
    last_seq = 0
    stored_by_seq: dict[int, str] = {}
    anchor_seqs = {int(anchor["seq"]) for anchor in anchors or []}

    while True:
        batch = connection.execute(
            select(table).where(table.c.seq > last_seq).order_by(table.c.seq).limit(BATCH)
        ).mappings().all()
        if not batch:
            break
        for row in batch:
            rows += 1
            seq = int(row["seq"])
            event_id = str(row["event_id"])
            if seq != expected_seq:
                fail(ChainFailure(seq, "seq_gap", expected_seq, seq, event_id))
            if row["prev_hash"] != previous:
                fail(ChainFailure(seq, "prev_hash_mismatch", previous, row["prev_hash"], event_id))
            recomputed = compute_event_hash(row)
            if recomputed != row["hash"]:
                fail(ChainFailure(seq, "hash_mismatch", recomputed, row["hash"], event_id))
            if seq in anchor_seqs:
                stored_by_seq[seq] = row["hash"]
            previous = row["hash"]
            expected_seq = seq + 1
            last_seq = seq

    for anchor in anchors or []:
        seq = int(anchor["seq"])
        if seq not in stored_by_seq:
            fail(ChainFailure(seq, "anchor_missing", anchor["hash"], None))
        elif stored_by_seq[seq] != anchor["hash"]:
            fail(ChainFailure(seq, "anchor_mismatch", anchor["hash"], stored_by_seq[seq]))

    return VerificationResult(
        ok=not failures,
        rows=rows,
        head_seq=last_seq,
        head_hash=previous if rows else GENESIS_HASH,
        anchors_checked=len(anchors or []),
        duration_ms=round((perf_counter() - began) * 1000, 3),
        failures=failures,
        truncated_failures=truncated,
    )
