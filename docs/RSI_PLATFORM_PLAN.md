# AIMEM Design Studio: Self-Improving AI Chip Design Platform

**Plan date:** 22 September 2026
**Status:** Phase 0 built and verified on 22 September 2026 (see [Phase 0 status](#phase-0-status-2026-09-22)). Phase 1 built and executed the same day, with all three exit criteria met (see [Phase 1 status](#phase-1-status-2026-09-22)). Phases 2 to 6 are proposed.
**Extends:** `../AIMEM_X1_AI_DESIGN_PLATFORM_DEVELOPMENT_PLAN.md` (31 Aug 2026). That plan defines the product, evidence classes, and agent authority boundaries. This plan adds three things: a working backend and real agents, **recursive self-improvement (RSI)**, and **mandatory logging of every action and feature**.

---

## 1. What "recursive self-improvement" means here

RSI is easy to over-promise, so this plan defines it as three nested loops. Each loop can only be promoted by a verifier that the loop itself cannot edit.

| Loop | What improves | What judges improvement | Precedent |
|---|---|---|---|
| **L1: design loop** | The chip artifacts: RTL, constraints, flow parameters, floorplans | Deterministic tools: simulation, formal, synthesis, STA, and PPA from OpenROAD | AlphaEvolve's TPU Verilog rewrite; ORFS-agent; AutoTuner |
| **L2: agent loop** | The agents themselves: prompts, skills, tool policies, scaffold code, and retrieval memory | A frozen benchmark harness (public RTL suites plus internal AIMEM tasks) with a held-out split | Darwin Gödel Machine (SWE-bench 20% to 50% through self-edits); ACE-RTL; Verilog-Evolve |
| **L3: model loop** | Model weights, through LoRA fine-tunes on verified trajectories from L1 and L2 | The same frozen harness plus a regression suite | ChipNeMo-style domain adaptation |

The recursion: better agents (L2) produce better designs (L1). Verified design trajectories become training data (L3). Better models make better agents, and the cycle repeats. Every step is logged, scored, and reversible.

### Invariants that make RSI safe to run

1. **The grader is outside the write-scope of anything it grades.** Evaluator code, benchmark sets, the held-out split, and gate policies live in a separate, signed package that agents can read but never modify. This is the main defense against reward hacking.
2. **Candidates are versioned, not replacements.** Every agent version and design candidate goes into an archive with its parent, diff, and scores. Rollback means repointing a single `active` pointer.
3. **Held-out non-regression.** A candidate is promoted only if it beats its parent on the target metric and does not regress on the held-out split or the safety suite by more than a configured tolerance.
4. **Humans approve promotion.** Promotions that change agent code, policies, or model weights require human approval until a phase exit criterion relaxes this for a specific narrow class.
5. **Budgets are hard limits.** Each loop has token, dollar, CPU-hour, and wall-clock ceilings that are enforced by the runtime, not by the agent.
6. **Evidence classes never upgrade automatically.** This carries over from the existing contract: nothing an agent does can turn `modeled` into `executed`, or any class into `measured`.

---

## 2. What exists today (verified in the repo on 2026-09-22)

| Area | What exists | Evidence class / limitation |
|---|---|---|
| **Specs** | Versioned T0, T1, and X1 architecture contracts plus a JSON schema (`design/spec/`); `validate:spec` | Executed schema validation |
| **Models** | 15 deterministic TS models (`lib/`): T0, T1, X1, campaigns, reliability, interconnect physics, package connectors, floorplans, foundry readiness | Modeled; 15 `node:test` suites (about 60 tests) |
| **RTL** | 5 SystemVerilog modules (`rtl/`): T0 channel, top, SECDED-64, lane repair, sparse gather | Synthesizable; no simulation testbench |
| **Formal** | 2 property files; checked with bounded Yosys `sat` (32 cycles) through WebAssembly | Bounded only. No SymbiYosys, no unbounded proofs, no cover or vacuity checks |
| **Synthesis** | `verify:rtl` re-synthesizes with Yosys WASM and writes `evidence/rtl-synthesis.json` | Executed, generic |
| **Physical** | `verify:physical` maps to Sky130 HD (2,447 cells) | Executed tech-mapping only. OpenROAD-flow-scripts is cached, but place, CTS, route, DRC, and LVS have never run |
| **Performance** | Ramulator2 built locally; correlation over 4 traces | Executed |
| **Evidence** | `generate-evidence.mjs` produces a sha256 manifest | Hash only. No signatures, no per-run provenance |
| **UI** | Next/vinext app: 12 workspaces, a 3D X1 twin in three.js, and a user guide | Deployed to Vercel from GitHub `main` |
| **Agents** | `lib/agent-orchestration.ts` plus the orchestration contract: 8 open agents, 3 boundary stops, and an authority policy | **Simulated.** The "Agent operations" view is a `setInterval` replay. No LLM calls and no tool execution |
| **Logging** | `docs/OPS_LOG.md`, maintained by hand for deploys and pushes | **No runtime logging** of user actions, agent actions, or tool runs |
| **Backend** | None. There are no API routes, database, job queue, auth, or artifact store | n/a |

**Bottom line:** the platform has a strong specification, model, and visualization layer and a small, real open-EDA evidence pipeline. It has no execution backend, no real agents, no self-improvement, and no runtime logging. Everything in section 3 is net-new.

---

## 3. What will be built

### 3.1 Target architecture

```
                         ┌──────────────────────────── Browser (existing Next app, extended) ─────────────────────────┐
                         │ Workspaces · 3D twin · Live agent console · RSI lab · Activity log · Approvals inbox      │
                         └───────────────▲──────────────────────────────┬──────────────────────────────────────────────┘
                                         │ SSE/WebSocket (events)       │ REST (every call logged)
┌────────────────────────────────────────┴──────────────────────────────▼──────────────────────────────────────────────┐
│ Control plane API (Python · FastAPI)                                                                                 │
│  auth/RBAC · projects · runs · approvals · feature registry · ── AUDIT MIDDLEWARE (wraps every route) ──             │
└──────┬──────────────┬─────────────────┬──────────────────────┬───────────────────────┬──────────────────────────────┘
       │              │                 │                      │                       │
┌──────▼─────┐ ┌──────▼───────┐ ┌───────▼────────┐ ┌───────────▼──────────┐ ┌──────────▼──────────┐
│ Agent      │ │ Job runner   │ │ RSI engine     │ │ Evaluator (SEALED)   │ │ Audit/Event store   │
│ runtime    │ │ (queue +     │ │ L1 design evo  │ │ benchmarks, held-out │ │ Postgres append-    │
│ task FSM,  │ │ sandboxed    │ │ L2 agent archive│ │ split, gate policies │ │ only + hash chain   │
│ model      │ │ containers)  │ │ L3 fine-tune   │ │ read-only to agents  │ │ + OTel traces       │
│ gateway    │ │              │ │ pipeline       │ │                      │ │                     │
└──────┬─────┘ └──────┬───────┘ └───────┬────────┘ └───────────┬──────────┘ └──────────▲──────────┘
       │ typed tool calls only          │                      │                       │ every component emits
┌──────▼────────────────▼───────────────▼──────────────────────▼───────────────────────┴──────────┐
│ Tool adapters (containerized): Yosys · Verilator · cocotb · SymbiYosys · OpenROAD-flow-scripts · │
│ OpenSTA · KLayout/Magic/Netgen · Ramulator2 · (later) Elmer/openEMS/OpenRAM                     │
└──────────────────────────────────────────┬───────────────────────────────────────────────────────┘
                                           │
                               ┌───────────▼────────────┐
                               │ Artifact store (S3/     │  content-addressed; every artifact carries
                               │ MinIO) + Postgres SoR   │  the existing 12-field provenance contract
                               └────────────────────────┘
```

**Stack choice, made for delivery speed.** The 31 Aug plan's full stack (Temporal, NATS, OPA, Sigstore, vLLM) remains the target, but it is phased in rather than required on day one:

| Concern | Phase 0–2 (ship) | Phase 5–6 (harden) |
|---|---|---|
| API | FastAPI (Python fits the EDA tooling) | same |
| State and audit | PostgreSQL | same + WORM archive |
| Jobs | Postgres-backed queue (`procrastinate` or `arq`) + Docker | Temporal |
| Events to UI | Postgres `LISTEN/NOTIFY` → SSE | NATS JetStream |
| Policy | Python policy module with unit tests | OPA/Rego |
| Provenance | sha256 + hash-chained audit | in-toto + Sigstore |
| Models | Model gateway (LiteLLM) → Claude API for public/FOSS-lane work | + vLLM open-weight models for restricted lanes |
| Tracing | OpenTelemetry SDK → local collector | Grafana/Tempo/Loki |

> **Decision needed:** whether a hosted model (such as Claude) may be used for FOSS-lane work. The 31 Aug plan says never to depend on a hosted provider. This plan proposes hosted models **only** for public, non-restricted design data, behind a gateway that can switch to local vLLM per project. See §7.

### 3.2 Logging and audit: a cross-cutting requirement for every feature

This is required for all features. It is built in Phase 0, before any other feature, so nothing ships without it.

**Rule: no log, no action.** Every state-changing or tool-invoking code path goes through one audit wrapper. If the audit write fails, the action fails closed.

**Event envelope** (one row per event in `audit_events`, append-only):

| Field | Purpose |
|---|---|
| `event_id`, `ts` (UTC, µs) | Identity and ordering |
| `trace_id`, `span_id`, `parent_event_id` | Links a UI click → API → agent step → tool run → artifact |
| `actor_type` / `actor_id` / `actor_version` | human · agent · system · evaluator; the agent version is the archive ID |
| `feature` | Key from the **feature registry** (for example `rtl.synthesize`, `rsi.l2.promote`) |
| `action` | Verb: `requested`, `started`, `tool_call`, `llm_call`, `artifact_written`, `gate_evaluated`, `approved`, `rejected`, `promoted`, `rolled_back`, `failed`, … |
| `target` | Project, run, design revision, file, or agent version |
| `input_hash`, `output_hash` | Content hashes (payloads live in the artifact store, not the log) |
| `result` / `error` | Outcome and the full error text, never truncated |
| `cost` | Tokens in/out, model, $ estimate, CPU-s, wall-ms |
| `evidence_class` | executed · modeled · planned · restricted · measured |
| `policy_decision` | allow/deny + rule ID, for every gated action |
| `redaction` | Marks fields withheld for restricted-lane data |
| `prev_hash`, `hash` | Hash chain; tampering or deletion becomes detectable |

**What gets logged.** "Each and every action" is concretely these categories:

| Category | Examples |
|---|---|
| Human UI actions | Every button, view change, parameter edit, export, approval or rejection, and login/logout. The existing `page.tsx` handlers get a `track()` call. |
| API calls | Every route, through middleware: request, response status, latency, and actor |
| Agent steps | Every task-FSM transition, every LLM call (model, prompt template and version, token counts, prompt/response hashes; full text in the artifact store), and every tool call with arguments |
| Tool runs | Container image digest, command, exit code, stdout/stderr (stored as artifacts), and parsed metrics |
| Artifacts | Write, read by an agent, promote, and supersede |
| Gates and policy | Every evaluation, with inputs and the rule that fired |
| RSI events | Candidate proposed, diff, sandbox run, benchmark scores per task, held-out scores, promote/reject reason, active-pointer change, and rollback |
| System | Deploys, migrations, config and flag changes, budget-limit hits, crashes (full traceback) |

**Enforcement, so logging cannot silently drift:**
1. **Feature registry** (`features.yaml`). Every feature declares its ID, owner, and the event actions it must emit. The API refuses to register a route or tool adapter whose feature is unknown.
2. **Coverage test in CI.** It runs each feature's smoke test and asserts that every declared event was emitted. A missing event fails the build.
3. **Static check.** A lint rule flags tool-adapter or DB-write calls that are not wrapped in `audited()`.
4. **Chain verifier.** A nightly job recomputes the hash chain, and alerts and logs on any break.
5. **UI.** An **Activity** workspace offers a filterable timeline by feature, actor, run, or trace, with drill-down from any event to its full trace tree and artifacts. Every page shows "last 5 events for this object."
6. **Ops log continuity.** `docs/OPS_LOG.md` stays as the human-readable log of out-of-tree side effects (deploys, credential changes), per the standing rule. Automated deploy events also land in `audit_events`.

**Retention and privacy:** audit rows are kept indefinitely; raw LLM prompts and responses are kept 180 days by default (configurable); restricted-lane payloads are never written outside the enclave, and only their hashes and the redaction marker are logged.

---

## 4. Phases

Every phase has testable exit criteria. Durations assume 2–3 engineers plus agent assistance and are estimates. Each phase is additive: the existing app, models, tests, and evidence scripts keep working throughout.

### Phase 0 status (2026-09-22)

**Built:** [`platform/`](../platform/README.md) (FastAPI, SQLAlchemy, PostgreSQL 16, Alembic, OpenTelemetry), the Studio's browser audit client and Activity workspace, the UI smoke test, and a CI workflow.

| Exit criterion | Evidence |
| --- | --- |
| 100% of registered features pass event coverage in CI | `platform/tests/test_event_coverage.py`: 27 features, one scenario each, every declared action observed; the coverage report shows no undeclared actions |
| Editing any audit row is detected | `platform/tests/test_tamper.py`: edited row, edit with forged rehash, middle delete, and tail cut (caught by the external anchor) are all detected; the API logs `break_detected` |
| Every existing UI action emits an event | `scripts/ui-audit-smoke.mjs` against the real Studio in Chrome: 493/493 controls across 15 views logged, all 21 declared UI actions observed, every page event delivered (0 rejected), chain verified afterwards |
| Existing tests, lint, and builds unchanged and green | 72 node tests (63 existing + 9 new), ESLint, `tsc`, `next build`, and `vinext build` pass; 74 platform tests pass |

**Deviations from the plan, and why:**
- PostgreSQL runs on the existing local Homebrew server with dedicated `aimem_platform*` roles and databases instead of Docker Compose, because the Docker daemon was not running. CI uses a Postgres 16 service container.
- Chain anchors are a local append-only file; signed anchors (Sigstore) remain Phase 5.
- The UI smoke test uses `playwright-core` with the installed Chrome instead of a bundled browser download.
- The "static check" is an AST test (`test_static_audit_lint.py`) plus a runtime guard on every database session, which catches more than a lint rule could.

### Phase 0: Audit backbone and backend skeleton (≈2–3 weeks)

**Build**
- `platform/` Python service: FastAPI, Postgres (Docker Compose locally), Alembic migrations.
- `audit_events` table, `audited()` wrapper and middleware, hash chain, chain verifier, OTel SDK.
- Feature registry plus the CI event-coverage test.
- Auth (single-org, email-based to start) and RBAC roles: viewer, engineer, approver, admin.
- Content-addressed artifact store (local disk, then MinIO/S3).
- Next app: `track()` client helper on existing handlers; **Activity** workspace (read-only timeline).

**Exit criteria**
- 100% of registered features pass event coverage in CI.
- Tamper test: editing any audit row is detected by the verifier.
- Every existing UI action in `page.tsx` emits an event (checked by a Playwright smoke test).
- Existing `npm test`, lint, and build are unchanged and green.

### Phase 1 status (2026-09-22)

**Built:** the run system in `platform/aimem_platform/runs/` (pinned toolchains, Docker sandbox, five adapters, audited lifecycle, reconstruction, reproduction), new testbenches in `verification/cocotb/`, SymbiYosys jobs in `formal/`, the sky130hd flow config in `design/physical/orfs/`, the Runs workspace, live evidence in the Digital and Physical views, and a CI job that executes every adapter on a second machine.

| Exit criterion | Evidence |
| --- | --- |
| `aimem_t0_channel` reaches a DRC/LVS-clean sky130 GDS with OpenSTA timing, labeled `executed (public PDK)` | **Met.** Run `6f3d41e1` (physical.orfs, sandboxed, 6.4 min): **DRC 0 violations, LVS match**, GDS written; OpenSTA: fmax **169.5 MHz**, setup WNS −4.65 ns / TNS −630 ns at the 1.25 ns (800 MHz) contract clock, hold met; 4,883 cells, 95,861 µm² die. Evidence class `executed`, limitation "public PDK (sky130hd) proxy; not signoff and not the production node" |
| Same inputs reproduce the same output hashes on two machines | **Met.** Same machine (Apple M4 Max; the amd64 image under Rosetta): all five adapters re-executed from their audit records with **identical** normalized outputs. Second machine (CI job `eda-runs`, run 35805452190, GitHub ubuntu-24.04, native x86-64): the same five specs (equal spec hashes) produced **identical** output manifests, 8/8 files. The physical flow's GDS matches with only BGNLIB/BGNSTR dates zeroed, and its DEF and netlist match byte for byte. The JSON outputs were compared whole: the normalizer dropped no keys from them. Compared with `aimem-platform compare-manifests` and recorded in the ops log. Two machines, one sample each |
| Every run is fully reconstructable from `audit_events` alone | **Met.** `aimem-platform reconstruct` / the Runs workspace rebuild each run from its `run.lifecycle` events: all 7 checks (spec, spec hash, inputs, input availability, status, outputs, output manifest hash) consistent for every executed run, locally and in CI; a test edits a `runs` row directly and the rebuild reports the disagreement |

**What the tools found (executed evidence, not models):**
- `aimem_t0_channel` reports `ecc_corrected` / `ecc_uncorrectable` in the cycle *before* `rsp_valid` and clears them when `rsp_valid` rises, so a consumer sampling response fields never sees ECC status. Found by simulation (`ecc_status_is_valid_with_the_response`, 20/21 tests pass) and independently by formal (`channel_protocol.sby` FAIL with a counterexample). Not fixed: RTL changes need the owner's approval.
- SECDED is proven for **any** 64-bit word: every single-bit fault corrected, every double-bit fault detected (SymbiYosys prove + cover). The channel's liveness, refresh priority, and response scoreboard are proven unbounded (k-induction).
- Verilator lint: 0 errors, 11 warnings (width truncations in lane repair, `active_write` unused because the channel has no storage yet).
- Sky130 reaches 169.5 MHz; the 800 MHz contract belongs to the advanced node.

**Deviations and gaps:**
- cocotb runs on Icarus 14 instead of Verilator (no C++ build under x86 emulation); Verilator is used for lint.
- ORFS's `kepler-formal` equivalence check crashes under Rosetta (SIGILL), so `LEC_CHECK=0` on every machine; netlist equivalence checking is open.
- Icarus 14-devel with cocotb 2.1-dev segfaults at shutdown if a test ends with a pending write; testbenches settle one step after each test (`verification/cocotb/tb.py`).
- Ramulator2 adapter deferred: the existing build is macOS-only and a Linux build fetches dependencies at configure time, which sandboxed runs cannot do.
- A real defect was caught in production use: the physical adapter first reported evidence class `executed (public PDK)`, which the artifacts table rejects, leaving run `9c4d67e8` stuck in `running`. Fixed (qualifiers moved to provenance `limitations`; any finalize failure now ends a run as `errored`), regression-tested, and the stuck run recorded as `errored` through the audited path.

### Phase 1: Real tool execution (≈4–6 weeks)

**Build**
- Containerized adapters with typed inputs and outputs: Yosys, **Verilator** + **cocotb** (new simulation testbenches for all 5 RTL modules), **SymbiYosys** (replacing the bounded `sat` with BMC + prove + cover and vacuity checks), and **OpenROAD-flow-scripts on sky130hd** (full floorplan → place → CTS → route → DRC/LVS for `aimem_t0_channel`), plus Ramulator2.
- Job runner: sandboxed containers with no host credentials, CPU/mem/time limits, and egress denied.
- Each run writes an artifact manifest with the existing 12-field provenance contract.
- UI: a "Run" button per evidence item, a live log stream, and run history. Evidence views read from the DB instead of static JSON (static JSON stays as a fallback).

**Exit criteria**
- `aimem_t0_channel` reaches a DRC/LVS-clean sky130 GDS, with timing reported by OpenSTA. The evidence class is `executed (public PDK)` and is never labeled signoff.
- The same inputs reproduce the same output hashes on two machines.
- Every run is fully reconstructable from `audit_events` alone.

### Phase 2: Real agents on the existing 8-node DAG (≈4–6 weeks)

**Build**
- Agent runtime implementing the 31 Aug task FSM: `CREATED → CONTEXT_VALIDATED → PLAN_PROPOSED → APPROVED_IF_REQUIRED → RUNNING_TOOLS → EVIDENCE_COLLECTED → SELF_CHECKED → REVIEW_REQUIRED → ACCEPTED/REJECTED/NEEDS_WORK`.
- Model gateway (LiteLLM), with per-project model routing and budgets.
- Agents for the 8 open nodes (Contract, Architecture, Performance, RTL, Formal, Physical, Multiphysics-stub, Evidence). They use only typed tool adapters, never a raw shell.
- Validation-first RTL loop (the MAGE/ChipCraftBrain pattern): testbench agent → RTL agent → judge → debug, with multiple candidates.
- Approvals inbox; boundary nodes (silicon, foundry, release) remain hard stops.
- The "Agent operations" view switches from `setInterval` replay to the live event stream. Replay stays available, labeled as replay.

**Exit criteria**
- A T0 mission runs end to end on real tools and produces an evidence bundle, with a human approving at the defined points.
- Agents cannot write outside their patch worktree (proved by denial tests, and the denials are logged).
- Every LLM call and tool call in the mission is visible in the Activity trace tree.

### Phase 3: Sealed evaluator and L1 design self-improvement (≈6–8 weeks)

**Build**
- **Sealed evaluator package**: a signed, versioned, read-only mount.
  - Public suites: VerilogEval v2, RTLLM v2, and a ChipBench subset (licenses to be checked).
  - An internal AIMEM suite: about 50 tasks built from this repo's RTL, formal properties, and specs (for example "add a parity check to lane repair without breaking the existing properties").
  - Train, validation, and **held-out** splits. The held-out split is never shown to agents.
  - PPA scorer that reads OpenROAD METRICS2.1.
- **L1 engine** (the AlphaEvolve pattern): a population of RTL and flow-config candidates → mutate (LLM diff proposals plus AutoTuner-style parameter search) → verify (sim + formal + equivalence) → score PPA → keep the Pareto front.
- **RSI Lab** workspace: population view, Pareto plot, candidate diff viewer, and lineage tree.

**Exit criteria**
- L1 finds at least one candidate for a T0 block that is formally equivalent (or passes the full regression) **and** improves area or timing over the hand-written baseline on sky130. It is promoted through human approval.
- Reward-hacking probe: a planted "edit the testbench" shortcut is blocked and logged as a policy denial.

### Phase 4: L2 agent self-improvement, with a DGM-style archive (≈6–8 weeks)

**Build**
- **Agent archive**: each agent version is a bundle of prompts, skills, tool policies, and scaffold code, identified by a content hash with parent links.
- **Meta-agent**: selects a parent from the archive (weighted by score and novelty), proposes a self-edit, runs it in a sandbox against the train and validation splits, and archives it with scores.
- **Promotion gate**: validation improvement, no held-out regression beyond tolerance, safety suite passing, and human approval. Promotion flips the `active` pointer; rollback flips it back. Both are logged.
- **Skill and memory library**: verified fixes and lessons stored as retrievable skills (the ACE-RTL/Verilog-Evolve pattern). Each skill records the task and evidence that produced it.

**Exit criteria**
- Across at least 20 generations, the active agent's held-out pass rate on the internal suite improves measurably over the Phase 2 baseline, with the full lineage reconstructable from the log.
- A one-click rollback to any prior agent version is proven in a test.
- No promoted version touched the evaluator (verified by mount-permission audit events).

### Phase 5: L3 model loop and closing the recursion (≈6–10 weeks)

**Build**
- A trajectory dataset built from verified, accepted L1 and L2 runs only. Its provenance comes from `audit_events`, and restricted-lane data is excluded.
- LoRA fine-tuning pipeline on an open-weight code model, served by vLLM. The fine-tuned model becomes a gateway option and competes in the L2 archive like any other variant.
- Scheduled RSI cycles: L2 runs weekly and L1 runs on every accepted design change, each with budget ceilings.
- Harden the ship-stack toward Temporal, OPA/Rego, and in-toto/Sigstore.

**Exit criteria**
- A fine-tuned model beats its base on the held-out suite with no safety-suite regression, or the result is recorded as a negative finding. Either outcome is logged.
- One full recursion is demonstrated and traced: L3 model → L2 agent promoted → L1 design improvement accepted.

### Phase 6: Scale to T1/X1, multiphysics, and multi-user (≈3–6 months)

- Multiphysics adapters: Elmer (thermal), openEMS/scikit-rf (link SI), Gmsh. The 3D twin overlays bind to executed results instead of modeled ones.
- T1 and X1 missions run through the same agents and loops.
- Multi-tenant orgs, SSO, and two-person approval for release-class actions.
- A foundry-enclave lane (a self-hosted deployment with local models only) that keeps the same audit schema with redaction.

**Exit criteria:** defined at Phase 5 review, based on the T0 results.

### Continuous across all phases
- Every feature is registered and event-covered before merge.
- `OPS_LOG.md` gets an entry for every deploy and out-of-tree side effect.
- Tests, lint, and build stay green; changes are additive; push to `main` after each tested build.

---

## 5. Feature × logging matrix (initial registry)

| Feature ID | Phase | Required events |
|---|---|---|
| `ui.view.change`, `ui.param.edit`, `ui.export` | 0 | requested |
| `auth.session` | 0 | login, logout, failed |
| `audit.verify_chain` | 0 | started, result, break_detected |
| `artifact.write` / `artifact.read` | 0 | artifact_written / artifact_read |
| `tool.<yosys\|verilator\|cocotb\|sby\|orfs\|ramulator>.run` | 1 | requested, started, tool_call, artifact_written, finished/failed |
| `evidence.bundle` | 1 | gate_evaluated, artifact_written |
| `agent.task` | 2 | every FSM transition, llm_call, tool_call, policy_decision |
| `approval.decide` | 2 | approved / rejected (with approver and reason) |
| `rsi.l1.generation` | 3 | candidate_proposed, verified, scored, pareto_updated, promoted/rejected |
| `eval.run` | 3 | started, task_scored (per task), finished |
| `rsi.l2.self_edit` | 4 | proposed, sandbox_run, scored, archived |
| `rsi.l2.promote` / `rsi.l2.rollback` | 4 | policy_decision, approved, promoted / rolled_back |
| `rsi.l3.finetune` | 5 | dataset_built, training_started, checkpoint_written, evaluated, promoted/rejected |
| `budget.limit` | 2+ | limit_hit, run_halted |
| `system.deploy` / `system.migrate` / `system.config` | 0+ | started, finished/failed, rollback_ref |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Reward hacking (agents gaming tests) | Sealed evaluator, held-out split, planted-shortcut probes, and human promotion |
| Open-PDK results mistaken for signoff | The existing evidence-class policy; `executed (public PDK)` label; UI badges |
| Runaway cost from RSI loops | Hard runtime budgets, logged `budget.limit` events, and per-loop dashboards |
| Log volume | Payloads in the artifact store and only hashes in rows; partition `audit_events` by month |
| Benchmark contamination (public suites seen in pretraining) | Internal AIMEM suite as the primary metric; public suites are secondary |
| EDA compute exceeds cheap hosting | Run the job runner on a dedicated worker host; the control plane can live on Railway or Vercel |
| IP leakage to hosted models | Per-project model routing; restricted lanes get local models only; enforced by policy and logged |

---

## 7. Decisions needed before Phase 0

1. **Model provider for FOSS-lane work:** hosted (Claude through the gateway) now and local vLLM later, or local-only from the start. This changes the Phase 2 hardware needs.
2. **Where the backend runs:** local Docker Compose first, or deploy the control plane to Railway from Phase 0 (the EDA job runner needs its own worker machine either way).
3. **Language for the control plane:** Python/FastAPI (recommended, since the EDA ecosystem is Python) or TypeScript to match the existing app.
4. **Repo layout:** add `platform/` inside `t0-design-studio` (one repo, simplest), or create a sibling repo.

---

## 8. Sources

- AlphaEvolve (Google DeepMind): https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/
- Darwin Gödel Machine (ICLR 2026): https://arxiv.org/abs/2505.22954 · https://github.com/jennyzzt/dgm
- Verilog-Evolve: https://arxiv.org/pdf/2605.26498
- Multi-Agent Self-Evolved ABC: https://arxiv.org/pdf/2604.15082
- ACE-RTL: https://arxiv.org/pdf/2602.10218
- ChipCraftBrain (validation-first multi-agent RTL): https://arxiv.org/pdf/2604.19856
- Veri-Sure (contract-aware + formal): https://arxiv.org/pdf/2601.19747
- ChipBench: https://arxiv.org/pdf/2601.21448
- Revisiting VerilogEval: https://dl.acm.org/doi/10.1145/3718088
- OpenROAD AutoTuner: https://openroad-flow-scripts.readthedocs.io/en/latest/user/InstructionsForAutoTuner.html
- Automated QoR improvement in OpenROAD with coding agents: https://arxiv.org/html/2601.06268v2
- AgenticPD: https://arxiv.org/pdf/2607.04758
- Multi-objective AutoTuner (Antmicro): https://antmicro.com/blog/2026/01/multi-objective-optimization-for-autotuner-in-openroad
