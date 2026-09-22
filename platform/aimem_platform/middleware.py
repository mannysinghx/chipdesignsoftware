"""Request audit middleware (pure ASGI).

Every HTTP request produces one `http_request` event under its route's
feature, including CORS preflights and unmatched paths. The response is held
until that event is committed: if the audit write fails, the client receives
503 instead of the response. State-changing handlers commit their own domain
event atomically with the change, so no action is ever left unlogged.
"""

from __future__ import annotations

import json
import traceback
from functools import partial
from time import perf_counter
from urllib.parse import unquote

import anyio
from opentelemetry.trace import SpanKind
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .audit.context import AuditContext, anonymous_actor, audit_context
from .deps import FEATURE_KEY
from .telemetry import tracer

PROPAGATOR = TraceContextTextMapPropagator()
MAX_QUERY_CHARS = 2000


def _result_for(status: int) -> str:
    if status in (401, 403, 429):
        return "denied"
    if status >= 400:
        return "error"
    return "ok"


def route_feature(scope: Scope) -> str:
    route = scope.get("route")
    feature = (getattr(route, "openapi_extra", None) or {}).get(FEATURE_KEY)
    if feature:
        return feature
    headers = Headers(scope=scope)
    if scope["method"] == "OPTIONS" and headers.get("access-control-request-method"):
        return "api.preflight"
    return "api.unrouted"


class AuditMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        services = scope["app"].state.services
        headers = Headers(scope=scope)
        client = scope.get("client")
        client_ip = client[0] if client else None
        carrier = {key: value for key in ("traceparent", "tracestate") if (value := headers.get(key))}
        parent = PROPAGATOR.extract(carrier) if carrier else None
        began = perf_counter()

        with tracer().start_as_current_span(f"{scope['method']} {scope['path']}", context=parent, kind=SpanKind.SERVER) as span:
            span_context = span.get_span_context()
            context = AuditContext(
                trace_id=format(span_context.trace_id, "032x"),
                span_id=format(span_context.span_id, "016x"),
                actor=anonymous_actor(client_ip),
                source="api",
                client_ip=client_ip,
                user_agent=(headers.get("user-agent") or "")[:300] or None,
            )
            scope.setdefault("state", {})["audit_context"] = context
            state: dict = {"logged": False, "blocked": False, "start": None}

            async def send_wrapper(message: Message) -> None:
                if message["type"] == "http.response.start":
                    state["start"] = message
                    return
                if message["type"] == "http.response.body" and not state["logged"]:
                    state["logged"] = True
                    start = state["start"]
                    written = await self._log(services, scope, context, start["status"], began, None)
                    if not written:
                        state["blocked"] = True
                        await _send_audit_unavailable(send, context.trace_id)
                        return
                    start = {**start, "headers": [*start.get("headers", []), (b"x-aimem-trace-id", context.trace_id.encode())]}
                    await send(start)
                if state["blocked"]:
                    return
                await send(message)

            with audit_context(context):
                try:
                    await self.app(scope, receive, send_wrapper)
                except Exception:
                    if not state["logged"]:
                        state["logged"] = True
                        await self._log(services, scope, context, 500, began, traceback.format_exc())
                    raise

    async def _log(self, services, scope: Scope, context: AuditContext, status: int, began: float, error: str | None) -> bool:
        return await anyio.to_thread.run_sync(partial(self._write, services, scope, context, status, began, error))

    @staticmethod
    def _write(services, scope: Scope, context: AuditContext, status: int, began: float, error: str | None) -> bool:
        route = scope.get("route")
        route_path = getattr(route, "path", None)
        latency_ms = round((perf_counter() - began) * 1000, 3)
        query = unquote(scope.get("query_string", b"").decode("latin-1"))[:MAX_QUERY_CHARS]
        details = {
            "method": scope["method"],
            "path": scope["path"],
            "route": route_path,
            "query": query or None,
            "status": status,
            "client_ip": context.client_ip,
            "user_agent": context.user_agent,
            **context.notes,
        }
        fields = dict(
            feature=route_feature(scope),
            action="http_request",
            result=_result_for(status),
            actor=context.actor,
            source="api",
            target=("route", f"{scope['method']} {route_path or scope['path']}"),
            details=details,
            policy_decision=context.policy_decisions or None,
            error=error,
            cost={"wall_ms": latency_ms},
            trace_id=context.trace_id,
            span_id=context.span_id,
        )
        try:
            with audit_context(context):
                services.writer.commit_event(services.db, **fields)
            return True
        except Exception as exc:  # the database or chain is unavailable: fail closed
            services.writer.write_fallback(fields, exc)
            return False


async def _send_audit_unavailable(send: Send, trace_id: str) -> None:
    body = json.dumps(
        {
            "error": "audit_unavailable",
            "detail": "The response was withheld because its audit event could not be written.",
            "trace_id": trace_id,
        }
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 503,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})
