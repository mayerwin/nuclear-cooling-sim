// ---------------------------------------------------------------------------
// sim.js - the clock, the scenarios and the two plants.
//
// No rendering lives here. The view reads this; it never writes to it.
// ---------------------------------------------------------------------------
import { Plant, MODE } from './plant.js?v=03485aad37';
import { byId } from './scenarios.js?v=03485aad37';
import { Sound } from './audio.js?v=03485aad37';
import { World, W, H } from './site/world.js?v=03485aad37';
import { PlantView } from './site/plantview.js?v=03485aad37';
import { FX } from './site/fx.js?v=03485aad37';
import { Camera } from './site/iso.js?v=03485aad37';
import { clamp, smoothstep } from './util.js?v=03485aad37';

export const SPEEDS = [0, 1, 50, 100, 1000, 2000, -1];
export const SPEED_LABELS = ['Paused', '1x', '50x', '100x', '1000x', '2000x', 'Auto'];
export const AUTO_IDX = SPEEDS.length - 1;

export class Sim {
  constructor(canvas) {
    // The site view keeps its own isometric camera and world; the plant view
    // has a 3-D one of its own. They are two views of the same simulation.
    this.cam = new Camera(canvas ? canvas.width : 1600, canvas ? canvas.height : 900);
    this.world = new World(7);
    this.fx = new FX(this.world);
    this.view = 'site';
    this.gloom = 0;
    this.whiteout = 0;
    this.showZones = true;
    this.showLabels = true;
    this.cine = null;
    this.tsunami = null;
    this.tsunamiCfg = null;
    this.t = 0;
    this.visTime = 0;
    this.speedIdx = AUTO_IDX;
    this.focus = 'both';
    this.feed = [];
    this.pending = [];
    this.scenario = null;
    this.sabotage = false;
    this.sound = new Sound();
    this.makePlants();
    this.cam.x = this.cam.tx = 26;
    this.cam.y = this.cam.ty = 26;
    this.cam.targetZoom = this.cam.zoom = this.fitZoom();
  }

