// ---------------------------------------------------------------------------
// materials.js - one place where every surface in the plant is defined.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { surfaceMaterial, bubbleMaterial, LOWFX } from './fluid.js?v=b19f8e6485';

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
  // The inside face of the containment. A dark polished liner turns the whole
  // interior into a cavern and the machinery in it into silhouettes, and the
  // interior is the entire point of the picture.
  m.liner = new THREE.MeshStandardMaterial(P({
    color: 0xb9c6d0, roughness: 0.62, metalness: 0.28,
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
  // On a handset the vessel walls are plain transparency rather than real
  // glass, for the reason given in fluid.js: refraction costs a whole extra
  // pass of the scene per material, and there are dozens of them here.
  m.glass = new THREE.MeshPhysicalMaterial({
    color: 0xdce8f2, roughness: LOWFX ? 0.3 : 0.05, metalness: 0,
    transmission: LOWFX ? 0 : 0.94,
    thickness: 1.6, ior: 1.4, transparent: true, opacity: LOWFX ? 0.2 : 1,
    side: THREE.DoubleSide, envMapIntensity: 1.4
  });
  m.glassHot = m.glass.clone(); m.glassHot.color = new THREE.Color(0xf0c6b4);

  // The far half of a vessel that has had its near half taken off: steel,
  // pale on the inside so the water and the fuel read against it.
  m.shell = new THREE.MeshStandardMaterial({
    color: 0x93a1ad, roughness: 0.42, metalness: 0.72, side: THREE.DoubleSide
  });

  // Pipe casing, cut away like a museum model: only the far wall is drawn, so
  // you look straight down the bore at the water. A fully transparent tube
  // washes out into whatever is behind it and the water disappears with it.
  m.pipe = new THREE.MeshStandardMaterial({
    color: 0x9fb0bf, roughness: 0.52, metalness: 0.25,
    side: THREE.BackSide, envMapIntensity: 0.7
  });
  // The outside of the pipe, so it still reads as a manufactured object: a
  // ring every few metres where a real run would have a flange.
  m.flange = new THREE.MeshStandardMaterial({
    color: 0x8b98a4, roughness: 0.42, metalness: 0.7
  });

  // Free surfaces: the same refractive body as the pipes, with an isotropic
  // ripple on it instead of a streamwise one.
  m.water = surfaceMaterial(5);
  m.poolWater = surfaceMaterial(4);
  m.bubble = bubbleMaterial();

  m.fuel = new THREE.MeshStandardMaterial({
    color: 0x6f7d88, roughness: 0.6, metalness: 0.5,
    emissive: 0x000000, emissiveIntensity: 1
  });
  // The bulb on the pole outside the turbine hall: the one thing in the model
  // whose whole job is to say whether electricity is being made.
  // What the downcomer carries. Air bubbles rise; anything drawn as a white
  // bubble travelling downwards reads as wrong before the viewer can say why.
  // These are specks of the water itself, the colour of the water, so they
  // read as the stream being carried rather than as air falling.
  m.mote = new THREE.MeshStandardMaterial({
    color: 0x7fc4ee, roughness: 0.25, metalness: 0,
    transparent: true, opacity: 0.55,
    emissive: new THREE.Color(0x2b6d96), emissiveIntensity: 0.5,
    depthWrite: false
  });
  // Condensate drops: bright, pale and a little glassy, so they read as water
  // coming out of steam rather than as more bubbles.
  m.drop = new THREE.MeshStandardMaterial({
    color: 0xe8f6ff, roughness: 0.05, metalness: 0,
    transparent: true, opacity: 0.85,
    emissive: new THREE.Color(0x5fa8cf), emissiveIntensity: 0.55
  });
  // Vapour coming off a boiling surface. Bigger, softer and fainter than a
  // bubble, and it never writes depth, so a cloud of them reads as one body of
  // steam leaving the water rather than as a hundred separate beads.
  m.puff = new THREE.MeshStandardMaterial({
    color: 0xf2f9ff, roughness: 1, metalness: 0,
    transparent: true, opacity: 0.13,
    emissive: new THREE.Color(0x9dc4de), emissiveIntensity: 0.28,
    depthWrite: false
  });
  m.bulb = new THREE.MeshStandardMaterial({
    color: 0x2a2a26, roughness: 0.25, metalness: 0,
    emissive: new THREE.Color(0xffcf87), emissiveIntensity: 0
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

// Blue, then warm, then orange. Straight from blue to orange passes through
// brown, and brown water reads as dirty rather than hot, so the midpoint is a
// warm cream that both ends can reach without going muddy.
const COLD = new THREE.Color(0x2b8fd8), MID = new THREE.Color(0xffd2a0), HOT = new THREE.Color(0xff6a33);
export function waterColor(u0, out = new THREE.Color()) {
  const u = Math.max(0, Math.min(1, u0));
  return u < 0.5 ? out.copy(COLD).lerp(MID, u * 2) : out.copy(MID).lerp(HOT, (u - 0.5) * 2);
}
export const heatOf = (K) => (K - 660) / 400;

// Loop colour. Hot water is not really red, but the one thing the picture has
// to say about the primary circuit is that it goes into the boiler hot and
// comes out cold, and 35 degrees of real difference is invisible. So the ramp
// is steep across the operating band: the cold leg sits in the blue, the hot
// leg in the warm, and anything hotter than normal runs on into orange.
export const loopHeat = (K) => (K - 579.6) / 53.85;
