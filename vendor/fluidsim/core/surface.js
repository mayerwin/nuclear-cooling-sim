// ---------------------------------------------------------------------------
// surface.js - a free surface: the top of a pool, a vessel, a hotwell, a tank.
//
// A row of water columns under the shallow-water equations. Waves cross it,
// reflect off the walls and die away; pouring into it makes a bulge that
// spreads, instead of a sine wave that was always there. One dimension,
// because what the eye reads on the top of a body of water is that it is
// moving and where something landed, and a second dimension costs the square
// for nothing anyone can see.
//
// No three.js, no dependencies, no allocation after construction, and NO
// WALL CLOCK: everything advances on the dt it is given, so a tool that drives
// the clock forward gets exactly the picture a viewer would have seen. Two
// runs with the same inputs give the same surface, which is what makes a
// screenshot a proof.
// ---------------------------------------------------------------------------

import { G } from './props.js?v=03485aad37';

// NaN lands on the lower bound rather than passing through: see the same note
// in props.js. One NaN reaching a vertex position takes the whole body of
// water out of the picture.
const clamp = (v, a, b) => (v >= a ? (v <= b ? v : b) : a);
// A number, or the fallback if the host handed over something that is not one.
// Math.max(0.01, NaN) is NaN, which is exactly the trap this closes.
const num = (v, d) => (Number.isFinite(v) ? v : d);

