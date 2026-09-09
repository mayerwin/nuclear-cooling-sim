// ---------------------------------------------------------------------------
// solver.js - the facade, and the owner of the one Sys state object.
//
// Everything a host touches is here: step(dt), the device setters, the impose
// layer that lets a plant model pin any quantity so the library never fights
// it, breakAt() and heal(), and the report. The physics lives in hydraulic.js
// and thermal.js; this file decides the ORDER and holds the memory.
//
// THREE PROMISES THIS FILE KEEPS, and every line below is in service of one:
//
//   1. step() NEVER THROWS and never publishes a NaN. Any dt from a
//      microsecond to a day lands on a finite, bounded state. A non-finite
//      value that gets through is treated as a bug: the last good state is
//      restored, report.recoveries counts it and a 'recover' event names the
//      array. That is a backstop, not a mechanism.
//   2. NOTHING IS ALLOCATED IN THE FRAME PATH. Every array is pre-sized in
//      rebuild() and reused; there are no object literals, no closures and no
//      array literals below step(). The Surface options object and the
//      state-of scratch are fields, not literals, for exactly this reason.
//   3. NO CLOCK. There is no performance.now() and no Date anywhere in
//      src/core, so two runs given the same dt sequence are bitwise identical
//      and a screenshot is a proof. report.ms is 0 unless the host passes an
//      opts.clock; wall time is the host's to measure, around step().
//
// SI THROUGHOUT: kg/s, Pa absolute, K, J/kg, kg/m3, Pa s, m, m2, W, s.
// ---------------------------------------------------------------------------

import { clamp, num, IdMap, growF64, growI32, growU8 } from './util.js?v=d7d0f53269';
import { roundedLength, elbows, bendK, areaOf, buildShape, levelOf, volumeAt, areaAt } from './geometry.js?v=d7d0f53269';
import { fluid, density, rhoLiquidSat, rhoVapourSat, psat, tsat, hLiquid, hfg, cpLiquid } from './props.js?v=d7d0f53269';
import { Network, NetworkError, MAX_NODES, autoRuns } from './network.js?v=d7d0f53269';
import { Surface } from './surface.js?v=d7d0f53269';
import { Hydraulic, pAt } from './hydraulic.js?v=d7d0f53269';
import { Thermal, stateOf, hOf, K_BULK } from './thermal.js?v=d7d0f53269';
import { publish, EdgeView, VolumeView, RunView } from './view.js?v=d7d0f53269';

// EIGHTY NEWTON ITERATIONS, AND THE REASON IS A MASS BALANCE RATHER THAN A
// TASTE FOR PRECISION. The Newton stops when it beats the tolerance, so a cap
// only ever binds on a frame that has not converged, and what happens to such
// a frame is not that it is slightly wrong: the node balances are still open,
// the volumes integrate the open residual as though it were flow, and mass is
// manufactured in whichever vessel the imbalance lands on. Measured on the
// consumer's station, released from rest and run for 2.2 plant hours at ten
// seconds a step, which is what a plant clock at 2000x asks for:
//
//   maxIter   mean edge visits   converged   worst mass residual   vessel
//         8                492     537/800                   8.8    332 t -> 499 t
//        20                613     533/800                1.1e-2    332 t -> 332 t
//        40                615     797/800                2.3e-3    332 t -> 330 t
//        80                626     799/800                4.2e-7    332 t -> 332 t
//       160                626     799/800                4.2e-7    332 t -> 332 t
//
// 160 buys nothing over 80, to the visit, which is how one knows 80 is not
// binding: the network converges within it whenever it can converge at all.
// The cost is 27 per cent more counted work than a budget that gives up, and
// what it buys is an inventory that closes to a ten-millionth instead of a
// vessel that gains 167 tonnes in a single step. A host that wants the cheap
// frame back lowers this and watches report.converged, which is what it is
// for. One frame in eight hundred still does not converge and says so.
//
// AND IT IS NOT A COUNT OF NEWTON ITERATIONS, which is worth knowing before
// anybody reaches for it to rescue a step that will not close. What the solve
// actually budgets is PASSES over the edge array, maxIter + 3 of them, and an
// iteration costs about three: a line-search trial or two, and the recoef at
// the end. Measured on the consumer's station released from rest, 2387 of 2403
// sub-step solves stopped on the pass budget and 16 on convergence -- and the
// ones that stopped did so at 17 to 28 iterations, with maxIter set to 80.
//
// That is not a fault and it is why the table above flattens: raising the pass
// budget three and four times over changes NOTHING on that station's day one,
// its trip fixture or its gravity scenario, to the step, at four times the
// counted work. A step that will not converge is not short of iterations. When
// report.converged is false, atBoundNode, trapped, derated and npshWorst are
// where the answer is; maxIter is not the lever.
export const DEFAULT_OPTS = Object.freeze({
  maxIter: 80, tol: 1e-4, maxDt: 10, maxSub: 8, inertia: true,
  vmaxLiquid: 60, vmaxVapour: 400, maxNodes: MAX_NODES, strictReference: false,
  // Unknowns at or below this are solved by the dense factorisation and
  // above it by the sparse conjugate gradient. See linalg.js for why.
  denseMax: 20
});

// How many columns a free surface gets, and how hard a body has to be boiling
// for the surface to read as a full rolling boil. 0.3 kg per square metre per
// second is roughly a pan at a hard boil; below that the churn fades out
// smoothly rather than switching on.
// The shortest step that can mean anything, in seconds. Below it the momentum
// equation's inertia term, L/(A dt), swamps every other coefficient by orders
// of magnitude and the linear system stops describing the network at all; the
// step is carried into the next one instead of being taken. See step().
// How far out of balance a junction may be before it is worth closing: a part
// in a million of the larger side. Above the tolerance a converged solve meets
// and far below anything a picture or a book would notice. See _closeJunctions.
const CLOSE_EPS = 1e-6;

const DT_MIN = 1e-6;

// How close to its own boiling point a volume has to be authored before its
// gas space is taken to be steam with a mass rather than a pressure the host
// states. A twentieth of a kelvin: a vessel meant to sit ON the line is
// authored on it, and one meant to be subcooled is not authored within 0.05 K
// of saturation by accident.
const SAT_INIT = 0.05;               // K

const SURFACE_N = 32;
const BOIL_FULL = 0.3;      // kg/(m2 s)

// Which hold is set on a node. One byte, so the per-sub-step pass over the
// holds is a scan of two small typed arrays and allocates nothing.
const HOLD_P = 1, HOLD_T = 2, HOLD_H = 4, HOLD_L = 8;
// How far a held temperature may land from the one the state function reads
// back off the enthalpy it produced, before the hold counts as one the fluid
// cannot keep. A hundredth of a kelvin: measured, the round trip is exact to
// every digit printed on an attainable temperature and misses by kelvins to
// hundreds of kelvins on one that is not, so there is nothing in between for
// the threshold to get wrong.
const HOLD_T_TOL = 0.01;

const F0 = new Float64Array(0), I0 = new Int32Array(0), U0 = new Uint8Array(0);

// ---------------------------------------------------------------------------
// Sys: the state object every module reads and writes.
//
// One dense integer index per node, edge, device, heat link and run, from an
// IdMap, and one typed array per quantity. Section 7 of the specification is
// the contract; the unit of every field is written beside it here because a
// unit that lives only in a design note is a unit that will be got wrong.
//
// WHO WRITES WHAT, and nobody may write outside their list:
//   hydraulic.js  egMdot egG egR2 egR1 egOpen egAvail egClamp ndP, report
//   thermal.js    cellH cellT cellX cellP ndH ndT ndX ndRho ndRhoL ndM ndLevel
//                 ndFill ndAsurf ndBoil ndCond ndPour ndPourAt ndDrain
//                 egT0 egT1 egX0 egX1 egFill egKind egDry egRho egMu, report
//   view.js       egV egPhase run*
//   solver.js     everything at rebuild(); ndSrc ndQ egHold* egTHold* egMprev
//
// A device index k is net.devices[k] and a heat index k is net.heat[k]: the
// IdMaps are interned in layout order at every rebuild, so an index into the
// live layout arrays is always valid and no object array is needed for them.
// ---------------------------------------------------------------------------
function emptySys(net, opts, report) {
  return {
    net, opts, report,
    nodeIds: new IdMap(), edgeIds: new IdMap(), devIds: new IdMap(),
    heatIds: new IdMap(), runIds: new IdMap(),
    nNodes: 0, nEdges: 0, nDev: 0, nHeat: 0, nRuns: 0, nSolve: 0, cellCap: 0,

    // --- nodes, length nNodes ---
    ndKind: I0,      // 0 junction, 1 volume, 2 boundary
    ndY: F0,         // m, reference elevation = at[1]
    ndP: F0,         // Pa absolute. For a FREE volume this is the pressure AT ITS SURFACE.
    ndH: F0,         // J/kg specific enthalpy
    ndT: F0,         // K
    ndX: F0,         // quality, 0..1
    ndRho: F0,       // kg/m3, mixture
    ndRhoL: F0,      // kg/m3, saturated liquid at ndT, for hydrostatic depth
    ndM: F0,         // kg total mass held
    ndMmax: F0,      // kg at Vtotal of liquid
    ndLevel: F0,     // m, ABSOLUTE y of the free surface (= ndY when not free)
    ndFill: F0,      // 0..1
    ndAsurf: F0,     // m2 free-surface area at the current level
    ndC: F0,         // kg/Pa compliance
    ndBoil: F0,      // kg/s, positive = boiling
    ndCond: F0,      // kg/s, positive = condensing
    ndPour: F0,      // kg/s arriving from above the surface
    ndPourAt: F0,    // 0..1 across the surface
    ndSrc: F0,       // kg/s imposed source, + into the node, rebuilt each sub-step
    ndQ: F0,         // W external heat this sub-step
    ndSolve: U0,     // 1 = its pressure is a Newton unknown
    ndFree: U0,
    // WHOSE PRESSURE THE HOST IS HOLDING. A closed volume decides its own
    // pressure; one the host has pinned does not, and thermal.js has to know
    // which, because resolving a state at a pressure that is about to be
    // overwritten publishes a temperature and a quality belonging to a
    // pressure the node does not have. See volumes().
    ndPHold: U0,
    ndDrain: U0,     // starved this sub-step
    // A CLOSED gas space, and the non-condensable in it. Closed, the volume's
    // pressure is a STATE that the water, the steam and the room they share
    // decide between them; open, it is held at whatever the space is open to
    // and both of these are zero. ndNc is n R for the gas that cannot
    // condense, which is what keeps a tank of cold water under air at one
    // atmosphere instead of at the two kilopascals its steam is at.
    ndClosed: U0,
    ndNc: F0,        // Pa m3 / K
    ndBubbly: U0,    // 1 = its vapour is bubbles through the water, not a space above it
    ndOrder: I0,     // flow-topological order for junction mixing
    ndSlot: I0,      // index into the Newton unknown vector, -1 if Dirichlet
    ndShape: null,   // built shape objects, or null
    ndFluid: null,   // fluid records from props.fluid()
    ndSurf: null,    // Surface instances, or null
    ndMixSpan: F0,   // m, a renderer hint carried through untouched

    // --- edges, length nEdges ---
    egFrom: I0, egTo: I0,
    egA: F0,         // m2, n * PI * dia^2 / 4
    egL: F0,         // m, roundedLength
    egD: F0,         // m, bore
    egN: I0,         // parallel paths this one drawn edge stands for
    egRough: F0,     // m
    egKform: F0,     // sum(bendK) + edge.k, WITHOUT device terms
    egYFrom: F0,     // m, pts[0][1]: the ATTACHMENT elevation, not the node's
    egYTo: F0,       // m, pts[last][1]
    // WHAT ACTUALLY CROSSED, kg over the step, and what it works out to per
    // second. egMdot is what the hydraulics SOLVED, which is not the same
    // thing: a volume's balance skips an edge that is not open, so an edge
    // shut for some of a step's sub-steps moves less water than its solved
    // flow says, and the vessel at its end knows it while the edge does not.
    // See C33.
    egCrossed: F0,
    egPubM: F0,
    egMdot: F0,      // kg/s
    egMprev: F0,     // kg/s at the start of this sub-step
    egV: F0,         // m/s, = egMdot / (egRho * egA), computed on publish only
    egRho: F0,       // kg/m3, mean of this edge's OWN cells
    egMu: F0,        // Pa s, mean of this edge's own cells
    egG: F0,         // (kg/s)/Pa, dm/dD from the closed form
    egR2: F0,        // Pa/(kg/s)^2
    egR1: F0,        // Pa/(kg/s)
    egOpen: U0,      // 0 = removed from the matrix, mdot forced to exactly 0
    egDev: I0,       // device index, or -1
    egVmax: F0,      // m/s
    egCells: I0,
    egOff: I0,       // start index into the cell arrays
    egRun: I0,       // run index, or -1
    // THE ENTHALPY OF THE WATER THAT ACTUALLY CROSSED THIS EDGE'S OUTLET over
    // the sub-step, which is not the last cell's once a step carries the water
    // further than one cell. See outflowH and C29.
    egHOut: F0,
    egT0: F0, egT1: F0,   // K at pts[0] and pts[last]
    egX0: F0, egX1: F0,
    egFill: F0,      // liquid volume fraction, 0..1
    egKind: I0,      // 0 liquid, 1 two-phase, 2 vapour
    egDry: U0,       // donor end uncovered, or the donor volume starved
    egPhase: F0,     // m of accumulated scroll, wrapped into [0, 1024)
    egHold: F0, egHoldOn: U0,     // imposed mdot, kg/s
    egTHold: F0, egTHoldOn: U0,   // imposed [T0, T1] pair, K, 2 per edge
    egAvail: F0,     // 0..1 uncovering factor applied this sub-step
    egClamp: U0,     // the velocity/choking penalty fired this sub-step
    egGeomVer: I0,
    egFluid: null,

    // --- cells, length cellCap ---
    cellH: F0,       // J/kg, GEOMETRIC order: index egOff[e]+0 is at pts[0]
    cellT: F0,       // K
    cellX: F0,
    cellP: F0,       // Pa, linear between the two end-node pressures

    // --- runs ---
    runLo: F0, runHi: F0,   // K, smoothed
    runMdot: F0,
    runMoving: U0,
    // WHICH EDGES ARE IN WHICH RUN, as a compressed row: runEdge holds every
    // edge that belongs to a run, grouped by run, and runAt[r]..runAt[r+1] is
    // where run r's are. The renderer's read surface needs a run's edges every
    // frame, and it used to find them by walking the whole edge array once per
    // run and skipping what did not match, which is the number of runs times
    // the number of edges: fine on a worked example with two runs and six
    // edges, and a hundred thousand rejected tests a frame on a station.
    runAt: I0,       // nRuns + 1 offsets
    runEdge: I0,     // edge indices, grouped by run
    // A run's `extra` nodes, the same way: the bodies whose water belongs to
    // this circuit although no edge of it carries them. See the span in view.js.
    runXAt: I0,      // nRuns + 1 offsets
    runXNode: I0,    // node indices, grouped by run
    runNorm: I0,     // 0 run, 1 network, 2 absolute; see NORMALISE_KINDS

    // --- scratch, sized at rebuild, never allocated in step() ---
    A: F0,           // nSolve*nSolve dense matrix
    bvec: F0, xvec: F0, Fvec: F0, Fbest: F0, ptmp: F0,
    cellTmp: new Float64Array(32),   // the semi-Lagrangian departure buffer
    wtmp: new Float64Array(32)       // heat profile weights
  };
}

