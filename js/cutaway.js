// ---------------------------------------------------------------------------
// cutaway.js — the inside of both plants, as a place.
//
// This is an isometric cutaway, drawn with the same projection and the same
// solid primitives as the site view, so the two views are one world seen at two
// scales rather than a picture and a diagram.
//
// The technique for seeing inside a vessel is the one a cutaway model uses:
// clip to the vessel's silhouette, draw the contents (water, fuel, the route
// the water takes), then lay the shell back over the top as glass. What you get
// is a machine you can see into, not a symbol with a level bar on it.
//
// Everything is a pure function of the model and the clock — variation comes
// from hashing an index, never Math.random() in a draw call, so a frozen frame
// is a still one.
// ---------------------------------------------------------------------------

import { MODE, FUEL_TOP } from './plant.js';
import { project, ERX, ERY, TZ, shade, rgba, mix, shadow, box, cylinder, prism } from './iso.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const hash = (i) => { const s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); };

const C = {
  cold: '#3fbfe0', water: '#2f8ed6', hot: '#f07a34', steam: '#cddae4',
  power: '#ffd35c', ok: '#63e08a', warn: '#ffc44d', bad: '#ff5c48',
  ink: '#e9f2f9', dim: '#93a6b6',
  steel: '#8fa3b3', deck: '#3d4b57', conc: '#586a7c'
};

const RAMP = [[560, '#d9853a'], [720, '#e59a2e'], [900, '#e8702a'],
  [1100, '#e8481c'], [1500, '#f52d10'], [2200, '#ff3a18'], [3200, '#ff6a33']];
const hx = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function tempColor(K) {
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
// Water goes blue -> pale scalding -> orange. It takes the long way round on
// purpose: blending blue into orange in RGB passes through brown, and brown
// water reads as dirty rather than hot.
function heatedWater(u0) {
  const u = clamp(u0, 0, 1);
  const midc = hx('#cfe6f2');
  const a = u < 0.5 ? hx('#2f8ed6') : midc;
  const b = u < 0.5 ? midc : hx('#ff6a33');
  const v = u < 0.5 ? u * 2 : (u - 0.5) * 2;
  return `rgb(${lerp(a[0], b[0], v) | 0},${lerp(a[1], b[1], v) | 0},${lerp(a[2], b[2], v) | 0})`;
}
function waterColor(K) { return heatedWater((K - 660) / 400); }

// Captions the renderer had to shrink past legibility. The harness reads this
// rather than trying to measure canvas text from outside.
const SHRUNK = [];
export function overflowReport() { return SHRUNK.slice(); }

// ---------------------------------------------------------------------------
// the plant, laid out as a place. Grid units: x toward lower-right, y toward
// lower-left, z up. One building is 22 x 22 and about 18 tall.
// ---------------------------------------------------------------------------
const G = {
  shell: { x: 11, y: 11, r: 8.8, h: 12.6, domeH: 5.2 },
  core:  { x: 7.6,  y: 14.4, r: 1.40, z: 0.8,  h: 8.2 },
  sg:    { x: 14.4, y: 7.6,  r: 1.20, z: 1.0,  h: 10.4 },
  pump:  { x: 14.4, y: 14.4, r: 1.35, z: 2.4,  h: 2.4 },
  pool:  { x0: 3.2, y0: 8.8, x1: 7.8, y1: 13.4, z: 9.4, h: 2.5 },
  // the water store and its pump, on the far side from the turbine hall
  base:  { x0: 10.0, y0: 21.0, x1: 16.0, y1: 24.0, z: -2.0, h: 2.6 },
  eccs:  { x: 7.6, y: 20.4, r: 0.95, z: 0.0,  h: 1.5 },
  power: { x0: 19.5, y0: 18.5, x1: 22.0, y1: 20.5, z: 0, h: 2.2 },
  // the turbine hall, outside the containment, where the heat becomes power
  deck:  { x0: 20.0, y0: 13.6, x1: 30.3, y1: 17.9, z: 0, h: 0.7 },
  hp:    { x: 20.5, y: 14.65, w: 2.6, d: 2.2, z: 0.7, h: 2.4 },
  lp:    { x: 23.4, y: 14.05, w: 3.2, d: 3.4, z: 0.7, h: 3.0 },
  gen:   { x: 26.9, y: 14.75, w: 3.0, d: 2.0, z: 0.7, h: 2.2 },
  cond:  { x0: 23.5, y0: 14.2, x1: 26.5, y1: 18.9, z: -1.9, h: 2.5 },
  // the filtered vent stack, and the line that reaches it through the wall
  stack: { x: 19.0, y: 6.2, r: 0.34, h: 15.0 }
};
const SHAFT_Y = 15.75;

// nozzle heights. The hot leg leaves high and the cold leg returns low, which
// is what makes the loop turn over on its own when the pump stops.
const HOT_Z = 6.9, COLD_Z = 3.6, SG_IN_Z = 7.8, SG_OUT_Z = 4.4;
const COIL_Z = G.pool.z + 1.2;      // the passive heat exchanger, under the pool
// The model calls the core uncovered below FUEL_TOP, so the drawing puts the
// surface exactly on the top of the fuel at that number and nowhere else.
// Everything about the water level is derived from these three lines.
const W0 = G.core.z + G.core.h * 0.06;          // the surface at level 0
const W1 = G.core.z + G.core.h * 0.66;          // the surface at level 1
const FUEL_Z0 = G.core.z + 0.75;
const FUEL_Z1 = W0 + (W1 - W0) * FUEL_TOP;
const waterZ = (level) => W0 + (W1 - W0) * clamp(level, 0, 1);

// The loop, as a route through the building: reactor -> far corner -> boiler
// -> near corner (the pump) -> reactor. Every leg is axis-aligned so it reads
// as plant pipework rather than as arrows on a diagram.
const R_HOT = [[G.core.x, G.core.y - G.core.r, HOT_Z], [G.core.x, G.sg.y, HOT_Z],
  [G.core.x, G.sg.y, SG_IN_Z], [G.sg.x - G.sg.r, G.sg.y, SG_IN_Z]];
const R_COLD_A = [[G.sg.x, G.sg.y + G.sg.r, SG_OUT_Z], [G.sg.x, 11.4, SG_OUT_Z],
  [G.sg.x, 11.4, COLD_Z], [G.sg.x, G.pump.y - G.pump.r, COLD_Z]];
const R_COLD_B = [[G.pump.x - G.pump.r, G.pump.y, COLD_Z],
  [G.core.x + G.core.r, G.core.y, COLD_Z]];
// passive residual-heat loop: out of the reactor, up into the pool, round the
// coil, back down and in low.
const PR_UP = [[G.core.x, G.core.y + G.core.r, HOT_Z], [6.6, 16.7, HOT_Z],
  [6.6, 16.7, COIL_Z], [6.6, 12.9, COIL_Z]];
const PR_COIL = (() => {
  const out = [], y0 = 9.4, y1 = 12.9;
  let x = 6.6, up = true;
  out.push([x, y1, COIL_Z]);
  while (x > 3.85) {
    out.push([x, up ? y0 : y1, COIL_Z]);
    x -= 0.7;
    out.push([x, up ? y0 : y1, COIL_Z]);
    up = !up;
  }
  if (!up) out.push([out[out.length - 1][0], y1, COIL_Z]);
  return out;
})();
const PR_DN = [[3.8, 12.9, COIL_Z], [3.8, 12.9, COLD_Z], [3.8, G.core.y, COLD_Z],
  [G.core.x - G.core.r, G.core.y, COLD_Z]];
// gravity drain: the pool runs out sideways and down onto the reactor head
const R_GRAV = [[4.7, 13.0, G.pool.z], [4.7, 13.0, 9.3], [4.7, G.core.y, 9.3],
  [G.core.x, G.core.y, 9.3], [G.core.x, G.core.y, G.core.z + G.core.h - 0.3]];
// the active plant's injection line: out of the basement, up the outside of the
// building and back down in. This is the long way round, and it needs a pump.
const R_SUCT = [[G.base.x0, 22.5, -0.7], [G.eccs.x, 22.5, -0.7], [G.eccs.x, G.eccs.y, -0.7],
  [G.eccs.x, G.eccs.y, 0.5]];
const R_ACT = [[G.eccs.x, G.eccs.y, 1.5], [G.eccs.x, G.eccs.y, 9.8], [10.6, G.eccs.y, 9.8],
  [10.6, G.core.y, 9.8], [10.6, G.core.y, COLD_Z]];

// The other circuit entirely. Steam off the top of the boiler, out through the
// containment wall, into the turbine; the condenser turns it back to water and
// it is pumped back in. Nothing in this loop is ever inside the reactor.
const R_STEAM = [[G.sg.x, G.sg.y, G.sg.z + G.sg.h - 0.2], [G.sg.x, G.sg.y, 12.4],
  [21.7, G.sg.y, 12.4], [21.7, SHAFT_Y, 12.4], [21.7, SHAFT_Y, G.hp.z + G.hp.h - 0.2]];
const R_FEED = [[23.2, 15.2, 1.3], [22.2, 15.2, 1.3], [22.2, 8.6, 1.3],
  [G.sg.x + G.sg.r, 8.6, 1.3], [G.sg.x + G.sg.r, G.sg.y, 1.3],
  [G.sg.x + G.sg.r, G.sg.y, 3.2]];
// cooling water out of the condenser, away to the sea
const R_CW = [[26.5, 17.4, -1.0], [27.8, 17.4, -1.0], [27.8, 20.4, -1.0]];
const R_VENT = [[16.2, G.stack.y, 10.0], [G.stack.x, G.stack.y, 10.0],
  [G.stack.x, G.stack.y, G.stack.h - 0.4]];
// the generator's output, on its way to the switchyard
const R_BUS = [[G.gen.x + G.gen.w, SHAFT_Y, G.gen.z + G.gen.h * 0.6],
  [30.6, SHAFT_Y, 4.4], [30.6, 20.6, 4.4], [G.power.x1 - 0.6, 20.6, 4.4],
  [G.power.x1 - 0.6, 20.6, G.power.h]];

// ---------------------------------------------------------------------------
// primitives built on the projection
// ---------------------------------------------------------------------------

// The silhouette of a body of revolution, as a path, so it can be clipped to.
function revolvePath(ctx, o) {
  const { x, y, h, prof } = o, z = o.z || 0, R = o.r == null ? 1 : o.r;
  const pts = prof.map((s) => {
    const p = project(x, y, z + h * s.t);
    return { x: p.x, y: p.y, rx: s.r * R * ERX, ry: s.r * R * ERY };
  });
  const tp = pts[pts.length - 1], bp = pts[0];
  ctx.beginPath();
  ctx.moveTo(bp.x - bp.rx, bp.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - pts[i].rx, pts[i].y);
  ctx.ellipse(tp.x, tp.y, tp.rx, tp.ry, 0, Math.PI, 0, true);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x + pts[i].rx, pts[i].y);
  ctx.ellipse(bp.x, bp.y, bp.rx, bp.ry, 0, 0, Math.PI, false);
  ctx.closePath();
  return pts;
}

// The inside of a vessel: dark, but lit from the opening like the rest of the
// cutaway, and with a haze in the space above the water.
function vesselInside(ctx, o) {
  const c = project(o.x, o.y, o.z);
  const rx = o.r * ERX;
  const g = ctx.createLinearGradient(c.x - rx, 0, c.x + rx, 0);
  g.addColorStop(0, '#28374a');
  g.addColorStop(0.42, '#141d27');
  g.addColorStop(0.72, '#1a2532');
  g.addColorStop(1, '#2d3d50');
  ctx.fillStyle = g; ctx.fill();
}
function steamSpace(ctx, o, surfY, amount) {
  const top = project(o.x, o.y, o.z + o.h);
  const g = ctx.createLinearGradient(0, top.y, 0, surfY);
  g.addColorStop(0, `rgba(196,216,232,${0.05 + 0.18 * amount})`);
  g.addColorStop(1, `rgba(214,232,244,${0.02 + 0.10 * amount})`);
  ctx.fillStyle = g;
  ctx.fillRect(top.x - o.r * ERX - 4, top.y - o.r * ERY - 4,
    o.r * ERX * 2 + 8, surfY - top.y + o.r * ERY + 8);
}

// A pressure-vessel profile: domed bottom, straight barrel, domed head.
function capsuleProf(n = 44) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let r;
    if (t < 0.14) r = Math.sqrt(1 - Math.pow(1 - t / 0.14, 2));
    else if (t > 0.70) r = Math.sqrt(1 - Math.pow((t - 0.70) / 0.30, 2));
    else r = 1;
    out.push({ t, r: Math.max(0.06, r) });
  }
  return out;
}
const CAPSULE = capsuleProf();

