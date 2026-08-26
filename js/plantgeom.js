// ---------------------------------------------------------------------------
// plantgeom.js — where everything is, and how the circuits are wired.
//
// Grid units: x runs to the lower right, y to the lower left, z up. Sizes are
// chosen so the machines read, not so they measure: what has to be true is the
// arrangement — what is connected to what, what is above what, and which way
// the water goes round.
// ---------------------------------------------------------------------------
import { FUEL_TOP } from './plant.js';
import { Edge, Circuit, Pump, FLUID } from './fluid.js';

export const G = {
  shell: { x: 11, y: 11, r: 8.8, h: 12.6, domeH: 5.2 },
  core:  { x: 7.6,  y: 14.4, r: 1.40, z: 0.8, h: 8.2 },
  sg:    { x: 14.4, y: 7.6,  r: 1.20, z: 1.0, h: 10.4 },
  pump:  { x: 14.4, y: 14.4, r: 1.35, z: 2.4, h: 2.4 },
  pool:  { x0: 3.2, y0: 8.8, x1: 7.8, y1: 13.4, z: 9.4, h: 2.5 },
  base:  { x0: 10.0, y0: 21.0, x1: 16.0, y1: 24.0, z: -2.0, h: 2.6 },
  eccs:  { x: 7.6, y: 20.4, r: 0.95, z: 0, h: 1.5 },
  stack: { x: 19.0, y: 6.2, r: 0.34, h: 15.0 },
  // the steam side, kept small on purpose: one turbine, one generator
  deck:  { x0: 19.8, y0: 10.4, x1: 27.8, y1: 14.6, z: -0.1, h: 0.5 },
  turb:  { x: 21.0, y: 12.5, z: 2.3, len: 1.8, r0: 0.85, r1: 1.35 },
  gen:   { x0: 23.6, y0: 11.6, x1: 25.6, y1: 13.4, z: 1.15, h: 2.3 },
  cond:  { x0: 20.2, y0: 11.3, x1: 22.6, y1: 13.7, z: -1.5, h: 1.6 },
  xfmr:  { x0: 26.2, y0: 11.9, x1: 27.5, y1: 13.1, z: 0.4, h: 1.5 }
};
export const SHAFT_Y = G.turb.y, SHAFT_Z = G.turb.z;

// nozzle heights: the hot leg leaves high, the cold leg comes back low, which
// is the whole reason the loop keeps turning when the pump stops
export const HOT_Z = 6.9, COLD_Z = 3.6, SG_IN_Z = 7.8, SG_OUT_Z = 4.4;
export const COIL_Z = G.pool.z + 1.2;

// the water level, tied to the model's own uncovering threshold
export const W0 = G.core.z + G.core.h * 0.06;
export const W1 = G.core.z + G.core.h * 0.66;
export const FUEL_Z0 = G.core.z + 0.75;
export const FUEL_Z1 = W0 + (W1 - W0) * FUEL_TOP;
export const waterZ = (lvl) => W0 + (W1 - W0) * Math.max(0, Math.min(1, lvl));

const P = FLUID;

