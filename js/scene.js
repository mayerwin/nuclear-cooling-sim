// ---------------------------------------------------------------------------
// scene.js — the cutaway, rendered on the GPU.
//
// PixiJS (WebGL2) draws it; fluid.js decides what the fluid is doing. Nothing
// here invents a speed or a direction: every particle position comes out of the
// pipe network, and the pump and the turbine take their rotation from the flow
// through them.
//
// The picture is a cutaway in the museum-model sense: the near quarter of the
// containment wall is removed, the roof is glass, and the top of every vessel
// is sliced off, so you look straight in at the water.
// ---------------------------------------------------------------------------
import * as PIXI from '../vendor/pixi.min.mjs';
import { initPhysics, Machinery } from './machinery.js';
import { MODE, FUEL_TOP } from './plant.js';
import { project, ERX, ERY, TZ } from './iso.js';
import { Surface, Puffs, ratedMdot, naturalMdot, hash1 } from './fluid.js';
import {
  G, SHAFT_Y, SHAFT_Z, HOT_Z, COLD_Z, SG_IN_Z, SG_OUT_Z, COIL_Z,
  FUEL_Z0, FUEL_Z1, waterZ, buildNetwork, solveFlows, PX_PER_MS
} from './plantgeom.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ---- colour ---------------------------------------------------------------
const hex = (s) => (typeof s === 'number' ? s : parseInt(s.slice(1), 16));
function shade(c, f) {
  const n = hex(c);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
  const b = Math.min(255, (n & 255) * f) | 0;
  return (r << 16) | (g << 8) | b;
}
function mix(a, b, t) {
  const x = hex(a), y = hex(b);
  const r = lerp((x >> 16) & 255, (y >> 16) & 255, t) | 0;
  const g = lerp((x >> 8) & 255, (y >> 8) & 255, t) | 0;
  const bl = lerp(x & 255, y & 255, t) | 0;
  return (r << 16) | (g << 8) | bl;
}
const C = {
  cold: 0x3fbfe0, water: 0x2f8ed6, hot: 0xf07a34, steam: 0xdbe9f2,
  power: 0xffd35c, ok: 0x63e08a, warn: 0xffc44d, bad: 0xff5c48,
  ink: 0xe9f2f9, dim: 0x93a6b6, steel: 0x8fa3b3, conc: 0x68788a
};

// Water goes blue -> pale scalding -> orange. Straight from blue to orange in
// RGB passes through brown, and brown water reads as dirty rather than hot.
export function heatedWater(u0) {
  const u = clamp(u0, 0, 1);
  return u < 0.5 ? mix(0x2f8ed6, 0xcfe6f2, u * 2) : mix(0xcfe6f2, 0xff6a33, (u - 0.5) * 2);
}
const waterColor = (K) => heatedWater((K - 660) / 400);
const RAMP = [[560, 0xd9853a], [900, 0xe8702a], [1400, 0xf03516], [2200, 0xff3a18], [3200, 0xff7a44]];
function tempColor(K) {
  if (K <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (K <= RAMP[i][0]) {
      return mix(RAMP[i - 1][1], RAMP[i][1], (K - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

// ---- geometry helpers on a Pixi Graphics ----------------------------------
const P3 = (x, y, z) => project(x, y, z);

function ellipsePts(cx, cy, rx, ry, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return out;
}
function polyPath(g, pts, close) {
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  if (close) g.closePath();
}
function strokePoly(g, pts, style) {
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.stroke(style);
}

// A vessel profile: domed bottom, straight barrel, domed head.
const HEAD_T = 0.70;
const CAPSULE = (() => {
  const out = [];
  for (let i = 0; i <= 44; i++) {
    const t = i / 44;
    let r;
    if (t < 0.14) r = Math.sqrt(1 - Math.pow(1 - t / 0.14, 2));
    else if (t > HEAD_T) r = Math.sqrt(1 - Math.pow((t - HEAD_T) / (1 - HEAD_T), 2));
    else r = 1;
    out.push({ t, r: Math.max(0.05, r) });
  }
  return out;
})();
function vesselProfile(o) {
  return CAPSULE.map((s) => {
    const p = P3(o.x, o.y, o.z + o.h * s.t);
    return { x: p.x, y: p.y, rx: s.r * o.r * ERX, ry: s.r * o.r * ERY, t: s.t };
  });
}
function vesselPath(g, o) {
  const pts = vesselProfile(o);
  const bp = pts[0], tp = pts[pts.length - 1];
  g.moveTo(bp.x - bp.rx, bp.y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x - pts[i].rx, pts[i].y);
  const arc = ellipsePts(tp.x, tp.y, tp.rx, tp.ry, Math.PI, 0, 10);
  for (let i = 0; i < arc.length; i += 2) g.lineTo(arc[i], arc[i + 1]);
  for (let i = pts.length - 1; i >= 0; i--) g.lineTo(pts[i].x + pts[i].rx, pts[i].y);
  const arc2 = ellipsePts(bp.x, bp.y, bp.rx, bp.ry, 0, Math.PI, 10);
  for (let i = 0; i < arc2.length; i += 2) g.lineTo(arc2[i], arc2[i + 1]);
  g.closePath();
  return pts;
}
function vesselRadiusAt(o, z) {
  const t = clamp((z - o.z) / o.h, 0, 1);
  for (let i = 1; i < CAPSULE.length; i++) {
    if (CAPSULE[i].t >= t) {
      const a = CAPSULE[i - 1], b = CAPSULE[i];
      return o.r * lerp(a.r, b.r, (t - a.t) / (b.t - a.t || 1));
    }
  }
  return o.r;
}

// An axis-aligned box, three visible faces.
function box(g, o) {
  const z = o.z || 0, t = z + o.h;
  const A = P3(o.x, o.y, t), B = P3(o.x + o.w, o.y, t),
    Cc = P3(o.x + o.w, o.y + o.d, t), D = P3(o.x, o.y + o.d, t);
  const Bb = P3(o.x + o.w, o.y, z), Cb = P3(o.x + o.w, o.y + o.d, z), Db = P3(o.x, o.y + o.d, z);
  g.moveTo(B.x, B.y).lineTo(Cc.x, Cc.y).lineTo(Cb.x, Cb.y).lineTo(Bb.x, Bb.y).closePath()
    .fill({ color: shade(o.color, 0.88) });
  g.moveTo(D.x, D.y).lineTo(Cc.x, Cc.y).lineTo(Cb.x, Cb.y).lineTo(Db.x, Db.y).closePath()
    .fill({ color: shade(o.color, 0.72) });
  g.moveTo(A.x, A.y).lineTo(B.x, B.y).lineTo(Cc.x, Cc.y).lineTo(D.x, D.y).closePath()
    .fill({ color: shade(o.top || o.color, 1.06) });
  if (o.edge !== false) {
    g.moveTo(A.x, A.y).lineTo(B.x, B.y).lineTo(Cc.x, Cc.y).lineTo(D.x, D.y).closePath()
      .stroke({ width: 1, color: 0x0e151c, alpha: 0.5 });
  }
}

function cylinder(g, o) {
  const z = o.z || 0;
  const top = P3(o.x, o.y, z + o.h), bot = P3(o.x, o.y, z);
  const rx = o.r * ERX, ry = o.r * ERY;
  g.moveTo(bot.x - rx, bot.y).lineTo(top.x - rx, top.y);
  const a = ellipsePts(top.x, top.y, rx, ry, Math.PI, 0, 12);
  for (let i = 0; i < a.length; i += 2) g.lineTo(a[i], a[i + 1]);
  g.lineTo(bot.x + rx, bot.y);
  const b = ellipsePts(bot.x, bot.y, rx, ry, 0, Math.PI, 12);
  for (let i = 0; i < b.length; i += 2) g.lineTo(b[i], b[i + 1]);
  g.closePath();
  const grad = new PIXI.FillGradient({
    type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 },
    colorStops: [
      { offset: 0, color: shade(o.color, 0.62) },
      { offset: 0.42, color: shade(o.color, 1.02) },
      { offset: 1, color: shade(o.color, 0.7) }]
  });
  g.fill(grad);
  if (o.cap !== false) {
    g.ellipse(top.x, top.y, rx, ry).fill({ color: shade(o.capColor || o.color, 1.12) })
      .stroke({ width: 1, color: 0x0e151c, alpha: 0.45 });
  }
  return top;
}

// The disc of a rotor whose shaft runs along the grid-x axis.
function rotorDisc(g, cx, cy, cz, r, blades, ang, style) {
  const hub = P3(cx, cy, cz);
  const pt = (th, rr) => P3(cx, cy + rr * Math.cos(th), cz + rr * Math.sin(th));
  const rim = [];
  for (let i = 0; i <= 28; i++) rim.push(pt((i / 28) * TAU, r));
  strokePoly(g, rim, { width: 1.4, color: style.rim, alpha: 0.8 });
  for (let i = 0; i < blades; i++) {
    const th = ang + (i / blades) * TAU;
    const a = pt(th, r * 0.42), b = pt(th + 0.30, r * 0.97);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y)
      .stroke({ width: style.w || 2.4, color: style.blade, alpha: style.alpha || 0.95, cap: 'round' });
  }
  g.circle(hub.x, hub.y, Math.max(2.5, r * ERY * 0.18)).fill({ color: style.hub });
  return hub;
}

// ---------------------------------------------------------------------------
// the fluid layers: a pipe you can see into, with liquid moving in it
// ---------------------------------------------------------------------------
const PIPE_W = { water: 13, steam: 14 };

function pipeCasing(g, e, w) {
  if (e.hidden || !e.pts) return;
  strokePoly(g, e.pts, { width: w + 4, color: 0x080e14, alpha: 0.9, cap: 'round', join: 'round' });
  strokePoly(g, e.pts, { width: w, color: shade(C.steel, 0.5), cap: 'round', join: 'round' });
  strokePoly(g, e.pts, { width: w * 0.9, color: shade(C.steel, 1.1), cap: 'round', join: 'round' });
  strokePoly(g, e.pts, { width: w * 0.72, color: shade(C.steel, 0.34), cap: 'round', join: 'round' });
  strokePoly(g, e.pts, { width: w * 0.62, color: 0x090f15, cap: 'round', join: 'round' });
}
function pipeLiquid(g, e, w, col, alpha) {
  if (!e.pts) return;
  strokePoly(g, e.pts, { width: w * 0.58, color: col, alpha, cap: 'round', join: 'round' });
}
function pipeBoreMask(g, e, w) {
  if (!e.pts) return;
  strokePoly(g, e.pts, { width: w * 0.62, color: 0xffffff, cap: 'round', join: 'round' });
}
function pipeCrown(g, e, w, col) {
  if (e.hidden || !e.pts) return;
  strokePoly(g, e.pts, { width: w * 0.2, color: shade(col, 1.6), alpha: 0.4, cap: 'round', join: 'round' });
}

// A soft round sprite, used for every drop, puff and glow in the scene.
function blobTexture(soft) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  if (soft) {
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.36)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.85, 'rgba(255,255,255,0.25)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
  }
  x.fillStyle = gr;
  x.fillRect(0, 0, S, S);
  return PIXI.Texture.from(c);
}

// Blur, then bend the alpha curve hard. Two overlapping drops become one body
// of liquid with a clean edge; a lone drop stays a drop. Pixi needs an explicit
// filterArea because a ParticleContainer does not compute its own bounds.
const WORLD_AREA = new PIXI.Rectangle(-900, -400, 2600, 1600);
function liquidLayer(pools, mask, blur, cut, blend) {
  const wrap = new PIXI.Container();
  for (const p of pools) {
    p.container.boundsArea = WORLD_AREA;
    wrap.addChild(p.container);
  }
  const th = new PIXI.ColorMatrixFilter();
  const k = 1 / Math.max(0.05, 1 - cut);
  th.matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, k, -cut * k];
  wrap.filters = [new PIXI.BlurFilter({ strength: blur, quality: 3 }), th];
  wrap.filterArea = WORLD_AREA;
  if (mask) wrap.mask = mask;
  if (blend) wrap.blendMode = blend;
  return wrap;
}

