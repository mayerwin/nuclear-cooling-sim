// ---------------------------------------------------------------------------
// props.js - what water and steam actually are, at the conditions a plant runs
// at. No three.js, no dependencies, no allocation: every function takes and
// returns numbers.
//
// SI THROUGHOUT. Temperature in kelvin, pressure in pascals, density in
// kg/m3, specific heat in J/(kg K), enthalpy in J/kg, viscosity in Pa s,
// conductivity in W/(m K), surface tension in N/m. The renderer talks in
// degrees Celsius and bar because people do; the conversion lives at that
// edge (degC / degK / bar / pa below), never in the middle of a formula.
//
// The saturation line and the saturated densities are the real published
// equations, because they are short, exact and cheap, and getting the boiling
// point wrong is visible: steam where there should be water. Everything else
// is a short interpolated table over the range a plant lives in, which is
// honest about being a fit and cannot blow up outside its range.
// ---------------------------------------------------------------------------

// --- constants --------------------------------------------------------------
export const T_CRIT = 647.096;      // K, critical temperature of water
export const P_CRIT = 22.064e6;     // Pa
export const RHO_CRIT = 322;        // kg/m3
export const T_TRIPLE = 273.16;     // K
export const P_TRIPLE = 611.657;    // Pa
export const G = 9.80665;           // m/s2, standard gravity

export const degK = (c) => c + 273.15;
export const degC = (k) => k - 273.15;
export const bar = (p) => p / 1e5;
export const pa = (b) => b * 1e5;

// Written so that NaN lands on the lower bound instead of passing straight
// through. `v < a ? a : v > b ? b : v` returns NaN for NaN, because every
// comparison with it is false, and one NaN temperature arriving from a host
// then spreads through a density, a velocity and a vertex position until the
// whole picture disappears. Nothing in this library may return NaN.
const clamp = (v, a, b) => (v >= a ? (v <= b ? v : b) : a);

// --- the saturation line ----------------------------------------------------
// IAPWS-IF97 region 4: a quadratic in a variable that is itself a quadratic in
// T, so both directions are closed form and neither iterates. Valid from the
// triple point to the critical point, which is the whole range a water plant
// can be in.
const N4 = [
  0.11670521452767e4, -0.72421316703206e6, -0.17073846940092e2,
  0.12020824702470e5, -0.32325550322333e7, 0.14915108613530e2,
  -0.48232657361591e4, 0.40511340542057e6, -0.23855557567849,
  0.65017534844798e3
];

// Saturation pressure at a temperature. Pa from K.
export function psat(T) {
  const t = clamp(T, T_TRIPLE, T_CRIT);
  const th = t + N4[8] / (t - N4[9]);
  const A = th * th + N4[0] * th + N4[1];
  const B = N4[2] * th * th + N4[3] * th + N4[4];
  const C = N4[5] * th * th + N4[6] * th + N4[7];
  const d = 2 * C / (-B + Math.sqrt(B * B - 4 * A * C));
  return Math.pow(d, 4) * 1e6;
}

// Saturation temperature at a pressure. K from Pa. The inverse of the above,
// also closed form.
export function tsatExact(P) {
  const p = clamp(P, P_TRIPLE, P_CRIT) / 1e6;
  const b = Math.pow(p, 0.25);
  const E = b * b + N4[2] * b + N4[5];
  const F = N4[0] * b * b + N4[3] * b + N4[6];
  const H = N4[1] * b * b + N4[4] * b + N4[7];
  const D = 2 * H / (-F - Math.sqrt(F * F - 4 * E * H));
  const s = N4[9] + D;
  return (s - Math.sqrt(s * s - 4 * (N4[8] + N4[9] * D))) / 2;
}

// AND THE BOILING POINT IS READ FROM A TABLE, for the same reason as the
// densities: profiled, this was another eight and a half per cent of a step.
// Every phase decision in the library asks for it, so it is asked more often
// than almost anything else.
//
// Tabulated uniformly in the LOGARITHM of the pressure, because that is the
// variable the boiling point is nearly straight in: from the triple point to
// the critical point the pressure spans four and a half decades while the
// temperature not quite doubles. A table uniform in pressure would put almost
// every one of its points above 100 bar and leave a condenser under vacuum,
// which is where a plant's coldest and most interesting water lives, sitting
// between the first two.
const TS_N = 1024;
const TS_LP0 = Math.log(P_TRIPLE);
const TS_LP1 = Math.log(P_CRIT);
const TS_TAB = new Float64Array(TS_N + 1);
for (let i = 0; i <= TS_N; i++) {
  TS_TAB[i] = tsatExact(Math.exp(TS_LP0 + (TS_LP1 - TS_LP0) * i / TS_N));
}
const TS_SCALE = TS_N / (TS_LP1 - TS_LP0);

