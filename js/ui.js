// ---------------------------------------------------------------------------
// ui.js — control-room panels, gauges, consequence ledger, event feed
// ---------------------------------------------------------------------------
import { SCENARIOS } from './scenarios.js';
import { SPEEDS, SPEED_LABELS } from './sim.js';
import { P0 } from './plant.js';
import { clamp, fmtTime, fmtNum } from './util.js';

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h !== undefined) e.innerHTML = h; return e; };

export class UI {
  constructor(sim) {
    this.sim = sim;
    this.build();
    this.lastFeed = 0;
  }

  build() {
    // ---- scenarios ----
    const list = $('#scenarioList');
    SCENARIOS.forEach(s => {
      const b = el('button', 'scn');
      b.innerHTML = `<span class="ic">${s.icon}</span><span><span class="nm">${s.name}</span>
        <span class="rf">${s.ref}</span></span>`;
      b.onclick = () => {
        document.querySelectorAll('.scn').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        this.sim.run(s.id);
        this.showWhy(s);
        if (this.sim.view !== 'cut' && !this.nudged) {
          this.nudged = true;
          this.toast('TIP: press Cutaway to watch the fluids', true);
        }
        $('#scenarioName').textContent = `${s.name} — ${s.ref}`;
        this.toast(`${s.icon} ${s.name.toUpperCase()} INITIATED`);
        if (window.innerWidth <= 860) this.closePanels();
      };
      list.appendChild(b);
    });

    // ---- speed buttons ----
    const sp = $('#speeds');
    const labels = SPEED_LABELS;
    SPEEDS.forEach((v, i) => {
      const b = el('button', i === this.sim.speedIdx ? 'on' : '', labels[i]);
      if (v < 0) b.classList.add('auto');
      b.onclick = () => {
        this.sim.speedIdx = i; this.sim.cine = null;
        sp.querySelectorAll('button').forEach((x, j) => x.classList.toggle('on', j === i));
      };
      sp.appendChild(b);
    });
    this.speedBtns = sp;

    // ---- telemetry cards ----
    const cards = $('#cards');
    this.cardEls = this.sim.plants.map((p, i) => {
      const c = el('div', 'card ' + (i === 0 ? 'act' : 'pas'));
      c.innerHTML = `<h3>${i === 0 ? '⚙️' : '🌊'} ${i === 0 ? 'ACTIVE' : 'PASSIVE'} COOLING</h3>
        <div class="sub">${i === 0 ? 'Gen-II LWR · pumps, diesels, operators' : 'Gen-III+ LWR · gravity, convection, evaporation'}</div>
        <div class="stateHost"></div><div class="gauges"></div>
        <div class="paths"></div><div class="alarms"></div>`;
      cards.appendChild(c);
      return {
        root: c, state: c.querySelector('.stateHost'), g: c.querySelector('.gauges'),
        paths: c.querySelector('.paths'), alarms: c.querySelector('.alarms')
      };
    });

    // ---- toggles ----
    $('#tgExplain').onchange = (e) => {
      this.sim.showLabels = e.target.checked;
      if (this.sim.cutStage) this.sim.fitCut();
    };
    $('#tgZones').onchange = (e) => this.sim.showZones = e.target.checked;
    $('#tgSabotage').onchange = (e) => {
      this.sim.sabotage = e.target.checked;
      this.sim.passive.sabotaged = e.target.checked;
      this.toast(e.target.checked
        ? '⚠ PASSIVE SAFETY SYSTEMS DISABLED' : '✓ Passive safety systems restored',
        !e.target.checked);
    };
    const wind = $('#wind');
    wind.oninput = () => {
      const deg = +wind.value;
      $('#windVal').textContent = deg + '°';
      this.sim.fx.wind.dir = (deg - 45) * Math.PI / 180;
    };
    document.querySelectorAll('[data-cam]').forEach(b => {
      b.onclick = () => {
        const sim = this.sim, s = sim.world.sites, m = b.dataset.cam;
        sim.cine = null;
        sim.holdCamera();
        if (sim.view === 'cut') {
          sim.cutFocus = m === 'both' ? 'both' : m;
          sim.fitCut();
          document.querySelectorAll('[data-cut]').forEach(x =>
            x.classList.toggle('on', x.dataset.cut === sim.cutFocus));
          return;
        }
        if (m === 'active') sim.cam.focus(s.active.x + 7, s.active.y + 7, 1.15);
        else if (m === 'passive') sim.cam.focus(s.passive.x + 7, s.passive.y + 7, 1.15);
        else sim.overview();
      };
    });

    // ---- view switcher ----
    const setView = (v) => {
      this.sim.setView(v);
      $('#viewSite').classList.toggle('on', v === 'site');
      $('#viewCut').classList.toggle('on', v === 'cut');
      document.body.classList.toggle('cutmode', v === 'cut');
      if (v === 'cut') {
        const wide = window.innerWidth > 860;
        this.sim.cutFocus = wide ? 'both' : 'active';
        this.sim.fitCut();
        document.querySelectorAll('[data-cut]').forEach(x =>
          x.classList.toggle('on', x.dataset.cut === this.sim.cutFocus));
      }
      $('#viewHint').innerHTML = v === 'cut'
        ? 'Every moving line is a flow the model computed. When a loop stops here, it stopped there.'
        : 'Switch to <b>Cutaway</b> to watch the water, steam and hydrogen move inside each containment.';
    };
    $('#viewSite').onclick = () => setView('site');
    $('#viewCut').onclick = () => setView('cut');
    document.querySelectorAll('[data-cut]').forEach(b => {
      b.onclick = () => {
        this.sim.cutFocus = b.dataset.cut;
        this.sim.fitCut();
        document.querySelectorAll('[data-cut]').forEach(x =>
          x.classList.toggle('on', x === b));
      };
    });

    // ---- top actions ----
    $('#btnReset').onclick = () => {
      this.sim.softReset();
      document.querySelectorAll('.scn').forEach(x => x.classList.remove('on'));
      $('#scenarioName').textContent = 'Select a scenario — both units run side by side';
      $('#whyBox').innerHTML = '';
      this.toast('✓ SIMULATION RESET', true);
    };
    $('#btnHelp').onclick = () => $('#modal').classList.add('open');
    $('#modalClose').onclick = $('#startBtn').onclick = () => $('#modal').classList.remove('open');

    // ---- mobile panels ----
    $('#btnPanels').onclick = () => this.togglePanel('left');
    document.querySelectorAll('[data-open]').forEach(b => {
      b.onclick = () => {
        const k = b.dataset.open;
        if (k === 'feedsheet') { $('#feed').classList.toggle('show'); return; }
        this.togglePanel(k);
      };
    });
    document.querySelectorAll('[data-close]').forEach(b => {
      b.onclick = () => $('#' + b.dataset.close).classList.remove('show');
    });

    this.sim.onFeed = () => this.renderFeed();
  }

