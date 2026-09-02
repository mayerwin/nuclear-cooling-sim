// ---------------------------------------------------------------------------
// ui.js - the panels round the picture.
// ---------------------------------------------------------------------------
import { SCENARIOS } from './scenarios.js?v=29b6a124b2';
import { SPEEDS, SPEED_LABELS, AUTO_IDX } from './sim.js?v=29b6a124b2';
import { MODE } from './plant.js?v=29b6a124b2';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hhmmss = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export class UI {
  constructor(sim, hooks) {
    this.sim = sim;
    this.hooks = hooks;
    this.build();
    sim.onFeed = () => this.renderFeed();
    this.renderFeed();
    this.update();
  }

  build() {
    const sim = this.sim;
    $('#scenarios').innerHTML = SCENARIOS.map((s) =>
      `<button class="sc" data-id="${s.id}"><b>${s.name}</b><small>${s.ref.replace(/·/g, '·')}</small></button>`).join('');
    $('#scenarios').addEventListener('click', (e) => {
      const b = e.target.closest('.sc');
      if (!b) return;
      sim.sound.init();
      sim.run(b.dataset.id);
      this.closeMobile();
    });

    $('#speedSeg').innerHTML = SPEEDS.map((v, i) =>
      `<button data-i="${i}"${i === sim.speedIdx ? ' class="on"' : ''}>${SPEED_LABELS[i]}</button>`).join('');
    $('#speedSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      sim.speedIdx = +b.dataset.i;
      [...$('#speedSeg').children].forEach((c) => c.classList.toggle('on', c === b));
    });

    $('#viewSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      [...$('#viewSeg').children].forEach((c) => c.classList.toggle('on', c === b));
      this.hooks.view(b.dataset.view);
      // The controls are about the inside view, so they appear the first time
      // it does. Listing them in the welcome text meant reading them before
      // there was anything to try them on.
      if (b.dataset.view === 'plant' && !this.helpSeen) {
        this.helpSeen = true;
        this.showHelp(true);
      }
    });

    // ---- graphics settings ----
    // The point of these is diagnosis: turn one off, watch the frame rate. So
    // the panel carries the frame rate and the draw count with it, live.
    const cfg = $('#cfg');
    const showCfg = (on) => {
      cfg.classList.toggle('show', on);
      $('#btnCfg').classList.toggle('on', on);
    };
    $('#btnCfg').onclick = () => showCfg(!cfg.classList.contains('show'));
    $('#cfgOk').onclick = () => showCfg(false);
    // The stage does not exist yet when this runs: nothing heavy is built until
    // the welcome card is dismissed. So the panel is wired to whatever stage it
    // is GIVEN, and boot() hands it the real one the moment there is one.
    // Wired once at construction it was seven disabled, unticked boxes.
    this.bindStage = (stage) => {
      this.hooks.stage = stage;
      for (const box of cfg.querySelectorAll('input[data-q]')) {
        box.checked = stage ? !!stage.q[box.dataset.q] : false;
        box.disabled = !stage;
        box.onchange = () => { if (stage) stage.setQuality(box.dataset.q, box.checked); };
      }
    };
    this.bindStage(this.hooks.stage);

    const help = $('#help');
    this.showHelp = (on) => {
      help.classList.toggle('show', on);
      $('#btnHelp').classList.toggle('on', on);
    };
    this.helpSeen = (() => {
      try { return localStorage.getItem('ncs.help') === '1'; } catch (e) { return false; }
    })();
    $('#btnHelp').onclick = () => this.showHelp(!help.classList.contains('show'));
    $('#helpOk').onclick = () => {
      this.showHelp(false);
      this.helpSeen = true;
      try { localStorage.setItem('ncs.help', '1'); } catch (e) { /* private mode */ }
    };

    $('#focusSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      [...$('#focusSeg').children].forEach((c) => c.classList.toggle('on', c === b));
      this.hooks.focus(b.dataset.focus);
    });

    $('#btnReset').onclick = () => sim.reset();
    $('#btnSound').onclick = () => {
      const m = sim.sound.setMuted(!sim.sound.muted);
      $('#btnSound').textContent = m ? '🔇' : '🔊';
    };
    $('#tgSabotage').onchange = (e) => {
      sim.sabotage = e.target.checked;
      sim.passive.sabotaged = sim.sabotage;
      sim.announce(sim.sabotage
        ? 'Passive systems disabled on Unit B. It is now only as safe as its pumps.'
        : 'Passive systems restored on Unit B.', 'crit');
    };
    // The inline handler in the page already closes the modal; this only has
    // to start the audio, and a browser that refuses must not eat the click.
    $('#startBtn').addEventListener('click', () => {
      $('#modal').classList.remove('open');
      // Everything the page costs starts here and not before.
      try { window.__boot && window.__boot(); } catch (e) { console.error(e); }
      try { sim.sound.init(); } catch (e) { console.warn('audio unavailable', e); }
    });
    $('#ledger').innerHTML = LEDGER;

    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); sim.speedIdx = sim.speedIdx === 0 ? AUTO_IDX : 0; this.syncSpeed(); }
      if (k === 'r') sim.reset();
      if (k === '1') this.pick('active');
      if (k === '2') this.pick('both');
      if (k === '3') this.pick('passive');
      if (k === 'v') this.pickView('site');
      if (k === 'c') this.pickView('plant');
    });
  }

  pickView(v) {
    [...$('#viewSeg').children].forEach((c) => c.classList.toggle('on', c.dataset.view === v));
    this.hooks.view(v);
  }

  pick(f) {
    [...$('#focusSeg').children].forEach((c) => c.classList.toggle('on', c.dataset.focus === f));
    this.hooks.focus(f);
  }
  syncSpeed() {
    [...$('#speedSeg').children].forEach((c, i) => c.classList.toggle('on', i === this.sim.speedIdx));
  }
  closeMobile() { document.querySelectorAll('.panel').forEach((p) => p.classList.remove('show')); }

  // ---- the telemetry panel ------------------------------------------------
  // Built once, then patched.
  //
  // It used to be rebuilt from a template string four or five times a second,
  // which makes the browser parse the HTML, throw away every node and lay the
  // whole panel out again, twelve gauges at a time, for the sake of six
  // numbers that changed. Now the nodes are made once and the only things
  // written are the text and the width of each bar.
  gauge(label) {
    const el = document.createElement('div');
    el.className = 'g';
    el.innerHTML = `<div class="row"><span>${label}</span><b></b></div>`
      + '<div class="track"><div class="fill"></div></div>';
    return { el, val: el.querySelector('b'), fill: el.querySelector('.fill') };
  }

  buildTelemetry() {
    const host = $('#telemetry');
    host.textContent = '';
    this.tel = this.sim.plants.map((p, i) => {
      const P = p.mode === MODE.PASSIVE;
      const box = document.createElement('div');
      box.className = 'unit';
      box.innerHTML = `<h3>${P ? 'Unit B' : 'Unit A'}</h3>`
        + `<div class="sub">${P ? 'Gen III+, passive' : 'Gen II, active'}</div>`
        + '<div class="st"></div>';
      const rows = {};
      const add = (key, label, note) => {
        const gg = this.gauge(label);
        box.appendChild(gg.el);
        rows[key] = gg;
        if (note) {
          const n = document.createElement('div');
          n.className = 'note';
          n.textContent = note;
          box.appendChild(n);
        }
      };
      add('decay', 'Heat still in the fuel', i === 0
        ? 'Shutting a reactor down stops the chain reaction, not the heat. This is'
          + ' the number that has to be carried away, for days.'
        : null);
      add('level', 'Water over the fuel');
      add('temp', 'Cladding temperature');
      add('press', 'Containment pressure');
      add('dmg', 'Core damage');
      add('cs', 'Caesium-137 released');
      host.appendChild(box);
      return { st: box.querySelector('.st'), rows };
    });
  }

  setGauge(g, text, frac, band) {
    if (g.text !== text) { g.val.textContent = text; g.text = text; }
    const w = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    if (g.w !== w) { g.fill.style.width = w; g.w = w; }
    if (g.band !== band) {
      g.fill.style.background = band === 'bad' ? 'var(--bad)'
        : band === 'warn' ? 'var(--warn)' : 'var(--ok)';
      g.band = band;
    }
  }

  update() {
    const sim = this.sim;
    $('#clock').textContent = hhmmss(sim.t);
    if (!this.tel) this.buildTelemetry();
    sim.plants.forEach((p, i) => {
      const u = this.tel[i], dmg = p.coreDamage, T = p.Tclad - 273;
      const good = !(p.vesselBreach || dmg > 0.01 || p.level < 0.97);
      if (u.state !== p.state) {
        u.st.textContent = p.state;
        u.st.className = 'st ' + (good ? 'ok' : 'bad');
        u.state = p.state;
      }
      const r = u.rows;
      this.setGauge(r.decay, (p.qDecay / 1e6).toFixed(p.qDecay < 1e7 ? 1 : 0) + ' MW',
        p.qDecay / 3400e6, 'ok');
      this.setGauge(r.level, Math.round(p.level * 100) + ' %', p.level,
        p.level > 0.9 ? 'ok' : p.level > 0.71 ? 'warn' : 'bad');
      this.setGauge(r.temp, Math.round(T) + ' °C', T / 2200,
        T < 400 ? 'ok' : T < 900 ? 'warn' : 'bad');
      this.setGauge(r.press, p.pCtmt.toFixed(2) + ' MPa', p.pCtmt / 0.9,
        p.pCtmt < 0.4 ? 'ok' : p.pCtmt < 0.7 ? 'warn' : 'bad');
      this.setGauge(r.dmg, (dmg * 100).toFixed(0) + ' %', dmg, dmg < 0.01 ? 'ok' : 'bad');
      this.setGauge(r.cs, (p.releasedBq / 1e15).toFixed(2) + ' PBq',
        p.releasedBq / 8.5e16, p.releasedBq < 1e13 ? 'ok' : 'bad');
    });
  }

  // Frame rate, measured over the last second, next to what the frame drew.
  // Called from the render loop, which is the only place that knows.
  tick(dt) {
    this.fpsN = (this.fpsN || 0) + 1;
    this.fpsT = (this.fpsT || 0) + dt;
    if (this.fpsT < 0.5) return;
    const fps = this.fpsN / this.fpsT;
    this.fpsN = 0; this.fpsT = 0;
    const el = $('#cfgStats');
    if (!el || !$('#cfg').classList.contains('show')) return;
    const st = this.hooks.stage ? this.hooks.stage.stats() : null;
    el.textContent = st
      ? `${fps.toFixed(0)} fps · ${st.calls} draws · ${(st.tris / 1000).toFixed(0)}k triangles`
      : `${fps.toFixed(0)} fps`;
  }

  renderFeed() {
    const el = $('#feedInner');
    el.innerHTML = this.sim.feed.slice(-40).map((e) =>
      `<div class="e"><span class="t">${hhmmss(e.t)}</span>`
      + `<span class="${e.kind}">${e.msg}${e.n > 1 ? ` (x${e.n})` : ''}</span></div>`).join('');
    el.parentElement.scrollTop = 1e6;
  }
}

