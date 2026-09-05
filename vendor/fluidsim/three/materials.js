// ---------------------------------------------------------------------------
// materials.js - what the fluids actually look like.
//
// Carried over from nuclear-cooling-sim's js/view/fluid.js, which is where
// every one of these decisions was paid for in review rounds. The notes are
// kept because they are the reasons, and a reason is what stops the next agent
// undoing the fix.
//
// A body of liquid here is a REAL SOLID filling the bore, not a coloured line:
// a lit surface with a scrolling flow map, absorption by path length, and a
// bright rim. That is how a game draws water, and it costs one ordinary draw.
//
// NO SCREEN-SPACE REFRACTION BY DEFAULT. Three renders a transmissive material
// by drawing the whole scene again into a target before it can shade one pipe.
// Measured on the consumer's model at 1200x800: seventy-three transmissive
// materials, 862 draw calls and 569 ms a frame; with transmission off, 581
// calls and 160 ms. Same picture, three and a half times the speed, and the
// pass was never buying much: a pipe half a metre across refracts almost
// nothing, and inside an unlit machine it sampled a dark background and came
// out as a dark panel, which is what makes a pool of water look painted.
// setQuality({ refraction: true }) switches it on for anyone who wants to see.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { fluidColour, colourIn, glowColour } from '../core/colour.js';

// --- the shared clock -------------------------------------------------------
// Every fluid shader scrolls off this one uniform, so nothing drifts out of
// step with anything else, and a tool that drives the clock forward gets the
// picture a viewer would have had.
export const FLUID_TIME = { value: 0 };
export function advanceTime(dt) {
  if (Number.isFinite(dt)) FLUID_TIME.value += dt;
  return FLUID_TIME.value;
}

// --- quality ----------------------------------------------------------------
// A phone cannot afford refraction or clearcoat. Every transmissive material
// makes the renderer draw the WHOLE scene again into a target before it can
// shade one pipe, and a model has dozens of them; on a real handset that is
// what takes the GPU past its budget and loses the WebGL context, which shows
// up as a blank white page rather than as a slow one.
export const quality = { lowfx: false, refraction: false };

function detect() {
  try {
    const q = new URLSearchParams(location.search).get('lowfx');
    if (q === '1') return true;
    if (q === '0') return false;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
    return (navigator.maxTouchPoints || 0) > 1 && Math.min(screen.width, screen.height) < 820;
  } catch (e) { return false; }
}
quality.lowfx = detect();

// The host decides in the end: a tuner that has measured the device knows
// better than a user-agent string does.
export function setQuality(q = {}) {
  if (q.lowfx != null) quality.lowfx = !!q.lowfx;
  if (q.refraction != null) quality.refraction = !!q.refraction;
  for (const m of REGISTRY) applyQuality(m);
  return quality;
}

// Every fluid material this module made, so a quality change reaches all of
// them. Held weakly: a material that has been disposed of must not be kept
// alive by a settings panel.
const REGISTRY = new Set();
function register(m) {
  REGISTRY.add(m);
  applyQuality(m);
  return m;
}
function applyQuality(m) {
  const d = m.userData.fluid;
  if (!d) return;
  if (m.transmission !== undefined) {
    const want = quality.refraction ? (d.wetTr || 0) : 0;
    if (m.transmission !== want) { m.transmission = want; m.needsUpdate = true; }
  }
  if (m.clearcoat !== undefined) {
    m.clearcoat = quality.lowfx ? 0 : (d.clearcoat || 0);
  }
}
export function forget(m) { REGISTRY.delete(m); }

