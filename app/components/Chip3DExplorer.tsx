'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { TwinBuildStep, TwinOverlay } from '@/lib/design-twin';
import { ACCELERATOR_FLOORPLAN, BASE_DIE_FLOORPLAN, OPEN_TITAN_REFERENCE, SKY130_VISUAL_LAYERS, X1_BASE_DIE_MM, floorplanAreaMm2 } from '@/lib/reference-microchip';
import { CONNECTOR_SAMPLING, PACKAGE_GEOMETRY, STACK_PLACEMENTS, acceleratorPhyAnchor, evaluateConnectorChain, stackLocalToWorld, type StackPlacement } from '@/lib/package-connectors';

export type TwinMetrics = {
  stackCount: number;
  dramTiers: number;
  capacityGibPerStack: number;
  payloadLanesPerStack: number;
  sramMibPerStack: number;
  rawBandwidthPerStackTbps: number;
  aggregateRawBandwidthTbps: number;
  deliveredBandwidthTbps: number;
  stackPowerWatts: number;
  memorySystemPowerWatts: number;
  routingPressurePercent: number;
  acceleratorFabricTbps: number;
  interposerRoutingLayers: number;
  distributedComputePorts: number;
};

export type CircuitPhysicsMetrics = {
  resistanceOhms: number;
  flightTimePs: number;
  rcDelayPs: number;
  totalElectricalDelayPs: number;
  capacitanceFf: number;
  energyPerTransitionPj: number;
  aggregateDynamicPowerWatts: number;
  aggregateJoulePowerWatts: number;
  currentDensityMAcm2: number;
};

type PartKind = 'accelerator' | 'interposer' | 'base' | 'dram' | 'route' | 'noc' | 'tsv' | 'bond' | 'package' | 'bga' | 'c4' | 'pad' | 'macro' | 'cell' | 'metal' | 'via' | 'seal' | 'phy' | 'compute' | 'capacitor' | 'stiffener';
type PartHost = 'package' | 'interposer' | 'accelerator' | 'base' | 'stack';

type Part = {
  id: string;
  name: string;
  kind: PartKind;
  host: PartHost;
  stack?: number;
  tier?: number;
  evidence: 'executed' | 'modeled' | 'planned' | 'restricted';
  primary: string;
  secondary: string;
};

type Props = {
  overlay: TwinOverlay;
  step: TwinBuildStep;
  metrics: TwinMetrics;
  physics: CircuitPhysicsMetrics;
};

type LabelMode = 'off' | 'key' | 'all';
type LabelLevel = 0 | 1 | 2;
type LabelEntry = { object: CSS2DObject; element: HTMLDivElement; level: LabelLevel; part: Part; tier?: number };

const LABEL_MODES: LabelMode[] = ['all', 'key', 'off'];
const LABEL_MODE_TEXT: Record<LabelMode, string> = { all: 'Labels: all', key: 'Labels: key', off: 'Labels: off' };
const DETAIL_LABEL_DISTANCE = 21;
const FINE_LABEL_DISTANCE = 13;

const PALETTE = {
  navy: new THREE.Color('#244f7d'),
  blue: new THREE.Color('#4f83bd'),
  steel: new THREE.Color('#7f9bb7'),
  pale: new THREE.Color('#cbd9e6'),
  offwhite: new THREE.Color('#f4f1ea'),
  gray: new THREE.Color('#aab4bf'),
};

const CIRCUIT_KINDS: PartKind[] = ['route', 'noc', 'tsv', 'bond', 'package', 'bga', 'c4', 'pad', 'macro', 'cell', 'metal', 'via', 'seal', 'phy', 'compute', 'capacitor', 'stiffener'];
const PACKAGE_KINDS: PartKind[] = ['package', 'bga', 'c4', 'stiffener', 'capacitor'];

function partColor(part: Part, overlay: TwinOverlay, metrics: TwinMetrics) {
  if (overlay === 'circuitry') {
    if (part.kind === 'route') return new THREE.Color('#2e74b5');
    if (part.kind === 'noc') return PALETTE.navy;
    if (part.kind === 'tsv') return new THREE.Color('#628db8');
    if (part.kind === 'bond') return new THREE.Color('#91abc4');
    if (part.kind === 'c4' || part.kind === 'bga') return new THREE.Color('#8a98a7');
    if (part.kind === 'metal' || part.kind === 'via') return new THREE.Color('#326fa9');
    if (part.kind === 'macro') return PALETTE.blue;
    if (part.kind === 'phy') return new THREE.Color('#3b6ea8');
    if (part.kind === 'compute') return new THREE.Color('#b7c8d8');
    if (part.kind === 'pad' || part.kind === 'seal') return PALETTE.navy;
    if (part.kind === 'cell') return new THREE.Color('#9fb7cd');
    if (part.kind === 'capacitor') return new THREE.Color('#5b6b7b');
    if (part.kind === 'package' || part.kind === 'stiffener') return PALETTE.gray;
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.steel, 0.35);
  }
  if (overlay === 'evidence') {
    const evidenceColors = { executed: PALETTE.navy, modeled: PALETTE.blue, planned: PALETTE.steel, restricted: PALETTE.gray };
    return evidenceColors[part.evidence];
  }
  if (PACKAGE_KINDS.includes(part.kind)) return PALETTE.gray;
  if (overlay === 'architecture') {
    if (part.kind === 'accelerator') return PALETTE.navy;
    if (part.kind === 'interposer') return PALETTE.pale;
    if (part.kind === 'base') return PALETTE.blue;
    if (part.kind === 'dram') return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.steel, (part.tier ?? 0) / 15);
    if (part.kind === 'route' || part.kind === 'noc' || part.kind === 'tsv' || part.kind === 'bond' || part.kind === 'via' || part.kind === 'metal') return PALETTE.steel;
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.blue, 0.5);
  }
  if (overlay === 'bandwidth') {
    const pressure = Math.min(1, metrics.deliveredBandwidthTbps / Math.max(1, metrics.aggregateRawBandwidthTbps));
    if (part.kind === 'accelerator') return new THREE.Color().lerpColors(PALETTE.blue, PALETTE.navy, pressure);
    if (part.kind === 'interposer') return PALETTE.steel;
    if (part.host === 'accelerator') return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.navy, pressure);
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.blue, 0.5 + pressure * 0.5);
  }
  if (overlay === 'power') {
    const load = Math.min(1, metrics.stackPowerWatts / 65);
    if (part.kind === 'accelerator') return PALETTE.navy;
    if (part.kind === 'interposer') return PALETTE.gray;
    if (part.host === 'accelerator') return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.navy, 0.7);
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.navy, load * (part.kind === 'base' || part.host === 'base' ? 0.85 : 0.62));
  }
  if (part.kind === 'accelerator') return PALETTE.navy;
  if (part.kind === 'interposer') return PALETTE.pale;
  if (part.host === 'accelerator') return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.navy, 0.75);
  const height = part.kind === 'base' || part.host === 'base' ? 0.35 : 0.35 + ((part.tier ?? 0) / 15) * 0.65;
  return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.navy, height);
}

