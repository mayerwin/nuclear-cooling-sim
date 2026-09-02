// ---------------------------------------------------------------------------
// unit.js - one power station, as real geometry.
//
// Metres. The origin is the middle of the containment floor. The near quarter
// of the building is removed by clipping planes, the way a museum model is cut
// open, and the vessels are cut in half on their own axis so you look straight
// in at the water.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { pipe, vessel, tube, slab, railing, V, roundedPath } from './parts.js?v=29b6a124b2';
import { liquidMaterial, steamMaterial, rippleNormal, Riser, Drip, Bubbles,
  frameOf, setGradient, gradientise, twoOctaveFlow, LOWFX, SEA_TILE } from './fluid.js?v=29b6a124b2';
import { tempColor, waterColor, heatOf, loopHeat, paleSRGB } from './materials.js?v=29b6a124b2';
import { Leg, Circuit, Surface, FLUID, clamp, lerp, hash1 } from '../flow.js?v=29b6a124b2';
import { Machines } from '../machines.js?v=29b6a124b2';
import { SectionCap } from './section.js?v=29b6a124b2';

const R_IN = 15.4, WALL = 1.0, SHELL_H = 31, DOME_R = R_IN + WALL;

// Where everything stands.
//
// The whole station is laid out in ONE vertical plane, and the model is turned
// so that plane faces the camera. x runs left to right across the picture, y is
// up, and z is depth, which almost nothing uses. That is what lets the circuit
// be read without turning the camera: what you get is an elevation, and the
// runs between the machines are straight because the machines are at the same
// height as each other on purpose.
export const L = {
  rpv:  { x: 4.5, z: 0, r: 3.2, base: 2.6, h: 17.0 },
  sg:   { x: -8.5, z: 0 },
  rcp:  { x: -3.6, z: 0 },
  pool: { x: 4.5, z: 0, w: 13, d: 8, h: 5.2, y: 21.6 },
  turb: { x: 26, z: 0 },
  // Under the boiler, inside the building. Standing it out on the left cost
  // fifteen metres of picture width for a box of water.
  // Under the boiler, on the centreline, in front of its legs where the whole
  // circuit can be read at a glance. It was moved back behind them once to keep
  // the legs out of the water and that was the wrong trade: a tank you can see
  // with two posts in it beats a tank you cannot see.
  tank: { x: -8.5, z: 0, w: 9.4, d: 6.0, h: 4.4 },
  // On the REACTOR side of the tank. Standing it on the far side meant the
  // suction ran left out of the tank and the discharge then ran right again,
  // back underneath the tank it had just come from: a pump that appears to
  // deliver into the ground.
  eccs: { x: -2.3, z: 0 },
  stack:{ x: -19, z: 0, h: 30 }
};
// The reactor's outlet and the boiler's inlet are at the same height, so the
// hot leg is one straight run. Same for the pump's discharge and the reactor's
// inlet. Every elbow that is left is one the machinery actually needs.
const HOT_Y = 13.0, COLD_Y = 8.2, XOVER_Y = 12.4;
const SG_BASE = 11.3;
// The boiler's channel head is at the bottom, which is where both of the
// reactor's pipes meet it, and the tube sheet is the floor of the shell.
const SG_NOZ = SG_BASE + 1.7, SG_TS = SG_BASE + 3.0;
const W_LO = L.rpv.base + 1.0, W_HI = L.rpv.base + 12.2;
export const FUEL_Y0 = L.rpv.base + 2.3;
export const FUEL_TOP_FRAC = 0.71;
export const FUEL_Y1 = W_LO + (W_HI - W_LO) * FUEL_TOP_FRAC;
const waterY = (lvl) => W_LO + (W_HI - W_LO) * clamp(lvl, 0, 1);

const RPV_PROFILE = [
  [0, 0], [1.6, 0.18], [2.7, 1.0], [3.2, 2.6], [3.2, 13.5],
  [3.0, 14.9], [1.9, 16.3], [0, 17.0]
];
// Nineteen metres, which is about what a real one is, and short enough that
// the lines leaving its top stay under the dome.
const SG_PROFILE = [
  [0, 0], [1.4, 0.15], [2.4, 0.9], [2.7, 2.05], [2.7, 9.1],
  [3.1, 10.8], [4.0, 12.6], [4.0, 16.7], [3.4, 17.9], [1.8, 18.7], [0, 19.1]
];

// A body of water takes its colour from what the light loses on the way
// through it, not from a coat of paint on the outside. Its surface ripples
// drift, because still water in a lit room never looks perfectly still.
function ownWater(src, axis = 1) {
  const c = src.clone();
  const rim = (src.userData.g && src.userData.g.rim.value) || 1.1;
  // A clone does not carry the shader injection, so it is reinstalled. Bodies
  // of water take the gradient up their own height: cold at the bottom of a
  // reactor, hot at the top, which is the direction the fuel heats it.
  gradientise(c, axis, rim);
  c.normalMap = src.normalMap.clone();
  c.normalMap.needsUpdate = true;
  c.normalMap.repeat.set(7, 7);
  return c;
}
const WHITE = new THREE.Color(0xffffff);

// ONE colour for one temperature, asked for in one way, everywhere.
//
// A junction only looks seamless if both sides ask the same question and get
// the same answer. Before this there were three conventions in the file - a
// gradient lightened 25% towards white, an attenuation colour that was not
// lightened at all, and a base colour mixed 62% with white - so a pipe and the
// vessel it ran into were painted from three different recipes and the join
// showed as a step every time.
// One speed scale for everything that moves.
//
// The real velocities in this plant span two orders of magnitude: steam leaves
// the boiler at fifty metres a second and a bubble rises through it at two.
// Drawn literally, the pipe is a blur beside a vessel that looks frozen, and
// the two read as unrelated animations rather than one circuit. Compressed by
// a power law the ORDER survives - thin pipes still run faster than fat ones,
// stopped is still stopped - while the ratio between the fastest and slowest
// thing on screen comes down from twenty-five to about five.
function drawV(v) {
  return Math.sign(v) * 2.6 * Math.pow(Math.abs(v), 0.55);
}

// TEMPERATURE TO COLOUR, once, for everything wet in the model.
//
// Nothing is told what colour to be any more. Water carries a temperature
// (see Leg in flow.js), and this is the only place a temperature becomes a
// colour. The map is monotone in degrees and deliberately not linear: the sea
// side lives between 15 and 100, the primary loop between 285 and 340, and
// both bands are given room so a change inside either one is a change you can
// see. Steam is not on it; vapour has its own material.
// The sea band runs from 15 to about 110, and the map climbs steeply across it
// so that water which has crossed the condenser is visibly warm; the map is
// nearly flat from there to the primary's band, which climbs steeply again so
// that the cold leg and the hot leg, thirty-five degrees apart, are told
// apart. Monotone throughout: nothing cooler is ever drawn warmer.
const T_MAP = [[15, 0.02], [40, 0.12], [70, 0.30], [110, 0.60], [230, 0.64],
  [285, 0.66], [300, 0.70], [325, 0.82], [360, 0.92], [800, 1.0]];
export function uOfT(T) {
  if (T <= T_MAP[0][0]) return T_MAP[0][1];
  for (let i = 1; i < T_MAP.length; i++) {
    if (T <= T_MAP[i][0]) {
      const [t0, u0] = T_MAP[i - 1], [t1, u1] = T_MAP[i];
      return u0 + (u1 - u0) * (T - t0) / (t1 - t0);
    }
  }
  return 1;
}
export function colourOfT(T, out = new THREE.Color()) { return fluidColour(uOfT(T), out); }
// Temperatures the plant model does not carry itself, in degrees C. The sea
// and the tanks are what they are; the boiler is saturated water at 70 bar;
// the condensate is what a condenser at vacuum makes.
export const T_SEA = 15, T_TANK = 18, T_BOILER = 285, T_COND = 40;

export function fluidColour(u, out = new THREE.Color()) {
  // Almost the ramp itself. The old figures whitened the colour by a third
  // because a transmissive body was already carrying most of its own tint
  // through attenuation; a lit body carries none, so the same figures came out
  // as white pipes. A little white at the hot end still keeps orange off rust.
  const t = Math.max(0, Math.min(1, u));
  return paleSRGB(waterColor(t, out), 0.05 + t * 0.09);
}

// Paint a body of fluid. c1 is the colour at the far end if it changes along
// the way, which is what a reactor does to the water going up through it.
// The gradient is the ONLY tint: attenuation is left neutral so it darkens
// with depth without colouring, and the base is left white, because two tints
// multiplied together turn the hot end to mud.
const _fa = new THREE.Color(), _c2 = new THREE.Color();
function paintFluid(mat, c0, c1 = c0) {
  if (mat.userData.g) setGradient(mat, c0, c1);
  else mat.color.copy(c0);
  if (mat.attenuationColor) mat.attenuationColor.setHex(0xffffff);
  if (mat.userData.g) mat.color.setHex(0xffffff);
  // NEUTRAL, not the water's colour. The gradient injection multiplies the
  // whole fragment - transmitted light, diffuse and emissive alike - by that
  // same colour, so an emissive already tinted blue came out blue SQUARED: a
  // fifth of what it should be. Water in the shadow of a machine then had
  // nothing of its own to show and went to a dark panel, while the identical
  // recipe on a pipe against the sky came out three times brighter. Setting it
  // grey lets the one multiply do the tinting.
  mat.emissive.setScalar(0.03);
}

function tintWater(mat, colour, dt) {
  paintFluid(mat, colour);
  mat.normalMap.offset.x += dt * 0.035;
  mat.normalMap.offset.y += dt * 0.021;
}

// Water drawn as water rather than as glass. A refractive body works for a
// deep vessel seen through its own wall, but a shallow one seen edge-on inside
// a glass shell refracts whatever is behind it and vanishes: everything shows
// through and nothing says there is water there. This is the treatment the sea
// gets, and for the same reason.
function bodyOfWater(colour, rep, cut) {
  const n = rippleNormal().clone();
  n.needsUpdate = true;
  n.repeat.set(rep[0], rep[1]);
  return gradientise(new THREE.MeshPhysicalMaterial({
    // The same treatment as the water in the pipes, because it IS the water in
    // the pipes: a white base, with the colour carried by what the light loses
    // crossing it. Given a base colour of its own it read as a different
    // liquid the moment it left the tube, and the condensate and the feedwater
    // are the same water at the same temperature.
    //
    // Saturation here is attenuation distance, not colour. A pipe half a metre
    // across takes its blue over about a metre of water, so a wide pool given
    // three times that comes out visibly paler than the line feeding it, which
    // is the same sudden change of colour by another route.
    color: 0xffffff, roughness: 0.2, metalness: 0,
    transmission: 0, ior: 1.333, thickness: 1.5,
    envMapIntensity: 0.6,
    attenuationColor: new THREE.Color(colour), attenuationDistance: 4.0,
    opacity: 1, transparent: false,
    clearcoat: LOWFX ? 0 : 0.3, clearcoatRoughness: 0.2,
    normalMap: n, normalScale: new THREE.Vector2(0.3, 0.3),
    emissive: new THREE.Color(0x0a2f4a), emissiveIntensity: 0.12,
    // gradientised below, so it is painted by exactly the call that paints
    // the line running into it
    // DoubleSide, or the cut plane opens a hole you look straight through: a
    // clipped solid is not capped, so with front faces only the near half
    // vanishes and the far half is back-facing and culled. The body is there
    // and draws nothing. Every other water in the model is double-sided for
    // exactly this reason.
    side: THREE.DoubleSide,
    clippingPlanes: cut
  }), 1, 0.5, 0.9, 1.5);
}


// Fold several geometries that share a material into one. Written here rather
// than pulled from three's BufferGeometryUtils because the only case it has to
// handle is this one: same attributes, same layout, all indexed.
function mergeGeos(list) {
  const names = Object.keys(list[0].attributes);
  let verts = 0, idx = 0;
  for (const g of list) {
    verts += g.attributes.position.count;
    idx += g.index ? g.index.count : g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  for (const n of names) {
    const size = list[0].attributes[n].itemSize;
    const arr = new Float32Array(verts * size);
    let at = 0;
    for (const g of list) { arr.set(g.attributes[n].array, at); at += g.attributes[n].array.length; }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  const ix = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let at = 0, base = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    if (g.index) for (let i = 0; i < g.index.count; i++) ix[at++] = g.index.array[i] + base;
    else for (let i = 0; i < n; i++) ix[at++] = i + base;
    base += n;
  }
  out.setIndex(new THREE.BufferAttribute(ix, 1));
  out.computeBoundingSphere();
  return out;
}

// A run of liquid with no casing round it. A boiler tube and a cooling coil
// are thin-walled: what you want to see is the water in them changing colour
// from one end to the other, not a pipe drawn round it.
function fluidRod(pts, r, bend) {
  const path = roundedPath(pts, bend == null ? r * 3 : bend);
  const seg = Math.max(20, Math.round(path.getLength() * 3));
  const mat = liquidMaterial(r * 2);
  mat.normalMap.repeat.set(Math.max(3, path.getLength() / 1.4), 2);
  mat.attenuationDistance = r * 14;
  mat.clearcoat = 0.2;
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, seg, r, 10, false), mat);
  mesh.castShadow = true;
  return { mesh, mat, len: path.getLength() };
}

// A bare run of metal with proper elbows. Pipes carry fluid and get the whole
// fluid treatment; a busbar carries current and just needs to be a solid.
function pipeLike(pts, r, mat, bend) {
  const path = roundedPath(pts, bend == null ? r * 3 : bend);
  const seg = Math.max(16, Math.round(path.getLength() * 1.4));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, seg, r, 8, false), mat);
  mesh.castShadow = true;
  return mesh;
}

// The heading the whole model is cut on. It faces the camera the two framings
// use, so the section always opens towards the viewer.
export const CUT_AZ = 1.16;
const CUT_N = new THREE.Vector3(-Math.cos(CUT_AZ), 0, -Math.sin(CUT_AZ));
// Along the face of the cut, and into the half that is kept. Anything meant to
// be seen in section lies along the first and is nudged back along the second.
const CUT_T = new THREE.Vector3(-Math.sin(CUT_AZ), 0, Math.cos(CUT_AZ));
// Keeps the far half of whatever is centred on (x, z) and discards the near.
function cutPlane(x, z) {
  return new THREE.Plane(CUT_N.clone(), -(CUT_N.x * x + CUT_N.z * z));
}

// A pump is a pump. The coolant pump and the backup pump are the same machine
// at different sizes, so they are the same component: a see-through volute
// full of water, an impeller turning in it, a short motor above, and a lamp.
function buildPump(stage, m, x, y, z, sc) {
  const group = new THREE.Group();
  const vaneMat = new THREE.MeshStandardMaterial({ color: 0x9fb3c2, roughness: 0.35, metalness: 0.9 });
  // Dark, not orange: an orange vane inside the volute reads as hot water
  // being pumped, which is the one thing this pump never touches.
  const markMat = new THREE.MeshStandardMaterial({ color: 0x27313a, roughness: 0.5, metalness: 0.6 });
  const impeller = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    // Backward-curved: the tip trails the root in the direction of turning.
    const curve = new THREE.CatmullRomCurve3([
      V(Math.cos(a) * 0.45 * sc, 0, Math.sin(a) * 0.45 * sc),
      V(Math.cos(a - 0.5) * 1.05 * sc, 0, Math.sin(a - 0.5) * 1.05 * sc),
      V(Math.cos(a - 1.0) * 1.6 * sc, 0, Math.sin(a - 1.0) * 1.6 * sc)]);
    impeller.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.17 * sc, 8, false),
      i === 0 ? markMat : vaneMat));
  }
  impeller.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5 * sc, 0.5 * sc, 1.4 * sc, 18), vaneMat));
  impeller.position.set(x, y, z);
  group.add(impeller);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.28 * sc, 0.28 * sc, 2.4 * sc, 12),
    stage.mat.steel);
  shaft.position.set(x, y + 1.4 * sc, z);
  group.add(shaft);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(1.72 * sc, 1.72 * sc, 2.0 * sc, 40), liquidMaterial(1.7 * sc));
  water.material.normalMap.repeat.set(6, 2);
  water.material.attenuationDistance = 14 * sc;
  water.position.set(x, y, z);
  group.add(water);
  // Open-ended, and SHORTER than the water in it. Capped and standing proud,
  // its two rims crossed the water as a pair of grey bands top and bottom, and
  // a band across a pump is a border drawn through the one thing the pump is
  // there to show.
  const casing = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9 * sc, 1.9 * sc, 1.86 * sc, 40, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xa8b6c2, roughness: 0.45, metalness: 0.4, side: THREE.BackSide }));
  casing.position.set(x, y, z);
  group.add(casing);
  // The motor is as short as it can be and still read as a motor: an opaque
  // drum is dead weight in a picture that is trying to show water.
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.95 * sc, 0.95 * sc, 1.3 * sc, 24),
    stage.mat.painted);
  motor.position.set(x, y + 2.15 * sc, z);
  group.add(motor);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.26 * sc, 12, 8), m.lamp.clone());
  lamp.position.set(x, y + 2.95 * sc, z);
  group.add(lamp);
  return { group, impeller, water, lamp };
}


