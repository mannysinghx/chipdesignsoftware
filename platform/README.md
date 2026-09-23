# AIMEM platform: audit backbone, tool runs, and agent missions

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

## Tool runs (Phase 1)

A **run** executes one adapter's pinned tools in a sandbox and records everything about it.

| Adapter | Tools | Evidence |
| --- | --- | --- |
| `platform.selftest` | python3 in the pinned image | The sandbox really has no network, a read-only root filesystem and inputs, and a non-root user |
| `rtl.lint` | Verilator 5.053 `-Wall` | Lint of the full T0 hierarchy and each block |
| `rtl.sim` | cocotb 2.1 + Icarus 14 | Seeded regression against independent Python reference models (`verification/cocotb/`) |
| `formal.sby` | SymbiYosys 0.69 + Bitwuzla | SECDED proofs for any data word, channel k-induction proof, cover checks, protocol contract (`formal/*.sby`) |
| `physical.orfs` | OpenROAD-flow-scripts, OpenSTA, KLayout | `aimem_t0_channel` → sky130hd GDS, KLayout DRC and LVS, timing at the 800 MHz contract clock |

**Pinned toolchains** (`toolchains.lock.json`): the `openroad/orfs` image by digest, and the OSS CAD Suite by SHA-256 in a read-only Docker volume. `aimem-platform toolchain install` is the only step that downloads anything.

**Sandbox** (`runs/runners.py`, DockerRunner): `--network none`, read-only root filesystem, every capability dropped, `no-new-privileges`, non-root user, CPU/memory/PID limits, wall-clock timeout, and only `/work/in` (read-only), `/work/out`, and toolchain volumes mounted. The host environment is not passed in. The self-test adapter checks all of this on every machine.

**Identity**: a run's spec hash covers the image digest, toolchain hashes, command, environment, and every input file's SHA-256 (inputs are snapshotted into the artifact store at submission). Limits are recorded but excluded, because they bound a run rather than define it.

**Audit**: `run.lifecycle` records `queued` (with the complete spec), `claimed`, `started` (committed before the sandbox launches), `outputs_recorded` (every kept output by hash, plus normalized hashes for comparison), and `finished` / `errored` / `timed_out` / `cancelled`, all in one trace. `aimem-platform reconstruct <run>` and the Runs workspace rebuild a run from those events alone and compare them with the `runs` table.

**Reproducibility**: `aimem-platform reproduce <run>` re-executes the spec recovered from the audit log and compares normalized outputs. `manifest` and `compare-manifests` compare runs across machines; CI's `eda-runs` job is the second machine. Every normalized hash names its scheme (`runs/normalize.py`):

- `gds-v1` zeroes the GDSII BGNLIB/BGNSTR date payloads, and `raw-v1` hashes the bytes as written.
- `json-v2` hashes canonical JSON without two kinds of key. It drops keys whose trailing tokens are an ORFS METRICS2.1 runtime, CPU or peak-memory reading (`*__runtime__total`, `*__cpu__total`, `*__mem__peak`), a `timestamp`, a `date` or a `hostname`. It also drops the exact keys the adapter declares for that file (`/checks/uid` in `selftest.json`). Each entry lists the keys it dropped.

Hashes are compared only when their schemes match. Any other file is reported as `incomparable`, never as identical. When a run was recorded under an older scheme, `reproduce` re-hashes its stored outputs under the current scheme before comparing, and says so. json-v1 matched substrings, so it could drop design keys such as `candidates` or `aimem_bank`. It dropped none from any output recorded so far, and those outputs hash identically under json-v2 (`docs/OPS_LOG.md`, 2026-09-22).

```bash
platform/.venv/bin/aimem-platform toolchain install      # pinned image + hash-verified bundle
npm run platform:worker                                   # executes queued runs in the sandbox
platform/.venv/bin/aimem-platform run rtl.sim             # or submit from the Runs workspace
platform/.venv/bin/aimem-platform reproduce <run-id>
```

## Agent missions (Phase 2)

`aimem_platform/agents/` drives the eight open nodes of the orchestration DAG (contract, architecture, performance, RTL, formal, physical, multiphysics, evidence) as agent tasks. Agents plan, call typed tools, and check their evidence. The tools produce the evidence, and people approve at fixed points.

