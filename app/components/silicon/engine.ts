import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { PACKAGE_GEOMETRY, SCENE_MM_PER_UNIT, STACK_PLACEMENTS } from '@/lib/package-connectors';
import {
  DIE, FLOATS_PER_INSTANCE, LEVELS, MATERIAL_KEYS, PRESETS, STACK_MAX,
  chunkId, clipPlanesFor, craterFor, describeLocation, focusStopFor, generateChunk, generateGlobal, levelFade, scaleBar, sectionCaps, snapSection, windowChunks, zoomPanPath,
  type Batch, type ChunkData, type ChunkKey, type FocusStop, type MaterialKey, type SectionPlane,
} from '@/lib/silicon-macro';
import { createDieTextures, createStackSideTexture } from './die-texture';
import { FinishShader, createBackdrop, createChipMaterial, createDieSurfaceMaterial, createDieUniforms, createSharedUniforms, createStudioEnvironment, type DieUniforms, type LevelUniforms } from './materials';

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
};

export type SiliconEngineCallbacks = {
  onHud: (hud: SiliconHud) => void;
  onReady: () => void;
  onError: (message: string) => void;
  onCameraGesture: (details: Record<string, unknown>) => void;
};

export type SiliconEngine = {
  flyTo: (presetId: string) => void;
  setGlow: (on: boolean) => void;
  setBloom: (on: boolean) => void;
  setSection: (on: boolean) => void;
  setAutoRotate: (on: boolean) => void;
  dispose: () => void;
};

