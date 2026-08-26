// ---------------------------------------------------------------------------
// fluid.js — the flow, solved rather than animated.
//
// Nothing in here draws. It takes the plant model's heat and mass balance,
// turns it into a volumetric flow for each circuit, and from that a velocity
// for every individual pipe by continuity, v = Q / A. Particles are then
// advected along the circuits at those velocities.
//
// The consequences are all real ones, not decisions someone made:
//   * a narrow line runs faster than a fat one carrying the same flow;
//   * the steam line runs about twenty times faster than the feed line that
//     carries the same kilograms, because steam is twenty times lighter;
//   * natural circulation is a crawl next to a running pump, because it is
//     driven by buoyancy and buoyancy is weak;
//   * the pump's impeller turns the way its own two pipes say it must.
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

// Deterministic jitter. Never Math.random() in anything the renderer reads:
// a frozen frame has to be a still one.
export function hash1(i) {
  let h = Math.imul(i | 0, 374761393) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- properties, at the conditions each circuit actually runs at -----------
export const FLUID = {
  // primary water, 155 bar / 310 °C
  rhoPrimary: 720, cpPrimary: 5500, dTcore: 35,
  // secondary: feedwater in, saturated steam out at ~70 bar
  rhoFeed: 750, rhoSteam: 36, hCycle: 1.50e6,
  // the residual-heat loop runs a much bigger temperature rise and much less flow
  dTprhr: 60,
  rhoCold: 990
};

// A rated primary mass flow that follows from the design temperature rise
// rather than from a number picked to look right.
export function ratedMdot(thermalW) {
  return thermalW / (FLUID.cpPrimary * FLUID.dTcore);
}

// Natural circulation. Buoyancy head goes as the temperature rise, friction as
// the square of the flow, and the rise is itself the heat over the flow, which
// leaves mdot proportional to the cube root of the power. K is the one
// calibration constant, set so decay heat gives the ~5 % of rated flow that
// PWRs actually measure in natural circulation.
const K_NC = 0.24;
export function naturalMdot(thermalW, decayW) {
  if (decayW <= 0 || thermalW <= 0) return 0;
  return ratedMdot(thermalW) * K_NC * Math.pow(decayW / thermalW, 1 / 3);
}

// ---------------------------------------------------------------------------
// geometry: a route is a polyline in grid space; the network works in the
// projected plane, because that is where the particles have to end up.
// ---------------------------------------------------------------------------
export class Edge {
  // dia is a real bore in metres; n is how many of that pipe the drawing's one
  // pipe stands for, so a four-loop plant's single drawn hot leg carries the
  // flow area of four.
  constructor(route, dia, n = 1, opts = {}) {
    this.route = route;
    this.area = n * Math.PI * dia * dia / 4;
    this.dia = dia;
    // density at this pipe's own conditions. A circuit carries one mass flow;
    // the volume that mass takes up is what changes from leg to leg, and that
    // is why the steam line runs twenty times faster than the feed line.
    this.rho = opts.rho || FLUID.rhoPrimary;
    this.kind = opts.kind || 'water';
    this.hidden = !!opts.hidden;
    this.name = opts.name || '';
    this.pts = null;      // projected, filled by measure()
    this.cum = null;
    this.len = 0;         // screen length
    this.v = 0;           // m/s
  }
  measure(project) {
    const pts = [];
    for (const p of this.route) pts.push(project(p[0], p[1], p[2]));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    this.pts = pts; this.cum = cum; this.len = cum[cum.length - 1];
    return this;
  }
  at(d) {
    const pts = this.pts, cum = this.cum;
    if (!pts) return null;
    if (d <= 0) return { x: pts[0].x, y: pts[0].y, i: 1 };
    if (d >= this.len) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, i: pts.length - 1 };
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const u = (d - cum[i - 1]) / seg;
    return {
      x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u,
      y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u,
      i
    };
  }
  dir(d) {
    const a = this.at(Math.max(0, d - 2)), b = this.at(Math.min(this.len, d + 2));
    const dx = b.x - a.x, dy = b.y - a.y;
    const m = Math.hypot(dx, dy) || 1;
    return { x: dx / m, y: dy / m };
  }
}

