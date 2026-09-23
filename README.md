# AIMEM Design Studio

An evidence-gated chip design workbench for the AIMEM memory-system program: a T0 pathfinder channel with executed RTL, formal, and public-PDK mapping evidence, a T1 scale-up planner, a production X1 eight-stack system planner, and an interactive 3D design twin of the complete 2.5D package.

Every action in the Studio and its control plane is written to an append-only, hash-chained audit log (see [Audit backbone](#audit-backbone-phase-0)).

Every number in the app carries an evidence class: **executed** (reproduced locally from versioned sources), **modeled** (deterministic planning proxy), **planned** (artifact defined but not produced), or **restricted** (requires a qualified foundry, PDK, or silicon). Production release stays on HOLD until measured evidence and named human approvals exist.

## Workspaces

| View | Purpose |
| --- | --- |
| 3D design twin | Orbit, explode, and select every component of the X1 package: BGA, substrate, stiffener, decoupling capacitors, C4 bumps, silicon interposer with TSVs and RDL route bundles, microbumps, accelerator floorplan, eight 16-high memory stacks with base-die floorplans, TSV columns, hybrid bonds, and individual DRAM tiers. Six data overlays and a 12-step build sequence. |
| Silicon macro | Photoreal, real-time zoom into the accelerator die, from the whole package down to single transistors: gold power mesh, copper routing mazes, standard cells, FinFETs, TSVs, backside-power nano-TSVs, and deep-trench capacitors, with animated data pulses and a cross-section view. Illustrative: procedural geometry, not GDS. |
| Readiness · Architecture · Workloads · Correlation · Experiment · Gates | T0 pathfinder: capacity, bandwidth, power, and reliability models, Ramulator2 correlation, analytical sweeps, and the evidence gate ledger. |
| RTL + verification | Elaborated `aimem_t0_channel` and SECDED datapath, bounded formal properties, and synthesis evidence. |
| Physical implementation | Sky130 HD technology mapping (2,447 cells), timing contract, and the OpenROAD implementation plan through DRC/LVS. |
| T1 scale-up · Foundry readiness | Derived T1 engineering-sample architecture, digital and physical proxies, and the foundry-entry handoff contract. |
| Production X1 | Eight-stack, 16-high, 8,192-lane production target with performance states and routing pressure. |
| Agent operations | Deterministic replay of the AI agent mission control plane. |
| User guide | Role-aware end-to-end guide embedded in the app. |
| Runs | Real tool execution (Phase 1): pinned, sandboxed runs of Verilator lint, cocotb simulation, SymbiYosys formal, and the OpenROAD sky130 flow through DRC/LVS, with live logs, content-addressed outputs, layout images, and a one-click rebuild of any run from the audit log. |
| Activity | The audit log: every click, edit, sign-in, API request, CLI command, and migration, with trace trees, chain verification, and live feature coverage. |

## 3D design twin

The twin is built with three.js and binds live to the X1 planning model.

- **Layout.** Eight memory stacks sit two per accelerator edge so every base-die PHY faces a dedicated accelerator memory PHY across a short interposer RDL bundle. Placement is tested for adjacency and non-overlap.
- **Connector chain.** Fourteen real-life connector levels from system board to top DRAM tier, with public HBM-class reference pitches: BGA balls, substrate vias, C4 bumps, interposer TSVs, RDL bundles, accelerator and base-die microbumps, base-die TSVs, Cu–Cu hybrid bonds, DRAM tier TSVs, die-side capacitors, stiffener ring, underfill, and heat-spreader lid. Eleven are rendered; the three that would occlude the scene are listed but not drawn.
- **Floorplans.** Base-die blocks are placed from the versioned 144 mm² X1 area budget and tested against it. The accelerator shows compute tiles, a shared SRAM strip, eight edge PHYs, an I/O cell ring, and a seal ring; the base die adds SKY130-ordered metal straps, vias, cell rows, and a clock H-tree.
- **Labels.** Every component has a clickable name label. `Labels` cycles All / Key / Off; detail and fine labels reveal as you zoom in, and per-tier labels expand in the exploded view.
- **Full screen.** A toolbar button opens the model full screen (Esc or the same button exits). The toolbar, overlay bar, labels, and selection panel stay available in full screen.
- **Overlays.** The six data overlays are multi-select: enable any combination, or press `All overlays` to composite all six at once. Composited color is the mean of the active overlays, so read a single overlay when you need exact per-part mapping.
- **Viewport.** The 3D scene renders on a dark gradient backdrop. The dies are pale silicon tones, so a light ground left the model washed out against it; on the dark ground the model separates by roughly 147 luminance points instead of 26.
- **Scale.** Plan view is 1 scene unit ≈ 4.9 mm. Vertical scale is exaggerated about 20× so tiers, bonds, and bumps remain selectable. Geometry is reference-informed and conceptual, not GDS or a released bump, ball, TSV, or bond map.

## Silicon macro view

A macro-photography view of the accelerator die that zooms continuously across five orders of magnitude, from the 150 mm package view to a 1 µm field of fins and gates. The die outline, compute-tile array, shared SRAM strip, and eight memory PHYs follow the planned accelerator floorplan (`ACCELERATOR_FLOORPLAN`, `acceleratorPhyAnchor`). Everything inside them is procedurally generated from a deterministic hash (`lib/silicon-macro.ts`), so it is **illustrative**, never layout, GDS, or PDK data, and the view says so on screen and in its evidence export.

- **Five detail levels, streamed.** Global metal (the whole die, built once), semi-global metal (systolic buses, TSVs, microbumps), intermediate routing, local interconnect M0–M3 over standard-cell rows, and front-end devices (fins, gates, raised source/drain epitaxy, contacts, buried power rails, nano-TSVs to a backside power network, deep-trench capacitors). Levels 1–4 are square chunks generated around the orbit target within a 5 ms-per-frame budget, cached, and evicted when out of range. Every primitive is placed from global coordinates, so chunks meet without seams and regenerate identically.
- **Rendering.** Primitives are unit boxes and cylinders scaled per instance from one interleaved buffer (offset, size, tint, glow path). One draw call per material per chunk, chunk-relative coordinates for precision at nanometre scale, and per-chunk frustum culling. Lighting is image-based from a procedural HDR studio (light tent, softboxes, ring light) prefiltered with PMREM, plus a key light and a coaxial headlight for cross-sections. The pipeline is HDR with 4× MSAA, then bloom on the glowing pathways, ACES tone mapping, and a vignette/grain finish.
- **Extreme zoom without clipping.** Smooth zoom-to-cursor, damped orbit and pan, and van Wijk–Nuij fly paths for the zoom ladder (Package → Die → Tile → Tensor PE → Cells → Transistors). Near and far planes scale with distance. As you zoom, the orbit target descends through the stack and a delayering crater removes every layer above the focus layer around the line of sight, with terraced walls that show each layer passed. Crater floors sit in true gaps of the layer stack (a test enforces this), so no layer is left as a sliver.
- **Cross-section.** A vertical cut through the target, faced from the cleared side. Solid caps are generated for every cut primitive, and the plane snaps onto a column of vertical conductors (nano-TSVs or power rails at transistor scale, the TSV column at tile scale) so the deep structures show whole.
- **Performance.** Measured on an Apple M4 Max in headless Chrome at 1600 × 1000: a steady 60 fps (p95 frame 16.8 ms) at every rung and in both cross-sections; with vsync off, 440–600 fps at 1× pixel ratio and 160–200 fps at 2× (Retina). Adaptive resolution trades pixels for frame rate from the median frame time, and a software-GL fallback (SwiftShader) runs at reduced resolution without MSAA.

Code: `lib/silicon-macro.ts` (floorplan, stack, generators, crater, fly paths, section caps; tested in `tests/silicon-macro.test.ts`), `app/components/silicon/` (engine, materials and shader patches, die textures), and `app/components/SiliconMacroView.tsx` (controls and HUD).

## Getting started

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

| Command | What it does |
| --- | --- |
| `npm test` | Runs the deterministic model tests under `tests/` (node:test, no build step). |
| `npm run lint` | ESLint over the app and libraries. |
| `npm run build` | Production build with vinext. |
| `npm run validate:spec` | Validates `design/spec/*.json` against its schema. |
| `npm run verify:rtl` | Re-synthesizes the T0 RTL with Yosys (WebAssembly) and regenerates RTL evidence. |
| `npm run verify:physical` | Maps the T0 channel to the public Sky130 HD library and regenerates physical evidence. |
| `npm run bootstrap:ramulator` · `npm run correlate:ramulator` | Fetches Ramulator2 and regenerates the correlation evidence. |
| `npm run evidence` | Full evidence pipeline: spec validation, tests, RTL, physical, correlation, and evidence summary. |
| `npm run platform:dev` · `npm run platform:test` · `npm run platform:migrate` | Run, test, and migrate the audit backbone ([platform/README.md](platform/README.md)). |
| `npm run smoke:ui-audit` | Clicks every control in every view of a running Studio and proves each one is logged and delivered. |

## Audit backbone (Phase 0)

The platform in [`platform/`](platform/README.md) (Python, FastAPI, PostgreSQL) is the first phase of the self-improving design platform in [`docs/RSI_PLATFORM_PLAN.md`](docs/RSI_PLATFORM_PLAN.md). It enforces **no log, no action**:

- Every browser interaction is captured by page-wide listeners and shipped to the API; every API request, CLI command, migration, and service start/stop is logged server-side.
- Rows are append-only (privileges and triggers) and hash-chained; verification recomputes every hash and checks external anchors.
- `platform/features.yaml` defines the complete vocabulary. CI fails if a registered feature never emits a declared action, and the browser smoke test fails if any control in any view is not logged.

```bash
bash platform/scripts/setup-local-db.sh && npm run platform:migrate
platform/.venv/bin/aimem-platform create-user --email you@example.com --role admin
npm run platform:dev    # API on :8100; open the Activity tab in the Studio
```

Deployed without an API, the Studio keeps events in the page and labels them local-only.

## Real tool execution (Phase 1)

The platform runs the EDA tools itself, in a sandbox, from pinned toolchains (`openroad/orfs` by digest and the YosysHQ OSS CAD Suite by SHA-256). Each run's spec hash covers the image, toolchains, command, environment, and every input's content hash; its outputs are stored by hash; and it can be rebuilt from the audit log alone and re-executed to compare outputs. See [platform/README.md](platform/README.md#tool-runs-phase-1).

```bash
platform/.venv/bin/aimem-platform toolchain install   # requires Docker
npm run platform:worker                                # executes runs queued from the Runs tab
```

## Deployment

Two build paths share the same source:

| Target | Command | Notes |
| --- | --- | --- |
| Vercel | `next build` (set in `vercel.json`) | Standard Next.js output in `.next/`; Tailwind runs through `postcss.config.mjs`. Import the GitHub repo in Vercel with the repository root as the project root and no overrides. |
| Cloudflare Workers / Sites | `npm run build` (`vinext build`) | Vite + vinext output in `dist/` with the Cloudflare worker entry from `vite.config.ts`. |

## Repository layout

```
app/                 Next-style app: page.tsx (all views), components/Chip3DExplorer.tsx (3D twin), components/SiliconMacroView.tsx + components/silicon/ (silicon macro view), globals.css
lib/                 Deterministic models: t0/t1/x1, campaigns, reliability, physics, package connectors, floorplans
tests/               node:test suites for every model in lib/
design/spec/         Versioned T0, T1, and X1 architecture contracts and schema
design/physical/     SDC timing contract and OpenROAD / T1 handoff contracts
design/digital/      Verification contract
design/agents/       Agent orchestration contract
rtl/                 Synthesizable T0 channel and SECDED sources
formal/              Bounded formal properties
evidence/            Generated evidence JSON (RTL, physical, correlation, summary)
scripts/ · tools/    Evidence generators, Yosys and Sky130 bootstrap, Ramulator2 correlation
platform/            Audit backbone: FastAPI service, migrations, feature registry, tests
docs/OPS_LOG.md      Log of actions with side effects outside the working tree
docs/RSI_PLATFORM_PLAN.md  Phased plan for the self-improving platform
```

## Evidence policy

No proprietary PDK, IP, package, or signoff data is bundled or exported. Open references (OpenTitan Earl Grey organization, SKY130 layer conventions, public HBM-class packaging pitches) guide visible organization only. Foundry signoff, assembly, silicon test, and the release decision remain restricted until qualified evidence and human approval exist.
