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
import { MODE, FUEL_TOP } from './plant.js';

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

// ---- geometry -------------------------------------------------------------
// Every vessel is drawn as a real silhouette rather than a rectangle, so the
// sizes are fixed and the insides are written as paths in the vessel's own
// coordinates. A schematic still has to look like the machine it stands for.
const RPV_W = 300, RPV_H = 430;
const SG_W = 260, SG_H = 430;
const PUMP_W = 230, PUMP_H = 240;
const TANK_W = 300, TANK_H = 160;

// The reactor pressure vessel: a tall capsule with a domed head and bottom.
const RPV_SHELL = 'M 46 108 Q 46 34 150 34 Q 254 34 254 108 L 254 292 '
  + 'Q 254 366 150 366 Q 46 366 46 292 Z';
const RPV_CAV = 'M 58 112 Q 58 46 150 46 Q 242 46 242 112 L 242 288 '
  + 'Q 242 354 150 354 Q 58 354 58 288 Z';
const CAV_TOP = 46, CAV_BOT = 354, CAV_SPAN = CAV_BOT - CAV_TOP;
const RPV_IN = 118, RPV_OUT = 88;          // cold and hot nozzle heights
const CH1 = 122, CH2 = 172, CH_BOT = 320, ANN = 229;
// Cold water comes in at the nozzle, drops down the gap between the core and
// the wall, crosses the bottom and rises between the fuel rods: the real route.
const RPV_COLD = `M 254 ${RPV_IN} H ${ANN} V ${CH_BOT} H ${CH1}`;
const RPV_HOT = `M ${CH1} ${CH_BOT} V ${RPV_OUT} H 254 M ${CH2} ${CH_BOT} V ${RPV_OUT - 6}`;
const RODS = [[80, 34], [130, 34], [180, 34]];   // x, width - three rod stacks

// The steam generator: channel head, conical transition, upper drum, domed top.
const SG_SHELL = 'M 28 350 Q 28 366 46 366 L 214 366 Q 232 366 232 350 L 232 200 '
  + 'L 182 150 L 182 78 Q 182 34 130 34 Q 78 34 78 78 L 78 150 L 28 200 Z';
const SG_CAV = 'M 40 346 Q 40 354 48 354 L 212 354 Q 220 354 220 346 L 220 205 '
  + 'L 170 155 L 170 78 Q 170 46 130 46 Q 90 46 90 78 L 90 155 L 40 205 Z';
const SG_TOP = 46, SG_BOT = 354, SG_SPAN = SG_BOT - SG_TOP;
const SG_IN = 330, SG_OUT_X = 160;
const SG_HOT = `M 28 ${SG_IN} H 76 V 190 H 118`;
const SG_COLD = `M 118 190 H ${SG_OUT_X} V 366`;