// A circuit is a series chain of edges. Series means one volumetric flow for
// the whole chain, which is the entire physics of a closed loop.
export class Circuit {
  constructor(name, edges, opts = {}) {
    this.name = name;
    this.edges = edges;
    this.loop = opts.loop !== false;
    this.spacing = opts.spacing || 15;   // px between particles when seeded
    this.Q = 0;                          // m3/s
    this.total = 0;
    this.parts = null;                   // Float32Array of arc positions
    this.seeded = false;
  }
  measure(project) {
    this.total = 0;
    for (const e of this.edges) { e.measure(project); this.total += e.len; }
    if (!this.seeded || this.parts.length !== Math.max(2, Math.round(this.total / this.spacing))) {
      const n = Math.max(2, Math.round(this.total / this.spacing));
      this.parts = new Float32Array(n);
      for (let i = 0; i < n; i++) this.parts[i] = (i + 0.5) * (this.total / n);
      this.seeded = true;
    }
    return this;
  }
  // One mass flow for the whole series chain. Each leg turns it into its own
  // volumetric flow and then, by continuity, its own velocity.
  setFlow(mdot, pxPerMs) {
    this.mdot = mdot;
    for (const e of this.edges) e.v = (mdot / e.rho) / e.area;
    this.pxPerMs = pxPerMs;
  }
  edgeAt(d) {
    let acc = 0;
    for (const e of this.edges) {
      if (d < acc + e.len || e === this.edges[this.edges.length - 1]) {
        return { e, d: d - acc };
      }
      acc += e.len;
    }
    return { e: this.edges[0], d: 0 };
  }
  speedAt(d) {
    const { e } = this.edgeAt(d);
    return e.v * this.pxPerMs;
  }
  step(dt) {
    if (!this.parts || this.total <= 0) return;
    const p = this.parts;
    for (let i = 0; i < p.length; i++) {
      let d = p[i] + this.speedAt(p[i]) * dt;
      if (d >= this.total) d = this.loop ? d - this.total : d % this.total;
      p[i] = d;
    }
  }
  // Positions for the renderer, as {x, y, v, e} — v is the local speed so the
  // renderer can stretch a droplet along the direction it is going.
  *positions() {
    if (!this.parts) return;
    for (let i = 0; i < this.parts.length; i++) {
      const d = this.parts[i];
      const { e, d: ed } = this.edgeAt(d);
      const q = e.at(ed);
      if (!q) continue;
      yield { x: q.x, y: q.y, e, ed, v: e.v * this.pxPerMs, i };
    }
  }
}

// ---------------------------------------------------------------------------
// A pump sitting on a circuit. Everything about how it is drawn — how fast the
// impeller turns and which way — comes from the flow through it and from where
// its own two pipes are, so the picture cannot contradict itself.
// ---------------------------------------------------------------------------
export class Pump {
  constructor(circuit, suctionEdge, dischargeEdge, centre) {
    this.circuit = circuit;
    this.suction = suctionEdge;
    this.discharge = dischargeEdge;
    this.centre = centre;       // grid [x, y, z] of the casing centre
    this.angle = 0;
    this.omega = 0;
    this.sign = 1;
  }
  // The vane tips have to travel from the suction port round to the discharge
  // port. Both ports are known in the projected plane, so the direction of
  // rotation is a fact about the drawing rather than a guess.
  orient(project) {
    const c = project(this.centre[0], this.centre[1], this.centre[2]);
    const inP = this.suction.pts[this.suction.pts.length - 1];
    const outP = this.discharge.pts[0];
    const a0 = Math.atan2(inP.y - c.y, inP.x - c.x);
    const a1 = Math.atan2(outP.y - c.y, outP.x - c.x);
    let d = a1 - a0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    this.sign = d >= 0 ? 1 : -1;
    this.inAngle = a0; this.outAngle = a1;
  }
  step(dt, rTip) {
    // tip speed follows the discharge velocity: a centrifugal pump's head is
    // set by u = omega * r, and the discharge velocity scales with it
    const v = this.discharge.v * this.circuit.pxPerMs;
    this.omega = this.sign * (v / Math.max(6, rTip)) * 0.55;
    this.angle = (this.angle + this.omega * dt) % TAU;
  }
}

// ---------------------------------------------------------------------------
// A turbine driven by the steam arriving at it. Spins up and coasts down with
// a real rotor inertia, so it does not snap on and off.
// ---------------------------------------------------------------------------
export class Rotor {
  constructor(tau = 3.5) { this.angle = 0; this.speed = 0; this.tau = tau; }
  step(dt, target) {
    const k = 1 - Math.exp(-dt / this.tau);
    this.speed += (target - this.speed) * k;
    this.angle = (this.angle + this.speed * dt) % TAU;
  }
}

