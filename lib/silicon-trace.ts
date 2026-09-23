// Net tracing for the Silicon macro view: starting from one drawn conductor,
// collect every conductor that touches it, as a circuit extractor would. The
// generator draws each net as touching pieces (a wire overlaps the vias at
// its ends, a via stands on the wire below it), so the traced set is the net
// as drawn: from a transistor contact up through the metal stack and back
// down into the cells it drives. Supply nets reach the whole power grid, so a
// trace stops after `limit` pieces and says so.

import { FLOATS_PER_INSTANCE, type ChunkData, type MaterialKey } from './silicon-macro.ts';
import { flowOfPhase, partOfPhase, type Flow, type PartId } from './silicon-part-ids.ts';

export type TraceRecord = { id: string; level: number; data: ChunkData };
export type TracePiece = { record: TraceRecord; batch: number; index: number };
export type Aabb = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };

/** Materials that conduct. Fins (silicon) and liners (oxide) are where a net stops. */
export const CONDUCTORS: ReadonlySet<MaterialKey> = new Set<MaterialKey>(['copper', 'gold', 'tungsten', 'gate', 'solder', 'epiN', 'epiP']);

// Touching in plan, allowing for float32 rounding at each level's scale.
const PLAN_TOLERANCE = [5e-6, 5e-7, 5e-8, 5e-9, 5e-9];
// Vertically, small gaps are bridged (a contact meets the M0 wire resting on
// it), but never a whole via band between two metal layers.
const MAX_GAP = 6e-6;

const GRID = 24;

type ChunkIndex = { x0: number; z0: number; cx: number; cz: number; cells: number[][] };
const indexCache = new WeakMap<ChunkData, ChunkIndex>();

/** World-space box of one primitive. */
export function pieceBox(data: ChunkData, batch: number, index: number): Aabb {
  const d = data.batches[batch].data;
  const o = index * FLOATS_PER_INSTANCE;
  const x = d[o] + data.origin[0];
  const z = d[o + 2] + data.origin[2];
  return { x0: x - d[o + 3] / 2, x1: x + d[o + 3] / 2, y0: d[o + 1] - d[o + 4] / 2, y1: d[o + 1] + d[o + 4] / 2, z0: z - d[o + 5] / 2, z1: z + d[o + 5] / 2 };
}

function indexOf(data: ChunkData): ChunkIndex {
  let found = indexCache.get(data);
  if (found) return found;
  // Cylinders may overhang the chunk a little; pad the grid.
  const padX = (data.bounds.x1 - data.bounds.x0) * 0.05;
  const padZ = (data.bounds.z1 - data.bounds.z0) * 0.05;
  const x0 = data.bounds.x0 - padX;
  const z0 = data.bounds.z0 - padZ;
  const cx = (data.bounds.x1 - data.bounds.x0 + 2 * padX) / GRID;
  const cz = (data.bounds.z1 - data.bounds.z0 + 2 * padZ) / GRID;
  const cells: number[][] = Array.from({ length: GRID * GRID }, () => []);
  data.batches.forEach((batch, b) => {
    if (!CONDUCTORS.has(batch.material)) return;
    for (let k = 0; k < batch.count; k += 1) {
      const box = pieceBox(data, b, k);
      const i0 = clampCell((box.x0 - x0) / cx);
      const i1 = clampCell((box.x1 - x0) / cx);
      const j0 = clampCell((box.z0 - z0) / cz);
      const j1 = clampCell((box.z1 - z0) / cz);
      for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) cells[j * GRID + i].push(b * 1048576 + k);
    }
  });
  found = { x0, z0, cx, cz, cells };
  indexCache.set(data, found);
  return found;
}

const clampCell = (value: number) => Math.min(GRID - 1, Math.max(0, Math.floor(value)));

function touching(a: Aabb, b: Aabb, plan: number) {
  if (a.x0 > b.x1 + plan || b.x0 > a.x1 + plan || a.z0 > b.z1 + plan || b.z0 > a.z1 + plan) return false;
  const gap = Math.min(MAX_GAP, 0.25 * Math.min(a.y1 - a.y0, b.y1 - b.y0));
  return a.y0 <= b.y1 + gap && b.y0 <= a.y1 + gap;
}

/** `open`: the net runs off the loaded chunks, so more of it exists than was traced. */
export type TraceResult = { pieces: TracePiece[]; truncated: boolean; open: boolean };

