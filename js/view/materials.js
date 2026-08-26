// ---------------------------------------------------------------------------
// materials.js - one place where every surface in the plant is defined.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export const CUT = [
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
  new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
];

// A vertical plane through a vessel's own axis, so the near half comes off and
// you look straight in at the water. Facing the camera's quadrant.
export function halfCut(x, z) {
  const n = new THREE.Vector3(-1, 0, -1).normalize();
  return [new THREE.Plane(n, -(n.x * x + n.z * z))];
}

const P = (o) => Object.assign({ clipIntersection: false }, o);

export function build() {
  const m = {};
  m.concrete = new THREE.MeshStandardMaterial(P({
    color: 0x7d7669, roughness: 0.96, metalness: 0.02,
    clippingPlanes: CUT, clipIntersection: true, clipShadows: true,
    side: THREE.DoubleSide
  }));
  m.concreteInner = new THREE.MeshStandardMaterial(P({
    color: 0x5a5f66, roughness: 0.97, metalness: 0.02,
    clippingPlanes: CUT, clipIntersection: true, side: THREE.DoubleSide
  }));
  m.liner = new THREE.MeshStandardMaterial(P({
    color: 0x8fa3b5, roughness: 0.38, metalness: 0.9,
    clippingPlanes: CUT, clipIntersection: true, side: THREE.DoubleSide
  }));
  m.deck = new THREE.MeshStandardMaterial({ color: 0x4d545b, roughness: 0.92, metalness: 0.05 });
  m.steel = new THREE.MeshStandardMaterial({ color: 0xaeb9c4, roughness: 0.34, metalness: 0.9 });
  m.painted = new THREE.MeshStandardMaterial({ color: 0x5d6b78, roughness: 0.58, metalness: 0.35 });
  m.dark = new THREE.MeshStandardMaterial({ color: 0x3a444d, roughness: 0.8, metalness: 0.2 });
  m.copper = new THREE.MeshStandardMaterial({ color: 0xb87333, roughness: 0.4, metalness: 0.95 });
  m.rail = new THREE.MeshStandardMaterial({ color: 0xd6dee6, roughness: 0.4, metalness: 0.7 });

  // Vessel shells: real glass, so the water and the fuel inside are seen
  // through them rather than beside them.
  m.glass = new THREE.MeshPhysicalMaterial({
    color: 0xdce8f2, roughness: 0.05, metalness: 0, transmission: 0.94,
    thickness: 1.6, ior: 1.4, transparent: true, opacity: 1,
    side: THREE.DoubleSide, envMapIntensity: 1.4
  });
  m.glassHot = m.glass.clone(); m.glassHot.color = new THREE.Color(0xf0c6b4);

  // Pipe casing: see-through, so what is in the pipe is water rather than a
  // line that means water.
  m.pipe = new THREE.MeshPhysicalMaterial({
    color: 0xbfcad6, roughness: 0.18, metalness: 0.35, transmission: 0.72,
    thickness: 0.5, ior: 1.3, transparent: true, side: THREE.DoubleSide,
    envMapIntensity: 1.2
  });

  m.water = new THREE.MeshPhysicalMaterial({
    color: 0x2b8fd8, roughness: 0.08, metalness: 0.0, transmission: 0.55,
    thickness: 2.5, ior: 1.33, transparent: true, side: THREE.DoubleSide,
    emissive: 0x0b3a63, emissiveIntensity: 0.35
  });
  m.poolWater = m.water.clone();
  m.poolWater.transmission = 0.5;

  m.fuel = new THREE.MeshStandardMaterial({
    color: 0x6f7d88, roughness: 0.6, metalness: 0.5,
    emissive: 0x000000, emissiveIntensity: 1
  });
  m.lamp = new THREE.MeshStandardMaterial({ color: 0x101820, emissive: 0x63e08a, emissiveIntensity: 2 });
  return m;
}

const RAMP = [[560, 0x8a6a4a], [900, 0xd06a28], [1400, 0xf03516], [2200, 0xff3a18], [3200, 0xff8a55]];
export function tempColor(K) {
  const c = new THREE.Color();
  if (K <= RAMP[0][0]) return c.setHex(RAMP[0][1]);
  for (let i = 1; i < RAMP.length; i++) {
    if (K <= RAMP[i][0]) {
      const a = new THREE.Color(RAMP[i - 1][1]), b = new THREE.Color(RAMP[i][1]);
      return a.lerp(b, (K - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]));
    }
  }
  return c.setHex(RAMP[RAMP.length - 1][1]);
}

// Blue, then pale scalding, then orange. Straight from blue to orange passes
// through brown, and brown water reads as dirty rather than hot.
const COLD = new THREE.Color(0x2b8fd8), MID = new THREE.Color(0xd6ecf7), HOT = new THREE.Color(0xff6a33);
export function waterColor(u0, out = new THREE.Color()) {
  const u = Math.max(0, Math.min(1, u0));
  return u < 0.5 ? out.copy(COLD).lerp(MID, u * 2) : out.copy(MID).lerp(HOT, (u - 0.5) * 2);
}
export const heatOf = (K) => (K - 660) / 400;
