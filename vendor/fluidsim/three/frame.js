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
import { paint, tintVapour, colourOf, advanceTime } from './materials.js?v=a7f82a57a1';
import { ripple } from './pipe.js?v=a7f82a57a1';

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
  const T = view.T, lo = range.lo, hi = range.hi;
  if (T !== body._pT || lo !== body._pLo || hi !== body._pHi) {
    body._pT = T; body._pLo = lo; body._pHi = hi;
    colourOf(range, T, _c0);
    paint(body.mat, _c0);
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
      const view = solver.volume(body.id);
      if (!view) continue;
      // A volume has no run of its own; attach() recorded which run's span to
      // paint it against and why.
      let range = null;
      if (body.rangeEdge) {
        const ev = solver.edge(body.rangeEdge);
        if (ev && ev.run != null && ev.run >= 0) range = solver.run(ev.run);
      }
      updateVolume(body, view, range || ZERO_RANGE, dt);
    }
  }

  dispose() {}
}

const ZERO_RANGE = { lo: 0, hi: 0 };

export { paint, tintVapour, colourOf };