/** Whether a piece is cut by its chunk's edge where the neighbouring chunk is not loaded. */
function leavesLoaded(piece: TracePiece, loaded: Set<string>) {
  const data = piece.record.data;
  // Only boxes are clipped at chunk edges (a cylinder stays whole in the chunk holding its axis).
  if (piece.record.level === 0 || data.batches[piece.batch].shape !== 'box') return false;
  const box = pieceBox(data, piece.batch, piece.index);
  const e = (data.bounds.x1 - data.bounds.x0) * 1e-6;
  const { level, ix, iz } = data;
  const edges: Array<[boolean, number, number]> = [
    [box.x0 <= data.bounds.x0 + e, ix - 1, iz], [box.x1 >= data.bounds.x1 - e, ix + 1, iz],
    [box.z0 <= data.bounds.z0 + e, ix, iz - 1], [box.z1 >= data.bounds.z1 - e, ix, iz + 1],
  ];
  return edges.some(([cut, jx, jz]) => cut && !loaded.has(`${level}:${jx}:${jz}`));
}

/**
 * Every conductor connected to `seed` across the given chunks (all detail
 * levels: a via stack from one level lands on a pad drawn by the next).
 */
export function traceNet(seed: TracePiece, records: Iterable<TraceRecord>, limit = 2500): TraceResult {
  const all = [...records];
  const loaded = new Set(all.map((record) => record.id));
  const key = (piece: TracePiece) => `${piece.record.id}/${piece.batch}/${piece.index}`;
  if (!CONDUCTORS.has(seed.record.data.batches[seed.batch]?.material)) return { pieces: [], truncated: false, open: false };
  const seen = new Set<string>([key(seed)]);
  const pieces: TracePiece[] = [seed];
  const queue: TracePiece[] = [seed];
  while (queue.length > 0) {
    const piece = queue.pop()!;
    const box = pieceBox(piece.record.data, piece.batch, piece.index);
    for (const record of all) {
      const data = record.data;
      const plan = Math.max(PLAN_TOLERANCE[record.level] ?? 5e-9, PLAN_TOLERANCE[piece.record.level] ?? 5e-9);
      if (box.x0 > data.bounds.x1 + plan * 4 + (data.bounds.x1 - data.bounds.x0) * 0.05 || box.x1 < data.bounds.x0 - plan * 4 - (data.bounds.x1 - data.bounds.x0) * 0.05) continue;
      if (box.z0 > data.bounds.z1 + plan * 4 + (data.bounds.z1 - data.bounds.z0) * 0.05 || box.z1 < data.bounds.z0 - plan * 4 - (data.bounds.z1 - data.bounds.z0) * 0.05) continue;
      if (box.y0 > data.yMax + MAX_GAP || box.y1 < data.yMin - MAX_GAP) continue;
      const grid = indexOf(data);
      const i0 = clampCell((box.x0 - plan - grid.x0) / grid.cx);
      const i1 = clampCell((box.x1 + plan - grid.x0) / grid.cx);
      const j0 = clampCell((box.z0 - plan - grid.z0) / grid.cz);
      const j1 = clampCell((box.z1 + plan - grid.z0) / grid.cz);
      for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) {
        for (const packed of grid.cells[j * GRID + i]) {
          const batch = Math.floor(packed / 1048576);
          const index = packed - batch * 1048576;
          const candidate = { record, batch, index };
          const id = key(candidate);
          if (seen.has(id)) continue;
          if (!touching(box, pieceBox(data, batch, index), plan)) continue;
          seen.add(id);
          pieces.push(candidate);
          if (pieces.length >= limit) return { pieces, truncated: true, open: true };
          queue.push(candidate);
        }
      }
    }
  }
  return { pieces, truncated: false, open: pieces.some((piece) => leavesLoaded(piece, loaded)) };
}

/** Packed phase (part, flow, pulse phase) of a traced piece. */
export const pieceCode = (piece: TracePiece) => piece.record.data.batches[piece.batch].data[piece.index * FLOATS_PER_INSTANCE + 9];

/** Part recorded by the generator for a piece, if it recorded one. */
export const piecePart = (piece: TracePiece): PartId | null => partOfPhase(pieceCode(piece));

/** Most common flow among the pieces (data, VDD, VSS, or clock). */
export function netFlow(pieces: TracePiece[]): Flow {
  const counts = [0, 0, 0, 0];
  for (const piece of pieces) counts[flowOfPhase(pieceCode(piece))] += 1;
  let best = 0;
  for (let k = 1; k < 4; k += 1) if (counts[k] > counts[best]) best = k;
  return best as Flow;
}
