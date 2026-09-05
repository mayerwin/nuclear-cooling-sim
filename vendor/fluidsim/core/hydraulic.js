// ---------------------------------------------------------------------------
// hydraulic.js - momentum and continuity: what makes the water move, and how
// much of it arrives.
//
// One mass flow per edge and one pressure per node. The edge law is a closed
// form: given the driving head across an edge it returns the flow AND the
// exact analytic derivative of that flow with respect to the head, in a
// handful of arithmetic operations with no inner iteration anywhere. Because
// the derivative is exact and positive, the nodal Jacobian is a weighted graph
// Laplacian, symmetric and positive definite by construction, so the dense
// LDL^T factorisation in linalg.js cannot divide by zero and the Newton step
// is always a descent direction. Nothing here can fail to converge in a way
// that stops the picture: non-convergence is a number in the report, never a
// throw and never a NaN.
//
// SI THROUGHOUT, as in props.js: kg/s, Pa absolute, K, kg/m3, Pa s, m, m2, s.
// R2 is Pa per (kg/s)^2, R1 is Pa per (kg/s), the conductance g is (kg/s)/Pa.
//
// NO ALLOCATION IN THE PER-FRAME PATH. Every array is grown in size(), which
// runs after a rebuild; the small "returns an object" helpers below hand back
// a module-level scratch object that is overwritten on each call, because a
// literal here would be a few hundred garbage objects a second on a phone.
//
// This file writes exactly these Sys fields and no others: egMdot, egG, egR2,
// egR1, egOpen, egAvail, egClamp, ndP for solved nodes only, and the report
// counters. In particular it never touches a Dirichlet node's pressure, so a
// host's imposed pressure reads back bit-identical.
// ---------------------------------------------------------------------------

import { clamp, num, sign0, smoothstep, growF64, growI32, growU8 } from './util.js?v=a7f82a57a1';
import { ldl, ldlSolve, pcg, LDL_EPS } from './linalg.js?v=a7f82a57a1';
import { G, tsat } from './props.js?v=a7f82a57a1';

// --- limits -----------------------------------------------------------------
// The laminar resistance floor is DERIVED FROM A VISCOSITY FLOOR rather than
// being a bare number, so it carries the units of a resistance and scales with
// the length and bore of the edge it is protecting. A magic constant with the
// dimensions of nothing in particular would be wrong by orders of magnitude on
// a garden hose and on a main coolant line at the same time, and this floor is
// the sole guarantor that every conductance is finite and strictly positive.
export const R1_MU_FLOOR = 1e-6;    // Pa s, the thinnest fluid R1 is allowed to see
export const R1_RHO_CEIL = 1200;    // kg/m3, the heaviest, so the quotient is smallest

export const RHO_FLOOR = 0.05, RHO_CEIL = 1200;   // kg/m3
export const MU_FLOOR = 1e-6, MU_CEIL = 1e-1;     // Pa s
export const P_FLOOR = 1e3, P_CEIL = 3e8;         // Pa absolute
export const DP_MAX = 2e7;          // Pa, the largest pressure move one Newton step may make
// And the smallest the trust radius may shrink to when the full step keeps
// being rejected. A pascal: small enough that any state is recoverable, large
// enough that the radius climbs back to DP_MAX in about twenty accepted
// iterations, which is a fraction of a second of frames.
export const TRUST_MIN = 1;         // Pa
export const UNCOVER = 0.05;        // m, the band over which a nozzle uncovers
// K below the saturation line over which a gas space stops being able to
// supply steam. One degree: narrow enough that a boiling vessel supplies
// freely, wide enough that the feedback it provides is smooth.
export const VAP_BAND = 1.0;
export const CAP_GAIN = 4;          // gain of the velocity/choking penalty resistance
export const CHECK_HYST = 50;       // Pa, the head a check valve needs before it changes state
export const VALVE_SHUT = 1e-3;     // `open` at or below this is hard closed, not nearly closed

// Internal limits, not part of the published surface.
const RE_FLOOR = 1e-3;              // Reynolds number floor, so f is finite at rest
// And a ceiling, so f is STRICTLY POSITIVE at the other end. Haaland's form
// goes to zero for a perfectly smooth pipe as Re goes to infinity, which is the
// right limit and the wrong answer to hand a solver: a zero friction factor is
// an edge with no quadratic resistance at all. The ceiling is far above
// anything a real line reaches (steam at 400 m/s in a metre bore is about 1e9)
// so it never binds in practice; it exists so that every input, including the
// Infinity a host could arrive with, leaves f finite and above zero.
const RE_CEIL = 1e12;
const AVAIL_SHUT = 1e-4;            // below this much uncovering an edge is simply closed
const PIN_FLOOR = 1e-9;             // (kg/s)/Pa, the weakest a pin may be
const G_FLOOR = 1e-12;              // (kg/s)/Pa, the totality backstop for a conductance
const LS_MIN = 0.125;               // the shortest line-search step, three halvings
const ARMIJO = 0.25;                // the fraction of the residual a step must actually remove
const EIGHT_PI = 8 * Math.PI;
const F_LAM_2000 = 64 / 2000;       // the laminar friction factor at the end of its range

// Where the dense factorisation stops being the cheaper answer, MEASURED by
// forcing the same network down both paths (tools/bench.mjs --crossover). On
// this laptop, in microseconds a step:
//
//   unknowns   16     24     32     40     48     56     64
//   dense     121    201    269    392    473    599    718
//   sparse    125    188    252    308    376    439    510
//
// They cross at about twenty and the sparse path is 1.4 times faster by
// sixty-four, which is where the dense one used to give up altogether. Below
// the crossover the dense factorisation is kept even though the two are within
// a few per cent, because it is exact and cannot be truncated, and most models
// a person builds by hand live there.
//
// Both paths produce the same flows: 67.59512 kg/s on every size in that table.
const DENSE_MAX = 20;
// The conjugate gradient's budget, and it has to grow with the network.
// Warm started on a graph Laplacian that has barely moved it is usually done
// in two or three iterations, which is what the cap is for: to make the
// per-frame cost a number rather than a hope.
//
// A FIXED SIXTY WAS WRONG, and wrong in the way that is hard to see: conjugate
// gradient is exact in n iterations and no fewer in the worst case, so on a
// long chain of eighty unknowns a hard state needed eighty-one and got sixty.
// The direction that came back was not merely inaccurate, it was an ASCENT
// direction: measured on a forty-rung comb whose host had held a junction and
// released it, the residual rose at every step length from 1e-6 upward, so
// every line search failed, the best iterate stayed where it started, and the
// junction sat 227 kg/s out of balance for ever. The same matrix solved to
// convergence took the residual from 227 to 15 in one step. Register line P9.
//
// So the budget is twice the number of unknowns, floored so that a small
// network keeps a generous one and capped so that a huge one still costs a
// bounded amount. Each iteration is one pass over the non-zeros, which is
// three per edge: cheap next to a pass over the edges themselves.
const CG_FLOOR = 60, CG_CAP = 600;
const cgBudget = (n) => Math.min(CG_CAP, Math.max(CG_FLOOR, 2 * n));
const CG_TOL = 1e-10;

const EMPTY_F64 = new Float64Array(0);
const EMPTY_I32 = new Int32Array(0);
const EMPTY_U8 = new Uint8Array(0);
const NO_OPTS = Object.freeze({});

// The predictor's answer. Module level and overwritten on every call, because
// edgeCoeffs runs for every edge of every Newton iteration of every sub-step.
const SEED = { m: 0, g: 0 };

