// ---------------------------------------------------------------------------
// parts.js - the reusable pieces of plant, as real geometry.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { liquidMaterial, steamMaterial, Bubbles, frameOf } from './fluid.js?v=7211739fec';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// A run of pipe with proper elbows: straight between the corners, a quadratic
// bend through each one.
export function roundedPath(pts, r = 1.6) {
  const path = new THREE.CurvePath();
  if (pts.length < 2) return path;
  let from = pts[0].clone();
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i], next = pts[i + 1];
    const inDir = c.clone().sub(from).normalize();
    const outDir = next.clone().sub(c).normalize();
    const rr = Math.min(r, from.distanceTo(c) * 0.45, c.distanceTo(next) * 0.45);
    const a = c.clone().addScaledVector(inDir, -rr);
    const b = c.clone().addScaledVector(outDir, rr);
    if (from.distanceTo(a) > 1e-4) path.add(new THREE.LineCurve3(from, a));
    path.add(new THREE.QuadraticBezierCurve3(a, c.clone(), b));
    from = b;
  }
  path.add(new THREE.LineCurve3(from, pts[pts.length - 1].clone()));
  return path;
}

// A pipe you can see into: a see-through casing with a real body of liquid
// filling the bore, and bubbles carried along in it.
export function pipe(pts, dia, mats, opts = {}) {
  const path = roundedPath(pts, opts.bend || dia * 2.2);
  const len = path.getLength();
  const seg = Math.max(24, Math.round(len * 1.6));
  const group = new THREE.Group();
  const casing = new THREE.Mesh(
    new THREE.TubeGeometry(path, seg, dia / 2, 12, false), mats.pipe);
  casing.castShadow = true;
  group.add(casing);

  // Flanges: the pipe's outside, at the spacing a real run would have them.
  const frame = frameOf(path, Math.max(48, Math.min(260, Math.round(len * 4))));
  // Rings only where a run is long enough to need them. Two flanges on a two
  // metre stub is jewellery, and it was reading as machinery.
  const nRing = Math.round(len / 7);
  const rings = new THREE.InstancedMesh(
    new THREE.TorusGeometry(dia * 0.54, dia * 0.1, 6, 16), mats.flange, Math.max(1, nRing));
  rings.count = nRing;
  rings.frustumCulled = false;
  {
    const mm = new THREE.Matrix4(), q = new THREE.Quaternion();
    const zAx = new THREE.Vector3(0, 0, 1), one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < nRing; i++) {
      const t = (i + 0.5) / nRing * (frame.pts.length - 1);
      const j = Math.min(frame.pts.length - 2, t | 0);
      const tan = frame.pts[j + 1].clone().sub(frame.pts[j]).normalize();
      q.setFromUnitVectors(zAx, tan);
      mm.compose(frame.pts[j], q, one);
      rings.setMatrixAt(i, mm);
    }
  }
  group.add(rings);

  // The liquid fills the bore. A thin thread down the middle of a pipe is a
  // diagram; a full bore is what water in a pipe looks like.
  const steam = !!opts.steam;
  const mat = steam ? steamMaterial() : liquidMaterial(dia);
  const bore = dia * (steam ? 0.48 : 0.46);
  const core = new THREE.Mesh(
    new THREE.TubeGeometry(path, seg, bore, 14, false), mat);
  // The maps have to tile at the pipe's own scale or the streaks stretch.
  const rx = Math.max(2, len / 2.4), ry = Math.max(1, Math.round(dia * 3));
  mat.normalMap.repeat.set(rx, ry);
  if (mat.alphaMap) mat.alphaMap.repeat.set(rx * 0.6, Math.max(1, Math.round(dia * 1.6)));
  if (steam) core.renderOrder = 3;
  group.add(core);

  // Tracers, spaced by length so a long run carries more of them than a short
  // one and the spacing means the same thing everywhere. They are advected
  // along this pipe's own centreline at this pipe's own velocity, so a run
  // added at any time shows its flow with nothing else to set up.
  const count = Math.max(12, Math.min(110, Math.round(len * 3.2)));
  const bub = new Bubbles(frame, bore * (steam ? 0.3 : 0.44), count, mats.bubble);
  group.add(bub.mesh);

  return { group, casing, core, bub, len, path, mat, dia, bore, steam, tint: mat };
}

// A vessel of revolution from a profile, with a cut so the near half comes off.
export function vessel(profile, mat, opts = {}) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(pts, opts.segments || 64);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function tube(r0, r1, h, mat, seg = 40) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg, 1, false), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function slab(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// A handrail round an arc or along a line, built from real tubes.
export function railing(points, mat, height = 1.1) {
  const g = new THREE.Group();
  for (const hh of [height, height * 0.55]) {
    const p = points.map((q) => V(q.x, q.y + hh, q.z));
    const path = roundedPath(p, 0.6);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(path, points.length * 4, 0.06, 6, false), mat));
  }
  for (let i = 0; i < points.length; i += 2) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, height, 6), mat);
    post.position.set(points[i].x, points[i].y + height / 2, points[i].z);
    g.add(post);
  }
  return g;
}

export { V };
