import * as THREE from 'three';
import { DIE, type MaterialKey } from '@/lib/silicon-macro';

// Shared per-frame uniforms. Every chip material holds references to these
// same objects, so one write per frame reaches all of them.
export type SharedUniforms = {
  uTime: { value: number };
  uGlowGain: { value: number };
  uGlowColor: { value: THREE.Color };
  /** x, z: crater centre; z: floor height; w: radius (all mm). */
  uCrater: { value: THREE.Vector4 };
  uCraterSlope: { value: number };
  uCraterOn: { value: number };
};

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uGlowGain: { value: 1 },
    uGlowColor: { value: new THREE.Color().setRGB(0.22, 0.86, 1.0, THREE.LinearSRGBColorSpace) },
    uCrater: { value: new THREE.Vector4(0, 0, 1, 0) },
    uCraterSlope: { value: 0.25 },
    uCraterOn: { value: 0 },
  };
}

export type LevelUniforms = {
  uFade: { value: number };
  uPulsePeriod: { value: number };
  uPulseRate: { value: number };
};

// Physically based base colours (linear sRGB reflectance for the metals).
type Surface = { color: [number, number, number]; metalness: number; roughness: number; tint: number };
const SURFACES: Record<MaterialKey, Surface> = {
  copper: { color: [0.955, 0.638, 0.538], metalness: 1, roughness: 0.2, tint: 0.16 },
  gold: { color: [1.0, 0.766, 0.336], metalness: 1, roughness: 0.16, tint: 0.1 },
  tungsten: { color: [0.52, 0.51, 0.53], metalness: 1, roughness: 0.34, tint: 0.12 },
  gate: { color: [0.63, 0.56, 0.46], metalness: 0.95, roughness: 0.26, tint: 0.12 },
  silicon: { color: [0.3, 0.32, 0.37], metalness: 0.45, roughness: 0.24, tint: 0.1 },
  epiN: { color: [0.36, 0.43, 0.56], metalness: 0.3, roughness: 0.34, tint: 0.1 },
  epiP: { color: [0.5, 0.42, 0.34], metalness: 0.3, roughness: 0.34, tint: 0.1 },
  oxide: { color: [0.5, 0.58, 0.68], metalness: 0, roughness: 0.1, tint: 0.06 },
  solder: { color: [0.78, 0.78, 0.8], metalness: 1, roughness: 0.3, tint: 0.08 },
};

const CHIP_VERTEX_HEAD = /* glsl */ `
attribute vec3 iOffset;
attribute vec3 iScale;
attribute vec4 iData;
varying vec4 vChip;
varying vec3 vChipWorld;
varying float vChipHeight;
`;

const CHIP_BEGIN_VERTEX = /* glsl */ `
vec3 transformed = position * iScale + iOffset;
// Glow path: iData.x carries the tint plus 2 when the wire runs along z.
float chipAxisZ = step(1.5, iData.x);
float chipAlong = mix(position.x, position.z, chipAxisZ) + 0.5;
float chipLength = mix(iScale.x, iScale.z, chipAxisZ) * 1000.0;
vChip = vec4(fract(iData.x), iData.y + chipAlong * chipLength, iData.z, iData.w);
vChipHeight = position.y + 0.5;
`;

const CHIP_FRAGMENT_HEAD = /* glsl */ `
uniform float uTime;
uniform float uGlowGain;
uniform vec3 uGlowColor;
uniform vec4 uCrater;
uniform float uCraterSlope;
uniform float uCraterOn;
uniform float uFade;
uniform float uPulsePeriod;
uniform float uPulseRate;
uniform float uTintAmount;
varying vec4 vChip;
varying vec3 vChipWorld;
varying float vChipHeight;
float chipB2(vec2 p) { return 2.0 * mod(p.x + p.y, 2.0) + p.y; }
float chipBayer(vec2 frag) {
  vec2 q = mod(floor(frag), 4.0);
  return (4.0 * chipB2(mod(q, 2.0)) + chipB2(floor(q / 2.0)) + 0.5) / 16.0;
}
`;

// Delayering crater and level fade. Discards run before any shading work.
const CHIP_DISCARD = /* glsl */ `
#include <clipping_planes_fragment>
if (uCraterOn > 0.5) {
  float chipRho = length(vChipWorld.xz - uCrater.xy);
  if (vChipWorld.y > uCrater.z + max(0.0, chipRho - uCrater.w) * uCraterSlope) discard;
}
if (uFade < 0.999 && chipBayer(gl_FragCoord.xy) > uFade) discard;
`;

