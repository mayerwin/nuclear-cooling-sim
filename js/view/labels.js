// ---------------------------------------------------------------------------
// labels.js - the writing on the picture.
//
// Real HTML, anchored to a 3-D point by CSS2DRenderer, then laid out in screen
// space: every caption is pushed inside the part of the window the panels
// leave free, pushed off any caption it lands on, and joined back to the thing
// it names by a leader line. A caption that is clipped, or sitting on another
// caption, is not a caption.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { L } from './unit.js';
import { state } from './state.js';

function tag(cls) {
  const el = document.createElement('div');
  el.className = 'anchor';
  const lead = document.createElement('i');
  lead.className = 'lead';
  const box = document.createElement('div');
  box.className = 'tag ' + cls;
  el.append(lead, box);
  const o = new CSS2DObject(el);
  o.center.set(0, 0);
  return { el, box, lead, o };
}

const _v = new THREE.Vector3();

export class Labels {
  constructor(stage, units) {
    this.stage = stage;
    this.units = units;
    this.items = [];
    this.focus = 'both';
    for (const u of units) {
      const set = {};
      const add = (key, cls, x, y, z, bias) => {
        const t = tag(cls);
        t.o.position.set(x, y, z);
        u.root.add(t.o);
        set[key] = t;
        this.items.push({ u, key, bias: bias || [0, 0], ...t });
      };
      // bias is where the caption prefers to sit relative to its anchor, in
      // pixels, so that a name does not cover the thing it names.
      add('title', 'title', 0, 50, 0, [0, -6]);
      add('rpv', 'part', L.rpv.x + 1, 21, L.rpv.z + 3, [86, -50]);
      add('sg', 'part', L.sg.x, 29, L.sg.z, [-96, -46]);
      add('pump', 'part', L.rcp.x, 12.5, L.rcp.z + 2, [-88, 34]);
      add('turb', 'part', L.turb.x - 7, 13.5, L.turb.z, [-10, -58]);
      add('gen', 'part', L.turb.x + 1.5, 12, L.turb.z, [76, -34]);
      add('store', 'part',
        u.passive ? L.pool.x : L.tank.x,
        u.passive ? L.pool.y + 6.5 : 2.5,
        u.passive ? L.pool.z : L.tank.z,
        u.passive ? [0, -34] : [-40, 46]);
      add('power', 'part', L.turb.x + 13, 15.5, L.turb.z - 11, [64, -30]);
      if (!u.passive) add('eccs', 'part', L.eccs.x, 5.2, L.eccs.z, [-30, 44]);
      add('vent', 'part', L.stack.x, L.stack.h + 1.5, L.stack.z, [46, -18]);
      u.labels = set;
    }
  }

  setFocus(f) { this.focus = f; }

  // The rectangle of the window that is not under a panel or the log.
  freeRect() {
    const w = window.innerWidth, h = window.innerHeight;
    const bar = document.getElementById('bar').getBoundingClientRect().height;
    const feed = document.getElementById('feed').getBoundingClientRect();
    const wide = w > 980;
    const l = document.getElementById('left').getBoundingClientRect();
    const r = document.getElementById('right').getBoundingClientRect();
    return {
      x0: (wide ? l.right : 0) + 10,
      x1: (wide ? r.left : w) - 10,
      y0: bar + 10,
      y1: (feed.height ? feed.top : h) - 10
    };
  }