// ---------------------------------------------------------------------------

export class Solver {
  constructor(net, opts) {
    if (!(net instanceof Network)) {
      throw new NetworkError('E_BAD_KIND', '', 'new Solver(net): net must be a Network',
        'build one with Network.fromJSON(json)');
    }
    this._net = net;
    this.opts = Object.assign({}, DEFAULT_OPTS, opts || null);
    // `clock` is the HOST'S CLOCK FUNCTION and not a flag. src/core owns no
    // wall clock at all, which is what makes two runs of the same scenario
    // bitwise identical, so there is nothing for a `true` to switch on: it
    // would be called, throw, and be swallowed, and report.ms would read zero
    // for ever with nothing to say why. Pass () => performance.now().
    this._clockBad = this.opts.clock != null && typeof this.opts.clock !== 'function';
    if (net.nodes.length > this.opts.maxNodes) {
      throw new NetworkError('E_TOO_LARGE', '/nodes',
        'this network has ' + net.nodes.length + ' nodes and the limit is ' + this.opts.maxNodes,
        'raise maxNodes if a model really is this big; the solve itself is sparse above denseMax unknowns and scales linearly in edges');
    }

    // The report is ONE object for the life of the solver, handed back by
    // every step. A host may keep the reference.
    this.report = {
      dt: 0, carried: 0, subSteps: 0, iters: 0, resid: 0, converged: true, pinned: 0,
      // What the sub-cycle criterion asked for before maxSub capped it, and
      // whether it was capped. A host that lowers maxSub for frame time is
      // buying it with accuracy and this is the only place that says so.
      subWanted: 0, subCapped: 0,
      // Which node or edge asked for subWanted, and why: 'volume' for a
      // vessel's turnover, 'edge' for an edge's, 'work' for a heat or work
      // rate along one. One number for a whole network says nothing about
      // whether it is every edge or a single turbine.
      subWantedBy: '', subWantedWhy: '',
      adrift: 0, adriftLoose: 0, worstNode: '', shutEdges: 0, shutEdge: '', shutWhy: '',
      overfilled: 0, overfilledNode: '', unmetHolds: 0, unmetHold: '',
      atBound: 0, atBoundNode: '',
      // HOW MANY PUMPS ARE MAKING LESS THAN THEIR HEAD, and the worst of them
      // with the fraction it is making. A derate is a STATE, like `trapped`: a
      // pump whose suction has nothing over it is doing the physical thing and
      // the solve has not failed. Without this a host reading `converged:
      // false` beside a plant behaving oddly has no way to tell the two apart.
      derated: 0, deratedEdge: '', deratedBy: 1,
      // And the least suction margin any pump has, in metres, with the pump it
      // belongs to. The derate is lagged; this is not, so on the first step of
      // a run it is the only one of the two that has anything to say.
      npshWorst: Infinity, npshEdge: '',
      // Nodes holding the pressure they had when the last valve round them
      // shut. A trapped segment is a STATE and not a failure; it is reported
      // so a host can tell it from a node that will not converge.
      // `trapped` is the STATE, how many junctions are holding the pressure
      // they had when the last valve round them shut. `trappedNew` is the
      // EVENT, how many became trapped this step: a line at rest reads trapped
      // for hours and is not news, and the step a live junction was cut off is
      // the one anybody is looking for.
      trapped: 0, trappedNew: 0, trappedNode: '',
      clampedEdges: 0, starvedVolumes: 0, spill: 0, hostMakeup: 0,
      massResidual: 0, energyResidual: 0, mdotScale: 1, edgeVisits: 0, ms: 0,
      // WHAT AN UNCONVERGED STEP PUT INTO THE PLANT, in kilogrammes.
      // massResidual is scaled and per step, so a step that fails reports a
      // number nobody reads and the next step, which converges, reports 5e-8
      // and buries it. massAdriftStep is the kilogrammes this step could not
      // account for, and massAdrift is the running total over every step that
      // did not converge. See _finishStep.
      massAdriftStep: 0, massAdrift: 0,
      recoveries: 0, rejected: 0, rejectedField: ''
    };

    this.sys = emptySys(net, this.opts, this.report);
    this.hydraulic = new Hydraulic(this.sys);
    this.thermal = new Thermal(this.sys);

    // Holds, keyed by id so they survive a rebuild that re-indexes everything.
    this._nodeHolds = new Map();
    this._flowHolds = new Map();
    this._edgeTHolds = new Map();
    this._hn = I0; this._hmask = U0;
    this._hp = F0; this._ht = F0; this._hh = F0; this._hl = F0; this._hcount = 0;

    // Simulated time handed over in steps too short to take, waiting to be
    // added to the next real one. See step().
    this._dtCarry = 0;

    // Carried state, so that an edit re-indexes the network without cooling
    // the water down. Grown by doubling, never freed.
    this._carry = {
      nN: 0, nE: 0, cellCap: 0, nodeIds: null, edgeIds: null, surf: [],
      p: F0, h: F0, x: F0, m: F0, mdot: F0, phase: F0, cellH: F0, off: I0, cn: I0
    };

    // Reused per-frame objects. These exist so that step() can call
    // Surface.step and stateOf without writing an object literal.
    this._sopt = { boil: 0, pour: 0, pourAt: 0.5, still: false };
    this._st = { T: 288.15, x: 0, rho: 1000, mu: 1e-3, cp: 4180, phase: 0 };

    this._good = null;      // the last published state known to be finite
    this._listeners = new Map();
    this._edgeViews = []; this._volViews = []; this._runViews = []; this._volSlot = I0;
    this._built = false;
    this._builtVersion = -1;
    this._badArray = ''; this._badIndex = -1;

    this.rebuild();
  }

  get net() { return this._net; }
  get arrays() { return this.sys; }
  get topoVersion() { return this._net.topoVersion; }
  get geomVersion() { return this._net.geomVersion; }

  on(evt, fn) {
    let a = this._listeners.get(evt);
    if (!a) { a = []; this._listeners.set(evt, a); }
    a.push(fn);
    return this;
  }
  off(evt, fn) {
    const a = this._listeners.get(evt);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    return this;
  }
  _emit(evt, payload) {
    const a = this._listeners.get(evt);
    if (!a) return;
    for (let i = 0; i < a.length; i++) a[i](payload);
  }

  // =========================================================================
  // rebuild
  // =========================================================================

  // Recompute every derived quantity from the layout and re-index
  // everything. State is carried across BY ID, never by index: an unchanged
  // edge keeps its cells verbatim, an edge whose cell count changed keeps them
  // resampled, a split edge gives each half the cells that fall in its own
  // span, and a new node is seeded from its neighbours. Arrays grow by
  // doubling, so a rebuild in steady state allocates nothing.
  rebuild() {
    const net = this._net, sys = this.sys, opts = this.opts;
    const nodes = net.nodes, edges = net.edges;
    const nN = nodes.length, nE = edges.length;
    if (nN > opts.maxNodes) {
      throw new NetworkError('E_TOO_LARGE', '/nodes',
        'this network has ' + nN + ' nodes and the limit is ' + opts.maxNodes);
    }

    this._stash();
    const c = this._carry;

    sys.nodeIds.clear(); sys.edgeIds.clear(); sys.devIds.clear();
    sys.heatIds.clear(); sys.runIds.clear();
    for (let i = 0; i < nN; i++) sys.nodeIds.intern(nodes[i].id);
    for (let i = 0; i < nE; i++) sys.edgeIds.intern(edges[i].id);
    for (let i = 0; i < net.devices.length; i++) sys.devIds.intern(net.devices[i].id);
    for (let i = 0; i < net.heat.length; i++) sys.heatIds.intern(net.heat[i].id);

    let cells = 0;
    for (let i = 0; i < nE; i++) cells += clamp(edges[i].cells, 2, 32);

    const declared = net.runs.length > 0;
    const runs = declared ? net.runs : autoRuns(net);
    for (let i = 0; i < runs.length; i++) sys.runIds.intern(runs[i].id);

    sys.nNodes = nN; sys.nEdges = nE; sys.nDev = net.devices.length;
    sys.nHeat = net.heat.length; sys.nRuns = runs.length; sys.cellCap = cells;
    this._sizeArrays(nN, nE, cells, runs.length);

    this._buildNodes(nodes, nN, c);
    this._buildEdges(edges, nE, c);
    this._buildRuns(runs, edges, nE);
    this._resolveLinks();

    this._assignSlots();
    this.hydraulic.size();
    this.thermal.size();
    this._compileHolds();
    this._buildViews(nodes, edges, runs, nN, nE);
    this._good = this._capture(this._good || this._newSnap());
    this._built = true;
    this._builtVersion = net.version;
    return this;
  }

  // Copy the handful of quantities that must survive re-indexing out of sys,
  // and keep the old IdMaps so an id can find its old index. Everything else
  // is derived from the layout and is recomputed.
  _stash() {
    const c = this._carry, s = this.sys;
    if (!this._built) {
      c.nodeIds = new IdMap(); c.edgeIds = new IdMap();
      return;
    }
    const nN = s.nNodes, nE = s.nEdges;
    c.nN = nN; c.nE = nE; c.cellCap = s.cellCap;
    c.p = growF64(c.p, nN); c.h = growF64(c.h, nN); c.x = growF64(c.x, nN); c.m = growF64(c.m, nN);
    for (let i = 0; i < nN; i++) { c.p[i] = s.ndP[i]; c.h[i] = s.ndH[i]; c.x[i] = s.ndX[i]; c.m[i] = s.ndM[i]; }
    c.surf.length = nN;
    for (let i = 0; i < nN; i++) c.surf[i] = s.ndSurf[i];
    c.mdot = growF64(c.mdot, nE); c.phase = growF64(c.phase, nE);
    c.off = growI32(c.off, nE); c.cn = growI32(c.cn, nE);
    for (let e = 0; e < nE; e++) {
      c.mdot[e] = s.egMdot[e]; c.phase[e] = s.egPhase[e];
      c.off[e] = s.egOff[e]; c.cn[e] = s.egCells[e];
    }
    c.cellH = growF64(c.cellH, s.cellCap);
    for (let i = 0; i < s.cellCap; i++) c.cellH[i] = s.cellH[i];
    // Swap the IdMaps rather than rebuilding a lookup: the previous one still
    // answers index(id) for every id that was there before this edit.
    const tn = c.nodeIds; c.nodeIds = s.nodeIds; s.nodeIds = tn;
    const te = c.edgeIds; c.edgeIds = s.edgeIds; s.edgeIds = te;
  }

