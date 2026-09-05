// ---------------------------------------------------------------------------
// thermal.js - energy, phase and inventory. What the water carries, where it
// changes, and what boils.
//
// THIS MODULE CARRIES SPECIFIC ENTHALPY, NEVER TEMPERATURE. In the two-phase
// region the temperature is pinned at the saturation value and only the
// enthalpy moves, so a temperature formulation cannot represent boiling at
// all: it has no state left to put the latent heat in. Enthalpy costs one
// table inversion when a temperature is wanted and buys the whole of boiling,
// flashing and condensation for nothing.
//
// SI throughout, as everywhere in the core: J/kg, K, Pa absolute, kg/s, kg,
// kg/m3, W, W/K, s. The only conversion in the library happens once, in
// Network.fromJSON.
//
// FOUR PROPERTIES ARE STRUCTURAL, not the result of care, and each one is
// written so that undoing it breaks a test rather than quietly degrading a
// picture:
//
//  1. TRANSPORT IS AN EXPLICIT CONVEX COMBINATION of a cell's own past value
//     and what arrived from upstream. Bracketing is therefore a proof and not
//     a clamp, at any dt from a microsecond to a day, and a flow that falls
//     to zero needs no special case because the advection term vanishes on
//     its own.
//  2. WALL HEAT IS APPLIED OVER AN EFFECTIVE TIME, min(dt, the time the fluid
//     takes to cross the edge). Without it a step longer than the residence
//     time dumps a whole dt of duty into fluid that had already left, and the
//     steady state a network settles on depends on the dt used to reach it.
//     With it, a heated edge delivers exactly W/mdot per kilogram at every dt.
//  3. NOTHING EVER DIVIDES WATTS BY A CONDUCTANCE. Every wall term is either a
//     bounded duty spread over cells or an exact two-lump exponential
//     relaxation, so a heated edge with no flow SATURATES instead of running
//     away. An earlier design reached 3.4e9 K by dividing by a conductance
//     that could be zero.
//  4. A JUNCTION HAS EXACTLY ZERO THERMAL MASS. Its enthalpy is what arrives,
//     so a degree-2 junction degenerates to the outlet enthalpy of the one
//     incoming edge, assigned rather than averaged, and a chain of pipes is
//     continuous to machine precision. "Never a step at a joint" then holds
//     structurally: there is no state in the model that could hold a step.
//
// Energy conservation is REPORTED, not claimed. Semi-Lagrangian advection is
// not conservative, and saying so in report.energyResidual is the honest
// thing; a library that asserted an invariant it cannot hold would have that
// invariant quietly deleted by the next agent who hit it.
// ---------------------------------------------------------------------------

import { clamp, lerp, num, growF64, growI32, growU8 } from './util.js?v=a7f82a57a1';
import {
  G, tsat, hLiquid, hVapour, hfg, tOfHLiquid, rhoLiquidSat, rhoVapourSat, rhoVapour,
  cpLiquid, cpVapour, muLiquid, muVapour,
  LIQUID, VAPOUR, TWO_PHASE, T_TRIPLE, T_CRIT, P_TRIPLE, P_CRIT
} from './props.js?v=a7f82a57a1';

// How far below a free surface a nozzle still counts as standing in the gas
// space, for deciding what a steam line is drawing. It matches the uncovering
// band the hydraulics ramps over, so the two cannot disagree about whether a
// line is on water or on vapour.
const GAS_BAND = 0.05;   // m

// The enthalpy bounds. H_FLOOR is below the triple point so subcooling has
// room; H_CEIL is above dry saturated steam at any plant pressure, so a
// runaway source saturates at a hot but finite temperature instead of
// reaching infinity. Every write into a cell or a volume passes through them,
// which is also where a NaN arriving from a host is caught: the clamp is
// written so NaN lands on the lower bound rather than passing through.
export const H_FLOOR = -1e5, H_CEIL = 4e6;   // J/kg

// Bulk modulus of liquid water, for the nodal compliance in hydraulic.js. It
// lives here because it is a property of the fluid rather than of the solve.
export const K_BULK = 2.2e9;                 // Pa

// The band over which an exchanger blends from the flowing effectiveness-NTU
// duty to the stagnant two-lump exponential. Expressed as divisors of UA so
// the knots are capacity rates: fully lumped below UA/NTU_LO, fully NTU above
// UA/NTU_HI, linear in Cmin between. Blending the DUTY rather than the
// temperature keeps bracketing, because a convex combination of two duties
// that each land inside the inlet interval also lands inside it.
export const NTU_LO = 8, NTU_HI = 2;

// Below this the flow through an edge is not a flow: it is arithmetic noise
// from a Newton step, and mixing on it would let a stopped network drift.
const M_EPS = 1e-12;                         // kg/s
// And the flow at which an edge is agreed to HAVE a direction, which is a
// different question and needs its own threshold. A microgram a second: far
// below anything a picture shows and far above the noise. See _order.
const M_DIR = 1e-9;                          // kg/s

// A volume may never be emptied completely: the last sliver of mass is what
// keeps h = U/M finite. Expressed as a fraction of the volume's own capacity
// so it scales with the network instead of being an absolute kilogram.
const M_FRAC = 1e-9;

// ---------------------------------------------------------------------------
// State: the two directions between (p, h) and (T, x)
// ---------------------------------------------------------------------------

// A single reusable record, because this is called once per cell per sub-step
// and an object literal there would allocate a hundred thousand times a
// second. A caller that wants to keep two states at once must pass its own.
const _state = { T: 288.15, x: 0, rho: 998, mu: 1e-3, cp: 4180, phase: LIQUID };
const _st2 = { T: 288.15, x: 0, rho: 998, mu: 1e-3, cp: 4180, phase: LIQUID };

// The three branches, written once. stateOf calls them after locating the
// saturation line itself; the per-cell pass in Thermal calls them after
// locating it once for a whole edge. One implementation of each, so there is
// no way for a cell and a volume to disagree about what water is.

// Subcooled liquid, and the common case by a long way. The temperature is the
// exact inverse of the same piecewise-linear enthalpy table hLiquid
// integrates, so hOf and stateOf round-trip.
function _liquid(H, out) {
  const T = tOfHLiquid(H);
  out.T = T;
  out.x = 0;
  out.rho = rhoLiquidSat(T);
  out.mu = muLiquid(T);
  out.cp = cpLiquid(T);
  out.phase = LIQUID;
  return out;
}

// Superheated. The sensible rise above dry saturated steam is taken at the
// saturated vapour cp, which is a couple of per cent out a long way from the
// line and cannot produce a temperature that is not monotone in the enthalpy.
// The cp floor stops a near-critical table value from turning a small surplus
// into a huge temperature.
function _vapour(P, H, Ts, hg, out) {
  const cpv = cpVapour(Ts);
  const T = Ts + (H - hg) / (cpv > 500 ? cpv : 500);
  out.T = T;
  out.x = 1;
  out.rho = rhoVapour(T, P);
  out.mu = muVapour(T);
  out.cp = cpv;
  out.phase = VAPOUR;
  return out;
}

// On the saturation line, where the temperature is pinned and the whole of the
// energy variable's movement is quality. This is the region a temperature
// formulation cannot see at all.
function _twoPhase(H, Ts, hf, fg, vf, vg, out) {
  const x = clamp(fg > 0 ? (H - hf) / fg : 1, 0, 1);
  out.T = Ts;
  out.x = x;
  // Homogeneous mixture: the VOLUMES add, not the densities. Averaging the
  // densities instead puts a 1 per cent void at half the water's density.
  out.rho = 1 / (vf + x * (vg - vf));
  out.mu = muLiquid(Ts) * (1 - x) + muVapour(Ts) * x;
  out.cp = cpLiquid(Ts) * (1 - x) + cpVapour(Ts) * x;
  out.phase = x >= 1 - 1e-6 ? VAPOUR : (x <= 1e-6 ? LIQUID : TWO_PHASE);
  return out;
}

// What a fluid at pressure p holding specific enthalpy h actually is. This is
// the only place in the library that decides a phase from an energy, and it
// is total: every finite or non-finite input produces a finite, bounded,
// physically ordered answer.
export function stateOf(p, h, out = _state) {
  const P = clamp(p, P_TRIPLE, P_CRIT);
  const H = clamp(h, H_FLOOR, H_CEIL);
  const Ts = tsat(P);
  const hf = hLiquid(Ts);
  // The latent heat is deliberately not computed on the liquid path: props.hfg
  // costs a pair of psat calls and would dominate the whole thermal pass if it
  // were asked for on every cell of every pipe that is nowhere near boiling.
  if (H < hf) return _liquid(H, out);
  const fg = hfg(Ts);
  if (H > hf + fg) return _vapour(P, H, Ts, hf + fg, out);
  return _twoPhase(H, Ts, hf, fg, 1 / rhoLiquidSat(Ts), 1 / rhoVapourSat(Ts), out);
}