// Section 7 names devIds and egDev but no array of the live device objects.
// The index in egDev is the index into net.devices, because solver.rebuild()
// interns the ids in that array's own order, and net.devices is a plain getter
// over a plain array, so this costs two property reads and allocates nothing.
// The objects are the NETWORK'S OWN and are read live on every sub-step: a host
// writing valve.open or pump.speed must take effect on the next step with no
// rebuild, which is the whole reason a setpoint change bumps no version
// counter. A missing array degrades to "no device" rather than throwing, since
// a solve that quietly ignores a pump is recoverable and a throw from the step
// path is not.
function deviceAt(sys, i) {
  if (i < 0) return null;
  const net = sys.net;
  const a = (net && net.devices) || sys.devs;
  return a ? (a[i] || null) : null;
}

// --- friction ---------------------------------------------------------------
// Haaland's explicit form, so no iteration on Colebrook. Below Re 2000 it is
// Hagen-Poiseuille exactly; above 4000 it is Haaland; between the two it is a
// straight line joining the two endpoint values, because a jump there would
// put a step in the Jacobian right where a loop that is coasting to a stop
// happens to live, and the Newton line search would chatter on it for ever.
// THE ROUGHNESS TERM IS A CONSTANT OF THE PIPE, not of the flow. Haaland needs
// (rough/3.7D)^1.11, and a fractional power is a logarithm and an exponential;
// computing it again for every edge of every iteration of every sub-step was
// five per cent of a whole step, to arrive at the same number every time. It is
// passed in already raised, and the one caller that changes keeps it.
function haalandPre(re, rrPow) {
  const s = -1.8 * Math.log10(rrPow + 6.9 / re);
  return s > 1e-6 ? 1 / (s * s) : 0;
}

function factorPre(Re, rrPow) {
  // NaN lands on the floor rather than passing through, as everywhere else.
  const re = Re >= RE_FLOOR ? (Re <= RE_CEIL ? Re : RE_CEIL) : RE_FLOOR;
  if (re <= 2000) return 64 / re;
  if (re >= 4000) return haalandPre(re, rrPow);
  const t = (re - 2000) / 2000;
  const turb = haalandPre(4000, rrPow);
  return F_LAM_2000 + (turb - F_LAM_2000) * t;
}

// The published form, which takes the relative roughness itself. Everything
// inside this file goes through factorPre with the power already taken.
export function frictionFactor(Re, relRough) {
  const rr = clamp(relRough, 0, 0.2);
  return factorPre(Re, Math.pow(rr / 3.7, 1.11));
}

// --- devices ----------------------------------------------------------------
// These return a scratch object that is reused on every call. Two of them are
// never live at the same moment, so one object each is enough, and it keeps
// the per-frame path free of garbage.
const PUMP_OUT = { dpConst: 0, betaR2: 0 };
const VALVE_OUT = { K: 0, shut: false };

// A pump is split into a constant and a resistance, and that split is what
// makes it unconditionally stable. H(Q) = H0 s^2 - beta Q|Q| becomes a
// constant driving head rho g H0 s^2, which cannot depend on the flow, plus a
// term G beta / rho ADDED TO R2, which is a positive resistance. A pump can
// therefore only ever damp the solve; there is no arrangement of curve and
// speed that turns it into positive feedback.
export function pumpTerms(dev, rho) {
  const out = PUMP_OUT;
  out.dpConst = 0;
  out.betaR2 = 0;
  if (!dev) return out;
  const c = dev.curve;
  const H0 = Math.max(0, num(c && c.H0, 0));
  const Hr = num(c && c.Hr, H0);
  const Qr = num(c && c.Qr, 0);
  const r = clamp(rho, RHO_FLOOR, RHO_CEIL);
  const beta = Qr > 0 ? Math.max(0, (H0 - Hr) / (Qr * Qr)) : 0;
  out.betaR2 = G * beta / r;
  // A pump turning below a thousandth of rated speed makes no head, but its
  // droop stays: a stopped pump is still a lump of resistance in the line.
  const s = clamp(num(dev.speed, 0), 0, 4);
  out.dpConst = s >= 1e-3 ? r * G * H0 * s * s : 0;
  return out;
}

// A valve at or below VALVE_SHUT is REMOVED from the matrix with mdot exactly
// zero, not throttled by a very large K. A conductance ratio, however extreme,
// still leaks a trickle, and that trickle scrolls visibly along the tracers of
// a line whose label says CLOSED. The picture and the label may never disagree,
// so the closure is hard. A position that cannot be read as a number lands on
// zero and the valve is treated as shut, because a leak the label denies is
// the worse of the two failures.
export function valveK(dev) {
  const out = VALVE_OUT;
  const theta = clamp(dev ? dev.open : 0, 0, 1);
  if (theta <= VALVE_SHUT) { out.K = 0; out.shut = true; return out; }
  out.K = Math.max(0, num(dev.Kfull, 4)) / (theta * theta);
  out.shut = false;
  return out;
}

// Torricelli already rearranged into a form loss on the pipe's own area, so a
// hole, a vent, a break and a valve throat all reach the solver through the
// one equation that is already there. `A` is the edge's flow area, dev.area
// the area of the hole. A hole of no area passes nothing, and Infinity is how
// that is said here: the caller closes the edge.
export function orificeK(dev, A) {
  const a = num(dev && dev.area, 0);
  if (!(a > 0)) return Infinity;
  const cd = clamp(num(dev.cd, 0.61), 0.05, 1);
  const ca = cd * a;
  return (A * A) / (ca * ca);
}

// Critical (choked) mass flux through a break, kg/m2/s. Subcooled liquid does
// not choke in any way this model can see, so it returns Infinity and the
// velocity limit alone applies; the `!(x > 0.01)` form means a quality that
// arrives as NaN also lands on Infinity, that is, on no cap at all rather than
// on a cap of zero that would stop the line dead. The 0.62 sqrt(rho p) fit is
// honest to about +/-20% on break mass release and is documented as such in
// the README: it is monotone in p and finite for every finite input, which is
// what the solver needs of it.
export function criticalFlux(p, x, rho) {
  if (!(x > 0.01)) return Infinity;
  return 0.62 * Math.sqrt(clamp(rho, 0, RHO_CEIL) * clamp(p, 0, P_CEIL));
}

// --- pressure at an attachment elevation ------------------------------------
// THE ONE FUNCTION THAT ANSWERS DRAINING, STOPPING AT THE NOZZLE AND PIPE-END
// SUBMERGENCE. ndP for a volume is the pressure at its FREE SURFACE, so an
// edge attached low down sees the hydrostatic column above its own attachment
// point, and an edge attached above the level sees the surface pressure and no
// column at all. That is what makes a tank drain through the bottom nozzle and
// not through the one above the waterline, with no special case anywhere.
//
// It is C0 in y: at the surface the depth term goes to zero smoothly, so the
// Newton line search has nothing to trip on. The derivative kink at the
// surface is not handled here but by egAvail, which ramps a nozzle closed over
// UNCOVER metres. A hard switch at the surface is a discontinuity inside a
// line search and it chatters.
export function pAt(sys, i, y) {
  if (sys.ndKind[i] !== 1) return sys.ndP[i];       // a junction or a boundary has no level
  const depth = sys.ndLevel[i] - y;                  // may be negative: the end is in the gas
  return sys.ndP[i] + (depth > 0 ? sys.ndRhoL[i] * G * depth : 0);
}

