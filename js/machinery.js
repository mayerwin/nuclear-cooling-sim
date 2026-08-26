// ---------------------------------------------------------------------------
// machinery.js — the rotating kit, on a real rigid-body solver.
//
// Rapier (dimforge, WASM) owns the impeller, the turbine-generator shaft and
// the backup pump. They are dynamic bodies with real moments of inertia and
// real damping; nothing here sets an angle directly. Torque goes in, angle and
// speed come out, so spin-up, coast-down and the direction of rotation are all
// consequences rather than decisions.
//
// Why the pipe flow is not on this solver: Rapier, Box2D, Matter and every
// other general engine solve free bodies in an open domain. Flow in a closed,
// pressurised pipe network is a different problem, and the tool for it is
// one-dimensional network hydraulics — mass conservation round the loop and
// v = Q / A in each leg — which is exactly what the plant codes (RELAP5,
// TRACE, ATHLET) use and what fluid.js does. An SPH fluid here would be both
// wrong and unreadable.
// ---------------------------------------------------------------------------
let RAPIER = null;

export async function initPhysics() {
  if (RAPIER) return RAPIER;
  const mod = await import('../vendor/rapier2d.mjs');
  RAPIER = mod.default || mod;
  await RAPIER.init();
  return RAPIER;
}

class Spinner {
  // Each shaft gets its own patch of the world and a collider that belongs to
  // no collision group, so the three of them can never touch each other. The
  // collider is only there to give the body a moment of inertia.
  constructor(world, radius, damping, slot) {
    this.world = world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(slot * 40, 0)
        .setAngularDamping(damping).lockTranslations());
    world.createCollider(
      RAPIER.ColliderDesc.ball(radius).setDensity(1).setCollisionGroups(0), this.body);
  }
  torque(n, dt) { if (dt > 0) this.body.applyTorqueImpulse(n * dt, true); }
  get angle() { return this.body.rotation(); }
  get speed() { return this.body.angvel(); }
}

export class Machinery {
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: 0 });
    // The impeller is light and heavily damped by the water it is pushing;
    // the turbine-generator shaft is heavy and barely damped, which is why one
    // stops in a second and the other takes a minute.
    this.impeller = new Spinner(this.world, 0.55, 2.2, 0);
    // A real turbine-generator takes minutes to run up. The clock here runs
    // up to 1800x, so the shaft is given an inertia that puts its run-up at a
    // couple of seconds; the shape of the curve is the solver's, not a tween.
    this.shaft = new Spinner(this.world, 1.25, 0.05, 1);
    this.aux = new Spinner(this.world, 0.4, 2.6, 2);
  }

  // targetOmega: what the motor is trying to hold, signed by the geometry of
  // the two pipes on the pump. steamPower: what the steam is worth in torque.
  // Sub-stepped so the machines run at the same rate whatever the frame rate:
  // a solver fed one fixed tick per frame runs slow on a slow machine, and a
  // turbine that spins up at a different rate on different hardware is a bug.
  step(dt, o) {
    if (dt <= 0) return;
    const n = Math.min(10, Math.max(1, Math.ceil(dt * 60)));
    const h = dt / n;
    this.world.timestep = h;
    for (let i = 0; i < n; i++) {
      const im = this.impeller;
      im.torque(o.pumpDriven ? (o.pumpTarget - im.speed) * 4.2 : 0, h);
      // the steam pushes, the generator's load and windage pull back; where
      // they balance is the running speed, and how fast it gets there is the
      // shaft's own inertia
      const sh = this.shaft;
      sh.torque(o.steamTorque - sh.speed * o.loadCoef, h);
      const ax = this.aux;
      ax.torque(o.auxDriven ? (o.auxTarget - ax.speed) * 3.4 : 0, h);
      this.world.step();
    }
  }
}