  update() {
    for (const u of this.units) {
      const p = u.plant, st = state(p);
      const on = this.focus === 'both'
        || (this.focus === 'active' && !u.passive)
        || (this.focus === 'passive' && u.passive);
      const detail = on && this.focus !== 'both';
      // Side by side there is no room for a running commentary on both
      // stations at once. The name and the verdict, nothing else.
      const KEY = ['title'];
      const S = u.labels;
      const set = (k, html) => {
        const t = S[k]; if (!t) return;
        // In the comparison view only the things that differ are named, or the
        // two sets of captions land on each other.
        t.o.visible = on && (detail || KEY.includes(k));
        if (!t.o.visible) return;
        if (t.box.innerHTML !== html) t.box.innerHTML = html;
      };
      const MW = (p.qDecay || 0) / 1e6;
      set('title', `<b class="${u.passive ? 'bPass' : 'bAct'}">${u.passive ? 'PASSIVE' : 'ACTIVE'}</b>`
        + `<span class="chip ${st.good ? 'ok' : 'bad'}">${st.headline}</span>`);
      set('rpv', `<b>Reactor</b><span>water ${Math.round(st.lvl * 100)}%`
        + `<i class="${st.T > 800 ? 'bad' : st.T > 360 ? 'warn' : ''}">${st.T.toFixed(0)} °C</i></span>`
        + `<em>${p.scrammed
          ? `shut down, still making ${MW < 10 ? MW.toFixed(1) : Math.round(MW)} MW of heat`
          : `running, making ${Math.round(MW).toLocaleString('en-US')} MW of heat`}</em>`);
      set('sg', `<b>Boiler</b><span>${st.sink === 'turbine' ? 'taking the heat away'
        : st.sink === 'pool' ? 'not needed, the pool has it'
          : st.sink === 'shell' ? 'not needed, the shell has it' : 'not taking any heat'}</span>`
        + '<em>two circuits, never mixing</em>');
      const pumpTx = st.s.rcp
        ? (st.P ? 'the cooling needs no pump at all' : 'the cooling needs pumps like this')
        : (st.P ? (st.flow > 0 ? 'water still creeps round on its own, far slower'
          : 'and the cooling carries on anyway')
          : st.steamOnly ? 'the steam pump covers it'
            : st.live ? 'the backups must take over' : 'the backups have no power');
      set('pump', `<b>Pump</b><span class="${st.s.rcp ? '' : st.P ? 'ok' : 'bad'}">`
        + `${st.s.rcp ? 'spinning' : 'stopped'}</span><em>${pumpTx}</em>`);
      set('turb', `<b>Turbine</b><span>${u.spin > 4 ? 'steam is turning it'
        : u.spin > 0.6 ? 'running down' : 'stopped'}</span>`);
      const mwe = u.spin > 12 ? Math.round((u.qSec || 0) / 1e6 * 0.33) : 0;
      const steaming = (u.secondary.mdot || 0) > 1;
      set('gen', `<b>Generator</b><span class="${mwe ? 'power' : ''}">${mwe
        ? mwe.toLocaleString('en-US') + ' MW of electricity'
        : u.spin > 1 ? (steaming ? 'running up to speed' : 'coasting down, no load')
          : 'no electricity'}</span>`);
      if (u.passive) {
        set('store', `<b>${st.onFloor ? 'Water on the floor' : 'The pool, higher than the reactor'}</b>`
          + `<span class="${st.lost ? 'bad' : st.cracked ? 'warn' : 'ok'}">${st.lost ? 'escaping as steam'
            : st.onFloor ? 'still gets back in'
              : st.cracked ? 'cracked, draining'
                : st.injecting ? 'falling into the reactor'
                  : st.poolLoop ? 'taking the heat from the reactor'
                    : 'ready, no pump needed'}</span>`
          + ((st.s.pccs || 0) > 0.05 && st.poolFrac < 0.985
            ? '<em>steam condenses on the shell and drains back in</em>' : ''));
      } else {
        set('store', '<b>Water in the basement</b><span class="'
          + (st.injecting ? '' : (st.live && p.pumpsOk) ? '' : 'bad') + '">'
          + (st.injecting ? 'being pumped up'
            : !st.live ? 'cannot reach the reactor'
              : !p.pumpsOk ? 'the pumps have failed' : 'waiting down here') + '</span>');
        set('eccs', `<b>Backup pump</b><span class="${st.injecting ? 'ok'
          : (st.live && p.pumpsOk) ? 'warn' : 'bad'}">${st.steamOnly ? 'running on steam'
            : st.injecting ? 'pumping' : !st.live ? 'no power'
              : !p.pumpsOk ? 'broken' : 'waiting'}</span>`
          + `<em>${st.steamOnly ? 'runs on steam, not the grid'
            : st.injecting ? 'lifting water uphill'
              : !st.live ? 'it needs electricity'
                : !p.pumpsOk ? 'it cannot lift the water' : 'starts if the level falls'}</em>`);
      }
      const src = st.s.grid ? 'grid' : st.s.diesel ? 'diesels'
        : st.s.battery > 0 ? `batteries, ${(st.s.battery * p.batteryHours).toFixed(0)} h left` : 'none';
      set('power', `<b>Power</b><span class="${st.live ? 'power' : st.s.battery > 0 ? 'warn' : 'bad'}">${src}</span>`);
      set('vent', st.s.vent
        ? '<b class="warn">Vent open</b><em>the way pressure is let out on purpose</em>'
        : '<b>Vent</b><span>closed</span>');
    }
    this.layout();
  }

