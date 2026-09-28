// How the A1 layout view zooms: its five stops, how far the camera may go, and
// which detail is streamed at each distance. Distances are camera-to-target in
// millimetres (the view is about 0.61 × the distance tall at its 34° field of view).
//
// Rules the tests hold this to: every stop spans a similar zoom range, every
// level of detail is fully faded in by the time its stop begins (so no stop
// opens on an empty or blurry view), and the deepest zoom still shows whole
// transistors rather than one magnified surface.

export type LayoutStopId = 'tile' | 'region' | 'routing' | 'cells' | 'devices';

export type LodSpec = {
  /** Camera distance below which the level streams in, and where its fade-in completes. */
  activateAt: number;
  fullAt: number;
  /** Half-size of the square streamed around the target: distance × factor, clamped to [min, max] (mm). */
  window: { factor: number; min: number; max: number };
  /** Tiles kept at once, with a GPU and with software rendering. */
  budget: { gpu: number; software: number };
};

export const LAYOUT_ZOOM = {
  /** The whole tile fits at the top; the deepest view is about 1.2 µm across (a few transistors). */
  min: 0.002,
  max: 16,
  /** Each stop holds while the distance is below `below` and above the next stop's. */
  stops: [
    { id: 'tile', below: Infinity },
    { id: 'region', below: 1.25 },
    { id: 'routing', below: 0.26 },
    { id: 'cells', below: 0.06 },
    { id: 'devices', below: 0.014 },
  ] as Array<{ id: LayoutStopId; below: number }>,
  /** Ladder distances (the tile stop's comes from the die size). */
  presets: { region: 0.55, routing: 0.11, cells: 0.028, devices: 0.0065 } as Record<Exclude<LayoutStopId, 'tile'>, number>,
  lod: {
    /** Upper routing (met3–met5) and cell outlines over a wide ring: the region stop's detail. */
    coarse: { activateAt: 1.7, fullAt: 1.25, window: { factor: 1.0, min: 0.2, max: 0.75 }, budget: { gpu: 160, software: 12 } } as LodSpec,
    /** Everything routed: the routing stop's detail. */
    tile: { activateAt: 0.36, fullAt: 0.26, window: { factor: 0.9, min: 0.06, max: 0.28 }, budget: { gpu: 36, software: 4 } } as LodSpec,
    /** Every cell's own transistors, contacts, and li1: the cells and transistors stops' detail. */
    cells: { activateAt: 0.08, fullAt: 0.06, window: { factor: 0.8, min: 0.02, max: 0.06 }, budget: { gpu: 9, software: 1 } } as LodSpec,
    /** The via4 arrays under the met5 straps: sub-pixel from further away. */
    globalVias: 1.7,
  },
} as const;

/** How faded in a level is at a camera distance (0 to 1). */
export function lodFade(spec: LodSpec, distance: number): number {
  if (distance >= spec.activateAt) return 0;
  if (distance <= spec.fullAt) return 1;
  return (spec.activateAt - distance) / (spec.activateAt - spec.fullAt);
}

/** Half-size (mm) of the square a level streams around the target. */
export const lodWindow = (spec: LodSpec, distance: number) => Math.min(spec.window.max, Math.max(spec.window.min, distance * spec.window.factor));

/** The stop for a camera distance, with 8 % hysteresis around each boundary. */
export function stopAt(distance: number, current: LayoutStopId | null): LayoutStopId {
  const stops = LAYOUT_ZOOM.stops;
  let chosen = 0;
  for (let k = 0; k < stops.length; k += 1) if (distance < stops[k].below) chosen = k;
  const index = stops.findIndex((stop) => stop.id === current);
  if (index >= 0 && Math.abs(chosen - index) === 1) {
    const boundary = chosen > index ? stops[chosen].below : stops[index].below;
    if (Math.abs(Math.log(distance / boundary)) < Math.log(1.08)) return stops[index].id;
  }
  return stops[chosen].id;
}
