"""Phase 2: agents that coordinate typed tool runs through an audited task state machine.

Agents plan, run approved tools, and check their evidence; deterministic tools produce
the evidence. Every transition, model call, tool call, and policy decision is an audit
event in the mission's trace, and people approve at the points policy.py names.
"""
