"""Per-task worktrees under var/worktrees/<mission>/<node>: an agent's only way to write a file.

Every write goes through policy.write: the path must stay inside the task's own worktree
(no absolute paths, no "..", no symlinks, no NUL bytes or backslashes). A refused write
never touches the disk and is logged as an agent.task policy_decision with result
"denied". An allowed write is logged as an agent.task tool_call carrying the content
hash, and the file appears only after that event commits (no log, no action). The bytes
are also kept in the artifact store.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ..audit.context import ActorRef
from ..models import AgentTask, Mission
from ..runs.service import _new_artifact_row
from ..services import Services
from . import policy


class WriteDenied(PermissionError):
    """An agent asked to write outside its task worktree."""


def root_for(services: Services, task: AgentTask) -> Path:
    return services.settings.var_dir / task.worktree


def write(services: Services, mission: Mission, task: AgentTask, relative: str, data: bytes, *, actor: ActorRef) -> dict:
    root = root_for(services, task)
    root.mkdir(parents=True, exist_ok=True)
    decision, target = policy.write(root, relative)
    common = dict(actor=actor, target=("agent_task", str(task.task_id)), trace_id=mission.trace_id, parent_event_id=task.root_event_id)
    shown = relative[:300] if isinstance(relative, str) else repr(relative)[:300]
    if not decision.allowed:
        services.writer.commit_event(
            services.db, feature="agent.task", action="policy_decision", result="denied",
            details={"node": task.node, "tool": "worktree.write", "path": shown, "worktree": task.worktree}, policy_decision=decision.as_dict(), **common,
        )
        raise WriteDenied(f"{shown!r}: {decision.reason}")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, staged = tempfile.mkstemp(dir=target.parent, prefix=".staged-")
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        blob = services.artifacts.put(data)
        with services.db.transaction() as session:
            row = _new_artifact_row(
                session, blob.sha256, blob.size_bytes, Path(relative).name, "text/plain", "unclassified",
                {"role": "agent worktree file", "mission_id": str(mission.mission_id), "task_id": str(task.task_id), "path": relative}, actor.id,
            )
            if row is not None:
                session.add(row)
            services.writer.append(
                session, feature="agent.task", action="tool_call", output_hash=f"sha256:{blob.sha256}",
                details={"node": task.node, "tool": "worktree.write", "path": relative, "bytes": len(data), "worktree": task.worktree},
                policy_decision=decision.as_dict(), **common,
            )
        os.replace(staged, target)
    finally:
        Path(staged).unlink(missing_ok=True)
    return {"tool": "worktree.write", "path": relative, "sha256": blob.sha256, "bytes": len(data)}