// How much of what this edge carries stands at its attachment, as a fraction:
// 1 fully available, 0 not there at all, and smooth between so the Newton line
// search has nothing to trip on. A node with no free surface can always supply.
//
// A VAPOUR LINE WANTS THE OPPOSITE OF A WATER LINE. Water is drawn from below
// the surface, so a nozzle that uncovers stops supplying it; steam is drawn
// from the space ABOVE the surface, so the same nozzle is exactly where it
// works. Without the distinction a boiling vessel can never send its steam
// anywhere: the ramp reads the outlet as uncovered, shuts it, and the vessel
// boils in a sealed pot, which is not what a plant does. It is also why a
// steam line whose nozzle goes under water shuts, which is right, because
// what it would be drawing then is water.
export function availAt(sys, i, y, vapour) {
  if (!sys.ndFree[i]) return 1;
  const liquid = smoothstep((sys.ndLevel[i] - y) / UNCOVER);
  if (!vapour) return liquid;
  // AND THERE HAS TO BE STEAM THERE. A vessel well below its boiling point has
  // a gas space with nothing in it this line can carry, so a steam main off a
  // cold boiler must read zero and not simply "the nozzle is clear". Written
  // as a band a degree wide below the saturation line rather than as a test on
  // quality, because a vessel that is boiling steadily holds a gas space full
  // of steam while its own quality is still almost nothing.
  //
  // This is also what makes the draw SELF-REGULATING, which is the whole
  // reason it belongs here and not in the energy balance. Pull steam off
  // faster than the heat can raise it and the water cools a fraction below
  // saturation, this term closes, and the flow falls back to what is actually
  // being boiled. Left open, a line to a condenser would empty a vessel at the
  // rate the pipe allows and take latent heat with it that was never added.
  const ts = tsat(sys.ndP[i]);
  const present = smoothstep((sys.ndT[i] - (ts - VAP_BAND)) / VAP_BAND);
  return (1 - liquid) * present;
}

// --- the closed-form edge law -----------------------------------------------
// Solve R2 m|m| + R1 m + a (m - mPrev) = D for m, and return dm/dD with it.
//
// Writing S = D + a mPrev and R = R1 + a, the positive root of the quadratic is
//
//     |m| = (-R + sqrt(R^2 + 4 R2 |S|)) / (2 R2)
//
// which is used here in its conjugate form 2|S| / (R + q), q = sqrt(...). The
// two are identical in exact arithmetic, but the subtraction in the first one
// loses every significant digit when R2|S| is small next to R^2, which is
// exactly the case of a nearly stopped loop, and it also divides by R2 which
// may be zero. The conjugate form divides by R + q >= 2R > 0 and collapses to
// the linear answer |S|/R on its own when R2 is zero, so there is no branch,
// no special case, and no way to divide by zero.
//
// The derivative is exact: dm/dD = 1 / (2 R2 |m| + R) = 1/q. It is strictly
// positive and finite, which is what makes the assembled Jacobian positive
// definite. R > 0 always, because R1 has a floor.
export function solveEdge(D, mPrev, R2, R1, a, out) {
  const S = D + a * mPrev;
  const R = R1 + a;
  const aS = S >= 0 ? S : -S;
  const q = Math.sqrt(R * R + 4 * R2 * aS);
  out.m = sign0(S) * (2 * aS / (R + q));
  out.g = 1 / q;
  // Totality backstop. Nothing above can produce a NaN from finite inputs, but
  // a non-finite pressure arriving from a host must land on "no flow, almost no
  // conductance" rather than reach a vertex position.
  if (!(out.g > 0) || !Number.isFinite(out.m)) { out.m = 0; out.g = G_FLOOR; }
  return out;
}

