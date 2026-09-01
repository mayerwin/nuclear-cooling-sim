// ---------------------------------------------------------------------------
// fluid.js - what the water actually looks like.
//
// The liquid is a real refractive body, not a coloured line. It is a solid of
// revolution filling the bore, given to Three's MeshPhysicalMaterial with
// transmission, an index of refraction of 1.333 and an attenuation colour, so
// the renderer bends the background through it the way water does. On top of
// that goes a tiling normal map that scrolls at the leg's own velocity in
// metres per second, and a string of instanced bubbles carried along at the
// same speed, so you can see how fast it is going and which way.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

// --- tiling normal maps -----------------------------------------------------
// Sum of sines on integer frequencies, so the pattern wraps exactly. Central
// differences turn the height field into a normal map.
function normalMap(N, waves, strength) {
  const h = new Float32Array(N * N);
  for (const w of waves) {
    const [fx, fy, amp, ph] = w;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        h[y * N + x] += amp * Math.sin(2 * Math.PI * (fx * x / N + fy * y / N) + ph);
      }
    }
  }
  const data = new Uint8Array(N * N * 4);
  const at = (x, y) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
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

// A deterministic little generator, so the same pattern comes out every load.
function rnd(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

let FLOW = null, RIPPLE = null;

// Streamwise: features stretched along the pipe, because that is how water
// moving down a bore actually looks.
export function flowNormal() {
  if (!FLOW) {
    const r = rnd(20110311), waves = [];
    for (let i = 0; i < 9; i++) {
      waves.push([1 + ((r() * 3) | 0), 2 + ((r() * 7) | 0),
        (0.5 + r() * 0.5) / (1 + i * 0.55), r() * 6.283]);
    }
    FLOW = normalMap(256, waves, 5.5);
  }
  return FLOW;
}

// Isotropic: a free surface with wind on it.
export function rippleNormal() {
  if (!RIPPLE) {
    const r = rnd(19790328), waves = [];
    for (let i = 0; i < 10; i++) {
      waves.push([1 + ((r() * 6) | 0), 1 + ((r() * 6) | 0),
        (0.5 + r() * 0.5) / (1 + i * 0.5), r() * 6.283]);
    }
    RIPPLE = normalMap(256, waves, 4.5);
  }
  return RIPPLE;
}

// --- the liquid itself ------------------------------------------------------
export const LIQUID = { COLD: 0x1f6fa8, HOT: 0xd8571e, STEAM: 0xdcecf8 };

// One material per pipe: they scroll at different speeds, so they cannot share.
// A phone cannot afford refraction. Every transmissive material makes the
// renderer draw the WHOLE scene again into a target before it can shade one
// pipe, and this model has dozens of them; on a real handset that is what
// takes the GPU past its budget and loses the WebGL context, which is why the
// inside view came back as a blank white page. Below, the same materials are
// built without transmission: the colour then comes from the base colour and
// the gradient injection, both of which are set every frame anyway, so the
// water still reads as water and costs one ordinary draw.
// ?lowfx=1 forces it on and ?lowfx=0 forces it off, so the cheap path can be
// looked at on a desktop and the expensive one tried on a handset.
export const LOWFX = (() => {
  try {
    const q = new URLSearchParams(location.search).get('lowfx');
    if (q === '1') return true;
    if (q === '0') return false;
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
    return (navigator.maxTouchPoints || 0) > 1
      && Math.min(screen.width, screen.height) < 820;
  } catch (e) { return false; }
})();

export function liquidMaterial(dia) {
  const n = flowNormal().clone();
  n.needsUpdate = true;
  return gradientise(new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    // Not mirror-smooth. At 0.045 the key light landed on every pipe as one
    // small, very bright streak, and where a pipe met a vessel that streak sat
    // across the joint as a white dart with bloom on top of it. Water is
    // slightly rough, and a slightly rough highlight is a sheen instead.
    roughness: 0.28,
    metalness: 0,
    // NO SCREEN-SPACE REFRACTION. See the note on REFRACTION below: this model
    // carried seventy-three transmissive materials, and what a body of water
    // in a pipe actually needs is a lit surface, a scrolling flow map and a
    // bright edge, which is how a game draws one.
    transmission: 0,
    ior: 1.333,
    thickness: dia * 0.9,
    attenuationColor: new THREE.Color(LIQUID.COLD),
    attenuationDistance: dia * 2.4,
    normalMap: n,
    normalScale: new THREE.Vector2(0.42, 0.42),
    // A mirror-smooth clearcoat turns every pipe into one blown-out highlight
    // under the key light, and the bloom pass then eats the machine behind it.
    clearcoat: LOWFX ? 0 : 0.22,
    clearcoatRoughness: 0.42,
    envMapIntensity: 0.42,
    emissive: new THREE.Color(0x081d33),
    emissiveIntensity: 0.3,
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: true
  }), 0, 0.42, 1);
}