export function tsat(P) {
  const p = clamp(P, P_TRIPLE, P_CRIT);
  const x = (Math.log(p) - TS_LP0) * TS_SCALE;
  const i = x >= TS_N ? TS_N - 1 : (x > 0 ? (x | 0) : 0);
  const f = x - i;
  return TS_TAB[i] + (TS_TAB[i + 1] - TS_TAB[i]) * f;
}

// --- saturated densities ----------------------------------------------------
// Wagner and Pruss, the two saturation density equations. Exact enough that a
// steam line drawn from them runs at the right multiple of the water line's
// speed, which is the whole point of doing it properly: steam at 70 bar is
// about 36 kg/m3 against feedwater's 740, so it runs twenty times faster
// carrying the same kilograms, and that ratio is what the eye reads.
const B_L = [1.99274064, 1.09965342, -0.510839303, -1.75493479, -45.5170352, -6.74694450e5];
const E_L = [1 / 3, 2 / 3, 5 / 3, 16 / 3, 43 / 3, 110 / 3];
const C_V = [-2.03150240, -2.68302940, -5.38626492, -17.2991605, -44.7586581, -63.9201063];
const E_V = [2 / 6, 4 / 6, 8 / 6, 18 / 6, 37 / 6, 71 / 6];

// Density of saturated liquid water at T. kg/m3 from K.
export function rhoLiquidSatExact(T) {
  const t = clamp(T, T_TRIPLE, T_CRIT);
  const tau = 1 - t / T_CRIT;
  if (tau <= 0) return RHO_CRIT;
  let s = 1;
  for (let i = 0; i < 6; i++) s += B_L[i] * Math.pow(tau, E_L[i]);
  return RHO_CRIT * s;
}

// Density of saturated steam at T. kg/m3 from K.
export function rhoVapourSatExact(T) {
  const t = clamp(T, T_TRIPLE, T_CRIT);
  const tau = 1 - t / T_CRIT;
  if (tau <= 0) return RHO_CRIT;
  let s = 0;
  for (let i = 0; i < 6; i++) s += C_V[i] * Math.pow(tau, E_V[i]);
  return RHO_CRIT * Math.exp(s);
}

// THE SATURATED DENSITIES ARE READ FROM TABLES, and this is the single biggest
// thing the solver's cost turns on. Each of the two above is six fractional
// powers, and a fractional power is a logarithm and an exponential; profiled,
// rhoLiquidSat alone was TWENTY-TWO PER CENT of a whole step, called for every
// cell of every edge and for every node, several times over.
//
// Tabulated uniformly in u = tau^(1/3), never in T. Both curves have an
// infinite slope in T at the critical point, which is exactly where linear
// interpolation in T would be worst; in u they are close to straight
// everywhere. The vapour density is tabulated in the LOGARITHM, because it
// spans four decades between the triple point and the critical point and a
// linear interpolation of the value itself would be badly wrong at the cold
// end where it is smallest.
//
// The tables are built at load FROM THE EXACT FUNCTIONS above, and a test
// asserts they still agree with them, so there is one source of truth and it
// is the published equation rather than a transcribed number.
const RHO_N = 1024;
const RHO_UMAX = Math.cbrt(1 - T_TRIPLE / T_CRIT);
const RHO_L_TAB = new Float64Array(RHO_N + 1);
const RHO_V_LOG = new Float64Array(RHO_N + 1);
for (let i = 0; i <= RHO_N; i++) {
  const u = RHO_UMAX * i / RHO_N;
  const T = T_CRIT * (1 - u * u * u);
  RHO_L_TAB[i] = rhoLiquidSatExact(T);
  RHO_V_LOG[i] = Math.log(rhoVapourSatExact(T));
}

export function rhoLiquidSat(T) {
  const t = clamp(T, T_TRIPLE, T_CRIT);
  const tau = 1 - t / T_CRIT;
  if (tau <= 0) return RHO_CRIT;
  const x = Math.cbrt(tau) / RHO_UMAX * RHO_N;
  const i = x >= RHO_N ? RHO_N - 1 : (x | 0);
  const f = x - i;
  return RHO_L_TAB[i] + (RHO_L_TAB[i + 1] - RHO_L_TAB[i]) * f;
}

