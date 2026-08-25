// ---------------------------------------------------------------------------
// cutaway.js - the circuit, painted on the same canvas as everything else.
//
// This was SVG once. SVG is a fine way to draw a diagram and a bad way to draw
// water: every drop has to be a DOM node, and moving liquid means mutating the
// document sixty times a second. On canvas the water can be what it is - a
// surface with waves on it, slugs of fluid travelling down a pipe, a stream
// falling into a tank and splashing.
//
// Everything here is a pure function of the model and the clock. No random
// numbers in a draw call: variation comes from hashing an index, so a frozen
// frame is a still one.
//
// Vessels are drawn as cylinders: a shaded body, an elliptical cap, and an
// elliptical liquid surface. That single trick - the ellipse - is what makes a
// flat drawing read as a tank with water in it rather than a blue rectangle.
// ---------------------------------------------------------------------------

import { MODE, FUEL_TOP } from './plant.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
// deterministic per-index jitter
const hash = (i) => {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

const C = {
  cold: '#39b6dc', water: '#2f8ed6', hot: '#e8763a',
  steam: '#c3d2dd', power: '#ffd35c',
  ok: '#63e08a', warn: '#ffc44d', bad: '#ff5c48',
  ink: '#e6f0f7', dim: '#93a6b6'
};

// Physically, hotter is whiter. Visually, pale reads as harmless, and a core at
// 2900 C is not, so the ramp stays in the red once the fuel is failing.
const RAMP = [[560, '#d9853a'], [720, '#e59a2e'], [900, '#e8702a'],
  [1100, '#e8481c'], [1500, '#f52d10'], [2200, '#ff3a18'], [3200, '#ff6a33']];
const hx = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export function tempColor(K) {
  if (K <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (K <= RAMP[i][0]) {
      const u = (K - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]);
      const a = hx(RAMP[i - 1][1]), b = hx(RAMP[i][1]);
      return `rgb(${a[0] + (b[0] - a[0]) * u | 0},${a[1] + (b[1] - a[1]) * u | 0},${a[2] + (b[2] - a[2]) * u | 0})`;
    }
  }
  return RAMP[RAMP.length - 1][1];
}
// Water in the loop is blue when it is cool and red when it is not. Real hot
// water is not red; this is the one place the picture chooses legibility over
// literal truth, and the ledger says so.
function waterColor(K) {
  // Normal primary water sits at 620 K and must still read as water, so the
  // shift starts where the plant is actually in trouble. It goes through a pale
  // scalding colour rather than straight from blue to orange: mixing those two
  // in RGB passes through brown, and brown water looks dirty, not hot.
  const u = clamp((K - 660) / 400, 0, 1);
  const mid = hx('#cfe6f2');
  const a = u < 0.5 ? hx('#2f8ed6') : mid;
  const b = u < 0.5 ? mid : hx('#ff6a33');
  const v = u < 0.5 ? u * 2 : (u - 0.5) * 2;
  return `rgb(${lerp(a[0], b[0], v) | 0},${lerp(a[1], b[1], v) | 0},${lerp(a[2], b[2], v) | 0})`;
}
function shade(col, f) {
  let r, g, b;
  if (col[0] === '#') [r, g, b] = hx(col);
  else { const m = col.match(/[\d.]+/g); r = +m[0]; g = +m[1]; b = +m[2]; }
  const k = (v) => clamp(f > 1 ? v + (255 - v) * (f - 1) : v * f, 0, 255) | 0;
  return `rgb(${k(r)},${k(g)},${k(b)})`;
}

// ---------------------------------------------------------------------------
// The layout, in design units. One circuit is W wide; the second sits beside it.
// ---------------------------------------------------------------------------
const W = 840, GAP = 90;
const L = {
  zone: { x: 18, y: 10, w: 802, hull: 938, slab: 46 },
  pool: { x: 70, y: 150, w: 300, h: 160 },
  core: { x: 116, y: 500, w: 208, h: 336 },
  sg: { x: 494, y: 258, w: 212, h: 344 },
  pump: { cx: 630, cy: 770, r: 58 },
  power: { x: 640, y: 1030, w: 180, h: 92 },
  base: { x: 40, y: 1030, w: 300, h: 160 },
  eccs: { cx: 485, cy: 1080, r: 58 },
  flag: { x: 520, y: -70, w: 215, h: 54 }
};
// nozzle heights on the reactor, and where the water goes inside it
const CORE_IN = 0.20, CORE_OUT = 0.10;     // as a fraction of vessel height
const CONTENT = { x: -10, y: -80, w: 870, h: 1340 };

// ---------------------------------------------------------------------------
// drawing primitives
// ---------------------------------------------------------------------------

function capsulePath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + w / 2, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w / 2, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.closePath();
}

// A vertical cylinder, lit from the upper left. The horizontal gradient is the
// whole illusion: dark limb, bright band, dark limb.
function steelGrad(ctx, x, w) {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, '#2c3742');
  g.addColorStop(0.10, '#5d7183');
  g.addColorStop(0.30, '#c2d3de');
  g.addColorStop(0.46, '#93a7b6');
  g.addColorStop(0.78, '#4d5d6b');
  g.addColorStop(1, '#26313b');
  return g;
}

function ellipse(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
}

