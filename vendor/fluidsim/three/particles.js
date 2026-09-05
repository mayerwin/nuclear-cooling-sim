// ---------------------------------------------------------------------------
// particles.js - what is carried in the fluid, and what comes out of it.
//
//   Tracers   specks carried along a run at the run's own velocity
//   Riser     bubbles climbing through a body of water that is boiling
//   Drip      drops condensing on a cold surface and falling to a pool
//   PuffCloud a body of vapour standing in a space
//   Plume     vapour or smoke leaving into the open air
//
// Carried over from nuclear-cooling-sim's fluid.js and plume.js, with one
// change that matters: NOTHING HERE READS THE WALL CLOCK. The original Riser
// took its wobble from performance.now(), so a tool that drove the simulation
// forward got a different picture from the one a viewer saw, and two runs of
// the same scenario never matched. Everything advances on the dt it is given.
//
// The tracers are what make speed legible. The tint of a moving liquid tells
// you nothing; a speck going past tells you everything.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// One shared unit sphere for every instanced system: a low icosahedron, which
// at the size these are drawn is a sphere.
const BEAD = new THREE.IcosahedronGeometry(1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _tan = new THREE.Vector3();

function rnd(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Sample a curve into points plus a stable perpendicular frame, ONCE, at build
// time. Doing this per frame is what makes particle trails cost money.
export function frameOf(path, n = 220) {
  const pts = path.getSpacedPoints(n);
  const nrm = [], bnm = [];
  const up = new THREE.Vector3(0, 1, 0), alt = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const t = b.clone().sub(a).normalize();
    // Along a vertical run the usual up vector is parallel to the tangent and
    // the cross product collapses; anything near vertical takes x instead.
    const ref = Math.abs(t.y) > 0.92 ? alt : up;
    const nv = new THREE.Vector3().crossVectors(t, ref).normalize();
    const bv = new THREE.Vector3().crossVectors(t, nv).normalize();
    nrm.push(nv);
    bnm.push(bv);
  }
  return { pts, nrm, bnm };
}

// An instanced mesh whose matrices have NEVER BEEN WRITTEN draws every one of
// its bodies at the origin at unit scale. On the consumer that put a hundred
// and ten white spheres on top of each other in the middle of the containment
// floor, and half of one sphere above the slab is a small white dome nobody
// can explain. Every system here starts hidden and shows itself when stepped.
function instanced(material, count) {
  const m = new THREE.InstancedMesh(BEAD, material, Math.max(1, count));
  m.frustumCulled = false;
  m.castShadow = false;
  m.receiveShadow = false;
  m.visible = false;
  return m;
}

// --- specks carried along a run ---------------------------------------------
export class Tracers {
  // frame: from frameOf(). radius: the bore they are scattered across.
  constructor(frame, radius, count, material) {
    this.frame = frame;
    this.n = Math.max(1, count | 0);
    this.enabled = true;
    this.mesh = instanced(material, this.n);
    this.u = new Float32Array(this.n);
    this.r = new Float32Array(this.n);
    this.th = new Float32Array(this.n);
    this.sz = new Float32Array(this.n);
    this.wob = new Float32Array(this.n);
    const g = rnd(this.n * 7919 + 13);
    for (let i = 0; i < this.n; i++) {
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
    // Where the core's scroll distance stood last frame, as a fraction of the
    // run, so setPhase can move by the difference rather than by dt.
    this._lastU = 0;
  }

  // len is the run's length in metres, v its velocity in metres per second.
  // clipY hides anything that has risen above a free surface.
  //
  // STREAKS, NOT BEADS. A round white ball travelling down a pipe is a bubble,
  // and a pipe full of bubbles is a pipe full of air. What says "water moving"
  // is something long and thin lying along the flow, so the cross-section is
  // halved and the length runs with the speed. Bounded low: at nine times its
  // own width a streak is a needle, and a handful of needles arriving at an
  // elbow point every which way at once, which turned the main steam line into
  // a white starburst at every corner.
  advance(dt, v, len, scale = 1, clipY = Infinity) {
    if (!Number.isFinite(dt) || !Number.isFinite(v)) return;
    this._write((v * dt) / Math.max(0.001, len), v, scale, clipY, dt);
  }

  // Place the specks from a scroll distance the SOLVER integrated, in metres
  // along the run, rather than integrating dt again here. Two renderers
  // reading the same solver then agree exactly instead of drifting apart, a
  // paused frame does not jump, and a tool that drove the clock forward gets
  // the picture a viewer would have had. The core wraps the distance, so this
  // stays exact in float32 however long the page has been open.
  setPhase(phase, v, len, dt, scale = 1, clipY = Infinity) {
    if (!Number.isFinite(phase)) return;
    const L = Math.max(0.001, len);
    const want = phase / L;
    const du = want - this._lastU;
    this._lastU = want;
    // A wrap in the core's distance shows up here as a jump backwards of most
    // of the run. Left alone every speck would leap; taken as no movement, the
    // frame it happens on is one frame of stillness, which nobody can see.
    this._write(Math.abs(du) > 0.5 ? 0 : du, v, scale, clipY, Number.isFinite(dt) ? dt : 0);
  }

  _write(du, v, scale, clipY, dt) {
    const f = this.frame, n = f.pts.length;
    const stretch = 1.6 + Math.min(2.4, Math.abs(v) * 0.16);
    for (let i = 0; i < this.n; i++) {
      let u = this.u[i] + du;
      u -= Math.floor(u);
      if (!Number.isFinite(u)) u = 0;
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
    // NOW it may show. It starts hidden because an instanced mesh whose
    // matrices were never written draws every body at the origin, and the
    // first advance is the moment that stops being true. A host that wants
    // tracers off, on a device that cannot afford them, sets `enabled` false
    // and it stays off however often this is called.
    this.mesh.visible = this.enabled !== false;
  }

  dispose() {
    this.mesh.dispose();
  }
}

// --- bubbles rising through water -------------------------------------------
// A column of water with nothing moving in it is a block of blue plastic. Heat
// it and it should fizz.
export class Riser {
  // aspect stretches the spawn disc along x, so the same class fills a wide
  // shallow space as readily as a round one.
  constructor(radius, count, material, aspect = 1) {
    this.n = Math.max(1, count | 0);
    this.mesh = instanced(material, this.n);
    this.x = new Float32Array(this.n);
    this.z = new Float32Array(this.n);
    this.y = new Float32Array(this.n);
    this.sz = new Float32Array(this.n);
    this.sp = new Float32Array(this.n);
    this.ph = new Float32Array(this.n);
    const g = rnd(this.n * 104729 + 7);
    for (let i = 0; i < this.n; i++) {
      const a = g() * 6.283, r = Math.sqrt(g()) * radius;
      this.x[i] = Math.cos(a) * r * aspect;
      this.z[i] = Math.sin(a) * r;
      this.y[i] = g();
      this.sz[i] = 0.05 + g() * 0.16;
      this.sp[i] = 0.5 + g() * 0.9;
      this.ph[i] = g() * 6.283;
    }
    this.t = 0;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
  }

  // base is the floor of the water, height how deep it is, rate how hard it is
  // boiling from 0 to 1. dir is +1 for bubbles rising through water and -1 for
  // drops falling through steam: same advection, opposite sign, because that
  // is the only thing that differs between the two.
  step(dt, base, height, rate, cx = 0, cz = 0, scale = 1, dir = 1) {
    const on = rate > 0.005;
    this.mesh.visible = on;
    if (!on || !Number.isFinite(dt)) return;
    this.t += dt;
    const h = Math.max(0.5, height);
    for (let i = 0; i < this.n; i++) {
      this.y[i] += dir * dt * this.sp[i] * (0.35 + rate * 1.9) / h;
      this.y[i] -= Math.floor(this.y[i]);
      if (!Number.isFinite(this.y[i])) this.y[i] = 0;
      const yy = base + this.y[i] * height;
      // a bubble wanders as it climbs
      const w = Math.sin(this.t * 1.7 + this.ph[i]) * 0.12 * (1 - this.y[i] * 0.4);
      this._p.set(cx + this.x[i] + w, yy, cz + this.z[i] + w * 0.7);
      // and grows as the pressure over it drops
      const sc = this.sz[i] * (0.55 + this.y[i] * 0.9) * scale * (0.4 + rate * 0.9);
      this._s.set(sc, sc, sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() { this.mesh.dispose(); }
}

// --- drops condensing and falling -------------------------------------------
// Not bubbles with the sign flipped: a bubble is a round thing that rises, a
// drop is an elongated thing that hangs, lets go and stretches as it falls.
// They spawn along a line, because what they come off is a tube.
export class Drip {
  constructor(count, material) {
    this.n = Math.max(1, count | 0);
    this.mesh = instanced(material, this.n);
    this.x = new Float32Array(this.n);
    this.z = new Float32Array(this.n);
    this.t = new Float32Array(this.n);
    this.sz = new Float32Array(this.n);
    this.sp = new Float32Array(this.n);
    const g = rnd(this.n * 31 + 5);
    for (let i = 0; i < this.n; i++) {
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
    // The last fraction each drop was at, so a host can be told when one
    // landed and splash its surface at the right moment.
    this.landed = 0;
  }

  // span: how far along the tube they spawn. top: the tube. floor: the pool.
  // Returns how many drops landed this step, so the surface underneath can be
  // splashed by the drops that actually reached it rather than by a guess.
  step(dt, cx, cz, span, depth, top, floor, rate) {
    const on = rate > 0.01;
    this.mesh.visible = on;
    this.landed = 0;
    if (!on || !Number.isFinite(dt)) return 0;
    const fall = Math.max(0.4, top - floor);
    for (let i = 0; i < this.n; i++) {
      const was = this.t[i];
      this.t[i] += dt * this.sp[i] * (0.25 + rate * 0.85);
      if (this.t[i] > 1) { this.t[i] -= Math.floor(this.t[i]); this.landed++; }
      else if (was < 1 && this.t[i] >= 1) this.landed++;
      if (!Number.isFinite(this.t[i])) this.t[i] = 0;
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
    return this.landed;
  }

  dispose() { this.mesh.dispose(); }
}

// --- vapour -----------------------------------------------------------------
// Soft round sprites, NOT spheres. A sphere has a hard silhouette and a
// hundred hard silhouettes is popcorn; steam has no edge, which is most of
// what makes it read as steam. The sprite is noise, not a radial blur: a plain
// radial blur reads as a blurred ball, and a column of blurred balls is fog at
// best.
let SPRITE = null;
function puffTexture() {
  if (SPRITE) return SPRITE;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  const g = rnd(20260904);
  const lat = (n) => {
    const a = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) a[i] = g();
    return a;
  };
  const oct = [[4, lat(4), 1.0], [8, lat(8), 0.5], [16, lat(16), 0.25]];
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (n, a, u, v) => {
    const x0 = Math.floor(u * n) % n, y0 = Math.floor(v * n) % n;
    const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const fx = smooth(u * n - Math.floor(u * n)), fy = smooth(v * n - Math.floor(v * n));
    const top = a[y0 * n + x0] * (1 - fx) + a[y0 * n + x1] * fx;
    const bot = a[y1 * n + x0] * (1 - fx) + a[y1 * n + x1] * fx;
    return top * (1 - fy) + bot * fy;
  };
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const u = px / N, v = py / N;
      let nz = 0, wsum = 0;
      for (const [n, a, w] of oct) { nz += sample(n, a, u, v) * w; wsum += w; }
      nz /= wsum;
      const dx = u - 0.5, dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      // the edge is where the noise decides it is
      const edge = Math.max(0, 1 - r / (0.72 + 0.28 * nz));
      const alpha = Math.pow(edge, 1.6) * (0.55 + 0.45 * nz);
      const o = (py * N + px) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(255 * Math.min(1, alpha));
    }
  }
  // A DataTexture, not a canvas: this module has to work without a document,
  // so it can be built in a worker or measured headless.
  SPRITE = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  SPRITE.minFilter = THREE.LinearMipmapLinearFilter;
  SPRITE.magFilter = THREE.LinearFilter;
  SPRITE.generateMipmaps = true;
  SPRITE.needsUpdate = true;
  return SPRITE;
}

// One soft sprite, sized in metres and fading on its own alpha attribute.
export function puffPointMaterial(color = 0xeef6fb, size = 30) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: puffTexture() },
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size }
    },
    vertexShader: [
      'attribute float aScale; attribute float aAlpha;',
      'varying float vA;',
      'uniform float uSize;',
      'void main() {',
      '  vA = aAlpha;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = uSize * aScale * (300.0 / -mv.z);',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap; uniform vec3 uColor; varying float vA;',
      'void main() {',
      '  vec4 t = texture2D(uMap, gl_PointCoord);',
      '  gl_FragColor = vec4(uColor, t.a * vA);',
      '}'
    ].join('\n'),
    transparent: true, depthWrite: false, blending: THREE.NormalBlending
  });
}

