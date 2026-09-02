// ---------------------------------------------------------------------------
// plume.js - steam and smoke, as points that rise, spread and thin out.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { hash1 } from '../flow.js?v=29b6a124b2';

let sprite = null;
function puffTexture() {
  if (sprite) return sprite;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  sprite = new THREE.CanvasTexture(c);
  return sprite;
}

// One soft sprite, sized in metres and fading with its own alpha attribute.
function puffMaterial(color, size) {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: puffTexture() }, uColor: { value: new THREE.Color(color) },
      uSize: { value: size } },
    vertexShader: `
      attribute float aScale; attribute float aAlpha;
      varying float vA;
      uniform float uSize;
      void main() {
        vA = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * aScale * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform vec3 uColor; varying float vA;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        gl_FragColor = vec4(uColor, t.a * vA);
      }`,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending
  });
}

// A body of vapour standing in a space: soft round sprites drifting through a
// box, fading in where they arrive and out where they have given up. Not
// spheres. A sphere has a hard silhouette, and a hundred hard silhouettes is
// popcorn; steam has no edge, which is most of what makes it read as steam.
export class PuffCloud {
  // w, d: how wide and deep the space is. h: how far a puff travels through it.
  // size is roughly seven times the diameter a puff should have in metres:
  // gl_PointSize works in the same units Plume's does, where 300/distance is
  // the projection, so a metre-wide puff is about a seven.
  constructor(count, opts = {}) {
    this.n = count;
    this.w = opts.w == null ? 1 : opts.w;
    this.d = opts.d == null ? 1 : opts.d;
    this.h = opts.h == null ? 3 : opts.h;
    this.grow = opts.grow == null ? 1.6 : opts.grow;
    this.pos = new Float32Array(count * 3);
    this.aScale = new Float32Array(count);
    this.aAlpha = new Float32Array(count);
    this.t = new Float32Array(count);
    this.ox = new Float32Array(count);
    this.oz = new Float32Array(count);
    this.sp = new Float32Array(count);
    this.sz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.t[i] = hash1(i * 71 + 3);
      this.ox[i] = hash1(i * 131 + 7) - 0.5;
      this.oz[i] = hash1(i * 197 + 11) - 0.5;
      this.sp[i] = 0.6 + hash1(i * 251 + 13) * 0.8;
      this.sz[i] = 0.55 + hash1(i * 313 + 17) * 0.85;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aScale', new THREE.BufferAttribute(this.aScale, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    this.geo = geo;
    this.mat = puffMaterial(opts.color == null ? 0xeef6fb : opts.color,
      opts.size == null ? 30 : opts.size);
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  // dir is -1 for vapour settling down a throat and +1 for vapour rising off
  // water. rate from 0 to 1 is how hard the machine is working.
  step(dt, cx, cy, cz, rate, dir = 1, opacity = 0.55) {
    const on = rate > 0.005;
    this.points.visible = on;
    if (!on) return;
    for (let i = 0; i < this.n; i++) {
      this.t[i] += dt * this.sp[i] * (0.25 + rate * 1.1) / Math.max(0.6, this.h) * 2.2;
      this.t[i] -= Math.floor(this.t[i]);
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
}

export class Plume {
  constructor(max, color, size) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.n = 0; this.cursor = 0; this.acc = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.aScale = new Float32Array(max);
    this.aAlpha = new Float32Array(max);
    geo.setAttribute('aScale', new THREE.BufferAttribute(this.aScale, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    this.geo = geo;
    this.mat = puffMaterial(color, size);
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
  }
  emit(x, y, z, o) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (this.n < this.max) this.n++;
    const s = hash1(i * 977 + Math.floor(o.k || 0));
    const sp = o.spread || 1.5;
    this.pos[i * 3] = x + (hash1(i * 31) - 0.5) * sp;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z + (hash1(i * 53) - 0.5) * sp;
    this.vel[i * 3] = (hash1(i * 71) - 0.5) * (o.vx || 2);
    this.vel[i * 3 + 1] = (o.vy || 6) * (0.6 + 0.7 * s);
    this.vel[i * 3 + 2] = (hash1(i * 97) - 0.5) * (o.vx || 2);
    this.age[i] = 0;
    this.life[i] = (o.life || 4) * (0.7 + 0.6 * s);
    this.seed[i] = s;
  }
  // A plume that has just been switched on has to look like a plume already:
  // a scenario can be jumped to at nine hundred times speed, and three frames
  // of emission is six puffs and reads as nothing at all.
  step(dt, rate, x, y, z, o = {}) {
    if (rate > 0 && !this.running) {
      this.running = true;
      const L = o.life || 4;
      for (let k = 0; k < 20; k++) this.advance(L / 20, rate, x, y, z, o);
    }
    if (rate <= 0) this.running = false;
    this.advance(dt, rate, x, y, z, o);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aScale.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.setDrawRange(0, this.n);
  }

  advance(dt, rate, x, y, z, o = {}) {
    if (dt > 0) {
      for (let i = 0; i < this.n; i++) {
        if (this.age[i] >= this.life[i]) { this.aAlpha[i] = 0; continue; }
        this.age[i] += dt;
        this.vel[i * 3 + 1] += (o.buoy == null ? 2.2 : o.buoy) * dt;
        this.vel[i * 3] *= Math.pow(0.6, dt);
        this.vel[i * 3 + 2] *= Math.pow(0.6, dt);
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
          this.emit(x, y, z, { ...o, k: this.cursor + this.n });
        }
      }
    }
  }
}