// ---------------------------------------------------------------------------
// One plant's pipe network. Built per plant because the passive and active
// units have different kit hanging off the same primary loop.
// ---------------------------------------------------------------------------
export function buildNetwork(passive) {
  const c = G.core, s = G.sg, pu = G.pump;

  // ---- primary loop, including the legs inside the two vessels -------------
  // Inside the reactor the water goes down the outside of the core, across the
  // bottom and up through the fuel. That is the real route and it is where the
  // heat gets picked up, so it is drawn rather than implied.
  const eDown = new Edge([[c.x + c.r, c.y, COLD_Z], [c.x + c.r * 0.72, c.y, 1.5],
    [c.x, c.y, 1.25]], 0.9, 4, { name: 'downcomer', hidden: true });
  const eCore = new Edge([[c.x, c.y, 1.25], [c.x, c.y, FUEL_Z1 + 0.5]],
    0.86, 4, { name: 'core', hidden: true });
  const eUp = new Edge([[c.x, c.y, FUEL_Z1 + 0.5], [c.x, c.y, HOT_Z],
    [c.x, c.y - c.r, HOT_Z]], 0.787, 4, { name: 'upper', hidden: true });
  const eHot = new Edge([[c.x, c.y - c.r, HOT_Z], [c.x, s.y, HOT_Z],
    [c.x, s.y, SG_IN_Z], [s.x - s.r, s.y, SG_IN_Z]], 0.787, 4, { name: 'hot leg' });
  const eSg = new Edge([[s.x - s.r, s.y, SG_IN_Z], [s.x, s.y, SG_IN_Z],
    [s.x, s.y, SG_OUT_Z], [s.x, s.y + s.r, SG_OUT_Z]], 0.7, 4,
  { name: 'tubes', hidden: true });
  const eColdA = new Edge([[s.x, s.y + s.r, SG_OUT_Z], [s.x, 11.4, SG_OUT_Z],
    [s.x, 11.4, COLD_Z], [s.x, pu.y - pu.r, COLD_Z]], 0.7, 4, { name: 'cold leg' });
  const ePumpThru = new Edge([[pu.x, pu.y - pu.r, COLD_Z], [pu.x, pu.y, COLD_Z],
    [pu.x - pu.r, pu.y, COLD_Z]], 0.7, 4, { name: 'pump', hidden: true });
  const eColdB = new Edge([[pu.x - pu.r, pu.y, COLD_Z], [c.x + c.r, c.y, COLD_Z]],
    0.7, 4, { name: 'cold leg' });

  const primary = new Circuit('primary',
    [eDown, eCore, eUp, eHot, eSg, eColdA, ePumpThru, eColdB], { spacing: 13 });
  const pump = new Pump(primary, eColdA, eColdB, [pu.x, pu.y, pu.z + pu.h]);

  // ---- the steam side: boiler -> turbine -> condenser -> back --------------
  const eSteam = new Edge([[s.x, s.y, s.z + s.h - 0.3], [s.x, s.y, 12.3],
    [19.6, s.y, 12.3], [19.6, SHAFT_Y, 12.3], [19.6, SHAFT_Y, SHAFT_Z],
    [G.turb.x - G.turb.len * 0.5 - 0.3, SHAFT_Y, SHAFT_Z]], 0.75, 4,
  { rho: P.rhoSteam, kind: 'steam', name: 'main steam' });
  const eExh = new Edge([[G.turb.x + G.turb.len * 0.5, SHAFT_Y, SHAFT_Z],
    [22.0, SHAFT_Y, SHAFT_Z], [22.0, SHAFT_Y, G.cond.z + G.cond.h]], 1.6, 4,
  { rho: P.rhoSteam, kind: 'steam', name: 'exhaust', hidden: true });
  const eFeed = new Edge([[22.0, SHAFT_Y, G.cond.z + 0.4], [21.4, SHAFT_Y, 0.9],
    [21.4, 9.6, 0.9], [s.x + s.r, 9.6, 0.9], [s.x + s.r, s.y, 0.9],
    [s.x + s.r, s.y, 3.2]], 0.4, 4, { rho: P.rhoFeed, name: 'feedwater' });
  const eBoil = new Edge([[s.x + s.r, s.y, 3.2], [s.x, s.y, 3.2],
    [s.x, s.y, s.z + s.h - 0.3]], 1.2, 4,
  { rho: P.rhoFeed, name: 'boiling', hidden: true });
  // tight spacing: the steam legs run twenty times faster than the water
  // legs and thin out accordingly, so they need parcels to spare
  const secondary = new Circuit('secondary', [eSteam, eExh, eFeed, eBoil],
    { spacing: 7 });

  const net = { primary, secondary, pump,
    edges: { eDown, eCore, eUp, eHot, eSg, eColdA, ePumpThru, eColdB,
      eSteam, eExh, eFeed, eBoil } };

  if (passive) {
    // residual heat: out of the reactor, up into the pool, round a coil, back
    const prUp = new Edge([[c.x, c.y + c.r, HOT_Z], [6.6, 16.7, HOT_Z],
      [6.6, 16.7, COIL_Z], [6.6, 12.9, COIL_Z]], 0.2, 2, { name: 'to the pool' });
    const coil = [];
    { let x = 6.6, up = true;
      coil.push([x, 12.9, COIL_Z]);
      while (x > 3.85) {
        coil.push([x, up ? 9.4 : 12.9, COIL_Z]);
        x -= 0.7;
        coil.push([x, up ? 9.4 : 12.9, COIL_Z]);
        up = !up;
      }
      if (!up) coil.push([coil[coil.length - 1][0], 12.9, COIL_Z]);
    }
    const prCoil = new Edge(coil, 0.2, 2, { name: 'coil' });
    const prDn = new Edge([[3.8, 12.9, COIL_Z], [3.8, 12.9, COLD_Z],
      [3.8, c.y, COLD_Z], [c.x - c.r, c.y, COLD_Z]], 0.2, 2,
    { rho: P.rhoCold, name: 'back from the pool' });
    const prThru = new Edge([[c.x - c.r, c.y, COLD_Z], [c.x, c.y, COLD_Z],
      [c.x, c.y, 1.6]], 0.9, 2, { rho: P.rhoCold, hidden: true });
    net.prhr = new Circuit('prhr', [prUp, prCoil, prDn, prThru], { spacing: 11 });
    net.gravity = new Circuit('gravity', [
      new Edge([[4.7, 13.0, G.pool.z], [4.7, 13.0, 9.3], [4.7, c.y, 9.3],
        [c.x, c.y, 9.3], [c.x, c.y, c.z + c.h - 0.3]], 0.2, 2,
      { rho: P.rhoCold, name: 'gravity' })], { loop: false, spacing: 10 });
  } else {
    const suct = new Edge([[G.base.x0 + 1.4, 22.5, -0.7], [G.eccs.x, 22.5, -0.7],
      [G.eccs.x, G.eccs.y, -0.7], [G.eccs.x, G.eccs.y, 0.5]], 0.25, 2,
    { rho: P.rhoCold, name: 'suction' });
    const inj = new Edge([[G.eccs.x, G.eccs.y, 1.5], [G.eccs.x, G.eccs.y, 9.8],
      [10.6, G.eccs.y, 9.8], [10.6, c.y, 9.8], [10.6, c.y, COLD_Z]], 0.15, 2,
    { rho: P.rhoCold, name: 'injection' });
    net.inject = new Circuit('inject', [suct, inj], { loop: false, spacing: 10 });
    net.injPump = new Pump(net.inject, suct, inj, [G.eccs.x, G.eccs.y, G.eccs.h]);
  }

  net.vent = new Circuit('vent', [new Edge([[16.2, G.stack.y, 10.0],
    [G.stack.x, G.stack.y, 10.0], [G.stack.x, G.stack.y, G.stack.h - 0.4]],
  0.5, 1, { rho: P.rhoSteam, kind: 'steam', name: 'vent' })],
  { loop: false, spacing: 18 });

  net.all = [primary, secondary, net.prhr, net.gravity, net.inject, net.vent]
    .filter(Boolean);
  return net;
}