// A pool of particles that is written every frame and never reallocated.
class Pool {
  constructor(texture, max, blend) {
    this.container = new PIXI.ParticleContainer({
      dynamicProperties: { position: true, scale: true, alpha: true, tint: true, rotation: true }
    });
    if (blend) this.container.blendMode = blend;
    this.items = [];
    for (let i = 0; i < max; i++) {
      const p = new PIXI.Particle({ texture, x: 0, y: 0, alpha: 0, anchorX: 0.5, anchorY: 0.5 });
      this.items.push(p);
      this.container.addParticle(p);
    }
    this.n = 0;
  }
  begin() { this.n = 0; }
  put(x, y, sx, sy, rot, tint, alpha) {
    if (this.n >= this.items.length) return;
    const p = this.items[this.n++];
    p.x = x; p.y = y; p.scaleX = sx; p.scaleY = sy;
    p.rotation = rot; p.tint = tint; p.alpha = alpha;
  }
  end() {
    for (let i = this.n; i < this.items.length; i++) this.items[i].alpha = 0;
    this.container.update();
  }
}

// ---------------------------------------------------------------------------
// one plant
// ---------------------------------------------------------------------------
const CUT0 = 0.17 * Math.PI, CUT1 = Math.PI - CUT0;
const gAngle = (theta) => theta - Math.PI / 4;
const BREACH_A = Math.PI * 1.42;

export class PlantNode {
  constructor(plant, textures) {
    this.p = plant;
    this.passive = plant.mode === MODE.PASSIVE;
    this.net = buildNetwork(this.passive);
    this.root = new PIXI.Container();

    this.gShell = new PIXI.Graphics();
    this.gBack = new PIXI.Graphics();
    this.gMach = new PIXI.Graphics();
    this.gPipeF = new PIXI.Graphics();
    this.gFront = new PIXI.Graphics();
    this.gFore = new PIXI.Graphics();

    this.maskBack = new PIXI.Graphics();
    this.maskFront = new PIXI.Graphics();

    this.poolBack = new Pool(textures.drop, 320);
    this.poolVessel = new Pool(textures.drop, 240);
    this.poolFront = new Pool(textures.drop, 320);
    this.poolSteam = new Pool(textures.soft, 320);
    this.poolFx = new Pool(textures.soft, 260, 'normal');
    this.poolGlow = new Pool(textures.soft, 90, 'add');

    // Blur the drops together and then cut the alpha back with a hard curve.
    // Overlapping drops merge into one moving body of liquid instead of
    // reading as a row of dots — the standard 2-D metaball recipe.
    this.liqBack = liquidLayer([this.poolBack], this.maskBack, 2.2, 0.26, 'add');
    this.liqFront = liquidLayer([this.poolFront, this.poolVessel], this.maskFront, 2.2, 0.26, 'add');
    this.liqSteam = liquidLayer([this.poolSteam], this.maskFront, 4.5, 0.3, 'add');

    this.root.addChild(
      this.gShell, this.gBack, this.maskBack, this.liqBack,
      this.gMach, this.gPipeF, this.maskFront,
      this.liqFront, this.liqSteam, this.gFront, this.gFore,
      this.poolFx.container, this.poolGlow.container
    );

    // free surfaces
    this.sCore = new Surface(26, { c: 3.4, damp: 1.35 });
    this.sSg = new Surface(20, { c: 3.0, damp: 1.5 });
    this.sPool = new Surface(30, { c: 2.4, damp: 0.9 });
    this.sTank = new Surface(22, { c: 2.6, damp: 1.2 });
    this.mach = new Machinery();
    this.puffBreach = new Puffs(70);
    this.puffVent = new Puffs(48);
    this.puffCond = new Puffs(46);
    this.puffAir = new Puffs(40);
    this.structKey = '';
  }

  // ---- back and front edge groups ----------------------------------------
  groups() {
    const e = this.net.edges, n = this.net;
    const back = [e.eHot];
    const front = [e.eColdA, e.ePumpThru, e.eColdB, e.eSteam, e.eExh, e.eFeed];
    const vessel = [e.eDown, e.eCore, e.eUp, e.eSg, e.eBoil];
    if (n.prhr) back.push(...n.prhr.edges);
    if (n.gravity) back.push(...n.gravity.edges);
    if (n.inject) front.push(...n.inject.edges);
    back.push(...n.vent.edges);
    return { back, front, vessel };
  }

  measure() {
    for (const c of this.net.all) c.measure(P3);
    this.net.pump.orient(P3);
    if (this.net.injPump) this.net.injPump.orient(P3);
  }

  step(dt, st) {
    const p = this.p;
    solveFlows(this.net, p, st, ratedMdot, naturalMdot);
    for (const c of this.net.all) c.step(dt);
    // The impeller's target speed is the discharge velocity over the tip
    // radius; its sign is whichever way carries water from the suction port to
    // the discharge port, which the two pipes decide, not this code.
    const tip = Math.max(6, G.pump.r * ERX * 0.7);
    const vOut = this.net.edges.eColdB.v * this.net.primary.pxPerMs;
    const mSteam = this.net.secondary.mdot || 0;
    this.mach.step(dt, {
      pumpDriven: (st.s.rcp || 0) > 0.01,
      pumpTarget: this.net.pump.sign * (vOut / tip) * 2.5,
      steamTorque: mSteam * 0.023,
      loadCoef: 2.6,
      auxDriven: !!st.injecting,
      auxTarget: 22
    });
    this.net.pump.angle = this.mach.impeller.angle;
    this.net.pump.omega = this.mach.impeller.speed;
    this.turbine = { angle: this.mach.shaft.angle, speed: Math.abs(this.mach.shaft.speed) };
    this.genRotor = this.turbine;
    this.eccsRotor = { angle: this.mach.aux.angle, speed: this.mach.aux.speed };

    const boil = st.s.boil || 0;
    this.sCore.step(dt, { boil, pour: st.injecting ? 0.5 : 0, pourAt: 0.42 });
    this.sSg.step(dt, { boil: (st.s.feed || st.s.aux) ? 0.5 : 0.04 });
    this.sPool.step(dt, { boil: (st.s.prhr || 0) > 0 ? 0.45 : 0.02 });
    this.sTank.step(dt, { boil: 0.02 });

    // plumes
    const sh = G.shell;
    if (!p.ctmtIntact) {
      const b = P3(sh.x, sh.y, 0), tp = P3(sh.x, sh.y, sh.h);
      const bx = b.x + sh.r * ERX * Math.cos(BREACH_A);
      const by = b.y + sh.r * ERY * Math.sin(BREACH_A) - (b.y - tp.y) * 0.52;
      this.puffBreach.step(dt, 16, bx, by,
        { spread: 26, vy: 42, vx: 26, r: 12, grow: 20, life: 2.6, buoy: -28 });
    } else this.puffBreach.step(dt, 0, 0, 0);
    const top = P3(G.stack.x, G.stack.y, G.stack.h);
    this.puffVent.step(dt, st.s.vent ? 14 : 0, top.x, top.y,
      { spread: 8, vy: 58, vx: 10, r: 6, grow: 15, life: 2.0 });
    const cd = P3((G.cond.x0 + G.cond.x1) / 2, (G.cond.y0 + G.cond.y1) / 2, G.cond.z + G.cond.h);
    this.puffCond.step(dt, this.turbine.speed > 2 ? 12 : 0, cd.x, cd.y,
      { spread: 26, vy: -6, vx: 22, r: 7, grow: 12, life: 0.9, buoy: 26 });
    const strength = st.sink === 'shell' ? 1 : clamp(st.s.pccs || 0, 0, 1);
    const ac = P3(sh.x, sh.y, sh.h * 0.25);
    this.puffAir.step(dt, strength > 0.06 ? 9 : 0, ac.x - sh.r * ERX * 1.06, ac.y,
      { spread: 14, vy: 52, vx: 4, r: 5, grow: 9, life: 2.4 });
  }
}

// ---- the water body inside a vessel, built exactly rather than clipped -----
function waterBody(g, o, zw, surf, col, alpha) {
  const prof = vesselProfile(o);
  const tw = clamp((zw - o.z) / o.h, 0, 1);
  const rw = vesselRadiusAt(o, zw);
  const c = P3(o.x, o.y, zw);
  const rx = rw * ERX, ry = rw * ERY;
  const wob = (u) => (surf ? surf.sample(u) : 0);

  const left = prof.filter((s) => s.t <= tw);
  if (!left.length) return null;
  g.moveTo(prof[0].x - prof[0].rx, prof[0].y);
  for (const s of left) g.lineTo(s.x - s.rx, s.y);
  // far half of the surface, left to right over the top
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI + (i / 16) * Math.PI;      // pi -> 2pi, the far half
    const u = (Math.cos(a) + 1) / 2;
    g.lineTo(c.x + rx * Math.cos(a), c.y + ry * Math.sin(a) + wob(u));
  }
  for (let i = left.length - 1; i >= 0; i--) g.lineTo(left[i].x + left[i].rx, left[i].y);
  const bp = prof[0];
  const arc = ellipsePts(bp.x, bp.y, bp.rx, bp.ry, 0, Math.PI, 10);
  for (let i = 0; i < arc.length; i += 2) g.lineTo(arc[i], arc[i + 1]);
  g.closePath();
  const grad = new PIXI.FillGradient({
    type: 'linear', start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 },
    colorStops: [
      { offset: 0, color: shade(col, 1.16) },
      { offset: 0.3, color: col },
      { offset: 1, color: shade(col, 0.48) }]
  });
  g.fill({ fill: grad, alpha });

  // the surface itself
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * TAU;
    const u = (Math.cos(a) + 1) / 2;
    pts.push({ x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) + wob(u) });
  }
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  const sg = new PIXI.FillGradient({
    type: 'linear', start: { x: 0.2, y: 0 }, end: { x: 0.9, y: 1 },
    colorStops: [
      { offset: 0, color: shade(col, 1.2) },
      { offset: 0.55, color: shade(col, 1.0) },
      { offset: 1, color: shade(col, 0.86) }]
  });
  g.fill({ fill: sg, alpha: Math.min(1, alpha + 0.25) });
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.stroke({ width: 1.3, color: shade(col, 1.55), alpha: 0.55 });
  return { x: c.x, y: c.y, rx, ry, zw };
}

