// ---------------------------------------------------------------------------
// sim.js - the clock, the scenarios and the two plants.
//
// No rendering lives here. The view reads this; it never writes to it.
// ---------------------------------------------------------------------------
import { Plant, MODE } from './plant.js';
import { byId } from './scenarios.js';
import { Sound } from './audio.js';
import { clamp } from './util.js';

export const SPEEDS = [0, 1, 30, 120, 900, -1];
export const SPEED_LABELS = ['Paused', '1x', '30x', '120x', '900x', 'Auto'];

export class Sim {
  constructor() {
    this.t = 0;
    this.visTime = 0;
    this.speedIdx = 5;
    this.focus = 'both';
    this.feed = [];
    this.pending = [];
    this.scenario = null;
    this.sabotage = false;
    this.sound = new Sound();
    this.makePlants();
  }

  makePlants() {
    this.active = new Plant(MODE.ACTIVE, 'Unit A, active cooling (Gen II)');
    this.passive = new Plant(MODE.PASSIVE, 'Unit B, passive cooling (Gen III+)');
    this.plants = [this.active, this.passive];
    this.hook();
  }

  hook() {
    for (const p of this.plants) {
      p.onExplosion = () => this.announce(`${p.name}: HYDROGEN EXPLOSION`, 'crit');
      p.onVesselBreach = () => this.announce(`${p.name}: REACTOR VESSEL BREACHED`, 'crit');
      p.onContainmentFail = () => this.announce(`${p.name}: CONTAINMENT FAILED`, 'crit');
      p.onSteamExplosion = () => this.announce(`${p.name}: STEAM EXPLOSION`, 'crit');
    }
  }

  cueFor(msg, kind) {
    const m = msg.toLowerCase();
    if (/hydrogen explosion/.test(m)) return 'explosion';
    if (/steam explosion/.test(m)) return 'steamex';
    if (/vessel breach|breached|containment fail/.test(m)) return 'breach';
    if (/tsunami|wave/.test(m)) return 'wave';
    if (/earthquake|quake|seismic/.test(m)) return 'quake';
    if (/flood|submerged|inundat|seawater/.test(m)) return 'flood';
    if (/fire|burn/.test(m)) return 'fire';
    if (/scram|shut down/.test(m)) return 'scram';
    if (/valve|relief|porv|depressuris/.test(m)) return 'valve';
    if (/fail|lost|trip|blackout|starved|ruptur/.test(m)) return 'trip';
    if (/start|energis|re-energ|connected/.test(m)) return 'start';
    return kind === 'crit' ? 'trip' : null;
  }

  announce(msg, kind = 'info') {
    const last = this.feed[this.feed.length - 1];
    if (last && last.msg === msg) {
      last.n = (last.n || 1) + 1; last.t = this.t;
      this.onFeed && this.onFeed(); return;
    }
    this.feed.push({ t: this.t, msg, kind });
    if (this.sound) { const c = this.cueFor(msg, kind); if (c) this.sound.cue(c); }
    if (this.feed.length > 120) this.feed.shift();
    this.onFeed && this.onFeed();
  }

  reset() {
    for (const p of this.plants) p.reset();
    this.plants[1].sabotaged = this.sabotage;
    this.t = 0;
    this.pending = [];
    this.scenario = null;
    this.feed = [];
    this.announce('Both units at 100% power. Grid connected, all systems normal.', 'ok');
    this.onReset && this.onReset();
  }

  run(id) {
    this.reset();
    const sc = byId(id);
    this.scenario = sc;
    this.pending = sc.timeline.map((e) => ({ ...e, done: false }));
    this.announce(`SCENARIO: ${sc.name}. ${sc.ref}`, 'crit');
    this.speedIdx = 5;
  }

  autoSpeed() {
    let s = 1800;
    for (const p of this.plants) {
      if (p.excursion > 0 || p.powerFrac > 1.2) return 2;
      const uncovering = p.level < 0.995 && p.level > 0.02;
      const heating = p.Tclad > 700 && p.coreDamage < 0.999;
      const melting = p.meltFrac > 0.001 && p.meltFrac < 0.99;
      const venting = p.pCtmt > 0.55 && p.ctmtIntact;
      if (melting || p.oxidising > 0.6) s = Math.min(s, 90);
      else if (heating) s = Math.min(s, 320);
      else if (uncovering) s = Math.min(s, 650);
      else if (venting) s = Math.min(s, 700);
      else if (p.state !== 'NORMAL') s = Math.min(s, 1500);
    }
    return s;
  }

  get speed() {
    const v = SPEEDS[this.speedIdx];
    return v < 0 ? this.autoSpeed() : v;
  }

  update(rdt) {
    rdt = Math.min(rdt, 0.05);
    this.visTime += rdt;
    if (this.sound) this.sound.frame(this);
    const dtSim = this.speed * rdt;
    if (dtSim > 0) {
      let left = dtSim, guard = 0;
      while (left > 0 && guard++ < 60) {
        const h = Math.min(left, 4);
        this.step(h);
        left -= h;
      }
    }
  }

  step(dt) {
    if (this.scenario) this.t += dt;
    for (const e of this.pending) {
      if (!e.done && this.t >= e.t) {
        e.done = true;
        this.announce(e.msg, 'crit');
        for (const p of this.plants) e.fn(this, p);
      }
    }
    for (const p of this.plants) p.step(dt);
  }

  verdict() {
    return { a: this.active.consequences(), b: this.passive.consequences() };
  }
}
export { clamp };
