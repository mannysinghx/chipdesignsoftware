import * as THREE from 'three';

export type LabelMode = 'all' | 'key' | 'off';

/** A labelled point in the scene. `key` labels also show in the Key mode. */
export type Anchor = {
  id: string;
  title: string;
  detail: string;
  world: THREE.Vector3;
  priority: number;
  key: boolean;
  /** Floorplan regions and package parts read differently from wires and devices. */
  tone: 'region' | 'part' | 'package';
  /** Selection key of what the label names, to highlight it while selected. */
  targetKey: string;
  select: () => void;
};

export type RulerMark = { id: string; label: string; top: number; bottom: number };

/** Screen box of a label: left, top, right, bottom in CSS pixels. */
export type LabelBox = [number, number, number, number];

type Slot = { element: HTMLDivElement; text: HTMLSpanElement; anchor: Anchor | null; width: number; shown: boolean };

const POOL = 48;
const RULER_POOL = 28;
// The chip sits up and to the right of its anchor, joined by a 14 px leader.
const LEADER = 14;
const CHIP_HEIGHT = 22;
// Keep labels out from under the toolbar row.
const TOP_RESERVED = 56;

/**
 * Screen-space annotations over the canvas: labels on 3D anchors, the layer
 * ruler for cross-sections, and the hover tooltip. Elements are pooled and
 * persistent (hidden, never removed), so nothing a user or a test is about to
 * click is detached from the page mid-gesture. Hidden labels drop their
 * data-audit attribute, so audit tooling only ever sees labels on screen.
 */
