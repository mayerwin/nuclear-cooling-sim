// ---------------------------------------------------------------------------
// view.js - the read surface: everything a renderer needs, derived once per
// frame, allocating nothing.
//
// A renderer must never work anything out for itself. Every quantity that
// reaches the screen is computed here, in the core, from the state the solver
// produced, so that two renderers looking at the same solver agree exactly and
// so that a caption and a colour cannot disagree. Three of these are worth
// stating as rules, because each one was arrived at the hard way:
//
//  1. VELOCITY IS COMPUTED, NEVER STORED. v = mdot / (rho * A), every frame,
//     from the flow the solve published. There is no independent velocity
//     state that could drift out of step with continuity, so two pipes
//     carrying the same kilograms have velocities in the exact inverse ratio
//     of their bores, which is the thing the eye actually reads.
//  2. THE SCROLL PHASE IS INTEGRATED HERE. If each renderer integrated its own
//     phase from its own frame time, two views of one network would drift
//     apart and a paused frame would jump on resume. It is wrapped at 1024 m
//     because that is a power of two: a float32 uniform holding it stays exact
//     for a session of any length, where an unwrapped metre count loses
//     precision after an hour and the tracers start to stutter.
//  3. THERE IS NO DISPLAY GAIN. A run's own coldest and hottest water define
//     its colour range, floored at a minimum span so that a circuit sitting at
//     one temperature is painted one colour instead of dividing by its own
//     noise. A knob that scaled colours independently of the numbers would let
//     the picture and the label disagree, so it was deleted rather than
//     defaulted.
//
// Everything a boolean drives on screen carries hysteresis, because a value
// sitting on a threshold otherwise flickers between two states at frame rate,
// and the reviews called that out every time it happened.
// ---------------------------------------------------------------------------

import { clamp, num } from './util.js?v=03485aad37';

// The narrowest span a run's colour is scaled across. It must sit ABOVE
// colour.js's own deadband, which is 2 K, or the floor is defeated exactly
// where it was meant to help: colourIn returns the coldest blue for any span
// below its deadband, so a run relaxing through 2 K used to floor here at 1.5,
// pass the range on, and be painted flat dark blue in one frame whatever
// temperature it was actually at. Every body on that run repaints at once, and
// a colour that changes abruptly is the one thing the reviews never allowed.
//
// Floored about the MIDDLE (see publish below), so a run at one temperature
// sits in the centre of its own band rather than at an end of the ramp.
export const MIN_SPAN = 2.5;      // K, and it must exceed colour.js's deadband

// How fast a colour range follows a change. A range that snapped would repaint
// a whole circuit the instant one cell moved; half a second reads as a fade.
export const RANGE_TAU = 0.5;     // s

// Moving and still, with a gap between them. A run has to reach 20 mm/s to be
// called moving and fall below 10 mm/s to stop being it.
export const W_EPS_ON = 0.02, W_EPS_OFF = 0.01;   // m/s

export const PHASE_WRAP = 1024;   // m

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