// ---------------------------------------------------------------------------
// A free surface, as a row of water columns obeying the shallow-water
// equations. Waves cross it, reflect off the walls and die away, and pouring
// into it makes a bulge that spreads instead of a sine wave that was always
// there.
// ---------------------------------------------------------------------------
export class Surface {
  constructor(n = 28, opts = {}) {
    this.n = n;
    this.h = new Float32Array(n);      // height above the mean level, px
    this.u = new Float32Array(n);      // velocity of each column
    this.c = opts.c || 3.2;            // wave speed, columns per second
    this.damp = opts.damp || 1.1;
    this.t = 0;
  }
  splash(pos, amp) {
    const i = clamp(Math.round(pos * (this.n - 1)), 0, this.n - 1);
    this.h[i] -= amp;
    if (i > 0) this.h[i - 1] -= amp * 0.5;
    if (i < this.n - 1) this.h[i + 1] -= amp * 0.5;
  }
  step(dt, opts = {}) {
    if (dt <= 0) return;
    const n = this.n, h = this.h, u = this.u;
    // sub-step so the explicit solve stays stable at any frame rate
    const steps = Math.max(1, Math.ceil(dt / 0.016));
    const sdt = dt / steps;
    const c2 = this.c * this.c;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        const hl = h[i > 0 ? i - 1 : 0], hr = h[i < n - 1 ? i + 1 : n - 1];
        u[i] += (c2 * (hl + hr - 2 * h[i])) * sdt;
        u[i] -= u[i] * this.damp * sdt;
      }
      for (let i = 0; i < n; i++) h[i] += u[i] * sdt;
    }
    this.t += dt;
    // boiling keeps knocking it about; the impulses are hashed, not random
    const boil = opts.boil || 0;
    if (boil > 0.02) {
      const k = Math.floor(this.t * 9);
      for (let j = 0; j < 2; j++) {
        const r = hash1(k * 7 + j * 131);
        const i = Math.floor(r * n);
        this.h[i] += (hash1(k * 13 + j) - 0.5) * boil * 3.2;
      }
    }
    if (opts.pour > 0) this.splash(opts.pourAt == null ? 0.5 : opts.pourAt, opts.pour * dt * 26);
  }
  // height at 0..1 across the surface
  sample(u) {
    const x = clamp(u, 0, 1) * (this.n - 1);
    const i = Math.floor(x), f = x - i;
    const a = this.h[i], b = this.h[Math.min(this.n - 1, i + 1)];
    return a + (b - a) * f;
  }
}

// ---------------------------------------------------------------------------
// Steam and smoke: puffs that rise, expand and thin out. Buoyancy and drag,
// integrated, rather than a sine wave pretending to be a cloud.
// ---------------------------------------------------------------------------
export class Puffs {
  constructor(max = 90) {
    this.max = max;
    this.x = new Float32Array(max); this.y = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max);
    this.r = new Float32Array(max); this.life = new Float32Array(max);
    this.age = new Float32Array(max); this.seed = new Float32Array(max);
    this.n = 0; this.cursor = 0; this.emitAcc = 0;
  }
  emit(x, y, opts = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    if (this.n < this.max) this.n++;
    const s = hash1(i * 977 + Math.floor((opts.k || 0) * 31));
    this.x[i] = x + (s - 0.5) * (opts.spread || 10);
    this.y[i] = y;
    this.vx[i] = (hash1(i * 31 + 7) - 0.5) * (opts.vx || 14);
    this.vy[i] = -(opts.vy || 30) * (0.6 + 0.8 * s);
    this.r[i] = (opts.r || 6) * (0.7 + 0.7 * hash1(i * 53));
    this.life[i] = (opts.life || 2.2) * (0.7 + 0.6 * hash1(i * 71));
    this.age[i] = 0;
    this.seed[i] = s;
  }
  step(dt, rate, x, y, opts = {}) {
    if (dt <= 0) return;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      // buoyancy minus drag, and the puff spreads as it rises
      this.vy[i] += (opts.buoy == null ? -34 : opts.buoy) * dt;
      this.vx[i] *= Math.pow(0.55, dt);
      this.vy[i] *= Math.pow(0.68, dt);
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.r[i] += (opts.grow || 16) * dt;
    }
    if (rate > 0) {
      this.emitAcc += rate * dt;
      let guard = 0;
      while (this.emitAcc >= 1 && guard++ < 8) {
        this.emitAcc -= 1;
        this.emit(x, y, { ...opts, k: this.cursor + this.n });
      }
    }
  }
  *live() {
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      const u = this.age[i] / this.life[i];
      yield { x: this.x[i], y: this.y[i], r: this.r[i], u, a: (1 - u) * (u < 0.15 ? u / 0.15 : 1), i };
    }
  }
}
