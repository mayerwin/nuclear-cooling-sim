// ---------------------------------------------------------------------------
// attach.js - a network plus a scene gives you fluid bodies.
//
// This is the join between the two halves of the library. The core knows
// numbers and nothing else; src/three knows meshes and nothing else. attach()
// walks a Network once, builds a body of fluid for every edge and every volume
// that has a shape, and hands back an object whose update() reads the solver
// every frame and paints, advects and ripples what it built.
//
// Everything is built WHOLE and cut at render time. Nothing here knows about
// the simulation's state; that is frame.js's job.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { pipe, fluidRod, waterColumn, vessel, V } from './pipe.js?v=d7d0f53269';
import { build as buildMaterials, bodyMaterial, surfaceMaterial, casingMaterial, steamMaterial } from './materials.js?v=d7d0f53269';
import { Riser, Drip, PuffCloud } from './particles.js?v=d7d0f53269';

// A number, or the fallback. src/core keeps its own copy; the adapter is not
// allowed to import from src/core, so it carries this one line itself.
const num = (v, f) => (Number.isFinite(v) ? v : f);

// A body of fluid in a run of pipe: the steel, the liquid or vapour filling
// the bore, the specks carried along in it, and the numbers the frame loop
// needs to advect them.
function edgeBody(edge, opts, mats) {
  const kind = edge.kind || 'pipe';
  // What the edge carries decides how it is drawn. The fluid's NAME is the
  // authority, because that is what the network states and what the solver
  // uses; display.vapour is there for a host whose own fluid is a vapour under
  // some other name. There used to be a read of edge.vapour here, which
  // nothing ever set.
  const steam = edge.fluid === 'steam' || !!(edge.display && edge.display.vapour);
  // A tube bank and a coil are thin-walled: what you want to see is the water
  // in them changing colour from one end to the other, not a pipe drawn round
  // it. Everything else gets the full treatment.
  const bare = kind === 'tubes' || kind === 'coil' || edge.display?.bare;
  const common = {
    bend: edge.bend,
    cut: opts.cut,
    name: edge.id,
    mats
  };
  if (bare) {
    // A BUNDLE OF PARALLEL RUNS FROM ONE CENTRELINE AND A COUNT. A bank of
    // tubes is not one pipe and it is not fifty edges either: it is one flow
    // path drawn many times, so the model states the path once and says how
    // many there are, and the geometry is nested copies of it offset across
    // its own width. What comes out is the nested U-runs of any bundle, which
    // is a heat exchanger, a condenser bank, a coil, a radiator or a set of
    // parallel risers; the library does not know which.
    //
    // ONE MESH, not n meshes: the copies are merged, so a fifty-tube bank is
    // one draw call and the frame cost of a bundle is the frame cost of a
    // pipe. A renderer that made a mesh per tube would be the difference
    // between a station that draws in 24 calls and one that draws in 300.
    const b = edge.display && edge.display.bundle;
    if (b && (b.n | 0) > 1) {
      const rods = bundleRods(edge.pts, edge.dia / 2, b, common);
      return { kind: 'rod', group: rods.mesh, mat: rods.mat, len: rods.len,
        tracers: null, steam: false, dispose: rods.dispose };
    }
    const rod = fluidRod(edge.pts, edge.dia / 2, common);
    return { kind: 'rod', group: rod.mesh, mat: rod.mat, len: rod.len,
      tracers: null, steam: false, dispose: rod.dispose };
  }
  const p = pipe(edge.pts, edge.dia, Object.assign({
    steam,
    // A vapour run wants a whole tube cut on the plane rather than a far wall
    // only: its core is translucent, and with only a far wall it reads as a
    // glowing tube floating in the air.
    section: steam ? opts.cut : null,
    casing: opts.casing === false ? false : undefined,
    tracers: opts.tracers === false ? false : undefined
  }, common));
  return { kind: 'pipe', group: p.group, mat: p.mat, len: p.len,
    tracers: p.tracers, steam: p.steam, casing: p.casing, core: p.core,
    dispose: p.dispose };
}