  togglePanel(id) {
    const p = $('#' + id);
    const was = p.classList.contains('show');
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('show'));
    if (!was) p.classList.add('show');
    document.querySelectorAll('#mobileTabs button').forEach(b =>
      b.classList.toggle('on', b.dataset.open === id && !was));
  }
  closePanels() { document.querySelectorAll('.panel').forEach(x => x.classList.remove('show')); }

  showWhy(s) {
    // `watch` is the line that tells a reader where to point their eyes. It was
    // written for every scenario, styled in the stylesheet, and then never put
    // on the page. It goes second, right after the one-line summary.
    $('#whyBox').innerHTML = `<h4>${s.icon} ${s.name} — what happens, and why</h4>
      <p class="lede">${s.lede}</p>
      <p class="watch"><span>WATCH</span><i>${s.watch}</i></p>
      <p>${s.detail}</p><p><b>${s.why}</b></p>`;
  }

  toast(msg, ok) {
    const t = el('div', 'tst' + (ok ? ' ok' : ''), msg);
    $('#toast').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
    setTimeout(() => t.remove(), 3100);
  }

  // -------------------------------------------------------------------
  // thresholds = [warnAt, badAt]; invert=true means LOW is dangerous
  gauge(label, val, unit, frac, thresholds, invert, fixed) {
    const f = clamp(frac, 0, 1);
    let col = fixed || 'var(--accent)';
    if (!fixed) {
      const [wa, ba] = thresholds;
      const bad = invert ? f < ba : f > ba;
      const warn = invert ? f < wa : f > wa;
      if (bad) col = 'var(--crit)'; else if (warn) col = 'var(--warn)';
    }
    return `<div class="g"><div class="lbl"><span>${label}</span><b>${val}${unit}</b></div>
      <div class="bar"><i style="width:${(f * 100).toFixed(1)}%;background:${col};
      box-shadow:0 0 8px ${col}"></i></div></div>`;
  }

  update() {
    const sim = this.sim;
    $('#clock').textContent = fmtTime(sim.t);
    const auto = SPEEDS[sim.speedIdx] < 0;
    const narrow = window.innerWidth <= 860;
    this.speedBtns.querySelectorAll('button')[5].textContent =
      (auto && !narrow) ? `AUTO ${Math.round(sim.speed)}\u00d7` : 'AUTO';
    // speed highlight (cinematics override)
    this.speedBtns.querySelectorAll('button').forEach((x, j) =>
      x.classList.toggle('on', j === sim.speedIdx));

    sim.plants.forEach((p, i) => {
      const c = this.cardEls[i];
      const st = p.state;
      const kind = /SAFE|RECOV|NORMAL/.test(st) ? 'ok'
        : /BLACKOUT|DEGRADED/.test(st) ? 'warn' : 'crit';
      c.state.innerHTML = `<span class="state ${kind}">${st}</span>`;

      const pctPow = (p.qDecay / P0) * 100;
      const tC = p.Tclad - 273;
      const cons = p.consequences();
      c.g.innerHTML =
        this.gauge('Thermal power', pctPow < 1 ? pctPow.toFixed(2) : pctPow.toFixed(0), '% ' +
          `(${fmtNum(p.qDecay / 1e6, ' MW', 0)})`, Math.pow(pctPow / 100, 0.35), [0.6, 0.85], false,
          p.powerFrac > 1.5 ? 'var(--crit)' : 'var(--passive)') +
        this.gauge('Core water level', (p.level * 100).toFixed(0), '%', p.level, [0.85, 0.55], true) +
        this.gauge('Cladding temperature', tC.toFixed(0), ' °C', clamp((tC - 200) / 2500, 0, 1), [0.28, 0.44]) +
        this.gauge('Heat removed / produced', (p.coolingMargin * 100).toFixed(0), '%',
          clamp(p.coolingMargin, 0, 1), [0.98, 0.6], true) +
        this.gauge('Containment pressure', p.pCtmt.toFixed(2), ' MPa', clamp(p.pCtmt / 1.1, 0, 1), [0.38, 0.62]) +
        this.gauge('Hydrogen generated', (p.h2 + p.h2Building).toFixed(0), ' kg',
          clamp((p.h2 + p.h2Building) / 900, 0, 1), [0.05, 0.25]) +
        this.gauge('Core damage', (p.coreDamage * 100).toFixed(1), ' %', p.coreDamage, [0.01, 0.2]) +
        this.gauge('Cs-137 released', cons.pbq < 0.01 ? cons.pbq.toExponential(1) : cons.pbq.toFixed(2),
          ' PBq', clamp(Math.log10(1 + cons.pbq) / 2, 0, 1), [0.01, 0.2]) +
        (i === 0
          ? this.gauge('DC battery charge (8 h)', (p.battery * 100).toFixed(0), '%',
            p.battery, [0.5, 0.15], true)
          : this.gauge('Gravity tank PCCWST (72 h)', (p.pccwst / 3e4).toFixed(0), '%',
            p.pccwst / 3e6, [0.5, 0.15], true));

      const paths = p.paths && p.paths.length
        ? p.paths.map(x => `<div class="p">${x}</div>`).join('')
        : '<div class="none">⛔ NO HEAT REMOVAL PATH AVAILABLE</div>';
      const wrecked = p.coreDamage > 0.01 || !p.ctmtIntact;
      const grace = wrecked ? null : (i === 0
        ? (p.acPower ? null : `${(p.battery * p.batteryHours).toFixed(1)} h of battery left`)
        : `${(72 * (p.pccwst / 3e6)).toFixed(0)} h before anyone has to do anything`);
      c.paths.innerHTML = paths + (grace
        ? `<div class="grace">\u23f1 ${grace}</div>` : '');
      c.alarms.innerHTML = p.alarms.map(a => `<span class="alarm">${a}</span>`).join('');
    });

    this.renderConsequences();
  }

  renderConsequences() {
    const [a, b] = this.sim.plants;
    const ca = a.consequences(), cb = b.consequences();
    const inesCol = (n) => n >= 6 ? '#ff5c48' : n >= 4 ? '#ffc44d' : n >= 1 ? '#9fd3e8' : '#63e08a';
    const row = (lbl, va, vb) =>
      `<tr><td>${lbl}</td><td class="a">${va}</td><td class="b">${vb}</td></tr>`;
    const km2 = (v) => v < 0.05 ? '—' : fmtNum(v, ' km²', v < 10 ? 1 : 0);
    const ppl = (v) => v < 10 ? '—' : fmtNum(v, '', 0);
    const usd = (v) => v < 0.05 ? '—' : '$' + v.toFixed(v < 10 ? 1 : 0) + 'B';

    document.querySelector('#consequences').innerHTML = `
      <div class="ines">
        <div class="inesBox"><div class="n" style="color:${inesCol(a.ines())}">${a.ines()}</div>
          <div class="l">INES · Active</div></div>
        <div class="inesBox"><div class="n" style="color:${inesCol(b.ines())}">${b.ines()}</div>
          <div class="l">INES · Passive</div></div>
      </div>
      <table class="ctable">
        <tr><th>Consequence</th><th>Active</th><th>Passive</th></tr>
        ${row('Cs-137 released', ca.pbq < 1e-3 ? '—' : ca.pbq.toFixed(2) + ' PBq',
      cb.pbq < 1e-3 ? '—' : cb.pbq.toFixed(2) + ' PBq')}
        ${row('Core damaged', (a.coreDamage * 100).toFixed(1) + '%', (b.coreDamage * 100).toFixed(1) + '%')}
        ${row('Land > 555 kBq/m²', km2(ca.land), km2(cb.land))}
        ${row('Exclusion radius', ca.pbq < 1e-3 ? '—' : ca.exclusionR.toFixed(1) + ' km',
        cb.pbq < 1e-3 ? '—' : cb.exclusionR.toFixed(1) + ' km')}
        ${row('People displaced', ppl(ca.evac), ppl(cb.evac))}
        ${row('Latent cancers (LNT)', ca.cancers < 1 ? '—' : Math.round(ca.cancers),
          cb.cancers < 1 ? '—' : Math.round(cb.cancers))}
        ${row('Acute casualties', ca.acute || '—', cb.acute || '—')}
        ${row('Cleanup + liability', usd(ca.cost), usd(cb.cost))}
        ${row('Explosions', a.explosions || '—', b.explosions || '—')}
      </table>
      ${this.verdictHTML(a, b, ca, cb)}`;
  }

  verdictHTML(a, b, ca, cb) {
    if (!this.sim.scenario) return `<div class="verdict">Pick a scenario. Both units are hit by the
      <b>identical</b> hazard at the identical moment — the only variable is how they remove decay heat.</div>`;
    if (this.sim.sabotage && b.coreDamage > 0.01) {
      return `<div class="verdict bad">With its passive systems <b>deliberately disabled</b>, the Gen-III+
        unit fails too — which is the point: the survival above is produced by the passive
        equipment, not by the model being kind to it.</div>`;
    }
    if (ca.pbq < 1e-3 && cb.pbq < 1e-3) {
      return `<div class="verdict">Both units are still holding. Let it run, or raise the time
        multiplier — the active plant's margin is measured in <b>battery hours</b>.</div>`;
    }
    const ratio = cb.pbq > 1e-6 ? (ca.pbq / cb.pbq) : Infinity;
    const factor = !isFinite(ratio) ? 'essentially zero' : `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}×`;
    return `<div class="verdict"><b>Result:</b> the active unit released
      <b>${ca.pbq.toFixed(2)} PBq</b> of Cs-137 and reached <b>INES ${a.ines()}</b>;
      the passive unit released ${cb.pbq < 1e-3 ? '<b>nothing measurable</b>' : `<b>${cb.pbq.toFixed(3)} PBq</b>`}
      (${factor} less) at <b>INES ${b.ines()}</b>.
      ${cb.coreDamage < 0.01 ? 'Its core never uncovered: the water was already above it, and gravity does not need a diesel.' : ''}
      </div>`;
  }

  renderFeed() {
    const f = this.sim.feed;
    const host = document.querySelector('#feedInner');
    host.innerHTML = f.slice(-40).reverse().map(e =>
      `<div class="ev ${e.kind}"><span class="tm">${fmtTime(e.t)}</span><span class="tx">${e.msg}${e.n > 1 ? ` <b class="xn">\u00d7${e.n}</b>` : ''}</span></div>`
    ).join('');
  }
}