function matchesFocus(part: Part, overlay: TwinOverlay, focus: TwinBuildStep['focus']) {
  const circuitKind = CIRCUIT_KINDS.includes(part.kind);
  if (overlay === 'circuitry' && circuitKind) return true;
  if (focus === 'system') return true;
  if (focus === 'stack') return part.host === 'stack' || part.host === 'base' || circuitKind;
  return focus === part.host;
}

const G = PACKAGE_GEOMETRY;
const SAMPLING = CONNECTOR_SAMPLING;
const UNIT_PER_MM = G.baseDie.size / X1_BASE_DIE_MM;
const SUBSTRATE_Y = G.substrate.top - G.substrate.thickness / 2;
const C4_Y = G.c4.bottom + G.c4.height / 2;
const INTERPOSER_Y = G.interposer.top - G.interposer.thickness / 2;
const MICROBUMP_Y = G.microbump.bottom + G.microbump.height / 2;
const ACCEL_Y = G.dieBottom + G.accelerator.thickness / 2;
const ACCEL_TOP = G.dieBottom + G.accelerator.thickness;
const BASE_Y = G.dieBottom + G.baseDie.thickness / 2;
const BASE_TOP = G.dieBottom + G.baseDie.thickness;
const tierBottom = (tier: number) => BASE_TOP + G.dramTier.bondGap + tier * G.dramTier.pitch;
const tierCenter = (tier: number) => tierBottom(tier) + G.dramTier.thickness / 2;
const bondCenter = (interfaceIndex: number) => tierBottom(interfaceIndex) - G.dramTier.bondGap / 2;