// REFRACTION, AND WHY THE DEFAULT IS OFF.
//
// Three renders a transmissive material by drawing the scene again into a
// target and sampling it, so every such material costs draw calls on top of
// the frame it is part of. Measured on this model at 1200x800: seventy-three
// transmissive materials, 862 draw calls and 569 ms a frame; with transmission
// off, 581 calls and 160 ms. Same picture, three and a half times the speed,
// and the pass was never buying much - a pipe half a metre across refracts
// almost nothing, and inside an unlit machine it sampled a dark background and
// came out as a dark panel, which is what made a pool of water look painted.
//
// What replaces it is what a game uses: a lit body with a scrolling flow map,
// an environment reflection, and a Fresnel rim. The rim is the whole trick. A
// body of water is bright where you look along its surface and clear where you
// look through it, and brightening the silhouette says "you are looking at
// something transparent" far more cheaply than actually being transparent.
//
// The settings panel can still switch real refraction on for anyone who wants
// to see it. It is an option, not the way the picture is built.

// Water changes temperature *along* a pipe, not all at once at a joint. The
// fuel heats it on the way up through the core; the boiler tubes and the pool
// coil give that heat back on the way through. Drawing each run as one flat
// colour puts the whole change on a flange, which is a lie you can see. So the
// liquid carries two colours and mixes between them along its own length.
// wetTr is what this material's transmission would be if the settings panel
// asks for real refraction. Nothing is built with it on.
export function gradientise(mat, axis = 0, rim = 0, wetTr = 0) {
  mat.defines = Object.assign({}, mat.defines, { USE_UV: '' });
  mat.userData.g = {
    c0: { value: new THREE.Color(1, 1, 1) },
    c1: { value: new THREE.Color(1, 1, 1) },
    axis: { value: axis },
    rim: { value: rim }
  };
  if (wetTr) mat.userData.wetTr = wetTr;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uC0 = mat.userData.g.c0;
    sh.uniforms.uC1 = mat.userData.g.c1;
    sh.uniforms.uAxis = mat.userData.g.axis;
    sh.uniforms.uRim = mat.userData.g.rim;
    // Applied to the FINAL colour, not to the diffuse term.
    //
    // In a transmissive material the diffuse term is almost entirely replaced
    // by the refracted light, and the refracted light is tinted by
    // attenuationColor, which is one uniform for the whole body. Multiplying
    // the diffuse therefore did close to nothing: the reactor's water was
    // whatever single colour its attenuation was set to, top to bottom, so the
    // gradient that was supposed to show it heating as it rises past the fuel
    // was invisible and the water read cold behind the rods. Multiplying at
    // the end tints everything the body actually emits, transmitted light
    // included, and one ramp then works on glass and on paint alike.
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uC0;\nuniform vec3 uC1;\n'
        + 'uniform float uAxis;\nuniform float uRim;')
      // ON THE DIFFUSE, before the light is applied. It used to be multiplied
      // into gl_FragColor, which sits AFTER tone mapping: the lit white body
      // was compressed to near one and the tint then had nothing left to bite
      // on, so every pipe came out pale. Tinting the diffuse gives a coloured
      // body with white highlights, which is what water is.
      .replace('#include <color_fragment>',
        '#include <color_fragment>\n'
        + '\tdiffuseColor.rgb *= mix( uC0, uC1,'
        + ' clamp( mix( vUv.x, vUv.y, uAxis ), 0.0, 1.0 ) );')
      // and the Fresnel edge on top, at grazing angles only. That bright rim
      // is what says "you are looking at a body of clear liquid", and it is
      // what the transmission pass used to be paying for.
      .replace('#include <colorspace_fragment>',
        '\tfloat fres = pow( 1.0 - clamp( abs( dot( normalize( normal ),'
        + ' normalize( vViewPosition ) ) ), 0.0, 1.0 ), 4.0 );\n'
        + '\tgl_FragColor.rgb += gl_FragColor.rgb * fres * uRim;\n'
        + '#include <colorspace_fragment>');
  };
  mat.customProgramCacheKey = () => 'fluid-gradient';
  return mat;
}

