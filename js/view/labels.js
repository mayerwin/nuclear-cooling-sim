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
import { L } from './unit.js?v=f7bec3ea79';
import { state } from './state.js?v=f7bec3ea79';

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
    // Set by a resize: every box is measured again and the free rectangle is
    // recomputed. Between resizes a caption is only measured when its text
    // changed, because reading a box's size right after writing its
    // transform forces the browser to lay the page out again, and doing that
    // twenty times a frame was the caption layer's whole cost.
    this.remeasure = true;
    this.frameNo = 0;
    for (const u of units) {
      const set = {};
      const add = (key, cls, x, y, z, side) => {
        const t = tag(cls);
        t.o.position.set(x, y, z);
        u.root.add(t.o);
        set[key] = t;
        this.items.push({ u, key, side: side || 'L', ...t });
      };
      // side is which margin the caption is parked in. Captions live in two
      // columns down the edges of the picture and reach their part with a
      // leader, because a plate sitting on the machine it names hides it.
      add('title', 'title', 0, 50, 0, 'C');
      add('rpv', 'part', L.rpv.x + 1, 15, L.rpv.z + 3, 'L');
      add('sg', 'part', L.sg.x, 24, L.sg.z, 'L');
      add('pump', 'part', L.rcp.x, 11.5, L.rcp.z + 2, 'L');
      add('store', 'part',
        u.passive ? L.pool.x : L.tank.x,
        u.passive ? L.pool.y + 3.5 : 3.4,
        u.passive ? L.pool.z : L.tank.z, 'L');
      if (!u.passive) add('eccs', 'part', L.eccs.x, 5.2, L.eccs.z, 'L');
      add('turb', 'part', L.turb.x - 6.4, 10.6, L.turb.z, 'R');
      add('gen', 'part', L.turb.x + 0.6, 9.8, L.turb.z, 'R');
      add('vent', 'part', L.stack.x, L.stack.h + 1.5, L.stack.z, 'L');
      add('sea', 'part', L.turb.x + 5.8, -1.2, L.turb.z - 1.5, 'R');
      add('power', 'part', L.turb.x + 0.6, 13.4, L.turb.z, 'R');
      u.labels = set;
    }
  }

  setFocus(f) { this.focus = f; }
  invalidate() { this.remeasure = true; }

  // The rectangle of the window that is not under a panel or the log.
  // In the LABEL LAYER'S own coordinates, not the page's. On a phone the layer
  // is the band between the toolbar and the log, so it starts partway down the
  // page and is shorter than it; measuring the free space in page pixels and
  // then placing a caption in band pixels put every caption too low by the
  // height of the toolbar, and the bottom one was cut in half by the layer's
  // own edge.
  freeRect() {
    const w = window.innerWidth, h = window.innerHeight;
    const rc = this.stage.renderer.domElement.getBoundingClientRect();
    const bar = document.getElementById('bar').getBoundingClientRect().height;
    const feed = document.getElementById('feed').getBoundingClientRect();
    const wide = w > 980;
    const l = document.getElementById('left').getBoundingClientRect();
    const r = document.getElementById('right').getBoundingClientRect();
    return {
      x0: Math.max(0, (wide ? l.right : 0) + 10 - rc.left),
      x1: Math.min(rc.width, (wide ? r.left : w) - 10 - rc.left),
      y0: Math.max(0, bar + 10 - rc.top),
      y1: Math.min(rc.height, (feed.height ? feed.top : h) - 16 - rc.top)
    };
  }

  update() {
    for (const u of this.units) {
      const p = u.plant, st = state(p);
      const on = this.focus === 'both'
        || (this.focus === 'active' && !u.passive)
        || (this.focus === 'passive' && u.passive);
      // On a wide screen every part is captioned in both views: side by
      // side, the left column describes the left station and the right
      // column the right one (see layout). On a phone there is no room for
      // a commentary at all: the name, the verdict, and the one number that
      // matters.
      const narrow = window.innerWidth < 700;
      const detail = on && !narrow;
      const KEY = narrow && on && this.focus !== 'both' ? ['title', 'rpv'] : ['title'];
      const S = u.labels;
      const set = (k, html) => {
        const t = S[k]; if (!t) return;
        // In the comparison view only the things that differ are named, or the
        // two sets of captions land on each other.
        t.o.visible = on && ((detail && !narrow) || KEY.includes(k));
        if (!t.o.visible) return;
        // Compared against the string last written, not the box's own
        // innerHTML: reading that serialises the node every time.
        if (t.html !== html) { t.box.innerHTML = html; t.html = html; t.dirty = true; }
      };
      const MW = (p.qDecay || 0) / 1e6;
      set('title', `<b class="${u.passive ? 'bPass' : 'bAct'}">${u.passive ? 'PASSIVE' : 'ACTIVE'}</b>`
        + `<span class="chip ${st.good ? 'ok' : 'bad'}">${st.headline}</span>`);
      set('rpv', `<b>Reactor</b><span>water ${Math.round(st.lvl * 100)}%`
        + `<i class="${st.T > 800 ? 'bad' : st.T > 360 ? 'warn' : ''}">${st.T.toFixed(0)} °C</i></span>`
        + `<em>${p.scrammed
          ? `shut down, still making ${MW < 10 ? MW.toFixed(1) : Math.round(MW)} MW of heat`
          : `running, making ${Math.round(MW).toLocaleString('en-US')} MW of heat`}</em>`);
      set('sg', `<b>Boiler</b><span>${st.sink === 'turbine'
        ? (u.spin > 1.2 ? 'taking the heat away' : 'boiling the heat off')
        : st.sink === 'pool' ? 'not needed, the pool has it'
          : st.sink === 'shell' ? 'not needed, the shell has it' : 'not taking any heat'}</span>`
        + `<em>${st.sink === 'turbine' && u.spin <= 4
          ? 'the steam is let straight out, and the water goes with it'
          : 'two circuits, never mixing'}</em>`);
      const pumpTx = st.s.rcp
        ? (st.P ? 'the cooling needs no pump at all' : 'the cooling needs pumps like this')
        : (st.P ? (st.flow > 0 ? 'water still creeps round on its own, far slower'
          : 'and the cooling carries on anyway')
          : st.steamOnly ? 'the steam pump covers it'
            : st.live ? 'the backups must take over' : 'the backups have no power');
      set('pump', `<b>Pump</b><span class="${st.s.rcp ? '' : st.P ? 'ok' : 'bad'}">`
        + `${st.s.rcp ? 'spinning' : 'stopped'}</span><em>${pumpTx}</em>`);
      set('turb', `<b>Turbine</b><span>${u.spin > 1.2 ? 'steam is turning it'
        : u.spin > 0.2 ? 'running down' : 'stopped'}</span>`);
      const mwe = u.spin > 3.5 ? Math.round((u.qSec || 0) / 1e6 * 0.33) : 0;
      const steaming = (u.secondary.mdot || 0) > 1;
      set('gen', `<b>Generator</b><span class="${mwe ? 'power' : ''}">${mwe
        ? mwe.toLocaleString('en-US') + ' MW of electricity'
        : u.spin > 0.3 ? (steaming ? 'running up to speed' : 'coasting down, no load')
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
        set('store', '<b>Emergency water tank</b><span class="'
          + (st.injecting ? '' : (st.live && p.pumpsOk) ? '' : 'bad') + '">'
          + (st.injecting ? 'being pumped in'
            : !st.live ? 'cannot reach the reactor'
              : !p.pumpsOk ? 'the pumps have failed' : 'full, waiting') + '</span>');
        set('eccs', `<b>Backup pump</b><span class="${st.injecting ? 'ok'
          : (st.live && p.pumpsOk) ? 'warn' : 'bad'}">${st.steamOnly ? 'running on steam'
            : st.injecting ? 'pumping' : !st.live ? 'no power'
              : !p.pumpsOk ? 'broken' : 'waiting'}</span>`
          + `<em>${st.steamOnly ? 'runs on steam, not the grid'
            : st.injecting ? 'lifting water uphill'
              : !st.live ? 'it needs electricity'
                : !p.pumpsOk ? 'it cannot lift the water' : 'starts if the level falls'}</em>`);
      }
      const cwOn = Math.abs(u.legCw ? u.legCw.v : 0) > 0.02;
      set('sea', `<b>Sea water</b><span class="${cwOn || p.uhs ? '' : 'bad'}">${cwOn
        ? 'carrying the heat away' : p.uhs ? 'standing still' : 'gone'}</span>`
        + `<em>${cwOn ? 'through the condenser and back to the sea'
          : p.uhs ? 'no steam to condense just now'
            : 'the intake is lost, the heat has nowhere to go'}</em>`);
      const src = st.s.grid ? 'grid' : st.s.diesel ? 'diesels'
        : st.s.battery > 0 ? `batteries, ${(st.s.battery * p.batteryHours).toFixed(0)} h left` : 'none';
      // The lamp is the whole point of the machine: two wires and something
      // that lights up. The station's own supply goes underneath it, because
      // when it fails that is the whole story of the accident.
      set('power', `<b>Electricity</b><span class="${mwe ? 'power' : 'bad'}">${mwe
        ? 'the lamp is lit' : 'the lamp is out'}</span>`
        + `<em>plant on ${src}</em>`);
      set('vent', st.s.vent
        ? '<b class="warn">Vent open</b><em>the way pressure is let out on purpose</em>'
        : '<b>Vent</b><span>closed</span>');
    }
    this.layout();
  }

  // ---- screen-space layout ------------------------------------------------
  // Two columns down the edges of the free area, each caption at the height of
  // the thing it names, pushed apart just enough not to touch, and joined to
  // its part by a leader. Nothing lands on the machinery.
  layout() {
    const cam = this.stage.camera;
    // Project against the camera as it is now, not as it was when the last
    // frame was drawn. Vector3.project reuses matrixWorldInverse, which only
    // the renderer refreshes, and with a damped camera that one frame of lag
    // is a permanent offset between a caption and the leader pointing at it.
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    this.frameNo++;
    // The free rectangle moves only when the page does; every thirtieth frame
    // is a safety net for a panel that changed without a resize.
    if (this.remeasure || !this.rect || this.frameNo % 30 === 0) {
      this.rc = this.stage.renderer.domElement.getBoundingClientRect();
      this.rect = this.freeRect();
    }
    const rc = this.rc;
    const w = rc.width, h = rc.height;
    const R = this.rect;
    const narrow = R.x1 - R.x0 < 620;
    const cols = { L: [], R: [], C: [] };
    for (const it of this.items) {
      if (!it.o.visible || !it.u.root.visible) { it.box.style.opacity = '0'; it.lead.style.opacity = '0'; continue; }
      // The renderer hides an anchor it did not draw last frame, and a hidden
      // box measures zero wide, which would park the caption in the wrong
      // column for as long as it takes to draw the next frame.
      it.el.style.display = '';
      it.o.getWorldPosition(_v).project(cam);
      if (_v.z < -1 || _v.z > 1) { it.box.style.opacity = '0'; it.lead.style.opacity = '0'; continue; }
      it.sx = (_v.x * 0.5 + 0.5) * w;
      it.sy = (-_v.y * 0.5 + 0.5) * h;
      if (it.dirty || this.remeasure || !it.bw) {
        const r = it.box.getBoundingClientRect();
        it.bw = r.width || it.bw || 120;
        it.bh = r.height || it.bh || 34;
        // A box the renderer has not drawn yet measures zero: try again.
        it.dirty = !r.width;
      }
      // Side by side, each station's captions take the margin on its own
      // side, whichever part they name.
      const side = it.side === 'C' ? 'C' : this.focus === 'both' ? (it.u.passive ? 'R' : 'L') : it.side;
      cols[narrow && side === 'R' ? 'L' : side].push(it);
    }
    this.remeasure = false;
    const place = (it, px, py) => {
      const dx = px - it.sx, dy = py - it.sy;
      it.box.style.opacity = '1';
      it.box.style.transform = `translate(-50%,-50%) translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
      const d = Math.hypot(dx, dy);
      if (d > 30) {
        it.lead.style.opacity = '1';
        it.lead.style.width = (d - 6) + 'px';
        it.lead.style.transform = `rotate(${Math.atan2(dy, dx).toFixed(3)}rad)`;
      } else {
        it.lead.style.opacity = '0';
      }
    };
    // the two titles keep the spot over their own building
    let topY = R.y0;
    for (const it of cols.C) {
      const py = Math.max(R.y0 + it.bh / 2, Math.min(it.sy, R.y1 - it.bh / 2));
      place(it, Math.min(Math.max(it.sx, R.x0 + it.bw / 2), R.x1 - it.bw / 2), py);
      topY = Math.max(topY, py + it.bh / 2 + 10);
    }
    if (narrow) {
      // No margin to park anything in: the one caption there is room for sits
      // along the bottom, out of the way of the building.
      let yy = R.y1;
      for (const it of cols.L.concat(cols.R)) {
        yy -= it.bh / 2;
        place(it, Math.min(Math.max(it.sx, R.x0 + it.bw / 2), R.x1 - it.bw / 2), yy);
        yy -= it.bh / 2 + 8;
      }
      return;
    }
    for (const side of ['L', 'R']) {
      const list = cols[side];
      if (!list.length) continue;
      list.sort((a, b) => a.sy - b.sy);
      const gap = 9;
      // first pass: everyone at the height of their own part, in order
      let y = topY;
      for (const it of list) {
        y = Math.max(y + it.bh / 2, it.sy);
        it.py = y;
        y += it.bh / 2 + gap;
      }
      // If that runs off the bottom, pull the column back up; and if there
      // is not room for the column at all, share what room there is evenly
      // from top to bottom instead of piling the first captions onto each
      // other at the top, which is what clamping them did.
      const over = (list[list.length - 1].py + list[list.length - 1].bh / 2) - R.y1;
      if (over > 0) {
        let need = 0;
        for (const it of list) need += it.bh;
        const room = R.y1 - topY;
        if (need + gap * (list.length - 1) > room) {
          const step = list.length > 1 ? (room - need) / (list.length - 1) : 0;
          let yy = topY;
          for (const it of list) { it.py = yy + it.bh / 2; yy += it.bh + step; }
        } else {
          let yy = R.y1;
          for (let i = list.length - 1; i >= 0; i--) {
            const it = list[i];
            yy = Math.min(yy - it.bh / 2, it.py);
            it.py = Math.max(yy, topY + it.bh / 2);
            yy -= it.bh / 2 + gap;
          }
        }
      }
      for (const it of list) {
        const px = side === 'L' ? R.x0 + it.bw / 2 : R.x1 - it.bw / 2;
        place(it, px, it.py);
      }
    }
  }
}
