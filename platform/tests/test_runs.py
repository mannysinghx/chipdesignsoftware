from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from aimem_platform.app import create_app
from aimem_platform.audit.context import ActorRef
from aimem_platform.audit.writer import utcnow
from aimem_platform.models import Run
from aimem_platform.runs import adapters as adapter_module
from aimem_platform.runs.adapters import Adapter, Outcome, SelfTestAdapter
from aimem_platform.runs.normalize import gds_normalized_sha256
from aimem_platform.runs.reconstruct import compare_with_record, reconstruct_run
from aimem_platform.runs.reproduce import reproduce_run
from aimem_platform.runs.runners import DockerRunner, LocalRunner
from aimem_platform.runs.service import claim_next, execute_run, reap_abandoned, run_worker, submit_run
from aimem_platform.runs.spec import Limits
from aimem_platform.services import build_services

from conftest import PLATFORM_DIR, events_since, find, head_seq, owner_engine

ENGINEER = ActorRef("human", "engineer@aimem.test", None, authenticated=True, role="engineer")


@pytest.fixture
def local_services(env):
    services = build_services(env.settings.model_copy(update={"runner": "local"}))
    yield services
    services.close()


def run_selftest(services):
    run = submit_run(services, "platform.selftest", {}, actor=ENGINEER)
    run_worker(services, LocalRunner(), once=True)
    with services.db.read() as session:
        return session.get(Run, run.run_id)


def test_spec_hash_ignores_limits_but_not_inputs(local_services):
    adapter = SelfTestAdapter()
    toolchains = __import__("aimem_platform.runs.service", fromlist=["toolchains_for"]).toolchains_for(local_services)
    params = adapter.params_model()
    first = adapter.build_spec(params, {"driver/selftest.py": "a" * 64}, toolchains)
    relimited = adapter.build_spec(params, {"driver/selftest.py": "a" * 64}, toolchains)
    object.__setattr__(relimited, "limits", Limits(cpus=16, memory_mb=1, pids=1, timeout_s=1))
    other_input = adapter.build_spec(params, {"driver/selftest.py": "b" * 64}, toolchains)
    assert first.spec_hash() == relimited.spec_hash()
    assert first.spec_hash() != other_input.spec_hash()
    assert "@sha256:" in first.image, "images are pinned by digest"


def test_a_run_records_every_lifecycle_step_in_one_trace(local_services):
    before = head_seq(local_services)
    run = run_selftest(local_services)
    assert run.status == "succeeded" and run.verdict == "pass"
    events = [event for event in events_since(local_services, before) if event["feature"] == "run.lifecycle"]
    assert [event["action"] for event in events] == ["queued", "claimed", "started", "outputs_recorded", "finished"]
    assert len({event["trace_id"] for event in events}) == 1 and events[0]["trace_id"] == run.trace_id
    queued = events[0]
    assert queued["details"]["spec"] == json.loads(run.spec_json)
    assert queued["input_hash"] == f"sha256:{run.spec_hash}"
    outputs = events[3]["details"]
    assert [item["path"] for item in outputs["outputs"]] == ["selftest.json"]
    assert local_services.artifacts.exists(outputs["outputs"][0]["sha256"])
    assert events[4]["details"]["summary" if "summary" in events[4]["details"] else "headline"]
    assert events[4]["evidence_class"] == "modeled", "a local run never claims sandbox isolation"


def test_a_run_can_be_rebuilt_from_the_audit_log_alone(local_services, env):
    run = run_selftest(local_services)
    verdict = compare_with_record(local_services, run.run_id)
    assert verdict["consistent"], verdict
    assert all(verdict["checks"].values())

    # Someone edits the runs row directly: the audit log disagrees and says so.
    engine = owner_engine(env)
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE aimem.runs SET spec_json = replace(spec_json, 'selftest.py', 'evil.py') WHERE run_id = :id"), {"id": str(run.run_id)}
        )
    engine.dispose()
    tampered = compare_with_record(local_services, run.run_id)
    assert tampered["checks"]["spec"] is False and tampered["consistent"] is False


def test_reproduction_from_the_audit_log_gives_identical_outputs(local_services):
    run = run_selftest(local_services)
    before = head_seq(local_services)
    result = reproduce_run(local_services, LocalRunner(), run.run_id, actor=ENGINEER)
    assert result["identical"] and result["compared"] == 1
    compared = find(events_since(local_services, before), feature="run.reproduce", action="compared")
    assert compared and compared[0]["result"] == "ok" and compared[0]["details"]["reproduction_run"] == result["reproduction_run"]
    with local_services.db.read() as session:
        twin = session.get(Run, uuid.UUID(result["reproduction_run"]))
    assert twin.reproduction_of == run.run_id and twin.spec_hash == run.spec_hash