const MIN_DISTANCE = 0.00022;
const MAX_DISTANCE = 240;
const FOV = 34;
const MAX_POLAR = 1.2;
const SECTION_MAX_POLAR = 1.53;
// Above every structure: the crater floor rests here when no stop needs one.
const FLOOR_OFF = STACK_MAX * 3;
const GENERATION_BUDGET_MS = 5;
const EVICT_AFTER_MS = 1200;
const MM = SCENE_MM_PER_UNIT;
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
  renderer.toneMappingExposure = 1.08;
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
  const key = new THREE.DirectionalLight('#fff3e4', 1.25);
  key.position.set(-4.5, 10, 3.5);
  scene.add(key);
  // Coaxial headlight, as on a microscope: brightens in the cross-section so
  // cut metal faces (which mirror the dark room behind the camera) read as metal.
  const headlight = new THREE.DirectionalLight('#f4f7ff', 0.3);
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
  const staticBoxes: Array<{ rect: [number, number, number, number]; y: [number, number]; section: THREE.Material }> = [];
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
    scene.add(dieMesh);

    const addBox = (width: number, depth: number, y0: number, y1: number, x: number, z: number, material: THREE.Material | THREE.Material[], section: THREE.Material) => {
      const geometry = new THREE.BoxGeometry(width, y1 - y0, depth);
      disposables.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, (y0 + y1) / 2, z);
      scene.add(mesh);
      staticBoxes.push({ rect: [x - width / 2, z - depth / 2, x + width / 2, z + depth / 2], y: [y0, y1], section });
      return mesh;
    };
    staticBoxes.push({ rect: [-DIE.width / 2, -DIE.depth / 2, DIE.width / 2, DIE.depth / 2], y: [-DIE.thickness, 0], section: sectionSilicon });
    const interposerTop = -DIE.thickness - 0.02;
    addBox(PACKAGE_GEOMETRY.interposer.width * MM, PACKAGE_GEOMETRY.interposer.depth * MM, interposerTop - 0.1, interposerTop, 0, 0, interposerMaterial, sectionSilicon);
    const stackSize = PACKAGE_GEOMETRY.dramTier.size * MM;
    for (const placement of STACK_PLACEMENTS) {
      addBox(stackSize, stackSize, interposerTop, 0.02, placement.x * MM, placement.z * MM, [stackSideMaterial, stackSideMaterial, stackTopMaterial, stackSideMaterial, stackSideMaterial, stackSideMaterial], stackSideMaterial);
    }
    const substrateTop = interposerTop - 0.1 - 0.09;
    addBox(PACKAGE_GEOMETRY.substrate.width * MM, PACKAGE_GEOMETRY.substrate.depth * MM, substrateTop - 1.1, substrateTop, 0, 0, substrateMaterial, substrateMaterial);
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
      scene.add(bodyMesh, endMesh);
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
  const bloomStrength = gpu.software ? 0.32 : 0.42;
  let bloomEnabled = true;
  let post: { composer: EffectComposer; bloom: UnrealBloomPass | null; finish: ShaderPass; target: THREE.WebGLRenderTarget } | null = null;
  function createPost() {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: hdrTargets ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: gpu.software ? 0 : 4 });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    // Bloom's blur chain is seven programs; software GL goes without it.
    const bloom = gpu.software ? null : new UnrealBloomPass(new THREE.Vector2(1, 1), bloomStrength, 0.5, hdrTargets ? 1.0 : 0.82);
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
  controls.maxPolarAngle = MAX_POLAR;
  controls.autoRotateSpeed = 0.35;
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
  const cursor = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const scratch = new THREE.Vector3();
  const spherical = new THREE.Spherical();
  let flight: null | { start: number; duration: number; path: ReturnType<typeof zoomPanPath>; polar: [number, number]; azimuth: [number, number] } = null;

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

  function zoomAbout(scale: number, ndc: THREE.Vector2) {
    const distance = camera.position.distanceTo(orbit);
    const next = clamp(distance * scale, MIN_DISTANCE, MAX_DISTANCE);
    if (Math.abs(next - distance) < distance * 1e-9) {
      zoomImpulse = 0;
      return;
    }
    const k = next / distance;
    const hit = planeHit(ndc);
    // Scaling camera and target about the point under the cursor keeps that
    // point fixed on screen: zoom-to-cursor without a target jump.
    const anchor = hit && hit.distanceTo(camera.position) < distance * 25 ? hit : orbit.clone();
    camera.position.sub(anchor).multiplyScalar(k).add(anchor);
    orbit.sub(anchor).multiplyScalar(k).add(anchor);
  }

  // Height the orbit target eases to while a cross-section flight runs.
  let sectionFocusY: number | null = null;
  /** Camera azimuth that looks straight at the cut from the cleared side. */
  const sectionAzimuth = () => (section.axis === 0 ? (section.keep > 0 ? -Math.PI / 2 : Math.PI / 2) : section.keep > 0 ? Math.PI : 0);

  function flyTo(spec: { x: number; z: number; distance: number; polar?: number; azimuth?: number }) {
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    const path = zoomPanPath({ x: orbit.x, z: orbit.z, width: spherical.radius }, { x: spec.x, z: spec.z, width: spec.distance });
    const polarTarget = clamp(spec.polar ?? spherical.phi, 0.05, sectionOn ? SECTION_MAX_POLAR : MAX_POLAR);
    const azimuthTarget = spherical.theta + wrapAngle((spec.azimuth ?? spherical.theta) - spherical.theta);
    flight = { start: performance.now(), duration: clamp(600 + path.length * 360, 700, 4500), path, polar: [spherical.phi, polarTarget], azimuth: [spherical.theta, azimuthTarget] };
    zoomImpulse = 0;
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
    const rect = canvas.getBoundingClientRect();
    cursor.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    noteGesture();
  };
  const onDoubleClick = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const hit = planeHit(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1));
    const distance = camera.position.distanceTo(orbit);
    spherical.setFromVector3(scratch.copy(camera.position).sub(orbit));
    flyTo({ x: hit?.x ?? orbit.x, z: hit?.z ?? orbit.z, distance: distance * (event.shiftKey ? 3.2 : 0.3), polar: spherical.phi, azimuth: spherical.theta });
    if (sectionOn && hit) sectionFocusY = hit.y;
    noteGesture();
  };
  // Capture on the host so a drag during a fly-through both cancels it and
  // reaches OrbitControls as a normal gesture.
  const onPointerDown = () => cancelFlight();
  const onControlsEnd = () => noteGesture();
  host.addEventListener('wheel', onWheel, { passive: false, capture: true });
  host.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('dblclick', onDoubleClick);
  controls.addEventListener('end', onControlsEnd);
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
  let polarLimit = MAX_POLAR;
  function constrain(dt: number) {
    const distance = camera.position.distanceTo(orbit);
    stop = focusStopFor(distance, stop.id);
    // The orbit target descends through the stack as you zoom, so orbiting
    // pivots on the layer in view.
    const focusY = sectionOn ? sectionFocusY : stop.targetY;
    if (focusY !== null) {
      const dy = (focusY - orbit.y) * (1 - Math.exp(-dt * 6));
      orbit.y += dy;
      camera.position.y += dy;
    }
    const margin = Math.max(1.5, distance * 0.6);
    const cx = clamp(orbit.x, -DIE.width / 2 - margin, DIE.width / 2 + margin) - orbit.x;
    const cz = clamp(orbit.z, -DIE.depth / 2 - margin, DIE.depth / 2 + margin) - orbit.z;
    orbit.x += cx;
    orbit.z += cz;
    camera.position.x += cx;
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

    // Leaving the section view eases the camera back above the stack.
    const limit = sectionOn ? SECTION_MAX_POLAR : MAX_POLAR;
    polarLimit = sectionOn ? limit : Math.max(limit, polarLimit - dt * 0.9);
    controls.maxPolarAngle = polarLimit;
    controls.screenSpacePanning = sectionOn;

    headlight.position.copy(camera.position);
    headlight.target.position.copy(orbit);
    headlight.intensity += ((sectionOn ? 1.3 : 0.3) - headlight.intensity) * (1 - Math.exp(-dt * 4));
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
        zoomAbout(Math.exp(step), cursor);
      }
      controls.update(dt);
    }
    const distance = constrain(dt);
    updateSection(distance);
    stream(now, distance);

    renderer.info.reset();
    post.composer.render(dt);

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
      if (on) polarLimit = SECTION_MAX_POLAR;
      const distance = camera.position.distanceTo(orbit);
      updateSection(distance);
      if (on) {
        // Face the cut from the cleared side, level with the stack, centred
        // where the layers, trenches, and TSVs of this zoom are.
        flyTo({ x: orbit.x, z: orbit.z, distance, polar: 1.36, azimuth: sectionAzimuth() });
        sectionFocusY = SECTION_FOCUS_Y[stop.id];
      } else {
        sectionFocusY = null;
        rebuildStaticCaps();
        for (const record of resident.values()) capsFor(record);
      }
    },
    setAutoRotate(on) {
      controls.autoRotate = on;
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
      controls.dispose();
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
