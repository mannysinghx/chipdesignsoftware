from __future__ import annotations

import threading

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor

from . import __version__

_configured = False
_lock = threading.Lock()


def setup_tracing(*, environment: str, console: bool = False) -> None:
    """Install the OpenTelemetry SDK so every request gets real trace and span ids.

    Audit events carry those ids, which is what links a browser click, the API
    request it caused, and every event the request wrote. Spans are exported to
    the console only when AIMEM_OTEL_CONSOLE=true; a collector exporter is Phase 5.
    """
    global _configured
    with _lock:
        if _configured:
            return
        provider = TracerProvider(
            resource=Resource.create(
                {"service.name": "aimem-platform", "service.version": __version__, "deployment.environment": environment}
            )
        )
        if console:
            provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
        trace.set_tracer_provider(provider)
        _configured = True


def tracer() -> trace.Tracer:
    return trace.get_tracer("aimem_platform", __version__)