// --- per-edge coefficients --------------------------------------------------
// Runs once per Newton iteration per edge. Fills egR2, egR1, egAvail, egOpen
// and egClamp, and RETURNS the pump's constant driving head in Pa, which the
// caller keeps for the flow pass (it is not a Sys field, and returning a
// number rather than an object keeps the path allocation-free).
//
// The check valve is deliberately NOT decided here: its state has to be
// latched across Newton iterations so it can flip at most once per sub-step,
// and that latch belongs to the Hydraulic instance.
export function edgeCoeffs(sys, e, dt) {
  const A = sys.egA[e] > 1e-12 ? sys.egA[e] : 1e-12;
  const L = sys.egL[e] > 1e-9 ? sys.egL[e] : 1e-9;
  const dia = sys.egD[e] > 1e-6 ? sys.egD[e] : 1e-6;
  const npar = sys.egN[e] >= 1 ? sys.egN[e] : 1;
  // The edge's OWN mean cell density and viscosity, never a node's. See the
  // note on the elevation head in _pass below: this is the same substitution.
  const rho = clamp(sys.egRho[e], RHO_FLOOR, RHO_CEIL);
  const mu = clamp(sys.egMu[e], MU_FLOOR, MU_CEIL);

  sys.egOpen[e] = 1;
  sys.egAvail[e] = 1;
  sys.egClamp[e] = 0;

  // Memoised per edge: the ratio only changes when the pipe does, so this is
  // one comparison in the common case and a power on the rare one. Keyed on
  // the ratio itself rather than on a version counter, so it repairs itself
  // after any edit without anything having to remember to invalidate it.
  const rr = sys.egRough[e] / dia;
  let rrPow = sys.egRrPow[e];
  if (sys.egRrOf[e] !== rr) {
    rrPow = Math.pow(clamp(rr, 0, 0.2) / 3.7, 1.11);
    sys.egRrPow[e] = rrPow;
    sys.egRrOf[e] = rr;
  }
  const mNow = sys.egMdot[e];
  const aNow = mNow >= 0 ? mNow : -mNow;
  const f0 = factorPre(Math.max(aNow * dia / (A * mu), RE_FLOOR), rrPow);

  let K = num(sys.egKform[e], 0);     // bends and the authored k, without devices
  let betaR2 = 0;
  let dpConst = 0;
  let shut = false;
  let aThroat = A;                    // m2, the narrowest section the stream passes through

  const dev = deviceAt(sys, sys.egDev[e]);
  if (dev) {
    const kind = dev.kind;
    if (kind === 'pump') {
      const t = pumpTerms(dev, rho);
      dpConst = t.dpConst;
      betaR2 = t.betaR2;
    } else if (kind === 'valve') {
      const v = valveK(dev);
      if (v.shut) shut = true; else K += v.K;
    } else if (kind === 'orifice' || kind === 'break') {
      // An intact break has area 0, so orificeK returns Infinity and the
      // discharge line is closed. That is the whole of "the pipe is not
      // broken yet": no extra equation, no extra branch downstream.
      const ko = orificeK(dev, A);
      if (Number.isFinite(ko)) {
        K += ko;
        // Choking happens at the THROAT, not in the pipe leading to it. A
        // fifty millimetre hole in a two hundred millimetre line has a
        // sixteenth of its area, so a critical flux written on the pipe's area
        // is sixteen times too generous and never binds: the break would empty
        // a vessel of steam at the Torricelli rate for a liquid, which is the
        // one number a break is judged on.
        const a = num(dev.area, 0);
        if (a > 0 && a < aThroat) aThroat = a;
      } else shut = true;
    }
  }

  // Uncovering, on the DONOR end only. A fill line discharging above a pool is
  // unaffected, because the end that matters is the one the water is being
  // drawn from. Applied as a resistance rather than as a switch, so the closed
  // form stays valid and monotone all the way down and a tank slows to a stop
  // at its own nozzle over five centimetres instead of snapping shut.
  //
  // How far above a nozzle the water stands, as a fraction: 1 well submerged,
  // 0 uncovered, smooth between. A node with no free surface is always full.
  //
  // WITH NO FLOW THERE IS NO DONOR YET, and the edge must not fall back on one
  // end by default. Reading the donor off the previous flow alone is a LATCH:
  // this rule sets a shut edge's flow to exactly zero, so on the next sub-step
  // the sign test lands on `from` again, finds it still empty, and shuts again.
  // An edge drawn with the empty vessel as `from` could then never reopen
  // however much water stood at the other end, and two tanks joined at the
  // floor would sit at different levels for ever.
  //
  // What breaks the circle is that the DRIVING HEAD DOES NOT DEPEND ON
  // AVAILABILITY: it is pressures, elevations and a pump's constant, all known
  // here. So with no flow the head picks the donor, which is exactly what
  // upstream means. Taking the better of the two ends instead would be wrong
  // in the commonest case of all, a tank draining to a boundary: a boundary is
  // always available, so the edge would keep draining a tank that is empty.
  // The head decides only where the latch can actually bite, which is when
  // BOTH ends are free volumes and either could be the one that is empty.
  // Everywhere else the previous flow still picks the donor, because an edge
  // with one free end and one ordinary end has no ambiguity worth resolving
  // and the head test would change how a vent behaves: a vent draws from a gas
  // space, where the ramp reads "uncovered" and would shut it, and a pot must
  // still be able to boil.
  const mp = sys.egMprev[e];
  const nF = sys.egFrom[e], nT = sys.egTo[e];
  const pF0 = pAt(sys, nF, sys.egYFrom[e]);
  const pT0 = pAt(sys, nT, sys.egYTo[e]);
  const D0 = pF0 - pT0 + rho * G * (sys.egYFrom[e] - sys.egYTo[e]) + dpConst;
  const ambiguous = mp === 0 && sys.ndFree[nF] && sys.ndFree[nT];
  const fwd = mp > 0 || (mp === 0 && (!ambiguous || D0 >= 0));
  const fl = sys.egFluid ? sys.egFluid[e] : null;
  const vap = !!(fl && fl.vapour);
  const av = fwd
    ? availAt(sys, nF, sys.egYFrom[e], vap)
    : availAt(sys, nT, sys.egYTo[e], vap);
  sys.egAvail[e] = av;
  if (av <= AVAIL_SHUT) shut = true;

  if (shut) {
    sys.egOpen[e] = 0;
    sys.egMdot[e] = 0;
    sys.egG[e] = 0;
    sys.egR2[e] = 0;
    sys.egR1[e] = 0;
    return 0;
  }

  const KA = 1 / (2 * rho * A * A);
  const R2ref = ((f0 * L / dia + K) * KA + betaR2) / (av * av);
  // R1 IS A CONDITIONING FLOOR AND NOTHING ELSE. It must NOT also carry the
  // physical laminar drag, because R2 already does: below Re 2000 the friction
  // factor is 64/Re, and putting that through the quadratic term gives
  //
  //   (64/Re)(L/d) |m| m / (2 rho A^2)  =  32 mu L m / (rho A d^2)
  //                                     =  128 mu L m / (rho n PI d^4)
  //
  // which IS Hagen-Poiseuille, exactly. Adding the same expression again here
  // made every laminar edge carry precisely twice the textbook viscous drop,
  // measured as a ratio of 2.0000 at Re 500 and at Re 2000 and tapering to
  // about +32% at Re 4000. It is worst in the places that matter most to this
  // library: small-bore lines, vents and drains, and any loop coasting down
  // towards natural circulation, where the flow is set by that very balance.
  //
  // The floor is Hagen-Poiseuille evaluated at a viscosity floor and a density
  // ceiling, so its units close and it scales with the edge instead of being a
  // number somebody picked. It is tiny against any real drag. R1 > 0 ALWAYS,
  // and that is the sole reason the Jacobian cannot be singular: every
  // conductance is at most 1/R1 and never infinite.
  const R1 = (EIGHT_PI * R1_MU_FLOOR * L * npar / (R1_RHO_CEIL * A * A)) / av;

  // All three were computed above, where the head decided which end is the
  // donor. They are named again here because the choking model wants the two
  // end pressures.
  const pF = pF0, pT = pT0, Dh = D0;
  const aDh = Dh >= 0 ? Dh : -Dh;

  // THE PREDICTOR. The friction factor needs a Reynolds number, and a Reynolds
  // number needs the flow that is being solved for, so something has to break
  // the circle. Taking it from the flow already on the edge is right in a
  // running simulation, where the last frame is a good guess, and badly wrong
  // starting from rest: at rest the Reynolds number is at its floor, the
  // laminar factor is 64/1e-3, and the resistance comes out six orders too
  // high, so the first solve creeps and each further iteration only takes the
  // square root of the remaining error. What is done instead is ONE extra
  // evaluation of the closed form with the reference coefficients, which costs
  // a square root and a divide and lands within a few per cent of the answer
  // at once. It is a closed form, not an iteration, so there is still nothing
  // here that can fail to converge.
  const aI = (sys.opts && sys.opts.inertia === false) || !(dt > 0) ? 0 : (L / A) / dt;
  solveEdge(Dh, mp, R2ref, R1, aI, SEED);
  const mSeed = SEED.m >= 0 ? SEED.m : -SEED.m;
  const f = factorPre(Math.max((mSeed > aNow ? mSeed : aNow) * dia / (A * mu), RE_FLOOR), rrPow);
  let R2 = ((f * L / dia + K) * KA + betaR2) / (av * av);

  // The velocity and choking limits are a LAGGED PENALTY RESISTANCE inside the
  // law, never a clamp applied to mdot afterwards. A post-hoc clamp changes the
  // flow on an edge without changing anything at the two nodes it joins, so
  // continuity breaks at both of them at exactly the moment somebody is
  // watching a break; inside the law the limit is just more resistance and
  // every node still closes.
  // mStar, not |mPrev|: with a pump starting from rest the previous flow is
  // zero, so a limit written on |mPrev| alone would not fire until the frame
  // after the spike it exists to prevent. sqrt(|D|/R2) is what the quadratic
  // law would give with no linear term, that is, the size of the spike.
  const mStar = Math.max(mp >= 0 ? mp : -mp, Math.sqrt(aDh / Math.max(R2, 1e-30)));
  const vmax = Math.max(0, num(sys.egVmax[e], 60));
  const mcapV = rho * A * vmax;
  const mcapC = criticalFlux(0.5 * (pF + pT),
                             0.5 * (num(sys.egX0[e], 0) + num(sys.egX1[e], 0)), rho) * aThroat;
  const mcap = mcapV < mcapC ? mcapV : mcapC;
  if (mcap > 0 && mStar > mcap) {
    R2 += CAP_GAIN * R2 * (mStar / mcap - 1);
    sys.egClamp[e] = 1;
    const rep = sys.report;
    if (rep) rep.clampedEdges = (rep.clampedEdges || 0) + 1;
  }

  sys.egR2[e] = R2;
  sys.egR1[e] = R1;
  return dpConst;
}

// --- the nodal Newton -------------------------------------------------------
export class Hydraulic {
  constructor(sys) {
    this.sys = sys;
    // Returned from solve() by identity, never rebuilt, because solve() runs
    // up to maxSub times a frame.
    this.out = { iters: 0, resid: 0, converged: true, pinned: 0 };
    this.edgeOut = { m: 0, g: 0 };
    this.dpc = EMPTY_F64;      // Pa, the pump constant of each edge this iteration
    this.pPrev = EMPTY_F64;    // Pa, node pressures at the start of the sub-step
    this.alpha = EMPTY_F64;    // (kg/s)/Pa, pin strength, indexed by component root
    this.parent = EMPTY_I32;   // union-find over the edges that are in the matrix
    this.hasRef = EMPTY_I32;   // 1 = this component owns a Dirichlet node
    this.pinList = EMPTY_I32;
    this.flip = EMPTY_U8;      // a check valve has changed state this sub-step
    this.chkOpen = EMPTY_U8;
    this.nPin = 0;
    this.pinned = 0;
    this.visits = 0;
    this.n1 = 0;
    this.nInf = 0;
    this.dt = 0;
    this.inertia = false;
    // How far one Newton step may move a pressure, in Pa. Adapted by the line
    // search below and carried between frames.
    this.trust = DP_MAX;
    this.size();
  }