// ---- shapes ---------------------------------------------------------------
let SHAPES = null;
function defineShapes() {
  if (SHAPES) return SHAPES;
  const j = J();
  const F = 'ui-sans-serif,system-ui,sans-serif';

  // A vessel: steel shell, dark cavity, water with a lit surface, the fuel, and
  // the route the water takes through it. The cavity is a clip path, so the
  // water can be a plain rectangle and still take the shape of the vessel.
  const Vessel = j.dia.Element.define('n.Vessel', {
    size: { width: RPV_W, height: RPV_H },
    z: 6,
    attrs: {
      shadow: { d: RPV_SHELL, fill: 'rgba(0,0,0,.45)', transform: 'translate(0,9)',
        filter: 'url(#cBlur)' },
      skirt: { d: 'M 104 320 L 92 388 L 208 388 L 196 320 Z', fill: '#38454f',
        stroke: '#22303c', strokeWidth: 2 },
      skirtHi: { d: 'M 104 320 L 92 388', fill: 'none', stroke: 'rgba(255,255,255,.16)',
        strokeWidth: 2.5 },
      shell: { d: RPV_SHELL, fill: 'url(#cSteel)', stroke: '#22303c', strokeWidth: 2 },
      shellHi: { d: RPV_SHELL, fill: 'none', stroke: 'rgba(255,255,255,.30)',
        strokeWidth: 2, transform: 'translate(0,2)' },
      cav: { d: RPV_CAV, fill: 'url(#cCav)' },
      liquid: { x: 0, y: 0, width: RPV_W, height: 0, fill: 'url(#cWater)', clipPath: '' },
      surf: { x: 0, y: 0, width: RPV_W, height: 4, fill: 'rgba(190,232,255,.85)',
        opacity: 0, clipPath: '' },
      glow: { x: 0, y: 0, width: 0, height: 0, rx: 7, fill: '#ff5a1e',
        filter: 'url(#cHot)', opacity: 0 },
      fuel1: { x: 0, y: 0, width: 0, height: 0, rx: 5, fill: 'url(#cClad)',
        stroke: '#1b2833', strokeWidth: 1.5, opacity: 0 },
      rod1: { x: 0, y: 0, width: 0, height: 0, rx: 5, fill: 'url(#cRods)', opacity: 0 },
      fuel2: { x: 0, y: 0, width: 0, height: 0, rx: 5, fill: 'url(#cClad)',
        stroke: '#1b2833', strokeWidth: 1.5, opacity: 0 },
      rod2: { x: 0, y: 0, width: 0, height: 0, rx: 5, fill: 'url(#cRods)', opacity: 0 },
      fuel3: { x: 0, y: 0, width: 0, height: 0, rx: 5, fill: 'url(#cClad)',
        stroke: '#1b2833', strokeWidth: 1.5, opacity: 0 },
      rod3: { x: 0, y: 0, width: 0, height: 0, rx: 5, fill: 'url(#cRods)', opacity: 0 },
      // the two halves of the route, each drawn as a tube
      rimA: { d: 'M 0 0', stroke: '#0b1219', strokeWidth: 16, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      rimB: { d: 'M 0 0', stroke: '#0b1219', strokeWidth: 16, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      chanA: { d: 'M 0 0', stroke: C.cold, strokeWidth: 11, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      chanB: { d: 'M 0 0', stroke: C.hot, strokeWidth: 11, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      glossA: { d: 'M 0 0', stroke: 'rgba(255,255,255,.28)', strokeWidth: 3.4, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      glossB: { d: 'M 0 0', stroke: 'rgba(255,255,255,.28)', strokeWidth: 3.4, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      dashA: { d: 'M 0 0', stroke: 'rgba(255,255,255,.95)', strokeWidth: 5, fill: 'none',
        strokeDasharray: '2.5 26', strokeLinecap: 'round', opacity: 0 },
      dashB: { d: 'M 0 0', stroke: 'rgba(255,255,255,.95)', strokeWidth: 5, fill: 'none',
        strokeDasharray: '2.5 26', strokeLinecap: 'round', opacity: 0 },
      nozA: { x: 274, y: RPV_IN - 11, width: 28, height: 22, rx: 4, fill: 'url(#cSteel)',
        stroke: '#22303c', strokeWidth: 1.5 },
      nozB: { x: 274, y: RPV_OUT - 11, width: 28, height: 22, rx: 4, fill: 'url(#cSteel)',
        stroke: '#22303c', strokeWidth: 1.5 },
      nozC: { x: 0, y: 0, width: 0, height: 0, opacity: 0 },
      bub: { d: 'M 0 0', fill: 'rgba(226,244,255,.55)', opacity: 0 },
      fuelTx: { x: 0, y: 0, textAnchor: 'middle', fill: '#9fb2c2', fontSize: 11.5,
        fontWeight: 800, fontFamily: F, letterSpacing: '.05em', opacity: 0 },
      name: { x: 'calc(w/2)', y: 22, textAnchor: 'middle', fill: C.ink, fontSize: 16,
        fontWeight: 800, fontFamily: F, letterSpacing: '.08em',
        stroke: 'rgba(6,12,18,.85)', strokeWidth: 5, paintOrder: 'stroke' },
      value: { x: 'calc(w/2)', y: 396, textAnchor: 'middle', fill: C.dim, fontSize: 15,
        fontWeight: 700, fontFamily: F, stroke: 'rgba(6,12,18,.8)', strokeWidth: 4,
        paintOrder: 'stroke' },
      value2: { x: 'calc(w/2)', y: 418, textAnchor: 'middle', fill: '#a2bacd', fontSize: 13,
        fontWeight: 700, fontFamily: F, stroke: 'rgba(6,12,18,.8)', strokeWidth: 4,
        paintOrder: 'stroke', opacity: 0 }
    }
  }, { markup: [
    { tagName: 'path', selector: 'shadow' },
    { tagName: 'path', selector: 'skirt' }, { tagName: 'path', selector: 'skirtHi' },
    { tagName: 'path', selector: 'shell' }, { tagName: 'path', selector: 'cav' },
    { tagName: 'rect', selector: 'liquid' }, { tagName: 'rect', selector: 'surf' },
    { tagName: 'rect', selector: 'glow' },
    { tagName: 'rect', selector: 'fuel1' }, { tagName: 'rect', selector: 'rod1' },
    { tagName: 'rect', selector: 'fuel2' }, { tagName: 'rect', selector: 'rod2' },
    { tagName: 'rect', selector: 'fuel3' }, { tagName: 'rect', selector: 'rod3' },
    { tagName: 'path', selector: 'bub' },
    { tagName: 'path', selector: 'rimA' }, { tagName: 'path', selector: 'rimB' },
    { tagName: 'path', selector: 'chanA' }, { tagName: 'path', selector: 'chanB' },
    { tagName: 'path', selector: 'glossA' }, { tagName: 'path', selector: 'glossB' },
    { tagName: 'path', selector: 'dashA' }, { tagName: 'path', selector: 'dashB' },
    { tagName: 'path', selector: 'shellHi' },
    { tagName: 'rect', selector: 'nozA' }, { tagName: 'rect', selector: 'nozB' },
    { tagName: 'rect', selector: 'nozC' },
    { tagName: 'text', selector: 'fuelTx' },
    { tagName: 'text', selector: 'name' },
    { tagName: 'text', selector: 'value' }, { tagName: 'text', selector: 'value2' }] });

  // An open basin of water, or a closed tank in the basement.
  const Tank = j.dia.Element.define('n.Tank', {
    size: { width: TANK_W, height: TANK_H },
    z: 6,
    attrs: {
      shadow: { x: 14, y: 44, width: TANK_W - 28, height: 94, rx: 10,
        fill: 'rgba(0,0,0,.45)', filter: 'url(#cBlur)' },
      shell: { d: `M 8 30 L 8 122 Q 8 134 20 134 L ${TANK_W - 20} 134 `
        + `Q ${TANK_W - 8} 134 ${TANK_W - 8} 122 L ${TANK_W - 8} 30`,
        fill: 'none', stroke: 'url(#cSteel)', strokeWidth: 13, strokeLinecap: 'round',
        strokeLinejoin: 'round' },
      cav: { x: 20, y: 42, width: TANK_W - 40, height: 82, rx: 4, fill: 'url(#cCav)' },
      liquid: { x: 20, y: 42, width: TANK_W - 40, height: 0, fill: 'url(#cWater)' },
      surf: { x: 20, y: 0, width: TANK_W - 40, height: 4, fill: 'rgba(190,232,255,.85)',
        opacity: 0 },
      shellHi: { d: `M 13 30 L 13 120 Q 13 128 22 128 L ${TANK_W - 22} 128`,
        fill: 'none', stroke: 'rgba(255,255,255,.24)', strokeWidth: 2,
        strokeLinecap: 'round' },
      name: { x: 'calc(w/2)', y: 22, textAnchor: 'middle', fill: C.ink, fontSize: 15,
        fontWeight: 800, fontFamily: F, letterSpacing: '.07em',
        stroke: 'rgba(6,12,18,.85)', strokeWidth: 5, paintOrder: 'stroke' },
      value: { x: 'calc(w/2)', y: 156, textAnchor: 'middle', fill: C.dim, fontSize: 14.5,
        fontWeight: 700, fontFamily: F, stroke: 'rgba(6,12,18,.8)', strokeWidth: 4,
        paintOrder: 'stroke' }
    }
  }, { markup: [
    { tagName: 'rect', selector: 'shadow' }, { tagName: 'path', selector: 'shell' },
    { tagName: 'rect', selector: 'cav' }, { tagName: 'rect', selector: 'liquid' },
    { tagName: 'rect', selector: 'surf' }, { tagName: 'path', selector: 'shellHi' },
    { tagName: 'text', selector: 'name' }, { tagName: 'text', selector: 'value' }] });

  // A centrifugal pump: volute casing, suction and discharge nozzles, and an
  // impeller that actually turns when the pump is running.
  const Pump = j.dia.Element.define('n.Pump', {
    size: { width: PUMP_W, height: PUMP_H },
    z: 6,
    attrs: {
      noz: { d: 'M 0 68 H 60 V 92 H 0 Z M 103 0 H 127 V 60 H 103 Z',
        fill: 'url(#cSteel)', stroke: '#22303c', strokeWidth: 1.5 },
      base: { d: 'M 84 118 L 74 152 L 156 152 L 146 118 Z', fill: '#38454f',
        stroke: '#22303c', strokeWidth: 2 },
      shadow: { cx: 115, cy: 89, r: 58, fill: 'rgba(0,0,0,.45)', filter: 'url(#cBlur)' },
      body: { cx: 115, cy: 80, r: 58, fill: 'url(#cVolute)', stroke: '#22303c',
        strokeWidth: 2 },
      ring: { cx: 115, cy: 80, r: 46, fill: '#0b141c', stroke: 'rgba(255,255,255,.10)',
        strokeWidth: 1.5 },
      imp: { d: 'M 115 44 A 36 36 0 0 1 141 57 L 122 74 A 12 12 0 0 0 115 68 Z',
        fill: '#5fb2e8', transform: 'rotate(0,115,80)' },
      imp2: { d: 'M 115 44 A 36 36 0 0 1 141 57 L 122 74 A 12 12 0 0 0 115 68 Z',
        fill: '#5fb2e8', transform: 'rotate(120,115,80)' },
      imp3: { d: 'M 115 44 A 36 36 0 0 1 141 57 L 122 74 A 12 12 0 0 0 115 68 Z',
        fill: '#5fb2e8', transform: 'rotate(240,115,80)' },
      hub: { cx: 115, cy: 80, r: 11, fill: '#8fa6b7', stroke: '#22303c', strokeWidth: 1.5 },
      gloss: { d: 'M 72 46 A 58 58 0 0 1 152 42', fill: 'none',
        stroke: 'rgba(255,255,255,.32)', strokeWidth: 3, strokeLinecap: 'round' },
      name: { x: 115, y: 176, textAnchor: 'middle', fill: C.ink, fontSize: 15,
        fontWeight: 800, fontFamily: F, letterSpacing: '.07em',
        stroke: 'rgba(6,12,18,.85)', strokeWidth: 5, paintOrder: 'stroke' },
      value: { x: 115, y: 197, textAnchor: 'middle', fill: C.dim, fontSize: 13.5,
        fontWeight: 700, fontFamily: F, stroke: 'rgba(6,12,18,.8)', strokeWidth: 4,
        paintOrder: 'stroke' },
      value2: { x: 115, y: 216, textAnchor: 'middle', fill: C.dim, fontSize: 12.5,
        fontWeight: 600, fontFamily: F, stroke: 'rgba(6,12,18,.8)', strokeWidth: 4,
        paintOrder: 'stroke' }
    }
  }, { markup: [
    { tagName: 'path', selector: 'noz' }, { tagName: 'path', selector: 'base' },
    { tagName: 'circle', selector: 'shadow' },
    { tagName: 'circle', selector: 'body' }, { tagName: 'circle', selector: 'ring' },
    { tagName: 'path', selector: 'imp' }, { tagName: 'path', selector: 'imp2' },
    { tagName: 'path', selector: 'imp3' }, { tagName: 'circle', selector: 'hub' },
    { tagName: 'path', selector: 'gloss' }, { tagName: 'text', selector: 'name' },
    { tagName: 'text', selector: 'value' }, { tagName: 'text', selector: 'value2' }] });

  // The electrical supply.
  const Panel = j.dia.Element.define('n.Panel', {
    size: { width: 180, height: 92 },
    z: 6,
    attrs: {
      shadow: { x: 4, y: 12, width: 172, height: 78, rx: 11, fill: 'rgba(0,0,0,.45)',
        filter: 'url(#cBlur)' },
      body: { x: 2, y: 2, width: 176, height: 82, rx: 11, fill: 'url(#cPanel)',
        stroke: '#22303c', strokeWidth: 2 },
      bolt: { d: 'M 26 22 L 40 22 L 33 38 L 44 38 L 24 62 L 30 44 L 20 44 Z',
        fill: C.power },
      name: { x: 108, y: 34, textAnchor: 'middle', fill: C.ink, fontSize: 14,
        fontWeight: 800, fontFamily: F, letterSpacing: '.06em' },
      value: { x: 108, y: 58, textAnchor: 'middle', fill: C.dim, fontSize: 14,
        fontWeight: 700, fontFamily: F }
    }
  }, { markup: [
    { tagName: 'rect', selector: 'shadow' }, { tagName: 'rect', selector: 'body' },
    { tagName: 'path', selector: 'bolt' }, { tagName: 'text', selector: 'name' },
    { tagName: 'text', selector: 'value' }] });

  // Where a line leaves the picture.
  const Flag = j.dia.Element.define('n.Flag', {
    size: { width: 215, height: 54 },
    z: 6,
    attrs: {
      body: { refD: 'M 0 0 L 0.86 0 L 1 0.5 L 0.86 1 L 0 1 Z', fill: 'url(#cPanel)',
        stroke: C.edge, strokeWidth: 2 },
      name: { x: 'calc(w/2-10)', y: 'calc(h/2+6)', textAnchor: 'middle', fill: C.ink,
        fontSize: 15, fontWeight: 700, fontFamily: F }
    }
  }, { markup: [{ tagName: 'path', selector: 'body' }, { tagName: 'text', selector: 'name' }] });

  // The containment: a cutaway of the building everything above stands in. It
  // is the answer to "when is passive cooling not enough" - the water the
  // passive plant recirculates never crosses this line.
  const Zone = j.dia.Element.define('n.Zone', {
    size: { width: 802, height: 990 },
    z: 0,
    attrs: {
      hull: { d: 'M 0 938 L 0 220 A 401 210 0 0 1 802 220 L 802 938 Z',
        fill: 'url(#cConc)', stroke: '#3d4e5f', strokeWidth: 2 },
      voidd: { d: 'M 20 938 L 20 224 A 381 196 0 0 1 782 224 L 782 938 Z',
        fill: 'rgba(10,18,26,.96)' },
      slab: { x: -12, y: 936, width: 826, height: 46, rx: 6, fill: 'url(#cConc)',
        stroke: '#3d4e5f', strokeWidth: 2 },
      hi: { d: 'M 10 700 L 10 220 A 391 203 0 0 1 200 44', fill: 'none',
        stroke: 'rgba(255,255,255,.14)', strokeWidth: 3, strokeLinecap: 'round' },
      name: { x: 24, y: 966, textAnchor: 'start', fill: C.dim, fontSize: 13.5,
        fontWeight: 700, fontFamily: F }
    }
  }, { markup: [
    { tagName: 'path', selector: 'hull' }, { tagName: 'path', selector: 'voidd' },
    { tagName: 'path', selector: 'hi' }, { tagName: 'rect', selector: 'slab' },
    { tagName: 'text', selector: 'name' }] });

  // A pipe, drawn as a tube: a dark rim for depth, the fluid itself, a gloss
  // down the middle, and the flow riding on top. Pipes sit under the vessels,
  // so they run into the nozzles rather than stopping at a boundary.
  const Pipe = j.dia.Link.define('n.Pipe', {
    attrs: {
      rim: { connection: true, stroke: '#0b1219', strokeWidth: 20, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      bore: { connection: true, stroke: C.water, strokeWidth: 14, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      gloss: { connection: true, stroke: 'rgba(255,255,255,.26)', strokeWidth: 4.4,
        fill: 'none', strokeLinejoin: 'round', strokeLinecap: 'round' },
      flow: { connection: true, stroke: 'rgba(255,255,255,.95)', strokeWidth: 6,
        fill: 'none', strokeDasharray: '2.5 30', strokeDashoffset: 0,
        strokeLinecap: 'round', opacity: 0 }
    },
    router: { name: 'orthogonal', args: { padding: 20 } },
    connector: { name: 'rounded', args: { radius: 24 } },
    connectionPoint: { name: 'anchor' },
    z: 2
  }, { markup: [{ tagName: 'path', selector: 'rim' }, { tagName: 'path', selector: 'bore' },
    { tagName: 'path', selector: 'gloss' }, { tagName: 'path', selector: 'flow' }] });

  const Wire = j.dia.Link.define('n.Wire', {
    attrs: {
      rim: { connection: true, stroke: '#0d1720', strokeWidth: 9, fill: 'none',
        strokeLinejoin: 'round', strokeLinecap: 'round' },
      bore: { connection: true, stroke: C.power, strokeWidth: 4.5, fill: 'none',
        strokeDasharray: '11 9', strokeDashoffset: 0, strokeLinejoin: 'round' }
    },
    router: { name: 'orthogonal', args: { padding: 16 } },
    connector: { name: 'rounded', args: { radius: 12 } },
    connectionPoint: { name: 'anchor' },
    z: 1
  }, { markup: [{ tagName: 'path', selector: 'rim' }, { tagName: 'path', selector: 'bore' }] });

  SHAPES = { Vessel, Tank, Pump, Panel, Flag, Zone, Pipe, Wire };
  return SHAPES;
}

// ===========================================================================
// One circuit, drawn as a section through the building: up on the screen is up
// on the site. The boiler stands above the reactor, which is why the loop keeps
// turning with the pump off, and the spare water is above the core on one
// design and in the basement on the other.
// ===========================================================================
const W = 840, H = 1260;

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
  tagPipe(link, text, col, pos, dx, dy) {
    link.labels([{ position: { distance: pos, offset: { x: dx || 0, y: dy || 0 } },
      attrs: { labelText: { text, fill: col, fontSize: 14.5, fontWeight: 700,
        fontFamily: 'ui-sans-serif,system-ui,sans-serif', textAnchor: 'middle',
        textVerticalAnchor: 'middle', stroke: 'rgba(8,14,20,.9)', strokeWidth: 4,
        paintOrder: 'stroke' } },
      markup: [{ tagName: 'text', selector: 'labelText' }] }]);
  }
  at(x, y) { return { x: this.ox + x, y }; }

  build() {
    const S = defineShapes(), P = this.passive;
    // Pipes are given the two points they actually join, not an element and a
    // hint. Every nozzle position here is read off the vessel drawings above,
    // so the plumbing lands on the stubs instead of near them, and the router
    // is never left guessing.
    const pipe = (a, b, col, verts) => {
      const l = this.add(new S.Pipe({
        source: this.at(a[0], a[1]), target: this.at(b[0], b[1]),
        vertices: (verts || []).map(v => this.at(v[0], v[1])),
        router: { name: 'normal' } }));
      // remembered so an idle pipe can go steel and come back the right colour
      if (col) { l.set('fluid', col); l.attr('bore/stroke', col); }
      return l;
    };

    // where everything stands, and where its nozzles are
    const CORE = [70, 470], SG = [470, 228], PUMP = [515, 690];
    const POOL = [70, 150], BASE = [40, 1010], ECCS = [370, 980], PWR = [640, 1010];
    const coreHot = [CORE[0] + 300, CORE[1] + RPV_OUT];      // 370, 558
    const coreCold = [CORE[0] + 300, CORE[1] + RPV_IN];      // 370, 588
    const coreTopA = [CORE[0] + 100, CORE[1]];               // gravity inlet
    const coreTopB = [CORE[0] + 200, CORE[1]];               // heat-exchanger riser
    const sgIn = [SG[0], SG[1] + SG_IN];
    const sgOut = [SG[0] + SG_OUT_X, SG[1] + 366];
    const sgTop = [SG[0] + 130, SG[1] + 30];
    const pumpTop = [PUMP[0] + 115, PUMP[1]];
    const pumpLeft = [PUMP[0], PUMP[1] + 80];
    const pumpBot = [PUMP[0] + 115, PUMP[1] + 138];
    const poolA = [POOL[0] + 100, POOL[1] + 134];
    const poolB = [POOL[0] + 200, POOL[1] + 134];

    this.zone = this.add(new S.Zone({ position: this.at(18, 10) }));

    this.core = this.add(new S.Vessel({ position: this.at(CORE[0], CORE[1]) }));
    this.core.attr({ name: { text: 'REACTOR' },
      rimA: { d: RPV_COLD }, rimB: { d: RPV_HOT },
      chanA: { d: RPV_COLD }, chanB: { d: RPV_HOT },
      glossA: { d: RPV_COLD }, glossB: { d: RPV_HOT },
      dashA: { d: RPV_COLD }, dashB: { d: RPV_HOT },
      liquid: { clipPath: 'url(#cRpvClip)' }, surf: { clipPath: 'url(#cRpvClip)' },
      fuelTx: { x: 150, y: 346, text: 'FUEL RODS', opacity: 1 } });
    for (let i = 0; i < 3; i++) {
      const [x, w] = RODS[i];
      this.core.attr(`fuel${i + 1}`, { x, width: w, opacity: 1 });
      this.core.attr(`rod${i + 1}`, { x, width: w, opacity: 1 });
    }

    this.sg = this.add(new S.Vessel({ position: this.at(SG[0], SG[1]),
      size: { width: SG_W, height: SG_H } }));
    this.sg.attr({ name: { text: 'BOILER' },
      shadow: { d: SG_SHELL }, shell: { d: SG_SHELL }, shellHi: { d: SG_SHELL },
      cav: { d: SG_CAV },
      rimA: { d: SG_COLD }, rimB: { d: SG_HOT },
      chanA: { d: SG_COLD }, chanB: { d: SG_HOT },
      glossA: { d: SG_COLD }, glossB: { d: SG_HOT },
      dashA: { d: SG_COLD }, dashB: { d: SG_HOT },
      liquid: { clipPath: 'url(#cSgClip)' }, surf: { clipPath: 'url(#cSgClip)' },
      nozA: { x: -4, y: SG_IN - 11, width: 26, height: 22 },
      nozB: { x: SG_OUT_X - 13, y: 352, width: 26, height: 20 },
      nozC: { x: 117, y: 22, width: 26, height: 20, rx: 4, fill: 'url(#cSteel)',
        stroke: '#22303c', strokeWidth: 1.5, opacity: 1 },
      skirt: { d: 'M 60 340 L 50 396 L 210 396 L 200 340 Z' },
      skirtHi: { d: 'M 60 340 L 50 396' } });

    this.pump = this.add(new S.Pump({ position: this.at(PUMP[0], PUMP[1]) }));
    this.pump.attr({ name: { text: 'PUMP' } });

    this.flag = this.add(new S.Flag({ position: this.at(520, -70) }));
    this.flag.attr({ name: { text: 'heat out, to the sea' } });

    this.supply = this.add(new S.Tank({
      position: P ? this.at(POOL[0], POOL[1]) : this.at(BASE[0], BASE[1]) }));
    this.supply.attr({ name: { text: P ? 'POOL ABOVE THE REACTOR' : 'WATER IN THE BASEMENT' } });

    this.power = this.add(new S.Panel({ position: this.at(PWR[0], PWR[1]) }));
    this.power.attr({ name: { text: 'POWER' } });

    // the loop: reactor -> boiler -> pump -> reactor
    this.hot = pipe(coreHot, sgIn, C.hot);
    this.cold1 = pipe(sgOut, pumpTop, C.cold);
    this.cold2 = pipe(pumpLeft, coreCold, C.cold, [[420, 770], [420, 588]]);
    this.out = pipe(sgTop, [sgTop[0], -16], C.steam);

    if (P) {
      // The pool does two jobs, both real: it is the water that falls in, and
      // the heat exchanger standing in it is where the heat goes when the
      // boiler route is gone.
      this.inject = pipe(poolA, coreTopA, C.water);
      this.tagPipe(this.inject, 'falls in', C.water, 0.5, -54);
      this.prhrLink = pipe(coreTopB, poolB, C.hot);
      this.tagPipe(this.prhrLink, 'heat rises', C.hot, 0.5, 56);
    } else {
      // the same inlet, reached the long way: up out of the basement, past the
      // whole height of the reactor, behind a pump that needs electricity
      this.eccs = this.add(new S.Pump({ position: this.at(ECCS[0], ECCS[1]) }));
      this.eccs.attr({ name: { text: 'BACKUP PUMP' } });
      this.inject = pipe([BASE[0] + 300, BASE[1] + 88], [ECCS[0], ECCS[1] + 80],
        C.water, [[355, BASE[1] + 88], [355, ECCS[1] + 80]]);
      this.inject2 = pipe([ECCS[0] + 115, ECCS[1]], coreTopA, C.water,
        [[485, 950], [52, 950], [52, 410], [170, 410]]);
      this.tagPipe(this.inject2, 'the long way round, uphill', C.water, 0.20, 0, -24);
    }

    this.wires = [this.add(new S.Wire({
      source: this.at(PWR[0] + 70, PWR[1]), target: this.at(pumpBot[0], pumpBot[1]),
      vertices: [this.at(PWR[0] + 70, pumpBot[1])], router: { name: 'normal' } }))];
    if (!P) this.wires.push(this.add(new S.Wire({
      source: this.at(PWR[0], PWR[1] + 38), target: this.at(ECCS[0] + 173, ECCS[1] + 80),
      vertices: [this.at(PWR[0] - 30, PWR[1] + 38), this.at(PWR[0] - 30, ECCS[1] + 80)],
      router: { name: 'normal' } })));
  }
}

Circuit.prototype.update = function (t) {
  const p = this.p, s = p.sys || {}, P = this.passive;
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  const IDLE = '#46545f';
  const setFlow = (link, on, rate) => {
    link.attr('flow/opacity', on ? 0.95 : 0);
    link.attr('bore/stroke', on ? (link.get('fluid') || C.water) : IDLE);
    link.attr('gloss/opacity', on ? 0.26 : 0.12);
    if (link.label(0)) link.prop('labels/0/attrs/labelText/opacity', on ? 1 : 0.35);
    if (on) link.attr('flow/strokeDashoffset', -(t * 30 * Math.min(1.5, rate || 1)) % 45);
  };
  const level = (el, frac, top, span, fill) => {
    const h = span * clamp(frac, 0, 1), y = top + span - h;
    el.attr({ liquid: { height: h, y, fill },
      surf: { y: y - 2, opacity: h > 3 ? 1 : 0 } });
  };
  // bubbles rise as a function of the clock, so a frozen frame is a still one
  const bubbles = (x0, x1, yBot, yTop, n, seed) => {
    let d = '';
    for (let i = 0; i < n; i++) {
      const ph = ((t * 0.42 + i * 0.37 + seed) % 1);
      const y = yBot - (yBot - yTop) * ph;
      const x = x0 + (x1 - x0) * (0.5 + 0.42 * Math.sin(i * 2.4 + seed * 6 + ph * 2.6));
      const r = 2.6 + 2.2 * Math.sin(i * 1.7 + seed);
      d += `M ${x.toFixed(1)} ${y.toFixed(1)} m ${-r} 0 a ${r} ${r} 0 1 0 ${2 * r} 0 `
        + `a ${r} ${r} 0 1 0 ${-2 * r} 0 `;
    }
    return d;
  };

  const sink = s.sink || 'none';
  const viaSG = sink === 'turbine';
  const carried = sink !== 'none';

  // ---- the reactor --------------------------------------------------------
  const lvl = clamp(p.level, 0, 1);
  const surfY = CAV_BOT - CAV_SPAN * lvl;
  const rodTop = CAV_BOT - CAV_SPAN * FUEL_TOP;
  const covered = surfY <= rodTop;
  const T = p.Tclad - 273;
  level(this.core, lvl, CAV_TOP, CAV_SPAN, 'url(#cWater)');
  const glow = T > 400 ? tempColor(Math.min(p.Tclad, 3200)) : null;
  const rodH = CH_BOT - 18 - rodTop;
  const MW = (p.qDecay || 0) / 1e6;
  this.core.attr({
    shell: { stroke: covered ? '#22303c' : '#7a2a1c' },
    glow: { x: RODS[0][0] - 10, y: rodTop - 10, width: 144, height: rodH + 20,
      fill: glow || '#ff5a1e', opacity: glow ? clamp((T - 400) / 700, 0, 0.85) : 0 },
    fuelTx: { fill: covered ? '#9fb2c2' : '#ffb59c' },
    value: { text: `water ${Math.round(lvl * 100)}%   ·   ${T.toFixed(0)} °C`,
      fill: T > 800 ? C.bad : T > 360 ? C.warn : C.dim },
    // Shutting a reactor down stops the chain reaction, not the heat. Without
    // this number nothing else on the page has a reason to exist.
    value2: { opacity: 1, text: p.scrammed
      ? `shut down — still making ${MW < 10 ? MW.toFixed(1) : Math.round(MW)} MW of heat`
      : `running — making ${Math.round(MW).toLocaleString('en-US')} MW of heat` } });
  for (let i = 1; i <= 3; i++) {
    this.core.attr(`fuel${i}`, { y: rodTop, height: rodH,
      fill: glow ? glow : 'url(#cClad)' });
    this.core.attr(`rod${i}`, { y: rodTop, height: rodH, opacity: glow ? 0.5 : 1 });
  }
  const uncovered = !covered;

  // the route through the fuel: it only moves while something is driving it
  const hotC = tempColor(Math.min(3200, p.Tcore + 40));
  const moving = flow > 0 && !uncovered;
  const off = -(t * 30 * Math.min(1.5, flow || 1)) % 45;
  const backC = carried ? C.cold : hotC;      // "cooled water" only if it was cooled
  const dead = { A: '#46545f', B: '#46545f' };
  this.core.attr({
    chanA: { stroke: moving ? backC : dead.A },
    chanB: { stroke: moving ? hotC : dead.B },
    glossA: { opacity: moving ? 0.22 : 0.07 }, glossB: { opacity: moving ? 0.22 : 0.07 },
    dashA: { opacity: moving ? 0.9 : 0, strokeDashoffset: off },
    dashB: { opacity: moving ? 0.9 : 0, strokeDashoffset: off },
    bub: { opacity: uncovered && T > 300 ? 0 : (lvl < 0.999 && T > 340 ? 0.5 : 0),
      d: bubbles(RODS[0][0], RODS[2][0] + RODS[2][1], CH_BOT - 6, surfY + 6, 7, 0.13) } });

  // ---- the boiler ---------------------------------------------------------
  const sgLvl = viaSG ? 0.72 : 0.22;
  level(this.sg, sgLvl, SG_TOP, SG_SPAN, 'url(#cWater)');
  this.sg.attr({
    shell: { stroke: carried ? '#22303c' : '#7a2a1c' },
    chanA: { stroke: moving ? backC : dead.A },
    chanB: { stroke: moving ? hotC : dead.B },
    glossA: { opacity: moving ? 0.22 : 0.07 }, glossB: { opacity: moving ? 0.22 : 0.07 },
    dashA: { opacity: moving ? 0.9 : 0, strokeDashoffset: off },
    dashB: { opacity: moving ? 0.9 : 0, strokeDashoffset: off },
    bub: { opacity: viaSG ? 0.6 : 0,
      d: bubbles(60, 200, SG_BOT - 8, SG_BOT - SG_SPAN * sgLvl + 6, 9, 0.61) },
    value: { text: viaSG ? 'taking the heat away'
      : sink === 'pool' ? 'not needed — the pool has it'
        : sink === 'shell' ? 'not needed — the shell has it' : 'not taking any heat',
      fill: viaSG ? C.dim : carried ? C.ok : C.bad } });

  // ---- pumps and power ----------------------------------------------------
  const live = !!(s.grid || s.diesel);
  // The Gen-II last-resort pump runs on steam from the reactor itself, so it
  // works with no electricity at all - for as long as the steam lasts.
  const steamOnly = !P && !!s.rcic && !s.aux;
  const spin = (el, on, rate) => {
    const a = on ? (t * 190 * (rate || 1)) % 360 : 0;
    el.attr({ imp: { transform: `rotate(${a.toFixed(1)},115,80)` },
      imp2: { transform: `rotate(${(a + 120).toFixed(1)},115,80)` },
      imp3: { transform: `rotate(${(a + 240).toFixed(1)},115,80)` } });
  };
  // Two lines: what the pump is doing, and what the cooling depends on. This
  // pump is a normal-running machine on both plants, and when it stops the loop
  // keeps creeping round on both. The difference is what comes next.
  const pumpTx = s.rcp
    ? (P ? ['spinning', 'the cooling needs no pump at all']
      : ['spinning', 'the cooling needs pumps like this'])
    : (P ? ['stopped', 'and the cooling carries on anyway']
      : ['STOPPED', steamOnly ? 'the steam pump covers it'
        : live ? 'the backups must take over'
          : 'the backups have no power']);
  spin(this.pump, !!s.rcp, 1);
  this.pump.attr({
    imp: { fill: s.rcp ? '#5fb2e8' : '#42525f' },
    imp2: { fill: s.rcp ? '#5fb2e8' : '#42525f' },
    imp3: { fill: s.rcp ? '#5fb2e8' : '#42525f' },
    body: { stroke: s.rcp ? '#22303c' : (P ? '#2c6a45' : '#7a2a1c') },
    value: { text: pumpTx[0], fill: s.rcp ? C.ink : (P ? C.ok : C.bad) },
    value2: { text: pumpTx[1], fill: s.rcp ? C.dim : (P ? C.ok : C.bad) } });
  const src = s.grid ? 'grid' : s.diesel ? 'diesels'
    : s.battery > 0 ? `batteries ${(s.battery * p.batteryHours).toFixed(0)} h` : 'NONE';
  this.power.attr({
    body: { stroke: live ? 'rgba(255,211,92,.55)' : (s.battery > 0 ? C.warn : C.bad) },
    bolt: { fill: live ? C.power : (s.battery > 0 ? C.warn : '#5a3630') },
    value: { text: src, fill: live ? C.power : (s.battery > 0 ? C.warn : C.bad) } });
  for (const w of this.wires) {
    w.attr('bore/stroke', live ? C.power : '#3a4550');
    w.attr('bore/strokeDashoffset', live ? -(t * 22) % 20 : 0);
    w.attr('bore/opacity', live ? 1 : 0.5);
  }

  // ---- the loop -----------------------------------------------------------
  // With nothing taking the heat away the return leg is not cooled water coming
  // back, it is the same hot water going round again.
  this.hot.set('fluid', hotC);
  this.cold1.set('fluid', backC);
  this.cold2.set('fluid', backC);
  setFlow(this.hot, flow > 0, flow);
  setFlow(this.cold1, flow > 0, flow);
  setFlow(this.cold2, flow > 0, flow);
  setFlow(this.out, viaSG, 1);
  if (this.prhrLink) setFlow(this.prhrLink, sink === 'pool', s.prhr || 1);
  this.flag.attr({ body: { stroke: viaSG ? C.edge : '#39424c', opacity: viaSG ? 1 : 0.5 },
    name: { fill: viaSG ? C.ink : '#5d6975' } });

  // ---- the spare water ----------------------------------------------------
  // Weighted by what these actually hold: two 70 t makeup tanks against a
  // 2,000 t pool.
  const poolFrac = p.irwst / 2.1e6;
  const floorFrac = (p.ctmtSump || 0) / 2.1e6;
  const store = P
    ? clamp(0.07 * p.cmtLevel + 0.93 * Math.max(poolFrac, floorFrac * 0.85), 0, 1)
    : 1;
  // the model keeps a 100 t floor in the pool figure, so "empty" is not zero
  const onFloor = P && p.irwst < 1.6e5 && floorFrac > 0.05;
  const injecting = P ? !!(s.cmt || s.gravity || s.accum) : !!(s.aux || s.rcic);
  // The pool is a natural-circulation loop, not a one-way street: hot water
  // rises into it and cooled water comes back down.
  const poolLoop = P && sink === 'pool';
  const cracked = P && p.irwstCracked;
  const lost = P && onFloor && !p.ctmtIntact;
  level(this.supply, store, 42, 82,
    lost ? '#6b4a34' : onFloor ? 'url(#cWaterDim)' : cracked ? '#7d5a3a' : 'url(#cWater)');
  this.supply.attr({
    shell: { stroke: lost ? '#7a2a1c' : cracked && !onFloor ? '#7a5a1c' : '#22303c' },
    value: { text: P ? (lost ? 'ESCAPING as steam'
      : onFloor ? 'still gets back in'
        : cracked ? 'CRACKED — draining'
          : injecting ? 'falling into the reactor'
            : poolLoop ? 'taking the heat from the reactor'
              : 'ready — no pump needed')
      : (injecting ? 'being pumped up'
        : !live ? 'CANNOT REACH THE REACTOR'
          : !p.pumpsOk ? 'THE PUMPS HAVE FAILED' : 'waiting down here'),
      fill: lost ? C.bad : onFloor ? C.ok : cracked ? C.warn : P ? C.ok
        : injecting ? C.ink : (live && p.pumpsOk ? C.dim : C.bad) } });
  if (P) this.supply.attr('name/text',
    onFloor ? 'WATER ON THE FLOOR' : 'POOL ABOVE THE REACTOR');
  if (P) {
    this.inject.set('fluid', injecting ? C.water : C.cold);
    this.inject.prop('labels/0/attrs/labelText/text',
      injecting ? 'falls in' : 'comes back cooled');
    this.inject.prop('labels/0/attrs/labelText/fill', injecting ? C.water : C.cold);
  }
  setFlow(this.inject, injecting || poolLoop, 1);
  if (this.inject2) setFlow(this.inject2, injecting, 1);
  if (this.eccs) {
    spin(this.eccs, injecting, 0.8);
    this.eccs.attr({
      imp: { fill: injecting ? '#5fb2e8' : '#42525f' },
      imp2: { fill: injecting ? '#5fb2e8' : '#42525f' },
      imp3: { fill: injecting ? '#5fb2e8' : '#42525f' },
      body: { stroke: steamOnly ? '#7a5a1c' : injecting ? '#22303c'
        : (live && p.pumpsOk ? '#22303c' : '#7a2a1c') },
      value: { text: steamOnly ? 'running on steam' : injecting ? 'pumping'
        : !live ? 'NO POWER' : !p.pumpsOk ? 'BROKEN' : 'waiting',
        fill: steamOnly ? C.warn : injecting ? C.ink : (live && p.pumpsOk) ? C.dim : C.bad },
      value2: { text: steamOnly ? 'runs on steam, not the grid'
        : injecting ? 'lifting water uphill'
          : !live ? 'it needs electricity'
            : !p.pumpsOk ? 'it cannot lift the water' : 'starts if the level falls',
        fill: steamOnly ? C.warn : injecting || (live && p.pumpsOk) ? C.dim : C.bad } });
  }

  // ---- the wall -----------------------------------------------------------
  const shell = sink === 'shell';
  this.zone.attr({
    hull: { stroke: p.ctmtIntact ? (shell ? '#3f7d5c' : '#3d4e5f') : '#7a2a1c' },
    slab: { stroke: p.ctmtIntact ? (shell ? '#3f7d5c' : '#3d4e5f') : '#7a2a1c' },
    name: { fill: p.ctmtIntact ? (shell ? C.ok : C.dim) : C.bad,
      text: !p.ctmtIntact ? 'CONTAINMENT BREACHED — the barrier is gone'
        : shell ? 'CONTAINMENT — the steel is taking the heat to the air'
          : 'CONTAINMENT — nothing inside this line gets out' } });

  // The steps, worst first, so the headline always names the furthest thing
  // that has happened rather than the first one that matched.
  const lostWater = P && !p.ctmtIntact;
  this.headline =
    p.vesselBreach || /DESTROYED/.test(p.state) ? 'MELTDOWN'
      : uncovered ? 'FUEL IS UNCOVERED'
        : p.coreDamage > 0.01 ? 'FUEL IS DAMAGED'
          : lvl < 0.97 ? 'LOSING WATER'
            : lostWater ? 'THE WATER IS ESCAPING'
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
    // Materials. Everything in this view is drawn from these: steel with a lit
    // edge, dark cavities, water with depth, concrete. A schematic can still be
    // made of something.
    const defs = this.paper.svg.querySelector('defs') || this.paper.svg.insertBefore(
      document.createElementNS('http://www.w3.org/2000/svg', 'defs'), this.paper.svg.firstChild);
    defs.insertAdjacentHTML('beforeend', `
      <linearGradient id="cSteel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#b3c5d3"/><stop offset=".13" stop-color="#8698a9"/>
        <stop offset=".52" stop-color="#4e5e6c"/><stop offset=".84" stop-color="#3b4956"/>
        <stop offset="1" stop-color="#71838f"/></linearGradient>
      <radialGradient id="cVolute" cx=".34" cy=".26" r=".85">
        <stop offset="0" stop-color="#a6b9c8"/><stop offset=".5" stop-color="#5d6f7f"/>
        <stop offset="1" stop-color="#36434f"/></radialGradient>
      <linearGradient id="cCav" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#243642"/><stop offset=".45" stop-color="#16242f"/>
        <stop offset="1" stop-color="#0e1a23"/></linearGradient>
      <linearGradient id="cWater" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#6fc4f7"/><stop offset=".14" stop-color="#3d9ae4"/>
        <stop offset=".62" stop-color="#1f6ab4"/><stop offset="1" stop-color="#123f74"/></linearGradient>
      <linearGradient id="cWaterDim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4f8fbc"/><stop offset="1" stop-color="#14405f"/></linearGradient>
      <linearGradient id="cClad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#8d9dab"/><stop offset=".28" stop-color="#dfe9f0"/>
        <stop offset=".62" stop-color="#9aa9b6"/><stop offset="1" stop-color="#616f7c"/></linearGradient>
      <linearGradient id="cConc" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#54custom"/><stop offset="1" stop-color="#28323d"/></linearGradient>
      <linearGradient id="cPanel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1a2733"/><stop offset="1" stop-color="#0d1620"/></linearGradient>
      <filter id="cBlur" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="9"/></filter>
      <filter id="cHot" x="-70%" y="-70%" width="240%" height="240%">
        <feGaussianBlur stdDeviation="13"/></filter>
      <pattern id="cRods" width="15" height="10" patternUnits="userSpaceOnUse">
        <rect x="0" y="0" width="15" height="10" fill="rgba(0,0,0,0)"/>
        <rect x="5" y="0" width="5" height="10" fill="rgba(14,24,33,.55)"/>
        <rect x="1.5" y="0" width="1.6" height="10" fill="rgba(255,255,255,.16)"/></pattern>
      <clipPath id="cRpvClip"><path d="${RPV_CAV}"/></clipPath>
      <clipPath id="cSgClip"><path d="${SG_CAV}"/></clipPath>`
      .replace('#54custom', '#4a5a6c'));
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

  // A caption that runs off its own box is the defect this view keeps growing
  // back, because the strings change with the plant's state and no reviewer
  // sees every state. Rather than police the wording, measure it: anything too
  // wide for the box it sits in is stepped down until it fits. Same text gives
  // the same size every time, so the frozen-frame check stays happy.
  fitCaptions() {
    for (const c of this.circuits) {
      for (const cell of c.cells) {
        if (!cell.isElement()) continue;
        const view = this.paper.findViewByModel(cell);
        if (!view || !view.el || view.el.style.display === 'none') continue;
        const box = cell.size().width - 16;
        for (const node of view.el.querySelectorAll('text')) {
          const txt = node.textContent;
          if (!txt || node.dataset.fitFor === txt) continue;
          node.dataset.fitFor = txt;
          if (!node.dataset.fitBase) {
            node.dataset.fitBase = node.style.fontSize
              || node.getAttribute('font-size') || '13';
          }
          const base = parseFloat(node.dataset.fitBase);
          node.style.fontSize = base + 'px';
          const w = node.getBBox().width;
          if (w > box && w > 0) {
            node.style.fontSize = Math.max(8.5, base * (box / w)).toFixed(2) + 'px';
          }
        }
      }
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
    if (changed) { this.placeHeads(); this.fitCaptions(); }
  }
}
