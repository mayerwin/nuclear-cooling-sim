// ---------------------------------------------------------------------------
// unit.js - one power station, as real geometry.
//
// Metres. The origin is the middle of the containment floor. The near quarter
// of the building is removed by clipping planes, the way a museum model is cut
// open, and the vessels are cut in half on their own axis so you look straight
// in at the water.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { pipe, vessel, tube, slab, railing, V, roundedPath } from './parts.js';
import { liquidMaterial, steamMaterial, Riser, Bubbles, frameOf, setGradient,
  gradientise } from './fluid.js';
import { tempColor, waterColor, heatOf, loopHeat } from './materials.js';
import { Leg, Circuit, Surface, FLUID, clamp, lerp, hash1 } from '../flow.js';
import { Machines } from '../machines.js';

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
  tank: { x: -30, z: 0, w: 11, d: 7, h: 4.2 },
  eccs: { x: -24, z: 0 },
  stack:{ x: -19, z: 0, h: 30 }
};
// The reactor's outlet and the boiler's inlet are at the same height, so the
// hot leg is one straight run. Same for the pump's discharge and the reactor's
// inlet. Every elbow that is left is one the machinery actually needs.
const HOT_Y = 13.0, COLD_Y = 8.2, XOVER_Y = 11.4;
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
  // A clone does not carry the shader injection, so it is reinstalled. Bodies
  // of water take the gradient up their own height: cold at the bottom of a
  // reactor, hot at the top, which is the direction the fuel heats it.
  gradientise(c, axis);
  c.normalMap = src.normalMap.clone();
  c.normalMap.needsUpdate = true;
  c.normalMap.repeat.set(7, 7);
  return c;
}
const WHITE = new THREE.Color(0xffffff);
function tintWater(mat, colour, dt) {
  mat.attenuationColor.copy(colour);
  // Three multiplies the refracted light by the base colour as well as by the
  // attenuation, and the base colour is what actually carries at this scale.
  mat.color.copy(colour).lerp(WHITE, 0.62);
  mat.normalMap.offset.x += dt * 0.035;
  mat.normalMap.offset.y += dt * 0.021;
  mat.emissive.copy(colour).multiplyScalar(0.14);
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
  const casing = new THREE.Mesh(new THREE.CylinderGeometry(1.9 * sc, 1.9 * sc, 2.2 * sc, 40),
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
  lamp.position.set(x, y + 3.0 * sc, z);
  group.add(lamp);
  return { group, impeller, water, lamp };
}

export class Unit {
  constructor(plant, stage, worldX) {
    this.plant = plant;
    this.stage = stage;
    this.passive = plant.mode === 'passive' || /passive/i.test(plant.mode);
    this.root = new THREE.Group();
    this.root.position.x = worldX;
    // Turned so the layout plane squares up to the camera: local +x runs
    // across the picture and local +z points into the half that is kept.
    this.root.rotation.y = Math.PI / 2 - CUT_AZ;
    this.worldX = worldX;

    // One plane, not two: half the building comes off, not a quarter. A wedge
    // leaves three walls standing and you end up peering into a slot. Taking
    // the whole near half off puts the machines in the open, and the far wall
    // stays behind them as something to read them against. Clipping is in
    // world space, so each unit gets its own plane.
    this.cut = [cutPlane(worldX, 0)];
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
      bubble: m.bubble, mote: m.mote, flange: m.flange
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
    this.riseCore = new Riser(1.65, 150, stage.mat.bubble);
    this.root.add(this.riseCore.mesh);
    this.riseSg = new Riser(2.3, 150, stage.mat.bubble);
    this.root.add(this.riseSg.mesh);
    this.risePool = new Riser(3.4, 110, stage.mat.bubble);
    this.root.add(this.risePool.mesh);

    this.surfCore = new Surface(30, { c: 3.4, damp: 1.4 });
    this.surfSg = new Surface(22, { c: 3.0, damp: 1.6 });
    this.surfPool = new Surface(30, { c: 2.2, damp: 0.9 });
    this.mach = new Machines();
    // The plant is at 100% when the page opens, so its machines are already at
    // speed. Spinning them up from rest on the first frame shows a station
    // starting, which is not the story.
    this.mach.running(11.5, 20.5);
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
    for (const [r, mat] of [[R_IN + WALL, m.concrete], [R_IN, m.liner]]) {
      band(r, 0, 9, mat, 0, TAU);
      band(r, 22, SHELL_H, mat, 0, TAU);
      band(r, 9, 22, mat, bA + halfW, TAU - halfW * 2);
    }
    this.plug = new THREE.Group();
    for (const [r, mat] of [[R_IN + WALL, m.concrete], [R_IN, m.liner]]) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, 13, 24, 1, true, bA - halfW, halfW * 2), mat);
      mesh.position.y = 15.5;
      mesh.castShadow = true;
      this.plug.add(mesh);
    }
    g.add(this.plug);
    this.breachAz = bA;
    this.tear = new THREE.Group();
    const tearMat = new THREE.MeshStandardMaterial({
      color: 0x2b1a14, roughness: 0.9, emissive: 0x120806, side: THREE.DoubleSide });
    for (let i = 0; i <= 14; i++) {
      const a = bA - halfW + (i / 14) * halfW * 2;
      for (const yy of [9, 22]) {
        const j = 0.5 + hash1(i * 7 + yy) * 1.6;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.45, j * 2.4, 5), tearMat);
        spike.position.set(Math.sin(a) * (R_IN + WALL / 2),
          yy + (yy > 15 ? -j : j), Math.cos(a) * (R_IN + WALL / 2));
        spike.rotation.x = yy > 15 ? Math.PI : 0;
        this.tear.add(spike);
      }
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

    // buttresses up the wall, and the ring where the dome springs from it.
    // A smooth white capsule reads as a toy; a real containment is ribbed.
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      if (a > bA - halfW && a < bA + halfW) continue;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.55, SHELL_H, 1.5), m.concrete);
      // same angle convention as the wall bands: theta 0 is +z, turning to +x
      rib.position.set(Math.sin(a) * (R_IN + WALL), SHELL_H / 2, Math.cos(a) * (R_IN + WALL));
      rib.rotation.y = a;
      rib.castShadow = rib.receiveShadow = true;
      g.add(rib);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R_IN + WALL + 0.4, 0.55, 8, 96), m.concrete);
    ring.rotation.x = Math.PI / 2; ring.position.y = SHELL_H - 0.4;
    ring.castShadow = true;
    g.add(ring);
    const plinthRing = new THREE.Mesh(new THREE.TorusGeometry(R_IN + WALL + 0.6, 0.8, 8, 96), m.concrete);
    plinthRing.rotation.x = Math.PI / 2; plinthRing.position.y = 1.0;
    g.add(plinthRing);

    // the rim of the cut, so the slice reads as deliberate
    const rimGeo = new THREE.TorusGeometry(R_IN + WALL / 2, WALL / 2, 8, 96);
    const rim = new THREE.Mesh(rimGeo, this.stage.mat.painted);
    rim.rotation.x = Math.PI / 2; rim.position.y = SHELL_H;
    rim.material = m.concrete;
    g.add(rim);

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

    this.rpvShell = vessel(RPV_PROFILE, this.mShellRpv);
    this.rpvShell.position.set(r.x, r.base, r.z);
    g.add(this.rpvShell);

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
    const fuelMark = new THREE.Mesh(
      new THREE.TorusGeometry(3.26, 0.1, 6, 40),
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
    this.coreTop = new THREE.Mesh(new THREE.CircleGeometry(2.94, 48, 0, Math.PI * 2)
      .rotateX(-Math.PI / 2), this.coreWater.material);
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
    // the steam that leaves, and both of those are things to watch, not
    // things to hide behind steel.
    const HEAD_P = SG_PROFILE.slice(0, 4);
    const BARREL_P = [[2.7, 2.05], [2.7, 9.1], [3.1, 10.8], [4.0, 12.6], [4.0, 16.7]];
    const DOME_P = [[4.0, 16.7], [3.4, 17.9], [1.8, 18.7], [0, 19.1]];
    for (const [prof, mat] of [[HEAD_P, this.mHalfSg], [BARREL_P, this.mShellSg],
      [DOME_P, this.mHalfSg]]) {
      const part = vessel(prof, mat);
      part.position.set(s.x, SG_BASE, s.z);
      g.add(part);
    }
    this.sgWater = tube(2.62, 2.62, 1, m.water, 40);
    this.sgWater.material = ownWater(m.water);
    this.sgWater.material.clippingPlanes = this.mHalfSg.clippingPlanes;
    g.add(this.sgWater);
    this.sgTop = new THREE.Mesh(new THREE.CircleGeometry(2.62, 40).rotateX(-Math.PI / 2),
      this.sgWater.material);
    g.add(this.sgTop);

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
    const div = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 4.4), plateIn);
    div.position.set(s.x + bx, SG_TS - 1.4, s.z + bz);
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
      const u = fluidRod([at(w, SG_TS), at(w, top), at(-w, top), at(-w, SG_TS)],
        0.17, w * 0.9);
      g.add(u.mesh);
      this.sgTubes.push(u);
    }
    // the separators the steam has to get through on its way out
    for (const r of [-1.3, 0.2, 1.7]) {
      const sep = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 3.0, 14, 1, true),
        new THREE.MeshStandardMaterial({
          color: 0x8894a0, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide }));
      sep.position.set(s.x + bx + dx * r, SG_BASE + 15.5, s.z + bz + dz * r);
      g.add(sep);
    }

    // ---- pump ----
    const p = L.rcp;
    // On legs, not a plinth: the suction comes up into the underside of the
    // casing, which is how a reactor coolant pump is actually fed, and a
    // plinth would hide the one pipe that explains the pump.
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
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
    // Reactor out at HOT_Y, straight across into the boiler's channel head at
    // the same height. Boiler out one and a half metres lower, straight down
    // into the pump, and straight back across into the reactor. Three runs,
    // one elbow, and the elbow is the crossover leg a real plant has.
    const sgHot = V(s.x + 2.7, HOT_Y, s.z);
    const sgCold = V(s.x + 2.7, XOVER_Y, s.z);
    this.hot = pipe([V(r.x - 3.1, HOT_Y, r.z), sgHot], 1.1, m, { bend: 1.0 });
    g.add(this.hot.group);

    // Down out of the channel head, under, and up into the pump from below,
    // which is how a coolant pump is actually fed. Going in over the top means
    // going through the motor.
    this.cold = pipe([
      sgCold, V(sgCold.x, 5.4, s.z), V(p.x, 5.4, p.z), V(p.x, COLD_Y - 0.9, p.z)
    ], 1.0, m, { bend: 1.6 });
    g.add(this.cold.group);

    this.coldB = pipe([
      V(p.x + 1.85, COLD_Y, p.z), V(r.x - 3.1, COLD_Y, r.z)
    ], 1.0, m, { bend: 1.0 });
    g.add(this.coldB.group);

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

    const pad = slab(26, 1.2, 18, this.stage.mat.deck);
    pad.position.set(t.x, 0.6, t.z);
    g.add(pad);

    // One turbine on one shaft turning one generator. The casing is opened
    // along its own axis, the way the building is, so the wheels are seen
    // standing inside it rather than beside it.
    const AX = 8.4, X0 = t.x - 11, X1 = t.x - 3;
    this.turbLen = X1 - X0;
    const casMat = this.stage.mat.painted.clone();
    casMat.side = THREE.DoubleSide;
    // Only the near half comes off, on the same plane as the building. The far
    // half and the lid stay: an open-topped machine full of steam is a machine
    // the steam would be leaving, and the far wall is what keeps it in.
    casMat.clippingPlanes = this.cut;
    this.turbCut = casMat.clippingPlanes;
    const cas = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.6, X1 - X0, 44, 1, true), casMat);
    cas.rotation.z = Math.PI / 2;
    cas.position.set((X0 + X1) / 2, AX, t.z);
    cas.castShadow = true;
    g.add(cas);
    // The steam chest: where the line actually joins the machine. A pipe that
    // stops a hand's breadth above a curved casing reads as two things near
    // each other, not as one thing feeding another.
    const chest = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 2.6, 20), this.stage.mat.steel);
    chest.position.set(X0 + 0.9, AX + 2.0, t.z);
    g.add(chest);
    const chestFlange = new THREE.Mesh(
      new THREE.CylinderGeometry(1.45, 1.45, 0.3, 20), this.stage.mat.flange);
    chestFlange.position.set(X0 + 0.9, AX + 3.1, t.z);
    g.add(chestFlange);
    const throat = new THREE.Mesh(
      new THREE.CylinderGeometry(1.0, 1.5, 1.6, 20, 1, true), casMat);
    throat.position.set(X0 + 0.9, AX + 0.6, t.z);
    g.add(throat);

    // the rim of the cut, so an opened machine reads as opened and not as burst
    for (const xx of [X0, X1]) {
      const lip = new THREE.Mesh(
        new THREE.TorusGeometry(xx === X0 ? 2.4 : 3.6, 0.16, 6, 32), this.stage.mat.steel);
      lip.rotation.y = Math.PI / 2;
      lip.position.set(xx, AX, t.z);
      g.add(lip);
    }

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 16, 20)
      .rotateZ(Math.PI / 2), this.stage.mat.steel);
    shaft.position.set(t.x - 5, AX, t.z);
    g.add(shaft);

    // Three wheels, each wider than the last, because the steam expands as it
    // gives up its heat. That widening is the whole machine in one picture.
    this.rotor = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x8b9dab, roughness: 0.32, metalness: 0.9 });
    const WHEELS = [[X0 + 1.6, 1.35], [X0 + 4.0, 1.85], [X0 + 6.4, 2.45]];
    for (const [wx, wr] of WHEELS) {
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.5, 20)
        .rotateZ(Math.PI / 2), bladeMat);
      hub.position.set(wx - t.x, 0, 0);
      this.rotor.add(hub);
      // Real blades: thin, twisted out of the plane of the wheel so the steam
      // pushing along the shaft has something to push against, and a shroud
      // ring round the tips. A row of flat boxes reads as gear teeth.
      // Wide-chord blades with a modest pitch, nearly touching, so the wheel
      // reads as a solid fan disc rather than a ring of teeth.
      const n = 22, span = wr - 0.68;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const bl = new THREE.Mesh(new THREE.BoxGeometry(0.6, span, 0.09), bladeMat);
        const mid = 0.68 + span / 2;
        bl.position.set(wx - t.x, Math.cos(ang) * mid, Math.sin(ang) * mid);
        bl.rotation.x = -ang;
        bl.rotateY(0.5);
        this.rotor.add(bl);
      }
      // A translucent disc fills the wheel between hub and rim. Blades seen
      // edge-on are a millimetre wide and disappear, and without the disc a
      // wheel viewed from the side collapsed to two teeth and a floating ring.
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(wr - 0.05, wr - 0.05, 0.3, 40)
        .rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({
        color: 0x6c7d8b, roughness: 0.4, metalness: 0.85,
        transparent: true, opacity: 0.55 }));
      disc.position.set(wx - t.x, 0, 0);
      this.rotor.add(disc);
      const shroud = new THREE.Mesh(new THREE.TorusGeometry(wr, 0.09, 6, 40)
        .rotateY(Math.PI / 2), bladeMat);
      shroud.position.set(wx - t.x, 0, 0);
      this.rotor.add(shroud);
    }
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

    this.gen = slab(7.2, 5.2, 5.2, this.stage.mat.painted);
    this.gen.position.set(t.x + 1.2, AX, t.z);
    g.add(this.gen);
    for (let i = 0; i < 3; i++) {
      // copper, because it is the one machine in the building whose job is
      // electricity, and the bars leaving it are the same metal
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5.5, 5.5), this.stage.mat.copper);
      band.position.set(t.x - 0.6 + i * 1.8, AX, t.z);
      g.add(band);
    }

    // The condenser, cut open on the same plane as everything else: the sea
    // water runs through a bank of tubes, the steam condenses on their
    // outsides, and the water it becomes lies in the bottom, where the
    // feedwater line picks it up. That pool is the whole point of the machine,
    // so it is drawn.
    const CX = (X0 + X1) / 2;
    const condShell = this.stage.mat.steel.clone();
    condShell.side = THREE.DoubleSide;
    condShell.clippingPlanes = this.cut;
    this.cond = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 9, 32, 1, true)
      .rotateZ(Math.PI / 2), condShell);
    this.cond.position.set(CX, 1.8, t.z);
    g.add(this.cond);
    // Glass heads: the tubes end in the water boxes the sea water pipes serve,
    // and that joint is the whole answer to how the sea gets into the machine.
    const condHead = this.stage.mat.glass.clone();
    condHead.clippingPlanes = this.cut;
    for (const xx of [-4.5, 4.5]) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(2.6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)
        .rotateZ(xx > 0 ? -Math.PI / 2 : Math.PI / 2), condHead);
      head.position.set(CX + xx, 1.8, t.z);
      g.add(head);
    }
    // The tube bank the sea water runs through. Each tube is a run of the same
    // moving liquid as every pipe in the plant, so the flow reads through the
    // glass heads and never stops dead at the shell.
    this.condTubes = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 2; col++) {
        const yy = 1.55 + row * 0.72, zz = -0.5 - col * 0.7;
        const u = fluidRod([V(CX - 5.6, yy, t.z + zz), V(CX + 5.6, yy, t.z + zz)], 0.16, 0.4);
        g.add(u.mesh);
        this.condTubes.push(u);
      }
    }
    // the condensate lying in the bottom
    this.condWater = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.7, 3.6), ownWater(m.poolWater));
    this.condWater.material.clippingPlanes = this.cut;
    this.condWater.position.set(CX, 0.45, t.z - 0.4);
    g.add(this.condWater);

    this.legCw = new Leg('sea water', 2.2, 2, { rho: FLUID.rhoCold });
    this.cw = new Circuit('sea water', [this.legCw]);
    // In at the bottom of one head, out at the top, and both lines run to an
    // open intake basin at the edge of the yard, so the water visibly comes
    // from somewhere and goes back there.
    const BAS = t.x + 5;
    // Both lines run above the pad the whole way, one into the bottom water
    // box and one out of the top, so the water can be followed from the basin
    // to the machine and back without either line vanishing into concrete.
    const cwIn = pipe([
      V(BAS + 2.4, 1.6, t.z), V(CX + 5.4, 1.6, t.z), V(CX + 4.6, 1.5, t.z)
    ], 1.4, m, { bend: 1.2 });
    const cwOut = pipe([
      V(CX + 4.6, 2.4, t.z), V(CX + 5.6, 2.7, t.z), V(BAS + 1.4, 2.7, t.z)
    ], 1.4, m, { bend: 1.2 });
    cwIn.leg = cwOut.leg = this.legCw;
    g.add(cwIn.group); g.add(cwOut.group);
    this.pipes.push(cwIn, cwOut);
    // The basin the lines serve: an open box of sea water standing proud of
    // the pad, fed from the sea. The culvert under the yard is drawn leaving
    // it towards the water, so the basin has a source and not just a surface.
    const basWalls = slab(5.2, 2.6, 6.4,
      new THREE.MeshStandardMaterial({ color: 0x4e5a66, roughness: 0.9, side: THREE.BackSide }));
    basWalls.position.set(BAS + 2.6, 1.9, t.z);
    g.add(basWalls);
    this.basinWater = slab(4.6, 1.5, 5.8, ownWater(m.poolWater));
    this.basinWater.position.set(BAS + 2.6, 2.05, t.z);
    g.add(this.basinWater);
    // the culvert to the sea, big and half-buried, running off frame right
    const culvert = pipe([
      V(BAS + 5.4, 0.9, t.z), V(BAS + 16, 0.9, t.z)
    ], 1.8, m, { bend: 1.0 });
    culvert.leg = this.legCw;
    g.add(culvert.group);
    this.pipes.push(culvert);

    // Transformer and lamp stand at the generator's own height, so the wiring
    // between them is straight. Every bend in a cable is one more thing to
    // follow, and there is nothing here that needs one.
    const XF = t.x + 13, POLE = t.x + 19;
    const xf = slab(4.4, 5.2, 4.4, this.stage.mat.painted);
    xf.position.set(XF, AX, t.z);
    g.add(xf);
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.0, 4.8), this.stage.mat.dark);
      fin.position.set(XF - 1.4 + i * 1.4, AX, t.z);
      g.add(fin);
    }
    const xfPlinth = slab(5.0, AX - 2.6, 5.0, this.stage.mat.deck);
    xfPlinth.position.set(XF, (AX - 2.6) / 2, t.z);
    g.add(xfPlinth);

    const poleMat = this.stage.mat.rail;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 12, 8), poleMat);
    pole.position.set(POLE, 6, t.z);
    g.add(pole);
    const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.8, 6)
      .rotateZ(Math.PI / 2), poleMat);
    bracket.position.set(POLE + 0.9, AX + 0.9, t.z);
    g.add(bracket);
    this.lampGlass = new THREE.Mesh(
      new THREE.SphereGeometry(0.66, 18, 12), this.stage.mat.bulb.clone());
    this.lampGlass.position.set(POLE + 1.8, AX + 0.5, t.z);
    g.add(this.lampGlass);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(1.0, 0.7, 18, 1, true), this.stage.mat.painted);
    shade.position.set(POLE + 1.8, AX + 1.15, t.z);
    g.add(shade);
    this.lampLight = new THREE.PointLight(0xffd9a0, 0, 24, 2);
    this.lampLight.position.set(POLE + 1.8, AX + 0.1, t.z);
    g.add(this.lampLight);

    this.busMat = new THREE.MeshStandardMaterial({
      color: 0x6a5a4c, roughness: 0.45, metalness: 0.9,
      emissive: new THREE.Color(0x140a02), emissiveIntensity: 0
    });
    this.bus = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const dy = i ? 0.75 : -0.75;
      this.bus.add(pipeLike([
        V(t.x + 4.9, AX + dy, t.z), V(XF - 2.1, AX + dy, t.z)], 0.19, this.busMat));
      this.bus.add(pipeLike([
        V(XF + 2.1, AX + dy, t.z), V(POLE - 0.2, AX + dy, t.z)], 0.13, this.busMat));
    }
    g.add(this.bus);

    // Boiler, over the containment, down beside the turbine hall and in
    // through the end of the casing. It has to arrive somewhere or the steam
    // is going nowhere.
    // Out of the top of the boiler, up under the dome, out through the wall
    // and down into the top of the turbine's inlet end.
    this.steam = pipe([
      V(s.x, SG_BASE + 18.6, s.z), V(s.x, 33, s.z),
      V(X0 + 0.9, 33, t.z), V(X0 + 0.9, AX + 2.9, t.z)
    ], 1.2, m, { bend: 3.0, steam: true });
    this.steam.leg = this.legSteam;
    g.add(this.steam.group);

    // What comes out of the turbine has to go somewhere: down the neck into
    // the condenser, where it turns back into water.
    this.legExh = new Leg('to the condenser', 1.9, 1, { rho: 12, kind: 'steam' });
    this.exh = pipe([
      V((X0 + X1) / 2, 6.2, t.z), V((X0 + X1) / 2, 3.4, t.z)
    ], 1.7, m, { bend: 0.8, steam: true });
    this.exh.leg = this.legExh;
    g.add(this.exh.group);

    // Back the other way at its own height, so the two halves of the second
    // circuit run as one straight pair across the top of the picture: white
    // going right to the turbine, blue coming back to the boiler.
    // Out of the bottom of the condenser, up outside the turbine hall, back
    // across the picture above the steam line, and into the boiler's side.
    // The two runs of the second circuit read as a pair going opposite ways,
    // and they never touch: steam rides at 33, feedwater at 36.5.
    this.feed = pipe([
      V(CX - 4.6, 1.6, t.z), V(X0 - 3.4, 1.6, t.z), V(X0 - 3.4, 36.5, t.z),
      V(s.x - 5.2, 36.5, s.z), V(s.x - 5.2, SG_BASE + 13.6, s.z),
      V(s.x - 3.4, SG_BASE + 13.6, s.z)
    ], 0.7, m, { bend: 2.4 });
    this.feed.leg = this.legFeed;
    g.add(this.feed.group);
    // and the water arriving inside the shell, falling to the surface, so the
    // line coming in at the top left visibly DOES something
    this.feedPour = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.3, 2.6, 10), liquidMaterial(0.5));
    this.feedPour.material.normalMap.repeat.set(2, 6);
    this.feedPour.position.set(s.x - 2.4, SG_BASE + 12.2, s.z);
    g.add(this.feedPour);
    this.secondary.legs.push(this.legExh);
    this.pipes.push(this.steam, this.exh, this.feed);

    // the stack the containment can be vented through
    // The stack is the vent line itself, standing up on a frame. A fat grey
    // column beside the building teaches nothing and takes the skyline; a pipe
    // going up says what it is, which is the one way out of the containment.
    const st = L.stack;
    const stackBase = tube(1.5, 1.9, 1.4, this.stage.mat.deck, 20);
    stackBase.position.set(st.x, 0.7, st.z);
    g.add(stackBase);
    const mouth = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.55, 1.6, 20, 1, true),
      this.stage.mat.painted);
    mouth.material.side = THREE.DoubleSide;
    mouth.position.set(st.x, st.h + 0.4, st.z);
    g.add(mouth);
    this.vent = pipe([
      V(R_IN * 0.72, 22, -R_IN * 0.5), V(st.x, 22, st.z), V(st.x, st.h, st.z)
    ], 0.8, m, { bend: 2.4, steam: true });
    this.legVent = new Leg('vent', 0.8, 1, { rho: FLUID.rhoSteam, kind: 'steam' });
    this.vent.leg = this.legVent;
    this.ventCircuit = new Circuit('vent', [this.legVent]);
    g.add(this.vent.group);
    this.pipes.push(this.vent);
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
      grav.leg = this.legGrav; g.add(grav.group);
      const recirc = pipe([
        V(GX - 3.2, 0.8, r.z), V(GX - 3.2, 18.6, r.z), TEE.clone()
      ], 0.5, m, { bend: 1.4 });
      recirc.leg = this.legRecirc; g.add(recirc.group);
      // Into the top of the vessel, not into its side: the water has to be
      // seen arriving somewhere, and a line that stops against a wall is a
      // line that goes nowhere.
      const IN = V(GX, r.base + 15.9, r.z);
      const fill = pipe([TEE.clone(), V(IN.x, IN.y + 0.9, IN.z)], 0.5, m, { bend: 0.6 });
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
      const pad = slab(t.w + 2, 0.5, t.d + 2, this.stage.mat.deck);
      pad.position.set(t.x, 0.25, t.z);
      g.add(pad);
      const walls = slab(t.w, t.h, t.d,
        new THREE.MeshStandardMaterial({ color: 0x4e5a66, roughness: 0.9, side: THREE.BackSide }));
      walls.position.set(t.x, t.h / 2 + 0.5, t.z);
      g.add(walls);
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const lip = slab(ax ? 0.5 : t.w + 1, 0.5, az ? 0.5 : t.d + 1, this.stage.mat.painted);
        lip.position.set(t.x + ax * (t.w / 2 + 0.25), t.h + 0.5, t.z + az * (t.d / 2 + 0.25));
        g.add(lip);
      }
      this.tankWater = slab(t.w - 0.8, 1, t.d - 0.8, ownWater(this.m.poolWater));
      this.tankWater.scale.y = 3.0;
      this.tankWater.position.set(t.x, 0.5 + 1.5, t.z);
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
        V(t.x + t.w / 2 - 0.8, 0.6, t.z), V(e.x, 0.6, e.z), V(e.x, 1.0, e.z)
      ], 0.5, m, { bend: 1.2 });
      suct.leg = this.legSuct; g.add(suct.group);
      // Along the floor and straight up into the cold leg. It has to pass
      // under the boiler, which is why the boiler stands on legs.
      const inj = pipe([
        V(e.x + 1.2, 1.7, e.z), V(r.x - 6.0, 1.7, r.z),
        V(r.x - 6.0, COLD_Y, r.z)
      ], 0.4, m, { bend: 1.6 });
      inj.leg = this.legInj; g.add(inj.group);
      this.pipes.push(suct, inj);
    }
  }
}

