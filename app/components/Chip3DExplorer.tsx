'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { TwinBuildStep, TwinOverlay } from '@/lib/design-twin';

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

type Part = {
  id: string;
  name: string;
  kind: 'accelerator' | 'interposer' | 'base' | 'dram';
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

export default function Chip3DExplorer({ overlay, step, metrics }: Props) {
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
  const explodedRef = useRef(false);
  const selectedRef = useRef<Part | null>(null);
  const [selected, setSelected] = useState<Part | null>(null);
  const [exploded, setExploded] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);

  useEffect(() => { overlayRef.current = overlay; }, [overlay]);
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { metricsRef.current = metrics; }, [metrics]);
  useEffect(() => { explodedRef.current = exploded; }, [exploded]);
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
    floor.position.y = -0.75;
    scene.add(floor);
    const grid = new THREE.GridHelper(42, 42, '#9db0c1', '#dbe1e6');
    grid.position.y = -0.72;
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

    const stackPositions: Array<[number, number]> = [
      [-6.7, -4.2], [-2.3, -4.2], [2.3, -4.2], [6.7, -4.2],
      [-6.7, 4.2], [-2.3, 4.2], [2.3, 4.2], [6.7, 4.2],
    ];
    stackPositions.slice(0, metricsRef.current.stackCount).forEach(([x, z], stackIndex) => {
      const basePart: Part = {
        id: `stack-${stackIndex + 1}-base`, name: `Stack ${stackIndex + 1} intelligent base die`, kind: 'base', stack: stackIndex + 1, evidence: 'executed',
        primary: `${metricsRef.current.sramMibPerStack} MB local SRAM`,
        secondary: `${metricsRef.current.payloadLanesPerStack.toLocaleString()} payload lanes · T0 RTL and public-PDK mapping evidence`,
      };
      addPart(new THREE.BoxGeometry(2.45, 0.34, 2.45), basePart, [x, 0.28, z], { layer: 0 });
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
        const layer = mesh.userData.layer as number;
        const targetY = (mesh.userData.baseY as number) + (explodedRef.current ? layer * 0.19 : 0);
        mesh.position.y += (targetY - mesh.position.y) * 0.09;
        material.color.lerp(partColor(part, overlayRef.current, metricsRef.current), 0.1);
        const matches = focus === 'system' || focus === 'stack' && (part.kind === 'dram' || part.kind === 'base') || focus === part.kind;
        material.opacity += ((matches ? 1 : 0.28) - material.opacity) * 0.09;
        material.emissive.set(selectedRef.current?.id === part.id ? '#244f7d' : '#000000');
        material.emissiveIntensity = selectedRef.current?.id === part.id ? 0.4 : 0;
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
      <div className="twin-canvas" ref={hostRef} role="img" aria-label="Interactive 3D model of the AIMEM-X1 accelerator package with eight sixteen-tier memory stacks" />
      <div className="twin-toolbar" aria-label="3D view controls">
        <button onClick={() => zoom(0.82)} title="Zoom in">＋</button>
        <button onClick={() => zoom(1.22)} title="Zoom out">−</button>
        <button onClick={reset}>Fit</button>
        <button className={exploded ? 'active' : ''} onClick={() => setExploded((value) => !value)}>{exploded ? 'Collapse' : 'Explode'}</button>
        <button className={autoRotate ? 'active' : ''} onClick={() => setAutoRotate((value) => !value)}>Orbit</button>
      </div>
      <div className="twin-instructions">Drag to rotate · scroll or pinch to zoom · right-drag to pan · select any die</div>
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
          <p>Select the accelerator, interposer, a base die, or any of the 128 visible DRAM tiers to inspect its linked data.</p>
        </>}
      </div>
      <div className="twin-axis" aria-hidden="true"><i className="x" /><i className="y" /><i className="z" /><span>X / Y / Z</span></div>
    </div>
  );
}