const CHIP_GLOW = /* glsl */ `
#include <emissivemap_fragment>
if (vChip.z != 0.0) {
  // A bright packet head with a tail behind it, travelling along the wire.
  float chipS = vChip.y * sign(vChip.z);
  float chipCycle = fract(uTime * uPulseRate - chipS / uPulsePeriod + vChip.w);
  float chipHead = smoothstep(0.0, 0.03, chipCycle) * (1.0 - smoothstep(0.03, 0.4, chipCycle));
  totalEmissiveRadiance += uGlowColor * uGlowGain * abs(vChip.z) * (0.05 + 1.6 * chipHead * chipHead);
}
`;

/**
 * Chip primitive material: unit box or cylinder scaled per instance from the
 * packed attributes, with per-instance tint, glow pulses, the delayering
 * crater, dithered level fade, and a cheap height-based occlusion term.
 */
export function createChipMaterial(key: MaterialKey, shared: SharedUniforms, level: LevelUniforms): THREE.MeshStandardMaterial {
  const surface = SURFACES[key];
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(...surface.color, THREE.LinearSRGBColorSpace),
    metalness: surface.metalness,
    roughness: surface.roughness,
    side: THREE.DoubleSide,
    envMapIntensity: 1.05,
  });
  const uTintAmount = { value: surface.tint };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, level, { uTintAmount });
    shader.vertexShader = CHIP_VERTEX_HEAD + shader.vertexShader
      .replace('#include <begin_vertex>', CHIP_BEGIN_VERTEX)
      .replace('#include <project_vertex>', '#include <project_vertex>\nvChipWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = CHIP_FRAGMENT_HEAD + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', CHIP_DISCARD)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 + (vChip.x - 0.5) * uTintAmount;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * (0.82 + 0.36 * fract(vChip.x * 7.31)), 0.04, 1.0);')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nfloat chipAo = mix(0.42, 1.0, smoothstep(0.0, 0.95, vChipHeight));\nreflectedLight.indirectDiffuse *= chipAo;\nreflectedLight.indirectSpecular *= mix(0.55, 1.0, chipAo);')
      .replace('#include <emissivemap_fragment>', CHIP_GLOW);
  };
  material.customProgramCacheKey = () => 'silicon-chip-v1';
  return material;
}

// ---------------------------------------------------------------------------
// Die surface: textured silicon with thin-film iridescence and a macro-scale
// activity wave that hands over to the streamed glow geometry on zoom.
// ---------------------------------------------------------------------------

export type DieUniforms = {
  uActivity: { value: THREE.Texture | null };
  uBaseGlow: { value: number };
  uMacroMix: { value: number };
  uSiliconColor: { value: THREE.Color };
};

export function createDieUniforms(activity: THREE.Texture): DieUniforms {
  return {
    uActivity: { value: activity },
    uBaseGlow: { value: 1 },
    uMacroMix: { value: 1 },
    uSiliconColor: { value: new THREE.Color().setRGB(0.028, 0.03, 0.036, THREE.LinearSRGBColorSpace) },
  };
}

/**
 * `lite` drops clearcoat and thin-film iridescence (a much smaller shader)
 * for software rendering, where every program links on the main thread.
 */
export function createDieSurfaceMaterial(map: THREE.Texture, roughnessMetal: THREE.Texture, shared: SharedUniforms, die: DieUniforms, lite = false) {
  const surface = { map, roughnessMap: roughnessMetal, metalnessMap: roughnessMetal, roughness: 1, metalness: 1 };
  const material = lite
    ? new THREE.MeshStandardMaterial(surface)
    : new THREE.MeshPhysicalMaterial({ ...surface, clearcoat: 0.55, clearcoatRoughness: 0.14, iridescence: 0.42, iridescenceIOR: 1.46, iridescenceThicknessRange: [240, 720] });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, die);
    shader.fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uGlowGain;
uniform vec3 uGlowColor;
uniform sampler2D uActivity;
uniform float uBaseGlow;
uniform float uMacroMix;
uniform vec3 uSiliconColor;
` + shader.fragmentShader
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(uSiliconColor, diffuseColor.rgb, uMacroMix);')
      .replace('#include <emissivemap_fragment>', /* glsl */ `