// --- tiling maps ------------------------------------------------------------
// Fractional Brownian motion on a wrapping lattice, so the pattern tiles
// exactly and repeats nowhere. It USED to be a sum of sines on integer
// frequencies, and a sum of sines is a set of regular ridges: on a pipe that
// is corrugated hose, on a vessel it is corduroy. Water has no ridges. Five
// octaves of value noise with quintic interpolation gives the aperiodic, soft,
// multi-scale relief real-time water shaders are built on; ax and ay stretch
// the lattice so flow can have long features along the bore and short ones
// across it.
function rnd(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function fbm(N, seed, { octaves = 5, ax = 4, ay = 4, gain = 0.5 } = {}) {
  const r = rnd(seed);
  const h = new Float32Array(N * N);
  const q = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  let amp = 1, fx = ax, fy = ay;
  for (let o = 0; o < octaves; o++) {
    const Lx = Math.max(1, Math.round(fx)), Ly = Math.max(1, Math.round(fy));
    const lat = new Float32Array(Lx * Ly);
    for (let i = 0; i < lat.length; i++) lat[i] = r() * 2 - 1;
    const at = (i, j) => lat[((j % Ly) + Ly) % Ly * Lx + ((i % Lx) + Lx) % Lx];
    for (let y = 0; y < N; y++) {
      const gy = y / N * Ly, jy = Math.floor(gy), ty = q(gy - jy);
      for (let x = 0; x < N; x++) {
        const gx = x / N * Lx, ix = Math.floor(gx), tx = q(gx - ix);
        const a = at(ix, jy), b = at(ix + 1, jy), c = at(ix, jy + 1), d = at(ix + 1, jy + 1);
        h[y * N + x] += amp * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
      }
    }
    amp *= gain; fx *= 2; fy *= 2;
  }
  return h;
}

function normalMap(N, h, strength) {
  const data = new Uint8Array(N * N * 4);
  const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * N + x) * 4;
      data[i] = (nx * inv * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

let FLOW = null, RIPPLE = null, STREAK = null;

// Streamwise: features stretched along the pipe, because that is how water
// moving down a bore actually looks.
export function flowNormal() {
  if (!FLOW) FLOW = normalMap(256, fbm(256, 20110311, { ax: 2, ay: 9 }), 2.6);
  return FLOW;
}

// Isotropic: a free surface with wind on it.
export function rippleNormal() {
  if (!RIPPLE) RIPPLE = normalMap(256, fbm(256, 19790328, { ax: 4, ay: 4 }), 2.4);
  return RIPPLE;
}

// Steam is not a body you look through, it is a body you look at: it scatters
// instead of refracting. What makes it read as steam rushing down a pipe is
// torn streaks running along the bore, so it gets an alpha map of streamwise
// tears that scrolls at the run's own metres per second.
export function streakTexture(N = 256) {
  if (STREAK) return STREAK;
  const r = rnd(30111981), waves = [];
  for (let i = 0; i < 7; i++) {
    waves.push([1 + ((r() * 5) | 0), (r() * 3) | 0, (0.45 + r() * 0.55) / (1 + i * 0.5), r() * 6.283]);
  }
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0;
      for (const [fx, fy, amp, ph] of waves) {
        v += amp * Math.sin(2 * Math.PI * (fx * x / N + fy * y / N) + ph);
      }
      // torn, not a smooth gradient
      const a = Math.min(1, Math.pow(Math.max(0, v * 0.42 + 0.5), 1.8));
      const i = (y * N + x) * 4;
      const g = (26 + 229 * a) | 0;
      data[i] = data[i + 1] = data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  STREAK = t;
  return t;
}

// --- the fluid shader -------------------------------------------------------
// Three things on top of a standard lit surface, which between them are what
// makes a body of liquid read as one:
//
//  1. TWO-OCTAVE FLOW. A single scrolling normal map is a sliding wallpaper:
//     the eye locks onto the tile and the water "swims". Sampling the same map
//     twice, once at the run's own speed and once at nearly twice the scale
//     with a slow independent drift, breaks the repeat, and the interference
//     between the two is what surface detail on moving water looks like.
//
//  2. ABSORPTION BY PATH LENGTH. Beer and Lambert: light crossing water loses
//     the colours the water absorbs, in proportion to how far it travelled.
//     Look at the middle of a pipe and you look through the whole bore; look
//     at its edge and through almost nothing. So the tint is exp(-absorption *
//     path), the path from the angle between the surface and the eye. That is
//     what gives a body of liquid its depth: saturated through the middle,
//     pale at the rim, all from one colour.
//
//  3. A FRESNEL EDGE. Grazing angles reflect, and that bright rim is what says
//     "there is a surface here". It is most of what the refraction pass used
//     to be paid for.
//
// And the gradient itself: WATER CHANGES TEMPERATURE ALONG A PIPE, not all at
// once at a joint. Drawing each run as one flat colour puts the whole change
// on a flange, which is a lie you can see. So the material carries two colours
// and mixes between them along its own length.

// If three ever renames the chunk these injections match, the replace becomes
// a silent no-op and the fluids quietly lose their gradient and their flow.
// That is a bug that looks like a subtle art regression, so it is caught here.
let warned = false;
function inject(src, find, replace, what) {
  if (src.indexOf(find) < 0) {
    if (!warned) {
      warned = true;
      console.warn('[3d-fluid-simulator] the fluid shader could not find "' + what
        + '" in this build of three. The water will draw without it.'
        + ' Check src/three/materials.js against three ' + THREE.REVISION + '.');
    }
    return src;
  }
  return src.replace(find, replace);
}

const NORMAL_CHUNK = 'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;';

export function gradientise(mat, axis = 0, rim = 0, wetTr = 0, dens = 1.6, clearcoat = 0) {
  mat.defines = Object.assign({}, mat.defines, { USE_UV: '' });
  const g = {
    c0: { value: new THREE.Color(1, 1, 1) },
    c1: { value: new THREE.Color(1, 1, 1) },
    axis: { value: axis },
    rim: { value: rim },
    dens: { value: dens }
  };
  mat.userData.g = g;
  mat.userData.fluid = { wetTr, clearcoat };
  // ALSO ON userData DIRECTLY, and this is the public name. It is what a
  // material would use for transmission if a host switches real refraction on,
  // and a host reasonably looks for it next to the material rather than inside
  // a bookkeeping object this module happens to keep. Moving it inside one
  // silently disconnected the consumer's refraction toggle: every fluid
  // material stayed opaque with the setting on, and nothing errored, so the
  // only thing that noticed was a proof image.
  if (wetTr) mat.userData.wetTr = wetTr;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uC0 = g.c0;
    sh.uniforms.uC1 = g.c1;
    sh.uniforms.uAxis = g.axis;
    sh.uniforms.uRim = g.rim;
    sh.uniforms.uDens = g.dens;
    sh.uniforms.uTime = FLUID_TIME;
    let f = sh.fragmentShader;
    f = inject(f, '#include <common>',
      '#include <common>\nuniform vec3 uC0;\nuniform vec3 uC1;\n'
      + 'uniform float uAxis;\nuniform float uRim;\n'
      + 'uniform float uDens;\nuniform float uTime;', 'the uniform block');
    // (1) two octaves of flow
    f = inject(f, NORMAL_CHUNK,
      'vec3 mapN = mix( texture2D( normalMap, vNormalMapUv ).xyz,\n'
      + '\t\ttexture2D( normalMap, vNormalMapUv * 2.13'
      + ' + vec2( uTime * 0.023, uTime * -0.014 ) ).xyz, 0.45 ) * 2.0 - 1.0;', 'the flow map');
    // (2) absorption, after the normal is known and before the light is
    // applied, so what the surface reflects stays white and what comes back
    // out of the body is the water's colour
    f = inject(f, '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n'
      + '\tvec3 fTint = mix( uC0, uC1,'
      + ' clamp( mix( vUv.x, vUv.y, uAxis ), 0.0, 1.0 ) );\n'
      + '\tfloat fNdv = clamp( abs( dot( normalize( normal ),'
      + ' normalize( vViewPosition ) ) ), 0.0, 1.0 );\n'
      // The floor matters as much as the slope. A tube is mostly silhouette,
      // so with almost no absorption at grazing angles the whole pipe came out
      // pale and only its centreline carried any colour.
      + '\tdiffuseColor.rgb *= exp( -( vec3( 1.0 ) - fTint )'
      + ' * ( uDens * ( 0.8 + 1.5 * fNdv ) ) );', 'the absorption');
    // (3) the Fresnel edge
    f = inject(f, '#include <colorspace_fragment>',
      '\tfloat fres = pow( 1.0 - clamp( abs( dot( normalize( normal ),'
      + ' normalize( vViewPosition ) ) ), 0.0, 1.0 ), 4.0 );\n'
      + '\tgl_FragColor.rgb += gl_FragColor.rgb * fres * uRim;\n'
      + '#include <colorspace_fragment>', 'the Fresnel edge');
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'fluid-gradient';
  return register(mat);
}

// The flow half of the shader on its own, for water that is not part of a
// circuit: the sea, an open channel. Same reason as (1) above: one scrolling
// tile is wallpaper.
export function twoOctaveFlow(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = FLUID_TIME;
    let f = sh.fragmentShader;
    f = inject(f, '#include <common>', '#include <common>\nuniform float uTime;', 'the uniform block');
    f = inject(f, NORMAL_CHUNK,
      'vec3 mapN = mix( texture2D( normalMap, vNormalMapUv ).xyz,\n'
      + '\t\ttexture2D( normalMap, vNormalMapUv * 2.31'
      + ' + vec2( uTime * 0.011, uTime * -0.007 ) ).xyz, 0.5 ) * 2.0 - 1.0;', 'the flow map');
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'two-octave-flow';
  return mat;
}

// --- painting ---------------------------------------------------------------
// THE ONLY WAY A FLUID MATERIAL IS PAINTED. c1 is the colour at the far end if
// it changes along the way, which is what a reactor does to the water going up
// through it.
//
// The gradient is the ONLY tint. Attenuation is left neutral so it darkens
// with depth without colouring, and the base is left white, because two tints
// multiplied together turn the hot end to mud.
const _c0 = new THREE.Color(), _c1 = new THREE.Color();

export function paint(mat, c0, c1 = c0) {
  // VAPOUR IS NOT ON THE COLOUR MAP. Steam at 285 C put through the ramp comes
  // out orange, and an orange vapour line reads as a hot metal pipe rather
  // than as steam: the thing that says "steam" is that it is pale, torn and
  // fast. A host that really wants to warm a vapour body uses tintVapour().
  if (mat.userData && mat.userData.steam) return mat;
  const g = mat.userData && mat.userData.g;
  const a = toColor(c0, _c0), b = c1 === c0 ? a : toColor(c1, _c1);
  if (g) {
    g.c0.value.copy(a);
    g.c1.value.copy(b);
    // WHITE ALREADY IS WHITE. These three are constants of a gradientised
    // material and they are restated here only so that a host which reached in
    // and changed one gets it back. Written unconditionally they were three
    // colour conversions per body per frame, sixty times a second, to arrive
    // at the value that was already there; the comparison costs three loads.
    const c = mat.color;
    if (c.r !== 1 || c.g !== 1 || c.b !== 1) c.setHex(0xffffff);
  } else if (mat.color) {
    mat.color.copy(a);
  }
  const att = mat.attenuationColor;
  if (att && (att.r !== 1 || att.g !== 1 || att.b !== 1)) att.setHex(0xffffff);
  // NEUTRAL, not the water's colour. The gradient injection multiplies the
  // whole fragment, transmitted light, diffuse and emissive alike, by that
  // same colour, so an emissive already tinted blue came out blue SQUARED: a
  // fifth of what it should be. Water in the shadow of a machine then had
  // nothing of its own to show and went to a dark panel, while the identical
  // recipe on a pipe against the sky came out three times brighter. Grey lets
  // the one multiply do all the tinting.
  const em = mat.emissive;
  if (em && (em.r !== 0.03 || em.g !== 0.03 || em.b !== 0.03)) em.setScalar(0.03);
  return mat;
}

// A vapour body warmed a little towards a colour, for a host that wants to say
// something about a steam line's temperature. `amount` is small on purpose:
// past about a fifth the vapour stops reading as vapour.
export function tintVapour(mat, colour, amount = 0.15) {
  const c = toColor(colour, _c0);
  mat.color.setHex(0xdfeefb, THREE.SRGBColorSpace).lerp(c, Math.max(0, Math.min(0.4, amount)));
  return mat;
}

// [r, g, b] from core/colour.js, a hex integer, or a THREE.Color.
function toColor(c, out) {
  if (c instanceof THREE.Color) return c;
  if (typeof c === 'number') return out.setHex(c, THREE.SRGBColorSpace);
  return out.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}

// The colour recipe, as THREE.Colors. Every call site goes through one of
// these two and no other: a call site that mixes its own colour is what breaks
// the promise that the same orange means the same thing across a picture.
const _ramp = [0, 0, 0];
export function colourOf(range, T, out = new THREE.Color()) {
  colourIn(range, T, _ramp);
  return out.setRGB(_ramp[0], _ramp[1], _ramp[2], THREE.SRGBColorSpace);
}
export function colourAt(u, out = new THREE.Color()) {
  fluidColour(u, _ramp);
  return out.setRGB(_ramp[0], _ramp[1], _ramp[2], THREE.SRGBColorSpace);
}
export function glowOf(K, out = new THREE.Color()) {
  glowColour(K, _ramp);
  return out.setRGB(_ramp[0], _ramp[1], _ramp[2], THREE.SRGBColorSpace);
}

// --- the materials ----------------------------------------------------------

// One material per run: they scroll at different speeds, so they cannot share.
export function liquidMaterial(dia) {
  const n = flowNormal().clone();
  n.needsUpdate = true;
  return gradientise(new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    // Water under flow is SMOOTH. Rough, with a strong normal map, the pipes
    // came out as corrugated rubber tubing: chunky ribs marching down the
    // bore. Glossy, with the ripple turned well down, what moves is glints on
    // a smooth body, which is what a pipe of water looks like. Not
    // mirror-smooth either: at 0.045 the key light landed on every pipe as one
    // very bright streak, and where a pipe met a vessel that streak sat across
    // the joint as a white dart with bloom on top of it.
    roughness: 0.1,
    metalness: 0,
    transmission: 0,
    ior: 1.333,
    thickness: dia * 0.9,
    attenuationColor: new THREE.Color(0x1f6fa8),
    attenuationDistance: dia * 2.4,
    normalMap: n,
    normalScale: new THREE.Vector2(0.14, 0.14),
    clearcoatRoughness: 0.18,
    envMapIntensity: 0.55,
    emissive: new THREE.Color(0x081d33),
    emissiveIntensity: 0.3,
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: true
  }), 0, 0.42, 1, 1.9, 0.3);
}

