// ---------------------------------------------------------------------------
// pipe.js - a run of pipe, and the bodies of revolution fluid stands in.
//
// A pipe here is a real object: a centreline with real elbows, a steel casing,
// and a BODY OF LIQUID FILLING THE BORE with specks carried along in it. A
// thin thread down the middle of a pipe is a diagram; a full bore is what
// water in a pipe looks like.
//
// Carried over from nuclear-cooling-sim's js/view/parts.js.
//
// NO FLANGES, NO COLLARS, NO GREY RINGS. They were tried: rings of grey metal
// every seven metres along every run, and what they actually did was chop each
// pipe into segments and put a hard grey edge across the water travelling down
// it. Build everything whole and cut it at render time.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { liquidMaterial, steamMaterial, casingMaterial, fleckMaterial } from './materials.js';
import { Tracers, frameOf } from './particles.js';

export const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Points from anything a network or a host might hand over: [x,y,z] triples,
// {x,y,z} objects, or THREE.Vector3s.
export function toPoints(pts) {
  return pts.map((p) => (p && p.isVector3 ? p.clone()
    : Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2])
      : new THREE.Vector3(p.x, p.y, p.z)));
}

// A run of pipe with proper elbows: straight between the corners, a quadratic
// bend through each one. The bend radius is clamped to what the two legs can
// actually accommodate, so a tight corner bends as far as it can instead of
// overshooting into the leg before it.
export function roundedPath(pts, r = 1.6) {
  const path = new THREE.CurvePath();
  const p = toPoints(pts);
  if (p.length < 2) return path;
  let from = p[0].clone();
  for (let i = 1; i < p.length - 1; i++) {
    const c = p[i], next = p[i + 1];
    const inDir = c.clone().sub(from).normalize();
    const outDir = next.clone().sub(c).normalize();
    const rr = Math.min(r, from.distanceTo(c) * 0.45, c.distanceTo(next) * 0.45);
    const a = c.clone().addScaledVector(inDir, -rr);
    const b = c.clone().addScaledVector(outDir, rr);
    if (from.distanceTo(a) > 1e-4) path.add(new THREE.LineCurve3(from, a));
    path.add(new THREE.QuadraticBezierCurve3(a, c.clone(), b));
    from = b;
  }
  path.add(new THREE.LineCurve3(from, p[p.length - 1].clone()));
  return path;
}

// A run of pipe you can see into.
//
// opts:
//   bend      elbow radius in metres (default: 2.2 diameters)
//   steam     draw the core as vapour rather than as liquid
//   casing    false to leave the steel to a model that already has it, and
//             build only the fluid, the tracers and the caps
//   section   build the casing as a WHOLE tube cut on these planes rather than
//             as a far wall only. A steam run wants this: its core is
//             translucent, and with only a far wall it reads as a glowing tube
//             floating in the air. A water run's opaque core needs no such
//             thing and a far wall is cheaper.
//   cut       clipping planes for the fluid core
//   mats      { casing, fleck } to share materials across many runs
//   tracers   false for no specks, or a count
//   flowDir   -1 if the water runs the other way down this centreline. A tube
//             built left to right whose water flows right to left paints
//             backwards: say so here, or build it in flow order.
export function pipe(pts, dia, opts = {}) {
  const d = Math.max(1e-3, dia);
  const path = roundedPath(pts, opts.bend == null ? d * 2.2 : opts.bend);
  const len = path.getLength();
  const seg = Math.max(24, Math.round(len * 1.6));
  const group = new THREE.Group();
  const mats = opts.mats || {};
  const steam = !!opts.steam;

  // --- the steel ---
  let casing = null;
  if (opts.casing !== false) {
    const geo = new THREE.TubeGeometry(path, seg, d / 2, 12, false);
    const mat = opts.section
      ? (mats.steamCasing || casingMaterial({ color: 0x6f7b87, section: true, cut: opts.section }))
      : (mats.casing || casingMaterial());
    casing = new THREE.Mesh(geo, mat);
    casing.castShadow = true;
    casing.name = (opts.name || 'pipe') + '_casing';
    group.add(casing);
  }

  // --- the fluid ---
  const mat = steam ? steamMaterial() : liquidMaterial(d);
  // Cut on the same planes as everything else: a cut casing needs a cut core,
  // and the water in a pipe is a trough in a trough, the way a cutaway drawing
  // has it.
  const cut = opts.cut || opts.section || null;
  if (cut) mat.clippingPlanes = cut;
  const bore = d * (steam ? 0.48 : 0.46);
  const core = new THREE.Mesh(new THREE.TubeGeometry(path, seg, bore, 14, false), mat);
  core.name = (opts.name || 'pipe') + '_fluid';
  // The maps have to tile at the run's own scale, or the streaks stretch.
  const rx = Math.max(2, len / 2.4), ry = Math.max(1, Math.round(d * 3));
  if (mat.normalMap) mat.normalMap.repeat.set(rx, ry);
  if (mat.alphaMap) mat.alphaMap.repeat.set(rx * 0.6, Math.max(1, Math.round(d * 1.6)));
  if (steam) core.renderOrder = 3;
  group.add(core);

  // A tube is open at both ends, and a torn alpha map on a double-sided open
  // end, seen down the bore, is a starburst of white spikes: that is what a
  // main steam line looks like where it enters a turbine casing. So a vapour
  // run gets its ends closed. A liquid core is opaque and needs no cap.
  const caps = [];
  if (steam) {
    for (const e of [0, 1]) {
      const cap = new THREE.Mesh(new THREE.CircleGeometry(bore, 16), mat);
      cap.position.copy(path.getPointAt(e));
      cap.lookAt(cap.position.clone().addScaledVector(path.getTangentAt(e), e ? 1 : -1));
      cap.renderOrder = 3;
      group.add(cap);
      caps.push(cap);
    }
  }

  // --- what is carried in it ---
  // Spaced by length, so a long run carries more specks than a short one and
  // the spacing means the same thing everywhere. They are advected along this
  // run's own centreline at this run's own velocity, so a run added at any
  // time shows its flow with nothing else to set up.
  let tracers = null;
  if (opts.tracers !== false) {
    const frame = frameOf(path, Math.max(48, Math.min(260, Math.round(len * 4))));
    const count = opts.tracers > 0 ? opts.tracers
      : Math.max(12, Math.min(110, Math.round(len * 3.2)));
    // Vapour specks are no bigger than water ones. Scaled half again and then
    // stretched, they were the brightest thing in the picture.
    tracers = new Tracers(frame, bore * (steam ? 0.22 : 0.44), count,
      mats.fleck || fleckMaterial());
    if (cut) tracers.mesh.material.clippingPlanes = cut;
    group.add(tracers.mesh);
  }

  return {
    group,
    // With casing false the core is what a click on the pipe hits, so a host
    // raycasting to break a line always has something under the cursor.
    casing: casing || core,
    core, caps, tracers, path, len, mat, dia: d, bore, steam,
    flowDir: opts.flowDir == null ? 1 : opts.flowDir,
    dispose() {
      core.geometry.dispose();
      mat.dispose();
      if (casing) casing.geometry.dispose();
      if (tracers) tracers.dispose();
      for (const c of caps) c.geometry.dispose();
    }
  };
}

