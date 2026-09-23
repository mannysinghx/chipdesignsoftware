import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CONNECTOR_SAMPLING, PACKAGE_GEOMETRY, SCENE_MM_PER_UNIT, STACK_PLACEMENTS } from '@/lib/package-connectors';
import {
  DIE, FLOATS_PER_INSTANCE, LEVELS, MATERIAL_KEYS, PRESETS, STACK_MAX,
  chunkId, clipPlanesFor, craterFor, describeLocation, focusStopFor, generateChunk, generateGlobal, levelFade, scaleBar, sectionCaps, snapSection, windowChunks, zoomPanPath,
  type Batch, type ChunkData, type ChunkKey, type FocusStop, type MaterialKey, type SectionPlane,
} from '@/lib/silicon-macro';
import { PARTS, type PartId } from '@/lib/silicon-parts';
import { createAnnotations, type Anchor, type LabelMode } from './annotations';
import { createDieTextures, createStackSideTexture } from './die-texture';
import { createInspector, describeTarget, type SiliconSelection, type StaticAnchor, type Target } from './inspector';
import { FinishShader, createBackdrop, createChipMaterial, createDieSurfaceMaterial, createDieUniforms, createSharedUniforms, createStudioEnvironment, type DieUniforms, type LevelUniforms } from './materials';

export type { LabelMode } from './annotations';
export type { SiliconSelection } from './inspector';

/** What a plain left-drag (or one-finger drag) does; the other stays one button away. */
export type DragMode = 'rotate' | 'pan';

export type SiliconHud = {
  stop: FocusStop;
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
  dpr: number;
  gpu: string;
  software: boolean;
  /** From above, from below the package, or from below at chip zoom (package hidden). */
  view: 'top' | 'underside' | 'backside';
};

export type SiliconEngineCallbacks = {
  onHud: (hud: SiliconHud) => void;
  onReady: () => void;
  onError: (message: string) => void;
  onCameraGesture: (details: Record<string, unknown>) => void;
  onSelect: (selection: SiliconSelection | null) => void;
};

export type SiliconEngine = {
  flyTo: (presetId: string) => void;
  setGlow: (on: boolean) => void;
  setBloom: (on: boolean) => void;
  setSection: (on: boolean) => void;
  setAutoRotate: (on: boolean) => void;
  setLabelMode: (mode: LabelMode) => void;
  setDragMode: (mode: DragMode) => void;
  clearSelection: () => void;
  zoomToSelection: () => void;
  dispose: () => void;
};

const MIN_DISTANCE = 0.00022;
const MAX_DISTANCE = 240;
const FOV = 34;
// The orbit is unrestricted: all the way round, over the top, and underneath.
// Flights stop just short of the poles, where the azimuth is undefined.
const POLAR_MARGIN = 0.02;
// Chip geometry nearer the camera than this fraction of the orbit distance is
// cut away, so orbiting through the stack never slices wires at the near plane.
const CULL_FRACTION = 0.12;
// Seen from below at tile zoom or closer, the package hides and the circuitry
// shows from its backside, as when imaging through the silicon in infrared.
const BACKSIDE_WITHIN = 6;
// Label placement work per frame; it continues over the next frames.
const LABEL_BUDGET_MS = 1.2;
// Above every structure: the crater floor rests here when no stop needs one.
const FLOOR_OFF = STACK_MAX * 3;
const GENERATION_BUDGET_MS = 5;
const EVICT_AFTER_MS = 1200;
const MM = SCENE_MM_PER_UNIT;
// The view roams freely: anywhere over the package plus a view's width
// beyond it, from below the BGA balls to above the bumps.
const ROAM_X = (PACKAGE_GEOMETRY.substrate.width * MM) / 2;
const ROAM_Z = (PACKAGE_GEOMETRY.substrate.depth * MM) / 2;
const ROAM_FLOOR = -3;
// Where a cross-section centres vertically at each stop (mm): the metal
// stack above the surface and the trenches, rails, and TSVs below it.
const SECTION_FOCUS_Y: Record<FocusStop['id'], number> = { package: 0, die: 0, tile: 0, block: -0.015, routing: 0.0005, cells: 0, devices: -0.00005 };

type Resident = {
  id: string;
  level: number;
  data: ChunkData;
  group: THREE.Group;
  capGroup: THREE.Group | null;
  capStamp: string;
  lastWanted: number;
  instances: number;
};

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

function detectGpu(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return { name, software: /swiftshader|llvmpipe|software|basic render/i.test(name) };
}

