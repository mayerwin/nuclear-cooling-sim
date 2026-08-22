// ---------------------------------------------------------------------------
// sim.js — orchestration: clock, scenario timeline, hazards, cinematics,
// camera choreography and the consequence ledger.
// ---------------------------------------------------------------------------
import { World, W, H, T } from './world.js';
import { Plant, MODE, P0 } from './plant.js';
import { PlantView } from './plantview.js';
import { FX } from './fx.js';
import { Camera } from './iso.js';
import { byId } from './scenarios.js';
import { clamp, lerp, smoothstep } from './util.js';

export const SPEEDS = [0, 1, 30, 120, 900, -1];   // -1 = AUTO (adaptive)
export const SPEED_LABELS = ['\u275a\u275a', '1\u00d7', '30\u00d7', '120\u00d7', '900\u00d7', 'AUTO'];

export class Sim {
  constructor(canvas) {
    this.cam = new Camera(canvas.width, canvas.height);
    this.world = new World(7);
    this.fx = new FX(this.world);
    this.speedIdx = 5;
    this.visTime = 0;
    this.t = 0;
    this.gloom = 0;
    this.whiteout = 0;
    this.showZones = true;
    this.scenario = null;
    this.pending = [];
    this.feed = [];
    this.cine = null;
    this.tsunami = null;
    this.makePlants();
    this.cam.x = 26; this.cam.y = 26;
    this.cam.tx = 26; this.cam.ty = 26;
    this.cam.targetZoom = this.fitZoom(); this.cam.zoom = this.cam.targetZoom;
  }

