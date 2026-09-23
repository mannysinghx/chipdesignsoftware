"""The agent task state machine (31 Aug plan, section 5.2).

    CREATED → CONTEXT_VALIDATED → PLAN_PROPOSED → APPROVED_IF_REQUIRED → RUNNING_TOOLS
            → EVIDENCE_COLLECTED → SELF_CHECKED → REVIEW_REQUIRED → ACCEPTED / REJECTED / NEEDS_WORK

A task moves only along these edges, and every move is an agent.task event written in
the same transaction as the row change (mission.py). Any state before review may also
end in NEEDS_WORK (a denied plan, a failed tool, a spent budget), with the reason.
"""

from __future__ import annotations

FORWARD = (
    "CREATED",
    "CONTEXT_VALIDATED",
    "PLAN_PROPOSED",
    "APPROVED_IF_REQUIRED",
    "RUNNING_TOOLS",
    "EVIDENCE_COLLECTED",
    "SELF_CHECKED",
    "REVIEW_REQUIRED",
)
TERMINAL = frozenset({"ACCEPTED", "REJECTED", "NEEDS_WORK"})
EDGES: dict[str, frozenset[str]] = {
    **{state: frozenset({following, "NEEDS_WORK"}) for state, following in zip(FORWARD, FORWARD[1:])},
    "PLAN_PROPOSED": frozenset({"APPROVED_IF_REQUIRED", "REJECTED", "NEEDS_WORK"}),
    "REVIEW_REQUIRED": frozenset({"ACCEPTED", "REJECTED", "NEEDS_WORK"}),
}


class IllegalTransition(ValueError):
    """A task was asked to move along an edge the state machine does not have."""


def check(current: str, target: str) -> None:
    if target not in EDGES.get(current, frozenset()):
        raise IllegalTransition(f"a task in {current} cannot move to {target}")


def action(state: str) -> str:
    """The agent.task audit action for entering a state."""
    return state.lower()