**State machine** (`fsm.py`): `CREATED → CONTEXT_VALIDATED → PLAN_PROPOSED → APPROVED_IF_REQUIRED → RUNNING_TOOLS → EVIDENCE_COLLECTED → SELF_CHECKED → REVIEW_REQUIRED → ACCEPTED / REJECTED / NEEDS_WORK`. Every move is an `agent.task` event in the same transaction as the row change, and every event is in the mission's trace.

**Human approval points** (`policy.py`):
- a person launches every mission (model route and budget);
- a person accepts the evidence bundle;
- a person reviews any node whose tools report a fail or error verdict (a found defect), and any node whose agent reports its evidence incomplete;
- any plan that would change design files needs approval (no Phase 2 tool does this yet).

Every other gate is a logged policy decision with its rule. Boundary nodes (measured silicon, foundry execution, fabrication release) get no task, only a `boundary.hard_stop` decision. Agents cannot approve anything: `decide()` accepts human actors only.

**Model gateway** (`gateway.py`): the default route is local, through Ollama (`qwen3.6:35b`). The hosted route (Claude through the Anthropic SDK) exists only when `AIMEM_ANTHROPIC_API_KEY` is set and a mission opts in with `--route hosted`. It needs `pip install -e 'platform[hosted]'`.

Every call is checked against hard token ceilings per task and per mission, plus a spend ceiling for the hosted route. A call that could cross one is never made: it is logged as `budget.limit` `limit_hit` + `run_halted`. The exact prompt and response go to the artifact store, and the call is one `agent.task` `llm_call` event with its model, template version, tokens, cost estimate, and hashes. Output is constrained to a JSON schema on both routes.

**Write scope** (`worktree.py`): an agent writes only through `worktree.write`, inside `var/worktrees/<mission>/<node>`. Absolute paths, `..`, symlinks, NUL bytes, and backslashes are refused before anything touches the disk, and each refusal is logged as a denied `policy_decision`. Tool runs read committed repository inputs through the Phase 1 adapters and are filed under the agent's tool call in the mission trace.

**Evidence bundle** (`evidence.bundle`): each gate with its runs by hash, the failing verdicts, the hard stops, and a `hold` decision. Its evidence class is the weakest of its gates, because classes never upgrade.

```bash
platform/.venv/bin/aimem-platform mission start t0-closure            # waits for a person to launch it
platform/.venv/bin/aimem-platform approvals                           # what is waiting for a decision
platform/.venv/bin/aimem-platform approve mission <id> approved --reason "..."
platform/.venv/bin/aimem-platform mission advance <id>                # or: mission worker
platform/.venv/bin/aimem-platform mission show <id>
platform/.venv/bin/aimem-platform approve task <task-id> approved --reason "..."   # plan or review
```

API: `POST /api/missions` (engineer), `GET /api/missions[/{id}]`, `GET /api/approvals`, and `POST /api/approvals` (approver; a reason is required to reject or send back).

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
| `AGENT_ROUTE` | `local` | Default model route for new missions (`local` or `hosted`) |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / `qwen3.6:35b` | Local route |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | none / `claude-opus-5` | Hosted route; enables it only for missions that opt in |
| `TASK_MAX_TOKENS` / `MISSION_MAX_TOKENS` / `MISSION_MAX_USD` | `60000` / `400000` / `5.0` | Hard ceilings, checked before every model call |

## Known limits (tracked for later phases)

- Anchors live in a local file. Phase 5 moves them to a signed transparency log (Sigstore), so an attacker with both database and host access cannot rewrite history and anchors together.
- Rate limits are in-process; Phase 5 moves them to a shared store.
- Appends are serialized by one advisory lock, which is ample for Phase 0 volumes. Batching and partitioning come with Phase 1 tool runs.
- The UI buffer keeps the latest 1,000 events per page and 5,000 queued; if the API is unreachable longer than that, drops are counted and shown, not silent.
- Agent tasks run one at a time in DAG order, and NEEDS_WORK ends a mission; a retry-from-this-node command, the validation-first RTL patch loop, and the live Agent operations view are the next Phase 2 increments.