// Set both ends at once. Pass one colour for a run at a single temperature.
export function setGradient(mat, c0, c1 = c0) {
  const g = mat.userData.g;
  if (!g) return;
  g.c0.value.copy(c0);
  g.c1.value.copy(c1);
}

// --- vapour -----------------------------------------------------------------
// Steam is not a body you look through, it is a body you look at: it scatters
// instead of refracting. What makes it read as steam rushing down a pipe is
// torn streaks that run along the bore, so it gets an alpha map of streamwise
// tears that scrolls at the leg's own metres per second.
let STREAK = null;
function streakTexture(N = 256) {
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
  // tagged so the settings panel can switch every vapour volume off at once
  m.userData.steam = true;
  return m;
}

export function surfaceMaterial(depth = 4) {
  const n = rippleNormal().clone();
  n.needsUpdate = true;
  // A free surface is the same body as the pipes, seen from above: same
  // shading model, an isotropic ripple instead of a streamwise one, and a
  // stronger rim, because the edge of a pool is where you see into it.
  return gradientise(new THREE.MeshPhysicalMaterial({
    // Rough enough that a flat horizontal face is not one blown highlight.
    // A pool's surface lit from above at 0.2 came out as a white lens lying on
    // the water rather than as the top of it.
    color: 0xffffff, roughness: 0.34,
    metalness: 0, transmission: 0,
    opacity: 1,
    ior: 1.333, thickness: depth * 0.22,
    attenuationColor: new THREE.Color(LIQUID.COLD), attenuationDistance: depth * 2.6,
    normalMap: n, normalScale: new THREE.Vector2(0.16, 0.16),
    clearcoat: LOWFX ? 0 : 0.25, clearcoatRoughness: 0.22,
    envMapIntensity: 0.6,
    emissive: new THREE.Color(0x08243d), emissiveIntensity: 0.12,
    transparent: false, side: THREE.DoubleSide
  }), 1, 0.22, 0.9);
}