  _sizeArrays(nN, nE, nCells, nR) {
    const s = this.sys;
    s.ndKind = growI32(s.ndKind, nN); s.ndOrder = growI32(s.ndOrder, nN); s.ndSlot = growI32(s.ndSlot, nN);
    s.ndY = growF64(s.ndY, nN); s.ndP = growF64(s.ndP, nN); s.ndH = growF64(s.ndH, nN);
    s.ndT = growF64(s.ndT, nN); s.ndX = growF64(s.ndX, nN); s.ndRho = growF64(s.ndRho, nN);
    s.ndRhoL = growF64(s.ndRhoL, nN); s.ndM = growF64(s.ndM, nN); s.ndMmax = growF64(s.ndMmax, nN);
    s.ndLevel = growF64(s.ndLevel, nN); s.ndFill = growF64(s.ndFill, nN); s.ndAsurf = growF64(s.ndAsurf, nN);
    s.ndC = growF64(s.ndC, nN); s.ndBoil = growF64(s.ndBoil, nN); s.ndCond = growF64(s.ndCond, nN);
    s.ndPour = growF64(s.ndPour, nN); s.ndPourAt = growF64(s.ndPourAt, nN);
    s.ndSrc = growF64(s.ndSrc, nN); s.ndQ = growF64(s.ndQ, nN); s.ndMixSpan = growF64(s.ndMixSpan, nN);
    s.ndSolve = growU8(s.ndSolve, nN); s.ndFree = growU8(s.ndFree, nN); s.ndDrain = growU8(s.ndDrain, nN); s.ndPHold = growU8(s.ndPHold, nN);
    s.ndClosed = growU8(s.ndClosed, nN); s.ndNc = growF64(s.ndNc, nN);
    s.ndBubbly = growU8(s.ndBubbly, nN);
    if (!s.ndShape || s.ndShape.length < nN) { s.ndShape = new Array(nN); s.ndFluid = new Array(nN); s.ndSurf = new Array(nN); }

    s.egFrom = growI32(s.egFrom, nE); s.egTo = growI32(s.egTo, nE); s.egN = growI32(s.egN, nE);
    s.egDev = growI32(s.egDev, nE); s.egCells = growI32(s.egCells, nE); s.egOff = growI32(s.egOff, nE);
    s.egRun = growI32(s.egRun, nE); s.egKind = growI32(s.egKind, nE); s.egGeomVer = growI32(s.egGeomVer, nE);
    s.egA = growF64(s.egA, nE); s.egL = growF64(s.egL, nE); s.egD = growF64(s.egD, nE);
    s.egRough = growF64(s.egRough, nE); s.egKform = growF64(s.egKform, nE);
    s.egYFrom = growF64(s.egYFrom, nE); s.egYTo = growF64(s.egYTo, nE);
    s.egCrossed = growF64(s.egCrossed, nE); s.egPubM = growF64(s.egPubM, nE);
    s.egMdot = growF64(s.egMdot, nE); s.egMprev = growF64(s.egMprev, nE); s.egV = growF64(s.egV, nE);
    s.egRho = growF64(s.egRho, nE); s.egMu = growF64(s.egMu, nE); s.egG = growF64(s.egG, nE);
    s.egR2 = growF64(s.egR2, nE); s.egR1 = growF64(s.egR1, nE); s.egVmax = growF64(s.egVmax, nE);
    s.egHOut = growF64(s.egHOut, nE);
    s.egT0 = growF64(s.egT0, nE); s.egT1 = growF64(s.egT1, nE);
    s.egX0 = growF64(s.egX0, nE); s.egX1 = growF64(s.egX1, nE);
    s.egFill = growF64(s.egFill, nE); s.egPhase = growF64(s.egPhase, nE);
    s.egHold = growF64(s.egHold, nE); s.egTHold = growF64(s.egTHold, 2 * nE);
    s.egAvail = growF64(s.egAvail, nE);
    s.egOpen = growU8(s.egOpen, nE); s.egDry = growU8(s.egDry, nE); s.egClamp = growU8(s.egClamp, nE);
    s.egHoldOn = growU8(s.egHoldOn, nE); s.egTHoldOn = growU8(s.egTHoldOn, nE);
    if (!s.egFluid || s.egFluid.length < nE) s.egFluid = new Array(nE);

    s.cellH = growF64(s.cellH, nCells); s.cellT = growF64(s.cellT, nCells);
    s.cellX = growF64(s.cellX, nCells); s.cellP = growF64(s.cellP, nCells);

    s.runLo = growF64(s.runLo, nR); s.runHi = growF64(s.runHi, nR);
    s.runMdot = growF64(s.runMdot, nR); s.runMoving = growU8(s.runMoving, nR);
    s.runAt = growI32(s.runAt, nR + 1); s.runEdge = growI32(s.runEdge, nE);
    s.runXAt = growI32(s.runXAt, nR + 1); s.runNorm = growI32(s.runNorm, nR);

    // The Newton scratch is sized for EVERY node that could ever be an
    // unknown, not for the current count, so that impose({p}) can make a node
    // Dirichlet and release it again without allocating anything. The MATRIX
    // is not sized here at all: hydraulic.slots() sizes it for the crossover,
    // because past the crossover it is not used and n squared doubles is how
    // a station-sized model would run out of memory solving nothing.
    s.bvec = growF64(s.bvec, nN); s.xvec = growF64(s.xvec, nN);
    s.Fvec = growF64(s.Fvec, nN); s.Fbest = growF64(s.Fbest, nN); s.ptmp = growF64(s.ptmp, nN);
  }

  _buildNodes(nodes, nN, c) {
    const s = this.sys, st = this._st;
    for (let i = 0; i < nN; i++) {
      const n = nodes[i];
      const kind = n.kind === 'junction' ? 0 : n.kind === 'volume' ? 1 : 2;
      s.ndKind[i] = kind;
      s.ndY[i] = n.at[1];
      s.ndFree[i] = n.free ? 1 : 0;
      s.ndMixSpan[i] = n.mixSpan;
      s.ndFluid[i] = fluid(n.fluid);
      s.ndOrder[i] = i;
      s.ndDrain[i] = 0;
      s.ndSrc[i] = 0; s.ndQ[i] = 0;
      s.ndBoil[i] = 0; s.ndCond[i] = 0; s.ndPour[i] = 0; s.ndPourAt[i] = 0.5;
      // A point shape has no inventory and sits at the node's own elevation,
      // which only the node knows, so it is told here.
      const shape = buildShape(n.shape.kind === 'point'
        ? { kind: 'point', y: n.at[1] } : n.shape);
      s.ndShape[i] = shape;

      const oi = c.nodeIds ? c.nodeIds.index(n.id) : -1;
      // A BOUNDARY IS DATA, NOT STATE. Carrying its pressure and enthalpy
      // across a rebuild is right for a junction and for a volume, where the
      // old value warm-starts the Newton and holds the water's heat, and wrong
      // for a boundary, whose p and h are held for ever by definition. Carried,
      // an edit that raises the sea's pressure or the atmosphere's temperature
      // does nothing at all, which is exactly the "change anything in the model
      // and see the effect" the library exists for. Reading it back from the
      // document costs nothing, since nothing in the step path ever writes a
      // boundary's state: thermal holds it and only impose() overrides it, and
      // an impose is re-applied every sub-step so it still wins after this.
      const carry = oi >= 0 && kind !== 2;
      let p, h, x, m = 0;
      if (carry) {
        p = c.p[oi]; h = c.h[oi]; x = c.x[oi]; m = c.m[oi];
      } else {
        p = n.free ? n.gas.p : n.p;
        x = n.x;
        // A JUNCTION'S TEMPERATURE IS AUTHORED AND ITS PRESSURE IS NOT. It
        // holds no inventory, so nothing in the document states what it is at
        // and the field falls back to one atmosphere; hOf then asks the liquid
        // branch for a temperature past ITS saturation line and clamps. A
        // junction stated at 333 C, which is a primary at 155 bar, came up at
        // 100 C carrying 418 kJ/kg, and every edge leaving it is seeded from
        // the node it leaves, so the whole circuit started at the boiling
        // point of water at one atmosphere. Measured on the consumer's
        // station: sg_tubes started at 373.1 K with its junction stated at
        // 606.1, and the loop then poured that into a 333 C vessel and took
        // ten plant minutes to warm back.
        //
        // The temperature is the fact here, so the pressure gives way: the
        // state is taken at the pressure that temperature is WATER at, which
        // is a far better first iterate for the Newton than an atmosphere in a
        // primary circuit as well. A junction's pressure is an unknown and the
        // first solve overwrites it; its enthalpy is not, and everything
        // leaving it is seeded from it.
        if (kind === 0) {
          const ps = psat(n.T);
          if (ps > p) p = ps;
        }
        h = hOf(p, n.T, x);
        if (n._seedH) {
          // A junction the library itself inserted (a split, a break) has no
          // authored temperature worth having: taking the mean of what its
          // neighbours hold is the difference between breaking a hot line and
          // dropping an ice cube into it.
          const nb = this._neighbourH(nodes, i, c);
          if (nb === nb) h = nb;
          delete n._seedH;
        }
      }
      if (n.free) p = n.gas.p;      // Dirichlet at the gas pressure, always
      s.ndP[i] = p;
      s.ndH[i] = h;
      stateOf(p, h, st);
      s.ndT[i] = st.T; s.ndX[i] = st.x; s.ndRho[i] = st.rho;
      s.ndRhoL[i] = rhoLiquidSat(st.T);

      if (kind === 1) {
        const Vtot = shape.Vtotal;
        s.ndMmax[i] = Vtot * s.ndRhoL[i];
        if (oi < 0) {
          // FILL IS A LIQUID FRACTION AND IT HAS TO WIN. It was turned into a
          // mass with the MIXTURE density at whatever quality the authored
          // temperature resolved to, and ON THE SATURATION LINE that
          // resolution is ambiguous: the same temperature is water, steam, or
          // anything between. A pressuriser at 345 C and 155 bar, which is two
          // tenths of a kelvin above its own boiling point, came out holding
          // 1.5 tonnes where its author asked for 8.9 tonnes of water; a
          // condenser hotwell at 33 C and 5 kPa came out holding twelve
          // kilograms of a twenty-three tonne fill. Every vessel a plant keeps
          // ON the line, which is every pressuriser and every condenser,
          // started empty, and a fill of 0.86 in a subcooled vessel worked
          // perfectly, so nothing looked wrong until a station was built.
          //
          // The liquid and the vapour are now weighed separately and the
          // quality follows from the two masses rather than from a temperature
          // that cannot tell them apart. The vapour is only counted where the
          // vessel is authored AT saturation: below it, the space above the
          // water is whatever gas the host says it is at whatever pressure,
          // and this library carries no mass for it (register C18).
          //
          // An explicitly authored x still decides: state one to say what you
          // mean, and the mass follows the mixture as it always did.
          const ts = tsat(p);
          if (n.x > 0) {
            m = n.fill * Vtot * density(st.T, p, st.x);
          } else {
            const tw = st.T < ts ? st.T : ts;
            const mLiq = n.fill * Vtot * rhoLiquidSat(tw);
            // A CLOSED VESSEL'S DOME IS PART OF WHAT IT HOLDS, whether or not
            // its water is at the boiling point: the space above a subcooled
            // pool still contains saturated steam at the water's own
            // temperature, and for a closed vessel that steam is inventory,
            // because its pressure is worked out from the mass and the room it
            // has. Left out, a vessel authored a kelvin below saturation came
            // up as a mixture at the density its LIQUID alone had, which is a
            // far lower pressure: a boiler shell authored at 70 bar settled at
            // 61. An open vessel does not care, because its gas space is held
            // at a pressure the host states and carries no mass here at all.
            const closed = n.free && n.gas && n.gas.closed;
            const mVap = (closed || st.T >= ts - SAT_INIT)
              ? (1 - n.fill) * Vtot * rhoVapourSat(tw) : 0;
            m = mLiq + mVap;
            if (mVap > 0 && m > 0) {
              h = hLiquid(tw) + (mVap / m) * hfg(tw);
              s.ndH[i] = h;
              stateOf(p, h, st);
              s.ndT[i] = st.T; s.ndX[i] = st.x; s.ndRho[i] = st.rho;
              s.ndRhoL[i] = rhoLiquidSat(st.T);
            }
          }
        }
        s.ndM[i] = m;

        // THE NON-CONDENSABLE, ONCE, FROM WHAT THE VESSEL WAS AUTHORED AT. A
        // closed space starts at the pressure the document states, and what
        // that pressure is made of is decided here and never again: the steam
        // in it is at its own saturation pressure, and whatever is left over is
        // a gas that cannot condense, so it obeys pV = nRT for the rest of the
        // run. A vessel authored at 70 bar and 285 C is pure steam and gets
        // none; one authored at 1.1 bar and 18 C is almost all air.
        s.ndClosed[i] = n.free && n.gas && n.gas.closed ? 1 : 0;
        if (s.ndClosed[i]) {
          const Vliq0 = clamp(m * (1 - st.x) / Math.max(1, s.ndRhoL[i]), 0, Vtot);
          const Vgas0 = Math.max(1e-6, Vtot - Vliq0);
          const pnc = Math.max(0, p - psat(st.T));
          s.ndNc[i] = pnc * Vgas0 / Math.max(1, st.T);
        } else {
          s.ndNc[i] = 0;
        }
        const Vliq = clamp(m * (1 - st.x) / Math.max(1, s.ndRhoL[i]), 0, Vtot);
        s.ndLevel[i] = levelOf(shape, Vliq);
        s.ndFill[i] = Vtot > 0 ? clamp(Vliq / Vtot, 0, 1) : 0;
        s.ndAsurf[i] = areaAt(shape, s.ndLevel[i]);
        // Liquid is nearly incompressible, so this is a small number, but it
        // must not be zero: it is the only thing making an isolated volume's
        // own row of the Jacobian non-singular.
        s.ndC[i] = Math.max(1e-9, Vliq * st.rho / K_BULK);
      } else {
        s.ndM[i] = 0; s.ndMmax[i] = 0; s.ndFill[i] = 0; s.ndAsurf[i] = 0;
        s.ndLevel[i] = n.at[1]; s.ndC[i] = 0;
      }

      if (n.free) {
        const surf = (oi >= 0 && c.surf[oi]) ? c.surf[oi]
          : new Surface({ n: SURFACE_N, seed: i + 1 });
        // A one-dimensional surface needs a width to get its wave speed from.
        // The diameter of a circle of the same area is the honest answer for a
        // lathe and close enough for a box.
        surf.setWidth(2 * Math.sqrt(Math.max(0.01, s.ndAsurf[i]) / Math.PI));
        surf.setDepth(s.ndLevel[i] - shape.y0);
        s.ndSurf[i] = surf;
      } else {
        s.ndSurf[i] = null;
      }
    }
  }