// A basin you look down into: the opening is a window, the water a slab in it.
function basin(g, b, frac, col, surf, tone) {
  const w = 0.34, zt = b.z + b.h, zb = b.z;
  const O = (x, y, z) => P3(x, y, z);
  const i0 = b.x0 + w, j0 = b.y0 + w, i1 = b.x1 - w, j1 = b.y1 - w;
  const A = O(b.x0, b.y0, zt), B = O(b.x1, b.y0, zt), Cc = O(b.x1, b.y1, zt), D = O(b.x0, b.y1, zt);
  const Bb = O(b.x1, b.y0, zb), Cb = O(b.x1, b.y1, zb), Db = O(b.x0, b.y1, zb);
  g.moveTo(B.x, B.y).lineTo(Cc.x, Cc.y).lineTo(Cb.x, Cb.y).lineTo(Bb.x, Bb.y).closePath()
    .fill({ color: shade(tone, 0.88) });
  g.moveTo(D.x, D.y).lineTo(Cc.x, Cc.y).lineTo(Cb.x, Cb.y).lineTo(Db.x, Db.y).closePath()
    .fill({ color: shade(tone, 0.7) });
  const a = O(i0, j0, zt), bq = O(i1, j0, zt), c = O(i1, j1, zt), d = O(i0, j1, zt);
  const fa = O(i0, j0, zb), fb = O(i1, j0, zb), fd = O(i0, j1, zb), fc = O(i1, j1, zb);
  g.moveTo(fa.x, fa.y).lineTo(fb.x, fb.y).lineTo(fc.x, fc.y).lineTo(fd.x, fd.y).closePath()
    .fill({ color: shade(tone, 0.36) });
  g.moveTo(a.x, a.y).lineTo(bq.x, bq.y).lineTo(fb.x, fb.y).lineTo(fa.x, fa.y).closePath()
    .fill({ color: shade(tone, 0.52) });
  g.moveTo(a.x, a.y).lineTo(d.x, d.y).lineTo(fd.x, fd.y).lineTo(fa.x, fa.y).closePath()
    .fill({ color: shade(tone, 0.46) });
  const f = clamp(frac, 0, 1);
  let surface = null;
  if (f > 0.006) {
    const zw = zb + (zt - zb) * f;
    const wa = O(i0, j0, zw), wb = O(i1, j0, zw), wc = O(i1, j1, zw), wd = O(i0, j1, zw);
    const s = (u) => (surf ? surf.sample(u) : 0);
    g.moveTo(wa.x, wa.y + s(0)).lineTo(wb.x, wb.y + s(0.5)).lineTo(wc.x, wc.y + s(1))
      .lineTo(fc.x, fc.y).lineTo(fd.x, fd.y).lineTo(fa.x, fa.y).closePath()
      .fill({ color: shade(col, 0.68), alpha: 0.85 });
    g.moveTo(wa.x, wa.y + s(0)).lineTo(wb.x, wb.y + s(0.4))
      .lineTo(wc.x, wc.y + s(1)).lineTo(wd.x, wd.y + s(0.6)).closePath();
    const gr = new PIXI.FillGradient({
      type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 },
      colorStops: [
        { offset: 0, color: shade(col, 1.3) },
        { offset: 0.5, color: shade(col, 1.05) },
        { offset: 1, color: shade(col, 1.36) }]
    });
    g.fill(gr);
    surface = { a: wa, b: wb, c: wc, d: wd, zw };
  }
  const rim = [[A, B, bq, a], [B, Cc, c, bq], [Cc, D, d, c], [D, A, a, d]];
  for (const q of rim) {
    g.moveTo(q[0].x, q[0].y).lineTo(q[1].x, q[1].y).lineTo(q[2].x, q[2].y).lineTo(q[3].x, q[3].y)
      .closePath().fill({ color: shade(tone, 1.1) });
  }
  g.moveTo(A.x, A.y).lineTo(B.x, B.y).lineTo(Cc.x, Cc.y).lineTo(D.x, D.y).closePath()
    .stroke({ width: 1, color: 0x0e151c, alpha: 0.45 });
  return surface;
}

// ---------------------------------------------------------------------------
Object.assign(PlantNode.prototype, {

  drawShell(st) {
    const g = this.gShell, p = this.p, s = G.shell;
    g.clear();
    const c = P3(s.x, s.y, 0), tp = P3(s.x, s.y, s.h);
    const rx = s.r * ERX, ry = s.r * ERY;
    g.ellipse(c.x, c.y, rx + 30, ry + 15).fill({ color: 0x1d252d });
    g.ellipse(c.x, c.y, rx, ry).fill(new PIXI.FillGradient({
      type: 'radial', center: { x: 0.5, y: 0.36 }, innerRadius: 0.02,
      outerCenter: { x: 0.5, y: 0.5 }, outerRadius: 0.55,
      colorStops: [{ offset: 0, color: 0x55636f }, { offset: 1, color: 0x323d47 }]
    }));
    g.ellipse(c.x, c.y, rx, ry).stroke({ width: 1.4, color: 0x0d1319, alpha: 0.6 });
    for (let i = 1; i < 4; i++) {
      g.ellipse(c.x, c.y, rx * i / 4, ry * i / 4).stroke({ width: 1, color: 0x141c23, alpha: 0.22 });
    }
    // the far wall, seen from the inside
    const broken = !p.ctmtIntact;
    const base = broken ? 0x7b564e : 0x68788a;
    const wall = [];
    for (let i = 0; i <= 40; i++) {
      const a = CUT1 + (CUT0 + TAU - CUT1) * (i / 40);
      wall.push({ x: tp.x + rx * Math.cos(a), y: tp.y + ry * Math.sin(a) });
    }
    g.moveTo(wall[0].x, wall[0].y);
    for (const q of wall) g.lineTo(q.x, q.y);
    for (let i = wall.length - 1; i >= 0; i--) {
      const a = CUT1 + (CUT0 + TAU - CUT1) * (i / 40);
      g.lineTo(c.x + rx * Math.cos(a), c.y + ry * Math.sin(a));
    }
    g.closePath();
    g.fill(new PIXI.FillGradient({
      type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 },
      colorStops: [
        { offset: 0, color: shade(base, 0.4) }, { offset: 0.3, color: shade(base, 0.82) },
        { offset: 0.5, color: shade(base, 0.98) }, { offset: 0.72, color: shade(base, 0.8) },
        { offset: 1, color: shade(base, 0.44) }]
    }));
    // the wall's own thickness at the top, and the two cut ends
    const kr = 1.05;
    g.moveTo(wall[0].x, wall[0].y);
    for (const q of wall) g.lineTo(q.x, q.y);
    for (let i = 40; i >= 0; i--) {
      const a = CUT1 + (CUT0 + TAU - CUT1) * (i / 40);
      g.lineTo(tp.x + rx * kr * Math.cos(a), tp.y + ry * kr * Math.sin(a));
    }
    g.closePath().fill({ color: shade(base, 1.14) });
    for (const a of [CUT0, CUT1]) {
      const ca = Math.cos(a), sa = Math.sin(a);
      g.moveTo(c.x + rx * ca, c.y + ry * sa)
        .lineTo(c.x + rx * kr * ca, c.y + ry * kr * sa)
        .lineTo(tp.x + rx * kr * ca, tp.y + ry * kr * sa)
        .lineTo(tp.x + rx * ca, tp.y + ry * sa).closePath()
        .fill({ color: broken ? 0x8d5f52 : 0x9fb0bd })
        .stroke({ width: 1, color: 0x0d1319, alpha: 0.55 });
    }
    if (broken) this.drawDamage(g);
    // water standing on the containment floor
    const floorFrac = clamp((p.ctmtSump || 0) / 2.1e6, 0, 1);
    if (floorFrac > 0.004) {
      const zw = floorFrac * 2.4;
      const w = P3(s.x, s.y, zw);
      const col = waterColor(Math.min(p.Tctmt || 330, 430));
      g.ellipse(w.x, w.y, rx * 0.985, ry * 0.985).fill({ color: col, alpha: 0.86 })
        .stroke({ width: 1.2, color: shade(col, 1.5), alpha: 0.45 });
    }
  },

  drawDamage(g) {
    const s = G.shell, p = this.p;
    const b = P3(s.x, s.y, 0), tp = P3(s.x, s.y, s.h);
    const rx = s.r * ERX * 1.04, ry = s.r * ERY * 1.04, H = b.y - tp.y;
    const spread = 0.15 + Math.min(3, p.explosions || 0) * 0.035;
    const n = 15, zc = 0.52, zh = 0.30;
    const pt = (u, upper) => {
      const a = BREACH_A - spread + u * spread * 2;
      const half = Math.sqrt(Math.max(0, 1 - Math.pow(2 * u - 1, 2)));
      const rough = (hash1((upper ? 31 : 57) + Math.round(u * n) * 7) - 0.5) * 0.09;
      const zz = clamp(zc + (upper ? 1 : -1) * (zh * half + rough * half), 0.03, 0.97);
      return { x: b.x + rx * Math.cos(a), y: b.y + ry * Math.sin(a) - H * zz };
    };
    const path = [];
    for (let i = 0; i <= n; i++) path.push(pt(i / n, true));
    for (let i = n; i >= 0; i--) path.push(pt(i / n, false));
    g.moveTo(path[0].x, path[0].y);
    for (const q of path) g.lineTo(q.x, q.y);
    g.closePath().fill({ color: 0x070c11 })
      .stroke({ width: 6, color: 0xff965c, alpha: 0.22 });
    g.moveTo(path[0].x, path[0].y);
    for (const q of path) g.lineTo(q.x, q.y);
    g.closePath().stroke({ width: 1.8, color: 0xc98259 });
    for (let k = 0; k < 7; k++) {
      const a0 = BREACH_A + (hash1(k * 11) - 0.5) * 1.7;
      const z0 = 0.2 + 0.6 * hash1(k * 13);
      const seg = [];
      for (let i = 0; i <= 5; i++) {
        const a = a0 + (i / 5) * (hash1(k * 17) - 0.5) * 0.7;
        const zz = z0 + (i / 5) * (hash1(k * 19) - 0.5) * 0.6;
        seg.push({ x: b.x + s.r * ERX * Math.cos(a),
          y: b.y + s.r * ERY * Math.sin(a) - H * clamp(zz, 0.02, 0.98) });
      }
      strokePoly(g, seg, { width: 1.6, color: 0x140c0a, alpha: 0.65 });
    }
    for (let i = 0; i < 12; i++) {
      const a = BREACH_A + (hash1(i * 7) - 0.5) * 0.7;
      const rr = s.r * (0.98 + hash1(i * 5) * 0.16);
      const q = P3(s.x + rr * Math.cos(a - Math.PI / 4), s.y + rr * Math.sin(a - Math.PI / 4), 0);
      g.ellipse(q.x, q.y, 3 + hash1(i * 3) * 5, (3 + hash1(i * 3) * 5) * 0.55)
        .fill({ color: 0x2e2622, alpha: 0.9 });
    }
  }
});