export default function Chip3DExplorer({ overlay, step, metrics, physics }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    meshes: THREE.Mesh[];
    renderer: THREE.WebGLRenderer;
  } | null>(null);
  const overlayRef = useRef(overlay);
  const stepRef = useRef(step);
  const metricsRef = useRef(metrics);
  const physicsRef = useRef(physics);
  const explodedRef = useRef(false);
  const siliconDetailRef = useRef(true);
  const labelModeRef = useRef<LabelMode>('all');
  const selectedRef = useRef<Part | null>(null);
  const [selected, setSelected] = useState<Part | null>(null);
  const [exploded, setExploded] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [siliconDetail, setSiliconDetail] = useState(true);
  const [labelMode, setLabelMode] = useState<LabelMode>('all');
  const [componentCount, setComponentCount] = useState(0);

  useEffect(() => { overlayRef.current = overlay; }, [overlay]);
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { metricsRef.current = metrics; }, [metrics]);
  useEffect(() => { physicsRef.current = physics; }, [physics]);
  useEffect(() => { explodedRef.current = exploded; }, [exploded]);
  useEffect(() => { siliconDetailRef.current = siliconDetail; }, [siliconDetail]);
  useEffect(() => { labelModeRef.current = labelMode; }, [labelMode]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { if (sceneRef.current) sceneRef.current.controls.autoRotate = autoRotate; }, [autoRotate]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const stackCount = Math.max(1, Math.min(STACK_PLACEMENTS.length, metricsRef.current.stackCount));
    const tiers = metricsRef.current.dramTiers;
    const chain = Object.fromEntries(evaluateConnectorChain(stackCount, tiers).levels.map((level) => [level.id, level]));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f7f7f4');
    scene.fog = new THREE.Fog('#f7f7f4', 32, 60);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(14.5, 11.5, 17.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = 'twin-labels';
    host.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 4;
    controls.maxDistance = 52;
    controls.target.set(0, 1.6, 0);
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.autoRotateSpeed = 0.7;

    scene.add(new THREE.HemisphereLight('#ffffff', '#a9b4bf', 2.2));
    const key = new THREE.DirectionalLight('#ffffff', 4.2);
    key.position.set(8, 16, 10);
    scene.add(key);
    const fill = new THREE.DirectionalLight('#8cb7e2', 2.1);
    fill.position.set(-12, 8, -9);
    scene.add(fill);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(25, 64), new THREE.MeshStandardMaterial({ color: '#edf0f2', roughness: 1, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.35;
    scene.add(floor);
    const grid = new THREE.GridHelper(42, 42, '#9db0c1', '#dbe1e6');
    grid.position.y = -1.32;
    scene.add(grid);

    const meshes: THREE.Mesh[] = [];
    const labels: LabelEntry[] = [];
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const unitScale = new THREE.Vector3(1, 1, 1);
    const tmpPosition = new THREE.Vector3();
    const partIds = new Set<string>();

    const registerMesh = (mesh: THREE.Mesh, part: Part, options?: { layer?: number; baseY?: number; siliconDetail?: boolean; baseOpacity?: number }) => {
      mesh.userData.part = part;
      mesh.userData.baseY = options?.baseY ?? mesh.position.y;
      mesh.userData.layer = options?.layer ?? 0;
      mesh.userData.siliconDetail = options?.siliconDetail ?? false;
      mesh.userData.baseOpacity = options?.baseOpacity ?? 1;
      partIds.add(part.id);
      meshes.push(mesh);
      scene.add(mesh);
      return mesh;
    };

    const addPart = (geometry: THREE.BufferGeometry, part: Part, position: [number, number, number], options?: { layer?: number; rotation?: number; siliconDetail?: boolean; baseOpacity?: number; roughness?: number; metalness?: number }) => {
      const material = new THREE.MeshStandardMaterial({
        color: partColor(part, overlayRef.current, metricsRef.current),
        roughness: options?.roughness ?? (part.kind === 'interposer' ? 0.72 : 0.5),
        metalness: options?.metalness ?? (part.kind === 'interposer' ? 0.18 : 0.08),
        transparent: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      if (options?.rotation) mesh.rotation.y = options.rotation;
      return registerMesh(mesh, part, { layer: options?.layer, siliconDetail: options?.siliconDetail, baseOpacity: options?.baseOpacity });
    };

    const addInstanced = (geometry: THREE.BufferGeometry, part: Part, placements: Array<[number, number, number, number?]>, options?: { layer?: number; y?: number; siliconDetail?: boolean; color?: string; metalness?: number; roughness?: number }) => {
      const material = new THREE.MeshStandardMaterial({
        color: options?.color ?? partColor(part, overlayRef.current, metricsRef.current),
        metalness: options?.metalness ?? 0.6,
        roughness: options?.roughness ?? 0.3,
        transparent: true,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
      placements.forEach(([x, y, z, rotation], index) => {
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotation ?? 0);
        matrix.compose(tmpPosition.set(x, y, z), quaternion, unitScale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.position.y = options?.y ?? 0;
      return registerMesh(mesh, part, { layer: options?.layer, siliconDetail: options?.siliconDetail });
    };

    const addLabel = (parent: THREE.Object3D, part: Part, level: LabelLevel, position: [number, number, number], options?: { text?: string; tier?: number }) => {
      const element = document.createElement('div');
      element.className = `twin-label level-${level} ${part.evidence}`;
      const dot = document.createElement('i');
      const text = document.createElement('span');
      text.textContent = options?.text ?? part.name;
      element.appendChild(dot);
      element.appendChild(text);
      element.addEventListener('click', (event) => { event.stopPropagation(); setSelected(part); });
      const object = new CSS2DObject(element);
      object.position.set(...position);
      object.center.set(0, 1);
      parent.add(object);
      labels.push({ object, element, level, part, tier: options?.tier });
      return object;
    };

    const part = (id: string, name: string, kind: PartKind, host: PartHost, evidence: Part['evidence'], primary: string, secondary: string, extra?: { stack?: number; tier?: number }): Part => ({ id, name, kind, host, evidence, primary, secondary, ...extra });
    const gridPlacements = (columns: number, rows: number, pitch: number, y: number, centerX = 0, centerZ = 0): Array<[number, number, number]> => {
      const placements: Array<[number, number, number]> = [];
      for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
        placements.push([centerX + (column - (columns - 1) / 2) * pitch, y, centerZ + (row - (rows - 1) / 2) * pitch]);
      }
      return placements;
    };

    // ------------------------------------------------------------------ package
    const substratePart = part('organic-package', 'Organic package substrate', 'package', 'package', 'modeled',
      `${(G.substrate.width * 12 / G.baseDie.size / 1).toFixed(0)} × ${(G.substrate.depth * 12 / G.baseDie.size).toFixed(0)} mm-class laminate`,
      'Build-up core with plated through-holes and microvias (enclosed, not rendered); dimensions are conceptual rather than package-qualified.');
    const substrate = addPart(new THREE.BoxGeometry(G.substrate.width, G.substrate.thickness, G.substrate.depth, 2, 1, 2), substratePart, [0, SUBSTRATE_Y, 0], { roughness: 0.85, metalness: 0.02 });
    addLabel(substrate, substratePart, 0, [-G.substrate.width / 2 + 0.3, G.substrate.thickness / 2, G.substrate.depth / 2 - 0.3]);

    const bgaPart = part('bga-array', 'BGA solder-ball array', 'bga', 'package', 'modeled',
      `${chain.bga.sampled} rendered balls · ${chain.bga.referencePitch}`,
      `${chain.bga.technology}. ${chain.bga.note} Not a released package ball map.`);
    const bga = addInstanced(new THREE.SphereGeometry(G.bga.radius, 12, 9), bgaPart, gridPlacements(SAMPLING.bga.columns, SAMPLING.bga.rows, SAMPLING.bga.pitch, G.bga.y), { color: '#8a98a7', metalness: 0.72, roughness: 0.27 });
    addLabel(bga, bgaPart, 0, [G.substrate.width / 2 - 0.6, G.bga.y - G.bga.radius, G.substrate.depth / 2 - 0.2]);

    const stiffenerPart = part('stiffener-ring', 'Stiffener ring', 'stiffener', 'package', 'modeled',
      `${chain.stiffener.technology}`, `${chain.stiffener.note} Also provides the seating surface for the heat-spreader lid, which is not rendered.`);
    const stiffenerY = G.substrate.top + G.stiffener.height / 2;
    const stiffenerFrame = [
      [G.stiffener.outerWidth, G.stiffener.band, 0, -(G.stiffener.outerDepth / 2 - G.stiffener.band / 2)],
      [G.stiffener.outerWidth, G.stiffener.band, 0, G.stiffener.outerDepth / 2 - G.stiffener.band / 2],
      [G.stiffener.band, G.stiffener.outerDepth - G.stiffener.band * 2, -(G.stiffener.outerWidth / 2 - G.stiffener.band / 2), 0],
      [G.stiffener.band, G.stiffener.outerDepth - G.stiffener.band * 2, G.stiffener.outerWidth / 2 - G.stiffener.band / 2, 0],
    ] as const;
    stiffenerFrame.forEach(([width, depth, x, z], index) => {
      const segment = addPart(new THREE.BoxGeometry(width, G.stiffener.height, depth), stiffenerPart, [x, stiffenerY, z], { roughness: 0.45, metalness: 0.5 });
      if (index === 0) addLabel(segment, stiffenerPart, 1, [-width / 2 + 0.4, G.stiffener.height / 2, 0]);
    });

    const capacitorPart = part('die-side-capacitors', 'Die-side decoupling capacitors', 'capacitor', 'package', 'modeled',
      `${chain.decoupling.sampled} rendered · ${chain.decoupling.referencePitch}`, `${chain.decoupling.technology}. ${chain.decoupling.note}`);
    const capacitorY = G.substrate.top + 0.09;
    const capacitorGapZ = (G.interposer.depth / 2 + G.stiffener.outerDepth / 2 - G.stiffener.band) / 2;
    const capacitorGapX = (G.interposer.width / 2 + G.stiffener.outerWidth / 2 - G.stiffener.band) / 2;
    const capacitorPlacements: Array<[number, number, number, number?]> = [];
    [-3, 0, 3].forEach((x) => { capacitorPlacements.push([x, capacitorY, -capacitorGapZ, 0], [x, capacitorY, capacitorGapZ, 0]); });
    [-2.5, 0, 2.5].forEach((z) => { capacitorPlacements.push([-capacitorGapX, capacitorY, z, Math.PI / 2], [capacitorGapX, capacitorY, z, Math.PI / 2]); });
    const capacitors = addInstanced(new THREE.BoxGeometry(0.42, 0.18, 0.22), capacitorPart, capacitorPlacements, { color: '#5b6b7b', metalness: 0.3, roughness: 0.6 });
    addLabel(capacitors, capacitorPart, 1, [-3, capacitorY + 0.09, capacitorGapZ]);

    // --------------------------------------------------------------- interposer
    const c4Part = part('c4-bumps', 'C4 flip-chip bump array', 'c4', 'interposer', 'modeled',
      `${chain.c4.sampled} rendered bumps · ${chain.c4.referencePitch}`, `${chain.c4.technology}. ${chain.c4.note} Production bump assignment requires package layout.`);
    const c4 = addInstanced(new THREE.CylinderGeometry(G.c4.radius, G.c4.radius * 0.85, G.c4.height, 8), c4Part, gridPlacements(SAMPLING.c4.columns, SAMPLING.c4.rows, SAMPLING.c4.pitch, C4_Y), { color: '#8a98a7', metalness: 0.7, roughness: 0.3 });
    addLabel(c4, c4Part, 1, [G.interposer.width / 2 - 0.4, C4_Y, G.interposer.depth / 2 + 0.05]);

    const interposerPart = part('interposer', 'Active silicon interposer', 'interposer', 'interposer', 'modeled',
      `${metricsRef.current.interposerRoutingLayers} RDL routing layers · ${metricsRef.current.distributedComputePorts} distributed compute ports`,
      `${metricsRef.current.routingPressurePercent.toFixed(0)}% route-pressure proxy. Rendered translucent so the TSVs inside it and the C4 bumps beneath it stay visible.`);
    const interposer = addPart(new THREE.BoxGeometry(G.interposer.width, G.interposer.thickness, G.interposer.depth, 2, 1, 2), interposerPart, [0, INTERPOSER_Y, 0], { baseOpacity: 0.72 });
    addLabel(interposer, interposerPart, 0, [-G.interposer.width / 2 + 0.3, G.interposer.thickness / 2, G.interposer.depth / 2 - 0.2]);

    const interposerTsvPart = part('interposer-tsvs', 'Interposer TSV fields', 'tsv', 'interposer', 'modeled',
      `${chain['interposer-tsv'].sampled} rendered · ${chain['interposer-tsv'].referencePitch}`, `${chain['interposer-tsv'].technology}. ${chain['interposer-tsv'].note}`);
    const interposerTsvPlacements: Array<[number, number, number]> = gridPlacements(SAMPLING.interposerTsvAccelerator.columns, SAMPLING.interposerTsvAccelerator.rows, SAMPLING.interposerTsvAccelerator.pitch, INTERPOSER_Y);
    STACK_PLACEMENTS.slice(0, stackCount).forEach((placement) => {
      interposerTsvPlacements.push(...gridPlacements(SAMPLING.interposerTsvStack.columns, SAMPLING.interposerTsvStack.rows, SAMPLING.interposerTsvStack.pitch, INTERPOSER_Y, placement.x, placement.z));
    });
    const interposerTsvs = addInstanced(new THREE.CylinderGeometry(G.tsv.radius, G.tsv.radius, G.interposer.thickness, 6), interposerTsvPart, interposerTsvPlacements, { color: '#628db8', metalness: 0.65, roughness: 0.3 });
    addLabel(interposerTsvs, interposerTsvPart, 1, [(SAMPLING.interposerTsvAccelerator.columns - 1) / 2 * SAMPLING.interposerTsvAccelerator.pitch, INTERPOSER_Y, (SAMPLING.interposerTsvAccelerator.rows - 1) / 2 * SAMPLING.interposerTsvAccelerator.pitch + 0.1]);

    // -------------------------------------------------------------- accelerator
    const acceleratorPart = part('accelerator', 'Accelerator die', 'accelerator', 'accelerator', 'planned',
      `${metricsRef.current.acceleratorFabricTbps.toFixed(0)} TB/s fabric proxy · reticle-class ${(G.accelerator.width / UNIT_PER_MM).toFixed(0)} × ${(G.accelerator.depth / UNIT_PER_MM).toFixed(0)} mm`,
      `${metricsRef.current.deliveredBandwidthTbps.toFixed(1)} TB/s modeled delivery · system bottleneck boundary. ${ACCELERATOR_FLOORPLAN.notes[0]}`);
    const accelerator = addPart(new THREE.BoxGeometry(G.accelerator.width, G.accelerator.thickness, G.accelerator.depth, 2, 1, 2), acceleratorPart, [0, ACCEL_Y, 0]);
    addLabel(accelerator, acceleratorPart, 0, [-G.accelerator.width / 2 + 0.1, G.accelerator.thickness / 2 + 0.02, -G.accelerator.depth / 2 + 0.1]);

    const microbumpPart = part('accelerator-microbumps', 'Accelerator microbump array', 'bond', 'accelerator', 'planned',
      `${chain['microbump-accelerator'].sampled} rendered contacts · ${chain['microbump-accelerator'].referencePitch}`, `${chain['microbump-accelerator'].technology}. ${chain['microbump-accelerator'].note}`);
    const microbumps = addInstanced(new THREE.CylinderGeometry(G.microbump.radius, G.microbump.radius, G.microbump.height, 8), microbumpPart, gridPlacements(SAMPLING.acceleratorMicrobumps.columns, SAMPLING.acceleratorMicrobumps.rows, SAMPLING.acceleratorMicrobumps.pitch, MICROBUMP_Y), { color: '#91abc4', metalness: 0.65, roughness: 0.24, siliconDetail: true });
    addLabel(microbumps, microbumpPart, 1, [G.accelerator.width / 2 - 0.2, MICROBUMP_Y, G.accelerator.depth / 2 + 0.02]);

    const sealPart = part('seal-ring', 'Accelerator seal + guard ring', 'seal', 'accelerator', 'planned',
      'Continuous four-sided die-edge structure', 'Represents the mechanical seal ring, substrate guard ring, and edge keep-out that surround every fabricated die.');
    const sealY = ACCEL_TOP + 0.035;
    const sealInsetX = G.accelerator.width / 2 - 0.08;
    const sealInsetZ = G.accelerator.depth / 2 - 0.08;
    const sealSegments = [
      addPart(new THREE.BoxGeometry(G.accelerator.width - 0.12, 0.07, 0.08), sealPart, [0, sealY, -sealInsetZ], { siliconDetail: true, layer: 1 }),
      addPart(new THREE.BoxGeometry(G.accelerator.width - 0.12, 0.07, 0.08), sealPart, [0, sealY, sealInsetZ], { siliconDetail: true, layer: 1 }),
      addPart(new THREE.BoxGeometry(0.08, 0.07, G.accelerator.depth - 0.28), sealPart, [-sealInsetX, sealY, 0], { siliconDetail: true, layer: 1 }),
      addPart(new THREE.BoxGeometry(0.08, 0.07, G.accelerator.depth - 0.28), sealPart, [sealInsetX, sealY, 0], { siliconDetail: true, layer: 1 }),
    ];
    addLabel(sealSegments[3], sealPart, 2, [0, 0.04, -G.accelerator.depth / 2 + 0.4]);

    const padPart = part('io-cell-ring', 'Four-bank I/O cell ring', 'pad', 'accelerator', 'planned',
      `${OPEN_TITAN_REFERENCE.asicPadCount} visible I/O cells across ${OPEN_TITAN_REFERENCE.ioBanks} banks`,
      'Count and bank organization follow the open Earl Grey ASIC reference; on this flip-chip die the cells reach the bump field through RDL rather than wire-bond pads.');
    const addPadBank = (count: number, side: 'north' | 'south' | 'east' | 'west') => {
      const horizontal = side === 'north' || side === 'south';
      let first: THREE.Mesh | null = null;
      for (let index = 0; index < count; index += 1) {
        const progress = count === 1 ? 0 : index / (count - 1);
        const x = horizontal ? -2.6 + progress * 5.2 : side === 'west' ? -2.9 : 2.9;
        const z = horizontal ? (side === 'north' ? -2.45 : 2.45) : -2.15 + progress * 4.3;
        const pad = addPart(new THREE.BoxGeometry(horizontal ? 0.19 : 0.12, 0.055, horizontal ? 0.12 : 0.19), padPart, [x, ACCEL_TOP + 0.03, z], { siliconDetail: true, layer: 1 });
        if (!first) first = pad;
      }
      if (first) addLabel(first, padPart, 2, [0, 0.03, 0], { text: `I/O bank · ${side}` });
    };
    addPadBank(18, 'north');
    addPadBank(18, 'south');
    addPadBank(18, 'west');
    addPadBank(17, 'east');

    const tiles = ACCELERATOR_FLOORPLAN.computeTiles;
    const computePart = part('compute-tiles', `${ACCELERATOR_FLOORPLAN.computeTiles.label} (${tiles.columns * tiles.rows} tiles)`, 'compute', 'accelerator', 'planned',
      `${tiles.columns} × ${tiles.rows} compute tiles around a shared SRAM strip`, ACCELERATOR_FLOORPLAN.notes[1]);
    const tilePlacements: Array<[number, number, number]> = [];
    for (let row = 0; row < tiles.rows; row += 1) for (let column = 0; column < tiles.columns; column += 1) {
      const sideIndex = column < tiles.columns / 2 ? column - tiles.columns / 2 : column - tiles.columns / 2 + 1;
      const x = Math.sign(sideIndex) * (ACCELERATOR_FLOORPLAN.sharedSram.width / 2 + 0.04 + tiles.tileWidth / 2) + (sideIndex - Math.sign(sideIndex)) * tiles.pitchX;
      tilePlacements.push([x, ACCEL_TOP + 0.02, (row - (tiles.rows - 1) / 2) * tiles.pitchZ]);
    }
    const computeTiles = addInstanced(new THREE.BoxGeometry(tiles.tileWidth, 0.03, tiles.tileDepth), computePart, tilePlacements, { color: '#b7c8d8', metalness: 0.1, roughness: 0.6, siliconDetail: true, layer: 1 });
    addLabel(computeTiles, computePart, 1, [tilePlacements[0][0] - tiles.tileWidth / 2, ACCEL_TOP + 0.04, tilePlacements[0][2] - tiles.tileDepth / 2]);

    const l2Part = part('shared-sram-strip', ACCELERATOR_FLOORPLAN.sharedSram.label, 'macro', 'accelerator', 'planned',
      'Central shared SRAM feeding the compute tiles', 'Placement follows the common GPU/NPU pattern of a central cache strip between tile columns; capacity is a planning placeholder.');
    const l2 = addPart(new THREE.BoxGeometry(ACCELERATOR_FLOORPLAN.sharedSram.width, 0.03, ACCELERATOR_FLOORPLAN.sharedSram.depth), l2Part, [0, ACCEL_TOP + 0.02, 0], { siliconDetail: true, layer: 1, roughness: 0.35 });
    addLabel(l2, l2Part, 1, [0, 0.02, ACCELERATOR_FLOORPLAN.sharedSram.depth / 2 - 0.1]);

    STACK_PLACEMENTS.forEach((placement) => {
      const anchor = acceleratorPhyAnchor(placement);
      const phyPart = part(`accelerator-phy-${placement.index + 1}`, `Memory PHY ${placement.index + 1} (${placement.side} edge)`, 'phy', 'accelerator', 'planned',
        `${metricsRef.current.payloadLanesPerStack.toLocaleString()} payload lanes to stack ${placement.index + 1}`,
        placement.index < stackCount ? 'Edge PHY facing its stack so the interposer route stays short-reach; drivers, receivers, and training are accelerator-partner IP.' : 'Edge PHY reserved for a stack that is not populated in the current configuration.');
      const phy = addPart(new THREE.BoxGeometry(anchor.width, 0.03, anchor.depth), phyPart, [anchor.x, ACCEL_TOP + 0.02, anchor.z], { siliconDetail: true, layer: 1, roughness: 0.4 });
      addLabel(phy, phyPart, 2, [0, 0.02, 0], { text: `PHY ${placement.index + 1}` });
    });

    const acceleratorNetwork = part('accelerator-network', 'Accelerator on-die NoC mesh', 'noc', 'accelerator', 'planned',
      `${metricsRef.current.distributedComputePorts} distributed memory ports`,
      'Visible mesh represents hierarchical connectivity between tiles, shared SRAM, and the eight edge PHYs; production transistor placement and extracted parasitics are absent.');
    let nocSample: THREE.Mesh | null = null;
    for (let index = -2; index <= 2; index += 1) {
      const across = addPart(new THREE.BoxGeometry(0.035, 0.025, 3.7), acceleratorNetwork, [index * 0.95, ACCEL_TOP + 0.05, 0], { siliconDetail: true, layer: 2 });
      addPart(new THREE.BoxGeometry(4.5, 0.025, 0.035), acceleratorNetwork, [0, ACCEL_TOP + 0.05, index * 0.72], { siliconDetail: true, layer: 2 });
      if (index === 2) nocSample = across;
    }
    if (nocSample) addLabel(nocSample, acceleratorNetwork, 1, [0, 0.02, 1.7]);

    // ------------------------------------------------------------------ stacks
    const signals: Array<{ mesh: THREE.Mesh; start: THREE.Vector3; end: THREE.Vector3; offset: number; reverse: boolean }> = [];
    const world = (placement: StackPlacement, localX: number, localZ: number) => stackLocalToWorld(placement, localX, localZ);

    STACK_PLACEMENTS.slice(0, stackCount).forEach((placement) => {
      const n = placement.index + 1;
      const { x, z, rotationY } = placement;

      // Interposer RDL route bundle between the facing PHYs
      const anchor = acceleratorPhyAnchor(placement);
      const phyStrip = BASE_DIE_FLOORPLAN.find((block) => block.id === 'phy')!;
      const [endX, endZ] = world(placement, 0, ((phyStrip.zMm[0] + phyStrip.zMm[1]) / 2) * UNIT_PER_MM);
      const start = new THREE.Vector3(anchor.x, G.interposer.top + 0.01, anchor.z);
      const end = new THREE.Vector3(endX, G.interposer.top + 0.01, endZ);
      const routeLength = start.distanceTo(end);
      const routePart = part(`route-${n}`, `Stack ${n} interposer RDL bundle`, 'route', 'interposer', 'modeled',
        `${(metricsRef.current.payloadLanesPerStack / 256).toFixed(0)} logical 256-lane bundles · ${SAMPLING.routeTracesPerBundle} rendered traces`,
        `${(routeLength / UNIT_PER_MM).toFixed(1)} mm PHY-to-PHY reach at scene scale · ${physicsRef.current.resistanceOhms.toFixed(2)} Ω/trace · ${physicsRef.current.totalElectricalDelayPs.toFixed(1)} ps first-order delay on the 12 mm physics route.`, { stack: n });
      const routePlacements: Array<[number, number, number, number?]> = [];
      const mid = start.clone().add(end).multiplyScalar(0.5);
      for (let trace = 0; trace < SAMPLING.routeTracesPerBundle; trace += 1) {
        const lateral = (trace - (SAMPLING.routeTracesPerBundle - 1) / 2) * 0.1;
        const [tx, tz] = world(placement, lateral, 0);
        routePlacements.push([mid.x + (tx - x), start.y, mid.z + (tz - z), rotationY]);
      }
      const routes = addInstanced(new THREE.BoxGeometry(0.022, 0.012, routeLength), routePart, routePlacements, { color: '#2e74b5', metalness: 0.55, roughness: 0.35 });
      addLabel(routes, routePart, 1, [mid.x, start.y + 0.02, mid.z], { text: `RDL bundle ${n}` });
      for (const reverse of [false, true]) {
        const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true }));
        const [px, pz] = world(placement, reverse ? 0.35 : -0.35, 0);
        const lateral = new THREE.Vector3(px - x, 0, pz - z);
        scene.add(pulse);
        signals.push({ mesh: pulse, start: start.clone().add(lateral), end: end.clone().add(lateral), offset: placement.index / stackCount + (reverse ? 0.5 : 0), reverse });
      }

      // Base die and its connectors
      const basePart = part(`stack-${n}-base`, `Stack ${n} intelligent base die`, 'base', 'base', 'executed',
        `${metricsRef.current.sramMibPerStack} MB local SRAM · ${X1_BASE_DIE_MM} × ${X1_BASE_DIE_MM} mm floorplan`,
        `${metricsRef.current.payloadLanesPerStack.toLocaleString()} payload lanes · T0 RTL and public-PDK mapping evidence. Flip-chip mounted face-down; floorplan shown face-up for inspection.`, { stack: n });
      const base = addPart(new THREE.BoxGeometry(G.baseDie.size, G.baseDie.thickness, G.baseDie.size), basePart, [x, BASE_Y, z], { rotation: rotationY });
      addLabel(base, basePart, 1, [-G.baseDie.size / 2 + 0.05, G.baseDie.thickness / 2 + 0.01, -G.baseDie.size / 2 + 0.05], { text: `Base die ${n}` });

      const baseBumpPart = part(`stack-${n}-microbumps`, `Stack ${n} base-die microbumps`, 'bond', 'base', 'modeled',
        `${SAMPLING.baseMicrobumps.columns * SAMPLING.baseMicrobumps.rows} rendered contacts · ${chain['microbump-base'].referencePitch}`, `${chain['microbump-base'].technology}. ${chain['microbump-base'].note}`, { stack: n });
      const baseBumps = addInstanced(new THREE.CylinderGeometry(G.microbump.radius, G.microbump.radius, G.microbump.height, 8), baseBumpPart, gridPlacements(SAMPLING.baseMicrobumps.columns, SAMPLING.baseMicrobumps.rows, SAMPLING.baseMicrobumps.pitch, MICROBUMP_Y, x, z), { color: '#91abc4', metalness: 0.65, roughness: 0.24, siliconDetail: true });
      const [bumpLabelX, bumpLabelZ] = world(placement, -G.baseDie.size / 2 + 0.1, -G.baseDie.size / 2 - 0.05);
      addLabel(baseBumps, baseBumpPart, 2, [bumpLabelX, MICROBUMP_Y, bumpLabelZ], { text: `µbumps ${n}` });

      // Budget-driven base-die floorplan
      BASE_DIE_FLOORPLAN.forEach((block) => {
        const width = (block.xMm[1] - block.xMm[0]) * UNIT_PER_MM;
        const depth = (block.zMm[1] - block.zMm[0]) * UNIT_PER_MM;
        const [bx, bz] = world(placement, ((block.xMm[0] + block.xMm[1]) / 2) * UNIT_PER_MM, ((block.zMm[0] + block.zMm[1]) / 2) * UNIT_PER_MM);
        const blockPart = part(`stack-${n}-${block.id}`, `Stack ${n} · ${block.label}`, block.id === 'phy' ? 'phy' : 'macro', 'base', 'modeled',
          `${floorplanAreaMm2(block).toFixed(1)} mm² placed · ${block.role}`,
          `Area follows the versioned X1 base-die budget; floorplan pattern adapted from an open ${block.referencePattern}. Not copied RTL or GDS.`, { stack: n });
        const blockMesh = addPart(new THREE.BoxGeometry(width - 0.03, 0.03, depth - 0.03), blockPart, [bx, BASE_TOP + 0.015, bz], { rotation: rotationY, siliconDetail: true, roughness: block.id === 'tsv-field' ? 0.8 : 0.42, baseOpacity: block.id === 'tsv-field' ? 0.6 : 1 });
        addLabel(blockMesh, blockPart, 2, [0, 0.02, 0], { text: block.label });
      });

      const nocPart = part(`stack-${n}-noc`, `Stack ${n} base-die NoC`, 'noc', 'base', 'modeled',
        '16 NoC regions · 128 physical channels', 'Mesh routes scheduling, ECC, gather, refresh, telemetry, and memory traffic across the intelligent base die.', { stack: n });
      let nocFirst: THREE.Mesh | null = null;
      for (let line = -2; line <= 2; line += 1) {
        const [ax, az] = world(placement, line * 0.42, 0);
        const [bx2, bz2] = world(placement, 0, line * 0.42);
        const along = addPart(new THREE.BoxGeometry(0.025, 0.018, 2.05), nocPart, [ax, BASE_TOP + 0.045, az], { rotation: rotationY, siliconDetail: true });
        addPart(new THREE.BoxGeometry(2.05, 0.018, 0.025), nocPart, [bx2, BASE_TOP + 0.045, bz2], { rotation: rotationY, siliconDetail: true });
        if (line === 2) nocFirst = along;
      }
      if (nocFirst) addLabel(nocFirst, nocPart, 2, [0, 0.02, -0.9], { text: `NoC ${n}` });

      const cellPart = part(`stack-${n}-cells`, `Stack ${n} standard-cell rows`, 'cell', 'base', 'executed',
        '40 visible logic-cell samples of 2,447 mapped Sky130 cells', 'Row-based synthesized controller, ECC, and NoC logic inside the controller block; this is not a placed netlist.', { stack: n });
      const cellPlacements: Array<[number, number, number, number?]> = [];
      for (let row = 0; row < 5; row += 1) for (let column = 0; column < 8; column += 1) {
        const [cx, cz] = world(placement, 0.6 + column * 0.075, -0.3 + row * 0.2);
        cellPlacements.push([cx, BASE_TOP + 0.042, cz, rotationY]);
      }
      const cells = addInstanced(new THREE.BoxGeometry(0.05, 0.02, 0.09), cellPart, cellPlacements, { color: '#9fb7cd', metalness: 0.06, roughness: 0.7, siliconDetail: true });
      addLabel(cells, cellPart, 2, [cellPlacements[0][0], BASE_TOP + 0.05, cellPlacements[0][2]], { text: `Cell rows ${n}` });

      const metalPart = part(`stack-${n}-metal`, `Stack ${n} metal stack ${SKY130_VISUAL_LAYERS[0].id} → ${SKY130_VISUAL_LAYERS.at(-1)!.id}`, 'metal', 'base', 'modeled',
        SKY130_VISUAL_LAYERS.map((layer) => layer.id).join(' → '), 'Layer ordering follows public SKY130 conventions; visible straps are illustrative routes over the logic core, not design-rule-clean geometry.', { stack: n });
      let metalTop: THREE.Mesh | null = null;
      SKY130_VISUAL_LAYERS.forEach((layer, layerIndex) => {
        const y = BASE_TOP + 0.075 + layerIndex * 0.02;
        const isHorizontal = layer.direction === 'horizontal';
        const isMesh = layer.direction === 'mesh';
        const strapCount = isMesh ? 3 : 4;
        for (let line = 0; line < strapCount; line += 1) {
          const width = layer.id === 'met5' ? 0.045 : 0.02 + layerIndex * 0.003;
          if (isHorizontal || isMesh) {
            const offset = -1.0 + line * (1.6 / Math.max(1, strapCount - 1));
            const [mx, mz] = world(placement, 0, offset);
            metalTop = addPart(new THREE.BoxGeometry(2.2, 0.01, width), metalPart, [mx, y, mz], { rotation: rotationY, siliconDetail: true, metalness: 0.6, roughness: 0.3 });
          }
          if (!isHorizontal || isMesh) {
            const offset = -1.0 + line * (2.0 / Math.max(1, strapCount - 1));
            const [mx, mz] = world(placement, offset, -0.2);
            metalTop = addPart(new THREE.BoxGeometry(width, 0.01, 1.8), metalPart, [mx, y + (isMesh ? 0.006 : 0), mz], { rotation: rotationY, siliconDetail: true, metalness: 0.6, roughness: 0.3 });
          }
        }
      });
      if (metalTop) addLabel(metalTop, metalPart, 2, [0, 0.01, 0], { text: `Metal li1→met5 · ${n}` });

      const viaPart = part(`stack-${n}-vias`, `Stack ${n} inter-layer via stack`, 'via', 'base', 'modeled',
        '100 sampled vertical inter-layer contacts', 'Represents mcon and via connectivity between local interconnect and upper metal layers; exact enclosures and cuts require DRC-clean layout.', { stack: n });
      const viaPlacements: Array<[number, number, number, number?]> = [];
      for (let layer = 0; layer < 4; layer += 1) for (let row = 0; row < 5; row += 1) for (let column = 0; column < 5; column += 1) {
        const [vx, vz] = world(placement, -0.8 + column * 0.4, -1.0 + row * 0.4);
        viaPlacements.push([vx, BASE_TOP + 0.09 + layer * 0.02, vz]);
      }
      const vias = addInstanced(new THREE.CylinderGeometry(0.012, 0.012, 0.09, 6), viaPart, viaPlacements, { color: '#326fa9', metalness: 0.65, roughness: 0.28, siliconDetail: true });
      addLabel(vias, viaPart, 2, [viaPlacements[4][0], BASE_TOP + 0.16, viaPlacements[4][2]], { text: `Vias ${n}` });

      const clockPart = part(`stack-${n}-clock-tree`, `Stack ${n} clock + reset tree`, 'metal', 'base', 'modeled',
        `${OPEN_TITAN_REFERENCE.clocks.length} reference clock domains · balanced H-tree sample`, 'Uses Earl Grey’s sys, io, usb, and always-on clock-domain pattern to make distribution visible; AIMEM clock frequency and closure remain unqualified.', { stack: n });
      const clockY = BASE_TOP + 0.21;
      const [trunkX, trunkZ] = world(placement, 0, -0.2);
      const trunk = addPart(new THREE.BoxGeometry(0.04, 0.015, 1.8), clockPart, [trunkX, clockY, trunkZ], { rotation: rotationY, siliconDetail: true });
      [[-0.9], [0.5]].forEach(([localZ]) => {
        const [cx, cz] = world(placement, 0, localZ);
        addPart(new THREE.BoxGeometry(2.0, 0.015, 0.035), clockPart, [cx, clockY, cz], { rotation: rotationY, siliconDetail: true });
        [-1.0, 1.0].forEach((localX) => {
          const [sx, sz] = world(placement, localX, localZ);
          addPart(new THREE.BoxGeometry(0.03, 0.015, 0.7), clockPart, [sx, clockY, sz], { rotation: rotationY, siliconDetail: true });
        });
      });
      addLabel(trunk, clockPart, 2, [0, 0.01, 0.85], { text: `Clock tree ${n}` });

      // Vertical TSV column: base-die segment plus one segment per non-top tier
      const tsvPart = part(`stack-${n}-tsv`, `Stack ${n} TSV column`, 'tsv', 'stack', 'restricted',
        `${chain['base-tsv'].referencePitch} · ${SAMPLING.tsv.columns * SAMPLING.tsv.rows} sampled conductors per die`,
        `${metricsRef.current.payloadLanesPerStack.toLocaleString()} payload lanes plus ECC, spare, power, and ground pass through the base die and ${tiers - 1} thinned DRAM tiers; the top tier terminates the column. Pitch and keep-outs require qualified layout.`, { stack: n });
      const tsvGrid = (y: number) => gridPlacements(SAMPLING.tsv.columns, SAMPLING.tsv.rows, SAMPLING.tsv.pitch, y, x, z);
      addInstanced(new THREE.CylinderGeometry(G.tsv.radius, G.tsv.radius, G.baseDie.thickness + G.dramTier.bondGap, 7), tsvPart, tsvGrid(BASE_Y + G.dramTier.bondGap / 2), { color: '#628db8', metalness: 0.65, roughness: 0.3 });
      let topTsv: THREE.Mesh | null = null;
      for (let tier = 0; tier < tiers - 1; tier += 1) {
        topTsv = addInstanced(new THREE.CylinderGeometry(G.tsv.radius, G.tsv.radius, G.dramTier.pitch, 7), tsvPart, tsvGrid(tierCenter(tier) + G.dramTier.bondGap / 2), { color: '#628db8', metalness: 0.65, roughness: 0.3, layer: tier + 1 });
      }
      if (topTsv) addLabel(topTsv, tsvPart, 1, [x, tierCenter(tiers - 2) + G.dramTier.pitch / 2, z], { text: `TSV column ${n}` });

      // Hybrid-bond interface below every tier
      const bondPart = part(`stack-${n}-bonds`, `Stack ${n} hybrid-bond interfaces`, 'bond', 'stack', 'restricted',
        `${tiers} Cu–Cu interfaces · ${chain['hybrid-bond'].referencePitch}`,
        `${SAMPLING.hybridBond.columns} × ${SAMPLING.hybridBond.rows} rendered contacts per interface sample the much denser signal, power, ground, and repair bond map. ${chain['hybrid-bond'].note}`, { stack: n });
      for (let interfaceIndex = 0; interfaceIndex < tiers; interfaceIndex += 1) {
        const bonds = addInstanced(new THREE.CylinderGeometry(G.hybridBond.radius, G.hybridBond.radius, G.hybridBond.height, 7), bondPart, gridPlacements(SAMPLING.hybridBond.columns, SAMPLING.hybridBond.rows, SAMPLING.hybridBond.pitch, bondCenter(interfaceIndex), x, z), { color: '#91abc4', metalness: 0.42, roughness: 0.35, layer: interfaceIndex + 1 });
        if (interfaceIndex === 0) {
          const [lx, lz] = world(placement, G.baseDie.size / 2 - 0.05, -G.baseDie.size / 2 + 0.2);
          addLabel(bonds, bondPart, 1, [lx, bondCenter(0), lz], { text: `Hybrid bonds ${n}` });
        }
      }

      // DRAM tiers
      const stackPart = part(`stack-${n}`, `Stack ${n} · ${tiers}-high memory stack`, 'dram', 'stack', 'restricted',
        `${metricsRef.current.capacityGibPerStack} GiB modeled capacity · ${metricsRef.current.rawBandwidthPerStackTbps.toFixed(3)} TB/s raw`,
        `${placement.side} edge of the accelerator · base die + ${tiers} hybrid-bonded DRAM tiers. ${tiers}-high silicon evidence is absent.`, { stack: n });
      for (let tier = 0; tier < tiers; tier += 1) {
        const dramPart = part(`stack-${n}-tier-${tier + 1}`, `Stack ${n} · DRAM tier ${tier + 1}`, 'dram', 'stack', 'restricted',
          `${(metricsRef.current.capacityGibPerStack / tiers).toFixed(1)} GiB modeled capacity`,
          `${metricsRef.current.rawBandwidthPerStackTbps.toFixed(3)} TB/s raw per stack · ${tier === tiers - 1 ? 'top tier without TSVs' : 'thinned tier with TSV feed-throughs'} · ${tiers}-high silicon evidence absent`, { stack: n, tier });
        const tierMesh = addPart(new THREE.BoxGeometry(G.dramTier.size, G.dramTier.thickness, G.dramTier.size), dramPart, [x, tierCenter(tier), z], { layer: tier + 1, rotation: rotationY });
        addLabel(tierMesh, dramPart, 2, [-G.dramTier.size / 2, 0, -G.dramTier.size / 2], { text: `Tier ${tier + 1}`, tier });
        if (tier === tiers - 1) addLabel(tierMesh, stackPart, 0, [0, G.dramTier.thickness / 2 + 0.03, 0], { text: `Stack ${n} · ${tiers}-high` });
      }
    });

    const packageOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(G.substrate.width + 0.2, 0.7, G.substrate.depth + 0.2)),
      new THREE.LineBasicMaterial({ color: '#7291af', transparent: true, opacity: 0.75 }),
    );
    packageOutline.position.y = -0.25;
    scene.add(packageOutline);
    setComponentCount(partIds.size + stackCount);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      labelRenderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downX = 0;
    let downY = 0;
    renderer.domElement.addEventListener('pointerdown', (event) => { downX = event.clientX; downY = event.clientY; });
    const pick = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(meshes.filter((mesh) => mesh.visible), false)[0]?.object as THREE.Mesh | undefined;
      setSelected(hit ? hit.userData.part as Part : null);
    };
    renderer.domElement.addEventListener('pointerup', pick);

    const labelPosition = new THREE.Vector3();
    let frame = 0;
    const animate = () => {
      frame = window.requestAnimationFrame(animate);
      const focus = stepRef.current.focus;
      const currentOverlay = overlayRef.current;
      const selectedId = selectedRef.current?.id;
      for (const mesh of meshes) {
        const meshPart = mesh.userData.part as Part;
        const material = mesh.material as THREE.MeshStandardMaterial;
        const detailVisible = !mesh.userData.siliconDetail || siliconDetailRef.current;
        mesh.visible = detailVisible;
        if (!detailVisible) continue;
        const layer = mesh.userData.layer as number;
        const targetY = (mesh.userData.baseY as number) + (explodedRef.current ? layer * 0.19 : 0);
        mesh.position.y += (targetY - mesh.position.y) * 0.09;
        material.color.lerp(partColor(meshPart, currentOverlay, metricsRef.current), 0.1);
        const matches = matchesFocus(meshPart, currentOverlay, focus);
        material.opacity += ((matches ? mesh.userData.baseOpacity as number : 0.28) - material.opacity) * 0.09;
        material.emissive.set(selectedId === meshPart.id ? '#244f7d' : '#000000');
        material.emissiveIntensity = selectedId === meshPart.id ? 0.4 : 0;
      }
      const mode = labelModeRef.current;
      for (const label of labels) {
        let show = mode !== 'off' && (label.level === 0 || mode === 'all');
        if (show && label.level > 0) {
          label.object.getWorldPosition(labelPosition);
          const distance = labelPosition.distanceTo(camera.position);
          show = distance < (label.level === 1 ? DETAIL_LABEL_DISTANCE : FINE_LABEL_DISTANCE);
          if (show && label.tier !== undefined && !explodedRef.current) show = label.tier % 4 === 0 || label.tier === tiers - 1;
        }
        label.object.visible = show;
        if (show) {
          label.element.classList.toggle('selected', selectedId === label.part.id);
          label.element.classList.toggle('dim', !matchesFocus(label.part, currentOverlay, focus));
        }
      }
      const elapsed = performance.now() * 0.00022;
      for (const signal of signals) {
        const progress = (elapsed + signal.offset) % 1;
        signal.mesh.position.lerpVectors(signal.start, signal.end, signal.reverse ? 1 - progress : progress);
        signal.mesh.position.y = G.interposer.top + 0.03;
        (signal.mesh.material as THREE.MeshBasicMaterial).opacity = currentOverlay === 'circuitry' ? 1 : 0;
        signal.mesh.visible = currentOverlay === 'circuitry';
      }
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();
    sceneRef.current = { camera, controls, meshes, renderer };

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerup', pick);
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((item) => item.dispose()); else material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
      sceneRef.current = null;
    };
  }, []);

  const zoom = (factor: number) => {
    const current = sceneRef.current;
    if (!current) return;
    const offset = current.camera.position.clone().sub(current.controls.target).multiplyScalar(factor);
    if (offset.length() < current.controls.minDistance || offset.length() > current.controls.maxDistance) return;
    current.camera.position.copy(current.controls.target.clone().add(offset));
    current.controls.update();
  };
  const reset = () => {
    const current = sceneRef.current;
    if (!current) return;
    current.camera.position.set(14.5, 11.5, 17.5);
    current.controls.target.set(0, 1.6, 0);
    current.controls.update();
  };
  const cycleLabels = () => setLabelMode((mode) => LABEL_MODES[(LABEL_MODES.indexOf(mode) + 1) % LABEL_MODES.length]);

  return (
    <div className="twin-viewport-shell">
      <div className="twin-canvas" ref={hostRef} role="img" aria-label="Interactive 3D circuit model of the AIMEM-X1 package: BGA, substrate, stiffener, decoupling capacitors, C4 bumps, silicon interposer with TSVs and RDL bundles, microbumps, accelerator die floorplan, and eight sixteen-tier memory stacks with base-die floorplans, TSV columns, and hybrid bonds" />
      <div className="twin-toolbar" aria-label="3D view controls">
        <button onClick={() => zoom(0.82)} title="Zoom in">＋</button>
        <button onClick={() => zoom(1.22)} title="Zoom out">−</button>
        <button onClick={reset}>Fit</button>
        <button className={siliconDetail ? 'active' : ''} onClick={() => setSiliconDetail((value) => !value)} aria-pressed={siliconDetail}>Silicon detail</button>
        <button className={exploded ? 'active' : ''} onClick={() => setExploded((value) => !value)}>{exploded ? 'Collapse' : 'Explode'}</button>
        <button className={labelMode !== 'off' ? 'active' : ''} onClick={cycleLabels} aria-label={`Component labels: ${labelMode}. Click to change.`}>{LABEL_MODE_TEXT[labelMode]}</button>
        <button className={autoRotate ? 'active' : ''} onClick={() => setAutoRotate((value) => !value)}>Orbit</button>
      </div>
      <div className="twin-instructions">Drag to rotate · scroll or pinch to zoom · right-drag to pan · click any part or its label · zoom in to reveal fine labels · {componentCount} named components</div>
      <div className="twin-selection" aria-live="polite">
        {selected ? <>
          <div><span>Selected component</span><button onClick={() => setSelected(null)} aria-label="Clear selected component">×</button></div>
          <h3>{selected.name}</h3>
          <strong>{selected.primary}</strong>
          <p>{selected.secondary}</p>
          <small className={`twin-status ${selected.evidence}`}>{selected.evidence} evidence</small>
          <small className="twin-status host">{selected.host}{selected.stack ? ` · stack ${selected.stack}` : ''}</small>
        </> : <>
          <span>Interactive selection</span>
          <h3>Explore the package</h3>
          <p>Select any labeled component: BGA balls, substrate, stiffener, capacitors, C4 bumps, interposer TSVs, RDL bundles, microbumps, accelerator tiles, PHYs, base-die floorplan blocks, TSV columns, hybrid bonds, or individual DRAM tiers.</p>
        </>}
      </div>
      <div className="twin-axis" aria-hidden="true"><i className="x" /><i className="y" /><i className="z" /><span>X / Y / Z</span></div>
    </div>
  );
}
