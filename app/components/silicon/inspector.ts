import * as THREE from 'three';
import { describeLocation, formatLength, type ChunkData, type FocusStop } from '@/lib/silicon-macro';
import {
  LABEL_PLAN, PARTS, PART_IDS, STACK_RULER, describePrimitive, identifyChunk, identifyPrimitive, pickChunk, regionLabels,
  type PartId, type PrimitiveRef, type RegionLabel,
} from '@/lib/silicon-parts';
import type { Anchor, Annotations, LabelBox, RulerMark } from './annotations';
import type { SharedUniforms } from './materials';

// What the cursor is on, what is selected, and which parts get labels.
// Everything here tests the same cuts the shaders make (section plane,
// delayering crater, the cut-away sphere around the camera, faded levels),
// so a label or a hover read-out only ever names geometry that is drawn.

export type InspectRecord = { id: string; level: number; data: ChunkData };

export type Target =
  | { kind: 'primitive'; key: string; part: PartId; ref: PrimitiveRef }
  | { kind: 'static'; key: string; part: PartId; box: THREE.Box3 }
  | { kind: 'region'; key: string; label: RegionLabel };

export type SiliconSelection = {
  key: string;
  kind: Target['kind'];
  title: string;
  role: string;
  material: string;
  layer: string;
  size: string;
  location: string[];
  notes: string[];
};

/** A labellable point on a package part (die, stacks, interposer, ...). */
export type StaticAnchor = { part: PartId; object: THREE.Object3D; point: THREE.Vector3; box: THREE.Box3 };

export type InspectorSource = {
  camera: THREE.PerspectiveCamera;
  shared: SharedUniforms;
  sectionPlane: THREE.Plane;
  records: () => Iterable<InspectRecord>;
  /** Whether a detail level is drawn solidly enough to see (fade ≥ 0.5). */
  levelVisible: (level: number) => boolean;
  /** Package meshes currently drawn; userData.part names each. */
  statics: () => THREE.Object3D[];
};

export type PlanView = {
  stop: FocusStop;
  orbit: THREE.Vector3;
  distance: number;
  width: number;
  height: number;
  section: { on: boolean; axis: 0 | 2; value: number };
  packageAnchors: StaticAnchor[];
  /** Targets labelled last time: kept where still valid, so labels do not hop. */
  keep: Set<string>;
};

type Hit =
  | { t: number; kind: 'chunk'; record: InspectRecord; batch: number; index: number }
  | { t: number; kind: 'static'; object: THREE.Object3D; instanceId: number | undefined; normalY: number };

const partsCache = new WeakMap<ChunkData, Uint8Array[]>();
const partsOf = (data: ChunkData) => {
  let ids = partsCache.get(data);
  if (!ids) {
    ids = identifyChunk(data);
    partsCache.set(data, ids);
  }
  return ids;
};

function refOf(record: InspectRecord, batchIndex: number, index: number): PrimitiveRef {
  const batch = record.data.batches[batchIndex];
  const d = batch.data;
  const o = index * 10;
  return {
    level: record.level, material: batch.material, shape: batch.shape,
    x: d[o] + record.data.origin[0], z: d[o + 2] + record.data.origin[2],
    y0: d[o + 1] - d[o + 4] / 2, y1: d[o + 1] + d[o + 4] / 2,
    sx: d[o + 3], sz: d[o + 5], glow: d[o + 8],
  };
}

const size3 = (box: THREE.Box3) => {
  const s = box.getSize(new THREE.Vector3());
  return `${formatLength(Math.max(s.x, s.z))} × ${formatLength(Math.min(s.x, s.z))} × ${formatLength(s.y)} thick`;
};

