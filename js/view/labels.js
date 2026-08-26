// ---------------------------------------------------------------------------
// labels.js - the writing on the picture.
//
// Real HTML, positioned by a 3-D anchor. Typography is CSS, so nothing has to
// be shrunk to fit and nothing is drawn twice.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { L, FUEL_TOP_FRAC } from './unit.js';
import { state } from './state.js';

function tag(cls) {
  const el = document.createElement('div');
  el.className = 'tag ' + cls;
  const o = new CSS2DObject(el);
  o.center.set(0.5, 0.5);
  return { el, o };
}

export class Labels {
  constructor(stage, units) {
    this.units = units;
    this.items = [];
    this.focus = 'both';
    for (const u of units) {
      const set = {};
      const add = (key, cls, x, y, z) => {
        const t = tag(cls);
        t.o.position.set(x, y, z);
        u.root.add(t.o);
        set[key] = t;
        this.items.push({ u, key, ...t });
      };
      add('title', 'title', 0, 52, 0);
      add('rpv', 'part', L.rpv.x + 1, 24, L.rpv.z + 4);
      add('sg', 'part', L.sg.x - 5, 30, L.sg.z - 6);
      add('pump', 'part', L.rcp.x - 7, 10, L.rcp.z + 7);
      add('turb', 'part', L.turb.x - 8, 13, L.turb.z + 3);
      add('gen', 'part', L.turb.x + 9, 12, L.turb.z + 4);
      add('store', 'part',
        u.passive ? L.pool.x : L.tank.x,
        u.passive ? L.pool.y + 6 : 11,
        u.passive ? L.pool.z - 3 : L.tank.z);
      add('power', 'part', L.turb.x + 24, 20, L.turb.z - 2);
      if (!u.passive) add('eccs', 'part', L.eccs.x + 3, 2, L.eccs.z);
      add('vent', 'part', L.stack.x, L.stack.h + 3, L.stack.z);
      u.labels = set;
    }
  }

  setFocus(f) { this.focus = f; }

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
        if (t.el.innerHTML !== html) t.el.innerHTML = html;
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
          : st.sink === 'shell' ? 'not needed, the shell has it' : 'not taking any heat'}</span>`);
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
        ? '<b class="warn">Vent open</b><em>opened on purpose, to stop the containment bursting</em>'
        : '<b>Vent</b><span>closed</span>');
    }
  }
}
