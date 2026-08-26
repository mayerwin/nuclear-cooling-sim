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
import { liquidMaterial, steamMaterial, Riser, Bubbles, frameOf } from './fluid.js';
import { tempColor, waterColor, heatOf, loopHeat } from './materials.js';
import { Leg, Circuit, Surface, FLUID, clamp, lerp, hash1 } from '../flow.js';
import { Machines } from '../machines.js';

const R_IN = 15.4, WALL = 1.0, SHELL_H = 31, DOME_R = R_IN + WALL;

// where everything stands
export const L = {
  // The reactor stands in the quarter that is cut open, so it is the thing you
  // see first. Everything else is arranged round it.
  rpv:  { x: 5.5, z: 5.0, r: 3.2, base: 2.6, h: 17.0 },
  sg:   { x: -6.5, z: -5.5 },
  rcp:  { x: -6.0, z: 6.5 },
  pool: { x: 1.5, z: -8.0, w: 11, d: 9, h: 5.2, y: 20.5 },
  turb: { x: 28, z: 6 },
  tank: { x: -20, z: 15, w: 11, d: 7, h: 6 },
  eccs: { x: -11, z: 20 },
  stack:{ x: 18, z: -17, h: 30 }
};
const HOT_Y = 13.0, COLD_Y = 8.2;
// The boiler's channel head is at the bottom, which is where both of the
// reactor's pipes meet it, and the tube sheet is the floor of the shell.
const SG_NOZ = 4.2, SG_TS = 6.0;
const W_LO = L.rpv.base + 1.0, W_HI = L.rpv.base + 12.2;
export const FUEL_Y0 = L.rpv.base + 2.3;
export const FUEL_TOP_FRAC = 0.71;
export const FUEL_Y1 = W_LO + (W_HI - W_LO) * FUEL_TOP_FRAC;
const waterY = (lvl) => W_LO + (W_HI - W_LO) * clamp(lvl, 0, 1);

const RPV_PROFILE = [
  [0, 0], [1.6, 0.18], [2.7, 1.0], [3.2, 2.6], [3.2, 13.5],
  [3.0, 14.9], [1.9, 16.3], [0, 17.0]
];
const SG_PROFILE = [
  [0, 0], [1.4, 0.2], [2.4, 1.2], [2.7, 2.7], [2.7, 12.0],
  [3.1, 14.2], [4.0, 16.6], [4.0, 22.0], [3.4, 23.6], [1.8, 24.6], [0, 25.1]
];

// A body of water takes its colour from what the light loses on the way
// through it, not from a coat of paint on the outside. Its surface ripples
// drift, because still water in a lit room never looks perfectly still.
function ownWater(src) {
  const c = src.clone();
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

// A bare run of metal with proper elbows. Pipes carry fluid and get the whole
// fluid treatment; a busbar carries current and just needs to be a solid.
function pipeLike(pts, r, mat, bend) {
  const path = roundedPath(pts, bend == null ? r * 3 : bend);
  const seg = Math.max(16, Math.round(path.getLength() * 1.4));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, seg, r, 8, false), mat);
  mesh.castShadow = true;
  return mesh;
}

