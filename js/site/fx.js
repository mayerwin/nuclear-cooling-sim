// ---------------------------------------------------------------------------
// fx.js - particle systems: steam, smoke, fire, hydrogen deflagration,
// debris, shockwaves and the advected radioactive plume that actually
// deposits contamination onto the terrain.
// ---------------------------------------------------------------------------
import { P } from './iso.js?v=df26edc179';
import { clamp, TAU } from '../util.js?v=df26edc179';

const MAXP = 1400;

// Pre-rendered soft sprites: creating a radial gradient per particle per frame
// is by far the most expensive thing a canvas particle system can do.
const SPR = {};
function sprite(name, stops, size = 128) {
  if (SPR[name]) return SPR[name];
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grd = g.createRadialGradient(r * 0.82, r * 0.76, r * 0.06, r, r, r);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
  SPR[name] = c;
  return c;
}
function buildSprites() {
  sprite('light', [[0, 'rgba(252,254,255,0.72)'], [0.42, 'rgba(238,246,252,0.42)'], [1, 'rgba(226,238,248,0)']]);
  sprite('dark', [[0, 'rgba(96,94,98,0.85)'], [0.5, 'rgba(52,50,54,0.5)'], [1, 'rgba(36,34,38,0)']]);
  sprite('fire', [[0, 'rgba(255,250,214,1)'], [0.32, 'rgba(255,178,60,0.92)'], [0.68, 'rgba(226,88,26,0.5)'], [1, 'rgba(140,34,10,0)']]);
  sprite('plume', [[0, 'rgba(222,255,146,1)'], [0.45, 'rgba(158,220,96,0.55)'], [1, 'rgba(120,170,70,0)']]);
  sprite('flash', [[0, 'rgba(255,255,246,1)'], [0.35, 'rgba(255,216,142,0.72)'], [1, 'rgba(255,140,40,0)']]);
}

export class FX {
  constructor(world) {
    this.world = world;
    this.p = [];
    this.rings = [];
    this.flashes = [];
    this.wind = { dir: 0.9, speed: 1.0 };    // dir in world radians, tiles/s
    this.windDeg = 150;
    this.setWindDeg(150);
    this.time = 0;
  }
  clear() { this.p.length = 0; this.rings.length = 0; this.flashes.length = 0; }

  // The user thinks in screen directions ("the plume blows that way"), so
  // convert a screen bearing (0 = up, 90 = right) into world tile space.
  setWindDeg(deg) {
    this.windDeg = deg;
    const t = deg * Math.PI / 180;
    const a = Math.sin(t) / 32, b = -Math.cos(t) / 16;
    const vx = (a + b) / 2, vy = (b - a) / 2;
    this.wind.dir = Math.atan2(vy, vx);
  }

  add(o) {
    if (this.p.length > MAXP) {
      // drop the oldest cheap particle
      let idx = 0;
      for (let i = 0; i < this.p.length; i += 37) if (this.p[i].life > this.p[idx].life) idx = i;
      this.p.splice(idx, 1);
    }
    this.p.push(o);
    return o;
  }

