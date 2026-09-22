# AIMEM platform: audit backbone (Phase 0)

The control plane behind AIMEM Design Studio. Phase 0 delivers the part every
later phase depends on: **every action is logged, and the log cannot be quietly
changed.** Real tool execution (Phase 1), real agents (Phase 2), and
self-improvement loops (Phases 3 to 5) all write into this log. See
[`../docs/RSI_PLATFORM_PLAN.md`](../docs/RSI_PLATFORM_PLAN.md).

## Guarantees

| Guarantee | How it is enforced | Proof |
| --- | --- | --- |
| **No log, no action** | State changes commit in the same transaction as their audit event. `AuditedSession` refuses to commit domain writes without one. External steps commit a `started` event first and do not run if that fails. Responses are withheld (503) until the request's event is written. The service refuses to start without its log. | `tests/test_guard.py`, `tests/test_fail_closed.py` |
| **Append-only** | The runtime role holds only `INSERT`/`SELECT` on `audit_events`; triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` even for the owner. | `tests/test_append_only.py` |
| **Tamper-evident** | Every row stores the SHA-256 of its canonical content and the previous row's hash; `seq` is gapless. Verified heads are anchored to a file outside the database, so tail truncation is caught too. | `tests/test_tamper.py` (edit, forged rehash, middle delete, tail cut) |
| **Complete vocabulary** | `features.yaml` lists every feature and the actions it may emit. Unknown features or undeclared actions raise; the API refuses to start if a route names no registered feature. | `tests/test_routes.py`, `tests/test_registry.py` |
| **Every feature is covered** | CI runs a scenario per registered feature and fails if any required action is never emitted. The browser smoke test clicks every control in every view and fails if one is not logged or any event is not delivered. | `tests/test_event_coverage.py`, `../scripts/ui-audit-smoke.mjs` |
| **Secrets stay out** | Request bodies are never logged. Password inputs are never read in the browser; email fields are withheld. | `test_passwords_never_reach_the_audit_log`, `tests/ui-audit.test.ts` |

## What gets logged

| Source | Events |
| --- | --- |
| Browser | Every click, committed input change, form submit, keyboard shortcut, 3D camera gesture, view change, parameter edit, selection change, export (with SHA-256), sweep, agent replay control, 3D part selection, browser error, and page load/unload. |
| API | One `http_request` event per request (including 404s and CORS preflights) with route, status, latency, actor, and every RBAC decision, plus domain events such as `login`, `login_failed`, `artifact_written`, `verified`. |
| CLI | `started` and `finished`/`failed` for every command, plus its domain events. |
| System | Service `started`/`stopped`, every migration (written inside the migration transaction), unhandled exceptions with full tracebacks. |

Each event carries: `seq`, `event_id`, `ts`, `trace_id`/`span_id` (OpenTelemetry;
shared by a click, the request it caused, and every event that request wrote),
`parent_event_id`, actor (type, id, version, authenticated), `source`, `feature`,
`action`, `result`, target, input/output hashes, `error` (never truncated),
`details`, `cost` (wall time), `evidence_class`, `policy_decision`, `redaction`,
`client_ts`, `prev_hash`, and `hash`.

## Run it locally

Requires Python 3.12+ and PostgreSQL 16 (this machine uses the Homebrew instance on port 5432).

```bash
python3.12 -m venv platform/.venv && platform/.venv/bin/pip install -e 'platform[dev]'
bash platform/scripts/setup-local-db.sh      # roles + databases + platform/.env (idempotent)
npm run platform:migrate                      # schema; writes the first audit event
platform/.venv/bin/aimem-platform create-user --email you@example.com --role admin
npm run platform:dev                          # API on http://127.0.0.1:8100
npm run dev                                   # Studio on http://localhost:3000 → Activity tab
```

The Studio finds the API automatically when it is served from `localhost`. Set
`NEXT_PUBLIC_AIMEM_PLATFORM_API` at build time to point a deployed Studio at a
hosted API; without it, a deployed Studio records events in the page only and
says so in the Activity view.

| Command | Purpose |
| --- | --- |
| `npm run platform:test` | Backend suite, including the event-coverage gate (uses `aimem_platform_test`) |
| `npm run smoke:ui-audit` | Browser smoke test against a running Studio (starts its own API on the test database) |
| `aimem-platform verify-chain` | Recompute every hash, check anchors, anchor the new head |
| `aimem-platform tail --limit 50` | Print the latest events |
| `aimem-platform coverage` | Compare the log with `features.yaml` |

## Adding a feature

1. Register it in `features.yaml` with the actions it must emit (`events`) and may emit (`may_emit`).
2. API routes: pass `openapi_extra=feature("your.feature")` and include the router in `aimem_platform/api/__init__.py`.
   Write domain events with `services.writer.append(session, ...)` inside the transaction that changes state.
3. Add a scenario for it in `tests/test_event_coverage.py`. CI fails until every declared action is observed.
4. UI surfaces need nothing extra for clicks and inputs; record meaning with `track()` or `useTrackedValue()`.

## Configuration

Environment variables (or `platform/.env`) with the `AIMEM_` prefix:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | local `aimem_platform` as `aimem_platform_app` | Runtime role: INSERT/SELECT on the log only |
| `OWNER_DATABASE_URL` | none | Migrations only |
| `CORS_ORIGINS` | `["http://localhost:3000","http://127.0.0.1:3000"]` | JSON list |
| `ALLOW_ANONYMOUS_UI_EVENTS` | `true` | Set `false` for shared deployments; the browser then queues events until sign-in |
| `COOKIE_SECURE` / `COOKIE_SAMESITE` | `false` / `lax` | Use `true` / `none` when the Studio and API are on different sites over HTTPS |
| `SESSION_TTL_HOURS` | `12` | |
| `VAR_DIR` | `platform/var` | Artifacts, anchors, fallback log |
| `OTEL_CONSOLE` | `false` | Print spans; a collector exporter is Phase 5 |

## Known limits (tracked for later phases)

- Anchors live in a local file. Phase 5 moves them to a signed transparency log (Sigstore), so an attacker with both database and host access cannot rewrite history and anchors together.
- Rate limits are in-process; Phase 5 moves them to a shared store.
- Appends are serialized by one advisory lock, which is ample for Phase 0 volumes. Batching and partitioning come with Phase 1 tool runs.
- The UI buffer keeps the latest 1,000 events per page and 5,000 queued; if the API is unreachable longer than that, drops are counted and shown, not silent.
