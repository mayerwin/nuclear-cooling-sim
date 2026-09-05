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
import { pipe, fluidRod, waterColumn, vessel, V } from './pipe.js?v=a7f82a57a1';
import { build as buildMaterials, bodyMaterial, surfaceMaterial, casingMaterial } from './materials.js?v=a7f82a57a1';
import { Riser, Drip, PuffCloud } from './particles.js?v=a7f82a57a1';

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

function volumeBody(node, opts) {
  const s = node.shape || {};
  const at = node.at || [0, 0, 0];
  const prof = s.kind === 'lathe' && Array.isArray(s.profile) ? s.profile : null;
  const across = prof ? Math.max(...prof.map((p) => p[0]))
    : (s.w != null ? s.w / 2 : (s.r != null ? s.r : 1));
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

  if (prof) {
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

  // What comes off a body of water: bubbles when it boils, vapour over it.
  let riser = null, puff = null;
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

  return { group, body, mat, riser, puff, radius, halfWidth, y0, y1,
    dispose() { body.dispose(); mat.dispose(); if (riser) riser.dispose(); if (puff) puff.dispose(); } };
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
    // A junction is a joint, not a body: it has no shape and nothing to draw.
    if (n.kind !== 'volume') continue;
    if (n.display && n.display.draw === false) continue;
    const b = volumeBody(n, o);
    b.id = n.id;
    b.node = n;
    // WHICH SPAN A BODY OF WATER IS PAINTED AGAINST. Colour is normalised per
    // run, and a run is a chain of edges, so a volume has no span of its own.
    // It borrows one from a run it is actually part of, which is what the
    // consumer did by hand: its boiler's water was painted from the secondary
    // circuit's range, because that is the circuit the water belongs to.
    // Painted against nothing, every vessel comes out at the cold end of the
    // ramp whatever temperature it is at.
    b.rangeEdge = (n.display && n.display.range) || null;
    if (!b.rangeEdge) {
      for (const e of net.edges) {
        if (e.from === n.id || e.to === n.id) { b.rangeEdge = e.id; break; }
      }
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