class SleepAdapter(Adapter):
    id = "test.sleep"
    version = "1"
    title = "sleep"
    description = "sleeps"
    evidence = "test"
    limits = Limits(cpus=1, memory_mb=128, pids=16, timeout_s=1)

    def inputs(self, params, repo):
        return {"driver/selftest.py": adapter_module.DRIVERS / "selftest.py"}

    def command(self, params):
        return [sys.executable, "-c", "import time; time.sleep(30)"]

    def summarize(self, out, execution):
        return Outcome("pass", "slept")


@pytest.fixture
def sleep_adapter(monkeypatch):
    monkeypatch.setitem(adapter_module.ADAPTERS, "test.sleep", SleepAdapter())
    yield


def test_a_run_past_its_time_limit_is_killed_and_recorded(local_services, sleep_adapter):
    before = head_seq(local_services)
    run = submit_run(local_services, "test.sleep", {}, actor=ENGINEER)
    run_worker(local_services, LocalRunner(), once=True)
    with local_services.db.read() as session:
        assert session.get(Run, run.run_id).status == "timed_out"
    assert find(events_since(local_services, before), feature="run.lifecycle", action="timed_out")


def test_the_tool_never_runs_if_started_cannot_be_logged(local_services):
    run = submit_run(local_services, "platform.selftest", {}, actor=ENGINEER)
    claimed = claim_next(local_services, worker_id="test", runner_name="local")
    real = local_services.writer.commit_event

    def refuse_started(db, **fields):
        if fields.get("action") == "started":
            raise RuntimeError("audit unavailable")
        return real(db, **fields)

    local_services.writer.commit_event = refuse_started

    class Spy(LocalRunner):
        executed = False

        def execute(self, *args, **kwargs):
            Spy.executed = True
            return super().execute(*args, **kwargs)

    result = execute_run(local_services, Spy(), claimed)
    assert Spy.executed is False
    assert result.status == "errored" and "could not start" in result.error


def test_cancelling_a_queued_run_is_audited_and_it_never_executes(env, local_services, client, login):
    engineer = login("engineer")
    created = client.post("/api/runs", headers=engineer, json={"adapter": "platform.selftest"})
    assert created.status_code == 201
    run_id = created.json()["run"]["run_id"]
    before = head_seq(local_services)
    cancelled = client.post(f"/api/runs/{run_id}/cancel", headers=engineer)
    assert cancelled.status_code == 200 and cancelled.json()["run"]["status"] == "cancelled"
    events = events_since(local_services, before)
    assert find(events, feature="run.cancel", action="cancel_requested")
    assert find(events, feature="run.lifecycle", action="cancelled")
    assert client.post(f"/api/runs/{run_id}/cancel", headers=engineer).status_code == 409


def test_run_api_roles_and_log_tail(env, local_services, client, login):
    viewer = login("viewer")
    assert client.post("/api/runs", headers=viewer, json={"adapter": "platform.selftest"}).status_code == 403
    assert client.post("/api/runs", headers=login("engineer"), json={"adapter": "nope"}).status_code == 404
    catalog = client.get("/api/adapters", headers=viewer).json()["adapters"]
    assert {"platform.selftest", "rtl.lint", "rtl.sim", "formal.sby", "physical.orfs"} <= {item["id"] for item in catalog}
    run = run_selftest(local_services)
    detail = client.get(f"/api/runs/{run.run_id}", headers=viewer).json()["run"]
    assert {file["role"] for file in detail["files"]} == {"input", "output", "log"}
    log = client.get(f"/api/runs/{run.run_id}/log", headers=viewer).json()
    assert log["complete"] and "network_ip" in log["text"]
    reconstruction = client.get(f"/api/runs/{run.run_id}/reconstruction", headers=viewer).json()
    assert reconstruction["consistent"] is True
    evidence = client.get("/api/evidence", headers=viewer).json()["evidence"]
    assert any(item["adapter"]["id"] == "platform.selftest" and item["latest"] for item in evidence)