export function describeTarget(target: Target): SiliconSelection {
  if (target.kind === 'primitive') {
    const d = describePrimitive(target.ref, target.part);
    return { key: target.key, kind: target.kind, title: d.title, role: d.role, material: d.material, layer: d.layer, size: d.size, location: d.location, notes: d.notes };
  }
  if (target.kind === 'static') {
    const part = PARTS[target.part];
    const center = target.box.getCenter(new THREE.Vector3());
    const onDie = target.part === 'die-surface' || target.part === 'die-top';
    const notes = target.part === 'bga' ? ['Balls shown at a sampled pitch, as in the 3D design twin'] : target.part === 'die-surface' ? ['Zoom in and the streamed metal, cells, and transistors replace the texture'] : [];
    return { key: target.key, kind: target.kind, title: part.title, role: part.role, material: part.material, layer: part.layer, size: onDie ? 'Whole die' : size3(target.box), location: onDie ? describeLocation(center.x, center.z) : ['Package'], notes };
  }
  const { label } = target;
  const r = label.rect;
  return {
    key: target.key, kind: target.kind, title: label.title, role: label.detail, material: '', layer: 'Floorplan region',
    size: `${formatLength(r.x1 - r.x0)} × ${formatLength(r.z1 - r.z0)}`, location: describeLocation(label.x, label.z), notes: [],
  };
}