// The horizontal perpendicular of a run's own first leg. A bundle laid along x
// spreads across z and one laid along z spreads across x, with no axis stated
// anywhere: the model gives a path and a count. A run that starts straight up
// has no horizontal direction of its own, so it spreads across x, which is as
// good an answer as there is.
function acrossFirstLeg(pts) {
  const p0 = pts[0] || [0, 0, 0], p1 = pts[1] || pts[0] || [1, 0, 0];
  const ax = p1[0] - p0[0], az = p1[2] - p0[2];
  const len = Math.hypot(ax, az);
  return len > 1e-6 ? [-az / len, 0, ax / len] : [1, 0, 0];
}

// WIDENING IS A PARALLEL CURVE, NOT A SLIDE SIDEWAYS, and getting that wrong
// is the whole difficulty of the thing.
//
// A bank of U-tubes nests: each tube is the same hairpin with its legs further
// apart AND its bend reaching further, so five of them sit one inside the next
// like the fingers of a hand. Move the path sideways instead and the legs
// spread while the bend's tip stays where it was, so every tube in the bank
// passes through one point and the picture pinches there.
//
// The right operation is the one a draughtsman does: offset the path along its
// own outward normal, in its own plane. A hairpin's legs then move apart by the
// step and its bend moves out by half of it, which is a wider U rather than a
// stretched one.
//
// The plane is the path's own, found from the first pair of tangents that are
// not parallel; outward is away from the path's centroid, which for any
// hairpin, coil or bend is the side a bigger copy has to grow into. A path with
// no plane, which is a straight run, has no widening to do and says so by
// returning null, and the bundle falls back to laying copies side by side.
function outwardNormals(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const L = Math.hypot(v[0], v[1], v[2]); return L > 1e-9 ? [v[0] / L, v[1] / L, v[2] / L] : null; };
  // The plane: the largest cross product of consecutive legs, which is the
  // corner least likely to be a rounding artefact of a nearly straight one.
  let plane = null, big = 0;
  for (let i = 1; i < n - 1; i++) {
    const c = cross(sub(pts[i], pts[i - 1]), sub(pts[i + 1], pts[i]));
    const L = Math.hypot(c[0], c[1], c[2]);
    if (L > big) { big = L; plane = c; }
  }
  plane = big > 1e-9 ? norm(plane) : null;
  if (!plane) return null;
  let cx = 0, cy = 0, cz = 0;
  for (const q of pts) { cx += q[0]; cy += q[1]; cz += q[2]; }
  cx /= n; cy /= n; cz /= n;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[i > 0 ? i - 1 : 0], b = pts[i < n - 1 ? i + 1 : n - 1];
    let m = norm(cross(plane, sub(b, a)));
    if (!m) { out[i] = [0, 0, 0]; continue; }
    // Away from the middle of the path: the side a wider copy grows into.
    const r = sub(pts[i], [cx, cy, cz]);
    if (m[0] * r[0] + m[1] * r[1] + m[2] * r[2] < 0) m = [-m[0], -m[1], -m[2]];
    out[i] = m;
  }
  return out;
}