  // (Re)allocate after a rebuild. Growing by doubling means a steady state
  // rebuild allocates nothing at all, and nothing here ever runs from step().
  size() {
    const sys = this.sys;
    const nE = Math.max(1, sys.nEdges | 0);
    const nN = Math.max(1, sys.nNodes | 0);
    this.dpc = growF64(this.dpc, nE);
    // The memoised roughness term lives on Sys, because edgeCoeffs is a plain
    // function over Sys and not a method. Seeded to a value no real ratio can
    // take, so the first call for an edge computes it.
    sys.egRrPow = growF64(sys.egRrPow || EMPTY_F64, nE);
    sys.egRrOf = growF64(sys.egRrOf || EMPTY_F64, nE);
    sys.egRrOf.fill(-1);
    this.flip = growU8(this.flip, nE);
    this.chkOpen = growU8(this.chkOpen, nE);
    // A rebuild reseeds every check valve open and lets the first solve after
    // it decide. Seeding them shut would stop a loop dead for one sub-step
    // every time a pipe is dragged in the editor.
    this.chkOpen.fill(1);
    this.pPrev = growF64(this.pPrev, nN);
    this.alpha = growF64(this.alpha, nN);
    this.parent = growI32(this.parent, nN);
    this.hasRef = growI32(this.hasRef, nN);
    this.pinList = growI32(this.pinList, nN);
    return this.slots();
  }

  // Everything that depends on WHICH pressures are unknowns, which is not the
  // same thing as the shape of the network. `impose({p})` makes a volume
  // Dirichlet and `release()` gives it back, and either one renumbers every
  // slot after it without a single pipe having moved. The solver calls this
  // whenever it reassigns slots, and size() calls it at a rebuild.
  //
  // It has to be its own step because the sparsity pattern is indexed BY SLOT.
  // Built once at a rebuild and left alone, it went stale the moment a host
  // imposed a pressure: measured on a ten-loop ladder, continuity at the
  // junctions went from 7e-12 kg/s to 720 and the solve stopped converging,
  // and it came back on its own when the node was released and the numbering
  // happened to line up again. Register line P8.
  slots() {
    const sys = this.sys;
    const nN = Math.max(1, sys.nNodes | 0);
    const n = Math.max(1, sys.nSolve | 0);
    // The Newton scratch lives on Sys because section 7 puts it there, but
    // this file is its only consumer, so it is sized here where the sizes are
    // known. growF64 is idempotent, so it does not matter whether rebuild()
    // has already made them.
    //
    // THE DENSE MATRIX IS SIZED FOR THE CROSSOVER AND NOT FOR THE NETWORK.
    // Past it the sparse path runs, so n squared doubles would be allocated to
    // be ignored: at a thousand unknowns eight megabytes, at ten thousand
    // eight hundred, which is where the promise of any model would quietly
    // have ended again for want of a number nobody looked at.
    // The crossover is an option so it can be MEASURED rather than asserted:
    // forcing the same network down both paths is the only way to know where
    // they actually cross on a given machine, and it is how the default was
    // chosen.
    const dmax = Math.max(1, Math.floor(num(sys.opts && sys.opts.denseMax, DENSE_MAX)));
    this.sparse = n > dmax;
    const nDense = Math.min(nN, dmax);
    sys.A = growF64(sys.A || EMPTY_F64, nDense * nDense);
    sys.bvec = growF64(sys.bvec || EMPTY_F64, n);
    sys.xvec = growF64(sys.xvec || EMPTY_F64, n);
    sys.Fvec = growF64(sys.Fvec || EMPTY_F64, n);
    sys.Fbest = growF64(sys.Fbest || EMPTY_F64, n);
    sys.ptmp = growF64(sys.ptmp || EMPTY_F64, n);
    // Built whether or not it is used today. It costs one pass over the edges
    // and it is what makes crossing the crossover between rebuilds safe, in
    // either direction: a host that imposes enough pressures to drop a network
    // under twenty unknowns can release them again on the next frame.
    this._buildPattern(n);
    // AND THE WARM START GOES WITH THE NUMBERING IT WAS TAKEN IN. xvec holds
    // the step the last iterate wanted, indexed by slot, and a renumbering
    // makes every one of those entries belong to a different node: the
    // conjugate gradient would then start from a guess assembled out of other
    // nodes' answers, which is worse than starting from nothing and costs the
    // iterations it takes to undo.
    sys.xvec.fill(0, 0, n);
    return this;
  }

  // THE SPARSITY PATTERN IS TOPOLOGY, so it is built once here and only its
  // VALUES change from iteration to iteration. A valve closing does not change
  // which nodes could be joined, it changes a conductance to zero, so the
  // pattern is built over every edge whether or not it is open and a shut edge
  // simply contributes nothing. That keeps the pattern stable for as long as
  // the network's shape is, which is what lets the values be refilled with a
  // single pass and no searching.
  _buildPattern(n) {
    const sys = this.sys, nE = sys.nEdges | 0, nN = sys.nNodes | 0;
    const ndSlot = sys.ndSlot;

    // Count the entries per row: the diagonal, plus one for each end of every
    // edge whose two ends are both unknowns.
    this.rowPtr = growI32(this.rowPtr, n + 1);
    const cnt = this.rowCount = growI32(this.rowCount, n);
    for (let i = 0; i < n; i++) cnt[i] = 1;
    for (let e = 0; e < nE; e++) {
      const sf = ndSlot[sys.egFrom[e]], st = ndSlot[sys.egTo[e]];
      if (sf >= 0 && st >= 0 && sf !== st) { cnt[sf]++; cnt[st]++; }
    }
    let nnz = 0;
    for (let i = 0; i < n; i++) { this.rowPtr[i] = nnz; nnz += cnt[i]; }
    this.rowPtr[n] = nnz;

    this.colIdx = growI32(this.colIdx, nnz);
    this.aval = growF64(this.aval, nnz);
    this.adiag = growF64(this.adiag, n);
    // Where each row's diagonal sits, and where each edge's two off-diagonal
    // entries sit, so refilling is a write and never a search.
    this.diagAt = growI32(this.diagAt, n);
    this.edgeAt = growI32(this.edgeAt, nE * 2);

    const fill = this.rowFill = growI32(this.rowFill, n);
    for (let i = 0; i < n; i++) {
      const at = this.rowPtr[i];
      this.colIdx[at] = i;
      this.diagAt[i] = at;
      fill[i] = at + 1;
    }
    for (let e = 0; e < nE; e++) {
      const sf = ndSlot[sys.egFrom[e]], st = ndSlot[sys.egTo[e]];
      if (sf >= 0 && st >= 0 && sf !== st) {
        const a = fill[sf]++, b = fill[st]++;
        this.colIdx[a] = st; this.colIdx[b] = sf;
        this.edgeAt[e * 2] = a; this.edgeAt[e * 2 + 1] = b;
      } else {
        this.edgeAt[e * 2] = -1; this.edgeAt[e * 2 + 1] = -1;
      }
    }

    // The conjugate gradient's own working vectors, and the guess it starts
    // from, which is the previous step's answer.
    this.cgR = growF64(this.cgR, n);
    this.cgZ = growF64(this.cgZ, n);
    this.cgP = growF64(this.cgP, n);
    this.cgAp = growF64(this.cgAp, n);
    return this;
  }