export class Unit {
  constructor(plant, stage, worldX) {
    this.plant = plant;
    this.stage = stage;
    this.passive = plant.mode === 'passive' || /passive/i.test(plant.mode);
    this.root = new THREE.Group();
    this.root.position.x = worldX;
    this.worldX = worldX;

    // Clipping is in world space, so each unit gets its own pair of planes.
    this.cut = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), worldX),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
    ];
    const m = stage.mat;
    const clip = (src) => {
      const c = src.clone();
      c.clippingPlanes = this.cut; c.clipIntersection = true; c.clipShadows = true;
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
      bubble: m.bubble, flange: m.flange
    };
    // Vessels are cut in half on their own axis, not by the building's wedge.
    const halfPlane = (x, z) => {
      const n = new THREE.Vector3(-1, 0, -1).normalize();
      return [new THREE.Plane(n, -(n.x * (x + worldX) + n.z * z))];
    };
    this.mHalfRpv = m.glass.clone();
    this.mHalfRpv.clippingPlanes = halfPlane(L.rpv.x, L.rpv.z);
    this.mHalfSg = m.glass.clone();
    this.mHalfSg.clippingPlanes = halfPlane(L.sg.x, L.sg.z);
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

    this.riseCore = new Riser(2.1, 150, stage.mat.bubble);
    this.root.add(this.riseCore.mesh);
    this.riseSg = new Riser(2.3, 150, stage.mat.bubble);
    this.root.add(this.riseSg.mesh);
    this.risePool = new Riser(3.4, 110, stage.mat.bubble);
    this.root.add(this.risePool.mesh);

    this.surfCore = new Surface(30, { c: 3.4, damp: 1.4 });
    this.surfSg = new Surface(22, { c: 3.0, damp: 1.6 });
    this.surfPool = new Surface(30, { c: 2.2, damp: 0.9 });
    this.mach = new Machines();
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
    // In the quarter facing the viewer that the cutaway leaves standing, so
    // when the containment goes you are looking straight at the hole. A breach
    // on the far wall is a breach nobody sees.
    const bA = 5.5, halfW = 0.75;
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

    this.skirt = tube(r.r * 0.85, r.r * 0.95, r.base, this.stage.mat.painted, 40);
    this.skirt.position.set(r.x, r.base / 2, r.z);
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

    // The route the water takes: in at the nozzle, down the gap between the
    // barrel and the wall, round the bottom and up through the fuel. Two
    // columns of carried bubbles going down and the boiling column going up
    // are what make that route, and its speed, something you can watch.
    const RD = Math.SQRT1_2;
    this.downFlow = [];
    for (const sgn of [1, -1]) {
      const px = r.x + RD * 2.58 * sgn, pz = r.z - RD * 2.58 * sgn;
      const fr = frameOf(roundedPath([V(px, W_HI - 0.4, pz), V(px, W_LO + 0.6, pz)], 0.2), 40);
      const b = new Bubbles(fr, 0.16, 26, m.bubble);
      g.add(b.mesh);
      this.downFlow.push(b);
    }
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
    const sgSkirt = tube(2.3, 2.6, 2.0, this.stage.mat.painted, 32);
    sgSkirt.position.set(s.x, 1.0, s.z);
    g.add(sgSkirt);
    this.sgShell = vessel(SG_PROFILE, this.mShellSg);
    this.sgShell.position.set(s.x, 2.0, s.z);
    g.add(this.sgShell);
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
    const BACK = 0.32, bx = -Math.SQRT1_2 * BACK, bz = -Math.SQRT1_2 * BACK;
    const plateIn = new THREE.MeshStandardMaterial({
      color: 0x7f8b96, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide });
    // the divider stands across the channel head, edge on to the cut
    const div = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 4.4), plateIn);
    div.position.set(s.x + bx, SG_TS - 1.4, s.z + bz);
    div.rotation.y = -Math.PI / 4;
    g.add(div);

    // The bundle, in section: nested U-tubes in the plane of the cut. The side
    // the water goes up is drawn hot, the side it comes down is drawn cold, so
    // the heat leaving the reactor is a colour change you can point at.
    this.sgHotMat = new THREE.MeshStandardMaterial({
      color: 0xff7a3c, roughness: 0.34, metalness: 0.55,
      emissive: new THREE.Color(0x3a1204), emissiveIntensity: 0.6
    });
    this.sgColdMat = new THREE.MeshStandardMaterial({
      color: 0x3f9ede, roughness: 0.34, metalness: 0.55,
      emissive: new THREE.Color(0x05203a), emissiveIntensity: 0.6
    });
    // d runs along the cut plane, so the U's lie flat in the face of the cut
    const dx = Math.SQRT1_2, dz = -Math.SQRT1_2;
    for (let k = 0; k < 5; k++) {
      const w = 0.6 + k * 0.45, top = SG_TS + 7.0 + w * 0.9;
      const at = (o, y) => V(s.x + bx + dx * o, y, s.z + bz + dz * o);
      g.add(pipeLike([at(-w, SG_TS), at(-w, top), at(0, top)], 0.16, this.sgHotMat, w * 0.9));
      g.add(pipeLike([at(0, top), at(w, top), at(w, SG_TS)], 0.16, this.sgColdMat, w * 0.9));
    }
    // the separators the steam has to get through on its way out
    for (const r of [-1.3, 0.2, 1.7]) {
      const sep = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 3.0, 14, 1, true),
        new THREE.MeshStandardMaterial({
          color: 0x8894a0, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide }));
      sep.position.set(s.x + bx + dx * r, 2 + 19.0, s.z + bz + dz * r);
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
    this.pumpCase = tube(1.9, 1.9, 2.2, this.stage.mat.steel, 40);
    this.pumpCase.position.set(p.x, COLD_Y, p.z);
    g.add(this.pumpCase);
    // The impeller, seen through the casing. Thick vanes, and one of them
    // painted, because a wheel of identical blades turning is a wheel you
    // cannot tell is turning.
    this.impeller = new THREE.Group();
    const vaneMat = new THREE.MeshStandardMaterial({ color: 0x9fb3c2, roughness: 0.35, metalness: 0.9 });
    const markMat = new THREE.MeshStandardMaterial({ color: 0xffa23c, roughness: 0.4, metalness: 0.5 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const curve = new THREE.CatmullRomCurve3([
        V(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45),
        V(Math.cos(a + 0.5) * 1.05, 0, Math.sin(a + 0.5) * 1.05),
        V(Math.cos(a + 1.0) * 1.6, 0, Math.sin(a + 1.0) * 1.6)]);
      const vane = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.17, 8, false),
        i === 0 ? markMat : vaneMat);
      this.impeller.add(vane);
    }
    this.impeller.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.4, 18), vaneMat));
    this.impeller.position.set(p.x, COLD_Y, p.z);
    g.add(this.impeller);
    // the shaft, so the motor above is visibly what turns it
    const pShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 3.2, 14), this.stage.mat.steel);
    pShaft.position.set(p.x, COLD_Y + 1.9, p.z);
    g.add(pShaft);
    // The volute is full of water, and the impeller turns in it. A pump that
    // shows a dry impeller is a fan.
    this.pumpWater = tube(1.72, 1.72, 2.0, liquidMaterial(1.7), 40);
    this.pumpWater.material.normalMap.repeat.set(6, 2);
    // shallow enough to see the impeller turning in it
    this.pumpWater.material.attenuationDistance = 14;
    this.pumpWater.position.set(p.x, COLD_Y, p.z);
    g.add(this.pumpWater);
    const casing = tube(1.9, 1.9, 2.2, null, 40);
    casing.material = new THREE.MeshStandardMaterial({
      color: 0xa8b6c2, roughness: 0.45, metalness: 0.4, side: THREE.BackSide });
    casing.position.set(p.x, COLD_Y, p.z);
    g.add(casing);
    this.pumpCase.visible = false;
    const motor = tube(1.1, 1.1, 3.4, this.stage.mat.painted, 32);
    motor.position.set(p.x, COLD_Y + 3.4, p.z);
    g.add(motor);
    this.pumpLamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), this.m.lamp);
    this.pumpLamp.position.set(p.x, COLD_Y + 5.3, p.z);
    g.add(this.pumpLamp);
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
    const D = Math.SQRT1_2;
    const nozHot = V(s.x + D * 2.6, SG_NOZ, s.z - D * 2.6);
    const nozCold = V(s.x - D * 2.6, SG_NOZ, s.z + D * 2.6);
    this.hot = pipe([
      V(r.x, HOT_Y, r.z), V(r.x, HOT_Y, s.z - 4.7),
      V(nozHot.x + D * 2.8, HOT_Y, nozHot.z - D * 2.8),
      V(nozHot.x + D * 2.8, SG_NOZ, nozHot.z - D * 2.8), nozHot
    ], 1.1, m, { bend: 2.2 });
    g.add(this.hot.group);

    // and back out of the other half of the channel head, up into the pump
    this.cold = pipe([
      nozCold,
      V(nozCold.x - D * 2.9, SG_NOZ, nozCold.z + D * 2.9),
      V(nozCold.x - D * 2.9, SG_NOZ, p.z),
      V(p.x, SG_NOZ, p.z), V(p.x, COLD_Y - 1.3, p.z)
    ], 1.0, m, { bend: 1.5 });
    g.add(this.cold.group);

    this.coldB = pipe([
      V(p.x + 1.9, COLD_Y, p.z), V(r.x - 3.6, COLD_Y, r.z), V(r.x - 3.2, COLD_Y, r.z)
    ], 1.0, m, { bend: 2.4 });
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
    casMat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), AX + 0.9)];
    this.turbCut = casMat.clippingPlanes;
    const cas = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.6, X1 - X0, 44, 1, true), casMat);
    cas.rotation.z = Math.PI / 2;
    cas.position.set((X0 + X1) / 2, AX, t.z);
    cas.castShadow = true;
    g.add(cas);
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
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xc9d8e4, roughness: 0.28, metalness: 0.92 });
    const WHEELS = [[X0 + 1.6, 1.35], [X0 + 4.0, 1.85], [X0 + 6.4, 2.45]];
    for (const [wx, wr] of WHEELS) {
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.55, 20)
        .rotateZ(Math.PI / 2), bladeMat);
      hub.position.set(wx - t.x + 0, 0, 0);
      this.rotor.add(hub);
      const n = 26;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const bl = new THREE.Mesh(new THREE.BoxGeometry(0.42, wr - 0.7, 0.1), bladeMat);
        bl.position.set(wx - t.x, Math.cos(ang) * (wr * 0.5 + 0.35), Math.sin(ang) * (wr * 0.5 + 0.35));
        bl.rotation.x = -ang + 0.55;
        this.rotor.add(bl);
      }
    }
    this.rotor.position.set(t.x, AX, t.z);
    g.add(this.rotor);

    // The steam inside the casing. It arrives at the narrow end, does work on
    // the wheels and leaves colder, wetter and much larger, so the body of
    // vapour is a cone that widens along the machine.
    this.turbSteam = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2, 2.1, X1 - X0 - 0.2, 32, 1, true).rotateZ(-Math.PI / 2),
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
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5.5, 5.5), this.stage.mat.dark);
      band.position.set(t.x - 0.6 + i * 1.8, AX, t.z);
      g.add(band);
    }

    // The condenser: the steam gives its heat to sea water running through a
    // second set of tubes and turns back into water. That sea water is the
    // ultimate heat sink, so it is drawn: when it stops, the reason the plant
    // is in trouble is on the screen.
    this.cond = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 9, 32, 1, true)
      .rotateX(Math.PI / 2), this.stage.mat.steel);
    this.cond.position.set(t.x - 4, 1.4, t.z);
    this.cond.material.side = THREE.DoubleSide;
    g.add(this.cond);
    for (const zz of [-4.5, 4.5]) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(2.7, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)
        .rotateX(zz > 0 ? Math.PI / 2 : -Math.PI / 2), this.stage.mat.painted);
      head.position.set(t.x - 4, 1.4, t.z + zz);
      g.add(head);
    }
    this.legCw = new Leg('sea water', 2.2, 2, { rho: FLUID.rhoCold });
    this.cw = new Circuit('sea water', [this.legCw]);
    const cwIn = pipe([
      V(t.x - 8.5, 1.4, t.z - 16), V(t.x - 8.5, 1.4, t.z + 4.5), V(t.x - 6.4, 1.4, t.z + 4.5)
    ], 2.2, m, { bend: 2.0 });
    const cwOut = pipe([
      V(t.x - 6.4, 1.4, t.z - 4.5), V(t.x - 0.6, 1.4, t.z - 4.5), V(t.x - 0.6, 1.4, t.z - 16)
    ], 2.2, m, { bend: 2.0 });
    cwIn.leg = cwOut.leg = this.legCw;
    g.add(cwIn.group); g.add(cwOut.group);
    this.pipes.push(cwIn, cwOut);

    const xf = slab(4.4, 3.6, 4.4, this.stage.mat.painted);
    xf.position.set(t.x + 13, 1.8, t.z - 3);
    g.add(xf);
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.6, 4.6), this.stage.mat.dark);
      fin.position.set(t.x + 11.6 + i * 1.4, 1.8, t.z - 3);
      g.add(fin);
    }
    // The line leaves towards the back of the site, not across the picture at
    // the other station.
    const pylonMat = this.stage.mat.rail;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 14, 8), pylonMat);
    mast.position.set(t.x + 13, 7, t.z - 11);
    g.add(mast);
    const armY = [11, 13.4];
    for (const yy of armY) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 6).rotateX(Math.PI / 2), pylonMat);
      arm.position.set(t.x + 13, yy, t.z - 11);
      g.add(arm);
    }

    // The electricity has to visibly leave the machine that made it: three
    // busbars out of the generator, into the transformer, up to the pylon and
    // away. A generator wired to nothing is not making anything. They are dark
    // conductors, not neon: the reactor is the subject of the picture.
    this.busMat = new THREE.MeshStandardMaterial({
      color: 0x6a5a4c, roughness: 0.45, metalness: 0.9,
      emissive: new THREE.Color(0x140a02), emissiveIntensity: 0
    });
    this.bus = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const dz = (i - 1) * 1.1;
      const run = pipeLike([
        V(t.x + 4.6, 8.4 + (i - 1) * 0.8, t.z),
        V(t.x + 7.6, 8.4 + (i - 1) * 0.8, t.z),
        V(t.x + 7.6, 4.2, t.z - 3 + dz),
        V(t.x + 10.9, 4.2, t.z - 3 + dz)
      ], 0.22, this.busMat);
      this.bus.add(run);
    }
    // transformer to pylon, then off towards the back of the site
    for (let i = 0; i < 4; i++) {
      const yy = armY[i >> 1], dz = (i % 2 ? 1 : -1) * 2.3;
      this.bus.add(pipeLike([
        V(t.x + 13 + (i % 2 ? 0.7 : -0.7), 3.4, t.z - 5.2),
        V(t.x + 13 + dz * 0.5, yy - 0.5, t.z - 8),
        V(t.x + 13 + dz, yy - 0.3, t.z - 11)
      ], 0.11, this.busMat, 1.2));
      const away = pipeLike([
        V(t.x + 13 + dz, yy - 0.3, t.z - 11),
        V(t.x + 13 + dz, yy - 3.2, t.z - 30)
      ], 0.11, this.busMat, 1.2);
      away.userData.noFrame = true;
      this.bus.add(away);
    }
    g.add(this.bus);

    // Boiler, over the containment, down beside the turbine hall and in
    // through the end of the casing. It has to arrive somewhere or the steam
    // is going nowhere.
    // Out of the top of the boiler, up under the dome, out through the wall
    // and down into the top of the turbine's inlet end.
    this.steam = pipe([
      V(s.x, 2 + 24.0, s.z), V(s.x, 30, s.z), V(s.x, 30, t.z - 13),
      V(X0, 30, t.z - 13), V(X0, 30, t.z), V(X0, AX + 2.4, t.z)
    ], 1.2, m, { bend: 3.0, steam: true });
    this.steam.leg = this.legSteam;
    g.add(this.steam.group);

    // What comes out of the turbine has to go somewhere: down the neck into
    // the condenser, where it turns back into water.
    this.legExh = new Leg('to the condenser', 2.6, 1, { rho: 12, kind: 'steam' });
    this.exh = pipe([
      V(t.x - 4, 6.2, t.z), V(t.x - 4, 2.0, t.z)
    ], 2.6, m, { bend: 0.8, steam: true });
    this.exh.leg = this.legExh;
    g.add(this.exh.group);

    this.feed = pipe([
      V(t.x - 4, -1.0, t.z + 4.6), V(t.x - 4, 1.4, t.z + 9),
      V(s.x - 8, 1.4, t.z + 9), V(s.x - 8, 1.4, s.z), V(s.x - 4.0, 1.4, s.z),
      V(s.x - 4.0, 2 + 6.0, s.z), V(s.x - 2.7, 2 + 6.0, s.z)
    ], 0.7, m, { bend: 2.2 });
    this.feed.leg = this.legFeed;
    g.add(this.feed.group);
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
      const up = pipe([
        V(r.x - 3.2, HOT_Y, r.z + 1.6), V(r.x - 5, HOT_Y, r.z + 1.6),
        V(r.x - 5, p.y + 1.6, r.z + 1.6), V(r.x - 5, p.y + 1.6, p.z + p.d / 2 - 2)
      ], 0.45, m, { bend: 1.6 });
      up.leg = this.legPrhrUp; g.add(up.group);
      // The coil sits low enough to stay under the water while there is any
      // water, because a coil in the air is not taking heat out of anything.
      const COIL_Y = p.y + 1.0;
      const coilPts = [];
      let cx = p.x + p.w / 2 - 2.5, side = 1;
      while (cx > p.x - p.w / 2 + 2.0) {
        coilPts.push(V(cx, COIL_Y, p.z + side * (p.d / 2 - 2.2)));
        coilPts.push(V(cx, COIL_Y, p.z - side * (p.d / 2 - 2.2)));
        cx -= 1.5; side *= -1;
      }
      // drawn in two halves, so the water going into it hot and coming out
      // cold is the same colour change as the boiler's
      const half = Math.max(2, Math.round(coilPts.length / 2));
      const coilA = pipe(coilPts.slice(0, half + 1), 0.4, m, { bend: 0.7 });
      coilA.leg = this.legCoil; g.add(coilA.group);
      const coilB = pipe(coilPts.slice(half), 0.4, m, { bend: 0.7 });
      coilB.leg = this.legCoilOut; g.add(coilB.group);
      const dn = pipe([
        coilPts[coilPts.length - 1].clone(),
        V(p.x - p.w / 2 + 1, COIL_Y, r.z - 1.4),
        V(r.x + 5.5, COIL_Y, r.z - 1.6), V(r.x + 5.5, COLD_Y, r.z - 1.6),
        V(r.x + 3.2, COLD_Y, r.z - 1.6)
      ], 0.45, m, { bend: 1.6 });
      dn.leg = this.legPrhrDn; g.add(dn.group);
      this.pipes.push(up, coilA, coilB, dn);

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
      this.leakJet.position.set(p.x + p.w / 2 - 1.0, (p.y - 0.2) / 2, p.z + p.d / 2 - 0.9);
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
      const TEE = V(p.x + 3, 12.6, p.z + p.d / 2 - 1.5);
      const grav = pipe([
        V(p.x + 3, p.y + 0.5, p.z + p.d / 2 - 1.5), TEE.clone()
      ], 0.5, m, { bend: 1.4 });
      grav.leg = this.legGrav; g.add(grav.group);
      const recirc = pipe([
        V(p.x + 3, 0.8, p.z + p.d / 2 - 1.5), TEE.clone()
      ], 0.5, m, { bend: 1.4 });
      recirc.leg = this.legRecirc; g.add(recirc.group);
      const fill = pipe([
        TEE.clone(), V(r.x - 2.97, 12.6, r.z - 1.2),
        V(r.x - 2.97, 10.4, r.z - 1.2), V(r.x - 2.53, 10.4, r.z - 1.2)
      ], 0.5, m, { bend: 1.4 });
      fill.leg = this.legFill; g.add(fill.group);
      this.pipes.push(grav, recirc, fill);
    } else {
      const t = L.tank;
      const pit = slab(t.w + 4, 0.6, t.d + 4, this.stage.mat.deck);
      pit.position.set(t.x, -0.3, t.z);
      g.add(pit);
      const walls = slab(t.w, t.h, t.d,
        new THREE.MeshStandardMaterial({ color: 0x4e5a66, roughness: 0.9, side: THREE.BackSide }));
      walls.position.set(t.x, -t.h / 2 + 0.4, t.z);
      g.add(walls);
      this.tankWater = slab(t.w - 0.8, 3.4, t.d - 0.8, this.m.poolWater);
      this.tankWater.position.set(t.x, -t.h + 2.3, t.z);
      g.add(this.tankWater);

      const e = L.eccs;
      const base = tube(1.4, 1.6, 1.4, this.stage.mat.painted, 20);
      base.position.set(e.x, 0.7, e.z);
      g.add(base);
      this.eccsMotor = tube(0.9, 0.9, 2.6, this.stage.mat.painted, 20);
      this.eccsMotor.position.set(e.x, 2.7, e.z);
      g.add(this.eccsMotor);
      this.eccsLamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), this.m.lamp.clone());
      this.eccsLamp.position.set(e.x, 4.3, e.z);
      g.add(this.eccsLamp);

      this.legSuct = new Leg('suction', 0.35, 2, { rho: FLUID.rhoCold });
      this.legInj = new Leg('injection', 0.25, 2, { rho: FLUID.rhoCold });
      this.inject = new Circuit('inject', [this.legSuct, this.legInj]);
      const suct = pipe([
        V(t.x + t.w / 2 - 2, -t.h + 1.5, t.z), V(e.x, -t.h + 1.5, t.z),
        V(e.x, -t.h + 1.5, e.z), V(e.x, 1.2, e.z)
      ], 0.5, m, { bend: 1.8 });
      suct.leg = this.legSuct; g.add(suct.group);
      // the long way round: up the outside and back down in
      const inj = pipe([
        V(e.x, 4.2, e.z), V(e.x, 24, e.z), V(e.x + 8, 30, e.z),
        V(e.x + 8, 30, r.z), V(r.x + 6, 30, r.z), V(r.x + 6, COLD_Y, r.z),
        V(r.x + 2.4, COLD_Y, r.z)
      ], 0.4, m, { bend: 2.2 });
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
      air: new Plume(120, 0xa9d8ee, 30)
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
      tm.opacity = on ? 0.8 : 0.05;
      tm.emissiveIntensity = on ? 0.42 : 0.03;
      this.turbSteam.visible = on;
      this.turbWisp.advance(dt, v, this.turbLen, on ? 1.0 : 0.0001);
      this.turbWisp.mesh.visible = on;

      // The busbars carry what the generator is actually making. A live
      // conductor gets a warm sheen and no more: the reactor is the subject of
      // the picture and a glowing cable was winning the frame.
      const mw = this.spin > 4 ? clamp(this.secondary.mdot / 1900, 0, 1) : 0;
      this.busMat.emissiveIntensity = mw * 0.10;
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
        mat.opacity = moving ? 0.88 : 0.14;
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
        waterColor(u, cTmp);
        mat.attenuationColor.copy(cTmp);
        mat.color.copy(cTmp).lerp(WHITE, 0.25);
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
      q.core.visible = moving || leg.kind !== 'steam';
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
    // down the outside at the downcomer's own speed, hidden above the surface
    for (const b of this.downFlow) {
      b.advance(dt, this.legDown.v, W_HI - W_LO - 1.0,
        Math.abs(this.legDown.v) > 0.02 ? 1 : 0.0001, wy - 0.25);
      b.mesh.visible = st.lvl > 0.06 && Math.abs(this.legDown.v) > 0.02;
    }
    this.levelRing.position.set(L.rpv.x, wy, L.rpv.z);
    this.levelRing.visible = st.lvl > 0.01 && st.lvl < 0.995;
    ripple(this.coreTop, this.surfCore, 2.94);
    waterColor(mean, cTmp);
    tintWater(this.coreWater.material, cTmp, dt);
    this.coreWater.visible = st.lvl > 0.01;
    this.coreTop.visible = st.lvl > 0.01;

    // ---- the fuel ----
    const hot = clamp((p.Tclad - 620) / 900, 0, 1);
    this.fuelMat.emissive.copy(tempColor(p.Tclad));
    this.fuelMat.emissiveIntensity = hot * 0.9;
    this.fuelMat.color.copy(tempColor(p.Tclad)).lerp(new THREE.Color(0x6f7d88), 1 - hot);
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

    // The bundle: hot going up one side, cold coming down the other. It is the
    // same colour rule as the pipes, so the eye joins them up.
    waterColor(heat, cTmp);
    this.sgHotMat.color.copy(cTmp);
    this.sgHotMat.emissive.copy(cTmp).multiplyScalar(0.2);
    waterColor(cold, cTmp);
    this.sgColdMat.color.copy(cTmp);
    this.sgColdMat.emissive.copy(cTmp).multiplyScalar(0.2);

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
      this.eccsMotor.rotation.y = this.mach.aux.angle;
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
    this.plumes.corium.step(dt, p.vesselBreach ? 20 : 0, L.rpv.x, 2.0, L.rpv.z,
      { spread: 5, vy: 4.5, vx: 1.6, life: 5, grow: 3.4, alpha: 0.34, buoy: 1.6 });
    // nothing steams out of a surface condenser: what leaves it is warm water
    const pccs = st.sink === 'shell' ? 1 : clamp(st.s.pccs || 0, 0, 1);
    this.plumes.air.step(dt, pccs > 0.06 ? 16 : 0, 0, SHELL_H + 4, 0,
      { spread: 34, vy: 6, vx: 1, life: 4.5, grow: 2.4, alpha: 0.22 });
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