  // Frame both stations regardless of screen shape: on a phone the side
  // panels are gone, so more of the canvas is actually usable.
  fitZoom() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const wide = this.cam.w / dpr > 860;
    const usable = this.cam.w - (wide ? 680 * dpr : 20 * dpr);
    return clamp(usable / (wide ? 1360 : 1150), 0.34, 0.95);
  }

  overview() { this.cam.focus(26, 26, this.fitZoom()); }

  makePlants() {
    const s = this.world.sites;
    this.active = new Plant(MODE.ACTIVE, 'Unit A — Active Cooling (Gen II)');
    this.passive = new Plant(MODE.PASSIVE, 'Unit B — Passive Cooling (Gen III+)');
    this.plants = [this.active, this.passive];
    this.views = [new PlantView(this.active, s.active), new PlantView(this.passive, s.passive)];
    this.hook();
  }

  hook() {
    this.views.forEach((v) => {
      const p = v.plant;
      p.onExplosion = (n) => {
        v.boom(this.fx, this.cam, this.world, 1.25 + n * 0.25, 'h2');
        this.whiteout = 0.55;
        this.gloom = Math.min(1, this.gloom + 0.3);
        this.cinematic(2.8, 1, [v.s.x + 7, v.s.y + 7], 1.25, 3);
        this.announce(`${p.name}: HYDROGEN EXPLOSION`, 'crit');
        this.killAround(v, 6.5);
      };
      p.onVesselBreach = () => {
        v.boom(this.fx, this.cam, this.world, 0.7, 'breach');
        this.gloom = Math.min(1, this.gloom + 0.22);
        this.cinematic(2.2, 1, [v.s.x + 7, v.s.y + 7], 1.1, 2);
        this.announce(`${p.name}: REACTOR VESSEL BREACHED`, 'crit');
      };
      p.onContainmentFail = () => {
        this.gloom = Math.min(1, this.gloom + 0.2);
        this.announce(`${p.name}: CONTAINMENT FAILED`, 'crit');
        this.cinematic(1.8, 2, [v.s.x + 7, v.s.y + 7], 1.0, 2);
      };
      p.onSteamExplosion = () => {
        v.boom(this.fx, this.cam, this.world, 1.8, 'steam');
        this.whiteout = 0.8;
        this.gloom = Math.min(1, this.gloom + 0.45);
        this.cinematic(3.2, 1, [v.s.x + 7, v.s.y + 7], 1.2, 4);
        this.announce(`${p.name}: PROMPT-CRITICAL STEAM EXPLOSION`, 'crit');
        this.killAround(v, 9);
      };
    });
  }

  killAround(v, r) {
    const cx = v.s.x + v.parts.reactor.x, cy = v.s.y + v.parts.reactor.y;
    for (const p of this.world.props) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < r) { p.hp = Math.max(0, p.hp - (1 - d / r) * 1.5); p.burn = 1; }
    }
  }

  announce(msg, kind = 'info') {
    this.feed.push({ t: this.t, msg, kind });
    if (this.feed.length > 120) this.feed.shift();
    this.onFeed && this.onFeed();
  }

  // -------------------------------------------------------------------
  reset(keepScenario = false) {
    this.world = new World(7);
    this.world.bakeTerrain();
    this.fx = new FX(this.world);
    this.t = 0; this.gloom = 0; this.whiteout = 0;
    this.tsunami = null; this.cine = null;
    this.feed = [];
    this.pending = [];
    this.makePlants();
    this.scenario = keepScenario ? this.scenario : null;
    this.onReset && this.onReset();
  }

  softReset() {
    // keep the same world/terrain, restore plants and clear damage
    const w = this.world;
    w.dirtyProps = true; w.liveCount = -1;
    w.contam.fill(0); w.scorch.fill(0); w.flood.fill(0); w.hasOverlay = false;
    w.dirtyOverlay = true;
    for (const p of w.props) { p.hp = 1; p.burn = 0; }
    this.fx.clear();
    this.plants.forEach(p => p.reset());
    this.plants[1].sabotaged = this.sabotage || false;
    this.t = 0; this.gloom = 0; this.whiteout = 0;
    this.tsunami = null; this.cine = null; this.pending = [];
    this.feed = [];
    this.scenario = null;
    this.announce('Simulation reset — both units at 100% power', 'ok');
  }

  run(id) {
    this.softReset();
    const sc = byId(id);
    this.scenario = sc;
    this.pending = sc.timeline.map(e => ({ ...e, done: false }));
    if (sc.tsunami) this.tsunamiCfg = sc.tsunami; else this.tsunamiCfg = null;
    this.announce(`SCENARIO: ${sc.name} — ${sc.ref}`, 'crit');
    this.speedIdx = 5;
    this.overview();
  }

  // A cinematic drops the clock to near-real-time so a violent event is
  // actually watchable. Never stack them: that is how the aftermath ends up
  // crawling for minutes.
  cinematic(dur, speed, focus, zoom, prio = 1) {
    if (this.cine && this.cine.prio >= prio && this.cine.t < this.cine.dur) return;
    this.cine = { t: 0, dur, speed, prio };
    if (focus) this.cam.focus(focus[0], focus[1], zoom || 1.0);
  }

  // AUTO: compress the long quiet stretches, then slow down hard the moment
  // something is actually happening to a core.
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
    if (this.tsunami && this.tsunami.active) s = Math.min(s, 20);
    return s;
  }

  get speed() {
    if (this.cine) return this.cine.speed;
    const v = SPEEDS[this.speedIdx];
    return v < 0 ? this.autoSpeed() : v;
  }

  // -------------------------------------------------------------------
  update(rdt) {
    rdt = Math.min(rdt, 0.05);
    this.visTime += rdt;
    this.whiteout *= Math.pow(0.02, rdt);
    this.cam.update(rdt);
    this.cam.resize(this.cam.w, this.cam.h);

    if (this.cine) {
      this.cine.t += rdt;
      if (this.cine.t > this.cine.dur) {
        this.cine = null;
        this.overview();
      }
    }

    const dtSim = this.speed * rdt;
    if (dtSim > 0) {
      let left = dtSim, guard = 0;
      while (left > 0 && guard++ < 60) {
        const h = Math.min(left, 4);
        this.stepSim(h);
        left -= h;
      }
    }

    // hazards + particles run on real time so they are always watchable
    this.stepTsunami(rdt);
    const visDt = rdt * clamp(this.speed / 60, 0.4, 3);
    for (const v of this.views) v.emit(this.fx, visDt, dtSim);
    this.fx.update(rdt);

    if (this.world.dirtyOverlay) {
      this.overlayTimer = (this.overlayTimer || 0) + rdt;
      if (this.overlayTimer > 0.6) {
        this.world.bakeOverlay(); this.world.dirtyProps = true; this.overlayTimer = 0;
      }
    }
    const sig = this.views.map(v => v.sig()).join('|');
    if (sig !== this.lastSig) { this.lastSig = sig; this.world.dirtyProps = true; }
    if (this.world.dirtyProps && this.propsFn) {
      this.propsTimer = (this.propsTimer || 0) + rdt;
      if (this.propsTimer > 0.6) { this.bakeScene(); this.propsTimer = 0; }
    }
    // ambient gloom from smoke + release
    const rel = this.plants.reduce((a, p) => a + p.releasedBq, 0);
    this.gloom = clamp(Math.max(this.gloom * Math.pow(0.9, rdt), Math.log10(1 + rel / 1e14) * 0.12), 0, 0.85);
  }

  stepSim(dt) {
    this.t += dt;
    // scenario timeline
    for (const e of this.pending) {
      if (!e.done && this.t >= e.t) {
        e.done = true;
        this.announce(e.msg, 'crit');
        for (const p of this.plants) e.fn(this, p);
        if (this.tsunamiCfg && Math.abs(e.t - this.tsunamiCfg.at) < 1) this.startTsunami();
      }
    }
    if (this.tsunamiCfg && !this.tsunami && this.t >= this.tsunamiCfg.at) this.startTsunami();
    for (const p of this.plants) p.step(dt);
  }

  // -------------------------------------------------------------------
  startTsunami() {
    if (this.tsunami) return;
    const cfg = this.tsunamiCfg;
    this.tsunami = {
      active: true, advancing: true, front: this.world.shore - 2,
      level: 0.2, height: cfg.height / 7.0, speed: 14, phase: 0, cfg
    };
    this.announce(`TSUNAMI — ${cfg.height} m wave inbound`, 'crit');
    this.cinematic(9, 12, [22, 22], 0.72, 2);
    this.cam.jolt(0.7);
  }

  stepTsunami(rdt) {
    const ts = this.tsunami;
    if (!ts) return;
    ts.phase += rdt;
    if (ts.advancing) {
      ts.front += ts.speed * rdt;
      ts.level = Math.min(ts.height, ts.level + rdt * ts.height * 0.55);
      this.cam.jolt(0.02);
      // spray thrown off the breaking crest
      if (Math.random() < 0.75) {
        for (let i = 0; i < 2; i++) {
          const x = Math.random() * 48;
          const y = ts.front - x;
          if (y < -2 || y > 50) continue;
          this.fx.steam(x, y, ts.level + 0.7, 1, 1, {
            r: 0.26, grow: 0.30, max: 1.5, rise: 1.7, spread: 0.5, a: 0.34,
            col: [232, 244, 250], wind: 0.2, turb: 0.8
          });
        }
      }
      // destroy what the water reaches
      for (const p of this.world.props) {
        if (p.x + p.y < ts.front && this.world.zAt(p.x | 0, p.y | 0) < ts.level) {
          if (p.hp > 0) {
            p.hp = Math.max(0, p.hp - rdt * 2.2);
            p.burn = 0;
          }
        }
      }
      if (ts.front > W + H) { ts.advancing = false; ts.retreat = 0; }
    } else {
      ts.retreat += rdt;
      ts.level = Math.max(0, ts.height * (1 - smoothstep(3, 16, ts.retreat)));
      ts.front = Math.max(this.world.shore - 2, ts.front - rdt * 4);
      if (ts.level <= 0.001) { this.tsunami.active = false; }
    }
  }

  // -------------------------------------------------------------------
  bakeScene() {
    const w = this.world;
    const entries = [];
    for (const p of w.props) {
      if (w.isLive(p, this.tsunami)) continue;
      entries.push({ d: p.x + p.y, fn: (g) => this.propsFn(g, p, w, 0) });
    }
    for (const v of this.views) v.collect(entries, w, 'static');
    w.bakeScene(entries);
  }

  verdict() {
    const a = this.active.consequences(), b = this.passive.consequences();
    return { a, b };
  }
}