  // One pass over the edges. With recoef, coefficients are recomputed first;
  // without, they are frozen and only the driving head moves, which is what a
  // line-search trial needs and is about a third of the cost.
  _pass(recoef) {
    const sys = this.sys;
    const nE = sys.nEdges | 0;
    const dt = this.dt;
    const out = this.edgeOut;
    const hold = sys.egHold, holdOn = sys.egHoldOn;
    const inertia = this.inertia;
    let visits = 0;
    for (let e = 0; e < nE; e++) {
      if (holdOn && holdOn[e]) {
        // An imposed flow leaves the unknowns entirely: solver.js has already
        // put the pair (-m at from, +m at to) into ndSrc, so the edge is a
        // source term and not an equation. It is copied across raw rather than
        // recomputed, so it reads back bit-identical. egOpen stays 1 because
        // the edge is still drawn and still carries water.
        sys.egMdot[e] = hold[e];
        sys.egG[e] = 0;
        sys.egOpen[e] = 1;
        sys.egAvail[e] = 1;
        sys.egClamp[e] = 0;
        continue;
      }
      if (recoef) this.dpc[e] = edgeCoeffs(sys, e, dt);
      if (!sys.egOpen[e]) continue;

      const A = sys.egA[e] > 1e-12 ? sys.egA[e] : 1e-12;
      const L = sys.egL[e] > 1e-9 ? sys.egL[e] : 1e-9;
      const rho = clamp(sys.egRho[e], RHO_FLOOR, RHO_CEIL);
      const yF = sys.egYFrom[e], yT = sys.egYTo[e];
      const nf = sys.egFrom[e], nt = sys.egTo[e];

      // THE ELEVATION HEAD TAKES THE EDGE'S OWN MEAN CELL DENSITY, NEVER THE
      // DONOR NODE'S. This one substitution is the difference between natural
      // circulation that settles and natural circulation that cannot exist.
      // With the donor's density a heated riser is filled, for the purposes of
      // its own weight, with the cold water of the inlet it draws from, and a
      // cooled downcomer is filled with cold water too, so the two columns
      // weigh the same and the buoyancy round the loop cancels or, on a
      // reversal, inverts and chatters. With the edge's own mean density the
      // hot column is genuinely lighter than the cold one and the loop flow
      // comes out on the cube root of the power, which is the law this library
      // exists to reproduce. With all densities equal the whole expression
      // collapses to p_from - p_to, as it must.
      const D = pAt(sys, nf, yF) - pAt(sys, nt, yT) + rho * G * (yF - yT) + this.dpc[e];

      const dev = deviceAt(sys, sys.egDev[e]);
      if (dev && dev.kind === 'check') {
        // The two directions are NOT the same test, and that is the whole of
        // the hysteresis. Open, it shuts on flow that has turned against it,
        // decided on the flow already there rather than the one about to be
        // computed, or the test would be circular. Shut, it carries no flow at
        // all, so a rule written on the flow would find nothing to hold it
        // closed and it would reopen on the very next sub-step, shut on the one
        // after, and rattle for ever: what reopens it is a HEAD in its own
        // direction, by more than the hysteresis. At most one state flip per
        // sub-step on top of that.
        const dir = dev.dir < 0 ? -1 : 1;
        const isOpen = this.chkOpen[e] !== 0;
        const mNow = sys.egMdot[e];
        const wantShut = isOpen
          ? dir * mNow < 0 && (D >= CHECK_HYST || D <= -CHECK_HYST)
          : !(dir * D > CHECK_HYST);
        if (wantShut === isOpen && !this.flip[e]) {
          this.chkOpen[e] = wantShut ? 0 : 1;
          this.flip[e] = 1;
        }
        if (!this.chkOpen[e]) {
          sys.egOpen[e] = 0;
          sys.egMdot[e] = 0;
          sys.egG[e] = 0;
          continue;
        }
      }

      // Backward Euler on the momentum of the column: I (m - mPrev)/dt with
      // I = L/A. It is implicit, so it damps rather than ringing, and it drops
      // out entirely when the host asks for a quasi-static solve.
      const a = inertia ? (L / A) / dt : 0;
      solveEdge(D, sys.egMprev[e], sys.egR2[e], sys.egR1[e], a, out);
      sys.egMdot[e] = out.m;
      sys.egG[e] = out.g;
      visits++;
    }
    this.visits += visits;
  }

  _find(i) {
    const p = this.parent;
    let r = i;
    while (p[r] !== r) r = p[r];
    while (p[i] !== r) { const nx = p[i]; p[i] = r; i = nx; }
    return r;
  }

  // Which components have a pressure reference, and how hard to pin the ones
  // that do not. Union-find runs here rather than being taken from
  // network.components() because the answer has to reflect the edges that are
  // in the matrix RIGHT NOW: a valve that closed this sub-step, a check valve
  // that flipped, a nozzle that uncovered and an imposed flow all cut the
  // graph, and an imposed flow in particular couples no pressures at all even
  // though it is drawn as a live edge.
  _pins() {
    const sys = this.sys;
    const nN = sys.nNodes | 0, nE = sys.nEdges | 0;
    const par = this.parent, alpha = this.alpha, ref = this.hasRef;
    const holdOn = sys.egHoldOn;
    for (let i = 0; i < nN; i++) { par[i] = i; alpha[i] = 0; ref[i] = 0; }
    // Union by lower index, so the root of a component IS its lowest-index
    // node and "the lowest-index node" costs nothing to find.
    for (let e = 0; e < nE; e++) {
      if (!sys.egOpen[e]) continue;
      if (holdOn && holdOn[e]) continue;
      const a = this._find(sys.egFrom[e]), b = this._find(sys.egTo[e]);
      if (a < b) par[b] = a; else if (b < a) par[a] = b;
    }
    for (let i = 0; i < nN; i++) if (sys.ndSlot[i] < 0) ref[this._find(i)] = 1;
    for (let e = 0; e < nE; e++) {
      if (!sys.egOpen[e]) continue;
      if (holdOn && holdOn[e]) continue;
      const r = this._find(sys.egFrom[e]);
      if (!ref[r]) alpha[r] += sys.egG[e];
    }
    let np = 0;
    for (let i = 0; i < nN; i++) {
      if (par[i] !== i || ref[i] || sys.ndSlot[i] < 0) continue;
      // The pin is a spring back to the pressure this component had at the
      // start of the sub-step: alpha on the diagonal and alpha * p_prev on the
      // right-hand side, so an island of pipe with every valve shut settles at
      // rest where it was rather than making the matrix singular. The floor
      // covers the degenerate island of one node and no open edges at all.
      const a = alpha[i];
      alpha[i] = a > PIN_FLOOR ? a : PIN_FLOOR;
      this.pinList[np++] = i;
    }
    this.nPin = np;
    this.pinned = np;
  }

  // F_i = inflow - outflow + source - compliance, plus the pin term. Both
  // norms are taken in the same sweep because both are wanted every time and
  // the vector is at most 64 long.
  _residual(invDt) {
    const sys = this.sys;
    const F = sys.Fvec;
    const nN = sys.nNodes | 0, nE = sys.nEdges | 0, n = sys.nSolve | 0;
    const ndSlot = sys.ndSlot, ndP = sys.ndP;
    for (let i = 0; i < nN; i++) {
      const s = ndSlot[i];
      if (s < 0) continue;
      F[s] = num(sys.ndSrc[i], 0) - num(sys.ndC[i], 0) * invDt * (ndP[i] - this.pPrev[i]);
    }
    const holdOn = sys.egHoldOn;
    for (let e = 0; e < nE; e++) {
      if (!sys.egOpen[e]) continue;
      if (holdOn && holdOn[e]) continue;      // already counted, inside ndSrc
      const m = sys.egMdot[e];
      const sf = ndSlot[sys.egFrom[e]]; if (sf >= 0) F[sf] -= m;
      const st = ndSlot[sys.egTo[e]]; if (st >= 0) F[st] += m;
    }
    for (let k = 0; k < this.nPin; k++) {
      const i = this.pinList[k], s = sys.ndSlot[i];
      if (s >= 0) F[s] += this.alpha[i] * (this.pPrev[i] - ndP[i]);
    }
    let n1 = 0, ni = 0;
    for (let s = 0; s < n; s++) {
      const v = F[s];
      const a = v >= 0 ? v : -v;
      n1 += a;
      // Written so a NaN becomes the infinity norm rather than being skipped:
      // a residual that cannot be measured must read as not converged.
      if (!(a <= ni)) ni = a;
    }
    this.n1 = n1;
    this.nInf = ni;
  }