  // The mass-weighted mean enthalpy of everything already attached to node i.
  _neighbourH(nodes, i, c) {
    const net = this._net, edges = net.edges, id = nodes[i].id;
    let w = 0, sum = 0;
    for (let e = 0; e < edges.length; e++) {
      const eg = edges[e];
      const otherId = eg.from === id ? eg.to : eg.to === id ? eg.from : null;
      if (otherId === null) continue;
      const oi = c.nodeIds ? c.nodeIds.index(otherId) : -1;
      if (oi < 0) continue;
      const wi = Math.max(1e-6, c.m[oi]);
      sum += wi * c.h[oi]; w += wi;
    }
    return w > 0 ? sum / w : NaN;
  }

  _buildEdges(edges, nE, c) {
    const s = this.sys, opts = this.opts, st = this._st;
    let off = 0;
    for (let e = 0; e < nE; e++) {
      const eg = edges[e];
      const fl = fluid(eg.fluid);
      s.egFluid[e] = fl;
      s.egFrom[e] = s.nodeIds.index(eg.from);
      s.egTo[e] = s.nodeIds.index(eg.to);
      s.egD[e] = eg.dia;
      s.egN[e] = eg.n;
      s.egA[e] = areaOf(eg.dia, eg.n);
      // The rounded length, from the ONE bend rule in geometry.js, so the
      // resistance and the tube a renderer draws are the same object.
      s.egL[e] = Math.max(1e-6, roundedLength(eg.pts, eg.bend));
      s.egRough[e] = eg.rough;
      let K = eg.k;
      const bends = elbows(eg.pts, eg.bend, eg.dia);
      for (let b = 0; b < bends.length; b++) K += bendK(bends[b].theta, bends[b].rOverD);
      s.egKform[e] = K;
      s.egYFrom[e] = eg.pts[0][1];
      s.egYTo[e] = eg.pts[eg.pts.length - 1][1];
      s.egCells[e] = clamp(eg.cells, 2, 32);
      s.egOff[e] = off;
      s.egDev[e] = eg.device == null ? -1 : s.devIds.index(eg.device);
      s.egVmax[e] = eg.vmax == null ? (fl.vapour ? opts.vmaxVapour : opts.vmaxLiquid) : eg.vmax;
      s.egGeomVer[e] = eg._geomVer;
      s.egOpen[e] = 1; s.egAvail[e] = 1; s.egClamp[e] = 0; s.egDry[e] = 0;
      s.egG[e] = 0; s.egR1[e] = 0; s.egR2[e] = 0;
      s.egHoldOn[e] = 0; s.egTHoldOn[e] = 0;
      s.egTHold[2 * e] = 0; s.egTHold[2 * e + 1] = 0;
      s.egRun[e] = -1;

      const oe = c.edgeIds ? c.edgeIds.index(eg.id) : -1;
      s.egMdot[e] = oe >= 0 ? c.mdot[oe] : 0;
      s.egPhase[e] = oe >= 0 ? c.phase[oe] : 0;
      // A HALF OF A SPLIT EDGE IS STILL FULL OF MOVING WATER. An edge nobody
      // has seen before starts from rest, which is right for one a host has
      // just added and wrong for the two halves a break leaves behind: the
      // fluid in them was doing 800 kg/s a moment ago and has the momentum to
      // prove it. Started from zero, and with the inertia term implicit, the
      // first frame after a break showed the flow collapsing to a fraction of
      // what it was and taking a second to climb back, which is the opposite
      // of what breaking a line does; at a small enough step the solve could
      // not close the break node at all inside the pressure bounds, because
      // the pressure needed to accelerate the water back up in a microsecond
      // does not exist. The scroll phase comes with it so the tracers do not
      // jump at the same instant.
      if (oe < 0 && eg._seedM && eg._seed) {
        const si = c.edgeIds ? c.edgeIds.index(eg._seed[0].id) : -1;
        if (si >= 0) { s.egMdot[e] = c.mdot[si]; s.egPhase[e] = c.phase[si]; }
      }
      s.egMprev[e] = s.egMdot[e];
      this._seedCells(eg, e, oe, c);
      off += s.egCells[e];
    }
    // A second pass, because the cell pressures need both end nodes' states
    // and those are only complete once every node is built.
    for (let e = 0; e < nE; e++) this._publishEdgeState(e, st);
  }

  // Fill an edge's cells with enthalpy. Verbatim when nothing changed,
  // resampled when the count or the geometry did, from the named source spans
  // when the edge is one half of a split, and from the donor node otherwise.
  _seedCells(eg, e, oe, c) {
    const s = this.sys, N = s.egCells[e], off = s.egOff[e];
    const donor = s.egMdot[e] >= 0 ? s.egFrom[e] : s.egTo[e];
    const hDonor = donor >= 0 ? s.ndH[donor] : 4.18e5;
    if (oe >= 0 && c.cn[oe] === N) {
      const so = c.off[oe];
      for (let j = 0; j < N; j++) s.cellH[off + j] = c.cellH[so + j];
      return;
    }
    for (let j = 0; j < N; j++) s.cellH[off + j] = hDonor;
    if (oe >= 0) { this._resample(c.cellH, c.off[oe], c.cn[oe], off, N, 0, 1, 0, 1); return; }
    const seed = eg._seed;
    if (!seed) return;
    for (let k = 0; k < seed.length; k++) {
      const sd = seed[k];
      const si = c.edgeIds ? c.edgeIds.index(sd.id) : -1;
      if (si < 0) continue;
      this._resample(c.cellH, c.off[si], c.cn[si], off, N, sd.a, sd.b, sd.c, sd.d);
    }
    delete eg._seed;
    delete eg._seedM;
  }

  // The new edge's fraction span [a,b] takes the source's fraction span [c,d],
  // by the same linear interpolation the semi-Lagrangian transport uses, so a
  // resampled edge and a transported one smear identically.
  _resample(src, so, sn, off, N, a, b, cc, dd) {
    const s = this.sys;
    if (sn <= 0 || b <= a) return;
    for (let j = 0; j < N; j++) {
      const t = (j + 0.5) / N;
      if (t < a || t > b) continue;
      const u = cc + (dd - cc) * ((t - a) / (b - a));
      const pos = u * sn - 0.5;
      const i0 = clamp(Math.floor(pos), 0, sn - 1) | 0;
      const i1 = clamp(i0 + 1, 0, sn - 1) | 0;
      const fr = clamp(pos - i0, 0, 1);
      s.cellH[off + j] = src[so + i0] + (src[so + i1] - src[so + i0]) * fr;
    }
  }

  // The cell pressures, states and the two published end values. thermal.js
  // owns these once running; this is only the seed that makes the first
  // hydraulic solve meaningful.
  _publishEdgeState(e, st) {
    const s = this.sys, N = s.egCells[e], off = s.egOff[e];
    const a = s.egFrom[e], b = s.egTo[e];
    const pa = a >= 0 ? pAt(s, a, s.egYFrom[e]) : 101325;
    const pb = b >= 0 ? pAt(s, b, s.egYTo[e]) : 101325;
    let rho = 0, mu = 0, xs = 0;
    for (let j = 0; j < N; j++) {
      const f = (j + 0.5) / N;
      const p = pa + (pb - pa) * f;
      s.cellP[off + j] = p;
      stateOf(p, s.cellH[off + j], st);
      s.cellT[off + j] = st.T; s.cellX[off + j] = st.x;
      rho += st.rho; mu += st.mu; xs += st.x;
    }
    s.egRho[e] = rho / N; s.egMu[e] = mu / N;
    const xm = xs / N;
    s.egT0[e] = s.cellT[off]; s.egT1[e] = s.cellT[off + N - 1];
    s.egX0[e] = s.cellX[off]; s.egX1[e] = s.cellX[off + N - 1];
    s.egFill[e] = 1 - xm;
    // By volume, as in thermal.js: at a rebuild the cells have only just been
    // seeded, so the mass fraction is all there is, but the same rule is used
    // so that a network does not change kind on its first step.
    s.egKind[e] = xm < 0.01 ? 0 : xm > 0.99 ? 2 : 1;
    s.egV[e] = s.egMdot[e] / Math.max(1e-9, s.egRho[e] * s.egA[e]);
  }

  _buildRuns(runs, edges, nE) {
    const s = this.sys;
    // A RUN'S SMOOTHED COLOUR RANGE IS CARRIED ACROSS A REBUILD, BY ID.
    // Seeding it with a fixed 288.15 K meant every edit to the network -
    // moving a point, opening a break, adding an edge - threw the range away
    // and started the half-second fade again from a temperature nothing in the
    // model was at, repainting every body on the run at once. A network is
    // meant to be editable on the fly, so an edit must not be visible as a
    // flash of colour. Held by id and not by index, because an edit is exactly
    // the moment indices move.
    const prev = this._runRange || (this._runRange = new Map());
    const old = this._runDefs;
    if (old) {
      for (let r = 0; r < old.length; r++) {
        if (s.runHi[r] > s.runLo[r]) prev.set(old[r].id, [s.runLo[r], s.runHi[r]]);
      }
    }
    for (let r = 0; r < runs.length; r++) {
      const ids = runs[r].edges;
      for (let k = 0; k < ids.length; k++) {
        const e = s.edgeIds.index(ids[k]);
        if (e >= 0) s.egRun[e] = r;
      }
      const keep = prev.get(runs[r].id);
      if (keep) {
        s.runLo[r] = keep[0]; s.runHi[r] = keep[1];
      } else {
        // Zero, not a made-up temperature: view.js reads a non-positive hi as
        // "this run has never been published" and SNAPS to the true range on
        // the first frame instead of fading to it from somewhere false.
        s.runLo[r] = 0; s.runHi[r] = 0;
      }
      s.runMdot[r] = 0; s.runMoving[r] = 0;
    }
    this._runDefs = runs;

    // The same membership the other way round, so the read surface can walk a
    // run's edges instead of walking every edge and asking. Filled in edge
    // order within each run, so two runs of the same shape are traversed the
    // same way and nothing in the picture can depend on the order the runs
    // happened to be found in.
    const nR = runs.length;
    for (let r = 0; r <= nR; r++) s.runAt[r] = 0;
    for (let e = 0; e < nE; e++) {
      const r = s.egRun[e];
      if (r >= 0 && r < nR) s.runAt[r + 1]++;
    }
    for (let r = 0; r < nR; r++) s.runAt[r + 1] += s.runAt[r];
    const fill = this._runFill = growI32(this._runFill, nR);
    for (let r = 0; r < nR; r++) fill[r] = s.runAt[r];
    for (let e = 0; e < nE; e++) {
      const r = s.egRun[e];
      if (r >= 0 && r < nR) s.runEdge[fill[r]++] = e;
    }

    // AND THE EXTRA NODES, resolved once here rather than by id every frame.
    // `normalise` and `extra` were both carried through Network, validated,
    // and then read by nobody: the span in view.js walked the run's own edges
    // and nothing else. On the consumer's station that painted the emergency
    // tank and the pool RED. Their runs span 288.15 to 291.15 K at rest, the
    // tank at 18 C and its line at 15, so three kelvin was stretched over the
    // whole ramp and 291 K sat at the hot end; both runs already declared
    // extra ['rpv'], the water they end in, which is at 610 K and would have
    // put the tank an eightieth of the way up its own ramp.
    let nx = 0;
    for (let r = 0; r < nR; r++) nx += (runs[r].extra || []).length;
    s.runXNode = growI32(s.runXNode, Math.max(1, nx));
    let w = 0;
    for (let r = 0; r < nR; r++) {
      s.runXAt[r] = w;
      const kind = runs[r].normalise;
      s.runNorm[r] = kind === 'network' ? 1 : (kind === 'absolute' ? 2 : 0);
      const ex = runs[r].extra || [];
      for (let k = 0; k < ex.length; k++) {
        const i = s.nodeIds.index(ex[k]);
        if (i >= 0) s.runXNode[w++] = i;
      }
    }
    s.runXAt[nR] = w;
  }

