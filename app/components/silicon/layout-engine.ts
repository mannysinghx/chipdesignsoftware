import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  LAYER, NO_NET, ROUTING_LAYERS, decodeBlock, instChunkOf, netChunkOf, placeRect, placedPinRects, tileKey,
  type CellClass, type ClockTreeFile, type InstChunk, type LayerId, type LayoutBlock, type LayoutManifest, type LayoutPath, type NetChunk, type RegionGroup,
} from '@/lib/a1-layout-format';
import { CELL_CLASS_TEXT, CELL_EXPLAIN, LAYER_TEXT, STAGE_TEXT, TRANSISTOR_EXPLAIN, describeCell, type Explanation } from '@/lib/a1-layout-parts';
import {
  LAYOUT_MATERIALS, MM_PER_NM, PULSE, buildCellChunk, buildCoarseChunk, buildRoutingChunk, decodeRoles, defX, defY, frameOf, sceneX, sceneZ, strapsOf, unitLabel, viewStats, whatCategory, whatLayer,
  type CellRoles, type ChunkCell, type Frame, type LayoutChunk, type LayoutLibrary, type LayoutMaterial, type SceneContext,
} from '@/lib/a1-layout-scene';
import { LAYOUT_ZOOM, lodFade, lodWindow, stopAt, type LayoutStopId } from '@/lib/a1-layout-view';
import { FLOATS_PER_INSTANCE, clipPlanesFor, formatLength, scaleBar, zoomPanPath } from '@/lib/silicon-macro';
import { pickChunk } from '@/lib/silicon-parts';
import { createAnnotations, type Anchor, type LabelBox, type LabelMode, type RulerMark } from './annotations';
import { FinishShader, LAYOUT_SURFACES, createBackdrop, createSharedUniforms, createStudioEnvironment, createSurfaceMaterial, type LevelUniforms } from './materials';

// The real A1 tile layout (SKY130), drawn from the exported routed DEF and
// the cell library's GDS: the Silicon macro view's "A1 layout" mode. It shares
// the procedural view's metal shader, studio lighting, labels, and picking,
// but has its own data (streamed tiles from /layouts/a1-sky130hd/), its own
// zoom stops, and true layer heights.

export type { LabelMode } from './annotations';
export type DragMode = 'rotate' | 'pan';
export type Flows = { data: boolean; power: boolean; clock: boolean };

export type { LayoutStopId } from '@/lib/a1-layout-view';
export type LayoutStop = { id: LayoutStopId; label: string; layer: string; below: number; targetY: number; floor: number | null };

export type LayoutHud = {
  stop: LayoutStop;
  location: string[];
  scale: { label: string; px: number };
  distance: number;
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  instances: number;
  chunks: number;
  pending: number;
  /** Bytes of layout data downloaded so far. */
  bytes: number;
  dpr: number;
  gpu: string;
  software: boolean;
  view: 'top' | 'underside';
};

export type LayoutPin = { pin: string; dir: string; cell: string | null; inst: string | null; net: string | null; io: boolean };
export type LayoutNet = {
  id: number;
  name: string | null;
  kind: 'signal' | 'clock' | 'vdd' | 'vss';
  length: number | null;
  vias: number | null;
  layers: string[];
  tiles: number;
  /** Driver first, then what it drives; null while loading or when the net spans too many tiles. */
  pins: LayoutPin[] | null;
  note: string | null;
  pieces: number;
};
export type LayoutCell = {
  inst: number; name: string | null; macro: string; what: string; drive: string | null; cls: CellClass; size: string; place: string; pins: LayoutPin[] | null; transistors: number;
  /** Its dot unit (0–15), 16 when shared by several, null for none; and what it does in the pipeline. */
  unit: number | null;
  role: string | null;
};
/** One transistor of a cell, from the cell's layout (checked device for device against the library netlist). */
export type LayoutDevice = { type: 'NMOS' | 'PMOS'; w: number; l: number; gate: string | null; count: { n: number; p: number } };
export type LayoutSelection = {
  key: string;
  kind: 'net' | 'cell' | 'region' | 'surface';
  title: string;
  layer: string;
  role: string;
  material: string;
  size: string;
  location: string[];
  notes: string[];
  explain: Explanation | null;
  net: LayoutNet | null;
  cell: LayoutCell | null;
  device: LayoutDevice | null;
  /** For a dot unit: its colour on the map and its cells. */
  unit: { index: number; color: string; cells: number; registers: number } | null;
};

/** The Details panel: facts for the whole tile at the tile stop, counts of what is in view below it. */
export type LayoutDetails = {
  stop: LayoutStopId;
  title: string;
  subtitle: string;
  sections: Array<{ title: string; rows: Array<{ label: string; value: string; hint?: string; swatch?: string }> }>;
};

export type LayoutOverlays = { units: boolean; path: boolean };

export type LayoutEngineCallbacks = {
  onManifest: (manifest: LayoutManifest) => void;
  onHud: (hud: LayoutHud) => void;
  onReady: () => void;
  onError: (message: string) => void;
  onCameraGesture: (details: Record<string, unknown>) => void;
  onSelect: (selection: LayoutSelection | null) => void;
  onDetails: (details: LayoutDetails) => void;
};

export type LayoutEngine = {
  flyTo: (stop: LayoutStopId) => void;
  setFlows: (flows: Flows) => void;
  setNetShown: (on: boolean) => void;
  setBloom: (on: boolean) => void;
  setSection: (on: boolean) => void;
  setAutoRotate: (on: boolean) => void;
  setLabelMode: (mode: LabelMode) => void;
  setDragMode: (mode: DragMode) => void;
  setOverlays: (overlays: LayoutOverlays) => void;
  clearSelection: () => void;
  zoomToSelection: () => void;
  dispose: () => void;
};

export const LAYOUT_BASE = '/layouts/a1-sky130hd/';

const FOV = 34;
const MIN_DISTANCE = LAYOUT_ZOOM.min;
const MAX_DISTANCE = LAYOUT_ZOOM.max;
const POLAR_MARGIN = 0.02;
const CULL_FRACTION = 0.12;
const LABEL_BUDGET_MS = 1.2;
const BUILD_BUDGET_MS = 6;
const EVICT_AFTER_MS = 1500;
const FETCHES = 6;
/** Nets spanning more tiles than this are outlined and resolved only where loaded. */
const NET_TILE_LIMIT = 36;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const um = (nm: number) => nm / 1000;
const fmtUm = (value: number) => (value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2));
const num = (value: number) => Math.round(value).toLocaleString('en-US');
const signedNs = (value: number) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(2)} ns`;
const watts = (value: number) => (value >= 1 ? `${value.toFixed(2)} W` : value >= 1e-3 ? `${(value * 1e3).toFixed(0)} mW` : `${(value * 1e6).toFixed(1)} µW`);
const millivolts = (value: number) => `${(value * 1e3).toFixed(value * 1e3 < 0.1 ? 3 : 2)} mV`;
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
type Row = LayoutDetails['sections'][number]['rows'][number];

/** Fetch a layout file; gzip is undone here (unless a server already did). */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

function detectGpu(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return { name, software: /swiftshader|llvmpipe|software|basic render/i.test(name) };
}

type Level = 'global' | 'coarse' | 'tile' | 'footprint' | 'cells';
type Resident = { id: string; level: Exclude<Level, 'footprint'>; key: string; chunk: LayoutChunk; group: THREE.Group; caps: THREE.Group | null; capStamp: string; lastWanted: number; block: LayoutBlock };
type Hit = { t: number; record: Resident; batch: number; index: number } | { t: number; record: null; object: THREE.Object3D; point: THREE.Vector3 };
type Box = [number, number, number, number, number, number];
type Target =
  | { kind: 'shape'; key: string; record: Resident; batch: number; index: number; point?: THREE.Vector3 }
  | { kind: 'region'; key: string; group: RegionGroup; unit: number }
  /** Something a label names rather than a drawn shape: an I/O bank, a stage, the slowest path, a transistor. */
  | { kind: 'info'; key: string; selection: Omit<LayoutSelection, 'key'>; point: THREE.Vector3; box: Box | null; zoom: number }
  | { kind: 'surface'; key: string; point: THREE.Vector3 };

export function createLayoutEngine(host: HTMLElement, callbacks: LayoutEngineCallbacks, base = LAYOUT_BASE): LayoutEngine {
  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error('WebGL 2 is required for the A1 layout view.');
  }
  const gpu = detectGpu(renderer);
  const hdrTargets = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.info.autoReset = false;
  const deviceRatio = Math.min(window.devicePixelRatio || 1, 2);
  const dprRange = gpu.software ? { min: 0.5, max: 0.6 } : { min: 0.75, max: Math.max(1, deviceRatio) };
  let dpr = gpu.software ? 0.6 : Math.min(deviceRatio, 1.6);
  renderer.setPixelRatio(dpr);
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9);
  renderer.clippingPlanes = [sectionPlane];
  // Software GL gets much smaller streaming windows.
  const budgetOf = (spec: { budget: { gpu: number; software: number } }) => (gpu.software ? spec.budget.software : spec.budget.gpu);

  const scene = new THREE.Scene();
  const disposables: Array<{ dispose: () => void }> = [];
  const backdrop = createBackdrop();
  disposables.push(backdrop);
  scene.background = backdrop;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  const key = new THREE.DirectionalLight('#fff3e4', 0.55);
  key.position.set(-4.5, 10, 3.5);
  scene.add(key);
  const headlight = new THREE.DirectionalLight('#f4f7ff', 0);
  scene.add(headlight, headlight.target);

  const shared = createSharedUniforms();
  const levelUniforms: Record<Level, LevelUniforms> = {
    global: { uFade: { value: 1 }, uPulsePeriod: { value: 400 }, uPulseRate: { value: 1 }, uViaStretch: { value: 40 } },
    coarse: { uFade: { value: 0 }, uPulsePeriod: { value: PULSE.period }, uPulseRate: { value: 1 }, uViaStretch: { value: 1 } },
    tile: { uFade: { value: 0 }, uPulsePeriod: { value: PULSE.period }, uPulseRate: { value: PULSE.speed / PULSE.period }, uViaStretch: { value: PULSE.viaStretch } },
    footprint: { uFade: { value: 0 }, uPulsePeriod: { value: PULSE.period }, uPulseRate: { value: 1 }, uViaStretch: { value: 1 } },
    cells: { uFade: { value: 0 }, uPulsePeriod: { value: PULSE.period }, uPulseRate: { value: 1 }, uViaStretch: { value: 1 } },
  };
  const materials = Object.fromEntries((['global', 'coarse', 'tile', 'footprint', 'cells'] as Level[]).map((level) => [level, Object.fromEntries(LAYOUT_MATERIALS.map((material) => [material, createSurfaceMaterial(LAYOUT_SURFACES[material], shared, levelUniforms[level])]))])) as Record<Level, Record<LayoutMaterial, THREE.MeshStandardMaterial>>;
  for (const set of Object.values(materials)) disposables.push(...Object.values(set));
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(unitBox);
  const levelGroups = { global: new THREE.Group(), coarse: new THREE.Group(), tile: new THREE.Group(), cells: new THREE.Group() };
  scene.add(levelGroups.global, levelGroups.coarse, levelGroups.tile, levelGroups.cells);

  // ------------------------------------------------------------ data state
  let manifest: LayoutManifest | null = null;
  let frame: Frame | null = null;
  let ctx: SceneContext | null = null;
  let library: LayoutLibrary | null = null;
  let roles: CellRoles | null = null;
  let bytesLoaded = 0;
  const tileBytes = new Map<string, number>();
  // Decoded tiles, least recently used first; chunks on screen keep their own reference.
  const blocks = new Map<string, LayoutBlock>();
  const BLOCK_CACHE = 240;
  const keepBlock = (key: string, block: LayoutBlock) => {
    blocks.delete(key);
    blocks.set(key, block);
    for (const oldest of blocks.keys()) {
      if (blocks.size <= BLOCK_CACHE) break;
      blocks.delete(oldest);
    }
  };
  const blockRequests = new Map<string, Promise<LayoutBlock | null>>();
  const netChunks = new Map<number, Promise<NetChunk>>();
  const instChunks = new Map<number, Promise<InstChunk>>();
  const netChunksReady = new Map<number, NetChunk>();
  const instChunksReady = new Map<number, InstChunk>();
  let inFlight = 0;
  const fetchQueue: Array<{ key: string; resolve: (block: LayoutBlock | null) => void; priority: number }> = [];
  const loadBytes = async (path: string) => {
    const bytes = await fetchBytes(base + path);
    bytesLoaded += bytes.length;
    return bytes;
  };
  const pumpFetches = () => {
    fetchQueue.sort((a, b) => a.priority - b.priority);
    while (inFlight < FETCHES && fetchQueue.length > 0) {
      const job = fetchQueue.shift()!;
      inFlight += 1;
      loadBytes(`tiles/${job.key}.bin.gz`)
        .then((bytes) => {
          const block = decodeBlock(bytes);
          keepBlock(job.key, block);
          job.resolve(block);
        })
        .catch(() => job.resolve(null))
        .finally(() => {
          // Settled either way: a later request for this tile fetches again if it was evicted.
          blockRequests.delete(job.key);
          inFlight -= 1;
          pumpFetches();
        });
    }
  };
  /** A tile's decoded block, fetched once; null for tiles with nothing in them. */
  const requestBlock = (key: string, priority = 0): Promise<LayoutBlock | null> => {
    const ready = blocks.get(key);
    if (ready) {
      keepBlock(key, ready);
      return Promise.resolve(ready);
    }
    const pending = blockRequests.get(key);
    if (pending) {
      const queued = fetchQueue.find((job) => job.key === key);
      if (queued) queued.priority = Math.min(queued.priority, priority);
      return pending;
    }
    if (!tileBytes.has(key)) return Promise.resolve(null);
    const promise = new Promise<LayoutBlock | null>((resolve) => fetchQueue.push({ key, resolve, priority }));
    blockRequests.set(key, promise);
    pumpFetches();
    return promise;
  };
  const netChunk = (net: number) => {
    const c = netChunkOf(net);
    let found = netChunks.get(c);
    if (!found) {
      found = loadBytes(`nets/${c}.json.gz`).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as NetChunk);
      found.then((chunk) => netChunksReady.set(c, chunk), () => netChunks.delete(c));
      netChunks.set(c, found);
    }
    return found;
  };
  const instChunk = (inst: number) => {
    const c = instChunkOf(inst);
    let found = instChunks.get(c);
    if (!found) {
      found = loadBytes(`insts/${c}.json.gz`).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as InstChunk);
      found.then((chunk) => instChunksReady.set(c, chunk), () => instChunks.delete(c));
      instChunks.set(c, found);
    }
    return found;
  };
  const netNameNow = (net: number) => {
    if (!manifest) return null;
    if (net === manifest.nets.vdd) return 'VDD';
    if (net === manifest.nets.vss) return 'VSS';
    const chunk = netChunksReady.get(netChunkOf(net));
    return chunk ? chunk.names[net - chunk.first] : null;
  };
  const instNameNow = (inst: number) => {
    if (inst < 0) return null;
    const chunk = instChunksReady.get(instChunkOf(inst));
    return chunk ? chunk.names[inst - chunk.first] : null;
  };

  // --------------------------------------------------------- chunk meshes
  function meshesFor(chunk: LayoutChunk, batches: LayoutChunk['batches'], level: Level) {
    const group = new THREE.Group();
    group.position.set(chunk.origin[0], 0, chunk.origin[2]);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    const hx = (chunk.bounds.x1 - chunk.bounds.x0) / 2;
    const hz = (chunk.bounds.z1 - chunk.bounds.z0) / 2;
    const margin = Math.max(hx, hz) * 0.08;
    for (const batch of batches) {
      if (batch.count === 0) continue;
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setIndex(unitBox.index!.clone());
      geometry.setAttribute('position', unitBox.getAttribute('position').clone());
      geometry.setAttribute('normal', unitBox.getAttribute('normal').clone());
      const buffer = new THREE.InstancedInterleavedBuffer(batch.data, FLOATS_PER_INSTANCE);
      geometry.setAttribute('iOffset', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
      geometry.setAttribute('iScale', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
      geometry.setAttribute('iData', new THREE.InterleavedBufferAttribute(buffer, 4, 6));
      geometry.instanceCount = batch.count;
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-hx - margin, chunk.yMin, -hz - margin), new THREE.Vector3(hx + margin, chunk.yMax, hz + margin));
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
      // Cell outlines fade out as the cells' own geometry fades in.
      const outline = level === 'tile' && (batch.material === 'logic' || batch.material === 'sequential' || batch.material === 'clockcell' || batch.material === 'physical');
      const mesh = new THREE.Mesh(geometry, materials[outline ? 'footprint' : level][batch.material]);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    return group;
  }
  const disposeGroup = (group: THREE.Group) => {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    group.removeFromParent();
  };
  const resident = new Map<string, Resident>();
  const addResident = (id: string, level: Resident['level'], chunk: LayoutChunk, block: LayoutBlock, now: number) => {
    const group = meshesFor(chunk, chunk.batches, level);
    levelGroups[level].add(group);
    resident.set(id, { id, level, key: id.slice(id.indexOf(':') + 1), chunk, group, caps: null, capStamp: '', lastWanted: now, block });
  };

  // ------------------------------------------------------ static geometry
  let substrate: THREE.Mesh | null = null;
  type OverviewUniforms = {
    uMetal: { value: THREE.Texture | null };
    uCells: { value: THREE.Texture | null };
    uUnits: { value: THREE.Texture | null };
    uPalette: { value: THREE.Color[] };
    /** How strongly the dot-unit colours tint the map (0 hides them). */
    uUnitsOn: { value: number };
    /** Inside uWindow (x0, z0, x1, z1: where every shape is loaded) the map gives way to bare silicon by this much. */
    uDetail: { value: number };
    uWindow: { value: THREE.Vector4 };
    /** The selected dot unit, whose tint stays while the others fade back (-1: none). */
    uFocus: { value: number };
  };
  let overviewUniforms: OverviewUniforms | null = null;
  const statics: THREE.Object3D[] = [];
  // The substrate's cut face in a cross-section: a thin solid box on the section plane.
  let substrateCap: THREE.Mesh | null = null;
  const SUBSTRATE_THICKNESS = 0.02;
  function placeSubstrateCap() {
    if (!substrateCap || !manifest) return;
    substrateCap.visible = sectionOn;
    if (!sectionOn) return;
    const width = (manifest.die[2] - manifest.die[0]) * MM_PER_NM;
    const depth = (manifest.die[3] - manifest.die[1]) * MM_PER_NM;
    const thin = Math.max(capEps, 1e-9);
    substrateCap.scale.set(section.axis === 0 ? thin : width, SUBSTRATE_THICKNESS, section.axis === 2 ? thin : depth);
    substrateCap.position.set(section.axis === 0 ? section.value + section.keep * thin * 8 : 0, -SUBSTRATE_THICKNESS / 2, section.axis === 2 ? section.value + section.keep * thin * 8 : 0);
  }
  function buildSubstrate(metal: THREE.Texture, cells: THREE.Texture, units: THREE.Texture | null) {
    if (!manifest || !frame) return;
    const width = (manifest.die[2] - manifest.die[0]) * MM_PER_NM;
    const depth = (manifest.die[3] - manifest.die[1]) * MM_PER_NM;
    const thickness = SUBSTRATE_THICKNESS;
    const geometry = new THREE.BoxGeometry(width, thickness, depth);
    // Top-face UVs map the die, north up (the coverage images are stored top row = north).
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const top = geometry.groups[2];
    for (let k = top.start; k < top.start + top.count; k += 1) {
      const vertex = geometry.index ? geometry.index.getX(k) : k;
      uv.setXY(vertex, (position.getX(vertex) + width / 2) / width, 1 - (position.getZ(vertex) + depth / 2) / depth);
    }
    uv.needsUpdate = true;
    const palette = (manifest.unitsOverview?.palette ?? []).map((hex) => new THREE.Color(hex));
    while (palette.length < 16) palette.push(new THREE.Color('#888888'));
    const uniforms: OverviewUniforms = {
      uMetal: { value: metal }, uCells: { value: cells }, uUnits: { value: units }, uPalette: { value: palette },
      uUnitsOn: { value: 0 }, uDetail: { value: 0 }, uWindow: { value: new THREE.Vector4(1, 1, -1, -1) }, uFocus: { value: -1 },
    };
    overviewUniforms = uniforms;
    const surface = new THREE.MeshStandardMaterial({ map: metal, roughness: 0.62, metalness: 0.25 });
    surface.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = 'varying vec3 vLayoutWorld;\n' + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvLayoutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = /* glsl */ `
