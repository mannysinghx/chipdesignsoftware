"""Append-only, hash-chained audit log.

Rule: no log, no action. Every state change commits in the same transaction as
its audit event, every external step commits a `started` event before it runs,
and every HTTP response is withheld until its request event is written.
"""

from .context import ActorRef, AuditContext, audit_context, current_context
from .guard import UnauditedWriteError
from .writer import AuditUnavailableError, AuditValidationError, AuditWriter

__all__ = [
    "ActorRef",
    "AuditContext",
    "AuditUnavailableError",
    "AuditValidationError",
    "AuditWriter",
    "UnauditedWriteError",
    "audit_context",
    "current_context",
]