// --- bubbles ----------------------------------------------------------------
// Air carried in the stream. They are what makes the speed legible: the tint of
// a moving liquid tells you nothing, a bubble going past tells you everything.
const BUBBLE_GEO = new THREE.IcosahedronGeometry(1, 1);
const _tan = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class Bubbles {
  // frame: {pts, nrm, bnm} sampled along the pipe centreline.
  constructor(frame, radius, count, material) {
    this.frame = frame;
    this.mesh = new THREE.InstancedMesh(BUBBLE_GEO, material, count);
    this.mesh.frustumCulled = false;
    // Hidden until something steps it. An instanced mesh whose matrices have
    // never been written draws every one of its bodies at the origin at unit
    // scale, so a particle system that belongs to a machine this unit does not
    // have - the passive station's pool, on the active station - put a hundred
    // and ten white spheres on top of each other in the middle of the
    // containment floor. Half of one sphere shows above the slab, and that is
    // a small white dome standing in the middle of the building.
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.u = new Float32Array(count);
    this.r = new Float32Array(count);
    this.th = new Float32Array(count);
    this.sz = new Float32Array(count);
    this.wob = new Float32Array(count);
    const g = rnd(count * 7919 + 13);
    for (let i = 0; i < count; i++) {
      this.u[i] = g();
      this.r[i] = Math.sqrt(g()) * radius * 1.9;
      this.th[i] = g() * 6.283;
      this.sz[i] = radius * (0.28 + g() * 0.62);
      this.wob[i] = (g() - 0.5) * 2.4;
    }
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
  }

  // len is the pipe length in metres, v the velocity in metres per second.
  // Fast water smears what is carried in it into streaks and slow water does
  // not, so the stretch is how the speed reads in a still frame as well as in
  // a moving one. clipY hides anything that has risen above a free surface.
  advance(dt, v, len, scale = 1, clipY = Infinity) {
    const f = this.frame, n = f.pts.length;
    const du = (v * dt) / Math.max(0.001, len);
    // Streaks, not beads. A round white ball travelling down a pipe is a
    // bubble, and a pipe full of bubbles is a pipe full of air. What says
    // "water moving" is something long and thin lying along the flow, so the
    // cross-section is halved and the length runs with the speed.
    // Bounded low. At nine times its own width a streak is a needle, and a
    // handful of needles arriving at an elbow point every which way at once:
    // the main steam line grew a white starburst at every corner it turned.
    const stretch = 1.6 + Math.min(2.4, Math.abs(v) * 0.16);
    for (let i = 0; i < this.u.length; i++) {
      let u = this.u[i] + du;
      u -= Math.floor(u);
      this.u[i] = u;
      this.th[i] += this.wob[i] * dt;
      const t = u * (n - 1);
      const j = Math.min(n - 2, t | 0), fr = t - j;
      this._p.copy(f.pts[j]).lerp(f.pts[j + 1], fr);
      const rr = this.r[i];
      this._p.addScaledVector(f.nrm[j], Math.cos(this.th[i]) * rr)
        .addScaledVector(f.bnm[j], Math.sin(this.th[i]) * rr);
      const s = this._p.y > clipY ? 0 : this.sz[i] * scale;
      _tan.copy(f.pts[j + 1]).sub(f.pts[j]).normalize();
      this._q.setFromUnitVectors(_up, _tan);
      this._s.set(s * 0.5, s * stretch, s * 0.5);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// Sample a curve into points plus a stable perpendicular frame, once, at build
// time. Doing this per frame is what makes particle trails cost money.
export function frameOf(path, n = 220) {
  const pts = path.getSpacedPoints(n);
  const nrm = [], bnm = [];
  const up = new THREE.Vector3(0, 1, 0), alt = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = b.clone().sub(a).normalize();
    const ref = Math.abs(t.y) > 0.92 ? alt : up;
    const nv = new THREE.Vector3().crossVectors(t, ref).normalize();
    const bv = new THREE.Vector3().crossVectors(t, nv).normalize();
    nrm.push(nv); bnm.push(bv);
  }
  return { pts, nrm, bnm };
}

// Bubbles are small and there are a lot of them, so they get a cheap material
// rather than another refractive body: a bright shell with a hard highlight,
// which is what a bubble in water looks like at this size anyway.
// What is carried along inside a pipe: pale, soft and barely there, because
// the point of it is to show the water moving and not to be a thing in its own
// right.
export function fleckMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xe8f5ff, roughness: 0.3, metalness: 0,
    transparent: true, opacity: 0.3,
    emissive: new THREE.Color(0x8fc4e6), emissiveIntensity: 0.3,
    depthWrite: false
  });
}

export function bubbleMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xeaf6ff, roughness: 0.06, metalness: 0.1,
    transparent: true, opacity: 0.5,
    emissive: new THREE.Color(0x9fd0ee), emissiveIntensity: 0.35,
    depthWrite: false
  });
}

// --- bubbles rising in a body of water --------------------------------------
// A column of water with nothing moving in it is a block of blue plastic. Heat
// it and it should fizz.
export class Riser {
  // aspect stretches the spawn disc along x, so the same class fills a wide
  // shallow space as readily as a round one.
  constructor(radius, count, material, aspect = 1) {
    this.mesh = new THREE.InstancedMesh(BUBBLE_GEO, material, count);
    this.mesh.frustumCulled = false;
    // Hidden until something steps it. An instanced mesh whose matrices have
    // never been written draws every one of its bodies at the origin at unit
    // scale, so a particle system that belongs to a machine this unit does not
    // have - the passive station's pool, on the active station - put a hundred
    // and ten white spheres on top of each other in the middle of the
    // containment floor. Half of one sphere shows above the slab, and that is
    // a small white dome standing in the middle of the building.
    this.mesh.visible = false;
    this.n = count;
    this.x = new Float32Array(count);
    this.z = new Float32Array(count);
    this.y = new Float32Array(count);
    this.sz = new Float32Array(count);
    this.sp = new Float32Array(count);
    const g = rnd(count * 104729 + 7);
    for (let i = 0; i < count; i++) {
      const a = g() * 6.283, r = Math.sqrt(g()) * radius;
      this.x[i] = Math.cos(a) * r * aspect; this.z[i] = Math.sin(a) * r;
      this.y[i] = g();
      this.sz[i] = 0.05 + g() * 0.16;
      this.sp[i] = 0.5 + g() * 0.9;
    }
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
  }