  // J = -dF/dp: a weighted graph Laplacian with a non-negative diagonal shift
  // from the compliance and the pin. Symmetric and positive definite by
  // construction, because every g is strictly positive and every component has
  // either a Dirichlet node or a pin.
  _jacobian(n, invDt) {
    const sys = this.sys;
    const A = sys.A;
    const nN = sys.nNodes | 0, nE = sys.nEdges | 0;
    const ndSlot = sys.ndSlot;
    A.fill(0, 0, n * n);
    for (let i = 0; i < nN; i++) {
      const s = ndSlot[i];
      if (s < 0) continue;
      A[s * n + s] += num(sys.ndC[i], 0) * invDt;
    }
    const holdOn = sys.egHoldOn;
    for (let e = 0; e < nE; e++) {
      if (!sys.egOpen[e]) continue;
      if (holdOn && holdOn[e]) continue;
      const g = sys.egG[e];
      if (!(g > 0)) continue;
      const sf = ndSlot[sys.egFrom[e]], st = ndSlot[sys.egTo[e]];
      if (sf >= 0) A[sf * n + sf] += g;
      if (st >= 0) A[st * n + st] += g;
      if (sf >= 0 && st >= 0) { A[sf * n + st] -= g; A[st * n + sf] -= g; }
    }
    for (let k = 0; k < this.nPin; k++) {
      const s = ndSlot[this.pinList[k]];
      if (s >= 0) A[s * n + s] += this.alpha[this.pinList[k]];
    }
  }

  // The same matrix, filled into the pattern _buildPattern laid out. Every
  // entry is written to a slot that was worked out once, so this is the same
  // arithmetic as the dense version with none of the searching and none of the
  // n squared zeroing.
  _jacobianSparse(n, invDt) {
    const sys = this.sys;
    const nN = sys.nNodes | 0, nE = sys.nEdges | 0;
    const ndSlot = sys.ndSlot;
    const val = this.aval, diag = this.adiag, at = this.diagAt, eat = this.edgeAt;

    val.fill(0, 0, this.rowPtr[n]);
    for (let i = 0; i < nN; i++) {
      const s = ndSlot[i];
      if (s < 0) continue;
      val[at[s]] += num(sys.ndC[i], 0) * invDt;
    }
    const holdOn = sys.egHoldOn;
    for (let e = 0; e < nE; e++) {
      if (!sys.egOpen[e]) continue;
      if (holdOn && holdOn[e]) continue;
      const g = sys.egG[e];
      if (!(g > 0)) continue;
      const sf = ndSlot[sys.egFrom[e]], st = ndSlot[sys.egTo[e]];
      if (sf >= 0) val[at[sf]] += g;
      if (st >= 0) val[at[st]] += g;
      const a = eat[e * 2];
      if (a >= 0) { val[a] -= g; val[eat[e * 2 + 1]] -= g; }
    }
    for (let k = 0; k < this.nPin; k++) {
      const s = ndSlot[this.pinList[k]];
      if (s >= 0) val[at[s]] += this.alpha[this.pinList[k]];
    }
    // The preconditioner is the diagonal, lifted off zero the same way the
    // dense factorisation floors a pivot, and for the same reason: a row that
    // nothing pins must not divide by nothing.
    for (let i = 0; i < n; i++) {
      const d = val[at[i]];
      diag[i] = d > LDL_EPS ? d : LDL_EPS;
    }
  }

  // Move the unknown pressures a fraction of the Newton step away from the
  // base held in ptmp. The clamp is where a non-finite step lands on a bound
  // instead of reaching a vertex position.
  _trial(k) {
    const sys = this.sys, nN = sys.nNodes | 0, ndSlot = sys.ndSlot;
    for (let i = 0; i < nN; i++) {
      const s = ndSlot[i];
      if (s >= 0) sys.ndP[i] = clamp(sys.ptmp[s] + k * sys.xvec[s], P_FLOOR, P_CEIL);
    }
  }

  _saveBest() {
    const sys = this.sys, nN = sys.nNodes | 0;
    for (let i = 0; i < nN; i++) { const s = sys.ndSlot[i]; if (s >= 0) sys.Fbest[s] = sys.ndP[i]; }
  }

  _loadBest() {
    const sys = this.sys, nN = sys.nNodes | 0;
    for (let i = 0; i < nN; i++) { const s = sys.ndSlot[i]; if (s >= 0) sys.ndP[i] = sys.Fbest[s]; }
  }

