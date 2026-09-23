"""Model gateway: the one audited path for every model call, with hard budgets.

Routes: local (Ollama, the default), hosted (Claude through the Anthropic SDK, only with
a configured key and a mission that opted in), and scripted (tests only). Every call:
  1. checks the task and mission token ceilings (and, for the hosted route, the spend
     ceiling) first; a call that could cross one is refused and logged as budget.limit
     limit_hit and run_halted, and the task stops;
  2. keeps the exact prompt and response in the artifact store, content-addressed;
  3. writes one agent.task llm_call event (model, template version, token counts, spend
     estimate, prompt and response hashes) in the same transaction that adds the usage
     to the task and mission rows.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from time import perf_counter
from typing import Callable, Protocol

import httpx

from ..audit.canonical import dumps_canonical
from ..audit.context import ActorRef
from ..audit.writer import utcnow
from ..models import AgentTask, Mission
from ..runs.service import _new_artifact_row
from ..services import Services
from . import policy
from .prompts import Template

HOSTED_BETAS = ["server-side-fallback-2026-07-01"]  # re-runs a declined request on the recommended fallback model


@dataclass(frozen=True)
class Completion:
    text: str
    tokens_in: int
    tokens_out: int
    model: str
    stop: str


class GatewayError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class BudgetExceeded(GatewayError):
    """A model call could cross a hard ceiling, so it was never made."""


class Provider(Protocol):
    name: str

    def complete(self, system: str, prompt: str, schema: dict, max_tokens: int) -> Completion: ...


class OllamaProvider:
    """Local models through Ollama's chat API, with the output constrained to the JSON schema."""

    name = "ollama"

    def __init__(self, base_url: str, model: str, *, context_tokens: int, think: bool | None, timeout: float, transport: httpx.BaseTransport | None = None):
        self.base_url, self.model, self.context_tokens, self.think, self.timeout = base_url, model, context_tokens, think, timeout
        self.client = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)

    def complete(self, system: str, prompt: str, schema: dict, max_tokens: int) -> Completion:
        body = {
            "model": self.model,
            "stream": False,
            "format": schema,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "options": {"temperature": 0, "seed": 0, "num_ctx": self.context_tokens, "num_predict": max_tokens},
        }
        if self.think is not None:
            body["think"] = self.think
        try:
            response = self.client.post("/api/chat", json=body)
        except httpx.TimeoutException as exc:
            raise GatewayError(f"Ollama did not answer within {self.timeout:.0f} s", retryable=True) from exc
        except httpx.TransportError as exc:
            raise GatewayError(f"Ollama is not reachable at {self.base_url} ({exc}); start it with `ollama serve`", retryable=True) from exc
        if response.status_code != 200:
            raise GatewayError(f"Ollama returned HTTP {response.status_code}: {response.text[:500]}", retryable=response.status_code >= 500)
        payload = response.json()
        return Completion(
            text=payload["message"]["content"],
            tokens_in=int(payload.get("prompt_eval_count") or 0),
            tokens_out=int(payload.get("eval_count") or 0),
            model=payload.get("model") or self.model,
            stop=payload.get("done_reason") or "stop",
        )


class AnthropicProvider:
    """Claude through the official SDK: JSON-schema structured output, server-side refusal fallback."""

    name = "anthropic"

    def __init__(self, api_key: str, base_url: str, model: str, *, timeout: float, client=None):
        self.model = model
        if client is None:
            try:
                import anthropic
            except ImportError as exc:
                raise GatewayError("the hosted route needs the Anthropic SDK: platform/.venv/bin/pip install -e 'platform[hosted]'") from exc
            # base_url is explicit so the client never inherits an ANTHROPIC_BASE_URL meant for another program.
            client = anthropic.Anthropic(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=2)
        self.client = client

    def complete(self, system: str, prompt: str, schema: dict, max_tokens: int) -> Completion:
        try:
            response = self.client.beta.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": prompt}],
                output_config={"format": {"type": "json_schema", "schema": schema}},
                betas=HOSTED_BETAS,
                fallbacks="default",
            )
        except Exception as exc:
            raise _hosted_error(exc) from exc
        if response.stop_reason == "refusal":
            category = getattr(getattr(response, "stop_details", None), "category", None)
            raise GatewayError(f"the model declined the request (category {category})")
        if response.stop_reason == "max_tokens":
            raise GatewayError("the model reached max_tokens before finishing its answer")
        text = next((block.text for block in response.content if block.type == "text"), None)
        if text is None:
            raise GatewayError("the response had no text block")
        # Top-level usage is the attempt that produced this message; a declined attempt before output is not billed.
        return Completion(text, int(response.usage.input_tokens), int(response.usage.output_tokens), response.model, response.stop_reason)


