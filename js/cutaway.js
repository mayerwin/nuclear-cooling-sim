// ---------------------------------------------------------------------------
// cutaway.js - the inside of both reactor buildings, drawn as a true cutaway
// section in SVG.
//
// Why SVG and not the canvas the rest of the app uses: this view is a drawing,
// not a scene. It needs crisp text at any pixel ratio, exact clipping for
// liquid levels, and component outlines authored as real paths. All of that is
// one attribute on an SVG node and a fight on a canvas.
//
// Everything is authored in METRES at true relative scale, y measured up from
// the containment basemat, and Y() flips into SVG's y-down space. The only
// deliberate distortion is that the free volume above the operating deck is
// compressed - a real large-dry containment is 65 m tall and the top 30 m of it
// is air. That is declared in the fidelity ledger.
//
// Real dimensions used (Westinghouse 4-loop / AP1000 class):
//   reactor vessel      13.4 m tall, 4.4 m inside diameter
//   active fuel          3.66 m tall
//   steam generator     20.6 m tall - narrow evaporator shell, conical
//                       transition, fat separator shell. Nothing else in the
//                       building has that silhouette, which is the point.
//   pressuriser         12.8 m tall, 2.4 m diameter
//   containment         40 m inside diameter, 1.15 m of concrete
//
// The fluids are the subject, so they carry the saturated colour and the
// structure stays grey. Every level, colour and flow is read from plant.sys
// and plant state on the frame the model computes it.
// ---------------------------------------------------------------------------
import { MODE } from './plant.js';

const NS = 'http://www.w3.org/2000/svg';

// ---- geometry, metres ------------------------------------------------------
// Per design, because the two machines are not the same size and drawing them
// from one set of constants erases real differences. Figures from the NRC
// Westinghouse Technology Systems Manual (ML11223A213, ML11223A212) and the
// AP1000 design certification material (NUREG-1793 Ch.5; NRC HRTD R107P
// ML11221A083).
const COMMON = { gnd: 58, cx: 50, floor: 2.0, deck: 17.4, spring: 36, domeRy: 13, crane: 34.0 };

export function makeGeo(passive) {
  const G = Object.assign({}, COMMON, passive ? {
    // AP1000
    rin: 19.8, wall: 0.55, steelShell: true,
    rpv:  { dx: -12.8, r: 2.25, base: 4.2, cyl: 7.9, head: 2.05 },
    core: { up: 2.4, h: 4.27, halfW: 1.52 },          // 14 ft fuel, 157 assemblies
    sg:   { dx: 2.6, base: 7.0, rl: 2.1, ru: 3.0, hLow: 9.4, hCone: 2.6, hUp: 6.6 },
    przr: { dx: -1.4, base: 18.5, r: 1.27, h: 10.24 },  // 100 in x 503 in
    // AP1000 puts the inlet (cold) nozzle ABOVE the outlet, offset 17.5 in, so
    // the loop can be drained to mid-loop with the pumps in place
    hotZ: 14.4, coldZ: 14.84, hotD: 0.79, coldD: 0.56, loops: 2
  } : {
    // Westinghouse 4-loop, large dry containment
    rin: 21.35, wall: 1.15, steelShell: false,
    rpv:  { dx: -13.4, r: 2.42, base: 4.2, cyl: 8.4, head: 2.1 },
    core: { up: 2.6, h: 3.66, halfW: 1.68 },          // 12 ft fuel, 193 assemblies
    sg:   { dx: 3.0, base: 8.0, rl: 1.9, ru: 2.44, hLow: 8.4, hCone: 2.3, hUp: 5.9 },
    przr: { dx: -1.6, base: 18.5, r: 1.145, h: 13.1 }, // 90 in x 607 in
    hotZ: 15.2, coldZ: 14.0, hotD: 0.74, coldD: 0.70, loops: 4,
    xoverD: 0.79
  });
  G.rpv.cylTop = G.rpv.base + G.rpv.r + G.rpv.cyl;
  G.rpv.top    = G.rpv.cylTop + G.rpv.head;
  G.core.z0    = G.rpv.base + G.rpv.r + G.core.up;
  G.core.z1    = G.core.z0 + G.core.h;
  G.sg.yCone   = G.sg.base + G.sg.rl + G.sg.hLow;
  G.sg.yUp     = G.sg.yCone + G.sg.hCone;
  G.sg.yTop    = G.sg.yUp + G.sg.hUp;
  return G;
}
export const GEO = makeGeo(false);

const Y = m => GEO.gnd - m;

// ---- palette: the water is the subject -------------------------------------
const C = {
  conc: '#4f4d47', concLine: '#6a675f',
  steel: '#aab5bf', steelDim: '#5d666f',
  dark: '#111922',
  liner: '#c0ae7d',
  text: '#d5e2ec', dim: '#8496a4',
  ok: '#63e08a', warn: '#ffc44d', bad: '#ff5c48',
  h2: '#d9e04a', air: '#7fd0e4', power: '#ffd35c',
  cold: '#2f7fd0'
};

// Temperature ramp. Confident blue when normal, then yellow, orange, red.
// Primary side. Amber at operating temperature - it is 320 C, and drawing it
// cool is what made the first version unreadable - then red as the fuel goes.
const RAMP = [
  [400, '#a8663a'], [600, '#cf8038'], [680, '#e09a34'], [780, '#e2702c'],
  [1000, '#e24822'], [1400, '#e8391f'], [2000, '#ff6a2a'],
  [2600, '#ffb96a'], [3200, '#ffe6bd']
];
// Everything cold: injection water, the secondary side, the pools.
const COOL = [
  [290, '#2668b8'], [420, '#2f8ed6'], [500, '#3aa6e0'], [560, '#43bcd8'],
  [610, '#63d2cf'], [700, '#c9b141'], [900, '#e09330']
];
function hex(c) {
  let h = c.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function ramp(tab, K) {
  if (K <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (K <= tab[i][0]) {
      const t = (K - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]);
      const a = hex(tab[i - 1][1]), b = hex(tab[i][1]);
      return `rgb(${(a[0] + (b[0] - a[0]) * t) | 0},${(a[1] + (b[1] - a[1]) * t) | 0},${(a[2] + (b[2] - a[2]) * t) | 0})`;
    }
  }
  return tab[tab.length - 1][1];
}
export function tempColor(K) { return ramp(RAMP, K); }
export function coolColor(K) { return ramp(COOL, K); }
function shade(c, f) {
  const a = hex(c);
  return `rgb(${Math.min(255, a[0] * f) | 0},${Math.min(255, a[1] * f) | 0},${Math.min(255, a[2] * f) | 0})`;
}