// A body of vapour standing in a space: puffs drifting through a box, fading
// in where they arrive and out where they have given up.
export class PuffCloud {
  // w, d: how wide and deep the space is. h: how far a puff travels through it.
  // size is roughly seven times the diameter a puff should have in metres,
  // because gl_PointSize takes 300/distance as its projection.
  constructor(count, opts = {}) {
    this.n = Math.max(1, count | 0);
    this.w = opts.w == null ? 1 : opts.w;
    this.d = opts.d == null ? 1 : opts.d;
    this.h = opts.h == null ? 3 : opts.h;
    this.grow = opts.grow == null ? 1.6 : opts.grow;
    this.pos = new Float32Array(this.n * 3);
    this.aScale = new Float32Array(this.n);
    this.aAlpha = new Float32Array(this.n);
    this.t = new Float32Array(this.n);
    this.ox = new Float32Array(this.n);
    this.oz = new Float32Array(this.n);
    this.sp = new Float32Array(this.n);
    this.sz = new Float32Array(this.n);
    const g = rnd(this.n * 71 + 3);
    for (let i = 0; i < this.n; i++) {
      this.t[i] = g();
      this.ox[i] = g() - 0.5;
      this.oz[i] = g() - 0.5;
      this.sp[i] = 0.6 + g() * 0.8;
      this.sz[i] = 0.55 + g() * 0.85;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(this.aScale, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    this.geo = geo;
    this.mat = puffPointMaterial(opts.color, opts.size);
    this.mat.userData.steam = true;
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
  }

  // dir is -1 for vapour settling down a throat and +1 for vapour rising off
  // water. rate from 0 to 1 is how hard the machine is working.
  step(dt, cx, cy, cz, rate, dir = 1, opacity = 0.55) {
    const on = rate > 0.005;
    this.points.visible = on;
    if (!on || !Number.isFinite(dt)) return;
    for (let i = 0; i < this.n; i++) {
      this.t[i] += dt * this.sp[i] * (0.25 + rate * 1.1) / Math.max(0.6, this.h) * 2.2;
      this.t[i] -= Math.floor(this.t[i]);
      if (!Number.isFinite(this.t[i])) this.t[i] = 0;
      const u = this.t[i];
      const along = dir > 0 ? u : 1 - u;
      this.pos[i * 3] = cx + this.ox[i] * this.w;
      this.pos[i * 3 + 1] = cy + along * this.h;
      this.pos[i * 3 + 2] = cz + this.oz[i] * this.d;
      // Fat and faint by the end of the run, small and solid at the start.
      this.aScale[i] = this.sz[i] * (1 + u * this.grow);
      // Never appearing or vanishing at a hard edge: in over the first tenth
      // of the travel, out over the last third.
      this.aAlpha[i] = opacity * Math.min(1, u / 0.1) * (1 - u * 0.72);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aScale.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

// Vapour or smoke leaving into the open air: emitted, buoyant, spreading and
// dying. A plume that has just been switched on has to look like a plume
// already, because a scenario can be jumped to at nine hundred times speed and
// three frames of emission is six puffs, which reads as nothing at all.
export class Plume {
  constructor(max, color, size) {
    this.max = Math.max(1, max | 0);
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.age = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.aScale = new Float32Array(this.max);
    this.aAlpha = new Float32Array(this.max);
    this.n = 0; this.cursor = 0; this.acc = 0; this.alive = 0;
    this.running = false;
    this._g = rnd(90210);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(this.aScale, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    this.geo = geo;
    this.mat = puffPointMaterial(color, size);
    this.mat.userData.steam = true;
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  emit(x, y, z, o) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (this.n < this.max) this.n++;
    const g = this._g;
    const s = g();
    const sp = o.spread || 1.5;
    this.pos[i * 3] = x + (g() - 0.5) * sp;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z + (g() - 0.5) * sp;
    this.vel[i * 3] = (g() - 0.5) * (o.vx || 2);
    this.vel[i * 3 + 1] = (o.vy || 6) * (0.6 + 0.7 * s);
    this.vel[i * 3 + 2] = (g() - 0.5) * (o.vx || 2);
    this.age[i] = 0;
    this.life[i] = (o.life || 4) * (0.7 + 0.6 * s);
  }

  step(dt, rate, x, y, z, o = {}) {
    if (rate > 0 && !this.running) {
      this.running = true;
      const L = o.life || 4;
      for (let k = 0; k < 20; k++) this.advance(L / 20, rate, x, y, z, o);
    }
    if (rate <= 0) this.running = false;
    // Idle: nothing alive and nothing arriving. Uploading three attribute
    // buffers every frame for a plume that finished a minute ago, five plumes
    // on each unit, was thirty uploads a frame for nothing.
    if (rate <= 0 && this.alive === 0) { this.points.visible = false; return; }
    this.points.visible = true;
    this.advance(dt, rate, x, y, z, o);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aScale.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.setDrawRange(0, this.n);
  }

  advance(dt, rate, x, y, z, o = {}) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    let alive = 0;
    const decay = Math.pow(0.6, dt);
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) { this.aAlpha[i] = 0; continue; }
      alive++;
      this.age[i] += dt;
      this.vel[i * 3 + 1] += (o.buoy == null ? 2.2 : o.buoy) * dt;
      this.vel[i * 3] *= decay;
      this.vel[i * 3 + 2] *= decay;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const u = this.age[i] / this.life[i];
      this.aScale[i] = 0.4 + u * (o.grow == null ? 2.2 : o.grow);
      this.aAlpha[i] = (1 - u) * (u < 0.12 ? u / 0.12 : 1) * (o.alpha == null ? 0.55 : o.alpha);
    }
    if (rate > 0) {
      this.acc += rate * dt;
      let guard = 0;
      while (this.acc >= 1 && guard++ < 12) {
        this.acc -= 1;
        this.emit(x, y, z, o);
        alive++;
      }
      // A very long step would otherwise leave the accumulator holding hours
      // of emission and spend the next twelve frames catching up.
      if (this.acc > 12) this.acc = 0;
    }
    this.alive = alive;
  }

  reset() {
    this.n = 0; this.cursor = 0; this.acc = 0; this.alive = 0;
    this.running = false;
    this.aAlpha.fill(0);
    this.points.visible = false;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}