#include <emissivemap_fragment>
{
  // Systolic activity: diagonal waves sweep each compute tile.
  vec4 act = texture2D(uActivity, vMapUv);
  float wave = fract(uTime * 0.22 - act.b * 1.6 + act.g);
  float head = smoothstep(0.0, 0.12, wave) * (1.0 - smoothstep(0.12, 0.7, wave));
  totalEmissiveRadiance += uGlowColor * uGlowGain * uBaseGlow * act.r * (0.02 + 0.3 * head * head);
}`);
  };
  material.customProgramCacheKey = () => 'silicon-die-v1';
  return material;
}

// ---------------------------------------------------------------------------
// Procedural HDR studio: softboxes, a ring light, and cool/warm accents,
// prefiltered with PMREM. Metals reflect it; nothing samples it as a backdrop.
// ---------------------------------------------------------------------------

export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose: () => void }> = [];
  const add = (geometry: THREE.BufferGeometry, color: THREE.Color, position: [number, number, number], lookAt: [number, number, number] = [0, 0, 0]) => {
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.lookAt(...lookAt);
    scene.add(mesh);
    disposables.push(geometry, material);
    return mesh;
  };
  const hdr = (hex: string, intensity: number) => new THREE.Color(hex).multiplyScalar(intensity);

  // Room: near-black walls and a faint warm floor bounce.
  add(new THREE.SphereGeometry(30, 48, 24), hdr('#0b0d12', 1), [0, 0, 0]);
  add(new THREE.CircleGeometry(24, 48), hdr('#3a2e22', 0.7), [0, -12, 0], [0, 0, 0]);
  // Light tent: a diffuse band well above the horizon all around,
  // modulated so the reflections keep some structure as the camera orbits.
  {
    const tent = document.createElement('canvas');
    tent.width = 256;
    tent.height = 4;
    const context = tent.getContext('2d');
    if (context) {
      for (let x = 0; x < 256; x += 1) {
        const level = 0.38 + 0.32 * Math.max(0, Math.sin((x / 256) * Math.PI * 6)) + 0.3 * Math.max(0, Math.sin((x / 256) * Math.PI * 2 + 1.1));
        const value = Math.round(Math.min(1, level) * 255);
        context.fillStyle = `rgb(${value},${value},${value})`;
        context.fillRect(x, 0, 1, 4);
      }
    }
    const map = new THREE.CanvasTexture(tent);
    map.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(1.55, 1.5, 1.45), side: THREE.DoubleSide });
    // 27-62 degrees of elevation: grazing reflections see the dark room, not the tent.
    const geometry = new THREE.CylinderGeometry(10, 18, 10, 64, 1, true);
    const band = new THREE.Mesh(geometry, material);
    band.position.y = 14;
    scene.add(band);
    disposables.push(map, material, geometry);
  }
  // Overhead softbox and a coaxial ring light, like a macro rig.
  add(new THREE.PlaneGeometry(14, 14), hdr('#fff7ee', 2.6), [0, 18, 2]);
  add(new THREE.TorusGeometry(4.2, 0.7, 16, 64), hdr('#ffffff', 5.5), [0, 14, 7]);
  // Strip boxes and a rim, all 30+ degrees up: long highlights along the
  // wires without flaring the grazing reflections of wide metal.
  add(new THREE.PlaneGeometry(3.2, 12), hdr('#ffe9d2', 6.5), [-14, 12, 4]);
  add(new THREE.PlaneGeometry(3.2, 12), hdr('#e3efff', 4.6), [13, 11, -5]);
  add(new THREE.PlaneGeometry(20, 2.4), hdr('#ffffff', 2.6), [0, 10, -16]);
  // Faint coloured accents low down: a hint of tint in edge reflections.
  add(new THREE.PlaneGeometry(6, 3), hdr('#39d6ff', 1.1), [-12, 3.5, -12]);
  add(new THREE.PlaneGeometry(6, 3), hdr('#ffae4a', 0.8), [13, 3.2, 11]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  for (const item of disposables) item.dispose();
  return target;
}

export function createBackdrop(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(256, 210, 20, 256, 256, 420);
    gradient.addColorStop(0, '#1b212b');
    gradient.addColorStop(0.45, '#0d1117');
    gradient.addColorStop(1, '#030405');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 512, 512);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Vignette, faint lens fringing, and grain, after tone mapping. */
export const FinishShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  vec2 shift = c * r2 * 0.0065;
  vec3 color = vec3(texture2D(tDiffuse, vUv + shift).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - shift).b);
  color *= mix(1.0, 0.7, smoothstep(0.06, 0.52, r2));
  float grain = fract(sin(dot(floor(vUv * uResolution) + fract(uTime * 7.13) * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
  color += (grain - 0.5) * 0.016;
  gl_FragColor = vec4(color, 1.0);
}`,
};

export const DIE_SIZE = { width: DIE.width, depth: DIE.depth };
