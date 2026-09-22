"""aimem-platform: operator commands. Every invocation is itself an audited action."""

from __future__ import annotations

import argparse
import getpass
import json
import sys

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


COMMANDS = {
    "create-user": cmd_create_user,
    "verify-chain": cmd_verify_chain,
    "tail": cmd_tail,
    "coverage": cmd_coverage,
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
