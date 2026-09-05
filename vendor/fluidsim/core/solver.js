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

import { clamp, num, IdMap, growF64, growI32, growU8 } from './util.js';
import { roundedLength, elbows, bendK, areaOf, buildShape, levelOf, volumeAt, areaAt } from './geometry.js';
import { fluid, density, rhoLiquidSat, cpLiquid } from './props.js';
import { Network, NetworkError, MAX_NODES, autoRuns } from './network.js';
import { Surface } from './surface.js';
import { Hydraulic, pAt } from './hydraulic.js';
import { Thermal, stateOf, hOf, K_BULK } from './thermal.js';
import { publish, EdgeView, VolumeView, RunView } from './view.js';

export const DEFAULT_OPTS = Object.freeze({
  maxIter: 8, tol: 1e-4, maxDt: 10, maxSub: 8, inertia: true,
  vmaxLiquid: 60, vmaxVapour: 400, maxNodes: MAX_NODES, strictReference: false,
  // Unknowns at or below this are solved by the dense factorisation and
  // above it by the sparse conjugate gradient. See linalg.js for why.
  denseMax: 20
});

// How many columns a free surface gets, and how hard a body has to be boiling
// for the surface to read as a full rolling boil. 0.3 kg per square metre per
// second is roughly a pan at a hard boil; below that the churn fades out
// smoothly rather than switching on.
const SURFACE_N = 32;
const BOIL_FULL = 0.3;      // kg/(m2 s)