export function createSiliconEngine(host: HTMLElement, callbacks: SiliconEngineCallbacks): SiliconEngine {
  // ------------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    throw new Error('WebGL 2 is required for the silicon macro view.');
  }
  const gpu = detectGpu(renderer);
  const hdrTargets = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // At 1.0 the brightest metal reflections stay below white instead of clipping.
  renderer.toneMappingExposure = 1.0;
  renderer.info.autoReset = false;
  const deviceRatio = Math.min(window.devicePixelRatio || 1, 2);
  const dprRange = gpu.software ? { min: 0.5, max: 0.6 } : { min: 0.75, max: Math.max(1, deviceRatio) };
  let dpr = gpu.software ? 0.6 : Math.min(deviceRatio, 1.6);
  renderer.setPixelRatio(dpr);
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  // Section plane; kept at infinity while the cross-section is off, so no
  // shader ever recompiles when it toggles.
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9);
  renderer.clippingPlanes = [sectionPlane];

  // --------------------------------------------------------------- scene
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose: () => void }> = [];
  const backdrop = createBackdrop();
  disposables.push(backdrop);
  scene.background = backdrop;

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  // Kept low: flat metal mirrors a strong key straight into the lens at some angles.
  const key = new THREE.DirectionalLight('#fff3e4', 0.55);
  key.position.set(-4.5, 10, 3.5);
  scene.add(key);
  // Coaxial headlight, as on a microscope: a little light on cut metal faces
  // in the cross-section (set per frame in constrain()).
  const headlight = new THREE.DirectionalLight('#f4f7ff', 0);
  scene.add(headlight, headlight.target);

  const shared = createSharedUniforms();
  const levelUniforms: LevelUniforms[] = LEVELS.map((level) => ({ uFade: { value: level.id === 0 ? 1 : 0 }, uPulsePeriod: { value: level.pulse.period }, uPulseRate: { value: level.pulse.speed / level.pulse.period } }));
  const levelMaterials = LEVELS.map((level) => Object.fromEntries(MATERIAL_KEYS.map((key) => [key, createChipMaterial(key, shared, levelUniforms[level.id])])) as Record<MaterialKey, THREE.MeshStandardMaterial>);
  for (const set of levelMaterials) disposables.push(...Object.values(set));

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1, false);
  disposables.push(unitBox, unitCylinder);

  // ------------------------------------------------------ die and package
  // Built in its own task by build(); section caps read staticBoxes.
  const staticBoxes: Array<{ rect: [number, number, number, number]; y: [number, number]; section: THREE.Material; part: PartId }> = [];
  // Package meshes that hover, selection, and labels can name (userData.part).
  const staticMeshes: THREE.Object3D[] = [];
  const packageAnchors: StaticAnchor[] = [];
  let bgaMesh: THREE.InstancedMesh | null = null;
  let substrateBottom = -Infinity;
  let dieUniforms: DieUniforms | null = null;
  function buildDieAndPackage() {
    const maxTexture = Math.min(renderer.capabilities.maxTextureSize, gpu.software ? 2048 : 4096);
    const textures = createDieTextures(maxTexture, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    disposables.push(textures.albedo, textures.roughnessMetal, textures.activity);
    const surfaceUniforms = createDieUniforms(textures.activity);
    dieUniforms = surfaceUniforms;
    const dieTop = createDieSurfaceMaterial(textures.albedo, textures.roughnessMetal, shared, surfaceUniforms, gpu.software);
    // Software GL links every program on the main thread: package parts use
    // the standard shader there instead of clearcoat and iridescence.
    const packageMaterial = (options: THREE.MeshPhysicalMaterialParameters) => {
      if (!gpu.software) return new THREE.MeshPhysicalMaterial(options);
      const { color, metalness, roughness } = options;
      return new THREE.MeshStandardMaterial({ color, metalness, roughness });
    };
    const siliconSide = new THREE.MeshStandardMaterial({ color: '#16181d', metalness: 0.35, roughness: 0.38 });
    const sectionSilicon = new THREE.MeshStandardMaterial({ color: '#5d636d', metalness: 0.3, roughness: 0.46 });
    const interposerMaterial = packageMaterial({ color: '#1a1d23', metalness: 0.45, roughness: 0.3, clearcoat: 0.45, clearcoatRoughness: 0.2, iridescence: 0.25, iridescenceThicknessRange: [300, 600] });
    const stackSide = createStackSideTexture();
    disposables.push(stackSide);
    const stackSideMaterial = new THREE.MeshStandardMaterial({ map: stackSide, metalness: 0.2, roughness: 0.55 });
    // Thinned-silicon backside on the stacks: near-black and glossy.
    const stackTopMaterial = packageMaterial({ color: '#0b0c0f', metalness: 0.35, roughness: 0.32, clearcoat: 0.4, clearcoatRoughness: 0.25 });
    const substrateMaterial = packageMaterial({ color: '#08110c', metalness: 0.05, roughness: 0.42, clearcoat: 0.75, clearcoatRoughness: 0.2 });
    const capBodyMaterial = new THREE.MeshStandardMaterial({ color: '#3a3027', metalness: 0.05, roughness: 0.5 });
    const capEndMaterial = new THREE.MeshStandardMaterial({ color: '#c8c8cc', metalness: 1, roughness: 0.32 });
    disposables.push(dieTop, siliconSide, sectionSilicon, interposerMaterial, stackSideMaterial, stackTopMaterial, substrateMaterial, capBodyMaterial, capEndMaterial);

    const dieGeometry = new THREE.BoxGeometry(DIE.width, DIE.thickness, DIE.depth);
    // World-space UVs on the top face (group 2 = +y) so the textures register to die millimetres.
    {
      const position = dieGeometry.getAttribute('position');
      const uv = dieGeometry.getAttribute('uv');
      const group = dieGeometry.groups[2];
      for (let k = group.start; k < group.start + group.count; k += 1) {
        const vertex = dieGeometry.index ? dieGeometry.index.getX(k) : k;
        uv.setXY(vertex, (position.getX(vertex) + DIE.width / 2) / DIE.width, (position.getZ(vertex) + DIE.depth / 2) / DIE.depth);
      }
      uv.needsUpdate = true;
    }
    disposables.push(dieGeometry);
    const dieMesh = new THREE.Mesh(dieGeometry, [siliconSide, siliconSide, dieTop, siliconSide, siliconSide, siliconSide]);
    dieMesh.position.y = -DIE.thickness / 2;
    dieMesh.userData.part = 'die';
    scene.add(dieMesh);
    staticMeshes.push(dieMesh);
    const anchor = (part: PartId, object: THREE.Object3D, x: number, y: number, z: number, box = new THREE.Box3().setFromObject(object)) => {
      packageAnchors.push({ part, object, point: new THREE.Vector3(x, y, z), box });
    };
    anchor('die', dieMesh, DIE.width * 0.18, 0, -DIE.depth * 0.12);

    const addBox = (width: number, depth: number, y0: number, y1: number, x: number, z: number, material: THREE.Material | THREE.Material[], section: THREE.Material, part: PartId) => {
      const geometry = new THREE.BoxGeometry(width, y1 - y0, depth);
      disposables.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, (y0 + y1) / 2, z);
      mesh.userData.part = part;
      scene.add(mesh);
      staticMeshes.push(mesh);
      staticBoxes.push({ rect: [x - width / 2, z - depth / 2, x + width / 2, z + depth / 2], y: [y0, y1], section, part });
      return mesh;
    };
    staticBoxes.push({ rect: [-DIE.width / 2, -DIE.depth / 2, DIE.width / 2, DIE.depth / 2], y: [-DIE.thickness, 0], section: sectionSilicon, part: 'die-section' });
    const interposerTop = -DIE.thickness - 0.02;
    const interposerWidth = PACKAGE_GEOMETRY.interposer.width * MM;
    const interposerDepth = PACKAGE_GEOMETRY.interposer.depth * MM;
    const interposer = addBox(interposerWidth, interposerDepth, interposerTop - 0.1, interposerTop, 0, 0, interposerMaterial, sectionSilicon, 'interposer');
    for (const [x, z] of [[interposerWidth / 2 - 2.5, 0], [-interposerWidth / 2 + 2.5, 0], [0, interposerDepth / 2 - 2.5], [0, -interposerDepth / 2 + 2.5]]) anchor('interposer', interposer, x, interposerTop, z);
    const stackSize = PACKAGE_GEOMETRY.dramTier.size * MM;
    for (const placement of STACK_PLACEMENTS) {
      const stack = addBox(stackSize, stackSize, interposerTop, 0.02, placement.x * MM, placement.z * MM, [stackSideMaterial, stackSideMaterial, stackTopMaterial, stackSideMaterial, stackSideMaterial, stackSideMaterial], stackSideMaterial, 'hbm');
      anchor('hbm', stack, placement.x * MM, 0.02, placement.z * MM);
    }
    const substrateTop = interposerTop - 0.1 - 0.09;
    const substrateWidth = PACKAGE_GEOMETRY.substrate.width * MM;
    const substrateDepth = PACKAGE_GEOMETRY.substrate.depth * MM;
    const substrate = addBox(substrateWidth, substrateDepth, substrateTop - 1.1, substrateTop, 0, 0, substrateMaterial, substrateMaterial, 'substrate');
    for (const [x, z] of [[substrateWidth / 2 - 3.5, 0], [-substrateWidth / 2 + 3.5, 0], [0, substrateDepth / 2 - 3.5], [0, -substrateDepth / 2 + 3.5]]) anchor('substrate', substrate, x, substrateTop, z);
    substrateBottom = substrateTop - 1.1;
    {
      // Die-side decoupling capacitors (0402) around the interposer.
      const bodies: THREE.Matrix4[] = [];
      const ends: THREE.Matrix4[] = [];
      const halfW = (PACKAGE_GEOMETRY.interposer.width * MM) / 2 + 3.2;
      const halfD = (PACKAGE_GEOMETRY.interposer.depth * MM) / 2 + 3.2;
      const place = (x: number, z: number, rotate: boolean) => {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotate ? Math.PI / 2 : 0);
        bodies.push(new THREE.Matrix4().compose(new THREE.Vector3(x, substrateTop + 0.25, z), q, new THREE.Vector3(0.62, 0.5, 0.5)));
        for (const side of [-1, 1]) {
          const offset = new THREE.Vector3(side * 0.4, 0, 0).applyQuaternion(q);
          ends.push(new THREE.Matrix4().compose(new THREE.Vector3(x + offset.x, substrateTop + 0.25, z + offset.z), q, new THREE.Vector3(0.2, 0.52, 0.52)));
        }
      };
      for (let k = -8; k <= 8; k += 1) {
        place(k * 3.6, -halfD, false);
        place(k * 3.6, halfD, false);
      }
      for (let k = -7; k <= 7; k += 1) {
        place(-halfW, k * 3.8, true);
        place(halfW, k * 3.8, true);
      }
      const bodyMesh = new THREE.InstancedMesh(unitBox, capBodyMaterial, bodies.length);
      bodies.forEach((matrix, index) => bodyMesh.setMatrixAt(index, matrix));
      const endMesh = new THREE.InstancedMesh(unitBox, capEndMaterial, ends.length);
      ends.forEach((matrix, index) => endMesh.setMatrixAt(index, matrix));
      bodyMesh.userData.part = 'capacitor';
      endMesh.userData.part = 'capacitor';
      scene.add(bodyMesh, endMesh);
      staticMeshes.push(bodyMesh, endMesh);
      for (const index of [8, 25, 40, 58]) {
        const position = new THREE.Vector3().setFromMatrixPosition(bodies[index]);
        anchor('capacitor', bodyMesh, position.x, substrateTop + 0.5, position.z, new THREE.Box3().setFromCenterAndSize(position, new THREE.Vector3(1.1, 0.5, 1.1)));
      }
    }
    {
      // BGA balls under the substrate, at the 3D twin's sampled pitch; drawn
      // only while the camera is below the package.
      const { columns, rows, pitch } = CONNECTOR_SAMPLING.bga;
      const radius = PACKAGE_GEOMETRY.bga.radius * MM;
      const ballGeometry = new THREE.IcosahedronGeometry(1, 2);
      const ballMaterial = new THREE.MeshStandardMaterial({ color: '#b9babf', metalness: 1, roughness: 0.4 });
      disposables.push(ballGeometry, ballMaterial);
      const balls = new THREE.InstancedMesh(ballGeometry, ballMaterial, columns * rows);
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3(radius, radius * 0.85, radius);
      const rotation = new THREE.Quaternion();
      let index = 0;
      for (let i = 0; i < columns; i += 1) for (let j = 0; j < rows; j += 1) {
        const x = (i - (columns - 1) / 2) * pitch * MM;
        const z = (j - (rows - 1) / 2) * pitch * MM;
        balls.setMatrixAt(index, matrix.compose(new THREE.Vector3(x, substrateBottom - radius * 0.7, z), rotation, scale));
        index += 1;
        if ((i === 4 || i === 12) && (j === 3 || j === 11)) {
          const center = new THREE.Vector3(x, substrateBottom - radius * 0.7, z);
          anchor('bga', balls, x, substrateBottom - radius * 1.5, z, new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(radius * 2, radius * 1.7, radius * 2)));
        }
      }
      balls.userData.part = 'bga';
      balls.visible = false;
      scene.add(balls);
      staticMeshes.push(balls);
      bgaMesh = balls;
    }
    return textures;
  }

  // --------------------------------------------------------- chunk meshes
  const levelGroups = LEVELS.map(() => {
    const group = new THREE.Group();
    scene.add(group);
    return group;
  });

  function instancedGeometry(batch: Batch, data: ChunkData) {
    const base = batch.shape === 'box' ? unitBox : unitCylinder;
    const geometry = new THREE.InstancedBufferGeometry();
    // Each chunk owns copies of the unit mesh: disposing a geometry frees
    // every buffer it references, so sharing them would pull buffers out from
    // under the chunks that remain.
    geometry.setIndex(base.index!.clone());
    geometry.setAttribute('position', base.getAttribute('position').clone());
    geometry.setAttribute('normal', base.getAttribute('normal').clone());
    const buffer = new THREE.InstancedInterleavedBuffer(batch.data, FLOATS_PER_INSTANCE);
    geometry.setAttribute('iOffset', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('iScale', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
    geometry.setAttribute('iData', new THREE.InterleavedBufferAttribute(buffer, 4, 6));
    geometry.instanceCount = batch.count;
    const hx = (data.bounds.x1 - data.bounds.x0) / 2;
    const hz = (data.bounds.z1 - data.bounds.z0) / 2;
    const margin = Math.max(hx, hz) * 0.08;
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-hx - margin, data.yMin, -hz - margin), new THREE.Vector3(hx + margin, data.yMax, hz + margin));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    return geometry;
  }

  function meshesFor(data: ChunkData, batches: Batch[], materials: Record<MaterialKey, THREE.MeshStandardMaterial>) {
    const group = new THREE.Group();
    group.position.set(data.origin[0], 0, data.origin[2]);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    for (const batch of batches) {
      if (batch.count === 0) continue;
      const mesh = new THREE.Mesh(instancedGeometry(batch, data), materials[batch.material]);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    return group;
  }

  function disposeGroup(group: THREE.Group) {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    group.removeFromParent();
  }

  const resident = new Map<string, Resident>();
  const dataCache = new Map<string, ChunkData>();
  const cacheData = (id: string, data: ChunkData) => {
    dataCache.delete(id);
    dataCache.set(id, data);
    while (dataCache.size > 600) dataCache.delete(dataCache.keys().next().value as string);
  };

  function addResident(id: string, level: number, data: ChunkData, now: number) {
    const group = meshesFor(data, data.batches, levelMaterials[level]);
    levelGroups[level].add(group);
    resident.set(id, { id, level, data, group, capGroup: null, capStamp: '', lastWanted: now, instances: data.instances });
  }

  // ------------------------------------------------------------ post stack
  // Subtle: only the data pulses cross the threshold, not metal reflections.
  const bloomStrength = 0.3;
  let bloomEnabled = true;
  let post: { composer: EffectComposer; bloom: UnrealBloomPass | null; finish: ShaderPass; target: THREE.WebGLRenderTarget } | null = null;
  function createPost() {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: hdrTargets ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: gpu.software ? 0 : 4 });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    // Bloom's blur chain is seven programs; software GL goes without it.
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
  controls.screenSpacePanning = false;
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;
  controls.autoRotateSpeed = 0.35;
  // Pinches zoom toward the fingers (the mouse wheel is handled below), and
  // the arrow keys move the view once it has keyboard focus.
  controls.zoomToCursor = true;
  controls.keyPanSpeed = 24;
  controls.listenToKeyEvents(host);
  const orbit = controls.target;
  const initial = PRESETS.find((preset) => preset.id === 'die') ?? PRESETS[0];
  orbit.set(initial.x, 0, initial.z);
  camera.position.copy(orbit).add(new THREE.Vector3().setFromSphericalCoords(initial.distance, initial.polar, initial.azimuth));
  controls.update();

  // ------------------------------------------------------------- state
  let stop: FocusStop = focusStopFor(initial.distance);
  let craterFloor = FLOOR_OFF;
  let sectionOn = false;
  let section: SectionPlane = { axis: 0, value: 0, keep: 1 };
  let sectionStamp = '';
  let capEps = 0;
  let staticCapsEps = -1;
  let zoomImpulse = 0;
  const raycaster = new THREE.Raycaster();
  const scratch = new THREE.Vector3();
  const spherical = new THREE.Spherical();
  let flight: null | { start: number; duration: number; path: ReturnType<typeof zoomPanPath>; polar: [number, number]; azimuth: [number, number]; height: [number, number] | null } = null;
  let view: SiliconHud['view'] = 'top';

  // Camera gestures are reported once per burst, like the package twin.
  let gestures = 0;
  let gestureTimer: number | undefined;
  const noteGesture = () => {
    gestures += 1;
    window.clearTimeout(gestureTimer);
    gestureTimer = window.setTimeout(() => {
      callbacks.onCameraGesture({ gestures, distance_mm: Number(camera.position.distanceTo(orbit).toPrecision(4)), stop: stop.id, target_mm: orbit.toArray().map((value) => Number(value.toFixed(5))), section: sectionOn });
      gestures = 0;
    }, 800);
  };

  // The surface the cursor points at: the focus layer in plan view, or the
  // cut face in the cross-section.
  const planeHit = (ndc: THREE.Vector2) => {
    raycaster.setFromCamera(ndc, camera);
    const plane = sectionOn ? new THREE.Plane(new THREE.Vector3(section.axis === 0 ? 1 : 0, 0, section.axis === 2 ? 1 : 0), -section.value) : new THREE.Plane(new THREE.Vector3(0, 1, 0), -orbit.y);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  };

  // Set once the user moves the orbit height by hand (a drag or zoom seen
  // from the side, a dive from the side or below); the target then keeps
  // that height instead of easing to the layer of the current scale. Any
  // fly-to that does not set a height clears it.
  let freeY = false;
  let zoomAnchor: THREE.Vector3 | null = null;
  const clientNdc = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  };
  /**
   * The point under the cursor: drawn geometry, else the focus plane, else a
   * point along the line of sight at the orbit distance. Each lies on the
   * cursor's ray, so zooming or dragging about it keeps the cursor on it.
   */
  const pointUnder = (ndc: THREE.Vector2) => {
    const distance = camera.position.distanceTo(orbit);
    const near = (point: THREE.Vector3 | null) => (point && point.distanceTo(camera.position) < distance * 25 ? point : null);
    const found = near(inspector.pickPoint(ndc)) ?? near(planeHit(ndc));
    if (found) return found;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.at(distance, new THREE.Vector3());
  };
  /**
   * Zoom anchor: the focus plane where the cursor's ray meets it steeply,
   * else the drawn point under the cursor (side views, where the plane is
   * seen edge-on, and empty space).
   */
  const zoomAnchorAt = (ndc: THREE.Vector2) => {
    const hit = planeHit(ndc);
    const normal = sectionOn ? (section.axis === 0 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)) : new THREE.Vector3(0, 1, 0);
    const steep = Math.abs(raycaster.ray.direction.dot(normal)) > 0.35;
    return hit && steep && hit.distanceTo(camera.position) < camera.position.distanceTo(orbit) * 25 ? hit : pointUnder(ndc);
  };
  const lineOfSight = new THREE.Vector3();

  function zoomAbout(scale: number) {
    const distance = camera.position.distanceTo(orbit);
    const next = clamp(distance * scale, MIN_DISTANCE, MAX_DISTANCE);
    if (Math.abs(next - distance) < distance * 1e-9) {
      zoomImpulse = 0;
      return;
    }
    const k = next / distance;
    // Scaling camera and target about a point on the cursor's line of sight
    // keeps what is under the cursor fixed on screen: zoom-to-cursor.
    const anchor = zoomAnchor ?? orbit.clone();
    if (Math.abs(anchor.y - orbit.y) > distance * 1e-6) freeY = true;
    camera.position.sub(anchor).multiplyScalar(k).add(anchor);
    orbit.sub(anchor).multiplyScalar(k).add(anchor);
  }

  // Height the orbit target eases to while a cross-section flight runs.
  let sectionFocusY: number | null = null;
  /** Camera azimuth that looks straight at the cut from the cleared side. */
  const sectionAzimuth = () => (section.axis === 0 ? (section.keep > 0 ? -Math.PI / 2 : Math.PI / 2) : section.keep > 0 ? Math.PI : 0);

  function flyTo(spec: { x: number; z: number; distance: number; polar?: number; azimuth?: number; y?: number }) {
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    const path = zoomPanPath({ x: orbit.x, z: orbit.z, width: spherical.radius }, { x: spec.x, z: spec.z, width: spec.distance });
    const polarTarget = clamp(spec.polar ?? spherical.phi, POLAR_MARGIN, Math.PI - POLAR_MARGIN);
    const azimuthTarget = spherical.theta + wrapAngle((spec.azimuth ?? spherical.theta) - spherical.theta);
    const height: [number, number] | null = spec.y === undefined ? null : [orbit.y, spec.y];
    flight = { start: performance.now(), duration: clamp(600 + path.length * 360, 700, 4500), path, polar: [spherical.phi, polarTarget], azimuth: [spherical.theta, azimuthTarget], height };
    freeY = height !== null;
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
    orbit.x = point.x;
    orbit.z = point.z;
    if (flight.height) orbit.y = THREE.MathUtils.lerp(flight.height[0], flight.height[1], blend);
    camera.position.copy(orbit).add(scratch.setFromSphericalCoords(point.width, THREE.MathUtils.lerp(flight.polar[0], flight.polar[1], blend), THREE.MathUtils.lerp(flight.azimuth[0], flight.azimuth[1], blend)));
    camera.lookAt(orbit);
    if (t >= 1) {
      cancelFlight();
      sectionFocusY = null;
    }
  }

  // ------------------------------------------------------------ events
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    cancelFlight();
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 400;
    // Trackpad pinches arrive as small ctrl+wheel deltas.
    zoomImpulse += clamp(delta * (event.ctrlKey ? 0.012 : 0.0022), -1.4, 1.4);
    // Anywhere on the view, from any angle: the anchor is fixed per wheel step.
    zoomAnchor = zoomAnchorAt(clientNdc(event.clientX, event.clientY));
    noteGesture();
  };
  const onDoubleClick = (event: MouseEvent) => {
    const point = pointUnder(clientNdc(event.clientX, event.clientY));
    const distance = camera.position.distanceTo(orbit);
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    // From above, the target then descends to the layer of the new scale;
    // from the side or below it keeps the height of the point dived into.
    const sideways = Math.abs(camera.getWorldDirection(scratch).y) < 0.35 || camera.position.y < orbit.y;
    flyTo({ x: point.x, z: point.z, y: sideways && !sectionOn ? point.y : undefined, distance: distance * (event.shiftKey ? 3.2 : 0.3), polar: spherical.phi, azimuth: spherical.theta });
    if (sectionOn) sectionFocusY = point.y;
    noteGesture();
  };
  // Capture on the host so a drag during a fly-through both cancels it and
  // reaches the controls as a normal gesture; drags that move the view are
  // taken here, before OrbitControls sees them.
  const onPointerDown = (event: PointerEvent) => {
    cancelFlight();
    beginPan(event);
  };
  const onControlsEnd = () => noteGesture();
  // A rotation moves the cursor off the last zoom anchor.
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

  // ------------------------------------------------------------- sizing
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

  // ------------------------------------------------------ section caps
  function capsFor(record: Resident) {
    const stamp = sectionOn ? `${sectionStamp}|${capEps}` : '';
    if (record.capStamp === stamp) return;
    if (record.capGroup) disposeGroup(record.capGroup);
    record.capGroup = null;
    record.capStamp = stamp;
    if (!sectionOn) return;
    const caps = sectionCaps(record.data, section, capEps);
    if (caps.length === 0) return;
    record.capGroup = meshesFor(record.data, caps, levelMaterials[record.level]);
    levelGroups[record.level].add(record.capGroup);
  }

  let staticCaps: THREE.Group | null = null;
  function rebuildStaticCaps() {
    if (staticCaps) {
      staticCaps.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      staticCaps.removeFromParent();
      staticCaps = null;
    }
    if (!sectionOn) return;
    staticCaps = new THREE.Group();
    for (const box of staticBoxes) {
      const [x0, z0, x1, z1] = box.rect;
      const lo = section.axis === 0 ? x0 : z0;
      const hi = section.axis === 0 ? x1 : z1;
      if (section.value <= lo || section.value >= hi) continue;
      // Behind the chunk caps, which sit within 5 eps of the plane.
      const offset = section.keep * capEps * 8;
      const span = section.axis === 0 ? z1 - z0 : x1 - x0;
      const geometry = new THREE.BoxGeometry(section.axis === 0 ? capEps : span, box.y[1] - box.y[0], section.axis === 0 ? span : capEps);
      const mesh = new THREE.Mesh(geometry, box.section);
      mesh.position.set(section.axis === 0 ? section.value + offset : (x0 + x1) / 2, (box.y[0] + box.y[1]) / 2, section.axis === 0 ? (z0 + z1) / 2 : section.value + offset);
      mesh.userData.part = box.part;
      staticCaps.add(mesh);
    }
    scene.add(staticCaps);
  }

  function updateSection(distance: number) {
    if (!sectionOn) {
      sectionPlane.normal.set(0, 1, 0);
      sectionPlane.constant = 1e9;
      return;
    }
    const forward = scratch.copy(orbit).sub(camera.position);
    const alongX = Math.abs(forward.x) > Math.abs(forward.z) * (section.axis === 0 ? 0.8 : 1.25);
    const axis: 0 | 2 = alongX ? 0 : 2;
    const keep: 1 | -1 = (alongX ? forward.x : forward.z) >= 0 ? 1 : -1;
    const at = axis === 0 ? orbit.x : orbit.z;
    const recut = axis !== section.axis || keep !== section.keep || Math.abs(at - section.value) > distance * 0.3;
    if (recut) section = { axis, keep, value: snapSection(axis, orbit.x, orbit.z, distance) };
    // Cap thickness tracks the zoom (re-cut after a 4x change) so caps stay
    // within depth precision without floating visibly off the plane.
    const eps = distance * 2e-6;
    if (recut || capEps === 0 || eps > capEps * 4 || eps < capEps / 4) capEps = eps;
    sectionPlane.normal.set(axis === 0 ? keep : 0, 0, axis === 2 ? keep : 0);
    sectionPlane.constant = -keep * section.value;
    const stamp = `${section.axis}:${section.keep}:${section.value}`;
    if (stamp !== sectionStamp || staticCapsEps !== capEps) {
      sectionStamp = stamp;
      staticCapsEps = capEps;
      rebuildStaticCaps();
    }
  }

  // ------------------------------------------- labels, hover, and selection
  const annotations = createAnnotations(host);
  const inspector = createInspector({
    camera,
    shared,
    sectionPlane,
    records: () => resident.values(),
    levelVisible: (level) => levelGroups[level].visible && levelUniforms[level].uFade.value >= 0.5,
    statics: () => {
      const drawn = staticMeshes.filter((object) => object.visible);
      if (staticCaps?.visible) drawn.push(...staticCaps.children);
      return drawn;
    },
  }, scene);
  let labelMode: LabelMode = 'all';
  const selectTarget = (target: Target | null) => {
    inspector.select(target);
    annotations.setSelected(target?.key ?? null);
    callbacks.onSelect(target ? describeTarget(target) : null);
  };
  // Package labels at the package stop; at the die stop the die itself needs none.
  const packageAnchorsFor = (id: FocusStop['id']) => (id === 'package' ? packageAnchors : id === 'die' ? packageAnchors.filter((item) => item.part !== 'die') : []);

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
  // A click (not a drag) names what is under the cursor: a label if one is
  // there (labels take no pointer events of their own), else the scene.
  // Empty space clears the selection.
  function clickAt(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const label = annotations.labelAt(x, y);
    if (label) annotations.activate(label);
    else selectTarget(inspector.pick(ndcAt(x, y)));
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

  // ------------------------------------------------------ moving the view
  // Drag to move: the point grabbed stays under the cursor, as when dragging
  // a map. Right- or middle-drag, Shift/Ctrl/Cmd-drag, or a plain drag in
  // Pan mode. The drag runs in the horizontal plane through the grabbed
  // point when looking down or up, and parallel to the screen from the side,
  // where a horizontal plane is seen edge-on.
  let dragMode: DragMode = 'rotate';
  let pan: { pointerId: number; plane: THREE.Plane; grab: THREE.Vector3; x: number; y: number; moved: boolean } | null = null;
  const applyDragMode = () => {
    // Whichever drag is the plain one, the other stays one button away.
    controls.mouseButtons = dragMode === 'pan'
      ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.touches = dragMode === 'pan' ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    host.classList.toggle('pan-mode', dragMode === 'pan');
  };
  applyDragMode();
  const wantsPan = (event: PointerEvent) => {
    // Touch stays with the controls (one finger per the mode, two to pinch and move).
    if (event.pointerType === 'touch' || event.target !== canvas) return false;
    if (event.button === 1) return true;
    const modified = event.shiftKey || event.ctrlKey || event.metaKey;
    if (event.button === 0) return (dragMode === 'pan') !== modified;
    return event.button === 2 && dragMode === 'rotate';
  };
  function beginPan(event: PointerEvent) {
    if (pan || !wantsPan(event)) return;
    // Keep the controls and the click handlers out of this gesture.
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
    // A few pixels of slack, so a click in Pan mode stays a click.
    if (!pan.moved && Math.hypot(event.clientX - pan.x, event.clientY - pan.y) < 4) return;
    pan.moved = true;
    raycaster.setFromCamera(clientNdc(event.clientX, event.clientY), camera);
    const hit = raycaster.ray.intersectPlane(pan.plane, new THREE.Vector3());
    if (!hit) return;
    const delta = pan.grab.clone().sub(hit);
    // Near the horizon a small cursor move reaches far along the plane: cap each step.
    const distance = camera.position.distanceTo(orbit);
    if (delta.length() > distance * 2) delta.setLength(distance * 2);
    camera.position.add(delta);
    orbit.add(delta);
    camera.updateMatrixWorld();
    if (Math.abs(delta.y) > distance * 1e-6) freeY = true;
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
    // In Pan mode a plain click still identifies what is under it.
    if (click) clickAt(event.clientX, event.clientY);
    else noteGesture();
  };
  // Keyboard, once the view has focus: arrows move it (OrbitControls), + and -
  // zoom at the centre, Escape clears the selection.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== host) return;
    const zoom = event.key === '+' || event.key === '=' ? -0.5 : event.key === '-' || event.key === '_' ? 0.5 : 0;
    if (zoom !== 0) {
      cancelFlight();
      zoomAnchor = null;
      zoomImpulse += zoom;
      noteGesture();
    } else if (event.key === 'Escape' && inspector.selected) selectTarget(null);
    else return;
    event.preventDefault();
  };
  host.addEventListener('keydown', onKeyDown);

  let hoverAt = 0;
  let hoverText: [string, string] | null = null;
  let planner: Generator<void, Anchor[]> | null = null;
  let planAt = 0;
  let planStamp = '';
  let labelled = new Set<string>();
  let movedAt = 0;
  // Label positions need recomputing only when the camera, the anchors, the
  // label mode, or the canvas size changed.
  let labelsStale = true;
  let rulerStale = true;
  const lastCamera = new THREE.Matrix4();
  let lastSize = '';
  function annotate(now: number, distance: number) {
    const size = `${cssWidth}x${cssHeight}`;
    const moved = !lastCamera.equals(camera.matrixWorld) || size !== lastSize;
    if (moved) {
      lastCamera.copy(camera.matrixWorld);
      lastSize = size;
      movedAt = now;
    }
    // Hover read-out: at most ~16 picks a second, none while dragging or flying.
    // Over a label it names what the label points at; elsewhere, the scene.
    if (pointer.inside && !pointer.dragging && !flight && !pan) {
      if ((pointer.dirty || moved) && now > hoverAt) {
        hoverAt = now + 60;
        pointer.dirty = false;
        const label = annotations.labelAt(pointer.x, pointer.y);
        annotations.setHovered(label);
        host.classList.toggle('over-label', Boolean(label));
        if (label) {
          inspector.hover(null);
          hoverText = [label.title, label.detail];
        } else {
          const target = inspector.pick(ndcAt(pointer.x, pointer.y));
          inspector.hover(target);
          hoverText = target && target.kind !== 'region' ? [PARTS[target.part].title, PARTS[target.part].layer] : null;
        }
      }
      annotations.tooltip(hoverText?.[0] ?? null, hoverText?.[1], pointer.x, pointer.y);
    } else if (hoverText || pointer.dirty) {
      pointer.dirty = false;
      hoverText = null;
      inspector.hover(null);
      annotations.setHovered(null);
      host.classList.remove('over-label');
      annotations.tooltip(null);
    }

    // Labels: re-planned a few times a second while the view moves.
    if (labelMode !== 'off') {
      const stamp = `${stop.id}|${sectionOn}|${view}|${size}`;
      if (planner && stamp !== planStamp) planner = null;
      if (!planner && (now > planAt || stamp !== planStamp)) {
        planStamp = stamp;
        planner = inspector.plan({
          stop, orbit: orbit.clone(), distance, width: cssWidth, height: cssHeight, keep: labelled,
          section: { on: sectionOn, axis: section.axis, value: section.value }, packageAnchors: packageAnchorsFor(stop.id),
        }, annotations, selectTarget);
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
      annotations.setRuler(inspector.ruler({ orbit, height: cssHeight, section: { on: true, axis: section.axis, value: section.value } }));
    }
  }

  // ---------------------------------------------------------- streaming
  let pending = 0;
  function stream(now: number, distance: number) {
    const wanted: Array<ChunkKey & { rank: number }> = [];
    for (const level of LEVELS) {
      const fade = levelFade(level, distance);
      levelUniforms[level.id].uFade.value = fade;
      levelGroups[level.id].visible = fade > 0;
      if (level.id === 0 || fade <= 0) continue;
      const keys = windowChunks(level, orbit.x, orbit.z, distance);
      const cx = Math.floor(orbit.x / level.chunk);
      const cz = Math.floor(orbit.z / level.chunk);
      for (const key of keys) wanted.push({ ...key, rank: Math.max(Math.abs(key.ix - cx), Math.abs(key.iz - cz)) * 10 + (LEVELS.length - key.level) });
    }
    wanted.sort((a, b) => a.rank - b.rank);
    const started = performance.now();
    pending = 0;
    for (const key of wanted) {
      const id = chunkId(key);
      const record = resident.get(id);
      if (record) {
        record.lastWanted = now;
        continue;
      }
      if (performance.now() - started > GENERATION_BUDGET_MS) {
        pending += 1;
        continue;
      }
      let data = dataCache.get(id);
      if (!data) {
        data = generateChunk(key.level, key.ix, key.iz);
        cacheData(id, data);
      }
      addResident(id, key.level, data, now);
    }
    for (const record of resident.values()) {
      if (record.level === 0) continue;
      if (now - record.lastWanted > EVICT_AFTER_MS) {
        disposeGroup(record.group);
        if (record.capGroup) disposeGroup(record.capGroup);
        resident.delete(record.id);
      }
    }
    // Section caps, within what is left of the budget.
    for (const record of resident.values()) {
      if (performance.now() - started > GENERATION_BUDGET_MS * 1.6) break;
      capsFor(record);
    }
  }

  // ------------------------------------------------------ camera rules
  function constrain(dt: number) {
    const distance = camera.position.distanceTo(orbit);
    stop = focusStopFor(distance, stop.id);
    // The orbit target descends through the stack as you zoom, so orbiting
    // pivots on the layer in view.
    const focusY = sectionOn ? sectionFocusY : freeY ? null : stop.targetY;
    if (focusY !== null) {
      const dy = (focusY - orbit.y) * (1 - Math.exp(-dt * 6));
      // After a zoom at the cursor, slide along the line of sight to the zoom
      // anchor, so what is under the cursor stays put; otherwise straight
      // down, which seen from above is along the line of sight anyway.
      lineOfSight.copy(zoomAnchor ?? orbit).sub(camera.position).normalize();
      if (zoomAnchor && Math.abs(lineOfSight.y) > 0.35) {
        lineOfSight.multiplyScalar(dy / lineOfSight.y);
        orbit.add(lineOfSight);
        camera.position.add(lineOfSight);
      } else {
        orbit.y += dy;
        camera.position.y += dy;
      }
    }
    // Free roaming, within the package and a view's width around it.
    const cx = clamp(orbit.x, -ROAM_X - distance, ROAM_X + distance) - orbit.x;
    const cy = clamp(orbit.y, ROAM_FLOOR - distance, STACK_MAX + distance) - orbit.y;
    const cz = clamp(orbit.z, -ROAM_Z - distance, ROAM_Z + distance) - orbit.z;
    orbit.x += cx;
    orbit.y += cy;
    orbit.z += cz;
    camera.position.x += cx;
    camera.position.y += cy;
    camera.position.z += cz;
    const planes = clipPlanesFor(distance);
    camera.near = planes.near;
    camera.far = planes.far;
    camera.updateProjectionMatrix();

    // Delayering crater: the cut descends (or rises) smoothly between stops,
    // like a mill working through the stack.
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    const crater = craterFor(stop, distance, spherical.phi);
    const floorTarget = crater && !sectionOn ? crater.floor : FLOOR_OFF;
    craterFloor = Math.exp(THREE.MathUtils.lerp(Math.log(craterFloor), Math.log(floorTarget), 1 - Math.exp(-dt * 5)));
    shared.uCrater.value.set(orbit.x, orbit.z, craterFloor, distance * (Math.sin(spherical.phi) + 1.1));
    shared.uCraterOn.value = craterFloor < FLOOR_OFF * 0.9 ? 1 : 0;

    controls.screenSpacePanning = sectionOn;
    shared.uCull.value.set(camera.position.x, camera.position.y, camera.position.z, distance * CULL_FRACTION);

    // Below the die: the whole package from afar; at chip zoom the package
    // hides and the circuitry shows from its backside. A cross-section keeps
    // the package, whose cut faces are part of what it shows.
    view = camera.position.y >= 0 ? 'top' : distance < BACKSIDE_WITHIN ? 'backside' : 'underside';
    const packageShown = view !== 'backside' || sectionOn;
    for (const object of staticMeshes) object.visible = packageShown && (object !== bgaMesh || camera.position.y < substrateBottom);

    headlight.position.copy(camera.position);
    headlight.target.position.copy(orbit);
    // Cross-sections only, and faint: as a coaxial light its highlight sits
    // mid-frame on any face square to the camera (a hot spot). Undersides and
    // cut faces mostly mirror the studio's floor and horizon instead.
    headlight.intensity += ((sectionOn ? 0.35 : 0) - headlight.intensity) * (1 - Math.exp(-dt * 4));
    // Head-on faces in a section converge at the vanishing point; less bloom there.
    if (post?.bloom) post.bloom.strength += ((sectionOn ? bloomStrength * 0.55 : bloomStrength) - post.bloom.strength) * (1 - Math.exp(-dt * 4));
    if (dieUniforms) {
      dieUniforms.uMacroMix.value = THREE.MathUtils.smoothstep(distance, 0.02, 0.5);
      dieUniforms.uBaseGlow.value = 1 - levelFade(LEVELS[1], distance);
    }
    return distance;
  }

  // ------------------------------------------------------------ loop
  const startTime = performance.now();
  let last = startTime;
  let frameEma = 16.7;
  const frameWindow: number[] = [];
  let hudAt = 0;
  let adaptAt = startTime + 2500;
  let raisedBlockedUntil = 0;
  let readySent = false;
  let raf = 0;

  const frame = (now: number) => {
    raf = window.requestAnimationFrame(frame);
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

    renderer.info.reset();
    post.composer.render(dt);
    annotate(now, distance);

    if (!readySent) {
      readySent = true;
      callbacks.onReady();
    }
    // Adaptive resolution: hold 60 fps by trading pixels, with hysteresis.
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
        if (!levelGroups[record.level].visible) continue;
        instances += record.instances;
        chunks += 1;
      }
      const mmPerPx = (2 * distance * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / cssHeight;
      const bar = scaleBar(mmPerPx, 110);
      callbacks.onHud({
        stop,
        location: describeLocation(orbit.x, orbit.z),
        scale: { label: bar.label, px: bar.px },
        distance,
        fps: 1000 / Math.max(1, frameEma),
        frameMs: frameEma,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        instances,
        chunks,
        pending,
        dpr,
        gpu: gpu.name,
        software: gpu.software,
        view,
      });
    }
  };

  // ------------------------------------------------------------ staged build
  // Setup is long (HDR environment, die textures, global metal, shader
  // compilation), so each step runs in a task of its own: the click or tab
  // switch that opened the view completes at once, and leaving mid-build
  // just stops at the next step.
  let disposed = false;
  const nextTask = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  async function build() {
    await nextTask();
    if (disposed) return;
    const environment = createStudioEnvironment(renderer);
    disposables.push(environment);
    scene.environment = environment.texture;
    await nextTask();
    if (disposed) return;
    const textures = buildDieAndPackage();
    // Upload the die textures now, one per task, rather than in the first frame.
    for (const texture of [textures.albedo, textures.roughnessMetal, textures.activity]) {
      await nextTask();
      if (disposed) return;
      renderer.initTexture(texture);
    }
    await nextTask();
    if (disposed) return;
    addResident('global', 0, generateGlobal(), performance.now());
    await nextTask();
    if (disposed) return;
    post = createPost();
    applySize();
    // Queue every program now. Where the driver compiles in parallel, wait
    // for them without blocking; elsewhere they link on the first frame.
    // (compileAsync would keep polling after a dispose.)
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
      // No parallel compile: finish linking one program per task, so no single
      // task waits on the whole set (the GPU process keeps compiling between).
      for (const material of programs) {
        programOf(material)?.getUniforms();
        await nextTask();
        if (disposed) return;
      }
    }
    last = performance.now();
    // Judge resolution only once frames are steady, not on the compile frames.
    adaptAt = last + 2500;
    raf = window.requestAnimationFrame(frame);
  }
  build().catch((reason: unknown) => {
    if (!disposed) callbacks.onError(`The silicon scene failed to build: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  // ------------------------------------------------------------- API
  return {
    flyTo(presetId) {
      const preset = PRESETS.find((item) => item.id === presetId);
      if (!preset) return;
      if (!sectionOn) {
        flyTo(preset);
        return;
      }
      // In the cross-section, keep facing the cut at the new scale.
      flyTo({ ...preset, polar: 1.36, azimuth: sectionAzimuth() });
      sectionFocusY = SECTION_FOCUS_Y[preset.id];
    },
    setGlow(on) {
      shared.uGlowGain.value = on ? 1 : 0;
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
      staticCapsEps = -1;
      planAt = 0;
      rulerStale = true;
      if (!on) annotations.setRuler(null);
      const distance = camera.position.distanceTo(orbit);
      updateSection(distance);
      if (on) {
        // Face the cut from the cleared side, level with the stack, centred
        // where the layers, trenches, and TSVs of this zoom are.
        flyTo({ x: orbit.x, z: orbit.z, distance, polar: 1.36, azimuth: sectionAzimuth() });
        sectionFocusY = SECTION_FOCUS_Y[stop.id];
      } else {
        sectionFocusY = null;
        freeY = false;
        rebuildStaticCaps();
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
      const target = inspector.selected;
      if (!target) return;
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      if (target.kind === 'primitive') {
        center.set(target.ref.x, (target.ref.y0 + target.ref.y1) / 2, target.ref.z);
        size.set(target.ref.sx, target.ref.y1 - target.ref.y0, target.ref.sz);
      } else if (target.kind === 'static') {
        target.box.getCenter(center);
        target.box.getSize(size);
      } else {
        const r = target.label.rect;
        center.set((r.x0 + r.x1) / 2, target.label.y, (r.z0 + r.z1) / 2);
        size.set(r.x1 - r.x0, 0, r.z1 - r.z0);
      }
      spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
      // Frame the whole part at its own height, keeping the viewing angle.
      flyTo({ x: center.x, z: center.z, y: sectionOn ? undefined : center.y, distance: clamp(Math.max(size.x, size.y, size.z) * 1.8, MIN_DISTANCE * 3, 150), polar: spherical.phi, azimuth: spherical.theta });
    },
    dispose() {
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
      inspector.dispose();
      for (const record of resident.values()) {
        disposeGroup(record.group);
        if (record.capGroup) disposeGroup(record.capGroup);
      }
      resident.clear();
      dataCache.clear();
      if (staticCaps) disposeGroup(staticCaps);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry !== unitBox && object.geometry !== unitCylinder) object.geometry.dispose();
      });
      for (const item of disposables) item.dispose();
      if (post) {
        for (const pass of post.composer.passes) pass.dispose();
        post.composer.dispose();
        post.target.dispose();
      }
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