def test_the_reaper_only_touches_runs_whose_container_is_gone(local_services):
    run = submit_run(local_services, "platform.selftest", {}, actor=ENGINEER)
    claim_next(local_services, worker_id="gone", runner_name="docker")
    engine = owner_engine(type("E", (), {"owner_url": local_services.settings.owner_database_url})())
    with engine.begin() as connection:
        connection.execute(text("UPDATE aimem.runs SET started_at = started_at - interval '1 hour' WHERE run_id = :id"), {"id": str(run.run_id)})
    engine.dispose()
    assert reap_abandoned(local_services, container_alive=lambda run_id: True) == []
    assert reap_abandoned(local_services, container_alive=lambda run_id: False) == [str(run.run_id)]
    with local_services.db.read() as session:
        assert session.get(Run, run.run_id).status == "errored"


def test_api_startup_never_touches_runs(env, local_services):
    queued = submit_run(local_services, "platform.selftest", {}, actor=ENGINEER)
    with TestClient(create_app(env.settings, services=build_services(env.settings))):
        pass
    with local_services.db.read() as session:
        assert session.get(Run, queued.run_id).status == "queued"
    # leave the queue clean for other tests
    run_worker(local_services, LocalRunner(), once=True)


def _gds(dates: tuple[int, ...], width: int) -> bytes:
    def record(kind: int, dtype: int, payload: bytes) -> bytes:
        return struct.pack(">HBB", 4 + len(payload), kind, dtype) + payload

    stamp = struct.pack(">12h", *dates)
    return b"".join([
        record(0x00, 0x02, struct.pack(">h", 600)),
        record(0x01, 0x02, stamp),
        record(0x02, 0x06, b"LIB\x00"),
        record(0x05, 0x02, stamp),
        record(0x06, 0x06, b"TOP\x00"),
        record(0x08, 0x00, b""),
        record(0x0D, 0x02, struct.pack(">h", width)),
        record(0x11, 0x00, b""),
        record(0x07, 0x00, b""),
        record(0x04, 0x00, b""),
    ])


def test_gds_normalization_ignores_dates_but_not_geometry(tmp_path):
    first, redated, changed = tmp_path / "a.gds", tmp_path / "b.gds", tmp_path / "c.gds"
    first.write_bytes(_gds((2026, 9, 22, 17, 0, 0) * 2, 5))
    redated.write_bytes(_gds((2031, 1, 2, 3, 4, 5) * 2, 5))
    changed.write_bytes(_gds((2026, 9, 22, 17, 0, 0) * 2, 6))
    assert first.read_bytes() != redated.read_bytes()
    assert gds_normalized_sha256(first) == gds_normalized_sha256(redated)
    assert gds_normalized_sha256(first) != gds_normalized_sha256(changed)


def test_physical_summary_parses_metrics_drc_and_lvs(tmp_path):
    base = tmp_path / "orfs"
    logs = base / "logs/sky130hd/aimem_t0_channel/base"
    reports = base / "reports/sky130hd/aimem_t0_channel/base"
    results = base / "results/sky130hd/aimem_t0_channel/base"
    for directory in (logs, reports, results):
        directory.mkdir(parents=True)
    (logs / "6_report.json").write_text(json.dumps({
        "finish__timing__fmax": 169527000.0, "finish__timing__setup__ws": -4.64876, "finish__timing__setup__tns": -629.747,
        "finish__timing__hold__ws": 0.019908, "finish__timing__hold__tns": 0, "finish__design__die__area": 95861.4,
        "finish__design__instance__count__stdcell": 4883, "finish__power__total": 0.174144,
    }))
    for name in ("1_synth.log", "5_2_route.log", "6_report.log", "6_drc.log"):
        (logs / name).write_text("ok")
    (logs / "6_lvs.log").write_text("Flatten circuit\nINFO : Congratulations! Netlists match.\n")
    (reports / "6_drc_count.rpt").write_text("0\n")
    (results / "clock_period.txt").write_text("1.250")
    (results / "6_final.gds").write_bytes(b"gds")
    out = tmp_path / "physical.json"
    subprocess.run(
        [sys.executable, str(adapter_module.DRIVERS / "orfs_summary.py"), "--work", str(base), "--design", "aimem_t0_channel", "--flow-exit", "0", "--out", str(out)],
        check=True, capture_output=True,
    )
    report = json.loads(out.read_text())
    metrics = report["metrics"]
    assert report["last_stage"] == "LVS"
    assert metrics["drc_violations"] == 0 and metrics["lvs"] == "match" and metrics["gds"] is True
    assert metrics["fmax_mhz"] == 169.527 and metrics["setup_wns_ns"] == -4.6488 and metrics["clock_period_ns"] == 1.25
    (logs / "6_lvs.log").write_text("Netlists don't match.\n")
    subprocess.run(
        [sys.executable, str(adapter_module.DRIVERS / "orfs_summary.py"), "--work", str(base), "--design", "aimem_t0_channel", "--flow-exit", "2", "--out", str(out)],
        check=True, capture_output=True,
    )
    assert json.loads(out.read_text())["metrics"]["lvs"] == "mismatch"