export function rhoVapourSat(T) {
  const t = clamp(T, T_TRIPLE, T_CRIT);
  const tau = 1 - t / T_CRIT;
  if (tau <= 0) return RHO_CRIT;
  const x = Math.cbrt(tau) / RHO_UMAX * RHO_N;
  const i = x >= RHO_N ? RHO_N - 1 : (x | 0);
  const f = x - i;
  return Math.exp(RHO_V_LOG[i] + (RHO_V_LOG[i + 1] - RHO_V_LOG[i]) * f);
}

// Steam away from the saturation line, as an ideal gas pulled towards the
// saturated value. A plant's steam is close enough to saturation that this is
// within a few per cent, and it degrades gracefully instead of going negative.
const R_STEAM = 461.52;   // J/(kg K), specific gas constant of water vapour
export function rhoVapour(T, P) {
  const t = clamp(T, T_TRIPLE, 1300);
  const ts = Math.min(t, T_CRIT);
  const ps = psat(ts);
  const ideal = P / (R_STEAM * t);
  // The compressibility of saturated steam at this temperature, carried to the
  // pressure asked for: on the saturation line this returns the published
  // value exactly, and at low pressure it tends to the ideal gas.
  const zSat = ps / (R_STEAM * ts * rhoVapourSat(ts));
  const f = clamp(P / Math.max(1, ps), 0, 1);
  return ideal / (1 + (zSat - 1) * f);
}

// --- tables -----------------------------------------------------------------
// Short tables from 0 to 370 C with linear interpolation. Cheap, monotone, and
// they cannot produce a number that is not between two published ones.
const T_TAB = [273.15, 293.15, 313.15, 333.15, 353.15, 373.15, 398.15, 423.15,
  448.15, 473.15, 498.15, 523.15, 548.15, 573.15, 593.15, 613.15, 633.15, 643.15];
// Specific heat of saturated liquid water, J/(kg K). It climbs steeply near
// the critical point, which is why a plant's primary circuit is modelled at
// 5500 and not at 4180.
const CP_L = [4217, 4182, 4179, 4185, 4197, 4216, 4256, 4310, 4384, 4497,
  4640, 4857, 5202, 5750, 6600, 8200, 12600, 21000];
// Specific heat of saturated steam, J/(kg K).
const CP_V = [1884, 1878, 1885, 1907, 1948, 2029, 2158, 2560, 2900, 3270,
  3700, 4270, 5100, 6500, 8500, 12000, 25000, 47000];
// Dynamic viscosity of saturated liquid water, Pa s.
const MU_L = [1.792e-3, 1.002e-3, 6.53e-4, 4.67e-4, 3.55e-4, 2.82e-4, 2.19e-4,
  1.81e-4, 1.55e-4, 1.36e-4, 1.22e-4, 1.11e-4, 1.02e-4, 9.4e-5, 8.7e-5,
  7.9e-5, 6.9e-5, 6.2e-5];
// Dynamic viscosity of saturated steam, Pa s.
const MU_V = [9.22e-6, 9.73e-6, 1.02e-5, 1.07e-5, 1.13e-5, 1.20e-5, 1.29e-5,
  1.37e-5, 1.45e-5, 1.53e-5, 1.62e-5, 1.71e-5, 1.81e-5, 1.92e-5, 2.03e-5,
  2.19e-5, 2.44e-5, 2.7e-5];
// Thermal conductivity of saturated liquid water, W/(m K).
const K_L = [0.561, 0.598, 0.630, 0.654, 0.670, 0.679, 0.683, 0.679, 0.670,
  0.656, 0.639, 0.618, 0.591, 0.560, 0.528, 0.490, 0.440, 0.410];
// Surface tension, N/m. It goes to zero at the critical point, where there is
// no longer a surface to have any.
const SIGMA = [0.0756, 0.0728, 0.0696, 0.0662, 0.0626, 0.0589, 0.0537, 0.0482,
  0.0426, 0.0376, 0.0326, 0.0261, 0.0212, 0.0144, 0.0098, 0.0053, 0.0016, 0.0005];

function lookup(tab, T) {
  const t = clamp(T, T_TAB[0], T_TAB[T_TAB.length - 1]);
  let i = 1;
  while (i < T_TAB.length - 1 && T_TAB[i] < t) i++;
  const f = (t - T_TAB[i - 1]) / (T_TAB[i] - T_TAB[i - 1]);
  return tab[i - 1] + (tab[i] - tab[i - 1]) * f;
}

export const cpLiquid = (T) => lookup(CP_L, T);
export const cpVapour = (T) => lookup(CP_V, T);
export const muLiquid = (T) => lookup(MU_L, T);
export const muVapour = (T) => lookup(MU_V, T);
export const kLiquid = (T) => lookup(K_L, T);
export const surfaceTension = (T) => lookup(SIGMA, T);

