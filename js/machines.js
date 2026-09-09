// ---------------------------------------------------------------------------
// machines.js - the rotating kit, on a rigid-body solver.
//
// Rapier owns the impeller, the turbine-generator shaft and the backup pump.
// They are dynamic bodies with real moments of inertia and real damping.
// Torque goes in; angle and speed come out. Nothing sets an angle, so spin-up,
// coast-down and the direction of rotation are all consequences.
// ---------------------------------------------------------------------------
let R = null;

export async function initPhysics() {
  if (R) return R;
  // Rapier is WASM, and some mobile browsers refuse it. The machines must not
  // take the whole app down with them: a plain integrator with the same
  // interface takes over, and everything else runs untouched.
  try {
    const mod = await import('../vendor/rapier2d.mjs');
    R = mod.default || mod;
    await R.init();
  } catch (e) {
    console.warn('physics engine unavailable, falling back', e);
    R = null;
  }
  return R;
}

// The fallback: torque in, angle out, forward Euler. Not as pretty under
// impulse as the real solver, but indistinguishable at these damping levels.
class PlainSpinner {
  constructor(inertia, damping) {
    this.i = inertia; this.d = damping;
    this.angle = 0; this.speed = 0;
  }
  torque(n, dt) { this.speed += (n / this.i) * dt; }
  step(dt) {
    this.speed *= Math.max(0, 1 - this.d * dt);
    this.angle += this.speed * dt;
  }
  spinAt(w) { this.speed = w; }
}

class Spinner {
  // Its own patch of the world and a collider in no collision group, so the
  // shafts can never touch each other. The collider is only there to give the
  // body a moment of inertia.
  constructor(world, radius, damping, slot) {
    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(slot * 40, 0)
        .setAngularDamping(damping).lockTranslations());
    world.createCollider(
      R.ColliderDesc.ball(radius).setDensity(1).setCollisionGroups(0), this.body);
  }
  torque(n, dt) { if (dt > 0) this.body.applyTorqueImpulse(n * dt, true); }
  spinAt(w) { this.body.setAngvel(w, true); }
  get angle() { return this.body.rotation(); }
  get speed() { return this.body.angvel(); }
}

export class Machines {
  constructor() {
    if (!R) {
      this.impeller = new PlainSpinner(0.3, 2.2);
      this.shaft = new PlainSpinner(2.4, 0.05);
      this.aux = new PlainSpinner(0.13, 2.6);
      this.plain = true;
      return;
    }
    this.world = new R.World({ x: 0, y: 0 });
    // The impeller is light and heavily damped by the water it is pushing. The
    // turbine-generator shaft is heavier and barely damped, so it runs up and
    // runs down over seconds rather than snapping between states.
    this.impeller = new Spinner(this.world, 0.55, 2.2, 0);
    this.shaft = new Spinner(this.world, 1.25, 0.05, 1);
    this.aux = new Spinner(this.world, 0.4, 2.6, 2);
  }

  // The station is at full power when you arrive, so its machines are already
  // turning. Starting them from rest means the first thing a visitor sees is a
  // generator winding up and a lamp that is out, which says the plant is off.
  running(pumpSpeed, shaftSpeed) {
    this.impeller.spinAt(pumpSpeed);
    this.shaft.spinAt(shaftSpeed);
  }
  // Sub-stepped, so the machines run at the same rate whatever the frame rate.
  step(dt, o) {
    if (dt <= 0) return;
    const n = Math.min(10, Math.max(1, Math.ceil(dt * 60)));
    const h = dt / n;
    if (!this.plain) this.world.timestep = h;
    for (let i = 0; i < n; i++) {
      this.impeller.torque(o.pumpDriven ? (o.pumpTarget - this.impeller.speed) * 4.2 : 0, h);
      // steam pushes, the generator's load and windage pull back; where they
      // balance is the running speed
      this.shaft.torque(o.steamTorque - this.shaft.speed * o.loadCoef, h);
      this.aux.torque(o.auxDriven ? (o.auxTarget - this.aux.speed) * 3.4 : 0, h);
      if (this.plain) {
        this.impeller.step(h); this.shaft.step(h); this.aux.step(h);
      } else {
        this.world.step();
      }
    }
  }
}