// Glass shell over whatever was drawn inside: a translucent body, a bright limb
// on the lit side, and opaque rims where the eye needs an edge.
function glassShell(ctx, o, tint) {
  const pts = revolvePath(ctx, o);
  const bp = pts[0], tp = pts[pts.length - 1];
  let maxR = 0; for (const q of pts) if (q.rx > maxR) maxR = q.rx;
  const g = ctx.createLinearGradient(bp.x - maxR, 0, bp.x + maxR, 0);
  g.addColorStop(0, rgba(tint || C.steel, 0.50));
  g.addColorStop(0.24, rgba(tint || C.steel, 0.07));
  g.addColorStop(0.46, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.74, rgba(tint || C.steel, 0.10));
  g.addColorStop(1, rgba(tint || C.steel, 0.54));
  ctx.fillStyle = g; ctx.fill();
  // limb highlight
  ctx.strokeStyle = 'rgba(232,244,252,0.55)'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(bp.x - bp.rx, bp.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - pts[i].rx, pts[i].y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(140,170,195,0.5)';
  ctx.beginPath();
  ctx.moveTo(bp.x + bp.rx, bp.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + pts[i].rx, pts[i].y);
  ctx.stroke();
}

// The domed head is solid steel and there is nothing behind it worth seeing, so
// it is painted opaque. It is what makes a glass cylinder read as a reactor
// vessel rather than as a tank of water.
const HEAD_T = 0.70;
function vesselHead(ctx, o, tone) {
  const pts = [];
  for (const s of CAPSULE) {
    if (s.t < HEAD_T - 1e-6) continue;
    const p = project(o.x, o.y, o.z + o.h * s.t);
    pts.push({ x: p.x, y: p.y, rx: s.r * o.r * ERX, ry: s.r * o.r * ERY });
  }
  const bp = pts[0], tp = pts[pts.length - 1];
  // The near half of the head is cut away, the same way the building is: a
  // solid head would hang down over the water and hide the one thing the
  // viewer came to see. What is left is the inside of the dome.
  ctx.beginPath();
  ctx.moveTo(bp.x - bp.rx, bp.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - pts[i].rx, pts[i].y);
  ctx.ellipse(tp.x, tp.y, tp.rx, tp.ry, 0, Math.PI, 0, true);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x + pts[i].rx, pts[i].y);
  ctx.ellipse(bp.x, bp.y, bp.rx, bp.ry, 0, 0, Math.PI, true);
  ctx.closePath();
  const g = ctx.createLinearGradient(bp.x - bp.rx, 0, bp.x + bp.rx, 0);
  g.addColorStop(0, shade(tone, 0.44));
  g.addColorStop(0.34, shade(tone, 0.82));
  g.addColorStop(0.56, shade(tone, 0.96));
  g.addColorStop(1, shade(tone, 0.50));
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(12,18,24,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();
  // the cut edge, bright so the slice reads as deliberate
  ctx.beginPath();
  ctx.ellipse(bp.x, bp.y, bp.rx, bp.ry, 0, 0, Math.PI, true);
  ctx.strokeStyle = shade(tone, 1.35); ctx.lineWidth = 2.2; ctx.stroke();
}

// The liquid inside a vessel of revolution: a body clipped to the silhouette,
// an elliptical surface with a moving crest, and bubbles when it boils.
function liquidIn(ctx, o, zTop, col, t, boil, alpha) {
  const zBot = o.z + o.h * 0.05;
  if (zTop <= zBot + 0.02) return null;
  const tt = clamp((zTop - o.z) / o.h, 0, 1);
  const surf = project(o.x, o.y, zTop);
  const bot = project(o.x, o.y, zBot);
  // radius at the surface, read off the same profile the shell is drawn from
  let r = o.r;
  for (let i = 1; i < CAPSULE.length; i++) {
    const s = CAPSULE[i], p0 = CAPSULE[i - 1];
    if (s.t >= tt) { r = o.r * lerp(p0.r, s.r, (tt - p0.t) / (s.t - p0.t || 1)); break; }
  }
  const rx = r * ERX, ry = r * ERY;
  const wob = Math.sin(t * 1.9) * 1.1 + Math.sin(t * 3.1 + 1.2) * 0.6;
  const sy = surf.y + wob;

  // body: from the surface down to the bottom, clipped to the vessel
  ctx.save();
  revolvePath(ctx, o); ctx.clip();
  if (alpha != null) ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(0, sy, 0, bot.y + ry);
  g.addColorStop(0, shade(col, 1.18));
  g.addColorStop(0.25, col);
  g.addColorStop(1, shade(col, 0.5));
  ctx.fillStyle = g;
  ctx.fillRect(surf.x - o.r * ERX - 4, sy, o.r * ERX * 2 + 8, (bot.y + ry) - sy + 4);
  // a vertical sheen down the lit side
  const sh = ctx.createLinearGradient(surf.x - rx, 0, surf.x + rx, 0);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(0.26, 'rgba(255,255,255,0.18)');
  sh.addColorStop(0.48, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = sh;
  ctx.fillRect(surf.x - rx, sy, rx * 2, (bot.y + ry) - sy + 4);
  if (boil > 0.02) {
    ctx.fillStyle = 'rgba(232,248,255,0.55)';
    const n = Math.round(7 + boil * 15);
    for (let i = 0; i < n; i++) {
      const ph = (t * (0.32 + hash(i) * 0.5) + hash(i + 90)) % 1;
      const by = (bot.y + ry) - ph * ((bot.y + ry) - sy);
      if (by < sy + 3) continue;
      const bx = surf.x + (hash(i + 30) - 0.5) * rx * 1.7 + Math.sin(ph * 9 + i) * 3;
      const rr = 1.3 + hash(i + 60) * 2.2;
      ctx.globalAlpha = 0.22 + 0.55 * (1 - ph);
      ctx.beginPath(); ctx.ellipse(bx, by, rr, rr * 0.62, 0, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // the surface, an ellipse in the isometric plane
  ctx.beginPath(); ctx.ellipse(surf.x, sy, rx, ry, 0, 0, TAU);
  const sg2 = ctx.createRadialGradient(surf.x - rx * 0.3, sy - ry * 0.5, ry * 0.1,
    surf.x, sy, rx * 1.1);
  sg2.addColorStop(0, shade(col, 1.30));
  sg2.addColorStop(0.55, shade(col, 1.10));
  sg2.addColorStop(1, shade(col, 0.92));
  ctx.fillStyle = sg2; ctx.fill();
  ctx.beginPath(); ctx.ellipse(surf.x, sy - 0.8, rx * 0.72, ry * 0.72, 0, 0, TAU);
  ctx.fillStyle = shade(col, 1.34);
  ctx.globalAlpha = 0.16 + 0.10 * Math.sin(t * 2.3); ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = withA(shade(col, 1.5), 0.5); ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(surf.x, sy, rx, ry, 0, 0, TAU); ctx.stroke();
  // ripples travelling out across it
  ctx.strokeStyle = 'rgba(226,246,255,0.5)'; ctx.lineWidth = 1.3;
  for (let i = 0; i < 2; i++) {
    const ph = ((t * 0.55 + i * 0.5) % 1);
    ctx.globalAlpha = 0.45 * (1 - ph);
    ctx.beginPath();
    ctx.ellipse(surf.x, sy, rx * (0.15 + ph * 0.82), ry * (0.15 + ph * 0.82), 0, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return { x: surf.x, y: sy, z: zTop, rx, ry };
}

// ---------------------------------------------------------------------------
// pipework: a tube along a 3D polyline, with fluid that visibly travels along it
// ---------------------------------------------------------------------------
function withA(col, a) {
  if (col.charCodeAt(0) === 35) return rgba(col, a);
  const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(col);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : col;
}

function scr(pts3) {
  const out = [];
  for (let i = 0; i < pts3.length; i++) out.push(project(pts3[i][0], pts3[i][1], pts3[i][2]));
  return out;
}
function tracePts(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}

// A pipe is drawn cut open, like everything else here: two casing rails with
// the bore between them. You are looking into the pipe, so what is in it is
// water rather than a dashed line meaning water.
function tube(ctx, pts, w, tone) {
  ctx.setLineDash([]);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  tracePts(ctx, pts);
  ctx.strokeStyle = 'rgba(10,17,24,0.62)'; ctx.lineWidth = w + 3.2; ctx.stroke();
  ctx.strokeStyle = shade(tone || C.steel, 0.66); ctx.lineWidth = w; ctx.stroke();
  ctx.strokeStyle = shade(tone || C.steel, 1.20); ctx.lineWidth = w * 0.86; ctx.stroke();
  // the cut edge of the casing, and the empty bore behind it
  ctx.strokeStyle = 'rgba(12,19,26,0.85)'; ctx.lineWidth = w * 0.66; ctx.stroke();
  ctx.strokeStyle = '#101a24'; ctx.lineWidth = w * 0.58; ctx.stroke();
}

// Distances along a screen polyline, so anything can be placed at a length.
function measure(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return cum;
}
function at(pts, cum, d) {
  const total = cum[cum.length - 1];
  if (total <= 0) return null;
  if (d < 0 || d > total) return null;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const u = (d - cum[i - 1]) / seg;
  return { x: lerp(pts[i - 1].x, pts[i].x, u), y: lerp(pts[i - 1].y, pts[i].y, u) };
}

// What is in the bore. Not a dashed line: a body of liquid with a bright crown
// down its middle where the light catches the curve, soft bands travelling
// along it, and bubbles carried with the flow.
function fluid(ctx, pts, w, col, t, speed, kind) {
  const steam = kind === 'steam';
  const bore = w * 0.58;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.setLineDash([]);
  // standing body
  tracePts(ctx, pts);
  ctx.strokeStyle = withA(col, steam ? 0.34 : 0.95); ctx.lineWidth = bore; ctx.stroke();
  // the crown: the lit top of the liquid, which is what makes it read as round
  ctx.strokeStyle = withA(shade(col, 1.45), steam ? 0.30 : 0.55);
  ctx.lineWidth = bore * 0.34; ctx.stroke();

  if (speed > 0.015) {
    const cum = measure(pts), total = cum[cum.length - 1];
    const phase = t * speed * (steam ? 260 : 120);
    // three soft bands at staggered phases read as continuous motion rather
    // than as a row of dashes
    for (let k = 0; k < 3; k++) {
      const period = w * 3.4;
      ctx.setLineDash([w * 0.9, period - w * 0.9]);
      ctx.lineDashOffset = -((phase + k * period / 3) % period);
      ctx.strokeStyle = `rgba(255,255,255,${steam ? 0.20 : 0.13 - k * 0.03})`;
      ctx.lineWidth = bore * (0.92 - k * 0.16);
      tracePts(ctx, pts); ctx.stroke();
    }
    ctx.setLineDash([]);
    // things carried along, so the eye can follow one of them
    const n = Math.min(26, Math.max(2, Math.round(total / 46)));
    const spacing = total / n;
    for (let i = 0; i < n; i++) {
      const d = (((phase * 0.55 + i * spacing) % total) + total) % total;
      const q = at(pts, cum, d);
      if (!q) continue;
      const r = bore * (steam ? 0.36 : 0.2) * (0.7 + 0.6 * hash(i * 7));
      ctx.beginPath(); ctx.ellipse(q.x, q.y, r, r, 0, 0, TAU);
      ctx.fillStyle = steam ? 'rgba(240,250,255,0.55)' : 'rgba(236,250,255,0.62)';
      ctx.fill();
    }
  }
}
function pipeRun(ctx, pts3, w, tone, col, t, speed, kind) {
  const pts = scr(pts3);
  tube(ctx, pts, w, tone);
  if (col) fluid(ctx, pts, w, col, t, speed, kind);
  return pts;
}

// ---------------------------------------------------------------------------
// the containment: cut open on the near side so you can look straight in
// ---------------------------------------------------------------------------
const CUT0 = 0.17 * Math.PI;              // screen angle of the near-right cut
const CUT1 = Math.PI - CUT0;              // near-left cut
const gAngle = (theta) => theta - Math.PI / 4;   // screen angle -> grid angle

function shellFloor(ctx, p, st, t) {
  const s = G.shell;
  const c = project(s.x, s.y, 0);
  const rx = s.r * ERX, ry = s.r * ERY;
  ctx.beginPath(); ctx.ellipse(c.x, c.y, rx + 30, ry + 15, 0, 0, TAU);
  ctx.fillStyle = '#232c34'; ctx.fill();
  const g = ctx.createRadialGradient(c.x, c.y - ry * 0.5, rx * 0.08, c.x, c.y, rx * 1.05);
  g.addColorStop(0, '#55636f'); g.addColorStop(0.6, '#42505b'); g.addColorStop(1, '#313c46');
  ctx.beginPath(); ctx.ellipse(c.x, c.y, rx, ry, 0, 0, TAU);
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(14,20,26,0.5)'; ctx.lineWidth = 1.4; ctx.stroke();
  // grating rings, so the floor reads as a floor and gives the eye a scale
  ctx.strokeStyle = 'rgba(20,28,35,0.20)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath(); ctx.ellipse(c.x, c.y, rx * i / 4, ry * i / 4, 0, 0, TAU); ctx.stroke();
  }
  // water that has ended up on the containment floor
  const floorFrac = clamp((p.ctmtSump || 0) / 2.1e6, 0, 1);
  if (floorFrac > 0.004) {
    const zw = floorFrac * 2.4;
    const w = project(s.x, s.y, zw);
    const col = waterColor(Math.min(p.Tctmt || 330, 420));
    ctx.beginPath(); ctx.ellipse(w.x, w.y, rx * 0.985, ry * 0.985, 0, 0, TAU);
    ctx.fillStyle = withA(col, 0.82); ctx.fill();
    ctx.strokeStyle = 'rgba(220,242,255,0.35)'; ctx.lineWidth = 1.2; ctx.stroke();
    for (let i = 0; i < 3; i++) {
      const ph = ((t * 0.4 + i / 3) % 1);
      ctx.globalAlpha = 0.3 * (1 - ph);
      ctx.beginPath();
      ctx.ellipse(w.x, w.y, rx * 0.985 * (0.2 + ph * 0.78), ry * 0.985 * (0.2 + ph * 0.78), 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function shellWall(ctx, p, st) {
  const s = G.shell;
  const b = project(s.x, s.y, 0), tp = project(s.x, s.y, s.h);
  const rx = s.r * ERX, ry = s.r * ERY;
  const broken = !p.ctmtIntact;
  const base = broken ? '#7b564e' : '#68788a';
  // inner face of the far wall
  ctx.beginPath();
  ctx.ellipse(tp.x, tp.y, rx, ry, 0, CUT1, CUT0 + TAU);
  ctx.ellipse(b.x, b.y, rx, ry, 0, CUT0 + TAU, CUT1, true);
  ctx.closePath();
  const g = ctx.createLinearGradient(b.x - rx, 0, b.x + rx, 0);
  g.addColorStop(0, shade(base, 0.42));
  g.addColorStop(0.28, shade(base, 0.80));
  g.addColorStop(0.5, shade(base, 0.96));
  g.addColorStop(0.72, shade(base, 0.78));
  g.addColorStop(1, shade(base, 0.46));
  ctx.fillStyle = g; ctx.fill();
  // vertical ribs
  ctx.save(); ctx.clip();
  ctx.strokeStyle = 'rgba(16,22,28,0.16)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 18; i++) {
    const a = CUT1 + (CUT0 + TAU - CUT1) * (i / 18);
    ctx.beginPath();
    ctx.moveTo(b.x + rx * Math.cos(a), b.y + ry * Math.sin(a));
    ctx.lineTo(tp.x + rx * Math.cos(a), tp.y + ry * Math.sin(a));
    ctx.stroke();
  }
  ctx.restore();
  // the top of the wall, showing its thickness
  const kr = 1.045;
  ctx.beginPath();
  ctx.ellipse(tp.x, tp.y, rx, ry, 0, CUT1, CUT0 + TAU);
  ctx.ellipse(tp.x, tp.y, rx * kr, ry * kr, 0, CUT0 + TAU, CUT1, true);
  ctx.closePath();
  ctx.fillStyle = shade(base, 1.12); ctx.fill();
  ctx.strokeStyle = 'rgba(12,18,24,0.45)'; ctx.lineWidth = 1; ctx.stroke();
  if (broken) wallDamage(ctx, p);
  // the two cut ends, drawn solid so the wall reads as sliced rather than torn
  for (const a of [CUT0, CUT1]) {
    const ca = Math.cos(a), sa = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(b.x + rx * ca, b.y + ry * sa);
    ctx.lineTo(b.x + rx * kr * ca, b.y + ry * kr * sa);
    ctx.lineTo(tp.x + rx * kr * ca, tp.y + ry * kr * sa);
    ctx.lineTo(tp.x + rx * ca, tp.y + ry * sa);
    ctx.closePath();
    ctx.fillStyle = broken ? '#8d5f52' : '#9fb0bd'; ctx.fill();
    ctx.strokeStyle = 'rgba(12,18,24,0.5)'; ctx.stroke();
  }
}

// Where the wall failed. A colour change is not damage; a hole is.
const BREACH_A = Math.PI * 1.42;
function breachOutline(ctx, s, spread) {
  const b = project(s.x, s.y, 0), tp = project(s.x, s.y, s.h);
  const rx = s.r * ERX * 1.04, ry = s.r * ERY * 1.04, H = b.y - tp.y;
  const zc = 0.52, zh = 0.30, n = 15;
  const pt = (u, upper) => {
    const a = BREACH_A - spread + u * spread * 2;
    const half = Math.sqrt(Math.max(0, 1 - Math.pow(2 * u - 1, 2)));
    const rough = (hash((upper ? 31 : 57) + Math.round(u * n) * 7) - 0.5) * 0.09;
    const zz = clamp(zc + (upper ? 1 : -1) * (zh * half + rough * half), 0.03, 0.97);
    return { x: b.x + rx * Math.cos(a), y: b.y + ry * Math.sin(a) - H * zz };
  };
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const q = pt(i / n, true);
    if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
  }
  for (let i = n; i >= 0; i--) {
    const q = pt(i / n, false);
    ctx.lineTo(q.x, q.y);
  }
  ctx.closePath();
}
function wallDamage(ctx, p) {
  const s = G.shell;
  const spread = 0.15 + Math.min(3, p.explosions || 0) * 0.035;
  // the hole itself: you see the night on the other side
  breachOutline(ctx, s, spread);
  ctx.fillStyle = '#080d13'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,150,92,0.30)'; ctx.lineWidth = 6; ctx.stroke();
  ctx.strokeStyle = '#c98259'; ctx.lineWidth = 1.8; ctx.stroke();
  // cracks running away from it
  const b = project(s.x, s.y, 0), tp = project(s.x, s.y, s.h);
  ctx.strokeStyle = 'rgba(20,12,10,0.6)'; ctx.lineWidth = 1.6;
  for (let k = 0; k < 7; k++) {
    const a0 = BREACH_A + (hash(k * 11) - 0.5) * 1.7;
    const z0 = 0.2 + 0.6 * hash(k * 13);
    ctx.beginPath();
    for (let i = 0; i <= 5; i++) {
      const a = a0 + (i / 5) * (hash(k * 17) - 0.5) * 0.7;
      const zz = z0 + (i / 5) * (hash(k * 19) - 0.5) * 0.6;
      const x = b.x + s.r * ERX * Math.cos(a);
      const y = b.y + s.r * ERY * Math.sin(a) - (b.y - tp.y) * clamp(zz, 0.02, 0.98);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
// Steam driven out through the hole, and rubble at the foot of it.
function breachPlume(ctx, p, t) {
  const s = G.shell;
  const b = project(s.x, s.y, 0), tp = project(s.x, s.y, s.h);
  const cx = b.x + s.r * ERX * Math.cos(BREACH_A);
  const cy = b.y + s.r * ERY * Math.sin(BREACH_A) - (b.y - tp.y) * 0.52;
  for (let i = 0; i < 14; i++) {
    const ph = ((t * 0.34 + hash(i * 23)) % 1);
    ctx.fillStyle = `rgba(214,202,194,${0.4 * (1 - ph)})`;
    ctx.beginPath();
    ctx.ellipse(cx + (hash(i) - 0.5) * 44 - ph * 14, cy - 6 - ph * 96,
      12 + ph * 30, 7 + ph * 19, 0, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(46,38,34,0.85)';
  for (let i = 0; i < 12; i++) {
    const a = BREACH_A + (hash(i * 7) - 0.5) * 0.7;
    const rr = s.r * (0.98 + hash(i * 5) * 0.16);
    const q = project(s.x + rr * Math.cos(a - Math.PI / 4), s.y + rr * Math.sin(a - Math.PI / 4), 0);
    const sz = 3 + hash(i * 3) * 5;
    ctx.beginPath(); ctx.ellipse(q.x, q.y, sz, sz * 0.55, 0, 0, TAU); ctx.fill();
  }
}

function meridian(ctx, s, theta, move) {
  const a = gAngle(theta), ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 0; i <= 14; i++) {
    const ph = (i / 14) * (Math.PI / 2);
    const q = project(s.x + s.r * Math.cos(ph) * ca, s.y + s.r * Math.cos(ph) * sa,
      s.h + s.domeH * Math.sin(ph));
    if (i === 0 && move) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
  }
}
function domePath(ctx) {
  const s = G.shell;
  const tp = project(s.x, s.y, s.h);
  const rx = s.r * ERX, ry = s.r * ERY;
  ctx.beginPath();
  ctx.ellipse(tp.x, tp.y, rx, ry, 0, CUT1, CUT0 + TAU);
  meridian(ctx, s, CUT0, false);
  const a = gAngle(CUT1), ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 14; i >= 0; i--) {
    const ph = (i / 14) * (Math.PI / 2);
    const q = project(s.x + s.r * Math.cos(ph) * ca, s.y + s.r * Math.cos(ph) * sa,
      s.h + s.domeH * Math.sin(ph));
    ctx.lineTo(q.x, q.y);
  }
  ctx.closePath();
}

// The polar crane. Every reactor building has one, running on a rail round the
// inside of the wall, and it is what the space above the machines is for.
function polarCrane(ctx, t) {
  const s = G.shell;
  const railZ = 11.9, girdZ = 12.05, girdH = 0.5;
  const c = project(s.x, s.y, railZ);
  // the rail ring, on the half of the wall that is still there
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, s.r * 0.965 * ERX, s.r * 0.965 * ERY, 0, CUT1, CUT0 + TAU);
  ctx.strokeStyle = 'rgba(150,166,180,0.55)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, s.r * 0.965 * ERX, s.r * 0.965 * ERY, 0, CUT1, CUT0 + TAU);
  ctx.strokeStyle = 'rgba(20,28,36,0.5)'; ctx.lineWidth = 1; ctx.stroke();
  // the bridge, spanning the far half
  const gy = 8.0, dy = gy - s.y;
  const half = Math.sqrt(Math.max(0, s.r * s.r * 0.93 - dy * dy));
  const x0 = s.x - half, x1 = s.x + half;
  box(ctx, { x: x0, y: gy - 0.42, z: girdZ, w: x1 - x0, d: 0.84, h: girdH,
    color: '#8b98a4', top: '#9dabb7' });
  // end trucks
  for (const ex of [x0, x1 - 1.1]) {
    box(ctx, { x: ex, y: gy - 0.72, z: railZ, w: 1.1, d: 1.44, h: girdZ - railZ + 0.2,
      color: '#6f7c88' });
  }
  // the trolley, parked where it was left
  const tx = s.x + 2.1;
  box(ctx, { x: tx, y: gy - 0.66, z: girdZ + girdH, w: 1.5, d: 1.32, h: 0.62,
    color: '#98a6b2', top: '#aab8c4' });
  // hoist rope and block
  const a = project(tx + 0.75, gy, girdZ + girdH * 0.5);
  const b = project(tx + 0.75, gy, girdZ - 1.6);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = 'rgba(206,218,228,0.8)'; ctx.lineWidth = 1.4; ctx.stroke();
  box(ctx, { x: tx + 0.45, y: gy - 0.3, z: girdZ - 2.1, w: 0.6, d: 0.6, h: 0.5,
    color: '#c2a04a', top: '#d6b45c' });
}

// Handrail along the near edge of the cut floor. A grating floor with nothing
// on its edge reads as a shape; a floor with a rail on it reads as a place
// somebody works in.
function railArc(ctx, a0, a1, r, z, n) {
  const s = G.shell;
  const post = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    const g = gAngle(a);
    post.push([s.x + r * Math.cos(g), s.y + r * Math.sin(g)]);
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
  for (const h of [1.05, 0.6]) {
    ctx.beginPath();
    for (let i = 0; i < post.length; i++) {
      const q = project(post[i][0], post[i][1], z + h);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = 'rgba(10,16,22,0.5)'; ctx.lineWidth = 3.4; ctx.stroke();
    ctx.strokeStyle = h > 0.9 ? '#a9bac6' : '#7c8b98'; ctx.lineWidth = 2; ctx.stroke();
  }
  for (let i = 0; i < post.length; i += 2) {
    const a = project(post[i][0], post[i][1], z);
    const b = project(post[i][0], post[i][1], z + 1.05);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(10,16,22,0.5)'; ctx.lineWidth = 3.4; ctx.stroke();
    ctx.strokeStyle = '#8b9aa6'; ctx.lineWidth = 2; ctx.stroke();
  }
}

// Hatch covers and plates, so the floor has something on it.
function floorPlates(ctx) {
  const s = G.shell;
  const c = project(s.x, s.y, 0);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, s.r * ERX * 0.98, s.r * ERY * 0.98, 0, 0, TAU);
  ctx.clip();
  const spots = [[13.4, 4.6], [5.6, 5.8], [16.4, 11.6], [10.6, 4.2], [5.0, 16.2]];
  for (let i = 0; i < spots.length; i++) {
    const [x, y] = spots[i];
    const w = 1.5 + hash(i * 5) * 0.8, d = 1.2 + hash(i * 9) * 0.7;
    const a = project(x, y, 0.04), b = project(x + w, y, 0.04),
      c = project(x + w, y + d, 0.04), e = project(x, y + d, 0.04);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(e.x, e.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(96,112,126,0.30)'; ctx.fill();
    ctx.strokeStyle = 'rgba(160,180,196,0.25)'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.restore();
}

// The roof is glass on purpose: the pool and the top of the boiler are the two
// things a viewer most needs to see, and a solid roof hides both.
function glassDome(ctx, p, st, t) {
  const s = G.shell;
  const tp = project(s.x, s.y, s.h);
  const rx = s.r * ERX, ry = s.r * ERY;
  const hot = st.sink === 'shell';
  const tint = !p.ctmtIntact ? '#c07a68' : hot ? '#7fc9d8' : '#93a9b8';
  domePath(ctx);
  const g = ctx.createLinearGradient(tp.x - rx, tp.y - s.domeH * TZ, tp.x + rx, tp.y);
  g.addColorStop(0, rgba(tint, 0.30));
  g.addColorStop(0.34, rgba(tint, 0.07));
  g.addColorStop(0.6, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, rgba(tint, 0.26));
  ctx.fillStyle = g; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.strokeStyle = rgba(tint, 0.26); ctx.lineWidth = 1;
  for (let i = 1; i <= 5; i++) {
    const ph = (i / 6) * (Math.PI / 2);
    const rr = s.r * Math.cos(ph), q = project(s.x, s.y, s.h + s.domeH * Math.sin(ph));
    ctx.beginPath(); ctx.ellipse(q.x, q.y, rr * ERX, rr * ERY, 0, 0, TAU); ctx.stroke();
  }
  for (let i = 0; i <= 10; i++) {
    ctx.beginPath();
    meridian(ctx, s, CUT1 + (CUT0 + TAU - CUT1) * (i / 10), true);
    ctx.stroke();
  }
  // water running down the outside of the steel, the passive plant's last sink
  if (st.s.film > 0 || st.s.pccs > 0.05) {
    ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const th = CUT1 + (CUT0 + TAU - CUT1) * ((i + 0.5) / 12);
      const ph0 = ((t * 0.36 + hash(i * 7)) % 1);
      const a = gAngle(th), ca = Math.cos(a), sa = Math.sin(a);
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const ph = (Math.PI / 2) * clamp(1 - ph0 - k * 0.045, 0, 1);
        const q = project(s.x + s.r * Math.cos(ph) * ca, s.y + s.r * Math.cos(ph) * sa,
          s.h + s.domeH * Math.sin(ph));
        if (k === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = `rgba(126,220,246,${0.22 + 0.4 * (1 - ph0)})`;
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.strokeStyle = rgba(tint, 0.75); ctx.lineWidth = 1.6;
  domePath(ctx); ctx.stroke();
}

// Air moving up the outside of the shell. Drawn beyond the silhouette so it
// cannot be mistaken for something happening inside.
function shellAir(ctx, p, st, t) {
  const s = G.shell;
  const strength = st.sink === 'shell' ? 1 : clamp(st.s.pccs || 0, 0, 1);
  if (strength < 0.06) return;
  const c = project(s.x, s.y, s.h * 0.4);
  const rx = s.r * ERX * 1.10, ry = s.r * ERY * 1.10;
  ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const ph = ((t * 0.42 + i / 6) % 1);
      const yy = c.y + ry * 0.9 - ph * (s.h * TZ * 1.35);
      const xx = c.x + side * (rx + 8 + 5 * Math.sin(ph * 4 + i));
      const w = 9 * (0.5 + 0.5 * Math.sin(ph * Math.PI));
      ctx.strokeStyle = `rgba(180,225,240,${0.42 * strength * Math.sin(ph * Math.PI)})`;
      ctx.beginPath();
      ctx.moveTo(xx - w, yy + 5); ctx.lineTo(xx, yy); ctx.lineTo(xx + w, yy + 5);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// the machines
// ---------------------------------------------------------------------------

// A fuel bundle: standing rods, so "the water covers the fuel" is something you
// can see rather than a number you have to trust.
const RODS = (() => {
  const out = [];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const dx = i * 0.66, dy = j * 0.66;
      if (Math.hypot(dx, dy) > 1.55) continue;
      out.push({ dx, dy });
    }
  }
  out.sort((a, b) => (a.dx + a.dy) - (b.dx + b.dy));
  return out;
})();

function fuelBundle(ctx, p, st, t) {
  const g = G.core, k = g.r * 0.66 / 1.55;
  const heat = clamp((p.Tclad - 620) / 620, 0, 1);
  const dam = clamp(p.coreDamage, 0, 1);
  const col = mix('#6d7b86', tempColor(p.Tclad), heat);
  const top = FUEL_Z1 - dam * (FUEL_Z1 - FUEL_Z0) * 0.55;
  ctx.lineCap = 'round'; ctx.setLineDash([]);
  for (let i = 0; i < RODS.length; i++) {
    const r = RODS[i];
    const slump = dam * (0.35 + 0.5 * hash(i * 3 + 1));
    const a = project(g.x + r.dx * k, g.y + r.dy * k, FUEL_Z0);
    const b = project(g.x + r.dx * k, g.y + r.dy * k, top - slump * (top - FUEL_Z0));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(6,10,14,0.7)'; ctx.lineWidth = 8.6; ctx.stroke();
    ctx.strokeStyle = shade(col, 0.86 + 0.3 * hash(i * 5)); ctx.lineWidth = 6.4; ctx.stroke();
    ctx.strokeStyle = shade(col, 1.5); ctx.lineWidth = 2.2; ctx.stroke();
  }
  // grid straps, which is what a real assembly is held together with
  ctx.strokeStyle = 'rgba(190,205,216,0.30)'; ctx.lineWidth = 2;
  for (const f of [0.22, 0.55, 0.86]) {
    const zz = FUEL_Z0 + (FUEL_Z1 - FUEL_Z0) * f;
    if (zz > top) continue;
    const q = project(g.x, g.y, zz);
    ctx.beginPath(); ctx.ellipse(q.x, q.y, 1.62 * k * ERX, 1.62 * k * ERY, 0, 0, TAU); ctx.stroke();
  }
  // heat, as light coming off the bundle
  if (heat > 0.12) {
    const c0 = project(g.x, g.y, (FUEL_Z0 + top) / 2);
    const gr = ctx.createRadialGradient(c0.x, c0.y, 4, c0.x, c0.y, g.r * 1.15 * ERX);
    gr.addColorStop(0, withA(tempColor(p.Tclad), 0.5 * heat));
    gr.addColorStop(1, withA(tempColor(p.Tclad), 0));
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.ellipse(c0.x, c0.y, g.r * 1.25 * ERX, (top - FUEL_Z0) * TZ * 0.75 + g.r * 1.25 * ERY, 0, 0, TAU);
    ctx.fill();
  }
  // once it has melted, what is left is a pool of it on the bottom head
  if (dam > 0.35) {
    const q = project(g.x, g.y, g.z + 0.45);
    const rr = g.r * (0.5 + dam * 0.42);
    ctx.beginPath(); ctx.ellipse(q.x, q.y, rr * ERX, rr * ERY, 0, 0, TAU);
    const mg = ctx.createRadialGradient(q.x, q.y - 4, 2, q.x, q.y, rr * ERX);
    mg.addColorStop(0, tempColor(Math.max(p.Tclad, 2100)));
    mg.addColorStop(1, '#5d1608');
    ctx.fillStyle = mg; ctx.fill();
  }
}

function drawReactor(ctx, p, st, t) {
  const g = G.core;
  const o = { x: g.x, y: g.y, z: g.z, h: g.h, r: g.r, prof: CAPSULE };
  shadow(ctx, g.x, g.y, 0, g.r * ERX * 1.15, g.r * ERY * 1.15, 0.4);
  // the support skirt it stands on
  cylinder(ctx, { x: g.x, y: g.y, z: 0, r: g.r * 0.78, h: g.z + 0.6, color: '#4b5866', rib: 3 });
  ctx.save();
  revolvePath(ctx, o); ctx.clip();
  vesselInside(ctx, o);
  fuelBundle(ctx, p, st, t);
  ctx.restore();
  const wcol = waterColor(p.Tclad);
  const surf = liquidIn(ctx, o, waterZ(st.lvl), wcol, t, st.s.boil || 0, 0.54);
  if (surf) {
    ctx.save(); revolvePath(ctx, o); ctx.clip();
    steamSpace(ctx, o, surf.y, clamp((st.s.boil || 0) * 2.2, 0, 1));
    ctx.restore();
  }
  // steam in the space above the water
  if ((st.s.boil || 0) > 0.03 && surf) {
    ctx.save(); revolvePath(ctx, o); ctx.clip();
    for (let i = 0; i < 9; i++) {
      const ph = ((t * 0.5 + hash(i * 11)) % 1);
      const yy = surf.y - ph * (g.h * TZ * 0.3);
      const xx = surf.x + (hash(i + 4) - 0.5) * surf.rx * 1.5;
      ctx.fillStyle = `rgba(226,240,248,${0.30 * (1 - ph) * clamp(st.s.boil * 2, 0, 1)})`;
      ctx.beginPath(); ctx.ellipse(xx, yy, 6 + ph * 9, 4 + ph * 6, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  // Make-up water arriving. The head is cut open, so you watch it land.
  if (st.injecting && !p.vesselBreach) {
    ctx.save(); revolvePath(ctx, o); ctx.clip();
    pour(ctx, g.x - 0.35, g.y - 0.35, g.z + g.h * 0.84, waterZ(st.lvl) + 0.05,
      t, heatedWater(0.04), 7);
    ctx.restore();
  }
  glassShell(ctx, o, p.vesselBreach ? '#b4746a' : C.steel);
  vesselHead(ctx, o, p.vesselBreach ? '#b4746a' : C.steel);
  // control rod drives on the head, so the reactor looks like a reactor
  ctx.strokeStyle = 'rgba(206,220,230,0.85)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3;
    const dx = Math.cos(a) * g.r * 0.42, dy = Math.sin(a) * g.r * 0.42;
    if (dx + dy > 0) continue;                     // the near half is cut away
    const z0 = g.z + g.h - 0.25 * Math.hypot(dx, dy) / (g.r * 0.42);
    const q0 = project(g.x + dx, g.y + dy, z0);
    const q1 = project(g.x + dx, g.y + dy, z0 + 1.2);
    ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
  }
  ctx.lineCap = 'butt';
  if (p.vesselBreach) {
    const b = project(g.x, g.y, g.z + 0.15);
    ctx.fillStyle = '#1a0d09';
    ctx.beginPath(); ctx.ellipse(b.x, b.y + 4, 16, 8, 0, 0, TAU); ctx.fill();
    for (let i = 0; i < 5; i++) {
      const ph = ((t * 0.8 + i / 5) % 1);
      ctx.fillStyle = `rgba(255,110,50,${0.7 * (1 - ph)})`;
      ctx.beginPath();
      ctx.ellipse(b.x + (hash(i) - 0.5) * 16, b.y + 6 + ph * 22, 4 - ph * 2.4, 6 - ph * 3, 0, 0, TAU);
      ctx.fill();
    }
  }
}

function drawBoiler(ctx, p, st, t) {
  const g = G.sg;
  const o = { x: g.x, y: g.y, z: g.z, h: g.h, r: g.r, prof: CAPSULE };
  shadow(ctx, g.x, g.y, 0, g.r * ERX * 1.15, g.r * ERY * 1.15, 0.4);
  cylinder(ctx, { x: g.x, y: g.y, z: 0, r: g.r * 0.8, h: g.z + 0.5, color: '#4b5866', rib: 2 });
  ctx.save();
  revolvePath(ctx, o); ctx.clip();
  vesselInside(ctx, o);
  // the U-tube bundle. The primary water goes up one leg and down the other
  // without ever mixing with the water on the other side — which is the whole
  // reason a boiler is here at all.
  const hot = st.sink === 'turbine' ? 1 : 0;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 1; i <= 3; i++) {
    const dx = i * 0.30;
    const zTop = g.z + g.h * (0.26 + i * 0.05);
    const a = project(g.x - dx, g.y, SG_OUT_Z + 0.3);
    const b = project(g.x - dx, g.y, zTop);
    const c = project(g.x + dx, g.y, zTop);
    const d = project(g.x + dx, g.y, SG_OUT_Z + 0.3);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.quadraticCurveTo((b.x + c.x) / 2, b.y - dx * 26, c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.strokeStyle = 'rgba(24,34,44,0.6)'; ctx.lineWidth = 7.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(158,178,192,0.85)'; ctx.lineWidth = 5.5; ctx.stroke();
    ctx.strokeStyle = hot ? withA(waterColor(p.Tclad), 0.95) : 'rgba(96,122,142,0.7)';
    ctx.lineWidth = 2.8;
    if (hot) { ctx.setLineDash([7, 11]); ctx.lineDashOffset = -((t * 90) % 18); }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // secondary water: this side boils and the steam goes to the turbine
  const sfrac = st.sink === 'turbine' ? 0.62 : 0.42;
  ctx.restore();
  const ssurf = liquidIn(ctx, o, g.z + g.h * sfrac, heatedWater(hot ? 0.20 : 0.02),
    t, hot ? 0.7 : 0.05, 0.62);
  if (ssurf) {
    ctx.save(); revolvePath(ctx, o); ctx.clip();
    steamSpace(ctx, o, ssurf.y, hot ? 0.85 : 0.15);
    ctx.restore();
  }
  glassShell(ctx, o, C.steel);
  vesselHead(ctx, o, C.steel);
  // steam leaving the top when it is actually taking heat away
  if (hot) {
    const q = project(g.x, g.y, g.z + g.h);
    for (let i = 0; i < 7; i++) {
      const ph = ((t * 0.55 + hash(i * 13)) % 1);
      ctx.fillStyle = `rgba(214,232,244,${0.42 * (1 - ph)})`;
      ctx.beginPath();
      ctx.ellipse(q.x + (hash(i) - 0.5) * 26 + ph * 18, q.y - 8 - ph * 46,
        7 + ph * 12, 4 + ph * 8, 0, 0, TAU);
      ctx.fill();
    }
  }
}

// The pump, cut open from above. A grey drum with a spinner on it says
// nothing; an impeller turning in a casing full of water, with the suction on
// one side and the discharge on the other, says what a pump is for.
function drawPump(ctx, p, st, t) {
  const g = G.pump;
  const drive = clamp(st.s.rcp || 0, 0, 1);
  const live = drive > 0.01;
  const creep = !live && (st.s.natCirc || 0) > 0.01;
  const spin = t * (live ? 4.2 : creep ? 0.25 : 0);
  const casZ = g.z, casH = 1.5;
  const topZ = casZ + casH;
  shadow(ctx, g.x, g.y, 0, g.r * ERX * 1.35, g.r * ERY * 1.35, 0.38);
  cylinder(ctx, { x: g.x, y: g.y, z: 0, r: g.r * 0.62, h: casZ, color: '#48545f', rib: 3 });
  cylinder(ctx, { x: g.x, y: g.y, z: casZ, r: g.r, h: casH, color: '#7c8b98', cap: false });

  const c = project(g.x, g.y, topZ);
  const RX = g.r * ERX, RY = g.r * ERY;
  // the cut rim of the casing
  ctx.beginPath(); ctx.ellipse(c.x, c.y, RX, RY, 0, 0, TAU);
  ctx.fillStyle = shade('#7c8b98', 1.12); ctx.fill();
  ctx.strokeStyle = 'rgba(12,18,24,0.55)'; ctx.lineWidth = 1.2; ctx.stroke();

  const iR = 0.84;
  ctx.save();
  ctx.beginPath(); ctx.ellipse(c.x, c.y, RX * iR, RY * iR, 0, 0, TAU); ctx.clip();
  // the cavity, and the water standing in it
  ctx.fillStyle = '#111b24'; ctx.fill();
  const wcol = waterColor(p.Tclad);
  ctx.fillStyle = withA(wcol, 0.9); ctx.fill();
  // water thrown round the volute: streaks that turn with the impeller
  ctx.strokeStyle = 'rgba(240,252,255,0.5)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const a0 = spin * 0.8 + (i / 7) * TAU;
    ctx.beginPath();
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      const a = a0 + u * 0.9, rr = iR * (0.42 + u * 0.56);
      const x = c.x + Math.cos(a) * RX * rr, y = c.y + Math.sin(a) * RY * rr;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = live ? 0.5 : creep ? 0.22 : 0.1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // the impeller: backward-curved vanes, which is what actually throws the water
  for (let i = 0; i < 6; i++) {
    const a0 = spin + (i / 6) * TAU;
    ctx.beginPath();
    for (let k = 0; k <= 10; k++) {
      const u = k / 10;
      const a = a0 - u * 1.05, rr = 0.2 + u * 0.62;
      const x = c.x + Math.cos(a) * RX * rr, y = c.y + Math.sin(a) * RY * rr;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(14,22,30,0.75)'; ctx.lineWidth = 5.2; ctx.stroke();
    ctx.strokeStyle = live ? '#c3d4de' : '#8593a0'; ctx.lineWidth = 3.4; ctx.stroke();
  }
  ctx.restore();
  // hub
  ctx.beginPath(); ctx.ellipse(c.x, c.y, RX * 0.2, RY * 0.2, 0, 0, TAU);
  ctx.fillStyle = shade('#9aa9b5', live ? 1.15 : 0.9); ctx.fill();
  ctx.strokeStyle = 'rgba(12,18,24,0.6)'; ctx.lineWidth = 1; ctx.stroke();

  // the stand and the motor above it, glass so the impeller stays visible
  const mz = topZ + 0.9, mh = 1.9;
  ctx.strokeStyle = 'rgba(150,166,178,0.85)'; ctx.lineWidth = 2.4;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const dx = Math.cos(a) * g.r * 0.8, dy = Math.sin(a) * g.r * 0.8;
    const q0 = project(g.x + dx, g.y + dy, topZ), q1 = project(g.x + dx, g.y + dy, mz);
    ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
  }
  const s0 = project(g.x, g.y, topZ), s1 = project(g.x, g.y, mz + mh);
  ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y);
  ctx.strokeStyle = live ? '#dce9f2' : '#6b757d'; ctx.lineWidth = 3; ctx.stroke();
  cylinder(ctx, {
    x: g.x, y: g.y, z: mz, r: g.r * 0.58, h: mh, rib: 4,
    color: live ? '#8fa2ae' : '#69737b', alpha: 0.72
  });
  const lamp = project(g.x, g.y, mz + mh + 0.12);
  ctx.beginPath(); ctx.ellipse(lamp.x, lamp.y, 3.4, 2.2, 0, 0, TAU);
  ctx.fillStyle = live ? C.ok : creep ? C.warn : C.bad; ctx.fill();
}

// A basin you look down into// A basin you look down into: clip to the opening, draw the far inner walls,
// then the water, then lay the rim back on top.
function drawBasin(ctx, b, frac, col, t, opts = {}) {
  const w = opts.wall || 0.34;
  const zt = b.z + b.h, zb = b.z;
  const O = (x, y, z) => project(x, y, z);
  const x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1;
  const i0 = x0 + w, j0 = y0 + w, i1 = x1 - w, j1 = y1 - w;
  const tone = opts.tone || '#5f6f7c';
  // outer body: the two faces that lean toward the camera
  const A = O(x0, y0, zt), B = O(x1, y0, zt), Cc = O(x1, y1, zt), D = O(x0, y1, zt);
  const Bb = O(x1, y0, zb), Cb = O(x1, y1, zb), Db = O(x0, y1, zb);
  ctx.fillStyle = shade(tone, 0.86);
  ctx.beginPath(); ctx.moveTo(B.x, B.y); ctx.lineTo(Cc.x, Cc.y); ctx.lineTo(Cb.x, Cb.y); ctx.lineTo(Bb.x, Bb.y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(tone, 0.70);
  ctx.beginPath(); ctx.moveTo(D.x, D.y); ctx.lineTo(Cc.x, Cc.y); ctx.lineTo(Cb.x, Cb.y); ctx.lineTo(Db.x, Db.y); ctx.closePath(); ctx.fill();
  // the opening, as a window into the cavity
  const a = O(i0, j0, zt), bq = O(i1, j0, zt), c = O(i1, j1, zt), d = O(i0, j1, zt);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x, a.y); ctx.lineTo(bq.x, bq.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
  ctx.closePath(); ctx.clip();
  // far inner walls and the floor
  const fa = O(i0, j0, zb), fb = O(i1, j0, zb), fd = O(i0, j1, zb), fc = O(i1, j1, zb);
  ctx.fillStyle = shade(tone, 0.40);
  ctx.beginPath(); ctx.moveTo(fa.x, fa.y); ctx.lineTo(fb.x, fb.y); ctx.lineTo(fc.x, fc.y); ctx.lineTo(fd.x, fd.y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(tone, 0.55);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bq.x, bq.y); ctx.lineTo(fb.x, fb.y); ctx.lineTo(fa.x, fa.y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(tone, 0.48);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(d.x, d.y); ctx.lineTo(fd.x, fd.y); ctx.lineTo(fa.x, fa.y); ctx.closePath(); ctx.fill();
  if (opts.inside) opts.inside(ctx);
  const f = clamp(frac, 0, 1);
  if (f > 0.006) {
    const zw = zb + (zt - zb) * f;
    const wob = Math.sin(t * 1.7) * 1.0;
    const wa = O(i0, j0, zw), wb = O(i1, j0, zw), wc = O(i1, j1, zw), wd = O(i0, j1, zw);
    // the body of water, down to the floor
    ctx.fillStyle = withA(col, 0.7);
    ctx.beginPath();
    ctx.moveTo(wa.x, wa.y + wob); ctx.lineTo(wb.x, wb.y + wob); ctx.lineTo(wc.x, wc.y + wob);
    ctx.lineTo(fc.x, fc.y); ctx.lineTo(fd.x, fd.y); ctx.lineTo(fa.x, fa.y);
    ctx.closePath(); ctx.fill();
    // the surface
    ctx.beginPath();
    ctx.moveTo(wa.x, wa.y + wob); ctx.lineTo(wb.x, wb.y + wob);
    ctx.lineTo(wc.x, wc.y + wob); ctx.lineTo(wd.x, wd.y + wob); ctx.closePath();
    const gg = ctx.createLinearGradient(wd.x, wa.y, wb.x, wc.y);
    gg.addColorStop(0, shade(col, 1.34));
    gg.addColorStop(0.5, shade(col, 1.05));
    gg.addColorStop(1, shade(col, 1.42));
    ctx.fillStyle = gg; ctx.fill();
    // ripples running across it
    ctx.strokeStyle = 'rgba(228,246,255,0.42)'; ctx.lineWidth = 1.3;
    const cx = (wa.x + wc.x) / 2, cy = (wa.y + wc.y) / 2 + wob;
    for (let i = 0; i < 3; i++) {
      const ph = ((t * 0.42 + i / 3) % 1);
      ctx.globalAlpha = 0.4 * (1 - ph);
      ctx.beginPath();
      ctx.ellipse(cx, cy, (i1 - i0) * ERX * 0.5 * (0.15 + ph * 0.8),
        (j1 - j0) * ERY * 0.5 * (0.15 + ph * 0.8), 0, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (opts.boil > 0.02) {
      ctx.fillStyle = 'rgba(240,252,255,0.6)';
      for (let i = 0; i < 12; i++) {
        const ph = ((t * 0.7 + hash(i * 9)) % 1);
        ctx.globalAlpha = 0.5 * Math.sin(ph * Math.PI) * clamp(opts.boil, 0, 1);
        const px = cx + (hash(i) - 0.5) * (i1 - i0) * ERX * 0.9;
        const py = cy + (hash(i + 20) - 0.5) * (j1 - j0) * ERY * 0.9;
        ctx.beginPath(); ctx.ellipse(px, py - ph * 5, 2 + ph * 3, 1.3 + ph * 1.8, 0, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  // rim
  const rim = [[A, B, bq, a], [B, Cc, c, bq], [Cc, D, d, c], [D, A, a, d]];
  ctx.fillStyle = shade(tone, 1.12);
  for (const q of rim) {
    ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i].x, q[i].y);
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(14,20,26,0.42)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(Cc.x, Cc.y); ctx.lineTo(D.x, D.y); ctx.closePath(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bq.x, bq.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.stroke();
}

// The pool that sits above the reactor on the passive plant. The heat exchanger
// coil is drawn inside it, under the water, because that is where it is.
function drawPool(ctx, p, st, t) {
  const b = G.pool;
  // the legs it stands on
  const feet = [[b.x0 + 0.4, b.y0 + 0.4], [b.x1 - 0.4, b.y0 + 0.4],
    [b.x0 + 0.4, b.y1 - 0.4], [b.x1 - 0.4, b.y1 - 0.4]];
  // cross-bracing first, so the columns stand in front of it
  ctx.strokeStyle = 'rgba(96,112,126,0.75)'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  for (const [i, j] of [[0, 3], [1, 2]]) {
    for (const zz of [b.z * 0.34, b.z * 0.68]) {
      const a = project(feet[i][0], feet[i][1], zz - 0.6);
      const c = project(feet[j][0], feet[j][1], zz + 0.6);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
    }
  }
  // a caged ladder up the near column
  {
    const [lx, ly] = feet[3];
    ctx.strokeStyle = 'rgba(168,186,200,0.7)'; ctx.lineWidth = 1.4;
    for (let z = 0.5; z < b.z; z += 0.55) {
      const p0 = project(lx - 0.34, ly + 0.34, z), p1 = project(lx + 0.34, ly - 0.34, z);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
    for (const d of [-0.34, 0.34]) {
      const p0 = project(lx + d, ly - d, 0.4), p1 = project(lx + d, ly - d, b.z);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
  }
  for (const [lx, ly] of feet) {
    shadow(ctx, lx, ly, 0, 15, 8, 0.34);
    const a = project(lx, ly, 0), c = project(lx, ly, b.z);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y);
    ctx.strokeStyle = 'rgba(10,16,22,0.55)'; ctx.lineWidth = 11; ctx.stroke();
    ctx.strokeStyle = '#5f6e7c'; ctx.lineWidth = 7.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(160,180,196,0.5)'; ctx.lineWidth = 2; ctx.stroke();
  }
  const frac = 0.08 + 0.86 * clamp(p.irwst / 2.1e6, 0, 1);
  const warming = (st.s.prhr || 0) > 0;
  const col = heatedWater(warming ? 0.42 : 0.06);
  const flowing = warming ? 1 : 0.12;
  drawBasin(ctx, b, frac, col, t, {
    tone: p.irwstCracked ? '#7a6357' : '#5f6f7c',
    boil: warming ? clamp(st.s.prhr, 0, 1) * 0.9 : 0,
    inside: (c2) => {
      const pts = scr(PR_COIL);
      tube(c2, pts, 7.5, '#9db0bd');
      fluid(c2, pts, 7.5, heatedWater(warming ? 0.72 : 0.12), t, flowing);
    }
  });
  if (p.irwstCracked) {
    // a crack lets it out of the bottom corner, which is the failure the whole
    // "what if the tank leaks" question is about
    const q = project(b.x1 - 0.3, b.y1 - 0.3, b.z);
    for (let i = 0; i < 6; i++) {
      const ph = ((t * 1.1 + i / 6) % 1);
      ctx.fillStyle = `rgba(120,190,230,${0.65 * (1 - ph)})`;
      ctx.beginPath();
      ctx.ellipse(q.x + 3, q.y + ph * (b.z * TZ), 2.4, 4.5, 0, 0, TAU); ctx.fill();
    }
  }
}

// Falling water, drawn straight because a vertical drop projects vertically.
function pour(ctx, gx, gy, z0, z1, t, col, width) {
  const a = project(gx, gy, z0), b = project(gx, gy, z1);
  const h = b.y - a.y;
  if (h <= 1) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(a.x - width / 2, a.y);
  ctx.lineTo(a.x + width / 2, a.y);
  ctx.lineTo(b.x + width * 0.78, b.y);
  ctx.lineTo(b.x - width * 0.78, b.y);
  ctx.closePath();
  ctx.fillStyle = withA(col, 0.55); ctx.fill();
  ctx.clip();
  ctx.strokeStyle = withA(col, 0.95); ctx.lineWidth = 2.2; ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const ph = ((t * 1.5 + hash(i * 17)) % 1);
    const yy = a.y + ph * h;
    const xx = a.x + (hash(i) - 0.5) * width * 0.8;
    ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + h * 0.22); ctx.stroke();
  }
  ctx.restore();
  // splash where it lands
  ctx.strokeStyle = withA(col, 0.5); ctx.lineWidth = 1.6;
  for (let i = 0; i < 2; i++) {
    const ph = ((t * 1.6 + i * 0.5) % 1);
    ctx.globalAlpha = 0.55 * (1 - ph);
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, width * (0.5 + ph * 1.6), width * (0.22 + ph * 0.7), 0, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawBaseTank(ctx, p, st, t) {
  const b = G.base;
  // the ground it is sunk into
  const m = 1.1;
  const c0 = project(b.x0 - m, b.y0 - m, 0.05), c1 = project(b.x1 + m, b.y0 - m, 0.05),
    c2 = project(b.x1 + m, b.y1 + m, 0.05), c3 = project(b.x0 - m, b.y1 + m, 0.05);
  ctx.beginPath();
  ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y);
  ctx.closePath();
  ctx.fillStyle = '#26303a'; ctx.fill();
  ctx.strokeStyle = 'rgba(12,18,24,0.5)'; ctx.lineWidth = 1.2; ctx.stroke();
  // The model treats this store as large enough not to run out, so it is drawn
  // at a fixed level: what fails here is the pump, not the supply.
  drawBasin(ctx, b, 0.86, heatedWater(0.03), t, { tone: '#4e5a66', wall: 0.4 });
}

function drawBackupPump(ctx, p, st, t) {
  const g = G.eccs;
  const live = st.injecting;
  shadow(ctx, g.x, g.y, 0, g.r * ERX * 1.3, g.r * ERY * 1.3, 0.34);
  cylinder(ctx, { x: g.x, y: g.y, z: 0, r: g.r, h: g.h * 0.6, color: '#77848f' });
  cylinder(ctx, {
    x: g.x, y: g.y, z: g.h * 0.6, r: g.r * 0.6, h: g.h * 0.8,
    color: live ? '#8fa2ae' : '#666f77', rib: 3
  });
  const top = project(g.x, g.y, g.h * 1.4);
  ctx.beginPath(); ctx.ellipse(top.x, top.y, 3.2, 2.1, 0, 0, TAU);
  ctx.fillStyle = live ? C.ok : (st.live && p.pumpsOk) ? C.warn : C.bad; ctx.fill();
  if (live) {
    ctx.strokeStyle = 'rgba(216,236,246,0.8)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = t * 6 + (i / 3) * TAU;
      ctx.beginPath(); ctx.moveTo(top.x, top.y);
      ctx.lineTo(top.x + Math.cos(a) * 11, top.y + Math.sin(a) * 6);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// the turbine hall: the answer to "so how does any of this make electricity?"
// ---------------------------------------------------------------------------

// A casing that reads as a machine lying on its side: an elongated octagon
// extruded, so the corners are off and the top is flat where the joint is.
function casing(ctx, o, color) {
  const cx = o.x + o.w / 2, cy = o.y + o.d / 2;
  const base = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + Math.PI / 12;
    base.push({ x: cx + Math.cos(a) * o.w * 0.5, y: cy + Math.sin(a) * o.d * 0.5 });
  }
  prism(ctx, base, o.z, o.h, color);
}

function drawTurbineHall(ctx, p, st, t) {
  const g = G;
  const running = (st.s.feed || 0) > 0 && !p.scrammed;
  const spin = t * (running ? 7 : 0);
  const mwe = running ? Math.round((p.qDecay / 1e6) * 0.33) : 0;
  st.mwe = mwe;

  shadow(ctx, (g.deck.x0 + g.deck.x1) / 2, (g.deck.y0 + g.deck.y1) / 2, 0,
    (g.deck.x1 - g.deck.x0) * ERX * 0.62, (g.deck.y1 - g.deck.y0) * ERY * 0.62, 0.34);
  // the condenser hangs below the deck, in its own pit
  const cd = g.cond;
  box(ctx, {
    x: cd.x0, y: cd.y0, z: cd.z, w: cd.x1 - cd.x0, d: cd.y1 - cd.y0, h: cd.h,
    color: running ? '#2f7d8f' : '#3c4b52', top: running ? '#3a94a8' : '#44545c'
  });
  // the deck everything stands on
  box(ctx, {
    x: g.deck.x0, y: g.deck.y0, z: g.deck.z, w: g.deck.x1 - g.deck.x0,
    d: g.deck.y1 - g.deck.y0, h: g.deck.h, color: '#57646f', top: '#66737e'
  });
  // the shaft, running the length of the train
  const sa = project(g.hp.x, SHAFT_Y, g.hp.z + g.hp.h * 0.55);
  const sb = project(g.gen.x + g.gen.w, SHAFT_Y, g.hp.z + g.hp.h * 0.55);
  ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y);
  ctx.strokeStyle = 'rgba(12,18,24,0.5)'; ctx.lineWidth = 7; ctx.stroke();
  ctx.strokeStyle = running ? '#c9d9e4' : '#7c868e'; ctx.lineWidth = 4.5; ctx.stroke();

  // the high-pressure cylinder, with the valve chest steam arrives through
  casing(ctx, g.hp, running ? '#7f8d99' : '#6b757e');
  box(ctx, { x: g.hp.x + 0.5, y: g.hp.y - 0.55, z: g.hp.z + g.hp.h - 0.2,
    w: 1.1, d: 0.7, h: 0.8, color: running ? '#a8b4bd' : '#828d95' });
  casing(ctx, g.lp, running ? '#8b97a2' : '#727d86');
  // the blading, seen through a cut in the low-pressure casing
  const lc = project(g.lp.x + g.lp.w / 2, SHAFT_Y, g.lp.z + g.lp.h);
  const lrx = g.lp.w * 0.5 * ERX * 0.62, lry = g.lp.d * 0.5 * ERY * 0.62;
  ctx.save();
  ctx.beginPath(); ctx.ellipse(lc.x, lc.y, lrx, lry, 0, 0, TAU); ctx.clip();
  ctx.fillStyle = '#141d26'; ctx.fill();
  ctx.strokeStyle = running ? 'rgba(214,234,246,0.85)' : 'rgba(126,140,152,0.7)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    const a = spin + (i / 14) * TAU;
    ctx.beginPath();
    ctx.moveTo(lc.x + Math.cos(a) * lrx * 0.22, lc.y + Math.sin(a) * lry * 0.22);
    ctx.lineTo(lc.x + Math.cos(a + 0.5) * lrx * 0.96, lc.y + Math.sin(a + 0.5) * lry * 0.96);
    ctx.stroke();
  }
  ctx.restore();
  ctx.beginPath(); ctx.ellipse(lc.x, lc.y, lrx, lry, 0, 0, TAU);
  ctx.strokeStyle = 'rgba(12,18,24,0.6)'; ctx.lineWidth = 1.4; ctx.stroke();
  // steam dropping out of the turbine into the condenser below it
  if (running) {
    for (let i = 0; i < 8; i++) {
      const ph = ((t * 0.9 + hash(i * 13)) % 1);
      const q = project(g.lp.x + 0.4 + hash(i) * (g.lp.w - 0.8),
        g.lp.y + 0.4 + hash(i + 9) * (g.lp.d - 0.8), g.lp.z - ph * 1.9);
      ctx.fillStyle = `rgba(206,228,240,${0.34 * (1 - ph)})`;
      ctx.beginPath(); ctx.ellipse(q.x, q.y, 5 + ph * 5, 3 + ph * 3, 0, 0, TAU); ctx.fill();
    }
  }
  box(ctx, {
    x: g.gen.x, y: g.gen.y, z: g.gen.z, w: g.gen.w, d: g.gen.d, h: g.gen.h,
    color: running ? '#5f7183' : '#535c65', top: running ? '#6f8194' : '#5e6771'
  });
  // ribs down the stator, and the exciter on the far end
  ctx.strokeStyle = 'rgba(18,26,34,0.32)'; ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const bx = g.gen.x + g.gen.w * (i / 5);
    const q0 = project(bx, g.gen.y + g.gen.d, g.gen.z);
    const q1 = project(bx, g.gen.y + g.gen.d, g.gen.z + g.gen.h);
    ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
  }
  box(ctx, { x: g.gen.x + g.gen.w, y: SHAFT_Y - 0.5, z: g.gen.z, w: 0.9, d: 1.0, h: 1.2,
    color: running ? '#77879a' : '#5b646d' });
  // the generator's field, glowing when it is making power
  if (running) {
    const q = project(g.gen.x + g.gen.w / 2, SHAFT_Y, g.gen.z + g.gen.h);
    const gr = ctx.createRadialGradient(q.x, q.y, 2, q.x, q.y, 46);
    gr.addColorStop(0, `rgba(255,214,110,${0.30 + 0.12 * Math.sin(t * 5)})`);
    gr.addColorStop(1, 'rgba(255,214,110,0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.ellipse(q.x, q.y, 46, 30, 0, 0, TAU); ctx.fill();
  }
  // and the power leaving it, along a bus to the switchyard
  const busPts = scr(R_BUS);
  tracePts(ctx, busPts);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(10,17,24,0.55)'; ctx.lineWidth = 5.5; ctx.stroke();
  ctx.strokeStyle = running ? '#6c6242' : '#4c545a'; ctx.lineWidth = 3.4; ctx.stroke();
  if (running) {
    const cum = measure(busPts), total = cum[cum.length - 1];
    for (let i = 0; i < 5; i++) {
      const d = (((t * 210 + i * total / 5) % total) + total) % total;
      const q = at(busPts, cum, d);
      if (!q) continue;
      ctx.beginPath(); ctx.ellipse(q.x, q.y, 3.4, 3.4, 0, 0, TAU);
      ctx.fillStyle = '#ffe27a'; ctx.fill();
    }
  }
}

// The stack. Water leaving the top of a containment is the one thing a viewer
// should never have to guess at, so the route out has a pipe and a chimney and
// a caption, and it only runs when the model says the vent is open.
function drawVentStack(ctx, p, st, t) {
  const g = G.stack;
  const venting = !!st.s.vent;
  shadow(ctx, g.x, g.y, 0, g.r * ERX * 2.2, g.r * ERY * 2.2, 0.3);
  cylinder(ctx, { x: g.x, y: g.y, z: 0, r: g.r * 1.9, h: 1.2, color: '#4e5a66' });
  cylinder(ctx, { x: g.x, y: g.y, z: 1.2, r: g.r, h: g.h - 1.2, rib: 6,
    color: venting ? '#8b96a0' : '#6d767e', cap: false });
  const top = project(g.x, g.y, g.h);
  ctx.beginPath(); ctx.ellipse(top.x, top.y, g.r * ERX, g.r * ERY, 0, 0, TAU);
  ctx.fillStyle = '#171f27'; ctx.fill();
  ctx.strokeStyle = 'rgba(180,196,210,0.6)'; ctx.lineWidth = 1.2; ctx.stroke();
  if (venting) {
    for (let i = 0; i < 10; i++) {
      const ph = ((t * 0.4 + hash(i * 19)) % 1);
      ctx.fillStyle = `rgba(206,214,220,${0.42 * (1 - ph)})`;
      ctx.beginPath();
      ctx.ellipse(top.x + (hash(i) - 0.5) * 26 + ph * 30, top.y - 4 - ph * 74,
        7 + ph * 22, 4 + ph * 13, 0, 0, TAU);
      ctx.fill();
    }
  }
}

function drawPower(ctx, p, st, t) {
  const b = G.power;
  box(ctx, {
    x: b.x0, y: b.y0, z: 0, w: b.x1 - b.x0, d: b.y1 - b.y0, h: b.h,
    color: st.live ? '#6b7a86' : '#4b545c',
    top: st.live ? '#7c8b96' : '#525c64'
  });
  // a row of lamps that is lit only when there is power
  const on = st.live ? C.power : (st.s.battery > 0 ? C.warn : '#3b444c');
  for (let i = 0; i < 4; i++) {
    const q = project(b.x1, b.y0 + (b.y1 - b.y0) * ((i + 0.5) / 4), b.h * 0.62);
    ctx.beginPath(); ctx.ellipse(q.x, q.y, 3.4, 3.4, 0, 0, TAU);
    ctx.fillStyle = on; ctx.fill();
    if (st.live || st.s.battery > 0) {
      const gg = ctx.createRadialGradient(q.x, q.y, 1, q.x, q.y, 13);
      gg.addColorStop(0, withA(on, 0.5)); gg.addColorStop(1, withA(on, 0));
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.ellipse(q.x, q.y, 13, 13, 0, 0, TAU); ctx.fill();
    }
  }
  // the pylon that brings the grid in
  const a = project(b.x1 + 1.0, b.y0 + 0.4, 0), c = project(b.x1 + 1.0, b.y0 + 0.4, 4.2);
  ctx.strokeStyle = st.s.grid ? '#8d9aa4' : '#5a636b'; ctx.lineWidth = 2.4;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(c.x - 13, c.y + 6); ctx.lineTo(c.x + 13, c.y + 6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x - 10, c.y + 14); ctx.lineTo(c.x + 10, c.y + 14); ctx.stroke();
}

// ---------------------------------------------------------------------------
// the scene: one depth-sorted pass over everything in the building
// ---------------------------------------------------------------------------
const PIPE_W = 9.5, BIG_W = 11;

function drawScene(ctx, p, st, t, full) {
  const P = st.P;
  const wcol = waterColor(p.Tclad);
  // Natural circulation is real but it is a crawl, and it has to look like
  // one or the picture says the pump does not matter.
  const loopSpeed = st.s.rcp > 0.01 ? 1 : st.s.natCirc > 0.01 ? 0.11 : 0;
  const items = [];
  const add = (d, f) => items.push({ d, f });

  shellFloor(ctx, p, st, t);
  floorPlates(ctx);
  shellWall(ctx, p, st);

  // --- the main loop, split so each leg sorts on its own depth --------------
  add(14.0, () => pipeRun(ctx, R_HOT.slice(1, 3), BIG_W, C.steel, wcol, t, loopSpeed));
  add(16.8, () => pipeRun(ctx, R_HOT.slice(0, 2), BIG_W, C.steel, wcol, t, loopSpeed));
  add(17.2, () => pipeRun(ctx, R_HOT.slice(2), BIG_W, C.steel, wcol, t, loopSpeed));
  add(26.3, () => pipeRun(ctx, R_COLD_A, BIG_W, C.steel,
    heatedWater((p.Tclad - 700) / 400), t, loopSpeed));
  add(26.5, () => pipeRun(ctx, R_COLD_B, BIG_W, C.steel,
    heatedWater((p.Tclad - 700) / 400), t, loopSpeed));

  if (P) {
    const pr = st.s.prhr > 0.01 ? 0.8 : 0;
    add(17.5, () => pipeRun(ctx, PR_DN, PIPE_W, '#9db0bd', heatedWater(0.10), t, pr));
    add(24.6, () => pipeRun(ctx, PR_UP, PIPE_W, '#9db0bd', wcol, t, pr));
  } else {
    add(30.6, () => pipeRun(ctx, R_ACT, BIG_W, '#9db0bd',
      heatedWater(0.04), t, st.injecting ? 0.9 : 0));
  }

  // --- the machines ---------------------------------------------------------
  if (P) {
    add(17.0, () => {
      drawPool(ctx, p, st, t);
    });
    add(19.0, () => pipeRun(ctx, R_GRAV, PIPE_W, '#9db0bd',
      st.injecting && p.irwst > 1e5 ? heatedWater(0.05) : null, t, 1));
  }
  add(22.0, () => drawReactor(ctx, p, st, t));
  add(22.0, () => drawBoiler(ctx, p, st, t));
  add(30.0, () => drawPump(ctx, p, st, t));

  items.sort((a, b) => a.d - b.d);
  for (const it of items) it.f();

  // Steam that reaches the shell condenses on it and runs back down to the
  // floor. That return is in the model, so it is in the picture.
  if (P && (st.s.pccs || 0) > 0.05) {
    const sh = G.shell;
    for (const th of [Math.PI * 1.04, Math.PI * 1.94]) {
      const a = gAngle(th);
      const wx = sh.x + sh.r * 0.94 * Math.cos(a), wy = sh.y + sh.r * 0.94 * Math.sin(a);
      pour(ctx, wx, wy, sh.h * 0.62, 0.05, t, heatedWater(0.12), 6);
    }
  }
  polarCrane(ctx, t);
  railArc(ctx, CUT0, CUT1, G.shell.r * 0.985, 0, 20);
  glassDome(ctx, p, st, t);
  shellAir(ctx, p, st, t);

  // --- outside the building -------------------------------------------------
  // the steam side. It runs to the turbine and back and never touches the
  // reactor's water, which is the point of having a boiler at all.
  const gen = (st.s.feed || 0) > 0 && !p.scrammed;
  st.mwe = gen ? Math.round((p.qDecay / 1e6) * 0.33) : 0;
  if (full) {
    pipeRun(ctx, R_FEED, PIPE_W, '#9db0bd', heatedWater(0.05), t, gen ? 0.85 : 0);
    drawTurbineHall(ctx, p, st, t);
    pipeRun(ctx, R_CW, PIPE_W, '#7f9aa6', heatedWater(0.0), t, gen ? 0.8 : 0);
    pipeRun(ctx, R_STEAM, BIG_W, '#a8b6c0', '#dbe9f2', t, gen ? 1.5 : 0, 'steam');
    pipeRun(ctx, R_VENT, PIPE_W, '#8b96a0', st.s.vent ? '#cfdae2' : null, t, 1.1, 'steam');
    drawVentStack(ctx, p, st, t);
  }
  drawPower(ctx, p, st, t);
  if (!P) {
    drawBaseTank(ctx, p, st, t);
    pipeRun(ctx, R_SUCT, BIG_W, '#9db0bd', heatedWater(0.03), t, st.injecting ? 0.9 : 0);
    drawBackupPump(ctx, p, st, t);
  }

  // --- what is escaping -----------------------------------------------------
  if (!p.ctmtIntact) breachPlume(ctx, p, t);
}

// ---------------------------------------------------------------------------
// text. Drawn in screen space and anchored to a projected point, so it stays
// crisp and level however small the drawing gets.
// ---------------------------------------------------------------------------
function label(ctx, text, x, y, o = {}) {
  const px = o.px || 15, weight = o.weight || 700, maxW = o.maxW || 1e9;
  let size = px;
  ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    size = Math.max(7, size * maxW / w);
    ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, sans-serif`;
    if (size < 8.5) SHRUNK.push(`${text} (${size.toFixed(1)}px in ${maxW.toFixed(0)}px)`);
  }
  ctx.textAlign = o.align || 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(4,9,14,0.94)';
  ctx.lineWidth = Math.max(3.5, size * 0.42);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = o.fill || C.ink;
  ctx.fillText(text, x, y);
  return size;
}

// One entry per caption: where it points, where the text sits relative to that
// (in drawing units, so the arrangement holds at any zoom), and how important
// it is — priority 1 captions are dropped when both plants share the width.
function captions(p, st) {
  const g = G, s = st.s, P = st.P;
  const MW = (p.qDecay || 0) / 1e6;
  const L = [];
  const at = (gx, gy, gz, dx, dy, text, o = {}) =>
    L.push({ g: [gx, gy, gz], dx, dy, text, ...o });
  const free = (wx, wy, text, o = {}) => L.push({ w: [wx, wy], dx: 0, dy: 0, text, ...o });
  void free;

  // reactor
  at(g.core.x, g.core.y, g.core.z + g.core.h + 2.1, 0, -10, 'REACTOR',
    { px: 17, weight: 800, maxW: 200 });
  at(g.core.x, g.core.y, 0, 0, 34,
    `water ${Math.round(st.lvl * 100)}%   ·   ${st.T.toFixed(0)} °C`,
    { px: 15, maxW: 300, lead: true,
      fill: st.T > 800 ? C.bad : st.T > 360 ? C.warn : C.dim });
  // Shutting a reactor down stops the chain reaction, not the heat. Without
  // this number nothing else in the picture has a reason to exist.
  at(g.core.x, g.core.y, 0, 0, 52,
    p.scrammed
      ? `shut down — still making ${MW < 10 ? MW.toFixed(1) : Math.round(MW)} MW of heat`
      : `running — making ${Math.round(MW).toLocaleString('en-US')} MW of heat`,
    { px: 13, weight: 600, maxW: 480, fill: '#a2bacd' });
  at(g.core.x, g.core.y, FUEL_Z1, 0, 0, '', { skip: true });

  // boiler
  at(g.sg.x, g.sg.y, g.sg.z + g.sg.h + 1.8, 0, -10, 'BOILER',
    { px: 17, weight: 800, maxW: 180 });
  at(g.sg.x, g.sg.y, 0, 0, 40,
    st.sink === 'turbine' ? 'taking the heat away'
      : st.sink === 'pool' ? 'not needed — the pool has it'
        : st.sink === 'shell' ? 'not needed — the shell has it' : 'not taking any heat',
    { px: 15, maxW: 300, lead: true,
      fill: st.sink === 'turbine' ? C.dim : st.carried ? C.ok : C.bad });

  // pump. Two lines: what it is doing, and what the cooling depends on.
  const pumpTx = s.rcp
    ? (P ? ['spinning', 'the cooling needs no pump at all']
      : ['spinning', 'the cooling needs pumps like this'])
    : (P ? ['stopped', st.flow > 0
      ? 'the water still creeps round on its own, far slower'
      : 'and the cooling carries on anyway']
      : ['STOPPED', st.steamOnly ? 'the steam pump covers it'
        : st.live ? 'the backups must take over' : 'the backups have no power']);
  const pc = s.rcp ? C.ink : (P ? C.ok : C.bad);
  at(g.pump.x, g.pump.y, 0, 0, 46, 'PUMP', { px: 16, weight: 800, maxW: 200, lead: true });
  at(g.pump.x, g.pump.y, 0, 0, 64, pumpTx[0], { px: 14, maxW: 260, fill: pc });
  at(g.pump.x, g.pump.y, 0, 0, 81, pumpTx[1],
    { px: 13, weight: 600, maxW: 320, prio: 1, fill: s.rcp ? C.dim : pc });

  if (P) {
    const pcx = (g.pool.x0 + g.pool.x1) / 2, pcy = (g.pool.y0 + g.pool.y1) / 2;
    at(pcx, pcy, g.pool.z + g.pool.h, 0, -40,
      st.onFloor ? 'WATER ON THE FLOOR' : 'THE POOL — HIGHER THAN THE REACTOR',
      { px: 15, weight: 800, maxW: 440 });
    at(pcx, pcy, g.pool.z + g.pool.h, 0, -21,
      st.lost ? 'ESCAPING as steam'
        : st.onFloor ? 'still gets back in'
          : st.cracked ? 'CRACKED — draining'
            : st.injecting ? 'falling into the reactor'
              : st.poolLoop ? 'taking the heat from the reactor' : 'ready — no pump needed',
      { px: 14, maxW: 340,
        fill: st.lost ? C.bad : st.onFloor ? C.ok : st.cracked ? C.warn : C.ok });
    // Why the level in this tank can go back up: it is a closed loop.
    if ((s.pccs || 0) > 0.05 && st.poolFrac < 0.985) {
      at(pcx, pcy, g.pool.z + g.pool.h, 0, -6,
        'steam condenses on the shell and drains back in',
        { px: 12, weight: 600, maxW: 380, prio: 1, fill: C.cold });
    }
    at(6.6, 16.7, 6.9, 200, 60, st.poolLoop ? 'heat goes up to the pool' : 'the path to the pool',
      { px: 13, weight: 600, align: 'left', maxW: 250, prio: 1, lead: true,
        fill: st.poolLoop ? C.hot : '#7d8a96' });
  } else {
    at((g.base.x0 + g.base.x1) / 2, g.base.y1, g.base.z, 0, 30, 'WATER IN THE BASEMENT',
      { px: 16, weight: 800, maxW: 320, lead: true });
    at((g.base.x0 + g.base.x1) / 2, g.base.y1, g.base.z, 0, 50,
      st.injecting ? 'being pumped up'
        : !st.live ? 'CANNOT REACH THE REACTOR'
          : !p.pumpsOk ? 'THE PUMPS HAVE FAILED' : 'waiting down here',
      { px: 14, maxW: 320,
        fill: st.injecting ? C.ink : (st.live && p.pumpsOk ? C.dim : C.bad) });
    at(g.eccs.x, g.eccs.y, g.eccs.h, 18, 50, 'BACKUP PUMP',
      { px: 15, weight: 800, align: 'left', maxW: 220, lead: true });
    at(g.eccs.x, g.eccs.y, g.eccs.h, 18, 68,
      st.steamOnly ? 'running on steam' : st.injecting ? 'pumping'
        : !st.live ? 'NO POWER' : !p.pumpsOk ? 'BROKEN' : 'waiting',
      { px: 13, align: 'left', maxW: 220,
        fill: st.steamOnly ? C.warn : st.injecting ? C.ink
          : (st.live && p.pumpsOk) ? C.dim : C.bad });
    at(g.eccs.x, g.eccs.y, g.eccs.h, 18, 85,
      st.steamOnly ? 'runs on steam, not the grid'
        : st.injecting ? 'lifting water uphill'
          : !st.live ? 'it needs electricity'
            : !p.pumpsOk ? 'it cannot lift the water' : 'starts if the level falls',
      { px: 12, weight: 600, align: 'left', maxW: 250, prio: 1,
        fill: st.steamOnly ? C.warn : st.injecting || (st.live && p.pumpsOk) ? C.dim : C.bad });
    at(10.6, 17.4, 9.8, 214, -74, 'the long way round, uphill',
      { px: 13, weight: 600, maxW: 260, prio: 1, lead: true,
        fill: st.injecting ? C.water : '#5f7180' });
  }

  // the steam side
  if (st.full) {
  at(g.hp.x + g.hp.w / 2, SHAFT_Y, g.hp.z + g.hp.h, 130, -60, 'TURBINE',
    { px: 15, weight: 800, maxW: 200, lead: true });
  at(g.gen.x + g.gen.w / 2, SHAFT_Y, g.gen.z + g.gen.h, 0, -40, 'GENERATOR',
    { px: 15, weight: 800, maxW: 240, lead: true });
  at(g.gen.x + g.gen.w / 2, SHAFT_Y, g.gen.z + g.gen.h, 0, -21,
    st.mwe ? `${st.mwe.toLocaleString('en-US')} MW of electricity` : 'no electricity',
    { px: 14, maxW: 300, fill: st.mwe ? C.power : C.dim });
  at((g.cond.x0 + g.cond.x1) / 2, g.cond.y1, g.cond.z, 30, 4, 'CONDENSER',
    { px: 13, weight: 800, align: 'left', maxW: 220, prio: 1, lead: true });
  at((g.cond.x0 + g.cond.x1) / 2, g.cond.y1, g.cond.z, 30, 22,
    'steam turns back to water here',
    { px: 12, weight: 600, align: 'left', maxW: 300, prio: 1, fill: C.dim });
  at(20.9, g.sg.y, 12.4, 0, -18,
    st.mwe ? 'steam to the turbine' : 'no steam — the reactor is shut down',
    { px: 13, weight: 600, maxW: 340, prio: 1,
      fill: st.mwe ? C.steam : '#7d8a96' });
  }

  // power
  at(g.power.x0, g.power.y1, g.power.h, -14, 2, 'POWER',
    { px: 14, weight: 800, align: 'right', maxW: 130, lead: true });
  at(g.power.x0, g.power.y1, g.power.h, -14, 19,
    s.grid ? 'grid' : s.diesel ? 'diesels'
      : s.battery > 0 ? `batteries ${(s.battery * p.batteryHours).toFixed(0)} h` : 'NONE',
    { px: 14, align: 'right', maxW: 160,
      fill: st.live ? C.power : (s.battery > 0 ? C.warn : C.bad) });

  if (s.vent && st.full) {
    at(g.stack.x, g.stack.y, g.stack.h, -16, 34, 'VENT OPEN',
      { px: 13, weight: 800, align: 'right', maxW: 200, lead: true, fill: C.warn });
    at(g.stack.x, g.stack.y, g.stack.h, -16, 51,
      'opened on purpose, to stop the containment bursting',
      { px: 12, weight: 600, align: 'right', maxW: 340, prio: 1, fill: C.warn });
  }
  if (!p.ctmtIntact) {
    // anchored on the hole itself, which lives in drawing coordinates because
    // it is a place on a projected circle rather than a point on the grid
    const bx = g.shell.r * ERX * Math.cos(BREACH_A);
    const by = (g.shell.x + g.shell.y) * 16 + g.shell.r * ERY * Math.sin(BREACH_A)
      - g.shell.h * TZ * 0.52;
    free(bx, by, 'the hole the inside is escaping through',
      { px: 13, weight: 700, maxW: 360, dy: -54, lead: true, fill: C.bad });
  }

  // the wall
  free(-120, 812, !p.ctmtIntact ? 'CONTAINMENT BREACHED — the barrier is gone'
    : st.sink === 'shell' ? 'CONTAINMENT — the steel carries the heat to the air'
      : 'CONTAINMENT — nothing inside this line gets out',
  { px: 13.5, maxW: 560,
    fill: !p.ctmtIntact ? C.bad : st.sink === 'shell' ? C.ok : C.dim });

  return L.filter((e) => !e.skip);
}

// ---------------------------------------------------------------------------
// what the picture is showing, in one place, read straight from the model
// ---------------------------------------------------------------------------
function circuitState(p) {
  const s = p.sys || {};
  const P = p.mode === MODE.PASSIVE;
  const sink = s.sink || 'none';
  const carried = sink !== 'none';
  const flow = Math.max(s.rcp || 0, s.natCirc || 0);
  const lvl = clamp(p.level, 0, 1);
  const covered = lvl >= FUEL_TOP;
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
  const poolFrac2 = poolFrac;
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
  return { s, P, sink, carried, flow, lvl, covered, uncovered, poolFrac: poolFrac2,
    T, live, steamOnly, injecting, poolLoop, store, onFloor, cracked, lost, lostWater,
    headline,
    good: !(p.vesselBreach || uncovered || p.coreDamage > 0.01 || sink === 'none'
      || lvl < 0.97 || lostWater) };
}

// ---------------------------------------------------------------------------
// the stage: fit the building (or two of them) into the band and paint it
// ---------------------------------------------------------------------------
// The top of the far wall projects far higher than the dome's apex does — a
// point with a small x + y climbs the screen twice over, once for its depth and
// once for its height. Measured, not guessed: anything shorter here hides the
// top of the building under the fixed top bar.
// Two framings. The comparison view holds only what differs between the two
// plants; a single unit gets the whole station, turbine hall included.
const CONTENT = { x: -510, y: -132, w: 1150, h: 962 };
const CORE = { x: -510, y: -132, w: 914, h: 962 };
const GAP = 80;

export class Cutaway {
  constructor() { this.focus = 'both'; this.states = []; }
  setFocus(f) { this.focus = f; }

  // The full station only earns its width when there is width to spend. On a
  // phone the turbine hall would land at a scale nobody can read, so the frame
  // falls back to the containment and its own kit.
  frame(bandW) {
    if (this.focus === 'both') return CORE;
    return bandW && bandW / CONTENT.w < 0.42 ? CORE : CONTENT;
  }

  bounds(bandW) {
    const one = { ...this.frame(bandW) };
    if (this.focus === 'both') return { ...one, w: one.w * 2 + GAP };
    return one;
  }

  // the band the drawing gets, in CSS pixels
  band(cw, ch) {
    const narrow = cw < 861;
    return narrow
      ? { x: 8, y: 124, w: cw - 16, h: ch - 124 - 226 }
      : { x: 318, y: 128, w: cw - 318 - 350, h: ch - 128 - 128 };
  }

  draw(ctx, sim, CW, CH, t) {
    const dpr = CW / (window.innerWidth || CW);
    const cw = CW / dpr, ch = CH / dpr;
    const b = this.band(cw, ch);
    if (b.w < 40 || b.h < 40) return;
    SHRUNK.length = 0;
    const bb = this.bounds(b.w);
    const sc = Math.min(b.w / bb.w, b.h / bb.h);
    const tx = b.x + (b.w - bb.w * sc) / 2 - bb.x * sc;
    const ty = b.y + (b.h - bb.h * sc) / 2 - bb.y * sc;
    this.scale = sc; this.tx = tx; this.ty = ty; this.dpr = dpr;

    const F = this.frame(b.w);
    const full = F === CONTENT;
    const show = sim.plants.filter((p) =>
      !(this.focus === 'active' && p.mode === MODE.PASSIVE)
      && !(this.focus === 'passive' && p.mode !== MODE.PASSIVE));
    this.states = [];
    show.forEach((p, i) => {
      const st = circuitState(p);
      const ox = i * (F.w + GAP);
      this.states.push({ p, st, ox });
      ctx.save();
      ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * (tx + ox * sc), dpr * ty);
      st.full = full;
      drawScene(ctx, p, st, t, full);
      ctx.restore();
    });

    // captions and headings, in screen space so they stay level and crisp
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A caption cannot shrink with the drawing all the way down or it stops
    // being readable, so below about half scale it is held at a floor and the
    // second-tier captions are dropped instead.
    const fs = clamp(sc * 1.32, 0.70, 1.06);
    const detail = sc >= 0.52;
    this.states.forEach(({ p, st, ox }) => {
      const ax = tx + ox * sc, ay = ty;
      for (const e of captions(p, st)) {
        if (e.prio === 1 && !detail) continue;
        const w = e.g ? project(e.g[0], e.g[1], e.g[2]) : { x: e.w[0], y: e.w[1] };
        const px = ax + w.x * sc, py = ay + w.y * sc;
        const lx = px + (e.dx || 0) * sc, ly = py + (e.dy || 0) * sc;
        if (e.lead) {
          ctx.strokeStyle = 'rgba(190,214,232,0.42)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(px, py);
          ctx.lineTo(lx - (e.align === 'right' ? -4 : e.align === 'left' ? 4 : 0), ly);
          ctx.stroke();
          ctx.fillStyle = 'rgba(210,232,248,0.85)';
          ctx.beginPath(); ctx.ellipse(px, py, 2.2, 2.2, 0, 0, TAU); ctx.fill();
        }
        label(ctx, e.text, lx, ly, {
          px: (e.px || 15) * fs, weight: e.weight, align: e.align,
          fill: e.fill, maxW: (e.maxW || 1e9) * sc * 1.12
        });
      }
    });
    this.states.forEach(({ p, st, ox }) => {
      const cx = tx + (ox + F.x + F.w / 2) * sc;
      // never let the name slide up under the fixed top bar (60 px, 50 on phone)
      const top = Math.max(118, ty + CONTENT.y * sc);
      const name = p.mode === MODE.PASSIVE ? 'PASSIVE' : 'ACTIVE';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
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
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
