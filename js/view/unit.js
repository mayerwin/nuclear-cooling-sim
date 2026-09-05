// ---------------------------------------------------------------------------
// unit.js - one power station, as real geometry.
//
// Metres. The origin is the middle of the containment floor. The near quarter
// of the building is removed by clipping planes, the way a museum model is cut
// open, and the vessels are cut in half on their own axis so you look straight
// in at the water.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { pipe, vessel, tube, slab, V, roundedPath } from './parts.js?v=03485aad37';
import { liquidMaterial, steamMaterial, rippleNormal, Riser, Drip, Bubbles, frameOf, setGradient, gradientise, twoOctaveFlow, LOWFX, SEA_TILE } from './fluid.js?v=03485aad37';
import { tempColor, waterColor, heatOf, loopHeat, paleSRGB } from './materials.js?v=03485aad37';
import { Leg, Circuit, Surface, FLUID, clamp, lerp, hash1 } from '../flow.js?v=03485aad37';
import { Machines } from '../machines.js?v=03485aad37';
import { instantiate } from './model.js?v=03485aad37';
import { SectionCap } from './section.js?v=03485aad37';

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
  // Set back from the cut and shallower, so the boiler's two columns (at
  // z = -2.2) stand behind it instead of running down through its water.
  tank: { x: -8.5, z: 0.6, w: 9.4, d: 4.0, h: 4.4 },
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
// The channel head's radius where the hot leg meets it and where the cold
// leg leaves it, from the head's own profile; the pipes end on its surface.
const HEAD_R_HOT = 2.4, HEAD_R_COLD = 2.22;
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
// COLOUR WITHIN A CIRCUIT. The absolute map above puts a whole primary loop,
// 290 to 325, in one band of orange and the picture loses the one thing it
// has to say about that loop, which is that the water comes back colder than
// it left. So a circuit's own coldest water is drawn at the cold end of the
// ramp and its hottest at the hot end, and everything else in between. The
// same orange does not mean the same degrees in two circuits, and that is the
// trade: what it means is "the hot end of this circuit", which is the thing
// worth seeing.
const BAND_LO = 0.06, BAND_HI = 0.84;
const NO_RANGE = { lo: 0, hi: 0 };
export function colourIn(range, T, out = new THREE.Color()) {
  const span = range.hi - range.lo;
  const f = span < 2 ? 0 : Math.max(0, Math.min(1, (T - range.lo) / span));
  return fluidColour(BAND_LO + (BAND_HI - BAND_LO) * f, out);
}
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
// Scratch colours for the per-frame paint. update() used to allocate a dozen
// THREE.Color objects a frame per unit; these are the same dozen, once.
const _cA = new THREE.Color(), _cB = new THREE.Color(), _hot = new THREE.Color(), _cold = new THREE.Color();
const FUEL_GREY = new THREE.Color(0x6f7d88);
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
function buildPump(unit, prefix, x, y, z, sc) {
  const group = new THREE.Group();
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(1.72 * sc, 1.72 * sc, 2.0 * sc, 40), liquidMaterial(1.7 * sc));
  water.material.normalMap.repeat.set(6, 2);
  water.material.attenuationDistance = 14 * sc;
  water.material.clippingPlanes = unit.cut;
  water.position.set(x, y, z);
  group.add(water);
  const impeller = unit.model[prefix + '_rotor'];
  const lamp = unit.model[prefix + '_lamp'];
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
    // NO GLASS on the cut. Everything is built whole and the near half is
    // taken off at render time by this one plane, walls and liquids alike;
    // the simulation never knows. A sheet of glass where the wall had been
    // was tried and taken out again: the liquid behind it was still cut, so
    // the glass explained nothing and covered everything.
    this.steamSection = { cut: this.cut };
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

    // The steel: every static part, from Blender (tools/blender/plant.py),
    // cut on this unit's plane. What follows builds only what moves, glows
    // or is wet, into the hollows the model leaves.
    const inst = instantiate({ passive: this.passive, cut: this.cut });
    this.model = inst.byName;
    this.root.add(inst.group);
    // tracers are cut with their pipes
    this.m.fleck = m.fleck.clone();
    this.m.fleck.clippingPlanes = this.cut;
    // every pipe built here is fluid only, with its casing in the model
    this.pipeOpts = { casing: false, cut: this.cut };

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
    this.riseSg = new Riser(2.1, 220, bub(this.mHalfSg.clippingPlanes));
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
    // Every circuit, and which one each leg belongs to, fixed once the
    // station is built. rangeOf() used to rebuild the list and search it
    // twenty-odd times a frame.
    this.allCircuits = this.circuits();
    this.circuitOf = new Map();
    for (const c of this.allCircuits) for (const l of c.legs) this.circuitOf.set(l, c);
    this.ranges = new Map();
    this.breakFx = [];
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
    // ONE source per unit. Two point lights per unit, four in the scene, were
    // a quarter of the whole frame on the laptop's Intel GPU: every fragment
    // of the sea and the ground evaluated all four. One, hung high on the
    // far side of the cut, lifts the machinery off the wall just as well.
    const lamp = new THREE.PointLight(0xdcecf8, 420, 0, 2);
    lamp.position.set(-2, 23, -6);
    g.add(lamp);

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_R, 96, 40, 0, Math.PI * 2, 0, Math.PI / 2), m.concrete);
    dome.position.y = SHELL_H; dome.castShadow = true;
    g.add(dome);
    const domeIn = new THREE.Mesh(
      new THREE.SphereGeometry(R_IN, 96, 40, 0, Math.PI * 2, 0, Math.PI / 2), m.liner);
    domeIn.position.y = SHELL_H;
    g.add(domeIn);
    this.dome = dome; this.domeIn = domeIn;
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

    // The vessel, its flange and studs, the skirt and the fuel-top mark are
    // the model's. The skirt is hidden once the vessel has failed, so the
    // melt on the floor can be seen.
    this.skirt = this.model.rpv_skirt;

    // No core barrel. A grey cylinder standing round the rods was a second
    // object inside the vessel that the eye had to explain away, and it lay
    // over the one thing in there worth looking at.

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
    // No ring at the water line: the water's own surface is the level, and
    // a ring round the vessel read as one more unexplained object.

    // the water, and its free surface
    this.coreWater = tube(3.12, 3.12, 1, m.water, 48);
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
    this.coreTop = new THREE.Mesh(new THREE.CircleGeometry(3.12, 48, 0, Math.PI * 2)
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
    // The shell, the tube sheet, the pedestal and the four nozzles are the
    // model's; what is built here is the water, the steam and the bank.

    // The water in the head, in two real bodies either side of the divider:
    // the hot leg's water arrives in one, the tubes drink from it, and what
    // they give back fills the other, where the crossover draws it off. The
    // pipe, the chamber and the tubes are one continuous fluid.
    // The water FILLS the head: this is the shell's own head profile less a
    // finger's clearance. Drawn smaller, a band of the head's inside wall
    // showed round the water once the head was steel, and where the legs'
    // cut troughs crossed that band they read as fins on the joint.
    const headProf = [[0.2, 0.35], [1.35, 0.5], [2.34, 0.96], [2.64, 2.05], [2.64, 2.9]]
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
    this.sgWater = tube(2.35, 2.35, 1, m.water, 40);
    this.sgWater.material = ownWater(m.water);
    this.sgWater.material.clippingPlanes = this.mHalfSg.clippingPlanes;
    g.add(this.sgWater);
    this.sgTop = new THREE.Mesh(new THREE.CircleGeometry(2.35, 40).rotateX(-Math.PI / 2),
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
    // DRAWN, and as dense as the line that carries it away. It was left off
    // once because at half opacity it hid the tube bank; but the bank is
    // under water whenever the boiler is carrying heat, and the space above
    // the water is exactly where the steam is. A boiler whose dome is empty
    // while the pipe out of it is full of steam is a boiler making steam
    // for nobody.
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
    // The downcomer: the ring of water between the column and the shell
    // that the feed lands in and runs down. Cut open, a ring is two strips,
    // one either side of the column, and that is what is drawn: the sheet
    // stands just outside the column, so the strips show, blue where the
    // feed arrives and orange by the bottom where it has mixed in. Inside
    // the column it was behind opaque water and never showed at all.
    this.sgDown = new THREE.Mesh(
      new THREE.CylinderGeometry(2.66, 2.66, 1, 36, 1, true), liquidMaterial(0.9));
    this.sgDown.material.transparent = true;
    this.sgDown.material.depthWrite = false;
    this.sgDown.material.normalMap.repeat.set(8, 3);
    this.sgDown.material.attenuationDistance = 3.5;
    this.sgDown.material.clippingPlanes = this.cut;
    // Down its height, not round it. The pipe material mixes along u, which
    // on a cylinder runs round the circumference, so the cold-at-the-top,
    // warm-at-the-bottom gradient came out as a stripe round the sheet and
    // the feedwater met the boiler in one step from blue to orange.
    this.sgDown.material.userData.g.axis.value = 1;
    // Seen edge-on, a Fresnel rim turns the strips white; the colour is the
    // whole point of them, so the rim is all but off and the ripple small.
    this.sgDown.material.userData.g.rim.value = 0.06;
    this.sgDown.material.normalScale.set(0.1, 0.1);
    this.sgDown.material.clearcoat = 0;
    this.sgDown.material.roughness = 0.55;
    this.sgDown.material.envMapIntensity = 0.15;
    g.add(this.sgDown);

    this.sgBoil = new THREE.Mesh(
      new THREE.CylinderGeometry(2.35, 2.35, 1, 32, 1, true), steamMaterial());
    this.sgBoil.material.normalMap.repeat.set(4, 2);
    this.sgBoil.material.alphaMap.repeat.set(3, 1);
    this.sgBoil.material.clippingPlanes = this.cut;
    g.add(this.sgBoil);

    // Everything that lives in the plane of the cut is set a little way back
    // into the half that is kept, which is local -z once the model is turned.
    const BACK = 0.32, bx = 0, bz = -BACK;

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
      const w = 0.5 + k * 0.42, top = SG_TS + 6.0 + w * 0.9;
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
    const rcp = buildPump(this, 'rcp', p.x, COLD_Y, p.z, 1);
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
    // Both legs end INSIDE the head's water, half a metre past its glass,
    // so the join is one body of water seen through the wall: no cap, no
    // opening, no gap. Every pipe in the model ends the same way, buried in
    // the water of whatever it serves.
    this.hot = pipe([V(r.x - 2.8, HOT_Y, r.z), V(s.x + HEAD_R_HOT - 0.5, HOT_Y, s.z)],
      1.1, m, { bend: 1.0, ...this.pipeOpts });
    g.add(this.hot.group);

    this.cold = pipe([
      V(s.x - HEAD_R_COLD + 0.5, XOVER_Y, s.z), V(s.x - 4.4, XOVER_Y, s.z),
      V(s.x - 4.4, 5.4, s.z), V(p.x, 5.4, p.z), V(p.x, COLD_Y - 0.6, p.z)
    ], 1.0, m, { bend: 1.5, ...this.pipeOpts });
    g.add(this.cold.group);

    this.coldB = pipe([
      V(p.x + 1.5, COLD_Y, p.z), V(r.x - 2.8, COLD_Y, r.z)
    ], 1.0, m, { bend: 1.0, ...this.pipeOpts });
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

    // ---- the turbine ------------------------------------------------------
    // One turbine on one shaft turning one generator. The casing is opened
    // along its own axis, the way the building is, so the wheel is seen
    // standing inside it rather than beside it. It stands high enough to
    // leave room for the condenser UNDER it, which is where a real hall
    // keeps it: the spent steam falls straight down.
    const AX = 10.4, X0 = t.x - 6.5, X1 = t.x - 1.7;
    this.turbLen = X1 - X0;
    const GX = t.x + 1.0;   // the generator, and the lamp above it
    // The casing, the shaft, the bearings, the wheel, the generator and the
    // lamp on its pole are the model's; the wheel turns under 'turb_rotor'.
    this.rotor = this.model.turb_rotor;
    this.turbCut = this.cut;
    this.gen = this.model.gen_body;

    // The steam inside the casing: in at the narrow end, out colder, wetter
    // and much larger, so the body of vapour is a cone that widens along it.
    this.turbSteam = new THREE.Mesh(
      new THREE.CylinderGeometry(2.7, 1.7, X1 - X0 - 0.2, 32, 1, true).rotateZ(-Math.PI / 2),
      steamMaterial());
    this.turbSteam.material.normalMap.repeat.set(5, 3);
    this.turbSteam.material.alphaMap.repeat.set(3, 2);
    this.turbSteam.material.clippingPlanes = this.cut;
    this.turbSteam.position.set((X0 + X1) / 2, AX, t.z);
    this.turbSteam.renderOrder = 2;
    g.add(this.turbSteam);
    const wispMat = m.bubble.clone();
    wispMat.clippingPlanes = this.cut;
    this.turbWisp = new Bubbles(
      frameOf(roundedPath([V(X0 + 0.4, AX, t.z), V(X1 - 0.4, AX, t.z)], 0.2), 40),
      0.34, 54, wispMat);
    g.add(this.turbWisp.mesh);

    // ---- the condenser, under the turbine -------------------------------
    // A surface condenser, drawn the way the textbooks draw one: a
    // horizontal shell under the machine, the spent steam let down into it
    // through a funnel in the casing's floor, a bank of tubes with the sea
    // running through them, and a hotwell under the shell where what
    // condenses collects for the pump to take back to the boiler. The sea
    // goes in at one end on the lower row, round at the far end, and comes
    // back out at the same end on the upper row, warmer: two passes, which
    // is how most of them are built and which keeps both sea lines on the
    // sea side of the machine.
    const CR = 2.0, CYC = 3.4, CXC = X1 - 0.8, CLEN = 6.2;
    const CTOP = CYC + CR, CBOT = CYC - CR;
    const PL = 0.25;
    const PLATE_R = CXC + CLEN / 2 + PL / 2;   // the middle of the sea-side plate
    // The shell, the plates, the saddles and the exhaust duct's steel are the
    // model's. The exhaust's vapour, cut with it:
    this.cond = this.model.cond_shell;
    this.exhaust = pipe([V(X1 - 1.3, AX - 3.0, t.z), V(X1 - 1.3, CTOP - 0.25, t.z)],
      1.4, m, { bend: 0.5, steam: true, ...this.pipeOpts });
    this.exhaust.leg = this.legSteam;
    g.add(this.exhaust.group);
    this.pipes.push(this.exhaust);

    this.legCw = new Leg('sea water', 2.2, 2, { rho: FLUID.rhoCold, gain: 10 });
    this.cw = new Circuit('sea water', [this.legCw]);
    // The tube bank: three nested runs lying flat in the shell, in along the
    // lower row from the sea side, round at the far end, back along the
    // upper row and out warmer. Each is one run of water changing colour
    // along its own length, as the boiler's tubes are.
    // The runs start and end INSIDE the sea-side plate, where the two
    // nozzles end from the other side: sea in, through the plate, along the
    // bank; back along the bank, through the plate, sea out.
    const TZ = t.z - 0.35, TXR = PLATE_R;
    this.condTubes = [];
    // Nested: the outer run takes the lowest and the highest row, the inner
    // run the two middle rows, so the three bends sit one inside the next.
    // Given the same height each, the bends lay on top of one another.
    for (let k = 0; k < 3; k++) {
      const yLo = CYC - 1.0 + k * 0.38, yHi = CYC + 0.45 + (2 - k) * 0.38;
      const xl = CXC - CLEN / 2 + 0.5 + k * 0.36;
      const u = fluidRod([V(TXR, yLo, TZ), V(xl, yLo, TZ), V(xl, yHi, TZ), V(TXR, yHi, TZ)],
        0.16, (yHi - yLo) * 0.45);
      u.mesh.castShadow = false;
      g.add(u.mesh);
      this.condTubes.push(u);
    }
    // Drops form on the lower rows and fall to the pool in the bottom of
    // the shell, and never past it: the floor they are given is the pool.
    this.condDrip = [CYC - 1.0, CYC - 1.0 + 2 * 0.38].map((yy) => {
      const d = new Drip(70, m.drop);
      g.add(d.mesh);
      return { d, x: CXC, z: TZ, y: yy - 0.12, span: CLEN - 0.8, depth: 0.5 };
    });
    // The steam filling the shell above the bank, settling down onto it.
    this.condFog = new PuffCloud(60, { w: CLEN - 0.8, d: 2.4, h: 2.2, size: 5.5, grow: 1.4 });
    this.condFogAt = { x: CXC, z: t.z, y0: CYC - 0.3 };
    g.add(this.condFog.points);

    // The condensate: a pool lying in the bottom of the shell, with a free
    // surface the drops land on. The hotwell IS the bottom of the shell.
    const POOL_H = 0.32, POOL_D = 0.9, HX = CXC;
    const POOL_Y0 = CBOT + 0.08;
    this.condPoolTop = POOL_Y0 + POOL_H;
    this.condWater = new THREE.Mesh(
      new THREE.BoxGeometry(CLEN - 0.3, POOL_H, POOL_D), bodyOfWater(0x2b8fd8, [3, 2], this.cut));
    this.condWater.position.set(HX, POOL_Y0 + POOL_H / 2, t.z);
    g.add(this.condWater);
    this.condTop = new THREE.Mesh(
      new THREE.PlaneGeometry(CLEN - 0.3, POOL_D, 24, 12).rotateX(-Math.PI / 2),
      bodyOfWater(0x2b8fd8, [3, 3], this.cut));
    this.condTop.material.side = THREE.DoubleSide;
    this.condTop.material.thickness = 0.5;
    this.condTop.position.set(HX, this.condPoolTop + 0.02, t.z);
    g.add(this.condTop);
    this.surfCond = new Surface(24, { c: 2.0, damp: 1.1 });
    this.condHalf = (CLEN - 0.3) / 2;

    // The condensate pump, drawing from the bottom of the hotwell, on the
    // boiler side, where the feed line leaves from.
    // out of the pool through the boiler-side plate, and into the side of
    // the pump: it starts in the pool's water and ends in the pump's.
    const PX = X0 - 1.9, PY = POOL_Y0 + 0.16;
    const cp = buildPump(this, 'cpump', PX, PY, t.z, 0.42);
    g.add(cp.group);
    this.condPump = cp;
    this.legCond = new Leg('condensate', 0.45, 1, { rho: FLUID.rhoFeed });
    const cSuct = pipe([
      V(CXC - CLEN / 2 + 0.6, PY, t.z), V(PX + 0.3, PY, t.z)
    ], 0.5, m, { bend: 0.5, ...this.pipeOpts });
    cSuct.leg = this.legCond;
    cSuct.kindBreak = 'feedline';
    g.add(cSuct.group);
    this.pipes.push(cSuct);

    // ---- the sea: forebay, circulating pump, in, and back out ------------
    // An open forebay cut into the ground beyond the machine, with a channel
    // running back from it to the water. The forebay IS the sea, so it
    // stands at the sea's height.
    const SEA_Y = -2.7, BX = t.x + 5.8;
    // THE SAME WATER AS THE SEA, drawn at the same scale: every piece of sea
    // sets its ripple repeat from its own size over SEA_TILE.
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
    this.chanWater = slab(4.6, 1.7, 36, seaOf(4.6, 36));
    this.chanWater.position.set(BX, SEA_Y - 0.85, t.z - 23);
    g.add(this.chanWater);

    // The circulating pump: nothing gets sea water up into a condenser on
    // its own. It stands at the forebay, draws straight up out of it, and
    // pushes into the lower half of the sea-side water box. The warm water
    // leaves the upper half of the same box and runs out beyond the pump to
    // the far side of the forebay. In on the near side, out on the far side:
    // the two lines never cross.
    const PMX = BX - 1.2, PMY = 1.3;
    const cwp = buildPump(this, 'cwpump', PMX, PMY, t.z, 0.42);
    g.add(cwp.group);
    this.cwPump = cwp;
    // The nozzles sit at the middle of the three rows they feed and drain,
    // a bore wide enough to cover all three, and both end in the plate the
    // rows start in.
    const NZ_IN = CYC - 1.0 + 0.38, NZ_OUT = CYC + 0.45 + 0.38;
    const cwSuct = pipe([V(PMX, SEA_Y - 0.5, t.z), V(PMX, PMY - 0.3, t.z)], 0.9, m, { bend: 0.5, ...this.pipeOpts });
    const cwDisch = pipe([
      V(PMX - 0.5, PMY, t.z), V(PMX - 1.7, PMY, t.z),
      V(PMX - 1.7, NZ_IN, t.z), V(PLATE_R, NZ_IN, t.z)
    ], 0.9, m, { bend: 0.8, ...this.pipeOpts });
    const cwOut = pipe([
      V(PLATE_R, NZ_OUT, t.z), V(BX + 1.9, NZ_OUT, t.z), V(BX + 1.9, SEA_Y - 0.5, t.z)
    ], 0.9, m, { bend: 1.2, ...this.pipeOpts });
    for (const q of [cwSuct, cwDisch, cwOut]) { q.kindBreak = 'cw'; q.leg = this.legCw; g.add(q.group); }
    // Each piece carries which end of the leg it is: cold up to the box,
    // warm away from it.
    cwSuct.tempAt = cwDisch.tempAt = 'in';
    cwOut.tempAt = 'out';
    this.pipes.push(cwSuct, cwDisch, cwOut);

    // The lamp: its bulb and the two busbars are the model's (their
    // materials are this unit's own, so they can be lit); the light it
    // throws is a point light here.
    const LY = AX + 4.4;
    this.lampGlass = this.model.lamp_bulb;
    this.lampLight = new THREE.PointLight(0xffd9a0, 0, 22, 2);
    this.lampLight.position.set(GX, LY - 0.4, t.z);
    g.add(this.lampLight);
    this.busMats = [this.model.lamp_bus_0, this.model.lamp_bus_1].filter(Boolean).map((n) => n.material);
    this.busMat = this.busMats[0] || new THREE.MeshStandardMaterial();

    // ---- the second circuit's two lines ---------------------------------
    // Steam: up out of the boiler, across under the dome, down inside the
    // wall on the turbine side, and IN AT THE END of the casing, on the axis.
    // Steam that comes in at one end, crosses the wheel and leaves through
    // the floor at the other explains a wheel being pushed round.
    const SX = R_IN - 0.9;
    // ...and IN THROUGH THE TOP of the casing near its narrow end. On the
    // axis it shared the end wall with the shaft, and the shaft ran inside
    // the steam pipe.
    this.steam = pipe([
      V(s.x, SG_BASE + 18.6, s.z), V(s.x, 31.4, s.z),
      V(SX, 31.4, t.z), V(SX, 14.0, t.z), V(X0 + 1.2, 14.0, t.z), V(X0 + 1.2, AX + 1.5, t.z)
    ], 1.2, m, { bend: 3.0, steam: true, ...this.pipeOpts });
    this.steam.kindBreak = 'steamline';
    this.steam.leg = this.legSteam;
    g.add(this.steam.group);

    // Feedwater: from the condensate pump, in through the wall low down, up
    // beside the steam line, STRAIGHT ACROSS ABOVE THE REACTOR, and into the
    // boiler's side. It used to describe a rectangle round the building to
    // arrive on the top; the short way is over the reactor, and arriving at
    // the side is where a feed nozzle is.
    const FXR = SX - 1.7;
    this.feed = pipe([
      V(PX - 0.5, PY, t.z), V(FXR, PY, t.z), V(FXR, 29.0, t.z),
      V(s.x + 5.1, 29.0, s.z), V(s.x + 5.1, SG_BASE + 12.6, s.z),
      V(s.x + 1.8, SG_BASE + 12.6, s.z)
    ], 0.7, m, { bend: 2.4, ...this.pipeOpts });
    this.feed.kindBreak = 'feedline';
    this.feed.leg = this.legFeed;
    g.add(this.feed.group);
    // The line runs through the shell and ends INSIDE the downcomer, at the
    // top of the sheet, so the water is seen to arrive on the one surface
    // it runs down.
    this.feedRing = null;
    this.pipes.push(this.steam, this.feed);

    // The vent: the hole in the wall is drawn here (it is the inside face of
    // the app's own wall); the line and its cover are the model's.
    const st = L.stack;
    const VY = 26;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.48, 24),
      new THREE.MeshStandardMaterial({ color: 0x0c1116, roughness: 1 }));
    hole.rotation.y = Math.PI / 2;
    hole.position.set(-R_IN + 0.03, VY, 0);
    g.add(hole);
    this.vent = pipe([
      V(-R_IN, VY, 0), V(-R_IN - 3.2, VY, 0), V(-R_IN - 3.2, st.h, 0)
    ], 0.8, m, { bend: 1.6, steam: true, ...this.pipeOpts });
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
      // the pool's floor, walls and columns are the model's
      this.poolWater = slab(p.w - wallT * 2.4, 1, p.d - wallT * 2.4, m.poolWater);
      g.add(this.poolWater);
      // the residual heat loop: out of the reactor, up into the pool, back in
      this.legPrhrUp = new Leg('to the pool', 0.2, 2);
      this.legCoil = new Leg('coil', 0.2, 2);
      this.legCoilOut = new Leg('coil out', 0.2, 2, { rho: FLUID.rhoCold });
      this.legPrhrDn = new Leg('back from the pool', 0.2, 2, { rho: FLUID.rhoCold });
      this.prhr = new Circuit('prhr',
        [this.legPrhrUp, this.legCoil, this.legCoilOut, this.legPrhrDn]);
      // Straight up out of the vessel into the pool, one hairpin under the
      // water, straight back down into the vessel lower down: hot water
      // rises, gives its heat to the pool, and sinks. Both runs stand on the
      // vessel's right, a metre apart, so the loop reads as one loop and
      // stays clear of the gravity line on the left. (It used to be a
      // serpentine across the whole pool with its two legs nine metres
      // apart, which read as plumbing nobody could explain.)
      const RUP = r.x + 3.7, RDN = r.x + 4.9;
      const COIL_Y = p.y + 1.4, COIL_TOP = p.y + 3.4;
      const up = pipe([
        V(r.x + 2.8, HOT_Y, r.z), V(RUP, HOT_Y, r.z), V(RUP, COIL_Y, r.z)
      ], 0.45, m, { bend: 1.6, ...this.pipeOpts });
      up.kindBreak = 'prhr';
      up.leg = this.legPrhrUp; g.add(up.group);
      // One run of water that goes in hot and comes out cold, with the change
      // happening along it: the same picture as the boiler tubes, because it
      // is the same job being done by a different means.
      const coilPts = [V(RUP, COIL_Y, r.z), V(RUP, COIL_TOP, r.z), V(RDN, COIL_TOP, r.z), V(RDN, COIL_Y, r.z)];
      this.poolCoil = fluidRod(coilPts, 0.22, 0.5);
      g.add(this.poolCoil.mesh);
      const dn = pipe([
        V(RDN, COIL_Y, r.z), V(RDN, COLD_Y + 1.4, r.z), V(r.x + 2.8, COLD_Y + 1.4, r.z)
      ], 0.45, m, { bend: 1.6, ...this.pipeOpts });
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
      // One vertical line from the pool floor straight down into the reactor
      // head, with the valve on it. Straight down is what gravity does. The
      // second line that used to climb from the building's floor to a tee
      // under the valve is gone: nineteen metres of pipe that the owner read
      // as useless. The recirculation leg still carries its flow in the
      // solver; what the eye gets is the water standing on the floor.
      const GX = r.x - 1.6;
      const VALVE = V(GX, 20.4, r.z);
      const grav = pipe([V(GX, p.y + 0.7, r.z), VALVE.clone()], 0.5, m, { bend: 1.4, ...this.pipeOpts });
      grav.kindBreak = 'gravity';
      grav.leg = this.legGrav; g.add(grav.group);
      // Into the top of the vessel, not into its side: the water has to be
      // seen arriving somewhere, and a line that stops against a wall is a
      // line that goes nowhere.
      const IN = V(GX, r.base + 16.4, r.z);
      const fill = pipe([VALVE.clone(), IN.clone()], 0.5, m, { bend: 0.6, ...this.pipeOpts });
      fill.kindBreak = 'gravity';
      fill.leg = this.legFill; g.add(fill.group);
            this.pipes.push(grav, fill);

      // The nozzle, the valve, its stem and wheel are the model's; the valve
      // changes colour with the model's own material, which is this unit's.
      this.gravValve = this.model.grav_valve;

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
      // the tank's floor and walls are the model's
      this.tankWater = slab(t.w - 0.7, 1, t.d - 0.7, ownWater(this.m.poolWater));
      this.tankWater.scale.y = t.h - 0.7;
      this.tankWater.position.set(t.x, (t.h - 0.7) / 2, t.z);
      g.add(this.tankWater);

      const e = L.eccs;
      const bp = buildPump(this, 'eccs', e.x, 1.7, e.z, 0.65);
      g.add(bp.group);
      this.eccsImpeller = bp.impeller;
      this.eccsWater = bp.water;
      this.eccsLamp = bp.lamp;

      this.legSuct = new Leg('suction', 0.35, 2, { rho: FLUID.rhoCold });
      this.legInj = new Leg('injection', 0.25, 2, { rho: FLUID.rhoCold });
      this.inject = new Circuit('inject', [this.legSuct, this.legInj]);
      const suct = pipe([
        V(t.x + t.w / 2 - 0.8, 0.8, e.z), V(e.x, 0.8, e.z), V(e.x, 1.1, e.z)
      ], 0.5, m, { bend: 1.0, ...this.pipeOpts });
      suct.kindBreak = 'inject';
      suct.leg = this.legSuct; g.add(suct.group);
      // Along the floor and straight up into the cold leg. It has to pass
      // under the boiler, which is why the boiler stands on legs.
      const inj = pipe([
        V(e.x + 1.2, 1.7, e.z), V(r.x - 3.9, 1.7, r.z),
        V(r.x - 3.9, COLD_Y, r.z)
      ], 0.4, m, { bend: 1.6, ...this.pipeOpts });
      inj.kindBreak = 'inject';
      inj.leg = this.legInj; g.add(inj.group);
      this.pipes.push(suct, inj);
    }
  }
}

