// ---------------------------------------------------------------------------
// parts.js - the reusable pieces of plant, as real geometry.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

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

// The stripe that runs along the inside of a pipe. One image, cloned per pipe
// so each can scroll at its own speed.
let stripeImage = null;
export function stripeTexture() {
  if (!stripeImage) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 8;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 128, 0);
    g.addColorStop(0.00, '#0a2c48');
    g.addColorStop(0.34, '#1f6ea8');
    g.addColorStop(0.47, '#a9e4ff');
    g.addColorStop(0.53, '#e6faff');
    g.addColorStop(0.66, '#1f6ea8');
    g.addColorStop(1.00, '#0a2c48');
    x.fillStyle = g; x.fillRect(0, 0, 128, 8);
    stripeImage = c;
  }
  const t = new THREE.CanvasTexture(stripeImage);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A pipe you can see into: a see-through casing with the fluid inside it.
export function pipe(pts, dia, mats, opts = {}) {
  const path = roundedPath(pts, opts.bend || dia * 2.2);
  const len = path.getLength();
  const seg = Math.max(24, Math.round(len * 1.6));
  const group = new THREE.Group();
  const casing = new THREE.Mesh(
    new THREE.TubeGeometry(path, seg, dia / 2, 14, false), mats.pipe);
  casing.castShadow = true;
  group.add(casing);
  const tex = stripeTexture();
  tex.repeat.set(Math.max(2, len / 3.2), 1);
  const core = new THREE.Mesh(
    new THREE.TubeGeometry(path, seg, dia * 0.33, 12, false),
    new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.85,
      color: 0xffffff, roughness: 0.25, metalness: 0, toneMapped: true
    }));
  group.add(core);
  return { group, casing, core, tex, len, path, tint: core.material };
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
