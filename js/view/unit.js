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
import { liquidMaterial, Riser } from './fluid.js';
import { tempColor, waterColor, heatOf } from './materials.js';
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
  pool: { x: 3.5, z: -9.0, w: 9, d: 9, h: 5, y: 21 },
  turb: { x: 30, z: 6 },
  tank: { x: -23, z: 24, w: 15, d: 9, h: 6 },
  eccs: { x: -12, z: 27 },
  stack:{ x: 21, z: -20, h: 40 }
};
const HOT_Y = 13.0, COLD_Y = 8.2, SG_IN = 17.0, SG_OUT = 8.0;
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

    this.buildBuilding();
    this.buildVessels();
    this.buildLoop();
    this.buildSteamSide();
    this.buildSafety();

    this.riseCore = new Riser(2.1, 90, stage.mat.bubble);
    this.root.add(this.riseCore.mesh);
    this.riseSg = new Riser(2.2, 70, stage.mat.bubble);
    this.root.add(this.riseSg.mesh);
    this.risePool = new Riser(3.4, 70, stage.mat.bubble);
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

    // the operating floor, which is what you actually stand on inside
    // A walkway round the wall, not a lid: it has to give structure without
    // covering the machines it is there to let you reach.
    const deckGeo = new THREE.RingGeometry(12.2, R_IN - 0.3, 72, 1).rotateX(-Math.PI / 2);
    const opDeck = new THREE.Mesh(deckGeo, m.inner);
    opDeck.position.y = 13.2; opDeck.receiveShadow = true;
    g.add(opDeck);
    const deckRail = [];
    for (let i = 0; i <= 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      deckRail.push(V(Math.cos(a) * 12.4, 13.2, Math.sin(a) * 12.4));
    }
    g.add(railing(deckRail, this.stage.mat.rail, 1.0));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const col = tube(0.4, 0.4, 13.2, this.stage.mat.painted, 10);
      col.position.set(Math.cos(a) * (R_IN - 1.6), 6.6, Math.sin(a) * (R_IN - 1.6));
      g.add(col);
    }

    // handrail round the near edge of the floor
    const pts = [];
    for (let i = 0; i <= 26; i++) {
      const a = Math.PI * 0.5 * (i / 26);
      pts.push(V(Math.cos(a) * (R_IN - 0.5), 0, Math.sin(a) * (R_IN - 0.5)));
    }
    g.add(railing(pts, this.stage.mat.rail));
  }

  // ---- reactor, boiler, pump ---------------------------------------------
  buildVessels() {
    const g = this.root, m = this.m, r = L.rpv;

    const skirt = tube(r.r * 0.85, r.r * 0.95, r.base, this.stage.mat.painted, 40);
    skirt.position.set(r.x, r.base / 2, r.z);
    g.add(skirt);

    this.rpvShell = vessel(RPV_PROFILE, this.mHalfRpv);
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
    const s = L.sg;
    const sgSkirt = tube(2.3, 2.6, 2.0, this.stage.mat.painted, 32);
    sgSkirt.position.set(s.x, 1.0, s.z);
    g.add(sgSkirt);
    this.sgShell = vessel(SG_PROFILE, this.mHalfSg);
    this.sgShell.position.set(s.x, 2.0, s.z);
    g.add(this.sgShell);
    this.sgWater = tube(2.5, 2.5, 1, m.water, 40);
    this.sgWater.material = ownWater(m.water);
    this.sgWater.material.clippingPlanes = this.mHalfSg.clippingPlanes;
    g.add(this.sgWater);
    this.sgTop = new THREE.Mesh(new THREE.CircleGeometry(2.5, 40).rotateX(-Math.PI / 2),
      this.sgWater.material);
    g.add(this.sgTop);
    // the tube bundle the reactor's water runs through
    const bundleMat = new THREE.MeshStandardMaterial({
      color: 0x9fb2c2, roughness: 0.3, metalness: 0.85,
      clippingPlanes: this.mHalfSg.clippingPlanes
    });
    const bg = new THREE.Group();
    for (let i = -2; i <= 2; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 12.0, 8), bundleMat);
      t.position.set(s.x + i * 0.85, 2 + SG_OUT + 4.0, s.z);
      bg.add(t);
    }
    g.add(bg);

    // ---- pump ----
    const p = L.rcp;
    const plinth = tube(1.6, 1.8, COLD_Y - 2.2, this.stage.mat.painted, 32);
    plinth.position.set(p.x, (COLD_Y - 2.2) / 2, p.z);
    g.add(plinth);
    this.pumpCase = tube(1.9, 1.9, 2.2, this.stage.mat.steel, 40);
    this.pumpCase.position.set(p.x, COLD_Y, p.z);
    g.add(this.pumpCase);
    // the impeller, seen through the casing
    this.impeller = new THREE.Group();
    const vaneMat = new THREE.MeshStandardMaterial({ color: 0xc6d4de, roughness: 0.3, metalness: 0.9 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const curve = new THREE.CatmullRomCurve3([
        V(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4),
        V(Math.cos(a + 0.5) * 1.0, 0, Math.sin(a + 0.5) * 1.0),
        V(Math.cos(a + 1.0) * 1.62, 0, Math.sin(a + 1.0) * 1.62)]);
      this.impeller.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.09, 6, false), vaneMat));
    }
    this.impeller.add(new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 16), vaneMat));
    this.impeller.position.set(p.x, COLD_Y, p.z);
    g.add(this.impeller);
    // The volute is full of water, and the impeller turns in it. A pump that
    // shows a dry impeller is a fan.
    this.pumpWater = tube(1.72, 1.72, 2.0, liquidMaterial(1.7), 40);
    this.pumpWater.material.normalMap.repeat.set(6, 2);
    // shallow enough to see the impeller turning in it
    this.pumpWater.material.attenuationDistance = 9;
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

    this.hot = pipe([
      V(r.x, HOT_Y, r.z), V(r.x, HOT_Y, s.z),
      V(s.x + 4.6, HOT_Y, s.z), V(s.x + 4.6, 2 + SG_IN, s.z), V(s.x, 2 + SG_IN, s.z)
    ], 1.1, m, { bend: 2.6 });
    g.add(this.hot.group);

    this.cold = pipe([
      V(s.x, 2 + SG_OUT, s.z), V(s.x, 2 + SG_OUT, s.z + 4.6),
      V(s.x, COLD_Y, s.z + 4.6), V(p.x, COLD_Y, p.z - 2.4), V(p.x, COLD_Y, p.z)
    ], 1.0, m, { bend: 2.4 });
    g.add(this.cold.group);

    this.coldB = pipe([
      V(p.x + 1.9, COLD_Y, p.z), V(r.x - 3.6, COLD_Y, r.z), V(r.x - 3.2, COLD_Y, r.z)
    ], 1.0, m, { bend: 2.4 });
    g.add(this.coldB.group);

    this.hot.leg = this.legHot;
    this.cold.leg = this.legTubes;
    this.coldB.leg = this.legCold;
    this.pipes = [this.hot, this.cold, this.coldB];
  }

  // ---- steam to a turbine, a generator, and back as water ----------------
  buildSteamSide() {
    const g = this.root, s = L.sg, t = L.turb, m = this.m;
    this.legSteam = new Leg('main steam', 0.75, 4, { rho: FLUID.rhoSteam, kind: 'steam' });
    this.legFeed = new Leg('feedwater', 0.45, 4, { rho: FLUID.rhoFeed });
    this.secondary = new Circuit('secondary', [this.legSteam, this.legFeed]);

    const pad = slab(30, 1.2, 20, this.stage.mat.deck);
    pad.position.set(t.x, 0.6, t.z);
    g.add(pad);

    // one turbine on one shaft turning one generator
    this.turbine = new THREE.Group();
    const casMat = this.stage.mat.painted.clone();
    casMat.side = THREE.DoubleSide;
    // the top of the casing is lifted off, so you look down at the blades
    casMat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 9.6)];
    const cas = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.9, 8, 40, 1, true), casMat);
    cas.rotation.z = Math.PI / 2;
    cas.position.set(t.x - 6, 8.4, t.z);
    cas.castShadow = true;
    g.add(cas);
    this.rotor = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xd7e5ef, roughness: 0.22, metalness: 0.95 });
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.0, 0.14), bladeMat);
      b.position.set(0, Math.cos(a) * 1.9, Math.sin(a) * 1.9);
      b.rotation.x = -a + 0.5;
      this.rotor.add(b);
    }
    this.rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.9, 20)
      .rotateZ(Math.PI / 2), bladeMat));
    this.rotor.position.set(t.x - 1.6, 8.4, t.z);
    g.add(this.rotor);

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 22, 20)
      .rotateZ(Math.PI / 2), this.stage.mat.steel);
    shaft.position.set(t.x + 1, 8.4, t.z);
    g.add(shaft);

    this.gen = slab(9, 6, 6, this.stage.mat.painted);
    this.gen.position.set(t.x + 8, 8.4, t.z);
    g.add(this.gen);
    for (let i = 0; i < 4; i++) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.3, 6.3), this.stage.mat.copper);
      band.position.set(t.x + 5 + i * 2, 8.4, t.z);
      g.add(band);
    }
    this.cond = slab(9, 5, 9, this.stage.mat.dark);
    this.cond.position.set(t.x - 6, -1.0, t.z);
    this.cond.material = new THREE.MeshStandardMaterial({ color: 0x2f5d6b, roughness: 0.6, metalness: 0.3 });
    g.add(this.cond);

    const xf = slab(5, 4, 5, this.stage.mat.painted);
    xf.position.set(t.x + 17, 2, t.z - 2);
    g.add(xf);
    const pylonMat = this.stage.mat.rail;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 16, 8), pylonMat);
    mast.position.set(t.x + 24, 8, t.z - 2);
    g.add(mast);
    for (const yy of [12, 15]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 8, 6).rotateZ(Math.PI / 2), pylonMat);
      arm.position.set(t.x + 24, yy, t.z - 2);
      g.add(arm);
    }

    // Boiler, over the containment, down beside the turbine hall and in
    // through the end of the casing. It has to arrive somewhere or the steam
    // is going nowhere.
    this.steam = pipe([
      V(s.x, 2 + 24.0, s.z), V(s.x, 28, s.z), V(s.x, 28, s.z - 8),
      V(t.x - 14, 28, s.z - 8), V(t.x - 14, 28, t.z), V(t.x - 14, 8.4, t.z),
      V(t.x - 10.4, 8.4, t.z)
    ], 1.2, m, { bend: 3.0 });
    this.steam.leg = this.legSteam;
    g.add(this.steam.group);

    // What comes out of the turbine has to go somewhere: down the neck into
    // the condenser, where it turns back into water.
    this.legExh = new Leg('to the condenser', 2.6, 1, { rho: 12, kind: 'steam' });
    this.exh = pipe([
      V(t.x - 6, 6.0, t.z), V(t.x - 6, 2.0, t.z)
    ], 2.6, m, { bend: 0.8 });
    this.exh.leg = this.legExh;
    g.add(this.exh.group);

    this.feed = pipe([
      V(t.x - 6, -1.0, t.z + 4.6), V(t.x - 6, 1.4, t.z + 9),
      V(s.x - 8, 1.4, t.z + 9), V(s.x - 8, 1.4, s.z), V(s.x - 4.0, 1.4, s.z),
      V(s.x - 4.0, 2 + 6.0, s.z), V(s.x - 2.7, 2 + 6.0, s.z)
    ], 0.7, m, { bend: 2.2 });
    this.feed.leg = this.legFeed;
    g.add(this.feed.group);
    this.secondary.legs.push(this.legExh);
    this.pipes.push(this.steam, this.exh, this.feed);

    // the stack the containment can be vented through
    const st = L.stack;
    const stackBase = tube(2.4, 3.0, 2, this.stage.mat.deck, 24);
    stackBase.position.set(st.x, 1, st.z);
    g.add(stackBase);
    const chimney = tube(1.1, 1.35, st.h, this.stage.mat.painted, 24);
    chimney.position.set(st.x, st.h / 2, st.z);
    g.add(chimney);
    this.vent = pipe([
      V(R_IN * 0.72, 22, -R_IN * 0.5), V(st.x, 22, st.z), V(st.x, st.h - 2, st.z)
    ], 0.8, m, { bend: 2.4 });
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
      // the tank sits high on purpose: that height is what makes gravity work
      const wallT = 0.6;
      const outer = slab(p.w, p.h, p.d, this.stage.mat.painted);
      outer.position.set(p.x, p.y + p.h / 2, p.z);
      g.add(outer);
      const cav = slab(p.w - wallT * 2, p.h, p.d - wallT * 2,
        new THREE.MeshStandardMaterial({ color: 0x3d4a53, roughness: 0.9, side: THREE.BackSide }));
      cav.position.set(p.x, p.y + p.h / 2 + 0.4, p.z);
      g.add(cav);
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
      this.legPrhrDn = new Leg('back from the pool', 0.2, 2, { rho: FLUID.rhoCold });
      this.prhr = new Circuit('prhr', [this.legPrhrUp, this.legCoil, this.legPrhrDn]);
      const up = pipe([
        V(r.x - 3.2, HOT_Y, r.z + 1.6), V(r.x - 5, HOT_Y, r.z + 1.6),
        V(r.x - 5, p.y + 1.6, r.z + 1.6), V(r.x - 5, p.y + 1.6, p.z + p.d / 2 - 2)
      ], 0.45, m, { bend: 1.6 });
      up.leg = this.legPrhrUp; g.add(up.group);
      const coilPts = [];
      let cx = p.x + p.w / 2 - 2.5, side = 1;
      while (cx > p.x - p.w / 2 + 2.0) {
        coilPts.push(V(cx, p.y + 1.6, p.z + side * (p.d / 2 - 2.2)));
        coilPts.push(V(cx, p.y + 1.6, p.z - side * (p.d / 2 - 2.2)));
        cx -= 1.5; side *= -1;
      }
      const coil = pipe(coilPts, 0.4, m, { bend: 0.7 });
      coil.leg = this.legCoil; g.add(coil.group);
      const dn = pipe([
        coilPts[coilPts.length - 1].clone(),
        V(p.x - p.w / 2 + 1, p.y + 1.6, r.z - 1.4),
        V(r.x + 5.5, p.y + 1.6, r.z - 1.6), V(r.x + 5.5, COLD_Y, r.z - 1.6),
        V(r.x + 3.2, COLD_Y, r.z - 1.6)
      ], 0.45, m, { bend: 1.6 });
      dn.leg = this.legPrhrDn; g.add(dn.group);
      this.pipes.push(up, coil, dn);

      // and the line that simply lets it fall in
      this.legGrav = new Leg('gravity', 0.3, 2, { rho: FLUID.rhoCold });
      this.gravity = new Circuit('gravity', [this.legGrav]);
      const grav = pipe([
        V(p.x + 2.5, p.y, p.z + 3), V(p.x + 2.5, 20.0, p.z + 3),
        V(r.x, 20.0, r.z), V(r.x, r.base + 16.6, r.z)
      ], 0.5, m, { bend: 2.0 });
      grav.leg = this.legGrav; g.add(grav.group);
      this.pipes.push(grav);
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

  addPlumes() {
    this.plumes = {
      vent: new Plume(140, 0xd6dee4, 34),
      breach: new Plume(200, 0xd2c6bc, 46),
      cond: new Plume(90, 0xbfe0ea, 22),
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
      const on = (st.s.gravity || 0) > 0 || (st.s.cmt || 0) > 0;
      this.gravity.setFlow(on && p.irwst > 1e5 ? 55 : 0);
    }
    if (this.inject) this.inject.setFlow(st.injecting ? (st.s.rcic ? 25 : 40) : 0);
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
    this.impeller.rotation.y = this.mach.impeller.angle;
    // the water in the volute is dragged round with the impeller
    this.pumpWater.material.normalMap.offset.x = this.mach.impeller.angle / 6.283;
    tintWater(this.pumpWater.material, waterColor(heatOf(p.Tclad) - 0.16, new THREE.Color()), 0);
    this.rotor.rotation.x = this.mach.shaft.angle;
    this.spin = Math.abs(this.mach.shaft.speed);

    // ---- the fluid in every pipe, scrolling at its own velocity ----
    for (const c of [this.primary, this.secondary, this.prhr, this.gravity,
      this.inject, this.ventCircuit]) if (c) c.advance(dt);
    const heat = heatOf(p.Tclad);
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
        // Vapour: it scatters instead of refracting, so it goes pale and rough
        // and you see the droplets it is dragging along rather than a body.
        // Vapour does not refract, it scatters. Clear glass with white
        // attenuation is invisible; what reads as steam is a pale translucent
        // body with fast structure running through it.
        mat.attenuationColor.setHex(0xffffff);
        mat.color.setHex(0xf6fbff);
        mat.attenuationDistance = 60;
        mat.transmission = 0.12;
        mat.roughness = 0.85;
        mat.thickness = q.dia * 0.15;
        mat.ior = 1.02;
        mat.opacity = moving ? 0.82 : 0.1;
        mat.emissive.setHex(0xa9d3f2);
        mat.emissiveIntensity = moving ? 0.85 : 0.04;
        mat.normalScale.set(1.1, 1.1);
      } else {
        const u = leg.name === 'feedwater' || leg.name === 'back from the pool'
          || leg.name === 'suction' || leg.name === 'injection' || leg.name === 'gravity'
          ? 0.06 : leg.name === 'cold leg' ? heat - 0.16 : heat;
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
      st.lvl > 0.02 ? clamp(0.12 + (st.s.boil || 0) * 1.4, 0, 1) : 0, L.rpv.x, L.rpv.z);
    ripple(this.coreTop, this.surfCore, 2.94);
    waterColor(heat, cTmp);
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
      const rr = 1.2 + dam * 1.6;
      this.melt.scale.set(rr, 0.55 + dam * 0.5, rr);
      this.melt.material.emissive.copy(tempColor(Math.max(p.Tclad, 2100)));
      this.melt.material.emissiveIntensity = 0.8 + dam * 0.7;
    }
    // rods shorten as they slump
    this.fuelInst.scale.y = 1 - dam * 0.55;
    this.fuelInst.position.y = -(FUEL_Y1 - FUEL_Y0) * dam * 0.275;

    // ---- the boiler ----
    const carrying = st.carried && (st.s.feed || st.s.aux || st.s.rcic);
    const sgLvl = carrying ? 0.62 : 0.42;
    const sgH = 12 * sgLvl;
    this.sgWater.scale.y = sgH;
    this.sgWater.position.set(L.sg.x, 2 + 1.2 + sgH / 2, L.sg.z);
    this.sgTop.position.set(L.sg.x, 2 + 1.2 + sgH, L.sg.z);
    this.surfSg.step(dt, { boil: carrying ? 0.5 : 0.05 });
    this.riseSg.step(dt, 3.2, Math.max(0.4, sgH), carrying ? 0.85 : 0.08, L.sg.x, L.sg.z);
    ripple(this.sgTop, this.surfSg, 2.5);
    tintWater(this.sgWater.material, waterColor(carrying ? 0.42 : 0.1, cTmp), dt);

    // ---- the store of water ----
    if (this.poolWater) {
      const f = clamp(p.irwst / 2.1e6, 0, 1);
      const ph = Math.max(0.05, 0.4 + 4.8 * f);
      this.poolWater.scale.y = ph;
      this.poolWater.position.set(L.pool.x, L.pool.y + 0.5 + ph / 2, L.pool.z);
      this.surfPool.step(dt, { boil: (st.s.prhr || 0) > 0 ? 0.4 : 0.02 });
      this.risePool.step(dt, L.pool.y + 0.5, Math.max(0.4, ph),
        (st.s.prhr || 0) > 0 ? 0.75 : 0.03, L.pool.x, L.pool.z);
      const warm = (st.s.prhr || 0) > 0 ? 0.35 : 0.05;
      waterColor(warm, cTmp);
      tintWater(this.poolWater.material, cTmp, dt);
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
    const brokenTint = p.ctmtIntact ? 0x9aa0a6 : 0xa2837a;
    m.concrete.color.setHex(brokenTint);

    // ---- plumes ----
    const st2 = L.stack;
    this.plumes.vent.step(dt, st.s.vent ? 26 : 0, st2.x, st2.h, st2.z,
      { spread: 2, vy: 9, vx: 1.4, life: 5, grow: 2.6, alpha: 0.45 });
    const bA = this.breachAz;
    this.plumes.breach.step(dt, p.ctmtIntact ? 0 : 34,
      Math.sin(bA) * (R_IN + 1), 16, Math.cos(bA) * (R_IN + 1),
      { spread: 5, vy: 7, vx: 4, life: 6, grow: 4, alpha: 0.5, buoy: 1.4 });
    this.plumes.cond.step(dt, this.spin > 4 ? 14 : 0, L.turb.x - 6, 2.0, L.turb.z + 5,
      { spread: 4, vy: 2.2, vx: 2, life: 2.0, grow: 2.0, alpha: 0.3 });
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