  // base is the floor of the water, height how deep it is, rate how hard it is
  // boiling from 0 to 1.
  // dir is +1 for bubbles rising through water and -1 for drops falling
  // through steam. Same advection, opposite sign, because that is the only
  // thing that differs between the two.
  step(dt, base, height, rate, cx = 0, cz = 0, scale = 1, dir = 1) {
    const on = rate > 0.005;
    this.mesh.visible = on;
    if (!on) return;
    const t = performance.now() * 0.001;
    for (let i = 0; i < this.n; i++) {
      this.y[i] += dir * dt * this.sp[i] * (0.35 + rate * 1.9) / Math.max(0.5, height);
      this.y[i] -= Math.floor(this.y[i]);
      const yy = base + this.y[i] * height;
      // a bubble wanders as it climbs
      const w = Math.sin(t * 1.7 + i) * 0.12 * (1 - this.y[i] * 0.4);
      this._p.set(cx + this.x[i] + w, yy, cz + this.z[i] + w * 0.7);
      // and grows as the pressure over it drops
      const sc = this.sz[i] * (0.55 + this.y[i] * 0.9) * scale * (0.4 + rate * 0.9);
      this._s.set(sc, sc, sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// --- condensation ------------------------------------------------------------
// Drops forming on a cold surface and falling off it. Not bubbles with the
// sign flipped: a bubble is a round thing that rises, a drop is an elongated
// thing that hangs, lets go and stretches as it falls. They spawn along a
// line, because what they come off is a tube.
export class Drip {
  constructor(count, material) {
    this.mesh = new THREE.InstancedMesh(BUBBLE_GEO, material, count);
    this.mesh.frustumCulled = false;
    // Hidden until something steps it. An instanced mesh whose matrices have
    // never been written draws every one of its bodies at the origin at unit
    // scale, so a particle system that belongs to a machine this unit does not
    // have - the passive station's pool, on the active station - put a hundred
    // and ten white spheres on top of each other in the middle of the
    // containment floor. Half of one sphere shows above the slab, and that is
    // a small white dome standing in the middle of the building.
    this.mesh.visible = false;
    this.n = count;
    this.x = new Float32Array(count);
    this.z = new Float32Array(count);
    this.t = new Float32Array(count);
    this.sz = new Float32Array(count);
    this.sp = new Float32Array(count);
    const g = rnd(count * 31 + 5);
    for (let i = 0; i < count; i++) {
      this.x[i] = g() - 0.5;
      this.z[i] = g() - 0.5;
      this.t[i] = g();
      this.sz[i] = 0.028 + g() * 0.03;
      this.sp[i] = 0.7 + g() * 0.6;
    }
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
  }

  // span: how far along the tube they spawn. top: the tube. floor: the pool.
  step(dt, cx, cz, span, depth, top, floor, rate) {
    const on = rate > 0.01;
    this.mesh.visible = on;
    if (!on) return;
    const fall = Math.max(0.4, top - floor);
    for (let i = 0; i < this.n; i++) {
      this.t[i] += dt * this.sp[i] * (0.25 + rate * 0.85);
      if (this.t[i] > 1) this.t[i] -= 1;
      const u = this.t[i];
      // It clings for the first fifth of its life, then falls, accelerating.
      const cling = u < 0.2;
      const f = cling ? 0 : Math.pow((u - 0.2) / 0.8, 2);
      const y = top - f * fall;
      // and it stretches as it goes, which is what tells you it is falling
      const st = cling ? 1 : 1 + f * 3.2;
      this._p.set(cx + this.x[i] * span, y, cz + this.z[i] * depth);
      const sc = this.sz[i] * (cling ? 0.7 + u * 1.5 : 1);
      this._s.set(sc, sc * st, sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
