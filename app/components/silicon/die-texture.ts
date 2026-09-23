import * as THREE from 'three';
import {
  CHANNEL_RECTS, DIE, EDGE_BLOCKS, PE_COLUMNS, PE_GAP, PE_ROWS, PHYS, SRAM_STRIP, TILES, TILE_RING, peRect, rand, type Rect, type SramMacro,
} from '@/lib/silicon-macro';

// Die-photo textures for the far view. Everything smaller than a few pixels
// at the die zoom is carried here: logic reads as a fine mottled weave, SRAM
// as a regular bright lattice, bump fields as dot grids. As the camera closes
// in, streamed geometry takes over and the die shader fades this out.

type Painter = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Die mm → canvas px. */
  px: (x: number) => number;
  pz: (z: number) => number;
  scale: number;
};

function painter(canvas: HTMLCanvasElement): Painter {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const scale = canvas.width / DIE.width;
  return { ctx, width: canvas.width, height: canvas.height, scale, px: (x) => (x + DIE.width / 2) * scale, pz: (z) => (z + DIE.depth / 2) * scale };
}

function fillRect(p: Painter, r: Rect, style: string | CanvasPattern | CanvasGradient, inset = 0) {
  p.ctx.fillStyle = style;
  p.ctx.fillRect(p.px(r.x0) + inset, p.pz(r.z0) + inset, (r.x1 - r.x0) * p.scale - 2 * inset, (r.z1 - r.z0) * p.scale - 2 * inset);
}

function patternCanvas(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  return canvas;
}

function logicWeave(seed: number) {
  return patternCanvas(256, (ctx, size) => {
    ctx.fillStyle = '#26211d';
    ctx.fillRect(0, 0, size, size);
    const tones = ['#3b3029', '#2f2a26', '#1c1e23', '#433731', '#35302b', '#2a2c31', '#4a3a2c'];
    for (let k = 0; k < 5200; k += 1) {
      const x = Math.floor(rand(seed, k, 1) * size);
      const y = Math.floor(rand(seed, k, 2) * size);
      ctx.fillStyle = tones[Math.floor(rand(seed, k, 3) * tones.length)];
      ctx.fillRect(x, y, 1 + Math.floor(rand(seed, k, 4) * 7), 1);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < size; y += 3) ctx.fillRect(0, y, size, 1);
  });
}

function sramLattice() {
  return patternCanvas(64, (ctx, size) => {
    ctx.fillStyle = '#233042';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#3a4c63';
    for (let x = 0; x < size; x += 2) ctx.fillRect(x, 0, 1, size);
    ctx.fillStyle = 'rgba(12,16,24,0.55)';
    for (let y = 0; y < size; y += 8) ctx.fillRect(0, y, size, 1);
  });
}

function dotGrid(background: string, dot: string, pitch: number, radius: number, stagger: boolean) {
  const size = Math.max(8, Math.round(pitch * (stagger ? 2 : 1)));
  return patternCanvas(size, (ctx) => {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = dot;
    const put = (x: number, y: number) => {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    };
    put(pitch / 2, pitch / 2);
    if (stagger) {
      put(pitch * 1.5, pitch / 2);
      put(pitch, pitch * 1.5);
      put(0, pitch * 1.5);
      put(pitch * 2, pitch * 1.5);
    }
  });
}

function stripes(background: string, line: string, period: number, vertical: boolean) {
  const size = Math.max(4, Math.round(period * 8));
  return patternCanvas(size, (ctx) => {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = line;
    for (let k = 0; k < size; k += period) {
      if (vertical) ctx.fillRect(Math.round(k), 0, Math.max(1, Math.round(period / 2)), size);
      else ctx.fillRect(0, Math.round(k), size, Math.max(1, Math.round(period / 2)));
    }
  });
}

function drawMacro(p: Painter, macro: SramMacro, lattice: CanvasPattern, periph: string) {
  fillRect(p, macro.rect, periph);
  fillRect(p, macro.array, lattice);
  p.ctx.strokeStyle = 'rgba(150,120,80,0.35)';
  p.ctx.lineWidth = Math.max(1, p.scale * 0.008);
  p.ctx.strokeRect(p.px(macro.rect.x0), p.pz(macro.rect.z0), (macro.rect.x1 - macro.rect.x0) * p.scale, (macro.rect.z1 - macro.rect.z0) * p.scale);
}

export type DieTextures = { albedo: THREE.CanvasTexture; roughnessMetal: THREE.CanvasTexture; activity: THREE.CanvasTexture };