// n copies of one centreline, displaced per copy, merged into a single
// geometry. THREE RULES, AND A COPY TAKES THE SUM OF WHATEVER IS STATED.
//
//   gap    metres across the run's own perpendicular, which is a radiator:
//          n rods side by side. The default when nothing else is stated.
//   offset [dx, dy, dz] metres per copy, in the model's own axes, which is
//          rows at heights, or a rake, or side by side along a stated line.
//   widen  metres of EXTRA SEPARATION per copy between the path's legs, which
//          is a bank of nested U-tubes: the shape a steam generator has and
//          the one a reviewer looks at. Each side moves half of it, so the
//          number is the separation the way a drawing dimensions it. See
//          outwardNormals for why this is a parallel curve and not a slide.
//
// Every rule is CENTRED on the authored path, so a bundle sits where its
// centreline was drawn whatever its count, and `gap` only takes its old
// default when it is the only rule: an offset bundle that also spread
// sideways by four radii would be a surprise.
function bundleRods(pts, r, b, common) {
  const n = Math.max(1, Math.min(256, b.n | 0));
  const off = Array.isArray(b.offset) ? b.offset : null;
  const widen = num(b.widen, 0);
  const stated = off || widen !== 0;
  const gap = num(b.gap, stated ? 0 : 4 * r);
  const [ox, , oz] = acrossFirstLeg(pts);
  const wn = widen !== 0 ? outwardNormals(pts) : null;
  const parts = [];
  const mats = [];
  const first = ((n - 1) / 2) * gap;
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const d = i * gap - first;
    const k = i - mid;
    const moved = pts.map((q, j) => {
      let x = q[0] + ox * d, y = q[1], z = q[2] + oz * d;
      if (off) { x += k * num(off[0], 0); y += k * num(off[1], 0); z += k * num(off[2], 0); }
      if (wn) {
        // Half the step each side, so `widen` is the separation a drawing
        // would dimension rather than the travel of one leg.
        const h = k * widen * 0.5, m = wn[j];
        x += m[0] * h; y += m[1] * h; z += m[2] * h;
      }
      return [x, y, z];
    });
    const rod = fluidRod(moved, r, common);
    rod.mesh.updateMatrixWorld(true);
    parts.push(rod.mesh.geometry.clone().applyMatrix4(rod.mesh.matrixWorld));
    mats.push(rod);
  }
  // Merged by hand rather than with three's BufferGeometryUtils, because this
  // library takes no dependency beyond three itself and the addon is one.
  const merged = mergeGeometries(parts);
  for (const rod of mats) rod.dispose();
  const mat = mats[0] ? mats[0].mat : null;
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = (common.name || 'bundle') + '_bundle';
  return { mesh, mat, len: mats[0] ? mats[0].len : 1,
    dispose() { merged.dispose(); } };
}

// The one geometry merge this library needs, written out rather than imported:
// positions, normals, uvs and an index, all of which fluidRod produces.
function mergeGeometries(list) {
  let nv = 0, ni = 0;
  for (const g of list) {
    nv += g.attributes.position.count;
    ni += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    const gp = g.attributes.position, gn = g.attributes.normal, gu = g.attributes.uv;
    pos.set(gp.array.subarray(0, gp.count * 3), vo * 3);
    if (gn) nor.set(gn.array.subarray(0, gn.count * 3), vo * 3);
    if (gu) uv.set(gu.array.subarray(0, gu.count * 2), vo * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < gp.count; i++) idx[io + i] = i + vo;
      io += gp.count;
    }
    vo += gp.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// A body of fluid standing in a vessel, a pool or a tank. The shape comes from
// the network, so the water is the size the network says it is and the picture
// and the state can never disagree about how much there is.
// The radius of a lathe profile at an elevation, so the top of the water is
// the size the vessel actually is there rather than the size of its widest
// part. A tapered vessel filled to a third looks wrong otherwise.
function radiusAt(profile, y) {
  let r = 0;
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1], [r1, y1] = profile[i];
    if (y1 === y0) { if (y === y0) r = Math.max(r, r0, r1); continue; }
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    if (y >= lo && y <= hi) {
      const f = (y - y0) / (y1 - y0);
      r = Math.max(r, r0 + (r1 - r0) * f);
    }
  }
  if (r <= 0) for (const p of profile) r = Math.max(r, p[0]);
  return r;
}