  steam(x, y, z, rate, dt, opt = {}) {
    const n = rate * dt;
    let k = Math.floor(n) + (Math.random() < (n % 1) ? 1 : 0);
    while (k-- > 0) {
      this.add({
        kind: 'steam', x: x + (Math.random() - 0.5) * (opt.spread || 0.6),
        y: y + (Math.random() - 0.5) * (opt.spread || 0.6), z,
        vx: (Math.random() - 0.5) * (opt.turb || 0.35),
        vy: (Math.random() - 0.5) * (opt.turb || 0.35),
        vz: (opt.rise || 1.4) * (0.7 + Math.random() * 0.6),
        r: (opt.r || 0.5) * (0.6 + Math.random() * 0.8), grow: opt.grow || 0.55,
        life: 0, max: opt.max || 5.5,
        col: opt.col || [236, 244, 250], a: opt.a || 0.34, wind: opt.wind === undefined ? 1 : opt.wind
      });
    }
  }
  smoke(x, y, z, rate, dt, opt = {}) {
    this.steam(x, y, z, rate, dt, {
      col: opt.col || [42, 40, 44], a: opt.a || 0.5, rise: opt.rise || 1.1,
      r: opt.r || 0.55, grow: opt.grow || 0.5, max: opt.max || 7, spread: opt.spread
    });
  }
  fire(x, y, z, rate, dt, opt = {}) {
    const n = rate * dt;
    let k = Math.floor(n) + (Math.random() < (n % 1) ? 1 : 0);
    while (k-- > 0) {
      this.add({
        kind: 'fire', x: x + (Math.random() - 0.5) * (opt.spread || 0.5),
        y: y + (Math.random() - 0.5) * (opt.spread || 0.5), z: z + Math.random() * 0.2,
        vx: 0, vy: 0, vz: 1.9 + Math.random() * 1.6,
        r: (opt.r || 0.34) * (0.6 + Math.random() * 0.9), grow: 0.02,
        life: 0, max: 0.75 + Math.random() * 0.6, a: opt.a || 0.5, wind: 0.35
      });
    }
  }
  debris(x, y, z, n, power) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = power * (0.35 + Math.random() * 1.1);
      this.add({
        kind: 'debris', x, y, z: z + Math.random() * 2,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: power * (1.2 + Math.random() * 2.6),
        r: 0.06 + Math.random() * 0.16, life: 0, max: 4 + Math.random() * 4,
        spin: (Math.random() - 0.5) * 12, rot: 0, hot: Math.random() < 0.5, wind: 0.1
      });
    }
  }
  ring(x, y, z, r, speed, col = '255,240,200') {
    this.rings.push({ x, y, z, r: 0.4, max: r, speed, life: 0, col });
  }
  flash(x, y, z, r, dur = 0.55) {
    this.flashes.push({ x, y, z, r, life: 0, max: dur });
  }

  // Radioactive aerosol. `bqFrame` is the activity actually released during
  // this frame *in simulation time* - so the particles carry the real budget
  // even when the clock is running at 1800x.
  plume(x, y, z, bqFrame, dt, buoy = 1) {
    if (bqFrame <= 0) return;
    const n = 13 * dt;
    let k = Math.floor(n) + (Math.random() < (n % 1) ? 1 : 0);
    if (k < 1) return;
    const per = bqFrame / k;
    while (k-- > 0) {
      this.add({
        kind: 'plume', x: x + (Math.random() - 0.5) * 1.2, y: y + (Math.random() - 0.5) * 1.2, z,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
        vz: 0.8 * buoy + Math.random() * 0.6,
        r: 0.7 + Math.random() * 0.6, grow: 0.12, life: 0, max: 15 + Math.random() * 9,
        bq: per, wind: 1.25
      });
    }
  }

  update(dt, simSpeedVis = 1) {
    this.time += dt;
    const w = this.wind;
    const wx = Math.cos(w.dir) * w.speed, wy = Math.sin(w.dir) * w.speed;
    const World = this.world;
    for (let i = this.p.length - 1; i >= 0; i--) {
      const q = this.p[i];
      q.life += dt;
      if (q.life > q.max) { this.p.splice(i, 1); continue; }
      const wf = q.wind === undefined ? 1 : q.wind;
      if (q.kind === 'debris') {
        q.vz -= 9.0 * dt;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        q.rot += q.spin * dt;
        const gz = World ? World.zAt(q.x | 0, q.y | 0) : 0;
        if (q.z <= gz) {
          q.z = gz; q.vz = 0; q.vx *= 0.3; q.vy *= 0.3;
          if (q.hot && World) { World.scorch[World.idx(clamp(q.x | 0, 0, 47), clamp(q.y | 0, 0, 47))] = 1; World.dirtyOverlay = true; }
          q.max = Math.min(q.max, q.life + 1.5);
        }
      } else {
        q.x += (q.vx + wx * wf) * dt;
        q.y += (q.vy + wy * wf) * dt;
        q.z += q.vz * dt;
        q.vz *= Math.pow(0.55, dt);
        if (q.grow) q.r += q.grow * dt;
        if (q.kind === 'plume') {
          q.vz = Math.max(-0.02, q.vz - 0.08 * dt);
          // crosswind turbulent diffusion - the plume widens as it travels
          const cw = 0.42 * dt;
          q.vx += (Math.random() - 0.5) * cw;
          q.vy += (Math.random() - 0.5) * cw;
          // dry + wet deposition, smeared over a 3x3 footprint so the
          // ground pattern reads as a plume rather than a dotted line
          if (World && q.bq > 0) {
            const dep = q.bq * 0.030 * dt;
            q.bq -= dep;
            const gx = q.x | 0, gy = q.y | 0;
            const unit = dep / 2.5e13;
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                const wgt = (ox === 0 && oy === 0) ? 0.40 : (ox === 0 || oy === 0) ? 0.11 : 0.04;
                World.deposit(gx + ox, gy + oy, unit * wgt);
              }
            }
          }
        }
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt; r.r += r.speed * dt;
      if (r.r > r.max) this.rings.splice(i, 1);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += dt;
      if (f.life > f.max) this.flashes.splice(i, 1);
    }
  }

  draw(ctx, cam, view) {
    if (!SPR.light) buildSprites();
    const arr = this.p;
    arr.sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const L = view ? view.minX - 200 : -1e9, R = view ? view.maxX + 200 : 1e9;
    const TOP = view ? view.minY - 400 : -1e9, BOT = view ? view.maxY + 200 : 1e9;
    ctx.save();
    const hot = [];
    for (const q of arr) {
      const s = P(q.x, q.y, q.z);
      if (s[0] < L || s[0] > R || s[1] < TOP || s[1] > BOT) continue;
      const t = q.life / q.max;
      if (q.kind === 'debris') {
        ctx.save();
        ctx.translate(s[0], s[1]); ctx.rotate(q.rot);
        ctx.fillStyle = q.hot ? `rgba(255,${140 - 80 * t | 0},60,${1 - t * 0.6})` : `rgba(48,44,42,${1 - t * 0.6})`;
        const sz = q.r * 34;
        ctx.fillRect(-sz / 2, -sz / 3, sz, sz * 0.66);
        ctx.restore();
        continue;
      }
      const rad = Math.min(q.r, 3.4) * 34;
      if (q.kind === 'fire') { hot.push([q, s, t]); continue; }
      const spr = q.kind === 'plume' ? SPR.plume
        : (q.col && q.col[0] < 120) ? SPR.dark : SPR.light;
      const a = q.kind === 'plume'
        ? (1 - t) * 0.34 * clamp(q.bq / 1e13, 0.2, 1) : (1 - t) * q.a;
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.drawImage(spr, s[0] - rad, s[1] - rad, rad * 2, rad * 2);
    }
    // additive pass: fire and flashes, so the composite mode is set once
    if (hot.length || this.flashes.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const [q, s, t] of hot) {
        const rad = Math.min(q.r, 3.4) * 34;
        ctx.globalAlpha = clamp((1 - t) * q.a, 0, 1);
        ctx.drawImage(SPR.fire, s[0] - rad, s[1] - rad, rad * 2, rad * 2);
      }
      for (const f of this.flashes) {
        const s = P(f.x, f.y, f.z);
        const a = clamp(1 - f.life / f.max, 0, 1);
        const rad = f.r * 34 * (0.4 + a);
        ctx.globalAlpha = a;
        ctx.drawImage(SPR.flash, s[0] - rad, s[1] - rad, rad * 2, rad * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    // shockwave rings
    for (const r of this.rings) {
      const s = P(r.x, r.y, r.z);
      const a = clamp(1 - r.r / r.max, 0, 1);
      ctx.strokeStyle = `rgba(${r.col},${a * 0.75})`;
      ctx.lineWidth = 2 + 7 * a;
      ctx.beginPath();
      ctx.ellipse(s[0], s[1], r.r * 32 * 1.414, r.r * 16 * 1.414, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