export function createDieTextures(maxWidth: number, anisotropy: number): DieTextures {
  const width = Math.min(4096, maxWidth);
  const height = Math.round((width * DIE.depth) / DIE.width);
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = width;
  albedoCanvas.height = height;
  const p = painter(albedoCanvas);
  const pattern = (source: HTMLCanvasElement) => {
    const made = p.ctx.createPattern(source, 'repeat');
    if (!made) throw new Error('pattern unavailable');
    return made;
  };
  const weaveA = pattern(logicWeave(11));
  const weaveB = pattern(logicWeave(12));
  const lattice = pattern(sramLattice());
  const bumps = pattern(dotGrid('#1b1815', '#7a6440', (0.045 * p.scale), Math.max(0.8, 0.011 * p.scale), true));
  const trenches = pattern(dotGrid('#191c21', '#2b3038', Math.max(2, 0.02 * p.scale), 0.6, false));
  const tsvDots = pattern(dotGrid('#16191e', '#6a5238', Math.max(3, 0.03 * p.scale), Math.max(0.6, 0.004 * p.scale), true));
  const driversH = pattern(stripes('#221f1c', '#3b3631', 3, true));
  const driversV = pattern(stripes('#221f1c', '#3b3631', 3, false));
  const channelH = pattern(stripes('#15171b', '#24272d', 3, false));
  const channelV = pattern(stripes('#15171b', '#24272d', 3, true));

  // Substrate, decoupling band, I/O ring.
  p.ctx.fillStyle = '#121419';
  p.ctx.fillRect(0, 0, width, height);
  fillRect(p, { x0: -DIE.width / 2, z0: -DIE.depth / 2, x1: DIE.width / 2, z1: DIE.depth / 2 }, trenches);
  const io = DIE.ioBand;
  p.ctx.fillStyle = pattern(stripes('#1e1c1a', '#2d2a27', Math.max(2, 0.06 * p.scale), true));
  p.ctx.fillRect(0, 0, width, io * p.scale);
  p.ctx.fillRect(0, height - io * p.scale, width, io * p.scale);
  p.ctx.fillStyle = pattern(stripes('#1e1c1a', '#2d2a27', Math.max(2, 0.06 * p.scale), false));
  p.ctx.fillRect(0, 0, io * p.scale, height);
  p.ctx.fillRect(width - io * p.scale, 0, io * p.scale, height);
  // Uncore logic fills the core; blocks paint over it.
  const core: Rect = { x0: -DIE.width / 2 + DIE.decapBand, z0: -DIE.depth / 2 + DIE.decapBand, x1: DIE.width / 2 - DIE.decapBand, z1: DIE.depth / 2 - DIE.decapBand };
  fillRect(p, core, weaveB);
  for (const channel of CHANNEL_RECTS) fillRect(p, channel.rect, channel.horizontal ? channelH : channelV);

  for (const phy of PHYS) {
    fillRect(p, phy.bumps, bumps);
    fillRect(p, phy.drivers, phy.side === 'north' || phy.side === 'south' ? driversH : driversV);
  }
  for (const block of EDGE_BLOCKS) {
    fillRect(p, block.rect, block.id === 'west' ? driversV : weaveA);
    for (const macro of block.sram) drawMacro(p, macro, lattice, '#1e2530');
    for (const inductor of block.inductors) {
      const r = { x0: inductor.cx - inductor.size * 0.62, z0: inductor.cz - inductor.size * 0.62, x1: inductor.cx + inductor.size * 0.62, z1: inductor.cz + inductor.size * 0.62 };
      fillRect(p, r, '#101216');
    }
  }
  fillRect(p, SRAM_STRIP.rect, '#171b21');
  for (const macro of SRAM_STRIP.macros) drawMacro(p, macro, lattice, '#1e2530');
  fillRect(p, SRAM_STRIP.tsvBand, tsvDots);

  for (const tile of TILES) {
    fillRect(p, tile.rect, '#1b1d22');
    const inner = { x0: tile.rect.x0 + TILE_RING, z0: tile.rect.z0 + TILE_RING, x1: tile.rect.x1 - TILE_RING, z1: tile.rect.z1 - TILE_RING };
    fillRect(p, inner, '#15171b');
    for (const macro of tile.sram) drawMacro(p, macro, lattice, '#1e2530');
    fillRect(p, tile.router, pattern(stripes('#2b231d', '#3f3228', 2, (tile.index & 1) === 0)));
    fillRect(p, tile.vector, tile.index % 2 ? weaveA : weaveB);
    for (let i = 0; i < PE_COLUMNS; i += 1) for (let j = 0; j < PE_ROWS; j += 1) {
      const pe = peRect(tile, i, j);
      fillRect(p, pe, (i + j) % 2 ? weaveA : weaveB);
      // Register file in the PE corner.
      fillRect(p, { x0: pe.x0 + 0.006, z0: pe.z0 + 0.006, x1: pe.x0 + 0.056, z1: pe.z0 + 0.066 }, lattice);
    }
  }

  // Seal ring.
  p.ctx.strokeStyle = '#6d5738';
  p.ctx.lineWidth = Math.max(1.5, 0.012 * p.scale);
  p.ctx.strokeRect(0.02 * p.scale, 0.02 * p.scale, width - 0.04 * p.scale, height - 0.04 * p.scale);

  // Roughness (G) and metalness (B): SRAM and bumps are smoother and more metallic.
  const rmCanvas = document.createElement('canvas');
  rmCanvas.width = Math.round(width / 4);
  rmCanvas.height = Math.round(height / 4);
  const rm = painter(rmCanvas);
  const rmStyle = (roughness: number, metalness: number) => `rgb(0, ${Math.round(roughness * 255)}, ${Math.round(metalness * 255)})`;
  rm.ctx.fillStyle = rmStyle(0.46, 0.3);
  rm.ctx.fillRect(0, 0, rm.width, rm.height);
  for (const channel of CHANNEL_RECTS) fillRect(rm, channel.rect, rmStyle(0.52, 0.22));
  for (const phy of PHYS) fillRect(rm, phy.bumps, rmStyle(0.34, 0.62));
  for (const macro of [...SRAM_STRIP.macros, ...TILES.flatMap((tile) => tile.sram), ...EDGE_BLOCKS.flatMap((block) => block.sram)]) fillRect(rm, macro.array, rmStyle(0.28, 0.55));
  fillRect(rm, SRAM_STRIP.tsvBand, rmStyle(0.4, 0.45));

  // Activity: R = emissive mask (PE gaps and NoC channels), G = per-tile
  // phase, B = diagonal coordinate inside the tile.
  const actCanvas = document.createElement('canvas');
  actCanvas.width = Math.round(width / 2);
  actCanvas.height = Math.round(height / 2);
  const act = painter(actCanvas);
  act.ctx.fillStyle = 'rgb(0,0,0)';
  act.ctx.fillRect(0, 0, act.width, act.height);
  for (const tile of TILES) {
    const phase = Math.round(rand(901, tile.index) * 255);
    const a = tile.peArray;
    // A corner-to-corner gradient has anti-diagonal isolines: the wavefronts
    // of a systolic array.
    const gradient = act.ctx.createLinearGradient(act.px(a.x0), act.pz(a.z0), act.px(a.x1), act.pz(a.z1));
    for (let k = 0; k <= 8; k += 1) gradient.addColorStop(k / 8, `rgb(0, ${phase}, ${Math.round((k / 8) * 255)})`);
    fillRect(act, a, gradient);
    // Mask the systolic corridors between PEs.
    act.ctx.globalCompositeOperation = 'lighter';
    act.ctx.fillStyle = 'rgb(220,0,0)';
    const line = Math.max(1, PE_GAP * act.scale);
    for (let i = 1; i < PE_COLUMNS; i += 1) act.ctx.fillRect(act.px(a.x0 + i * tile.pePitchX - PE_GAP), act.pz(a.z0), line, (a.z1 - a.z0) * act.scale);
    for (let j = 1; j < PE_ROWS; j += 1) act.ctx.fillRect(act.px(a.x0), act.pz(a.z0 + j * tile.pePitchZ - PE_GAP), (a.x1 - a.x0) * act.scale, line);
    act.ctx.globalCompositeOperation = 'source-over';
  }

  const texture = (canvas: HTMLCanvasElement, colorSpace: THREE.ColorSpace) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = colorSpace;
    t.flipY = false;
    t.anisotropy = anisotropy;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { albedo: texture(albedoCanvas, THREE.SRGBColorSpace), roughnessMetal: texture(rmCanvas, THREE.NoColorSpace), activity: texture(actCanvas, THREE.NoColorSpace) };
}

/** Side texture for the memory stacks: sixteen thinned tiers over a base die. */
export function createStackSideTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#16171a';
    ctx.fillRect(0, 0, 64, 256);
    for (let tier = 0; tier < 17; tier += 1) {
      const y = 12 + tier * 13.5;
      ctx.fillStyle = tier === 16 ? '#2b2f36' : '#262a30';
      ctx.fillRect(0, y, 64, 10);
      ctx.fillStyle = '#6a5436';
      ctx.fillRect(0, y + 10, 64, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
