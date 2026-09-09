// ---------------------------------------------------------------------------
// frame.js - reading the solver every frame and putting it on the screen.
//
// This is the ONLY place the simulation reaches the picture. Everything it
// does follows from numbers the core published: nothing here decides how fast
// water is going, how hot it is, or whether it is boiling.
//
// The rules it exists to keep:
//   Every colour comes from the one recipe, scaled inside the run's own span.
//   A change of temperature along a run is drawn along that run, never as a
//     step at a joint.
//   Speed is what the solver says: the map scrolls and the specks travel at
//     the run's own metres per second, so a narrow line visibly runs faster.
//   Vapour is never put through the temperature ramp.
//   Nothing is allocated in here. The scratch colours are made once.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { paint, tintVapour, colourOf, advanceTime } from './materials.js?v=d7d0f53269';
import { ripple } from './pipe.js?v=d7d0f53269';

// Scratch. update() runs sixty times a second per body; allocating a THREE
// .Color per body per frame is a dozen allocations a frame per machine, which
// is what the consumer's code review found and removed.
const _c0 = new THREE.Color(), _c1 = new THREE.Color();

// How far a normal map scrolls for a metre of water. The map tiles at the
// run's own scale, so this is in tiles per metre and not in metres.
const MAP_PER_M = 1 / 2.4;
const ALPHA_PER_M = 0.18;

// Paint and advect one run of pipe from its edge view.
function updateEdge(body, view, range, dt) {
  const v = view.v;
  const mat = body.mat;

  if (body.steam) {
    // Vapour is not on the colour map. What says steam is that it is pale,
    // torn and fast; at 285 C the ramp would make it orange and it would read
    // as a hot metal pipe.
    if (mat.normalMap) mat.normalMap.offset.x -= v * dt * MAP_PER_M * 0.4;
    if (mat.alphaMap) mat.alphaMap.offset.x -= v * dt * ALPHA_PER_M;
    const on = Math.abs(v) > 0.02;
    mat.opacity = on ? 0.9 : 0.12;
    mat.emissiveIntensity = on ? 0.35 : 0.05;
  } else {
    // THE GRADIENT. The two ends of the run are painted from the temperature
    // the solver carried to each end, inside the run's own span, and the
    // material mixes between them along its own length. That is what makes a
    // heat exchanger read as one run going in hot and coming out cold instead
    // of two pipes of different colours meeting at a collar.
    //
    // ONLY WHEN SOMETHING MOVED. The same four numbers give the same two
    // colours, and a settled plant hands them over unchanged sixty times a
    // second. Skipping the recipe and the two uniform writes when nothing has
    // changed is exact, not an approximation, and on a station most runs are
    // settled most of the time.
    const T0 = view.T0, T1 = view.T1, lo = range.lo, hi = range.hi;
    if (T0 !== body._pT0 || T1 !== body._pT1 || lo !== body._pLo || hi !== body._pHi) {
      body._pT0 = T0; body._pT1 = T1; body._pLo = lo; body._pHi = hi;
      colourOf(range, T0, _c0);
      colourOf(range, T1, _c1);
      paint(mat, _c0, _c1);
    }
    if (mat.normalMap) mat.normalMap.offset.x -= v * dt * MAP_PER_M;
  }

  // The specks. They ride the scroll distance THE SOLVER integrated, not a dt
  // integrated again here, so two renderers reading the same solver agree
  // exactly and a tool that drove the clock forward gets the picture a viewer
  // would have had. A dry run carries nothing.
  if (body.tracers) {
    body.tracers.enabled = !view.dry;
    body.tracers.setPhase(view.phase, v, body.len, dt, 1);
  }
}