  // WHAT A JUNCTION COULD NOT BALANCE, TAKEN OFF THE SIDE THAT WAS TOO BIG.
  //
  // A junction holds no inventory. Whatever arrives in an instant leaves in the
  // same instant, and that is not an approximation, it is what a junction IS:
  // the Newton's whole equation for one is that its flows sum to zero. When the
  // solve CANNOT make that true -- the node is pinned on a pressure bound, so
  // its unknown has nowhere left to go -- the flows it publishes do not sum to
  // zero, and everything downstream integrates them anyway: the volume at one
  // end is debited and the volume at the other credited a different number, and
  // the difference is water that did not exist.
  //
  // Measured on the consumer's station, whose whole mass error is one step:
  // releasing the network from its imposed flows leaves cpump_j short by 231 kg
  // in a single tick, with disch_j at 11.8 kg and every other junction under
  // one. Every row of its health table books that same step and nothing after.
  //
  // The larger side is scaled to the smaller, which says the honest thing: a
  // pump whose suction cannot feed it delivers what it can draw. This is NOT a
  // cavitation model -- C16 is still open and there is still none -- it invents
  // no vapour, no delay and no damage. It refuses to let a node with no
  // inventory act as a source, which is the one thing a junction can never be.
  //
  // ONLY ON A SUB-STEP THAT DID NOT CONVERGE. A converged solve closes its
  // junctions to the tolerance it was asked for and this finds nothing to do,
  // and the report still says `converged: false`, `atBound`, and which pump is
  // derated, so nothing is hidden. What changes is that the books close.
  _closeJunctions() {
    const s = this.sys;
    const nN = s.nNodes | 0, nE = s.nEdges | 0;
    const keep = this._closedM = growF64(this._closedM || F0, nE);
    const mark = this._closedAt = growU8(this._closedAt || U0, nE);
    let n = 0;
    for (let e = 0; e < nE; e++) mark[e] = 0;
    for (let i = 0; i < nN; i++) {
      if (s.ndKind[i] !== 0) continue;                    // junctions only
      let inn = 0, out = 0;
      for (let e = 0; e < nE; e++) {
        if (!s.egOpen[e]) continue;
        if (s.egHoldOn && s.egHoldOn[e]) continue;        // the host's word, untouched
        const m = s.egMdot[e];
        if (s.egFrom[e] === i) { if (m > 0) out += m; else inn -= m; }
        else if (s.egTo[e] === i) { if (m > 0) inn += m; else out -= m; }
      }
      const big = inn > out ? inn : out, small = inn > out ? out : inn;
      if (!(big > 0) || big - small <= CLOSE_EPS * big) continue;
      const f = small / big;
      const scaleIn = inn > out;
      for (let e = 0; e < nE; e++) {
        if (!s.egOpen[e]) continue;
        if (s.egHoldOn && s.egHoldOn[e]) continue;
        const m = s.egMdot[e];
        const isIn = (s.egFrom[e] === i && m < 0) || (s.egTo[e] === i && m > 0);
        if (isIn !== scaleIn) continue;
        if (!mark[e]) { keep[e] = m; mark[e] = 1; n++; }
        s.egMdot[e] = m * f;
      }
    }
    return n;
  }

  // Put back the flows the closure scaled, once the water has moved on them.
  _restoreClosed() {
    const s = this.sys, mark = this._closedAt, keep = this._closedM;
    for (let e = 0, nE = s.nEdges | 0; e < nE; e++) if (mark[e]) s.egMdot[e] = keep[e];
  }

  // Resolve every "edge:x" / "node:x" target and every device's edge ONCE, at
  // rebuild, onto the layout records as underscore fields. Parsing those
  // strings every sub-step would allocate, and allocation in the frame path is
  // the one thing this library may not do.
  _resolveLinks() {
    const s = this.sys, net = this._net;
    for (let k = 0; k < net.devices.length; k++) {
      const d = net.devices[k];
      d._edge = s.edgeIds.index(d.edge);
    }
    for (let k = 0; k < net.heat.length; k++) {
      const h = net.heat[k];
      h._sign = h.kind === 'sink' ? -1 : 1;
      this._resolveTarget(h, 'on', '_onNode', '_onEdge');
      this._resolveTarget(h, 'hot', '_hotNode', '_hotEdge');
      this._resolveTarget(h, 'cold', '_coldNode', '_coldEdge');
    }
  }

  _resolveTarget(h, field, nodeKey, edgeKey) {
    const s = this.sys, v = h[field];
    h[nodeKey] = -1; h[edgeKey] = -1;
    if (typeof v !== 'string') return;
    if (v.charCodeAt(0) === 110) h[nodeKey] = s.nodeIds.index(v.slice(5));   // "node:"
    else if (v.charCodeAt(0) === 101) h[edgeKey] = s.edgeIds.index(v.slice(5)); // "edge:"
  }

  // Which pressures are unknowns. Junctions always; volumes unless they are
  // free (Dirichlet at the gas pressure) or the host has imposed a pressure;
  // boundaries never.
  _assignSlots() {
    const s = this.sys, nN = s.nNodes;
    let k = 0;
    for (let i = 0; i < nN; i++) {
      let solve = s.ndKind[i] !== 2 && !s.ndFree[i];
      if (solve && this._nodeHolds.size) {
        const hold = this._nodeHolds.get(this._net.nodes[i].id);
        if (hold && (hold.mask & HOLD_P)) solve = false;
      }
      s.ndSolve[i] = solve ? 1 : 0;
      s.ndSlot[i] = solve ? k++ : -1;
    }
    s.nSolve = k;
    // The matrix, the Newton scratch and the sparsity pattern are all indexed
    // BY SLOT, so they are re-sized here and not only at a rebuild: impose()
    // and release() renumber every slot after the node they touch, and no pipe
    // has moved. Doing it in the one place the numbering is decided is what
    // makes it impossible for a new caller to forget.
    this.hydraulic.slots();
  }

  // Flyweights, built once per rebuild and never again: a host that reads
  // solver.edge('riser').v every frame must not be allocating a view to do it.
  _buildViews(nodes, edges, runs, nN, nE) {
    this._edgeViews.length = 0; this._volViews.length = 0; this._runViews.length = 0;
    this._volSlot = growI32(this._volSlot, nN);
    for (let e = 0; e < nE; e++) this._edgeViews.push(new EdgeView(this.sys, e));
    for (let i = 0; i < nN; i++) {
      this._volSlot[i] = -1;
      if (this.sys.ndKind[i] !== 1) continue;
      this._volSlot[i] = this._volViews.length;
      this._volViews.push(new VolumeView(this.sys, i));
    }
    for (let r = 0; r < runs.length; r++) this._runViews.push(new RunView(this.sys, r));
  }

  // =========================================================================
  // the step
  // =========================================================================