uniform sampler2D uMetal;
uniform sampler2D uCells;
uniform sampler2D uUnits;
uniform vec3 uPalette[16];
uniform float uUnitsOn;
uniform float uDetail;
uniform vec4 uWindow;
uniform float uFocus;
varying vec3 vLayoutWorld;
` + shader.fragmentShader.replace('#include <map_fragment>', /* glsl */ `
{
  // Coverage of the real layout per 2.5 µm pixel: cells by kind, then the routing layers over them.
  vec4 m = texture2D(uMetal, vMapUv);
  vec4 c = texture2D(uCells, vMapUv);
  vec3 col = vec3(0.028, 0.031, 0.038);
  col = mix(col, vec3(0.22, 0.21, 0.21), c.r * 0.65);
  col = mix(col, vec3(0.10, 0.21, 0.44), c.g * 0.9);
  col = mix(col, vec3(0.34, 0.15, 0.42), c.b * 0.9);
  // Where each dot unit's cells are (the map from the netlist), tinted in the unit's colour.
  float unit = floor(texture2D(uUnits, vMapUv).r * 255.0 / 16.0 + 0.5) - 1.0;
  if (unit >= 0.0 && uUnitsOn > 0.0) {
    float focus = uFocus < 0.0 || abs(unit - uFocus) < 0.5 ? 1.0 : 0.3;
    col = mix(col, uPalette[int(unit)] * (0.35 + 0.65 * clamp(c.r + c.g, 0.0, 1.0)), uUnitsOn * 0.62 * focus);
  }
  col = mix(col, vec3(0.30, 0.30, 0.33), m.r * 0.45);
  col = mix(col, vec3(0.38, 0.37, 0.39), m.g * 0.5);
  col = mix(col, vec3(0.46, 0.45, 0.46), m.b * 0.6);
  col = mix(col, vec3(0.54, 0.54, 0.56), m.a * 0.75);
  // Where every shape is loaded, the streamed geometry takes over and the surface is bare silicon.
  float inside = step(uWindow.x, vLayoutWorld.x) * step(vLayoutWorld.x, uWindow.z) * step(uWindow.y, vLayoutWorld.z) * step(vLayoutWorld.z, uWindow.w);
  diffuseColor.rgb = mix(col, vec3(0.028, 0.031, 0.038), uDetail * inside);
}`);
    };
    surface.customProgramCacheKey = () => 'a1-layout-overview-v3';
    const side = new THREE.MeshStandardMaterial({ color: '#16181d', metalness: 0.35, roughness: 0.38 });
    disposables.push(geometry, surface, side, metal, cells);
    if (units) disposables.push(units);
    const mesh = new THREE.Mesh(geometry, [side, side, surface, side, side, side]);
    mesh.position.y = -thickness / 2;
    mesh.userData.part = 'substrate';
    scene.add(mesh);
    statics.push(mesh);
    substrate = mesh;
    const capMaterial = new THREE.MeshStandardMaterial({ color: '#5d636d', metalness: 0.3, roughness: 0.46 });
    disposables.push(capMaterial);
    substrateCap = new THREE.Mesh(unitBox, capMaterial);
    substrateCap.visible = false;
    substrateCap.userData.part = 'substrate';
    scene.add(substrateCap);
    statics.push(substrateCap);
  }

  // -------------------------------------------------------------- overlays
  // Real data drawn over the chip: the I/O pin banks, the clock tree, and the slowest path.
  let overlays: LayoutOverlays = { units: true, path: false };
  let clockShown = false;
  const overlayY = () => (frame ? frame.z.met5[1] : 0.0066);
  let ioBars: THREE.Group | null = null;
  function buildIoBars() {
    if (!manifest || !frame || !manifest.ioBuses) return;
    const f = frame;
    const group = new THREE.Group();
    const materialFor = (dir: string) => new THREE.MeshBasicMaterial({ color: dir === 'output' ? '#ffb066' : '#5fdcff', transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false });
    const depth = 14000; // nm: a band this deep just inside the edge
    for (const bus of manifest.ioBuses) {
      const [x0, y0, x1, y1] = manifest.die;
      const pad = 3000;
      const [a0, a1] = [bus.from - pad, bus.to + pad];
      const rect = bus.side === 'west' ? [x0, a0, x0 + depth, a1] : bus.side === 'east' ? [x1 - depth, a0, x1, a1] : bus.side === 'south' ? [a0, y0, a1, y0 + depth] : [a0, y1 - depth, a1, y1];
      const material = materialFor(bus.dir);
      const mesh = new THREE.Mesh(unitBox, material);
      mesh.scale.set((rect[2] - rect[0]) * MM_PER_NM, 0.0004, (rect[3] - rect[1]) * MM_PER_NM);
      mesh.position.set(sceneX(f, (rect[0] + rect[2]) / 2), overlayY() + 0.0006, sceneZ(f, (rect[1] + rect[3]) / 2));
      mesh.renderOrder = 5;
      group.add(mesh);
      disposables.push(material);
    }
    scene.add(group);
    ioBars = group;
  }
  let clockTree: THREE.Group | null = null;
  let clockTreeLoading = false;
  let clockTreeData: ClockTreeFile | null = null;
  async function ensureClockTree() {
    if (clockTree || clockTreeLoading || !manifest?.clockTree || !frame) return;
    clockTreeLoading = true;
    try {
      const data = JSON.parse(new TextDecoder().decode(await loadBytes(manifest.clockTree.file))) as ClockTreeFile;
      if (disposed || !frame) return;
      clockTreeData = data;
      const f = frame;
      const y = overlayY() + 0.0009;
      const positions: number[] = [];
      const colors: number[] = [];
      const deepest = Math.max(...data.nodes.map((node) => node[4]));
      const tint = (level: number) => new THREE.Color().setHSL(0.8 - 0.1 * (level / Math.max(1, deepest)), 0.75, 0.62);
      for (const [x, yy, parent, , level] of data.nodes) {
        const [px, py] = parent >= 0 ? [data.nodes[parent][0], data.nodes[parent][1]] : data.root;
        positions.push(sceneX(f, px), y, sceneZ(f, py), sceneX(f, x), y, sceneZ(f, yy));
        const c = tint(level);
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false });
      const lines = new THREE.LineSegments(geometry, material);
      lines.renderOrder = 6;
      const dots = new THREE.BufferGeometry();
      dots.setAttribute('position', new THREE.Float32BufferAttribute(data.nodes.flatMap(([x, yy]) => [sceneX(f, x), y, sceneZ(f, yy)]), 3));
      const dotMaterial = new THREE.PointsMaterial({ color: '#e7a6ff', size: 3, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
      const points = new THREE.Points(dots, dotMaterial);
      points.renderOrder = 6;
      disposables.push(geometry, material, dots, dotMaterial);
      const group = new THREE.Group();
      group.add(lines, points);
      group.visible = false;
      scene.add(group);
      clockTree = group;
      planAt = 0;
    } catch {
      // The clock tree is optional: the flows still show the clock nets in the tiles.
    } finally {
      clockTreeLoading = false;
    }
  }
  let pathGroup: THREE.Group | null = null;
  let pathData: LayoutPath | null = null;
  let pathLoading = false;
  async function ensurePath() {
    if (pathGroup || pathLoading || !manifest?.criticalPath || !frame) return;
    pathLoading = true;
    try {
      const data = JSON.parse(new TextDecoder().decode(await loadBytes(manifest.criticalPath.file))) as LayoutPath;
      if (disposed || !frame) return;
      pathData = data;
      const f = frame;
      const y = overlayY() + 0.0012;
      const line = (steps: LayoutPath['data'], color: string, order: number) => {
        const points: THREE.Vector3[] = [];
        for (const step of steps) {
          const point = new THREE.Vector3(sceneX(f, step.x), y, sceneZ(f, step.y));
          if (!points.length || points[points.length - 1].distanceTo(point) > 1e-9) points.push(point);
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false, toneMapped: false });
        const object = new THREE.Line(geometry, material);
        object.renderOrder = order;
        disposables.push(geometry, material);
        const dots = new THREE.BufferGeometry().setFromPoints(points);
        const dotMaterial = new THREE.PointsMaterial({ color, size: 4, sizeAttenuation: false, depthWrite: false, depthTest: false, toneMapped: false });
        const cells = new THREE.Points(dots, dotMaterial);
        cells.renderOrder = order;
        disposables.push(dots, dotMaterial);
        return [object, cells];
      };
      const group = new THREE.Group();
      group.add(...line(data.clock, '#d58cff', 7), ...line(data.data, '#ff6a4d', 8));
      group.visible = overlays.path;
      scene.add(group);
      pathGroup = group;
      planAt = 0;
    } catch (reason) {
      callbacks.onError(`The slowest path could not be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      pathLoading = false;
    }
  }
  /** Which overlays show at this distance. */
  function updateOverlays(distance: number) {
    const far = distance > LAYOUT_ZOOM.stops[2].below;
    if (ioBars) ioBars.visible = far && !sectionOn;
    const clockWanted = clockShown && far && !sectionOn;
    if (clockWanted) void ensureClockTree();
    if (clockTree) clockTree.visible = clockWanted;
    if (overlays.path) void ensurePath();
    if (pathGroup) pathGroup.visible = overlays.path;
    if (overviewUniforms) overviewUniforms.uUnitsOn.value = overlays.units ? THREE.MathUtils.smoothstep(distance, 0.25, 1.1) : 0;
  }

  // ------------------------------------------------------------ post stack
  const bloomStrength = 0.3;
  let bloomEnabled = true;
  let post: { composer: EffectComposer; bloom: UnrealBloomPass | null; finish: ShaderPass; target: THREE.WebGLRenderTarget } | null = null;
  function createPost() {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: hdrTargets ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: gpu.software ? 0 : 4 });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = gpu.software ? null : new UnrealBloomPass(new THREE.Vector2(1, 1), bloomStrength, 0.45, hdrTargets ? 1.5 : 0.92);
    if (bloom) {
      bloom.enabled = bloomEnabled;
      composer.addPass(bloom);
    }
    composer.addPass(new OutputPass());
    const finish = new ShaderPass(FinishShader);
    composer.addPass(finish);
    return { composer, bloom, finish, target };
  }

  // -------------------------------------------------------------- controls
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.085;
  controls.rotateSpeed = 0.55;
  controls.panSpeed = 0.9;
  // Pinches zoom toward the fingers through the controls; the mouse wheel is taken on the host (onWheel).
  controls.enableZoom = true;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = false;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;
  controls.autoRotateSpeed = 0.35;
  controls.keyPanSpeed = 24;
  controls.listenToKeyEvents(host);
  const orbit = controls.target;
  orbit.set(0, 0, 0);
  camera.position.set(0, 3.2, 2.6);
  controls.update();

  // ---------------------------------------------------------------- stops
  let stops: LayoutStop[] = [];
  let stop: LayoutStop = { id: 'tile', label: 'A1 tile', layer: 'Loading the layout', below: Infinity, targetY: 0.006, floor: null };
  const stopFor = (distance: number, current: LayoutStopId) => {
    if (stops.length === 0) return stop;
    const id = stopAt(distance, current);
    return stops.find((item) => item.id === id) ?? stops[0];
  };
  const presets = new Map<LayoutStopId, { x: number; z: number; distance: number; polar: number; azimuth: number }>();

  // ------------------------------------------------------------ camera
  let craterFloor = 1;
  let sectionOn = false;
  let section = { axis: 0 as 0 | 2, value: 0, keep: 1 as 1 | -1 };
  let sectionStamp = '';
  let capEps = 0;
  let zoomImpulse = 0;
  const raycaster = new THREE.Raycaster();
  const scratch = new THREE.Vector3();
  const spherical = new THREE.Spherical();
  let flight: null | { start: number; duration: number; path: ReturnType<typeof zoomPanPath>; polar: [number, number]; azimuth: [number, number]; height: [number, number] } = null;
  let view: LayoutHud['view'] = 'top';
  let gestures = 0;
  let gestureTimer: number | undefined;
  const noteGesture = () => {
    gestures += 1;
    window.clearTimeout(gestureTimer);
    gestureTimer = window.setTimeout(() => {
      callbacks.onCameraGesture({ gestures, distance_mm: Number(camera.position.distanceTo(orbit).toPrecision(4)), stop: stop.id, target_mm: orbit.toArray().map((value) => Number(value.toFixed(6))), section: sectionOn, source: 'a1-layout' });
      gestures = 0;
    }, 800);
  };
  const clientNdc = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  };
  const planeHit = (ndc: THREE.Vector2) => {
    raycaster.setFromCamera(ndc, camera);
    const plane = sectionOn ? new THREE.Plane(new THREE.Vector3(section.axis === 0 ? 1 : 0, 0, section.axis === 2 ? 1 : 0), -section.value) : new THREE.Plane(new THREE.Vector3(0, 1, 0), -stop.targetY);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  };
  const pointUnder = (ndc: THREE.Vector2) => {
    const distance = camera.position.distanceTo(orbit);
    const near = (point: THREE.Vector3 | null) => (point && point.distanceTo(camera.position) < distance * 25 ? point : null);
    const hit = pickRay(ndc);
    const found = near(hit ? hitPoint(hit) : null) ?? near(planeHit(ndc));
    if (found) return found;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.at(distance, new THREE.Vector3());
  };
  let zoomAnchor: THREE.Vector3 | null = null;
  const zoomAnchorAt = (ndc: THREE.Vector2) => {
    const hit = planeHit(ndc);
    const normal = sectionOn ? (section.axis === 0 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)) : new THREE.Vector3(0, 1, 0);
    const steep = Math.abs(raycaster.ray.direction.dot(normal)) > 0.35;
    return hit && steep && hit.distanceTo(camera.position) < camera.position.distanceTo(orbit) * 25 ? hit : pointUnder(ndc);
  };
  function zoomAbout(scale: number) {
    const distance = camera.position.distanceTo(orbit);
    const next = clamp(distance * scale, MIN_DISTANCE, MAX_DISTANCE);
    if (Math.abs(next - distance) < distance * 1e-9) {
      zoomImpulse = 0;
      return;
    }
    const k = next / distance;
    const anchor = zoomAnchor ?? orbit.clone();
    camera.position.sub(anchor).multiplyScalar(k).add(anchor);
    orbit.sub(anchor).multiplyScalar(k).add(anchor);
  }
  let sectionFocusY: number | null = null;
  const sectionAzimuth = () => (section.axis === 0 ? (section.keep > 0 ? -Math.PI / 2 : Math.PI / 2) : section.keep > 0 ? Math.PI : 0);
  function flyTo(spec: { x: number; z: number; distance: number; polar?: number; azimuth?: number; y?: number }) {
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    const path = zoomPanPath({ x: orbit.x, z: orbit.z, width: spherical.radius }, { x: spec.x, z: spec.z, width: spec.distance });
    const polarTarget = clamp(spec.polar ?? spherical.phi, POLAR_MARGIN, Math.PI - POLAR_MARGIN);
    const azimuthTarget = spherical.theta + wrapAngle((spec.azimuth ?? spherical.theta) - spherical.theta);
    const targetY = spec.y ?? stopFor(spec.distance, stop.id).targetY;
    flight = { start: performance.now(), duration: clamp(600 + path.length * 360, 700, 4500), path, polar: [spherical.phi, polarTarget], azimuth: [spherical.theta, azimuthTarget], height: [orbit.y, targetY] };
    zoomImpulse = 0;
    zoomAnchor = null;
    controls.enabled = false;
  }
  const cancelFlight = () => {
    if (!flight) return;
    flight = null;
    controls.enabled = true;
  };
  function stepFlight(now: number) {
    if (!flight) return;
    const t = clamp((now - flight.start) / flight.duration, 0, 1);
    const point = flight.path.at(ease(t) * flight.path.length);
    const blend = t * t * (3 - 2 * t);
    orbit.set(point.x, THREE.MathUtils.lerp(flight.height[0], flight.height[1], blend), point.z);
    camera.position.copy(orbit).add(scratch.setFromSphericalCoords(point.width, THREE.MathUtils.lerp(flight.polar[0], flight.polar[1], blend), THREE.MathUtils.lerp(flight.azimuth[0], flight.azimuth[1], blend)));
    camera.lookAt(orbit);
    if (t >= 1) {
      cancelFlight();
      sectionFocusY = null;
    }
  }

  // ------------------------------------------------------------- events
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    cancelFlight();
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 400;
    zoomImpulse += clamp(delta * (event.ctrlKey ? 0.012 : 0.0022), -1.4, 1.4);
    zoomAnchor = zoomAnchorAt(clientNdc(event.clientX, event.clientY));
    noteGesture();
  };
  const onDoubleClick = (event: MouseEvent) => {
    const point = pointUnder(clientNdc(event.clientX, event.clientY));
    const distance = camera.position.distanceTo(orbit);
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    flyTo({ x: point.x, z: point.z, distance: distance * (event.shiftKey ? 3.2 : 0.3), polar: spherical.phi, azimuth: spherical.theta });
    if (sectionOn) sectionFocusY = point.y;
    noteGesture();
  };
  const onPointerDown = (event: PointerEvent) => {
    cancelFlight();
    beginPan(event);
  };
  const onControlsEnd = () => noteGesture();
  const onControlsStart = () => {
    zoomAnchor = null;
  };
  host.addEventListener('wheel', onWheel, { passive: false, capture: true });
  host.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('dblclick', onDoubleClick);
  controls.addEventListener('end', onControlsEnd);
  controls.addEventListener('start', onControlsStart);
  let contextLost = false;
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
    callbacks.onError('The GPU context was lost. Open another view and come back to rebuild the scene.');
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  // --------------------------------------------------------------- sizing
  let cssWidth = 1;
  let cssHeight = 1;
  const applySize = () => {
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssWidth, cssHeight, false);
    if (post) {
      post.composer.setPixelRatio(dpr);
      post.composer.setSize(cssWidth, cssHeight);
      post.finish.uniforms.uResolution.value.set(cssWidth * dpr, cssHeight * dpr);
    }
    camera.aspect = cssWidth / cssHeight;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(() => {
    cssWidth = Math.max(1, host.clientWidth);
    cssHeight = Math.max(1, host.clientHeight);
    applySize();
  });
  observer.observe(host);
  cssWidth = Math.max(1, host.clientWidth);
  cssHeight = Math.max(1, host.clientHeight);
  applySize();

  // --------------------------------------------------------------- picking
  const craterCleared = (x: number, y: number, z: number) => {
    if (shared.uCraterOn.value < 0.5) return false;
    const c = shared.uCrater.value;
    return y > c.z + Math.max(0, Math.hypot(x - c.x, z - c.y) - c.w) * shared.uCraterSlope.value;
  };
  const sphereExit = (origin: THREE.Vector3, dir: THREE.Vector3) => {
    const u = shared.uCull.value;
    const mx = origin.x - u.x;
    const my = origin.y - u.y;
    const mz = origin.z - u.z;
    const c = mx * mx + my * my + mz * mz - u.w * u.w;
    if (c >= 0) return 0;
    const b = mx * dir.x + my * dir.y + mz * dir.z;
    return -b + Math.sqrt(b * b - c);
  };
  const levelVisible = (record: Resident) => levelUniforms[record.level].uFade.value >= 0.5 && levelGroups[record.level].visible && record.group.visible;
  const outlineVisible = () => levelUniforms.footprint.uFade.value >= 0.5;
  function castRay(origin: THREE.Vector3, dir: THREE.Vector3, tLimit = Infinity): Hit | null {
    let t0 = 0;
    let t1 = tLimit;
    const d0 = sectionPlane.distanceToPoint(origin);
    const dn = sectionPlane.normal.dot(dir);
    if (d0 < 0) {
      if (dn <= 0) return null;
      t0 = -d0 / dn;
    } else if (dn < 0) t1 = Math.min(t1, -d0 / dn);
    if (t0 > t1) return null;
    const tChip = Math.max(t0, sphereExit(origin, dir));
    const o: [number, number, number] = [origin.x, origin.y, origin.z];
    const d: [number, number, number] = [dir.x, dir.y, dir.z];
    let best: Hit | null = null;
    for (const record of resident.values()) {
      if (!levelVisible(record)) continue;
      // Hide the cell outlines from picking once the cells' own shapes have replaced them.
      const chunk = record.level === 'tile' && !outlineVisible() ? withoutOutlines(record.chunk) : record.chunk;
      const hit = pickChunk(chunk, o, d, tChip, t1, craterCleared);
      if (!hit) continue;
      t1 = hit.t;
      const batch = chunk === record.chunk ? hit.batch : record.chunk.batches.indexOf(chunk.batches[hit.batch]);
      best = { t: hit.t, record, batch, index: hit.index };
    }
    if (substrate?.visible || substrateCap?.visible) {
      raycaster.set(origin, dir);
      raycaster.near = t0;
      raycaster.far = t1;
      const hit = raycaster.intersectObjects(statics.filter((object) => object.visible), false)[0];
      if (hit && sectionPlane.distanceToPoint(hit.point) >= -1e-9) best = { t: hit.distance, record: null, object: hit.object, point: hit.point };
    }
    return best;
  }
  const outlineless = new WeakMap<LayoutChunk, LayoutChunk>();
  function withoutOutlines(chunk: LayoutChunk): LayoutChunk {
    let found = outlineless.get(chunk);
    if (!found) {
      found = { ...chunk, batches: chunk.batches.filter((batch) => !(batch.material === 'logic' || batch.material === 'sequential' || batch.material === 'clockcell' || batch.material === 'physical')) };
      outlineless.set(chunk, found);
    }
    return found;
  }
  const hitPoint = (hit: Hit) => (hit.record ? raycaster.ray.at(hit.t, new THREE.Vector3()) : hit.point.clone());
  function pickRay(ndc: THREE.Vector2): Hit | null {
    raycaster.setFromCamera(ndc, camera);
    const origin = raycaster.ray.origin.clone();
    const dir = raycaster.ray.direction.clone();
    const hit = castRay(origin, dir);
    raycaster.set(origin, dir);
    return hit;
  }
  const targetOf = (hit: Hit): Target => (hit.record ? { kind: 'shape', key: `${hit.record.id}/${hit.batch}/${hit.index}`, record: hit.record, batch: hit.batch, index: hit.index, point: hitPoint(hit) } : { kind: 'surface', key: 'surface', point: hit.point });
  const pick = (ndc: THREE.Vector2) => {
    const hit = pickRay(ndc);
    return hit ? targetOf(hit) : null;
  };

  // ------------------------------------------------------- describe things
  const shapeOf = (target: Extract<Target, { kind: 'shape' }>) => {
    const batch = target.record.chunk.batches[target.batch];
    const o = target.index * FLOATS_PER_INSTANCE;
    const d = batch.data;
    const origin = target.record.chunk.origin;
    return {
      what: batch.what[target.index],
      ref: batch.ref[target.index],
      material: batch.material,
      x: d[o] + origin[0], y: d[o + 1], z: d[o + 2] + origin[2],
      sx: d[o + 3], sy: d[o + 4], sz: d[o + 5],
    };
  };
  const netKind = (net: number): LayoutNet['kind'] => (!manifest ? 'signal' : net === manifest.nets.vdd ? 'vdd' : net === manifest.nets.vss ? 'vss' : ctx?.clockNets.has(net) ? 'clock' : 'signal');
  const unitColor = (unit: number) => manifest?.unitsOverview?.palette[unit] ?? '#ffc978';
  /** Where a dot unit's logic sits (DBU), or its registers for exports without cell roles. */
  const unitCentre = (unit: number): [number, number] | null => {
    const found = manifest?.roles?.units?.find((item) => item.unit === unit);
    if (found) return [found.x, found.y];
    const group = manifest?.groups[unit];
    return group ? group.centroid : null;
  };
  /** A dot unit's own logic cells: the roles summary counts its registers with them (perUnit), the centroid without. */
  const unitLogic = (unit: number) => {
    const r = manifest?.roles;
    if (!r) return 0;
    return r.units?.find((item) => item.unit === unit)?.count ?? Math.max(0, (r.perUnit[unit] ?? 0) - (manifest?.groups[unit]?.count ?? 0));
  };
  /** A stored cell's dot unit (16: shared by several) and what it does in the pipeline, from the cell roles. */
  const roleOf = (inst: number): { unit: number | null; role: string | null } => {
    if (!roles || !manifest?.roles || inst < 0 || inst >= roles.unit.length) return { unit: null, role: null };
    const unit = roles.unit[inst];
    const kind = roles.kind[inst];
    const stage = kind >= 1 && kind <= 3 ? STAGE_TEXT[kind as 1 | 2 | 3] : null;
    const name = kind > 0 ? manifest.roles.kinds[kind] ?? null : null;
    return { unit: unit <= 16 ? unit : null, role: stage ? `${stage.title} logic: ${stage.does}, into ${stage.into}` : name ? capital(name) : null };
  };
  /** The loaded tile's chunk under a DBU point: the full one if resident, else the region one. */
  const chunkAt = (dx: number, dy: number, full = false) => {
    if (!manifest) return null;
    const size = manifest.tile.size;
    const key = tileKey(Math.floor((dx - manifest.die[0]) / size), Math.floor((dy - manifest.die[1]) / size));
    return resident.get(`tile:${key}`) ?? (full ? null : resident.get(`coarse:${key}`)) ?? null;
  };
  /** The logic cell under a DBU point, or nearest it within 3 µm, in the loaded tiles around it. */
  const cellNear = (dx: number, dy: number, full = false): { record: Resident; cell: ChunkCell } | null => {
    if (!manifest) return null;
    // A tile keeps the cells whose origin it holds, so a cell can reach into the tiles above and to its right.
    const size = manifest.tile.size;
    let found: { record: Resident; cell: ChunkCell } | null = null;
    let bestD = 3000;
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1], [1, 0], [0, 1]]) {
      const record = chunkAt(dx + ox * size, dy + oy * size, full);
      if (!record) continue;
      for (const cell of record.chunk.cells) {
        const m = manifest.macros[cell.macro];
        if (cell.inst < 0 || m.cls === 'fill' || m.cls === 'tap') continue;
        const d = Math.hypot(Math.max(cell.x - dx, 0, dx - cell.x - m.w), Math.max(cell.y - dy, 0, dy - cell.y - m.h));
        if (d < bestD) {
          bestD = d;
          found = { record, cell };
        }
      }
    }
    return found;
  };
  /** Which dot unit a point belongs to: its nearest cell's where tiles are loaded, else the nearest unit's logic. */
  const unitPhrase = (dx: number, dy: number) => {
    const near = roles ? cellNear(dx, dy) : null;
    if (near) {
      const { unit } = roleOf(near.cell.inst);
      if (unit !== null) return unit < 16 ? `In dot unit ${unitLabel(unit)}` : 'Logic shared by several dot units';
    }
    let best = -1;
    let bestD = Infinity;
    for (let unit = 0; unit < (manifest?.groups.length ?? 0); unit += 1) {
      const centre = unitCentre(unit);
      const d = centre ? Math.hypot(centre[0] - dx, centre[1] - dy) : Infinity;
      if (d < bestD) {
        bestD = d;
        best = unit;
      }
    }
    return best >= 0 && bestD < 450000 ? `Near dot unit ${unitLabel(best)}` : null;
  };
  const locationAt = (x: number, z: number) => {
    if (!manifest || !frame) return [] as string[];
    const dx = defX(frame, x);
    const dy = defY(frame, z);
    const out = ['AIMEM-A1 tensor tile'];
    const unit = unitPhrase(dx, dy);
    if (unit) out.push(unit);
    out.push(`x ${fmtUm(um(dx - manifest.die[0]))} µm · y ${fmtUm(um(dy - manifest.die[1]))} µm`);
    return out;
  };
  const titleOf = (what: number, net: number) => {
    const layer = whatLayer(what);
    const category = whatCategory(what);
    const supply = manifest && net === manifest.nets.vdd ? 'VDD' : manifest && net === manifest.nets.vss ? 'VSS' : null;
    switch (category) {
      case 'wire': return supply ? `${supply} ${LAYER_TEXT[layer].title.toLowerCase()}` : `${LAYER_TEXT[layer].title} wire`;
      case 'patch': return supply ? `${supply} via landing (${layer})` : `${LAYER_TEXT[layer].title} patch`;
      case 'pin': return `I/O pin (${layer})`;
      case 'rail': return `${supply ?? 'Supply'} rail (met1)`;
      case 'strap': return `${supply ?? 'Supply'} strap (${layer})`;
      case 'cut': return LAYER_TEXT[layer].title;
      case 'pad': return `${LAYER_TEXT[layer].title} via pad`;
      case 'stack-cut': return `${supply ?? 'Supply'} via stack · ${layer}`;
      case 'stack-pad': return `${supply ?? 'Supply'} via stack · ${layer} pad`;
      case 'footprint': return 'Placed cell';
      case 'device': return LAYER_TEXT[layer].title;
      case 'well': return 'N-well';
      default: return LAYER_TEXT[layer].title;
    }
  };
  const sizeOf = (sx: number, sy: number, sz: number) => `${formatLength(Math.max(sx, sz))} × ${formatLength(Math.min(sx, sz))} × ${formatLength(sy)} thick`;

  /** Which cell of a tile block holds a chunk's cell slot, and its signal pins' nets (read off the metal). */
  const cellOf = (record: Resident, slot: number): ChunkCell | null => record.chunk.cells[slot] ?? null;
  const cellPins = async (record: Resident, cell: ChunkCell): Promise<LayoutPin[]> => {
    if (!manifest || !library) return [];
    const m = manifest.macros[cell.macro];
    const lib = library.macros[cell.macro];
    // The pins' vias may sit in the neighbouring tile above or to the right.
    const keys = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => tileKey(record.block.ix + dx, record.block.iy + dy));
    const near = (await Promise.all(keys.map((k) => requestBlock(k, -1)))).filter((b): b is LayoutBlock => b !== null);
    const out: LayoutPin[] = [];
    for (const pin of m.signalPins) {
      const rects = placedPinRects(lib.pins, pin, m, cell.x, cell.y, cell.orient);
      let net = NO_NET;
      for (const block of near) {
        net = netOnRects(block, rects);
        if (net !== NO_NET) break;
      }
      out.push({ pin: m.pins[pin].name, dir: m.pins[pin].dir, cell: null, inst: null, net: net === NO_NET ? null : String(net), io: false });
    }
    // Names of the nets.
    await Promise.all(out.map((pin) => (pin.net === null ? null : netChunk(Number(pin.net)))));
    for (const pin of out) if (pin.net !== null) pin.net = netNameNow(Number(pin.net)) ?? `net ${pin.net}`;
    return out;
  };
  /** The net whose li1/met1 metal (a via pad or a wire) overlaps any of the given pin shapes in a block. */
  function netOnRects(block: LayoutBlock, rects: Array<[number, number, number, number, number]>): number {
    if (!manifest) return NO_NET;
    for (const [layer, x0, y0, x1, y1] of rects) {
      const r = block.rects;
      for (let k = 0; k < r.kind.length; k += 1) {
        if ((r.kind[k] & 31) !== layer || r.net[k] >= manifest.nets.vdd) continue;
        if (r.x0[k] < x1 && r.x1[k] > x0 && r.y0[k] < y1 && r.y1[k] > y0) return r.net[k];
      }
      const v = block.vias;
      for (let k = 0; k < v.def.length; k += 1) {
        if (v.net[k] >= manifest.nets.vdd) continue;
        const vx = v.x[k];
        const vy = v.y[k];
        if (vx < x0 - 2000 || vx > x1 + 2000 || vy < y0 - 2000 || vy > y1 + 2000) continue;
        for (const [l, a, b, c, dd] of manifest.vias[v.def[k]].rects) if (l === layer && vx + a < x1 && vx + c > x0 && vy + b < y1 && vy + dd > y0) return v.net[k];
      }
    }
    return NO_NET;
  }
  /** The pins a net joins, read off its metal in the tiles it spans: driver first. */
  async function netPins(net: number, tiles: number[]): Promise<{ pins: LayoutPin[] | null; note: string | null }> {
    if (!manifest || !library || tiles.length !== 4) return { pins: [], note: null };
    const [ix0, iy0, ix1, iy1] = tiles;
    const count = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
    if (count > NET_TILE_LIMIT) return { pins: null, note: `This net spans ${count} tiles; its pins are listed for nets of up to ${NET_TILE_LIMIT}.` };
    const keys: string[] = [];
    for (let iy = Math.max(0, iy0 - 1); iy <= iy1; iy += 1) for (let ix = Math.max(0, ix0 - 1); ix <= ix1; ix += 1) keys.push(tileKey(ix, iy));
    const found = (await Promise.all(keys.map((k) => requestBlock(k, -1)))).filter((b): b is LayoutBlock => b !== null);
    const netBlocks = found.filter((b) => b.ix >= ix0 && b.iy >= iy0);
    // The net's metal on li1 and met1 (where cell pins are), to find the cells it lands on.
    const landings: Array<[number, number, number, number]> = [];
    for (const block of netBlocks) {
      const v = block.vias;
      for (let k = 0; k < v.def.length; k += 1) if (v.net[k] === net && manifest.vias[v.def[k]].bottom === 'li1') landings.push([v.x[k] - 400, v.y[k] - 400, v.x[k] + 400, v.y[k] + 400]);
      const r = block.rects;
      for (let k = 0; k < r.kind.length; k += 1) if (r.net[k] === net && (r.kind[k] & 31) === LAYER.met1) landings.push([r.x0[k], r.y0[k], r.x1[k], r.y1[k]]);
    }
    const pins: Array<LayoutPin & { instId: number; out: boolean }> = [];
    for (const block of found) {
      for (let c = 0; c < block.cells.macro.length; c += 1) {
        const m = manifest.macros[block.cells.macro[c]];
        const x = block.cells.x[c];
        const y = block.cells.y[c];
        if (!landings.some(([a, b, cc, d]) => a < x + m.w && cc > x && b < y + m.h && d > y)) continue;
        const lib = library.macros[block.cells.macro[c]];
        for (const pin of m.signalPins) {
          const rects = placedPinRects(lib.pins, pin, m, x, y, block.cells.orient[c]);
          if (netBlocks.some((b) => netOnRectsFor(b, rects, net))) pins.push({ pin: m.pins[pin].name, dir: m.pins[pin].dir, cell: describeCell(m.name).title, inst: null, net: null, io: false, instId: block.firstInst + c, out: m.pins[pin].dir === 'output' });
        }
      }
    }
    await Promise.all(pins.map((pin) => instChunk(pin.instId)));
    for (const pin of pins) pin.inst = instNameNow(pin.instId);
    const io = manifest.ioPins.filter((pin) => pin.net === net).map((pin) => ({ pin: pin.name, dir: pin.dir, cell: null, inst: null, net: null, io: true }));
    const sorted = [...io.filter((pin) => pin.dir === 'input'), ...pins.sort((a, b) => Number(b.out) - Number(a.out)), ...io.filter((pin) => pin.dir !== 'input')];
    return { pins: sorted.map(({ pin, dir, cell, inst, net: n, io: isIo }) => ({ pin, dir, cell, inst, net: n, io: isIo })), note: null };
  }
  function netOnRectsFor(block: LayoutBlock, rects: Array<[number, number, number, number, number]>, net: number) {
    if (!manifest) return false;
    for (const [layer, x0, y0, x1, y1] of rects) {
      const v = block.vias;
      for (let k = 0; k < v.def.length; k += 1) {
        if (v.net[k] !== net) continue;
        for (const [l, a, b, c, d] of manifest.vias[v.def[k]].rects) if (l === layer && v.x[k] + a < x1 && v.x[k] + c > x0 && v.y[k] + b < y1 && v.y[k] + d > y0) return true;
      }
      const r = block.rects;
      for (let k = 0; k < r.kind.length; k += 1) if (r.net[k] === net && (r.kind[k] & 31) === layer && r.x0[k] < x1 && r.x1[k] > x0 && r.y0[k] < y1 && r.y1[k] > y0) return true;
    }
    return false;
  }

  // ------------------------------------------------ selection and outlines
  const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  disposables.push(boxEdges);
  const outline = (color: string, opacity: number, order: number) => {
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
    const line = new THREE.LineSegments(boxEdges, material);
    line.renderOrder = order;
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    disposables.push(material);
    return line;
  };
  const hoverLine = outline('#bfeaff', 0.5, 20);
  const selectLine = outline('#43d8ff', 1, 21);
  const netMaterial = new THREE.LineBasicMaterial({ color: '#7ef4ff', transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
  disposables.push(netMaterial);
  const netLine = new THREE.LineSegments(new THREE.BufferGeometry(), netMaterial);
  netLine.renderOrder = 19;
  netLine.frustumCulled = false;
  netLine.visible = false;
  scene.add(netLine);
  let netShown = true;
  let netPieces = 0;
  const EDGE_PAIRS = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
  function showNetBoxes(boxes: Array<[number, number, number, number, number, number]>) {
    const positions = new Float32Array(boxes.length * 24 * 3);
    let o = 0;
    for (const [x0, x1, y0, y1, z0, z1] of boxes) {
      for (const corner of EDGE_PAIRS) {
        positions[o] = corner & 1 ? x1 : x0;
        positions[o + 1] = corner & 2 ? y1 : y0;
        positions[o + 2] = corner & 4 ? z1 : z0;
        o += 3;
      }
    }
    netLine.geometry.dispose();
    netLine.geometry = new THREE.BufferGeometry();
    netLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    netPieces = boxes.length;
    netLine.visible = netShown && netPieces > 0;
  }
  const NET_COLORS: Record<LayoutNet['kind'], string> = { signal: '#7ef4ff', vdd: '#ffb066', vss: '#9dff80', clock: '#e79bff' };
  /** Every piece of a net in the given blocks, as scene boxes. */
  function netBoxes(net: number, list: LayoutBlock[]) {
    const out: Array<[number, number, number, number, number, number]> = [];
    if (!manifest || !frame) return out;
    const f = frame;
    const push = (layer: LayerId, x0: number, y0: number, x1: number, y1: number) => {
      const [z0, z1] = f.z[layer];
      out.push([sceneX(f, x0), sceneX(f, x1), z0, z1, sceneZ(f, y1), sceneZ(f, y0)]);
    };
    for (const block of list) {
      const r = block.rects;
      for (let k = 0; k < r.kind.length; k += 1) if (r.net[k] === net) push(whatLayer(r.kind[k] & 31), r.x0[k], r.y0[k], r.x1[k], r.y1[k]);
      const v = block.vias;
      for (let k = 0; k < v.def.length; k += 1) {
        if (v.net[k] !== net) continue;
        for (const [layer, a, b, c, d] of manifest.vias[v.def[k]].rects) push(whatLayer(layer), v.x[k] + a, v.y[k] + b, v.x[k] + c, v.y[k] + d);
      }
    }
    return out;
  }

  let selected: Target | null = null;
  let selectionToken = 0;
  const place = (line: THREE.LineSegments, target: Target | null) => {
    // A dot unit shows by its tint on the map (selected, the others fade back); labelled things by their box.
    const box = target?.kind === 'shape' ? null : target?.kind === 'info' ? target.box : null;
    if (!target || (target.kind !== 'shape' && !box)) {
      line.visible = false;
      return;
    }
    if (target.kind === 'shape') {
      const s = shapeOf(target);
      line.position.set(s.x, s.y, s.z);
      line.scale.set(s.sx, s.sy, s.sz);
    } else if (box) {
      line.position.set(box[0], box[1], box[2]);
      line.scale.set(box[3], box[4], box[5]);
    }
    line.scale.multiplyScalar(1.004);
    line.visible = true;
  };

  const selectionOf = (fields: Partial<Omit<LayoutSelection, 'key'>> & Pick<LayoutSelection, 'kind' | 'title'>): Omit<LayoutSelection, 'key'> => ({
    layer: '', role: '', material: '', size: '', location: ['AIMEM-A1 tensor tile'], notes: [], explain: null, net: null, cell: null, device: null, unit: null, ...fields,
  });
  const cellInfo = (cell: ChunkCell): LayoutCell => {
    const mf = manifest!;
    const m = mf.macros[cell.macro];
    const d = describeCell(m.name);
    const orient = ['N', 'S', 'E', 'W', 'FN', 'FS', 'FE', 'FW'][cell.orient];
    const row = Math.round((cell.y - mf.rows.y0) / mf.rows.height);
    const { unit, role } = roleOf(cell.inst);
    return { inst: cell.inst, name: instNameNow(cell.inst), macro: m.name, what: d.what, drive: d.drive, cls: m.cls, size: `${fmtUm(um(m.w))} × ${fmtUm(um(m.h))} µm`, place: `Row ${row.toLocaleString()} (${orient === 'N' ? 'upright' : orient === 'FS' ? 'flipped' : orient}), x ${fmtUm(um(cell.x - mf.die[0]))} µm`, pins: null, transistors: library?.macros[cell.macro].transistors ?? 0, unit, role };
  };
  /** A transistor of a cell: its type, size, and gate pin, from the library's channels (poly over diffusion). */
  const deviceOf = (cell: ChunkCell, index: number): LayoutDevice | null => {
    if (!manifest || !library) return null;
    const channels = library.macros[cell.macro].channels ?? [];
    const c = channels[index];
    if (!c) return null;
    const n = channels.filter((item) => item[0] === 0).length;
    return { type: c[0] ? 'PMOS' : 'NMOS', w: c[5] / 1000, l: c[6] / 1000, gate: c[7] >= 0 ? manifest.macros[cell.macro].pins[c[7]]?.name ?? null : null, count: { n, p: channels.length - n } };
  };
  /** The channel of a cell nearest a scene point (within 0.4 µm), placed as the DEF places the cell. */
  const channelAt = (cell: ChunkCell, point: THREE.Vector3): number => {
    if (!manifest || !library || !frame) return -1;
    const m = manifest.macros[cell.macro];
    const px = defX(frame, point.x) - cell.x;
    const py = defY(frame, point.z) - cell.y;
    let best = -1;
    let bestD = 400;
    (library.macros[cell.macro].channels ?? []).forEach((c, index) => {
      const [x0, y0, x1, y1] = placeRect(cell.orient, m.w, m.h, c[1], c[2], c[3], c[4]);
      const d = Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1));
      if (d < bestD) {
        bestD = d;
        best = index;
      }
    });
    return best;
  };
  /** A channel's box in the scene: over the diffusion, up to the top of the gate. */
  const channelBox = (cell: ChunkCell, index: number): Box | null => {
    const c = library?.macros[cell.macro].channels?.[index];
    if (!c || !manifest || !frame) return null;
    const m = manifest.macros[cell.macro];
    const [x0, y0, x1, y1] = placeRect(cell.orient, m.w, m.h, c[1], c[2], c[3], c[4]);
    const f = frame;
    const ax = sceneX(f, cell.x + x0);
    const bx = sceneX(f, cell.x + x1);
    const az = sceneZ(f, cell.y + y1);
    const bz = sceneZ(f, cell.y + y0);
    const lo = f.z.ndiff[0];
    const hi = f.z.poly[1];
    return [(ax + bx) / 2, (lo + hi) / 2, (az + bz) / 2, bx - ax, hi - lo, bz - az];
  };
  function deviceSelection(cell: ChunkCell, device: LayoutDevice, size: string, location: string[]): Omit<LayoutSelection, 'key'> {
    const m = manifest!.macros[cell.macro];
    const d = describeCell(m.name);
    const name = instNameNow(cell.inst);
    return selectionOf({
      kind: 'cell',
      title: `${device.type} transistor`,
      layer: `Inside ${name ?? d.title} (${d.title}: ${d.what})`,
      role: `${device.gate ? `Its gate is the cell's input pin ${device.gate}` : 'Its gate is a node inside the cell'}; W ${device.w.toFixed(2)} µm × L ${device.l.toFixed(2)} µm`,
      material: device.type === 'PMOS' ? 'P+ diffusion in the n-well under a polysilicon gate' : 'N+ diffusion in the p-type substrate under a polysilicon gate',
      size,
      location,
      notes: [`${d.title} has ${device.count.n} NMOS and ${device.count.p} PMOS transistors: the same types, sizes, and gate pins as the library netlist`],
      explain: TRANSISTOR_EXPLAIN,
      cell: cellInfo(cell),
      device,
    });
  }
  function unitSelection(unit: number, group: RegionGroup): Omit<LayoutSelection, 'key'> {
    const r = manifest?.roles;
    const logic = unitLogic(unit);
    const notes = [`${num(group.count)} flip-flops hold its product terms, partial sum, accumulators, and C/D element (bits assigned by the RTL's bus layout)`];
    if (r) {
      notes.push(`${num(logic)} logic cells in its three stages serve this unit alone, traced back from its registers through the netlist; ${num(r.counts.shared)} more are shared between units`);
      for (const item of r.stages.filter((stage) => stage.unit === unit)) {
        const text = STAGE_TEXT[item.stage as 1 | 2 | 3];
        if (text) notes.push(`${text.title}, ${text.does}: ${num(item.count)} cells`);
      }
    }
    return selectionOf({ kind: 'region', title: group.label, layer: 'Dot-product unit: one of the 4 × 4 tile\'s 16 outputs', role: group.detail, size: `${num(r?.perUnit[unit] ?? logic + group.count)} cells`, notes, unit: { index: unit, color: unitColor(unit), cells: logic, registers: group.count } });
  }
  function pathSelection(): Omit<LayoutSelection, 'key'> {
    const cp = manifest!.criticalPath!;
    const notes: string[] = [];
    if (pathData) {
      const slowest = [...pathData.data].sort((a, b) => b.delay - a.delay).slice(0, 5);
      for (const step of slowest) notes.push(`${step.inst}/${step.pin} (${step.cell.replace('sky130_fd_sc_hd__', '')}): +${step.delay.toFixed(2)} ns`);
    }
    notes.push('From the run\'s final static timing report; the line joins the pins in the order the signal passes them');
    const verdict = cp.slack < 0 ? `misses the ${cp.period} ns clock by ${(-cp.slack).toFixed(2)} ns` : `meets the ${cp.period} ns clock with ${cp.slack.toFixed(2)} ns to spare`;
    return selectionOf({ kind: 'region', title: 'Slowest path', layer: cp.stage, role: `From ${cp.startpoint} to ${cp.endpoint}: the data arrives at ${cp.arrival.toFixed(2)} ns and is needed by ${cp.required.toFixed(2)} ns, so it ${verdict}`, size: `${num(cp.cells)} cells, after ${cp.clockBuffers} clock buffers`, notes });
  }
  function clockSelection(): Omit<LayoutSelection, 'key'> {
    const tree = manifest!.clockTree!;
    const skew = manifest?.facts ? `; skew ${manifest.facts.timing.skewSetup.toFixed(2)} ns` : '';
    return selectionOf({ kind: 'region', title: 'Clock tree', layer: 'From the clk pin to every flip-flop', role: `${num(tree.nodes)} clock buffers and inverters, ${tree.levels} levels deep, deliver the clock to ${num(tree.flops)} flip-flops at nearly the same moment${skew}`, notes: ['Lines join each clock driver to the one driving it, coloured by depth; dots are the drivers', 'Built by the flow\'s clock-tree synthesis and read back from the routed DEF'] });
  }

  function describe(target: Target): LayoutSelection {
    if (target.kind === 'info') return { key: target.key, ...target.selection };
    if (target.kind === 'surface' || !manifest) {
      return { key: target.key, ...selectionOf({ kind: 'surface', title: 'Silicon substrate', layer: 'Substrate', role: 'The tile\'s silicon. From afar its surface shows the real layout\'s coverage: cells by kind, each routing layer\'s density, and the dot units by colour, per 2.5 µm pixel. Zoom in and the drawn geometry takes over.', material: 'Silicon', size: `${fmtUm(um(manifest ? manifest.die[2] - manifest.die[0] : 0))} µm square`, location: target.kind === 'surface' ? locationAt(target.point.x, target.point.z) : [] }) };
    }
    if (target.kind === 'region') return { key: target.key, ...unitSelection(target.unit, target.group) };
    const s = shapeOf(target);
    const layer = whatLayer(s.what);
    const category = whatCategory(s.what);
    const text = LAYER_TEXT[layer];
    const location = locationAt(s.x, s.z);
    const size = sizeOf(s.sx, s.sy, s.sz);
    if (category === 'footprint' || category === 'device') {
      const cell = cellOf(target.record, s.ref);
      if (!cell) return { key: target.key, ...selectionOf({ kind: 'surface', title: text.title, layer: text.title, role: text.role, material: text.material, size, location, explain: text.explain }) };
      const m = manifest.macros[cell.macro];
      const d = describeCell(m.name);
      const info = cellInfo(cell);
      if (category === 'device') {
        const channel = layer === 'poly' || layer === 'ndiff' || layer === 'pdiff' ? channelAt(cell, target.point ?? new THREE.Vector3(s.x, s.y, s.z)) : -1;
        const device = channel >= 0 ? deviceOf(cell, channel) : null;
        if (device) return { key: target.key, ...deviceSelection(cell, device, size, location) };
        const gate = layer === 'poly';
        return { key: target.key, ...selectionOf({ kind: 'cell', title: gate ? 'Polysilicon gate' : text.title, layer: `Inside ${d.title} (${d.what})`, role: text.role, material: text.material, size, location, notes: gate ? ['Where the poly crosses diffusion it is a transistor gate; elsewhere it links gates'] : [], explain: text.explain, cell: info }) };
      }
      return { key: target.key, ...selectionOf({ kind: 'cell', title: d.title, layer: CELL_CLASS_TEXT[m.cls].title, role: `${capital(d.what)}${d.drive ? `, ${d.drive}` : ''}`, material: 'SkyWater sky130_fd_sc_hd standard cell', size: info.size, location, notes: cell.inst < 0 ? ['Filler: rebuilt from the row gap it fills (checked against the DEF)'] : [], explain: CELL_EXPLAIN, cell: info }) };
    }
    // A conductor: its net.
    const net = s.ref;
    const kind = netKind(net);
    const info: LayoutNet = { id: net, name: netNameNow(net), kind, length: null, vias: null, layers: [], tiles: 0, pins: kind === 'vdd' || kind === 'vss' ? [] : null, note: kind === 'vdd' || kind === 'vss' ? 'The supply reaches every cell: met5 and met4 straps, a via stack at every strap-rail crossing, and a met1 rail along every row.' : null, pieces: 0 };
    return { key: target.key, ...selectionOf({ kind: 'net', title: titleOf(s.what, net), layer: text.title, role: category === 'rail' ? 'Carries the supply along the row boundary to every cell in the two rows it borders' : category === 'strap' ? 'Part of the tile\'s power grid' : category === 'pin' ? 'A port of the tile: where a signal enters or leaves the macro' : text.role, material: text.material, size, location, explain: text.explain, net: info }) };
  }

  /** Select a target; the net or cell details fill in as their data arrives. */
  function selectTarget(target: Target | null) {
    selected = target;
    if (overviewUniforms) overviewUniforms.uFocus.value = target?.kind === 'region' ? target.unit : -1;
    place(selectLine, target);
    if (target && hoverLine.visible) hoverLine.visible = false;
    annotations.setSelected(target?.key ?? null);
    showNetBoxes([]);
    const token = (selectionToken += 1);
    if (!target) {
      callbacks.onSelect(null);
      return;
    }
    const selection = describe(target);
    callbacks.onSelect(selection);
    const update = (next: LayoutSelection) => {
      if (token === selectionToken) callbacks.onSelect(next);
    };
    if (selection.net && manifest) {
      const net = selection.net.id;
      if (net < manifest.nets.vdd) {
        void netChunk(net).then(async (chunk) => {
          const k = net - chunk.first;
          const tiles = chunk.tiles[k] ?? [];
          const count = tiles.length === 4 ? (tiles[2] - tiles[0] + 1) * (tiles[3] - tiles[1] + 1) : 0;
          const layers = ROUTING_LAYERS.filter((_, index) => (chunk.layers[k] >> index) & 1);
          const base: LayoutNet = { ...selection.net!, name: chunk.names[k], kind: chunk.use[k] === 'c' ? 'clock' : 'signal', length: chunk.length[k], vias: chunk.vias[k], layers: [...layers], tiles: count };
          update({ ...selection, net: base });
          // Outline it, fetching its tiles when there are few enough.
          const keys: string[] = [];
          if (tiles.length === 4 && count <= NET_TILE_LIMIT) for (let iy = tiles[1]; iy <= tiles[3]; iy += 1) for (let ix = tiles[0]; ix <= tiles[2]; ix += 1) keys.push(tileKey(ix, iy));
          const list = keys.length > 0 ? (await Promise.all(keys.map((key) => requestBlock(key, -1)))).filter((b): b is LayoutBlock => b !== null) : [...resident.values()].filter((r) => r.level === 'tile').map((r) => r.block);
          if (token !== selectionToken) return;
          const boxes = netBoxes(net, list);
          netMaterial.color.set(NET_COLORS[base.kind]);
          showNetBoxes(boxes);
          const pins = await netPins(net, tiles);
          update({ ...selection, net: { ...base, pieces: boxes.length, pins: pins.pins, note: pins.note } });
        });
      }
    }
    if (selection.cell && target.kind === 'shape') {
      const cell = cellOf(target.record, shapeOf(target).ref);
      if (cell) {
        void (async () => {
          if (cell.inst >= 0) await instChunk(cell.inst);
          const pins = await cellPins(target.record, cell);
          update({ ...selection, cell: { ...selection.cell!, name: instNameNow(cell.inst), pins } });
        })();
      }
    }
  }

  // --------------------------------------------------------------- labels
  const annotations = createAnnotations(host);
  let labelMode: LabelMode = 'all';
  type Entry = { priority: number; title: string; detail: string; key: boolean; tone: Anchor['tone']; accent?: string; candidates: Array<{ point: THREE.Vector3; target: Target; check: (() => boolean) | null }> };
  const LABEL_PARTS: Record<LayoutStopId, Array<[string, LayerId | null]>> = {
    tile: [['strap', 'met5'], ['strap', 'met4']],
    region: [['wire', 'met4'], ['wire', 'met3'], ['wire', 'met2'], ['cut', 'via3'], ['strap', 'met4'], ['rail', 'met1'], ['footprint', null]],
    routing: [['wire', 'met3'], ['wire', 'met2'], ['wire', 'met1'], ['cut', 'via2'], ['cut', 'via'], ['cut', 'mcon'], ['rail', 'met1'], ['stack-cut', 'via3'], ['footprint', null]],
    cells: [['device', 'li1'], ['device', 'mcon'], ['cut', 'mcon'], ['wire', 'met1'], ['rail', 'met1'], ['device', 'met1']],
    devices: [['device', 'poly'], ['device', 'ndiff'], ['device', 'pdiff'], ['device', 'licon'], ['device', 'pcon'], ['well', 'nwell'], ['device', 'ntap'], ['device', 'ptap']],
  };
  const project = (p: THREE.Vector3): [number, number] | null => {
    scratch.copy(p).project(camera);
    if (scratch.z < -1 || scratch.z > 1 || Math.abs(scratch.x) > 0.96 || Math.abs(scratch.y) > 0.96) return null;
    return [((scratch.x + 1) / 2) * cssWidth, ((1 - scratch.y) / 2) * cssHeight];
  };
  const seen = (point: THREE.Vector3, key: string, tolerance: number) => {
    const direction = point.clone().sub(camera.position);
    const distance = direction.length();
    direction.divideScalar(distance);
    const hit = castRay(camera.position.clone(), direction, distance * (1 + 1e-6) + tolerance);
    return !hit || (hit.record !== null && `${hit.record.id}/${hit.batch}/${hit.index}` === key) || hit.t >= distance - tolerance;
  };
  function* plan(distance: number, keep: Set<string>): Generator<void, Anchor[]> {
    const entries: Entry[] = [];
    if (!manifest || !frame) return [];
    const f = frame;
    const mf = manifest;
    const above = !sectionOn && camera.position.y > f.z.met5[1];
    const far = stop.id === 'tile' || stop.id === 'region';
    // The 16 dot units from above, labelled where their logic sits, in their colour on the map.
    if (far && above) {
      mf.groups.forEach((g, unit) => {
        const centre = unitCentre(unit);
        if (!centre) return;
        const point = new THREE.Vector3(sceneX(f, centre[0]), f.z.met5[1], sceneZ(f, centre[1]));
        const logic = unitLogic(unit);
        entries.push({ priority: stop.id === 'tile' ? 3 : 2.4, title: g.label, detail: logic ? `${num(logic)} logic cells and ${num(g.count)} flip-flops` : g.detail, key: true, tone: 'region', accent: overlays.units ? unitColor(unit) : undefined, candidates: [{ point, target: { kind: 'region', key: `region/${g.id}`, group: g, unit }, check: null }] });
      });
    }
    // The I/O pins along each edge, at the tile stop.
    if (stop.id === 'tile' && above && mf.ioBuses) {
      for (const side of ['north', 'south', 'east', 'west'] as const) {
        const buses = mf.ioBuses.filter((bus) => bus.side === side);
        if (buses.length === 0) continue;
        const pins = buses.reduce((sum, bus) => sum + bus.count, 0);
        const from = Math.min(...buses.map((bus) => bus.from));
        const to = Math.max(...buses.map((bus) => bus.to));
        const mid = (from + to) / 2;
        const [x0, y0, x1, y1] = mf.die;
        const inset = 26000;
        const [px, py] = side === 'west' ? [x0 + inset, mid] : side === 'east' ? [x1 - inset, mid] : side === 'south' ? [mid, y0 + inset] : [mid, y1 - inset];
        const point = new THREE.Vector3(sceneX(f, px), overlayY(), sceneZ(f, py));
        const edge = capital(side);
        const selection = selectionOf({
          kind: 'region',
          title: `${edge} edge I/O pins`,
          layer: `The tile's ports on its ${side} edge`,
          role: 'Where the command buses enter the tile and the response leaves it: each pin a small rectangle of metal on the die edge, where the wiring of the chip around the tile connects',
          material: [...new Set(buses.flatMap((bus) => bus.layers))].join(' and '),
          size: `${num(pins)} pins over ${fmtUm(um(to - from))} µm`,
          location: ['AIMEM-A1 tensor tile', `${edge} edge`],
          notes: buses.map((bus) => `${bus.name}: ${num(bus.count)} ${bus.dir === 'output' ? 'outputs' : 'inputs'} on ${bus.layers.join(', ')}, ${fmtUm(um(bus.from))}–${fmtUm(um(bus.to))} µm along the edge`),
        });
        entries.push({ priority: 2.8, title: `${edge} I/O · ${num(pins)} pins`, detail: buses.map((bus) => `${bus.name} ${bus.count} ${bus.dir === 'output' ? 'out' : 'in'}`).join(' · '), key: true, tone: 'package', candidates: [{ point, target: { kind: 'info', key: `io/${side}`, selection, point, box: null, zoom: 0.5 }, check: null }] });
      }
    }
    // Each nearby unit's three stages at the region stop, where their cells' median sits.
    if (stop.id === 'region' && above && mf.roles) {
      for (const item of mf.roles.stages) {
        const text = STAGE_TEXT[item.stage as 1 | 2 | 3];
        if (!text) continue;
        const point = new THREE.Vector3(sceneX(f, item.x), f.z.met5[1], sceneZ(f, item.y));
        if (Math.hypot(point.x - orbit.x, point.z - orbit.z) > distance * 1.3) continue;
        const group = mf.groups[item.unit];
        const selection = selectionOf({
          kind: 'region',
          title: `${text.title} of dot unit ${unitLabel(item.unit)}`,
          layer: `Logic feeding ${text.into} (${text.does})`,
          role: `${num(item.count)} cells. The label marks their median position; the stage spreads around it among the unit's other logic, and the tile's wiring runs between them`,
          material: 'SkyWater sky130_fd_sc_hd standard cells',
          size: `${num(item.count)} cells`,
          location: ['AIMEM-A1 tensor tile', `Dot unit ${unitLabel(item.unit)}`],
          unit: group ? { index: item.unit, color: unitColor(item.unit), cells: unitLogic(item.unit), registers: group.count } : null,
        });
        entries.push({ priority: 2.3, title: `${unitLabel(item.unit)} · ${text.title}`, detail: `${text.does} · ${num(item.count)} cells`, key: false, tone: 'region', accent: overlays.units ? unitColor(item.unit) : undefined, candidates: [{ point, target: { kind: 'info', key: `stage/${item.unit}/${item.stage}`, selection, point, box: null, zoom: 0.2 }, check: null }] });
      }
    }
    // The clock tree's root while it is drawn.
    const clockData = clockTreeData;
    if (clockTree?.visible && clockData && mf.clockTree) {
      const point = new THREE.Vector3(sceneX(f, clockData.root[0]), overlayY(), sceneZ(f, clockData.root[1]));
      entries.push({ priority: 2.9, title: 'Clock input · clk', detail: `${num(mf.clockTree.nodes)} drivers in ${mf.clockTree.levels} levels to ${num(mf.clockTree.flops)} flip-flops`, key: true, tone: 'part', candidates: [{ point, target: { kind: 'info', key: 'clock/root', selection: clockSelection(), point, box: null, zoom: 0.5 }, check: null }] });
    }
    // Both ends of the slowest path while it is drawn.
    const path = pathData;
    if (overlays.path && pathGroup?.visible && path && mf.criticalPath && path.data.length > 1) {
      const cp = mf.criticalPath;
      const ends: Array<[string, string, LayoutPath['data'][number]]> = [
        [`Slowest path starts · ${cp.startpoint}`, `launched by the clock at ${path.data[0].time.toFixed(2)} ns`, path.data[0]],
        [`Slowest path ends · slack ${signedNs(cp.slack)}`, `${cp.endpoint}: arrives ${cp.arrival.toFixed(2)} ns, needed by ${cp.required.toFixed(2)} ns`, path.data[path.data.length - 1]],
      ];
      const selection = pathSelection();
      ends.forEach(([title, detail, step], index) => {
        const point = new THREE.Vector3(sceneX(f, step.x), overlayY() + 0.0012, sceneZ(f, step.y));
        entries.push({ priority: 3.2, title, detail, key: true, tone: 'part', candidates: [{ point, target: { kind: 'info', key: `path/${index}`, selection, point, box: null, zoom: 0.3 }, check: null }] });
      });
    }
    yield;
    // One visible example of each kind of structure this stop shows.
    const wanted = LABEL_PARTS[stop.id];
    const reach = distance * 3;
    const tx = orbit.x;
    const tz = orbit.z;
    const cells = new Map<string, { score: number; point: THREE.Vector3; target: Target; central: number }>();
    for (const record of resident.values()) {
      if (!levelVisible(record)) continue;
      const b = record.chunk.bounds;
      if (record.level !== 'global' && (b.x1 < tx - reach || b.x0 > tx + reach || b.z1 < tz - reach || b.z0 > tz + reach)) continue;
      record.chunk.batches.forEach((batch, bi) => {
        const d = batch.data;
        const [ox, , oz] = record.chunk.origin;
        for (let k = 0; k < batch.count; k += 1) {
          const what = batch.what[k];
          const category = whatCategory(what);
          const layer = whatLayer(what);
          const order = wanted.findIndex(([c, l]) => c === category && (l === null || l === layer));
          if (order < 0) continue;
          if (category === 'footprint' && record.level === 'tile' && !outlineVisible()) continue;
          const o = k * FLOATS_PER_INSTANCE;
          const cx = d[o] + ox;
          const cz = d[o + 2] + oz;
          const hx = d[o + 3] / 2;
          const hz = d[o + 5] / 2;
          if (Math.abs(cx - tx) > reach + hx || Math.abs(cz - tz) > reach + hz) continue;
          const point = new THREE.Vector3(clamp(tx, cx - hx * 0.7, cx + hx * 0.7), d[o + 1] + d[o + 4] / 2, clamp(tz, cz - hz * 0.7, cz + hz * 0.7));
          if (sectionPlane.distanceToPoint(point) < 0 || craterCleared(point.x, point.y, point.z)) continue;
          const screen = project(point);
          if (!screen) continue;
          const cell = `${order}:${Math.min(3, Math.floor((screen[0] / cssWidth) * 4))}:${Math.min(2, Math.floor((screen[1] / cssHeight) * 3))}`;
          const score = Math.hypot(((screen[0] / cssWidth) * 4) % 1 - 0.5, ((screen[1] / cssHeight) * 3) % 1 - 0.5);
          const current = cells.get(cell);
          if (current && current.score <= score) continue;
          cells.set(cell, { score, point, target: { kind: 'shape', key: `${record.id}/${bi}/${k}`, record, batch: bi, index: k }, central: Math.hypot(screen[0] / cssWidth - 0.5, screen[1] / cssHeight - 0.5) });
        }
      });
      yield;
    }
    wanted.forEach(([category, layer], order) => {
      const found = [...cells.entries()].filter(([cell]) => cell.startsWith(`${order}:`)).map(([, value]) => value);
      if (found.length === 0) return;
      found.sort((a, b) => Number(keep.has(b.target.key)) - Number(keep.has(a.target.key)) || a.central - b.central);
      const sample = found[0].target as Extract<Target, { kind: 'shape' }>;
      const s = shapeOf(sample);
      const title = category === 'footprint' ? 'Placed cells' : titleOf(s.what, s.ref);
      const detail = category === 'footprint' ? 'Cell outlines, coloured by kind' : layer ? LAYER_TEXT[layer].role : '';
      entries.push({ priority: 2.2 - order * 0.04, title, detail, key: order < 3, tone: 'part', candidates: found.map((candidate) => ({ point: candidate.point, target: candidate.target, check: () => seen(candidate.point, candidate.target.key, distance * 2e-5) })) });
    });
    // Cell names around the target at the cells stop.
    if (stop.id === 'cells' || stop.id === 'devices') {
      const near: Array<{ d: number; record: Resident; slot: number }> = [];
      for (const record of resident.values()) {
        if (record.level !== 'tile') continue;
        record.chunk.cells.forEach((cell, slot) => {
          if (cell.inst < 0) return;
          const m = mf.macros[cell.macro];
          if (m.cls === 'tap') return;
          const cx = sceneX(f, cell.x + m.w / 2);
          const cz = sceneZ(f, cell.y + m.h / 2);
          const dd = Math.hypot(cx - tx, cz - tz);
          if (dd < distance * 1.2) near.push({ d: dd, record, slot });
        });
      }
      near.sort((a, b) => a.d - b.d);
      for (const { record, slot } of near.slice(0, 14)) {
        const cell = record.chunk.cells[slot];
        const m = mf.macros[cell.macro];
        const name = instNameNow(cell.inst);
        if (name === null) void instChunk(cell.inst);
        const d = describeCell(m.name);
        const { unit, role } = roleOf(cell.inst);
        const point = new THREE.Vector3(sceneX(f, cell.x + m.w / 2), stop.id === 'cells' ? f.z.li1[1] : f.z.poly[1], sceneZ(f, cell.y + m.h / 2));
        // Only cells the view still shows: not cut away by the section or the delayering crater.
        if (sectionPlane.distanceToPoint(point) < 0 || craterCleared(point.x, point.y, point.z)) continue;
        // Pick the cell's outline for the label's target (it selects the cell).
        const batchIndex = record.chunk.batches.findIndex((batch) => batch.material === (m.cls === 'sequential' ? 'sequential' : m.cls === 'clock' || m.cls === 'buffer' ? 'clockcell' : m.cls === 'logic' ? 'logic' : 'physical'));
        const batch = record.chunk.batches[batchIndex];
        const index = batch ? batch.ref.indexOf(slot) : -1;
        if (index < 0) continue;
        const key = `${record.id}/${batchIndex}/${index}`;
        const detail = [d.what, unit !== null ? (unit < 16 ? `dot unit ${unitLabel(unit)}` : 'shared by several units') : null, role].filter(Boolean).join(' · ');
        entries.push({ priority: 2.6, title: name ? `${name} · ${d.title}` : d.title, detail, key: true, tone: 'region', accent: unit !== null && unit < 16 && overlays.units ? unitColor(unit) : undefined, candidates: [{ point, target: { kind: 'shape', key, record, batch: batchIndex, index }, check: () => seen(point, key, distance * 0.05) }] });
      }
    }
    // The transistors nearest the target: type, gate pin, and size, from each cell's channels.
    const lib = library;
    if (stop.id === 'devices' && lib) {
      const near: Array<{ d: number; record: Resident; slot: number; channel: number }> = [];
      for (const record of resident.values()) {
        if (record.level !== 'cells' || !levelVisible(record)) continue;
        record.chunk.cells.forEach((cell, slot) => {
          const m = mf.macros[cell.macro];
          (lib.macros[cell.macro].channels ?? []).forEach((c, channel) => {
            const [x0, y0, x1, y1] = placeRect(cell.orient, m.w, m.h, c[1], c[2], c[3], c[4]);
            const dd = Math.hypot(sceneX(f, cell.x + (x0 + x1) / 2) - tx, sceneZ(f, cell.y + (y0 + y1) / 2) - tz);
            if (dd < distance * 0.9) near.push({ d: dd, record, slot, channel });
          });
        });
        yield;
      }
      near.sort((a, b) => a.d - b.d);
      for (const { record, slot, channel } of near.slice(0, 10)) {
        const cell = record.chunk.cells[slot];
        const device = deviceOf(cell, channel);
        const box = channelBox(cell, channel);
        if (!device || !box) continue;
        const point = new THREE.Vector3(box[0], f.z.poly[1], box[2]);
        if (sectionPlane.distanceToPoint(point) < 0) continue;
        const d = describeCell(mf.macros[cell.macro].name);
        const name = instNameNow(cell.inst);
        const key = `device/${record.id}/${slot}/${channel}`;
        const selection = deviceSelection(cell, device, `Channel ${device.w.toFixed(2)} µm wide × ${device.l.toFixed(2)} µm long`, locationAt(box[0], box[2]));
        entries.push({ priority: 2.7, title: `${device.type} · ${device.gate ?? 'internal'}`, detail: `W ${device.w.toFixed(2)} × L ${device.l.toFixed(2)} µm in ${name ?? d.title} (${d.title})`, key: false, tone: 'part', candidates: [{ point, target: { kind: 'info', key, selection, point, box, zoom: 0.004 }, check: () => seen(point, key, distance * 0.05) }] });
      }
    }
    entries.sort((a, b) => b.priority - a.priority);
    const accepted: LabelBox[] = [];
    const anchors: Anchor[] = [];
    for (const entry of entries) {
      const width = annotations.widthOf(entry.title);
      for (const candidate of entry.candidates) {
        const screen = project(candidate.point);
        if (!screen) continue;
        const box = annotations.boxAt(screen[0], screen[1], width);
        if (annotations.blocked(box, cssWidth, cssHeight)) continue;
        if (accepted.some((other) => box[0] < other[2] + 4 && other[0] < box[2] + 4 && box[1] < other[3] + 3 && other[1] < box[3] + 3)) continue;
        if (candidate.check) {
          const visible = candidate.check();
          yield;
          if (!visible) continue;
        }
        accepted.push(box);
        const target = candidate.target;
        anchors.push({ id: target.key, title: entry.title, detail: entry.detail, world: candidate.point, priority: entry.priority, key: entry.key, tone: entry.tone, accent: entry.accent, targetKey: target.key, select: () => selectTarget(target) });
        break;
      }
    }
    return anchors;
  }
  function ruler(): RulerMark[] {
    if (!manifest || !frame) return [];
    const marks: RulerMark[] = [];
    const at = new THREE.Vector3(section.axis === 0 ? section.value : orbit.x, 0, section.axis === 2 ? section.value : orbit.z);
    const screenY = (y: number) => {
      scratch.set(at.x, y, at.z).project(camera);
      return scratch.z > 1 ? null : ((1 - scratch.y) / 2) * cssHeight;
    };
    const bands: Array<{ id: string; label: string; y0: number; y1: number }> = [
      { id: 'well', label: 'N-well', y0: frame.z.nwell[0], y1: frame.z.nwell[1] },
      { id: 'diff', label: 'Diffusion', y0: frame.z.ndiff[0], y1: frame.z.ndiff[1] },
      { id: 'poly', label: 'Poly', y0: frame.z.poly[0], y1: frame.z.poly[1] },
      { id: 'licon', label: 'licon', y0: frame.z.poly[1], y1: frame.z.licon[1] },
      ...(['li1', 'mcon', 'met1', 'via', 'met2', 'via2', 'met3', 'via3', 'met4', 'via4', 'met5'] as LayerId[]).map((id) => ({ id, label: id, y0: frame!.z[id][0], y1: frame!.z[id][1] })),
    ];
    for (const band of bands) {
      const top = screenY(band.y1);
      const bottom = screenY(band.y0);
      if (top === null || bottom === null) continue;
      if (Math.max(top, bottom) < 60 || Math.min(top, bottom) > cssHeight - 20) continue;
      marks.push({ id: band.id, label: band.label, top: Math.max(60, Math.min(top, bottom)), bottom: Math.min(cssHeight - 20, Math.max(top, bottom)) });
    }
    return marks.sort((a, b) => a.top - b.top);
  }

  // ---------------------------------------------------------- pointer
  const pointer = { inside: false, dragging: false, dirty: false, x: 0, y: 0, down: null as null | { x: number; y: number; at: number } };
  const ndcAt = (x: number, y: number) => new THREE.Vector2((x / cssWidth) * 2 - 1, -(y / cssHeight) * 2 + 1);
  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.inside = true;
    pointer.dragging = event.buttons !== 0;
    pointer.dirty = true;
  };
  const onPointerLeave = () => {
    pointer.inside = false;
    pointer.dirty = true;
  };
  const onCanvasDown = (event: PointerEvent) => {
    pointer.down = event.button === 0 ? { x: event.clientX, y: event.clientY, at: performance.now() } : null;
  };
  function clickAt(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const label = annotations.labelAt(x, y);
    if (label) annotations.activate(label);
    else selectTarget(pick(ndcAt(x, y)));
  }
  const onCanvasUp = (event: PointerEvent) => {
    const down = pointer.down;
    pointer.down = null;
    if (!down || event.button !== 0) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || performance.now() - down.at > 600) return;
    clickAt(event.clientX, event.clientY);
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointerup', onCanvasUp);

  let dragMode: DragMode = 'rotate';
  let pan: { pointerId: number; plane: THREE.Plane; grab: THREE.Vector3; x: number; y: number; moved: boolean } | null = null;
  const applyDragMode = () => {
    controls.mouseButtons = dragMode === 'pan'
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = dragMode === 'pan' ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    host.classList.toggle('pan-mode', dragMode === 'pan');
  };
  applyDragMode();
  const wantsPan = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || event.target !== canvas) return false;
    if (event.button === 1) return true;
    const modified = event.shiftKey || event.ctrlKey || event.metaKey;
    if (event.button === 0) return (dragMode === 'pan') !== modified;
    return event.button === 2 && dragMode === 'rotate';
  };
  function beginPan(event: PointerEvent) {
    if (pan || !wantsPan(event)) return;
    event.preventDefault();
    event.stopPropagation();
    zoomAnchor = null;
    const grab = pointUnder(clientNdc(event.clientX, event.clientY));
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const plane = Math.abs(forward.y) > 0.35 ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -grab.y) : new THREE.Plane().setFromNormalAndCoplanarPoint(forward.negate(), grab);
    pan = { pointerId: event.pointerId, plane, grab, x: event.clientX, y: event.clientY, moved: false };
    host.setPointerCapture(event.pointerId);
    document.addEventListener('pointermove', onPanMove);
    document.addEventListener('pointerup', onPanEnd);
    document.addEventListener('pointercancel', onPanEnd);
    host.classList.add('panning');
  }
  const onPanMove = (event: PointerEvent) => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    if (!pan.moved && Math.hypot(event.clientX - pan.x, event.clientY - pan.y) < 4) return;
    pan.moved = true;
    raycaster.setFromCamera(clientNdc(event.clientX, event.clientY), camera);
    const hit = raycaster.ray.intersectPlane(pan.plane, new THREE.Vector3());
    if (!hit) return;
    const delta = pan.grab.clone().sub(hit);
    const distance = camera.position.distanceTo(orbit);
    if (delta.length() > distance * 2) delta.setLength(distance * 2);
    camera.position.add(delta);
    orbit.add(delta);
    camera.updateMatrixWorld();
  };
  const endPan = () => {
    if (!pan) return;
    if (host.hasPointerCapture(pan.pointerId)) host.releasePointerCapture(pan.pointerId);
    document.removeEventListener('pointermove', onPanMove);
    document.removeEventListener('pointerup', onPanEnd);
    document.removeEventListener('pointercancel', onPanEnd);
    host.classList.remove('panning');
    pan = null;
  };
  const onPanEnd = (event: PointerEvent) => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const click = !pan.moved && event.type === 'pointerup' && event.button === 0;
    endPan();
    if (click) clickAt(event.clientX, event.clientY);
    else noteGesture();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== host) return;
    const zoom = event.key === '+' || event.key === '=' ? -0.5 : event.key === '-' || event.key === '_' ? 0.5 : 0;
    if (zoom !== 0) {
      cancelFlight();
      zoomAnchor = null;
      zoomImpulse += zoom;
      noteGesture();
    } else if (event.key === 'Escape' && selected) selectTarget(null);
    else return;
    event.preventDefault();
  };
  host.addEventListener('keydown', onKeyDown);

  // ------------------------------------------------------------ hover/labels
  let hoverAt = 0;
  let hoverText: [string, string] | null = null;
  let planner: Generator<void, Anchor[]> | null = null;
  let planAt = 0;
  let planStamp = '';
  let labelled = new Set<string>();
  let movedAt = 0;
  let labelsStale = true;
  let rulerStale = true;
  const lastCamera = new THREE.Matrix4();
  let lastSize = '';
  const hoverTitle = (target: Target | null): [string, string] | null => {
    if (!target || !manifest) return null;
    if (target.kind === 'surface') return ['Silicon substrate', 'Coverage of the real layout per 2.5 µm'];
    if (target.kind === 'region') return [target.group.label, `${num(unitLogic(target.unit))} logic cells · ${num(target.group.count)} flip-flops`];
    if (target.kind === 'info') return [target.selection.title, target.selection.layer];
    const s = shapeOf(target);
    const category = whatCategory(s.what);
    if (category === 'footprint' || category === 'device') {
      const cell = cellOf(target.record, s.ref);
      if (!cell) return [LAYER_TEXT[whatLayer(s.what)].title, ''];
      const d = describeCell(manifest.macros[cell.macro].name);
      const name = instNameNow(cell.inst);
      if (name === null && cell.inst >= 0) void instChunk(cell.inst);
      if (category === 'device') {
        const layer = whatLayer(s.what);
        const channel = (layer === 'poly' || layer === 'ndiff' || layer === 'pdiff') && target.point ? channelAt(cell, target.point) : -1;
        const device = channel >= 0 ? deviceOf(cell, channel) : null;
        if (device) return [`${device.type} transistor · gate ${device.gate ?? 'internal'}`, `W ${device.w.toFixed(2)} × L ${device.l.toFixed(2)} µm in ${name ?? d.title} (${d.title})`];
        return [LAYER_TEXT[layer].title, `in ${name ?? d.title} (${d.what})`];
      }
      const { unit, role } = roleOf(cell.inst);
      return [name ?? d.title, [d.title, role ?? d.what, unit !== null && unit < 16 ? unitLabel(unit) : null].filter(Boolean).join(' · ')];
    }
    const name = netNameNow(s.ref);
    if (name === null) void netChunk(s.ref);
    return [titleOf(s.what, s.ref), name ? `net ${name}` : LAYER_TEXT[whatLayer(s.what)].title];
  };
  function annotate(now: number, distance: number) {
    const size = `${cssWidth}x${cssHeight}`;
    const moved = !lastCamera.equals(camera.matrixWorld) || size !== lastSize;
    if (moved) {
      lastCamera.copy(camera.matrixWorld);
      lastSize = size;
      movedAt = now;
    }
    if (pointer.inside && !pointer.dragging && !flight && !pan) {
      if ((pointer.dirty || moved) && now > hoverAt) {
        hoverAt = now + 60;
        pointer.dirty = false;
        const label = annotations.labelAt(pointer.x, pointer.y);
        annotations.setHovered(label);
        host.classList.toggle('over-label', Boolean(label));
        if (label) {
          place(hoverLine, null);
          hoverText = [label.title, label.detail];
        } else {
          const target = pick(ndcAt(pointer.x, pointer.y));
          place(hoverLine, target && target.key !== selected?.key ? target : null);
          hoverText = hoverTitle(target);
        }
      }
      annotations.tooltip(hoverText?.[0] ?? null, hoverText?.[1], pointer.x, pointer.y);
    } else if (hoverText || pointer.dirty) {
      pointer.dirty = false;
      hoverText = null;
      place(hoverLine, null);
      annotations.setHovered(null);
      host.classList.remove('over-label');
      annotations.tooltip(null);
    }
    if (labelMode !== 'off') {
      const stamp = `${stop.id}|${sectionOn}|${view}|${size}`;
      if (planner && stamp !== planStamp) planner = null;
      if (!planner && (now > planAt || stamp !== planStamp)) {
        planStamp = stamp;
        planner = plan(distance, labelled);
      }
      if (planner) {
        const started = performance.now();
        let step = planner.next();
        while (!step.done && performance.now() - started < LABEL_BUDGET_MS) step = planner.next();
        if (step.done) {
          annotations.setAnchors(step.value);
          labelled = new Set(step.value.map((item) => item.targetKey));
          labelsStale = true;
          planner = null;
          planAt = now + (now - movedAt < 400 ? 250 : 1200);
        }
      }
    }
    if (moved || labelsStale) {
      labelsStale = false;
      annotations.update(camera, cssWidth, cssHeight);
    }
    if (sectionOn && (moved || rulerStale)) {
      rulerStale = false;
      annotations.setRuler(ruler());
    }
  }

  // ------------------------------------------------------------ section
  function capsFor(record: Resident) {
    const stamp = sectionOn ? `${sectionStamp}|${capEps}` : '';
    if (record.capStamp === stamp) return;
    if (record.caps) disposeGroup(record.caps);
    record.caps = null;
    record.capStamp = stamp;
    if (!sectionOn) return;
    const origin = section.axis === 0 ? record.chunk.origin[0] : record.chunk.origin[2];
    const v = section.value - origin;
    const other = section.axis === 0 ? 2 : 0;
    const batches: LayoutChunk['batches'] = [];
    for (const batch of record.chunk.batches) {
      const values: number[] = [];
      const refs: number[] = [];
      const whats: number[] = [];
      const d = batch.data;
      for (let k = 0; k < batch.count; k += 1) {
        const p = k * FLOATS_PER_INSTANCE;
        const c = d[p + section.axis];
        const half = d[p + 3 + section.axis] / 2;
        if (c - half >= v || c + half <= v) continue;
        const cap = [0, d[p + 1], 0, 0, d[p + 4], 0, d[p + 6], d[p + 7], d[p + 8] * 0.5, d[p + 9]];
        cap[section.axis] = v + section.keep * capEps;
        cap[other] = d[p + other];
        cap[3 + section.axis] = capEps;
        cap[3 + other] = d[p + 3 + other];
        values.push(...cap);
        refs.push(batch.ref[k]);
        whats.push(batch.what[k]);
      }
      if (refs.length > 0) batches.push({ material: batch.material, shape: 'box', data: new Float32Array(values), count: refs.length, ref: Int32Array.from(refs), what: Uint16Array.from(whats) });
    }
    if (batches.length === 0) return;
    record.caps = meshesFor(record.chunk, batches, record.level);
    levelGroups[record.level].add(record.caps);
  }
  function updateSection(distance: number) {
    if (!sectionOn) {
      sectionPlane.normal.set(0, 1, 0);
      sectionPlane.constant = 1e9;
      if (substrateCap) substrateCap.visible = false;
      return;
    }
    const forward = scratch.copy(orbit).sub(camera.position);
    const alongX = Math.abs(forward.x) > Math.abs(forward.z) * (section.axis === 0 ? 0.8 : 1.25);
    const axis: 0 | 2 = alongX ? 0 : 2;
    const keep: 1 | -1 = (alongX ? forward.x : forward.z) >= 0 ? 1 : -1;
    const at = axis === 0 ? orbit.x : orbit.z;
    const recut = axis !== section.axis || keep !== section.keep || Math.abs(at - section.value) > distance * 0.3;
    if (recut) section = { axis, keep, value: at };
    const eps = distance * 2e-6;
    if (recut || capEps === 0 || eps > capEps * 4 || eps < capEps / 4) capEps = eps;
    sectionPlane.normal.set(axis === 0 ? keep : 0, 0, axis === 2 ? keep : 0);
    sectionPlane.constant = -keep * section.value;
    const stamp = `${section.axis}:${section.keep}:${section.value}`;
    if (stamp !== sectionStamp) {
      sectionStamp = stamp;
      rulerStale = true;
    }
    placeSubstrateCap();
  }

  // ------------------------------------------------------------ streaming
  let pending = 0;
  let buildQueue: Array<{ id: string; level: Resident['level']; key: string; rank: number }> = [];
  function stream(now: number, distance: number) {
    if (!manifest || !ctx || !frame) return;
    const f = frame;
    const m = manifest;
    const { coarse, tile, cells: inside } = LAYOUT_ZOOM.lod;
    const coarseFade = lodFade(coarse, distance);
    const tileFade = lodFade(tile, distance);
    const cellFade = library ? lodFade(inside, distance) : 0;
    levelUniforms.coarse.uFade.value = coarseFade;
    levelUniforms.tile.uFade.value = tileFade;
    levelUniforms.cells.uFade.value = cellFade;
    levelUniforms.footprint.uFade.value = tileFade * (1 - cellFade);
    levelGroups.coarse.visible = coarseFade > 0;
    levelGroups.tile.visible = tileFade > 0;
    levelGroups.cells.visible = cellFade > 0;
    const globalVias = resident.get('global-vias');
    if (globalVias) globalVias.group.visible = distance < LAYOUT_ZOOM.lod.globalVias;
    const size = m.tile.size;
    const tx = defX(f, orbit.x);
    const ty = defY(f, orbit.z);
    const ti = Math.floor((tx - m.die[0]) / size);
    const tj = Math.floor((ty - m.die[1]) / size);
    type Want = { id: string; level: Resident['level']; key: string; rank: number };
    /** Tiles within `half` (mm) of the target, nearest first, at most `budget`. */
    const windowOf = (half: number, budget: number, level: Resident['level']): Want[] => {
      const r = half / MM_PER_NM;
      const i0 = Math.max(0, Math.floor((tx - r - m.die[0]) / size));
      const i1 = Math.min(m.tile.nx - 1, Math.floor((tx + r - m.die[0]) / size));
      const j0 = Math.max(0, Math.floor((ty - r - m.die[1]) / size));
      const j1 = Math.min(m.tile.ny - 1, Math.floor((ty + r - m.die[1]) / size));
      const list: Want[] = [];
      for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) {
        const key = tileKey(i, j);
        if (!tileBytes.has(key)) continue;
        list.push({ id: `${level}:${key}`, level, key, rank: Math.hypot(m.die[0] + (i + 0.5) * size - tx, m.die[1] + (j + 0.5) * size - ty) / size });
      }
      return list.sort((a, b) => a.rank - b.rank).slice(0, budget);
    };
    // Each tile shows once: every shape where the full level streams, upper routing and outlines in the ring beyond.
    const full = tileFade > 0 ? windowOf(lodWindow(tile, distance), budgetOf(tile), 'tile') : [];
    const fullKeys = new Set(full.map((item) => item.key));
    const ring = coarseFade > 0 ? windowOf(lodWindow(coarse, distance), budgetOf(coarse), 'coarse').filter((item) => !fullKeys.has(item.key)) : [];
    const cellsWanted = cellFade > 0 ? windowOf(lodWindow(inside, distance), budgetOf(inside), 'cells') : [];
    const wanted = [...cellsWanted, ...full, ...ring];
    const priority = (item: Want) => item.rank + (item.level === 'cells' ? 0 : item.level === 'tile' ? 0.5 : 1.5);
    for (const item of wanted) {
      const record = resident.get(item.id);
      if (record) record.lastWanted = now;
      else void requestBlock(item.key, priority(item));
    }
    // Tiles queued for a view that has moved on are dropped (a selection's own requests are kept).
    const keys = new Set(wanted.map((item) => item.key));
    for (let k = fetchQueue.length - 1; k >= 0; k -= 1) {
      const job = fetchQueue[k];
      if (job.priority >= 0 && !keys.has(job.key)) {
        fetchQueue.splice(k, 1);
        blockRequests.delete(job.key);
        job.resolve(null);
      }
    }
    buildQueue = wanted.filter((item) => !resident.has(item.id));
    // Build what has arrived, within the frame budget; cell interiors need the tile's cells first.
    const started = performance.now();
    pending = 0;
    for (const item of buildQueue) {
      const block = blocks.get(item.key) ?? resident.get(`tile:${item.key}`)?.block ?? resident.get(`coarse:${item.key}`)?.block;
      if (!block || performance.now() - started > BUILD_BUDGET_MS) {
        pending += 1;
        continue;
      }
      if (item.level === 'tile') addResident(item.id, 'tile', buildRoutingChunk(ctx, block, item.id, 'tile'), block, now);
      else if (item.level === 'coarse') addResident(item.id, 'coarse', buildCoarseChunk(ctx, block, item.id), block, now);
      else {
        const cells = resident.get(`tile:${item.key}`)?.chunk.cells ?? buildRoutingChunk(ctx, block, `tile:${item.key}`, 'tile').cells;
        addResident(item.id, 'cells', buildCellChunk(ctx, block, item.id, cells), block, now);
      }
    }
    // A region chunk stands down while its tile's full chunk is showing, so no shape is drawn twice.
    for (const record of resident.values()) {
      if (record.level !== 'coarse') continue;
      record.group.visible = !(tileFade > 0 && resident.has(`tile:${record.key}`));
    }
    for (const record of resident.values()) {
      if (record.level === 'global') continue;
      if (now - record.lastWanted > EVICT_AFTER_MS) {
        disposeGroup(record.group);
        if (record.caps) disposeGroup(record.caps);
        resident.delete(record.id);
      }
    }
    for (const record of resident.values()) {
      if (performance.now() - started > BUILD_BUDGET_MS * 1.6) break;
      capsFor(record);
    }
    // The density map gives way to bare silicon over the square of tiles that are fully loaded around the target.
    if (overviewUniforms) {
      let reach = -1;
      if (tileFade > 0) {
        for (let r = 0; r < 12; r += 1) {
          let whole = true;
          for (let j = tj - r; j <= tj + r && whole; j += 1) for (let i = ti - r; i <= ti + r; i += 1) {
            if (Math.max(Math.abs(i - ti), Math.abs(j - tj)) !== r) continue;
            const key = tileKey(i, j);
            if (i < 0 || j < 0 || i >= m.tile.nx || j >= m.tile.ny || !tileBytes.has(key)) continue;
            if (!resident.has(`tile:${key}`)) {
              whole = false;
              break;
            }
          }
          if (!whole) break;
          reach = r;
        }
      }
      if (reach < 0) overviewUniforms.uWindow.value.set(1, 1, -1, -1);
      else {
        const x0 = m.die[0] + (ti - reach) * size;
        const y0 = m.die[1] + (tj - reach) * size;
        const x1 = m.die[0] + (ti + reach + 1) * size;
        const y1 = m.die[1] + (tj + reach + 1) * size;
        overviewUniforms.uWindow.value.set(sceneX(f, x0), sceneZ(f, y1), sceneX(f, x1), sceneZ(f, y0));
      }
      overviewUniforms.uDetail.value = tileFade;
    }
  }

  // ---------------------------------------------------------- camera rules
  function constrain(dt: number) {
    const distance = camera.position.distanceTo(orbit);
    stop = stopFor(distance, stop.id);
    // The orbit target settles on the layer of the current stop while looking down;
    // from the side, where that would fight the user's own moves, it is left alone.
    const looking = camera.getWorldDirection(scratch);
    const focusY = sectionOn ? sectionFocusY : Math.abs(looking.y) > 0.35 ? stop.targetY : null;
    if (focusY !== null && !flight) {
      const dy = (focusY - orbit.y) * (1 - Math.exp(-dt * 6));
      orbit.y += dy;
      camera.position.y += dy;
    }
    if (manifest) {
      const hx = ((manifest.die[2] - manifest.die[0]) * MM_PER_NM) / 2;
      const hz = ((manifest.die[3] - manifest.die[1]) * MM_PER_NM) / 2;
      const cx = clamp(orbit.x, -hx - distance, hx + distance) - orbit.x;
      const cy = clamp(orbit.y, -0.03 - distance, 0.008 + distance) - orbit.y;
      const cz = clamp(orbit.z, -hz - distance, hz + distance) - orbit.z;
      orbit.x += cx;
      orbit.y += cy;
      orbit.z += cz;
      camera.position.x += cx;
      camera.position.y += cy;
      camera.position.z += cz;
    }
    const planes = clipPlanesFor(distance);
    camera.near = planes.near;
    camera.far = planes.far;
    camera.updateProjectionMatrix();
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    const floorTarget = stop.floor !== null && !sectionOn ? stop.floor : 1;
    craterFloor = Math.exp(THREE.MathUtils.lerp(Math.log(craterFloor), Math.log(floorTarget), 1 - Math.exp(-dt * 5)));
    shared.uCrater.value.set(orbit.x, orbit.z, craterFloor, distance * (Math.sin(spherical.phi) + 1.1));
    shared.uCraterOn.value = craterFloor < 0.9 ? 1 : 0;
    controls.screenSpacePanning = sectionOn;
    shared.uCull.value.set(camera.position.x, camera.position.y, camera.position.z, distance * CULL_FRACTION);
    view = camera.position.y >= 0 ? 'top' : 'underside';
    // From below, the silicon is lifted away so the transistors show from their backside.
    if (substrate) substrate.visible = view === 'top' || sectionOn;
    headlight.position.copy(camera.position);
    headlight.target.position.copy(orbit);
    headlight.intensity += ((sectionOn ? 0.35 : 0) - headlight.intensity) * (1 - Math.exp(-dt * 4));
    if (post?.bloom) post.bloom.strength += ((sectionOn ? bloomStrength * 0.55 : bloomStrength) - post.bloom.strength) * (1 - Math.exp(-dt * 4));
    return distance;
  }

  // --------------------------------------------------------------- details
  function factsDetails(m: LayoutManifest): LayoutDetails {
    const fa = m.facts;
    const sections: LayoutDetails['sections'] = [];
    const tile: Row[] = [{ label: 'Die', value: `${fmtUm(um(m.die[2] - m.die[0]))} × ${fmtUm(um(m.die[3] - m.die[1]))} µm` }];
    if (fa) tile.push({ label: 'Cell area', value: `${(fa.area.cells / 1e6).toFixed(2)} mm²`, hint: `${(fa.area.utilization * 100).toFixed(1)} % of the ${(fa.area.core / 1e6).toFixed(2)} mm² core` });
    tile.push(
      { label: 'Process', value: 'SkyWater SKY130 (130 nm)', hint: 'sky130_fd_sc_hd standard cells; li1 and five aluminium metal layers' },
      { label: 'Signal wiring', value: `${num(Object.values(m.stats.wire).reduce((a, b) => a + b, 0) / 1000)} mm`, hint: `${num(m.nets.signal)} signal nets, ${num(Object.values(m.stats.vias).reduce((a, b) => a + b, 0))} vias` },
    );
    sections.push({ title: 'Tile', rows: tile });
    if (fa) {
      sections.push({ title: 'Cells', rows: [...Object.entries(fa.counts.byClass).map(([label, value]) => ({ label, value: num(value) })), { label: 'All placed', value: num(fa.counts.all), hint: `${num(fa.counts.cells)} without the fillers` }] });
      sections.push({ title: 'Transistors', rows: [
        { label: 'In the layout', value: num(fa.transistors.gds), hint: 'Every cell\'s poly-over-diffusion channels, from the library layout (GDS)' },
        { label: 'In the netlist', value: num(fa.transistors.cdl), hint: 'The library\'s own transistor netlist (CDL) for the same cells' },
        { label: 'Cell types agreeing', value: `${fa.transistors.cellsMatching} of ${fa.transistors.cellTypes}`, hint: 'Same type, width, length, and gate pin, device for device' },
      ] });
    }
    if (m.roles) {
      const r = m.roles;
      sections.push({ title: 'Dot units (4 × 4)', rows: [
        { label: 'Logic per unit', value: `${num(Math.min(...r.perUnit.map((_, unit) => unitLogic(unit))))}–${num(Math.max(...r.perUnit.map((_, unit) => unitLogic(unit))))} cells`, hint: 'Traced back from each unit\'s registers through the netlist' },
        { label: 'Shared between units', value: num(r.counts.shared) },
        { label: 'Serving no unit', value: num(r.counts.none), hint: 'Control logic' },
        { label: 'Flip-flops', value: num(r.counts.registers) },
        ...r.perUnit.map((cells, unit) => ({ label: `Dot unit ${unitLabel(unit)}`, value: `${num(cells)} cells`, hint: `${num(unitLogic(unit))} logic, ${num(m.groups[unit]?.count ?? 0)} flip-flops`, swatch: unitColor(unit) })),
      ] });
    }
    if (fa) {
      const t = fa.timing;
      sections.push({ title: `Timing · ${fa.period} ns clock (${(1000 / fa.period).toFixed(0)} MHz)`, rows: [
        { label: 'Setup, worst slack', value: signedNs(t.setupWs), hint: `${num(t.setupViolations)} endpoints late, ${num(-t.setupTns)} ns in total` },
        { label: 'Fastest clock it meets', value: `${(t.fmax / 1e6).toFixed(1)} MHz` },
        { label: 'Hold, worst slack', value: signedNs(t.holdWs), hint: `${num(t.holdViolations)} violations` },
        { label: 'Clock skew', value: `${t.skewSetup.toFixed(2)} ns` },
        { label: 'Slew / load limits exceeded', value: `${num(t.maxSlewViolations)} / ${num(t.maxCapViolations)}` },
      ] });
    }
    if (m.criticalPath) {
      const cp = m.criticalPath;
      sections.push({ title: 'Slowest path', rows: [
        { label: 'From', value: cp.startpoint },
        { label: 'To', value: cp.endpoint },
        { label: 'Stage', value: cp.stage },
        { label: 'Arrives / needed', value: `${cp.arrival.toFixed(2)} / ${cp.required.toFixed(2)} ns` },
        { label: 'Slack', value: signedNs(cp.slack) },
        { label: 'Cells on it', value: num(cp.cells), hint: `After ${cp.clockBuffers} clock buffers. Show it with Slowest path.` },
      ] });
    }
    if (m.clockTree) sections.push({ title: 'Clock tree', rows: [
      { label: 'Drivers', value: num(m.clockTree.nodes), hint: 'Clock buffers and inverters' },
      { label: 'Levels', value: String(m.clockTree.levels) },
      { label: 'Flip-flops clocked', value: num(m.clockTree.flops) },
    ] });
    if (m.ioBuses) {
      const byName = new Map<string, { dir: string; count: number; sides: Set<string>; layers: Set<string> }>();
      for (const bus of m.ioBuses) {
        const entry = byName.get(bus.name) ?? { dir: bus.dir, count: 0, sides: new Set<string>(), layers: new Set<string>() };
        entry.count += bus.count;
        entry.sides.add(bus.side);
        for (const layer of bus.layers) entry.layers.add(layer);
        byName.set(bus.name, entry);
      }
      sections.push({ title: `I/O · ${num(m.stats.ioPins)} pins`, rows: [...byName.entries()].sort((a, b) => b[1].count - a[1].count).map(([name, entry]) => ({ label: name, value: `${num(entry.count)} ${entry.dir === 'output' ? 'out' : entry.dir === 'input' ? 'in' : entry.dir}`, hint: `${[...entry.sides].join(', ')} edges, on ${[...entry.layers].join(' and ')}` })) });
    }
    if (fa) {
      sections.push({ title: 'Power (OpenROAD estimate)', rows: [
        { label: 'Total', value: watts(fa.power.total), hint: `At the ${fa.period} ns clock` },
        { label: 'Switching', value: watts(fa.power.switching) },
        { label: 'Internal', value: watts(fa.power.internal) },
        { label: 'Leakage', value: watts(fa.power.leakage) },
      ] });
      sections.push({ title: 'Supply (IR) drop', rows: [
        { label: 'VDD, worst', value: millivolts(fa.ir.vddWorst), hint: `Average ${millivolts(fa.ir.vddAverage)}` },
        { label: 'VSS, worst', value: millivolts(fa.ir.vssWorst), hint: `Average ${millivolts(fa.ir.vssAverage)}` },
      ] });
      const signoff: Row[] = [];
      if (fa.drc) signoff.push({ label: 'DRC', value: `${num(fa.drc.count)} violations`, hint: fa.drc.source });
      if (fa.lvs) signoff.push({ label: 'LVS', value: fa.lvs.result, hint: `${num(fa.lvs.devices)} devices, ${num(fa.lvs.nets)} nets · ${fa.lvs.source}` });
      if (fa.lec) signoff.push({ label: 'Equivalence', value: fa.lec.result, hint: fa.lec.source });
      if (signoff.length) sections.push({ title: 'Signoff', rows: signoff });
    }
    return { stop: 'tile', title: m.title, subtitle: `${m.platform} · run ${m.run}`, sections };
  }
  function viewDetails(distance: number): LayoutDetails {
    const m = manifest!;
    const half = distance * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const aspect = cssWidth / Math.max(1, cssHeight);
    const rect = { x0: orbit.x - half * aspect, x1: orbit.x + half * aspect, z0: orbit.z - half, z1: orbit.z + half };
    const touches = (b: LayoutChunk['bounds']) => b.x1 >= rect.x0 && b.x0 <= rect.x1 && b.z1 >= rect.z0 && b.z0 <= rect.z1;
    // Each tile once: its full chunk where loaded, else its region chunk.
    const full = new Map<string, LayoutChunk>();
    const coarse: LayoutChunk[] = [];
    for (const record of resident.values()) if (record.level === 'tile' && levelGroups.tile.visible && touches(record.chunk.bounds)) full.set(record.key, record.chunk);
    for (const record of resident.values()) if (record.level === 'coarse' && levelGroups.coarse.visible && !full.has(record.key) && touches(record.chunk.bounds)) coarse.push(record.chunk);
    const chunks = [...full.values(), ...coarse];
    const stats = viewStats(chunks, rect, m, library, roles, m.roles?.kinds ?? []);
    const sections: LayoutDetails['sections'] = [];
    // What sits at the target itself, down to its transistors.
    if (stop.id === 'cells' || stop.id === 'devices') {
      const here = cellNear(defX(frame!, orbit.x), defY(frame!, orbit.z), true);
      if (here) {
        const cell = here.cell;
        const mm = m.macros[cell.macro];
        const d = describeCell(mm.name);
        const name = instNameNow(cell.inst);
        if (name === null) void instChunk(cell.inst);
        const { unit, role } = roleOf(cell.inst);
        const rows: Row[] = [{ label: 'Cell', value: name ?? '…', hint: `${d.title}: ${d.what}` }];
        if (unit !== null) rows.push({ label: 'Dot unit', value: unit < 16 ? unitLabel(unit) : 'Shared by several', swatch: unit < 16 ? unitColor(unit) : undefined });
        if (role) rows.push({ label: 'Role', value: role });
        const channels = library?.macros[cell.macro].channels ?? [];
        if (channels.length) {
          const n = channels.filter((c) => c[0] === 0).length;
          rows.push({ label: 'Transistors', value: `${n} NMOS + ${channels.length - n} PMOS`, hint: 'Checked against the library netlist' });
          if (stop.id === 'devices') {
            channels.slice(0, 16).forEach((c, index) => {
              const device = deviceOf(cell, index);
              if (device) rows.push({ label: `${device.type} · gate ${device.gate ?? 'internal'}`, value: `W ${device.w.toFixed(2)} × L ${device.l.toFixed(2)} µm` });
            });
            if (channels.length > 16) rows.push({ label: `${channels.length - 16} more`, value: '' });
          }
        }
        sections.push({ title: 'At the centre', rows });
      }
    }
    const cellRows: Row[] = [];
    for (const [cls, label] of [['logic', 'Logic gates'], ['sequential', 'Flip-flops'], ['buffer', 'Buffers'], ['clock', 'Clock-tree cells'], ['diode', 'Antenna diodes']] as const) {
      if (stats.cells[cls]) cellRows.push({ label, value: num(stats.cells[cls]), swatch: CELL_CLASS_TEXT[cls].swatch });
    }
    if (stats.transistors > 0) cellRows.push({ label: 'Transistors', value: num(stats.transistors) });
    if (cellRows.length) sections.push({ title: 'Cells', rows: cellRows });
    if (roles) {
      const ranked = stats.units.slice(0, 16).map((cells, unit) => ({ unit, cells })).filter((item) => item.cells > 0).sort((a, b) => b.cells - a.cells);
      const rows: Row[] = ranked.slice(0, 6).map(({ unit, cells }) => ({ label: `Dot unit ${unitLabel(unit)}`, value: num(cells), swatch: unitColor(unit) }));
      if (ranked.length > 6) rows.push({ label: `${ranked.length - 6} more units`, value: num(ranked.slice(6).reduce((sum, item) => sum + item.cells, 0)) });
      if (stats.units[16]) rows.push({ label: 'Shared between units', value: num(stats.units[16]) });
      if (stats.units[17]) rows.push({ label: 'Operands, control, and clock', value: num(stats.units[17]) });
      if (rows.length) sections.push({ title: 'Dot units', rows });
      const stages: Row[] = [];
      for (const k of [1, 2, 3] as const) if (stats.stages[k - 1] > 0) stages.push({ label: `${STAGE_TEXT[k].title} · ${STAGE_TEXT[k].does}`, value: num(stats.stages[k - 1]) });
      if (stages.length) sections.push({ title: 'Pipeline stages (logic cells)', rows: stages });
      const registers: Row[] = Object.entries(stats.registers).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ label: `${capital(name)}s`, value: num(value) }));
      if (registers.length) sections.push({ title: 'Registers', rows: registers });
    } else if (m.roles) sections.push({ title: 'Dot units', rows: [{ label: 'Loading the cell roles…', value: '' }] });
    const wires: Row[] = ROUTING_LAYERS.filter((layer) => stats.wire[layer]).map((layer) => ({ label: `${layer} wire`, value: `${num(stats.wire[layer])} µm` }));
    const vias = Object.values(stats.vias).reduce((a, b) => a + b, 0);
    if (vias) wires.push({ label: 'Vias', value: num(vias), hint: Object.entries(stats.vias).map(([layer, value]) => `${layer} ${num(value)}`).join(' · ') });
    if (stats.nets) wires.push({ label: 'Signal nets', value: num(stats.nets) });
    if (coarse.length) wires.push({ label: 'li1–met2 and the vias', value: 'Closer in', hint: 'From here the view draws met3–met5; every shape loads at the Routing stop' });
    if (wires.length) sections.push({ title: 'Routing', rows: wires });
    const w = (rect.x1 - rect.x0) * 1000;
    const h = (rect.z1 - rect.z0) * 1000;
    return { stop: stop.id, title: 'In view', subtitle: `About ${fmtUm(w)} × ${fmtUm(h)} µm around the centre · ${chunks.length} tile${chunks.length === 1 ? '' : 's'} counted`, sections };
  }
  let detailsAt = 0;
  let detailsInput = '';
  let detailsSent = '';
  function emitDetails(now: number, distance: number) {
    if (!manifest || !frame || now < detailsAt) return;
    detailsAt = now + 500;
    const input = stop.id === 'tile' ? `tile|${roles ? 1 : 0}` : `${stop.id}|${orbit.x.toFixed(5)}|${orbit.z.toFixed(5)}|${distance.toFixed(5)}|${resident.size}|${pending}|${roles ? 1 : 0}|${cssWidth}x${cssHeight}`;
    if (input === detailsInput) return;
    detailsInput = input;
    const details = stop.id === 'tile' ? factsDetails(manifest) : viewDetails(distance);
    const sent = JSON.stringify(details);
    if (sent === detailsSent) return;
    detailsSent = sent;
    callbacks.onDetails(details);
  }

  // ----------------------------------------------------------------- loop
  const startTime = performance.now();
  let last = startTime;
  let frameEma = 16.7;
  const frameWindow: number[] = [];
  let hudAt = 0;
  let adaptAt = startTime + 2500;
  let raisedBlockedUntil = 0;
  let readySent = false;
  let raf = 0;
  const frameLoop = (now: number) => {
    raf = window.requestAnimationFrame(frameLoop);
    if (contextLost || !post) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    frameEma += ((now - last) - frameEma) * 0.08;
    frameWindow.push(now - last);
    last = now;
    shared.uTime.value = (now - startTime) / 1000;
    post.finish.uniforms.uTime.value = shared.uTime.value;
    if (flight) stepFlight(now);
    else {
      if (Math.abs(zoomImpulse) > 1e-5) {
        const step = zoomImpulse * (1 - Math.exp(-dt * 12));
        zoomImpulse -= step;
        zoomAbout(Math.exp(step));
      }
      controls.update(dt);
    }
    const distance = constrain(dt);
    updateSection(distance);
    stream(now, distance);
    updateOverlays(distance);
    renderer.info.reset();
    post.composer.render(dt);
    annotate(now, distance);
    if (!readySent) {
      readySent = true;
      callbacks.onReady();
    }
    if (now > adaptAt) {
      adaptAt = now + 1000;
      const median = frameWindow.sort((a, b) => a - b)[Math.floor(frameWindow.length / 2)] ?? 16.7;
      frameWindow.length = 0;
      if (median > 19.5 && dpr > dprRange.min) {
        dpr = Math.max(dprRange.min, dpr - 0.15);
        raisedBlockedUntil = now + 10000;
        applySize();
      } else if (median < 17.2 && dpr < dprRange.max && now > raisedBlockedUntil) {
        dpr = Math.min(dprRange.max, dpr + 0.1);
        applySize();
      }
    }
    if (now > hudAt) {
      hudAt = now + 250;
      let instances = 0;
      let chunks = 0;
      for (const record of resident.values()) {
        if (!levelGroups[record.level].visible || !record.group.visible) continue;
        instances += record.chunk.instances;
        if (record.level !== 'global') chunks += 1;
      }
      const mmPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / cssHeight;
      const bar = scaleBar(mmPerPx, 110);
      emitDetails(now, distance);
      callbacks.onHud({ stop, location: locationAt(orbit.x, orbit.z), scale: { label: bar.label, px: bar.px }, distance, fps: 1000 / Math.max(1, frameEma), frameMs: frameEma, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, instances, chunks, pending: pending + fetchQueue.length + inFlight, bytes: bytesLoaded, dpr, gpu: gpu.name, software: gpu.software, view });
    }
  };

  // ------------------------------------------------------------ staged build
  // Each step runs in a task of its own, so the click that opened the view
  // finishes at once and leaving mid-build stops at the next step.
  let disposed = false;
  const nextTask = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  async function build() {
    await nextTask();
    if (disposed) return;
    const environment = createStudioEnvironment(renderer);
    disposables.push(environment);
    scene.environment = environment.texture;
    const loaded = await fetchBytes(`${base}manifest.json`);
    if (disposed) return;
    bytesLoaded += loaded.length;
    const m = JSON.parse(new TextDecoder().decode(loaded)) as LayoutManifest;
    manifest = m;
    frame = frameOf(m);
    for (const entry of m.tile.entries) tileBytes.set(tileKey(entry.ix, entry.iy), entry.bytes);
    callbacks.onManifest(m);
    const f = frame;
    const hx = ((m.die[2] - m.die[0]) * MM_PER_NM) / 2;
    const below = Object.fromEntries(LAYOUT_ZOOM.stops.map((item) => [item.id, item.below])) as Record<LayoutStopId, number>;
    stops = [
      { id: 'tile', label: 'A1 tile', layer: 'The 16 dot units, the I/O pins, and the met5/met4 power grid', below: below.tile, targetY: f.z.met5[1], floor: null },
      { id: 'region', label: 'Region', layer: 'met3–met5 signal routing over the placed cells', below: below.region, targetY: f.z.met4[1], floor: null },
      { id: 'routing', label: 'Routing', layer: 'Every wire and via on met1–met3, the power straps delayered', below: below.routing, targetY: f.z.met2[1], floor: f.z.met3[1] + 0.00002 },
      { id: 'cells', label: 'Standard cells', layer: 'li1 and met1 inside the cells, upper metal delayered', below: below.cells, targetY: f.z.li1[1], floor: f.z.met1[1] + 0.00001 },
      { id: 'devices', label: 'Transistors', layer: 'Diffusion, poly gates, and contacts (metal and li1 delayered)', below: below.devices, targetY: f.z.poly[1], floor: f.z.li1[0] - 0.0000005 },
    ];
    const at = (p: { x: number; y: number }) => ({ x: sceneX(f, p.x), z: sceneZ(f, p.y) });
    const ladder = LAYOUT_ZOOM.presets;
    presets.set('tile', { x: 0, z: 0, distance: hx * 3.4, polar: 0.62, azimuth: 0.4 });
    presets.set('region', { ...at(m.heroes.region), distance: ladder.region, polar: 0.78, azimuth: 0.55 });
    presets.set('routing', { ...at(m.heroes.routing), distance: ladder.routing, polar: 0.8, azimuth: 0.6 });
    presets.set('cells', { ...at(m.heroes.cells), distance: ladder.cells, polar: 0.82, azimuth: 0.7 });
    presets.set('devices', { ...at(m.heroes.devices), distance: ladder.devices, polar: 0.9, azimuth: 0.78 });
    const first = presets.get('tile')!;
    orbit.set(first.x, f.z.met5[1], first.z);
    camera.position.copy(orbit).add(new THREE.Vector3().setFromSphericalCoords(first.distance, first.polar, first.azimuth));
    controls.update();
    stop = stops[0];
    await nextTask();
    if (disposed) return;
    const [globalBytes, libBytes] = await Promise.all([loadBytes('global.bin.gz'), loadBytes('lib.json.gz')]);
    if (disposed) return;
    library = JSON.parse(new TextDecoder().decode(libBytes)) as LayoutLibrary;
    const globalBlock = decodeBlock(globalBytes);
    ctx = { manifest: m, frame: f, library, clockNets: new Set(m.nets.clockIds), straps: strapsOf(globalBlock) };
    // Which unit and stage each cell serves: optional, and not needed for the first frame.
    if (m.roles) {
      void loadBytes(m.roles.file).then((bytes) => {
        if (disposed) return;
        roles = decodeRoles(bytes);
        planAt = 0;
      }).catch(() => undefined);
    }
    await nextTask();
    if (disposed) return;
    addResident('global', 'global', buildRoutingChunk(ctx, globalBlock, 'global', 'global', 'rects'), globalBlock, performance.now());
    addResident('global-vias', 'global', buildRoutingChunk(ctx, globalBlock, 'global-vias', 'global', 'vias'), globalBlock, performance.now());
    const loader = new THREE.TextureLoader();
    const unitsFile = m.unitsOverview?.file;
    const [metal, cells, units] = await Promise.all([
      loader.loadAsync(`${base}${m.overview.files.metal}`),
      loader.loadAsync(`${base}${m.overview.files.cells}`),
      unitsFile ? loader.loadAsync(`${base}${unitsFile}`).catch(() => null) : Promise.resolve(null),
    ]);
    if (disposed) {
      metal.dispose();
      cells.dispose();
      units?.dispose();
      return;
    }
    for (const texture of [metal, cells]) {
      texture.colorSpace = THREE.NoColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      texture.generateMipmaps = true;
    }
    if (units) {
      // One index per pixel: read back exactly, never blended between units.
      units.colorSpace = THREE.NoColorSpace;
      units.magFilter = THREE.NearestFilter;
      units.minFilter = THREE.NearestFilter;
      units.generateMipmaps = false;
    }
    buildSubstrate(metal, cells, units);
    buildIoBars();
    await nextTask();
    if (disposed) return;
    post = createPost();
    applySize();
    const programs = renderer.compile(scene, camera);
    await nextTask();
    if (disposed) return;
    const programOf = (material: THREE.Material) => (renderer.properties.get(material) as { currentProgram?: { isReady: () => boolean; getUniforms: () => unknown } }).currentProgram;
    if (renderer.extensions.has('KHR_parallel_shader_compile')) {
      for (let tries = 0; tries < 300; tries += 1) {
        let compiling = 0;
        for (const material of programs) if (programOf(material)?.isReady() === false) compiling += 1;
        if (compiling === 0) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
        if (disposed) return;
      }
    } else {
      for (const material of programs) {
        programOf(material)?.getUniforms();
        await nextTask();
        if (disposed) return;
      }
    }
    last = performance.now();
    adaptAt = last + 2500;
    raf = window.requestAnimationFrame(frameLoop);
  }
  build().catch((reason: unknown) => {
    if (!disposed) callbacks.onError(`The A1 layout failed to load: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  // ------------------------------------------------------------------- API
  return {
    flyTo(id) {
      const preset = presets.get(id);
      if (!preset || !frame) return;
      if (!sectionOn) {
        flyTo(preset);
        return;
      }
      flyTo({ ...preset, polar: 1.36, azimuth: sectionAzimuth() });
      sectionFocusY = stopFor(preset.distance, stop.id).targetY;
    },
    setFlows(flows) {
      shared.uGlowGain.value = flows.data ? 1 : 0;
      shared.uFlowGain.value.set(flows.data ? 1 : 0, flows.power ? 1 : 0, flows.power ? 1 : 0, flows.clock ? 1 : 0);
      // The clock flow also draws the clock tree from afar.
      clockShown = flows.clock;
      planAt = 0;
    },
    setOverlays(next) {
      overlays = { ...next };
      planAt = 0;
      detailsInput = '';
    },
    setNetShown(on) {
      netShown = on;
      netLine.visible = on && netPieces > 0;
    },
    setBloom(on) {
      bloomEnabled = on;
      if (post?.bloom) post.bloom.enabled = on;
    },
    setSection(on) {
      if (sectionOn === on) return;
      sectionOn = on;
      sectionStamp = '';
      capEps = 0;
      planAt = 0;
      rulerStale = true;
      if (!on) annotations.setRuler(null);
      const distance = camera.position.distanceTo(orbit);
      updateSection(distance);
      if (on) {
        flyTo({ x: orbit.x, z: orbit.z, distance, polar: 1.36, azimuth: sectionAzimuth() });
        sectionFocusY = stop.targetY;
      } else {
        sectionFocusY = null;
        for (const record of resident.values()) capsFor(record);
      }
    },
    setAutoRotate(on) {
      controls.autoRotate = on;
    },
    setDragMode(mode) {
      dragMode = mode;
      applyDragMode();
    },
    setLabelMode(mode) {
      labelMode = mode;
      annotations.setMode(mode);
      labelsStale = true;
      planAt = 0;
    },
    clearSelection() {
      selectTarget(null);
    },
    zoomToSelection() {
      const target = selected;
      if (!target || !frame) return;
      spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
      if (target.kind === 'shape') {
        const s = shapeOf(target);
        flyTo({ x: s.x, z: s.z, y: s.y, distance: clamp(Math.max(s.sx, s.sz, s.sy) * 3, MIN_DISTANCE * 3, 6), polar: spherical.phi, azimuth: spherical.theta });
      } else if (target.kind === 'region') {
        const centre = unitCentre(target.unit);
        if (centre) flyTo({ x: sceneX(frame, centre[0]), z: sceneZ(frame, centre[1]), distance: LAYOUT_ZOOM.presets.region * 1.4, polar: spherical.phi, azimuth: spherical.theta });
      } else if (target.kind === 'info') {
        flyTo({ x: target.point.x, z: target.point.z, y: target.point.y, distance: target.zoom, polar: spherical.phi, azimuth: spherical.theta });
      } else flyTo({ x: target.point.x, z: target.point.z, distance: camera.position.distanceTo(orbit) * 0.3, polar: spherical.phi, azimuth: spherical.theta });
    },
    dispose() {
      // Everything the page can see stops now; the GPU teardown (which software GL can take
      // seconds over) runs in a task of its own, so the click that closed the view returns at once.
      disposed = true;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(gestureTimer);
      observer.disconnect();
      host.removeEventListener('wheel', onWheel, { capture: true });
      canvas.removeEventListener('dblclick', onDoubleClick);
      host.removeEventListener('pointerdown', onPointerDown, { capture: true });
      canvas.removeEventListener('webglcontextlost', onContextLost);
      controls.removeEventListener('end', onControlsEnd);
      controls.removeEventListener('start', onControlsStart);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onCanvasDown);
      canvas.removeEventListener('pointerup', onCanvasUp);
      host.removeEventListener('keydown', onKeyDown);
      endPan();
      controls.dispose();
      planner = null;
      annotations.dispose();
      canvas.remove();
      window.setTimeout(() => {
        for (const record of resident.values()) {
          disposeGroup(record.group);
          if (record.caps) disposeGroup(record.caps);
        }
        resident.clear();
        blocks.clear();
        for (const line of [hoverLine, selectLine, netLine]) line.removeFromParent();
        netLine.geometry.dispose();
        for (const item of disposables) item.dispose();
        if (post) {
          for (const pass of post.composer.passes) pass.dispose();
          post.composer.dispose();
          post.target.dispose();
        }
        renderer.dispose();
        renderer.forceContextLoss();
      }, 0);
    },
  };
}