Object.assign(PlantNode.prototype, {

  drawVessels(st, t) {
    const g = this.gMach, p = this.p;
    g.clear();
    const c = G.core, s = G.sg;
    const cObj = { x: c.x, y: c.y, z: c.z, h: c.h, r: c.r };
    const sObj = { x: s.x, y: s.y, z: s.z, h: s.h, r: s.r };

    // ---- reactor ----
    cylinder(g, { x: c.x, y: c.y, z: 0, r: c.r * 0.78, h: c.z + 0.5, color: 0x4b5866 });
    vesselPath(g, cObj);
    g.fill(new PIXI.FillGradient({
      type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 },
      colorStops: [{ offset: 0, color: 0x28374a }, { offset: 0.42, color: 0x121a24 },
        { offset: 1, color: 0x2d3d50 }]
    }));
    this.drawFuel(g, st);
    const wcol = waterColor(p.Tclad);
    this.coreSurf = waterBody(g, cObj, waterZ(st.lvl), this.sCore, wcol, 0.62);

    // ---- boiler ----
    cylinder(g, { x: s.x, y: s.y, z: 0, r: s.r * 0.8, h: s.z + 0.5, color: 0x4b5866 });
    vesselPath(g, sObj);
    g.fill(new PIXI.FillGradient({
      type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 },
      colorStops: [{ offset: 0, color: 0x28374a }, { offset: 0.42, color: 0x121a24 },
        { offset: 1, color: 0x2d3d50 }]
    }));
    // the tube bundle: reactor water goes down these and never mixes with what
    // is outside them
    const hot = st.carried && (st.s.feed || st.s.aux || st.s.rcic);
    for (const dx of [-0.62, -0.31, 0, 0.31, 0.62]) {
      const a = P3(s.x + dx, s.y, SG_OUT_Z), b = P3(s.x + dx, s.y, SG_IN_Z);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y)
        .stroke({ width: 7, color: 0x1a2530, alpha: 0.8, cap: 'round' });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y)
        .stroke({ width: 5, color: 0x9eb2c0, alpha: 0.9, cap: 'round' });
    }
    const sf = hot ? 0.62 : 0.42;
    this.sgSurf = waterBody(g, sObj, s.z + s.h * sf, this.sSg,
      heatedWater(hot ? 0.2 : 0.02), 0.6);

    // ---- the pool, or the basement tank ----
    if (this.passive) {
      const b = G.pool;
      for (const [lx, ly] of [[b.x0 + 0.4, b.y0 + 0.4], [b.x1 - 0.4, b.y0 + 0.4],
        [b.x0 + 0.4, b.y1 - 0.4], [b.x1 - 0.4, b.y1 - 0.4]]) {
        const a0 = P3(lx, ly, 0), a1 = P3(lx, ly, b.z);
        g.moveTo(a0.x, a0.y).lineTo(a1.x, a1.y)
          .stroke({ width: 11, color: 0x0a1016, alpha: 0.55, cap: 'round' });
        g.moveTo(a0.x, a0.y).lineTo(a1.x, a1.y)
          .stroke({ width: 7.5, color: 0x5f6e7c, cap: 'round' });
      }
      const warm = (st.s.prhr || 0) > 0;
      this.poolSurf = basin(g, b, 0.08 + 0.86 * clamp(p.irwst / 2.1e6, 0, 1),
        heatedWater(warm ? 0.4 : 0.05), this.sPool,
        p.irwstCracked ? 0x7a6357 : 0x5f6f7c);
    }
  },

  drawFuel(g, st) {
    const p = this.p, c = G.core;
    const heat = clamp((p.Tclad - 620) / 620, 0, 1);
    const dam = clamp(p.coreDamage, 0, 1);
    const col = mix(0x6d7b86, tempColor(p.Tclad), heat);
    const top = FUEL_Z1 - dam * (FUEL_Z1 - FUEL_Z0) * 0.55;
    const k = c.r * 0.66 / 1.55;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const dx = i * 0.66 * k, dy = j * 0.66 * k;
        if (Math.hypot(i * 0.66, j * 0.66) > 1.55) continue;
        const id = (i + 2) * 5 + j + 2;
        const slump = dam * (0.35 + 0.5 * hash1(id * 3 + 1));
        const a = P3(c.x + dx, c.y + dy, FUEL_Z0);
        const b = P3(c.x + dx, c.y + dy, top - slump * (top - FUEL_Z0));
        g.moveTo(a.x, a.y).lineTo(b.x, b.y)
          .stroke({ width: 8.6, color: 0x060a0e, alpha: 0.75, cap: 'round' });
        g.moveTo(a.x, a.y).lineTo(b.x, b.y)
          .stroke({ width: 6.4, color: shade(col, 0.86 + 0.3 * hash1(id * 5)), cap: 'round' });
        g.moveTo(a.x, a.y).lineTo(b.x, b.y)
          .stroke({ width: 2.2, color: shade(col, 1.5), cap: 'round' });
      }
    }
    for (const f of [0.22, 0.55, 0.86]) {
      const zz = FUEL_Z0 + (FUEL_Z1 - FUEL_Z0) * f;
      if (zz > top) continue;
      const q = P3(c.x, c.y, zz);
      g.ellipse(q.x, q.y, 1.62 * k * ERX, 1.62 * k * ERY)
        .stroke({ width: 2, color: 0xbecdd8, alpha: 0.3 });
    }
    if (dam > 0.35) {
      const q = P3(c.x, c.y, c.z + 0.45);
      const rr = c.r * (0.5 + dam * 0.42);
      g.ellipse(q.x, q.y, rr * ERX, rr * ERY)
        .fill({ color: tempColor(Math.max(p.Tclad, 2100)) });
      g.ellipse(q.x, q.y, rr * ERX * 0.6, rr * ERY * 0.6).fill({ color: 0x5d1608 });
    }
  }
});