const LEDGER = `<table>
<tr><th>Modelled</th><td>Way and Wigner decay heat. Latent heat boil off against the real
water inventory. Zirconium and steam oxidation above 1100 K with its 6.5 MJ/kg exotherm and
0.044 kg of hydrogen per kg of cladding. Saturated pool containment pressure. Hydrogen
migration and deflagration. Released caesium 137 integrated over time.</td></tr>
<tr><th>Solved</th><td>The flow. One mass flow per circuit from the heat balance, then a
velocity for every pipe by continuity. The numbers that come out match a four loop PWR:
17,662 kg/s primary, 12.6 m/s in the hot leg, 15.9 in the cold leg, 10.6 through the core,
35.6 in the main steam line, 6.0 in the feedwater. Natural circulation lands at about 5 per
cent of rated flow, which is what plants measure. The rotating machinery is on a rigid body
solver: torque in, angle out.</td></tr>
<tr><th>Scaled</th><td>Time. The clock compresses quiet hours and drops to near real time
when a core is coming apart. The turbine runs up in seconds rather than minutes, to match.</td></tr>
<tr><th>Assumed</th><td>Both units are 3,400 MW thermal so the comparison is like for like.
The Gen II unit is a large dry PWR containment. The Gen III+ unit is AP1000 class: passive
residual heat removal, core makeup tanks, gravity injection and a steel shell cooled by air
and an evaporating film. 8 hours of battery on the Gen II unit and 24 on the Gen III+,
against a 72 hour gravity tank. The passive plant is not invulnerable here: past about 1.5
times the seismic design basis the pool cracks, and past about 2.5 times the heat exchanger
line fails too.</td></tr>
<tr><th>Faked</th><td>Hot water is drawn reddish. Water at 350 °C is not red. The colour is
there so you can see where the heat is without reading a number. The near quarter of the
building and the near half of every vessel are cut away, the way a museum model is cut away.
Consequence figures are scaling laws fitted to two data points, Fukushima at about 15 PBq and
Chernobyl at about 85. They are the right order of magnitude and nothing more.</td></tr>
</table>`;