export class Unit {
  constructor(plant, stage, worldX, worldZ = 0) {
    this.plant = plant;
    this.stage = stage;
    this.passive = plant.mode === 'passive' || /passive/i.test(plant.mode);
    this.root = new THREE.Group();
    // The two stations stand along the camera's own screen-right axis, so
    // side by side they sit at the SAME depth: offsetting them along plain
    // world x put one thirty metres behind the other and it drew smaller.
    this.root.position.set(worldX, 0, worldZ);
    // Turned so the layout plane squares up to the camera: local +x runs
    // across the picture and local +z points into the half that is kept.
    this.root.rotation.y = Math.PI / 2 - CUT_AZ;
    this.worldX = worldX;
    this.worldZ = worldZ;

    // One plane, not two: half the building comes off, not a quarter. A wedge
    // leaves three walls standing and you end up peering into a slot. Taking
    // the whole near half off puts the machines in the open, and the far wall
    // stays behind them as something to read them against. Clipping is in
    // world space, so each unit gets its own plane.
    this.cut = [cutPlane(worldX, worldZ)];
    const m = stage.mat;
    const clip = (src) => {
      const c = src.clone();
      c.clippingPlanes = this.cut; c.clipIntersection = false; c.clipShadows = true;
      return c;
    };
    this.m = {
      // Only the building shell takes the wedge. The wedge is a hole in the
      // wall so you can see in; it is not a saw through everything standing
      // inside, and a pipe or a body of water that stops in mid air reads as
      // broken rather than as opened up.
      concrete: clip(m.concrete), inner: clip(m.concreteInner), liner: clip(m.liner),
      glass: m.glass, glassHot: m.glassHot, water: m.water,
      pipe: m.pipe, fuel: m.fuel,
      steel: m.steel, painted: m.painted, deck: m.deck, dark: m.dark,
      poolWater: ownWater(m.poolWater), copper: m.copper, rail: m.rail, lamp: m.lamp.clone(),
      bubble: m.bubble, mote: m.mote, drop: m.drop, flange: m.flange,
      // The streaks carried along in the pipes and the vapour in the vessels.
      // Left out of this table they came through as undefined, and an
      // undefined material is a plain white one: every tracer in the plant was
      // a matt white ball, which is exactly what a bubble looks like and
      // exactly what water flowing does not.
      fleck: m.fleck, puff: m.puff
    };
    // Every vessel stands on the layout plane, so the plane that halves the
    // building halves all of them too. One cut, one section, one picture.
    this.mHalfRpv = m.glass.clone();
    this.mHalfRpv.clippingPlanes = this.cut;
    this.mHalfSg = m.glass.clone();
    this.mHalfSg.clippingPlanes = this.cut;
    // The near half of each vessel is taken off, so what is left is the far
    // half, and the far half of a real vessel is steel. Drawing it as glass
    // as well leaves the water floating in front of the sky with nothing
    // behind it; solid steel gives it something to stand against.
    this.mShellRpv = m.shell.clone();
    this.mShellRpv.clippingPlanes = this.mHalfRpv.clippingPlanes;
    this.mShellSg = m.shell.clone();
    this.mShellSg.clippingPlanes = this.mHalfSg.clippingPlanes;

    this.buildBuilding();
    this.buildVessels();
    this.buildLoop();
    this.buildSteamSide();
    this.buildSafety();

    // Inside the core barrel only: the ring outside it is the downcomer,
    // where the flow is downward and rising bubbles would contradict it.
    // Each riser is cut on the same plane as the vessel it belongs to. Sharing
    // one unclipped material, the bubbles in the boiler carried on past its
    // wall and hung in the open air beside the building.
    const bub = (planes) => {
      const c = stage.mat.bubble.clone();
      c.clippingPlanes = planes;
      return c;
    };
    this.riseCore = new Riser(1.65, 150, bub(this.mHalfRpv.clippingPlanes));
    this.root.add(this.riseCore.mesh);
    this.riseSg = new Riser(2.3, 220, bub(this.mHalfSg.clippingPlanes));
    // and the steam those bubbles turn into the moment they break the surface
    // Sprites, not spheres. Bubbles in water keep their round bodies because a
    // bubble has a surface; vapour does not, and drawn as balls it was popcorn
    // sitting on the water rather than steam coming off it.
    this.sgVapour = new PuffCloud(70, { w: 3.6, d: 3.0, h: 5.2, size: 7, grow: 1.9 });
    this.root.add(this.sgVapour.points);
    this.root.add(this.riseSg.mesh);
    this.risePool = new Riser(3.4, 110, bub(this.cut));
    this.root.add(this.risePool.mesh);

    this.surfCore = new Surface(30, { c: 3.4, damp: 1.4 });
    this.surfSg = new Surface(22, { c: 3.0, damp: 1.6 });
    this.surfPool = new Surface(30, { c: 2.2, damp: 0.9 });
    this.mach = new Machines();
    // The plant is at 100% when the page opens, so its machines are already at
    // speed. Spinning them up from rest on the first frame shows a station
    // starting, which is not the story.
    this.mach.running(11.5, 5.8);
  }

  // ---- the building -------------------------------------------------------
  buildBuilding() {
    const g = this.root, m = this.m;
    const mat = new THREE.Mesh(new THREE.CylinderGeometry(21, 21, 3, 64), m.concrete);
    mat.position.y = -1.5; mat.receiveShadow = true;
    mat.material = this.stage.mat.deck;
    g.add(mat);

    const floor = new THREE.Mesh(new THREE.CircleGeometry(R_IN, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x5c666f, roughness: 0.95, metalness: 0.05 }));
    floor.position.y = 0.02; floor.receiveShadow = true;
    g.add(floor);
    this.floorMesh = floor;

