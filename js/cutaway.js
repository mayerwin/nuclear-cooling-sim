// ---------------------------------------------------------------------------
// cutaway.js - what actually happens in the circuit, as a schematic.
//
// Drawn with JointJS (vendor/joint.min.js, MPL-2.0), whose Manhattan router
// does the orthogonal, obstacle-avoiding pipe routing. Hand-routed plumbing is
// where this view kept falling down; a library that does it properly is worth
// the 460 kB.
//
// Deliberately NOT to scale. The question this view answers is "where is the
// water going, and what stops it", so it holds five boxes a side and as few
// words as will carry the point. Real dimensions live in the site view and in
// the fidelity ledger.
//
// The whole comparison is one thing: when the pump stops, does anything still
// move, and is there water above the core to fall in.
// ---------------------------------------------------------------------------
import { MODE } from './plant.js';

const J = () => window.joint;

const C = {
  hot: '#e07a3c', hotHi: '#ff6a2a',
  cold: '#3fc0d8', water: '#2f8ed6',
  steam: '#b7c6d2', power: '#ffd35c',
  ok: '#63e08a', warn: '#ffc44d', bad: '#ff5c48',
  ink: '#dbe8f2', dim: '#93a6b6', panel: '#111a23', edge: '#6f7d8a'
};
// Physically, hotter is whiter. Visually, pale reads as harmless, and a core at
// 2900 C is not. The ramp stays in the red once the fuel is failing.
const RAMP = [[560, '#d9853a'], [720, '#e59a2e'], [900, '#e8702a'],
  [1100, '#e8481c'], [1500, '#f52d10'], [2200, '#ff3a18'], [3200, '#ff6a33']];
