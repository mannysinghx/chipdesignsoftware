from __future__ import annotations

import hashlib

from conftest import events_since, find, head_seq


def upload(client, headers, data: bytes, **extra):
    return client.post(
        "/api/artifacts",
        content=data,
        headers={
            **headers,
            "content-type": "application/json",
            "x-artifact-name": "rtl-synthesis.json",
            "x-evidence-class": "executed",
            "x-git-revision": "bbf75f1",
            "x-tool-identity": "yosys 0.65 (wasm)",
            **extra,
        },
    )


def test_upload_dedupe_download_and_list_are_audited(client, login, services):
    engineer = login("engineer")
    data = b'{"cells": 2447, "probe": "' + hashlib.sha256(str(id(services)).encode()).hexdigest().encode() + b'"}'
    digest = hashlib.sha256(data).hexdigest()
    before = head_seq(services)

    first = upload(client, engineer, data)
    assert first.status_code == 201, first.text
    assert first.json()["artifact"]["sha256"] == digest and first.json()["deduplicated"] is False
    assert services.artifacts.path_for(digest).read_bytes() == data
    second = upload(client, engineer, data)
    assert second.status_code == 201 and second.json()["deduplicated"] is True

    downloaded = client.get(f"/api/artifacts/{digest}", headers=login("viewer"))
    assert downloaded.status_code == 200 and downloaded.content == data
    listing = client.get("/api/artifacts", headers=login("viewer"))
    assert any(item["sha256"] == digest for item in listing.json()["artifacts"])

    events = events_since(services, before)
    written = find(events, feature="artifact.write", action="artifact_written")
    assert [event["details"]["deduplicated"] for event in written] == [False, True]
    assert written[0]["output_hash"] == f"sha256:{digest}"
    assert written[0]["evidence_class"] == "executed"
    provenance = written[0]["details"]["provenance"]
    assert provenance["git_revision"] == "bbf75f1" and provenance["owner"] == "engineer@aimem.test"
    assert set(provenance) == {
        "artifact_id", "mission_id", "task_id", "git_revision", "tool_identity", "input_hashes",
        "output_hash", "evidence_class", "limitations", "owner", "timestamp", "signature",
    }
    read = find(events, feature="artifact.read", action="artifact_read")
    assert read and read[0]["target"] == {"type": "artifact", "id": digest}
    assert find(events, feature="artifact.list", action="http_request")


def test_uploads_are_validated_and_role_checked(client, login):
    assert upload(client, login("viewer"), b"x").status_code == 403
    engineer = login("engineer")
    assert upload(client, engineer, b"x", **{"x-evidence-class": "signoff"}).status_code == 422
    assert upload(client, engineer, b"x", **{"x-input-hashes": "md5:abc"}).status_code == 422
    assert upload(client, engineer, b"").status_code == 422
    assert client.get("/api/artifacts/not-a-hash", headers=engineer).status_code == 422
    assert client.get(f"/api/artifacts/{'0' * 64}", headers=engineer).status_code == 404