export function createInspector(source: InspectorSource, scene: THREE.Scene) {
  const { camera, shared, sectionPlane } = source;
  const raycaster = new THREE.Raycaster();
  const scratch = new THREE.Vector3();
  const direction = new THREE.Vector3();

  // ---------------------------------------------------------------- cuts
  const craterCleared = (x: number, y: number, z: number) => {
    if (shared.uCraterOn.value < 0.5) return false;
    const c = shared.uCrater.value;
    return y > c.z + Math.max(0, Math.hypot(x - c.x, z - c.y) - c.w) * shared.uCraterSlope.value;
  };
  const culled = (p: THREE.Vector3) => {
    const u = shared.uCull.value;
    return Math.hypot(p.x - u.x, p.y - u.y, p.z - u.z) < u.w;
  };
  const clipped = (p: THREE.Vector3) => sectionPlane.distanceToPoint(p) < 0;
  /** Where a ray leaves the cut-away sphere around the camera (0 if it starts outside). */
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

  // ------------------------------------------------------------- raycast
  function castRay(origin: THREE.Vector3, dir: THREE.Vector3, tLimit = Infinity): Hit | null {
    let t0 = 0;
    let t1 = tLimit;
    // Only the kept side of the section plane is drawn.
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
    for (const record of source.records()) {
      if (!source.levelVisible(record.level)) continue;
      const hit = pickChunk(record.data, o, d, tChip, t1, craterCleared);
      if (!hit) continue;
      t1 = hit.t;
      best = { t: hit.t, kind: 'chunk', record, batch: hit.batch, index: hit.index };
    }
    const statics = source.statics();
    if (statics.length > 0) {
      raycaster.set(origin, dir);
      raycaster.near = t0;
      raycaster.far = t1;
      for (const hit of raycaster.intersectObjects(statics, false)) {
        if (sectionPlane.distanceToPoint(hit.point) < -1e-9) continue;
        if (!best || hit.distance < best.t) best = { t: hit.distance, kind: 'static', object: hit.object, instanceId: hit.instanceId, normalY: hit.face?.normal.y ?? 0 };
        break;
      }
    }
    return best;
  }

  const instanceBox = (object: THREE.Object3D, instanceId: number | undefined) => {
    if (object instanceof THREE.InstancedMesh && instanceId !== undefined) {
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const matrix = new THREE.Matrix4();
      object.getMatrixAt(instanceId, matrix);
      return object.geometry.boundingBox!.clone().applyMatrix4(matrix).applyMatrix4(object.matrixWorld);
    }
    return new THREE.Box3().setFromObject(object);
  };

  function targetOf(hit: Hit, distance: number): Target {
    if (hit.kind === 'chunk') {
      const ref = refOf(hit.record, hit.batch, hit.index);
      return { kind: 'primitive', key: `${hit.record.id}/${hit.batch}/${hit.index}`, part: identifyPrimitive(ref), ref };
    }
    let part = hit.object.userData.part as PartId;
    // The die's top face: the floorplan texture from afar, bare silicon up close.
    if (part === 'die' && hit.normalY > 0.9) part = distance >= 0.02 ? 'die-surface' : 'die-top';
    return { kind: 'static', key: `static/${hit.object.uuid}/${hit.instanceId ?? '-'}/${part}`, part, box: instanceBox(hit.object, hit.instanceId) };
  }

  /** The drawn surface point under a screen point, or null over empty space. */
  function pickPoint(ndc: THREE.Vector2): THREE.Vector3 | null {
    raycaster.setFromCamera(ndc, camera);
    const origin = raycaster.ray.origin.clone();
    const dir = raycaster.ray.direction.clone();
    const hit = castRay(origin, dir);
    return hit ? origin.addScaledVector(dir, hit.t) : null;
  }

  /** What is drawn under a screen point (normalized device coordinates). */
  function pick(ndc: THREE.Vector2): Target | null {
    raycaster.setFromCamera(ndc, camera);
    const origin = raycaster.ray.origin.clone();
    const dir = raycaster.ray.direction.clone();
    const hit = castRay(origin, dir);
    return hit ? targetOf(hit, camera.position.distanceTo(scratch.copy(origin).addScaledVector(dir, hit.t))) : null;
  }

  // ------------------------------------------------------------ outlines
  const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const cylinderEdges = new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.5, 0.5, 1, 32, 1), 30);
  const outline = (color: string, opacity: number, order: number) => {
    const line = new THREE.LineSegments(boxEdges, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
    line.renderOrder = order;
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    return line;
  };
  const hoverLine = outline('#bfeaff', 0.5, 20);
  const selectLine = outline('#43d8ff', 1, 21);

  function place(line: THREE.LineSegments, target: Target | null) {
    if (!target) {
      line.visible = false;
      return;
    }
    let cylinder = false;
    if (target.kind === 'primitive') {
      const { ref } = target;
      cylinder = ref.shape === 'cyl';
      line.position.set(ref.x, (ref.y0 + ref.y1) / 2, ref.z);
      line.scale.set(ref.sx, ref.y1 - ref.y0, ref.sz);
    } else if (target.kind === 'static') {
      target.box.getCenter(line.position);
      target.box.getSize(line.scale);
    } else {
      const r = target.label.rect;
      line.position.set((r.x0 + r.x1) / 2, target.label.y, (r.z0 + r.z1) / 2);
      line.scale.set(r.x1 - r.x0, Math.max(1e-9, (r.x1 - r.x0) * 1e-4), r.z1 - r.z0);
    }
    // A hair larger than the part, so the lines sit just outside its faces.
    line.scale.multiplyScalar(1.004);
    line.geometry = cylinder ? cylinderEdges : boxEdges;
    line.visible = true;
  }

  let selected: Target | null = null;

  // ------------------------------------------------------ label planning
  const project = (p: THREE.Vector3, view: PlanView): [number, number] | null => {
    scratch.copy(p).project(camera);
    if (scratch.z < -1 || scratch.z > 1 || Math.abs(scratch.x) > 0.96 || Math.abs(scratch.y) > 0.96) return null;
    return [((scratch.x + 1) / 2) * view.width, ((1 - scratch.y) / 2) * view.height];
  };
  /** Nothing drawn between the camera and the point, or only the part itself. */
  const seen = (point: THREE.Vector3, same: (hit: Hit) => boolean, tolerance: number) => {
    direction.copy(point).sub(camera.position);
    const distance = direction.length();
    direction.divideScalar(distance);
    const hit = castRay(camera.position, direction, distance * (1 + 1e-6) + tolerance);
    return !hit || same(hit) || hit.t >= distance - tolerance;
  };

  type Entry = { priority: number; title: string; detail: string; key: boolean; tone: Anchor['tone']; candidates: Array<{ point: THREE.Vector3; target: Target; check: (() => boolean) | null }> };

  /**
   * Plans the labels for the current view in small steps (the caller runs it
   * against a time budget, a few steps per frame): region names, package
   * parts, and one visible example of each part class this stop shows, spread
   * so the labels do not collide.
   */
  function* plan(view: PlanView, annotations: Annotations, onSelect: (target: Target) => void): Generator<void, Anchor[]> {
    const entries: Entry[] = [];
    const above = (y: number) => camera.position.y > y;

    // Floorplan regions: names on the top of the stack, read from above.
    if (!view.section.on) {
      for (const label of regionLabels(view.stop.id, view.orbit.x, view.orbit.z)) {
        const point = new THREE.Vector3(label.x, label.y, label.z);
        if (!above(label.y) || culled(point)) continue;
        entries.push({ priority: label.priority, title: label.title, detail: label.detail, key: label.priority >= 2.5, tone: 'region', candidates: [{ point, target: { kind: 'region', key: `region/${label.id}`, label }, check: null }] });
      }
    }
    yield;

    // Package parts, verified against the package meshes.
    const byPart = new Map<PartId, StaticAnchor[]>();
    for (const anchor of view.packageAnchors) byPart.set(anchor.part, [...(byPart.get(anchor.part) ?? []), anchor]);
    for (const [part, anchors] of byPart) {
      const tolerance = view.distance * 0.004;
      entries.push({
        priority: view.stop.id === 'package' ? 3 : 1.6, title: PARTS[part].title, detail: PARTS[part].role, key: true, tone: 'package',
        candidates: anchors.map((anchor) => ({
          point: anchor.point,
          target: { kind: 'static', key: `static/${anchor.object.uuid}/${part}/${anchor.point.toArray().map((v) => v.toFixed(3)).join(',')}`, part, box: anchor.box },
          check: () => !clipped(anchor.point) && seen(anchor.point, (hit) => hit.kind === 'static' && hit.object === anchor.object, tolerance),
        })),
      });
    }
    yield;

    // Part classes: scan the chunks in view for instances of each planned part.
    const planned = LABEL_PLAN[view.stop.id];
    if (planned.length > 0) {
      const wanted = new Map<number, number>(planned.map((id, order) => [PART_IDS.indexOf(id), order]));
      const reach = view.distance * 3;
      const tx = view.orbit.x;
      const tz = view.orbit.z;
      // Best candidate per part per cell of a 4 × 3 screen grid, to spread labels.
      const cells = new Map<string, { score: number; point: THREE.Vector3; target: Target; central: number }>();
      const point = new THREE.Vector3();
      for (const record of source.records()) {
        if (!source.levelVisible(record.level)) continue;
        const b = record.data.bounds;
        if (record.level > 0 && (b.x1 < tx - reach || b.x0 > tx + reach || b.z1 < tz - reach || b.z0 > tz + reach)) continue;
        const ids = partsOf(record.data);
        const [ox, , oz] = record.data.origin;
        record.data.batches.forEach((batch, bi) => {
          const d = batch.data;
          const idsOfBatch = ids[bi];
          for (let k = 0; k < batch.count; k += 1) {
            const order = wanted.get(idsOfBatch[k]);
            if (order === undefined) continue;
            const o = k * 10;
            const cx = d[o] + ox;
            const cz = d[o + 2] + oz;
            const hx = d[o + 3] / 2;
            const hz = d[o + 5] / 2;
            const y0 = d[o + 1] - d[o + 4] / 2;
            const y1 = d[o + 1] + d[o + 4] / 2;
            if (Math.abs(cx - tx) > reach + hx || Math.abs(cz - tz) > reach + hz) continue;
            // The point of the part nearest the target, a little inside its edges.
            point.set(THREE.MathUtils.clamp(tx, cx - hx * 0.7, cx + hx * 0.7), y1, THREE.MathUtils.clamp(tz, cz - hz * 0.7, cz + hz * 0.7));
            if (view.section.on) {
              // Cut parts are labelled on the cut face.
              const lo = view.section.axis === 0 ? cx - hx : cz - hz;
              const hi = view.section.axis === 0 ? cx + hx : cz + hz;
              if (view.section.value > lo && view.section.value < hi) {
                if (view.section.axis === 0) point.x = view.section.value; else point.z = view.section.value;
                point.y = (y0 + y1) / 2;
              }
            }
            if (clipped(point) || culled(point) || craterCleared(point.x, point.y, point.z)) continue;
            const screen = project(point, view);
            if (!screen) continue;
            const cell = `${order}:${Math.min(3, Math.floor((screen[0] / view.width) * 4))}:${Math.min(2, Math.floor((screen[1] / view.height) * 3))}`;
            // Prefer points near the cell centre.
            const score = Math.hypot(((screen[0] / view.width) * 4) % 1 - 0.5, ((screen[1] / view.height) * 3) % 1 - 0.5);
            const current = cells.get(cell);
            if (current && current.score <= score) continue;
            const ref = refOf(record, bi, k);
            const central = Math.hypot(screen[0] / view.width - 0.5, screen[1] / view.height - 0.5);
            cells.set(cell, { score, point: point.clone(), target: { kind: 'primitive', key: `${record.id}/${bi}/${k}`, part: PART_IDS[idsOfBatch[k]], ref }, central });
          }
        });
        yield;
      }
      planned.forEach((part, order) => {
        const found = [...cells.entries()].filter(([cell]) => cell.startsWith(`${order}:`)).map(([, value]) => value);
        if (found.length === 0) return;
        // Last plan's pick first, then central cells; the collision pass
        // falls back to the outer ones.
        found.sort((a, b) => Number(view.keep.has(b.target.key)) - Number(view.keep.has(a.target.key)) || a.central - b.central);
        const tolerance = view.distance * 2e-5;
        entries.push({
          priority: 2.2 - order * 0.04, title: PARTS[part].title, detail: PARTS[part].role, key: order < 3, tone: 'part',
          candidates: found.map((candidate) => ({
            point: candidate.point,
            target: candidate.target,
            check: () => seen(candidate.point, (hit) => hit.kind === 'chunk' && `${hit.record.id}/${hit.batch}/${hit.index}` === candidate.target.key, tolerance),
          })),
        });
      });
    }

    // Greedy placement by priority: the first candidate that is on screen,
    // clear of other labels and panels, and not hidden behind geometry.
    entries.sort((a, b) => b.priority - a.priority);
    const accepted: LabelBox[] = [];
    const anchors: Anchor[] = [];
    for (const entry of entries) {
      const width = annotations.widthOf(entry.title);
      for (const candidate of entry.candidates) {
        const screen = project(candidate.point, view);
        if (!screen) continue;
        const box = annotations.boxAt(screen[0], screen[1], width);
        if (annotations.blocked(box, view.width, view.height)) continue;
        if (accepted.some((other) => box[0] < other[2] + 4 && other[0] < box[2] + 4 && box[1] < other[3] + 3 && other[1] < box[3] + 3)) continue;
        if (candidate.check) {
          const visible = candidate.check();
          yield;
          if (!visible) continue;
        }
        accepted.push(box);
        const target = candidate.target;
        anchors.push({ id: target.key, title: entry.title, detail: entry.detail, world: candidate.point, priority: entry.priority, key: entry.key, tone: entry.tone, targetKey: target.key, select: () => onSelect(target) });
        break;
      }
    }
    return anchors;
  }

  // ------------------------------------------------------ section ruler
  function ruler(view: Pick<PlanView, 'orbit' | 'height' | 'section'>): RulerMark[] {
    const marks: RulerMark[] = [];
    const at = new THREE.Vector3(view.section.axis === 0 ? view.section.value : view.orbit.x, 0, view.section.axis === 2 ? view.section.value : view.orbit.z);
    const screenY = (y: number) => {
      scratch.set(at.x, y, at.z).project(camera);
      return scratch.z > 1 ? null : ((1 - scratch.y) / 2) * view.height;
    };
    for (const band of STACK_RULER) {
      const top = screenY(band.y1);
      const bottom = screenY(band.y0);
      if (top === null || bottom === null) continue;
      if (Math.max(top, bottom) < 60 || Math.min(top, bottom) > view.height - 20) continue;
      marks.push({ id: band.id, label: band.label, top: Math.max(60, Math.min(top, bottom)), bottom: Math.min(view.height - 20, Math.max(top, bottom)) });
    }
    // Top of the screen first, so the collision skip keeps the upper labels.
    return marks.sort((a, b) => a.top - b.top);
  }

  return {
    pick,
    pickPoint,
    plan,
    ruler,
    hover(target: Target | null) {
      place(hoverLine, target && target.key !== selected?.key ? target : null);
    },
    select(target: Target | null) {
      selected = target;
      place(selectLine, target);
      if (target && hoverLine.visible) hoverLine.visible = false;
    },
    get selected() {
      return selected;
    },
    dispose() {
      for (const line of [hoverLine, selectLine]) {
        line.removeFromParent();
        (line.material as THREE.Material).dispose();
      }
      boxEdges.dispose();
      cylinderEdges.dispose();
    },
  };
}

export type Inspector = ReturnType<typeof createInspector>;
