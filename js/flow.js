// ---------------------------------------------------------------------------
// flow.js - the hydraulics.
//
// The plant model gives a heat balance. This turns it into one mass flow per
// circuit and, by continuity, a velocity for every individual pipe: v = Q / A.
// Everything the eye sees about speed is a consequence of that, not a number
// somebody picked:
//
//   a narrow line runs faster than a fat one carrying the same flow;
//   the steam line runs about twenty times faster than the feed line that
//     carries the same kilograms, because steam is twenty times lighter;
//   natural circulation is a crawl next to a running pump.
//
// This is 1-D network hydraulics, which is what plant codes (RELAP5, TRACE)
// use for closed pressurised loops. A rigid-body or SPH engine solves a
// different problem and would be wrong here; the rotating machinery, which is
// a rigid-body problem, is on Rapier in machines.js.
// ---------------------------------------------------------------------------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function hash1(i) {
  let h = Math.imul(i | 0, 374761393) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Properties at the conditions each circuit actually runs at.
export const FLUID = {
  rhoPrimary: 720, cpPrimary: 5500, dTcore: 35,   // 155 bar, 310 C
  rhoFeed: 750, rhoSteam: 36, hCycle: 1.50e6,     // 70 bar secondary
  rhoCold: 990, dTprhr: 60
};

export const THERMAL_W = 3400e6;

// Rated primary flow follows from the design temperature rise.
export const ratedMdot = (w = THERMAL_W) => w / (FLUID.cpPrimary * FLUID.dTcore);

// Natural circulation: buoyancy head goes as the temperature rise, friction as
// the square of the flow, and the rise is the heat over the flow, which leaves
// the flow on the cube root of the power. K is the one calibration constant,
// set so decay heat gives the ~5 % of rated flow that PWRs measure.
const K_NC = 0.24;
export function naturalMdot(decayW, w = THERMAL_W) {
  if (decayW <= 0) return 0;
  return ratedMdot(w) * K_NC * Math.cbrt(decayW / w);
}

// A leg of pipe. `n` is how many real pipes the one drawn stands for, so a
// four-loop plant's single drawn hot leg carries the flow area of four.
export class Leg {
  constructor(name, dia, n = 1, opts = {}) {
    this.name = name;
    this.dia = dia;
    this.area = n * Math.PI * dia * dia / 4;
    this.rho = opts.rho || FLUID.rhoPrimary;
    this.kind = opts.kind || 'water';
    this.v = 0;
    this.phase = 0;
    // TEMPERATURE TRAVELS WITH THE WATER. A leg has an inlet temperature, an
    // outlet temperature, and the heat it picks up or gives away on the way
    // (dT, in degrees; negative is cooling). Nothing downstream is told what
    // colour to be: the circuit walks its legs in flow order and each inlet is
    // the previous outlet. Set the sea at 15 degrees, say where the heat goes
    // in, and every pipe after that follows.
    //
    // `gain` is a DISPLAY multiplier on dT and nothing else. A turbine's worth
    // of heat into a river of sea water is ten degrees in life, which is no
    // colour at all on screen; drawn with a gain it is a visible change, and
    // the number stays in one place where it can be read.
    this.T0 = 15;
    this.T1 = 15;
    this.dT = 0;
    this.gain = opts.gain || 1;
  }
}

// A circuit is a series chain: one mass flow for the whole chain, which is the
// entire physics of a closed loop.
export class Circuit {
  constructor(name, legs) { this.name = name; this.legs = legs; this.mdot = 0; }
  setFlow(mdot) {
    this.mdot = mdot;
    for (const l of this.legs) l.v = (mdot / l.rho) / l.area;
  }
  advance(dt) { for (const l of this.legs) l.phase += l.v * dt; }
  // Walk the chain from a known inlet temperature. When the water is not
  // moving nothing is carried, and each leg sits at whatever it is standing
  // next to, which the caller has already set.
  setTemps(Tin) {
    let T = Tin;
    for (const l of this.legs) {
      l.T0 = T;
      l.T1 = T + l.dT * l.gain;
      T = l.T1;
    }
    return T;
  }
  // The coldest and hottest water in this circuit right now. Colour is scaled
  // between the two, so a circuit whose water runs from 290 to 325 shows that
  // span as fully as one that runs from 15 to 115: the same orange means
  // "the hot end of this circuit", not the same number of degrees. `extra`
  // is for temperatures the circuit holds but its legs do not carry, such as
  // the water standing in the boiler.
  range(extra = []) {
    let lo = Infinity, hi = -Infinity;
    for (const l of this.legs) {
      if (l.kind === 'steam') continue;
      lo = Math.min(lo, l.T0, l.T1); hi = Math.max(hi, l.T0, l.T1);
    }
    for (const t of extra) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
    if (!isFinite(lo)) { lo = 0; hi = 0; }
    return { lo, hi };
  }
}

// A free surface, as a row of water columns under the shallow-water equations.
// Waves cross it, reflect off the walls and die away; pouring into it makes a
// bulge that spreads instead of a sine wave that was always there.
export class Surface {
  constructor(n = 32, opts = {}) {
    this.n = n;
    this.h = new Float32Array(n);
    this.u = new Float32Array(n);
    this.c = opts.c || 3.2;
    this.damp = opts.damp || 1.2;
    this.t = 0;
  }
  splash(pos, amp) {
    const i = clamp(Math.round(pos * (this.n - 1)), 0, this.n - 1) | 0;
    this.h[i] -= amp;
    if (i > 0) this.h[i - 1] -= amp * 0.5;
    if (i < this.n - 1) this.h[i + 1] -= amp * 0.5;
  }
  step(dt, opts = {}) {
    if (dt <= 0) return;
    const n = this.n, h = this.h, u = this.u;
    const steps = Math.min(6, Math.max(1, Math.ceil(dt / 0.016)));
    const sdt = dt / steps, c2 = this.c * this.c;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        const hl = h[i > 0 ? i - 1 : 0], hr = h[i < n - 1 ? i + 1 : n - 1];
        u[i] += c2 * (hl + hr - 2 * h[i]) * sdt;
        u[i] -= u[i] * this.damp * sdt;
      }
      for (let i = 0; i < n; i++) h[i] += u[i] * sdt;
    }
    this.t += dt;
    const boil = opts.boil || 0;
    if (boil > 0.02) {
      const k = Math.floor(this.t * 9);
      for (let j = 0; j < 2; j++) {
        const i = Math.floor(hash1(k * 7 + j * 131) * n);
        this.h[i] += (hash1(k * 13 + j) - 0.5) * boil * 0.34;
      }
    }
    if (opts.pour > 0) this.splash(opts.pourAt == null ? 0.5 : opts.pourAt, opts.pour * dt * 2.2);
  }
  sample(u) {
    const x = clamp(u, 0, 1) * (this.n - 1);
    const i = Math.floor(x), f = x - i;
    return lerp(this.h[i], this.h[Math.min(this.n - 1, i + 1)], f);
  }
}