// Fill every derived field. Allocates nothing, branches on nothing that
// changes size, and is safe to call with dt = 0, which is what a paused frame
// does: the phase does not advance, the ranges hold, and nothing jumps.
export function publish(sys, dt) {
  const t = clamp(num(dt, 0), 0, 1e12);
  const nE = sys.nEdges | 0;

  for (let e = 0; e < nE; e++) {
    const rho = sys.egRho[e], A = sys.egA[e];
    const den = rho * A;
    // Continuity by construction. The guard is for an edge whose cells have
    // not been through a thermal pass yet, never for a real state.
    const v = den > 1e-12 ? sys.egMdot[e] / den : 0;
    sys.egV[e] = Number.isFinite(v) ? v : 0;

    let ph = sys.egPhase[e] + sys.egV[e] * t;
    if (Number.isFinite(ph)) {
      ph %= PHASE_WRAP;
      // A phase a hair below zero, which is what an edge creeping backwards at
      // 1e-18 m/s produces, adds to exactly PHASE_WRAP in float64 and leaves
      // the half-open range this promises to stay inside. Land it on zero,
      // which is the same point on the scroll.
      if (ph < 0) ph += PHASE_WRAP;
      if (ph >= PHASE_WRAP) ph = 0;
    } else {
      ph = 0;
    }
    sys.egPhase[e] = ph;

    // Dry means there is nothing to draw flowing: either the volume feeding
    // this edge has run out or the end it draws through is above the water.
    const donor = sys.egMdot[e] >= 0 ? sys.egFrom[e] : sys.egTo[e];
    const avail = sys.egAvail ? sys.egAvail[e] : 1;
    sys.egDry[e] = (sys.ndDrain[donor] || avail < 0.5) ? 1 : 0;
  }

  const nR = sys.nRuns | 0;
  if (nR <= 0) return;
  // The relaxation factor for this frame. Exact for an exponential approach at
  // any dt, so a range fades at the same rate whatever the frame time.
  const f = t > 0 ? 1 - Math.exp(-t / RANGE_TAU) : 0;

  // A RUN'S EDGES ARE LOOKED UP, NOT SEARCHED FOR. This loop used to walk all
  // nE edges for every run and skip the ones that did not belong, which is the
  // number of runs times the number of edges: six tests a frame on the worked
  // example, and on a station with a hundred runs and five hundred edges fifty
  // thousand, of which forty-nine thousand five hundred are rejections. The
  // membership is compiled at rebuild, where the runs are found.
  const at = sys.runAt, list = sys.runEdge;
  for (let r = 0; r < nR; r++) {
    let lo = Infinity, hi = -Infinity;
    let maxV = 0, bigM = 0, mdot = 0;
    const e0 = at[r], e1 = at[r + 1];
    for (let k = e0; k < e1; k++) {
      const e = list[k];
      const av = Math.abs(sys.egV[e]);
      if (av > maxV) maxV = av;
      const am = Math.abs(sys.egMdot[e]);
      if (am > bigM) { bigM = am; mdot = sys.egMdot[e]; }
      const off = sys.egOff[e], n = sys.egCells[e] | 0;
      for (let j = 0; j < n; j++) {
        // Vapour is left out of the range. Steam sits at the saturation
        // temperature however hard it is being heated, so including it pins
        // the hot end of a boiling run and flattens every gradient below it;
        // it is also drawn as vapour rather than through the ramp.
        if (sys.cellX[off + j] > 0.5) continue;
        const T = sys.cellT[off + j];
        if (!(T > 0)) continue;
        if (T < lo) lo = T;
        if (T > hi) hi = T;
      }
    }
    if (!(hi >= lo)) {
      // Every cell in this run is vapour, or the run holds no cells at all.
      // Hold the range it had rather than collapsing it to zero, so a run that
      // boils dry for a moment does not flash a new set of colours.
      lo = sys.runLo[r];
      hi = sys.runHi[r];
      if (!(hi >= lo)) { lo = 288.15; hi = 288.15 + MIN_SPAN; }
    }
    // Floored about the middle, so a run at one temperature keeps that
    // temperature in the centre of its own band instead of being pushed to an
    // end of the ramp by its own rounding.
    const span = hi - lo;
    if (span < MIN_SPAN) {
      const mid = (hi + lo) * 0.5;
      lo = mid - MIN_SPAN * 0.5;
      hi = mid + MIN_SPAN * 0.5;
    }

    // A fresh array is all zeros, which is not a temperature any water can be
    // at, so the first publish snaps and every later one fades.
    if (!(sys.runHi[r] > 0)) {
      sys.runLo[r] = lo;
      sys.runHi[r] = hi;
    } else {
      sys.runLo[r] += (lo - sys.runLo[r]) * f;
      sys.runHi[r] += (hi - sys.runHi[r]) * f;
    }
    sys.runMdot[r] = mdot;
    sys.runMoving[r] = sys.runMoving[r]
      ? (maxV > W_EPS_OFF ? 1 : 0)
      : (maxV >= W_EPS_ON ? 1 : 0);
  }
}

// Moving, for an edge that belongs to no run and so has no hysteresis state of
// its own. Midway between the two thresholds: a lone edge is rare, and one
// stable threshold is better than borrowing another run's history.
function edgeMoving(sys, e) {
  const r = sys.egRun[e];
  if (r >= 0 && r < (sys.nRuns | 0)) return !!sys.runMoving[r];
  return Math.abs(sys.egV[e]) > (W_EPS_ON + W_EPS_OFF) * 0.5;
}

// ---------------------------------------------------------------------------
// Flyweights
//
// Each of these is a view onto one index of the arrays, not a copy of them.
// A host keeps one per body and reads it every frame; nothing here allocates
// once it has been bound, which is what lets a renderer walk a whole station
// in a frame without touching the garbage collector.
// ---------------------------------------------------------------------------

// Ids are strings and live in the IdMap, whose ids() builds an array. Cached
// per view and refreshed only when the map's size changes, so reading .id
// every frame is a lookup rather than an allocation.
function idsOf(map, cache, key) {
  if (!map) return null;
  const n = map.size;
  if (!cache[key] || cache[key + 'N'] !== n) {
    cache[key] = map.ids();
    cache[key + 'N'] = n;
  }
  return cache[key];
}

class BaseView {
  constructor(sys, i) {
    this.sys = sys;
    this.i = i | 0;
    this._ids = null;
    this._idsN = -1;
    this._nids = null;
    this._nidsN = -1;
  }
  bind(i) { this.i = i | 0; return this; }
}

export class EdgeView extends BaseView {
  constructor(sys, i = 0) {
    super(sys, i);
    this._cT = null;
    this._cX = null;
    this._cBuf = null;
    this._cOff = -1;
    this._cN = -1;
  }

