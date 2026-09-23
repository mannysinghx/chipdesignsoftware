"""aimem-platform: operator commands. Every invocation is itself an audited action."""

from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

from sqlalchemy import select

from .audit.canonical import format_ts
from .audit.context import AuditContext, audit_context, cli_actor, new_span_id, new_trace_id
from .audit.writer import StepHandle, audited_step
from .config import Settings, get_settings
from .models import ROLES, AuditEvent
from .operations import coverage_report, serialize_event, verify_and_anchor
from .services import Services, build_services


def _read_password(args: argparse.Namespace) -> str:
    if args.password_stdin:
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("Password (12+ characters): ")
    second = getpass.getpass("Repeat password: ")
    if first != second:
        raise SystemExit("Passwords did not match.")
    return first


def cmd_create_user(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .api.users import create_user_record

    password = _read_password(args)
    user = create_user_record(services, email=args.email, password=password, role=args.role, display_name=args.name, via="cli")
    step.target = ("user", str(user.user_id))
    step.details["created_user"] = {"email": user.email, "role": user.role}
    print(f"Created {user.role} {user.email} ({user.user_id})")
    return 0


def cmd_verify_chain(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    result = verify_and_anchor(services, step)
    print(json.dumps({**result.as_dict(), "anchor": step.details.get("anchor")}, indent=2))
    return 0 if result.ok else 2


def cmd_tail(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    statement = select(AuditEvent).order_by(AuditEvent.seq.desc()).limit(args.limit)
    if args.feature:
        statement = statement.where(AuditEvent.feature == args.feature)
    with services.db.read() as session:
        rows = list(reversed(session.scalars(statement).all()))
    step.details["returned"] = len(rows)
    for row in rows:
        event = serialize_event(row)
        target = f" {event['target']['type']}:{event['target']['id']}" if event["target"] else ""
        print(f"{event['seq']:>7} {event['ts']} {event['result']:<7} {event['actor']['id']:<32} {event['feature']}.{event['action']}{target}")
    return 0


def cmd_coverage(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    report = coverage_report(services)
    step.details["coverage_percent"] = report["coverage_percent"]
    for item in report["features"]:
        missing = f"  missing: {', '.join(item['missing'])}" if item["missing"] else ""
        print(f"{item['id']:<24} {item['kind']:<7}{missing}")
    print(f"\n{report['covered_actions']}/{report['required_actions']} required actions observed ({report['coverage_percent']}%)")
    if report["undeclared"]:
        print(f"Undeclared events in the log: {report['undeclared']}")
    return 0 if not report["undeclared"] else 3


def _runner(args: argparse.Namespace, services: Services):
    from .runs.runners import make_runner

    return make_runner(args.runner or services.settings.runner, services.settings.docker_bin)


def cmd_toolchain(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .runs.service import toolchains_for
    from .runs.toolchains import DockerCLI

    toolchains = toolchains_for(services)
    docker = DockerCLI(services.settings.docker_bin)
    if not docker.available():
        print("Docker is not running.", file=sys.stderr)
        return 2
    if args.action == "status":
        status = toolchains.status(docker)
        step.details["status"] = status
        print(json.dumps({"lock_digest": toolchains.lock_digest, **status}, indent=2))
        return 0 if all(status["images"].values()) and all(status["bundles"].values()) else 1
    result = toolchains.ensure(services, docker, allow_download=not args.offline)
    step.details["actions"] = result["actions"]
    print(json.dumps(result, indent=2))
    return 0


def cmd_worker(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .runs.service import docker_container_alive, run_worker

    runner = _runner(args, services)
    alive = docker_container_alive(services.settings.docker_bin) if runner.name == "docker" else None
    try:
        executed = run_worker(services, runner, once=args.once, poll_s=args.poll, container_alive=alive)
    except KeyboardInterrupt:
        executed = -1
    step.details["executed"] = executed
    return 0


def _parse_params(pairs: list[str]) -> dict:
    params = {}
    for pair in pairs:
        key, _, value = pair.partition("=")
        params[key] = json.loads(value) if value[:1] in "[{0123456789-" or value in ("true", "false", "null") else value
    return params


def cmd_run(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .api.runs import serialize_run
    from .audit.context import cli_actor
    from .runs.reproduce import run_inline
    from .runs.service import submit_run

    runner = _runner(args, services)
    run = submit_run(services, args.adapter, _parse_params(args.param), actor=cli_actor())
    step.target = ("run", str(run.run_id))
    finished = run_inline(services, runner, run)
    payload = serialize_run(finished)
    step.details.update({"run_id": payload["run_id"], "status": payload["status"], "output_manifest_hash": payload["output_manifest_hash"]})
    print(json.dumps(payload, indent=2))
    return 0 if finished.status in ("succeeded", "failed") else 1


def cmd_reproduce(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .audit.context import cli_actor
    from .runs.reproduce import reproduce_run

    result = reproduce_run(services, _runner(args, services), args.run_id, actor=cli_actor())
    step.target = ("run", args.run_id)
    step.details.update({"identical": result["identical"], "reproduction_run": result["reproduction_run"]})
    print(json.dumps(result, indent=2))
    return 0 if result["identical"] else 4


def cmd_reconstruct(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .runs.reconstruct import compare_with_record

    result = compare_with_record(services, args.run_id)
    step.target = ("run", args.run_id)
    step.details["consistent"] = result["consistent"]
    print(json.dumps({"checks": result["checks"], "consistent": result["consistent"], "problems": result["reconstructed"]["problems"]}, indent=2))
    return 0 if result["consistent"] else 5


def cmd_manifest(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .runs.reconstruct import reconstruct_run

    rebuilt = reconstruct_run(services, args.run_id)
    step.target = ("run", args.run_id)
    outputs = rebuilt["outputs"] or {}
    print(json.dumps({
        "run_id": args.run_id,
        "adapter": rebuilt["adapter"],
        "spec_hash": rebuilt["spec_hash"],
        "status": (rebuilt["final"] or {}).get("status"),
        "output_manifest_hash": outputs.get("output_manifest_hash"),
        "reproducible": outputs.get("reproducible", {}),
    }, indent=2, sort_keys=True))
    return 0


def cmd_compare_manifests(args: argparse.Namespace, services: Services, step: StepHandle) -> int:
    from .runs.reconstruct import compare_manifests

    first = json.loads(Path(args.first).read_text())
    second = json.loads(Path(args.second).read_text())
    result = compare_manifests(first.get("reproducible", first), second.get("reproducible", second))
    result["spec_hash_equal"] = first.get("spec_hash") == second.get("spec_hash")
    step.details.update({"identical": result["identical"], "spec_hash_equal": result["spec_hash_equal"], "incomparable": len(result["incomparable"])})
    print(json.dumps(result, indent=2))
    if result["incomparable"]:
        print(
            f"{len(result['incomparable'])} file(s) were normalized under different schemes, so their hashes were not compared; "
            "reproduce the older run to get a manifest under the current schemes.",
            file=sys.stderr,
        )
    return 0 if result["identical"] and result["spec_hash_equal"] else 4


COMMANDS = {
    "create-user": cmd_create_user,
    "verify-chain": cmd_verify_chain,
    "tail": cmd_tail,
    "coverage": cmd_coverage,
    "toolchain": cmd_toolchain,
    "worker": cmd_worker,
    "run": cmd_run,
    "reproduce": cmd_reproduce,
    "reconstruct": cmd_reconstruct,
    "manifest": cmd_manifest,
    "compare-manifests": cmd_compare_manifests,
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aimem-platform", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-user", help="Create a user (prompts for the password)")
    create.add_argument("--email", required=True)
    create.add_argument("--role", choices=ROLES, default="viewer")
    create.add_argument("--name")
    create.add_argument("--password-stdin", action="store_true", help="Read the password from the first line of stdin")
    commands.add_parser("verify-chain", help="Verify the audit hash chain and anchor the verified head")
    tail = commands.add_parser("tail", help="Print the most recent audit events")
    tail.add_argument("--limit", type=int, default=25)
    tail.add_argument("--feature")
    commands.add_parser("coverage", help="Compare the log with the feature registry")

    toolchain = commands.add_parser("toolchain", help="Check or install the pinned tool images and bundles")
    toolchain.add_argument("action", choices=["status", "install"])
    toolchain.add_argument("--offline", action="store_true", help="Fail instead of downloading")

    worker = commands.add_parser("worker", help="Execute queued runs in the sandbox")
    worker.add_argument("--once", action="store_true", help="Exit when the queue is empty")
    worker.add_argument("--poll", type=float, default=1.0)
    worker.add_argument("--runner", choices=["docker", "local"])

    run = commands.add_parser("run", help="Submit a run and execute it in this process")
    run.add_argument("adapter")
    run.add_argument("--param", action="append", default=[], help="key=value (repeatable)")
    run.add_argument("--runner", choices=["docker", "local"])

    reproduce = commands.add_parser("reproduce", help="Re-execute a run from its audit record and compare outputs")
    reproduce.add_argument("run_id")
    reproduce.add_argument("--runner", choices=["docker", "local"])

    reconstruct = commands.add_parser("reconstruct", help="Rebuild a run from the audit log and compare it with the runs table")
    reconstruct.add_argument("run_id")

    manifest = commands.add_parser("manifest", help="Print a run's reproducible-output manifest (from the audit log)")
    manifest.add_argument("run_id")

    compare = commands.add_parser("compare-manifests", help="Compare two manifest files, e.g. from two machines")
    compare.add_argument("first")
    compare.add_argument("second")
    return parser


def main(argv: list[str] | None = None, *, settings: Settings | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = settings or get_settings()
    actor = cli_actor()
    services = build_services(settings, default_actor=actor, default_source="cli")
    recorded_args = {key: value for key, value in vars(args).items() if key not in {"command", "password_stdin"}}
    context = AuditContext(trace_id=new_trace_id(), span_id=new_span_id(), actor=actor, source="cli")
    exit_code = 1
    try:
        with audit_context(context):
            with audited_step(
                services.db,
                services.writer,
                feature="cli.command",
                target=("command", args.command),
                details={"command": args.command, "args": recorded_args, "started_at": format_ts(services.writer.clock())},
            ) as step:
                exit_code = COMMANDS[args.command](args, services, step)
                step.details["exit_code"] = exit_code
                if exit_code:
                    step.result = "error"
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        exit_code = 1
    finally:
        services.close()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