Object.assign(PlantNode.prototype, {

  // Everything on the near side: the pump, the steam plant, the water store.
  drawFront(st, t) {
    const g = this.gFront, p = this.p;
    g.clear();
    this.drawPump(g, st);
    this.drawSteamPlant(g, st);
    if (!this.passive) {
      const b = G.base;
      const m = 1.1;
      const c0 = P3(b.x0 - m, b.y0 - m, 0.05), c1 = P3(b.x1 + m, b.y0 - m, 0.05),
        c2 = P3(b.x1 + m, b.y1 + m, 0.05), c3 = P3(b.x0 - m, b.y1 + m, 0.05);
      g.moveTo(c0.x, c0.y).lineTo(c1.x, c1.y).lineTo(c2.x, c2.y).lineTo(c3.x, c3.y)
        .closePath().fill({ color: 0x232c34 });
      basin(g, b, 0.86, heatedWater(0.03), this.sTank, 0x4e5a66);
      // the backup pump
      const e = G.eccs, live = st.injecting;
      cylinder(g, { x: e.x, y: e.y, z: 0, r: e.r, h: e.h * 0.6, color: 0x77848f });
      cylinder(g, { x: e.x, y: e.y, z: e.h * 0.6, r: e.r * 0.6, h: e.h * 0.8,
        color: live ? 0x8fa2ae : 0x666f77 });
      const top = P3(e.x, e.y, e.h * 1.4);
      g.circle(top.x, top.y, 3.2).fill({
        color: live ? C.ok : (st.live && p.pumpsOk) ? C.warn : C.bad });
      if (live) {
        for (let i = 0; i < 3; i++) {
          const a = this.eccsRotor.angle + (i / 3) * TAU;
          g.moveTo(top.x, top.y)
            .lineTo(top.x + Math.cos(a) * 11, top.y + Math.sin(a) * 6)
            .stroke({ width: 2, color: 0xd8ecf6, alpha: 0.85, cap: 'round' });
        }
      }
    }
    // the vent stack
    const s = G.stack;
    cylinder(g, { x: s.x, y: s.y, z: 0, r: s.r * 1.9, h: 1.2, color: 0x4e5a66 });
    cylinder(g, { x: s.x, y: s.y, z: 1.2, r: s.r, h: s.h - 1.2,
      color: st.s.vent ? 0x8b96a0 : 0x6d767e, cap: false });
    const stop = P3(s.x, s.y, s.h);
    g.ellipse(stop.x, stop.y, s.r * ERX, s.r * ERY).fill({ color: 0x171f27 })
      .stroke({ width: 1.2, color: 0xb4c4d2, alpha: 0.6 });
  },

  // The pump, cut open from above. Both the speed and the direction of the
  // impeller come out of the flow through it, so they cannot disagree with it.
  drawPump(g, st) {
    const pu = G.pump, pump = this.net.pump, p = this.p;
    const flowing = Math.abs(this.net.edges.eColdB.v) > 0.02;
    const driven = (st.s.rcp || 0) > 0.01;
    const casZ = pu.z, casH = 1.5, topZ = casZ + casH;
    cylinder(g, { x: pu.x, y: pu.y, z: 0, r: pu.r * 0.62, h: casZ, color: 0x48545f });
    cylinder(g, { x: pu.x, y: pu.y, z: casZ, r: pu.r, h: casH, color: 0x7c8b98, cap: false });
    const c = P3(pu.x, pu.y, topZ);
    const RX = pu.r * ERX, RY = pu.r * ERY;
    g.ellipse(c.x, c.y, RX, RY).fill({ color: shade(0x7c8b98, 1.12) })
      .stroke({ width: 1.2, color: 0x0c1218, alpha: 0.6 });
    const iR = 0.84;
    const wcol = waterColor(p.Tclad);
    g.ellipse(c.x, c.y, RX * iR, RY * iR).fill({ color: 0x0f1720 });
    g.ellipse(c.x, c.y, RX * iR, RY * iR).fill({ color: wcol, alpha: 0.92 });
    // the volute: water is thrown from the suction port round to the discharge
    for (let i = 0; i < 7; i++) {
      const a0 = pump.angle * 0.8 + (i / 7) * TAU;
      const seg = [];
      for (let k = 0; k <= 8; k++) {
        const u = k / 8;
        const a = a0 + pump.sign * u * 0.9, rr = iR * (0.42 + u * 0.56);
        seg.push({ x: c.x + Math.cos(a) * RX * rr, y: c.y + Math.sin(a) * RY * rr });
      }
      strokePoly(g, seg, {
        width: 1.7, color: 0xf0fcff, alpha: flowing ? (driven ? 0.55 : 0.2) : 0.07, cap: 'round' });
    }
    for (let i = 0; i < 6; i++) {
      const a0 = pump.angle + (i / 6) * TAU;
      const seg = [];
      for (let k = 0; k <= 10; k++) {
        const u = k / 10;
        const a = a0 - pump.sign * u * 1.05, rr = 0.2 + u * 0.62;
        seg.push({ x: c.x + Math.cos(a) * RX * rr, y: c.y + Math.sin(a) * RY * rr });
      }
      strokePoly(g, seg, { width: 5.2, color: 0x0e1620, alpha: 0.8, cap: 'round' });
      strokePoly(g, seg, { width: 3.4, color: driven ? 0xc3d4de : 0x8593a0, cap: 'round' });
    }
    g.ellipse(c.x, c.y, RX * 0.2, RY * 0.2)
      .fill({ color: shade(0x9aa9b5, driven ? 1.15 : 0.9) })
      .stroke({ width: 1, color: 0x0c1218, alpha: 0.6 });
    // an arrow on the casing rim pointing the way the water actually leaves
    const outA = pump.outAngle;
    const ax = c.x + Math.cos(outA) * RX * 1.02, ay = c.y + Math.sin(outA) * RY * 1.02;
    const dx = Math.cos(outA), dy = Math.sin(outA) * (RY / RX);
    const m = Math.hypot(dx, dy) || 1;
    g.moveTo(ax + (-dy / m) * 4 - dx * 3, ay + (dx / m) * 4 - dy * 3)
      .lineTo(ax + dx * 7, ay + dy * 7)
      .lineTo(ax + (dy / m) * 4 - dx * 3, ay + (-dx / m) * 4 - dy * 3)
      .closePath().fill({ color: flowing ? C.ok : 0x4a545c });
    // the motor, on a stand, drawn as glass so the impeller stays visible
    const mz = topZ + 0.9, mh = 1.9;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      const q0 = P3(pu.x + Math.cos(a) * pu.r * 0.8, pu.y + Math.sin(a) * pu.r * 0.8, topZ);
      const q1 = P3(pu.x + Math.cos(a) * pu.r * 0.8, pu.y + Math.sin(a) * pu.r * 0.8, mz);
      g.moveTo(q0.x, q0.y).lineTo(q1.x, q1.y)
        .stroke({ width: 2.4, color: 0x96a6b2, alpha: 0.9 });
    }
    const s0 = P3(pu.x, pu.y, topZ), s1 = P3(pu.x, pu.y, mz + mh);
    g.moveTo(s0.x, s0.y).lineTo(s1.x, s1.y)
      .stroke({ width: 3, color: driven ? 0xdce9f2 : 0x6b757d });
    cylinder(g, { x: pu.x, y: pu.y, z: mz, r: pu.r * 0.58, h: mh,
      color: driven ? 0x8fa2ae : 0x69737b });
    const lamp = P3(pu.x, pu.y, mz + mh + 0.12);
    g.ellipse(lamp.x, lamp.y, 3.4, 2.2)
      .fill({ color: driven ? C.ok : flowing ? C.warn : C.bad });
  },

  // One turbine on one shaft turning one generator. Nothing else.
  drawSteamPlant(g, st) {
    const d = G.deck, tb = G.turb, gn = G.gen, cd = G.cond, xf = G.xfmr;
    const spinning = this.turbine.speed > 1.5;
    box(g, { x: d.x0, y: d.y0, z: d.z, w: d.x1 - d.x0, d: d.y1 - d.y0, h: d.h,
      color: 0x4d5a65, top: 0x5b6874 });
    box(g, { x: cd.x0, y: cd.y0, z: cd.z, w: cd.x1 - cd.x0, d: cd.y1 - cd.y0, h: cd.h,
      color: spinning ? 0x2c6472 : 0x3c4b52, top: spinning ? 0x37798a : 0x44545c });
    // the shaft
    const a = P3(tb.x - tb.len, SHAFT_Y, SHAFT_Z), b = P3(gn.x1 + 0.4, SHAFT_Y, SHAFT_Z);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y)
      .stroke({ width: 7, color: 0x0c1218, alpha: 0.55, cap: 'round' });
    g.moveTo(a.x, a.y).lineTo(b.x, b.y)
      .stroke({ width: 4.5, color: spinning ? 0xc9d9e4 : 0x7c868e, cap: 'round' });
    // the casing, and the wheel showing on the end of it
    box(g, { x: tb.x - 0.9, y: SHAFT_Y - 1.5, z: SHAFT_Z - 1.35, w: 1.8, d: 3.0, h: 2.7,
      color: spinning ? 0x8b97a2 : 0x727d86, top: spinning ? 0x9aa6b1 : 0x7e8992 });
    rotorDisc(g, tb.x + 0.92, SHAFT_Y, SHAFT_Z, 1.22, 11, this.turbine.angle,
      { rim: 0x9fb2c0, blade: spinning ? 0xdce9f2 : 0x8a959d, hub: 0xa7b6c2,
        w: 3.2, alpha: spinning ? 0.95 : 0.6 });
    box(g, { x: gn.x0, y: gn.y0, z: gn.z, w: gn.x1 - gn.x0, d: gn.y1 - gn.y0, h: gn.h,
      color: spinning ? 0x5f7183 : 0x535c65, top: spinning ? 0x6f8194 : 0x5e6771 });
    for (let i = 1; i < 5; i++) {
      const bx = gn.x0 + (gn.x1 - gn.x0) * (i / 5);
      const q0 = P3(bx, gn.y1, gn.z), q1 = P3(bx, gn.y1, gn.z + gn.h);
      g.moveTo(q0.x, q0.y).lineTo(q1.x, q1.y).stroke({ width: 1, color: 0x121a22, alpha: 0.35 });
    }
    // the rotor end, so you can see the generator turning with the turbine
    rotorDisc(g, gn.x1 + 0.12, SHAFT_Y, SHAFT_Z, 0.6, 8, this.genRotor.angle,
      { rim: 0xb08a4a, blade: spinning ? 0xf0c169 : 0x7a6a4c, hub: 0xc9a05a, w: 2.6 });
    box(g, { x: xf.x0, y: xf.y0, z: xf.z, w: xf.x1 - xf.x0, d: xf.y1 - xf.y0, h: xf.h,
      color: 0x5d6a74, top: 0x6b7883 });
    // the pylon that takes it away
    const py = P3(xf.x1 + 1.0, (xf.y0 + xf.y1) / 2, 0);
    const pt = P3(xf.x1 + 1.0, (xf.y0 + xf.y1) / 2, 4.4);
    g.moveTo(py.x, py.y).lineTo(pt.x, pt.y)
      .stroke({ width: 2.6, color: st.live ? 0x8d9aa4 : 0x5a636b });
    g.moveTo(pt.x - 14, pt.y + 6).lineTo(pt.x + 14, pt.y + 6)
      .stroke({ width: 2, color: st.live ? 0x8d9aa4 : 0x5a636b });
    g.moveTo(pt.x - 10, pt.y + 15).lineTo(pt.x + 10, pt.y + 15)
      .stroke({ width: 2, color: st.live ? 0x8d9aa4 : 0x5a636b });
    // the bus from the generator to the transformer
    this.busPts = [P3(gn.x1, SHAFT_Y, gn.z + gn.h * 0.8),
      P3(gn.x1 + 0.8, SHAFT_Y, gn.z + gn.h + 0.5),
      P3(xf.x0 + 0.3, (xf.y0 + xf.y1) / 2, xf.z + xf.h + 0.3)];
    strokePoly(g, this.busPts, { width: 5, color: 0x0c1218, alpha: 0.5, cap: 'round' });
    strokePoly(g, this.busPts, { width: 3, color: spinning ? 0x6c6242 : 0x4c545a, cap: 'round' });
  }
});

function edgeColor(e, p, st) {
  if (e.kind === 'steam') return 0xe6f2fa;
  switch (e.name) {
    case 'feedwater': case 'boiling': return heatedWater(0.06);
    case 'cold leg': return heatedWater((p.Tclad - 700) / 400);
    case 'back from the pool': return heatedWater(0.08);
    case 'coil': return heatedWater(0.5);
    case 'to the pool': return waterColor(p.Tclad);
    case 'gravity': case 'suction': case 'injection': return heatedWater(0.04);
    default: return waterColor(p.Tclad);
  }
}