def _hosted_error(exc: Exception) -> GatewayError:
    try:
        import anthropic
    except ImportError:
        return GatewayError(f"{type(exc).__name__}: {exc}")
    if isinstance(exc, anthropic.RateLimitError):
        return GatewayError("the hosted API rate-limited the request", retryable=True)
    if isinstance(exc, anthropic.APIStatusError):
        return GatewayError(f"the hosted API returned HTTP {exc.status_code}: {exc.message}", retryable=exc.status_code >= 500)
    if isinstance(exc, anthropic.APIConnectionError):
        return GatewayError(f"the hosted API could not be reached: {exc}", retryable=True)
    return GatewayError(f"{type(exc).__name__}: {exc}")


class ScriptedProvider:
    """Deterministic answers for tests: respond(system, prompt, schema) returns the JSON object."""

    name = "scripted"

    def __init__(self, respond: Callable[[str, str, dict], dict]):
        self.respond = respond

    def complete(self, system: str, prompt: str, schema: dict, max_tokens: int) -> Completion:
        text = json.dumps(self.respond(system, prompt, schema), sort_keys=True)
        return Completion(text, (len(system) + len(prompt)) // 4, len(text) // 4, "scripted", "stop")


def empty_usage() -> dict:
    return {"calls": 0, "tokens_in": 0, "tokens_out": 0, "tokens": 0, "usd": 0.0}


def model_for(settings, route: str) -> str:
    return {"local": settings.ollama_model, "hosted": settings.anthropic_model}.get(route, route)


class ModelGateway:
    def __init__(self, services: Services, route: str, provider: Provider, *, model: str, usd_per_mtok: tuple[float, float] = (0.0, 0.0)):
        self.services, self.route, self.provider, self.model, self.usd_per_mtok = services, route, provider, model, usd_per_mtok

    @classmethod
    def for_mission(cls, services: Services, mission: Mission) -> "ModelGateway":
        settings = services.settings
        decision = policy.route(settings, mission.model_route)
        if not decision.allowed:
            raise GatewayError(f"model route {mission.model_route!r} is not allowed: {decision.reason}")
        if mission.model_route == "local":
            provider = OllamaProvider(
                settings.ollama_url, settings.ollama_model, context_tokens=settings.ollama_context_tokens, think=settings.ollama_think, timeout=settings.llm_timeout_s
            )
            return cls(services, "local", provider, model=settings.ollama_model)
        if mission.model_route == "hosted":
            provider = AnthropicProvider(
                settings.anthropic_api_key.get_secret_value(), settings.anthropic_base_url, settings.anthropic_model, timeout=settings.llm_timeout_s
            )
            return cls(services, "hosted", provider, model=settings.anthropic_model, usd_per_mtok=settings.anthropic_usd_per_mtok)
        raise GatewayError("the scripted route has no default provider; tests pass one explicitly")

    def ask(self, *, mission: Mission, task: AgentTask, actor: ActorRef, template: Template, values: dict, schema: dict, purpose: str) -> dict:
        """One model call that must return a JSON object matching `schema`."""
        system, prompt = template.render(**values)
        max_tokens = self.services.settings.llm_max_output_tokens
        self._check_budget(mission, task, actor, estimate=(len(system) + len(prompt)) // 3 + max_tokens)
        request = dumps_canonical({"route": self.route, "model": self.model, "template": template.id, "system": system, "prompt": prompt, "schema": schema})
        prompt_blob = self.services.artifacts.put(request.encode("utf-8"))
        details = {"purpose": purpose, "template": template.id, "route": self.route, "provider": self.provider.name, "model": self.model, "node": task.node}
        began = perf_counter()
        try:
            completion = self.provider.complete(system, prompt, schema, max_tokens)
        except GatewayError as exc:
            self.services.writer.commit_event(
                self.services.db, feature="agent.task", action="llm_call", result="error", actor=actor, target=("agent_task", str(task.task_id)),
                trace_id=mission.trace_id, parent_event_id=task.root_event_id, input_hash=f"sha256:{prompt_blob.sha256}", error=str(exc),
                details={**details, "retryable": exc.retryable}, cost={"wall_ms": round((perf_counter() - began) * 1000, 3)},
            )
            raise
        wall_ms = round((perf_counter() - began) * 1000, 3)
        response_blob = self.services.artifacts.put(completion.text.encode("utf-8"))
        usd = round(completion.tokens_in * self.usd_per_mtok[0] / 1e6 + completion.tokens_out * self.usd_per_mtok[1] / 1e6, 6)
        now = utcnow()
        with self.services.db.transaction() as session:
            for blob, name, role in ((prompt_blob, "llm-request.json", "llm request"), (response_blob, "llm-response.json", "llm response")):
                row = _new_artifact_row(
                    session, blob.sha256, blob.size_bytes, name, "application/json", "unclassified",
                    {"role": role, "mission_id": str(mission.mission_id), "task_id": str(task.task_id), "template": template.id, "model": completion.model},
                    actor.id,
                )
                if row is not None:
                    session.add(row)
            for row in (session.get(AgentTask, task.task_id, with_for_update=True), session.get(Mission, mission.mission_id, with_for_update=True)):
                usage = json.loads(row.usage_json)
                usage.update(
                    calls=usage["calls"] + 1, tokens_in=usage["tokens_in"] + completion.tokens_in, tokens_out=usage["tokens_out"] + completion.tokens_out,
                    tokens=usage["tokens"] + completion.tokens_in + completion.tokens_out, usd=round(usage["usd"] + usd, 6),
                )
                row.usage_json = dumps_canonical(usage)
                if isinstance(row, AgentTask):
                    row.updated_at = now
            self.services.writer.append(
                session, feature="agent.task", action="llm_call", actor=actor, target=("agent_task", str(task.task_id)),
                trace_id=mission.trace_id, parent_event_id=task.root_event_id,
                input_hash=f"sha256:{prompt_blob.sha256}", output_hash=f"sha256:{response_blob.sha256}",
                details={**details, "model": completion.model, "stop": completion.stop, "prompt_bytes": len(request), "response_bytes": len(completion.text)},
                cost={"tokens_in": completion.tokens_in, "tokens_out": completion.tokens_out, "model": completion.model, "usd": usd, "wall_ms": wall_ms},
            )
        if completion.stop == "length":
            raise GatewayError(f"the model reached its {max_tokens}-token output limit before finishing")
        try:
            answer = json.loads(completion.text)
        except ValueError as exc:
            raise GatewayError(f"the model's answer is not JSON (response sha256 {response_blob.sha256})") from exc
        if not isinstance(answer, dict):
            raise GatewayError("the model's answer is not a JSON object")
        return answer

    def _check_budget(self, mission: Mission, task: AgentTask, actor: ActorRef, *, estimate: int) -> None:
        with self.services.db.read() as session:
            task_usage = json.loads(session.get(AgentTask, task.task_id).usage_json)
            mission_row = session.get(Mission, mission.mission_id)
            mission_usage, limits = json.loads(mission_row.usage_json), json.loads(mission_row.budget_json)
        estimate_usd = estimate * max(self.usd_per_mtok) / 1e6
        breaches = [
            {"scope": scope, "used": used, "estimate": extra, "limit": limit}
            for scope, used, extra, limit in (
                ("task_tokens", task_usage["tokens"], estimate, limits["task_tokens"]),
                ("mission_tokens", mission_usage["tokens"], estimate, limits["mission_tokens"]),
                ("mission_usd", mission_usage["usd"], round(estimate_usd, 6), limits["mission_usd"]),
            )
            if used + extra > limit
        ]
        if not breaches:
            return
        target = ("agent_task", str(task.task_id))
        common = dict(actor=actor, target=target, trace_id=mission.trace_id, parent_event_id=task.root_event_id)
        with self.services.db.transaction() as session:
            self.services.writer.append(session, feature="budget.limit", action="limit_hit", result="denied", details={"node": task.node, "breaches": breaches}, **common)
            self.services.writer.append(session, feature="budget.limit", action="run_halted", result="error", details={"node": task.node, "reason": "a model call could cross a hard ceiling"}, **common)
        raise BudgetExceeded("budget ceiling: " + "; ".join(f"{b['scope']} {b['used']} + {b['estimate']} > {b['limit']}" for b in breaches))