// Liquid inside a cylindrical cavity: body, then the surface as an ellipse with
// a moving crest. Bubbles rise through it when it is hot.
function liquid(ctx, cav, frac, t, col, opts = {}) {
  const { x, y, w, h } = cav;
  const f = clamp(frac, 0, 1);
  if (f <= 0.001) return null;
  const rx = w / 2, ry = opts.flat ? Math.min(7, w * 0.03) : Math.min(16, w * 0.115);
  const surf = y + h - f * h;
  const cx = x + rx;
  const wob = Math.sin(t * 1.7) * 1.2 + Math.sin(t * 2.9 + 1.3) * 0.7;
  const sy = surf + wob;

  ctx.save();
  // body
  const g = ctx.createLinearGradient(x, sy, x, y + h);
  g.addColorStop(0, shade(col, 1.35));
  g.addColorStop(0.18, shade(col, 1.05));
  g.addColorStop(1, shade(col, 0.6));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x, sy);
  ctx.lineTo(x + w, sy);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
  // a vertical sheen down the lit side of the column
  const sh = ctx.createLinearGradient(x, 0, x + w, 0);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(0.28, 'rgba(255,255,255,.20)');
  sh.addColorStop(0.46, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(0,0,0,.20)');
  ctx.fillStyle = sh;
  ctx.fillRect(x, sy, w, y + h - sy);

  // the surface, seen from a little above
  ellipse(ctx, cx, sy, rx, ry);
  ctx.fillStyle = shade(col, 1.5);
  ctx.fill();
  ellipse(ctx, cx, sy - 1, rx * 0.92, ry * 0.82);
  ctx.fillStyle = shade(col, 1.9);
  ctx.globalAlpha = 0.55 + 0.2 * Math.sin(t * 2.2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // crest highlight, drifting
  ctx.strokeStyle = 'rgba(226,246,255,.75)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i <= 22; i++) {
    const u = i / 22, ax = x + u * w;
    const dy = Math.sin(u * 7 + t * 2.4) * 1.7 + Math.sin(u * 13 - t * 1.6) * 0.9;
    const ey = sy + Math.sin(Math.acos(clamp((ax - cx) / rx, -1, 1))) * ry * 0.35;
    if (i === 0) ctx.moveTo(ax, ey + dy); else ctx.lineTo(ax, ey + dy);
  }
  ctx.stroke();

  // bubbles
  if (opts.boil > 0.02) {
    ctx.fillStyle = 'rgba(232,248,255,.55)';
    const n = Math.round(6 + opts.boil * 14);
    for (let i = 0; i < n; i++) {
      const ph = (t * (0.30 + hash(i) * 0.45) + hash(i + 90)) % 1;
      const by = y + h - 4 - ph * (y + h - sy - 6);
      if (by < sy + 3) continue;
      const bx = x + 8 + hash(i + 30) * (w - 16) + Math.sin(ph * 9 + i) * 3;
      const r = 1.4 + hash(i + 60) * 2.4;
      ctx.globalAlpha = 0.25 + 0.55 * (1 - ph);
      ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  return sy;
}

// ---- pipes ---------------------------------------------------------------
// A pipe is a polyline. It is drawn three times: a dark rim for depth, the
// fluid, and a highlight along the lit side. Then slugs of brighter liquid
// travel along it, which is what makes the water look like it is moving.

function tracePath(ctx, pts, r) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const [px, py] = pts[i - 1];
    const d1 = Math.hypot(x - px, y - py), d2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r * 2.2, d1 / 2, d2 / 2);
    ctx.lineTo(x - (x - px) / d1 * rr, y - (y - py) / d1 * rr);
    ctx.quadraticCurveTo(x, y, x + (nx - x) / d2 * rr, y + (ny - y) / d2 * rr);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function pipe(ctx, pts, r, col, opts = {}) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  tracePath(ctx, pts, r);
  ctx.strokeStyle = '#0a1017'; ctx.lineWidth = r * 2 + 5; ctx.stroke();
  ctx.strokeStyle = shade(col, 0.62); ctx.lineWidth = r * 2; ctx.stroke();
  ctx.strokeStyle = col; ctx.lineWidth = r * 1.5; ctx.stroke();
  ctx.strokeStyle = shade(col, 1.45); ctx.lineWidth = r * 0.55;
  ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
  ctx.restore();
}

function measure(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
}
function at(pts, cum, d) {
  const total = cum[cum.length - 1];
  d = ((d % total) + total) % total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const u = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
  const x = lerp(pts[i - 1][0], pts[i][0], u), y = lerp(pts[i - 1][1], pts[i][1], u);
  const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
  const len = Math.hypot(dx, dy) || 1;
  return { x, y, tx: dx / len, ty: dy / len };
}

// slugs of brighter fluid running along the pipe
function flow(ctx, pts, r, t, speed, col) {
  const cum = measure(pts), total = cum[cum.length - 1];
  const spacing = 46, n = Math.max(1, Math.floor(total / spacing));
  const off = t * speed * 46;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    // A slug that straddles the end of the pipe would be drawn from the outlet
    // back to the inlet - one long diagonal across the whole picture.
    const d = (((off + i * spacing) % total) + total) % total;
    if (d + 15 > total) continue;
    const a = at(pts, cum, d), b = at(pts, cum, d + 15);
    const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.45, shade(col, 1.75));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = g; ctx.lineWidth = r * 1.15;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