Object.assign(PlantNode.prototype, {

  drawPipes(st) {
    const p = this.p;
    const { back, front, vessel } = this.groups();
    for (const e of back) e.layer = 'back';
    for (const e of front) e.layer = 'front';
    for (const e of vessel) e.layer = 'vessel';

    const gb = this.gBack;
    gb.clear(); this.gPipeF.clear();
    this.maskBack.clear(); this.maskFront.clear();

    const drawSet = (g, list) => {
      for (const e of list) {
        const w = PIPE_W[e.kind] || PIPE_W.water;
        pipeCasing(g, e, w);
      }
      for (const e of list) {
        if (e.hidden) continue;
        const w = PIPE_W[e.kind] || PIPE_W.water;
        const col = edgeColor(e, p, st);
        const moving = Math.abs(e.v) > 0.02;
        pipeLiquid(g, e, w, col, e.kind === 'steam' ? (moving ? 0.5 : 0.12) : 0.95);
        pipeCrown(g, e, w, col);
      }
    };
    drawSet(gb, back);
    drawSet(this.gPipeF, front);

    for (const e of back) pipeBoreMask(this.maskBack, e, PIPE_W[e.kind] || PIPE_W.water);
    for (const e of front) pipeBoreMask(this.maskFront, e, PIPE_W[e.kind] || PIPE_W.water);
    // the vessels are part of the same mask: what flows inside them is only
    // ever visible through their own silhouette
    vesselPath(this.maskFront, { x: G.core.x, y: G.core.y, z: G.core.z, h: G.core.h, r: G.core.r });
    this.maskFront.fill({ color: 0xffffff });
    vesselPath(this.maskFront, { x: G.sg.x, y: G.sg.y, z: G.sg.z, h: G.sg.h, r: G.sg.r });
    this.maskFront.fill({ color: 0xffffff });
  },

  drawDrops(st) {
    const p = this.p;
    this.poolBack.begin(); this.poolFront.begin();
    this.poolVessel.begin(); this.poolSteam.begin();
    for (const c of this.net.all) {
      if (!c.parts || !c.mdot) continue;
      for (const q of c.positions()) {
        const e = q.e;
        const bore = (PIPE_W[e.kind] || PIPE_W.water) * 0.58;
        const dir = e.dir(q.ed);
        const rot = Math.atan2(dir.y, dir.x);
        const stretch = clamp(Math.abs(q.v) * 0.05, 0, 20);
        const pool = e.kind === 'steam' ? this.poolSteam
          : e.layer === 'vessel' ? this.poolVessel
            : e.layer === 'back' ? this.poolBack : this.poolFront;
        const col = edgeColor(e, p, st);
        if (e.kind === 'steam') {
          pool.put(q.x, q.y, (bore * 1.9 + stretch) / 40, bore * 1.5 / 40, rot, 0xdff0ff, 0.85);
        } else {
          pool.put(q.x, q.y, (bore + stretch) / 50, bore / 50, rot, shade(col, 1.42), 0.98);
        }
      }
    }
    this.poolBack.end(); this.poolFront.end();
    this.poolVessel.end(); this.poolSteam.end();
  },

  drawFore(st, t) {
    const g = this.gFore, p = this.p, s = G.shell;
    g.clear();
    for (const o of [{ x: G.core.x, y: G.core.y, z: G.core.z, h: G.core.h, r: G.core.r,
      tint: p.vesselBreach ? 0xb4746a : C.steel },
    { x: G.sg.x, y: G.sg.y, z: G.sg.z, h: G.sg.h, r: G.sg.r, tint: C.steel }]) {
      const pts = vesselPath(g, o);
      g.fill({
        fill: new PIXI.FillGradient({
          type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 },
          colorStops: [
            { offset: 0, color: shade(o.tint, 1.15) }, { offset: 0.22, color: o.tint },
            { offset: 0.46, color: 0xffffff }, { offset: 0.74, color: o.tint },
            { offset: 1, color: shade(o.tint, 1.15) }]
        }),
        alpha: 0.22
      });
      // glass is only a hint of a surface; the alpha is carried on the fill
      const left = pts.map((q) => ({ x: q.x - q.rx, y: q.y }));
      strokePoly(g, left, { width: 1.6, color: 0xe8f4fc, alpha: 0.5 });
      const right = pts.map((q) => ({ x: q.x + q.rx, y: q.y }));
      strokePoly(g, right, { width: 1.4, color: 0x8caac3, alpha: 0.45 });
      this.vesselHead(g, o);
    }
    this.drawDome(g, st);
    this.drawRail(g);
  },

  vesselHead(g, o) {
    const pts = vesselProfile(o).filter((q) => q.t >= HEAD_T - 1e-6);
    const bp = pts[0], tp = pts[pts.length - 1];
    g.moveTo(bp.x - bp.rx, bp.y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x - pts[i].rx, pts[i].y);
    const arc = ellipsePts(tp.x, tp.y, tp.rx, tp.ry, Math.PI, 0, 10);
    for (let i = 0; i < arc.length; i += 2) g.lineTo(arc[i], arc[i + 1]);
    for (let i = pts.length - 1; i >= 0; i--) g.lineTo(pts[i].x + pts[i].rx, pts[i].y);
    const arc2 = ellipsePts(bp.x, bp.y, bp.rx, bp.ry, Math.PI, 0, 10);
    for (let i = 0; i < arc2.length; i += 2) g.lineTo(arc2[i], arc2[i + 1]);
    g.closePath();
    g.fill(new PIXI.FillGradient({
      type: 'linear', start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 },
      colorStops: [
        { offset: 0, color: shade(o.tint || C.steel, 0.44) },
        { offset: 0.34, color: shade(o.tint || C.steel, 0.84) },
        { offset: 0.56, color: shade(o.tint || C.steel, 0.98) },
        { offset: 1, color: shade(o.tint || C.steel, 0.5) }]
    }));
    const rim = [];
    for (let i = 0; i <= 20; i++) {
      const a = Math.PI + (i / 20) * Math.PI;
      rim.push({ x: bp.x + bp.rx * Math.cos(a), y: bp.y + bp.ry * Math.sin(a) });
    }
    strokePoly(g, rim, { width: 2.2, color: shade(o.tint || C.steel, 1.35) });
  },

  drawDome(g, st) {
    const s = G.shell, p = this.p;
    const tp = P3(s.x, s.y, s.h);
    const rx = s.r * ERX, ry = s.r * ERY;
    const tint = !p.ctmtIntact ? 0xc07a68 : st.sink === 'shell' ? 0x7fc9d8 : 0x93a9b8;
    const mer = (theta) => {
      const a = gAngle(theta), ca = Math.cos(a), sa = Math.sin(a), out = [];
      for (let i = 0; i <= 14; i++) {
        const ph = (i / 14) * (Math.PI / 2);
        out.push(P3(s.x + s.r * Math.cos(ph) * ca, s.y + s.r * Math.cos(ph) * sa,
          s.h + s.domeH * Math.sin(ph)));
      }
      return out;
    };
    const path = [];
    for (let i = 0; i <= 40; i++) {
      const a = CUT1 + (CUT0 + TAU - CUT1) * (i / 40);
      path.push({ x: tp.x + rx * Math.cos(a), y: tp.y + ry * Math.sin(a) });
    }
    const m0 = mer(CUT0), m1 = mer(CUT1);
    g.moveTo(path[0].x, path[0].y);
    for (const q of path) g.lineTo(q.x, q.y);
    for (const q of m0) g.lineTo(q.x, q.y);
    for (let i = m1.length - 1; i >= 0; i--) g.lineTo(m1[i].x, m1[i].y);
    g.closePath();
    g.fill({ color: tint, alpha: 0.14 });
    for (let i = 1; i <= 5; i++) {
      const ph = (i / 6) * (Math.PI / 2);
      const rr = s.r * Math.cos(ph), q = P3(s.x, s.y, s.h + s.domeH * Math.sin(ph));
      g.ellipse(q.x, q.y, rr * ERX, rr * ERY).stroke({ width: 1, color: tint, alpha: 0.2 });
    }
    for (let i = 0; i <= 10; i++) {
      strokePoly(g, mer(CUT1 + (CUT0 + TAU - CUT1) * (i / 10)),
        { width: 1, color: tint, alpha: 0.2 });
    }
    g.moveTo(path[0].x, path[0].y);
    for (const q of path) g.lineTo(q.x, q.y);
    for (const q of m0) g.lineTo(q.x, q.y);
    for (let i = m1.length - 1; i >= 0; i--) g.lineTo(m1[i].x, m1[i].y);
    g.closePath().stroke({ width: 1.6, color: tint, alpha: 0.7 });
  },

  drawRail(g) {
    const s = G.shell, r = s.r * 0.985;
    const post = [];
    for (let i = 0; i <= 20; i++) {
      const a = gAngle(CUT0 + (CUT1 - CUT0) * (i / 20));
      post.push([s.x + r * Math.cos(a), s.y + r * Math.sin(a)]);
    }
    for (const h of [1.05, 0.6]) {
      const line = post.map(([x, y]) => P3(x, y, h));
      strokePoly(g, line, { width: 3.4, color: 0x0a1016, alpha: 0.5, cap: 'round' });
      strokePoly(g, line, { width: 2, color: h > 0.9 ? 0xa9bac6 : 0x7c8b98, cap: 'round' });
    }
    for (let i = 0; i < post.length; i += 2) {
      const a = P3(post[i][0], post[i][1], 0), b = P3(post[i][0], post[i][1], 1.05);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y)
        .stroke({ width: 3.4, color: 0x0a1016, alpha: 0.5 });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 2, color: 0x8b9aa6 });
    }
  },

  drawFx(st) {
    const fx = this.poolFx, gl = this.poolGlow;
    fx.begin(); gl.begin();
    const put = (src, tint, k) => {
      for (const q of src.live()) {
        fx.put(q.x, q.y, q.r / 26, q.r / 26, 0, tint, q.a * k);
      }
    };
    put(this.puffBreach, 0xd8ccc4, 0.55);
    put(this.puffVent, 0xd2dade, 0.5);
    put(this.puffCond, 0xbfe0ea, 0.4);
    put(this.puffAir, 0xb4e1f0, 0.35);
    // the generator's field, and the power leaving it
    if (this.turbine.speed > 0.6 && this.busPts) {
      const gn = G.gen;
      const q = P3((gn.x0 + gn.x1) / 2, SHAFT_Y, gn.z + gn.h);
      gl.put(q.x, q.y, 1.5, 1.1, 0, 0xffd66e, 0.26);
      const cum = [0];
      for (let i = 1; i < this.busPts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(this.busPts[i].x - this.busPts[i - 1].x,
          this.busPts[i].y - this.busPts[i - 1].y));
      }
      const total = cum[cum.length - 1];
      for (let i = 0; i < 4; i++) {
        const dd = ((this.genRotor.angle * 26 + i * total / 4) % total + total) % total;
        let k = 1;
        while (k < cum.length - 1 && cum[k] < dd) k++;
        const u = (dd - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
        gl.put(lerp(this.busPts[k - 1].x, this.busPts[k].x, u),
          lerp(this.busPts[k - 1].y, this.busPts[k].y, u), 0.16, 0.16, 0, 0xffe27a, 0.9);
      }
    }
    // heat coming off damaged fuel
    const heat = clamp((this.p.Tclad - 900) / 1400, 0, 1);
    if (heat > 0.03) {
      const q = P3(G.core.x, G.core.y, (FUEL_Z0 + FUEL_Z1) / 2);
      gl.put(q.x, q.y, 1.5, 1.7, 0, tempColor(this.p.Tclad), 0.34 * heat);
    }
    fx.end(); gl.end();
  }
});

// ---------------------------------------------------------------------------
// what the picture is saying, read straight off the model
// ---------------------------------------------------------------------------

export function circuitState(p) {
  const s = p.sys || {};
  const P = p.mode === MODE.PASSIVE;
  const sink = s.sink || 'none';
  const carried = sink !== 'none';
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  const lvl = clamp(p.level, 0, 1);
  const covered = lvl >= FUEL_TOP;
  const T = p.Tclad - 273;
  const live = !!(s.grid || s.diesel);
  const steamOnly = !P && !!s.rcic && !s.aux;
  const injecting = P ? !!(s.cmt || s.gravity || s.accum) : !!(s.aux || s.rcic);
  const poolLoop = P && sink === 'pool';
  const poolFrac = p.irwst / 2.1e6;
  const floorFrac = (p.ctmtSump || 0) / 2.1e6;
  const onFloor = P && p.irwst < 1.6e5 && floorFrac > 0.05;
  const cracked = P && p.irwstCracked;
  const lost = P && onFloor && !p.ctmtIntact;
  const lostWater = P && !p.ctmtIntact;
  const uncovered = !covered;
  const headline =
    p.vesselBreach || /DESTROYED/.test(p.state) ? 'MELTDOWN'
      : uncovered ? 'FUEL IS UNCOVERED'
        : p.coreDamage > 0.01 ? 'FUEL IS DAMAGED'
          : lvl < 0.97 ? 'LOSING WATER'
            : lostWater ? 'THE WATER IS ESCAPING'
              : (P && !p.prhrOk && sink === 'none') ? 'PASSIVE HEAT PATH BROKEN'
                : sink === 'none' ? 'HEAT IS NOT GETTING OUT'
                  : s.rcic ? 'ON THE LAST-RESORT PUMP'
                    : sink === 'pool' ? 'THE POOL IS TAKING THE HEAT'
                      : sink === 'shell' ? 'THE SHELL IS TAKING THE HEAT'
                        : (flow > 0 && !s.rcp) ? 'COOLING ITSELF, NO PUMP'
                          : !s.grid && !s.diesel ? 'RUNNING ON BATTERIES'
                            : P ? 'SAFE' : 'NORMAL';
  return { s, P, sink, carried, flow, lvl, covered, uncovered, poolFrac,
    T, live, steamOnly, injecting, poolLoop, onFloor, cracked, lost, lostWater,
    headline,
    good: !(p.vesselBreach || uncovered || p.coreDamage > 0.01 || sink === 'none'
      || lvl < 0.97 || lostWater) };
}

