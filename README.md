# AIMEM Design Studio

An evidence-gated chip design workbench for the AIMEM memory-system program: a T0 pathfinder channel with executed RTL, formal, and public-PDK mapping evidence, a T1 scale-up planner, a production X1 eight-stack system planner, and an interactive 3D design twin of the complete 2.5D package.

Every action in the Studio and its control plane is written to an append-only, hash-chained audit log (see [Audit backbone](#audit-backbone-phase-0)).

Every number in the app carries an evidence class: **executed** (reproduced locally from versioned sources), **modeled** (deterministic planning proxy), **planned** (artifact defined but not produced), or **restricted** (requires a qualified foundry, PDK, or silicon). Production release stays on HOLD until measured evidence and named human approvals exist.

## Workspaces

| View | Purpose |
| --- | --- |
| 3D design twin | Orbit, explode, and select every component of the X1 package: BGA, substrate, stiffener, decoupling capacitors, C4 bumps, silicon interposer with TSVs and RDL route bundles, microbumps, accelerator floorplan, eight 16-high memory stacks with base-die floorplans, TSV columns, hybrid bonds, and individual DRAM tiers. Six data overlays and a 12-step build sequence. |
| Silicon macro | Photoreal, real-time zoom into the accelerator die, from the whole package down to single transistors: gold power mesh, copper routing, standard cells, FinFETs, TSVs, backside-power nano-TSVs, and deep-trench capacitors, with a cross-section view. Every interconnect belongs to a net that joins components through vias on every layer, from the transistors to the bumps and across the interposer to the HBM stacks; pulses follow the nets to show data, power (VDD/VSS), and clock flowing. Click any part to trace its whole net and read what it does, what it connects, and how it is made. The chip turns a full 360°, underneath included. Illustrative: procedural geometry, not GDS. |
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
- **Rendering.** Primitives are unit boxes and cylinders scaled per instance from one interleaved buffer (offset, size, tint, glow path). One draw call per material per chunk, chunk-relative coordinates for precision at nanometre scale, and per-chunk frustum culling. Lighting is image-based from a procedural HDR studio (light tent, softboxes, ring light, a floor bounce and horizon band for undersides and cut faces) prefiltered with PMREM, plus a low key light and a faint coaxial headlight for cross-sections only. The pipeline is HDR with 4× MSAA, then bloom on the glowing pathways, ACES tone mapping, and a vignette/grain finish.
- **Glare control.** Flat metal seen from above mirrors whatever is overhead, so the overhead softbox is dim and falls off from its centre, metal roughness is moderate, exposure is 1.0, and bloom starts above the brightest reflections (only data pulses cross it). Measured at 14 fixed poses (die to transistors, four azimuths and overhead at the Tensor PE and routing zooms), the share of near-white pixels fell from 13.8 % on average (53 % looking straight down at a PE) to 1.3 % (1.2 %), about 1 % of which is constant page chrome.
- **Actual interconnects, layer to layer.** Every wire belongs to a net, and every net is drawn whole, with a via wherever it changes layer:
  - *Cells.* Each standard cell type has a fixed layout (`cellLayout`), shared by the transistor and wiring levels so they always meet. Input pins on M1 drop through V0 and M0 onto gate contacts. The output pin joins the NMOS and PMOS drains through a merged contact, M0, and V0. Source contacts reach the supply rails and, through VBPR vias, the buried power rails.
  - *Local nets.* A per-row-block router joins each output to the inputs it drives: M2 within a row (V1 at each pin), M2 → V2 → M3 → V2 → M2 between rows. DFF clock pins take the block's clock buffer. M3 tracks come in four classes (row-pair nets, drops from above, power ladders) so no two nets share one.
  - *Intermediate routes (Mx1–Mx3).* Each route is a net with one driver. An Mx2 or Mx3 route starts on a track centre of the layer below, joining a route there through Vx1/Vx2 when one passes. Every other end drops a V3 via stack, between the lower layers' tracks, onto an M3 pad that level 3 wires to a cell pin.
  - *Tile.* Systolic buses pass operands PE to PE, and every line drops through the gaps of Mx4–Mx1 to a cell pin in each PE. Weight buses feed each PE column from its SRAM macro, activation buses feed each row from the router, and result buses drain into the vector unit and back. NoC drops join each router's crossbar. Channel buses between the tiles drop to cell pins at both ends of their channel.
  - *Die and package.* The NoC runs on two layers (horizontal and vertical links) joined by junction vias at every branch, with edge lanes that close the network around the array. PHY bundles drop into the driver-strip lanes, and each microbump's via stack lands on the I/O circuit beneath it. The SRAM spine joins the lanes that cross it and takes TSV risers from the stacked die. Interposer RDL bundles join each PHY to its HBM stack, and C4 bumps carry the interposer to the substrate.
  - *Power.* The global mesh, tile rings, semi-global straps, and Mx4 straps each alternate VDD and VSS, with vias only where the same supply crosses. The path runs from the power bumps through the mesh, ring and mesh stacks, straps, and Mx4 → My1 stacks, then down via ladders (in the gaps between the Mx tracks) to the M0 rails. Backside power reaches the buried rails through nano-TSVs.
  - `tests/silicon-nets.test.ts` traces the generated geometry the way a circuit extractor would. It checks that local nets have one driver and reach the transistors, that routes and bus lines stay separate nets that drop to the cells, and that no signal ever touches a supply. It also checks that VDD and VSS each form one network, from the bumps to the ladders, and never meet.
- **Flows.** Pulses run along each net and through its vias (a via's height counts several times in the pulse path, so pulses visibly climb and descend), coloured by what the net carries. Every drawn primitive records its part and flow in the integer part of its pulse-phase float, so this costs no extra vertex data. The Flow toggles show Data (cyan, on by default), Power (amber VDD flowing down from the bumps, green VSS returning), and Clock (violet, from each local clock buffer to its flip-flops).
- **Trace any net.** Clicking a conductor traces everything touching it across all resident detail levels (`lib/silicon-trace.ts`). The whole net is outlined in its flow colour, through the other layers, and the panel lists the layers it passes through and the cell pins it joins (driver first). If the net runs on beyond the chunks loaded at the current zoom, the panel says so. Supply nets stop after 2,500 pieces. The worst case, the whole VDD network at the die zoom (857 pieces), traces in 36 ms on the M4 Max and 381 ms under SwiftShader at 6× CPU throttling.
- **What it is and how it is made.** `lib/silicon-explain.ts` explains every part (about 120 types), floorplan region, and standard cell. The selection panel shows what it does, what it connects (plus the traced net), and how it is made, in process order: fin patterning and replacement metal gates, source/drain epitaxy, contacts, dual-damascene copper, via stacks, buried and backside power, deep trenches, via-middle TSVs, copper-pillar microbumps, and the interposer, HBM, and package. These describe how such parts are built in general; the geometry stays illustrative.
- **Labels and identification.** `lib/silicon-parts.ts` names every primitive the generator draws (about 120 part types: fins, gates, epitaxy, contacts, buried rails, nano-TSVs, deep-trench capacitors, TSVs, M0–M3, vias, Mx/My/Mz metal, systolic buses, NoC lanes, pads, bumps, seal ring, and the package parts) from its material, shape, layer band, and the floorplan region under it; a test samples every detail level across the floorplan and fails if any drawn primitive there is unnamed. On screen: floating labels for the floorplan regions and one visible example of each part class at the current zoom, spread so they do not overlap and checked by ray casts against the same cuts the shaders make (crater, section plane, faded levels), so a label never points at hidden geometry; a hover read-out naming whatever is under the cursor; click for a details panel (role, material, size, location, cell type, supply) with a zoom-to button; a per-zoom legend with colour swatches; and a layer ruler down the side of a cross-section. Labels can show all parts, key parts only, or none.
- **Free movement.** Drag to move the view as you would a map: the point you grab stays under the cursor, in the horizontal plane through it when looking down or up and parallel to the screen from the side. Right-, middle-, or Shift/Ctrl/Cmd-drag moves the view, or turn on Pan so a plain drag (or one finger) moves it and right-drag rotates. Scroll or pinch zooms toward whatever is under the cursor, from any angle; when a zoom crosses into the next scale, the pivot slides to that scale's layer along the line of sight to the cursor, so the point under it stays put. The view roams anywhere over the package, keeps any height you move it to, and ignores the labels for dragging, zooming, and clicking. Measured in headless Chrome: grabbed and zoomed-at points stay within 0.1 px of the cursor at every scale, from above, the side, and below. With keyboard focus, the arrow keys move the view, + and − zoom, and Escape clears the selection.
- **Full rotation.** The orbit is unrestricted: all the way round and over the top to underneath. From below the package you see the substrate and BGA balls; at tile zoom or closer the package hides and the circuitry shows from its backside (backside power rails, nano-TSVs, deep trenches), as when imaging through the silicon in infrared. Chip geometry within a small sphere around the camera is cut away, so orbiting through the stack never slices wires at the near plane.
- **Extreme zoom without clipping.** Smooth zoom-to-cursor, damped orbit and pan, and van Wijk–Nuij fly paths for the zoom ladder (Package → Die → Tile → Tensor PE → Cells → Transistors). Near and far planes scale with distance. As you zoom, the orbit target descends through the stack and a delayering crater removes every layer above the focus layer around the line of sight, with terraced walls that show each layer passed. Crater floors sit in true gaps of the layer stack (a test enforces this), so no layer is left as a sliver.
- **Cross-section.** A vertical cut through the target, faced from the cleared side. Solid caps are generated for every cut primitive, and the plane snaps onto a column of vertical conductors (nano-TSVs or power rails at transistor scale, the TSV column at tile scale) so the deep structures show whole.
- **Performance.** Measured on an Apple M4 Max in headless Chrome at 1600 × 1000: a steady 60 fps at every rung. With vsync off, the rungs run at 409–644 fps at 1× pixel ratio with labels and hover running, including the complete nets (up to about 95,000 parts in view at the Cells zoom). Label placement runs in steps of at most 1.2 ms per frame. A chunk generates in about 1 ms once warm; the first chunk of each level takes 10–17 ms, once. Adaptive resolution trades pixels for frame rate from the median frame time, and a software-GL fallback (SwiftShader) runs at reduced resolution without MSAA.

Code: `lib/silicon-macro.ts` (floorplan, stack, cell layouts, local router, generators, package wiring, crater, fly paths, section caps; tested in `tests/silicon-macro.test.ts`), `lib/silicon-part-ids.ts` (part identities and flows packed per primitive), `lib/silicon-parts.ts` (part names, labels, legend, ruler, ray picking, net summaries; tested in `tests/silicon-parts.test.ts`), `lib/silicon-trace.ts` (net tracing; tested with the connectivity checks in `tests/silicon-nets.test.ts`), `lib/silicon-explain.ts` (what each part does, connects, and how it is made), `app/components/silicon/` (engine, inspector for picking and label planning, screen annotations, materials and shader patches, die textures), and `app/components/SiliconMacroView.tsx` (controls, legend, selection panel, and HUD).

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