  step(dt) {
    const s = this.sys, rep = this.report, opts = this.opts;
    const t0 = opts.clock ? this._clock() : 0;

    // 0. Any dt at all, from a microsecond to a day, lands somewhere finite.
    //    A day of clock advances maxDt of simulation rather than exploding,
    //    and a NaN from a host becomes a legal no-op instead of a lost picture.
    //
    //    AND A STEP TOO SHORT TO MEAN ANYTHING IS CARRIED, NOT TAKEN. In zero
    //    time nothing can move, and the equations say so in a way no linear
    //    algebra survives: the inertia term is L/(A dt), so at a femtosecond
    //    every conductance is about 1e-15 (kg/s)/Pa and a junction's row of the
    //    Jacobian is a residual at the noise floor divided by nothing at all.
    //    Measured on examples/model.glb: a step of 8.5e-13 s after a 0.5 s step
    //    drove a junction to the pressure floor, 368 kPa to 1000 Pa, which
    //    flashed 95 C water to steam. Nothing reported it. Every step said
    //    converged, the state read normally, and the loop fell apart over the
    //    next ten ordinary frames, 78.0 kg/s becoming 30.6.
    //
    //    That is not a hypothetical: `drive(span)` written as a while loop over
    //    min(BIG, left) ends every call with one, because neither 1/60 nor 0.5
    //    is exact in binary and `left` lands on 8.5e-13 instead of zero. A
    //    browser tab coming back from the background does the same.
    //
    //    The time is not thrown away: it is added to the next step, so a host
    //    that hands over a thousand femtoseconds still gets a picosecond
    //    simulated and drive(60) still runs for exactly sixty seconds. The
    //    floor was measured on the same network: the state is identical to
    //    three decimals at 1e-10 s and poisoned at 1e-12, so a microsecond is
    //    six orders clear of the failure and two below the shortest step a real
    //    frame loop produces. report.carried says how much is being held.
    dt = clamp(num(dt, 0), 0, opts.maxDt);
    if (dt > 0 && dt < DT_MIN) {
      this._dtCarry += dt;
      rep.dt = 0;
      rep.carried = this._dtCarry;
      publish(s, 0);
      if (opts.clock) rep.ms = this._clock() - t0;
      return rep;
    }
    if (dt > 0 && this._dtCarry > 0) {
      dt = Math.min(opts.maxDt, dt + this._dtCarry);
      this._dtCarry = 0;
    }
    rep.carried = this._dtCarry;
    rep.dt = dt;
    rep.subSteps = 0; rep.iters = 0; rep.resid = 0; rep.converged = true;
    rep.pinned = 0; rep.clampedEdges = 0; rep.starvedVolumes = 0;
    rep.adrift = 0; rep.adriftLoose = 0; rep.worstNode = '';
    rep.shutEdges = 0; rep.shutEdge = ''; rep.shutWhy = '';
    rep.overfilled = 0; rep.overfilledNode = ''; rep.overspeedEdges = 0; rep.overspeedEdge = '';
    rep.unmetHolds = 0; rep.unmetHold = ''; this._unmetAt = 0;
    for (let e = 0; e < s.nEdges; e++) s.egCrossed[e] = 0;
    rep.atBound = 0; rep.atBoundNode = -1;
    rep.derated = 0; rep.deratedEdge = -1; rep.deratedBy = 1;
    rep.npshWorst = Infinity; rep.npshEdge = -1;
    rep.trapped = 0; rep.trappedNew = 0; rep.trappedNode = -1;
    rep.spill = 0; rep.hostMakeup = 0; rep.massResidual = 0; rep.energyResidual = 0;
    rep.massAdriftStep = 0;
    rep.edgeVisits = 0; rep.ms = 0;

    if (this._builtVersion !== this._net.version) this.rebuild();

    let mScale = 1;
    for (let e = 0; e < s.nEdges; e++) {
      const m = s.egMdot[e] >= 0 ? s.egMdot[e] : -s.egMdot[e];
      if (m > mScale) mScale = m;
    }
    rep.mdotScale = mScale;

    if (dt === 0) {
      publish(s, 0);
      if (opts.clock) rep.ms = this._clock() - t0;
      return rep;
    }

    // The network is read-only for the duration of the step: an edit from
    // inside a listener would re-index the arrays these loops are walking.
    this._net._freeze();
    try {
      this._applyInputs(dt);

      const nSub = clamp(Math.round(this.thermal.subcycles(dt)), 1, opts.maxSub) | 0;
      const dts = dt / nSub;
      rep.subSteps = nSub;
    // What the network is taking, so an edge that asked for more can make up
    // the difference by itself inside each of them. See advect's fine branch.
    this.thermal.nSubNow = nSub;
    rep.subWanted = this.thermal.subWanted || nSub;
    rep.subCapped = this.thermal.subCapped || 0;
    const why = this.thermal.subWhy, at = this.thermal.subAt;
    rep.subWantedWhy = why === 0 ? 'volume' : (why === 1 ? 'edge' : (why === 2 ? 'work' : ''));
    rep.subWantedBy = at < 0 ? ''
      : (why === 0 ? (s.nodeIds.ids()[at] || '') : (s.edgeIds.ids()[at] || ''));

      let m0 = 0;
      for (let i = 0; i < s.nNodes; i++) if (s.ndKind[i] === 1) m0 += s.ndM[i];
      let bnd = 0;

      for (let k = 0; k < nSub; k++) {
        // a. the flows this sub-step started from, and the host's sources
        for (let e = 0; e < s.nEdges; e++) s.egMprev[e] = s.egMdot[e];
        this._applyHoldsPre(dts);
        this._applyHeat(dts);

        // b..f. the whole simulation. Nothing in here has a stability limit
        // in dt: the hydraulic solve is quasi-static, the inertia term is
        // implicit, transport is semi-Lagrangian, exchangers are eps-NTU or
        // exponential relaxations, and the one explicit integration is
        // protected by the availability ramp and the inventory clamp.
        const r = this.hydraulic.solve(dts);
        // A JUNCTION HOLDS NOTHING, SO WHAT LEAVES IT CANNOT EXCEED WHAT
        // ARRIVES, and when the Newton could not make that true the volumes
        // must not be told otherwise. See _closeJunctions.
        const closed = r && r.converged === false ? this._closeJunctions() : 0;
        if (r) {
          // NOT rep.iters += r.iters. Hydraulic._report has already added this
          // sub-step's iterations to the report, and adding them again here
          // made report.iters exactly twice the truth: a single converged
          // Newton step read as 2, and the count could pass its own analytic
          // bound of maxSub * maxIter. The rest of the merge stays, because
          // taking the WORST residual and the LARGEST pin count over the
          // sub-steps is not the same as the last sub-step's, and a frame that
          // struggled once in eight has to stay visible.
          if (r.resid > rep.resid) rep.resid = r.resid;
          if (r.converged === false) rep.converged = false;
          if (r.pinned > rep.pinned) rep.pinned = r.pinned;
        }
        // The mass an imposed pressure put into the network, or took out of
        // it. A junction holds no inventory, so pinning its pressure makes it
        // a source: the flows around it no longer have to close and the
        // difference is mass the host created. It belongs in hostMakeup with
        // the imposed levels, for the same reason: an imposed value shows up
        // as a number rather than as a silently broken mass balance.
        rep.hostMakeup += dts * this._imposedFlux();

        this.thermal.mixNodes();
        // The host's word, applied again HERE and not only at the end of the
        // step. mixNodes has just overwritten every junction's enthalpy with
        // what arrived, which wipes an imposed temperature; advect then carries
        // the wiped value downstream and the edge leaving the node publishes a
        // temperature the node itself does not have. That is a step at a joint
        // manufactured by the hold, and invariant 5 says there is no
        // representation for one in this model.
        this._applyStateHolds();

        this.thermal.advect(dts);
        this.thermal.wall(dts);
        this.thermal.volumes(dts);
        // What crossed in THIS sub-step, counted the way the volumes counted
        // it: a shut edge moves nothing, however much its solved flow says.
        for (let e = 0; e < s.nEdges; e++) {
          if (s.egOpen[e]) s.egCrossed[e] += s.egMdot[e] * dts;
        }
        // AND THE SOLVE GETS ITS OWN ANSWER BACK. The closure above is about
        // the WATER: what a junction with no inventory could actually pass, so
        // the volumes are not told two different numbers. It is not a new
        // iterate. Leaving the scaled value in egMdot makes it egMprev on the
        // next sub-step, and the inertia term then sees an acceleration that
        // never happened and spends the whole solve arguing with it: measured
        // on the consumer's gravity scenario, whose severed loop the solve is
        // right to want flow through, that took 1 unconverged step of 300 to
        // 299. The mass moved is the closed one; the flow the solver
        // remembers is the one it computed.
        if (closed > 0) this._restoreClosed();
        this._applyHoldsPost(dts);

        bnd += dts * this._boundaryFlux();
      }

      // 4. the free surfaces, once per whole step: a surface is a look, not a
      //    state the physics reads back, so sub-stepping it buys nothing.
      this._stepSurfaces(dt);

      let m1 = 0;
      for (let i = 0; i < s.nNodes; i++) if (s.ndKind[i] === 1) m1 += s.ndM[i];
      // rep.starvedVolumes is NOT written here. thermal.js counts every volume
      // that starved in any sub-step and has already published that; taking a
      // snapshot of ndDrain after the last sub-step instead reported zero for
      // a step whose first sub-step ran a tank dry, while rep.spill still
      // carried the kilograms it could not find. A report that says mass went
      // missing and nothing was starved names nothing. One writer per field.
      //
      // Invariant 1. Everything that entered or left the mass-holding part of
      // the network is accounted for: what crossed a boundary, what the host
      // put in through an imposed level, and what the inventory clamp could
      // not find. Anything else is junction closure error.
      //
      // MINUS spill, not plus. Spill is mass the network delivered that the
      // volume did not have, so it was created at the volume: the inventory
      // fell by less than what left, and the surplus has to be subtracted to
      // close the books. With the sign the other way round the residual read
      // twice the spill instead of zero, which meant the one audit that exists
      // to catch a leak was itself broken in exactly the frames that leak.
      // The kilogrammes that came from nowhere, before any scaling. An
      // unconverged step's flows do not close, and the volumes integrate them
      // anyway, so the difference lands in inventories as real water: the
      // consumer found twenty-five tonnes booked into a hotwell over five bad
      // steps, and had to bisect for it because the report said nothing. It
      // says it now, and it SUMS it, because the one step that did the damage
      // is long gone by the time anybody looks.
      const adrift = Math.abs(m1 - m0 - bnd - rep.hostMakeup - rep.spill);
      rep.massAdriftStep = adrift;
      rep.massResidual = adrift / (mScale * dt);
      // Invariant 4 is thermal.js's to report and it has already written it.
      // There was a second, advection-only residual computed here that
      // overwrote thermal's whole-system audit with a worse number: it took
      // two full sweeps of the cell array per sub-step to measure less, and
      // being scaled by a net flux that cancels at steady state it read 1.0 on
      // a healthy loop. One writer per report field, and this is not it.

      // The running total, over the steps that did not converge. A converged
      // step's residual is a rounding error and summing it for a million
      // frames would turn that rounding into a number; a step that FAILED is
      // the one whose water is unaccounted for, and those are what this counts.
      if (!rep.converged) rep.massAdrift += adrift;

      // 5. the read surface: velocities, scroll phase, run ranges.
      publish(s, dt);

      // WHAT THE HOST IMPOSED, MEASURED AGAINST WHAT THE PIPE CAN CARRY. An
      // imposed flow is never overridden: the host is right by construction,
      // and that is the whole point of the layer. But an imposed 1900 kg/s
      // through a line that has gone to vapour is a quarter of a million
      // metres a second on the screen, and nothing said so. A solved edge is
      // held to egVmax by a penalty resistance and counted in clampedEdges; a
      // held one is counted here instead, with the first offender named, so
      // the host learns from the report what it could not have known when it
      // set the number.
      for (let e = 0; e < s.nEdges; e++) {
        if (!s.egHoldOn[e]) continue;
        const v = s.egV[e] >= 0 ? s.egV[e] : -s.egV[e];
        if (!(v > num(s.egVmax[e], 60))) continue;
        rep.overspeedEdges++;
        if (!rep.overspeedEdge) rep.overspeedEdge = s.edgeIds.ids()[e];
      }
      // AND WHY THE PICTURE IS STILL. A network where nothing moves hands a
      // host twenty zeros and no clue which came first; on a station it took
      // an instrumented solver to find that a feed nozzle had come out of the
      // water. The count is what is shut and the name is the first of them,
      // with the reason in a word.
      // A valve the host closed on purpose is the least interesting shut edge
      // there is, and on a station it is also the first by index: report the
      // one that was shut BY THE PHYSICS if there is one, and fall back to the
      // deliberate ones only when there is not.
      const WHY = ['', 'uncovered', 'valve', 'check', 'starved'];
      let pick = -1, pickWhy = 0;
      for (let e = 0; e < s.nEdges; e++) {
        if (s.egOpen[e]) continue;
        rep.shutEdges++;
        const why = s.egShutWhy ? s.egShutWhy[e] : 0;
        const interesting = why !== 2;
        if (pick < 0 || (interesting && pickWhy === 2)) { pick = e; pickWhy = why; }
      }
      if (pick >= 0) {
        rep.shutEdge = s.edgeIds.ids()[pick];
        rep.shutWhy = WHY[pickWhy] || 'shut';
      }
      // The node whose pressure ended the solve on its bound, named: hydraulic.js
      // has no ids either, and this is the address a host needs to see that its
      // pump is asking for water no pressure above vacuum can deliver.
      if (typeof rep.trappedNode === 'number') {
        rep.trappedNode = rep.trappedNode >= 0 ? s.nodeIds.ids()[rep.trappedNode] : '';
      }
      if (typeof rep.atBoundNode === 'number') {
        rep.atBoundNode = rep.atBoundNode >= 0 ? s.nodeIds.ids()[rep.atBoundNode] : '';
      }
      // The pump making the least of its head, named. An EDGE and not a node,
      // because a pump is a device on an edge and that is what a host has a
      // handle for.
      if (typeof rep.deratedEdge === 'number') {
        rep.deratedEdge = rep.deratedEdge >= 0 ? s.edgeIds.ids()[rep.deratedEdge] : '';
      }
      if (typeof rep.npshEdge === 'number') {
        rep.npshEdge = rep.npshEdge >= 0 ? s.edgeIds.ids()[rep.npshEdge] : '';
      }
      // The node whose held temperature could not be kept, named. _holdT marks
      // it by index plus one, so that node zero is not the same as none.
      if (this._unmetAt > 0) rep.unmetHold = s.nodeIds.ids()[this._unmetAt - 1];
      // A vessel holding more than it can, named. thermal.js has no ids, so it
      // reports the index and this turns it into something a host can act on.
      if (typeof rep.overfilledNode === 'number') {
        rep.overfilledNode = rep.overfilledNode >= 0 ? s.nodeIds.ids()[rep.overfilledNode] : '';
      }
      // The worst-closing node arrives from hydraulic.js as an index, because
      // that file has no ids. A host needs the name.
      if (typeof rep.worstNode === 'number') {
        rep.worstNode = rep.worstNode >= 0 ? s.nodeIds.ids()[rep.worstNode] : '';
      }
    } catch (err) {
      // step() NEVER throws. A module below this one that does is a bug, and
      // the honest response is to put the last known good picture back, count
      // it and say so, not to take the whole frame loop down with it.
      this._recover(err && err.message ? err.message : String(err), -1);
    } finally {
      this._net._thaw();
    }

    // 6. Nothing non-finite may leave this function. The same pass captures
    //    the state as the new last-known-good when it is clean.
    if (!this._verifyAndCapture()) this._recover(this._badArray, this._badIndex);
    if (opts.clock) rep.ms = this._clock() - t0;
    return rep;
  }

  _clock() {
    // The host's clock, never the core's. src/core owns no wall clock at all,
    // which is what makes two runs bitwise identical.
    if (this._clockBad) {
      this._reject('opts.clock: pass the host clock FUNCTION, e.g. () => performance.now(), not a flag');
      return 0;
    }
    try { const v = this.opts.clock(); return Number.isFinite(v) ? v : 0; } catch (e) { return 0; }
  }

  // Device travel. Both laws are written so the answer does not depend on how
  // the step was cut up: a constant stroke rate for a valve, and an exact
  // exponential for a pump coasting down.
  _applyInputs(dt) {
    const net = this._net;
    for (let k = 0; k < net.devices.length; k++) {
      const d = net.devices[k];
      if (d.kind === 'valve') {
        const step = dt / d.tau;
        d.open = clamp(d.open + clamp(d.cmd - d.open, -step, step), 0, 1);
      } else if (d.kind === 'pump') {
        const f = Math.exp(-dt / d.inertia);
        // num(), and not the bare expression, because `speed` is a field the
        // HOST owns and writes: a plant model that sends one NaN frame would
        // otherwise leave NaN in the layout for ever, since NaN times anything
        // is NaN and the coastdown reads its own previous value back. The
        // command is the right place to land, and a NaN command lands on zero,
        // which is a pump that has stopped. The valve above already does this
        // through its clamp; the pump had nothing.
        const c = num(d.cmd, 0);
        d.speed = num(c + (d.speed - c) * f, c);
      }
    }
  }

  // ndQ is filled HERE, once per sub-step, from every source, sink and ambient
  // link that targets a NODE. thermal.wall() applies edge heat to cells and
  // exchanger duty where it has to see both sides; it must not add source or
  // sink duty to a node again or the heat is counted twice.
  _applyHeat(dts) {
    const s = this.sys, net = this._net;
    for (let i = 0; i < s.nNodes; i++) s.ndQ[i] = 0;
    for (let k = 0; k < net.heat.length; k++) {
      const h = net.heat[k];
      const i = h._onNode;
      if (i < 0) continue;
      if (h.kind === 'source' || h.kind === 'sink') {
        s.ndQ[i] += h._sign * num(h.W, 0);
      } else if (h.kind === 'ambient') {
        // The exponential form, not U*A*dT, so that a huge dt relaxes the node
        // towards ambient instead of shooting past it. For a node the perim
        // field is read as the wetted AREA in m2, since a node has no length.
        const UA = Math.max(0, h.U * h.perim);
        const C = Math.max(1, s.ndM[i] * cpLiquid(s.ndT[i]));
        const dT = s.ndT[i] - h.Tinf;
        const dTn = dT * Math.exp(-UA * dts / C);
        s.ndQ[i] += C * (dTn - dT) / dts;
      }
    }
  }

  // =========================================================================
  // the impose layer: the host is always right
  // =========================================================================