// A free surface: the same body as the pipes seen from above. Same shading
// model, an isotropic ripple instead of a streamwise one, and a stronger rim,
// because the edge of a pool is where you see into it.
export function surfaceMaterial(depth = 4) {
  const n = rippleNormal().clone();
  n.needsUpdate = true;
  return gradientise(new THREE.MeshPhysicalMaterial({
    // Rough enough that a flat horizontal face is not one blown highlight: a
    // pool lit from above at 0.2 came out as a white lens lying on the water
    // rather than as the top of it.
    color: 0xffffff, roughness: 0.34,
    metalness: 0, transmission: 0,
    opacity: 1,
    ior: 1.333, thickness: depth * 0.22,
    attenuationColor: new THREE.Color(0x1f6fa8), attenuationDistance: depth * 2.6,
    normalMap: n, normalScale: new THREE.Vector2(0.09, 0.09),
    clearcoatRoughness: 0.22,
    envMapIntensity: 0.6,
    emissive: new THREE.Color(0x08243d), emissiveIntensity: 0.12,
    transparent: false, side: THREE.DoubleSide
  }), 1, 0.22, 0.9, 1.5, 0.25);
}

// A body of water in a vessel, a pool or a tank: wider than a pipe, so its
// colour is taken over a longer path. Saturation here is attenuation distance,
// not colour: a pipe half a metre across takes its blue over about a metre of
// water, so a wide pool given three times that comes out visibly paler than
// the line feeding it, which is the same sudden change of colour by another
// route.
//
// DOUBLE-SIDED, always. A clipped solid is not capped, so with front faces
// only the near half vanishes and the far half is back-facing and culled: the
// body is there and draws nothing.
export function bodyMaterial(opts = {}) {
  const n = rippleNormal().clone();
  n.needsUpdate = true;
  const rep = opts.repeat || [3, 3];
  n.repeat.set(rep[0], rep[1]);
  return gradientise(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.2, metalness: 0,
    transmission: 0, ior: 1.333, thickness: opts.thickness == null ? 1.5 : opts.thickness,
    envMapIntensity: 0.6,
    attenuationColor: new THREE.Color(0x1f6fa8),
    attenuationDistance: opts.attenuation == null ? 4.0 : opts.attenuation,
    opacity: 1, transparent: false,
    clearcoatRoughness: 0.2,
    normalMap: n, normalScale: new THREE.Vector2(0.3, 0.3),
    emissive: new THREE.Color(0x0a2f4a), emissiveIntensity: 0.12,
    side: THREE.DoubleSide,
    clippingPlanes: opts.cut || null
  }), 1, 0.5, 0.9, 1.5, 0.3);
}