// --- latent heat and enthalpy ----------------------------------------------
// The latent heat is not fitted: it FOLLOWS from the saturation line and the
// two saturated densities above, by Clausius and Clapeyron,
//
//     hfg = T (vg - vf) dp/dT
//
// which is an identity, not a correlation. Against the steam tables from 10 C
// to 370 C it is within 0.2 per cent everywhere, where the usual Watson fit is
// out by up to 2.7, and it costs one extra pair of psat calls. It also goes to
// zero at the critical point on its own, because the two densities meet there.
//
// The difference is one-sided at each end of the range, or it would straddle
// the clamp in psat and come back half the size at the triple point.
export function hfgExact(T) {
  const t = clamp(T, T_TRIPLE, T_CRIT);
  if (t >= T_CRIT - 1e-9) return 0;
  const h = Math.max(0.002, t * 2e-5);
  const lo = Math.max(T_TRIPLE, t - h), hi = Math.min(T_CRIT, t + h);
  const dpdT = (psat(hi) - psat(lo)) / (hi - lo);
  return Math.max(0, t * (1 / rhoVapourSatExact(t) - 1 / rhoLiquidSatExact(t)) * dpdT);
}

// The identity above costs a pair of psat calls and two density evaluations,
// about a microsecond, and the solver wants it for every cell of every edge
// every step, where it was measured to be the frame's cost bound. So it is
// evaluated once, at load, into a table, and read back by interpolation.
//
// The table is uniform in u = (1 - T/Tc)^(1/3), NOT in T. The latent heat goes
// as tau^0.38 near the critical point, which has an infinite slope in T and
// which linear interpolation in T therefore gets badly wrong exactly where the
// curve is most interesting. In u it is close to a straight line everywhere.
// Checked against hfgExact over the whole range: worst error 0.02 per cent.
const HFG_N = 512;
const HFG_TAB = (() => {
  const tab = new Float64Array(HFG_N + 1);
  const uMax = Math.cbrt(1 - T_TRIPLE / T_CRIT);
  for (let i = 0; i <= HFG_N; i++) {
    const u = uMax * i / HFG_N;
    tab[i] = hfgExact(T_CRIT * (1 - u * u * u));
  }
  return tab;
})();
const HFG_UMAX = Math.cbrt(1 - T_TRIPLE / T_CRIT);

export function hfg(T) {
  const t = clamp(T, T_TRIPLE, T_CRIT);
  const tau = 1 - t / T_CRIT;
  if (tau <= 0) return 0;
  const x = Math.cbrt(tau) / HFG_UMAX * HFG_N;
  const i = x >= HFG_N ? HFG_N - 1 : (x | 0);
  const f = x - i;
  return HFG_TAB[i] + (HFG_TAB[i + 1] - HFG_TAB[i]) * f;
}

// Enthalpy of saturated liquid, J/kg, zero at the triple point and integrated
// up the cp table. Built once, so a call is two lookups.
const H_L = (() => {
  const h = [0];
  for (let i = 1; i < T_TAB.length; i++) {
    h.push(h[i - 1] + (CP_L[i - 1] + CP_L[i]) / 2 * (T_TAB[i] - T_TAB[i - 1]));
  }
  return h;
})();
export const hLiquid = (T) => lookup(H_L, T);
export const hVapour = (T) => lookup(H_L, T) + hfg(T);

// The temperature a liquid enthalpy belongs to: the inverse of hLiquid, for
// an energy equation that carries enthalpy and has to report a temperature.
export function tOfHLiquid(h) {
  const last = H_L.length - 1;
  if (h <= H_L[0]) return T_TAB[0];
  if (h >= H_L[last]) return T_TAB[last];
  let i = 1;
  while (i < last && H_L[i] < h) i++;
  const f = (h - H_L[i - 1]) / (H_L[i] - H_L[i - 1]);
  return T_TAB[i - 1] + (T_TAB[i] - T_TAB[i - 1]) * f;
}

// --- fluid states -----------------------------------------------------------
// What a body of fluid IS, in one call: given a temperature and a pressure,
// which phase it is in and what its density is. Everything the solver and the
// renderer ask about a fluid goes through here, so there is one answer.
export const LIQUID = 'liquid', VAPOUR = 'vapour', TWO_PHASE = 'two-phase';

// The quality, the mass fraction that is vapour, of a mixture at T holding
// enthalpy h.
export function qualityOf(T, h) {
  const hf = hLiquid(T), fg = hfg(T);
  if (fg <= 0) return 1;
  return clamp((h - hf) / fg, 0, 1);
}