// ---------------------------------------------------------------------------
// the stage
// ---------------------------------------------------------------------------
const CONTENT = { x: -510, y: -132, w: 1160, h: 962 };
const CORE = { x: -510, y: -132, w: 920, h: 962 };
const GAP = 80;
const SHRUNK = [];
export function overflowReport() { return SHRUNK.slice(); }

class TextPool {
  constructor(parent) { this.parent = parent; this.items = []; this.n = 0; }
  begin() { this.n = 0; }
  put(str, x, y, o) {
    let t = this.items[this.n];
    if (!t) {
      t = new PIXI.Text({ text: '', style: { fontFamily: 'ui-sans-serif, system-ui, sans-serif' } });
      t.resolution = 2;
      this.items.push(t);
      this.parent.addChild(t);
    }
    this.n++;
    const px = o.px || 15;
    t.style.fontSize = px;
    t.style.fontWeight = String(o.weight || 700);
    t.style.fill = o.fill == null ? C.ink : o.fill;
    t.style.stroke = { color: 0x040910, width: Math.max(3.4, px * 0.42), join: 'round' };
    if (t.text !== str) t.text = str;
    t.visible = true;
    // measure unscaled: width reports the scaled width, so leaving last
    // frame's scale on compounds it away to nothing
    t.scale.set(1);
    t.anchor.set(o.align === 'right' ? 1 : o.align === 'left' ? 0 : 0.5, 0.5);
    let scale = 1;
    if (o.maxW && t.width > o.maxW) {
      scale = o.maxW / t.width;
      if (px * scale < 8.5) SHRUNK.push(`${str} (${(px * scale).toFixed(1)}px in ${o.maxW.toFixed(0)}px)`);
    }
    t.scale.set(scale);
    t.x = x; t.y = y;
    return t;
  }
  end() { for (let i = this.n; i < this.items.length; i++) this.items[i].visible = false; }
}

export class CutScene {
  constructor() {
    this.focus = 'both';
    this.ready = false;
    this.nodes = [];
    this.states = [];
    this.lastT = null;
  }

  async init(host) {
    this.app = new PIXI.Application();
    await this.app.init({
      background: 0x0a1119, antialias: true, preference: 'webgl',
      resolution: Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1),
      autoDensity: true, autoStart: false, resizeTo: window
    });
    host.appendChild(this.app.canvas);
    await initPhysics();
    this.tex = { drop: blobTexture(false), soft: blobTexture(true) };
    this.bg = new PIXI.Graphics();
    this.world = new PIXI.Container();
    this.overlay = new PIXI.Container();
    this.app.stage.addChild(this.bg, this.world, this.overlay);
    this.text = new TextPool(this.overlay);
    this.ready = true;
  }

  setFocus(f) { this.focus = f; }
  frameBox(bandW) {
    if (this.focus === 'both') return CORE;
    return bandW && bandW / CONTENT.w < 0.42 ? CORE : CONTENT;
  }
  bounds(bandW) {
    const one = { ...this.frameBox(bandW) };
    if (this.focus === 'both') return { ...one, w: one.w * 2 + GAP };
    return one;
  }
  band(cw, ch) {
    const narrow = cw < 861;
    return narrow
      ? { x: 8, y: 124, w: cw - 16, h: ch - 124 - 226 }
      : { x: 318, y: 128, w: cw - 318 - 350, h: ch - 128 - 128 };
  }

  ensure(sim) {
    if (this.nodes.length) return;
    for (const p of sim.plants) {
      const n = new PlantNode(p, this.tex);
      n.measure();
      this.nodes.push(n);
      this.world.addChild(n.root);
    }
  }

  // called every animation frame; t is the simulation's visual clock
  render(sim, t) {
    if (!this.ready) return;
    this.ensure(sim);
    const dt = this.lastT == null ? 0 : clamp(t - this.lastT, 0, 0.25);
    this.lastT = t;
    // app.screen is already in CSS pixels; renderer.width is too when
    // autoDensity is on, so dividing by the resolution halved the whole scene
    const cw = this.app.screen.width, ch = this.app.screen.height;

    this.bg.clear();
    this.bg.rect(0, 0, cw, ch).fill(new PIXI.FillGradient({
      type: 'linear', start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 },
      colorStops: [{ offset: 0, color: 0x0a1119 }, { offset: 0.55, color: 0x0c1620 },
        { offset: 1, color: 0x0a1119 }]
    }));
    for (let x = 0; x < cw; x += 46) {
      this.bg.moveTo(x, 0).lineTo(x, ch).stroke({ width: 1, color: 0x5082b4, alpha: 0.055 });
    }
    for (let y = 0; y < ch; y += 46) {
      this.bg.moveTo(0, y).lineTo(cw, y).stroke({ width: 1, color: 0x5082b4, alpha: 0.055 });
    }

    const b = this.band(cw, ch);
    if (b.w < 40 || b.h < 40) { this.app.render(); return; }
    SHRUNK.length = 0;
    const F = this.frameBox(b.w);
    const full = F === CONTENT;
    const bb = this.bounds(b.w);
    const sc = Math.min(b.w / bb.w, b.h / bb.h);
    const tx = b.x + (b.w - bb.w * sc) / 2 - bb.x * sc;
    const ty = b.y + (b.h - bb.h * sc) / 2 - bb.y * sc;
    this.world.scale.set(sc);
    this.world.position.set(tx, ty);

    const show = sim.plants.filter((p) =>
      !(this.focus === 'active' && p.mode === MODE.PASSIVE)
      && !(this.focus === 'passive' && p.mode !== MODE.PASSIVE));
    this.states = [];
    let i = 0;
    for (const node of this.nodes) {
      const on = show.includes(node.p);
      node.root.visible = on;
      if (!on) continue;
      const st = circuitState(node.p);
      st.full = full;
      st.mwe = 0;
      node.root.x = i * (F.w + GAP);
      node.step(dt, st);
      // A turbine-generator makes nothing until it is near speed, and what it
      // then makes is a third of the heat the steam is actually carrying.
      st.spin = node.turbine.speed;
      st.steaming = (node.net.secondary.mdot || 0) > 1;
      st.mwe = node.turbine.speed > 12
        ? Math.round(((node.net.secondary.mdot * 1.5e6) / 1e6) * 0.33) : 0;
      node.drawShell(st);
      node.drawPipes(st);
      node.drawVessels(st, t);
      node.drawFront(st, t);
      node.drawDrops(st);
      node.drawFore(st, t);
      node.drawFx(st);
      this.states.push({ p: node.p, st, node, ox: node.root.x });
      i++;
    }

    this.drawText(sc, tx, ty, F);
    this.drawKey(cw, ch);
    this.app.render();
  }

  // the key, on the same overlay as the captions
  drawKey(cw, ch) {
    if (!this.key) {
      this.key = new PIXI.Graphics();
      this.keyText = new TextPool(this.overlay);
      this.overlay.addChild(this.key);
    }
    const narrow = cw < 861;
    const items = narrow
      ? [[0x2b86cf, 'water'], [0xe07a3c, 'hot water'],
        [0xf52d10, 'fuel failing'], [0xffd35c, 'electricity']]
      : [[0x2b86cf, 'water'], [0xe07a3c, 'hot water'], [0x3fc0d8, 'water that has been cooled'],
        [0xe8702a, 'fuel heating up'], [0xf52d10, 'fuel failing'],
        [0xb7c6d2, 'steam leaving'], [0xffd35c, 'electricity']];
    const left = narrow ? 10 : 322;
    const right = cw - (narrow ? 10 : 344);
    this.key.clear();
    this.keyText.begin();
    const rows = [[]];
    let x = left;
    for (const it of items) {
      const w = it[1].length * 5.8 + 30;
      if (x + w > right && rows[rows.length - 1].length) { rows.push([]); x = left; }
      rows[rows.length - 1].push([it, x]);
      x += w;
    }
    const h = rows.length * 18 + 9;
    const baseY = ch - (narrow ? 186 : 78) - h;
    this.key.roundRect(left - 8, baseY, right - left + 16, h, 7)
      .fill({ color: 0x080d13, alpha: 0.72 })
      .stroke({ width: 1, color: 0x78aad2, alpha: 0.16 });
    rows.forEach((row, ri) => {
      const y = baseY + 17 + ri * 18;
      for (const [it, px] of row) {
        this.key.rect(px, y - 9, 11, 11).fill({ color: it[0] });
        this.keyText.put(it[1], px + 16, y - 3,
          { px: 11, weight: 500, align: 'left', fill: 0xd0e0ee });
      }
    });
    this.keyText.end();
  }

  resize() { if (this.ready) this.app.renderer.resize(); }
}

