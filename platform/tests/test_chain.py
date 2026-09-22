from __future__ import annotations

import threading
import uuid

from sqlalchemy import select

from aimem_platform.audit.canonical import GENESIS_HASH, compute_event_hash
from aimem_platform.audit.verifier import verify_chain
from aimem_platform.models import AuditEvent

from conftest import events_since, head_seq

AWKWARD_DETAILS = {
    "big_float": 1e16,
    "negative_zero": -0.0,
    "tenth": 0.1,
    "tiny": 1.5e-7,
    "huge_int": 2**70,
    "unicode": "résumé · 日本語 · 🧪",
    "nul": "a\x00b",
    "nested": {"z": [1, 2, {"y": None, "x": True}], "a": {}},
    "empty_list": [],
}


def test_rows_chain_and_round_trip_through_postgres(services):
    before = head_seq(services)
    with services.db.transaction() as session:
        for index in range(5):
            services.writer.append(session, feature="system.lifecycle", action="started", details={**AWKWARD_DETAILS, "i": index})
    table = AuditEvent.__table__
    with services.db.read() as session:
        rows = session.execute(select(table).where(table.c.seq > before).order_by(table.c.seq)).mappings().all()
        previous_row = session.execute(select(table.c.hash).where(table.c.seq == before)).scalar()
    assert [row["seq"] for row in rows] == list(range(before + 1, before + 6))
    previous = previous_row or GENESIS_HASH
    for row in rows:
        assert row["prev_hash"] == previous
        assert compute_event_hash(row) == row["hash"], "hash must survive the Postgres round trip exactly"
        previous = row["hash"]


def test_whole_chain_verifies(services):
    with services.db.read() as session:
        result = verify_chain(session.connection())
    assert result.ok, result.failures
    assert result.rows == head_seq(services)


def test_concurrent_writers_keep_a_gapless_linear_chain(services):
    before = head_seq(services)
    errors: list[BaseException] = []

    def worker(worker_id: int) -> None:
        try:
            for index in range(20):
                with services.db.transaction() as session:
                    services.writer.append(session, feature="system.lifecycle", action="started", details={"worker": worker_id, "i": index})
        except BaseException as exc:  # pragma: no cover - reported below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(worker_id,)) for worker_id in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors, errors
    assert head_seq(services) == before + 160
    with services.db.read() as session:
        result = verify_chain(session.connection())
    assert result.ok, result.failures


def test_batch_append_skips_events_already_stored(services):
    before = head_seq(services)
    ids = [uuid.uuid4() for _ in range(3)]
    rows = [services.writer.prepare(feature="system.lifecycle", action="started", event_id=event_id) for event_id in ids]
    with services.db.transaction() as session:
        first = services.writer.append_rows(session, rows, skip_existing=True)
    retry_rows = [services.writer.prepare(feature="system.lifecycle", action="started", event_id=event_id) for event_id in ids]
    retry_rows.append(services.writer.prepare(feature="system.lifecycle", action="started", event_id=ids[0]))
    with services.db.transaction() as session:
        second = services.writer.append_rows(session, retry_rows, skip_existing=True)
    assert len(first) == 3 and second == []
    assert [event["event_id"] for event in events_since(services, before)] == [str(event_id) for event_id in ids]