// Which hold is set on a node. One byte, so the per-sub-step pass over the
// holds is a scan of two small typed arrays and allocates nothing.
const HOLD_P = 1, HOLD_T = 2, HOLD_H = 4, HOLD_L = 8;

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
    ndDrain: U0,     // starved this sub-step
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
    if (net.nodes.length > this.opts.maxNodes) {
      throw new NetworkError('E_TOO_LARGE', '/nodes',
        'this network has ' + net.nodes.length + ' nodes and the limit is ' + this.opts.maxNodes,
        'the dense LDL^T factorisation is exact and cheap up to that count; a sparse path is M2');
    }

    // The report is ONE object for the life of the solver, handed back by
    // every step. A host may keep the reference.
    this.report = {
      dt: 0, subSteps: 0, iters: 0, resid: 0, converged: true, pinned: 0,
      clampedEdges: 0, starvedVolumes: 0, spill: 0, hostMakeup: 0,
      massResidual: 0, energyResidual: 0, mdotScale: 1, edgeVisits: 0, ms: 0,
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
    s.ndSolve = growU8(s.ndSolve, nN); s.ndFree = growU8(s.ndFree, nN); s.ndDrain = growU8(s.ndDrain, nN);
    if (!s.ndShape || s.ndShape.length < nN) { s.ndShape = new Array(nN); s.ndFluid = new Array(nN); s.ndSurf = new Array(nN); }

    s.egFrom = growI32(s.egFrom, nE); s.egTo = growI32(s.egTo, nE); s.egN = growI32(s.egN, nE);
    s.egDev = growI32(s.egDev, nE); s.egCells = growI32(s.egCells, nE); s.egOff = growI32(s.egOff, nE);
    s.egRun = growI32(s.egRun, nE); s.egKind = growI32(s.egKind, nE); s.egGeomVer = growI32(s.egGeomVer, nE);
    s.egA = growF64(s.egA, nE); s.egL = growF64(s.egL, nE); s.egD = growF64(s.egD, nE);
    s.egRough = growF64(s.egRough, nE); s.egKform = growF64(s.egKform, nE);
    s.egYFrom = growF64(s.egYFrom, nE); s.egYTo = growF64(s.egYTo, nE);
    s.egMdot = growF64(s.egMdot, nE); s.egMprev = growF64(s.egMprev, nE); s.egV = growF64(s.egV, nE);
    s.egRho = growF64(s.egRho, nE); s.egMu = growF64(s.egMu, nE); s.egG = growF64(s.egG, nE);
    s.egR2 = growF64(s.egR2, nE); s.egR1 = growF64(s.egR1, nE); s.egVmax = growF64(s.egVmax, nE);
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

    // The dense matrix is sized for EVERY node that could ever be an unknown,
    // not for the current count, so that impose({p}) can make a node Dirichlet
    // and release it again without allocating anything.
    s.A = growF64(s.A, nN * nN);
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
        if (oi < 0) m = n.fill * Vtot * density(st.T, p, st.x);
        s.ndM[i] = m;
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
    dt = clamp(num(dt, 0), 0, opts.maxDt);
    rep.dt = dt;
    rep.subSteps = 0; rep.iters = 0; rep.resid = 0; rep.converged = true;
    rep.pinned = 0; rep.clampedEdges = 0; rep.starvedVolumes = 0;
    rep.spill = 0; rep.hostMakeup = 0; rep.massResidual = 0; rep.energyResidual = 0;
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
      rep.massResidual = Math.abs(m1 - m0 - bnd - rep.hostMakeup - rep.spill)
        / (mScale * dt);
      // Invariant 4 is thermal.js's to report and it has already written it.
      // There was a second, advection-only residual computed here that
      // overwrote thermal's whole-system audit with a worse number: it took
      // two full sweeps of the cell array per sub-step to measure less, and
      // being scaled by a net flux that cancels at steady state it read 1.0 on
      // a healthy loop. One writer per report field, and this is not it.

      // 5. the read surface: velocities, scroll phase, run ranges.
      publish(s, dt);
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
    this._applyHoldsPost(1);
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
    else if (s.ndFree[i]) s.ndP[i] = num(n.gas ? n.gas.p : undefined, s.ndP[i]);
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
  _applyStateHolds() {
    const s = this.sys, st = this._st;
    for (let k = 0; k < this._hcount; k++) {
      const i = this._hn[k], mask = this._hmask[k];
      if (mask & HOLD_P) s.ndP[i] = this._hp[k];
      if (mask & HOLD_H) {
        s.ndH[i] = this._hh[k];
        stateOf(s.ndP[i], s.ndH[i], st);
        s.ndT[i] = st.T; s.ndX[i] = st.x; s.ndRho[i] = st.rho; s.ndRhoL[i] = rhoLiquidSat(st.T);
      }
      if (mask & HOLD_T) {
        s.ndH[i] = hOf(s.ndP[i], this._ht[k], s.ndX[i]);
        s.ndRho[i] = density(this._ht[k], s.ndP[i], s.ndX[i]);
        s.ndRhoL[i] = rhoLiquidSat(this._ht[k]);
        s.ndT[i] = this._ht[k];      // last, so it is exactly what was asked for
      }
    }
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
  _applyHoldsPost(dts) {
    const s = this.sys, st = this._st, rep = this.report;
    for (let k = 0; k < this._hcount; k++) {
      const i = this._hn[k], mask = this._hmask[k];
      if (mask & HOLD_P) s.ndP[i] = this._hp[k];
      if (mask & HOLD_H) {
        s.ndH[i] = this._hh[k];
        stateOf(s.ndP[i], s.ndH[i], st);
        s.ndT[i] = st.T; s.ndX[i] = st.x; s.ndRho[i] = st.rho; s.ndRhoL[i] = rhoLiquidSat(st.T);
      }
      if (mask & HOLD_T) {
        s.ndH[i] = hOf(s.ndP[i], this._ht[k], s.ndX[i]);
        s.ndRho[i] = density(this._ht[k], s.ndP[i], s.ndX[i]);
        s.ndRhoL[i] = rhoLiquidSat(this._ht[k]);
        s.ndT[i] = this._ht[k];      // last, so it is exactly what was asked for
      }
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
      if (mask & (HOLD_T | HOLD_H)) {
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
    for (let e = 0; e < s.nEdges; e++) {
      if (!s.egTHoldOn[e]) continue;
      s.egT0[e] = s.egTHold[2 * e];
      s.egT1[e] = s.egTHold[2 * e + 1];
    }
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