// A deterministic little generator: the same ripples every load, so a proof
// image can be compared with the one before it.
function rnd(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class Surface {
  // width:  how wide the body is, in metres. The wave speed comes from it and
  //         the depth, so a bath and a reservoir do not ripple the same.
  // depth:  still-water depth in metres, for that wave speed. Set it from the
  //         level each frame with setDepth() and the waves slow as it drains,
  //         which is what shallow water does.
  // n:      how many columns. 32 is plenty for a vessel; 64 for a long pool.
  constructor(opts = {}) {
    const n = this.n = Math.max(4, Math.round(num(opts.n, 32)));
    this.h = new Float32Array(n);       // height above the still level, metres
    this.u = new Float32Array(n);       // vertical rate of each column, m/s
    this.width = Math.max(0.05, num(opts.width, 4));
    this.depth = Math.max(0.01, num(opts.depth, 2));
    // How fast a disturbance dies. Real water on this scale loses a wave in a
    // few seconds; slower than that and a pool never settles, faster and a
    // splash is over before it is seen.
    this.damp = Math.max(0, num(opts.damp, 1.1));
    // A cap on the height, so nothing a host does can make a spike taller than
    // the water is deep.
    this.maxAmp = Math.max(1e-4, num(opts.maxAmp, 0.4));
    this.t = 0;
    // How much is still moving. See the early-out in step().
    this._live = 0;
    this._rnd = rnd(opts.seed == null ? 20260904 : opts.seed);
    this._boilPhase = 0;
  }

  // Shallow water: the speed of a wave is the root of gravity times depth.
  // Clamped so a body that has drained to nothing does not divide by it.
  get c() { return Math.sqrt(G * Math.max(0.02, this.depth)); }

  setDepth(d) { this.depth = Math.max(0.01, num(d, 0.01)); return this; }
  setWidth(w) { this.width = Math.max(0.05, num(w, 0.05)); return this; }

  // Something landed at `pos` (0 to 1 across the body) with this much
  // amplitude in metres. A drop, a jet, a pipe discharging.
  splash(pos, amp) {
    if (!(amp > 0)) return;
    const a = Math.min(amp, this.maxAmp);
    const i = clamp(Math.round(clamp(pos, 0, 1) * (this.n - 1)), 0, this.n - 1) | 0;
    this.h[i] -= a;
    if (i > 0) this.h[i - 1] -= a * 0.5;
    if (i < this.n - 1) this.h[i + 1] -= a * 0.5;
    // Wake it. A drop landing on a surface the early-out had put to sleep must
    // start it moving again on the very next step.
    if (a > this._live) this._live = a;
  }

  // dt in seconds. opts:
  //   boil    0 to 1, how hard the body is boiling: the surface breaks up.
  //   pour    metres per second of water arriving from above, and pourAt
  //           (0 to 1) where it lands.
  //   still   true to settle the surface flat quickly, for a body that has
  //           just been emptied or frozen by the host.
  //
  // UNCONDITIONALLY STABLE AT ANY dt. The substep count comes from the
  // Courant limit for the wave speed and the column spacing, so a tool that
  // hands it a whole second of clock gets a settled surface rather than an
  // explosion, and it is capped so a big dt costs a bounded amount: past the
  // cap the remaining time is spent damping, which is where a long step was
  // always going to end up anyway.
  step(dt, opts = {}) {
    // Not finite is not a step. An infinite dt would otherwise reach the
    // substep arithmetic and come back out as NaN.
    if (!(dt > 0) || !Number.isFinite(dt)) return this;

    // A FLAT SURFACE WITH NOTHING HAPPENING TO IT STAYS FLAT, so there is
    // nothing to integrate. Every term below is linear in the height and the
    // rate, so from all zeros with no boiling and nothing pouring in, eight
    // substeps of the wave equation produce eight passes of zeros. Skipping
    // them is exact rather than approximate, and it is worth doing: a still
    // pool is the common case, and profiled, this solve was nearly seven per
    // cent of a whole step of the simulation, spent on water that was not
    // moving. `_live` is maintained by the write pass below, so the test is
    // one comparison and not a scan.
    const forced = (opts.boil || 0) > 0.02 || (opts.pour || 0) > 0;
    if (this._live < 1e-12 && !forced) {
      this.t += dt;
      return this;
    }
    const n = this.n, h = this.h, u = this.u;
    const dx = this.width / (n - 1);
    const c = this.c;
    // Courant: c dt / dx <= 0.5, with a little margin.
    const safe = 0.45 * dx / Math.max(0.05, c);
    let steps = Math.ceil(dt / safe);
    const CAP = 8;
    let sdt = dt / steps;
    let rest = 0;
    if (steps > CAP) {
      // Too much time to march honestly. March what the cap allows and let the
      // rest of the interval simply decay, which is where a long quiet step
      // was heading.
      rest = dt - CAP * safe;
      steps = CAP;
      sdt = safe;
    }
    const c2 = c * c / (dx * dx);
    const damp = this.damp;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        const hl = h[i > 0 ? i - 1 : 0], hr = h[i < n - 1 ? i + 1 : n - 1];
        u[i] += c2 * (hl + hr - 2 * h[i]) * sdt;
        u[i] -= u[i] * damp * sdt;
      }
      for (let i = 0; i < n; i++) {
        let v = h[i] + u[i] * sdt;
        if (v > this.maxAmp) { v = this.maxAmp; u[i] = 0; }
        else if (v < -this.maxAmp) { v = -this.maxAmp; u[i] = 0; }
        h[i] = v;
      }
    }
    if (rest > 0) {
      const k = Math.exp(-damp * rest);
      for (let i = 0; i < n; i++) { h[i] *= k; u[i] *= k; }
    }
    this.t += dt;

    // Boiling breaks the surface up: not a wave, a churn. Two columns get
    // kicked per tick, at a rate that rises with how hard it is boiling. The
    // number of kicks is capped, or a tool driving an hour of clock into one
    // step would run tens of thousands of them and pay for every one.
    const boil = opts.boil || 0;
    if (boil > 0.02) {
      this._boilPhase += dt * (4 + boil * 14);
      let kicks = 0;
      while (this._boilPhase > 1 && kicks < 48) {
        this._boilPhase -= 1;
        kicks++;
        for (let j = 0; j < 2; j++) {
          const i = Math.min(n - 1, Math.floor(this._rnd() * n));
          h[i] += (this._rnd() - 0.5) * boil * 0.34 * Math.min(1, this.depth);
        }
      }
      if (this._boilPhase > 1) this._boilPhase = 0;
    }
    // Water arriving from above.
    if (opts.pour > 0) {
      this.splash(opts.pourAt == null ? 0.5 : opts.pourAt, opts.pour * dt * 2.2);
    }
    if (opts.still) {
      const k = Math.exp(-6 * dt);
      for (let i = 0; i < n; i++) { h[i] *= k; u[i] *= k; }
    }

    // NOTHING MAY SHIFT THE MEAN. This surface is the deviation from the still
    // level; the level itself belongs to the volume. A splash pushes water
    // down at the point of impact and it has to go somewhere, so taking the
    // mean back out is what conserves it. Left in, the offset is a flat
    // displacement with no curvature, so the wave equation never sees it and
    // the damping never removes it: the whole surface sits low for ever after
    // the first drop lands. The clamp goes in the same pass, so a kick or a
    // pour cannot leave a spike taller than the surface is allowed to be.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += h[i];
    mean /= n;
    const cap = this.maxAmp;
    // The same pass keeps `_live`, the largest thing still moving, so the
    // early-out at the top of the next call costs one comparison. Held as a
    // sum of the two magnitudes rather than a norm because it is a test for
    // "is anything happening", not a measurement.
    let live = 0;
    for (let i = 0; i < n; i++) {
      let v = h[i] - mean;
      if (v > cap) { v = cap; if (u[i] > 0) u[i] = 0; }
      else if (v < -cap) { v = -cap; if (u[i] < 0) u[i] = 0; }
      h[i] = v;
      const a = v < 0 ? -v : v;
      const b = u[i] < 0 ? -u[i] : u[i];
      if (a > live) live = a;
      if (b > live) live = b;
    }
    this._live = live;
    return this;
  }

  // The height at u (0 to 1 across the body), in metres above the still level.
  sample(u) {
    const x = clamp(u, 0, 1) * (this.n - 1);
    const i = Math.floor(x), f = x - i;
    const a = this.h[i], b = this.h[Math.min(this.n - 1, i + 1)];
    return a + (b - a) * f;
  }

  // The height at a point on a round or rectangular body, faded to nothing at
  // the rim. Flat at the wall and moving in the middle: weighted the other way
  // round, the silhouette of the surface is a row of triangular shards where
  // the one-dimensional wave meets the edge.
  //
  // x and z are metres from the centre; radius is the body's half-width.
  sampleAt(x, z, radius, amp = 1) {
    const r = Math.hypot(x, z) / Math.max(1e-6, radius);
    const u = (x / Math.max(1e-6, radius) + 1) / 2;
    return this.sample(u) * Math.max(0, 1 - r * 0.9) * amp;
  }

  // How disturbed the surface is right now, 0 upward: for a renderer deciding
  // whether it needs to redraw the top of a body at all.
  energy() {
    let e = 0;
    for (let i = 0; i < this.n; i++) e += this.h[i] * this.h[i] + this.u[i] * this.u[i] * 0.05;
    return e / this.n;
  }

  // Flat and still. For a reset, or a body the host has just emptied.
  reset() {
    this.h.fill(0);
    this.u.fill(0);
    this.t = 0;
    this._live = 0;
    this._boilPhase = 0;
    return this;
  }
}