// Paint a body of water, move its level, and ripple its surface.
function updateVolume(body, view, range, dt) {
  // Same idea as the runs: a vessel holding steady is the common case.
  const lo = range.lo, hi = range.hi;
  // A GRADIENT BODY IS PAINTED BETWEEN THE WATER THAT ARRIVES AND THE WATER
  // THAT LEAVES, floor to top, because that is what the vessel actually holds:
  // a reactor is cold at the bottom where the loop returns it and hot at the
  // top where the core has finished with it. Without it the same vessel is one
  // colour, which is the single most looked-at thing in a station's picture
  // and the one a viewer can most easily tell is wrong. The body material has
  // always been gradient-capable along its height; it was simply never given
  // two colours. See display.gradient in attach().
  const g0 = body.grad ? body._gLo : null, g1 = body.grad ? body._gHi : null;
  const T = (g0 == null || g1 == null) ? view.T : (g0 + g1) * 0.5;
  if (T !== body._pT || lo !== body._pLo || hi !== body._pHi
    || g0 !== body._pG0 || g1 !== body._pG1) {
    body._pT = T; body._pLo = lo; body._pHi = hi; body._pG0 = g0; body._pG1 = g1;
    if (g0 == null || g1 == null) {
      colourOf(range, T, _c0);
      paint(body.mat, _c0);
    } else {
      colourOf(range, g0, _c0);
      colourOf(range, g1, _c1);
      paint(body.mat, _c0, _c1);
    }
  }

  // The level comes from the inventory, so a vessel that is losing water shows
  // it. Nothing is rebuilt: a level is a scale and a shift.
  if (body.body.setLevel && view.level != null) {
    body.body.setLevel(body.y0, Math.max(body.y0 + 1e-3, Math.min(body.y1, view.level)));
  }

  // The top of the body is pushed about by the shallow-water solve, so it
  // tilts and breaks up instead of sitting flat. The SOLVER owns and steps the
  // surface, because how hard a body is boiling and what is pouring into it
  // are simulation, not drawing; this only reads the heights it produced.
  if (view.surface && body.body.top) {
    ripple(body.body.top, view.surface, body.radius, 0.5);
  }

  // Bubbles when it boils, and vapour standing over it. Both read the rate the
  // solver worked out from the mass that actually changed phase, so they
  // cannot disagree with the state.
  const boil = Math.min(1, view.boil || 0);
  if (body.riser) {
    const lvl = view.level == null ? body.y1 : view.level;
    body.riser.step(dt, body.y0, Math.max(0.1, lvl - body.y0), boil, 0, 0, 1, 1);
  }
  if (body.puff) {
    body.puff.step(dt, 0, view.level == null ? body.y1 : view.level, 0, boil * 0.7, 1, 0.11);
  }

  // THE VAPOUR SPACE FILLS WHAT THE WATER HAS LEFT, exactly. One number moves
  // both: the water's clipping plane keeps what is below the level and the
  // vapour's keeps what is above it, so they meet at the surface however the
  // level moves and there is no gap and no overlap to see.
  if (body.gas && view.level != null) {
    body.gas.setLevel(Math.max(body.y0, Math.min(body.y1, view.level)));
    // How much there is to see. A gas space over cold water is air and nothing
    // is drawn; over boiling water it is steam and it is. The quality is the
    // honest measure of that and it is already published.
    const x = Math.min(1, Math.max(0, view.x || 0));
    const want = 0.06 + 0.5 * Math.min(1, x * 12);
    if (body.gas.mat.opacity !== want) {
      body.gas.mat.opacity = want;
      body.gas.mat.transparent = true;
      body.gas.mesh.visible = want > 0.07;
    }
  }

  // Drops and fog when it is CONDENSING, which is the mirror of the bubbles
  // and reads the same published rate.
  if (body.drip) {
    const cond = Math.min(1, view.cond || 0);
    const lvl = view.level == null ? body.y1 : view.level;
    // (dt, cx, cz, span, depth, top, floor, rate): they fall from the top of
    // the space to the water standing in it.
    body.drip.step(dt, 0, 0, body.halfWidth * 1.6, body.halfWidth, body.y1, lvl, cond);
  }
  // The temperature this body was actually painted at, which is the fallback a
  // split with no run of its own takes. Not view.T: a gradient body is painted
  // between two ends, and the mean of those is what its one colour would be.
  return T;
}

// The far side of a partition takes its colour from its own run, which is the
// whole reason it is a second skin.
//
// ONE WRITER FOR BOTH KINDS OF BODY. This used to live inside updateVolume(),
// which a drawn JOINT never reaches, so a channel head with a divider plate
// had its near half painted and its far half left white: the split is exactly
// what a channel head is for, a hot half and a cold half of one bowl, so the
// one body that most wants it was the one body that did not get it. Reported
// by the consumer against its own steam generator head.
function paintSplit(body, T) {
  if (!body.split || !body._farRange) return;
  const r2 = body._farRange;
  const fT = body._farT == null ? T : body._farT;
  if (fT !== body._pT2 || r2.lo !== body._pLo2 || r2.hi !== body._pHi2) {
    body._pT2 = fT; body._pLo2 = r2.lo; body._pHi2 = r2.hi;
    colourOf(r2, fT, _c0);
    paint(body.split.mat, _c0);
  }
}

