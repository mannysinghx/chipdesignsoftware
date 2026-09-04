# AIMEM Design Studio

An evidence-gated chip design workbench for the AIMEM memory-system program: a T0 pathfinder channel with executed RTL, formal, and public-PDK mapping evidence, a T1 scale-up planner, a production X1 eight-stack system planner, and an interactive 3D design twin of the complete 2.5D package.

Every number in the app carries an evidence class: **executed** (reproduced locally from versioned sources), **modeled** (deterministic planning proxy), **planned** (artifact defined but not produced), or **restricted** (requires a qualified foundry, PDK, or silicon). Production release stays on HOLD until measured evidence and named human approvals exist.

## Workspaces

| View | Purpose |
| --- | --- |
| 3D design twin | Orbit, explode, and select every component of the X1 package: BGA, substrate, stiffener, decoupling capacitors, C4 bumps, silicon interposer with TSVs and RDL route bundles, microbumps, accelerator floorplan, eight 16-high memory stacks with base-die floorplans, TSV columns, hybrid bonds, and individual DRAM tiers. Six data overlays and a 12-step build sequence. |
| Readiness · Architecture · Workloads · Correlation · Experiment · Gates | T0 pathfinder: capacity, bandwidth, power, and reliability models, Ramulator2 correlation, analytical sweeps, and the evidence gate ledger. |
| RTL + verification | Elaborated `aimem_t0_channel` and SECDED datapath, bounded formal properties, and synthesis evidence. |
| Physical implementation | Sky130 HD technology mapping (2,447 cells), timing contract, and the OpenROAD implementation plan through DRC/LVS. |
| T1 scale-up · Foundry readiness | Derived T1 engineering-sample architecture, digital and physical proxies, and the foundry-entry handoff contract. |
| Production X1 | Eight-stack, 16-high, 8,192-lane production target with performance states and routing pressure. |
| Agent operations | Deterministic replay of the AI agent mission control plane. |
| User guide | Role-aware end-to-end guide embedded in the app. |

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

## Deployment

Two build paths share the same source:

| Target | Command | Notes |
| --- | --- | --- |
| Vercel | `next build` (set in `vercel.json`) | Standard Next.js output in `.next/`; Tailwind runs through `postcss.config.mjs`. Import the GitHub repo in Vercel with the repository root as the project root and no overrides. |
| Cloudflare Workers / Sites | `npm run build` (`vinext build`) | Vite + vinext output in `dist/` with the Cloudflare worker entry from `vite.config.ts`. |

## Repository layout

```
app/                 Next-style app: page.tsx (all views), components/Chip3DExplorer.tsx (3D twin), globals.css
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
docs/OPS_LOG.md      Log of actions with side effects outside the working tree
```

## Evidence policy

No proprietary PDK, IP, package, or signoff data is bundled or exported. Open references (OpenTitan Earl Grey organization, SKY130 layer conventions, public HBM-class packaging pitches) guide visible organization only. Foundry signoff, assembly, silicon test, and the release decision remain restricted until qualified evidence and human approval exist.