// ---- tiny DOM helpers ------------------------------------------------------
export function el(parent, name, attrs, text) {
  const e = document.createElementNS(NS, name);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const P = pts => 'M' + pts.map(p => `${p[0]},${Y(p[1])}`).join(' L ');

// ===========================================================================
// One section: one reactor building, cut open.
// ===========================================================================
export class Section {
  constructor(plant, ox) {
    this.p = plant;
    this.ox = ox;                                   // metres, section offset
    this.passive = plant.mode === MODE.PASSIVE;
    this.key = this.passive ? 'p' : 'a';
    this.G = makeGeo(this.passive);
    this.r = {};                                    // live element references
  }
  x(m) { return this.ox + m; }                      // section-local -> world

  // -- primitives ----------------------------------------------------------
  // A cut-open vessel: dark interior, thick wall, and a clip for its contents.
  vessel(layerShell, layerWall, id, d) {
    el(layerShell, 'path', { d, fill: C.dark });
    const cp = el(this.defs, 'clipPath', { id });
    el(cp, 'path', { d });
    el(layerWall, 'path', {
      d, fill: 'none', stroke: 'url(#cutWall)', 'stroke-width': 0.68,
      'stroke-linejoin': 'round'
    });
    el(layerWall, 'path', {
      d, fill: 'none', stroke: C.steel, 'stroke-width': 0.1, 'stroke-linejoin': 'round'
    });
  }
  // A body of liquid inside a clip. Returns handles the update pass moves.
  liquid(id, x0, w, name) {
    const g = el(this.L.fluid, 'g', { 'clip-path': `url(#${id})` });
    const body = el(g, 'rect', { x: x0, y: Y(0), width: w, height: 0, fill: C.cold });
    const surf = el(g, 'rect', { x: x0, y: Y(0), width: w, height: 0.3, fill: '#a8e6ff' });
    this.r[name] = { body, surf, x0, w };
    return g;
  }
  setLevel(name, top, bottom, colour) {
    const h = this.r[name];
    if (!h) return;
    const lvl = Math.max(bottom, top);
    h.body.setAttribute('y', Y(lvl));
    h.body.setAttribute('height', Math.max(0, lvl - bottom));
    h.body.setAttribute('fill', colour);
    const show = lvl > bottom + 0.05;
    h.surf.setAttribute('y', Y(lvl));
    h.surf.setAttribute('opacity', show ? 1 : 0);
    h.surf.setAttribute('fill', shade(colour, 1.7));
  }
  // A pipe: dark casing, coloured bore, and a dashed overlay that carries flow.
  pipe(pts, w, name) {
    const LY = this.L[this._into || 'pipe'];
    const d = P(pts.map(q => [this.x(q[0]), q[1]]));
    el(LY, 'path', {
      d, fill: 'none', stroke: '#4d565f', 'stroke-width': w + 0.42,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    });
    const bore = el(LY, 'path', {
      d, fill: 'none', stroke: C.cold, 'stroke-width': w,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    });
    const flow = el(LY, 'path', {
      d, fill: 'none', stroke: 'rgba(255,255,255,.75)', 'stroke-width': w * 0.32,
      'stroke-linecap': 'butt', 'stroke-dasharray': `${w * 0.9} ${w * 2.6}`,
      'stroke-dashoffset': 0, opacity: 0
    });
    if (name) this.r[name] = { bore, flow, len: (w * 0.9 + w * 2.6) };
    return { bore, flow };
  }
  setFlow(name, colour, rate, t, reverse) {
    const h = this.r[name];
    if (!h) return;
    h.bore.setAttribute('stroke', rate > 0 ? colour : '#333c45');
    h.flow.setAttribute('opacity', rate > 0 ? 0.9 : 0);
    if (rate > 0) h.flow.setAttribute('stroke-dashoffset',
      ((reverse ? 1 : -1) * t * 5.5 * Math.min(1.6, rate)) % h.len);
  }
  pump(x, y, name) {
    const g = el(this.L[this._into || 'pipe'], 'g', {});
    const body = el(g, 'circle', { cx: this.x(x), cy: Y(y), r: 1.5, fill: '#243441',
      stroke: C.steel, 'stroke-width': 0.16 });
    const tri = el(g, 'path', {
      d: `M${this.x(x) - 0.7},${Y(y + 0.8)} L${this.x(x) + 1.0},${Y(y)} L${this.x(x) - 0.7},${Y(y - 0.8)} Z`,
      fill: '#7fc6f0' });
    const bolt = el(g, 'text', { x: this.x(x) + 1.9, y: Y(y) + 1.5,
      class: 'cutBolt', 'text-anchor': 'middle' }, '⚡');
    this.r[name] = { body, tri, bolt };
    return g;
  }
  setPump(name, running) {
    const h = this.r[name]; if (!h) return;
    h.tri.setAttribute('fill', running ? '#7fc6f0' : '#48525b');
    h.body.setAttribute('stroke', running ? C.steel : C.steelDim);
    h.bolt.setAttribute('fill', running ? C.power : '#4d565f');
  }
  valve(x, y, name) {
    const s = 0.95, X = this.x(x);
    const g = el(this.L[this._into || 'pipe'], 'path', {
      d: `M${X - s},${Y(y + s)} L${X},${Y(y)} L${X - s},${Y(y - s)} Z
          M${X + s},${Y(y + s)} L${X},${Y(y)} L${X + s},${Y(y - s)} Z`,
      fill: '#2b2f34', stroke: C.steel, 'stroke-width': 0.16 });
    this.r[name] = g;
    return g;
  }
  setValve(name, open, alarm) {
    const g = this.r[name]; if (!g) return;
    g.setAttribute('fill', alarm ? '#5a1a12' : open ? '#16351f' : '#2b2f34');
    g.setAttribute('stroke', alarm ? C.bad : open ? C.ok : C.steel);
  }
  // Direct label with a leader into a side gutter. No numbered key: the whole
  // point of a cutaway is that you read it without looking away.
  label(ax, ay, gx, gy, text, side) {
    const AX = this.x(ax), GX = this.x(gx);
    el(this.L.anno, 'path', { d: `M${AX},${Y(ay)} L${GX},${Y(gy)}`,
      stroke: 'rgba(150,190,215,.42)', 'stroke-width': 0.08 });
    el(this.L.anno, 'circle', { cx: AX, cy: Y(ay), r: 0.22, fill: '#9ec8e2' });
    return el(this.L.anno, 'text', {
      x: GX + (side === 'end' ? -0.7 : 0.7), y: Y(gy) + 0.52,
      class: 'cutLab', 'text-anchor': side || 'start' }, text);
  }
  // A pill that only appears when it has something to say.
  tag(x, y, name, tone) {
    const g = el(this.L.anno, 'g', { opacity: 0 });
    const rect = el(g, 'rect', { x: this.x(x) - 5, y: Y(y) - 1.1, width: 10, height: 2.2,
      rx: 0.6, fill: 'rgba(12,20,28,.92)', stroke: C.ok, 'stroke-width': 0.12 });
    const txt = el(g, 'text', { x: this.x(x), y: Y(y) + 0.55, class: 'cutTag',
      'text-anchor': 'middle' }, '');
    const h = { g, rect, txt, x: this.x(x), y: Y(y), w: 10, on: false };
    this.r[name] = h;
    (this.tags || (this.tags = [])).push(h);
    return g;
  }
  setTag(name, text, tone) {
    const h = this.r[name]; if (!h) return;
    h.on = !!text;
    if (!text) { h.g.setAttribute('opacity', 0); return; }
    h.g.setAttribute('opacity', 1);
    if (h.txt.textContent !== text) {
      h.txt.textContent = text;
      h.w = Math.max(6, text.length * 0.86 + 2.2);
      h.rect.setAttribute('width', h.w);
    }
    const col = tone === 'bad' ? C.bad : tone === 'warn' ? C.warn : C.ok;
    const bg = tone === 'bad' ? 'rgba(60,14,10,.94)' : tone === 'warn'
      ? 'rgba(56,40,8,.94)' : 'rgba(10,40,26,.94)';
    h.rect.setAttribute('stroke', col); h.rect.setAttribute('fill', bg);
    h.txt.setAttribute('fill', col);
  }

  // Pills appear and vanish with the plant's state, so wherever two of them
  // want the same patch of drawing, push the later one clear.
  layoutTags() {
    const on = (this.tags || []).filter(h => h.on);
    const placed = [];
    for (const h of on) {
      let y = h.y;
      for (let k = 0; k < 14; k++) {
        let hit = false;
        for (const q of placed)
          if (Math.abs(q.x - h.x) < (q.w + h.w) / 2 + 0.6 && Math.abs(q.y - y) < 2.7) { hit = true; break; }
        if (!hit) break;
        y -= 2.8;
      }
      placed.push({ x: h.x, y, w: h.w });
      h.g.setAttribute('transform', `translate(0,${(y - h.y).toFixed(2)})`);
      h.rect.setAttribute('x', h.x - h.w / 2);
    }
  }
}

// ---------------------------------------------------------------------------
// static geometry
// ---------------------------------------------------------------------------
Section.prototype.build = function (root, defs) {
  this.defs = defs;
  this.L = {};
  for (const k of ['back', 'atmo', 'shell', 'fluid', 'intern', 'wall', 'pipe', 'ext', 'front', 'anno'])
    this.L[k] = el(root, 'g', { class: 'cl-' + k });
  const G = this.G, X = m => this.x(m), P_ = this.passive;
  const cx = G.cx, rin = G.rin, ro = rin + G.wall;

  // ---- the building ------------------------------------------------------
  if (P_) {
    // AP1000: steel containment vessel inside a concrete shield building, with
    // the annulus the cooling draught climbs between them.
    const sr = rin + 3.4, shRy = G.domeRy + 7.5;
    el(this.L.back, 'path', { d: `M${X(cx - sr - 1.1)},${Y(-1.4)} L${X(cx - sr - 1.1)},${Y(G.spring + 1)}
      A${sr + 1.1},${shRy + 1.1} 0 0 1 ${X(cx + sr + 1.1)},${Y(G.spring + 1)} L${X(cx + sr + 1.1)},${Y(-1.4)} Z`,
      fill: 'url(#cutConc)' });
    el(this.L.back, 'path', { d: `M${X(cx - sr)},${Y(G.floor)} L${X(cx - sr)},${Y(G.spring + 1)}
      A${sr},${shRy} 0 0 1 ${X(cx + sr)},${Y(G.spring + 1)} L${X(cx + sr)},${Y(G.floor)} Z`,
      fill: '#0a1017' });
    this.r.baffle = el(this.L.front, 'path', { d: `M${X(cx - sr + 0.3)},${Y(G.floor)} L${X(cx - sr + 0.3)},${Y(G.spring)}
      M${X(cx + sr - 0.3)},${Y(G.floor)} L${X(cx + sr - 0.3)},${Y(G.spring)}`,
      fill: 'none', stroke: '#4a5259', 'stroke-width': 0.2 });
  }
  el(this.L.back, 'path', { d: `M${X(cx - ro)},${Y(-1.4)} L${X(cx - ro)},${Y(G.spring)}
    A${ro},${G.domeRy + G.wall} 0 0 1 ${X(cx + ro)},${Y(G.spring)} L${X(cx + ro)},${Y(-1.4)} Z`,
    fill: P_ ? 'url(#cutSteelB)' : 'url(#cutConc)' });
  this.r.void = el(this.L.back, 'path', { d: `M${X(cx - rin)},${Y(G.floor)} L${X(cx - rin)},${Y(G.spring)}
    A${rin},${G.domeRy} 0 0 1 ${X(cx + rin)},${Y(G.spring)} L${X(cx + rin)},${Y(G.floor)} Z`,
    fill: '#0c131b' });
  const inner = `M${X(cx - rin)},${Y(G.floor)} L${X(cx - rin)},${Y(G.spring)}
    A${rin},${G.domeRy} 0 0 1 ${X(cx + rin)},${Y(G.spring)} L${X(cx + rin)},${Y(G.floor)} Z`;
  const acp = el(defs, 'clipPath', { id: 'atmo' + this.key }); el(acp, 'path', { d: inner });
  this.r.liner = el(this.L.front, 'path', { d: inner, fill: 'none',
    stroke: P_ ? '#9fb3c2' : C.liner, 'stroke-width': P_ ? 0.34 : 0.24 });
  el(this.L.back, 'rect', { x: X(cx - ro), y: Y(G.floor), width: ro * 2, height: G.floor + 1.4,
    fill: '#3b3936' });
  // the failure states, drawn rather than captioned
  this.r.blown = el(this.L.front, 'g', { opacity: 0 });
  {   // sky through a torn-open dome
    const seed = this.passive ? 7 : 3, pts = [];
    for (let i = 0; i <= 12; i++) {
      const u = cx - ro + (ro * 2) * (i / 12);
      let h = Math.imul(i + 1, 374761393) ^ Math.imul(seed, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      pts.push([u, G.spring + 1.4 + ((h >>> 16) / 65536) * 4.2]);
    }
    const tear = 'M' + pts.map(q => `${X(q[0])},${Y(q[1])}`).join(' L ');
    const cover = tear
      + ` L${X(cx + ro + 1)},${Y(G.spring + G.domeRy + 11)}`
      + ` L${X(cx - ro - 1)},${Y(G.spring + G.domeRy + 11)} Z`;
    el(this.r.blown, 'path', { d: cover, fill: '#0b111a' });
    el(this.r.blown, 'path', { d: tear, fill: 'none', stroke: '#8b8579',
      'stroke-width': 0.6, 'stroke-linejoin': 'round' });
    el(this.r.blown, 'path', { d: tear, fill: 'none', stroke: 'rgba(255,130,70,.55)',
      'stroke-width': 0.24 });
  }
  this.r.sabotage = el(this.L.anno, 'g', { opacity: 0 });

  // containment atmosphere: steam haze, then hydrogen stratifying under the dome
  const ag = el(this.L.atmo, 'g', { 'clip-path': `url(#atmo${this.key})` });
  this.r.haze = el(ag, 'rect', { x: X(cx - rin), y: Y(G.spring + G.domeRy), width: rin * 2,
    height: G.spring + G.domeRy, fill: 'rgba(214,228,238,0)' });
  this.r.h2 = el(ag, 'rect', { x: X(cx - rin), y: Y(G.spring + G.domeRy), width: rin * 2,
    height: 0, fill: 'rgba(217,224,74,.22)' });
  this.r.h2line = el(ag, 'rect', { x: X(cx - rin), y: Y(0), width: rin * 2, height: 0.22,
    fill: C.h2, opacity: 0 });

  // ---- reactor vessel, in its cavity --------------------------------------
  const R = G.rpv, rx = cx + R.dx;
  el(this.L.back, 'path', { d: `M${X(rx - R.r - 2.2)},${Y(R.cylTop + 0.4)} L${X(rx - R.r - 2.2)},${Y(G.floor - 1)}
    L${X(rx + R.r + 2.2)},${Y(G.floor - 1)} L${X(rx + R.r + 2.2)},${Y(R.cylTop + 0.4)}
    L${X(rx + R.r + 0.35)},${Y(R.cylTop + 0.4)} L${X(rx + R.r + 0.35)},${Y(G.floor + 0.6)}
    L${X(rx - R.r - 0.35)},${Y(G.floor + 0.6)} L${X(rx - R.r - 0.35)},${Y(R.cylTop + 0.4)} Z`,
    fill: '#403e39', stroke: C.concLine, 'stroke-width': 0.12 });
  const rd = `M${X(rx - R.r)},${Y(R.base + R.r)} A${R.r},${R.r} 0 0 0 ${X(rx + R.r)},${Y(R.base + R.r)}
    L${X(rx + R.r)},${Y(R.cylTop)} Q${X(rx + R.r)},${Y(R.top)} ${X(rx)},${Y(R.top)}
    Q${X(rx - R.r)},${Y(R.top)} ${X(rx - R.r)},${Y(R.cylTop)} Z`;
  this.vessel(this.L.shell, this.L.wall, 'cR' + this.key, rd);
  this.liquid('cR' + this.key, X(rx - R.r), R.r * 2, 'rpv');
  // the fuel: the single most important object in the drawing
  const fg = el(this.L.intern, 'g', { 'clip-path': `url(#cR${this.key})` });
  el(fg, 'rect', { x: X(rx - G.core.halfW), y: Y(G.core.z1), width: G.core.halfW * 2,
    height: G.core.h, fill: '#1b2732' });
  this.r.rods = [];
  for (let i = -4; i <= 4; i++)
    this.r.rods.push(el(fg, 'rect', { x: X(rx + i * (G.core.halfW / 4.6) - 0.15),
      y: Y(G.core.z1), width: 0.3, height: G.core.h, fill: '#cfd9e1', stroke: '#20303e',
      'stroke-width': 0.06 }));
  for (const zz of [G.core.z0, G.core.z1])
    el(fg, 'rect', { x: X(rx - G.core.halfW), y: Y(zz) - 0.19, width: G.core.halfW * 2,
      height: 0.38, fill: '#8f9ba5', stroke: '#dde6ee', 'stroke-width': 0.06 });
  this.r.glow = el(fg, 'rect', { x: X(rx - G.core.halfW), y: Y(G.core.z1),
    width: G.core.halfW * 2, height: G.core.h, fill: 'url(#cutGlow)', opacity: 0 });
  this.r.corium = el(this.L.intern, 'ellipse', { cx: X(rx), cy: Y(G.floor + 0.3), rx: 3, ry: 0.9,
    fill: '#e2621f', opacity: 0 });
  this.r.breach = el(this.L.wall, 'path', { d: `M${X(rx - 1.1)},${Y(R.base)} L${X(rx + 1.1)},${Y(R.base)}`,
    stroke: '#0c1015', 'stroke-width': 1.1, opacity: 0 });
  // control rod drives
  this.r.crdm = el(this.L.wall, 'g', {});
  for (let i = -3; i <= 3; i++)
    el(this.r.crdm, 'rect', { x: X(rx + i * 0.52 - 0.11), y: Y(R.top + 2.9), width: 0.22,
      height: 2.9, fill: '#79838d', stroke: '#a3aeb8', 'stroke-width': 0.06 });
  // nozzles
  for (const z of [G.hotZ, G.coldZ])
    el(this.L.wall, 'rect', { x: X(rx + R.r - 0.5), y: Y(z + 0.45), width: 1.1, height: 0.9,
      fill: '#8b96a0', stroke: '#c2ccd5', 'stroke-width': 0.08 });
  this.rx = rx;

  // ---- steam generator ----------------------------------------------------
  const S = G.sg, sx = cx + S.dx;
  const sd = `M${X(sx - S.rl)},${Y(S.base + S.rl)} A${S.rl},${S.rl} 0 0 0 ${X(sx + S.rl)},${Y(S.base + S.rl)}
    L${X(sx + S.rl)},${Y(S.yCone)} L${X(sx + S.ru)},${Y(S.yUp)} L${X(sx + S.ru)},${Y(S.yTop)}
    A${S.ru},${S.ru} 0 0 0 ${X(sx - S.ru)},${Y(S.yTop)} L${X(sx - S.ru)},${Y(S.yUp)}
    L${X(sx - S.rl)},${Y(S.yCone)} Z`;
  this.vessel(this.L.shell, this.L.wall, 'cG' + this.key, sd);
  this.liquid('cG' + this.key, X(sx - S.ru), S.ru * 2, 'sg');
  const sgi = el(this.L.intern, 'g', { 'clip-path': `url(#cG${this.key})` });
  this.r.tubes = [];
  for (let i = 1; i <= 5; i++) {
    const o = i * 0.28;
    this.r.tubes.push(el(sgi, 'path', {
      d: `M${X(sx - o)},${Y(S.base + 1.4)} L${X(sx - o)},${Y(S.yCone - 0.8)}
          A${o},${o * 0.8} 0 0 1 ${X(sx + o)},${Y(S.yCone - 0.8)} L${X(sx + o)},${Y(S.base + 1.4)}`,
      fill: 'none', stroke: '#e07a3c', 'stroke-width': 0.14 }));
  }
  el(sgi, 'rect', { x: X(sx - S.ru + 0.5), y: Y(S.yTop - 1.2), width: S.ru * 2 - 1, height: 1.6,
    fill: 'none', stroke: 'rgba(190,205,218,.42)', 'stroke-width': 0.14 });
  el(sgi, 'path', { d: `M${X(sx)},${Y(S.base + 0.4)} L${X(sx)},${Y(S.yCone - 1.6)}`,
    stroke: 'rgba(190,205,218,.4)', 'stroke-width': 0.16 });   // divider plate
  this.sx = sx;

  // ---- pressuriser --------------------------------------------------------
  const Z = G.przr, zx = cx + Z.dx;
  const zd = `M${X(zx - Z.r)},${Y(Z.base + Z.r)} A${Z.r},${Z.r} 0 0 0 ${X(zx + Z.r)},${Y(Z.base + Z.r)}
    L${X(zx + Z.r)},${Y(Z.base + Z.r + Z.h)} A${Z.r},${Z.r} 0 0 0 ${X(zx - Z.r)},${Y(Z.base + Z.r + Z.h)} Z`;
  this.vessel(this.L.shell, this.L.wall, 'cP' + this.key, zd);
  this.liquid('cP' + this.key, X(zx - Z.r), Z.r * 2, 'przr');
  this.zx = zx; this.przrTop = Z.base + Z.r + Z.h + Z.r;
};

// ---------------------------------------------------------------------------
// the primary loop, the power cycle, and the floor everyone stands on
// ---------------------------------------------------------------------------
Section.prototype.buildLoop = function () {
  const G = this.G, R = G.rpv, S = G.sg, Z = G.przr, cx = G.cx;
  const rx = this.rx, sx = this.sx, zx = this.zx, X = m => this.x(m);
  const chan = S.base + S.rl;                 // steam generator channel head

  if (this.passive) {
    // AP1000: the reactor coolant pumps are canned-motor units bolted straight
    // to the bottom of the steam generator channel head - two per generator.
    // There is no crossover leg, no pump seal, and nothing for a seal LOCA to
    // happen to. That arrangement IS the design's signature.
    this.pipe([[rx + R.r - 0.2, G.hotZ], [sx - S.rl - 1.4, G.hotZ],
      [sx - S.rl - 1.4, chan], [sx - S.rl + 0.3, chan]], G.hotD, 'hot');
    this.pumpX = sx - 1.35;
    this.pump(sx - 1.35, S.base - 0.9, 'rcp');
    this.pump(sx + 1.35, S.base - 0.9, 'rcp2');
    this.pipe([[sx - 1.35, S.base - 2.1], [sx - 1.35, G.coldZ - 2.4],
      [rx + R.r + 3.2, G.coldZ - 2.4], [rx + R.r + 3.2, G.coldZ],
      [rx + R.r - 0.2, G.coldZ]], G.coldD, 'cold');
    this.pipe([[sx + 1.35, S.base - 2.1], [sx + 1.35, G.coldZ - 4.0],
      [rx + R.r + 1.6, G.coldZ - 4.0]], G.coldD, 'cold2');
  } else {
    // Westinghouse loop: hot leg to the inlet plenum, then a crossover leg that
    // dips below the top of the fuel - the loop seal - into the pump suction,
    // then the cold leg back to the vessel. The dip is not decoration: it is
    // why small-break behaviour in these plants is what it is.
    this.pipe([[rx + R.r - 0.2, G.hotZ], [sx - S.rl - 1.2, G.hotZ],
      [sx - S.rl - 1.2, chan], [sx - S.rl + 0.3, chan]], G.hotD, 'hot');
    this.pumpX = cx + 10.2;
    const seal = G.core.z1 - 2.6;             // below the top of the active fuel
    this.pipe([[sx + S.rl - 0.3, chan], [sx + S.rl + 1.4, chan],
      [sx + S.rl + 1.4, seal], [this.pumpX, seal], [this.pumpX, 7.6]],
      G.xoverD, 'xover');
    this.pump(this.pumpX, 8.9, 'rcp');
    this.pipe([[this.pumpX, 10.2], [this.pumpX, G.coldZ],
      [rx + R.r - 0.2, G.coldZ]], G.coldD, 'cold');
  }
  // the surge line has to land on a hot leg, which is where the pressuriser
  // actually hangs
  this.pipe([[zx, Z.base + 0.5], [zx, G.hotZ]], 0.42, 'surge');

  // nozzles on the vessel belt
  for (const z of [G.hotZ, G.coldZ])
    el(this.L.wall, 'rect', { x: X(rx + R.r - 0.5), y: Y(z + 0.5), width: 1.1, height: 1.0,
      fill: '#8b96a0', stroke: '#c2ccd5', 'stroke-width': 0.08 });
  // Direct vessel injection. Everything that puts water back into the core -
  // accumulators, makeup tanks, the pool - arrives at this one nozzle, into the
  // downcomer above the fuel. Drawing it as one address is the honest shape.
  this.dvi = { z: G.core.z1 + 1.6, x: rx - R.r };
  el(this.L.wall, 'rect', { x: X(rx - R.r - 0.6), y: Y(this.dvi.z + 0.42), width: 1.1,
    height: 0.84, fill: '#8b96a0', stroke: '#c2ccd5', 'stroke-width': 0.08 });

  // power cycle: steam out, feedwater back. The same on both plants, because
  // the difference between the designs is not here.
  this._into = 'ext';
  this.pipe([[sx, S.yTop + 0.2], [sx, S.yTop + 2.6], [cx + G.rin + 3.4, S.yTop + 2.6]],
    0.85, 'steam');
  this.pipe([[cx + G.rin + 3.4, S.yCone + 4.2], [sx + S.ru + 1.5, S.yCone + 4.2],
    [sx + S.ru + 1.5, S.yCone + 1.4], [sx + S.ru - 0.3, S.yCone + 1.4]], 0.7, 'feed');
  this.offPage(cx + G.rin + 3.6, S.yTop + 2.6, 'to turbine', 'steamFlag');
  this.offPage(cx + G.rin + 3.6, S.yCone + 4.2, 'condensate', 'feedFlag');
  this._into = null;

  // operating deck, cut open around the reactor cavity
  el(this.L.front, 'path', {
    d: `M${X(cx - G.rin)},${Y(G.deck)} L${X(rx - R.r - 2.2)},${Y(G.deck)}
        M${X(rx + R.r + 2.2)},${Y(G.deck)} L${X(cx + G.rin)},${Y(G.deck)}`,
    stroke: '#75716a', 'stroke-width': 0.85 });
  el(this.L.front, 'path', { d: `M${X(cx - G.rin + 1)},${Y(G.crane)} L${X(cx + G.rin - 1)},${Y(G.crane)}`,
    stroke: '#5b646d', 'stroke-width': 0.5 });
  el(this.L.front, 'path', { d: `M${X(cx - 4)},${Y(G.crane)} L${X(cx - 4)},${Y(G.crane - 1.6)}
    L${X(cx + 4)},${Y(G.crane - 1.6)} L${X(cx + 4)},${Y(G.crane)}`, fill: 'none',
    stroke: '#5b646d', 'stroke-width': 0.36 });
  for (const px of [cx - 7.4, cx + 14.2]) this.human(px, G.deck + 0.45);
  el(this.L.anno, 'text', { x: X(cx + 14.2), y: Y(G.deck + 2.9), class: 'cutDim',
    'text-anchor': 'middle' }, '1.8 m');
  // The single most-documented way a reader misreads a section like this is to
  // believe the plant has one of everything. Say the count on the drawing.
  el(this.L.anno, 'text', { x: X(cx), y: Y(G.spring + 1.5), class: 'cutDim',
    'text-anchor': 'middle' }, `1 of ${G.loops} coolant loops shown`);
};

Section.prototype.buildPower = function () {
  const G = this.G, cx = G.cx, X = m => this.x(m);
  const bus = G.floor - 3.0;
  this.r.cables = [];
  const feedPoints = this.passive ? [[this.pumpX, G.sg.base - 0.9]]
    : [[this.pumpX, 8.9], [cx - G.rin - 6.5, 6.4]];
  for (const [px, pz] of feedPoints) {
    const d = `M${X(cx - G.rin - 9)},${Y(bus)} L${X(px)},${Y(bus)} L${X(px)},${Y(pz - 1.6)}`;
    el(this.L.ext, 'path', { d, fill: 'none', stroke: '#2b3138', 'stroke-width': 0.5,
      'stroke-linejoin': 'round' });
    this.r.cables.push(el(this.L.ext, 'path', { d, fill: 'none', stroke: C.power,
      'stroke-width': 0.26, 'stroke-linejoin': 'round', 'stroke-dasharray': '1.1 2.4',
      'stroke-dashoffset': 0 }));
  }
  this.r.busFlag = el(this.L.ext, 'g', {});
  el(this.r.busFlag, 'rect', { x: X(cx - G.rin - 15.6), y: Y(bus) - 1.5, width: 7.2,
    height: 3.0, rx: 0.6, fill: 'rgba(18,26,34,.94)', stroke: C.power, 'stroke-width': 0.14 });
  this.r.busTx = el(this.r.busFlag, 'text', { x: X(cx - G.rin - 12.0), y: Y(bus) + 0.6,
    class: 'cutFlag', 'text-anchor': 'middle' }, 'grid');
  el(this.L.ext, 'path', { d: `M${X(cx - G.rin - 8.4)},${Y(bus)} L${X(cx - G.rin - 9)},${Y(bus)}`,
    stroke: '#2b3138', 'stroke-width': 0.5 });
};
Section.prototype.updatePower = function (t) {
  const s = this.p.sys || {};
  const live = !!(s.grid || s.diesel);
  const src = s.grid ? 'grid' : s.diesel ? 'diesels' : s.battery > 0 ? 'batteries only' : 'NO POWER';
  const col = s.grid ? C.power : s.diesel ? C.power : s.battery > 0 ? C.warn : C.bad;
  for (const c of this.r.cables) {
    c.setAttribute('stroke', live ? C.power : '#39404a');
    c.setAttribute('stroke-dashoffset', live ? (-t * 6) % 3.5 : 0);
    c.setAttribute('opacity', live ? 1 : 0.5);
  }
  this.r.busTx.textContent = src;
  this.r.busTx.setAttribute('fill', col);
  this.r.busFlag.querySelector('rect').setAttribute('stroke', col);
};

Section.prototype.human = function (x, b) {
  const X = this.x(x);
  el(this.L.front, 'circle', { cx: X, cy: Y(b + 1.63), r: 0.17, fill: '#f0f6fa' });
  el(this.L.front, 'path', {
    d: `M${X},${Y(b + 1.46)} L${X},${Y(b + 0.78)} M${X},${Y(b + 0.78)} L${X - 0.22},${Y(b)}
        M${X},${Y(b + 0.78)} L${X + 0.22},${Y(b)} M${X - 0.3},${Y(b + 1.26)} L${X + 0.3},${Y(b + 1.26)}`,
    stroke: '#f0f6fa', 'stroke-width': 0.13, fill: 'none', 'stroke-linecap': 'round' });
};
Section.prototype.offPage = function (x, y, text, name) {
  const X = this.x(x), w = text.length * 0.78 + 1.8, h = 2.1;
  const g = el(this.L.ext, 'g', {});
  el(g, 'path', { d: `M${X},${Y(y) - h / 2} L${X + w - 0.9},${Y(y) - h / 2}
    L${X + w},${Y(y)} L${X + w - 0.9},${Y(y) + h / 2} L${X},${Y(y) + h / 2} Z`,
    fill: 'rgba(18,26,34,.94)', stroke: 'rgba(150,190,215,.45)', 'stroke-width': 0.12 });
  const t = el(g, 'text', { x: X + 0.7, y: Y(y) + 0.5, class: 'cutFlag' }, text);
  this.r[name] = t;
};

// ---------------------------------------------------------------------------
// what the two designs do NOT share - the whole comparison
// ---------------------------------------------------------------------------
Section.prototype.buildKit = function () {
  const G = this.G, cx = G.cx, X = m => this.x(m), rx = this.rx, R = G.rpv, S = G.sg, Z = G.przr;
  // accumulators: passive kit a Gen-II plant already has, good for about a
  // minute. Both plants carry them.
  this.r.accum = [];
  const nAcc = this.passive ? 2 : 1;
  for (let i = 0; i < nAcc; i++) {
    const ax = cx + 8.2 + i * 3.6, ar = this.passive ? 1.6 : 1.35, ab = 4.4,
      ah = this.passive ? 5.6 : 5.2;
    const d = `M${X(ax - ar)},${Y(ab + ar)} A${ar},${ar} 0 0 0 ${X(ax + ar)},${Y(ab + ar)}
      L${X(ax + ar)},${Y(ab + ar + ah)} A${ar},${ar} 0 0 0 ${X(ax - ar)},${Y(ab + ar + ah)} Z`;
    this.vessel(this.L.shell, this.L.wall, `cA${i}${this.key}`, d);
    this.liquid(`cA${i}${this.key}`, X(ax - ar), ar * 2, 'acc' + i);
    this.r.accum.push({ base: ab, top: ab + ar * 2 + ah });
    // into the vessel, not the cold leg: every passive source arrives at the
    // same direct-injection nozzle
    this.pipe([[ax, ab], [ax, this.dvi.z - 3.4], [this.dvi.x - 4.2, this.dvi.z - 3.4],
      [this.dvi.x - 4.2, this.dvi.z], [this.dvi.x - 0.2, this.dvi.z]], 0.5, 'accP' + i);
  }
  this.accTop = 4.4 + (this.passive ? 1.6 : 1.35) * 2 + (this.passive ? 5.6 : 5.2);

  if (!this.passive) {
    // ---- Gen-II: everything that matters needs a running pump -------------
    this._into = 'ext';
    this.pipe([[cx - G.rin - 6.5, 6.4], [rx - R.r - 3.4, 6.4],
      [rx - R.r - 3.4, R.base + 1.4], [rx - R.r + 0.2, R.base + 1.4]], 0.62, 'eccs');
    this.pump(cx - G.rin - 6.5, 6.4, 'eccsPump');
    this.valve(cx - G.rin - 2.6, 6.4, 'eccsValve');
    // containment sprays, on the same bus
    this._into = null;
    this.r.sprayHdr = el(this.L.pipe, 'path', {
      d: `M${X(cx - 15)},${Y(27.5)} L${X(cx + 15)},${Y(27.5)}`,
      stroke: '#48525b', 'stroke-width': 0.3 });
    this.r.sprays = [];
    for (let i = 0; i < 11; i++) {
      const ux = cx - 14 + i * 2.8;
      this.r.sprays.push(el(this.L.pipe, 'path', {
        d: `M${X(ux)},${Y(27.5)} L${X(ux)},${Y(26.2)}`,
        stroke: 'rgba(120,190,238,.75)', 'stroke-width': 0.22, opacity: 0.25 }));
    }
    // Containment purge path. A large dry PWR has a purge line; the hardened
    // severe-accident vent of NRC Order EA-13-109 is a BWR Mark I/II fitting
    // and does not belong on this plant.
    this._into = 'ext';
    this.pipe([[cx - G.rin + 1.5, 25], [cx - G.rin - 4.5, 25], [cx - G.rin - 4.5, 36]],
      0.5, 'vent');
    this.valve(cx - G.rin - 1.6, 25, 'ventValve');
    this._into = null;
  } else {
    // ---- AP1000: water above the core, and no pump in any of it -----------
    // IRWST: 2,000 t sitting on the operating deck, above the loops
    const i0 = cx - 18.4, i1 = cx - 11.2, ib = 18.4, it = 26.4;
    const idp = `M${X(i0)},${Y(ib)} L${X(i0)},${Y(it)} L${X(i1)},${Y(it)} L${X(i1)},${Y(ib)} Z`;
    el(this.L.shell, 'path', { d: idp, fill: C.dark });
    const cp = el(this.defs, 'clipPath', { id: 'cI' + this.key }); el(cp, 'path', { d: idp });
    el(this.L.wall, 'path', { d: `M${X(i0)},${Y(it)} L${X(i0)},${Y(ib)} L${X(i1)},${Y(ib)} L${X(i1)},${Y(it)}`,
      fill: 'none', stroke: C.steel, 'stroke-width': 0.34 });
    this.liquid('cI' + this.key, X(i0), i1 - i0, 'irwst');
    this.irw = { x0: i0, x1: i1, base: ib, top: it };
    // PRHR: a C-tube bundle standing in that pool, on a thermosiphon. No pump.
    const hx = i0 + 3.6;
    this.r.prhr = el(this.L.intern, 'path', {
      d: (() => { let p = `M${X(hx)},${Y(ib + 0.8)}`;
        for (let i = 0; i < 11; i++)
          p += ` L${X(hx + (i % 2 ? 2.2 : -2.2))},${Y(ib + 1.2 + i * 0.62)}`;
        return p; })(),
      fill: 'none', stroke: '#5d666f', 'stroke-width': 0.62, 'stroke-linejoin': 'round' });
    this.pipe([[cx - 4.6, G.hotZ], [cx - 4.6, 27.6], [hx, 27.6], [hx, ib + 8.2]], 0.5, 'prhrIn');
    this.pipe([[hx, ib + 0.5], [hx, 15.0], [this.sx - S.rl - 1.2, 15.0],
      [this.sx - S.rl - 1.2, S.base + 1.4]], 0.5, 'prhrOut');
    // core makeup tanks: full system pressure, driven by gravity and a balance line
    this.r.cmt = [];
    for (let i = 0; i < 2; i++) {
      const ax = cx - 8.6 + i * 3.4, ar = 1.6, ah = 7.6, ab = 19.4;
      const d = `M${X(ax - ar)},${Y(ab + ar)} A${ar},${ar} 0 0 0 ${X(ax + ar)},${Y(ab + ar)}
        L${X(ax + ar)},${Y(ab + ar + ah)} A${ar},${ar} 0 0 0 ${X(ax - ar)},${Y(ab + ar + ah)} Z`;
      this.vessel(this.L.shell, this.L.wall, `cC${i}${this.key}`, d);
      this.liquid(`cC${i}${this.key}`, X(ax - ar), ar * 2, 'cmt' + i);
      this.pipe([[ax, ab], [ax, this.dvi.z + 2.6], [this.dvi.x - 4.2, this.dvi.z + 2.6],
        [this.dvi.x - 4.2, this.dvi.z], [this.dvi.x - 0.2, this.dvi.z]], 0.5, 'cmtP' + i);
      // Pressure balance line from a cold leg into the top of the tank. This is
      // what holds it at system pressure, and therefore what makes it drain the
      // moment the loop loses inventory - without it the tank is an
      // unexplained box.
      this.pipe([[ax, ab + ar * 2 + ah], [ax, ab + ar * 2 + ah + 1.6],
        [rx + R.r + 2.2, ab + ar * 2 + ah + 1.6], [rx + R.r + 2.2, G.coldZ]],
        0.32, 'cmtBal' + i);
      this.r.cmt.push({ base: ab, top: ab + ar * 2 + ah });
    }
    this.cmtTop = 19.4 + 1.6 * 2 + 7.6;
    // automatic depressurisation, venting the pressuriser into the pool
    this.valve(Z.dx + cx - 2.2, this.przrTop + 1.2, 'ads');
    this.pipe([[Z.dx + cx, this.przrTop], [Z.dx + cx, this.przrTop + 1.2],
      [i1 - 1.5, this.przrTop + 1.2], [i1 - 1.5, it - 0.6]], 0.5, 'adsP');
    // gravity injection, straight down into the vessel
    this.pipe([[i0 + 1.4, ib], [i0 + 1.4, this.dvi.z], [this.dvi.x - 0.2, this.dvi.z]],
      0.62, 'grav');
    this.valve(i0 + 1.4, 15.4, 'gravValve');
    // PCCS tank, nested in the top of the shield building
    const t0 = cx - 7, t1 = cx + 7, tb = G.spring + G.domeRy + 0.8, tt = tb + 3.4;
    const tdp = `M${X(t0)},${Y(tb)} L${X(t0)},${Y(tt)} L${X(t1)},${Y(tt)} L${X(t1)},${Y(tb)} Z`;
    el(this.L.shell, 'path', { d: tdp, fill: C.dark });
    const tcp = el(this.defs, 'clipPath', { id: 'cT' + this.key }); el(tcp, 'path', { d: tdp });
    el(this.L.wall, 'path', { d: tdp, fill: 'none', stroke: C.steel, 'stroke-width': 0.3 });
    this.liquid('cT' + this.key, X(t0), t1 - t0, 'pccs');
    this.pccs = { base: tb, top: tt };
    for (const [qx, qy] of [[i0 + 4.6, ib + 4.2], [cx - 6.4, this.cmtTop - 3],
      [cx + 8.2, this.accTop - 3], [i0 + 1.4, 12.0]]) {
      const QX = X(qx), QY = Y(qy), r2 = 1.5;
      el(this.r.sabotage, 'path', {
        d: `M${QX - r2},${QY - r2} L${QX + r2},${QY + r2} M${QX + r2},${QY - r2} L${QX - r2},${QY + r2}`,
        stroke: C.bad, 'stroke-width': 0.5, 'stroke-linecap': 'round' });
    }
    // the evaporating film running down the outside of the steel shell
    this.r.film = [];
    for (let i = 0; i < 10; i++)
      this.r.film.push(el(this.L.front, 'path', { d: '', stroke: '#9edcff',
        'stroke-width': 0.34, 'stroke-linecap': 'round', opacity: 0 }));
    // the air draught climbing the annulus
    this.r.draught = [];
    for (let i = 0; i < 8; i++)
      this.r.draught.push(el(this.L.front, 'path', { d: '', fill: C.air, opacity: 0 }));
  }
  // the recirculation sump, and the floodup across the floor after a leak
  const s0 = cx - G.rin + 0.3, s1 = cx + G.rin - 0.3;
  const sdp = `M${X(s0)},${Y(G.floor)} L${X(s0)},${Y(G.floor + 3.6)} L${X(s1)},${Y(G.floor + 3.6)} L${X(s1)},${Y(G.floor)} Z`;
  const scp = el(this.defs, 'clipPath', { id: 'cS' + this.key }); el(scp, 'path', { d: sdp });
  this.liquid('cS' + this.key, X(s0), s1 - s0, 'sump');
};

// ---------------------------------------------------------------------------
// annotation. Direct labels into a gutter on the section's outer side, so that
// with two sections up the captions sit on the outside edges and never fight.
// ---------------------------------------------------------------------------
Section.prototype.buildAnno = function () {
  const G = this.G, cx = G.cx, R = G.rpv, S = G.sg, Z = G.przr;
  this.L.labels = el(this.L.anno, 'g', {});
  const saveAnno = this.L.anno; this.L.anno = this.L.labels;
  const gxL = cx - G.rin - 5.5, gxR = cx + G.rin + 16.5;
  const rows = [];
  const add = (ax, ay, text, home) => rows.push({ ax, ay, text, home: home == null ? ax : home });

  add(this.rx - R.r, G.core.z1 + 2.2, 'reactor vessel');
  add(this.rx, (G.core.z0 + G.core.z1) / 2, 'the fuel');
  add(this.sx - S.ru, S.yTop - 5, 'steam generator', this.sx);
  add(this.zx + (this.passive ? Z.r : -Z.r), this.przrTop - 3, 'pressuriser');
  add(this.pumpX, G.coldZ, this.passive ? 'coolant pumps (not safety)' : 'coolant pumps');
  if (this.passive) {
    add(this.irw.x1, this.irw.top - 1, 'IRWST · 2,000 t');
    add(this.irw.x0 + 3.6, this.irw.base + 4.2, 'PRHR HX · no pump');
    add(cx - 8.6, this.cmtTop - 2, 'core makeup tanks');
    add(cx + 8.2, this.accTop - 2, 'accumulators');
    add(cx, this.pccs.base + 1.7, 'PCCS tank · 3,000 t');
    add(cx + G.rin, 26, 'steel containment vessel');
  } else {
    add(cx + 8.2, this.accTop - 2, 'accumulators');
    add(cx - G.rin - 6.5, 6.4, 'ECCS pumps');
    add(cx - G.rin - 12.0, G.floor - 3.0, 'electrical supply');
    add(cx - 10, 27.5, 'containment sprays');
    add(cx - G.rin - 4.5, 32, 'containment purge');
    add(cx + G.rin, 26, 'concrete containment');
  }
  // Each caption goes to whichever gutter is nearer, so a leader never has to
  // cross the building it is pointing into. Within a gutter they keep the
  // vertical order of their anchors.
  const left = rows.filter(r0 => r0.home < cx).sort((a, b) => b.ay - a.ay);
  const right = rows.filter(r0 => r0.home >= cx).sort((a, b) => b.ay - a.ay);
  const lay = (list, gx, side) => {
    const top = 38, step = Math.min(4.0, (top - 5) / Math.max(1, list.length - 1));
    list.forEach((r0, i) => this.label(r0.ax, r0.ay, gx, top - i * step, r0.text, side));
  };
  lay(left, gxL, 'end');
  lay(right, gxR, 'start');
  this.L.anno = saveAnno;

  // state pills, which appear only when they have something to say
  this.tag(G.rpv.dx + cx, G.rpv.base - 1.9, 'tCore', 'ok');
  this.tag(cx + 6, G.hotZ + 2.6, 'tCirc', 'ok');
  this.tag(this.pumpX - 1.5, G.coldZ + 3.4, 'tPump', 'bad');
  this.tag(cx, 38, 'tCtmt', 'bad');
  this.tag(cx + 2.5, G.floor + 1.2, 'tCorium', 'bad');
  this.tag(cx + 2, 24.5, 'tSafety', 'ok');

  // level scale beside the vessel, the way a control room shows it
  const lx = this.rx - R.r - 2.9, X = this.x(lx);
  el(this.L.anno, 'path', { d: `M${X},${Y(R.base)} L${X},${Y(R.cylTop)}`,
    stroke: C.steelDim, 'stroke-width': 0.12 });
  for (const [z, nm] of [[G.core.z0, 'BAF'], [G.core.z1, 'TAF']]) {
    this.r['m' + nm] = el(this.L.anno, 'path', { d: `M${X - 0.7},${Y(z)} L${X + 0.7},${Y(z)}`,
      stroke: C.dim, 'stroke-width': 0.18 });
    this.r['t' + nm] = el(this.L.anno, 'text', { x: X - 1.1, y: Y(z) + 0.45, class: 'cutDim',
      'text-anchor': 'end' }, nm);
  }
  this.r.lvlMark = el(this.L.anno, 'path', { d: '', fill: C.ok });
  this.r.lvlTxt = el(this.L.anno, 'text', { x: X - 1.1, y: Y(R.cylTop) + 0.5,
    class: 'cutPct', 'text-anchor': 'end' }, '100%');

  // title block
  this.r.title = el(this.L.anno, 'text', { x: this.x(cx), y: Y(62), class: 'cutTitle',
    'text-anchor': 'middle' }, this.passive ? 'PASSIVE · Gen III+' : 'ACTIVE · Gen II');
  this.r.title.setAttribute('fill', this.passive ? '#57d9ff' : '#ff8b5c');
  el(this.L.anno, 'text', { x: this.x(cx), y: Y(59.6), class: 'cutSub', 'text-anchor': 'middle' },
    this.passive ? 'gravity · natural circulation · evaporation' : 'pumps · diesels · operators');
  this.r.stateBg = el(this.L.anno, 'rect', { x: this.x(cx) - 9, y: Y(57.4), width: 18, height: 2.8,
    rx: 0.7, fill: 'rgba(10,40,26,.9)', stroke: C.ok, 'stroke-width': 0.14 });
  this.r.stateTx = el(this.L.anno, 'text', { x: this.x(cx), y: Y(57.4) + 2.0, class: 'cutState',
    'text-anchor': 'middle' }, 'NORMAL');
};

// ---------------------------------------------------------------------------
// the update pass: every number here is read from the model, never invented
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

Section.prototype.update = function (t) {
  const p = this.p, s = p.sys || {}, G = this.G, R = G.rpv, S = G.sg, Z = G.przr, cx = G.cx;
  const lvl = clamp(p.level, 0, 1);
  const surf = R.base + lvl * (R.cylTop - R.base);
  const wet = Math.min(p.Tclad, 660);

  // ---- reactor vessel -----------------------------------------------------
  this.setLevel('rpv', surf, R.base, tempColor(wet));
  const uncovered = surf < G.core.z1;
  const rodCol = !uncovered ? '#cfd9e1' : tempColor(p.Tclad);
  // fuel that has melted is no longer standing there: the bundle slumps
  const slump = clamp(p.meltFrac, 0, 1);
  const rodH = G.core.h * (1 - 0.72 * slump);
  for (const rod of this.r.rods) {
    rod.setAttribute('fill', rodCol);
    rod.setAttribute('y', Y(G.core.z0 + rodH));
    rod.setAttribute('height', rodH);
  }
  this.r.glow.setAttribute('opacity',
    uncovered && p.Tclad > 680 ? clamp((p.Tclad - 680) / 900, 0, 0.85) : 0);
  this.r.corium.setAttribute('opacity', p.vesselBreach ? 0.55 + 0.35 * p.mcci : 0);
  this.r.corium.setAttribute('rx', 3 + 2.6 * p.mcci);
  this.r.breach.setAttribute('opacity', p.vesselBreach ? 1 : 0);
  this.r.crdm.setAttribute('opacity', p.scrammed ? 1 : 0.45);

  // level scale
  const X = this.x(this.rx - R.r - 3.1);
  this.r.lvlMark.setAttribute('d',
    `M${X + 2.4},${Y(surf)} L${X + 0.8},${Y(surf) - 0.9} L${X + 0.8},${Y(surf) + 0.9} Z`);
  this.r.lvlMark.setAttribute('fill', uncovered ? C.bad : lvl > 0.98 ? C.ok : C.warn);
  this.r.lvlTxt.textContent = `${Math.round(lvl * 100)}%`;
  this.r.lvlTxt.setAttribute('y', Y(surf) + 0.5);
  this.r.lvlTxt.setAttribute('fill', uncovered ? C.bad : lvl > 0.98 ? C.ok : C.warn);
  this.r.mTAF.setAttribute('stroke', uncovered ? C.bad : C.dim);
  this.r.tTAF.setAttribute('fill', uncovered ? C.bad : C.dim);

  // ---- steam generator and pressuriser ------------------------------------
  const fed = s.feed || s.aux || s.rcic || s.prhr;
  this.setLevel('sg', fed ? S.yCone + 1.2 : S.base + S.rl + 2.6, S.base + S.rl,
    coolColor(Math.min(560, p.Tcore - 40)));
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  for (const tu of this.r.tubes)
    tu.setAttribute('stroke', flow > 0 ? tempColor(Math.min(645, p.Tcore)) : '#4d565f');
  this.setLevel('przr', Z.base + Z.r + Z.h * clamp(p.level, 0.08, 1), Z.base + Z.r,
    tempColor(Math.min(660, p.Tcore + 20)));

  // ---- flows --------------------------------------------------------------
  const hotC = tempColor(Math.min(680, p.Tcore + 40));
  const coldC = coolColor(Math.min(620, p.Tcore - 60));
  this.setFlow('hot', hotC, flow, t);
  this.setFlow('cold', coldC, flow, t, true);
  if (this.passive) { this.setFlow('cold2', coldC, flow, t, true); this.setPump('rcp2', s.rcp > 0); }
  else this.setFlow('xover', coldC, flow, t, true);
  this.setFlow('surge', hotC, flow ? 0.25 : 0, t);
  this.setFlow('steam', '#b7c6d2', s.feed ? 1 : 0, t);
  this.setFlow('feed', coolColor(480), s.feed ? 1 : 0, t, true);
  this.setPump('rcp', s.rcp > 0);
  this.r.steamFlag.textContent = p.uhs ? 'to turbine' : 'HEAT SINK LOST';
  this.r.steamFlag.setAttribute('fill', p.uhs ? C.text : C.bad);

  for (let i = 0; i < this.r.accum.length; i++) {
    this.setLevel('acc' + i, this.r.accum[i].base + 1.5
      + (this.r.accum[i].top - this.r.accum[i].base - 3) * clamp(p.accumLevel, 0, 1),
      this.r.accum[i].base + 1.5, C.cold);
    this.setFlow('accP' + i, C.cold, s.accum || 0, t);
  }
  const sumpDepth = this.passive
    ? (s.gravity ? 3.4 : s.ads ? 1.6 : 0.35)
    : (p.vesselBreach ? 1.6 : p.leakRate > 0 ? 1.2 : 0.35);
  this.setLevel('sump', G.floor + sumpDepth, G.floor, coolColor(Math.min(430, p.Tctmt)));

  // ---- containment atmosphere --------------------------------------------
  const hz = clamp((p.Tctmt - 320) / 170, 0, 0.42);
  this.r.haze.setAttribute('fill', `rgba(214,228,238,${(hz * 0.34).toFixed(3)})`);
  const h2 = p.h2 + p.h2Building, h2f = clamp(h2 / 900, 0, 1);
  const h2Top = G.spring + G.domeRy, h2Bot = h2Top - h2f * (h2Top - G.floor - 4);
  this.r.h2.setAttribute('height', h2f > 0.01 ? h2Top - h2Bot : 0);
  this.r.h2.setAttribute('fill', `rgba(202,214,66,${(0.05 + 0.17 * h2f).toFixed(3)})`);
  this.r.h2line.setAttribute('opacity', h2f > 0.01 ? 0.85 : 0);
  this.r.h2line.setAttribute('y', Y(h2Bot));

  // ---- design-specific ----------------------------------------------------
  if (this.passive) {
    this.setLevel('irwst', this.irw.base + (this.irw.top - this.irw.base)
      * clamp(p.irwst / 2.1e6, 0.05, 1), this.irw.base, coolColor(Math.min(430, p.Tctmt)));
    this.setLevel('pccs', this.pccs.base + (this.pccs.top - this.pccs.base)
      * clamp(p.pccwst / 3.0e6, 0, 1), this.pccs.base, C.cold);
    for (let i = 0; i < 2; i++) {
      this.setLevel('cmt' + i, this.r.cmt[i].base + 1.5
        + (this.r.cmt[i].top - this.r.cmt[i].base - 3) * clamp(p.cmtLevel, 0, 1),
        this.r.cmt[i].base + 1.5, C.cold);
      this.setFlow('cmtP' + i, C.cold, s.cmt || 0, t);
      // the balance line carries pressure, not a visible flow
      this.setFlow('cmtBal' + i, '#6a7580', 0, t);
    }
    this.setFlow('prhrIn', hotC, s.prhr || 0, t);
    this.setFlow('prhrOut', coolColor(520), s.prhr || 0, t);
    this.setFlow('grav', C.cold, s.gravity || 0, t);
    this.setFlow('adsP', '#c6d3dc', s.ads ? 1 : 0, t);
    this.setValve('ads', !!s.ads, false);
    this.setValve('gravValve', (s.gravity || 0) > 0, false);
    this.r.prhr.setAttribute('stroke', s.prhr > 0 ? hotC : '#5d666f');
    this.r.prhr.setAttribute('stroke-width', s.prhr > 0 ? 0.7 : 0.55);
    // the film on the shell, and the draught in the annulus
    const on = s.pccs > 0, rin = G.rin, sr = rin + 3.4;
    for (let i = 0; i < this.r.film.length; i++) {
      const f = this.r.film[i];
      if (!on || !s.film) { f.setAttribute('opacity', 0); continue; }
      const k = ((t * 0.09 + i / this.r.film.length) % 1);
      let x, y0;
      if (k < 0.42) {                                  // over the crown
        const q = k / 0.42, a = Math.PI * (1 - q);
        x = cx + Math.cos(a) * rin; y0 = G.spring + Math.sin(a) * G.domeRy;
      } else {                                         // down a flank
        const q = (k - 0.42) / 0.58;
        x = cx + (i % 2 ? rin + 0.55 : -rin - 0.55);
        y0 = G.spring - q * (G.spring - G.floor);
      }
      f.setAttribute('d', `M${this.x(x)},${Y(y0)} L${this.x(x)},${Y(y0 - 1.5)}`);
      f.setAttribute('opacity', 0.8);
    }
    for (let i = 0; i < this.r.draught.length; i++) {
      const a = this.r.draught[i];
      if (!on) { a.setAttribute('opacity', 0); continue; }
      const k = ((t * 0.16 + i / this.r.draught.length) % 1);
      const up = i % 2 === 1;
      const x = cx + (up ? sr - 1.7 : -sr + 1.7);
      const y0 = G.floor + k * (G.spring - G.floor);
      const yy = up ? y0 : G.spring - k * (G.spring - G.floor);
      const dir = up ? 1 : -1, X0 = this.x(x);
      a.setAttribute('d', `M${X0},${Y(yy + dir * 0.9)} L${X0 - 0.6},${Y(yy)} L${X0 + 0.6},${Y(yy)} Z`);
      a.setAttribute('fill', up ? '#f0b070' : C.air);
      a.setAttribute('opacity', 0.85);
    }
  } else {
    const inj = s.aux > 0, need = p.scrammed && p.coolingMargin < 1.0;
    this.setFlow('eccs', C.cold, inj ? 1 : 0, t);
    this.setPump('eccsPump', inj);
    this.setValve('eccsValve', inj, need && !inj);
    const spr = s.sprays > 0;
    this.r.sprayHdr.setAttribute('stroke', spr ? '#6d9fc4' : '#48525b');
    for (let i = 0; i < this.r.sprays.length; i++) {
      const d = spr ? 1.2 + ((t * 1.6 + i * 0.27) % 1) * 2.6 : 1.3;
      this.r.sprays[i].setAttribute('d',
        `M${this.x(cx - 14 + i * 2.8)},${Y(27.5)} L${this.x(cx - 14 + i * 2.8)},${Y(27.5 - d)}`);
      this.r.sprays[i].setAttribute('opacity', spr ? 0.8 : 0.22);
    }
    this.setFlow('vent', '#b9c6d0', p.vented ? 1 : 0, t);
    this.setValve('ventValve', !!p.vented, false);
  }

  // ---- the pills ----------------------------------------------------------
  const T = p.Tclad - 273;
  this.setTag('tCore', `core ${T.toFixed(0)} °C`, T > 800 ? 'bad' : T > 360 ? 'warn' : 'ok');
  this.setTag('tCirc', flow > 0 && !s.rcp ? 'natural circulation' : '', 'ok');
  // "not needed" is only true while the passive plant is actually coping; once
  // it is not, the caption must stop reassuring the reader
  const coping = this.passive && p.coolingMargin >= 0.99 && p.coreDamage < 0.01;
  this.setTag('tPump', s.rcp ? '' : (coping ? 'pumps off — not needed' : 'PUMPS STOPPED'),
    coping ? 'ok' : 'bad');
  this.setTag('tCorium', p.vesselBreach ? 'corium on the basemat' : '', 'bad');
  this.setTag('tCtmt', p.explosions > 0 || p.rupturedByPower ? 'CONTAINMENT BLOWN OPEN'
    : !p.ctmtIntact ? 'CONTAINMENT FAILED' : (h2 > 60 ? `hydrogen ${h2 | 0} kg` : ''), 'bad');
  const safetyTxt = this.passive
    ? (s.gravity ? 'GRAVITY INJECTION' : s.prhr ? 'PRHR thermosiphon'
      : s.cmt ? 'core makeup tanks' : '')
    : (s.aux ? 'ECCS injecting'
      : (p.scrammed && p.coolingMargin < 1 ? 'NO COOLING PATH LEFT' : ''));
  this.setTag('tSafety', safetyTxt, this.passive || s.aux ? 'ok' : 'bad');

  // ---- title block --------------------------------------------------------
  const good = /SAFE|NORMAL|STABLE/.test(p.state);
  if (this.r.stateTx.textContent !== p.state) {
    this.r.stateTx.textContent = p.state;
    const w = Math.max(14, p.state.length * 1.02 + 3);
    this.r.stateBg.setAttribute('x', this.x(cx) - w / 2);
    this.r.stateBg.setAttribute('width', w);
  }
  this.r.stateBg.setAttribute('stroke', good ? C.ok : C.bad);
  this.r.stateBg.setAttribute('fill', good ? 'rgba(10,40,26,.9)' : 'rgba(60,14,10,.92)');
  this.r.stateTx.setAttribute('fill', good ? C.ok : '#ff9c88');
  this.r.liner.setAttribute('stroke', p.ctmtIntact ? (this.passive ? '#9fb3c2' : C.liner) : C.bad);
  this.r.blown.setAttribute('opacity', p.explosions > 0 || p.rupturedByPower ? 1 : 0);
  this.r.sabotage.setAttribute('opacity', p.sabotaged ? 1 : 0);
  this.updatePower(t);
  this.updateHead();
  this.layoutTags();
};

// ===========================================================================
// The stage: one SVG holding both sections, fitted by its viewBox.
// There is no camera - the viewBox is the camera, and it is exact.
// ===========================================================================
export class CutStage {
  constructor(svg) {
    this.svg = svg;
    this.focus = 'both';
    this.built = false;
  }
  build(plants) {
    const svg = this.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const defs = el(svg, 'defs', {});
    defs.innerHTML = `
      <linearGradient id="cutConc" x1="0" x2="1">
        <stop offset="0" stop-color="#4b4943"/><stop offset=".42" stop-color="#6b6860"/>
        <stop offset="1" stop-color="#3f3d39"/></linearGradient>
      <linearGradient id="cutSteelB" x1="0" x2="1">
        <stop offset="0" stop-color="#4c545c"/><stop offset=".4" stop-color="#78828c"/>
        <stop offset="1" stop-color="#414951"/></linearGradient>
      <linearGradient id="cutWall" x1="0" x2="1">
        <stop offset="0" stop-color="#6b757f"/><stop offset=".3" stop-color="#a7b2bc"/>
        <stop offset="1" stop-color="#5c656e"/></linearGradient>
      <linearGradient id="cutGlow" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="rgba(255,90,30,0)"/>
        <stop offset="1" stop-color="rgba(255,160,60,.95)"/></linearGradient>`;
    this.sections = plants.map((p) => {
      const sec = new Section(p, 0);
      const g = el(svg, 'g', { class: 'cutSec' });
      sec.build(g, defs);
      sec.buildLoop();
      sec.buildKit();
      sec.buildAnno();
      sec.buildPower();
      sec.buildHead();
      sec.root = g;
      return sec;
    });
    this.built = true;
  }

  // The viewBox is the camera, and SVG can measure its own content, so the fit
  // is exact rather than a pile of guessed constants: hide what this focus does
  // not show, ask for the bounding box, frame that.
  setFocus(focus, showLabels) {
    if (!this.built) return;
    this.focus = focus;
    const both = focus === 'both' || showLabels === false;
    const [a, p] = this.sections;
    a.root.style.display = (focus === 'passive') ? 'none' : '';
    p.root.style.display = (focus === 'active') ? 'none' : '';
    for (const s of this.sections) {
      s.L.labels.style.display = both ? 'none' : '';
      // with two sections up there is no room for what sits outside the
      // building, and the comparison is about what is inside it
      s.L.ext.style.display = both ? 'none' : '';
    }
    // side by side: put the second section one measured width to the right
    p.root.removeAttribute('transform');
    if (both) {
      let w = 0;
      try { w = a.root.getBBox().width; } catch (e) { w = 0; }
      p.root.setAttribute('transform', `translate(${(w || 56) + 5},0)`);
    }
    let b = null;
    try { b = this.svg.getBBox(); } catch (e) { b = null; }
    if (!b || !b.width || !b.height) {
      const G = GEO, half = G.rin + G.wall + 8;
      b = { x: G.cx - half, y: Y(52), width: half * 2, height: 56 };
    }
    const m = Math.max(1.5, b.width * 0.02);
    this.svg.setAttribute('viewBox',
      `${b.x - m} ${b.y - m} ${b.width + m * 2} ${b.height + m * 2}`);
  }

  update(t) {
    if (!this.built) return;
    for (const s of this.sections)
      if (s.root.style.display !== 'none') s.update(t);
  }
}

// ---------------------------------------------------------------------------
// The driving head: the vertical distance from the water that is available to
// fall into the core down to the top of the fuel. Drawn in the same place, at
// the same scale, on both sections.
//
// This is the argument as a quantity rather than as a list of extra equipment.
// Differences that line up against shared structure get noticed; differences
// that are simply an extra object with no counterpart mostly do not (Gentner &
// Markman, Psychological Science 1994). "This plant has a heat exchanger the
// other lacks" is the second kind. "Both have a head-to-fuel distance, and one
// of them is negative" is the first.
// ---------------------------------------------------------------------------
Section.prototype.buildHead = function () {
  const G = this.G, cx = G.cx, X = m => this.x(m);
  const hx = cx + G.rin - 2.6;
  const g = el(this.L.anno, 'g', {});
  this.r.headLine = el(g, 'path', { d: '', stroke: '#7fe0b0', 'stroke-width': 0.16 });
  this.r.headTick = el(g, 'path', { d: '', stroke: '#7fe0b0', 'stroke-width': 0.16 });
  // set alongside the dimension line, the way a drawing does it: it costs no
  // horizontal room, which matters when two sections are up at once
  this.r.headTxt = el(g, 'text', { x: 0, y: 0, class: 'cutHead',
    'text-anchor': 'middle' }, '');
  this.headX = hx;
};
Section.prototype.updateHead = function () {
  const G = this.G, X = m => this.x(m), x = X(this.headX);
  const taf = G.core.z1;
  // the highest water inside the building that can reach the core without a pump
  const top = this.passive
    ? this.irw.base + (this.irw.top - this.irw.base) * clamp(this.p.irwst / 2.1e6, 0, 1)
    : G.floor + 0.35;                   // a Gen-II plant's in-containment water is the sump
  const good = top > taf;
  const y0 = Y(Math.max(top, taf)), y1 = Y(Math.min(top, taf));
  this.r.headLine.setAttribute('d', `M${x},${y0} L${x},${y1}`);
  this.r.headTick.setAttribute('d',
    `M${x - 1.1},${Y(taf)} L${x + 1.1},${Y(taf)} M${x - 1.1},${Y(top)} L${x + 1.1},${Y(top)}`);
  const col = good ? '#7fe0b0' : C.bad;
  this.r.headLine.setAttribute('stroke', col);
  this.r.headTick.setAttribute('stroke', col);
  // read upward from the bottom tick, so a short bar never hangs the caption
  // off the floor
  const tx = x + 1.9, ty = y1 - 0.4;
  this.r.headTxt.setAttribute('x', tx);
  this.r.headTxt.setAttribute('y', ty);
  this.r.headTxt.setAttribute('text-anchor', 'start');
  this.r.headTxt.setAttribute('transform', `rotate(-90 ${tx} ${ty})`);
  this.r.headTxt.setAttribute('fill', col);
  this.r.headTxt.textContent = good
    ? `${(top - taf).toFixed(0)} m of water above the fuel`
    : 'no water above the fuel';
};