  // spec is {p} | {T} | {h} | {level} | null. A value passed here reads back
  // BIT-IDENTICAL and the rest of the network is made consistent with it.
  // Nothing in this library ever argues with a number the plant model gave it;
  // where an imposed level means mass had to appear from nowhere, the amount
  // shows up in report.hostMakeup rather than as a silently broken balance.
  impose(nodeId, spec) {
    const i = this.sys.nodeIds.index(nodeId);
    if (i < 0) return this._reject('impose:' + nodeId);
    if (spec == null) {
      this._nodeHolds.delete(nodeId);
      this._restoreDirichlet(i);
      this._assignSlots(); this._compileHolds();
      return this;
    }
    const cur = this._nodeHolds.get(nodeId) || { mask: 0, p: 0, T: 0, h: 0, level: 0 };
    if (spec.p != null) { if (!Number.isFinite(spec.p)) return this._reject('impose.p:' + nodeId); cur.mask |= HOLD_P; cur.p = spec.p; }
    if (spec.T != null) { if (!Number.isFinite(spec.T)) return this._reject('impose.T:' + nodeId); cur.mask |= HOLD_T; cur.T = spec.T; }
    if (spec.h != null) { if (!Number.isFinite(spec.h)) return this._reject('impose.h:' + nodeId); cur.mask |= HOLD_H; cur.h = spec.h; }
    if (spec.level != null) { if (!Number.isFinite(spec.level)) return this._reject('impose.level:' + nodeId); cur.mask |= HOLD_L; cur.level = spec.level; }
    this._nodeHolds.set(nodeId, cur);
    this._assignSlots();
    this._compileHolds();
    this._applyHoldsPost(0, false);
    return this;
  }

  imposeFlow(edgeId, mdot) {
    const e = this.sys.edgeIds.index(edgeId);
    if (e < 0) return this._reject('imposeFlow:' + edgeId);
    if (mdot == null) { this._flowHolds.delete(edgeId); this.sys.egHoldOn[e] = 0; return this; }
    if (!Number.isFinite(mdot)) return this._reject('imposeFlow:' + edgeId);
    this._flowHolds.set(edgeId, mdot);
    this.sys.egHold[e] = mdot;
    this.sys.egHoldOn[e] = 1;
    this.sys.egMdot[e] = mdot;
    return this;
  }

  // The M3 migration hook: a host that already knows the two end temperatures
  // of a run hands them over and the library draws them, while everything
  // downstream of the hold keeps solving. It releases cleanly.
  imposeEdgeT(edgeId, spec) {
    const e = this.sys.edgeIds.index(edgeId);
    if (e < 0) return this._reject('imposeEdgeT:' + edgeId);
    if (spec == null) { this._edgeTHolds.delete(edgeId); this.sys.egTHoldOn[e] = 0; return this; }
    const T0 = spec.T0, T1 = spec.T1;
    if (!Number.isFinite(T0) || !Number.isFinite(T1)) return this._reject('imposeEdgeT:' + edgeId);
    this._edgeTHolds.set(edgeId, { T0, T1 });
    this.sys.egTHold[2 * e] = T0;
    this.sys.egTHold[2 * e + 1] = T1;
    this.sys.egTHoldOn[e] = 1;
    this.sys.egT0[e] = T0;
    this.sys.egT1[e] = T1;
    return this;
  }

  release(id) {
    this._nodeHolds.delete(id);
    this._flowHolds.delete(id);
    this._edgeTHolds.delete(id);
    this._restoreDirichlet(this.sys.nodeIds.index(id));
    const e = this.sys.edgeIds.index(id);
    if (e >= 0) { this.sys.egHoldOn[e] = 0; this.sys.egTHoldOn[e] = 0; }
    this._assignSlots();
    this._compileHolds();
    return this;
  }

  // Put a released node's pressure back where a Dirichlet pressure comes from.
  // A boundary is held at its own p and a free volume at the pressure of the
  // gas above it, and NOTHING in the step path ever writes either, because
  // hydraulic.js only touches nodes that are Newton unknowns. Without this, a
  // vessel whose pressure the host imposed once and then released would sit at
  // that pressure for the rest of the session, and the only thing that would
  // ever move it is an unrelated edit that happened to force a rebuild.
  _restoreDirichlet(i) {
    const s = this.sys;
    if (!(i >= 0) || i >= s.nNodes) return;
    const n = this._net.nodes[i];
    if (!n) return;
    if (s.ndKind[i] === 2) s.ndP[i] = num(n.p, s.ndP[i]);
    // A CLOSED space keeps the pressure it has arrived at: `gas.p` is where it
    // started and not what it is held at, so putting the authored number back
    // would undo everything the vessel has done since.
    else if (s.ndFree[i] && !s.ndClosed[i]) s.ndP[i] = num(n.gas ? n.gas.p : undefined, s.ndP[i]);
  }

  _reject(what) {
    this.report.rejected++;
    this.report.rejectedField = what;
    return this;
  }

  // The id-keyed holds compiled into flat arrays, so the per-sub-step pass is
  // a walk over two typed arrays with no iterator and no allocation.
  _compileHolds() {
    const s = this.sys, nN = s.nNodes;
    this._hn = growI32(this._hn, nN); this._hmask = growU8(this._hmask, nN);
    this._hp = growF64(this._hp, nN); this._ht = growF64(this._ht, nN);
    this._hh = growF64(this._hh, nN); this._hl = growF64(this._hl, nN);
    let k = 0;
    for (const entry of this._nodeHolds) {
      const i = s.nodeIds.index(entry[0]);
      if (i < 0) continue;
      this._hn[k] = i; this._hmask[k] = entry[1].mask;
      this._hp[k] = entry[1].p; this._ht[k] = entry[1].T;
      this._hh[k] = entry[1].h; this._hl[k] = entry[1].level;
      k++;
    }
    this._hcount = k;
    // The pressure-held flag, rebuilt from scratch every time: a hold that was
    // released must stop being one.
    if (s.ndPHold) {
      s.ndPHold.fill(0, 0, nN);
      for (let j = 0; j < k; j++) if (this._hmask[j] & HOLD_P) s.ndPHold[this._hn[j]] = 1;
    }
    // Edge holds live in Sys itself, so they only need reinstating after a
    // rebuild has cleared the flags.
    for (const entry of this._flowHolds) {
      const e = s.edgeIds.index(entry[0]);
      if (e < 0) continue;
      s.egHold[e] = entry[1]; s.egHoldOn[e] = 1; s.egMdot[e] = entry[1];
    }
    for (const entry of this._edgeTHolds) {
      const e = s.edgeIds.index(entry[0]);
      if (e < 0) continue;
      s.egTHold[2 * e] = entry[1].T0; s.egTHold[2 * e + 1] = entry[1].T1;
      s.egTHoldOn[e] = 1;
    }
  }

  // Before the solve: the Dirichlet pressures the host asked for, the sources
  // that stand for an imposed flow, and the makeup rate an imposed level
  // implies, so that the hydraulics see the whole picture rather than being
  // corrected afterwards.
  _applyHoldsPre(dts) {
    const s = this.sys;
    for (let i = 0; i < s.nNodes; i++) s.ndSrc[i] = 0;
    for (let e = 0; e < s.nEdges; e++) {
      if (!s.egHoldOn[e]) continue;
      const m = s.egHold[e];
      s.egMdot[e] = m;
      const a = s.egFrom[e], b = s.egTo[e];
      if (a >= 0) s.ndSrc[a] -= m;
      if (b >= 0) s.ndSrc[b] += m;
    }
    for (let k = 0; k < this._hcount; k++) {
      const i = this._hn[k], mask = this._hmask[k];
      if (mask & HOLD_P) s.ndP[i] = this._hp[k];
      if ((mask & HOLD_L) && s.ndKind[i] === 1) {
        const shape = s.ndShape[i];
        const Vt = volumeAt(shape, this._hl[k]);
        const target = Vt * s.ndRhoL[i];
        s.ndSrc[i] += (target - s.ndM[i]) / dts;
      }
    }
  }

  // The pressure, temperature and enthalpy holds only, with no inventory and
  // no accounting. Run once per sub-step immediately after node mixing, so
  // that the enthalpy transport carries downstream is the one the host asked
  // for. Splitting this out of _applyHoldsPost is deliberate: the level hold
  // moves mass and adds to hostMakeup, and doing that twice a sub-step would
  // report double what the host actually put in.
  // A HELD TEMPERATURE THE FLUID CANNOT ACTUALLY HAVE IS A LIE THE WHOLE
  // PICTURE REPEATS, so this is the one writer for one and both places that
  // apply a hold come through it. hOf takes the phase the node is ALREADY in,
  // so asking a water-solid vessel at 155 bar for 660 K asks the liquid branch
  // for a temperature 42 K past its own saturation line: the enthalpy clamps
  // at hf, 1663.3 kJ/kg, and the node then published 660 K while holding water
  // that is at 617.4. Every pipe leaving a node takes its upstream end FROM
  // THE NODE, so the mouth of the pipe read 660 and its far end read the 617.4
  // it was actually carrying, and that gap never closes however long it runs
  // or however small the step is. It looks exactly like a transport failure,
  // it survives every step size, and it is not one. Measured: held at 560, 600
  // and 617 K the vessel and its pipe agree to the digit; held at 630 the gap
  // is 12.58 K and at 660 it is 42.58, which is the size of the impossible
  // part of the request and nothing else.
  //
  // So the enthalpy is written from the request and the request is then READ
  // BACK OFF IT. Where the two agree the node publishes what was asked for,
  // bit-identical, which is what imposition means and what every attainable
  // hold does. Where they do not, the node publishes what it IS and
  // report.unmetHolds says whose word could not be kept. Honouring it the
  // other way, by making the vessel steam, would overrule the model's own
  // authoring: `free: false` IS the host saying this vessel is water-solid.
  _holdT(i, want) {
    const s = this.sys, st = this._st;
    s.ndH[i] = hOf(s.ndP[i], want, s.ndX[i]);
    stateOf(s.ndP[i], s.ndH[i], st);
    const got = Math.abs(st.T - want) <= HOLD_T_TOL ? want : st.T;
    s.ndRho[i] = density(got, s.ndP[i], s.ndX[i]);
    s.ndRhoL[i] = rhoLiquidSat(got);
    s.ndT[i] = got;                // last, so an attainable hold is exact
    if (got === want) return 0;
    if (!this._unmetAt) this._unmetAt = i + 1;
    return 1;
  }

  _applyStateHolds() {
    const s = this.sys, st = this._st;
    let unmet = 0;
    for (let k = 0; k < this._hcount; k++) {
      const i = this._hn[k], mask = this._hmask[k];
      if (mask & HOLD_P) s.ndP[i] = this._hp[k];
      if (mask & HOLD_H) {
        s.ndH[i] = this._hh[k];
        stateOf(s.ndP[i], s.ndH[i], st);
        s.ndT[i] = st.T; s.ndX[i] = st.x; s.ndRho[i] = st.rho; s.ndRhoL[i] = rhoLiquidSat(st.T);
      }
      if (mask & HOLD_T) unmet += this._holdT(i, this._ht[k]);
    }
    // HOW MANY HOLDS COULD NOT BE KEPT, not how many times they could not be
    // kept: this runs once a sub-step, so accumulating would multiply one
    // impossible request by the sub-step count and report eight vessels where
    // there is one. The same rule as report.pinned, for the same reason.
    if (unmet > this.report.unmetHolds) this.report.unmetHolds = unmet;
  }

  // Mass per second entering the network at a JUNCTION whose pressure the host
  // has pinned, kg/s, positive in. A junction holds nothing, so its incident
  // flows have to sum to zero; pinning its pressure removes that equation from
  // the system and whatever no longer balances is mass the host supplied. A
  // volume is different even when its pressure is held, because it still
  // integrates its own inventory from the real flows, and a boundary is
  // already counted by _boundaryFlux.
  _imposedFlux() {
    const s = this.sys;
    let f = 0;
    for (let i = 0; i < s.nNodes; i++) {
      if (s.ndKind[i] !== 0 || s.ndSlot[i] >= 0) continue;
      for (let e = 0; e < s.nEdges; e++) {
        if (!s.egOpen[e]) continue;
        if (s.egTo[e] === i) f -= s.egMdot[e];
        else if (s.egFrom[e] === i) f += s.egMdot[e];
      }
    }
    return f;
  }