// THE PROFILE A LATHE IS DRAWN FROM, whatever kind of volume it is. A vessel
// is its own profile; an ANNULUS is the space between two, which is drawn by
// going up the outer wall and back down the inner one, so the same LatheGeometry
// makes a jacket, a downcomer, a guide tube or the gap between two shells with
// no new mesh code at all. The profile closes on itself, which is what gives it
// an inside surface to see.
function latheProfile(s) {
  if (s.kind === 'lathe' && Array.isArray(s.profile)) return s.profile;
  if (s.kind === 'annulus' && Array.isArray(s.outer) && Array.isArray(s.inner)) {
    const out = [];
    for (const row of s.outer) out.push([Math.max(0, +row[0]), +row[1]]);
    for (let i = s.inner.length - 1; i >= 0; i--) {
      const row = s.inner[i];
      out.push([Math.max(0, +row[0]), +row[1]]);
    }
    // Closed, so the ring has a floor and a roof rather than two open ends.
    out.push([Math.max(0, +s.outer[0][0]), +s.outer[0][1]]);
    return out;
  }
  return null;
}

function volumeBody(node, opts) {
  const s = node.shape || {};
  const at = node.at || [0, 0, 0];
  const prof = latheProfile(s);
  const across = prof ? Math.max(...prof.map((p) => p[0]))
    : (s.w != null ? s.w / 2 : (s.r != null ? s.r : 1));
  const disp = node.display || {};
  const mat = bodyMaterial({
    cut: opts.cut,
    attenuation: Math.max(1.5, across * 1.8),
    thickness: Math.max(0.5, across * 0.8),
    repeat: [3, 3]
  });
  const group = new THREE.Group();
  // ONLY THE HORIZONTAL POSITION. Every shape in a network states its y in
  // absolute metres, and so does the level the solver publishes, so a group
  // that also carried the node's elevation would apply it twice: a tank at
  // twelve metres holding a profile written from twelve to fifteen came out
  // hanging at twenty-four. Keeping y absolute everywhere means the level, the
  // clipping plane, the surface and the bubbles all agree without conversion.
  group.position.set(at[0], 0, at[2]);

  let body = null, radius = across, halfWidth = across, y0 = 0, y1 = 1;

  if (s.kind === 'cylinder') {
    // A DRUM ON ITS SIDE, which is the one shape a lathe cannot be and half a
    // power station is made of: a condenser shell, a feedwater heater, a
    // receiver, a separator. The core knows it exactly, chord and circular
    // segment in closed form; here it is a cylinder laid down along its own
    // axis and cut by its level, the same clipping plane every other body
    // uses, so a half-full drum shows a real waterline down its length.
    const r = Math.max(1e-3, s.r), len = Math.max(1e-3, s.len);
    y0 = s.y0 == null ? 0 : s.y0;
    const yc = y0 + r;
    y1 = y0 + 2 * r;
    const alongZ = s.axis === 'z';
    // Slightly inside the shell, so the water does not z-fight the steel.
    const side = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.985, r * 0.985, len * 0.99, opts.segments || 48, 1, false), mat);
    if (alongZ) side.rotation.x = Math.PI / 2; else side.rotation.z = Math.PI / 2;
    side.position.y = yc;
    side.name = node.id + '_body';
    const levelPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), y1);
    side.material.clippingPlanes = (opts.cut || []).concat([levelPlane]);
    // The waterline is a rectangle the length of the drum and the width of the
    // chord at that level, which is why it is built one unit wide and scaled:
    // the chord is the only thing about it that moves.
    const top = new THREE.Mesh(new THREE.PlaneGeometry(len * 0.99, 1, 24, 4), mat);
    top.rotation.x = -Math.PI / 2;
    if (alongZ) top.rotation.z = Math.PI / 2;
    top.name = node.id + '_top';
    group.add(side);
    group.add(top);
    radius = r; halfWidth = r;
    body = {
      group, side, top, mat, radius: r, levelPlane,
      setLevel(a, b) {
        levelPlane.constant = b;
        // The chord of the circle at this level. It is zero at both ends, so
        // the scale is floored: a plane of zero width is not drawn and a
        // NaN-free zero is what the two ends actually have.
        const dy = Math.min(r, Math.max(-r, b - yc));
        const chord = 2 * Math.sqrt(Math.max(0, r * r - dy * dy));
        top.position.y = b;
        top.scale.set(1, Math.max(1e-3, chord), 1);
      },
      dispose() { side.geometry.dispose(); top.geometry.dispose(); }
    };
    body.setLevel(y0, y1);
  } else if (prof) {
    // A vessel of revolution. The water is the vessel's own shape, and the
    // LEVEL is a clipping plane rather than a rebuilt geometry: moving a plane
    // costs nothing per frame and it is exact for any profile, where scaling
    // the body in y would squash a taper instead of draining it.
    y0 = Math.min(...prof.map((p) => p[1]));
    y1 = Math.max(...prof.map((p) => p[1]));
    // Slightly inside the wall, so the water does not z-fight the steel.
    const pts = prof.map((p) => new THREE.Vector2(Math.max(0, p[0] * 0.985), p[1]));
    const side = new THREE.Mesh(new THREE.LatheGeometry(pts, opts.segments || 48), mat);
    side.name = node.id + '_body';
    const levelPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), y1);
    // The body is cut by the section AND by its own level. clipIntersection is
    // false, so a fragment on the wrong side of EITHER plane goes, which is
    // the union of the two cuts and what a cutaway of a part-full vessel is.
    mat.clippingPlanes = (opts.cut || []).concat([levelPlane]);
    const top = new THREE.Mesh(new THREE.CircleGeometry(across, opts.segments || 48), mat);
    top.rotation.x = -Math.PI / 2;
    top.name = node.id + '_top';
    group.add(side);
    group.add(top);
    body = {
      group, side, top, mat, radius: across, levelPlane,
      setLevel(a, b) {
        // A plane keeps the half whose signed distance is positive, and this
        // one points DOWN, so the constant is the level itself and everything
        // above it goes.
        levelPlane.constant = b;
        const r = radiusAt(prof, b);
        top.position.y = b;
        top.scale.set(Math.max(1e-3, r / across), Math.max(1e-3, r / across), 1);
      },
      dispose() { side.geometry.dispose(); top.geometry.dispose(); }
    };
    body.setLevel(y0, y1);
  } else if (s.kind === 'box' || s.w != null) {
    // A tank or a pool. Built as a slab with its own top, so the top can be
    // rippled from the free surface while the sides stay straight.
    const w = s.w || 2, d = s.d || 2;
    y0 = s.y0 == null ? 0 : s.y0;
    y1 = s.h != null ? y0 + s.h : (s.y1 == null ? y0 + 1 : s.y1);
    const h = Math.max(1e-3, y1 - y0);
    const side = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    side.position.y = y0 + h / 2;
    side.name = node.id + '_body';
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 40, 8), mat);
    top.rotation.x = -Math.PI / 2;
    top.position.y = y1;
    top.name = node.id + '_top';
    group.add(side);
    group.add(top);
    halfWidth = w / 2;
    radius = halfWidth;
    body = {
      group, side, top, mat, radius: halfWidth,
      setLevel(a, b) {
        const hh = Math.max(1e-3, b - a);
        side.scale.y = hh / h;
        side.position.y = a + hh / 2;
        top.position.y = b;
      },
      dispose() { side.geometry.dispose(); top.geometry.dispose(); }
    };
  } else {
    // No shape worth drawing: an 'area' or a 'point' volume is a number, not a
    // body. It still gets a record so the frame loop can skip it cheaply.
    body = { group, side: null, top: null, mat, radius: 1,
      setLevel() {}, dispose() {} };
    y0 = 0; y1 = 1;
  }

  // A VAPOUR SPACE THAT FILLS WHAT THE WATER DOES NOT. The particles below are
  // what rises OFF a surface; this is the body of vapour standing over it,
  // which is a different thing and is what you see through a cutaway of any
  // vessel with a headspace: a dome, a drum, a condenser shell, a tank with
  // its ullage. The same geometry as the water, clipped the other way round,
  // so it always fills exactly the room the water has left and the two can
  // never overlap or leave a gap between them.
  let gas = null;
  if (disp.vapour && (prof || s.kind === 'cylinder' || s.kind === 'box' || s.w != null)) {
    const gasMat = steamMaterial ? steamMaterial({ cut: opts.cut }) : null;
    if (gasMat) {
      const gasPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      gasMat.clippingPlanes = (opts.cut || []).concat([gasPlane]);
      let mesh = null;
      if (prof) {
        const pts = prof.map((p) => new THREE.Vector2(Math.max(0, p[0] * 0.97), p[1]));
        mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, opts.segments || 48), gasMat);
      } else if (s.kind === 'cylinder') {
        const r = Math.max(1e-3, s.r), len = Math.max(1e-3, s.len);
        mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(r * 0.97, r * 0.97, len * 0.98, opts.segments || 48, 1, false), gasMat);
        if (s.axis === 'z') mesh.rotation.x = Math.PI / 2; else mesh.rotation.z = Math.PI / 2;
        mesh.position.y = (s.y0 == null ? 0 : s.y0) + r;
      } else {
        const w = (s.w || 2) * 0.98, d = (s.d || 2) * 0.98;
        const yy0 = s.y0 == null ? 0 : s.y0;
        const hh = s.h != null ? s.h : ((s.y1 == null ? yy0 + 1 : s.y1) - yy0);
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), gasMat);
        mesh.position.y = yy0 + hh / 2;
      }
      mesh.name = node.id + '_gas';
      group.add(mesh);
      // The plane points UP, so everything BELOW the level goes: the vapour is
      // what is left above it, which is the exact complement of the water.
      gas = { mesh, mat: gasMat, plane: gasPlane,
        setLevel(b) { gasPlane.constant = -b; },
        dispose() { mesh.geometry.dispose(); gasMat.dispose(); } };
    }
  }

  // What comes off a body of water: bubbles when it boils, vapour over it.
  let riser = null, puff = null, drip = null;
  if (opts.particles !== false) {
    riser = new Riser(halfWidth * 0.85, opts.bubbles || 60, opts.mats.bubble);
    riser.mesh.material = opts.mats.bubble;
    group.add(riser.mesh);
  }
  if (opts.vapour !== false) {
    puff = new PuffCloud(opts.puffs || 40, {
      w: halfWidth * 1.6, d: halfWidth * 1.6, h: Math.max(1, (y1 - y0) * 0.5),
      color: 0xdff0fb, size: 4
    });
    group.add(puff.points);
  }

  // A PARTITION, WHICH MAKES ONE VESSEL INTO CHAMBERS. A divided vessel is one
  // body of water with a wall down the middle and two different temperatures
  // either side of it: drawing it as two nodes would be a lie about the
  // geometry, and painting it as one is a lie about the water.
  //
  // IT IS TWO HALF-LATHES, NOT TWO CLIPPING PLANES. A vessel of revolution
  // divided by a wall through its axis is exactly what LatheGeometry's own
  // phiStart and phiLength describe, so each chamber is its own mesh with its
  // own material and its own colour range, and there is nothing to get wrong
  // about which fragment belongs to which side. Clipping planes were tried
  // first and are the wrong tool twice over: a plane parallel to the section
  // cut loses a whole chamber to the cut, and adding a plane to a material
  // that has already been compiled needs a recompile that is easy to forget.
  //
  // Generic on purpose: where the wall stands and which run each side takes its
  // colour from are the model's business. A channel head divided hot from cold,
  // a tank with a baffle and a settling chamber are the same object here.
  let split = null;
  if (disp.split && prof) {
    const at = num(disp.split.at, 0);
    const pts = prof.map((q) => new THREE.Vector2(Math.max(0, q[0] * 0.985), q[1]));
    const seg = Math.max(8, Math.round((opts.segments || 48) / 2));
    const farMat = bodyMaterial({
      cut: opts.cut,
      attenuation: Math.max(1.5, across * 1.8),
      thickness: Math.max(0.5, across * 0.8),
      repeat: [3, 3]
    });
    farMat.clippingPlanes = (opts.cut || []).concat(body.levelPlane ? [body.levelPlane] : []);
    const far = new THREE.Mesh(new THREE.LatheGeometry(pts, seg, at, Math.PI), farMat);
    far.name = node.id + '_far';
    group.add(far);
    // The near half is the same vessel through the other half turn, so the two
    // meet at the wall and nothing is drawn twice.
    body.side.geometry.dispose();
    body.side.geometry = new THREE.LatheGeometry(pts, seg, at + Math.PI, Math.PI);
    split = { mesh: far, mat: farMat, range: disp.split.range,
      dispose() { far.geometry.dispose(); farMat.dispose(); } };
  }

  // DROPS AND FOG, for a volume that is CONDENSING. The mirror of the bubbles:
  // a vessel taking heat out of a vapour has drops running down its walls and
  // a fog standing in the space, and both read the rate the solver worked out
  // from the mass that actually changed phase, so the picture cannot disagree
  // with the state. Any condensing volume, not a condenser: the library does
  // not know what a condenser is.
  if (disp.drops && opts.particles !== false && opts.mats && opts.mats.drop) {
    drip = new Drip(opts.drops || 40, opts.mats.drop);
    group.add(drip.mesh);
  }

  return { group, body, gas, split, mat, riser, puff, drip, radius, halfWidth, y0, y1,
    dispose() {
      body.dispose(); mat.dispose();
      if (gas) gas.dispose();
      if (riser) riser.dispose();
      if (puff) puff.dispose();
      if (drip) drip.dispose();
    } };
}