export function createAnnotations(host: HTMLElement) {
  const layer = document.createElement('div');
  layer.className = 'silicon-labels';
  host.appendChild(layer);
  const widths = new Map<string, number>();

  const slots: Slot[] = Array.from({ length: POOL }, () => {
    const element = document.createElement('div');
    element.className = 'silicon-label';
    element.setAttribute('role', 'button');
    element.tabIndex = -1;
    element.style.display = 'none';
    const text = document.createElement('span');
    element.appendChild(text);
    layer.appendChild(element);
    const slot: Slot = { element, text, anchor: null, width: 0, shown: false };
    const activate = (event: Event) => {
      event.stopPropagation();
      slot.anchor?.select();
    };
    element.addEventListener('click', activate);
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(event);
      }
    });
    return slot;
  });

  const ruler = document.createElement('div');
  ruler.className = 'silicon-ruler';
  ruler.setAttribute('aria-hidden', 'true');
  host.appendChild(ruler);
  const marks = Array.from({ length: RULER_POOL }, () => {
    const mark = document.createElement('div');
    mark.className = 'silicon-ruler-mark';
    mark.style.display = 'none';
    const bracket = document.createElement('i');
    const label = document.createElement('span');
    // appendChild: the Workers types shadow Element.append in this project.
    mark.appendChild(bracket);
    mark.appendChild(label);
    ruler.appendChild(mark);
    return { mark, bracket, label };
  });

  const tooltip = document.createElement('div');
  tooltip.className = 'silicon-tooltip';
  tooltip.setAttribute('aria-hidden', 'true');
  tooltip.style.display = 'none';
  const tooltipTitle = document.createElement('b');
  const tooltipSub = document.createElement('span');
  tooltip.appendChild(tooltipTitle);
  tooltip.appendChild(tooltipSub);
  host.appendChild(tooltip);

  let mode: LabelMode = 'all';
  let selectedKey: string | null = null;
  const projected = new THREE.Vector3();

  // Panels over the canvas (legend, selection, HUD) that labels must avoid,
  // re-measured twice a second rather than every frame.
  let occluders: LabelBox[] = [];
  let occludersAt = 0;
  const refreshOccluders = (now: number) => {
    if (now < occludersAt) return;
    occludersAt = now + 500;
    const origin = host.getBoundingClientRect();
    occluders = [...(host.parentElement?.querySelectorAll<HTMLElement>('[data-silicon-occluder]') ?? [])]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => [rect.left - origin.left, rect.top - origin.top, rect.right - origin.left, rect.bottom - origin.top] as LabelBox);
  };
  const overlaps = (a: LabelBox, b: LabelBox, pad = 0) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;

  const hide = (slot: Slot) => {
    if (slot.shown) {
      slot.element.style.display = 'none';
      slot.element.tabIndex = -1;
      delete slot.element.dataset.audit;
      slot.shown = false;
    }
  };

  const measure = (title: string) => {
    let width = widths.get(title);
    if (width !== undefined) return width;
    // Measured once per distinct text, on a spare hidden slot.
    const probe = slots.find((slot) => !slot.shown) ?? slots[0];
    const previous = probe.text.textContent;
    const wasShown = probe.shown;
    probe.text.textContent = title;
    probe.element.style.display = 'block';
    width = probe.element.offsetWidth || title.length * 7 + 20;
    probe.text.textContent = previous;
    if (!wasShown) probe.element.style.display = 'none';
    widths.set(title, width);
    return width;
  };

  const boxAt = (x: number, y: number, width: number): LabelBox => [x - 6, y - LEADER - CHIP_HEIGHT, x - 6 + width, y - LEADER];

  return {
    setMode(next: LabelMode) {
      mode = next;
    },

    setSelected(key: string | null) {
      selectedKey = key;
      for (const slot of slots) slot.element.classList.toggle('selected', Boolean(key) && slot.anchor?.targetKey === key);
    },

    /** Label width in CSS pixels, for placement before a label is shown. */
    widthOf: measure,
    boxAt,

    /** Whether a label box would sit off-canvas, under the toolbar, or under a panel. */
    blocked(box: LabelBox, width: number, height: number) {
      refreshOccluders(performance.now());
      if (box[0] < 4 || box[2] > width - 4 || box[1] < TOP_RESERVED || box[3] > height - 6) return true;
      return occluders.some((rect) => overlaps(box, rect, 4));
    },

    /** Replace the labelled anchors; slots keep their elements. */
    setAnchors(anchors: Anchor[]) {
      const ordered = [...anchors].sort((a, b) => b.priority - a.priority).slice(0, POOL);
      slots.forEach((slot, index) => {
        const anchor = ordered[index] ?? null;
        slot.anchor = anchor;
        if (!anchor) {
          hide(slot);
          return;
        }
        const aria = `${anchor.title}: ${anchor.detail}`;
        if (slot.element.getAttribute('aria-label') !== aria || slot.element.dataset.tone !== anchor.tone) {
          slot.text.textContent = anchor.title;
          slot.element.dataset.tone = anchor.tone;
          slot.element.dataset.auditLabel = anchor.title;
          slot.element.setAttribute('aria-label', aria);
          slot.element.title = anchor.detail;
        }
        slot.element.classList.toggle('selected', Boolean(selectedKey) && anchor.targetKey === selectedKey);
        slot.width = measure(anchor.title);
      });
    },

    /** Project, cull, de-overlap, and place the labels for this frame. */
    update(camera: THREE.Camera, width: number, height: number) {
      refreshOccluders(performance.now());
      const placed: LabelBox[] = [];
      for (const slot of slots) {
        const anchor = slot.anchor;
        if (!anchor || mode === 'off' || (mode === 'key' && !anchor.key)) {
          hide(slot);
          continue;
        }
        projected.copy(anchor.world).project(camera);
        if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.02 || Math.abs(projected.y) > 1.02) {
          hide(slot);
          continue;
        }
        const x = ((projected.x + 1) / 2) * width;
        const y = ((1 - projected.y) / 2) * height;
        const box = boxAt(x, y, slot.width);
        if (box[2] > width - 4 || box[1] < TOP_RESERVED || occluders.some((rect) => overlaps(box, rect, 4))) {
          hide(slot);
          continue;
        }
        if (placed.some((other) => box[0] < other[2] + 4 && other[0] < box[2] + 4 && box[1] < other[3] + 3 && other[1] < box[3] + 3)) {
          hide(slot);
          continue;
        }
        placed.push(box);
        slot.element.style.transform = `translate(${Math.round(x - 6)}px, ${Math.round(y - LEADER)}px) translateY(-100%)`;
        if (!slot.shown) {
          slot.element.style.display = 'block';
          slot.element.tabIndex = 0;
          slot.element.dataset.audit = 'silicon-label';
          slot.shown = true;
        }
      }
    },

    /** Layer names down the left edge in a cross-section (null hides the ruler). */
    setRuler(bands: RulerMark[] | null) {
      let used = 0;
      let lastCenter = -Infinity;
      for (const band of bands ?? []) {
        if (used >= marks.length) break;
        const top = Math.min(band.top, band.bottom);
        const bottom = Math.max(band.top, band.bottom);
        const center = (top + bottom) / 2;
        // Skip bands too thin to read, and labels that would collide.
        if (bottom - top < 2 || Math.abs(center - lastCenter) < 15) continue;
        const { mark, bracket, label } = marks[used];
        mark.style.display = 'block';
        mark.style.transform = `translateY(${Math.round(top)}px)`;
        bracket.style.height = `${Math.max(2, Math.round(bottom - top))}px`;
        label.style.top = `${Math.round((bottom - top) / 2)}px`;
        if (label.textContent !== band.label) label.textContent = band.label;
        lastCenter = center;
        used += 1;
      }
      for (let k = used; k < marks.length; k += 1) marks[k].mark.style.display = 'none';
    },

    tooltip(title: string | null, sub = '', x = 0, y = 0) {
      if (!title) {
        tooltip.style.display = 'none';
        return;
      }
      if (tooltipTitle.textContent !== title) tooltipTitle.textContent = title;
      if (tooltipSub.textContent !== sub) tooltipSub.textContent = sub;
      tooltip.style.display = 'block';
      // Flip to the left of the cursor near the right edge.
      const flip = x > host.clientWidth - 280;
      tooltip.style.transform = flip ? `translate(${Math.round(x - 14)}px, ${Math.round(y + 16)}px) translateX(-100%)` : `translate(${Math.round(x + 14)}px, ${Math.round(y + 16)}px)`;
    },

    dispose() {
      layer.remove();
      ruler.remove();
      tooltip.remove();
    },
  };
}

export type Annotations = ReturnType<typeof createAnnotations>;