@pytest.mark.skipif(os.environ.get("AIMEM_DOCKER_TESTS") != "1", reason="set AIMEM_DOCKER_TESTS=1 to run sandbox tests against Docker")
def test_the_docker_sandbox_blocks_network_and_writes(env):
    services = build_services(env.settings.model_copy(update={"runner": "docker"}))
    try:
        run = submit_run(services, "platform.selftest", {}, actor=ENGINEER)
        claimed = claim_next(services, worker_id="docker-test", runner_name="docker")
        finished = execute_run(services, DockerRunner(), claimed)
        summary = json.loads(finished.summary_json)
        assert finished.status == "succeeded", summary
        checks = summary["metrics"]["checks"]
        assert checks["network_ip"] == "blocked" and checks["network_dns"] == "blocked"
        assert checks["root_filesystem"] == "read-only" and checks["inputs"] == "read-only" and checks["uid"] != 0
        assert summary["isolation"]["network"] == "none"
    finally:
        services.close()


def test_run_outputs_carry_the_twelve_field_provenance_contract(local_services):
    run = run_selftest(local_services)
    from aimem_platform.models import Artifact, RunFile

    with local_services.db.read() as session:
        output = session.scalars(select(RunFile).where(RunFile.run_id == run.run_id, RunFile.role == "output")).first()
        artifact = session.get(Artifact, output.sha256)
    provenance = json.loads(artifact.provenance_json)
    required = {"artifact_id", "mission_id", "task_id", "git_revision", "tool_identity", "input_hashes", "output_hash", "evidence_class", "limitations", "owner", "timestamp", "signature"}
    contract = json.loads((PLATFORM_DIR.parent / "design/agents/orchestration-contract.json").read_text())["artifact_contract"]["required_fields"]
    assert set(contract) == required
    if provenance.get("task_id") == str(run.run_id):  # first registration of this blob
        assert required <= set(provenance)
        assert provenance["output_hash"] == f"sha256:{output.sha256}" and provenance["input_hashes"]


def test_every_adapter_outcome_uses_the_evidence_vocabulary():
    from aimem_platform.models import EVIDENCE_CLASSES
    from aimem_platform.runs.runners import Execution

    exited = Execution("exited", 0, 1, "docker")
    for adapter in adapter_module.ADAPTERS.values():
        outcome = adapter.summarize(Path("/nonexistent"), exited)
        assert outcome.evidence_class in EVIDENCE_CLASSES, (adapter.id, outcome.evidence_class)


class BadEvidenceAdapter(SelfTestAdapter):
    id = "test.bad_evidence"

    def summarize(self, out, execution):
        return Outcome("pass", "claims an evidence class that does not exist", evidence_class="signoff")


def test_a_finalization_failure_ends_the_run_as_errored_not_stuck(local_services, monkeypatch):
    monkeypatch.setitem(adapter_module.ADAPTERS, "test.bad_evidence", BadEvidenceAdapter())
    before = head_seq(local_services)
    run = submit_run(local_services, "test.bad_evidence", {}, actor=ENGINEER)
    run_worker(local_services, LocalRunner(), once=True)
    with local_services.db.read() as session:
        current = session.get(Run, run.run_id)
    assert current.status == "errored" and "finalization failed" in current.error and "signoff" in current.error
    errored = find(events_since(local_services, before), feature="run.lifecycle", action="errored")
    assert errored and "Traceback" in errored[0]["error"]


def test_local_runner_maps_only_a_leading_sandbox_path(tmp_path):
    # Regression: GitHub Actions checks out under /home/runner/work/..., which a substring
    # replace of "/work" mangled, so the interpreter path broke and runs errored.
    assert LocalRunner.map_path("/work/out", tmp_path) == f"{tmp_path}/out"
    assert LocalRunner.map_path("/work", tmp_path) == str(tmp_path)
    host = "/home/runner/work/repo/platform/.venv/bin/python"
    assert LocalRunner.map_path(host, tmp_path) == host
    assert LocalRunner.map_path("/workspace/file", tmp_path) == "/workspace/file"