function hx(c) { const h = c.slice(1); const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export function tempColor(K) {
  if (K <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) if (K <= RAMP[i][0]) {
    const t = (K - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]);
    const a = hx(RAMP[i - 1][1]), b = hx(RAMP[i][1]);
    return `rgb(${a[0] + (b[0] - a[0]) * t | 0},${a[1] + (b[1] - a[1]) * t | 0},${a[2] + (b[2] - a[2]) * t | 0})`;
  }
  return RAMP[RAMP.length - 1][1];
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// ---- shapes ---------------------------------------------------------------
let SHAPES = null;
function defineShapes() {
  if (SHAPES) return SHAPES;
  const j = J();
  // A tank: header band with its name, a liquid level, one line of state.
  const Tank = j.dia.Element.define('n.Tank', {
    size: { width: 240, height: 220 },
    attrs: {
      body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 12,
        fill: C.panel, stroke: C.edge, strokeWidth: 3 },
      liquid: { x: 4, y: 4, width: 'calc(w-8)', height: 0, fill: C.water },
      mark: { x1: 5, x2: 'calc(w-5)', y1: 0, y2: 0, stroke: 'rgba(255,255,255,.55)',
        strokeWidth: 2, strokeDasharray: '7 6', opacity: 0 },
      markTx: { x: 'calc(w-9)', y: 0, textAnchor: 'end', fill: 'rgba(255,255,255,.75)',
        fontSize: 12, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui', opacity: 0 },
      head: { x: 2, y: 2, width: 'calc(w-4)', height: 34, rx: 10, fill: 'rgba(8,13,19,.94)' },
      name: { x: 'calc(w/2)', y: 25, textAnchor: 'middle', fill: C.ink,
        fontSize: 16, fontWeight: 800, fontFamily: 'ui-sans-serif,system-ui' },
      foot: { x: 2, y: 'calc(h-30)', width: 'calc(w-4)', height: 28, rx: 10,
        fill: 'rgba(8,13,19,.9)' },
      value: { x: 'calc(w/2)', y: 'calc(h-10)', textAnchor: 'middle', fill: C.dim,
        fontSize: 15, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [
    { tagName: 'rect', selector: 'body' }, { tagName: 'rect', selector: 'liquid' },
    { tagName: 'line', selector: 'mark' }, { tagName: 'rect', selector: 'head' },
    { tagName: 'text', selector: 'name' }, { tagName: 'rect', selector: 'foot' },
    { tagName: 'text', selector: 'value' }, { tagName: 'text', selector: 'markTx' }] });

  // A pump, drawn the way a process drawing draws one.
  const Pump = j.dia.Element.define('n.Pump', {
    size: { width: 118, height: 168 },
    attrs: {
      body: { cx: 'calc(w/2)', cy: 'calc(w/2)', r: 'calc(w/2-2)', fill: '#1b2a36',
        stroke: C.edge, strokeWidth: 3 },
      tri: { d: 'M 38 34 L 88 59 L 38 84 Z', fill: '#7fc6f0' },
      name: { x: 'calc(w/2)', y: 'calc(w+30)', textAnchor: 'middle', fill: C.ink,
        fontSize: 15, fontWeight: 800, fontFamily: 'ui-sans-serif,system-ui' },
      value: { x: 'calc(w/2)', y: 'calc(w+50)', textAnchor: 'middle', fill: C.dim,
        fontSize: 14, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [{ tagName: 'circle', selector: 'body' }, { tagName: 'path', selector: 'tri' },
    { tagName: 'text', selector: 'name' }, { tagName: 'text', selector: 'value' }] });

  // Where a line leaves the picture.
  const Flag = j.dia.Element.define('n.Flag', {
    size: { width: 190, height: 54 },
    attrs: {
      body: { refD: 'M 0 0 L 0.86 0 L 1 0.5 L 0.86 1 L 0 1 Z', fill: 'rgba(14,22,30,.95)',
        stroke: C.edge, strokeWidth: 2.5 },
      name: { x: 'calc(w/2-10)', y: 'calc(h/2+6)', textAnchor: 'middle', fill: C.ink,
        fontSize: 15, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [{ tagName: 'path', selector: 'body' }, { tagName: 'text', selector: 'name' }] });

  // A pipe: casing, bore, and a dash that moves when something is flowing.
  const Pipe = j.dia.Link.define('n.Pipe', {
    attrs: {
      casing: { connection: true, stroke: '#39424c', strokeWidth: 24, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      bore: { connection: true, stroke: C.water, strokeWidth: 16, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      flow: { connection: true, stroke: 'rgba(255,255,255,.92)', strokeWidth: 6, fill: 'none',
        strokeDasharray: '8 34', strokeDashoffset: 0, strokeLinecap: 'butt', opacity: 0 }
    },
    router: { name: 'orthogonal', args: { padding: 20 } },
    connector: { name: 'rounded', args: { radius: 22 } },
    connectionPoint: { name: 'anchor' },
    z: 1
  }, { markup: [{ tagName: 'path', selector: 'casing' }, { tagName: 'path', selector: 'bore' },
    { tagName: 'path', selector: 'flow' }] });

  // The electrical feed. Thin, dashed, and it goes out.
  const Wire = j.dia.Link.define('n.Wire', {
    attrs: {
      casing: { connection: true, stroke: '#232a31', strokeWidth: 10, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      bore: { connection: true, stroke: C.power, strokeWidth: 4, fill: 'none',
        strokeDasharray: '10 9', strokeDashoffset: 0, strokeLinejoin: 'round' }
    },
    router: { name: 'orthogonal', args: { padding: 16 } },
    connector: { name: 'rounded', args: { radius: 14 } },
    connectionPoint: { name: 'anchor' },
    z: 0
  }, { markup: [{ tagName: 'path', selector: 'casing' }, { tagName: 'path', selector: 'bore' }] });

  SHAPES = { Tank, Pump, Flag, Pipe, Wire };
  return SHAPES;
}

// ===========================================================================
// One circuit. Same five boxes on both sides; only the water supply moves.
// ===========================================================================
const W = 730, H = 1060;

class Circuit {
  constructor(plant, graph, ox) {
    this.p = plant;
    this.passive = plant.mode === MODE.PASSIVE;
    this.g = graph;
    this.ox = ox;
    this.cells = [];
    this.build();
  }
  add(c) { this.g.addCell(c); this.cells.push(c); return c; }
  // a caption riding on a pipe: no leader, no lookup
  tagPipe(link, text, col, pos, dx, dy) {
    link.labels([{ position: { distance: pos, offset: { x: dx || 0, y: dy || 0 } },
      attrs: { labelText: { text, fill: col, fontSize: 14, fontWeight: 700,
        fontFamily: 'ui-sans-serif,system-ui', textAnchor: 'middle',
        textVerticalAnchor: 'middle' } },
      markup: [{ tagName: 'text', selector: 'labelText' }] }]);
  }
  at(x, y) { return { x: this.ox + x, y }; }

  // The loop runs down the page: core on top, steam generator below it, the
  // pump in the return. The spare water is the only thing that moves between
  // the two designs - straight above the core on one, at the bottom behind a
  // pump on the other - so up against down carries the whole argument.
  build() {
    const S = defineShapes(), P = this.passive;
    const pipe = (a, b, sa, ta, col) => {
      const l = this.add(new S.Pipe({ source: { id: a.id, anchor: sa },
        target: { id: b.id, anchor: ta } }));
      if (col) l.attr('bore/stroke', col);
      return l;
    };
    const A = (name, dx, dy) => ({ name, args: { dx: dx || 0, dy: dy || 0 } });
    // a pump's box is taller than its circle so the caption fits inside it;
    // pipes must land on the circle, not the box
    const PA = (name) => name === 'bottom' ? A('bottom', 0, -58)
      : name === 'right' ? A('right', 0, -29) : name === 'left' ? A('left', 0, -29) : A(name);

    this.core = this.add(new S.Tank({ position: this.at(165, 175), size: { width: 275, height: 250 } }));
    this.core.attr({ name: { text: 'REACTOR CORE' }, mark: { opacity: 1 },
      markTx: { opacity: 1, text: 'top of fuel' } });

    this.sg = this.add(new S.Tank({ position: this.at(165, 640), size: { width: 275, height: 220 } }));
    this.sg.attr({ name: { text: 'STEAM GENERATOR' } });

    this.pump = this.add(new S.Pump({ position: this.at(510, 420), size: { width: 118, height: 176 } }));
    this.pump.attr({ name: { text: 'PUMP' } });

    this.flag = this.add(new S.Flag({ position: this.at(524, 764), size: { width: 150, height: 52 } }));
    this.flag.attr({ name: { text: 'heat out' } });

    this.supply = this.add(new S.Tank({
      position: P ? this.at(165, 0) : this.at(165, 900), size: { width: 275, height: 118 } }));
    this.supply.attr({ name: { text: P ? 'WATER ABOVE THE CORE' : 'WATER OUTSIDE, BELOW' } });

    this.power = this.add(new S.Tank({ position: this.at(500, 900), size: { width: 152, height: 78 } }));
    this.power.attr({ name: { text: 'POWER' } });

    // the loop
    this.hot = pipe(this.core, this.sg, A('bottom'), A('top'), C.hot);
    this.tagPipe(this.hot, 'hot water out', C.hot, 0.5, 82);
    this.cold1 = pipe(this.sg, this.pump, A('right', 0, -64), PA('left'), C.cold);
    this.cold2 = pipe(this.pump, this.core, PA('top'), A('right', 0, 62), C.cold);
    this.tagPipe(this.cold2, 'cooled water in', C.cold, 0.5, 0, -22);
    this.out = pipe(this.sg, this.flag, A('right', 0, 40), A('left'), C.steam);

    if (P) {
      // nothing in the way, nothing to switch on
      this.inject = pipe(this.supply, this.core, A('bottom'), A('top'), C.water);
    } else {
      // a long way round, uphill, behind a pump
      this.eccs = this.add(new S.Pump({ position: this.at(30, 880), size: { width: 118, height: 176 } }));
      this.eccs.attr({ name: { text: 'BACKUP PUMP' } });
      this.inject = pipe(this.supply, this.eccs, A('left', 0, -20), PA('right'), C.water);
        this.inject2 = pipe(this.eccs, this.core, PA('top'), A('left', 0, 62), C.water);
    }

    this.wires = [this.add(new S.Wire({
      source: { id: this.power.id, anchor: A('right') },
      target: { id: this.pump.id, anchor: PA('right') } }))];
    if (!P) this.wires.push(this.add(new S.Wire({
      source: { id: this.power.id, anchor: A('bottom') },
      target: { id: this.eccs.id, anchor: PA('bottom') } })));
  }
}

Circuit.prototype.update = function (t) {
  const p = this.p, s = p.sys || {}, P = this.passive;
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  const setFlow = (link, on, rate) => {
    link.attr('flow/opacity', on ? 0.95 : 0);
    link.attr('bore/opacity', on ? 1 : 0.22);
    link.attr('casing/opacity', on ? 1 : 0.45);
    // a caption on a dead pipe should fade with it
    if (link.label(0)) link.prop('labels/0/attrs/labelText/opacity', on ? 1 : 0.3);
    if (on) link.attr('flow/strokeDashoffset', -(t * 26 * Math.min(1.5, rate || 1)) % 42);
  };
  const box = (el, h, y, fill, stroke, value, valueCol) => {
    el.attr({ liquid: { height: h, y, fill }, body: { stroke },
      value: { text: value, fill: valueCol || C.dim } });
  };

  // ---- the core: level, temperature, and whether the fuel is covered -------
  const size = this.core.size();
  const lvl = clamp(p.level, 0, 1);
  const top = 36, inner = size.height - top - 32;
  const tafY = top + inner * 0.42;                 // top of the fuel
  const h = inner * lvl;
  const uncovered = lvl < 0.58;
  const T = p.Tclad - 273;
  box(this.core, h, top + inner - h, tempColor(Math.min(p.Tclad, 3200)),
    uncovered ? C.bad : C.edge,
    `${Math.round(lvl * 100)}%   ·   ${T.toFixed(0)} °C`,
    T > 800 ? C.bad : T > 360 ? C.warn : C.dim);
  this.core.attr({ mark: { y1: tafY, y2: tafY, stroke: uncovered ? C.bad : 'rgba(255,255,255,.5)' },
    markTx: { y: tafY - 6, fill: uncovered ? C.bad : 'rgba(255,255,255,.7)' } });

  // ---- the steam generator ------------------------------------------------
  const fed = !!(s.feed || s.aux || s.rcic || s.prhr);
  const ss = this.sg.size(), si = ss.height - 68;
  const sh = fed ? si * 0.7 : si * 0.16;
  box(this.sg, sh, 36 + si - sh, C.water, C.edge,
    fed ? 'taking heat out' : 'not taking heat', fed ? C.dim : C.bad);

  // ---- pumps and power ----------------------------------------------------
  const live = !!(s.grid || s.diesel);
  this.pump.attr({ tri: { fill: s.rcp ? '#7fc6f0' : '#49535d' },
    body: { stroke: s.rcp ? C.edge : '#39424c' },
    value: { text: s.rcp ? 'running' : (P ? 'not needed' : 'STOPPED'),
      fill: s.rcp ? C.dim : (P ? C.ok : C.bad) } });
  const src = s.grid ? 'grid' : s.diesel ? 'diesels'
    : s.battery > 0 ? `batteries ${(s.battery * p.batteryHours).toFixed(0)} h` : 'NONE';
  box(this.power, 0, 4, C.power, live ? C.power : (s.battery > 0 ? C.warn : C.bad),
    src, live ? C.power : (s.battery > 0 ? C.warn : C.bad));
  for (const w of this.wires) {
    w.attr('bore/stroke', live ? C.power : '#39424c');
    w.attr('bore/strokeDashoffset', live ? -(t * 22) % 19 : 0);
    w.attr('bore/opacity', live ? 1 : 0.5);
  }

  // ---- the loop -----------------------------------------------------------
  const hotC = tempColor(Math.min(3200, p.Tcore + 40));
  this.hot.attr('bore/stroke', flow > 0 ? hotC : '#39424c');
  setFlow(this.hot, flow > 0, flow);
  setFlow(this.cold1, flow > 0, flow);
  setFlow(this.cold2, flow > 0, flow);
  setFlow(this.out, fed, 1);
  this.flag.attr({ body: { stroke: fed ? C.edge : '#39424c', opacity: fed ? 1 : 0.55 },
    name: { fill: fed ? C.ink : '#5d6975' } });

  // ---- the spare water ----------------------------------------------------
  const store = P ? clamp(Math.max(p.cmtLevel, p.irwst / 2.1e6), 0, 1) : 1;
  const us = this.supply.size(), ui = us.height - 68, uh = ui * store;
  const injecting = P ? !!(s.cmt || s.gravity || s.accum) : !!s.aux;
  const reachable = P || (live && p.pumpsOk);
  box(this.supply, uh, 36 + ui - uh, C.water,
    reachable ? C.edge : C.bad,
    P ? (injecting ? 'falling into the core' : 'ready — no pump needed')
      : (injecting ? 'being pumped in' : (live ? 'idle' : 'CANNOT REACH THE CORE')),
    P ? C.ok : (live ? C.dim : C.bad));
  setFlow(this.inject, injecting, 1);
  if (this.inject2) setFlow(this.inject2, injecting, 1);
  if (this.eccs) this.eccs.attr({ tri: { fill: injecting ? '#7fc6f0' : '#49535d' },
    body: { stroke: injecting ? C.edge : '#39424c' },
    value: { text: injecting ? 'injecting' : (live ? 'idle' : 'NO POWER'),
      fill: injecting ? C.dim : (live ? C.dim : C.bad) } });

  this.headline = p.vesselBreach || /DESTROYED/.test(p.state) ? 'MELTDOWN'
    : uncovered ? 'FUEL UNCOVERED'
      : p.coreDamage > 0.01 ? 'FUEL DAMAGED'
        : !fed ? 'HEAT IS NOT GETTING OUT'
          : (flow > 0 && !s.rcp) ? 'COOLING ITSELF'
            : lvl < 0.995 ? 'LOSING WATER'
              : P ? 'SAFE' : 'NORMAL';
  this.good = !(p.vesselBreach || uncovered || p.coreDamage > 0.01 || !fed || lvl < 0.995);
};

// ===========================================================================
// The stage: two circuits in one paper, fitted by transformToFitContent.
// ===========================================================================
export class CutStage {
  constructor(host) { this.host = host; this.built = false; this.focus = 'both'; }

  build(plants) {
    if (!window.joint) { this.failed = true; return; }
    const j = J();
    this.host.innerHTML = '';
    this.graph = new j.dia.Graph({}, { cellNamespace: j.shapes });
    this.paper = new j.dia.Paper({
      el: this.host, model: this.graph, width: 800, height: 600,
      gridSize: 1, interactive: false, cellViewNamespace: j.shapes,
      background: { color: 'transparent' }, sorting: j.dia.Paper.sorting.APPROX
    });
    this.circuits = plants.map((p, i) => new Circuit(p, this.graph, i * (W + 90)));
    this.head = plants.map((p, i) => {
      const el = document.createElement('div');
      el.className = 'cutHead' + (i ? ' pas' : ' act');
      el.innerHTML = '<b></b><i></i>';
      this.host.parentNode.appendChild(el);
      return el;
    });
    this.built = true;
  }

  setFocus(focus) {
    if (!this.built) return;
    this.focus = focus;
    const [a, p] = this.circuits;
    const show = (c, on) => c.cells.forEach(x => {
      const v = this.paper.findViewByModel(x); if (v) v.el.style.display = on ? '' : 'none';
    });
    show(a, focus !== 'passive');
    show(p, focus !== 'active');
    this.head[0].style.display = focus !== 'passive' ? '' : 'none';
    this.head[1].style.display = focus !== 'active' ? '' : 'none';
    this.fit();
  }

  fit() {
    if (!this.built) return;
    // The paper needs real pixel dimensions before it can work out a scale, and
    // it has none until the view is on screen. Measure the wrapper: JointJS
    // sizes the host element itself, so asking the host is asking our own
    // previous answer.
    const box = this.host.parentNode;
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return false;
    this.paper.setDimensions(w, h);
    this.fitW = w; this.fitH = h;
    const f = this.focus;
    const shown = this.circuits
      .filter(c => !(f === 'active' && c.passive) && !(f === 'passive' && !c.passive))
      .reduce((a, c) => a.concat(c.cells), []);
    const bb = this.graph.getCellsBBox(shown);
    if (!bb) return false;
    this.paper.transformToFitContent({
      padding: { top: (this._reserved = this.headH()), bottom: 14, left: 14, right: 14 },
      contentArea: bb, verticalAlign: 'middle', horizontalAlign: 'middle'
    });
    this.placeHeads();
    const need = this.headH();
    if (!this._refit && Math.abs(need - this._reserved) > 2) {
      this._refit = true; this._reserved = need; this.fit(); this._refit = false;
    }
    return true;
  }

  headH() {
    const h = this.head && this.head[0] ? this.head[0].offsetHeight : 0;
    return Math.max(52, h + 12);
  }

  // headings live in the DOM above each circuit, so they stay crisp and short
  placeHeads() {
    const sc = this.paper.scale().sx, tr = this.paper.translate();
    for (let i = 0; i < 2; i++) {
      const el = this.head[i];
      el.style.left = (tr.tx + (i * (W + 90) + 10) * sc) + 'px';
      el.style.top = Math.max(0, tr.ty - el.offsetHeight - 8) + 'px';
      el.style.width = ((W - 20) * sc) + 'px';
      el.style.fontSize = Math.max(12, Math.min(16, 15 * sc)) + 'px';
    }
  }

  update(t) {
    if (!this.built) return;
    let changed = false;
    // re-fit when the view first becomes visible, or the window changes shape
    const box = this.host.parentNode;
    if (box.clientWidth !== this.fitW || box.clientHeight !== this.fitH
      || !this.paper.scale().sx) this.fit();
    else if (Math.abs(this.headH() - this._reserved) > 2) this.fit();
    for (let i = 0; i < 2; i++) {
      const c = this.circuits[i];
      if (this.focus === 'active' && c.passive) continue;
      if (this.focus === 'passive' && !c.passive) continue;
      c.update(t);
      const el = this.head[i];
      const b = el.firstChild, sub = el.lastChild;
      const title = c.passive ? 'PASSIVE' : 'ACTIVE';
      if (b.textContent !== title) b.textContent = title;
      if (sub.textContent !== c.headline) sub.textContent = c.headline;
      el.dataset.tone = c.good ? 'ok' : 'bad';
      changed = true;
    }
    if (changed) this.placeHeads();
  }
}
