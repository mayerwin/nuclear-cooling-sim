// ---------------------------------------------------------------------------
// ui.js - the panels round the picture.
// ---------------------------------------------------------------------------
import { SCENARIOS } from './scenarios.js?v=7211739fec';
import { SPEEDS, SPEED_LABELS, AUTO_IDX } from './sim.js?v=7211739fec';
import { MODE } from './plant.js?v=7211739fec';

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
    });

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

  gauge(label, val, unit, frac, band) {
    const f = clamp(frac, 0, 1);
    const col = band === 'bad' ? 'var(--bad)' : band === 'warn' ? 'var(--warn)' : 'var(--ok)';
    return `<div class="g"><div class="row"><span>${label}</span><b>${val}${unit ? ' ' + unit : ''}</b></div>`
      + `<div class="track"><div class="fill" style="width:${(f * 100).toFixed(1)}%;background:${col}"></div></div></div>`;
  }

  update() {
    const sim = this.sim;
    $('#clock').textContent = hhmmss(sim.t);
    $('#telemetry').innerHTML = sim.plants.map((p) => {
      const P = p.mode === MODE.PASSIVE;
      const dmg = p.coreDamage;
      const good = !(p.vesselBreach || dmg > 0.01 || p.level < 0.97);
      const T = p.Tclad - 273;
      return `<div class="unit">
        <h3>${P ? 'Unit B' : 'Unit A'}</h3>
        <div class="sub">${P ? 'Gen III+, passive' : 'Gen II, active'}</div>
        <div class="st ${good ? 'ok' : 'bad'}">${p.state}</div>
        ${this.gauge('Heat still in the fuel', (p.qDecay / 1e6).toFixed(p.qDecay < 1e7 ? 1 : 0), 'MW',
    p.qDecay / 3400e6, 'ok')}
        ${this.gauge('Water over the fuel', Math.round(p.level * 100), '%', p.level,
    p.level > 0.9 ? 'ok' : p.level > 0.71 ? 'warn' : 'bad')}
        ${this.gauge('Cladding temperature', Math.round(T), '°C', T / 2200,
    T < 400 ? 'ok' : T < 900 ? 'warn' : 'bad')}
        ${this.gauge('Containment pressure', p.pCtmt.toFixed(2), 'MPa', p.pCtmt / 0.9,
    p.pCtmt < 0.4 ? 'ok' : p.pCtmt < 0.7 ? 'warn' : 'bad')}
        ${this.gauge('Core damage', (dmg * 100).toFixed(0), '%', dmg, dmg < 0.01 ? 'ok' : 'bad')}
        ${this.gauge('Caesium-137 released', (p.releasedBq / 1e15).toFixed(2), 'PBq',
    p.releasedBq / 8.5e16, p.releasedBq < 1e13 ? 'ok' : 'bad')}
      </div>`;
    }).join('');
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