export function steamMaterial() {
  const n = flowNormal().clone();
  n.needsUpdate = true;
  const a = streakTexture().clone();
  a.needsUpdate = true;
  const m = new THREE.MeshStandardMaterial({
    color: 0xdfeefb, roughness: 0.95, metalness: 0,
    emissive: new THREE.Color(0x7fa9c8), emissiveIntensity: 0.35,
    normalMap: n, normalScale: new THREE.Vector2(0.8, 0.8),
    alphaMap: a, transparent: true, opacity: 0.9,
    depthWrite: false, side: THREE.DoubleSide
  });
  // tagged so a settings panel can switch every vapour body off at once
  m.userData.steam = true;
  return m;
}

// What is carried along inside a pipe: pale, soft and barely there, because
// the point of it is to show the water moving and not to be a thing in its own
// right. Air bubbles rise; anything drawn as a white bubble travelling
// downwards reads as wrong before the viewer can say why, so these are specks
// of the water itself.
export function fleckMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xe8f5ff, roughness: 0.3, metalness: 0,
    transparent: true, opacity: 0.3,
    emissive: new THREE.Color(0x8fc4e6), emissiveIntensity: 0.3,
    depthWrite: false
  });
}

// Bubbles are small and there are a lot of them, so they get a cheap material
// rather than another refractive body: a bright shell with a hard highlight,
// which is what a bubble in water looks like at this size anyway.
export function bubbleMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xeaf6ff, roughness: 0.06, metalness: 0.1,
    transparent: true, opacity: 0.5,
    emissive: new THREE.Color(0x9fd0ee), emissiveIntensity: 0.35,
    depthWrite: false
  });
}