  solve(dt) {
    const sys = this.sys;
    const rep = sys.report;
    const out = this.out;
    const nN = sys.nNodes | 0, nE = sys.nEdges | 0, n = sys.nSolve | 0;
    const opts = sys.opts || NO_OPTS;
    const step = dt > 0 ? dt : 0;
    const invDt = step > 0 ? 1 / step : 0;
    this.dt = step;
    this.inertia = opts.inertia !== false && step > 0;
    this.visits = 0;
    this.flip.fill(0, 0, nE);

    // The tolerance follows the size of the flows in the network, so a sea
    // circuit carrying tonnes a second is not asked to close to the same
    // absolute kilogram as a vent line, and a network at rest is not asked to
    // beat a tolerance that scales to nothing.
    let scale = 1;
    for (let e = 0; e < nE; e++) {
      const a = Math.abs(sys.egMprev[e]);
      if (a > scale) scale = a;
    }
    const tol = Math.max(num(opts.tol, 1e-4), 1e-6 * scale);

    const ndP = sys.ndP, ndSlot = sys.ndSlot;
    for (let i = 0; i < nN; i++) {
      // Only the unknowns are touched. A Dirichlet pressure is a boundary, a
      // gas space or a host's imposed value, and it must read back exactly as
      // it was written.
      if (ndSlot[i] >= 0) ndP[i] = clamp(num(ndP[i], 101325), P_FLOOR, P_CEIL);
      this.pPrev[i] = ndP[i];
    }

    const maxIter = Math.max(1, num(opts.maxIter, 8) | 0);
    // A hard budget on the passes over the edge array, so the counted work
    // report.edgeVisits can never exceed the analytic bound the perf test
    // asserts, maxSub * (maxIter + 3) * nEdges, however hard the frame is. One
    // pass is held in reserve for restoring the best iterate at the end.
    const maxPasses = maxIter + 3;
    let passes = 0, iters = 0;

    this._pass(true); passes++;
    this._pins();
    this._residual(invDt);

    if (n === 0) {
      // Every node is a boundary or a free surface. The flows above are the
      // whole answer and there is nothing to iterate on.
      out.iters = 0;
      out.resid = 0;
      out.converged = true;
      out.pinned = 0;
      this._report(rep, out, scale);
      return out;
    }

    let cgIters = 0;
    let bestN1 = this.n1, bestInf = this.nInf;
    this._saveBest();

    // ALWAYS TAKE ONE NEWTON STEP, even when the incoming residual already
    // beats the tolerance. tol has an absolute floor of 1e-4 kg/s, so a
    // network coasting to a halt would otherwise freeze the first iterate that
    // slipped under that floor and keep it for ever: measured, a loop with the
    // pump off, no heat and a uniform temperature sat at 1.1e-4 kg/s through
    // fifty thousand steps, its flows not even closing at the junctions,
    // because every solve exited before it did any work. STOPPED MEANS
    // STOPPED, and one iteration of a quadratically convergent Newton on a
    // nearly linear system takes that 1e-4 to 1e-13. It costs two extra passes
    // over the edges in exactly the case where a pass is cheapest, the loop
    // below still breaks out as soon as it has converged, and the pass budget
    // is unchanged.
    while (iters < maxIter && (iters === 0 || this.nInf >= tol) && passes < maxPasses - 1) {
      for (let s = 0; s < n; s++) sys.bvec[s] = sys.Fvec[s];
      // J delta = +F, not -F. The residual is written as inflow minus outflow
      // and J is MINUS its derivative, so the two sign changes cancel: a node
      // taking in more than it lets out has a positive residual and its
      // pressure must rise. Flipping this sign gives a solve that diverges
      // smoothly and looks like a physics problem.
      if (this.sparse) {
        this._jacobianSparse(n, invDt);
        // Warm started from the step this iterate would take if nothing had
        // changed, which on a settled network is nearly the answer. Zeroing it
        // instead throws away the only cheap information there is.
        cgIters += pcg(this.rowPtr, this.colIdx, this.aval, this.adiag, n,
          sys.bvec, sys.xvec, this.cgR, this.cgZ, this.cgP, this.cgAp,
          cgBudget(n), CG_TOL);
      } else {
        this._jacobian(n, invDt);
        ldl(sys.A, n);
        ldlSolve(sys.A, n, sys.bvec, sys.xvec);
      }

      let dmax = 0, bad = false;
      for (let s = 0; s < n; s++) {
        const v = sys.xvec[s];
        if (!Number.isFinite(v)) { bad = true; break; }
        const a = v >= 0 ? v : -v;
        if (a > dmax) dmax = a;
      }
      if (bad) break;                       // keep the best iterate and report it
      const sc = Math.min(1, this.trust / Math.max(dmax, 1e-300));

      for (let i = 0; i < nN; i++) { const s = ndSlot[i]; if (s >= 0) sys.ptmp[s] = ndP[i]; }
      // THE STEP IS PROJECTED INTO THE PRESSURE RANGE HERE, RATHER THAN
      // CLAMPED INSIDE THE TRIAL. A clamped trial is the SAME POINT at every
      // step length: if the full step would drive a pressure to the floor,
      // half of it and a quarter of it land on the floor as well, so the line
      // search below has nothing to search over, every trial scores identically
      // and the best iterate is the one it started from. The sub-step then
      // makes no progress AND makes none on the next frame either, because
      // nothing about the state has changed. Measured, releasing a node the
      // host had held far from its own answer left it at exactly that pressure
      // for ever, with 573 kg/s never closing at that one junction, on both
      // solve paths. Projecting keeps the direction, and each halving is then a
      // genuinely different point. Register line P9.
      for (let s = 0; s < n; s++) {
        const p0 = sys.ptmp[s];
        const d = sys.xvec[s] * sc;
        const lo = P_FLOOR - p0, hi = P_CEIL - p0;
        sys.xvec[s] = d < lo ? lo : (d > hi ? hi : d);
      }
      const base = this.n1;
      // The step must remove a REAL fraction of the residual, not merely fail
      // to make it worse. Newton on a square-root law overshoots by close to a
      // factor of two whenever it starts far from the answer, and the two
      // overshoots either side of the solution have almost exactly the same
      // residual: a plain "is it any better" test sees a decrease of a
      // thousandth, accepts it, and the loop pressures then flip back and
      // forth for ever, hundreds of iterations from an answer that one halving
      // of the step lands on. Armijo turns that into two evaluations.
      //
      // AND WHAT IT ASKS FOR IS SCALED BY HOW MUCH OF THE NEWTON STEP IS
      // ACTUALLY BEING TAKEN. A full step predicts the whole residual gone, so
      // asking for a quarter of it back is right; a step the cap has cut to a
      // hundredth predicts a hundredth, and asking that one for a quarter of
      // the residual is asking for something the step cannot deliver however
      // well it is aimed. Every capped step was then rejected, whatever it did:
      // that is a rejection test which fires hardest exactly where the solver
      // is furthest from its answer and needs the step most.
      let t = 1, bestT = 1, bestLs = Infinity, took = false;
      for (;;) {
        this._trial(t);
        this._pass(false); passes++;
        this._residual(invDt);
        if (this.n1 < bestLs) { bestLs = this.n1; bestT = t; }
        // Written this way round so a residual that came back NaN fails the
        // test and the step is halved rather than accepted.
        if (this.n1 <= base * (1 - ARMIJO * sc * t)) { took = true; break; }
        if (!(t > LS_MIN) || passes >= maxPasses - 1) break;
        t *= 0.5;
      }
      // THE TRUST RADIUS, and it is what makes a state far from its answer
      // recoverable at all. Three halvings is a wide enough search when the
      // iterate is near the solution and nowhere near wide enough when it is
      // not: measured, a network whose host had held one junction two bars
      // above its neighbours and then released it wanted a twelve-megapascal
      // Newton step, and a step of one eighth of that still raised the
      // residual. Every trial failed, the best iterate was the one the search
      // started from, and because nothing about the state had changed the next
      // frame did exactly the same thing. That junction sat 573 kg/s out of
      // balance FOR EVER, on both solve paths.
      //
      // So the cap on the step is not a constant but a radius that shrinks
      // when a search fails and grows back when one succeeds, carried between
      // sub-steps and between frames because that is where the information is.
      // A settled plant converges at t = 1 and keeps the full radius; a
      // network thrown far from its answer walks the radius down over a few
      // frames until its steps are accepted, then walks it back up. It costs
      // one multiplication a Newton iteration and no passes at all.
      this.trust = took ? Math.min(DP_MAX, this.trust * 2) : Math.max(TRUST_MIN, this.trust * 0.25);
      if (bestT !== t && passes < maxPasses - 1) {
        // Backtracking walked past the best point on the ray. One pass to go
        // back to it, rather than carrying a worse iterate into the next round.
        this._trial(bestT);
        this._pass(false); passes++;
        this._residual(invDt);
      }
      iters++;
      if (this.n1 < bestN1) { bestN1 = this.n1; bestInf = this.nInf; this._saveBest(); }
      if (this.nInf < tol || passes >= maxPasses - 1) break;

      this._pass(true); passes++;
      this._pins();
      this._residual(invDt);
      if (this.n1 < bestN1) { bestN1 = this.n1; bestInf = this.nInf; this._saveBest(); }
    }

    // Publish the best iterate seen, not the last one. A Newton step that
    // overshot must not be what the renderer draws, and the flows have to be
    // recomputed from the pressures that are published or the two would
    // disagree at every node.
    // `!(this.n1 <= bestN1)` and not `bestN1 < this.n1`, so a last iterate whose
    // residual came back NaN is also thrown away for the best one.
    if (!(this.n1 <= bestN1)) {
      this._loadBest();
      this._pass(false); passes++;
    } else {
      bestInf = this.nInf;
    }

    out.iters = iters;
    out.resid = bestInf;
    out.converged = bestInf < tol;
    out.pinned = this.pinned;
    this._report(rep, out, scale);
    return out;
  }

  // The report is the honesty channel, so a sub-step that struggled is visible
  // even when the seven around it were easy: the residual is the worst of the
  // sub-steps and converged is true only if every one of them converged.
  // solver.step() zeroes the counters at the top of a step.
  _report(rep, out, scale) {
    if (!rep) return;
    rep.iters = (rep.iters || 0) + out.iters;
    rep.edgeVisits = (rep.edgeVisits || 0) + this.visits;
    rep.resid = out.resid > (rep.resid || 0) ? out.resid : (rep.resid || 0);
    rep.converged = rep.converged === false ? false : out.converged;
    rep.pinned = out.pinned;
    rep.mdotScale = scale > (rep.mdotScale || 0) ? scale : (rep.mdotScale || 0);
  }
}