// The phase of water at a temperature and a pressure. Above the saturation
// temperature for that pressure it is steam, below it water.
//
// A quality that is given OVERRULES the temperature, because it knows
// something the temperature does not: a body sitting exactly on the saturation
// line can be anything from all water to all steam, and only the quality says
// which. It overrules in one direction only. Quality one is vapour and any
// quality in between is a mixture, but quality ZERO means no vapour is
// present, which is as true of subcooled water as it is of saturated water, so
// there the temperature still decides.
export function phaseOf(T, P, quality) {
  if (quality != null) {
    if (quality >= 1 - 1e-4) return VAPOUR;
    if (quality > 1e-4) return TWO_PHASE;
  }
  return T >= tsat(P) - 1e-6 ? VAPOUR : LIQUID;
}

// Density of water at a temperature and a pressure, whichever phase that is.
// Liquid water is treated as incompressible, which over a plant's range costs
// under two per cent and cannot produce a negative density.
export function density(T, P, quality) {
  const ph = phaseOf(T, P, quality);
  if (ph === VAPOUR) return rhoVapour(T, P);
  if (ph === LIQUID) return rhoLiquidSat(T);
  // A homogeneous mixture: the volumes add, not the densities.
  const q = clamp(quality, 0, 1);
  const vf = 1 / rhoLiquidSat(T), vg = 1 / rhoVapourSat(T);
  return 1 / (vf + q * (vg - vf));
}

// Specific heat of whichever phase this is, for the energy equation.
export function cp(T, P, quality) {
  const ph = phaseOf(T, P, quality);
  if (ph === VAPOUR) return cpVapour(T);
  if (ph === LIQUID) return cpLiquid(T);
  const q = clamp(quality, 0, 1);
  return cpLiquid(T) * (1 - q) + cpVapour(T) * q;
}

// Dynamic viscosity, for the friction factor.
export function mu(T, P, quality) {
  const ph = phaseOf(T, P, quality);
  if (ph === VAPOUR) return muVapour(T);
  if (ph === LIQUID) return muLiquid(T);
  const q = clamp(quality, 0, 1);
  return muLiquid(T) * (1 - q) + muVapour(T) * q;
}

// --- named fluids -----------------------------------------------------------
// A network says "water" or "steam" and gets a set of these functions. A
// consumer can register their own: nothing above assumes water except the
// water functions themselves.
const FLUIDS = new Map();

export function defineFluid(name, f) {
  FLUIDS.set(name, Object.assign({
    name,
    density: () => 1000,
    cp: () => 4180,
    mu: () => 1e-3,
    tsat: () => 373.15,
    hfg: () => 2256.4e3,
    boils: false,
    vapour: false
  }, f, { name }));
  return FLUIDS.get(name);
}

export function fluid(name) {
  const f = FLUIDS.get(name);
  if (!f) {
    throw new Error('unknown fluid "' + name + '": define it with defineFluid(), or use one of '
      + [...FLUIDS.keys()].join(', '));
  }
  return f;
}

export const hasFluid = (name) => FLUIDS.has(name);
export const fluidNames = () => [...FLUIDS.keys()];

defineFluid('water', {
  density, cp, mu, tsat, psat, hfg, hLiquid, hVapour, tOfHLiquid,
  rhoLiquidSat, rhoVapourSat, phaseOf, qualityOf,
  surfaceTension, k: kLiquid,
  boils: true
});

// Steam is the same substance. The name exists so a network can say what a run
// is meant to be carrying and the renderer can draw it as vapour without
// asking the solver what phase it worked out.
defineFluid('steam', {
  density: (T, P) => rhoVapour(T, P),
  cp: (T) => cpVapour(T),
  mu: (T) => muVapour(T),
  tsat, psat, hfg,
  boils: true, vapour: true
});

// Sea water: three and a half per cent salt, so a little denser, a little less
// heat capacity and it boils a fraction higher. The numbers matter because a
// condenser's cooling circuit is drawn against them.
defineFluid('seawater', {
  density: (T) => rhoLiquidSat(T) + 26,
  cp: (T) => cpLiquid(T) * 0.955,
  mu: (T) => muLiquid(T) * 1.09,
  tsat: (P) => tsat(P) + 0.55,
  psat, hfg,
  boils: true
});

// Air, for a vent or an open space: the fluid a plume leaves into.
defineFluid('air', {
  density: (T, P) => (P || 101325) / (287.05 * Math.max(1, T)),
  cp: () => 1005,
  mu: () => 1.82e-5,
  tsat: () => Infinity,
  hfg: () => 0,
  boils: false,
  gas: true
});