    // The wall is built in bands so that one sector of the middle band can be
    // taken out when the containment fails. A colour change is not damage; a
    // hole is.
    // In the half that is kept, on the wall you are looking straight at
    // through the opening. With the near half taken off, a hole in the far
    // wall is seen from the inside, lit from behind, which is the clearest a
    // torn containment ever looks.
    const bA = 4.4, halfW = 0.75;
    const band = (r, y0, y1, mat, t0, tl) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, y1 - y0, 72, 1, true, t0, tl), mat);
      mesh.position.y = (y0 + y1) / 2;
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    const TAU = Math.PI * 2;
    // Everything that bounds the concrete goes into the section pass as well,
    // so the plane's cut through it can be capped. See section.js: this is
    // what makes a metre of wall read as a metre of wall rather than as two
    // skins with a gap between them.
    this.section = new SectionCap(this.cut[0]);
    const shell = [];
    for (const [r, mat] of [[R_IN + WALL, m.concrete], [R_IN, m.liner]]) {
      const inward = r === R_IN;
      shell.push([band(r, 0, 9, mat, 0, TAU), inward]);
      shell.push([band(r, 22, SHELL_H, mat, 0, TAU), inward]);
      shell.push([band(r, 9, 22, mat, bA + halfW, TAU - halfW * 2), inward]);
    }
    // The wall stands on the slab, and the shell has to be CLOSED for the
    // stencil count to mean anything: an annulus across the bottom joins the
    // outer skin to the inner one.
    const foot = new THREE.Mesh(
      new THREE.RingGeometry(R_IN, R_IN + WALL, 96, 1).rotateX(-Math.PI / 2), m.concrete);
    foot.position.y = 0.01;
    g.add(foot);
    shell.push([foot, true]);
    this.plug = new THREE.Group();
    for (const [r, mat] of [[R_IN + WALL, m.concrete], [R_IN, m.liner]]) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, 13, 24, 1, true, bA - halfW, halfW * 2), mat);
      mesh.position.y = 15.5;
      mesh.castShadow = true;
      this.plug.add(mesh);
      // its stencil twins live in the same group, so a torn wall loses its cap
      // along with its concrete
      for (const t of this.section.mirror(mesh, r === R_IN)) this.plug.add(t);
    }
    g.add(this.plug);
    for (const [mesh, inward] of shell) for (const t of this.section.mirror(mesh, inward)) g.add(t);
    this.breachAz = bA;
    this.tear = new THREE.Group();
    const tearMat = new THREE.MeshStandardMaterial({
      color: 0x2b1a14, roughness: 0.9, emissive: 0x120806, side: THREE.DoubleSide });
    // A ragged rim. Broken concrete is slabs and shards lying in the plane
    // of the wall, not a row of cones pointing at the hole: each piece is a
    // flat, randomly-sized block set into the wall's own surface round the
    // opening, tilted a little, dark where the reinforcement shows.
    for (let i = 0; i < 26; i++) {
      const edgeTop = i % 2 === 0;
      const a = bA - halfW + hash1(i * 11 + 3) * halfW * 2;
      const w = 0.5 + hash1(i * 17 + 5) * 1.1, h = 0.4 + hash1(i * 23 + 7) * 1.3;
      const shard = new THREE.Mesh(new THREE.BoxGeometry(w, h, WALL * 1.15), tearMat);
      const yy = edgeTop ? 22 + hash1(i * 29) * 1.2 : 9 - hash1(i * 31) * 1.2;
      shard.position.set(Math.sin(a) * (R_IN + WALL / 2), yy, Math.cos(a) * (R_IN + WALL / 2));
      shard.rotation.y = a;
      shard.rotation.z = (hash1(i * 37) - 0.5) * 0.9;
      shard.rotation.x = (hash1(i * 41) - 0.5) * 0.5;
      this.tear.add(shard);
    }
    // rubble at the foot of it
    for (let i = 0; i < 22; i++) {
      const a = bA + (hash1(i * 13) - 0.5) * 1.5;
      const rr = R_IN + WALL + 1 + hash1(i * 5) * 9;
      const sz = 0.4 + hash1(i * 3) * 1.3;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(sz, 0), this.stage.mat.deck);
      rock.position.set(Math.sin(a) * rr, sz * 0.4, Math.cos(a) * rr);
      rock.rotation.set(hash1(i) * 3, hash1(i + 1) * 3, hash1(i + 2) * 3);
      rock.castShadow = true;
      this.tear.add(rock);
    }
    g.add(this.tear);

    // Light inside the building. The dome shades everything under it, and a
    // cutaway you cannot see into is not a cutaway. Two soft sources, no
    // shadows: they are there to lift the machinery off the wall.
    // They hang high and clear of every vessel. A lamp standing inside the
    // reactor is not a lamp, it is a blown highlight, and a specular spike big
    // enough to overflow the buffer takes the bloom pass down with it.
    for (const [lx, ly, lz, inten] of [[11, 22, 9, 280], [-12, 20, -10, 220]]) {
      const lamp = new THREE.PointLight(0xdcecf8, inten, 0, 2);
      lamp.position.set(lx, ly, lz);
      g.add(lamp);
    }

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_R, 96, 40, 0, Math.PI * 2, 0, Math.PI / 2), m.concrete);
    dome.position.y = SHELL_H; dome.castShadow = true;
    g.add(dome);
    const domeIn = new THREE.Mesh(
      new THREE.SphereGeometry(R_IN, 96, 40, 0, Math.PI * 2, 0, Math.PI / 2), m.liner);
    domeIn.position.y = SHELL_H;
    g.add(domeIn);
    this.dome = dome; this.domeIn = domeIn;
    for (const t of this.section.mirror(dome)) g.add(t);
    for (const t of this.section.mirror(domeIn, true)) g.add(t);
    // and the face itself. The cut plane is z = 0 in the unit's own frame (the
    // whole station is turned so the plane faces the camera), so the quad
    // lies in the xy plane, big enough to cover the building and its dome.
    {
      const capMat = new THREE.MeshStandardMaterial({
        color: 0x8d9296, roughness: 0.95, metalness: 0.02 });
      g.add(this.section.cap(2 * DOME_R + 4, SHELL_H + DOME_R + 4,
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, (SHELL_H + DOME_R) / 2, 0), capMat));
    }

    //
    // There were twenty-eight buttresses standing up the outside of the wall
    // here, put in because a smooth white capsule reads as a toy. Twenty-eight
    // thin vertical bars wrapped round a cylinder do not read as buttresses.
    // They read as a network of pipes running round the building and joining
    // nothing, which is exactly what they were told to be and exactly what
    // this model is not allowed to contain.
    // Three rings round the building have gone with them: one at the
    // springline, one round the plinth and one round the rim of the cut. A
    // torus wrapped round a cylinder is a pipe running round a building and
    // joining nothing, whatever it was meant to be, and the plinth one ran
    // straight through the condenser as a curved grey sheet hanging in the
    // machine. The wall is a wall.

    // Nothing else goes inside. An operating deck, a handrail and a ring of
    // columns are what a real containment has and what a photograph of one
    // shows, but here they stand between the viewer and the only thing the
    // picture is for: the water, where it goes and what happens to it.
  }

  // ---- reactor, boiler, pump ---------------------------------------------
  buildVessels() {
    const g = this.root, m = this.m, r = L.rpv;

    // A concrete cradle the bottom head sits down into, not a narrow skirt
    // with a glass bulb ballooning over it.
    this.skirt = tube(3.0, 3.45, r.base + 0.9, this.stage.mat.deck, 40);
    this.skirt.position.set(r.x, (r.base + 0.9) / 2, r.z);
    g.add(this.skirt);

    // The barrel is steel; the head above it is glass. Drawn in steel, the
    // far half of the head is a concave grey cap lit from outside, and what
    // that looks like is a small solid dome standing in the middle of the
    // containment with no explanation. Glass makes it the top of the reactor.
    this.rpvShell = vessel(RPV_PROFILE.slice(0, 5), this.mShellRpv);
    this.rpvShell.position.set(r.x, r.base, r.z);
    g.add(this.rpvShell);
    const rpvHead = vessel(RPV_PROFILE.slice(4), this.mHalfRpv);
    rpvHead.position.set(r.x, r.base, r.z);
    rpvHead.castShadow = false;
    g.add(rpvHead);

    // the core barrel and the fuel standing in it
    const bar = tube(2.15, 2.15, 12.0, this.stage.mat.dark, 32);
    bar.position.set(r.x, r.base + 7.2, r.z);
    bar.material = new THREE.MeshStandardMaterial({
      color: 0x7b8896, roughness: 0.5, metalness: 0.6, side: THREE.FrontSide,
      clippingPlanes: this.mHalfRpv.clippingPlanes
    });
    g.add(bar);

    this.fuel = new THREE.Group();
    const fh = FUEL_Y1 - FUEL_Y0;
    const rodGeo = new THREE.CylinderGeometry(0.19, 0.19, fh, 8);
    this.fuelMat = m.fuel.clone();
    this.fuelMat.clippingPlanes = this.mHalfRpv.clippingPlanes;
    const inst = new THREE.InstancedMesh(rodGeo, this.fuelMat, 69);
    let n = 0;
    const d = new THREE.Object3D();
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) {
        const px = i * 0.54, pz = j * 0.54;
        if (Math.hypot(px, pz) > 2.25) continue;
        d.position.set(r.x + px, FUEL_Y0 + fh / 2, r.z + pz);
        d.updateMatrix();
        inst.setMatrixAt(n++, d.matrix);
      }
    }
    inst.count = n;
    inst.castShadow = true;
    this.fuel.add(inst);
    this.fuelInst = inst;
    g.add(this.fuel);

    // No particles travel downwards in the vessel. The downcomer is real, but
    // every attempt to draw it as moving specks read as bubbles sinking, and a
    // sinking bubble is wrong before the viewer can say why. The rising column
    // in the core carries the story alone.
    // the line the water level stands at, which is what the number means
    this.levelRing = new THREE.Mesh(
      new THREE.TorusGeometry(3.05, 0.08, 6, 40), this.stage.mat.rail);
    this.levelRing.rotation.x = Math.PI / 2;
    this.levelRing.material = new THREE.MeshStandardMaterial({
      color: 0xdfeaf2, emissive: 0x6f8ea6, emissiveIntensity: 0.5,
      roughness: 0.4, metalness: 0.3, clippingPlanes: this.mHalfRpv.clippingPlanes });
    g.add(this.levelRing);
    // and the mark on the vessel that says where the top of the fuel is
    // Inside the wall. At 3.26 against a vessel of 3.2 the ring poked through
    // the steel, and the cut left two little gold darts sticking out either
    // side of the reactor with nothing on screen to say what they were.
    const fuelMark = new THREE.Mesh(
      new THREE.TorusGeometry(3.02, 0.1, 6, 40),
      new THREE.MeshStandardMaterial({ color: 0xffb03a, emissive: 0x542f00,
        emissiveIntensity: 0.7, roughness: 0.5, metalness: 0.2,
        clippingPlanes: this.mHalfRpv.clippingPlanes }));
    fuelMark.rotation.x = Math.PI / 2;
    fuelMark.position.set(r.x, FUEL_Y1, r.z);
    g.add(fuelMark);

    // the water, and its free surface
    this.coreWater = tube(2.94, 2.94, 1, m.water, 48);
    // The water is cut on the same plane as the vessel, so you look straight in
    // at the fuel standing in it rather than through five metres of blue.
    this.coreWater.material = ownWater(m.water);
    this.coreWater.material.clippingPlanes = this.mHalfRpv.clippingPlanes;
    g.add(this.coreWater);
    // Its own material. Sharing the column's gave the disc the column's
    // gradient across its width, so the water's surface was blue down one side
    // and orange down the other with a grey seam between: it read as a plate
    // lying on the water. A free surface is at one temperature, the
    // temperature of the top of the water.
    this.coreTop = new THREE.Mesh(new THREE.CircleGeometry(2.94, 48, 0, Math.PI * 2)
      .rotateX(-Math.PI / 2), ownWater(m.water));
    this.coreTop.material.clippingPlanes = this.mHalfRpv.clippingPlanes;
    g.add(this.coreTop);

    // ---- boiler ----
    // A U-tube steam generator, cut down its own axis. The reactor's water
    // comes in at the bottom, goes up one side of every tube, over, and back
    // down the other side, and leaves colder. The water round the outside of
    // those tubes is a different circuit that never touches it: it boils, and
    // the steam goes to the turbine. Two circuits, one wall between them.
    const s = L.sg;
    // Two legs into the kept half of the picture, meeting the underside of
    // the head. Four free-standing pillars round a cutaway put two of them in
    // front of the thing being looked at.
    for (const dx0 of [-1.7, 1.7]) {
      const leg = tube(0.3, 0.34, SG_BASE + 0.8, this.stage.mat.painted, 10);
      leg.position.set(s.x + dx0, (SG_BASE + 0.8) / 2, s.z - 1.3);
      g.add(leg);
    }
    // The head and the dome are glass: the head is where the hot leg's one fat
    // pipe becomes many thin tubes, and the dome is where the boiling makes
    // the steam that leaves, and both of those are things to watch. Plain
    // transparency, not refraction: under a heavy scene the refractive pass
    // milks over and reads as solid metal, which is the opposite of the point.
    const clearGlass = new THREE.MeshStandardMaterial({
      color: 0xdfeaf4, roughness: 0.12, metalness: 0.1,
      transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      clippingPlanes: this.cut, depthWrite: false
    });
    const HEAD_P = SG_PROFILE.slice(0, 4);
    const BARREL_P = [[2.7, 2.05], [2.7, 9.1], [3.1, 10.8], [4.0, 12.6], [4.0, 16.7]];
    const DOME_P = [[4.0, 16.7], [3.4, 17.9], [1.8, 18.7], [0, 19.1]];
    for (const [prof, mat] of [[HEAD_P, clearGlass], [BARREL_P, this.mShellSg],
      [DOME_P, clearGlass]]) {
      const part = vessel(prof, mat);
      part.position.set(s.x, SG_BASE, s.z);
      g.add(part);
    }

    // The water in the head, in two real bodies either side of the divider:
    // the hot leg's water arrives in one, the tubes drink from it, and what
    // they give back fills the other, where the crossover draws it off. The
    // pipe, the chamber and the tubes are one continuous fluid.
    const headProf = [[0.2, 0.35], [1.25, 0.45], [2.2, 1.05], [2.5, 2.0], [2.5, 2.86]]
      .map(([r0, y0]) => new THREE.Vector2(r0, y0));
    this.headHot = new THREE.Mesh(
      new THREE.LatheGeometry(headProf, 24, 0, Math.PI), ownWater(m.water, 0));
    this.headHot.position.set(s.x, SG_BASE, s.z);
    this.headHot.material.clippingPlanes = this.cut;
    g.add(this.headHot);
    this.headCold = new THREE.Mesh(
      new THREE.LatheGeometry(headProf, 24, Math.PI, Math.PI), ownWater(m.water, 0));
    this.headCold.position.set(s.x, SG_BASE, s.z);
    this.headCold.material.clippingPlanes = this.cut;
    g.add(this.headCold);
    this.sgWater = tube(2.62, 2.62, 1, m.water, 40);
    this.sgWater.material = ownWater(m.water);
    this.sgWater.material.clippingPlanes = this.mHalfSg.clippingPlanes;
    g.add(this.sgWater);
    this.sgTop = new THREE.Mesh(new THREE.CircleGeometry(2.62, 40).rotateX(-Math.PI / 2),
      this.sgWater.material);
    g.add(this.sgTop);
    // The steam space above the water. This is what the boiler is FOR: the
    // water boils, the steam collects here, and the line at the top takes it
    // away. Without it the dome is an empty glass hat.
    this.sgSteam = new THREE.Mesh(
      new THREE.CylinderGeometry(2.55, 2.9, 1, 32, 1, true), steamMaterial());
    this.sgSteam.material.normalMap.repeat.set(3, 4);
    this.sgSteam.material.alphaMap.repeat.set(2, 3);
    this.sgSteam.material.clippingPlanes = this.cut;
    // NOT DRAWN. Steam in the boiler is drawn as vapour rising off the water,
    // which is a thing you can watch happening; this was a second, solid
    // account of the same steam - a ribbed grey drum filling the top half of
    // the vessel with the tube bundle hidden behind it. The object stays so
    // the frame code has something to talk to, and the story is left to the
    // vapour and to the neck it leaves through.
    this.sgSteam.visible = false;
    g.add(this.sgSteam);
    // The dome, full of the same steam and drawn to the shape of the dome, so
    // it necks down and runs straight into the outlet nozzle. Stopping the
    // steam a metre and a half short of the pipe was what made the boiler look
    // like it was making steam for nobody: there was a gap between the vapour
    // and the line that carries it away.
    const NECK_P = [[4.0, 16.7], [3.45, 17.7], [2.4, 18.35], [1.35, 18.9],
      [0.62, 19.25]].map(([r0, y0]) => new THREE.Vector2(r0, y0));
    this.sgNeck = new THREE.Mesh(
      new THREE.LatheGeometry(NECK_P, 32), this.sgSteam.material.clone());
    this.sgNeck.material.normalMap = this.sgSteam.material.normalMap.clone();
    this.sgNeck.material.alphaMap = this.sgSteam.material.alphaMap.clone();
    this.sgNeck.material.normalMap.needsUpdate = true;
    this.sgNeck.material.alphaMap.needsUpdate = true;
    this.sgNeck.material.normalMap.repeat.set(3, 3);
    this.sgNeck.material.alphaMap.repeat.set(2, 2);
    this.sgNeck.material.clippingPlanes = this.cut;
    this.sgNeck.position.set(s.x, SG_BASE, s.z);
    g.add(this.sgNeck);
    // The boiling interface itself: a shallow band of wet steam sitting on the
    // surface, where the water is actually turning into the thing the pipe at
    // the top carries. Without it the surface is a hard line between blue and
    // white and the change of state happens at a boundary rather than in a
    // place.
    // The downcomer: the feedwater arrives at the top, runs DOWN the gap
    // between the bundle and the shell, turns at the tube sheet and comes back
    // up through the bundle boiling. Drawn as a cold annulus with its own
    // downward flow, it is the whole recirculation in one shape.
    // A sheet of water running down the gap between the bundle and the shell,
    // and it has to be SEEN THROUGH: the bundle is behind it. Liquid is opaque
    // now, so this one asks for transparency by name rather than inheriting
    // it - left opaque it was a milky wall across the whole boiler and every
    // tube behind it disappeared.
    this.sgDown = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, 1, 36, 1, true), liquidMaterial(0.9));
    this.sgDown.material.transparent = true;
    this.sgDown.material.depthWrite = false;
    this.sgDown.material.normalMap.repeat.set(8, 3);
    this.sgDown.material.attenuationDistance = 3.5;
    this.sgDown.material.clippingPlanes = this.cut;
    g.add(this.sgDown);

    this.sgBoil = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 2.6, 1, 32, 1, true), steamMaterial());
    this.sgBoil.material.normalMap.repeat.set(4, 2);
    this.sgBoil.material.alphaMap.repeat.set(3, 1);
    this.sgBoil.material.clippingPlanes = this.cut;
    g.add(this.sgBoil);

    // the tube sheet the bundle stands on, and the plate that keeps the water
    // going in from the water coming out
    const cut = this.mHalfSg.clippingPlanes;
    const plate = new THREE.MeshStandardMaterial({
      color: 0x7f8b96, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide,
      clippingPlanes: cut
    });
    const sheet = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.62, 0.35, 40), plate);
    sheet.position.set(s.x, SG_TS, s.z);
    g.add(sheet);
    // Everything that lives in the plane of the cut is set a little way back
    // into the half that is kept, and is not clipped: geometry sitting exactly
    // on a clipping plane is a coin toss, and it lands on discarded.
    // into the half that is kept, which is local -z once the model is turned
    const BACK = 0.32, bx = 0, bz = -BACK;
    const plateIn = new THREE.MeshStandardMaterial({
      color: 0x7f8b96, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide });
    // the divider stands across the channel head, edge on to the cut
    // Narrow enough and high enough to stay inside the head it divides. At
    // 4.4 deep and starting a third of a metre off the floor, its corners came
    // out through the bottom of the head as a grey blade hanging under it.
    const div = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.2, 3.4), plateIn);
    div.position.set(s.x + bx, SG_TS - 1.0, s.z + bz);
    div.rotation.y = 0;
    g.add(div);

    // The bundle, in section: nested U-tubes in the plane of the cut. The side
    // the water goes up is drawn hot, the side it comes down is drawn cold, so
    // the heat leaving the reactor is a colour change you can point at.
    // d runs along the cut plane, so the U's lie flat in the face of the cut.
    // Each tube is one run of water, hot where it goes in and cold where it
    // comes out, mixing between the two along its own length: that gradient is
    // the heat crossing into the second circuit, drawn where it happens.
    const dx = 1, dz = 0;
    this.sgTubes = [];
    for (let k = 0; k < 5; k++) {
      const w = 0.6 + k * 0.45, top = SG_TS + 6.0 + w * 0.9;
      const at = (o, y) => V(s.x + bx + dx * o, y, s.z + bz + dz * o);
      const u = fluidRod([at(w, SG_TS - 0.8), at(w, top), at(-w, top), at(-w, SG_TS - 0.8)],
        0.17, w * 0.9);
      g.add(u.mesh);
      this.sgTubes.push(u);
    }
    // Nothing else goes in the dome. Three grey cylinders standing in the
    // steam space are real hardware and read as three unexplained objects.

    // ---- pump ----
    const p = L.rcp;
    // On legs, not a plinth: the suction comes up into the underside of the
    // casing, which is how a reactor coolant pump is actually fed, and a
    // plinth would hide the one pipe that explains the pump.
    // Two legs, both on the far side. A ring of four put two of them at
    // x = -2.4, which is inside the emergency pump's casing: a chrome rod went
    // in the top of the blue volute and came out of the bottom.
    for (const a of [Math.PI * 0.75, Math.PI * 1.25]) {
      const leg = tube(0.17, 0.17, COLD_Y - 1.1, this.stage.mat.steel, 8);
      leg.position.set(p.x + Math.cos(a) * 1.7, (COLD_Y - 1.1) / 2, p.z + Math.sin(a) * 1.7);
      g.add(leg);
    }
    const rcp = buildPump(this.stage, this.m, p.x, COLD_Y, p.z, 1);
    g.add(rcp.group);
    this.impeller = rcp.impeller;
    this.pumpWater = rcp.water;
    this.pumpLamp = rcp.lamp;
  }

  // ---- the primary loop, and everything the water runs through -----------
  buildLoop() {
    const g = this.root, r = L.rpv, s = L.sg, p = L.rcp;
    const m = this.m;
    // legs, with real bores; one drawn pipe stands for the four a real plant has
    this.legHot = new Leg('hot leg', 0.787, 4);
    this.legCold = new Leg('cold leg', 0.699, 4);
    this.legCore = new Leg('through the core', 0.86, 4);
    this.legDown = new Leg('downcomer', 0.9, 4);
    this.legTubes = new Leg('boiler tubes', 0.7, 4);
    this.primary = new Circuit('primary',
      [this.legDown, this.legCore, this.legHot, this.legTubes, this.legCold]);

    // Out of the top of the reactor, round and down into the boiler's channel
    // head, which is where a U-tube boiler is fed from.
    // Reactor out at HOT_Y, straight across, through a welded nozzle into the
    // HOT side of the boiler's channel head. Out of the COLD side of the head,
    // which is the other side of the divider plate, down, under the boiler and
    // up into the pump from below. Each run penetrates what it serves: the
    // hot leg's water ends inside the head's water, and the head's water ends
    // inside the pump's, so the circuit is continuous fluid end to end.
    // Ending at plus or minus 1.6 put the open end of the tube a hand's
    // breadth inside the chamber wall, where it showed through the water as a
    // flat pale rectangle. They run on to the divider plate instead, so what
    // you see is one body of water changing shape, not a pipe stopping.
    this.hot = pipe([V(r.x - 2.4, HOT_Y, r.z), V(s.x + 0.1, HOT_Y, s.z)],
      1.1, m, { bend: 1.0 });
    g.add(this.hot.group);

    this.cold = pipe([
      V(s.x - 0.1, XOVER_Y, s.z), V(s.x - 3.6, XOVER_Y, s.z),
      V(s.x - 3.6, 5.4, s.z), V(p.x, 5.4, p.z), V(p.x, COLD_Y - 0.6, p.z)
    ], 1.0, m, { bend: 1.5 });
    g.add(this.cold.group);

    this.coldB = pipe([
      V(p.x + 1.5, COLD_Y, p.z), V(r.x - 2.4, COLD_Y, r.z)
    ], 1.0, m, { bend: 1.0 });
    g.add(this.coldB.group);

    this.hot.kindBreak = this.cold.kindBreak = this.coldB.kindBreak = 'primary';
    this.hot.leg = this.legHot;
    // one physical leg, drawn in two runs: out of the boiler and into the
    // reactor, with the pump in the middle of it
    this.cold.leg = this.legCold;
    this.coldB.leg = this.legCold;
    this.pipes = [this.hot, this.cold, this.coldB];
  }

  // ---- steam to a turbine, a generator, and back as water ----------------
  buildSteamSide() {
    const g = this.root, s = L.sg, t = L.turb, m = this.m;
    this.legSteam = new Leg('main steam', 0.75, 4, { rho: FLUID.rhoSteam, kind: 'steam' });
    this.legFeed = new Leg('feedwater', 0.45, 4, { rho: FLUID.rhoFeed });
    this.secondary = new Circuit('secondary', [this.legSteam, this.legFeed]);

    // No pad. A twenty-six metre concrete slab under the turbine hall carried
    // nothing the eye needed and took a quarter of the picture's width.

    // One turbine on one shaft turning one generator. The casing is opened
    // along its own axis, the way the building is, so the wheels are seen
    // standing inside it rather than beside it.
    // Forty per cent shorter. The machine's job is to be recognisably a
    // turbine, and it was eight metres of casing to say it.
    // The machine stands high enough to leave a gap under it. At 8.4 the
    // casing sat straight down on the condenser hood and the two touched, so
    // there was nowhere for the exhaust to be and the turbine read as sealed.
    const AX = 10.4, X0 = t.x - 8.8, X1 = t.x - 4.0;
    this.turbLen = X1 - X0;
    const casMat = this.stage.mat.painted.clone();
    // DARK INSIDE. The inside of a turbine casing is a dark place, and lit at
    // the yard's own brightness against a bright sea the machine came out the
    // same value as its background: the wheel, the steam and the casing were
    // one pale smear. Dark, the wheel stands in it and the steam crossing the
    // blades is the brightest thing in the frame, which is the point.
    casMat.color.setHex(0x39434e);
    casMat.metalness = 0.2;
    casMat.roughness = 0.7;
    casMat.side = THREE.DoubleSide;
    // Only the near half comes off, on the same plane as the building. The far
    // half and the lid stay: an open-topped machine full of steam is a machine
    // the steam would be leaving, and the far wall is what keeps it in.
    casMat.clippingPlanes = this.cut;
    this.turbCut = casMat.clippingPlanes;
    // CLOSED at both ends. Open-ended with a steel hoop round each rim, the
    // machine was two floating rings with a wheel between them and no walls;
    // a turbine is a casing with an end wall at each end, and what the cutaway
    // does is take the near half of that casing off. Closed geometry, cut on
    // the same plane as the building, is exactly that.
    const cas = new THREE.Mesh(
      new THREE.CylinderGeometry(2.4, 3.6, X1 - X0, 44, 1, false), casMat);
    cas.rotation.z = Math.PI / 2;
    cas.position.set((X0 + X1) / 2, AX, t.z);
    cas.castShadow = true;
    g.add(cas);

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 9.4, 20)
      .rotateZ(Math.PI / 2), this.stage.mat.steel);
    shaft.position.set(t.x - 5.4, AX, t.z);
    g.add(shaft);
    // Slim pedestals, because with the slab gone the machines stood in the
    // air. One at each end of the hall and nothing in between: the pair that
    // used to stand under the middle of the casing came down THROUGH the
    // condenser and put two grey columns behind its glass, which is the last
    // place in the model that can afford anything the eye has to explain away.
    // The machine rests on the condenser between them, which is what a real
    // hall looks like anyway.
    for (const px of [X0 - 1.6, t.x - 1.0]) {
      const ped = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, AX - 1.4, 1.6), this.stage.mat.deck);
      ped.position.set(px, (AX - 1.4) / 2, t.z - 2.6);
      g.add(ped);
    }

    // One wheel. A real single-stage turbine is a disc carrying a ring of
    // curved buckets: the steam comes in along the axis, turns through them
    // and leaves. Three wheels of growing size was a cutaway of a machine
    // nobody asked about, and the first of them sat inside the inlet.
    this.rotor = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0x8b9dab, roughness: 0.32, metalness: 0.9 });
    const WR = 2.5, WX = (X0 + X1) / 2 - t.x;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 1.1, 24)
      .rotateZ(Math.PI / 2), bladeMat);
    hub.position.set(WX, 0, 0);
    this.rotor.add(hub);
    // The buckets: a curved sweep, not a flat plate, because the curve is what
    // turns the steam and therefore what makes it a turbine.
    // Thirty-two buckets, one mesh. They never move relative to each other -
    // the wheel turns, not the blades on it - so thirty-two draw calls and
    // thirty-two matrix updates a frame bought nothing over one merged
    // geometry, and two turbines were sixty-four of them.
    const NB = 32, bladeGeos = [];
    for (let i = 0; i < NB; i++) {
      const ang = (i / NB) * Math.PI * 2;
      const curve = new THREE.CatmullRomCurve3([
        V(-0.42, Math.cos(ang) * 0.9, Math.sin(ang) * 0.9),
        V(0.0, Math.cos(ang + 0.12) * (WR * 0.6), Math.sin(ang + 0.12) * (WR * 0.6)),
        V(0.42, Math.cos(ang + 0.34) * (WR - 0.1), Math.sin(ang + 0.34) * (WR - 0.1))]);
      bladeGeos.push(new THREE.TubeGeometry(curve, 12, 0.1, 4, false));
    }
    const blades = new THREE.Mesh(mergeGeos(bladeGeos), bladeMat);
    for (const bg of bladeGeos) bg.dispose();
    blades.position.set(WX, 0, 0);
    this.rotor.add(blades);
    // A translucent disc fills the wheel between hub and rim. Blades seen
    // edge-on are a millimetre wide and disappear, and without the disc a
    // wheel viewed from the side collapses to two teeth and a floating ring.
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.34, 44)
      .rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({
      color: 0x6c7d8b, roughness: 0.4, metalness: 0.85,
      transparent: true, opacity: 0.5 }));
    disc.position.set(WX, 0, 0);
    this.rotor.add(disc);
    const shroud = new THREE.Mesh(new THREE.TorusGeometry(WR, 0.1, 6, 44)
      .rotateY(Math.PI / 2), bladeMat);
    shroud.position.set(WX, 0, 0);
    this.rotor.add(shroud);
    this.rotor.position.set(t.x, AX, t.z);
    g.add(this.rotor);

    // The steam inside the casing. It arrives at the narrow end, does work on
    // the wheels and leaves colder, wetter and much larger, so the body of
    // vapour is a cone that widens along the machine.
    this.turbSteam = new THREE.Mesh(
      new THREE.CylinderGeometry(2.7, 1.7, X1 - X0 - 0.2, 32, 1, true).rotateZ(-Math.PI / 2),
      steamMaterial());
    this.turbSteam.material.normalMap.repeat.set(5, 3);
    this.turbSteam.material.alphaMap.repeat.set(3, 2);
    // cut on the same plane as the casing, so the vapour stays inside it
    this.turbSteam.material.clippingPlanes = casMat.clippingPlanes;
    this.turbSteam.position.set((X0 + X1) / 2, AX, t.z);
    this.turbSteam.renderOrder = 2;
    g.add(this.turbSteam);
    // and the droplets it carries, blown straight through onto the blades
    const wispMat = m.bubble.clone();
    wispMat.clippingPlanes = casMat.clippingPlanes;
    this.turbWisp = new Bubbles(
      frameOf(roundedPath([V(X0 + 0.4, AX, t.z), V(X1 - 0.4, AX, t.z)], 0.2), 40),
      0.34, 54, wispMat);
    g.add(this.turbWisp.mesh);

    // The generator: the smallest block that still reads as the machine that
    // turns shaft work into electricity, with the one copper band that says
    // which machine it is. It stands right at the end of the shaft and the
    // lamp stands right next to it, so the whole electrical story is three
    // metres wide instead of twenty.
    this.gen = slab(3.0, 2.6, 2.6, this.stage.mat.painted);
    this.gen.position.set(t.x - 1.0, AX, t.z);
    g.add(this.gen);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.45, 2.75, 2.75), this.stage.mat.copper);
    band.position.set(t.x - 1.0, AX, t.z);
    g.add(band);

    // ---- the condenser -------------------------------------------------
    // The one machine in the plant whose whole job is a change of state, so
    // it is drawn as a box you look into and watch it happen: spent steam
    // falls in at the top, crosses a bank of tubes with the sea running
    // through them, gives up its heat, and lands in the bottom as water. A
    // small pump takes that water back to the boiler. Nothing here is a
    // cylinder or a reservoir; it is a section through the process.
    const CX = (X0 + X1) / 2, CY = 3.1, CW = 6.6, CH = 5.0, CD = 3.6;
    const condGlass = new THREE.MeshStandardMaterial({
      color: 0xdfeaf4, roughness: 0.12, metalness: 0.1,
      transparent: true, opacity: 0.16, side: THREE.DoubleSide,
      clippingPlanes: this.cut, depthWrite: false });
    const shell = new THREE.Mesh(new THREE.BoxGeometry(CW, CH, CD), condGlass);
    shell.position.set(CX, CY, t.z);
    g.add(shell);
    // A thin steel floor, and nothing else. There was a slab over the top of
    // it as well, and between the two the machine was a grey box with the sea
    // lines disappearing behind it: the one part of this circuit that leaves
    // the site was hidden by the furniture around it. The lid is gone and the
    // floor is a third of what it was.
    const tray = new THREE.Mesh(new THREE.BoxGeometry(CW + 0.2, 0.12, CD + 0.2),
      this.stage.mat.steel);
    tray.position.set(CX, CY - CH / 2, t.z);
    g.add(tray);

    this.legCw = new Leg('sea water', 2.2, 2, { rho: FLUID.rhoCold, gain: 10 });
    this.cw = new Circuit('sea water', [this.legCw]);
    // The tube bank, and the water boxes that are the whole reason it is
    // legible. A metre-wide pipe cannot simply become a thin tube in mid air:
    // in a real condenser it arrives in a steel box welded to a tube sheet,
    // and the box is what divides the one big flow into the many small ones.
    // Two passes is enough to show it. Sea water comes in low, crosses to the
    // far box, turns round in it, and comes back high and warm. Four tubes
    // said nothing two do not.
    const TY_IN = CY + 0.35, TY_OUT = CY + 1.75;
    const BOXY = (TY_IN + TY_OUT) / 2, BOXH = 2.6, BOXD = CD - 1.0;
    const RBW = 1.6, RBX = CX + CW / 2 + RBW / 2;
    const LBW = 1.1, LBX = CX - CW / 2 + LBW / 2;
    const TX = RBX + RBW / 2;
    // Glass, with the sea water standing in them. As steel they were two grey
    // blocks with the sea lines running into one side and out of the other,
    // which is a box that swallows the circuit rather than the place where one
    // big pipe becomes many small ones.
    const boxGlass = this.m.glass.clone();
    boxGlass.opacity = 0.15;
    boxGlass.clippingPlanes = this.cut;
    const inlet = new THREE.Mesh(new THREE.BoxGeometry(RBW, BOXH, BOXD), boxGlass);
    inlet.position.set(RBX, BOXY, t.z - 0.5);
    g.add(inlet);
    this.boxWater = [];
    for (const [bw, bx] of [[RBW - 0.12, RBX], [LBW - 0.12, LBX]]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(bw, BOXH - 0.12, BOXD - 0.12),
        bodyOfWater(0x2b8fd8, [2, 2], this.cut));
      w.position.set(bx, BOXY, t.z - 0.5);
      g.add(w);
      this.boxWater.push(w);
    }
    // the plate down the middle of it, which is what makes it two boxes and
    // stops the water short-circuiting from the inlet nozzle to the outlet
    const divider = new THREE.Mesh(new THREE.BoxGeometry(RBW + 0.06, 0.14, BOXD + 0.06),
      this.stage.mat.flange);
    divider.position.set(RBX, BOXY, t.z - 0.5);
    g.add(divider);
    const turn = new THREE.Mesh(new THREE.BoxGeometry(LBW, BOXH, BOXD), boxGlass);
    turn.position.set(LBX, BOXY, t.z - 0.5);
    g.add(turn);
    this.condTubes = [];
    for (const yy of [TY_IN, TY_OUT]) {
      const u = fluidRod([V(LBX + LBW / 2, yy, t.z - 0.5),
        V(RBX - RBW / 2, yy, t.z - 0.5)], 0.3, 0.4);
      g.add(u.mesh);
      this.condTubes.push({ rod: u, y: yy, dir: yy < BOXY ? 1 : -1 });
    }
    // The drops each tube makes. A drop is not a bubble going the wrong way:
    // it clings to the underside of the cold tube, lets go, and stretches as
    // it falls into the water. That is the one thing in this machine you are
    // meant to see happen.
    this.condDrip = this.condTubes.map(c => {
      const d = new Drip(90, m.drop);
      g.add(d.mesh);
      return { d, y: c.y };
    });
    // The steam filling the space above the tubes. Wide and soft: run through
    // a fat pipe the vapour shader tears into a lumpy sack, which read as a
    // bag hanging off the machine rather than as steam in a space.
    // It fills the whole space the tubes stand in, from just above the pool to
    // the hood, so the tubes are IN the steam and the drops come off them into
    // the water. A thin band above the top tube made the steam a separate
    // object sitting on the machine.
    // Open-ended, not a box. A box has a lid and a floor, and the floor sat
    // right over the water: looking down into the machine you saw a white
    // rippled sheet where the pool should be and read it as the pool. Steam
    // has no shape, so it is given a body with no ends.
    // Steam has no walls, and no surface either. Given a body - a cylinder, a
    // box, anything with a skin - the half of it the section leaves behind
    // hangs in the machine as a pale curved sheet; given spheres it is
    // popcorn. It is drawn as what it is: soft sprites drifting down onto the
    // cold tubes and thinning as they go, with no silhouette anywhere.
    this.condFog = new PuffCloud(60,
      { w: CW - 1.0, d: CD - 1.2, h: 3.2, size: 5.5, grow: 1.4 });
    this.condFogAt = { x: CX, z: t.z, y0: CY - 0.6 };
    g.add(this.condFog.points);
    // and the water it becomes, lying in the bottom of the shell. A shallow
    // body with a lit, rippling free surface across it, well below the tubes,
    // so it reads as water collecting in the bottom of a machine and not as a
    // filled tank: what tells the two apart is that you can see the top of it.
    const POOL_Y = CY - CH / 2 + 0.05, POOL_H = 1.9;
    this.condPoolTop = POOL_Y + POOL_H;
    this.condWater = new THREE.Mesh(
      new THREE.BoxGeometry(CW - 0.3, POOL_H, CD - 0.4),
      bodyOfWater(0x2b8fd8, [5, 3], this.cut));
    this.condWater.position.set(CX, POOL_Y + POOL_H / 2, t.z);
    g.add(this.condWater);
    // Rotated in the GEOMETRY, not on the mesh, so its vertices live in the
    // x/z plane and the same wave solver that ripples the reactor's pools can
    // ripple this one. A flat lid is what makes a body of water read as a
    // block; a surface that moves is what makes it read as water.
    this.condTop = new THREE.Mesh(
      new THREE.PlaneGeometry(CW - 0.3, CD - 0.4, 24, 12).rotateX(-Math.PI / 2),
      bodyOfWater(0x2b8fd8, [4, 3], this.cut));
    this.condTop.material.side = THREE.DoubleSide;
    // A skin rather than a body: thin, so what tints the picture is the pool
    // underneath it and not the lid.
    this.condTop.material.thickness = 0.5;

    this.condTop.position.set(CX, this.condPoolTop + 0.02, t.z);
    g.add(this.condTop);
    this.surfCond = new Surface(24, { c: 2.0, damp: 1.1 });
    this.condHalf = (CW - 0.3) / 2;
    this.cond = shell;

    // The condensate pump, and the two pipes that make it a pump: one out of
    // the bottom of the pool into it, one out of it into the feed line.
    const PX = CX - CW / 2 - 2.2;
    const cp = buildPump(this.stage, this.m, PX, 1.6, t.z, 0.42);
    g.add(cp.group);
    this.condPump = cp;
    this.legCond = new Leg('condensate', 0.45, 1, { rho: FLUID.rhoFeed });
    const cSuct = pipe([
      V(CX - CW / 2 + 0.4, POOL_Y + 0.35, t.z), V(PX, POOL_Y + 0.35, t.z),
      V(PX, 1.6 - 0.5, t.z)
    ], 0.55, m, { bend: 0.7 });
    cSuct.leg = this.legCond;
    cSuct.kindBreak = 'feedline';
    g.add(cSuct.group);
    this.pipes.push(cSuct);

    // ---- where the sea comes in -----------------------------------------
    // An open forebay cut into the ground beside the machine, with a channel
    // running back from it to the water. The two lines go straight out and
    // straight down into it, all in the plane of the section: run back into
    // the distance instead, they turned into a pair of hooks with no readable
    // direction. A recess full of moving sea water is not a tank, and the
    // channel says where it came from.
    // The sea's own level in stage.buildSea, which is just below grade. The
    // forebay IS the sea, so it stands at the sea's height and not at one of
    // its own: a water surface a metre above the ground around it is a tub.
    // A fifth of a metre above the sea sheet, which is what lets the channel
    // cut visibly THROUGH the shore strip instead of disappearing under it:
    // the strip is land drawn over the water's first few metres, so anything
    // at or below sea level stops dead at the beach.
    const SEA_Y = -2.7, BX = TX + 3.4;
    // The basin walls stop AT the waterline. Standing them a metre and a half
    // proud of it put a kerb all the way round, and a kerb round water is what
    // makes a tub: an inlet of the sea has banks that go under, not a rim.
    const bayWall = slab(5.6, 1.8, 8.4, new THREE.MeshStandardMaterial({
      color: 0x51606c, roughness: 0.94, side: THREE.BackSide }));
    bayWall.position.set(BX, SEA_Y - 0.9, t.z - 1.5);
    g.add(bayWall);
    // The forebay and the channel are THE SEA, reaching in, so they are drawn
    // the way the sea is drawn: one opaque, rippling water, not a refractive
    // body that turns to haze at this distance and reads as a tank of
    // something else. What comes in the channel and what is in the bay have to
    // be visibly the same water or the pipes go nowhere.
    // THE SAME WATER AS THE SEA, drawn at the same scale. SEA_TILE is the
    // size of one ripple tile in metres, and every piece of sea in the model
    // sets its repeat from its own size divided by it, so the forebay, the
    // channel and the open water carry one continuous surface instead of three
    // patches of different-looking material meeting at a line.
    const seaOf = (w, d) => {
      const mm = twoOctaveFlow(new THREE.MeshStandardMaterial({
        color: 0x1d5f86, roughness: 0.24, metalness: 0.1,
        normalMap: m.poolWater.normalMap.clone(),
        normalScale: new THREE.Vector2(0.42, 0.42)
      }));
      mm.normalMap.needsUpdate = true;
      mm.normalMap.repeat.set(w / SEA_TILE, d / SEA_TILE);
      return mm;
    };
    const seaMat = seaOf(5.4, 8.4);
    this.seaMat = seaMat;
    this.bayWater = slab(5.4, 1.7, 8.4, seaMat);
    this.bayWater.position.set(BX, SEA_Y - 0.85, t.z - 1.5);
    g.add(this.bayWater);
    // The channel out to the open water. It runs far enough back to overlap
    // the sea sheet itself, so what is under the pipes and what is on the
    // horizon are one unbroken piece of water and not a pond that happens to
    // be near the coast.
    this.chanWater = slab(4.6, 1.7, 36, seaOf(4.6, 36));
    this.chanWater.position.set(BX, SEA_Y - 0.85, t.z - 23);
    g.add(this.chanWater);

    // Both lines land square on the face of the inlet box, one below the
    // divider and one above it, which is where a metre of sea water turns
    // into a tube bank and back again.
    const cwIn = pipe([
      V(TX, TY_IN, t.z - 0.5), V(BX - 1.6, TY_IN, t.z - 0.5),
      V(BX - 1.6, SEA_Y - 0.2, t.z - 0.5)
    ], 0.9, m, { bend: 1.0 });
    const cwOut = pipe([
      V(BX + 1.6, SEA_Y - 0.2, t.z - 0.5), V(BX + 1.6, TY_OUT, t.z - 0.5),
      V(TX, TY_OUT, t.z - 0.5)
    ], 0.9, m, { bend: 1.0 });
    cwIn.kindBreak = cwOut.kindBreak = 'cw';
    // The sea leg is drawn in two pieces: the intake, which is the leg's inlet
    // end, and the outfall, which is its outlet end. Each piece carries which
    // end of the leg it is. Both are also built from the machine towards the
    // sea while the water in the intake comes the other way, so the intake
    // says its geometry runs against its flow.
    cwIn.leg = cwOut.leg = this.legCw;
    cwIn.tempAt = 'in'; cwIn.flowDir = -1;
    cwOut.tempAt = 'out';
    g.add(cwIn.group); g.add(cwOut.group);
    this.pipes.push(cwIn, cwOut);

    // The lamp stands straight up out of the generator, so the whole
    // electrical story is one column instead of a row across the yard.
    const GX = t.x - 1.0, LY = AX + 4.4;
    const poleMat = this.stage.mat.rail;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 3.4, 8), poleMat);
    pole.position.set(GX, AX + 1.3 + 1.7, t.z);
    g.add(pole);
    this.lampGlass = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 18, 12), this.stage.mat.bulb.clone());
    this.lampGlass.position.set(GX, LY, t.z);
    g.add(this.lampGlass);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.85, 0.55, 18, 1, true), this.stage.mat.painted);
    shade.position.set(GX, LY + 0.55, t.z);
    g.add(shade);
    this.lampLight = new THREE.PointLight(0xffd9a0, 0, 22, 2);
    this.lampLight.position.set(GX, LY - 0.4, t.z);
    g.add(this.lampLight);

    this.busMat = new THREE.MeshStandardMaterial({
      color: 0x6a5a4c, roughness: 0.45, metalness: 0.9,
      emissive: new THREE.Color(0x140a02), emissiveIntensity: 0
    });
    this.bus = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const dz = i ? 0.34 : -0.34;
      this.bus.add(pipeLike([
        V(GX + dz, AX + 1.3, t.z), V(GX + dz, LY - 0.5, t.z)], 0.1, this.busMat, 0.3));
    }
    g.add(this.bus);

    // Boiler, over the containment, down beside the turbine hall and in
    // through the end of the casing. It has to arrive somewhere or the steam
    // is going nowhere.
    // Out of the top of the boiler, up under the dome, out through the wall
    // and down into the top of the turbine's inlet end.
    // Out of the top of the boiler, across under the dome, down outside the
    // machine and IN THROUGH ITS LEFT END, on the axis. Steam arriving down a
    // spout on the lid had to be given a box to arrive in, and the box hid the
    // thing it was feeding.
    // Up out of the boiler, across under the dome, and down ON THE TURBINE
    // SIDE of the building, so the second circuit leaves the containment at
    // one place instead of describing a rectangle round it. The feedwater
    // comes back up the same corner, a metre and a half away: a pair, in one
    // corner, not a network wrapped round the shell.
    this.steam = pipe([
      V(s.x, SG_BASE + 18.6, s.z), V(s.x, 31.4, s.z),
      // ALONG THE AXIS, in at the end of the casing. Steam that arrives on
      // the lid does not explain a wheel being pushed round; steam that comes
      // in at one end, crosses the blades and leaves underneath does. (It was
      // routed over the top once to hide an artefact - the vapour core's open
      // end flaring into white spikes - and that is fixed at the source now:
      // steam runs are capped at both ends in parts.js.)
      V(X0 - 2.6, 31.4, t.z), V(X0 - 2.6, AX, t.z), V(X0 + 0.6, AX, t.z)
    ], 1.2, m, { bend: 3.0, steam: true });
    this.steam.kindBreak = 'steamline';
    this.steam.leg = this.legSteam;
    g.add(this.steam.group);

    // What comes out of the turbine has to go somewhere: down the neck into
    // the condenser, where it turns back into water.
    // Downstream of the wheel, because that is where spent steam is: dropping
    // it from directly under the buckets put the exhaust plume on top of the
    // thing it had just come through.
    // A short steel duct with a column of steam inside it. Run through the
    // pipe builder at this diameter the vapour shader tore into a lumpy sack
    // that read as a bag slung under the machine.
    // The exhaust throat: out of the belly of the casing, widening, down into
    // the top of the condenser. It is the answer to how the steam gets from
    // the turbine to the water underneath it, so it is drawn at a size that
    // answers the question, cut open like everything else, with the vapour
    // visibly falling down the inside of it.
    // Ending at 5.6 put the throat's rim in the middle of the condenser hood,
    // so its far wall hung down inside the box as a loose curved grey sheet.
    // It lands ON the hood instead.
    const EX = X1 - 1.6, EY0 = AX - 2.3, EY1 = 5.82;
    const duct = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.75, EY0 - EY1, 26, 1, true),
      this.m.glass.clone());
    // Glass, like the vessels. In steel it was a solid grey funnel and the
    // question it exists to answer - where does the steam go when it leaves
    // the wheel - was answered by an opaque object. Now you watch it fall
    // down the throat and into the machine that condenses it.
    duct.material.side = THREE.DoubleSide;
    duct.material.opacity = 0.16;
    duct.material.clippingPlanes = this.cut;
    duct.position.set(EX, (EY0 + EY1) / 2, t.z);
    g.add(duct);
    this.exhSteam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.0, 1.6, EY0 - EY1 + 0.5, 26, 1, true), steamMaterial());
    this.exhSteam.material.normalMap.repeat.set(6, 2);
    this.exhSteam.material.alphaMap.repeat.set(5, 2);
    this.exhSteam.material.clippingPlanes = this.cut;
    this.exhSteam.position.set(EX, (EY0 + EY1) / 2, t.z);
    g.add(this.exhSteam);
    // and puffs of it visibly falling down the bore. A scrolling texture says
    // something is moving; separate bodies of vapour travelling down the throat
    // say WHAT is moving and which way, which is the question being answered
    // here: this is how the steam gets from the turbine to the water below it.
    // It starts ABOVE the wheel, inside the casing, and ends in the condenser.
    // Beginning it below the buckets left the machine with steam arriving on
    // its lid, nothing crossing the blades, and steam leaving underneath: three
    // separate events instead of one thing happening.
    // Fewer and fainter than when this column was only the throat. Stretched
    // to the whole height of the machine at the old density it fogged the
    // casing out, and a turbine you cannot see is not helped by knowing where
    // its steam went.
    this.exhFall = new PuffCloud(80,
      { w: 1.9, d: 1.6, h: AX + 2.0 - EY1, size: 5.4, grow: 1.6 });
    this.exhFallAt = { x: EX, z: t.z, y0: EY1 + 0.1 };
    g.add(this.exhFall.points);
    // a flange where it lands on the condenser, so it arrives somewhere

    // Back the other way at its own height, so the two halves of the second
    // circuit run as one straight pair across the top of the picture: white
    // going right to the turbine, blue coming back to the boiler.
    // Out of the bottom of the condenser, up outside the turbine hall, back
    // across the picture above the steam line, and into the boiler's side.
    // The two runs of the second circuit read as a pair going opposite ways,
    // and they never touch: steam rides at 33, feedwater at 36.5.
    // Back to the boiler alongside the steam line, two metres above it the
    // whole way. Run on its own path it drew a second rectangle round the
    // building and the two of them read as scaffolding; run as a pair they
    // read as what they are, the same circuit going out and coming back.
    this.feed = pipe([
      V(CX - CW / 2 - 3.0, 1.6, t.z), V(X0 - 4.2, 1.6, t.z), V(X0 - 4.2, 33.0, t.z),
      V(s.x - 4.4, 33.0, s.z), V(s.x - 4.4, SG_BASE + 13.4, s.z),
      V(s.x - 2.35, SG_BASE + 13.4, s.z), V(s.x - 2.35, SG_BASE + 12.6, s.z)
    ], 0.7, m, { bend: 2.4 });
    this.feed.kindBreak = 'feedline';
    this.feed.leg = this.legFeed;
    g.add(this.feed.group);
    // and the water arriving inside the shell, falling to the surface, so the
    // line coming in at the top left visibly DOES something
    // The feed ring the water arrives through, and the sheet of water falling
    // off it into the boiler. This is the answer to how the cold water gets
    // back in, so it is drawn at a size you cannot miss: a pipe that arrives
    // at a shell and stops reads as a pipe with a cap on it.
    const FY = SG_BASE + 13.4;
    // The ring carries the feedwater, so the ring IS feedwater: the same
    // liquid, the same colour, the same tube radius as the line arriving. As
    // grey steel the blue simply stopped where the pipe met it and something
    // else continued, which is the join the eye goes straight to.
    // A slim ring at the head of the downcomer, and the downcomer takes it
    // from there. It used to be a fat torus with two columns hanging off it,
    // and cut in half that is a blue plank lying across the boiler with two
    // blue posts under it. One ring, feeding one sheet of water that runs all
    // the way down to the pool, is the same story with nothing extra in it.
    // NO RING. Cut in half a ring is an arc, and an arc of pipe joined to
    // nothing is what it read as however slim it was drawn. The feed line
    // runs through the shell and ends INSIDE the downcomer, at the top of the
    // sheet, so the water is seen to arrive on the one surface it runs down.
    this.feedRing = null;
    this.pipes.push(this.steam, this.feed);

    // the stack the containment can be vented through
    // The stack is the vent line itself, standing up on a frame. A fat grey
    // column beside the building teaches nothing and takes the skyline; a pipe
    // going up says what it is, which is the one way out of the containment.
    // No stack. A drum on the ground with a funnel hanging in the sky twenty
    // metres above it was two objects and no connection, and a column between
    // them was one object nobody wanted. The vent is a hole in the wall with a
    // line out of it that turns up and clears the roof, and that is all a vent
    // needs to be.
    const st = L.stack;
    const VY = 26;
    // THE HOLE. The line takes the building's air, so where it meets the wall
    // there is an opening: a dark disc on the inside face, the pipe's own
    // bore, with the pipe running away from it through the concrete. Without
    // it the pipe was joined to a blank wall.
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.48, 24),
      new THREE.MeshStandardMaterial({ color: 0x0c1116, roughness: 1 }));
    hole.rotation.y = Math.PI / 2;
    hole.position.set(-R_IN + 0.03, VY, 0);
    g.add(hole);
    this.vent = pipe([
      V(-R_IN, VY, 0), V(-R_IN - 3.2, VY, 0), V(-R_IN - 3.2, st.h, 0)
    ], 0.8, m, { bend: 1.6, steam: true });
    // and the cover on top, which is what says "this is where it comes out"
    const mouth = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.55, 1.6, 20, 1, true),
      this.stage.mat.painted);
    mouth.material = this.stage.mat.painted.clone();
    mouth.material.side = THREE.DoubleSide;
    mouth.position.set(-R_IN - 3.2, st.h + 0.5, 0);
    g.add(mouth);
    this.legVent = new Leg('vent', 0.8, 1, { rho: FLUID.rhoSteam, kind: 'steam' });
    this.vent.kindBreak = 'vent';
    this.vent.leg = this.legVent;
    this.ventCircuit = new Circuit('vent', [this.legVent]);
    g.add(this.vent.group);
    this.pipes.push(this.vent);
  }

  // Add a pipe while the app is running. Geometry, tracers, break behaviour
  // and colour all come from the same two things every other pipe has: a
  // centreline and a leg carrying a velocity. Nothing else has to be told.
  //   __units[0].addPipe([[0,20,0],[14,20,0]], 0.8, 'primary')
  addPipe(points, dia, kindBreak, legName) {
    const pts = points.map((q) => (q.isVector3 ? q : V(q[0], q[1], q[2])));
    const q = pipe(pts, dia, this.m, { bend: dia * 2 });
    q.leg = (legName && this.pipes.find((x) => x.leg && x.leg.name === legName)?.leg)
      || (this.pipes.find((x) => x.kindBreak === kindBreak) || {}).leg
      || this.legCold;
    q.kindBreak = kindBreak || null;
    this.root.add(q.group);
    this.pipes.push(q);
    return q;
  }

  // Any pipe can be broken, and breaking it is not paint: the kind of pipe
  // maps to the physical consequence in the plant model, and the model's next
  // step decides everything downstream. The wound itself is a torn collar and
  // a jet of whatever the pipe was carrying, which dies away as the thing
  // feeding it runs out.
  rupture(q, worldPoint) {
    if (!q.kindBreak || q.broken) return false;
    const changed = this.plant.breakPipe(q.kindBreak);
    if (!changed) { q.broken = true; return false; }
    q.broken = true;
    const local = this.root.worldToLocal(worldPoint.clone());
    const g = this.root;
    const steam = q.leg && q.leg.kind === 'steam';
    // A HOLE IN THE WALL, not a ring round the run. A torus whose axis is the
    // pipe's own axis encircles the pipe, and a ring round a pipe is a collar
    // fitted to it however it is coloured. This one's axis is the direction
    // the contents leave in - down for water, up for steam - so it sits in the
    // pipe's surface as the torn lip of an opening, and it is the pipe's own
    // steel rather than the near-black it used to be.
    const out = new THREE.Vector3(0, steam ? 1 : -1, 0);
    const torn = new THREE.Mesh(
      new THREE.TorusGeometry(q.dia * 0.44, q.dia * 0.1, 6, 18),
      new THREE.MeshStandardMaterial({ color: 0x93a0ac, roughness: 0.92,
        metalness: 0.55, flatShading: true }));
    torn.position.copy(local).addScaledVector(out, q.dia * 0.4);
    torn.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), out);
    g.add(torn);
    let jet = null;
    if (!steam) {
      // water falls: a column from the wound to the floor
      const h = Math.max(1.2, local.y - 0.1);
      // Narrow where it leaves the pipe and spreading a little as it falls. It
      // used to open out to three times the pipe's diameter, which is not a
      // stream getting away from a break, it is a traffic cone.
      jet = new THREE.Mesh(
        new THREE.CylinderGeometry(q.dia * 0.3, q.dia * 0.66, h, 16),
        liquidMaterial(q.dia * 1.4));
      jet.material.normalMap.repeat.set(2, Math.max(4, Math.round(h * 1.6)));
      jet.position.set(local.x, local.y - h / 2, local.z);
      g.add(jet);
    }
    if (!this.plumes) this.addPlumes();
    const spray = new Plume(120, steam ? 0xeef6ff : 0xbfe0f4, steam ? 22 : 13);
    g.add(spray.points);
    this.breakFx = this.breakFx || [];
    this.breakFx.push({ q, torn, jet, spray, at: local, t0: this.plant.t, steam });
    return true;
  }

  // ---- what the two designs do differently -------------------------------
  buildSafety() {
    const g = this.root, m = this.m, r = L.rpv;
    if (this.passive) {
      const p = L.pool;
      // The tank sits high on purpose: that height is what makes gravity work.
      // It is drawn open, because a closed box with a blue lid on it is the
      // one thing in this building nobody would guess is a pool of water.
      const wallT = 0.6;
      const cav = slab(p.w, p.h, p.d,
        new THREE.MeshStandardMaterial({ color: 0x53616d, roughness: 0.9, side: THREE.BackSide }));
      cav.position.set(p.x, p.y + p.h / 2, p.z);
      g.add(cav);
      // the floor, and a lip round the top so the open box reads as a tank
      const floorSlab = slab(p.w, 0.5, p.d, this.stage.mat.painted);
      floorSlab.position.set(p.x, p.y + 0.25, p.z);
      g.add(floorSlab);
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const lip = slab(ax ? 0.5 : p.w + 1, 0.5, az ? 0.5 : p.d + 1, this.stage.mat.painted);
        lip.position.set(p.x + ax * (p.w / 2 + 0.25), p.y + p.h, p.z + az * (p.d / 2 + 0.25));
        g.add(lip);
      }
      this.poolWater = slab(p.w - wallT * 2.4, 1, p.d - wallT * 2.4, m.poolWater);
      g.add(this.poolWater);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const col = tube(0.4, 0.4, p.y, this.stage.mat.painted, 12);
        col.position.set(p.x + dx * (p.w / 2 - 1), p.y / 2, p.z + dz * (p.d / 2 - 1));
        g.add(col);
      }
      // the residual heat loop: out of the reactor, up into the pool, back in
      this.legPrhrUp = new Leg('to the pool', 0.2, 2);
      this.legCoil = new Leg('coil', 0.2, 2);
      this.legCoilOut = new Leg('coil out', 0.2, 2, { rho: FLUID.rhoCold });
      this.legPrhrDn = new Leg('back from the pool', 0.2, 2, { rho: FLUID.rhoCold });
      this.prhr = new Circuit('prhr',
        [this.legPrhrUp, this.legCoil, this.legCoilOut, this.legPrhrDn]);
      // Straight up off the hot leg into the pool. Hot water rises; drawing
      // the line that carries it as anything but a vertical run hides that.
      const RUP = p.x - p.w / 2 + 2.0;
      const up = pipe([
        V(r.x - 3.1, HOT_Y, r.z), V(RUP, HOT_Y, r.z), V(RUP, p.y + 1.6, r.z)
      ], 0.45, m, { bend: 1.6 });
      up.kindBreak = 'prhr';
      up.leg = this.legPrhrUp; g.add(up.group);
      // The coil sits low enough to stay under the water while there is any
      // water, because a coil in the air is not taking heat out of anything.
      const COIL_Y = p.y + 1.6;
      const coilPts = [];
      let cx = RUP, side = 1;
      while (cx < p.x + p.w / 2 - 2.0) {
        coilPts.push(V(cx, COIL_Y, p.z + side * (p.d / 2 - 2.0)));
        coilPts.push(V(cx, COIL_Y, p.z - side * (p.d / 2 - 2.0)));
        cx += 1.5; side *= -1;
      }
      // One run of water that goes in hot and comes out cold, with the change
      // happening along it: the same picture as the boiler tubes, because it
      // is the same job being done by a different means.
      this.poolCoil = fluidRod(coilPts, 0.22, 0.7);
      g.add(this.poolCoil.mesh);
      // and straight back down the other side into the reactor, because that
      // is what cooled water does.
      const RDN = p.x + p.w / 2 - 2.0;
      const dn = pipe([
        coilPts[coilPts.length - 1].clone(), V(RDN, COIL_Y, r.z),
        V(RDN, COLD_Y + 1.4, r.z), V(r.x + 3.1, COLD_Y + 1.4, r.z)
      ], 0.45, m, { bend: 1.6 });
      dn.kindBreak = 'prhr';
      dn.leg = this.legPrhrDn; g.add(dn.group);
      this.pipes.push(up, dn);

      // When the tank cracks the water does not vanish: it falls on the floor
      // of the building, and the model goes on drawing from it down there. So
      // both the falling stream and the water it makes are drawn.
      this.sumpWater = new THREE.Mesh(
        new THREE.CylinderGeometry(R_IN - 0.4, R_IN - 0.4, 1, 56), ownWater(m.poolWater));
      this.sumpWater.material.clippingPlanes = this.cut;
      this.sumpWater.material.clipIntersection = true;
      this.sumpWater.visible = false;
      g.add(this.sumpWater);
      this.leakJet = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.45, p.y - 0.2, 12), liquidMaterial(0.6));
      this.leakJet.position.set(p.x + p.w / 2 - 1.0, (p.y - 0.2) / 2, p.z);
      this.leakJet.material.normalMap.repeat.set(2, 6);
      this.leakJet.visible = false;
      g.add(this.leakJet);

      // And the line that simply lets it fall in. It is fed from two places:
      // the pool while there is a pool, and the floor of the building once the
      // pool has emptied onto it, which is what keeps the core covered after
      // the tank has cracked.
      this.legGrav = new Leg('gravity', 0.3, 2, { rho: FLUID.rhoCold });
      this.legRecirc = new Leg('gravity', 0.3, 2, { rho: FLUID.rhoCold });
      this.legFill = new Leg('gravity', 0.3, 2, { rho: FLUID.rhoCold });
      this.gravity = new Circuit('gravity', [this.legGrav]);
      this.recircC = new Circuit('recirculation', [this.legRecirc]);
      this.fillC = new Circuit('into the reactor', [this.legFill]);
      // One vertical line from the pool to the reactor head, with a valve in
      // it and a second line up from the floor of the building joining below
      // the valve. Straight down is what gravity does, so straight down is
      // what it is drawn as.
      const GX = r.x - 1.6;
      const TEE = V(GX, 18.6, r.z);
      const grav = pipe([V(GX, p.y + 0.4, r.z), TEE.clone()], 0.5, m, { bend: 1.4 });
      grav.kindBreak = 'gravity';
      grav.leg = this.legGrav; g.add(grav.group);
      const recirc = pipe([
        V(GX - 3.2, 0.8, r.z), V(GX - 3.2, 18.6, r.z), TEE.clone()
      ], 0.5, m, { bend: 1.4 });
      recirc.kindBreak = 'gravity';
      recirc.leg = this.legRecirc; g.add(recirc.group);
      // Into the top of the vessel, not into its side: the water has to be
      // seen arriving somewhere, and a line that stops against a wall is a
      // line that goes nowhere.
      const IN = V(GX, r.base + 15.9, r.z);
      const fill = pipe([TEE.clone(), V(IN.x, IN.y + 0.9, IN.z)], 0.5, m, { bend: 0.6 });
      fill.kindBreak = 'gravity';
      fill.leg = this.legFill; g.add(fill.group);
      this.pipes.push(grav, recirc, fill);

      // The nozzle it arrives through, so the joint is a joint.
      const boss = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 0.62, 1.1, 16), this.stage.mat.steel);
      boss.position.set(IN.x, IN.y + 0.5, IN.z);
      g.add(boss);

      // The valve that holds it all back. Nothing here needs power or an
      // operator: when the pressure falls the valve opens and the water goes
      // where water goes. So the valve is drawn, and it is the thing that
      // changes when the accident starts.
      this.gravValve = new THREE.Mesh(
        new THREE.SphereGeometry(0.85, 18, 12), new THREE.MeshStandardMaterial({
          color: 0x8d99a5, roughness: 0.4, metalness: 0.7,
          emissive: new THREE.Color(0x102616), emissiveIntensity: 0.4 }));
      this.gravValve.position.copy(TEE).setY(TEE.y + 0.2);
      g.add(this.gravValve);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.11, 1.6, 10), this.stage.mat.steel);
      stem.position.set(TEE.x, TEE.y + 1.4, TEE.z);
      g.add(stem);
      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(0.48, 0.09, 8, 20), this.stage.mat.rail);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(TEE.x, TEE.y + 2.1, TEE.z);
      g.add(wheel);

      // and the water landing in the vessel while it is open
      this.fillPour = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.42, 4.2, 12), liquidMaterial(0.7));
      this.fillPour.material.normalMap.repeat.set(2, 7);
      this.fillPour.material.clippingPlanes = this.mHalfRpv.clippingPlanes;
      this.fillPour.position.set(IN.x, IN.y - 2.2, IN.z);
      this.fillPour.visible = false;
      g.add(this.fillPour);
    } else {
      // The emergency water stands in an open tank on the ground, because the
      // point of drawing it is that you can see how much is left. A buried
      // tank under a concrete lid is realistic and invisible, which is the
      // wrong trade here.
      const t = L.tank;
      // On the ground, at the same grade as everything else. Standing it on a
      // plinth put the emergency water above the reactor's cold nozzle, which
      // says gravity could do the job and the pump is decoration.
      const walls = slab(t.w, t.h, t.d,
        new THREE.MeshStandardMaterial({ color: 0x4e5a66, roughness: 0.9, side: THREE.BackSide }));
      walls.position.set(t.x, t.h / 2, t.z);
      g.add(walls);
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const lip = slab(ax ? 0.4 : t.w + 0.8, 0.4, az ? 0.4 : t.d + 0.8, this.stage.mat.painted);
        lip.position.set(t.x + ax * (t.w / 2 + 0.2), t.h, t.z + az * (t.d / 2 + 0.2));
        g.add(lip);
      }
      this.tankWater = slab(t.w - 0.7, 1, t.d - 0.7, ownWater(this.m.poolWater));
      this.tankWater.scale.y = t.h - 0.7;
      this.tankWater.position.set(t.x, (t.h - 0.7) / 2, t.z);
      g.add(this.tankWater);

      const e = L.eccs;
      const bp = buildPump(this.stage, this.m, e.x, 1.7, e.z, 0.65);
      g.add(bp.group);
      this.eccsImpeller = bp.impeller;
      this.eccsWater = bp.water;
      this.eccsLamp = bp.lamp;

      this.legSuct = new Leg('suction', 0.35, 2, { rho: FLUID.rhoCold });
      this.legInj = new Leg('injection', 0.25, 2, { rho: FLUID.rhoCold });
      this.inject = new Circuit('inject', [this.legSuct, this.legInj]);
      const suct = pipe([
        V(t.x + t.w / 2 - 0.8, 0.8, t.z), V(e.x, 0.8, e.z), V(e.x, 1.1, e.z)
      ], 0.5, m, { bend: 1.0 });
      suct.kindBreak = 'inject';
      suct.leg = this.legSuct; g.add(suct.group);
      // Along the floor and straight up into the cold leg. It has to pass
      // under the boiler, which is why the boiler stands on legs.
      const inj = pipe([
        V(e.x + 1.2, 1.7, e.z), V(r.x - 3.9, 1.7, r.z),
        V(r.x - 3.9, COLD_Y, r.z)
      ], 0.4, m, { bend: 1.6 });
      inj.kindBreak = 'inject';
      inj.leg = this.legInj; g.add(inj.group);
      this.pipes.push(suct, inj);
    }
  }
}

