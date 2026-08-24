// ---------------------------------------------------------------------------
// cutaway.js - what actually happens in the circuit, as a schematic.
//
// Drawn with JointJS (vendor/joint.min.js, MPL-2.0): its graph, its shape
// definitions, its orthogonal router and rounded connector do the plumbing.
// Hand-routed pipes are where this view kept falling down; a library that does
// it properly is worth the 460 kB.
//
// Deliberately NOT to scale. The question this view answers is "where is the
// water going, and what stops it", so it holds a handful of boxes a side and
// as few words as will carry the point. Real dimensions live in the site view
// and in the fidelity ledger.
//
// Three things are drawn because they are the argument, not decoration:
//   - the route inside the reactor, so the water is seen going *through* the
//     fuel rather than up to the edge of a box;
//   - the boiler standing above the reactor, because that is what keeps the
//     loop turning when the pump stops;
//   - the containment line, because on the passive plant it is the outer wall
//     of the cooling loop and not just a radiological barrier.
//
// The whole comparison is one thing: when the pump stops, does anything still
// move, and is there water above the core to fall in.
// ---------------------------------------------------------------------------
import { MODE } from './plant.js';

const J = () => window.joint;

const C = {
  hot: '#e07a3c', hotHi: '#ff6a2a',
  cold: '#3fc0d8', water: '#2f8ed6', rcs: '#2b86cf',
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
// Sizes are fixed, because the insides of the two vessels are drawn as real
// paths (the water route through the fuel, the tubes in the boiler) and a path
// cannot be written in calc() the way a rectangle can.
const CORE_W = 300, CORE_H = 300, SG_W = 260, SG_H = 300;

let SHAPES = null;
function defineShapes() {
  if (SHAPES) return SHAPES;
  const j = J();

  // A vessel: steel wall, a cavity, water in the cavity, and the route the
  // water actually takes drawn *inside* it. Cold half and hot half are separate
  // paths so the colour changes exactly where the heat is picked up.
  const Vessel = j.dia.Element.define('n.Vessel', {
    size: { width: CORE_W, height: CORE_H },
    z: 6,
    attrs: {
      body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 14,
        fill: '#16222d', stroke: '#8497a6', strokeWidth: 3 },
      cav: { x: 8, y: 38, width: 'calc(w-16)', height: 'calc(h-70)', rx: 5,
        fill: '#0a121a' },
      liquid: { x: 8, y: 38, width: 'calc(w-16)', height: 0, fill: C.rcs, opacity: .8 },
      surf: { x1: 8, x2: 'calc(w-8)', y1: 0, y2: 0, stroke: 'rgba(220,240,255,.5)',
        strokeWidth: 2, opacity: 0 },
      fuel: { x: 0, y: 0, width: 0, height: 0, fill: '#8e9aa6', rx: 3, opacity: 0 },
      rods: { x: 0, y: 0, width: 0, height: 0, fill: 'url(#cutRods)', opacity: 0 },
      chanA: { d: 'M 0 0', stroke: C.cold, strokeWidth: 15, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'butt' },
      chanB: { d: 'M 0 0', stroke: C.hot, strokeWidth: 15, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'butt' },
      dashA: { d: 'M 0 0', stroke: 'rgba(255,255,255,.95)', strokeWidth: 5, fill: 'none',
        strokeDasharray: '9 30', strokeLinecap: 'butt', opacity: 0 },
      dashB: { d: 'M 0 0', stroke: 'rgba(255,255,255,.95)', strokeWidth: 5, fill: 'none',
        strokeDasharray: '9 30', strokeLinecap: 'butt', opacity: 0 },
      fuelTx: { x: 0, y: 0, textAnchor: 'middle', fill: '#0d151d',
        fontSize: 12, fontWeight: 800, fontFamily: 'ui-sans-serif,system-ui', opacity: 0 },
      head: { x: 2, y: 2, width: 'calc(w-4)', height: 32, rx: 11, fill: 'rgba(6,11,16,.96)' },
      name: { x: 'calc(w/2)', y: 24, textAnchor: 'middle', fill: C.ink,
        fontSize: 16, fontWeight: 800, fontFamily: 'ui-sans-serif,system-ui' },
      foot: { x: 2, y: 'calc(h-30)', width: 'calc(w-4)', height: 28, rx: 11,
        fill: 'rgba(6,11,16,.94)' },
      value: { x: 'calc(w/2)', y: 'calc(h-10)', textAnchor: 'middle', fill: C.dim,
        fontSize: 15, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [
    { tagName: 'rect', selector: 'body' }, { tagName: 'rect', selector: 'cav' },
    { tagName: 'rect', selector: 'liquid' }, { tagName: 'line', selector: 'surf' },
    { tagName: 'rect', selector: 'fuel' }, { tagName: 'rect', selector: 'rods' },
    { tagName: 'path', selector: 'chanA' }, { tagName: 'path', selector: 'chanB' },
    { tagName: 'path', selector: 'dashA' }, { tagName: 'path', selector: 'dashB' },
    { tagName: 'text', selector: 'fuelTx' },
    { tagName: 'rect', selector: 'head' }, { tagName: 'text', selector: 'name' },
    { tagName: 'rect', selector: 'foot' }, { tagName: 'text', selector: 'value' }] });

  // A plain store of water: no insides worth drawing, just how much is left.
  const Tank = j.dia.Element.define('n.Tank', {
    size: { width: 300, height: 120 },
    z: 6,
    attrs: {
      body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 14,
        fill: '#16222d', stroke: '#8497a6', strokeWidth: 3 },
      cav: { x: 8, y: 36, width: 'calc(w-16)', height: 'calc(h-68)', rx: 5, fill: '#0a121a' },
      liquid: { x: 8, y: 36, width: 'calc(w-16)', height: 0, fill: C.water },
      surf: { x1: 8, x2: 'calc(w-8)', y1: 0, y2: 0, stroke: 'rgba(220,240,255,.5)',
        strokeWidth: 2, opacity: 0 },
      head: { x: 2, y: 2, width: 'calc(w-4)', height: 32, rx: 11, fill: 'rgba(6,11,16,.96)' },
      name: { x: 'calc(w/2)', y: 24, textAnchor: 'middle', fill: C.ink,
        fontSize: 16, fontWeight: 800, fontFamily: 'ui-sans-serif,system-ui' },
      foot: { x: 2, y: 'calc(h-30)', width: 'calc(w-4)', height: 28, rx: 11,
        fill: 'rgba(6,11,16,.94)' },
      value: { x: 'calc(w/2)', y: 'calc(h-10)', textAnchor: 'middle', fill: C.dim,
        fontSize: 15, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [
    { tagName: 'rect', selector: 'body' }, { tagName: 'rect', selector: 'cav' },
    { tagName: 'rect', selector: 'liquid' }, { tagName: 'line', selector: 'surf' },
    { tagName: 'rect', selector: 'head' }, { tagName: 'text', selector: 'name' },
    { tagName: 'rect', selector: 'foot' }, { tagName: 'text', selector: 'value' }] });

  // A pump, drawn the way a process drawing draws one.
  const Pump = j.dia.Element.define('n.Pump', {
    size: { width: 190, height: 190 },
    z: 6,
    attrs: {
      body: { cx: 95, cy: 68, r: 60, fill: '#16222d', stroke: '#8497a6', strokeWidth: 3 },
      tri: { d: 'M 78 40 L 132 68 L 78 96 Z', fill: '#7fc6f0' },
      name: { x: 95, y: 160, textAnchor: 'middle', fill: C.ink,
        fontSize: 15, fontWeight: 800, fontFamily: 'ui-sans-serif,system-ui' },
      value: { x: 95, y: 181, textAnchor: 'middle', fill: C.dim,
        fontSize: 13.5, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [{ tagName: 'circle', selector: 'body' }, { tagName: 'path', selector: 'tri' },
    { tagName: 'text', selector: 'name' }, { tagName: 'text', selector: 'value' }] });

  // Where a line leaves the picture.
  const Flag = j.dia.Element.define('n.Flag', {
    size: { width: 180, height: 54 },
    z: 6,
    attrs: {
      body: { refD: 'M 0 0 L 0.86 0 L 1 0.5 L 0.86 1 L 0 1 Z', fill: 'rgba(14,22,30,.96)',
        stroke: C.edge, strokeWidth: 2.5 },
      name: { x: 'calc(w/2-10)', y: 'calc(h/2+6)', textAnchor: 'middle', fill: C.ink,
        fontSize: 15, fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [{ tagName: 'path', selector: 'body' }, { tagName: 'text', selector: 'name' }] });

  // The containment: the wall everything above sits inside. It is drawn because
  // it is the answer to "when is passive cooling not enough" - the water the
  // passive plant recirculates never leaves this line, so losing the line is
  // the failure that matters.
  const Zone = j.dia.Element.define('n.Zone', {
    size: { width: 740, height: 860 },
    z: 0,
    attrs: {
      body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 26,
        fill: 'rgba(28,46,62,.22)', stroke: '#4d6376', strokeWidth: 2.5,
        strokeDasharray: '11 9' },
      name: { x: 20, y: 'calc(h-16)', textAnchor: 'start', fill: C.dim, fontSize: 13.5,
        fontWeight: 700, fontFamily: 'ui-sans-serif,system-ui' }
    }
  }, { markup: [{ tagName: 'rect', selector: 'body' }, { tagName: 'text', selector: 'name' }] });

  // A pipe. One stroke, no casing: a dark outline around every pipe reads as a
  // wall across the flow at every nozzle, which is the opposite of the point.
  // Pipes sit below the vessels (z), so they run under the steel and come out
  // inside, where the internal route picks them up.
  const Pipe = j.dia.Link.define('n.Pipe', {
    attrs: {
      bore: { connection: true, stroke: C.water, strokeWidth: 15, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'butt' },
      flow: { connection: true, stroke: 'rgba(255,255,255,.95)', strokeWidth: 5, fill: 'none',
        strokeDasharray: '9 30', strokeDashoffset: 0, strokeLinecap: 'butt', opacity: 0 }
    },
    router: { name: 'orthogonal', args: { padding: 20 } },
    connector: { name: 'rounded', args: { radius: 20 } },
    connectionPoint: { name: 'anchor' },
    z: 2
  }, { markup: [{ tagName: 'path', selector: 'bore' },
    { tagName: 'path', selector: 'flow' }] });

  // The electrical feed. Thin, dashed, and it goes out.
  const Wire = j.dia.Link.define('n.Wire', {
    attrs: {
      bore: { connection: true, stroke: C.power, strokeWidth: 4, fill: 'none',
        strokeDasharray: '10 9', strokeDashoffset: 0, strokeLinejoin: 'round' }
    },
    router: { name: 'orthogonal', args: { padding: 16 } },
    connector: { name: 'rounded', args: { radius: 12 } },
    connectionPoint: { name: 'anchor' },
    z: 1
  }, { markup: [{ tagName: 'path', selector: 'bore' }] });

  SHAPES = { Vessel, Tank, Pump, Flag, Zone, Pipe, Wire };
  return SHAPES;
}

// ===========================================================================
// One circuit. The page is a section through the plant, so up on the screen is
// up in the building: the boiler stands above the core, which is why the water
// keeps circling with the pump off, and the spare water is above the core on
// one design and in the basement on the other.
// ===========================================================================
const W = 770, H = 1110;

// Where the water goes inside the reactor vessel, in the vessel's own
// coordinates: in at the top right, down the gap between the core and the wall,
// across the bottom, then up through the middle of the fuel and out.
const CORE_IN = 118, CORE_OUT = 70;
const CORE_COLD = `M ${CORE_W} ${CORE_IN} H 250 V 240 H 150`;
const CORE_HOT = `M 150 240 V ${CORE_OUT} H ${CORE_W}`;
const FUEL = { x: 95, y: 112, w: 110, h: 116 };
// And inside the boiler: up one leg of a tube, over, down the other, giving the
// heat to the water outside the tubes on the way.
const SG_IN = 232, SG_OUT_X = 175;
const SG_HOT = `M 0 ${SG_IN} H 70 V 78 H 122`;
const SG_COLD = `M 122 78 H ${SG_OUT_X} V ${SG_H}`;

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

  build() {
    const S = defineShapes(), P = this.passive;
    const pipe = (a, b, sa, ta, col, verts) => {
      const l = this.add(new S.Pipe({ source: { id: a.id, anchor: sa },
        target: { id: b.id, anchor: ta }, vertices: verts || [] }));
      if (col) l.attr('bore/stroke', col);
      return l;
    };
    const A = (name, dx, dy) => ({ name, args: { dx: dx || 0, dy: dy || 0 } });
    // the pump's box is taller than its circle so the caption fits inside it;
    // pipes have to land on the circle, not on the empty box corner
    const PA = (n) => n === 'left' ? A('left', 35, -27) : n === 'right' ? A('right', -35, -27)
      : n === 'top' ? A('top', 0, 8) : A('bottom', 0, -62);

    this.zone = this.add(new S.Zone({ position: P ? this.at(18, 20) : this.at(18, 170),
      size: { width: 740, height: P ? 840 : 690 } }));

    this.core = this.add(new S.Vessel({ position: this.at(60, 330),
      size: { width: CORE_W, height: CORE_H } }));
    this.core.attr({ name: { text: 'REACTOR' },
      chanA: { d: CORE_COLD }, chanB: { d: CORE_HOT },
      dashA: { d: CORE_COLD }, dashB: { d: CORE_HOT },
      fuel: { x: FUEL.x, y: FUEL.y, width: FUEL.w, height: FUEL.h, opacity: 1 },
      rods: { x: FUEL.x, y: FUEL.y, width: FUEL.w, height: FUEL.h, opacity: 1 },
      fuelTx: { x: FUEL.x + 26, y: FUEL.y + FUEL.h / 2 + 4, text: 'FUEL', opacity: 1 } });

    this.sg = this.add(new S.Vessel({ position: this.at(470, 200),
      size: { width: SG_W, height: SG_H } }));
    this.sg.attr({ name: { text: 'BOILER' },
      chanA: { d: SG_COLD }, chanB: { d: SG_HOT },
      dashA: { d: SG_COLD }, dashB: { d: SG_HOT } });

    this.pump = this.add(new S.Pump({ position: this.at(550, 640) }));
    this.pump.attr({ name: { text: 'PUMP' } });

    this.flag = this.add(new S.Flag({ position: this.at(520, -50) }));
    this.flag.attr({ name: { text: 'heat out' } });

    this.supply = this.add(new S.Tank({ position: P ? this.at(60, 40) : this.at(60, 900) }));
    this.supply.attr({ name: { text: P ? 'POOL ABOVE THE REACTOR' : 'WATER IN THE BASEMENT' } });

    this.power = this.add(new S.Tank({ position: this.at(560, 880), size: { width: 180, height: 80 } }));
    this.power.attr({ name: { text: 'POWER' } });

    // the loop: reactor -> boiler -> pump -> reactor
    this.hot = pipe(this.core, this.sg, A('right', 0, CORE_OUT - CORE_H / 2),
      A('left', 0, SG_IN - SG_H / 2), C.hot);
    this.cold1 = pipe(this.sg, this.pump, A('bottom', SG_OUT_X - SG_W / 2), PA('top'), C.cold);
    this.cold2 = pipe(this.pump, this.core, PA('left'), A('right', 0, CORE_IN - CORE_H / 2),
      C.cold, [this.at(420, 702)]);
    this.out = pipe(this.sg, this.flag, A('top', -70), A('bottom', -80), C.steam);

    if (P) {
      // The pool does two jobs, both real: it holds the water that falls in,
      // and the heat exchanger standing in it is where the heat goes once the
      // boiler route is gone. Drawing only the first made it look ornamental.
      this.inject = pipe(this.supply, this.core, A('bottom', -100), A('top', -100), C.water);
      this.tagPipe(this.inject, 'falls in', C.water, 0.5, -46);
      this.prhrLink = pipe(this.core, this.supply, A('top', 100), A('bottom', 100), C.hot);
      this.tagPipe(this.prhrLink, 'heat rises', C.hot, 0.5, 44);
    } else {
      // the same inlet, reached the long way: up out of the basement, past the
      // whole height of the reactor, behind a pump that needs electricity
      this.eccs = this.add(new S.Pump({ position: this.at(360, 880) }));
      this.eccs.attr({ name: { text: 'BACKUP PUMP' } });
      this.inject = pipe(this.supply, this.eccs, A('right', 0, 8), PA('left'), C.water);
      this.inject2 = pipe(this.eccs, this.core, PA('top'), A('top', -100), C.water,
        [this.at(455, 806), this.at(30, 806), this.at(30, 268), this.at(110, 268)]);
      this.tagPipe(this.inject2, 'pumped all the way up', C.water, 0.513, 100, 0);
    }

    this.wires = [this.add(new S.Wire({
      source: { id: this.power.id, anchor: A('right') },
      target: { id: this.pump.id, anchor: PA('right') } }))];
    if (!P) this.wires.push(this.add(new S.Wire({
      source: { id: this.power.id, anchor: A('left', 0, 8) },
      target: { id: this.eccs.id, anchor: PA('right') } })));
  }
}

Circuit.prototype.update = function (t) {
  const p = this.p, s = p.sys || {}, P = this.passive;
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  const setFlow = (link, on, rate) => {
    link.attr('flow/opacity', on ? 0.95 : 0);
    link.attr('bore/opacity', on ? 1 : 0.24);
    // a caption on a dead pipe should fade with it
    if (link.label(0)) link.prop('labels/0/attrs/labelText/opacity', on ? 1 : 0.3);
    if (on) link.attr('flow/strokeDashoffset', -(t * 26 * Math.min(1.5, rate || 1)) % 39);
  };
  const level = (el, frac, top, span, fill) => {
    const h = span * clamp(frac, 0, 1);
    el.attr({ liquid: { height: h, y: top + span - h, fill },
      surf: { y1: top + span - h, y2: top + span - h, opacity: h > 2 ? 1 : 0 } });
  };

  // ---- the reactor: level, temperature, and whether the fuel is covered ----
  const lvl = clamp(p.level, 0, 1);
  const top = 38, span = CORE_H - 70;
  const covered = top + span - span * lvl <= FUEL.y;   // surface above the bundle
  const T = p.Tclad - 273;
  level(this.core, lvl, top, span, C.rcs);
  const glow = T > 400 ? tempColor(Math.min(p.Tclad, 3200)) : '#8e9aa6';
  this.core.attr({
    body: { stroke: covered ? '#8497a6' : C.bad },
    fuel: { fill: glow, stroke: covered ? '#c8d3dc' : '#ffd9c6' },
    fuelTx: { fill: T > 700 ? '#2a0d05' : '#0d151d' },
    value: { text: `${Math.round(lvl * 100)}% full  ·  ${T.toFixed(0)} °C`,
      fill: T > 800 ? C.bad : T > 360 ? C.warn : C.dim } });
  const uncovered = !covered;

  // the route through the fuel: it only moves while something is driving it
  const hotC = tempColor(Math.min(3200, p.Tcore + 40));
  const moving = flow > 0 && !uncovered;
  const off = -(t * 26 * Math.min(1.5, flow || 1)) % 39;
  this.core.attr({
    chanA: { stroke: moving ? C.cold : '#3a4650' },
    chanB: { stroke: moving ? hotC : '#4a3b34' },
    dashA: { opacity: moving ? 0.95 : 0, strokeDashoffset: off },
    dashB: { opacity: moving ? 0.95 : 0, strokeDashoffset: off } });

  // ---- the boiler ---------------------------------------------------------
  const sink = s.sink || 'none';
  const viaSG = sink === 'turbine';
  level(this.sg, viaSG ? 0.86 : 0.2, 38, SG_H - 70, C.water);
  this.sg.attr({
    body: { stroke: viaSG || sink !== 'none' ? '#8497a6' : C.bad },
    chanA: { stroke: moving ? C.cold : '#3a4650' },
    chanB: { stroke: moving ? hotC : '#4a3b34' },
    dashA: { opacity: moving ? 0.95 : 0, strokeDashoffset: off },
    dashB: { opacity: moving ? 0.95 : 0, strokeDashoffset: off },
    value: { text: viaSG ? 'boiling off the heat'
      : sink === 'pool' ? 'not needed — the pool has it'
        : sink === 'shell' ? 'not needed — the shell has it' : 'not taking heat',
      fill: viaSG ? C.dim : sink !== 'none' ? C.ok : C.bad } });

  // ---- pumps and power ----------------------------------------------------
  const live = !!(s.grid || s.diesel);
  this.pump.attr({ tri: { fill: s.rcp ? '#7fc6f0' : '#49535d' },
    body: { stroke: s.rcp ? '#8497a6' : '#39424c' },
    value: { text: s.rcp ? (P ? 'needed only for power' : 'must keep running')
      : (P ? 'off — cooling carries on' : 'STOPPED — no cooling'),
      fill: s.rcp ? C.dim : (P ? C.ok : C.bad) } });
  const src = s.grid ? 'grid' : s.diesel ? 'diesels'
    : s.battery > 0 ? `batteries ${(s.battery * p.batteryHours).toFixed(0)} h` : 'NONE';
  this.power.attr({ body: { stroke: live ? C.power : (s.battery > 0 ? C.warn : C.bad) },
    value: { text: src, fill: live ? C.power : (s.battery > 0 ? C.warn : C.bad) } });
  for (const w of this.wires) {
    w.attr('bore/stroke', live ? C.power : '#39424c');
    w.attr('bore/strokeDashoffset', live ? -(t * 22) % 19 : 0);
    w.attr('bore/opacity', live ? 1 : 0.5);
  }

  // ---- the loop -----------------------------------------------------------
  this.hot.attr('bore/stroke', flow > 0 ? hotC : '#39424c');
  setFlow(this.hot, flow > 0, flow);
  setFlow(this.cold1, flow > 0, flow);
  setFlow(this.cold2, flow > 0, flow);
  setFlow(this.out, viaSG, 1);
  if (this.prhrLink) setFlow(this.prhrLink, sink === 'pool', s.prhr || 1);
  this.flag.attr({ body: { stroke: viaSG ? C.edge : '#39424c', opacity: viaSG ? 1 : 0.55 },
    name: { fill: viaSG ? C.ink : '#5d6975' } });

  // ---- the spare water ----------------------------------------------------
  // Weighted by what these actually hold: two 70 t makeup tanks against a
  // 2,000 t pool. Showing the larger of the two hid a pool that was draining.
  const poolFrac = p.irwst / 2.1e6;
  const floorFrac = (p.ctmtSump || 0) / 2.1e6;
  const store = P
    ? clamp(0.07 * p.cmtLevel + 0.93 * Math.max(poolFrac, floorFrac * 0.85), 0, 1)
    : 1;
  // The model keeps a 100 t floor in the pool figure, so "empty" is not zero.
  // Reading it as still full made the box claim the pool was pouring in hours
  // after it had drained onto the containment floor.
  const onFloor = P && p.irwst < 1.6e5 && floorFrac > 0.05;
  const injecting = P ? !!(s.cmt || s.gravity || s.accum) : !!s.aux;
  const cracked = P && p.irwstCracked;
  const lost = P && onFloor && !p.ctmtIntact;
  level(this.supply, store, 36, 120 - 68,
    lost ? '#5c4436' : onFloor ? '#3f7fa8' : cracked ? '#7d5a3a' : C.water);
  this.supply.attr({
    body: { stroke: lost ? C.bad : cracked && !onFloor ? C.warn : '#8497a6' },
    value: { text: P ? (lost ? 'ESCAPING as steam'
      : onFloor ? 'still gets back in'
        : cracked ? 'CRACKED — draining'
          : injecting ? 'falling into the reactor' : 'ready — no pump needed')
      : (injecting ? 'being pumped up'
        : !live ? 'NO POWER — CANNOT REACH THE REACTOR'
          : !p.pumpsOk ? 'THE PUMPS HAVE FAILED' : 'idle'),
      fill: lost ? C.bad : onFloor ? C.ok : cracked ? C.warn : P ? C.ok
        : (live && p.pumpsOk ? C.dim : C.bad) } });
  if (P) this.supply.attr('name/text',
    onFloor ? 'WATER ON THE FLOOR' : 'POOL ABOVE THE REACTOR');
  setFlow(this.inject, injecting, 1);
  if (this.inject2) setFlow(this.inject2, injecting, 1);
  if (this.eccs) this.eccs.attr({ tri: { fill: injecting ? '#7fc6f0' : '#49535d' },
    body: { stroke: injecting ? '#8497a6' : '#39424c' },
    value: { text: injecting ? 'injecting'
      : !live ? 'NO POWER' : !p.pumpsOk ? 'FAILED' : 'idle',
      fill: injecting || (live && p.pumpsOk) ? C.dim : C.bad } });

  // ---- the wall ------------------------------------------------------------
  const shell = sink === 'shell';
  this.zone.attr({
    body: { stroke: p.ctmtIntact ? (shell ? C.ok : '#4d6376') : C.bad,
      fill: p.ctmtIntact ? 'rgba(28,46,62,.22)' : 'rgba(74,32,26,.26)' },
    name: { fill: p.ctmtIntact ? (shell ? C.ok : C.dim) : C.bad,
      text: !p.ctmtIntact ? 'CONTAINMENT BREACHED — everything inside can get out'
        : shell ? 'CONTAINMENT — the steel is carrying the heat to the outside air'
          : 'CONTAINMENT — nothing inside this line gets out' } });

  // The steps, worst first, so the headline always names the furthest thing
  // that has happened rather than the first one that matched.
  // For the passive plant the containment is the outer wall of its cooling
  // loop, not just a radiological barrier: lose it and the water it keeps
  // recycling leaves as steam. That is the one failure it cannot ride out.
  const lostWater = P && !p.ctmtIntact;
  this.headline =
    p.vesselBreach || /DESTROYED/.test(p.state) ? 'MELTDOWN'
      : uncovered ? 'FUEL IS UNCOVERED'
        : p.coreDamage > 0.01 ? 'FUEL IS DAMAGED'
          : lvl < 0.97 ? 'LOSING WATER'
            : (P && lostWater) ? 'THE WATER IS ESCAPING'
              : (P && !p.prhrOk && sink === 'none') ? 'PASSIVE HEAT PATH BROKEN'
              : sink === 'none' ? 'HEAT IS NOT GETTING OUT'
                : s.rcic ? 'ON THE LAST-RESORT PUMP'
                  : sink === 'pool' ? 'THE POOL IS TAKING THE HEAT'
                    : sink === 'shell' ? 'THE SHELL IS TAKING THE HEAT'
                    : (flow > 0 && !s.rcp) ? 'COOLING ITSELF, NO PUMP'
                      : !s.grid && !s.diesel ? 'RUNNING ON BATTERIES'
                        : P ? 'SAFE' : 'NORMAL';
  this.good = !(p.vesselBreach || uncovered || p.coreDamage > 0.01
    || sink === 'none' || lvl < 0.97 || lostWater);
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
    // fuel-rod hatching, so the bundle reads as a bundle
    const defs = this.paper.svg.querySelector('defs') || this.paper.svg.insertBefore(
      document.createElementNS('http://www.w3.org/2000/svg', 'defs'), this.paper.svg.firstChild);
    defs.insertAdjacentHTML('beforeend',
      '<pattern id="cutRods" width="14" height="8" patternUnits="userSpaceOnUse">' +
      '<rect x="4.5" y="0" width="5" height="8" fill="rgba(16,26,36,.62)"/></pattern>');
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
    this.topY = bb.y;          // the drawing starts above y=0: the steam line leaves the top
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
      el.style.top = Math.max(0, tr.ty + (this.topY || 0) * sc - el.offsetHeight - 10) + 'px';
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