// Paint a joint. A junction holds nothing, so there is no level to move, no
// surface to ripple and no boiling rate to read: a drawn joint is a body of
// water that is always full, and the only question is what colour it is.
//
// It takes that from the EDGES that meet at it, never from a node state,
// because a junction's own temperature is a bookkeeping value the solver keeps
// for seeding pipes and not a body of water anyone should be shown. A channel
// head with a gradient authored across it is painted between the water
// arriving and the water leaving, which is what a head actually looks like;
// with none, it takes the water in the line it was given a span from.
function updateJoint(body, range, T) {
  const g0 = body.grad ? body._gLo : null, g1 = body.grad ? body._gHi : null;
  const lo = range.lo, hi = range.hi;
  if (T !== body._pT || lo !== body._pLo || hi !== body._pHi
    || g0 !== body._pG0 || g1 !== body._pG1) {
    body._pT = T; body._pLo = lo; body._pHi = hi; body._pG0 = g0; body._pG1 = g1;
    if (g0 == null || g1 == null) {
      if (!(T >= 0)) return;
      colourOf(range, T, _c0);
      paint(body.mat, _c0);
    } else {
      colourOf(range, g0, _c0);
      colourOf(range, g1, _c1);
      paint(body.mat, _c0, _c1);
    }
  }
}

// The whole per-frame update. Call it once, after solver.step(dt).
//
//   const fluids = attach(net, scene, { cut });
//   const frame = new FluidFrame(fluids);
//   function tick(dt) { solver.step(dt); frame.update(dt, solver); }
export class FluidFrame {
  constructor(fluids, opts = {}) {
    this.fluids = fluids;
    this.opts = opts;
    // Bound once. The solver's views are flyweights it reuses, so holding the
    // id and asking for the view each frame costs nothing and stays correct
    // across a rebuild, where an index would not.
    this._edges = fluids.edges;
    this._volumes = fluids.volumes;
  }

  update(dt, solver) {
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    // The one clock every fluid shader scrolls off, so nothing drifts out of
    // step with anything else.
    advanceTime(dt);

    for (let i = 0; i < this._edges.length; i++) {
      const body = this._edges[i];
      const view = solver.edge(body.id);
      if (!view) continue;
      // A break's jet is there only while the hole is. Checked every frame, so
      // opening or healing a break shows in the picture immediately and
      // without a rebuild.
      if (body.jet) {
        const on = Number.isFinite(body.jet.area) && body.jet.area > 0;
        body.group.visible = on;
        if (!on) continue;
      }
      // An edge that belongs to no run reports -1, not null.
      const r = view.run;
      const range = r >= 0 ? solver.run(r) : null;
      updateEdge(body, view, range || ZERO_RANGE, dt);
    }

    for (let i = 0; i < this._volumes.length; i++) {
      const body = this._volumes[i];
      // A drawn joint has no volume view, because it is a junction and holds
      // nothing. Everything below this reads inventory, so it takes its own
      // short path.
      const view = body.joint ? null : solver.volume(body.id);
      if (!view && !body.joint) continue;
      // A volume has no run of its own; attach() recorded which run's span to
      // paint it against and why.
      let range = null;
      if (body.rangeEdge) {
        const ev = solver.edge(body.rangeEdge);
        if (ev && ev.run != null && ev.run >= 0) range = solver.run(ev.run);
      }
      // THE FAR SIDE OF A PARTITION HAS ITS OWN RUN, which is the whole reason
      // it is a second skin: the two chambers of a divided vessel are at
      // different temperatures and each belongs to a different circuit. The
      // edge named in the split is the one it takes both its span AND its
      // temperature from, because a chamber's own water is the water in the
      // line that leaves it.
      if (body.split && body.split.range) {
        const fv = solver.edge(body.split.range);
        if (fv) {
          body._farT = fv.T0;
          if (fv.run != null && fv.run >= 0) body._farRange = solver.run(fv.run) || range;
          else body._farRange = range;
        }
      }
      // The two temperatures a gradient body is painted between, read from the
      // ends of the named edges that actually touch this vessel.
      if (body.grad) {
        const fv = solver.edge(body.grad.from.id), tv = solver.edge(body.grad.to.id);
        body._gLo = fv ? (body.grad.from.far ? fv.T1 : fv.T0) : null;
        body._gHi = tv ? (body.grad.to.far ? tv.T1 : tv.T0) : null;
      }
      if (body.joint) {
        // The water in the line the joint borrows its span from, at the end
        // that touches the joint.
        let T = -1;
        if (body.rangeEdge) {
          const ev = solver.edge(body.rangeEdge);
          if (ev) T = body.jointFar ? ev.T1 : ev.T0;
        }
        updateJoint(body, range || ZERO_RANGE, T);
        paintSplit(body, T);
        continue;
      }
      paintSplit(body, updateVolume(body, view, range || ZERO_RANGE, dt));
    }
  }

  dispose() {}
}

const ZERO_RANGE = { lo: 0, hi: 0 };

export { paint, tintVapour, colourOf };