  // ---- screen-space layout ------------------------------------------------
  layout() {
    const cam = this.stage.camera;
    const w = window.innerWidth, h = window.innerHeight;
    const R = this.freeRect();
    const placed = [];
    const live = [];
    for (const it of this.items) {
      if (!it.o.visible || !it.u.root.visible) { it.box.style.opacity = '0'; continue; }
      it.o.getWorldPosition(_v).project(cam);
      if (_v.z < -1 || _v.z > 1) { it.box.style.opacity = '0'; continue; }
      it.sx = (_v.x * 0.5 + 0.5) * w;
      it.sy = (-_v.y * 0.5 + 0.5) * h;
      const r = it.box.getBoundingClientRect();
      it.bw = r.width || 120;
      it.bh = r.height || 34;
      live.push(it);
    }
    // Titles first, then the rest from the top down, so the important one gets
    // the spot it asked for and the others move round it.
    live.sort((a, b) => (a.key === 'title' ? -1 : b.key === 'title' ? 1 : 0)
      || (a.sy + a.bias[1]) - (b.sy + b.bias[1]));
    for (const it of live) {
      const hw = it.bw / 2, hh = it.bh / 2;
      let px = it.sx + it.bias[0], py = it.sy + it.bias[1];
      px = Math.min(Math.max(px, R.x0 + hw), Math.max(R.x0 + hw, R.x1 - hw));
      py = Math.min(Math.max(py, R.y0 + hh), Math.max(R.y0 + hh, R.y1 - hh));
      // push off anything already down, downwards first, upwards if there is
      // no room left below
      for (let pass = 0; pass < 24; pass++) {
        let hit = null;
        for (const q of placed) {
          if (Math.abs(px - q.x) < hw + q.hw + 6 && Math.abs(py - q.y) < hh + q.hh + 5) { hit = q; break; }
        }
        if (!hit) break;
        const down = hit.y + hit.hh + hh + 6;
        const up = hit.y - hit.hh - hh - 6;
        py = (down + hh <= R.y1) ? down : up;
        py = Math.min(Math.max(py, R.y0 + hh), Math.max(R.y0 + hh, R.y1 - hh));
      }
      placed.push({ x: px, y: py, hw, hh });
      const dx = px - it.sx, dy = py - it.sy;
      it.box.style.opacity = '1';
      it.box.style.transform = `translate(-50%,-50%) translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
      // the leader, so a caption that had to move still points at its part
      const d = Math.hypot(dx, dy);
      if (d > 26) {
        it.lead.style.opacity = '1';
        it.lead.style.width = (d - 4) + 'px';
        it.lead.style.transform = `rotate(${Math.atan2(dy, dx).toFixed(3)}rad)`;
      } else {
        it.lead.style.opacity = '0';
      }
    }
  }
}