// A run of liquid with NO CASING round it. A boiler tube and a cooling coil
// are thin-walled: what you want to see is the water in them changing colour
// from one end to the other, not a pipe drawn round it.
export function fluidRod(pts, r, opts = {}) {
  const path = roundedPath(pts, opts.bend == null ? r * 3 : opts.bend);
  const len = path.getLength();
  const seg = Math.max(20, Math.round(len * 3));
  const mat = liquidMaterial(r * 2);
  if (mat.normalMap) mat.normalMap.repeat.set(Math.max(3, len / 1.4), 2);
  mat.attenuationDistance = r * 14;
  if (opts.cut) mat.clippingPlanes = opts.cut;
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, seg, r, 10, false), mat);
  mesh.castShadow = true;
  mesh.name = opts.name || 'rod';
  return {
    mesh, mat, path, len, group: mesh,
    dispose() { mesh.geometry.dispose(); mat.dispose(); }
  };
}

// A vessel of revolution from a profile of [radius, height] pairs.
export function vessel(profile, mat, opts = {}) {
  const pts = profile.map((p) => new THREE.Vector2(p[0], p[1]));
  const geo = new THREE.LatheGeometry(pts, opts.segments || 64);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = opts.name || 'vessel';
  return m;
}

// A body of water standing in a round vessel: a cylinder with a separate top
// disc, so the top can be rippled from a free surface while the sides stay
// straight. Both parts share one material, so one paint call colours the whole
// body and the water in a vessel can never disagree with its own surface.
export function waterColumn(radius, y0, y1, mat, opts = {}) {
  const h = Math.max(1e-3, y1 - y0);
  const seg = opts.segments || 40;
  const group = new THREE.Group();
  const side = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, seg, 1, true), mat);
  side.position.y = y0 + h / 2;
  side.name = (opts.name || 'water') + '_body';
  group.add(side);
  // A ring of segments, so a shallow-water solve can push its vertices about.
  const top = new THREE.Mesh(new THREE.CircleGeometry(radius, seg, 0, Math.PI * 2), mat);
  top.rotation.x = -Math.PI / 2;
  top.position.y = y1;
  top.name = (opts.name || 'water') + '_top';
  group.add(top);
  return {
    group, side, top, mat, radius,
    // Move the water without rebuilding it: a level is a scale and a shift,
    // not a new geometry every frame.
    setLevel(a, b) {
      const hh = Math.max(1e-3, b - a);
      side.scale.y = hh / h;
      side.position.y = a + hh / 2;
      top.position.y = b;
    },
    dispose() { side.geometry.dispose(); top.geometry.dispose(); }
  };
}

// Push a disc's vertices up and down from a shallow-water solve, so a surface
// tilts and ripples instead of sitting flat. amp scales the height: the solve
// is in metres and on a pool a metre across the same waves are spikes.
export function ripple(mesh, surface, radius, amp = 1) {
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // A CircleGeometry lies in xy before the mesh is turned, so the plane the
    // vertices live in is x, y and the height goes on z.
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, -surface.sampleAt(x, y, radius, amp));
  }
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

export { THREE };