  // After the volumes have integrated: the host's word is the last word. A
  // temperature or an enthalpy hold is written back exactly, so it reads back
  // bit-identical rather than round-tripped through an equation of state.
  // `seam` is false when this runs from impose() rather than from a step. The
  // state and the level are instantaneous and belong there; repainting the
  // ends of every edge that is not temperature-held does NOT, because what it
  // does depends on which OTHER holds happen to be set at that instant.
  //
  // Measured on the consumer's station: releasing a level hold in the same
  // instant as twelve seeded edge holds, which is what its app did at boot,
  // sent the condensate line into a reversal three vessels away and neither
  // build recovered, 59 steps of 61 unconverged with the suction check
  // flapping and its boiler draining 190 t to 87. Releasing the same hold one
  // step later, or BEFORE the edge holds instead of after, is 1 of 61: the
  // order mattered because this pass reads egTHoldOn to decide whether to
  // repaint a seam, so freeing those edges first changed what it did between
  // one step and the next.
  _applyHoldsPost(dts, seam = true) {
    const s = this.sys, st = this._st, rep = this.report;
    let unmet = 0;
    for (let k = 0; k < this._hcount; k++) {
      const i = this._hn[k], mask = this._hmask[k];
      if (mask & HOLD_P) s.ndP[i] = this._hp[k];
      if (mask & HOLD_H) {
        s.ndH[i] = this._hh[k];
        stateOf(s.ndP[i], s.ndH[i], st);
        s.ndT[i] = st.T; s.ndX[i] = st.x; s.ndRho[i] = st.rho; s.ndRhoL[i] = rhoLiquidSat(st.T);
      }
      if (mask & HOLD_T) unmet += this._holdT(i, this._ht[k]);
      if ((mask & HOLD_L) && s.ndKind[i] === 1) {
        const shape = s.ndShape[i];
        const Vliq = volumeAt(shape, this._hl[k]);
        const target = Vliq * s.ndRhoL[i];
        rep.hostMakeup += target - s.ndM[i];
        s.ndM[i] = target;
        s.ndLevel[i] = this._hl[k];
        s.ndFill[i] = shape.Vtotal > 0 ? clamp(Vliq / shape.Vtotal, 0, 1) : 0;
        s.ndAsurf[i] = areaAt(shape, this._hl[k]);
      }
      // An edge drawing from a node whose temperature or enthalpy the host has
      // pinned publishes THAT temperature at its upstream end. thermal's own
      // end pass ran before this one and took the node's mixed value, so
      // without this the pipe leaving an imposed vessel is painted a different
      // colour from the vessel itself at the very point they join. Invariant 5
      // says there is no representation in this model for a step at a seam,
      // and a hold must not be able to manufacture one.
      if (seam && (mask & (HOLD_T | HOLD_H))) {
        for (let e = 0; e < s.nEdges; e++) {
          if (s.egTHoldOn[e]) continue;          // an imposed pair wins over everything
          if (s.egMdot[e] >= 0) {
            if (s.egFrom[e] === i) { s.egT0[e] = s.ndT[i]; s.egX0[e] = s.ndX[i]; }
          } else if (s.egTo[e] === i) { s.egT1[e] = s.ndT[i]; s.egX1[e] = s.ndX[i]; }
        }
      }
    }
    // An edge whose end temperatures are held publishes exactly those numbers,
    // whatever transport did to its cells.
    if (seam) {
      for (let e = 0; e < s.nEdges; e++) {
        if (!s.egTHoldOn[e]) continue;
        s.egT0[e] = s.egTHold[2 * e];
        s.egT1[e] = s.egTHold[2 * e + 1];
      }
    }
    if (unmet > rep.unmetHolds) rep.unmetHolds = unmet;
  }

  // =========================================================================
  // surfaces, accounting, recovery
  // =========================================================================

  _stepSurfaces(dt) {
    const s = this.sys, o = this._sopt;
    for (let i = 0; i < s.nNodes; i++) {
      const surf = s.ndSurf[i];
      if (!surf) continue;
      const shape = s.ndShape[i];
      const A = Math.max(0.01, s.ndAsurf[i]);
      surf.setWidth(2 * Math.sqrt(A / Math.PI));
      surf.setDepth(s.ndLevel[i] - shape.y0);
      // The surface reads a boil INTENSITY, not a mass rate: what the eye
      // reads is how hard the top of the water is breaking up per square
      // metre, and that has to be the same picture in a bucket and in a pool.
      o.boil = clamp(s.ndBoil[i] / (A * BOIL_FULL), 0, 1);
      o.pour = s.ndPour[i] / Math.max(1e-6, s.ndRho[i] * A);
      o.pourAt = clamp(s.ndPourAt[i], 0, 1);
      o.still = s.ndFill[i] < 1e-4;
      surf.step(dt, o);
    }
  }

  // Mass crossing the boundary of the mass-holding network, kg/s, positive in.
  // Junctions hold nothing, so everything that is not in a volume came from or
  // went to a boundary node.
  _boundaryFlux() {
    const s = this.sys;
    let f = 0;
    for (let e = 0; e < s.nEdges; e++) {
      if (!s.egOpen[e]) continue;
      const a = s.egFrom[e], b = s.egTo[e];
      const ka = a >= 0 ? s.ndKind[a] : 2, kb = b >= 0 ? s.ndKind[b] : 2;
      if (ka === 2 && kb !== 2) f += s.egMdot[e];
      else if (kb === 2 && ka !== 2) f -= s.egMdot[e];
    }
    return f;
  }

  _newSnap() {
    const s = this.sys;
    return {
      version: -1, nN: 0, nE: 0, nC: 0,
      ndP: new Float64Array(s.ndP.length), ndH: new Float64Array(s.ndH.length),
      ndT: new Float64Array(s.ndT.length), ndX: new Float64Array(s.ndX.length),
      ndRho: new Float64Array(s.ndRho.length), ndM: new Float64Array(s.ndM.length),
      ndLevel: new Float64Array(s.ndLevel.length), ndFill: new Float64Array(s.ndFill.length),
      egMdot: new Float64Array(s.egMdot.length), egPhase: new Float64Array(s.egPhase.length),
      cellH: new Float64Array(s.cellH.length)
    };
  }

  _fitSnap(sn) {
    const s = this.sys;
    if (sn.ndP.length < s.ndP.length) {
      sn.ndP = new Float64Array(s.ndP.length); sn.ndH = new Float64Array(s.ndP.length);
      sn.ndT = new Float64Array(s.ndP.length); sn.ndX = new Float64Array(s.ndP.length);
      sn.ndRho = new Float64Array(s.ndP.length); sn.ndM = new Float64Array(s.ndP.length);
      sn.ndLevel = new Float64Array(s.ndP.length); sn.ndFill = new Float64Array(s.ndP.length);
    }
    if (sn.egMdot.length < s.egMdot.length) {
      sn.egMdot = new Float64Array(s.egMdot.length); sn.egPhase = new Float64Array(s.egMdot.length);
    }
    if (sn.cellH.length < s.cellH.length) sn.cellH = new Float64Array(s.cellH.length);
    return sn;
  }

  _capture(sn) {
    const s = this.sys;
    this._fitSnap(sn);
    sn.version = this._net.version; sn.nN = s.nNodes; sn.nE = s.nEdges; sn.nC = s.cellCap;
    for (let i = 0; i < s.nNodes; i++) {
      sn.ndP[i] = s.ndP[i]; sn.ndH[i] = s.ndH[i]; sn.ndT[i] = s.ndT[i]; sn.ndX[i] = s.ndX[i];
      sn.ndRho[i] = s.ndRho[i]; sn.ndM[i] = s.ndM[i]; sn.ndLevel[i] = s.ndLevel[i]; sn.ndFill[i] = s.ndFill[i];
    }
    for (let e = 0; e < s.nEdges; e++) { sn.egMdot[e] = s.egMdot[e]; sn.egPhase[e] = s.egPhase[e]; }
    for (let i = 0; i < s.cellCap; i++) sn.cellH[i] = s.cellH[i];
    return sn;
  }

  _apply(sn) {
    const s = this.sys;
    if (!sn || sn.nN !== s.nNodes || sn.nE !== s.nEdges || sn.nC !== s.cellCap) return false;
    for (let i = 0; i < s.nNodes; i++) {
      s.ndP[i] = sn.ndP[i]; s.ndH[i] = sn.ndH[i]; s.ndT[i] = sn.ndT[i]; s.ndX[i] = sn.ndX[i];
      s.ndRho[i] = sn.ndRho[i]; s.ndM[i] = sn.ndM[i]; s.ndLevel[i] = sn.ndLevel[i]; s.ndFill[i] = sn.ndFill[i];
    }
    for (let e = 0; e < s.nEdges; e++) { s.egMdot[e] = sn.egMdot[e]; s.egPhase[e] = sn.egPhase[e]; }
    for (let i = 0; i < s.cellCap; i++) s.cellH[i] = sn.cellH[i];
    return true;
  }

  snapshot() { return this._capture(this._newSnap()); }
  restore(snap) { return this._apply(snap); }

  // One pass over everything a consumer can read. Clean means it also becomes
  // the state to fall back to; dirty means the array and the index are named,
  // because "something went NaN somewhere" is not a bug report.
  _verifyAndCapture() {
    const s = this.sys;
    for (let i = 0; i < s.nNodes; i++) {
      if (!Number.isFinite(s.ndP[i])) return this._bad('ndP', i);
      if (!Number.isFinite(s.ndH[i])) return this._bad('ndH', i);
      if (!Number.isFinite(s.ndT[i])) return this._bad('ndT', i);
      if (!Number.isFinite(s.ndX[i])) return this._bad('ndX', i);
      if (!Number.isFinite(s.ndRho[i])) return this._bad('ndRho', i);
      if (!Number.isFinite(s.ndM[i])) return this._bad('ndM', i);
      if (!Number.isFinite(s.ndLevel[i])) return this._bad('ndLevel', i);
    }
    for (let e = 0; e < s.nEdges; e++) {
      if (!Number.isFinite(s.egMdot[e])) return this._bad('egMdot', e);
      if (!Number.isFinite(s.egV[e])) return this._bad('egV', e);
      if (!Number.isFinite(s.egRho[e])) return this._bad('egRho', e);
      if (!Number.isFinite(s.egT0[e])) return this._bad('egT0', e);
      if (!Number.isFinite(s.egT1[e])) return this._bad('egT1', e);
      if (!Number.isFinite(s.egPhase[e])) return this._bad('egPhase', e);
    }
    for (let i = 0; i < s.cellCap; i++) {
      if (!Number.isFinite(s.cellH[i])) return this._bad('cellH', i);
      if (!Number.isFinite(s.cellT[i])) return this._bad('cellT', i);
    }
    for (let r = 0; r < s.nRuns; r++) {
      if (!Number.isFinite(s.runLo[r]) || !Number.isFinite(s.runHi[r])) return this._bad('runLo', r);
    }
    this._good = this._capture(this._good || this._newSnap());
    return true;
  }

  _bad(what, i) { this._badArray = what; this._badIndex = i; return false; }

  _recover(what, index) {
    this.report.recoveries++;
    this._apply(this._good);
    // Re-derive everything the fallback does not carry, so the picture is
    // whole rather than half restored.
    for (let e = 0; e < this.sys.nEdges; e++) this._publishEdgeState(e, this._st);
    this._emit('recover', { array: what, index, recoveries: this.report.recoveries });
  }

  // =========================================================================
  // inputs and reading
  // =========================================================================

  // The live device object. Writing one of its fields is a tier-1 edit: it
  // bumps nothing and rebuilds nothing, because the coefficient pass reads the
  // field again every sub-step.
  device(id) { return this._net.device(id); }
  pump(id) { const d = this._net.device(id); return d && d.kind === 'pump' ? d : undefined; }
  valve(id) { const d = this._net.device(id); return d && d.kind === 'valve' ? d : undefined; }

  heat(id, W) {
    const h = this._net.heatLink(id);
    if (!h || (h.kind !== 'source' && h.kind !== 'sink')) return this._reject('heat:' + id);
    if (!Number.isFinite(W)) return this._reject('heat:' + id);
    h.W = num(W, h.W);
    return this;
  }

  setUA(id, UA) {
    const h = this._net.heatLink(id);
    if (!h || h.kind !== 'exchanger') return this._reject('setUA:' + id);
    if (!Number.isFinite(UA)) return this._reject('setUA:' + id);
    h.UA = Math.max(0, num(UA, h.UA));
    return this;
  }

  // Break a line at rounded-arclength fraction u. Sugar over the network edit
  // so a host does not have to know about splitEdge: the edge becomes two
  // halves and a stub carrying the hole, the cells of both halves keep the
  // water that was in them, and the next step solves the new graph.
  breakAt(edgeId, u, spec) {
    const net = this._net;
    const s = Object.assign({ id: edgeId + '#brk', kind: 'break', edge: edgeId, at: u, area: 0.01, cd: net.defaults.cd }, spec || null);
    let out = null;
    net.edit((n) => { out = n.splitEdge(edgeId, u, s); });
    this.rebuild();
    return out;
  }

  heal(edgeId) {
    const net = this._net;
    let out = null;
    net.edit((n) => { out = n.heal(edgeId); });
    this.rebuild();
    return out;
  }

  edge(id) { const e = this.sys.edgeIds.index(id); return e < 0 ? undefined : this._edgeViews[e]; }
  volume(id) {
    const i = this.sys.nodeIds.index(id);
    if (i < 0 || this.sys.ndKind[i] !== 1) return undefined;
    const k = this._volSlot[i];
    return k < 0 ? undefined : this._volViews[k];
  }
  // BY ID OR BY INDEX, because both are handed out. edge(id) and volume(id)
  // take an id, so run(id) does too; but EdgeView.run reports the run's INDEX,
  // which makes solver.run(edge.run) the natural thing for a renderer to write
  // and it would silently return undefined. A renderer that gets undefined
  // here falls back to an empty temperature span and paints the whole network
  // one flat colour, which looks like a shader problem and is not one.
  run(id) {
    if (typeof id === 'number') {
      return id >= 0 && id < this._runViews.length ? this._runViews[id] : undefined;
    }
    const r = this.sys.runIds.index(id);
    return r < 0 ? undefined : this._runViews[r];
  }

  get edges() { return this._edgeViews; }
  get volumes() { return this._volViews; }
  get runs() { return this._runViews; }
}