// ---------------------------------------------------------------------------
// per frame: solve the flows, step the machines, and let the geometry follow
// ---------------------------------------------------------------------------
import { ratedMdot, naturalMdot, THERMAL_W } from '../flow.js';
import { Plume } from './plume.js';

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

    // ---- machines: torque in, angle out ----
    const vOut = this.legCold.v;
    this.mach.step(dt, {
      pumpDriven: (st.s.rcp || 0) > 0.01,
      pumpTarget: (vOut / 1.62) * 0.6,
      steamTorque: (this.secondary.mdot || 0) * 0.023,
      loadCoef: 2.6,
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
      const mw = this.spin > 4 ? clamp(this.secondary.mdot / 1900, 0, 1) : 0;
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
    tintWater(this.pumpWater.material,
      waterColor(loopHeat(p.Tclad - FLUID.dTcore), new THREE.Color()), 0);
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
      const moving = Math.abs(v) > 0.02;
      const mat = q.mat;
      // The ripples on the liquid travel with it, at the leg's real velocity.
      mat.normalMap.offset.x -= v * dt / 2.4;
      // and so do the bubbles in it
      // In steam the carried droplets are the whole story, so they are drawn
      // big; in water they are bubbles and stay small.
      q.bub.advance(dt, v, q.len, moving ? (leg.kind === 'steam' ? 2.6 : 1) : 0.0001);
      q.bub.mesh.visible = moving;

      if (leg.kind === 'steam') {
        // Vapour scatters instead of refracting, so it is a body you look at
        // rather than through: pale, torn, and moving fast enough to see.
        mat.alphaMap.offset.x -= v * dt * 0.25;
        mat.opacity = moving ? 0.72 : 0.12;
        mat.emissiveIntensity = moving ? 0.42 : 0.05;
      } else {
        // Everything downstream of a heat exchanger is drawn cold, everything
        // straight off the fuel is drawn hot. That colour change, across the
        // boiler and across the pool coil, is the heat leaving the reactor.
        const u = leg.name === 'feedwater' || leg.name === 'back from the pool'
          || leg.name === 'suction' || leg.name === 'injection' || leg.name === 'gravity'
          || leg.name === 'sea water' || leg.name === 'coil out'
          ? 0.06
          : (leg.name === 'cold leg' || leg.name === 'boiler tubes') ? cold : heat;
        // Lightened towards white, because the gradient replaces the base
        // colour and a fully saturated one turns the water to poster paint.
        waterColor(u, cTmp).lerp(WHITE, 0.25);
        setGradient(mat, cTmp);
        waterColor(u, cTmp);
        mat.attenuationColor.copy(cTmp);
        mat.color.set(0xffffff);
        mat.transmission = 1;
        mat.attenuationDistance = q.dia * 2.4;
        mat.roughness = 0.045;
        mat.thickness = q.dia * 0.9;
        mat.ior = 1.333;
        mat.opacity = 1;
        mat.emissive.copy(cTmp).multiplyScalar(0.10);
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
      const hotC = waterColor(heat, new THREE.Color()).lerp(WHITE, 0.25);
      const coldC = waterColor(cold, new THREE.Color()).lerp(WHITE, 0.25);
      const wet = st.lvl > 0.02;
      for (const u of this.sgTubes || []) {
        setGradient(u.mat, hotC, coldC);
        // The colour lives entirely in the gradient here. Tinting the volume
        // as well fights it and turns the hot end brown.
        u.mat.attenuationColor.setHex(0xffffff);
        u.mat.normalMap.offset.x -= this.legTubes.v * dt / 2.4;
        u.mat.emissive.copy(coldC).multiplyScalar(0.10);
        u.mesh.visible = wet;
      }
      // the condenser's tube bank runs at the sea water leg's own speed
      const cwC = waterColor(0.05, new THREE.Color()).lerp(WHITE, 0.25);
      for (const u2 of this.condTubes) {
        setGradient(u2.mat, cwC);
        u2.mat.attenuationColor.setHex(0xffffff);
        u2.mat.normalMap.offset.x -= this.legCw.v * dt / 2.4;
      }
      // and the feedwater falling to the surface inside the boiler's dome
      const feeding = Math.abs(this.legFeed.v) > 0.02;
      this.feedPour.visible = feeding;
      if (feeding) {
        this.feedPour.material.normalMap.offset.y -= dt * 2.2;
        setGradient(this.feedPour.material,
          waterColor(0.06, new THREE.Color()).lerp(WHITE, 0.3));
      }
      if (this.poolCoil) {
        const on = (st.s.prhr || 0) > 0;
        setGradient(this.poolCoil.mat, on ? hotC : coldC, coldC);
        this.poolCoil.mat.attenuationColor.setHex(0xffffff);
        this.poolCoil.mat.normalMap.offset.x -= this.legCoil.v * dt / 2.4;
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
    waterColor(mean, cTmp);
    tintWater(this.coreWater.material, cTmp, dt);
    // Cold in at the bottom from the cold leg, hot out at the top, and the top
    // has to MATCH the hot leg leaving beside it: the pipe is the same water.
    // The base colour is left white so the gradient is the only tint; tinting
    // both multiplies them together and turns the hot end to mud.
    this.coreWater.material.color.setHex(0xffffff);
    setGradient(this.coreWater.material,
      waterColor(cold, new THREE.Color()).lerp(WHITE, 0.35),
      waterColor(heat, new THREE.Color()).lerp(WHITE, 0.25));
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
    this.surfSg.step(dt, { boil: carrying ? 0.5 : 0.05 });
    this.riseSg.step(dt, SG_TS + 0.2, Math.max(0.4, sgH), carrying ? 0.85 : 0.08, L.sg.x, L.sg.z, 0.42);
    ripple(this.sgTop, this.surfSg, 2.62);
    // The shell side of the boiler is at its own boiling point, which is what
    // the feed line arriving cold and the steam line leaving hot are about.
    tintWater(this.sgWater.material, waterColor(carrying ? 0.30 : 0.10, cTmp), dt);

    // The gravity valve: shut and green while nothing needs it, open and amber
    // once it is doing the work. It is the whole design argument in one part.
    if (this.gravValve) {
      const open = Math.abs(this.legFill.v) > 0.02;
      this.gravValve.material.emissive.setHex(open ? 0x4a2a05 : 0x102616);
      this.gravValve.material.color.setHex(open ? 0xd9a24a : 0x8d99a5);
      this.fillPour.visible = open && st.lvl < 0.995;
      if (open) {
        this.fillPour.material.normalMap.offset.y -= dt * 2.4;
        setGradient(this.fillPour.material, waterColor(0.06, cTmp).clone());
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
      waterColor(warm, cTmp);
      tintWater(this.poolWater.material, cTmp, dt);
    }

    if (this.tankWater) tintWater(this.tankWater.material, waterColor(0.04, cTmp), dt);

    // ---- the water that got out of the tank and is lying on the floor ----
    if (this.sumpWater) {
      const kg = p.ctmtSump || 0;
      const dep = clamp(kg / 2.1e6, 0, 1) * 2.6;
      this.sumpWater.visible = dep > 0.04;
      this.sumpWater.scale.y = Math.max(0.05, dep);
      this.sumpWater.position.set(0, dep / 2 + 0.05, 0);
      tintWater(this.sumpWater.material, waterColor(0.03, cTmp), dt);
      this.sumpWater.material.emissiveIntensity = 0.34;
      this.sumpWater.material.attenuationDistance = 3.2;
      const leaking = p.irwstCracked && p.irwst > 1e5;
      this.leakJet.visible = leaking;
      if (leaking) {
        this.leakJet.material.normalMap.offset.y += dt * 2.2;
        tintWater(this.leakJet.material, waterColor(0.06, cTmp), 0);
      }
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
      tintWater(this.eccsWater.material, waterColor(0.05, cTmp), 0);
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
    this.plumes.breach.step(dt, p.ctmtIntact ? 0 : 34,
      Math.sin(bA) * (R_IN + 1), 16, Math.cos(bA) * (R_IN + 1),
      { spread: 5, vy: 7, vx: 4, life: 6, grow: 4, alpha: 0.5, buoy: 1.4 });
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