  fitZoom() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const wide = this.cam.w / dpr > 860;
    const usable = this.cam.w - (wide ? 680 * dpr : 20 * dpr);
    // fit the island in BOTH axes rather than cropping the tips off a phone
    const usableH = this.cam.h - (wide ? 150 : 230) * dpr;
    // A phone is much taller than the island is, so shrinking the map until
    // its empty left and right corners fit wastes most of the screen: on a
    // tall viewport those corners are allowed off the edge instead. A tablet
    // is square enough that height binds first, so it keeps the whole island.
    const tall = this.cam.h / this.cam.w > 1.7;
    const wBudget = wide ? 1360 : (tall ? 1030 : 1220);
    return clamp(Math.min(usable / wBudget, usableH / (wide ? 900 : 1120)),
      0.30, 0.95);
  }

  overview() { this.cam.focus(26, 26, this.fitZoom()); }

  killAround(v, r) {
    const cx = v.s.x + v.parts.reactor.x, cy = v.s.y + v.parts.reactor.y;
    for (const p of this.world.props) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < r) { p.hp = Math.max(0, p.hp - (1 - d / r) * 1.5); p.burn = 1; }
    }
    this.world.propsVersion++;
  }


  cinematic(dur, speed, focus, zoom, prio = 1) {
    if (this.cine && this.cine.prio >= prio && this.cine.t < this.cine.dur) return;
    this.cine = { t: 0, dur, speed, prio };
    // A repeating event - hydrogen bursts come in threes - used to snatch the
    // camera back every few seconds, so pressing "Both" during the interesting
    // part did nothing. Choosing a camera now holds it; the slow-motion still
    // applies, only the framing is left alone.
    if (focus && !(this.camHold > 0)) this.cam.focus(focus[0], focus[1], zoom || 1.0);
  }


  startTsunami() {
    if (this.tsunami) return;
    const cfg = this.tsunamiCfg;
    this.tsunami = {
      active: true, advancing: true, front: this.world.shore - 2,
      level: 0.2, height: cfg.height / 7.0, speed: 14, phase: 0, cfg
    };
    this.announce(`TSUNAMI: ${cfg.height} m wave inbound`, 'crit');
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
            this.world.propsVersion++;
          }
        }
      }
      if (ts.front > W + H) { ts.advancing = false; ts.retreat = 0; }
    } else {
      ts.retreat += rdt;
      ts.level = Math.max(0, ts.height * (1 - smoothstep(3, 16, ts.retreat)));
      ts.front = Math.max(this.world.shore - 2, ts.front - rdt * 4);
      if (ts.level <= 0.001) {
        // the water goes, the damage does not: leave standing pools on the
        // low ground and debris across everything the wave reached
        if (!ts.settled) {
          ts.settled = true;
          const w = this.world;
          for (let y = 0; y < 48; y++) {
            for (let x = 0; x < 48; x++) {
              const i = w.idx(x, y);
              if (x + y > ts.cfg.height * 7 + w.shore + 14) continue;
              if (w.type[i] === 0) continue;
              if (w.z[i] < ts.height * 0.55) {
                w.flood[i] = ts.height * 0.55 - w.z[i];
                w.scorch[i] = Math.min(0.55, w.scorch[i] + 0.28);
                w.hasOverlay = true;
              }
            }
          }
          w.dirtyOverlay = true;
          this.announce('The water has gone. The site is wrecked, wet and inaccessible.', 'crit');
        }
        this.tsunami.active = false;
      }
    }
  }

  setView(v) {
    this.view = v;
    if (typeof document !== 'undefined') document.body.classList.toggle('viewplant', v === 'plant');
    if (v === 'site') this.overview();
  }


  makePlants() {
    this.active = new Plant(MODE.ACTIVE, 'Unit A, active cooling (Gen II)');
    this.passive = new Plant(MODE.PASSIVE, 'Unit B, passive cooling (Gen III+)');
    this.plants = [this.active, this.passive];
    const s = this.world.sites;
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
    const w = this.world;
    w.contam.fill(0); w.scorch.fill(0); w.flood.fill(0);
    w.hasOverlay = false; w.dirtyOverlay = true;
    for (const q of w.props) { q.hp = 1; q.burn = 0; }
    w.propsVersion++;
    this.fx.clear();
    this.gloom = 0; this.whiteout = 0;
    this.tsunami = null; this.tsunamiCfg = null; this.cine = null;
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
    this.tsunamiCfg = sc.tsunami || null;
    this.announce(`SCENARIO: ${sc.name}. ${sc.ref}`, 'crit');
    this.speedIdx = AUTO_IDX;
  }

  autoSpeed() {
    let s = 1800;
    if (this.tsunami && this.tsunami.active) return 20;
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
    if (this.cine) return this.cine.speed;
    const v = SPEEDS[this.speedIdx];
    return v < 0 ? this.autoSpeed() : v;
  }

  update(rdt) {
    rdt = Math.min(rdt, 0.05);
    this.visTime += rdt;
    this.whiteout *= Math.pow(0.02, rdt);
    this.cam.update(rdt);
    if (this.sound) this.sound.frame(this);
    if (this.cine) {
      this.cine.t += rdt;
      if (this.cine.t > this.cine.dur) { this.cine = null; this.overview(); }
    }
    const dtSim = this.speed * rdt;
    if (dtSim > 0) {
      let left = dtSim, guard = 0;
      while (left > 0 && guard++ < 60) {
        const h = Math.min(left, 4);
        this.step(h);
        left -= h;
      }
    }
    this.stepTsunami(rdt);
    const visDt = rdt * clamp(this.speed / 60, 0.4, 3);
    for (const v of this.views) v.emit(this.fx, visDt, dtSim);
    this.fx.update(rdt);
    if (this.world.dirtyOverlay) {
      this.overlayTimer = (this.overlayTimer || 0) + rdt;
      if (this.overlayTimer > 0.4) { this.world.bakeOverlay(); this.overlayTimer = 0; }
    }
    const rel = this.plants.reduce((a, p) => a + p.releasedBq, 0);
    this.gloom = clamp(Math.max(this.gloom * Math.pow(0.9, rdt),
      Math.log10(1 + rel / 1e14) * 0.12), 0, 0.85);
  }

  step(dt) {
    if (this.scenario) this.t += dt;
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

  verdict() {
    return { a: this.active.consequences(), b: this.passive.consequences() };
  }
}
export { clamp };
