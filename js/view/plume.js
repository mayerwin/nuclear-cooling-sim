// ---------------------------------------------------------------------------
// plume.js - steam and smoke, as points that rise, spread and thin out.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { hash1 } from '../flow.js?v=c9e7ae8639';

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
    this.mat = new THREE.ShaderMaterial({
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
