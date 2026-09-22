"""Static checks for writes the runtime guard cannot see.

The AuditedSession guard catches ORM and DML writes that go through a Session.
These checks cover the rest: raw SQL, file writes, and functions that add or
delete rows without writing an audit event.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from conftest import PLATFORM_DIR

PACKAGE = PLATFORM_DIR / "aimem_platform"
# Modules allowed to write files, and why:
#   artifacts.py        the content-addressed blob store (its callers write the audit event)
#   audit/writer.py     the fallback log, used only when the database write failed
#   audit/verifier.py   the external anchor file
FILE_WRITERS = {"artifacts.py", "audit/writer.py", "audit/verifier.py"}
DML = re.compile(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b", re.IGNORECASE)
WRITE_MODES = re.compile(r"[wax+]")


def modules():
    for path in sorted(PACKAGE.rglob("*.py")):
        yield path.relative_to(PACKAGE).as_posix(), ast.parse(path.read_text(), filename=str(path))


def call_name(node: ast.Call) -> str | None:
    function = node.func
    return function.attr if isinstance(function, ast.Attribute) else function.id if isinstance(function, ast.Name) else None


def test_no_raw_sql_writes_in_application_code():
    offenders = []
    for name, tree in modules():
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and call_name(node) == "text":
                for argument in node.args:
                    if isinstance(argument, ast.Constant) and isinstance(argument.value, str) and DML.search(argument.value):
                        offenders.append(f"{name}:{node.lineno}")
    assert not offenders, f"raw SQL writes bypass the audit guard; use the ORM inside an audited transaction: {offenders}"


def test_files_are_written_only_by_allowlisted_modules():
    offenders = []
    for name, tree in modules():
        if name in FILE_WRITERS:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            called = call_name(node)
            receiver = node.func.value if isinstance(node.func, ast.Attribute) else None
            module_call = isinstance(receiver, ast.Name) and receiver.id in {"os", "shutil", "tempfile"}
            # Path methods that only exist for filesystem writes, or os/shutil/tempfile calls
            # (str.replace and list.remove are not file operations).
            if called in {"write_text", "write_bytes", "unlink", "rename", "touch", "mkstemp", "rmtree"} or (
                module_call and called in {"replace", "remove", "rename", "unlink", "rmtree", "move", "copy", "copyfile", "mkstemp"}
            ):
                offenders.append(f"{name}:{node.lineno} {called}()")
            if called == "open":
                modes = [arg.value for arg in node.args[1:2] if isinstance(arg, ast.Constant)]
                modes += [kw.value.value for kw in node.keywords if kw.arg == "mode" and isinstance(kw.value, ast.Constant)]
                if any(isinstance(mode, str) and WRITE_MODES.search(mode) for mode in modes):
                    offenders.append(f"{name}:{node.lineno} open(mode={modes[0]!r})")
    assert not offenders, f"file writes outside the allowlist: {offenders}"


def _changes_rows(function: ast.AST) -> bool:
    for node in ast.walk(function):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            owner = node.func.value
            if isinstance(owner, ast.Name) and owner.id == "session" and node.func.attr in {"add", "add_all", "delete", "merge"}:
                return True
    return False


def _writes_audit_event(function: ast.AST) -> bool:
    for node in ast.walk(function):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in {"append", "append_rows"}:
            owner = node.func.value
            if isinstance(owner, ast.Attribute) and owner.attr == "writer":
                return True
    return False


def test_functions_that_change_rows_also_write_an_audit_event():
    offenders = []
    for name, tree in modules():
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _changes_rows(node) and not _writes_audit_event(node):
                offenders.append(f"{name}:{node.lineno} {node.name}()")
    assert not offenders, f"functions add or delete rows without writer.append(): {offenders}"