// Condensate drops: bright, pale and a little glassy, so they read as water
// coming out of steam rather than as more bubbles.
export function dropMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xcfe8fb, roughness: 0.05, metalness: 0,
    transparent: true, opacity: 0.5,
    emissive: new THREE.Color(0x4f93bd), emissiveIntensity: 0.3,
    depthWrite: false
  });
}

// Vapour coming off a boiling surface. Bigger, softer and fainter than a
// bubble, and it never writes depth, so a cloud of them reads as one body of
// steam leaving the water rather than as a hundred separate beads.
export function puffMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xf2f9ff, roughness: 1, metalness: 0,
    transparent: true, opacity: 0.13,
    emissive: new THREE.Color(0x9dc4de), emissiveIntensity: 0.28,
    depthWrite: false
  });
}

// The steel a fluid runs inside. Only the FAR wall is drawn, so you look
// straight down the bore at the water: a fully transparent tube washes out
// into whatever is behind it and the water disappears with it. A steam run
// wants a whole tube cut on the section plane instead, because its core is
// translucent and with only a far wall it reads as a glowing tube floating in
// the air.
export function casingMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: opts.color == null ? 0x9fb0bf : opts.color,
    roughness: 0.52, metalness: 0.25,
    side: opts.section ? THREE.DoubleSide : THREE.BackSide,
    envMapIntensity: 0.7,
    clippingPlanes: opts.cut || null,
    clipIntersection: false
  });
}

// Everything this module can make, in one call, for a host that just wants a
// table of materials to hand to a builder.
export function build(opts = {}) {
  return {
    fleck: fleckMaterial(),
    bubble: bubbleMaterial(),
    drop: dropMaterial(),
    puff: puffMaterial(),
    casing: casingMaterial(opts),
    steamCasing: casingMaterial(Object.assign({ color: 0x6f7b87, section: true }, opts))
  };
}

export { THREE };
