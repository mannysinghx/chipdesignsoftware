"""Exit criterion: editing, deleting, or truncating audit rows is detected by the verifier.

These tests bypass both database protections as the table owner (disabling the
append-only trigger), which is what an attacker with owner or superuser access
could do. Each test rebuilds the schema afterwards so later tests see an intact chain.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from aimem_platform.audit.canonical import compute_event_hash
from aimem_platform.audit.verifier import AnchorStore, verify_chain

from conftest import events_since, find, head_seq, owner_engine


@pytest.fixture
def fresh(env, services):
    env.reset()
    anchors = services.anchors
    if anchors.path.exists():
        anchors.path.unlink()
    for index in range(6):
        with services.db.transaction() as session:
            services.writer.append(session, feature="system.lifecycle", action="started", details={"i": index})
    yield services
    env.reset()
    if anchors.path.exists():
        anchors.path.unlink()


def as_owner(env, statement: str, **params) -> None:
    engine = owner_engine(env)
    try:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE aimem.audit_events DISABLE TRIGGER audit_events_block_update_delete"))
            connection.execute(text(statement), params)
            connection.execute(text("ALTER TABLE aimem.audit_events ENABLE TRIGGER audit_events_block_update_delete"))
    finally:
        engine.dispose()


def verify(services, anchors=None):
    with services.db.read() as session:
        return verify_chain(session.connection(), anchors=anchors)


def test_clean_chain_verifies(fresh):
    result = verify(fresh)
    assert result.ok and result.rows == head_seq(fresh)


def test_editing_a_row_is_detected(fresh, env):
    target = head_seq(fresh) - 2
    as_owner(env, "UPDATE aimem.audit_events SET details_json = :details WHERE seq = :seq", details='{"i":999}', seq=target)
    result = verify(fresh)
    assert not result.ok
    assert (result.first_failure.seq, result.first_failure.reason) == (target, "hash_mismatch")


def test_editing_a_row_and_recomputing_its_hash_breaks_the_next_link(fresh, env):
    target = head_seq(fresh) - 2
    with fresh.db.read() as session:
        row = dict(session.execute(text("SELECT * FROM aimem.audit_events WHERE seq = :seq"), {"seq": target}).mappings().one())
    row["details_json"] = '{"i":999}'
    forged = compute_event_hash(row)
    as_owner(env, "UPDATE aimem.audit_events SET details_json = :details, hash = :forged WHERE seq = :seq", details='{"i":999}', forged=forged, seq=target)
    result = verify(fresh)
    assert not result.ok
    assert (result.first_failure.seq, result.first_failure.reason) == (target + 1, "prev_hash_mismatch")


def test_deleting_a_middle_row_is_detected(fresh, env):
    target = head_seq(fresh) - 3
    as_owner(env, "DELETE FROM aimem.audit_events WHERE seq = :seq", seq=target)
    result = verify(fresh)
    assert not result.ok
    reasons = {(failure.seq, failure.reason) for failure in result.failures}
    assert (target + 1, "seq_gap") in reasons and (target + 1, "prev_hash_mismatch") in reasons


def test_truncating_the_tail_is_detected_by_the_external_anchor(fresh, env, tmp_path):
    anchors = AnchorStore(tmp_path / "anchors.jsonl")
    result = verify(fresh)
    anchors.append(result.head_seq, result.head_hash)
    as_owner(env, "DELETE FROM aimem.audit_events WHERE seq >= :seq", seq=result.head_seq - 1)
    tail_cut = verify(fresh, anchors=anchors.load())
    assert verify(fresh).ok, "a tail cut leaves a valid shorter chain, which is why anchors exist"
    assert not tail_cut.ok
    assert tail_cut.first_failure.reason == "anchor_missing"


def test_the_api_reports_a_break_and_logs_break_detected(fresh, env, client, login):
    headers = login("admin")
    clean = client.post("/api/audit/verify", headers=headers)
    assert clean.status_code == 200 and clean.json()["ok"] is True
    assert clean.json()["anchor"]["seq"] == clean.json()["head_seq"]

    before = head_seq(fresh)
    as_owner(env, "UPDATE aimem.audit_events SET actor_id = 'someone-else' WHERE seq = 3")
    broken = client.post("/api/audit/verify", headers=headers)
    assert broken.status_code == 200
    body = broken.json()
    assert body["ok"] is False and body["failures"][0]["seq"] == 3
    events = events_since(fresh, before)
    detected = find(events, feature="audit.verify_chain", action="break_detected")
    assert len(detected) == 1 and detected[0]["result"] == "error"
    assert detected[0]["details"]["failures"][0]["reason"] == "hash_mismatch"