// ---------------------------------------------------------------------------
// captions. Drawn in screen space, anchored to a projected point, so they stay
// level and legible however small the drawing gets.
// ---------------------------------------------------------------------------
function captions(node, st) {
  const p = node.p, s = st.s, P = st.P, g = G;
  const MW = (p.qDecay || 0) / 1e6;
  const L = [];
  const at = (gx, gy, gz, dx, dy, text, o = {}) => L.push({ g: [gx, gy, gz], dx, dy, text, ...o });
  const free = (wx, wy, text, o = {}) => L.push({ w: [wx, wy], dx: 0, dy: 0, text, ...o });

  at(g.core.x, g.core.y, g.core.z + g.core.h + 2.1, 0, -10, 'REACTOR',
    { px: 17, weight: 800, maxW: 200 });
  at(g.core.x, g.core.y, 0, 0, 34,
    `water ${Math.round(st.lvl * 100)}%   ·   ${st.T.toFixed(0)} °C`,
    { px: 15, maxW: 300, lead: true,
      fill: st.T > 800 ? C.bad : st.T > 360 ? C.warn : C.dim });
  at(g.core.x, g.core.y, 0, 0, 52, p.scrammed
    ? `shut down — still making ${MW < 10 ? MW.toFixed(1) : Math.round(MW)} MW of heat`
    : `running — making ${Math.round(MW).toLocaleString('en-US')} MW of heat`,
  { px: 13, weight: 600, maxW: 480, fill: 0xa2bacd });

  at(g.sg.x, g.sg.y, g.sg.z + g.sg.h + 1.8, 0, -10, 'BOILER',
    { px: 17, weight: 800, maxW: 180 });
  at(g.sg.x, g.sg.y, 0, 0, 40,
    st.sink === 'turbine' ? 'taking the heat away'
      : st.sink === 'pool' ? 'not needed — the pool has it'
        : st.sink === 'shell' ? 'not needed — the shell has it' : 'not taking any heat',
    { px: 15, maxW: 300, lead: true,
      fill: st.sink === 'turbine' ? C.dim : st.carried ? C.ok : C.bad });

  const pumpTx = s.rcp
    ? (P ? ['spinning', 'the cooling needs no pump at all']
      : ['spinning', 'the cooling needs pumps like this'])
    : (P ? ['stopped', st.flow > 0
      ? 'the water still creeps round on its own, far slower'
      : 'and the cooling carries on anyway']
      : ['STOPPED', st.steamOnly ? 'the steam pump covers it'
        : st.live ? 'the backups must take over' : 'the backups have no power']);
  const pc = s.rcp ? C.ink : (P ? C.ok : C.bad);
  at(g.pump.x, g.pump.y, 0, 0, 46, 'PUMP', { px: 16, weight: 800, maxW: 200, lead: true });
  at(g.pump.x, g.pump.y, 0, 0, 64, pumpTx[0], { px: 14, maxW: 260, fill: pc });
  at(g.pump.x, g.pump.y, 0, 0, 81, pumpTx[1],
    { px: 13, weight: 600, maxW: 320, prio: 1, fill: s.rcp ? C.dim : pc });

  if (P) {
    const pcx = (g.pool.x0 + g.pool.x1) / 2, pcy = (g.pool.y0 + g.pool.y1) / 2;
    at(pcx, pcy, g.pool.z + g.pool.h, 0, -40,
      st.onFloor ? 'WATER ON THE FLOOR' : 'THE POOL — HIGHER THAN THE REACTOR',
      { px: 15, weight: 800, maxW: 440 });
    at(pcx, pcy, g.pool.z + g.pool.h, 0, -21,
      st.lost ? 'ESCAPING as steam'
        : st.onFloor ? 'still gets back in'
          : st.cracked ? 'CRACKED — draining'
            : st.injecting ? 'falling into the reactor'
              : st.poolLoop ? 'taking the heat from the reactor' : 'ready — no pump needed',
      { px: 14, maxW: 340,
        fill: st.lost ? C.bad : st.onFloor ? C.ok : st.cracked ? C.warn : C.ok });
    if ((s.pccs || 0) > 0.05 && st.poolFrac < 0.985) {
      at(pcx, pcy, g.pool.z + g.pool.h, 0, -6,
        'steam condenses on the shell and drains back in',
        { px: 12, weight: 600, maxW: 380, prio: 1, fill: C.cold });
    }
    at(6.6, 16.7, 6.9, 214, -74, st.poolLoop ? 'heat goes up to the pool' : 'the path to the pool',
      { px: 13, weight: 600, maxW: 250, prio: 1, lead: true,
        fill: st.poolLoop ? C.hot : 0x7d8a96 });
  } else {
    at((g.base.x0 + g.base.x1) / 2, g.base.y1, g.base.z, 0, 30, 'WATER IN THE BASEMENT',
      { px: 16, weight: 800, maxW: 320, lead: true });
    at((g.base.x0 + g.base.x1) / 2, g.base.y1, g.base.z, 0, 50,
      st.injecting ? 'being pumped up'
        : !st.live ? 'CANNOT REACH THE REACTOR'
          : !p.pumpsOk ? 'THE PUMPS HAVE FAILED' : 'waiting down here',
      { px: 14, maxW: 320,
        fill: st.injecting ? C.ink : (st.live && p.pumpsOk ? C.dim : C.bad) });
    at(g.eccs.x, g.eccs.y, g.eccs.h, 18, 50, 'BACKUP PUMP',
      { px: 15, weight: 800, align: 'left', maxW: 220, lead: true });
    at(g.eccs.x, g.eccs.y, g.eccs.h, 18, 68,
      st.steamOnly ? 'running on steam' : st.injecting ? 'pumping'
        : !st.live ? 'NO POWER' : !p.pumpsOk ? 'BROKEN' : 'waiting',
      { px: 13, align: 'left', maxW: 220,
        fill: st.steamOnly ? C.warn : st.injecting ? C.ink
          : (st.live && p.pumpsOk) ? C.dim : C.bad });
    at(g.eccs.x, g.eccs.y, g.eccs.h, 18, 85,
      st.steamOnly ? 'runs on steam, not the grid'
        : st.injecting ? 'lifting water uphill'
          : !st.live ? 'it needs electricity'
            : !p.pumpsOk ? 'it cannot lift the water' : 'starts if the level falls',
      { px: 12, weight: 600, align: 'left', maxW: 250, prio: 1,
        fill: st.steamOnly ? C.warn : st.injecting || (st.live && p.pumpsOk) ? C.dim : C.bad });
    at(10.6, 17.4, 9.8, 214, -74, 'the long way round, uphill',
      { px: 13, weight: 600, maxW: 260, prio: 1, lead: true,
        fill: st.injecting ? C.water : 0x5f7180 });
  }

  if (st.full) {
    at(G.turb.x, SHAFT_Y, SHAFT_Z + G.turb.r1, 0, -30, 'TURBINE',
      { px: 15, weight: 800, maxW: 200, lead: true });
    at((G.gen.x0 + G.gen.x1) / 2, SHAFT_Y, G.gen.z + G.gen.h, 0, -40, 'GENERATOR',
      { px: 15, weight: 800, maxW: 240, lead: true });
    at((G.gen.x0 + G.gen.x1) / 2, SHAFT_Y, G.gen.z + G.gen.h, 0, -21,
      st.mwe ? `${st.mwe.toLocaleString('en-US')} MW of electricity`
        : st.spin > 1 ? 'running up to speed' : 'no electricity',
      { px: 14, maxW: 300, fill: st.mwe ? C.power : st.spin > 1 ? C.warn : C.dim });
    at((G.cond.x0 + G.cond.x1) / 2, G.cond.y1, G.cond.z, -20, 26, 'CONDENSER',
      { px: 13, weight: 800, align: 'right', maxW: 220, prio: 1, lead: true });
    at((G.cond.x0 + G.cond.x1) / 2, G.cond.y1, G.cond.z, -20, 44,
      'steam turns back to water here',
      { px: 12, weight: 600, align: 'right', maxW: 300, prio: 1, fill: C.dim });
    at(19.6, 10.0, 12.3, 0, -16,
      st.steaming ? 'steam to the turbine' : 'no steam — the reactor is shut down',
      { px: 13, weight: 600, maxW: 340, prio: 1, fill: st.steaming ? C.steam : 0x7d8a96 });
    if (s.vent) {
      at(G.stack.x, G.stack.y, G.stack.h, -16, 34, 'VENT OPEN',
        { px: 13, weight: 800, align: 'right', maxW: 200, lead: true, fill: C.warn });
      at(G.stack.x, G.stack.y, G.stack.h, -16, 51,
        'opened on purpose, to stop the containment bursting',
        { px: 12, weight: 600, align: 'right', maxW: 340, prio: 1, fill: C.warn });
    }
  }
  if (!p.ctmtIntact) {
    const bx = G.shell.r * ERX * Math.cos(BREACH_A);
    const by = (G.shell.x + G.shell.y) * 16 + G.shell.r * ERY * Math.sin(BREACH_A)
      - G.shell.h * TZ * 0.52;
    free(bx, by, 'the hole the inside is escaping through',
      { px: 13, weight: 700, maxW: 360, dy: -54, lead: true, fill: C.bad });
  }
  free(-120, 812, !p.ctmtIntact ? 'CONTAINMENT BREACHED — the barrier is gone'
    : st.sink === 'shell' ? 'CONTAINMENT — the steel carries the heat to the air'
      : 'CONTAINMENT — nothing inside this line gets out',
  { px: 13.5, maxW: 560,
    fill: !p.ctmtIntact ? C.bad : st.sink === 'shell' ? C.ok : C.dim });
  return L;
}

Object.assign(CutScene.prototype, {
  drawText(sc, tx, ty, F) {
    if (!this.lead) {
      this.lead = new PIXI.Graphics();
      this.overlay.addChildAt(this.lead, 0);
    }
    this.lead.clear();
    this.text.begin();
    const fs = clamp(sc * 1.32, 0.70, 1.06);
    const detail = sc >= 0.52;
    for (const { p, st, ox } of this.states) {
      const node = this.nodes.find((n) => n.p === p);
      for (const e of captions(node, st)) {
        if (e.prio === 1 && !detail) continue;
        const w = e.g ? P3(e.g[0], e.g[1], e.g[2]) : { x: e.w[0], y: e.w[1] };
        const px = tx + (ox + w.x) * sc, py = ty + w.y * sc;
        const lx = px + (e.dx || 0) * sc, ly = py + (e.dy || 0) * sc;
        if (e.lead) {
          this.lead.moveTo(px, py).lineTo(lx, ly)
            .stroke({ width: 1, color: 0xbed6e8, alpha: 0.42 });
          this.lead.circle(px, py, 2.2).fill({ color: 0xd2e8f8, alpha: 0.85 });
        }
        this.text.put(e.text, lx, ly, {
          px: (e.px || 15) * fs, weight: e.weight, align: e.align,
          fill: e.fill, maxW: (e.maxW || 1e9) * sc * 1.12
        });
      }
      // the plant's name and the step it has reached
      const cx = tx + (ox + F.x + F.w / 2) * sc;
      const top = Math.max(118, ty + F.y * sc);
      this.text.put(p.mode === MODE.PASSIVE ? 'PASSIVE' : 'ACTIVE', cx, top - 44,
        { px: 22, weight: 800, fill: p.mode === MODE.PASSIVE ? 0x57d9ff : 0xff8b5c });
      const chip = this.text.put(st.headline, cx, top - 14,
        { px: 14, weight: 800, fill: st.good ? 0x8ff0b4 : 0xff9c88 });
      const cw2 = chip.width + 26;
      this.lead.roundRect(cx - cw2 / 2, top - 26, cw2, 24, 7)
        .fill({ color: st.good ? 0x0a2c1c : 0x380e0a, alpha: 0.94 })
        .stroke({ width: 1.5, color: st.good ? 0x63e08a : 0xff6e50, alpha: 0.62 });
      this.overlay.removeChild(chip); this.overlay.addChild(chip);
    }
    this.text.end();
  }
});