// ---------------------------------------------------------------------------
// per frame: solve the flows, step the machines, and let the geometry follow
// ---------------------------------------------------------------------------
import { ratedMdot, naturalMdot, THERMAL_W } from '../flow.js?v=03485aad37';
import { Plume, PuffCloud } from './plume.js?v=03485aad37';

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
    // Each circuit's own span, for the colour. The secondary's water legs all
    // sit at the condensate temperature; the boiler holds its hot end.
    for (const c of this.allCircuits) this.ranges.set(c, c.range(c === this.secondary ? [T_BOILER] : []));
    this.rangeSec = this.ranges.get(this.secondary);
  },

  // Every circuit this unit has, and the circuit a leg belongs to.
  circuits() {
    return this.allCircuits || [this.primary, this.secondary, this.cw, this.inject, this.gravity,
      this.recircC, this.fillC, this.prhr, this.ventCircuit].filter(Boolean);
  },
  rangeOf(leg) {
    const c = this.circuitOf && this.circuitOf.get(leg);
    if (c) return this.ranges.get(c) || NO_RANGE;
    if (leg === this.legCond) return this.rangeSec || NO_RANGE;
    return NO_RANGE;
  },

  // Back to the station as built: wounds closed, pipes whole. Called when
  // the simulation is reset, so a break made in one run does not bleed into
  // the next.
  reset() {
    for (const b of this.breakFx || []) {
      for (const o of [b.torn, b.jet, b.spray && b.spray.points]) {
        if (!o) continue;
        this.root.remove(o);
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          // the jet's liquid carries its own clone of the flow map
          if (o.material.normalMap) o.material.normalMap.dispose();
          o.material.dispose();
        }
      }
    }
    this.breakFx = [];
    for (const q of this.pipes) q.broken = false;
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
    // What the settings panel has on. The units decide the visibility of
    // their own particles and vapour from these, every frame, so a toggle
    // sticks instead of being overwritten by the next frame's state.
    const Q = this.stage.q, PART = Q.particles ? 1 : 0, STEAM = Q.steam ? 1 : 0;
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
      this.turbSteam.visible = on && !!STEAM;
      const wisp = on && !!PART;
      this.turbWisp.mesh.visible = wisp;
      if (wisp) this.turbWisp.advance(dt, v, this.turbLen, 1.0);

      // The busbars carry what the generator is actually making. A live
      // conductor gets a warm sheen and no more: the reactor is the subject of
      // the picture and a glowing cable was winning the frame.
      const mw = this.spin > 1.2 ? clamp(this.secondary.mdot / 1900, 0, 1) : 0;
      for (const bm of this.busMats) bm.emissiveIntensity = mw * 0.10;
      // and the lamp at the end of them is lit exactly when it is being made
      this.lampGlass.material.emissiveIntensity = mw * 3.2;
      this.lampGlass.material.color.setHex(mw > 0.02 ? 0xffe9c4 : 0x2a2a26);
      this.lampLight.intensity = mw * 55;
      for (const bm of this.busMats) bm.emissive.setHex(mw > 0.02 ? 0x804013 : 0x140a02);
    }

    this.impeller.rotation.y = this.mach.impeller.angle;
    // the water in the volute is dragged round with the impeller
    this.pumpWater.material.normalMap.offset.x = this.mach.impeller.angle / 6.283;
    tintWater(this.pumpWater.material, colourIn(this.rangeOf(this.legCold), this.legCold.T0, _cA), 0);
    this.rotor.rotation.x = this.mach.shaft.angle;
    this.spin = Math.abs(this.mach.shaft.speed);

    // ---- the fluid in every pipe, scrolling at its own velocity ----
    for (const c of this.allCircuits) c.advance(dt);
    const heat = loopHeat(p.Tclad);
    const cold = loopHeat(p.Tclad - FLUID.dTcore);
    // A body of water is drawn as water and only turns colour when it is
    // really overheating. The red-for-hot trade is spent on the pipes, where a
    // hot leg beside a cold one is the thing that has to be seen.
    const mean = heatOf(p.Tclad);
    const cTmp = _cB;
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
      // Tracers only while there is something to trace, and only with the
      // panel's say-so: the advance is a hundred matrix writes per pipe.
      const tracers = moving && !!PART;
      q.bub.mesh.visible = tracers;
      if (tracers) q.bub.advance(dt, vd, q.len, leg.kind === 'steam' ? 1.5 : 1);

      if (leg.kind === 'steam') {
        // Vapour scatters instead of refracting, so it is a body you look at
        // rather than through: pale, torn, and moving fast enough to see.
        // On the same compression as the tracers beside it and the vapour in
        // the boiler it came from: raw velocity here made the streaks in the
        // steam line race past bubbles that were leaving the water it boiled
        // out of.
        mat.alphaMap.offset.x -= vd * dt * 0.25;
        mat.opacity = moving ? 0.6 : 0.12;
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
        const rg = this.rangeOf(leg);
        paintFluid(mat, colourIn(rg, Ta, cTmp), colourIn(rg, Tb, _c2));
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
      q.core.visible = wet && (leg.kind !== 'steam' || (moving && !!STEAM));
      for (const cap of q.caps) cap.visible = q.core.visible;
      if (!wet) q.bub.mesh.visible = false;
    }

    // The boiler tubes and the pool coil carry the change itself: hot in at
    // one end, cold out at the other, mixed along the run.
    {
      const hotC = colourIn(this.rangeOf(this.legHot), this.legHot.T1, _hot);
      const coldC = colourIn(this.rangeOf(this.legTubes), this.legTubes.T1, _cold);
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
      // Steam down the funnel, drops off the bank, water in the hotwell. Each
      // is driven by whether the machine is actually being asked to condense
      // anything, which is the secondary flow.
      {
        const rate = clamp((this.secondary.mdot || 0) / 1400, 0, 1);
        for (const c of this.condDrip) {
          c.d.step(dt, c.x, c.z, c.span, c.depth, c.y, this.condPoolTop, rate * PART);
        }
        this.condFog.step(dt, this.condFogAt.x, this.condFogAt.y0, this.condFogAt.z,
          rate * STEAM, -1, 0.14);
        // Exactly the colour the condensate line and the feed line carry: it
        // condenses here and it is pumped from here to the boiler, at one
        // temperature the whole way.
        colourIn(this.rangeSec, T_COND, cTmp);
        paintFluid(this.condWater.material, cTmp);
        paintFluid(this.condTop.material, cTmp);
        this.condWater.material.normalMap.offset.x += dt * 0.04;
        this.condTop.material.normalMap.offset.x += dt * 0.05;
        this.condTop.material.normalMap.offset.y += dt * 0.03;
        // the drops landing are what disturbs it
        this.surfCond.step(dt, { boil: 0.06 + rate * 0.5 });
        ripple(this.condTop, this.surfCond, this.condHalf, 0.12);
        this.condPump.impeller.rotation.y += dt * (0.6 + rate * 9);
        this.legCond.v = 0.4 + rate * 2.6;
        this.condPump.water.material.normalMap.offset.x -= dt * (0.1 + rate * 1.2);
        tintWater(this.condPump.water.material, colourIn(this.rangeSec, T_COND, cTmp), 0);
      }
      // The tube bank: sea in cold along the lower row, out warmer along the
      // upper, the change drawn along each run, scrolling at the sea leg's
      // own speed; and the pump that gets the sea there.
      {
        const rg = this.rangeOf(this.legCw);
        const cIn = colourIn(rg, this.legCw.T0, cTmp), cOut = colourIn(rg, this.legCw.T1, _c2);
        const cwv = drawV(this.legCw.v), cwOn = Math.abs(this.legCw.v) > 0.02;
        for (const u of this.condTubes) {
          setGradient(u.mat, cIn, cOut);
          u.mat.attenuationColor.setHex(0xffffff);
          u.mat.normalMap.offset.x -= cwv * dt / 2.4;
        }
        this.cwPump.impeller.rotation.y += dt * (cwOn ? 8 : 0);
        this.cwPump.water.material.normalMap.offset.x -= dt * (cwOn ? 1.2 : 0);
        tintWater(this.cwPump.water.material, cIn, 0);
        this.cwPump.lamp.material.emissive.setHex(cwOn ? 0x63e08a : p.uhs ? 0xffc44d : 0xff5c48);
      }
      // and the feedwater falling to the surface inside the boiler's dome
      // the ring, the pipe into it and the two pours off it are one run of
      // water, so they are given one colour from one call
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
      st.lvl > 0.02 ? clamp(0.12 + (st.s.boil || 0) * 1.4, 0, 1) * PART : 0, L.rpv.x, L.rpv.z, 0.5);
    ripple(this.coreTop, this.surfCore, 3.12, 0.6);
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
    const rgP = this.rangeOf(this.legCore);
    paintFluid(this.coreWater.material,
      colourIn(rgP, this.legCore.T0, _cA), colourIn(rgP, this.legCore.T1, _c2));
    paintFluid(this.coreTop.material, colourIn(rgP, this.legCore.T1, cTmp));
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
      .lerp(FUEL_GREY, 1 - Math.max(glow, 0.25));
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
      // As dense as the steam line it feeds. The bank is under the water
      // whenever the boiler is carrying, so nothing worth seeing is behind
      // this; and when it is not carrying the space is nearly clear.
      sm.opacity = carrying ? 0.52 : 0.1;
      sm.emissiveIntensity = carrying ? 0.5 : 0.14;
      // The dome is the same steam at the same speed, so what fills the vessel
      // and what leaves down the pipe are visibly one thing.
      const nm = this.sgNeck.material;
      nm.alphaMap.offset.y -= dt * sv;
      nm.normalMap.offset.y -= dt * sv * 0.7;
      nm.opacity = carrying ? 0.5 : 0.1;
      nm.emissiveIntensity = sm.emissiveIntensity;
      // the downcomer runs from the feed nozzle to the tube sheet, and its
      // water moves DOWNWARD, which is the direction the recirculation goes
      {
        // From the end of the feed line DOWN to the tube sheet, whatever the
        // water level: the sheet is what the arriving water runs down, so it
        // starts where the pipe stops. Clipped to the surface, it lived under
        // the water and the pipe ended in mid-air above it, going nowhere.
        // The band where the cold feed mixes in: from the nozzle down four
        // and a half metres, not the whole height, so the change from blue
        // to orange happens where the water arrives and can be seen.
        const dTop = SG_BASE + 12.6, dBot = dTop - 6.0;
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
        paintFluid(dm, colourIn(this.rangeSec, T_BOILER, _c2), colourIn(this.rangeSec, this.legFeed.T1, cTmp));
        dm.opacity = 0.9;
        // Only while the feed is arriving: with nothing coming in, the ring
        // is the same water as the column.
        this.sgDown.visible = carrying;
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
      (carrying ? 0.62 : 0.08) * PART, L.sg.x, L.sg.z, 0.6);
    // Vapour leaving the surface and climbing into the dome. The bubbles stop
    // at the waterline and these start there, so the change of state happens
    // at the one place in the picture where it should.
    this.sgVapour.h = Math.max(1.0, SG_BASE + 17.2 - SG_TS - sgH);
    // A tenth each. Seventy soft sprites stacked in one drum at half opacity
    // is not vapour, it is a white cylinder, and the bundle behind it goes.
    this.sgVapour.step(dt, L.sg.x, SG_TS + sgH, L.sg.z,
      (carrying ? 0.68 : 0.1) * STEAM, 1, carrying ? 0.3 : 0.08);
    ripple(this.sgTop, this.surfSg, 2.35, 0.35);
    // The shell side of the boiler is at its own boiling point, which is what
    // the feed line arriving cold and the steam line leaving hot are about.
    tintWater(this.sgWater.material, colourIn(this.rangeSec, T_BOILER, cTmp), dt);

    // The gravity valve: shut and green while nothing needs it, open and amber
    // once it is doing the work. It is the whole design argument in one part.
    if (this.gravValve) {
      const open = Math.abs(this.legFill.v) > 0.02;
      this.gravValve.material.emissive.setHex(open ? 0x4a2a05 : 0x102616);
      this.gravValve.material.color.setHex(open ? 0xd9a24a : 0x8d99a5);
      this.fillPour.visible = open && st.lvl < 0.995;
      if (open) {
        this.fillPour.material.normalMap.offset.y -= dt * 2.4;
        paintFluid(this.fillPour.material, colourIn(this.rangeOf(this.legFill), this.legFill.T1, cTmp));
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
        ((st.s.prhr || 0) > 0 ? 0.75 : 0.03) * PART, L.pool.x, L.pool.z, 0.55);
      const warm = (st.s.prhr || 0) > 0 ? 0.2 : 0.04;
      if (this.legCoilOut) colourIn(this.rangeOf(this.legCoilOut), this.legCoilOut.T1, cTmp);
      else fluidColour(BAND_LO, cTmp);
      tintWater(this.poolWater.material, cTmp, dt);
    }

    if (this.tankWater) tintWater(this.tankWater.material, fluidColour(BAND_LO, cTmp), dt);

    // ---- the water that got out of the tank and is lying on the floor ----
    if (this.sumpWater) {
      const kg = p.ctmtSump || 0;
      const dep = clamp(kg / 2.1e6, 0, 1) * 2.6;
      this.sumpWater.visible = dep > 0.04;
      this.sumpWater.scale.y = Math.max(0.05, dep);
      this.sumpWater.position.set(0, dep / 2 + 0.05, 0);
      tintWater(this.sumpWater.material, fluidColour(BAND_LO, cTmp), dt);
      this.sumpWater.material.emissiveIntensity = 0.34;
      this.sumpWater.material.attenuationDistance = 3.2;
      const leaking = p.irwstCracked && p.irwst > 1e5;
      this.leakJet.visible = leaking;
      if (leaking) {
        this.leakJet.material.normalMap.offset.y += dt * 2.2;
        tintWater(this.leakJet.material, colourIn(this.rangeOf(this.legCold), this.legCold.T0, cTmp), 0);
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
          paintFluid(b.jet.material, b.q.leg
            ? colourIn(this.rangeOf(b.q.leg), b.q.leg.T1, cTmp) : fluidColour(BAND_LO, cTmp));
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
      tintWater(this.eccsWater.material, fluidColour(BAND_LO, cTmp), 0);
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
// amp scales the height: the solve is in the units of a three-metre vessel,
// and on a pool a metre across the same waves were spikes.
function ripple(mesh, surf, radius, amp = 1) {
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const u = (x / radius + 1) / 2;
    // Flat at the wall, moving in the middle. Weighted the other way round
    // the silhouette of the surface was a row of triangular shards where the
    // one-dimensional wave met the rim.
    const r = Math.hypot(x, z) / radius;
    pos.setY(i, surf.sample(u) * Math.max(0, 1 - r * 0.9) * amp);
  }
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}
