from __future__ import annotations

import io
import json

from aimem_platform import cli

from conftest import events_since, find, head_seq


def run(env, monkeypatch, *argv: str, stdin: str = "") -> int:
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    return cli.main(list(argv), settings=env.settings)


def test_every_command_is_bracketed_by_started_and_finished(env, services, monkeypatch, capsys):
    before = head_seq(services)
    assert run(env, monkeypatch, "create-user", "--email", "cli.user@aimem.test", "--role", "engineer", "--password-stdin", stdin="cli-password-long-enough\n") == 0
    assert run(env, monkeypatch, "tail", "--limit", "3") == 0
    assert run(env, monkeypatch, "coverage") in (0, 3)
    events = events_since(services, before)

    commands = find(events, feature="cli.command")
    assert [(event["action"], event["details"]["command"]) for event in commands] == [
        ("started", "create-user"),
        ("finished", "create-user"),
        ("started", "tail"),
        ("finished", "tail"),
        ("started", "coverage"),
        ("finished", "coverage"),
    ]
    assert all(event["source"] == "cli" and event["actor"]["id"].startswith("cli:") for event in commands)
    created = find(events, feature="auth.user", action="created")[0]
    assert created["details"]["via"] == "cli" and created["trace_id"] == commands[0]["trace_id"]
    assert "cli-password-long-enough" not in json.dumps(events)
    assert "cli.user@aimem.test" in capsys.readouterr().out


def test_failed_commands_are_logged_as_failed(env, services, monkeypatch):
    before = head_seq(services)
    code = run(env, monkeypatch, "create-user", "--email", "viewer@aimem.test", "--password-stdin", stdin="another-long-password\n")
    assert code == 1
    actions = [event["action"] for event in find(events_since(services, before), feature="cli.command")]
    assert actions == ["started", "failed"]


def test_verify_chain_command_anchors_the_head(env, services, monkeypatch, capsys):
    assert run(env, monkeypatch, "verify-chain") == 0
    output = json.loads(capsys.readouterr().out)
    assert output["ok"] is True and output["anchor"]["seq"] == output["head_seq"]