  get id() {
    const ids = idsOf(this.sys.edgeIds, this, '_ids');
    return ids ? ids[this.i] : String(this.i);
  }
  get from() {
    const ids = idsOf(this.sys.nodeIds, this, '_nids');
    return ids ? ids[this.sys.egFrom[this.i]] : this.sys.egFrom[this.i];
  }
  get to() {
    const ids = idsOf(this.sys.nodeIds, this, '_nids');
    return ids ? ids[this.sys.egTo[this.i]] : this.sys.egTo[this.i];
  }

  get mdot() { return this.sys.egMdot[this.i]; }
  get v() { return this.sys.egV[this.i]; }
  get rho() { return this.sys.egRho[this.i]; }
  get mu() { return this.sys.egMu[this.i]; }
  get A() { return this.sys.egA[this.i]; }
  get L() { return this.sys.egL[this.i]; }
  get dia() { return this.sys.egD[this.i]; }
  get n() { return this.sys.egN[this.i]; }
  get T0() { return this.sys.egT0[this.i]; }
  get T1() { return this.sys.egT1[this.i]; }
  get x0() { return this.sys.egX0[this.i]; }
  get x1() { return this.sys.egX1[this.i]; }
  get kind() { return this.sys.egKind[this.i]; }
  get fill() { return this.sys.egFill[this.i]; }
  get dry() { return !!this.sys.egDry[this.i]; }
  get moving() { return edgeMoving(this.sys, this.i); }
  get phase() { return this.sys.egPhase[this.i]; }
  get cells() { return this.sys.egCells[this.i]; }
  get run() { return this.sys.egRun[this.i]; }
  get geomVersion() { return this.sys.egGeomVer[this.i]; }

  // Views onto this edge's own cells, rebuilt only when the edge is rebound or
  // the cell arrays are grown by a rebuild.
  _cache() {
    const s = this.sys, i = this.i;
    const off = s.egOff[i], n = s.egCells[i] | 0;
    if (this._cT === null || this._cBuf !== s.cellT || this._cOff !== off || this._cN !== n) {
      this._cT = s.cellT.subarray(off, off + n);
      this._cX = s.cellX.subarray(off, off + n);
      this._cBuf = s.cellT;
      this._cOff = off;
      this._cN = n;
    }
  }
  get cellT() { this._cache(); return this._cT; }
  get cellX() { this._cache(); return this._cX; }
}

export class VolumeView extends BaseView {
  get id() {
    const ids = idsOf(this.sys.nodeIds, this, '_nids');
    return ids ? ids[this.i] : String(this.i);
  }
  get p() { return this.sys.ndP[this.i]; }
  get T() { return this.sys.ndT[this.i]; }
  get x() { return this.sys.ndX[this.i]; }
  get h() { return this.sys.ndH[this.i]; }
  get rho() { return this.sys.ndRho[this.i]; }
  get mass() { return this.sys.ndM[this.i]; }
  get level() { return this.sys.ndLevel[this.i]; }
  get fill() { return this.sys.ndFill[this.i]; }
  get area() { return this.sys.ndAsurf[this.i]; }
  get boil() { return this.sys.ndBoil[this.i]; }
  get cond() { return this.sys.ndCond[this.i]; }
  get pour() { return this.sys.ndPour[this.i]; }
  get pourAt() { return this.sys.ndPourAt[this.i]; }
  get drain() { return !!this.sys.ndDrain[this.i]; }
  get free() { return !!this.sys.ndFree[this.i]; }
  get surface() { return this.sys.ndSurf ? this.sys.ndSurf[this.i] : null; }
  get mixSpan() { return this.sys.ndMixSpan[this.i]; }
}

export class RunView extends BaseView {
  constructor(sys, i = 0) {
    super(sys, i);
    this._edges = null;
    this._edgesFor = -1;
  }
  get id() {
    const ids = idsOf(this.sys.runIds, this, '_ids');
    return ids ? ids[this.i] : String(this.i);
  }
  get lo() { return this.sys.runLo[this.i]; }
  get hi() { return this.sys.runHi[this.i]; }
  get mdot() { return this.sys.runMdot[this.i]; }
  get moving() { return !!this.sys.runMoving[this.i]; }

  // The run's edges as ids, in the order the network declared them, which is
  // flow order and so is the order a renderer must walk them in to lay a
  // gradient along the whole run. Built once per binding.
  get edges() {
    if (this._edges !== null && this._edgesFor === this.i) return this._edges;
    const s = this.sys;
    const declared = (s.net && typeof s.net.run === 'function' && this.id != null)
      ? s.net.run(this.id) : null;
    if (declared && Array.isArray(declared.edges)) {
      this._edges = declared.edges.slice();
    } else {
      const ids = idsOf(s.edgeIds, this, '_ids2');
      const out = [];
      for (let e = 0; e < (s.nEdges | 0); e++) {
        if (s.egRun[e] === this.i) out.push(ids ? ids[e] : e);
      }
      this._edges = out;
    }
    this._edgesFor = this.i;
    return this._edges;
  }
}