// Build every fluid body a network describes and add them to a scene.
//
//   const fluids = attach(net, scene, { cut: section.planes });
//   fluids.update(dt, solver);
//
// opts:
//   cut        clipping planes for every body (see src/three/cut.js)
//   root       the group to add to; one is made if absent
//   mats       a shared material table from materials.build()
//   casing     false when the 3D model already has the steel and only the
//              fluid, the tracers and the caps should be built here
//   tracers    false for no specks; particles/vapour false likewise
export function attach(net, scene, opts = {}) {
  const o = Object.assign({}, opts);
  o.mats = o.mats || buildMaterials({ cut: o.cut });
  const root = o.root || new THREE.Group();
  if (!o.root && scene) scene.add(root);

  const edges = [];
  const byEdgeId = new Map();
  for (const e of net.edges) {
    if (e.display && e.display.draw === false) continue;
    const b = edgeBody(e, o, o.mats);
    b.id = e.id;
    b.edge = e;
    // A BREAK'S DISCHARGE IS NOT A PIPE. Declaring where a line could one day
    // fail splits it in three at load, and the third piece is the hole's own
    // path to wherever it lets out. Drawn like the others it is a pipe hanging
    // off an intact line to nowhere, which is exactly the kind of unexplained
    // object the reviews kept throwing out. It appears when the hole does.
    b.jet = (net.devices || []).find((d) => d.kind === 'break' && d.edge === e.id) || null;
    if (b.jet) b.group.visible = num(b.jet.area, 0) > 0;
    root.add(b.group);
    edges.push(b);
    byEdgeId.set(e.id, b);
  }

  const volumes = [];
  const byVolumeId = new Map();
  for (const n of net.nodes || net.volumes || []) {
    // A JUNCTION IS A JOINT AND HOLDS NOTHING, BUT SOME JOINTS ARE THINGS YOU
    // CAN SEE. A boiler's channel head is the clearest case: the primary water
    // arrives in it, turns round through the tubes and leaves, and it is a
    // metre of water you look straight into on a cutaway. The network is right
    // to call it a junction, because giving it inventory would put a lump of
    // capacitance in the primary that the plant does not have, and it is the
    // PICTURE that is missing something, not the physics.
    //
    // So: a junction draws a body when the document gives it a shape, and that
    // is the whole trigger. A junction has never had any other use for one, so
    // a shape on a junction is an unambiguous request to draw it, and nothing
    // that exists today grows a body it did not have. What the shape means is
    // exactly what it means on a volume, which is why `point` and `area` are
    // excluded: they are numbers, not forms.
    //
    // The body holds nothing and is painted from the edges that meet at it.
    // See the joint branch in frame().
    const joint = n.kind !== 'volume';
    const drawnJoint = joint && n.kind === 'junction' && n.shape
      && n.shape.kind !== 'point' && n.shape.kind !== 'area';
    if (joint && !drawnJoint) continue;
    if (n.display && n.display.draw === false) continue;
    const b = volumeBody(n, o);
    b.id = n.id;
    b.node = n;
    // A joint is always full of itself: there is no level to move, no surface
    // to ripple and nothing to boil, so the frame loop paints it and stops.
    b.joint = joint;
    // WHICH SPAN A BODY OF WATER IS PAINTED AGAINST. Colour is normalised per
    // run, and a run is a chain of edges, so a volume has no span of its own.
    // It borrows one from a run it is actually part of, which is what the
    // consumer did by hand: its boiler's water was painted from the secondary
    // circuit's range, because that is the circuit the water belongs to.
    // Painted against nothing, every vessel comes out at the cold end of the
    // ramp whatever temperature it is at.
    b.rangeEdge = (n.display && n.display.range) || null;
    // A VESSEL IS NOT ONE TEMPERATURE, and the one most people look at is not.
    // A reactor's water is cold-leg blue where the loop returns it at the
    // bottom and hot-leg red where it leaves at the top, because the core
    // heats it on the way up, and a body painted one colour reads as a tank of
    // tepid water. `display.gradient: { from, to }` names the edge that brings
    // the water in and the edge that takes it out, and the body is painted
    // between their two temperatures from its floor to its top.
    //
    // The END that matters is the one touching THIS vessel: the water arriving
    // is at the arriving edge's vessel end, and the water leaving is at the
    // leaving edge's vessel end. A body material is already gradient-capable
    // along its height, so this costs one extra colour and no geometry.
    const grad = n.display && n.display.gradient;
    if (grad && grad.from && grad.to) {
      const endAt = (id) => {
        const e = net.edges.find((x) => x.id === id);
        if (!e) return null;
        // 1 means the edge's far end sits on this vessel, so its T1 is the
        // water at the vessel; 0 means its near end does, so T0 is.
        return { id, far: e.to === n.id ? 1 : 0 };
      };
      const f = endAt(grad.from), t = endAt(grad.to);
      if (f && t) b.grad = { from: f, to: t };
    }
    if (!b.rangeEdge) {
      for (const e of net.edges) {
        if (e.from === n.id || e.to === n.id) { b.rangeEdge = e.id; break; }
      }
    }
    // WHICH END OF THAT LINE IS THE WATER AT THIS JOINT. A volume reads its own
    // temperature and never needs this; a joint has none of its own, so it
    // reads the span edge's end, and the end that matters is the one touching
    // it. Getting it the wrong way round on a heat exchanger's outlet head
    // paints it with the water at the far end of the tubes, which is the whole
    // temperature difference of the bank in the wrong place.
    if (b.joint && b.rangeEdge) {
      const e = net.edges.find((x) => x.id === b.rangeEdge);
      b.jointFar = !!(e && e.to === n.id);
    }
    root.add(b.group);
    volumes.push(b);
    byVolumeId.set(n.id, b);
  }

  return {
    root, edges, volumes, mats: o.mats,
    edge: (id) => byEdgeId.get(id),
    volume: (id) => byVolumeId.get(id),
    dispose() {
      for (const b of edges) b.dispose();
      for (const b of volumes) b.dispose();
      root.removeFromParent();
    }
  };
}

export { THREE };