// water falling from one place to another, with a splash where it lands
function pour(ctx, x, y0, y1, w, t, col, into) {
  if (y1 <= y0 + 2) return;
  ctx.save();
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, shade(col, 1.3));
  g.addColorStop(0.4, col);
  g.addColorStop(1, shade(col, 0.75));
  ctx.fillStyle = g;
  ctx.beginPath();
  const steps = 22;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps, yy = lerp(y0, y1, u);
    const wob = Math.sin(u * 9 - t * 9) * 1.6 * u;
    ctx.lineTo(x - w / 2 * (1 - u * 0.15) + wob, yy);
  }
  for (let i = steps; i >= 0; i--) {
    const u = i / steps, yy = lerp(y0, y1, u);
    const wob = Math.sin(u * 9 - t * 9 + 0.6) * 1.6 * u;
    ctx.lineTo(x + w / 2 * (1 - u * 0.15) + wob, yy);
  }
  ctx.closePath(); ctx.fill();
  // droplets riding the stream
  ctx.fillStyle = shade(col, 1.7);
  for (let i = 0; i < 7; i++) {
    const ph = (t * 1.5 + hash(i) * 3) % 1;
    const yy = lerp(y0, y1, ph);
    ctx.globalAlpha = 0.5 * (1 - ph * 0.4);
    ctx.beginPath();
    ctx.ellipse(x + (hash(i + 5) - 0.5) * w * 0.5, yy, w * 0.16, w * 0.3, 0, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (into) {
    // splash: a couple of ellipses opening out where it hits
    for (let i = 0; i < 3; i++) {
      const ph = ((t * 1.9 + i / 3) % 1);
      ctx.globalAlpha = 0.35 * (1 - ph);
      ctx.strokeStyle = shade(col, 1.8); ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(x, y1, w * (0.5 + ph * 2.4), w * (0.18 + ph * 0.7), 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ---- machinery -----------------------------------------------------------

function shadowUnder(ctx, cx, cy, rx) {
  ctx.save();
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
  g.addColorStop(0, 'rgba(0,0,0,.5)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ellipse(ctx, cx, cy, rx, rx * 0.24); ctx.fill();
  ctx.restore();
}

// A pressure vessel: capsule shell, domed cap, dark cavity, support skirt.
function vesselShell(ctx, b, tone) {
  const { x, y, w, h } = b, r = w * 0.42;
  shadowUnder(ctx, x + w / 2, y + h + 10, w * 0.62);
  // skirt
  ctx.fillStyle = '#333f4a'; ctx.strokeStyle = '#1d262e'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.28, y + h - 14); ctx.lineTo(x + w * 0.20, y + h + 26);
  ctx.lineTo(x + w * 0.80, y + h + 26); ctx.lineTo(x + w * 0.72, y + h - 14);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  capsulePath(ctx, x, y, w, h, r);
  ctx.fillStyle = steelGrad(ctx, x, w); ctx.fill();
  ctx.strokeStyle = tone || '#1b242c'; ctx.lineWidth = 2.5; ctx.stroke();
  // the cap, so the top reads as a dome and not a semicircle
  ctx.save();
  capsulePath(ctx, x, y, w, h, r); ctx.clip();
  ellipse(ctx, x + w / 2, y + r * 0.5, w * 0.42, w * 0.16);
  ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
}

function cavityOf(b, wall) {
  return { x: b.x + wall, y: b.y + wall, w: b.w - wall * 2, h: b.h - wall * 2 };
}

function clipCavity(ctx, cav) {
  capsulePath(ctx, cav.x, cav.y, cav.w, cav.h, cav.w * 0.42);
  ctx.clip();
}

function cavityFill(ctx, cav) {
  capsulePath(ctx, cav.x, cav.y, cav.w, cav.h, cav.w * 0.42);
  const g = ctx.createLinearGradient(cav.x, cav.y, cav.x + cav.w, cav.y + cav.h);
  g.addColorStop(0, '#0a141d'); g.addColorStop(1, '#16242f');
  ctx.fillStyle = g; ctx.fill();
}

// A centrifugal pump: volute, nozzles, an impeller that turns while it runs.
function pumpBody(ctx, p, spin, live, tone) {
  const { cx, cy, r } = p;
  shadowUnder(ctx, cx, cy + r + 26, r * 1.25);
  // base
  ctx.fillStyle = '#333f4a'; ctx.strokeStyle = '#1d262e'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.55, cy + r * 0.55); ctx.lineTo(cx - r * 0.8, cy + r + 22);
  ctx.lineTo(cx + r * 0.8, cy + r + 22); ctx.lineTo(cx + r * 0.55, cy + r * 0.55);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // volute
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#c3d3de'); g.addColorStop(0.45, '#67798a'); g.addColorStop(1, '#2f3b46');
  ellipse(ctx, cx, cy, r, r); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = tone || '#1b242c'; ctx.lineWidth = 2.5; ctx.stroke();
  ellipse(ctx, cx, cy, r * 0.78, r * 0.78);
  ctx.fillStyle = '#0b141c'; ctx.fill();
  // impeller
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(spin);
  ctx.fillStyle = live ? '#63b7ea' : '#44525f';
  for (let i = 0; i < 3; i++) {
    ctx.rotate(TAU / 3);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.12);
    ctx.quadraticCurveTo(r * 0.42, -r * 0.55, r * 0.66, -r * 0.16);
    ctx.quadraticCurveTo(r * 0.40, -r * 0.02, 0, r * 0.16);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ellipse(ctx, cx, cy, r * 0.19, r * 0.19);
  ctx.fillStyle = '#93a7b6'; ctx.fill();
  ctx.strokeStyle = '#1b242c'; ctx.lineWidth = 1.5; ctx.stroke();
  // gloss
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.88, Math.PI * 1.12, Math.PI * 1.72);
  ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 3; ctx.stroke();
}

// An open basin of water.
function basin(ctx, b, tone) {
  shadowUnder(ctx, b.x + b.w / 2, b.y + b.h - 14, b.w * 0.5);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x, b.y + b.h - 22);
  ctx.quadraticCurveTo(b.x, b.y + b.h - 6, b.x + 16, b.y + b.h - 6);
  ctx.lineTo(b.x + b.w - 16, b.y + b.h - 6);
  ctx.quadraticCurveTo(b.x + b.w, b.y + b.h - 6, b.x + b.w, b.y + b.h - 22);
  ctx.lineTo(b.x + b.w, b.y);
  ctx.strokeStyle = tone || '#48596a'; ctx.lineWidth = 13; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.20)'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(b.x + 5, b.y); ctx.lineTo(b.x + 5, b.y + b.h - 24);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// text, with a guarantee it fits
// ---------------------------------------------------------------------------
// Captions that had to be shrunk past legibility to fit their box. The harness
// reads this rather than trying to measure canvas text from outside.
const SHRUNK = [];
export function overflowReport() { return SHRUNK.slice(); }

function label(ctx, text, x, y, opts = {}) {
  const px = opts.px || 15, weight = opts.weight || 700, maxW = opts.maxW || 1e9;
  let size = px;
  ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    size = Math.max(7, size * maxW / w);
    ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`;
    if (size < 8.5) SHRUNK.push(`${text} (${size.toFixed(1)}px in ${maxW}px)`);
  }
  ctx.textAlign = opts.align || 'center';
  ctx.textBaseline = 'alphabetic';
  if (opts.halo !== false) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(5,10,15,.92)';
    ctx.lineWidth = Math.max(3, size * 0.34);
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = opts.fill || C.ink;
  ctx.fillText(text, x, y);
  return size;
}

// ---------------------------------------------------------------------------
// one circuit
// ---------------------------------------------------------------------------
const CORE_CAV_WALL = 13;
const ROD = [[159, 34], [203, 34], [247, 34]];   // x, width
const CH = [198, 242];                            // coolant channels between them
const CH_BOT = 800, HOT_TOP = 545, ANN = 298;
const HOT_Y = 534, COLD_Y = 567;

function circuitState(p) {
  const s = p.sys || {};
  const P = p.mode === MODE.PASSIVE;
  const sink = s.sink || 'none';
  const carried = sink !== 'none';
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  const lvl = clamp(p.level, 0, 1);
  const cav = cavityOf(L.core, CORE_CAV_WALL);
  const surfY = cav.y + cav.h - lvl * cav.h;
  const rodTop = cav.y + cav.h - FUEL_TOP * cav.h;
  const covered = surfY <= rodTop;
  const T = p.Tclad - 273;
  const live = !!(s.grid || s.diesel);
  const steamOnly = !P && !!s.rcic && !s.aux;
  const injecting = P ? !!(s.cmt || s.gravity || s.accum) : !!(s.aux || s.rcic);
  const poolLoop = P && sink === 'pool';
  const poolFrac = p.irwst / 2.1e6;
  const floorFrac = (p.ctmtSump || 0) / 2.1e6;
  const store = P
    ? clamp(0.07 * p.cmtLevel + 0.93 * Math.max(poolFrac, floorFrac * 0.85), 0, 1) : 1;
  const onFloor = P && p.irwst < 1.6e5 && floorFrac > 0.05;
  const cracked = P && p.irwstCracked;
  const lost = P && onFloor && !p.ctmtIntact;
  const lostWater = P && !p.ctmtIntact;
  const uncovered = !covered;
  const headline =
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
  return { s, P, sink, carried, flow, lvl, cav, surfY, rodTop, covered, uncovered,
    T, live, steamOnly, injecting, poolLoop, store, onFloor, cracked, lost, lostWater,
    headline,
    good: !(p.vesselBreach || uncovered || p.coreDamage > 0.01 || sink === 'none'
      || lvl < 0.97 || lostWater) };
}

function drawCircuit(ctx, p, st, t) {
  const { P, s } = st;
  const hotC = tempColor(Math.min(3200, p.Tcore + 40));
  const loopHot = tempColor(Math.min(3200, p.Tcore + 40));
  const loopBack = st.carried ? C.cold : loopHot;
  const moving = st.flow > 0 && !st.uncovered;
  const IDLE = '#4a5966';

  // ---- containment ------------------------------------------------------
  const z = L.zone;
  const tone = !p.ctmtIntact ? '#8a3020' : st.sink === 'shell' ? '#3f7d5c' : '#3d4e5f';
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(z.x, z.hull);
  ctx.lineTo(z.x, z.y + 210);
  ctx.ellipse(z.x + z.w / 2, z.y + 210, z.w / 2, 210, 0, Math.PI, 0);
  ctx.lineTo(z.x + z.w, z.hull);
  ctx.closePath();
  const cg = ctx.createLinearGradient(z.x, 0, z.x + z.w, 0);
  cg.addColorStop(0, '#3a4756'); cg.addColorStop(0.35, '#54custom'.replace('#54custom', '#55677a'));
  cg.addColorStop(1, '#2a3541');
  ctx.fillStyle = cg; ctx.fill();
  ctx.strokeStyle = tone; ctx.lineWidth = 2.5; ctx.stroke();
  // the void inside
  ctx.beginPath();
  ctx.moveTo(z.x + 20, z.hull);
  ctx.lineTo(z.x + 20, z.y + 214);
  ctx.ellipse(z.x + z.w / 2, z.y + 214, z.w / 2 - 20, 196, 0, Math.PI, 0);
  ctx.lineTo(z.x + z.w - 20, z.hull);
  ctx.closePath();
  ctx.fillStyle = 'rgba(9,16,23,.96)'; ctx.fill();
  ctx.restore();
  // basemat
  ctx.fillStyle = ctx.createLinearGradient
    ? (() => { const g = ctx.createLinearGradient(0, z.hull, 0, z.hull + z.slab);
      g.addColorStop(0, '#55677a'); g.addColorStop(1, '#2a3541'); return g; })() : '#44525f';
  ctx.strokeStyle = tone; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.rect(z.x - 12, z.hull - 2, z.w + 24, z.slab); ctx.fill(); ctx.stroke();

  // ---- pipes (under the machinery, so they run into the nozzles) --------
  const core = L.core, sg = L.sg, pump = L.pump;
  const R = 9;
  const P_hot = [[core.x + core.w, HOT_Y], [sg.x, HOT_Y]];
  const P_cold1 = [[630, sg.y + sg.h], [630, pump.cy - pump.r]];
  const P_cold2 = [[pump.cx - pump.r, pump.cy], [420, pump.cy], [420, COLD_Y],
    [core.x + core.w, COLD_Y]];
  const P_steam = [[600, sg.y], [600, L.flag.y + L.flag.h]];
  const inTop = [core.x + 60, core.y], upTop = [core.x + 148, core.y];
  const pipes = [
    { pts: P_hot, col: st.flow > 0 ? loopHot : IDLE, on: st.flow > 0, sp: st.flow },
    { pts: P_cold1, col: st.flow > 0 ? loopBack : IDLE, on: st.flow > 0, sp: st.flow },
    { pts: P_cold2, col: st.flow > 0 ? loopBack : IDLE, on: st.flow > 0, sp: st.flow },
    { pts: P_steam, col: st.sink === 'turbine' ? C.steam : IDLE, on: st.sink === 'turbine', sp: 1 }
  ];
  if (P) {
    pipes.push({ pts: [[inTop[0], L.pool.y + L.pool.h - 6], inTop],
      col: (st.injecting || st.poolLoop) ? (st.injecting ? C.water : C.cold) : IDLE,
      on: st.injecting || st.poolLoop, sp: 1, down: true });
    pipes.push({ pts: [upTop, [upTop[0], L.pool.y + L.pool.h - 6]],
      col: st.poolLoop ? C.hot : IDLE, on: st.poolLoop, sp: s.prhr || 1 });
  } else {
    pipes.push({ pts: [[L.base.x + L.base.w, L.base.y + 80], [383, L.base.y + 80],
      [383, L.eccs.cy], [L.eccs.cx - L.eccs.r, L.eccs.cy]],
    col: st.injecting ? C.water : IDLE, on: st.injecting, sp: 1 });
    pipes.push({ pts: [[L.eccs.cx, L.eccs.cy - L.eccs.r], [L.eccs.cx, 1000], [52, 1000],
      [52, 430], [inTop[0], 430], inTop],
    col: st.injecting ? C.water : IDLE, on: st.injecting, sp: 1 });
  }
  for (const q of pipes) pipe(ctx, q.pts, R, q.col);
  for (const q of pipes) if (q.on) flow(ctx, q.pts, R, t, Math.min(1.6, q.sp || 1), q.col);

  // ---- the boiler -------------------------------------------------------
  vesselShell(ctx, sg, st.carried ? null : '#8a3020');
  const sgCav = cavityOf(sg, CORE_CAV_WALL);
  ctx.save(); cavityFill(ctx, sgCav); clipCavity(ctx, sgCav);
  liquid(ctx, sgCav, st.sink === 'turbine' ? 0.72 : 0.22, t, '#2f8ed6',
    { boil: st.sink === 'turbine' ? 0.9 : 0 });
  // the U-tube carrying primary water through it
  const uHot = [[sgCav.x, HOT_Y], [sgCav.x + 38, HOT_Y], [sgCav.x + 38, 360], [592, 360]];
  const uCold = [[592, 360], [630, 360], [630, sgCav.y + sgCav.h + 14]];
  pipe(ctx, uHot, 7, moving ? loopHot : IDLE);
  pipe(ctx, uCold, 7, moving ? loopBack : IDLE);
  if (moving) {
    flow(ctx, uHot, 7, t, st.flow, loopHot);
    flow(ctx, uCold, 7, t, st.flow, loopBack);
  }
  ctx.restore();

  // ---- the reactor ------------------------------------------------------
  vesselShell(ctx, core, st.covered ? null : '#8a3020');
  const cav = st.cav;
  ctx.save(); cavityFill(ctx, cav); clipCavity(ctx, cav);
  const boil = clamp((st.T - 300) / 260, 0, 1) * (st.lvl > 0.02 ? 1 : 0);
  const wCol = waterColor(p.Tclad);
  const surf = liquid(ctx, cav, st.lvl, t, wCol, { boil });
  // fuel rods
  const rodH = 760 - st.rodTop;
  const glow = st.T > 400 ? tempColor(Math.min(p.Tclad, 3200)) : null;
  if (glow) {
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 26 + 30 * clamp((st.T - 400) / 900, 0, 1);
    ctx.fillStyle = glow;
    ctx.globalAlpha = clamp((st.T - 400) / 700, 0, 0.9);
    for (const [rx, rw] of ROD) { ctx.beginPath(); ctx.rect(rx, st.rodTop, rw, rodH); ctx.fill(); }
    ctx.restore();
  }
  for (const [rx, rw] of ROD) {
    const g = ctx.createLinearGradient(rx, 0, rx + rw, 0);
    if (glow) {
      g.addColorStop(0, shade(glow, 0.7)); g.addColorStop(0.3, shade(glow, 1.35));
      g.addColorStop(1, shade(glow, 0.6));
    } else {
      g.addColorStop(0, '#7a8996'); g.addColorStop(0.28, '#e2ecf3');
      g.addColorStop(0.62, '#9dacb9'); g.addColorStop(1, '#5d6b78');
    }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect(rx, st.rodTop, rw, rodH, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(12,20,28,.7)'; ctx.lineWidth = 1.2; ctx.stroke();
    // individual rods
    ctx.strokeStyle = 'rgba(14,24,33,.45)'; ctx.lineWidth = 2;
    for (let i = 1; i < 3; i++) {
      const lx = rx + rw * i / 3;
      ctx.beginPath(); ctx.moveTo(lx, st.rodTop + 3); ctx.lineTo(lx, st.rodTop + rodH - 3); ctx.stroke();
    }
  }
  // the route the water takes through the core
  const colds = [[core.x + core.w, COLD_Y], [ANN, COLD_Y], [ANN, CH_BOT], [CH[0], CH_BOT]];
  const hots = [[CH[0], CH_BOT], [CH[0], HOT_TOP], [core.x + core.w, HOT_TOP]];
  const hots2 = [[CH[1], CH_BOT], [CH[1], HOT_TOP + 6]];
  pipe(ctx, colds, 7, moving ? loopBack : IDLE);
  pipe(ctx, hots, 7, moving ? hotC : IDLE);
  pipe(ctx, hots2, 7, moving ? hotC : IDLE);
  if (moving) {
    flow(ctx, colds, 7, t, st.flow, loopBack);
    flow(ctx, hots, 7, t, st.flow, hotC);
    flow(ctx, hots2, 7, t, st.flow, hotC);
  }
  label(ctx, 'FUEL RODS', 220, cav.y + cav.h - 8, { px: 12, weight: 800, fill: st.covered ? '#a9bccb' : '#ffb59c' });
  ctx.restore();

  // water falling in from the pool, landing on the surface
  if (P && st.injecting && surf !== null) {
    pour(ctx, inTop[0], core.y + 6, Math.max(core.y + 20, surf - 2), 13, t, C.water, true);
  }

  // ---- the spare water --------------------------------------------------
  const tank = P ? L.pool : L.base;
  basin(ctx, tank, st.lost ? '#8a3020' : st.cracked && !st.onFloor ? '#7a5a1c' : null);
  const tcav = { x: tank.x + 9, y: tank.y + 8, w: tank.w - 18, h: tank.h - 22 };
  ctx.save();
  ctx.beginPath(); ctx.rect(tcav.x, tcav.y, tcav.w, tcav.h); ctx.clip();
  liquid(ctx, tcav, P ? st.store : 1, t,
    st.lost ? '#6b4a34' : st.cracked && !st.onFloor ? '#7d5a3a' : C.water,
    { boil: 0, flat: true });
  ctx.restore();

  // ---- pumps ------------------------------------------------------------
  const spin = (v) => (v ? (t * 3.4) % TAU : 0);
  pumpBody(ctx, pump, spin(s.rcp), !!s.rcp, s.rcp ? null : (P ? '#2c6a45' : '#8a3020'));
  if (!P) {
    pumpBody(ctx, L.eccs, spin(st.injecting) * 0.8,
      st.injecting, st.steamOnly ? '#7a5a1c' : st.injecting ? null
        : (st.live && p.pumpsOk ? null : '#8a3020'));
  }

  // ---- power ------------------------------------------------------------
  const pw = L.power;
  ctx.save();
  const pg = ctx.createLinearGradient(pw.x, pw.y, pw.x, pw.y + pw.h);
  pg.addColorStop(0, '#1a2733'); pg.addColorStop(1, '#0d1620');
  ctx.fillStyle = pg;
  ctx.strokeStyle = st.live ? 'rgba(255,211,92,.65)' : (s.battery > 0 ? C.warn : C.bad);
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(pw.x, pw.y, pw.w, pw.h, 11); ctx.fill(); ctx.stroke();
  ctx.fillStyle = st.live ? C.power : (s.battery > 0 ? C.warn : '#5a3630');
  ctx.beginPath();
  ctx.moveTo(pw.x + 24, pw.y + 20); ctx.lineTo(pw.x + 38, pw.y + 20);
  ctx.lineTo(pw.x + 31, pw.y + 36); ctx.lineTo(pw.x + 42, pw.y + 36);
  ctx.lineTo(pw.x + 22, pw.y + 60); ctx.lineTo(pw.x + 28, pw.y + 42);
  ctx.lineTo(pw.x + 18, pw.y + 42); ctx.closePath(); ctx.fill();
  ctx.restore();

  // ---- wires ------------------------------------------------------------
  const wires = [[[pw.x + 70, pw.y], [pw.x + 70, pump.cy + pump.r], [pump.cx, pump.cy + pump.r]]];
  if (!P) wires.push([[pw.x, pw.y + 46], [pw.x - 30, pw.y + 46], [pw.x - 30, L.eccs.cy],
    [L.eccs.cx + L.eccs.r, L.eccs.cy]]);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const w of wires) {
    tracePath(ctx, w, 4);
    ctx.strokeStyle = '#0a1017'; ctx.lineWidth = 9; ctx.stroke();
    ctx.setLineDash([11, 9]);
    ctx.lineDashOffset = st.live ? -(t * 26) % 20 : 0;
    ctx.strokeStyle = st.live ? C.power : '#3a4550'; ctx.lineWidth = 4.5; ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // ---- the outlet flag --------------------------------------------------
  const fl = L.flag, viaSG = st.sink === 'turbine';
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y); ctx.lineTo(fl.x + fl.w * 0.86, fl.y);
  ctx.lineTo(fl.x + fl.w, fl.y + fl.h / 2); ctx.lineTo(fl.x + fl.w * 0.86, fl.y + fl.h);
  ctx.lineTo(fl.x, fl.y + fl.h); ctx.closePath();
  ctx.fillStyle = 'rgba(14,22,30,.95)';
  ctx.strokeStyle = viaSG ? '#6f7d8a' : '#39424c'; ctx.lineWidth = 2;
  ctx.globalAlpha = viaSG ? 1 : 0.55; ctx.fill(); ctx.stroke();
  ctx.globalAlpha = 1;
  label(ctx, 'heat out, to the sea', fl.x + fl.w * 0.45, fl.y + 34,
    { px: 15, fill: viaSG ? C.ink : '#5d6975', maxW: fl.w * 0.8 });
  ctx.restore();
  return { hotC, loopBack, moving };
}

function drawLabels(ctx, p, st) {
  const { P, s } = st;
  const core = L.core, sg = L.sg, pump = L.pump, tank = P ? L.pool : L.base;
  const MW = (p.qDecay || 0) / 1e6;
  // reactor
  label(ctx, 'REACTOR', core.x + core.w / 2, core.y - 22, { px: 17, weight: 800 });
  label(ctx, `water ${Math.round(st.lvl * 100)}%   ·   ${st.T.toFixed(0)} °C`,
    core.x + core.w / 2, core.y + core.h + 56,
    { px: 16, fill: st.T > 800 ? C.bad : st.T > 360 ? C.warn : C.dim, maxW: 300 });
  // Shutting a reactor down stops the chain reaction, not the heat. Without
  // this number nothing else on the page has a reason to exist.
  label(ctx, p.scrammed
    ? `shut down — still making ${MW < 10 ? MW.toFixed(1) : Math.round(MW)} MW of heat`
    : `running — making ${Math.round(MW).toLocaleString('en-US')} MW of heat`,
  core.x + core.w / 2, core.y + core.h + 78, { px: 13.5, fill: '#a2bacd', maxW: 320 });
  // boiler
  label(ctx, 'BOILER', sg.x + sg.w / 2, sg.y - 22, { px: 17, weight: 800 });
  label(ctx, st.sink === 'turbine' ? 'taking the heat away'
    : st.sink === 'pool' ? 'not needed — the pool has it'
      : st.sink === 'shell' ? 'not needed — the shell has it' : 'not taking any heat',
  sg.x + sg.w / 2, sg.y + sg.h + 54,
  { px: 15, fill: st.sink === 'turbine' ? C.dim : st.carried ? C.ok : C.bad, maxW: 300 });
  // pumps. Two lines: what it is doing, and what the cooling depends on. This
  // pump is a normal-running machine on both plants, and when it stops the loop
  // keeps creeping round on both. The difference is what comes next.
  const pumpTx = s.rcp
    ? (P ? ['spinning', 'the cooling needs no pump at all']
      : ['spinning', 'the cooling needs pumps like this'])
    : (P ? ['stopped', 'and the cooling carries on anyway']
      : ['STOPPED', st.steamOnly ? 'the steam pump covers it'
        : st.live ? 'the backups must take over' : 'the backups have no power']);
  const pc = s.rcp ? C.ink : (P ? C.ok : C.bad);
  label(ctx, 'PUMP', pump.cx, pump.cy + pump.r + 52, { px: 16, weight: 800 });
  label(ctx, pumpTx[0], pump.cx, pump.cy + pump.r + 73, { px: 14, fill: pc, maxW: 250 });
  label(ctx, pumpTx[1], pump.cx, pump.cy + pump.r + 92,
    { px: 13, weight: 600, fill: s.rcp ? C.dim : pc, maxW: 260 });
  // the store of water
  label(ctx, P ? (st.onFloor ? 'WATER ON THE FLOOR' : 'POOL ABOVE THE REACTOR')
    : 'WATER IN THE BASEMENT', tank.x + tank.w / 2, tank.y - 16, { px: 16, weight: 800, maxW: 320 });
  label(ctx, P ? (st.lost ? 'ESCAPING as steam'
    : st.onFloor ? 'still gets back in'
      : st.cracked ? 'CRACKED — draining'
        : st.injecting ? 'falling into the reactor'
          : st.poolLoop ? 'taking the heat from the reactor' : 'ready — no pump needed')
    : (st.injecting ? 'being pumped up'
      : !st.live ? 'CANNOT REACH THE REACTOR'
        : !p.pumpsOk ? 'THE PUMPS HAVE FAILED' : 'waiting down here'),
  tank.x + tank.w / 2, tank.y + tank.h + 18,
  { px: 15, maxW: 320,
    fill: st.lost ? C.bad : st.onFloor ? C.ok : st.cracked ? C.warn : P ? C.ok
      : st.injecting ? C.ink : (st.live && p.pumpsOk ? C.dim : C.bad) });
  // power
  const src = s.grid ? 'grid' : s.diesel ? 'diesels'
    : s.battery > 0 ? `batteries ${(s.battery * p.batteryHours).toFixed(0)} h` : 'NONE';
  label(ctx, 'POWER', L.power.x + L.power.w / 2 + 14, L.power.y + 36, { px: 15, weight: 800 });
  label(ctx, src, L.power.x + L.power.w / 2 + 14, L.power.y + 60,
    { px: 15, fill: st.live ? C.power : (s.battery > 0 ? C.warn : C.bad), maxW: 120 });
  if (!P) {
    const e = L.eccs;
    label(ctx, 'BACKUP PUMP', e.cx, e.cy + e.r + 52, { px: 16, weight: 800 });
    label(ctx, st.steamOnly ? 'running on steam' : st.injecting ? 'pumping'
      : !st.live ? 'NO POWER' : !p.pumpsOk ? 'BROKEN' : 'waiting',
    e.cx, e.cy + e.r + 73,
    { px: 14, maxW: 250,
      fill: st.steamOnly ? C.warn : st.injecting ? C.ink : (st.live && p.pumpsOk) ? C.dim : C.bad });
    label(ctx, st.steamOnly ? 'runs on steam, not the grid'
      : st.injecting ? 'lifting water uphill'
        : !st.live ? 'it needs electricity'
          : !p.pumpsOk ? 'it cannot lift the water' : 'starts if the level falls',
    e.cx, e.cy + e.r + 92, { px: 13, weight: 600, maxW: 260,
      fill: st.steamOnly ? C.warn : st.injecting || (st.live && p.pumpsOk) ? C.dim : C.bad });
    label(ctx, 'the long way round, uphill', 600, 1002,
      { px: 14, fill: st.injecting ? C.water : '#5f7180', maxW: 300 });
  } else {
    label(ctx, st.injecting ? 'falls in' : 'comes back cooled', L.core.x + 60 - 54, 400,
      { px: 14, fill: st.injecting ? C.water : C.cold, maxW: 130 });
    label(ctx, 'heat rises', L.core.x + 148 + 56, 400,
      { px: 14, fill: st.poolLoop ? C.hot : '#6a5a50', maxW: 120 });
  }
  // the wall
  label(ctx, !p.ctmtIntact ? 'CONTAINMENT BREACHED — the barrier is gone'
    : st.sink === 'shell' ? 'CONTAINMENT — the steel is taking the heat to the air'
      : 'CONTAINMENT — nothing inside this line gets out',
  L.zone.x + 22, L.zone.hull + 30,
  { px: 14, align: 'left', maxW: 430,
    fill: !p.ctmtIntact ? C.bad : st.sink === 'shell' ? C.ok : C.dim });
}

// ---------------------------------------------------------------------------
// the stage: fit both circuits into the band and paint them
// ---------------------------------------------------------------------------
export class Cutaway {
  constructor() { this.focus = 'both'; this.states = []; this.shrunk = []; }
  setFocus(f) { this.focus = f; }

  bounds() {
    const one = { x: CONTENT.x, y: CONTENT.y, w: CONTENT.w, h: CONTENT.h };
    if (this.focus === 'both') return { ...one, w: one.w + W + GAP };
    return one;
  }

  // the band the drawing gets, in CSS pixels
  band(cw, ch) {
    const narrow = cw < 861;
    return narrow
      ? { x: 8, y: 124, w: cw - 16, h: ch - 124 - 226 }
      : { x: 318, y: 104, w: cw - 318 - 350, h: ch - 104 - 128 };
  }

  draw(ctx, sim, CW, CH, t) {
    const dpr = CW / (window.innerWidth || CW);
    const cw = CW / dpr, ch = CH / dpr;
    const b = this.band(cw, ch);
    if (b.w < 40 || b.h < 40) return;
    SHRUNK.length = 0;
    const bb = this.bounds();
    const sc = Math.min(b.w / bb.w, b.h / bb.h);
    const tx = b.x + (b.w - bb.w * sc) / 2 - bb.x * sc;
    const ty = b.y + (b.h - bb.h * sc) / 2 - bb.y * sc;
    this.scale = sc; this.tx = tx; this.ty = ty; this.dpr = dpr;

    const show = sim.plants.filter((p) =>
      !(this.focus === 'active' && p.mode === MODE.PASSIVE)
      && !(this.focus === 'passive' && p.mode !== MODE.PASSIVE));
    this.states = [];
    show.forEach((p, i) => {
      const st = circuitState(p);
      this.states.push({ p, st, ox: i * (W + GAP) });
      ctx.save();
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (tx + i * (W + GAP) * sc), dpr * ty);
      drawCircuit(ctx, p, st, t);
      drawLabels(ctx, p, st);
      ctx.restore();
    });

    // headings, in screen space so they stay crisp at any zoom
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.states.forEach(({ p, st, ox }) => {
      const cx = tx + (ox + W / 2) * sc;
      // the headings live above the drawing, but never under the top bar
      const top = Math.max(78, ty + CONTENT.y * sc);
      const name = p.mode === MODE.PASSIVE ? 'PASSIVE' : 'ACTIVE';
      ctx.textAlign = 'center';
      ctx.font = '800 22px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = p.mode === MODE.PASSIVE ? '#57d9ff' : '#ff8b5c';
      ctx.fillText(name, cx, top - 34);
      ctx.font = '800 14px ui-sans-serif, system-ui, sans-serif';
      const w = ctx.measureText(st.headline).width + 26;
      ctx.fillStyle = st.good ? 'rgba(10,44,28,.94)' : 'rgba(56,14,10,.94)';
      ctx.strokeStyle = st.good ? 'rgba(99,224,138,.6)' : 'rgba(255,110,80,.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(cx - w / 2, top - 26, w, 24, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = st.good ? '#8ff0b4' : '#ff9c88';
      ctx.fillText(st.headline, cx, top - 9);
    });
    ctx.textAlign = 'left';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