// ---------------------------------------------------------------------------
// per frame: solve the flows, step the machines, and let the geometry follow
// ---------------------------------------------------------------------------
import { ratedMdot, naturalMdot, THERMAL_W } from '../flow.js?v=29b6a124b2';
import { Plume, PuffCloud } from './plume.js?v=29b6a124b2';

Object.assign(Unit.prototype, {

  // What a breached vessel leaves behind: a hole in the bottom head, a pool of
  // melt on the floor under it, and the pit that pool is eating into the
  // concrete.
  buildBreach() {
    const r = L.rpv, g = new THREE.Group();
    const tornMat = new THREE.MeshStandardMaterial({
      color: 0x1d0c07, roughness: 0.9, emissive: 0x30100a, emissiveIntensity: 0.22,
      side: THREE.DoubleSide, clippingPlanes: this.mHalfRpv.clippingPlanes });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.5, 5), tornMat);
      spike.position.set(r.x + Math.sin(a) * 1.5, r.base - 0.3, r.z + Math.cos(a) * 1.5);
      spike.rotation.x = Math.PI;
      spike.rotation.z = Math.sin(a) * 0.5;
      g.add(spike);
    }
    // the stream still running out of it
    const drip = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.7, r.base - 0.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x3a1204, emissive: 0xd8400f, emissiveIntensity: 0.6,
        roughness: 0.55 }));
    drip.position.set(r.x, (r.base - 0.2) / 2 + 0.1, r.z);
    g.add(drip);
    // the scar it burns into the floor, spreading as it goes
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.06, 1, 32),
      new THREE.MeshStandardMaterial({ color: 0x1b1512, roughness: 0.98 }));
    pit.position.set(r.x, 0.09, r.z);
    g.add(pit);
    const pool = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 0.86, 1, 32),
      new THREE.MeshStandardMaterial({ color: 0x2a0d05, emissive: 0xd8400f,
        emissiveIntensity: 0.6, roughness: 0.5 }));
    pool.position.set(r.x, 0.2, r.z);
    g.add(pool);
    const glow = new THREE.PointLight(0xff7a2a, 90, 34, 2);
    glow.position.set(r.x, 1.6, r.z);
    g.add(glow);
    g.visible = false;
    this.root.add(g);
    return { group: g, pit, pool, glow };
  },

  addPlumes() {
    this.plumes = {
      vent: new Plume(140, 0xd6dee4, 34),
      breach: new Plume(200, 0xd2c6bc, 46),
      corium: new Plume(120, 0x8d7f74, 34),
      dump: new Plume(160, 0xc3d3de, 26),
      air: new Plume(120, 0x9ed6f2, 26)
    };
    for (const k in this.plumes) this.root.add(this.plumes[k].points);
  },

  // WHERE THE HEAT GOES. This is the whole thermal description of the plant
  // as far as the picture is concerned: one inlet temperature per circuit, and
  // the legs that add or remove heat. Everything else follows down the chain.
  solveTemps(st) {
    const p = this.plant;
    // Water off the fuel, in degrees C. The plant model carries cladding
    // temperature in kelvin; the water leaves a little below it.
    const Thot = Math.max(T_TANK, p.Tclad - 273.15 - 8);
    // The rise across the core is the heat over the flow, capped by what the
    // model already says the design rise is; with no flow there is no rise
    // and the whole loop sits at one temperature.
    const dTcore = this.primary.mdot > 1 ? FLUID.dTcore * Math.min(1.6,
      (p.qDecay || THERMAL_W) / THERMAL_W * ratedMdot() / this.primary.mdot) : 0;
    this.legCore.dT = dTcore;
    this.legTubes.dT = -dTcore * ((st.s.feed || 0) > 0 || (st.s.aux || 0) > 0 ? 1 : 0.3);
    this.primary.setTemps(Thot - dTcore);
    // The secondary's water is condensate; its steam is not on the colour map.
    this.legFeed.dT = 0;
    this.secondary.setTemps(T_COND);
    // The sea: in at the sea's own temperature, warmed across the bank by the
    // condensing duty. Ten degrees in life; drawn with the leg's gain.
    // Moving water carries heat; the leg's own velocity is the test, because
    // the sea circuit's speed is set on the leg directly, not through a mass
    // flow on the circuit. Tested on the circuit's flow it was always zero and
    // the outfall left at the sea's own temperature.
    this.legCw.dT = Math.abs(this.legCw.v) > 0.01 || this.cw.mdot > 1 ? 10 : 0;
    this.cw.setTemps(T_SEA);
    if (this.legCond) { this.legCond.T0 = this.legCond.T1 = T_COND; }
    // Emergency water is tank water.
    if (this.inject) this.inject.setTemps(T_TANK);
    if (this.gravity) { this.gravity.setTemps(T_TANK); this.recircC.setTemps(T_TANK); this.fillC.setTemps(T_TANK); }
    // The pool loop takes hot-leg water up, gives FLUID.dTprhr to the pool,
    // and brings it back.
    if (this.prhr) {
      this.legCoil.dT = Math.abs(this.legCoil.v) > 0.01 || this.prhr.mdot > 0.5 ? -FLUID.dTprhr : 0;
      this.prhr.setTemps(this.legHot.T1);
    }
  },

  solve(st) {
    const p = this.plant;
    const rated = ratedMdot();
    let mPri = 0;
    if ((st.s.rcp || 0) > 0.01) mPri = rated * st.s.rcp;
    else if ((st.s.natCirc || 0) > 0.01) mPri = naturalMdot(p.qDecay || 0);
    if (p.level < 0.35) mPri *= p.level / 0.35;
    this.primary.setFlow(mPri);

    const carrying = (st.s.feed || 0) > 0 || (st.s.aux || 0) > 0 || (st.s.rcic || 0) > 0;
    const qSec = !carrying ? 0 : (st.s.feed > 0 ? THERMAL_W : (p.qDecay || 0) * 1.15);
    this.secondary.setFlow(qSec / FLUID.hCycle);
    this.qSec = qSec;

    if (this.prhr) {
      const qp = (st.s.prhr || 0) > 0 ? (p.qDecay || 0) : 0;
      this.prhr.setFlow(qp / (FLUID.cpPrimary * FLUID.dTprhr));
      // Where the water is coming from is drawn, not assumed: out of the pool
      // while the pool has any, off the floor once it has not.
      const on = (st.s.gravity || 0) > 0 || (st.s.cmt || 0) > 0;
      const fromPool = on && p.irwst > 1e5;
      const fromSump = on && !fromPool && (p.ctmtSump || 0) > 1e5;
      this.gravity.setFlow(fromPool ? 55 : 0);
      this.recircC.setFlow(fromSump ? 55 : 0);
      this.fillC.setFlow(fromPool || fromSump ? 55 : 0);
    }
    if (this.inject) this.inject.setFlow(st.injecting ? (st.s.rcic ? 25 : 40) : 0);
    // the sea water only runs while there is a heat sink to run to
    this.cw.setFlow(p.uhs && qSec > 0 ? 5.0e4 : 0);
    this.ventCircuit.setFlow(st.s.vent ? 12 : 0);
  },

  update(st, dt) {
    const p = this.plant, m = this.m;
    if (!this.plumes) this.addPlumes();
    this.solve(st);
    this.solveTemps(st);

    // ---- machines: torque in, angle out ----
    const vOut = this.legCold.v;
    this.mach.step(dt, {
      pumpDriven: (st.s.rcp || 0) > 0.01,
      pumpTarget: (vOut / 1.62) * 0.6,
      steamTorque: (this.secondary.mdot || 0) * 0.023,
      // A real set turns at 3000 rpm, which at any drawable scale is a blur.
      // The load coefficient is what the generator pulls back with, and it is
      // set so the wheel settles at about one turn a second: fast enough to be
      // unmistakably driven, slow enough to watch a bucket go round.
      loadCoef: 9.0,
      auxDriven: !!st.injecting,
      auxTarget: 22
    });
    // ---- steam through the turbine, and the power leaving it ----
    {
      const v = this.legSteam.v, on = Math.abs(v) > 0.02;
      const tm = this.turbSteam.material;
      tm.normalMap.offset.x -= v * dt / 2.4;
      tm.alphaMap.offset.x -= v * dt * 0.18;
      // Thin enough to see the wheels through it: the machine is the subject
      // and the steam is what is happening to it.
      tm.opacity = on ? 0.26 : 0.03;
      tm.emissiveIntensity = on ? 0.26 : 0.02;
      this.turbSteam.visible = on;
      this.turbWisp.advance(dt, v, this.turbLen, on ? 1.0 : 0.0001);
      this.turbWisp.mesh.visible = on;

      // The busbars carry what the generator is actually making. A live
      // conductor gets a warm sheen and no more: the reactor is the subject of
      // the picture and a glowing cable was winning the frame.
      const mw = this.spin > 1.2 ? clamp(this.secondary.mdot / 1900, 0, 1) : 0;
      this.busMat.emissiveIntensity = mw * 0.10;
      // and the lamp at the end of them is lit exactly when it is being made
      this.lampGlass.material.emissiveIntensity = mw * 3.2;
      this.lampGlass.material.color.setHex(mw > 0.02 ? 0xffe9c4 : 0x2a2a26);
      this.lampLight.intensity = mw * 55;
      this.busMat.emissive.setHex(mw > 0.02 ? 0x804013 : 0x140a02);
    }

    this.impeller.rotation.y = this.mach.impeller.angle;
    // the water in the volute is dragged round with the impeller
    this.pumpWater.material.normalMap.offset.x = this.mach.impeller.angle / 6.283;
    tintWater(this.pumpWater.material, colourOfT(this.legCold.T0, new THREE.Color()), 0);
    this.rotor.rotation.x = this.mach.shaft.angle;
    this.spin = Math.abs(this.mach.shaft.speed);

    // ---- the fluid in every pipe, scrolling at its own velocity ----
    for (const c of [this.primary, this.secondary, this.prhr, this.gravity,
      this.recircC, this.fillC, this.inject, this.ventCircuit, this.cw]) if (c) c.advance(dt);
    const heat = loopHeat(p.Tclad);
    const cold = loopHeat(p.Tclad - FLUID.dTcore);
    // A body of water is drawn as water and only turns colour when it is
    // really overheating. The red-for-hot trade is spent on the pipes, where a
    // hot leg beside a cold one is the thing that has to be seen.
    const mean = heatOf(p.Tclad);
    const cTmp = new THREE.Color();
    for (const q of this.pipes) {
      const leg = q.leg;
      if (!leg) continue;
      const v = leg.v;
      const vd = drawV(v);
      const moving = Math.abs(v) > 0.02;
      const mat = q.mat;
      // The ripples on the liquid travel with it, and with the tracers in it,
      // because they are the same water at the same speed.
      mat.normalMap.offset.x -= vd * dt / 2.4;
      // and so do the bubbles in it
      // In steam the carried droplets are the whole story, so they are drawn
      // big; in water they are bubbles and stay small.
      q.bub.advance(dt, vd, q.len, moving ? (leg.kind === 'steam' ? 1.5 : 1) : 0.0001);
      q.bub.mesh.visible = moving;

      if (leg.kind === 'steam') {
        // Vapour scatters instead of refracting, so it is a body you look at
        // rather than through: pale, torn, and moving fast enough to see.
        // On the same compression as the tracers beside it and the vapour in
        // the boiler it came from: raw velocity here made the streaks in the
        // steam line race past bubbles that were leaving the water it boiled
        // out of.
        mat.alphaMap.offset.x -= vd * dt * 0.25;
        mat.opacity = moving ? 0.72 : 0.12;
        mat.emissiveIntensity = moving ? 0.42 : 0.05;
      } else {
        // The leg knows its own inlet and outlet temperature; the pipe is
        // painted from one to the other along its length, in the direction the
        // water goes. A run whose geometry is laid out against its flow says so
        // with flowDir, and a run that is only one END of a leg (the sea intake
        // is the sea leg's inlet, the outfall its outlet) says which end.
        let Ta = leg.T0, Tb = leg.T1;
        if (q.tempAt === 'in') Tb = Ta;
        else if (q.tempAt === 'out') Ta = Tb;
        if (q.flowDir === -1) { const t = Ta; Ta = Tb; Tb = t; }
        paintFluid(mat, colourOfT(Ta, cTmp), colourOfT(Tb, _c2));
        // Everything else about this material was set when it was built.
        // Rewriting it every frame cost forty materials a dozen property
        // writes each for nothing, and it forced transmission back on the
        // moment the settings panel switched it off.
        mat.emissiveIntensity = moving ? 0.32 : 0.14;
        mat.normalScale.set(moving ? 0.42 : 0.14, moving ? 0.42 : 0.14);
      }
      // An empty pipe is drawn empty. A coloured rod in a loop that has boiled
      // dry says there is water where there is none, which is the one thing
      // the picture is not allowed to say.
      const wet = q.dry ? !q.dry() : true;
      q.core.visible = wet && (moving || leg.kind !== 'steam');
      if (!wet) q.bub.mesh.visible = false;
    }

    // The boiler tubes and the pool coil carry the change itself: hot in at
    // one end, cold out at the other, mixed along the run.
    {
      const hotC = colourOfT(this.legHot.T1, new THREE.Color());
      const coldC = colourOfT(this.legTubes.T1, new THREE.Color());
      const wet = st.lvl > 0.02;
      // The two chambers of the channel head, painted from the same call as
      // the legs that arrive in them, so the pipe does not step into the
      // vessel at the nozzle.
      if (this.headHot) {
        tintWater(this.headHot.material, hotC, dt);
        tintWater(this.headCold.material, coldC, dt);
        const wet2 = st.lvl > 0.02;
        this.headHot.visible = wet2;
        this.headCold.visible = wet2;
      }
      for (const u of this.sgTubes || []) {
        setGradient(u.mat, hotC, coldC);
        // The colour lives entirely in the gradient here. Tinting the volume
        // as well fights it and turns the hot end brown.
        u.mat.attenuationColor.setHex(0xffffff);
        u.mat.normalMap.offset.x -= drawV(this.legTubes.v) * dt / 2.4;
        u.mat.emissive.copy(coldC).multiplyScalar(0.10);
        u.mesh.visible = wet;
      }
      // ---- the condenser doing its one job ----
      // Steam above the tubes, drops off the tubes, water below them. Each of
      // the three is driven by whether the machine is actually being asked to
      // condense anything, which is the secondary flow.
      {
        const rate = clamp((this.secondary.mdot || 0) / 1400, 0, 1);
        // Down the throat, hard and obvious: this is the steam leaving the
        // turbine, and it was too faint to be seen doing it.
        const em = this.exhSteam.material;
        em.alphaMap.offset.y -= dt * (0.9 + rate * 4.2);
        em.opacity = 0.24 + rate * 0.58;
        em.emissiveIntensity = 0.15 + rate * 0.5;
        {
          const f = this.exhFallAt;
          this.exhFall.step(dt, f.x, f.y0, f.z, rate, -1, 0.1 + rate * 0.16);
        }
        // and filling the shell, where it meets the cold tubes and stops being
        // steam. Thicker at the top where it arrives, thin at the bottom where
        // it has already given up.
        {
          const f = this.condFogAt;
          this.condFog.step(dt, f.x, f.y0, f.z, rate, -1, 0.1 + rate * 0.16);
        }
        for (const c of this.condDrip) {
          c.d.step(dt, this.cond.position.x + 0.4, L.turb.z - 0.5, 4.4, 1.6,
            c.y - 0.34, this.condPoolTop, rate);
        }
        // Exactly the colour the condensate line and the feed line carry.
        // Water that leaves a pipe one blue and lands in the machine another
        // says the two are different fluids, and nothing along this run heats
        // it or cools it: it condenses here and it is pumped from here to the
        // boiler, at one temperature the whole way.
        // the same call that paints the condensate line out of it
        colourOfT(T_COND, cTmp);
        paintFluid(this.condWater.material, cTmp);
        paintFluid(this.condTop.material, cTmp);

        this.condWater.material.normalMap.offset.x += dt * 0.04;
        this.condTop.material.normalMap.offset.x += dt * 0.05;
        this.condTop.material.normalMap.offset.y += dt * 0.03;
        // the drops landing are what disturbs it, so the surface moves when
        // the machine is condensing and lies still when it is not
        this.surfCond.step(dt, { boil: 0.06 + rate * 0.5 });
        ripple(this.condTop, this.surfCond, this.condHalf);
        this.condPump.impeller.rotation.y += dt * (0.6 + rate * 9);
        this.legCond.v = 0.4 + rate * 2.6;
        this.condPump.water.material.normalMap.offset.x -= dt * (0.1 + rate * 1.2);
        tintWater(this.condPump.water.material, colourOfT(T_COND, cTmp), 0);
      }
      // the condenser's tube bank runs at the sea water leg's own speed
      const cwC = new THREE.Color();
      for (const c2 of this.condTubes) {
        // cold going in, warm coming back: the bank is where the heat crosses
        // The sea leg's rise is split across its two passes: the first takes
        // the water from the leg's inlet temperature to the midpoint, the
        // second from the midpoint to the outlet. Both tubes are built left
        // to right; the first pass FLOWS right to left, so its ends are
        // swapped. Nothing here knows a colour, only a temperature.
        const Tmid = (this.legCw.T0 + this.legCw.T1) / 2;
        const lo = c2.dir > 0;
        paintFluid(c2.rod.mat,
          colourOfT(lo ? Tmid : Tmid, cwC),
          colourOfT(lo ? this.legCw.T0 : this.legCw.T1, _c2));
        // the lower pass runs left, the upper pass runs back to the right
        c2.rod.mat.normalMap.offset.x -=
          drawV(this.legCw.v) * dt / 2.4 * c2.dir;
      }
      // The inlet box holds the water that has just arrived from the sea; the
      // turning box at the far end holds it after one pass, half warmed. Both
      // are painted from the same call as the tubes that leave them.
      if (this.boxWater) {
        // The inlet box is divided: cold sea arrives in the bottom half and
        // warm water leaves from the top, which is what the plate across it is
        // for. Its body is drawn with that change up its own height.
        paintFluid(this.boxWater[0].material,
          colourOfT(this.legCw.T0, cwC), colourOfT(this.legCw.T1, _c2));
        paintFluid(this.boxWater[1].material,
          colourOfT((this.legCw.T0 + this.legCw.T1) / 2, cwC));
      }
      // and the feedwater falling to the surface inside the boiler's dome
      // the ring, the pipe into it and the two pours off it are one run of
      // water, so they are given one colour from one call
      const feedC = colourOfT(this.legFeed.T1, new THREE.Color());
      if (this.seaMat) {
        // one material, shared by the bay and the channel, so the swell runs
        // in from the horizon as a single body of water
        this.seaMat.normalMap.offset.y -= dt * 0.02;
        this.seaMat.normalMap.offset.x += dt * 0.006;
      }
      if (this.poolCoil) {
        const on = (st.s.prhr || 0) > 0;
        setGradient(this.poolCoil.mat, on ? hotC : coldC, coldC);
        this.poolCoil.mat.attenuationColor.setHex(0xffffff);
        this.poolCoil.mat.normalMap.offset.x -= drawV(this.legCoil.v) * dt / 2.4;
        this.poolCoil.mesh.visible = wet;
      }
    }

    // ---- the water in the reactor ----
    const wy = waterY(st.lvl);
    const hgt = Math.max(0.05, wy - W_LO + 0.6);
    this.coreWater.scale.y = hgt;
    this.coreWater.position.set(L.rpv.x, W_LO - 0.6 + hgt / 2, L.rpv.z);
    this.coreTop.position.set(L.rpv.x, wy, L.rpv.z);
    this.surfCore.step(dt, { boil: st.s.boil || 0, pour: st.injecting ? 0.6 : 0, pourAt: 0.4 });
    // The core is always driving heat into the water, so it always fizzes a
    // little; when it boils in earnest the column of bubbles fills the vessel.
    this.riseCore.step(dt, W_LO - 0.5, Math.max(0.4, wy - W_LO + 0.5),
      st.lvl > 0.02 ? clamp(0.12 + (st.s.boil || 0) * 1.4, 0, 1) : 0, L.rpv.x, L.rpv.z, 0.5);
    this.levelRing.position.set(L.rpv.x, wy, L.rpv.z);
    this.levelRing.visible = st.lvl > 0.01 && st.lvl < 0.995;
    ripple(this.coreTop, this.surfCore, 2.94);
    // Cold in at the bottom from the cold leg, hot out at the top, and the top
    // MATCHES the hot leg leaving beside it, because both come from the same
    // call on the same number. This is the water heating as it goes up past
    // the fuel, which is the one thing a reactor does.
    this.coreWater.material.normalMap.offset.x += dt * 0.035;
    this.coreWater.material.normalMap.offset.y += dt * 0.021;
    // The body of the water is held below the top of the ramp at normal
    // power: the pipes are where the blue-to-orange trade is spent, and a
    // vessel full of orange at 347 C leaves nowhere to go when it really is
    // overheating.
    // Cold-leg water at the bottom, hot-leg water at the top: the vessel's
    // column is the core leg, painted from its inlet to its outlet.
    paintFluid(this.coreWater.material,
      colourOfT(this.legCore.T0, new THREE.Color()), colourOfT(this.legCore.T1, new THREE.Color()));
    paintFluid(this.coreTop.material, colourOfT(this.legCore.T1, cTmp));
    this.coreTop.material.normalMap.offset.x += dt * 0.03;
    this.coreWater.visible = st.lvl > 0.01;
    this.coreTop.visible = st.lvl > 0.01;

    // ---- the fuel ----
    // The rods glow with what they are making. At full power they are the red
    // heart of the picture; after a scram they dim to the decay-heat ember
    // that the whole cooling problem is about; melting takes them to white.
    const hot = clamp((p.Tclad - 620) / 900, 0, 1);
    const burn = clamp(p.powerFrac, 0, 1);
    const glow = Math.max(burn * 0.75, hot);
    this.fuelMat.emissive.copy(tempColor(Math.max(p.Tclad, 620 + burn * 500)));
    this.fuelMat.emissiveIntensity = 0.12 + glow * 0.85;
    this.fuelMat.color.copy(tempColor(Math.max(p.Tclad, 620 + burn * 500)))
      .lerp(new THREE.Color(0x6f7d88), 1 - Math.max(glow, 0.25));
    // what is left of a melted core is a pool of it on the bottom head
    const dam = clamp(p.coreDamage, 0, 1);
    if (!this.melt) {
      this.melt = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
        new THREE.MeshStandardMaterial({
          color: 0x2a0d05, emissive: 0xff5a1e, emissiveIntensity: 1.0, roughness: 0.5,
          clippingPlanes: this.mHalfRpv.clippingPlanes
        }));
      this.melt.position.set(L.rpv.x, L.rpv.base + 1.3, L.rpv.z);
      this.root.add(this.melt);
    }
    this.melt.visible = dam > 0.3;
    if (this.melt.visible) {
      // some of it always stays in the vessel; the rest is on the floor
      const rr = (1.2 + dam * 1.6) * (p.vesselBreach ? 0.72 : 1);
      this.melt.scale.set(rr, 0.55 + dam * 0.5, rr);
      this.melt.material.emissive.copy(tempColor(Math.max(p.Tclad, 2100)));
      this.melt.material.emissiveIntensity = 0.8 + dam * 0.7;
    }
    // The rods slump as they melt, and once the core is destroyed there are no
    // rods left to draw: what is left of it is the pool.
    this.fuelInst.scale.y = Math.max(0.04, 1 - dam * 0.97);
    this.fuelInst.position.y = -(FUEL_Y1 - FUEL_Y0) * dam * 0.485;
    this.fuelInst.visible = dam < 0.97;

    // When the vessel goes, the melt is out on the floor of the building and
    // starts eating the concrete. That is the containment being damaged, and
    // the model already tracks how far it has got.
    if (!this.breachKit) this.breachKit = this.buildBreach();
    const out = !!p.vesselBreach;
    this.breachKit.group.visible = out;
    if (out) {
      const mc = clamp(p.mcci / 3.5, 0, 1);
      const rr = 3.4 + mc * 4.0;
      this.breachKit.pool.scale.set(rr, 0.45 + mc * 0.6, rr);
      this.breachKit.pool.material.emissive.copy(tempColor(Math.max(p.Tclad, 1900)));
      this.breachKit.pool.material.emissiveIntensity = 0.5 + mc * 0.35;
      this.breachKit.pit.scale.set(rr * 1.22, 0.14, rr * 1.22);
      this.breachKit.glow.intensity = 90 + mc * 130;
    }
    // the skirt is in the way of the one thing worth seeing here
    this.skirt.visible = !out;

    // ---- the boiler ----
    const carrying = st.carried && (st.s.feed || st.s.aux || st.s.rcic);
    // Carrying heat, the water stands over the whole bundle and boils. Not
    // carrying, it settles back and the top of the bundle comes out of it.
    const sgH = carrying ? 9.6 : 5.6;
    this.sgWater.scale.y = sgH;
    this.sgWater.position.set(L.sg.x, SG_TS + sgH / 2, L.sg.z);
    this.sgTop.position.set(L.sg.x, SG_TS + sgH, L.sg.z);
    // the steam space is whatever the water is not, and it thickens as the
    // boiler is actually asked to carry heat
    {
      const top = SG_BASE + 16.7, surf = SG_TS + sgH;
      const h = Math.max(0.4, top - surf);
      this.sgSteam.scale.y = h;
      this.sgSteam.position.set(L.sg.x, surf + h / 2, L.sg.z);
      const sm = this.sgSteam.material;
      // The steam space scrolls upward at the speed the steam line is running
      // at, so what is in the dome and what is in the pipe are the same stuff
      // moving at the same rate.
      // On the same compressed scale as everything else, so the steam in the
      // dome, the steam in the line and the bubbles under it all move at
      // speeds that belong to the same picture.
      const sv = Math.max(0.15, Math.abs(drawV(this.legSteam.v)) * 0.12);
      sm.alphaMap.offset.y -= dt * sv;
      sm.normalMap.offset.y -= dt * sv * 0.7;
      // Faint. At half opacity the steam space was a white drum filling the
      // top of the boiler and the bundle behind it disappeared; what says
      // there is steam in there is the vapour rising off the water, not a
      // cylinder of fog.
      sm.opacity = carrying ? 0.17 : 0.06;
      sm.emissiveIntensity = carrying ? 0.35 : 0.12;
      // The dome is the same steam at the same speed, so what fills the vessel
      // and what leaves down the pipe are visibly one thing.
      const nm = this.sgNeck.material;
      nm.alphaMap.offset.y -= dt * sv;
      nm.normalMap.offset.y -= dt * sv * 0.7;
      nm.opacity = carrying ? 0.2 : 0.07;
      nm.emissiveIntensity = sm.emissiveIntensity;
      // the downcomer runs from the feed nozzle to the tube sheet, and its
      // water moves DOWNWARD, which is the direction the recirculation goes
      {
        // From the end of the feed line DOWN to the tube sheet, whatever the
        // water level: the sheet is what the arriving water runs down, so it
        // starts where the pipe stops. Clipped to the surface, it lived under
        // the water and the pipe ended in mid-air above it, going nowhere.
        const dTop = SG_BASE + 12.6, dBot = SG_TS + 0.2;
        const dh = Math.max(0.6, dTop - dBot);
        this.sgDown.scale.y = dh;
        this.sgDown.position.set(L.sg.x, dBot + dh / 2, L.sg.z);
        const dm = this.sgDown.material;
        dm.normalMap.offset.y += dt * (carrying ? 1.4 : 0.35);
        // Cold at the top where the feedwater lands on it, warm at the bottom
        // where it turns into the bundle: the recirculation, drawn along the
        // one surface it happens on.
        // Feedwater at the top where it lands, boiler water at the bottom
        // where it joins: the downcomer is the one place the two meet.
        paintFluid(dm, colourOfT(T_BOILER, _c2), colourOfT(this.legFeed.T1, cTmp));
        dm.opacity = 0.34;
      }
      // and the boiling band rides on the surface, thicker the harder it boils
      const bh = 0.5 + (carrying ? 1.5 : 0.3);
      this.sgBoil.scale.y = bh;
      this.sgBoil.position.set(L.sg.x, surf + bh * 0.35, L.sg.z);
      const bm = this.sgBoil.material;
      bm.alphaMap.offset.y -= dt * (carrying ? 1.6 : 0.4);
      bm.normalMap.offset.x += dt * 0.25;
      bm.opacity = carrying ? 0.62 : 0.22;
      bm.emissiveIntensity = carrying ? 0.5 : 0.15;
    }
    this.surfSg.step(dt, { boil: carrying ? 0.5 : 0.05 });
    this.riseSg.step(dt, SG_TS + 0.2, Math.max(0.4, sgH),
      carrying ? 0.62 : 0.08, L.sg.x, L.sg.z, 0.6);
    // Vapour leaving the surface and climbing into the dome. The bubbles stop
    // at the waterline and these start there, so the change of state happens
    // at the one place in the picture where it should.
    this.sgVapour.h = Math.max(1.0, SG_BASE + 17.2 - SG_TS - sgH);
    // A tenth each. Seventy soft sprites stacked in one drum at half opacity
    // is not vapour, it is a white cylinder, and the bundle behind it goes.
    this.sgVapour.step(dt, L.sg.x, SG_TS + sgH, L.sg.z,
      carrying ? 0.68 : 0.1, 1, carrying ? 0.19 : 0.07);
    ripple(this.sgTop, this.surfSg, 2.62);
    // The shell side of the boiler is at its own boiling point, which is what
    // the feed line arriving cold and the steam line leaving hot are about.
    tintWater(this.sgWater.material, colourOfT(T_BOILER, cTmp), dt);

    // The gravity valve: shut and green while nothing needs it, open and amber
    // once it is doing the work. It is the whole design argument in one part.
    if (this.gravValve) {
      const open = Math.abs(this.legFill.v) > 0.02;
      this.gravValve.material.emissive.setHex(open ? 0x4a2a05 : 0x102616);
      this.gravValve.material.color.setHex(open ? 0xd9a24a : 0x8d99a5);
      this.fillPour.visible = open && st.lvl < 0.995;
      if (open) {
        this.fillPour.material.normalMap.offset.y -= dt * 2.4;
        paintFluid(this.fillPour.material, colourOfT(this.legFill.T1, cTmp));
      }
    }

    // ---- the store of water ----
    if (this.poolWater) {
      const f = clamp(p.irwst / 2.1e6, 0, 1);
      const ph = Math.max(0.05, 0.4 + 4.8 * f);
      this.poolWater.scale.y = ph;
      this.poolWater.position.set(L.pool.x, L.pool.y + 0.5 + ph / 2, L.pool.z);
      this.surfPool.step(dt, { boil: (st.s.prhr || 0) > 0 ? 0.4 : 0.02 });
      this.risePool.step(dt, L.pool.y + 0.5, Math.max(0.4, ph),
        (st.s.prhr || 0) > 0 ? 0.75 : 0.03, L.pool.x, L.pool.z, 0.55);
      const warm = (st.s.prhr || 0) > 0 ? 0.2 : 0.04;
      colourOfT(this.legCoilOut ? this.legCoilOut.T1 : T_TANK, cTmp);
      tintWater(this.poolWater.material, cTmp, dt);
    }

    if (this.tankWater) tintWater(this.tankWater.material, colourOfT(T_TANK, cTmp), dt);

    // ---- the water that got out of the tank and is lying on the floor ----
    if (this.sumpWater) {
      const kg = p.ctmtSump || 0;
      const dep = clamp(kg / 2.1e6, 0, 1) * 2.6;
      this.sumpWater.visible = dep > 0.04;
      this.sumpWater.scale.y = Math.max(0.05, dep);
      this.sumpWater.position.set(0, dep / 2 + 0.05, 0);
      tintWater(this.sumpWater.material, colourOfT(T_TANK, cTmp), dt);
      this.sumpWater.material.emissiveIntensity = 0.34;
      this.sumpWater.material.attenuationDistance = 3.2;
      const leaking = p.irwstCracked && p.irwst > 1e5;
      this.leakJet.visible = leaking;
      if (leaking) {
        this.leakJet.material.normalMap.offset.y += dt * 2.2;
        tintWater(this.leakJet.material, colourOfT(this.legCold.T0, cTmp), 0);
      }
    }

    // ---- broken pipes bleeding ----
    // Each wound blows for as long as what fed it holds out: the primary jet
    // stops when the vessel is dry, a steam jet when the blowdown is spent,
    // the rest die on their own timescale. Nothing bleeds forever.
    for (const b of this.breakFx || []) {
      const age = p.t - b.t0;
      let on;
      if (b.q.kindBreak === 'primary') on = st.lvl > 0.02;
      else if (b.q.kindBreak === 'steamline' || b.q.kindBreak === 'feedline') on = age < 240;
      else if (b.q.kindBreak === 'cw') on = age < 60;
      else on = age < 150;
      if (b.jet) {
        b.jet.visible = on;
        if (on) {
          b.jet.material.normalMap.offset.y -= dt * 2.6;
          paintFluid(b.jet.material, colourOfT(
            b.q.leg ? b.q.leg.T1 : T_COND, cTmp));
        }
      }
      b.spray.step(dt, on ? (b.steam ? 26 : 14) : 0, b.at.x, b.at.y, b.at.z,
        b.steam ? { spread: 1.6, vy: 4.5, vx: 3.5, life: 2.4, grow: 2.4, alpha: 0.5 }
          : { spread: 0.8, vy: 1.6, vx: 2.4, life: 1.1, grow: 1.1, alpha: 0.5 });
    }

    // ---- lamps ----
    const driven = (st.s.rcp || 0) > 0.01;
    this.pumpLamp.material.emissive.setHex(driven ? 0x63e08a
      : Math.abs(this.legCold.v) > 0.02 ? 0xffc44d : 0xff5c48);
    if (this.eccsLamp) {
      this.eccsLamp.material.emissive.setHex(st.injecting ? 0x63e08a
        : (st.live && p.pumpsOk) ? 0xffc44d : 0xff5c48);
      this.eccsImpeller.rotation.y = this.mach.aux.angle;
      this.eccsWater.material.normalMap.offset.x = this.mach.aux.angle / 6.283;
      tintWater(this.eccsWater.material, colourOfT(T_TANK, cTmp), 0);
    }

    // ---- damage ----
    if (this.plug) this.plug.visible = p.ctmtIntact;
    if (this.tear) this.tear.visible = !p.ctmtIntact;
    // Scorched, not repainted: a building that changes colour reads as a
    // different building, and what happened to it is the hole.
    m.concrete.color.setHex(p.ctmtIntact ? 0x9aa0a6 : 0x8a8078);

    // ---- plumes ----
    const st2 = L.stack;
    this.plumes.vent.step(dt, st.s.vent ? 26 : 0, st2.x, st2.h, st2.z,
      { spread: 2, vy: 9, vx: 1.4, life: 5, grow: 2.6, alpha: 0.45 });
    const bA = this.breachAz;
    // Released OUTSIDE the wall, well clear of it, and rising. Emitted a
    // metre off the concrete with a five-metre spread, half the smoke was
    // born inside the building and drifted across the cutaway; smoke leaving
    // through a hole starts at the hole and goes up.
    this.plumes.breach.step(dt, p.ctmtIntact ? 0 : 34,
      Math.sin(bA) * (R_IN + 4.5), 17, Math.cos(bA) * (R_IN + 4.5),
      { spread: 2.2, vy: 9, vx: 1.6, life: 6, grow: 4, alpha: 0.5, buoy: 1.6 });
    // Steam the turbine is not taking has to go somewhere, and in a real plant
    // it goes to atmosphere through the relief valves. Drawing it says where
    // the water in the boiler is going.
    this.plumes.dump.step(dt, (this.secondary.mdot || 0) > 1 && this.spin < 4 ? 34 : 0,
      L.turb.x - 11, 20, L.turb.z,
      { spread: 1.6, vy: 5.5, vx: 1.4, life: 3.0, grow: 2.2, alpha: 0.62, buoy: 1.2 });
    this.plumes.corium.step(dt, p.vesselBreach ? 20 : 0, L.rpv.x, 2.0, L.rpv.z,
      { spread: 5, vy: 4.5, vx: 1.6, life: 5, grow: 3.4, alpha: 0.34, buoy: 1.6 });
    // nothing steams out of a surface condenser: what leaves it is warm water
    // Warm air off the outside of the steel shell. It is deliberately a faint
    // blue shimmer and not a cloud: beside a station that is releasing caesium
    // through a hole in its wall, a white plume over the safe one reads as the
    // same thing happening twice.
    const pccs = st.sink === 'shell' ? 1 : clamp(st.s.pccs || 0, 0, 1);
    this.plumes.air.step(dt, pccs > 0.25 ? 9 : 0, 0, SHELL_H + 3, 0,
      { spread: 30, vy: 5, vx: 0.8, life: 3.6, grow: 2.0, alpha: 0.13 });
  }
});

// Push a disc's rim up and down from the shallow-water solve, so the surface
// tilts and ripples instead of sitting flat.
function ripple(mesh, surf, radius) {
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const u = (x / radius + 1) / 2;
    const r = Math.hypot(x, z) / radius;
    pos.setY(i, surf.sample(u) * Math.min(1, 0.35 + r));
  }
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}