// The enthalpy of a fluid the host describes as a temperature and a quality.
// The inverse of stateOf, used wherever the outside world hands in a
// temperature: initial conditions, imposed edge profiles, boundaries.
export function hOf(p, T, x) {
  const P = clamp(p, P_TRIPLE, P_CRIT);
  const Ts = tsat(P);
  const q = clamp(x, 0, 1);
  const t = Number.isFinite(T) ? T : Ts;
  if (q <= 0) {
    // No vapour present, so the temperature decides. Above the saturation
    // temperature with no quality is not a state water can be in, so it is
    // read as saturated liquid rather than as superheated water.
    return clamp(hLiquid(t < Ts ? t : Ts), H_FLOOR, H_CEIL);
  }
  const hf = hLiquid(Ts), fg = hfg(Ts);
  if (q >= 1 && t > Ts) {
    const cpv = cpVapour(Ts);
    return clamp(hf + fg + (cpv > 500 ? cpv : 500) * (t - Ts), H_FLOOR, H_CEIL);
  }
  return clamp(hf + q * fg, H_FLOOR, H_CEIL);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// One edge of semi-Lagrangian transport, in place.
//
//   cellH  the enthalpy array, GEOMETRIC order: index off+0 sits at pts[0]
//   off    this edge's first cell
//   N      how many cells
//   cFrac  signed cells of travel this step, mdot*dt/(rho*A*l). May exceed N.
//   hIn    the donor node's enthalpy, the value arriving at the upstream face
//   tmp    scratch of at least N, the departure buffer
//
// Every cell's new value is a linear interpolation between two samples of the
// OLD field, where a sample taken upstream of the first cell returns hIn. Both
// interpolation weights are non-negative and sum to one, so the result is a
// convex combination of {the old cells, hIn} and therefore cannot leave the
// interval they span. That is the bracketing proof, and it holds at any dt,
// because a departure point that lands a thousand cells upstream simply
// returns hIn, which is the physically right answer for a step long enough to
// flush the whole edge.
//
// The upstream face is placed one full cell ahead of the first cell centre
// rather than half a cell. That choice makes the first cell's update exactly
// the mass-weighted mixture (1-c)*own + c*arrived for c below one, which is
// what conserves energy across the inlet; putting the face at half a cell
// replaces sixty per cent of the first cell after thirty per cent of a cell
// of travel, and the edge then runs permanently hot at small dt.
export function advectEdge(cellH, off, N, cFrac, hIn, tmp) {
  const n = N | 0;
  if (!(n > 0)) return cellH;
  // NaN lands on 0 here, which makes the whole pass the identity. A step that
  // does nothing is always a safe answer; a step that propagates NaN is not.
  const c = clamp(cFrac >= 0 ? cFrac : -cFrac, 0, 1e12);
  if (c === 0) return cellH;
  const fwd = !(cFrac < 0);
  const hi = clamp(hIn, H_FLOOR, H_CEIL);
  for (let k = 0; k < n; k++) tmp[k] = cellH[off + k];
  const last = n - 1;
  for (let j = 0; j < n; j++) {
    // j counts in FLOW order; s is the departure point in flow-order cell
    // index space, so s = j is the cell's own centre and s < 0 is upstream of
    // the edge.
    const s = j - c;
    let h;
    if (s <= -1) {
      h = hi;
    } else {
      const i0 = Math.floor(s);
      const fr = s - i0;
      const i1 = i0 + 1;
      const a = i0 < 0 ? hi : tmp[fwd ? i0 : last - i0];
      const b = i1 > last ? (fwd ? tmp[last] : tmp[0]) : (i1 < 0 ? hi : tmp[fwd ? i1 : last - i1]);
      h = a + (b - a) * fr;
    }
    cellH[off + (fwd ? j : last - j)] = clamp(h, H_FLOOR, H_CEIL);
  }
  return cellH;
}

// ---------------------------------------------------------------------------
// Exchangers
// ---------------------------------------------------------------------------

// Effectiveness from the number of transfer units and the capacity ratio.
// Bounded in [0, 1] by construction, for every input including NTU of zero,
// NTU of infinity and Cr of exactly one, which are the three values the
// textbook forms divide by.
export function effNTU(NTU, Cr, arrangement) {
  const N = clamp(NTU, 0, 1e3);
  const r = clamp(Cr, 0, 1);
  if (!(N > 0)) return 0;
  let e;
  if (arrangement === 'parallel') {
    e = (1 - Math.exp(-N * (1 + r))) / (1 + r);
  } else if (arrangement === 'cross') {
    // The single-pass cross-flow correlation is singular at Cr = 0, where its
    // limit is the constant-wall-temperature answer.
    if (r < 1e-6) e = 1 - Math.exp(-N);
    else e = 1 - Math.exp((1 / r) * Math.pow(N, 0.22) * (Math.exp(-r * Math.pow(N, 0.78)) - 1));
  } else {
    // Counterflow, the default, and the arrangement of every tube bank a
    // plant draws. At Cr = 1 the closed form is 0/0 and its limit is used.
    if (r > 1 - 1e-6) e = N / (1 + N);
    else {
      const k = Math.exp(-N * (1 - r));
      e = (1 - k) / (1 - r * k);
    }
  }
  return clamp(e, 0, 1);
}

// Two lumps joined by a conductance, integrated EXACTLY: their temperature
// difference decays as a single exponential. Returns the new difference.
//
// This is the whole answer to a stagnant exchanger. exp(-k) lies in [0, 1] for
// every k >= 0, so the new difference has the same sign and a smaller
// magnitude than the old one, at any dt whatsoever; the two lumps approach
// each other and can never cross. A duty computed as UA*dT and applied
// explicitly overshoots as soon as dt exceeds the lumps' time constant, and a
// duty computed as W/UA divides by a conductance that can be zero.
export function lumpedRelax(dT, UA, Ch, Cc, dt) {
  const d = num(dT, 0);
  const ua = clamp(UA, 0, 1e15);
  const t = clamp(dt, 0, 1e12);
  if (!(ua > 0) || !(t > 0)) return d;
  // A lump with no heat capacity equilibrates instantly, which is the correct
  // degenerate limit and the reason this is written with reciprocals: an
  // infinite capacity (a boundary, the sea) contributes exactly zero.
  const ih = Ch > 1e-9 ? 1 / Ch : 1e9;
  const ic = Cc > 1e-9 ? 1 / Cc : 1e9;
  const k = ua * t * (ih + ic);
  return k >= 60 ? 0 : d * Math.exp(-k);
}

// ---------------------------------------------------------------------------
// The same pressure law hydraulic.js uses at an attachment elevation.
//
// It is repeated rather than imported because the module graph keeps
// thermal.js free of hydraulic.js, so that energy can be tested without a
// solve. IT MUST STAY IDENTICAL TO hydraulic.pAt: a cell pressure that
// disagrees with the momentum equation's puts the saturation line in a
// different place for the picture than for the flow, and steam appears in a
// pipe the solver believes is liquid.
// ---------------------------------------------------------------------------
function pAtNode(sys, i, y) {
  if (sys.ndKind[i] !== 1) return sys.ndP[i];
  const depth = sys.ndLevel[i] - y;
  return sys.ndP[i] + (depth > 0 ? sys.ndRhoL[i] * G * depth : 0);
}

// A mutable record per exchanger side. Built once and rewritten in place,
// because an object literal here would allocate once per link per sub-step.
function sideRec() {
  return {
    isEdge: 0, idx: -1, off: 0, n: 0, mdot: 0, fwd: 1,
    M: 0, cp: 4180, Tin: 288.15, Tmean: 288.15, Crate: 0, Clump: 0, teff: 0
  };
}

export class Thermal {
  constructor(sys) {
    this.sys = sys;
    // Everything below is grown in size(), which the solver calls on every
    // rebuild. Nothing in the per-frame path allocates.
    this.nodeQ = new Float64Array(0);     // W, wall duty into nodes this sub-step
    this.adjStart = new Int32Array(0);    // CSR adjacency over incident edges
    this.adj = new Int32Array(0);
    this.indeg = new Int32Array(0);
    this.queue = new Int32Array(0);
    this.done = new Uint8Array(0);
    this.sgn = new Uint8Array(0);         // memo of sign(mdot), for reordering
    this.rho0 = new Float64Array(0);      // each edge's density at the start of the sub-step
    this.memoP = new Float64Array(0);     // the (p, h) a junction state was last derived from
    this.memoH = new Float64Array(0);
    this.tmp = new Float64Array(0);       // the departure buffer
    this.wt = new Float64Array(0);        // heat profile weights
    this.ndCx = new Float64Array(0);      // node centres, for pour placement
    this.ndCz = new Float64Array(0);
    this.endX0 = new Float64Array(0);     // edge end positions, for the same
    this.endZ0 = new Float64Array(0);
    this.endX1 = new Float64Array(0);
    this.endZ1 = new Float64Array(0);
    this.hlKind = new Int32Array(0);      // 0 source, 1 exchanger, 2 ambient
    this.hlSign = new Float64Array(0);    // -1 for a sink, +1 for a source
    this.hlAEdge = new Uint8Array(0);
    this.hlA = new Int32Array(0);
    this.hlBEdge = new Uint8Array(0);
    this.hlB = new Int32Array(0);
    this.hlObj = [];                      // the live JSON objects, read each pass
    this.egHeated = new Uint8Array(0);    // this edge is touched by a heat link
    this._sa = sideRec();
    this._sb = sideRec();
    this._E = 0;            // total energy at the end of the last sub-step, J
    this._hasOrder = false;
    this._wallE = 0;        // J the walls put in during this sub-step, signed
    this._fluxE = 0;        // J that crossed a boundary node during it, signed
    this._wallAbs = 0;      // the same two, summed as MAGNITUDES, which is the
    this._fluxAbs = 0;      // scale the residual below is honestly measured on
    this._resNum = 0;
    this._resDen = 0;
    this._spill = 0;
    this._starved = 0;
    this.dMassVolumes = 0;  // kg, change in volume inventory this step
    this.size();
  }

  // (Re)allocate after a rebuild, and cache everything that would otherwise
  // have to be parsed or looked up by string inside the frame path.
  size() {
    const sys = this.sys;
    const nN = sys.nNodes | 0, nE = sys.nEdges | 0, nH = sys.nHeat | 0;
    this.nodeQ = growF64(this.nodeQ, nN);
    this.indeg = growI32(this.indeg, nN);
    this.queue = growI32(this.queue, nN);
    this.done = growU8(this.done, nN);
    this.sgn = growU8(this.sgn, nE);
    // A rebuild may reuse an index for a different node, so the memo starts
    // empty: NaN never equals anything, so every junction is recomputed once.
    this.rho0 = growF64(this.rho0, nE);
    this.memoP = growF64(this.memoP, nN); this.memoP.fill(NaN);
    this.memoH = growF64(this.memoH, nN); this.memoH.fill(NaN);
    this.ndCx = growF64(this.ndCx, nN);
    this.ndCz = growF64(this.ndCz, nN);
    this.endX0 = growF64(this.endX0, nE);
    this.endZ0 = growF64(this.endZ0, nE);
    this.endX1 = growF64(this.endX1, nE);
    this.endZ1 = growF64(this.endZ1, nE);
    this.egHeated = growU8(this.egHeated, nE);
    this.adjStart = growI32(this.adjStart, nN + 1);
    this.adj = growI32(this.adj, nE * 2);

    let maxCells = 4;
    for (let e = 0; e < nE; e++) if (sys.egCells[e] > maxCells) maxCells = sys.egCells[e];
    // sys.cellTmp is sized for the largest legal cell count, but a Sys built
    // by hand in a test may not carry one, so a private buffer stands in.
    this.tmp = (sys.cellTmp && sys.cellTmp.length >= maxCells)
      ? sys.cellTmp : growF64(this.tmp, maxCells);
    this.wt = (sys.wtmp && sys.wtmp.length >= maxCells)
      ? sys.wtmp : growF64(this.wt, maxCells);

    this._buildAdjacency(nN, nE);
    this._cachePositions(nN, nE);
    this._resolveHeat(nH);
  }

  // Incident edges per node in compressed row form. A volume's inventory and a
  // junction's mixing both walk their own edges, and scanning every edge for
  // every node is the one place this module could accidentally become
  // quadratic.
  _buildAdjacency(nN, nE) {
    const sys = this.sys, start = this.adjStart, adj = this.adj;
    for (let i = 0; i <= nN; i++) start[i] = 0;
    for (let e = 0; e < nE; e++) {
      const a = sys.egFrom[e], b = sys.egTo[e];
      if (a >= 0 && a < nN) start[a + 1]++;
      if (b >= 0 && b < nN) start[b + 1]++;
    }
    for (let i = 0; i < nN; i++) start[i + 1] += start[i];
    for (let i = 0; i < nN; i++) this.indeg[i] = start[i];
    for (let e = 0; e < nE; e++) {
      const a = sys.egFrom[e], b = sys.egTo[e];
      if (a >= 0 && a < nN) adj[this.indeg[a]++] = e;
      if (b >= 0 && b < nN) adj[this.indeg[b]++] = e;
    }
  }

  // Where each node and each edge end sits horizontally, so a pipe discharging
  // above a pool can tell the free surface WHERE the water lands. Sys carries
  // elevations only, because nothing in the solve needs x and z; they are read
  // once here from the network rather than every frame.
  _cachePositions(nN, nE) {
    const sys = this.sys, net = sys.net;
    for (let i = 0; i < nN; i++) { this.ndCx[i] = 0; this.ndCz[i] = 0; }
    for (let e = 0; e < nE; e++) {
      this.endX0[e] = 0; this.endZ0[e] = 0; this.endX1[e] = 0; this.endZ1[e] = 0;
    }
    if (!net || typeof net.node !== 'function') return;
    const nodeIds = sys.nodeIds ? sys.nodeIds.ids() : null;
    if (nodeIds) {
      for (let i = 0; i < nN && i < nodeIds.length; i++) {
        const nd = net.node(nodeIds[i]);
        const at = nd && nd.at;
        if (at) { this.ndCx[i] = num(at[0], 0); this.ndCz[i] = num(at[2], 0); }
      }
    }
    const edgeIds = sys.edgeIds ? sys.edgeIds.ids() : null;
    if (edgeIds) {
      for (let e = 0; e < nE && e < edgeIds.length; e++) {
        const ed = net.edge(edgeIds[e]);
        const pts = ed && ed.pts;
        if (pts && pts.length >= 2) {
          const a = pts[0], b = pts[pts.length - 1];
          this.endX0[e] = num(a[0], 0); this.endZ0[e] = num(a[2], 0);
          this.endX1[e] = num(b[0], 0); this.endZ1[e] = num(b[2], 0);
        }
      }
    }
  }

  // Turn "edge:cooler" into an index, once. Doing it per sub-step would mean a
  // string slice per heat link per sub-step, which is an allocation in the
  // frame path and the one thing this design refuses.
  _resolveHeat(nH) {
    const sys = this.sys;
    this.hlKind = growI32(this.hlKind, nH);
    this.hlSign = growF64(this.hlSign, nH);
    this.hlAEdge = growU8(this.hlAEdge, nH);
    this.hlA = growI32(this.hlA, nH);
    this.hlBEdge = growU8(this.hlBEdge, nH);
    this.hlB = growI32(this.hlB, nH);
    this.hlObj.length = 0;
    for (let e = 0; e < (sys.nEdges | 0); e++) this.egHeated[e] = 0;
    const net = sys.net;
    const ids = (nH > 0 && sys.heatIds) ? sys.heatIds.ids() : null;
    for (let k = 0; k < nH; k++) {
      const link = (ids && net && typeof net.heatLink === 'function') ? net.heatLink(ids[k]) : null;
      this.hlObj.push(link || null);
      this.hlKind[k] = 0;
      this.hlSign[k] = 1;
      this.hlAEdge[k] = 0; this.hlA[k] = -1;
      this.hlBEdge[k] = 0; this.hlB[k] = -1;
      if (!link) continue;
      const kind = link.kind;
      if (kind === 'exchanger') {
        this.hlKind[k] = 1;
        this._target(k, link.hot, 0);
        this._target(k, link.cold, 1);
      } else if (kind === 'ambient') {
        this.hlKind[k] = 2;
        this._target(k, link.on, 0);
      } else {
        this.hlKind[k] = 0;
        // A sink is sugar for a source with the sign turned round. Handling it
        // here rather than at load means a network that keeps the word "sink"
        // still reads correctly.
        this.hlSign[k] = kind === 'sink' ? -1 : 1;
        this._target(k, link.on, 0);
      }
    }
  }

  _target(k, spec, side) {
    const sys = this.sys;
    if (typeof spec !== 'string') return;
    const c = spec.indexOf(':');
    if (c < 0) return;
    const isEdge = spec.charCodeAt(0) === 101 /* 'e' */ && spec.slice(0, c) === 'edge';
    const id = spec.slice(c + 1);
    const idx = isEdge
      ? (sys.edgeIds ? sys.edgeIds.index(id) : -1)
      : (sys.nodeIds ? sys.nodeIds.index(id) : -1);
    if (side === 0) { this.hlAEdge[k] = isEdge ? 1 : 0; this.hlA[k] = idx; }
    else { this.hlBEdge[k] = isEdge ? 1 : 0; this.hlB[k] = idx; }
    if (isEdge && idx >= 0) this.egHeated[idx] = 1;
  }

  // How many sub-steps this step needs, from the PREVIOUS step's flows: two
  // per volume turnover, so a tank that would empty in one step gets eight
  // bites at it. Also the once-per-step hook where the accumulators that
  // report a whole step are cleared, because it is the only method the solver
  // calls exactly once outside the sub-loop.
  subcycles(dt) {
    const sys = this.sys, nN = sys.nNodes | 0;
    this._resNum = 0;
    this._resDen = 0;
    this._spill = 0;
    this._starved = 0;
    this.dMassVolumes = 0;
    const maxSub = Math.max(1, Math.round(num(sys.opts && sys.opts.maxSub, 8)));
    const t = clamp(dt, 0, 1e12);
    let worst = 0;
    for (let i = 0; i < nN; i++) {
      if (sys.ndKind[i] !== 1) continue;
      const M = sys.ndM[i];
      if (!(M > 0)) continue;
      let out = 0;
      const s0 = this.adjStart[i], s1 = this.adjStart[i + 1];
      for (let a = s0; a < s1; a++) {
        const e = this.adj[a];
        if (!sys.egOpen[e]) continue;
        const m = sys.egMdot[e];
        if (sys.egFrom[e] === i) { if (m > 0) out += m; }
        else if (m < 0) out -= m;
      }
      const r = out * t / M;
      if (r > worst) worst = r;
    }
    // Volume turnover, and then EDGE TURNOVER on any edge a heat link touches.
    //
    // Transport has no stability limit in dt and needs no sub-step to stay
    // standing, which is why the spec asks only for the volume term. But wall
    // heat is split from transport, and once a step flushes a whole heated
    // edge the split loses which fluid picked up which watts: the cell at the
    // outlet is given only its own share of the axial profile instead of
    // everything the parcel gathered on its way down the pipe. With the cos
    // profile of examples/loop.json that made the heater outlet read 21.7 C at
    // dt = 10 s against 30.9 C at dt = 0.1 s, and dt independence is an
    // invariant. Holding one edge turnover per sub-step restores it.
    //
    // It costs nothing at a frame rate. A 60 Hz host moves the water a few
    // hundredths of an edge per step and stays at one sub-step; only a
    // fast-forward tool taking seconds at a time pays, and maxSub still caps
    // what it pays. Unheated edges are not counted, because an edge nothing
    // heats carries its enthalpy through whatever the step size.
    for (let e = 0; e < (this.sys.nEdges | 0); e++) {
      if (!this.egHeated[e] || !sys.egOpen[e]) continue;
      const M = this._mass(e);
      if (!(M > 0)) continue;
      const m = sys.egMdot[e] >= 0 ? sys.egMdot[e] : -sys.egMdot[e];
      const r = 0.5 * m * t / M;    // halved, because the volume term below doubles
      if (r > worst) worst = r;
    }
    const n = Math.ceil(2 * worst);
    return clamp(n, 1, maxSub) | 0;
  }

  // -------------------------------------------------------------------------
  // 1. Node mixing. Runs first in every sub-step.
  // -------------------------------------------------------------------------
  mixNodes() {
    const sys = this.sys, nN = sys.nNodes | 0;
    this._order();
    const order = sys.ndOrder;
    for (let k = 0; k < nN; k++) {
      const i = order[k];
      if (i < 0 || i >= nN || sys.ndKind[i] !== 0) continue;
      let sumW = 0, sumWH = 0, count = 0, lastH = 0;
      const s0 = this.adjStart[i], s1 = this.adjStart[i + 1];
      for (let a = s0; a < s1; a++) {
        const e = this.adj[a];
        if (!sys.egOpen[e]) continue;
        const m = sys.egMdot[e];
        const into = sys.egTo[e] === i ? m : -m;
        if (!(into > M_EPS)) continue;
        const off = sys.egOff[e], n = sys.egCells[e];
        // The enthalpy delivered is the one in the cell at the far end of the
        // edge from the flow's point of view, which is the cell touching this
        // node.
        const h = sys.egTo[e] === i ? sys.cellH[off + n - 1] : sys.cellH[off];
        sumW += into;
        sumWH += into * h;
        lastH = h;
        count++;
      }
      if (count === 1) {
        // ONE inlet, so the junction IS that inlet. Assigned, not divided:
        // (m*h)/m is not bit-identical to h in floating point, and a chain of
        // degree-2 junctions would then drift by an ulp per joint. Assignment
        // is what makes "no step at a joint" exact rather than close.
        sys.ndH[i] = lastH;
      } else if (count > 1 && sumW > 0) {
        // Two or more inlets is a mixer, and a genuine step there is
        // physically real: cold water meeting hot water does have a
        // discontinuity at the tee.
        sys.ndH[i] = clamp(sumWH / sumW, H_FLOOR, H_CEIL);
      }
      // With no inflow at all the junction keeps what it had. It has no
      // thermal mass to change it with.
      //
      // Deriving the state is the single most expensive thing this pass does
      // when the water is boiling, so it is skipped when neither the pressure
      // nor the enthalpy has moved by even one bit. That is an exact test, not
      // a tolerance: a settled network pays nothing, and anything that changes
      // is recomputed in full.
      if (sys.ndP[i] === this.memoP[i] && sys.ndH[i] === this.memoH[i]) continue;
      this.memoP[i] = sys.ndP[i];
      this.memoH[i] = sys.ndH[i];
      const st = stateOf(sys.ndP[i], sys.ndH[i], _state);
      sys.ndT[i] = st.T;
      sys.ndX[i] = st.x;
      sys.ndRho[i] = st.rho;
      sys.ndRhoL[i] = st.x <= 0 ? st.rho : rhoLiquidSat(st.T);
    }
  }

  // Kahn's algorithm over the digraph the flow signs induce, restricted to
  // junctions. Recomputed only when a sign changes, because the order is
  // stable for as long as the flow directions are.
  //
  // The order does not change the answer today, since a junction reads edge
  // cells that transport has not yet touched this sub-step. It is kept because
  // it is the contract in Sys, because it costs nothing when nothing reverses,
  // and because it is what a future pass that propagates a mixture along a
  // chain within one sub-step would need.
  _order() {
    const sys = this.sys, nN = sys.nNodes | 0, nE = sys.nEdges | 0;
    let changed = false;
    // WHICH WAY EACH EDGE POINTS, WITH HYSTERESIS, and the hysteresis is what
    // makes the early-out below worth having. A bare threshold made the
    // direction of an edge carrying a hundred-billionth of a gram a second
    // flip on the noise of the last Newton step, and every flip rebuilt the
    // whole order: measured on a fifteen-loop ladder, eleven thousand flips in
    // two thousand steps, on flows between 2e-16 and 4e-11 kg/s, sorting the
    // graph again on every other sub-step for a flow no instrument could see.
    // A direction is established at a microgram a second, lost below the noise
    // floor, and kept through the band between them, which is the same shape
    // as the moving/still hysteresis the read surface uses and for the same
    // reason. Register line P10.
    for (let e = 0; e < nE; e++) {
      const m = sys.egMdot[e];
      const a = m >= 0 ? m : -m;
      let s;
      if (!sys.egOpen[e] || !(a > M_EPS)) s = 0;
      else if (a >= M_DIR) s = m >= 0 ? 1 : 2;
      else s = this.sgn[e];
      if (this.sgn[e] !== s) { this.sgn[e] = s; changed = true; }
    }
    if (!changed && this._hasOrder) return;
    this._hasOrder = true;
    const indeg = this.indeg, queue = this.queue, done = this.done, order = sys.ndOrder;
    for (let i = 0; i < nN; i++) { indeg[i] = 0; done[i] = 0; }
    for (let e = 0; e < nE; e++) {
      const s = this.sgn[e];
      if (s === 0) continue;
      const src = s === 1 ? sys.egFrom[e] : sys.egTo[e];
      const dst = s === 1 ? sys.egTo[e] : sys.egFrom[e];
      // Only a junction upstream is a dependency. A volume or a boundary
      // already knows its own enthalpy, so it never has to be visited first.
      if (sys.ndKind[dst] === 0 && sys.ndKind[src] === 0) indeg[dst]++;
    }
    let head = 0, tail = 0, w = 0;
    for (let i = 0; i < nN; i++) {
      if (sys.ndKind[i] !== 0) { order[w++] = i; done[i] = 1; continue; }
      if (indeg[i] === 0) { queue[tail++] = i; done[i] = 1; }
    }
    for (;;) {
      while (head < tail) {
        const i = queue[head++];
        order[w++] = i;
        const s0 = this.adjStart[i], s1 = this.adjStart[i + 1];
        for (let a = s0; a < s1; a++) {
          const e = this.adj[a];
          const s = this.sgn[e];
          if (s === 0) continue;
          const src = s === 1 ? sys.egFrom[e] : sys.egTo[e];
          if (src !== i) continue;
          const dst = s === 1 ? sys.egTo[e] : sys.egFrom[e];
          if (sys.ndKind[dst] !== 0 || done[dst]) continue;
          if (--indeg[dst] <= 0) { queue[tail++] = dst; done[dst] = 1; }
        }
      }
      // Anything left is in a cycle, which is what a loop with no volume in it
      // looks like. Break it at the largest flow: that node takes its inlet
      // from the previous sub-step, a lag of one sub-step that affects
      // accuracy and never the joint invariant.
      let best = -1, bestM = -1;
      for (let i = 0; i < nN; i++) {
        if (done[i] || sys.ndKind[i] !== 0) continue;
        const s0 = this.adjStart[i], s1 = this.adjStart[i + 1];
        for (let a = s0; a < s1; a++) {
          const e = this.adj[a];
          const s = this.sgn[e];
          if (s === 0) continue;
          const dst = s === 1 ? sys.egTo[e] : sys.egFrom[e];
          if (dst !== i) continue;
          const m = Math.abs(sys.egMdot[e]);
          if (m > bestM) { bestM = m; best = i; }
        }
      }
      if (best < 0) break;
      indeg[best] = 0;
      queue[tail++] = best;
      done[best] = 1;
    }
    // Any node the walk never reached (an isolated junction with no flow at
    // all) still has to appear, or the mixing pass would skip it for ever.
    for (let i = 0; i < nN; i++) if (!done[i]) { order[w++] = i; done[i] = 1; }
  }

  // -------------------------------------------------------------------------
  // 2. Transport
  // -------------------------------------------------------------------------
  advect(dt) {
    const sys = this.sys, nE = sys.nEdges | 0;
    const t = clamp(dt, 0, 1e12);
    // The energy books for this sub-step open here, because mixing a junction
    // moves no energy: a junction has no mass to hold any.
    this._wallE = 0;
    this._fluxE = 0;
    this._wallAbs = 0;
    this._fluxAbs = 0;
    let E = 0;
    for (let e = 0; e < nE; e++) {
      const off = sys.egOff[e], n = sys.egCells[e] | 0;
      if (n <= 0) continue;
      // An edge is an incompressible conduit: it holds no mass inventory of
      // its own, so the mass its cells are weighted by is frozen for the whole
      // sub-step. Letting it move with the density would make water that
      // simply warmed up look like energy leaving the system, and the residual
      // would report a leak that is really a property lookup.
      this.rho0[e] = sys.egRho[e];
      const m0 = this._mass(e) / n;
      for (let j = 0; j < n; j++) E += m0 * sys.cellH[off + j];
      if (sys.egTHoldOn && sys.egTHoldOn[e]) {
        // The host owns this edge's temperature. Laying a linear ramp in
        // enthalpy rather than blending towards one keeps the readback
        // bit-identical at the ends, which is what imposition means.
        const pA = pAtNode(sys, sys.egFrom[e], sys.egYFrom[e]);
        const pB = pAtNode(sys, sys.egTo[e], sys.egYTo[e]);
        const T0 = sys.egTHold[2 * e], T1 = sys.egTHold[2 * e + 1];
        for (let j = 0; j < n; j++) {
          const u = (j + 0.5) / n;
          sys.cellH[off + j] = hOf(lerp(pA, pB, u), lerp(T0, T1, u), 0);
        }
        continue;
      }
      const rho = sys.egRho[e] > 1e-3 ? sys.egRho[e] : 1e-3;
      const A = sys.egA[e] > 1e-12 ? sys.egA[e] : 1e-12;
      const L = sys.egL[e] > 1e-9 ? sys.egL[e] : 1e-9;
      const mCell = rho * A * (L / n);
      // A closed edge carries mdot exactly zero, so cFrac is exactly zero and
      // the pass is the identity. There is no branch for a stopped flow
      // because there does not need to be one.
      const cFrac = sys.egMdot[e] * t / mCell;
      const donor = sys.egMdot[e] >= 0 ? sys.egFrom[e] : sys.egTo[e];
      // WHAT A STEAM LINE DRAWS IS STEAM. Its nozzle stands in the gas space
      // above a free surface, so what arrives at the pipe is saturated vapour
      // at the vessel's own temperature, not the vessel's MIXED enthalpy,
      // which is mostly the water underneath and would send a line of nearly
      // cold liquid to a turbine.
      const fl = sys.egFluid ? sys.egFluid[e] : null;
      const hIn = (fl && fl.vapour && sys.ndFree[donor])
        ? hVapour(sys.ndT[donor])
        : sys.ndH[donor];
      advectEdge(sys.cellH, off, n, cFrac, hIn, this.tmp);
    }
    const nN = sys.nNodes | 0;
    for (let i = 0; i < nN; i++) if (sys.ndKind[i] === 1) E += sys.ndM[i] * sys.ndH[i];
    this._E = E;
  }

  // -------------------------------------------------------------------------
  // 3. Wall heat, after transport (operator splitting)
  // -------------------------------------------------------------------------
  wall(dt) {
    const sys = this.sys, nH = sys.nHeat | 0, nN = sys.nNodes | 0;
    const t = clamp(dt, 0, 1e12);
    for (let i = 0; i < nN; i++) this.nodeQ[i] = 0;
    if (nH <= 0 || !(t > 0)) return;
    // Only the edges a link actually touches need their cell temperatures
    // refreshed before the duties are worked out; the rest are refreshed once
    // at the end of the sub-step.
    for (let e = 0; e < (sys.nEdges | 0); e++) if (this.egHeated[e]) this._refresh(e);
    for (let k = 0; k < nH; k++) {
      const link = this.hlObj[k];
      if (!link) continue;
      const kind = this.hlKind[k];
      // Each link's own duty is measured as it is applied and added to the
      // MAGNITUDE total as well as to the signed one. A loop that puts two
      // megawatts in at the bottom and takes two megawatts out at the top has
      // a signed wall total of nearly zero, and dividing the energy imbalance
      // by that number reported a residual of 1.0 for a network in perfect
      // balance. The gross duty is the scale the imbalance actually means
      // something against.
      const w0 = this._wallE;
      if (kind === 1) this._exchanger(k, link, t);
      else if (kind === 2) this._ambient(k, link, t);
      else this._source(k, link, t);
      const dw = this._wallE - w0;
      this._wallAbs += dw >= 0 ? dw : -dw;
    }
  }

  // A source or a sink: watts spread along the cells by the axial profile.
  //
  // The duty is applied over teff = min(dt, the residence time), so a step
  // longer than the fluid takes to cross the edge delivers exactly W/mdot per
  // kilogram rather than W*dt to whatever happens to be resident. The steady
  // state is then the same at dt = 1 ms and at dt = 10 s, which is the
  // dt-independence invariant, and a heated edge with no flow simply climbs
  // until the enthalpy ceiling stops it.
  _source(k, link, dt) {
    const sys = this.sys;
    const W = num(link.W, 0) * this.hlSign[k];
    if (W === 0) return;
    // A SOURCE OR SINK AIMED AT A NODE IS SOLVER'S, NOT OURS. solver.js fills
    // sys.ndQ once per sub-step from every source, sink and ambient link that
    // targets a node, because section 7 gives it ndQ, and volumes() below adds
    // ndQ to the node's energy. Applying it here as well put the same watts in
    // twice: a heated tank warmed at double the rate the document asked for.
    // Only a volume could take it anyway, since a boundary is held for ever
    // and a junction has exactly zero thermal mass by design.
    if (!this.hlAEdge[k]) return;
    const e = this.hlA[k];
    if (e < 0) return;
    if (sys.egTHoldOn && sys.egTHoldOn[e]) return;
    const n = sys.egCells[e] | 0, off = sys.egOff[e];
    if (n <= 0) return;
    const M = this._mass(e);
    const teff = this._teff(e, M, dt);
    this._profile(link, n, this.wt);
    const mCell = M / n;
    for (let j = 0; j < n; j++) {
      const dh = W * this.wt[j] * teff / mCell;
      const before = sys.cellH[off + j];
      const after = clamp(before + dh, H_FLOOR, H_CEIL);
      sys.cellH[off + j] = after;
      // Counted as what was actually deposited, not as W*teff. The two differ
      // only when the ceiling has caught a runaway, and counting the deposit
      // keeps the energy residual honest about a source that saturated.
      this._wallE += mCell * (after - before);
    }
  }

  // Loss to the surroundings: Q = U * perim * L * (T - Tinf), integrated as an
  // exponential approach rather than as an explicit duty, so a thin pipe left
  // alone for an hour ends at ambient instead of oscillating about it.
  _ambient(k, link, dt) {
    const sys = this.sys;
    const U = clamp(num(link.U, 0), 0, 1e9);
    const perim = clamp(num(link.perim, 0), 0, 1e6);
    const Tinf = num(link.Tinf, 288.15);
    if (!(U > 0) || !(perim > 0)) return;
    // As with a source, an ambient link on a NODE belongs to solver.js, which
    // puts the same exponential relaxation into sys.ndQ once per sub-step.
    // Doing it here too would cool the node twice as fast as the document says.
    if (!this.hlAEdge[k]) return;
    const e = this.hlA[k];
    if (e < 0) return;
    if (sys.egTHoldOn && sys.egTHoldOn[e]) return;
    const n = sys.egCells[e] | 0, off = sys.egOff[e];
    if (n <= 0) return;
    const M = this._mass(e);
    const teff = this._teff(e, M, dt);
    const mCell = M / n;
    const L = sys.egL[e] > 1e-9 ? sys.egL[e] : 1e-9;
    const UAcell = U * perim * (L / n);
    for (let j = 0; j < n; j++) {
      const T = sys.cellT[off + j];
      const cp = _cpOf(T, sys.cellX[off + j]);
      const C = mCell * cp;
      const dT2 = lumpedRelax(T - Tinf, UAcell, C, Infinity, teff);
      const dh = (Tinf + dT2 - T) * cp;
      sys.cellH[off + j] = clamp(sys.cellH[off + j] + dh, H_FLOOR, H_CEIL);
      this._wallE += mCell * dh;
    }
  }

  // An exchanger, as one duty computed two ways and blended.
  //
  // The flowing answer is effectiveness-NTU, which is exact for a steady
  // counterflow bank and has eps in [0, 1] by construction. The stagnant
  // answer is the exact two-lump exponential. Neither can overshoot, and the
  // blend is a convex combination of two duties, so neither can the blend:
  // no cell leaving an exchanger lies outside the interval spanned by the two
  // inlets, at any dt and any flow including zero. That is the bracketing
  // invariant, and it is a proof rather than a clamp.
  _exchanger(k, link, dt) {
    const sys = this.sys;
    const UA = clamp(num(link.UA, 0), 0, 1e12);
    const a = this._sa, b = this._sb;
    if (!this._side(a, this.hlAEdge[k], this.hlA[k], dt)) return;
    if (!this._side(b, this.hlBEdge[k], this.hlB[k], dt)) return;
    if (!(UA > 0)) return;
    // Cmin is taken over the FLOWING sides only. A vessel presents no capacity
    // rate at all, and treating its absence as an infinite rate would make two
    // vessels joined by an exchanger never exchange.
    let Cmin, Cmax;
    if (a.isEdge && b.isEdge) {
      Cmin = a.Crate < b.Crate ? a.Crate : b.Crate;
      Cmax = a.Crate < b.Crate ? b.Crate : a.Crate;
    } else if (a.isEdge || b.isEdge) {
      Cmin = a.isEdge ? a.Crate : b.Crate;
      Cmax = Infinity;               // a vessel is a reservoir, not a stream
    } else {
      Cmin = 0;                      // nothing flows, so nothing has a rate
      Cmax = Infinity;
    }
    if (!(Cmin >= 0)) Cmin = 0;
    const Cr = (Cmax > 0 && Cmax < Infinity) ? clamp(Cmin / Cmax, 0, 1) : 0;
    const NTU = Cmin > 0 ? UA / Cmin : 1e3;
    const eps = effNTU(NTU, Cr, link.arrangement);
    // The flowing duty is driven by the INLET difference, which is what
    // effectiveness-NTU is defined against.
    const Qntu = eps * Cmin * (a.Tin - b.Tin);
    // The stagnant duty is driven by what is actually sitting in the two
    // bodies, because with no flow there are no inlets.
    const dTl = a.Tmean - b.Tmean;
    const dTl2 = lumpedRelax(dTl, UA, a.Clump, b.Clump, dt);
    let Ceff = 0;
    if (a.Clump < Infinity && b.Clump < Infinity) Ceff = (a.Clump * b.Clump) / Math.max(1e-9, a.Clump + b.Clump);
    else if (a.Clump < Infinity) Ceff = a.Clump;
    else if (b.Clump < Infinity) Ceff = b.Clump;
    const Qlump = dt > 0 ? (dTl - dTl2) * Ceff / dt : 0;
    const lo = UA / NTU_LO, hi = UA / NTU_HI;
    const w = clamp((Cmin - lo) / Math.max(1e-30, hi - lo), 0, 1);
    const Q = Qlump + (Qntu - Qlump) * w;
    if (!Number.isFinite(Q) || Q === 0) return;
    this._applySide(a, -Q, b, dt);
    this._applySide(b, Q, a, dt);
  }

  // Fill a side record. Returns false when the side does not exist.
  _side(s, isEdge, idx, dt) {
    const sys = this.sys;
    s.isEdge = isEdge ? 1 : 0;
    s.idx = idx;
    if (idx < 0) return false;
    if (isEdge) {
      const n = sys.egCells[idx] | 0;
      if (n <= 0) return false;
      const m = sys.egMdot[idx];
      s.off = sys.egOff[idx];
      s.n = n;
      s.mdot = m;
      s.fwd = m >= 0 ? 1 : 0;
      s.M = this._mass(idx);
      const donor = m >= 0 ? sys.egFrom[idx] : sys.egTo[idx];
      s.Tin = sys.ndT[donor];
      let ts = 0, cps = 0;
      for (let j = 0; j < n; j++) {
        ts += sys.cellT[s.off + j];
        cps += _cpOf(sys.cellT[s.off + j], sys.cellX[s.off + j]);
      }
      s.Tmean = ts / n;
      s.cp = cps / n;
      s.Crate = Math.abs(m) * s.cp;
      s.Clump = s.M * s.cp;
      s.teff = this._teff(idx, s.M, dt);
      return !(sys.egTHoldOn && sys.egTHoldOn[idx]);
    }
    s.n = 0;
    s.mdot = 0;
    s.M = sys.ndM[idx];
    s.cp = _cpOf(sys.ndT[idx], sys.ndX[idx]);
    s.Tin = sys.ndT[idx];
    s.Tmean = sys.ndT[idx];
    // A node offers no flow through the exchanger. A boundary is infinite in
    // both senses: its temperature is held and its capacity is unbounded.
    s.Crate = Infinity;
    s.Clump = sys.ndKind[idx] === 2 ? Infinity : s.M * s.cp;
    s.teff = dt;
    return true;
  }

  // Put a duty into one side, as a fraction of each cell's own distance from
  // its partner rather than as a flat rise.
  //
  // The fraction f is a single scalar chosen so the total energy delivered is
  // exactly Q*teff, and it is clamped into [0, 1]; each cell then moves f of
  // the way towards the cell it faces, which is a convex combination and so
  // cannot cross it. That is what draws the change ALONG the run, which is the
  // owner's rule: a heat exchanger goes in hot and comes out cold with the
  // change spread down its own length, never as a step at the end.
  _applySide(s, Q, other, dt) {
    const sys = this.sys;
    if (s.idx < 0) return;
    if (!s.isEdge) {
      // A boundary is held for ever and a junction has no thermal mass, so
      // neither can take a duty. Only a volume can.
      if (sys.ndKind[s.idx] !== 1) return;
      const dTp = other.Tmean - sys.ndT[s.idx];
      const C = s.M * s.cp;
      const qmax = dt > 0 ? C * dTp / dt : 0;
      // Never past the partner: the largest duty that is physically available
      // is the one that lands exactly on it.
      let q = 0;
      if (Q > 0 && qmax > 0) q = Q < qmax ? Q : qmax;
      else if (Q < 0 && qmax < 0) q = Q > qmax ? Q : qmax;
      this.nodeQ[s.idx] += q;
      this._wallE += q * dt;
      return;
    }
    const n = s.n, off = s.off;
    let sumD = 0;
    for (let j = 0; j < n; j++) sumD += this._partnerT(s, other, j) - sys.cellT[off + j];
    const dMean = sumD / n;
    const denom = s.M * s.cp * dMean;
    const f = clamp(Q * s.teff / denom, 0, 1);
    if (!(f > 0)) return;
    const mCell = s.M / n;
    for (let j = 0; j < n; j++) {
      const T = sys.cellT[off + j];
      const cp = _cpOf(T, sys.cellX[off + j]);
      const dh = f * cp * (this._partnerT(s, other, j) - T);
      sys.cellH[off + j] = clamp(sys.cellH[off + j] + dh, H_FLOOR, H_CEIL);
      this._wallE += mCell * dh;
    }
  }

  // Which cell of the other side this cell faces. Hot cell j pairs with cold
  // cell N-1-j IN FLOW ORDER, so a counterflow bank really is counterflow
  // whichever way round the two edges happen to be drawn.
  _partnerT(s, other, j) {
    const sys = this.sys;
    if (!other.isEdge) return other.Tmean;
    const jj = s.fwd ? j : s.n - 1 - j;                       // this side, flow order
    const u = (jj + 0.5) / s.n;
    const v = 1 - u;                                          // counterflow
    let kk = Math.floor(v * other.n);
    kk = kk < 0 ? 0 : (kk > other.n - 1 ? other.n - 1 : kk);
    const g = other.fwd ? kk : other.n - 1 - kk;              // back to geometric
    return sys.cellT[other.off + g];
  }

  // Axial power shape, normalised to sum one. "cos" is the chopped cosine a
  // reactor channel has; an explicit array is resampled onto the cell count so
  // a shape written for one resolution survives a change of cells.
  _profile(link, n, out) {
    const p = link.profile;
    let s = 0;
    if (p === 'cos') {
      for (let j = 0; j < n; j++) { const w = Math.sin(Math.PI * (j + 0.5) / n); out[j] = w; s += w; }
    } else if (Array.isArray(p) && p.length > 0) {
      for (let j = 0; j < n; j++) {
        let idx = Math.floor(j * p.length / n);
        idx = idx < 0 ? 0 : (idx >= p.length ? p.length - 1 : idx);
        const w = num(p[idx], 0);
        out[j] = w >= 0 ? w : -w;
        s += out[j];
      }
    } else {
      for (let j = 0; j < n; j++) { out[j] = 1; s += 1; }
    }
    if (!(s > 0)) { for (let j = 0; j < n; j++) out[j] = 1 / n; return; }
    const inv = 1 / s;
    for (let j = 0; j < n; j++) out[j] *= inv;
  }

  // The fluid mass an edge holds, and the time a wall has to act on it.
  _mass(e) {
    const sys = this.sys;
    const rho = sys.egRho[e] > 1e-3 ? sys.egRho[e] : 1e-3;
    const A = sys.egA[e] > 1e-12 ? sys.egA[e] : 1e-12;
    const L = sys.egL[e] > 1e-9 ? sys.egL[e] : 1e-9;
    return rho * A * L;
  }

  // min(dt, the residence time), written without a division by a flow that
  // can be zero. A NaN mass flow makes the ratio NaN, the comparison false,
  // and teff simply dt, which is the safe branch.
  _teff(e, M, dt) {
    const c = Math.abs(this.sys.egMdot[e]) * dt / M;
    return c > 1 ? dt / c : dt;
  }

  // -------------------------------------------------------------------------
  // 4. Volumes: mass, energy, level, and what boils
  // -------------------------------------------------------------------------
  volumes(dt) {
    const sys = this.sys, nN = sys.nNodes | 0;
    const t = clamp(dt, 0, 1e12);
    let starved = 0;
    for (let i = 0; i < nN; i++) {
      if (sys.ndKind[i] !== 1) continue;      // junctions hold nothing, boundaries are held
      const M = sys.ndM[i] > 0 ? sys.ndM[i] : 0;
      const Mfloor = M_FRAC * (sys.ndMmax[i] > 0 ? sys.ndMmax[i] : 0);
      const s0 = this.adjStart[i], s1 = this.adjStart[i + 1];

      let fin = 0, fout = 0, finH = 0, foutH = 0, foutVap = 0;
      let pour = 0, pourPos = 0;
      for (let a = s0; a < s1; a++) {
        const e = this.adj[a];
        if (!sys.egOpen[e]) continue;
        const m = sys.egMdot[e];
        const atTo = sys.egTo[e] === i;
        const into = atTo ? m : -m;
        const off = sys.egOff[e], n = sys.egCells[e] | 0;
        if (into > 0) {
          // What arrives carries the enthalpy of the cell touching this node.
          const h = n > 0 ? (atTo ? sys.cellH[off + n - 1] : sys.cellH[off]) : sys.ndH[i];
          fin += into;
          finH += into * h;
          // An end above the water pours into it rather than joining it. The
          // end that matters is the one attached to THIS volume: that is where
          // the water leaves the pipe and falls.
          const yEnd = atTo ? sys.egYTo[e] : sys.egYFrom[e];
          if (yEnd > sys.ndLevel[i] + 1e-4) {
            pour += into;
            pourPos += into * (atTo ? this.endX1[e] : this.endX0[e]);
          }
        } else if (into < 0) {
          fout -= into;
          // WHAT LEAVES A STEAM LINE IS STEAM, and steam carries about seven
          // times the enthalpy per kilogram that the water under it does. A
          // vessel whose outflow left at the vessel's own mixed enthalpy would
          // lose mass without losing the latent heat that mass took with it,
          // so it would boil for ever on a fraction of the energy boiling
          // actually costs. This is the other half of the same idea as the
          // inlet above: the gas space is what the nozzle is standing in.
          const flo = sys.egFluid ? sys.egFluid[e] : null;
          const yEnd2 = atTo ? sys.egYTo[e] : sys.egYFrom[e];
          const drawsGas = flo && flo.vapour && sys.ndFree[i]
            && yEnd2 > sys.ndLevel[i] - GAS_BAND;
          foutH += (-into) * (drawsGas ? hVapour(sys.ndT[i]) : sys.ndH[i]);
          if (drawsGas) foutVap += -into;
        }
      }

      // THE INVENTORY CLAMP. Outflow may never take more than the volume has,
      // because h = U/M has to stay finite and because a tank that goes
      // negative comes back as a NaN in a vertex position. What the network
      // believed had left and was not there is reported as spill rather than
      // quietly created; with the uncovering ramp in hydraulic.js this is zero
      // in every well-posed run, and the tests assert it.
      let scale = 1;
      const avail = M - Mfloor;
      const want = fout * t;
      if (want > avail) {
        scale = avail > 0 ? avail / want : 0;
        scale = clamp(scale, 0, 1);
        sys.ndDrain[i] = 1;
        starved++;
        this._spill += want - want * scale;
      } else {
        sys.ndDrain[i] = 0;
      }

      const Mkeep = M - t * fout * scale;
      const Mnew = Mkeep + t * fin;
      // ndQ is solver's channel: the host's own duty plus every source, sink
      // and ambient link aimed at this node. nodeQ is ours: the exchanger duty
      // wall() worked out, which needs both sides and so cannot be computed
      // there. Only the first of the two is missing from the energy books,
      // because wall() already counted its own.
      const hostQ = sys.ndQ ? sys.ndQ[i] : 0;
      const Q = hostQ + this.nodeQ[i];
      this._wallE += hostQ * t;
      this._wallAbs += hostQ >= 0 ? hostQ * t : -hostQ * t;
      // Written as a CONVEX COMBINATION of what stayed and what arrived, plus
      // the wall term. Every coefficient is non-negative once the clamp above
      // has guaranteed Mkeep >= 0, and they sum to the new mass, so the new
      // enthalpy cannot lie outside the interval spanned by the old value and
      // the inflows. Bracketing again by construction rather than by a clamp.
      // The energy that left with the outflow, at the outflow's OWN enthalpy
      // rather than the vessel's, which is what lets a steam draw cool the
      // water it came off. Written as mass times enthalpy taken away rather
      // than as a convex combination, because a stream that carries more
      // energy per kilogram than the body it leaves is exactly the case a
      // convex combination cannot represent. The bracketing that guaranteed
      // then is replaced here by the clamp below and by the phase floor: a
      // body cannot give up more vapour than it holds, so hNew cannot fall
      // below its own saturated liquid value through this term.
      // What is NOT done here: clamping the result back up when a steam draw
      // has taken more energy than the heat put in. That was tried and it
      // pinned the vessel at whatever temperature it started from, because a
      // floor at its own saturated liquid enthalpy is a floor at its own
      // temperature. The draw is limited where it belongs instead, in
      // hydraulic.js: a vessel that is pulled on harder than it is heated
      // cools a fraction below saturation, its gas space stops being able to
      // supply, and the flow falls back to what is actually being boiled.
      const U = sys.ndH[i] * M - t * scale * foutH + t * finH + Q * t;
      const hNew = clamp(Mnew > 1e-12 ? U / Mnew : sys.ndH[i], H_FLOOR, H_CEIL);

      const xOld = sys.ndX[i];
      const st = stateOf(sys.ndP[i], hNew, _state);
      // THE ONE DEFINITION OF BOILING: the mass that actually changed phase.
      // Heating, flashing on a falling pressure and condensation on cold tubes
      // are all the same number, it cannot double count, and it is what the
      // renderer's bubbles and drops read, so a picture can never disagree
      // with the state that produced it.
      // PLUS THE STEAM THAT LEFT. A vessel boiling steadily under a line that
      // takes the steam away as fast as it is raised never accumulates any
      // quality at all, so a rate read from the change in vapour INVENTORY
      // alone comes out at zero and the picture shows a vessel at a rolling
      // boil with nothing coming off it. What changed phase is what the body
      // now holds as vapour, plus what has already left as vapour.
      const dxM = st.x * Mnew - xOld * M + t * scale * foutVap;
      const rate = t > 0 ? dxM / t : 0;
      sys.ndBoil[i] = rate > 0 ? rate : 0;
      sys.ndCond[i] = rate < 0 ? -rate : 0;

      sys.ndM[i] = Mnew;
      sys.ndH[i] = hNew;
      sys.ndT[i] = st.T;
      sys.ndX[i] = st.x;
      sys.ndRho[i] = st.rho;
      const rhoL = rhoLiquidSat(st.T);
      sys.ndRhoL[i] = rhoL;
      this.dMassVolumes += Mnew - M;

      // Level from inventory: only the liquid has a surface, so the vapour
      // fraction leaves the level rather than raising it.
      const shape = sys.ndShape ? sys.ndShape[i] : null;
      const Vliq = Mnew * (1 - st.x) / (rhoL > 1e-6 ? rhoL : 1e-6);
      if (shape && shape.Vtotal > 0 && shape.cum) {
        const y = clamp(shape.cum.inv(Vliq), shape.y0, shape.y1);
        sys.ndLevel[i] = y;
        sys.ndFill[i] = clamp(Vliq / shape.Vtotal, 0, 1);
        sys.ndAsurf[i] = shape.areaT ? Math.max(1e-6, shape.areaT.at(y)) : 1e-6;
      } else {
        // A point volume has no shape to hold a level, so its surface is its
        // own elevation and it is always notionally full.
        sys.ndLevel[i] = sys.ndY[i];
        sys.ndFill[i] = 1;
        sys.ndAsurf[i] = 1e-6;
      }

      sys.ndPour[i] = pour;
      if (pour > 0) {
        // Across the body, 0 to 1, from the free-surface area. A renderer puts
        // the splash and the drips where the pipe actually is.
        const r = Math.sqrt(sys.ndAsurf[i] / Math.PI);
        sys.ndPourAt[i] = clamp(0.5 + (pourPos / pour - this.ndCx[i]) / (2 * (r > 1e-3 ? r : 1e-3)), 0, 1);
      } else {
        sys.ndPourAt[i] = 0.5;
      }
    }
    // The count a step reports is how many volumes were starved at once, not
    // how many times one of them was starved across the sub-steps.
    if (starved > this._starved) this._starved = starved;
    this._finish(t);
  }

  // Everything the rest of the library reads, refreshed once at the end of the
  // sub-step: cell pressures and states, the edge means the momentum equation
  // needs, and the two end values a renderer paints a joint with.
  _finish(dt) {
    const sys = this.sys, nE = sys.nEdges | 0;

    // THE SEAM IS CLOSED HERE, and this call is why a chain of pipes is one
    // run of water rather than two.
    //
    // mixNodes runs at the TOP of the sub-step, before transport, so a
    // junction holds the outlet enthalpy the upstream pipe had at the end of
    // the PREVIOUS sub-step. The upstream pipe then publishes its fresh last
    // cell as egT1 while the downstream pipe publishes the stale node as its
    // egT0, and the two disagree by one sub-step of change: a tenth of a
    // degree at 50 ms, but a whole sixty-degree collar for one frame at
    // dt = 10 s, drawn exactly at the joint the owner's first standing rule
    // forbids one at.
    //
    // Re-mixing here costs one pass over the junctions and changes NO physics
    // at all. Between this call and the next sub-step's nothing writes cellH,
    // so the two produce bit-identical values; the downstream edge is still
    // advected with the value its upstream neighbour had before this
    // sub-step's transport, exactly as section 9.3 lays it out. All that
    // moves is WHEN the junction is refreshed, and it now happens before
    // anything is published rather than after.
    this.mixNodes();

    let E = 0;
    for (let e = 0; e < nE; e++) {
      const n = sys.egCells[e] | 0;
      if (n <= 0) continue;
      const off = sys.egOff[e];
      // Weighted by the mass the edge held when the sub-step opened, so this is
      // the same inventory the opening figure was taken over.
      const mCell = this.rho0[e] * sys.egA[e] * sys.egL[e] / n;
      this._refresh(e);
      for (let j = 0; j < n; j++) E += mCell * sys.cellH[off + j];
      this._ends(e);
      // What crossed a boundary node, for the energy books. A boundary is
      // outside the system, so mass arriving from one is a source and mass
      // leaving into one is a loss.
      const m = sys.egMdot[e];
      if (sys.egOpen[e] && m !== 0) {
        const from = sys.egFrom[e], to = sys.egTo[e];
        if (sys.ndKind[from] === 2) {
          const q = dt * (m > 0 ? m * sys.ndH[from] : m * sys.cellH[off]);
          this._fluxE += q;
          this._fluxAbs += q >= 0 ? q : -q;
        }
        if (sys.ndKind[to] === 2) {
          const q = dt * (m > 0 ? m * sys.cellH[off + n - 1] : m * sys.ndH[to]);
          this._fluxE -= q;
          this._fluxAbs += q >= 0 ? q : -q;
        }
      }
    }
    const nN = sys.nNodes | 0;
    for (let i = 0; i < nN; i++) if (sys.ndKind[i] === 1) E += sys.ndM[i] * sys.ndH[i];

    // THE HONEST NUMBER. Semi-Lagrangian transport is not conservative, so
    // this reports the gap instead of pretending there is none: what the
    // system holds now, against what it held plus what the walls put in and
    // what crossed a boundary. It is near zero at a dt below the residence
    // time and grows when one step flushes a whole edge, which is exactly when
    // the scheme is interpolating rather than transporting.
    {
      const dE = E - this._E;
      const imb = dE - this._wallE - this._fluxE;
      this._resNum += imb >= 0 ? imb : -imb;
      const d = dE >= 0 ? dE : -dE;
      // The SIGNED totals are what the imbalance is measured from, and the
      // MAGNITUDE totals are what it is measured against. They differ by an
      // enormous factor in exactly the case that matters: a loop in steady
      // state, where two megawatts in and two megawatts out cancel to a few
      // watts and every honest joule of transport error then looks like the
      // whole of the energy budget.
      this._resDen += this._wallAbs + this._fluxAbs + d;
    }
    const rep = sys.report;
    if (rep) {
      rep.energyResidual = this._resDen > 1 ? this._resNum / this._resDen : 0;
      rep.spill = this._spill;
      rep.starvedVolumes = this._starved;
    }
  }

  // Cell pressures, cell states and the edge means. The pressure is linear
  // between the two end-node pressures, so BOILING APPEARS AS QUALITY CLIMBING
  // ALONG A HEATED CHANNEL rather than as a phase that switches at a joint:
  // that gradient is the only way to draw a liquid core fading into vapour
  // along one run, and it is why the cells carry a pressure at all.
  _refresh(e) {
    const sys = this.sys;
    const off = sys.egOff[e], n = sys.egCells[e] | 0;
    if (n <= 0) return;
    const pA = pAtNode(sys, sys.egFrom[e], sys.egYFrom[e]);
    const pB = pAtNode(sys, sys.egTo[e], sys.egYTo[e]);

    // A cell is certainly subcooled when its enthalpy is below the saturated
    // liquid enthalpy at BOTH ends of the edge. That test is exact rather than
    // approximate, because hLiquid(tsat(p)) rises with p and every cell
    // pressure lies between the two end pressures, and it lets a pipe that is
    // nowhere near boiling skip the saturation line entirely: two evaluations
    // for the whole edge instead of one per cell.
    const hfA = hLiquid(tsat(clamp(pA, P_TRIPLE, P_CRIT)));
    const hfB = hLiquid(tsat(clamp(pB, P_TRIPLE, P_CRIT)));
    const hfMin = hfA < hfB ? hfA : hfB;
    let allLiquid = true;
    for (let j = 0; j < n; j++) {
      const p = pA + (pB - pA) * ((j + 0.5) / n);
      sys.cellP[off + j] = p;
      if (!(sys.cellH[off + j] < hfMin)) allLiquid = false;
    }
    if (allLiquid) {
      // Single-phase liquid, so the edge's mean density and viscosity are
      // taken at its mean temperature rather than averaged cell by cell. The
      // two differ only by the curvature of the property over one edge's own
      // temperature span, which is four orders below the 1.5 per cent this
      // library already accepts for taking liquid density on the saturation
      // line, and it removes the per-cell density call that would otherwise be
      // the most expensive thing in the frame.
      let ts = 0;
      for (let j = 0; j < n; j++) {
        const T = tOfHLiquid(sys.cellH[off + j]);
        sys.cellT[off + j] = T;
        sys.cellX[off + j] = 0;
        ts += T;
      }
      const Tm = ts / n;
      sys.egRho[e] = rhoLiquidSat(Tm);
      sys.egMu[e] = muLiquid(Tm);
      sys.egFill[e] = 1;
      sys.egKind[e] = 0;
      return;
    }

    // Something in this edge is at or past saturation, so the line has to be
    // located. It is evaluated EXACTLY at the two ends and interpolated
    // between them, rather than evaluated at every cell: the pressure across
    // one pipe is a fraction of a bar, over which the saturation temperature
    // is very nearly straight, so the error is under a hundredth of a kelvin,
    // where the cost of the exact call is a pair of psat evaluations per cell
    // and is the most expensive thing in a boiling network by an order of
    // magnitude. It is the same IAPWS line as everywhere else in the library,
    // sampled twice; it is not a second table.
    const TsA = tsat(clamp(pA, P_TRIPLE, P_CRIT)), TsB = tsat(clamp(pB, P_TRIPLE, P_CRIT));
    const fgA = hfg(TsA), fgB = hfg(TsB);
    const vfA = 1 / rhoLiquidSat(TsA), vfB = 1 / rhoLiquidSat(TsB);
    const vgA = 1 / rhoVapourSat(TsA), vgB = 1 / rhoVapourSat(TsB);
    let rho = 0, mu = 0, xs = 0, liq = 0;
    for (let j = 0; j < n; j++) {
      const p = sys.cellP[off + j];
      const u = (j + 0.5) / n;
      const Ts = TsA + (TsB - TsA) * u;
      const hf = hfA + (hfB - hfA) * u;
      const fg = fgA + (fgB - fgA) * u;
      const H = clamp(sys.cellH[off + j], H_FLOOR, H_CEIL);
      const vf = vfA + (vfB - vfA) * u;
      const st = H < hf ? _liquid(H, _st2)
        : (H > hf + fg ? _vapour(clamp(p, P_TRIPLE, P_CRIT), H, Ts, hf + fg, _st2)
          : _twoPhase(H, Ts, hf, fg, vf, vgA + (vgB - vgA) * u, _st2));
      sys.cellT[off + j] = st.T;
      sys.cellX[off + j] = st.x;
      rho += st.rho;
      mu += st.mu;
      xs += st.x;
      // The LIQUID VOLUME fraction, not the mass fraction. One per cent of
      // steam by mass is most of the pipe by volume, and a renderer that
      // filled the bore from the mass fraction would draw a full pipe of water
      // where there is a bubbly froth.
      liq += st.x <= 0 ? 1 : (st.x >= 1 ? 0 : st.rho * (1 - st.x) * vf);
    }
    sys.egRho[e] = rho / n;
    sys.egMu[e] = mu / n;
    sys.egFill[e] = clamp(liq / n, 0, 1);
    const xm = xs / n;
    sys.egKind[e] = xm < 0.01 ? 0 : (xm > 0.99 ? 2 : 1);
  }

  // What an edge publishes at its two ends.
  //
  // The upstream end is ASSIGNED the donor node's value, not recomputed from
  // it, so it is equal to machine precision and no arithmetic can put a step
  // at a joint. The downstream end is the last cell, which is the boundary
  // face value of a cell-centred field. There is no representation in this
  // model for a seam.
  _ends(e) {
    const sys = this.sys;
    const off = sys.egOff[e], n = sys.egCells[e] | 0;
    if (n <= 0) return;
    if (sys.egTHoldOn && sys.egTHoldOn[e]) {
      // An imposed pair reads back bit-identical, which is what imposition
      // means; recomputing it from the cells would return it a rounding out.
      sys.egT0[e] = sys.egTHold[2 * e];
      sys.egT1[e] = sys.egTHold[2 * e + 1];
      sys.egX0[e] = sys.cellX[off];
      sys.egX1[e] = sys.cellX[off + n - 1];
      return;
    }
    if (sys.egMdot[e] >= 0) {
      const d = sys.egFrom[e];
      sys.egT0[e] = sys.ndT[d];
      sys.egX0[e] = sys.ndX[d];
      sys.egT1[e] = sys.cellT[off + n - 1];
      sys.egX1[e] = sys.cellX[off + n - 1];
    } else {
      const d = sys.egTo[e];
      sys.egT1[e] = sys.ndT[d];
      sys.egX1[e] = sys.ndX[d];
      sys.egT0[e] = sys.cellT[off];
      sys.egX0[e] = sys.cellX[off];
    }
  }
}

// The specific heat to use when a temperature change has to be turned into an
// enthalpy change. In the two-phase region there is no such thing, because the
// temperature does not move at all; the mixture value is used so the arithmetic
// stays finite and the quality does the work.
function _cpOf(T, x) {
  const q = clamp(x, 0, 1);
  const c = cpLiquid(T) * (1 - q) + cpVapour(T) * q;
  return c > 100 ? c : 100;
}