// ---------------------------------------------------------------------------
// The mass flows, straight off the model.
// ---------------------------------------------------------------------------
export function solveFlows(net, p, st, ratedMdot, naturalMdot) {
  const P0 = 3400e6;
  const rated = ratedMdot(P0);
  const q = p.qDecay || 0;
  // primary: rated flow while the pump turns, buoyancy-driven when it does not
  let mPri = 0;
  if ((st.s.rcp || 0) > 0.01) mPri = rated * st.s.rcp;
  else if ((st.s.natCirc || 0) > 0.01) mPri = naturalMdot(P0, q);
  if (p.level < 0.35) mPri *= p.level / 0.35;      // a half-empty loop cannot circulate
  net.primary.setFlow(mPri, PX_PER_MS);

  // secondary: the steam it takes to carry the heat the boiler is removing
  const carrying = (st.s.feed || 0) > 0 || (st.s.aux || 0) > 0 || (st.s.rcic || 0) > 0;
  const qSec = !carrying ? 0 : (st.s.feed > 0 ? P0 : q * 1.15);
  net.secondary.setFlow(qSec / FLUID.hCycle, PX_PER_MS);

  if (net.prhr) {
    const qp = (st.s.prhr || 0) > 0 ? q : 0;
    net.prhr.setFlow(qp / (FLUID.cpPrimary * FLUID.dTprhr), PX_PER_MS);
  }
  if (net.gravity) {
    const on = (st.s.gravity || 0) > 0 || (st.s.cmt || 0) > 0;
    net.gravity.setFlow(on && p.irwst > 1e5 ? 55 : 0, PX_PER_MS);
  }
  if (net.inject) {
    net.inject.setFlow(st.injecting ? (st.s.rcic ? 25 : 40) : 0, PX_PER_MS);
  }
  net.vent.setFlow(st.s.vent ? 12 : 0, PX_PER_MS);
}

// One constant maps metres per second to pixels per second at unit zoom. It is
// the only place a velocity is scaled by hand; every ratio between pipes comes
// out of the physics.
export const PX_PER_MS = 10.5;
