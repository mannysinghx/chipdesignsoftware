'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { TwinBuildStep, TwinOverlay } from '@/lib/design-twin';
import { AIMEM_REFERENCE_MACROS, OPEN_TITAN_REFERENCE, SKY130_VISUAL_LAYERS } from '@/lib/reference-microchip';

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

type Part = {
  id: string;
  name: string;
  kind: 'accelerator' | 'interposer' | 'base' | 'dram' | 'route' | 'noc' | 'tsv' | 'bond' | 'package' | 'bga' | 'pad' | 'macro' | 'cell' | 'metal' | 'via' | 'seal';
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

const PALETTE = {
  navy: new THREE.Color('#244f7d'),
  blue: new THREE.Color('#4f83bd'),
  steel: new THREE.Color('#7f9bb7'),
  pale: new THREE.Color('#cbd9e6'),
  offwhite: new THREE.Color('#f4f1ea'),
  gray: new THREE.Color('#aab4bf'),
};

function partColor(part: Part, overlay: TwinOverlay, metrics: TwinMetrics) {
  if (overlay === 'circuitry') {
    if (part.kind === 'route') return new THREE.Color('#2e74b5');
    if (part.kind === 'noc') return PALETTE.navy;
    if (part.kind === 'tsv') return new THREE.Color('#628db8');
    if (part.kind === 'bond') return new THREE.Color('#91abc4');
    if (part.kind === 'metal' || part.kind === 'via') return new THREE.Color('#326fa9');
    if (part.kind === 'macro') return PALETTE.blue;
    if (part.kind === 'pad' || part.kind === 'seal') return PALETTE.navy;
    if (part.kind === 'cell') return new THREE.Color('#9fb7cd');
    if (part.kind === 'package' || part.kind === 'bga') return PALETTE.gray;
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.steel, 0.35);
  }
  if (overlay === 'architecture') {
    if (part.kind === 'accelerator') return PALETTE.navy;
    if (part.kind === 'interposer') return PALETTE.pale;
    if (part.kind === 'base') return PALETTE.blue;
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.steel, (part.tier ?? 0) / 15);
  }
  if (overlay === 'bandwidth') {
    const pressure = Math.min(1, metrics.deliveredBandwidthTbps / Math.max(1, metrics.aggregateRawBandwidthTbps));
    if (part.kind === 'accelerator') return new THREE.Color().lerpColors(PALETTE.blue, PALETTE.navy, pressure);
    if (part.kind === 'interposer') return PALETTE.steel;
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.blue, 0.5 + pressure * 0.5);
  }
  if (overlay === 'power') {
    const load = Math.min(1, metrics.stackPowerWatts / 65);
    if (part.kind === 'accelerator') return PALETTE.navy;
    if (part.kind === 'interposer') return PALETTE.gray;
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.navy, load * (part.kind === 'base' ? 0.85 : 0.62));
  }
  if (overlay === 'thermal') {
    if (part.kind === 'accelerator') return PALETTE.navy;
    if (part.kind === 'interposer') return PALETTE.pale;
    const height = part.kind === 'base' ? 0.35 : 0.35 + ((part.tier ?? 0) / 15) * 0.65;
    return new THREE.Color().lerpColors(PALETTE.pale, PALETTE.navy, height);
  }
  const evidenceColors = {
    executed: PALETTE.navy,
    modeled: PALETTE.blue,
    planned: PALETTE.steel,
    restricted: PALETTE.gray,
  };
  return evidenceColors[part.evidence];
}

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
  const selectedRef = useRef<Part | null>(null);
  const [selected, setSelected] = useState<Part | null>(null);
  const [exploded, setExploded] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [siliconDetail, setSiliconDetail] = useState(true);

  useEffect(() => { overlayRef.current = overlay; }, [overlay]);
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { metricsRef.current = metrics; }, [metrics]);
  useEffect(() => { physicsRef.current = physics; }, [physics]);
  useEffect(() => { explodedRef.current = exploded; }, [exploded]);
  useEffect(() => { siliconDetailRef.current = siliconDetail; }, [siliconDetail]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { if (sceneRef.current) sceneRef.current.controls.autoRotate = autoRotate; }, [autoRotate]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f7f7f4');
    scene.fog = new THREE.Fog('#f7f7f4', 30, 58);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(19, 15, 22);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 7;
    controls.maxDistance = 52;
    controls.target.set(0, 2.1, 0);
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.autoRotateSpeed = 0.7;

    scene.add(new THREE.HemisphereLight('#ffffff', '#a9b4bf', 2.2));
    const key = new THREE.DirectionalLight('#ffffff', 4.2);
    key.position.set(8, 16, 10);
    scene.add(key);
    const fill = new THREE.DirectionalLight('#8cb7e2', 2.1);
    fill.position.set(-12, 8, -9);
    scene.add(fill);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(25, 64),
      new THREE.MeshStandardMaterial({ color: '#edf0f2', roughness: 1, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.35;
    scene.add(floor);
    const grid = new THREE.GridHelper(42, 42, '#9db0c1', '#dbe1e6');
    grid.position.y = -1.32;
    scene.add(grid);

    const meshes: THREE.Mesh[] = [];
    const addPart = (geometry: THREE.BufferGeometry, part: Part, position: [number, number, number], options?: { layer?: number; rotation?: number; scale?: [number, number, number] }) => {
      const material = new THREE.MeshStandardMaterial({
        color: partColor(part, overlayRef.current, metricsRef.current),
        roughness: part.kind === 'interposer' ? 0.72 : 0.5,
        metalness: part.kind === 'interposer' ? 0.18 : 0.08,
        transparent: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      if (options?.rotation) mesh.rotation.y = options.rotation;
      if (options?.scale) mesh.scale.set(...options.scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.part = part;
      mesh.userData.baseY = position[1];
      mesh.userData.layer = options?.layer ?? 0;
      meshes.push(mesh);
      scene.add(mesh);
      return mesh;
    };

    const markSiliconDetail = <T extends THREE.Mesh>(mesh: T) => {
      mesh.userData.siliconDetail = true;
      return mesh;
    };

    const packagePart: Part = {
      id: 'organic-package', name: 'Organic package substrate', kind: 'package', evidence: 'modeled',
      primary: '19 × 14.2 package-scale substrate',
      secondary: 'Representative core, redistribution, solder-mask, and board-interface volume; dimensions are conceptual rather than package-qualified.',
    };
    addPart(new THREE.BoxGeometry(19, 0.32, 14.2, 2, 1, 2), packagePart, [0, -0.78, 0]);

    const bgaPart: Part = {
      id: 'bga-array', name: 'BGA board connector array', kind: 'bga', evidence: 'modeled',
      primary: '96 visible package solder balls',
      secondary: 'Sampled power, ground, reference-clock, management, and high-speed board connections; not a released package ball map.',
    };
    const bgaMaterial = new THREE.MeshStandardMaterial({ color: '#8a98a7', metalness: 0.72, roughness: 0.27, transparent: true });
    const bga = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 12, 9), bgaMaterial, 96);
    const bgaMatrix = new THREE.Matrix4();
    let bgaIndex = 0;
    for (let row = 0; row < 8; row += 1) for (let column = 0; column < 12; column += 1) {
      bgaMatrix.makeTranslation(-7.7 + column * 1.4, -1.06, -4.9 + row * 1.4);
      bga.setMatrixAt(bgaIndex, bgaMatrix);
      bgaIndex += 1;
    }
    bga.userData.part = bgaPart;
    bga.userData.baseY = 0;
    bga.userData.layer = 0;
    meshes.push(bga);
    scene.add(bga);

    const interposerPart: Part = {
      id: 'interposer', name: 'Active interposer', kind: 'interposer', evidence: 'modeled',
      primary: `${metricsRef.current.interposerRoutingLayers} routing layers`,
      secondary: `${metricsRef.current.distributedComputePorts} distributed compute ports · ${metricsRef.current.routingPressurePercent.toFixed(0)}% route pressure proxy`,
    };
    addPart(new THREE.BoxGeometry(18, 0.52, 13.2, 2, 1, 2), interposerPart, [0, -0.25, 0]);

    const acceleratorPart: Part = {
      id: 'accelerator', name: 'Accelerator die', kind: 'accelerator', evidence: 'planned',
      primary: `${metricsRef.current.acceleratorFabricTbps.toFixed(0)} TB/s fabric proxy`,
      secondary: `${metricsRef.current.deliveredBandwidthTbps.toFixed(1)} TB/s modeled delivery · system bottleneck boundary`,
    };
    addPart(new THREE.BoxGeometry(6.2, 0.95, 5.3, 2, 1, 2), acceleratorPart, [0, 0.55, 0]);

    const microbumpPart: Part = {
      id: 'accelerator-microbumps', name: 'Accelerator microbump array', kind: 'bond', evidence: 'modeled',
      primary: '192 visible die-to-interposer contacts',
      secondary: 'Sampled signal, power, and ground connectors between the accelerator and active interposer; production pitch and assignment require package layout.',
    };
    const microbumpMaterial = new THREE.MeshStandardMaterial({ color: '#91abc4', metalness: 0.65, roughness: 0.24, transparent: true });
    const microbumps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.055, 8), microbumpMaterial, 192);
    let microbumpIndex = 0;
    for (let row = 0; row < 12; row += 1) for (let column = 0; column < 16; column += 1) {
      bgaMatrix.makeTranslation(-2.62 + column * 0.35, 0.045, -2 + row * 0.36);
      microbumps.setMatrixAt(microbumpIndex, bgaMatrix);
      microbumpIndex += 1;
    }
    microbumps.userData.part = microbumpPart;
    microbumps.userData.baseY = 0;
    microbumps.userData.layer = 0;
    markSiliconDetail(microbumps);
    meshes.push(microbumps);
    scene.add(microbumps);

    const sealPart: Part = {
      id: 'seal-ring', name: 'Die seal and guard ring', kind: 'seal', evidence: 'modeled',
      primary: 'Continuous four-sided die-edge structure',
      secondary: 'Represents the mechanical seal, substrate guard, and edge keep-out used around a fabricated die.',
    };
    markSiliconDetail(addPart(new THREE.BoxGeometry(6.08, 0.07, 0.08), sealPart, [0, 1.065, -2.52]));
    markSiliconDetail(addPart(new THREE.BoxGeometry(6.08, 0.07, 0.08), sealPart, [0, 1.065, 2.52]));
    markSiliconDetail(addPart(new THREE.BoxGeometry(0.08, 0.07, 4.96), sealPart, [-2.92, 1.065, 0]));
    markSiliconDetail(addPart(new THREE.BoxGeometry(0.08, 0.07, 4.96), sealPart, [2.92, 1.065, 0]));

    const padPart: Part = {
      id: 'asic-pad-ring', name: 'Four-bank ASIC pad ring', kind: 'pad', evidence: 'modeled',
      primary: `${OPEN_TITAN_REFERENCE.asicPadCount} visible pads across ${OPEN_TITAN_REFERENCE.ioBanks} banks`,
      secondary: 'Count and bank organization follow the open Earl Grey ASIC reference; signals are reassigned to AIMEM and are not an AIMEM production pinout.',
    };
    const addPadBank = (count: number, side: 'north' | 'south' | 'east' | 'west') => {
      for (let index = 0; index < count; index += 1) {
        const horizontal = side === 'north' || side === 'south';
        const progress = count === 1 ? 0 : index / (count - 1);
        const x = horizontal ? -2.65 + progress * 5.3 : side === 'west' ? -2.76 : 2.76;
        const z = horizontal ? side === 'north' ? -2.36 : 2.36 : -2.15 + progress * 4.3;
        markSiliconDetail(addPart(new THREE.BoxGeometry(horizontal ? 0.19 : 0.12, 0.055, horizontal ? 0.12 : 0.19), padPart, [x, 1.09, z]));
      }
    };
    addPadBank(18, 'north');
    addPadBank(18, 'south');
    addPadBank(18, 'west');
    addPadBank(17, 'east');

    const cellPart: Part = {
      id: 'standard-cell-field', name: 'Placed standard-cell rows', kind: 'cell', evidence: 'modeled',
      primary: '336 visible logic-cell samples',
      secondary: 'Represents row-based synthesized control, DMA, ECC, clock, and NoC logic between hardened macros; this is not a placed netlist.',
    };
    const cellMaterial = new THREE.MeshStandardMaterial({ color: '#9fb7cd', roughness: 0.7, metalness: 0.06, transparent: true });
    const cells = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.025, 0.09), cellMaterial, 336);
    let cellIndex = 0;
    for (let row = 0; row < 14; row += 1) for (let column = 0; column < 24; column += 1) {
      bgaMatrix.makeTranslation(-2.35 + column * 0.205, 1.045, -1.95 + row * 0.30);
      cells.setMatrixAt(cellIndex, bgaMatrix);
      cellIndex += 1;
    }
    cells.userData.part = cellPart;
    cells.userData.baseY = 0;
    cells.userData.layer = 0;
    markSiliconDetail(cells);
    meshes.push(cells);
    scene.add(cells);

    AIMEM_REFERENCE_MACROS.forEach((macro, macroIndex) => {
      const macroPart: Part = {
        id: `macro-${macro.id}`, name: macro.label, kind: 'macro', evidence: 'modeled',
        primary: `${macro.domain === 'always-on' ? 'Always-on' : 'Main'} power domain · ${macro.aimemRole}`,
        secondary: `Floorplan pattern adapted from an open ${macro.referencePattern}; functional assignment is AIMEM-specific and not copied RTL or GDS.`,
      };
      const macroMesh = markSiliconDetail(addPart(new THREE.BoxGeometry(macro.width, 0.1, macro.depth), macroPart, [macro.x, 1.10, macro.z], { layer: macroIndex % 2 }));
      (macroMesh.material as THREE.MeshStandardMaterial).roughness = macro.domain === 'always-on' ? 0.32 : 0.48;
    });

    const metalPart: Part = {
      id: 'sky130-metal-stack', name: 'Sampled local-to-global metal stack', kind: 'metal', evidence: 'modeled',
      primary: `${SKY130_VISUAL_LAYERS.map((layer) => layer.id).join(' → ')}`,
      secondary: 'Layer ordering follows public SKY130 conventions; visible straps are illustrative AIMEM routes, not design-rule-clean production geometry.',
    };
    SKY130_VISUAL_LAYERS.forEach((layer, layerIndex) => {
      const y = 1.19 + layerIndex * 0.032;
      const isHorizontal = layer.direction === 'horizontal';
      const isMesh = layer.direction === 'mesh';
      const strapCount = isMesh ? 5 : 7;
      for (let line = 0; line < strapCount; line += 1) {
        const offset = -2.05 + line * (4.1 / Math.max(1, strapCount - 1));
        const width = layer.id === 'met5' ? 0.055 : 0.025 + layerIndex * 0.004;
        if (isHorizontal || isMesh) markSiliconDetail(addPart(new THREE.BoxGeometry(5.25, 0.012, width), metalPart, [0, y, offset], { layer: layerIndex }));
        if (!isHorizontal || isMesh) markSiliconDetail(addPart(new THREE.BoxGeometry(width, 0.012, 4.45), metalPart, [offset, y + (isMesh ? 0.007 : 0), 0], { layer: layerIndex }));
      }
    });

    const viaPart: Part = {
      id: 'via-stack', name: 'Inter-layer via stack', kind: 'via', evidence: 'modeled',
      primary: '320 sampled vertical inter-layer contacts',
      secondary: 'Represents mcon and via connectivity between local interconnect and upper metal layers; exact enclosures and cuts require DRC-clean layout.',
    };
    const viaMaterial = new THREE.MeshStandardMaterial({ color: '#326fa9', metalness: 0.65, roughness: 0.28, transparent: true });
    const vias = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.018, 0.018, 0.18, 6), viaMaterial, 320);
    let viaIndex = 0;
    for (let layer = 0; layer < 4; layer += 1) for (let row = 0; row < 8; row += 1) for (let column = 0; column < 10; column += 1) {
      bgaMatrix.makeTranslation(-2.15 + column * 0.48, 1.23 + layer * 0.02, -1.75 + row * 0.5);
      vias.setMatrixAt(viaIndex, bgaMatrix);
      viaIndex += 1;
    }
    vias.userData.part = viaPart;
    vias.userData.baseY = 0;
    vias.userData.layer = 0;
    markSiliconDetail(vias);
    meshes.push(vias);
    scene.add(vias);

    const clockPart: Part = {
      id: 'clock-reset-tree', name: 'Clock and reset distribution tree', kind: 'metal', evidence: 'modeled',
      primary: `${OPEN_TITAN_REFERENCE.clocks.length} reference clock domains · balanced H-tree sample`,
      secondary: 'Uses Earl Grey’s sys, io, usb, and always-on clock-domain pattern to make distribution visible; AIMEM clock frequency and closure remain unqualified.',
    };
    [[0, 5.05, 0.055], [-1.3, 2.5, 0.04], [1.3, 2.5, 0.04]].forEach(([x, length, width], index) => {
      markSiliconDetail(addPart(new THREE.BoxGeometry(width, 0.02, length), clockPart, [x, 1.405, 0], { layer: 7 + index }));
    });
    [[-1.3, -1.25], [-1.3, 1.25], [1.3, -1.25], [1.3, 1.25]].forEach(([x, z]) => {
      markSiliconDetail(addPart(new THREE.BoxGeometry(2.6, 0.02, 0.04), clockPart, [x, 1.405, z], { layer: 8 }));
    });

    const stackPositions: Array<[number, number]> = [
      [-6.7, -4.2], [-2.3, -4.2], [2.3, -4.2], [6.7, -4.2],
      [-6.7, 4.2], [-2.3, 4.2], [2.3, 4.2], [6.7, 4.2],
    ];
    const signals: Array<{ mesh: THREE.Mesh; curve: THREE.CatmullRomCurve3; offset: number }> = [];
    const circuitPart = (id: string, name: string, kind: Part['kind'], primary: string, secondary: string): Part => ({ id, name, kind, evidence: 'modeled', primary, secondary });

    const acceleratorNetwork = circuitPart(
      'accelerator-network', 'Accelerator on-die network', 'noc',
      `${metricsRef.current.distributedComputePorts} distributed memory ports`,
      'Visible mesh represents hierarchical connectivity; production transistor placement and extracted parasitics are absent.',
    );
    for (let index = -2; index <= 2; index += 1) {
      addPart(new THREE.BoxGeometry(0.035, 0.025, 4.45), acceleratorNetwork, [index * 1.08, 1.04, 0]);
      addPart(new THREE.BoxGeometry(5.25, 0.025, 0.035), acceleratorNetwork, [0, 1.04, index * 0.88]);
    }

    stackPositions.slice(0, metricsRef.current.stackCount).forEach(([x, z], stackIndex) => {
      const routePart = circuitPart(
        `route-${stackIndex + 1}`, `Accelerator ↔ stack ${stackIndex + 1} interposer bundle`, 'route',
        `${(metricsRef.current.payloadLanesPerStack / 256).toFixed(0)} logical 256-lane bundles`,
        `${physicsRef.current.resistanceOhms.toFixed(2)} Ω/trace · ${physicsRef.current.totalElectricalDelayPs.toFixed(1)} ps first-order electrical delay`,
      );
      const start = new THREE.Vector3(Math.sign(x) * 2.85, 0.23, Math.sign(z) * 1.75);
      const end = new THREE.Vector3(x, 0.23, z);
      const bend = new THREE.Vector3(x * 0.54, 0.27, z * 0.54);
      const curve = new THREE.CatmullRomCurve3([start, bend, end]);
      addPart(new THREE.TubeGeometry(curve, 36, 0.055, 7, false), routePart, [0, 0, 0]);
      const returnCurve = new THREE.CatmullRomCurve3([
        start.clone().add(new THREE.Vector3(0.13, 0, -0.11)),
        bend.clone().add(new THREE.Vector3(0.13, 0, -0.11)),
        end.clone().add(new THREE.Vector3(0.13, 0, -0.11)),
      ]);
      addPart(new THREE.TubeGeometry(returnCurve, 36, 0.028, 6, false), routePart, [0, 0, 0]);
      const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.105, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true }));
      pulse.userData.circuitPulse = true;
      scene.add(pulse);
      signals.push({ mesh: pulse, curve, offset: stackIndex / metricsRef.current.stackCount });
    });

    stackPositions.slice(0, metricsRef.current.stackCount).forEach(([x, z], stackIndex) => {
      const basePart: Part = {
        id: `stack-${stackIndex + 1}-base`, name: `Stack ${stackIndex + 1} intelligent base die`, kind: 'base', stack: stackIndex + 1, evidence: 'executed',
        primary: `${metricsRef.current.sramMibPerStack} MB local SRAM`,
        secondary: `${metricsRef.current.payloadLanesPerStack.toLocaleString()} payload lanes · T0 RTL and public-PDK mapping evidence`,
      };
      addPart(new THREE.BoxGeometry(2.45, 0.34, 2.45), basePart, [x, 0.28, z], { layer: 0 });
      const nocPart = circuitPart(
        `stack-${stackIndex + 1}-noc`, `Stack ${stackIndex + 1} base-die NoC`, 'noc',
        '16 NoC regions · 128 physical channels',
        'Mesh routes scheduling, ECC, gather, refresh, telemetry, and memory traffic across the intelligent base die.',
      );
      for (let line = -2; line <= 2; line += 1) {
        addPart(new THREE.BoxGeometry(0.025, 0.018, 2.05), nocPart, [x + line * 0.42, 0.47, z]);
        addPart(new THREE.BoxGeometry(2.05, 0.018, 0.025), nocPart, [x, 0.47, z + line * 0.42]);
      }

      const tsvPart = circuitPart(
        `stack-${stackIndex + 1}-tsv`, `Stack ${stackIndex + 1} TSV bundle`, 'tsv',
        `${metricsRef.current.payloadLanesPerStack.toLocaleString()} payload lanes represented by 16 sampled vertical conductors`,
        'Vertical conductors connect base-die PHY endpoints through the 16-tier stack; exact pitch and keep-outs require qualified layout.',
      );
      for (let row = -1.5; row <= 1.5; row += 1) for (let column = -1.5; column <= 1.5; column += 1) {
        addPart(new THREE.CylinderGeometry(0.022, 0.022, 2.75, 7), tsvPart, [x + row * 0.24, 1.89, z + column * 0.24]);
      }

      const bondPart = circuitPart(
        `stack-${stackIndex + 1}-bonds`, `Stack ${stackIndex + 1} hybrid-bond array`, 'bond',
        `${metricsRef.current.dramTiers} vertical die interfaces`,
        '4 × 4 visible contacts per interface are a sampled representation of the much denser signal, power, ground, and repair network.',
      );
      const bondGeometry = new THREE.CylinderGeometry(0.032, 0.032, 0.045, 7);
      const bondMaterial = new THREE.MeshStandardMaterial({ color: partColor(bondPart, overlayRef.current, metricsRef.current), metalness: 0.42, roughness: 0.35, transparent: true });
      const bonds = new THREE.InstancedMesh(bondGeometry, bondMaterial, metricsRef.current.dramTiers * 16);
      const matrix = new THREE.Matrix4();
      let bondIndex = 0;
      for (let tier = 0; tier < metricsRef.current.dramTiers; tier += 1) {
        for (let row = -1.5; row <= 1.5; row += 1) for (let column = -1.5; column <= 1.5; column += 1) {
          matrix.makeTranslation(x + row * 0.28, 0.50 + tier * 0.17, z + column * 0.28);
          bonds.setMatrixAt(bondIndex, matrix);
          bondIndex += 1;
        }
      }
      bonds.userData.part = bondPart;
      bonds.userData.baseY = 0;
      bonds.userData.layer = 0;
      meshes.push(bonds);
      scene.add(bonds);
      Array.from({ length: metricsRef.current.dramTiers }).forEach((_, tier) => {
        const dramPart: Part = {
          id: `stack-${stackIndex + 1}-tier-${tier + 1}`, name: `Stack ${stackIndex + 1} · DRAM tier ${tier + 1}`, kind: 'dram', stack: stackIndex + 1, tier, evidence: 'restricted',
          primary: `${(metricsRef.current.capacityGibPerStack / metricsRef.current.dramTiers).toFixed(1)} GiB modeled capacity`,
          secondary: `${metricsRef.current.rawBandwidthPerStackTbps.toFixed(3)} TB/s raw per stack · 16-high silicon evidence absent`,
        };
        addPart(new THREE.BoxGeometry(2.35, 0.13, 2.35), dramPart, [x, 0.58 + tier * 0.17, z], { layer: tier + 1 });
      });
    });

    const packageOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(18.3, 0.7, 13.5)),
      new THREE.LineBasicMaterial({ color: '#7291af', transparent: true, opacity: 0.75 }),
    );
    packageOutline.position.y = -0.25;
    scene.add(packageOutline);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
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
      const hit = raycaster.intersectObjects(meshes, false)[0]?.object as THREE.Mesh | undefined;
      setSelected(hit ? hit.userData.part as Part : null);
    };
    renderer.domElement.addEventListener('pointerup', pick);

    let frame = 0;
    const animate = () => {
      frame = window.requestAnimationFrame(animate);
      const focus = stepRef.current.focus;
      for (const mesh of meshes) {
        const part = mesh.userData.part as Part;
        const material = mesh.material as THREE.MeshStandardMaterial;
        const detailVisible = !mesh.userData.siliconDetail || siliconDetailRef.current;
        mesh.visible = detailVisible;
        if (!detailVisible) continue;
        const layer = mesh.userData.layer as number;
        const targetY = (mesh.userData.baseY as number) + (explodedRef.current ? layer * 0.19 : 0);
        mesh.position.y += (targetY - mesh.position.y) * 0.09;
        material.color.lerp(partColor(part, overlayRef.current, metricsRef.current), 0.1);
        const circuitKind = ['route', 'noc', 'tsv', 'bond', 'package', 'bga', 'pad', 'macro', 'cell', 'metal', 'via', 'seal'].includes(part.kind);
        const matches = overlayRef.current === 'circuitry' && circuitKind || focus === 'system' || focus === 'stack' && (part.kind === 'dram' || part.kind === 'base' || circuitKind) || focus === part.kind;
        material.opacity += ((matches ? 1 : 0.28) - material.opacity) * 0.09;
        material.emissive.set(selectedRef.current?.id === part.id ? '#244f7d' : '#000000');
        material.emissiveIntensity = selectedRef.current?.id === part.id ? 0.4 : 0;
      }
      const elapsed = performance.now() * 0.00022;
      for (const signal of signals) {
        signal.mesh.position.copy(signal.curve.getPoint((elapsed + signal.offset) % 1));
        (signal.mesh.material as THREE.MeshBasicMaterial).opacity = overlayRef.current === 'circuitry' ? 1 : 0;
        signal.mesh.visible = overlayRef.current === 'circuitry';
      }
      controls.update();
      renderer.render(scene, camera);
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
    current.camera.position.set(19, 15, 22);
    current.controls.target.set(0, 2.1, 0);
    current.controls.update();
  };

  return (
    <div className="twin-viewport-shell">
      <div className="twin-canvas" ref={hostRef} role="img" aria-label="Interactive 3D circuit model of the AIMEM-X1 accelerator, interposer traces, base-die networks, TSVs, hybrid bonds, and eight sixteen-tier memory stacks" />
      <div className="twin-toolbar" aria-label="3D view controls">
        <button onClick={() => zoom(0.82)} title="Zoom in">＋</button>
        <button onClick={() => zoom(1.22)} title="Zoom out">−</button>
        <button onClick={reset}>Fit</button>
        <button className={siliconDetail ? 'active' : ''} onClick={() => setSiliconDetail((value) => !value)} aria-pressed={siliconDetail}>Silicon detail</button>
        <button className={exploded ? 'active' : ''} onClick={() => setExploded((value) => !value)}>{exploded ? 'Collapse' : 'Explode'}</button>
        <button className={autoRotate ? 'active' : ''} onClick={() => setAutoRotate((value) => !value)}>Orbit</button>
      </div>
      <div className="twin-instructions">Drag to rotate · scroll or pinch to zoom · right-drag to pan · select dies, pads, macros, metal, vias, routes, TSVs, bumps, or BGA balls</div>
      <div className="twin-selection" aria-live="polite">
        {selected ? <>
          <div><span>Selected component</span><button onClick={() => setSelected(null)} aria-label="Clear selected component">×</button></div>
          <h3>{selected.name}</h3>
          <strong>{selected.primary}</strong>
          <p>{selected.secondary}</p>
          <small className={`twin-status ${selected.evidence}`}>{selected.evidence} evidence</small>
        </> : <>
          <span>Interactive selection</span>
          <h3>Explore the package</h3>
          <p>Select the accelerator, package, BGA, pad ring, functional macros, cell field, metal or via stack, interposer route, TSV bundle, or hybrid-bond array to inspect its linked data.</p>
        </>}
      </div>
      <div className="twin-axis" aria-hidden="true"><i className="x" /><i className="y" /><i className="z" /><span>X / Y / Z</span></div>
    </div>
  );
}
