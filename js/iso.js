// ---------------------------------------------------------------------------
// iso.js - projection, camera and the solid primitives everything is drawn from.
//
// Style follows the isometric-explainer convention: flat shaded faces with a
// soft pencil outline, which reads as a drawn paper model rather than a render,
// and costs a fill and a stroke instead of a pattern transform per face.
//
// Grid space: x grows toward the lower-right, y toward the lower-left, z up.
// ---------------------------------------------------------------------------

export const TW = 32;    // px per grid unit on screen-x (half tile width)
export const TH = 16;    // px per grid unit on screen-y (half tile height)
export const TZ = 20;    // px per grid unit of height

export function project(x, y, z) {
  return { x: (x - y) * TW, y: (x + y) * TH - (z || 0) * TZ };
}
export function P(x, y, z) {              // array form, for hot paths
  return [(x - y) * TW, (x + y) * TH - (z || 0) * TZ];
}
export function unproject(sx, sy) {
  const a = sx / TW, b = sy / TH;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

// ---- colour ---------------------------------------------------------------
const shadeCache = Object.create(null);

function parseHex(hex) {
  if (hex.charCodeAt(0) !== 35) {
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(hex);
    if (m) return [+m[1], +m[2], +m[3]];
  }
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (isNaN(n)) return [255, 0, 255];     // loud magenta, never silent black
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Quantise before caching: anything animated feeds this a continuously varying
// factor, which would otherwise miss on every call and grow without bound.
export function shade(hex, f) {
  f = Math.round(f * 64) / 64;
  const key = hex + '|' + f;
  const hit = shadeCache[key];
  if (hit) return hit;
  const c = parseHex(hex);
  const out = 'rgb(' +
    Math.min(255, Math.round(c[0] * f)) + ',' +
    Math.min(255, Math.round(c[1] * f)) + ',' +
    Math.min(255, Math.round(c[2] * f)) + ')';
  shadeCache[key] = out;
  return out;
}
export function rgba(hex, a) {
  const c = parseHex(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
export function mix(a, b, t) {
  const A = parseHex(a), B = parseHex(b);
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.max(0, Math.min(255, Math.round(A[i] + (B[i] - A[i]) * t)));
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

// Deterministic variation. Never Math.random() in a draw call: it is
// re-evaluated every frame and the whole world shimmers.
export function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- primitives -----------------------------------------------------------
export const TOP = 1.0, RIGHT = 0.89, LEFT = 0.76;
export const EDGE = 'rgba(70,62,52,0.34)';

export function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
}
export function polyLine(ctx, pts, close) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
  ctx.stroke();
}

// Axis-aligned box. o = {x,y,z,w,d,h,color,top,alpha,edge,panels,windows}
export function box(ctx, o) {
  const x = o.x, y = o.y, z = o.z || 0, w = o.w, d = o.d, h = o.h;
  const c = o.color, t = z + h;
  if (o.alpha != null) { ctx.save(); ctx.globalAlpha *= o.alpha; }

  const A = project(x, y, t), B = project(x + w, y, t),
    C = project(x + w, y + d, t), D = project(x, y + d, t);
  const Bb = project(x + w, y, z), Cb = project(x + w, y + d, z), Db = project(x, y + d, z);

  ctx.fillStyle = shade(c, RIGHT); poly(ctx, [B, C, Cb, Bb]);
  ctx.fillStyle = shade(c, LEFT); poly(ctx, [D, C, Cb, Db]);
  if (o.panels) panels(ctx, o);
  if (o.windows) windows(ctx, o);
  ctx.fillStyle = shade(o.top || c, o.topShade != null ? o.topShade : TOP);
  poly(ctx, [A, B, C, D]);

  const edge = o.edge === false ? null : (o.edge || EDGE);
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = o.edgeWidth || 1;
    ctx.lineJoin = 'round';
    polyLine(ctx, [A, B, C, D], true);
    polyLine(ctx, [B, Bb], false);
    polyLine(ctx, [C, Cb], false);
    polyLine(ctx, [D, Db], false);
  }
  if (o.alpha != null) ctx.restore();
}

function windows(ctx, o) {
  const win = o.windows;
  const cols = win.cols || 3, rows = win.rows || Math.max(1, Math.round(o.h * 1.4));
  const x = o.x, y = o.y, z = o.z || 0, w = o.w, d = o.d, h = o.h;
  const seed = win.seed || 1;
  const lit = win.color || '#ffdc9a', dark = win.dark || '#5d7182';
  const X1 = x + w, Y1 = y + d;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z0 = z + h * ((r + 0.28) / rows), z1 = z + h * ((r + 0.72) / rows);
      let on = hash2(r * 31 + c, seed, 7) > 0.55;
      ctx.fillStyle = on ? rgba(lit, 0.62) : rgba(dark, 0.5);
      const v0 = y + d * ((c + 0.26) / cols), v1 = y + d * ((c + 0.74) / cols);
      poly(ctx, [project(X1, v0, z1), project(X1, v1, z1), project(X1, v1, z0), project(X1, v0, z0)]);
      on = hash2(r * 17 + c, seed + 3, 11) > 0.58;
      ctx.fillStyle = on ? rgba(lit, 0.5) : rgba(dark, 0.42);
      const u0 = x + w * ((c + 0.26) / cols), u1 = x + w * ((c + 0.74) / cols);
      poly(ctx, [project(u0, Y1, z1), project(u1, Y1, z1), project(u1, Y1, z0), project(u0, Y1, z0)]);
    }
  }
}

function panels(ctx, o) {
  const p = o.panels;
  const cols = p.cols || 4, rows = p.rows || Math.max(1, Math.round(o.h * 1.1));
  const x = o.x, y = o.y, z = o.z || 0, w = o.w, d = o.d, h = o.h;
  const seed = p.seed || 1;
  const glass = p.color || '#8fa4b0';
  const joint = p.joint || 'rgba(58,52,44,0.14)';
  const X1 = x + w, Y1 = y + d;
  for (let r = 0; r < rows; r++) {
    const glazed = p.band != null ? r === p.band : (r === rows - 1 && rows > 1);
    const z0 = z + h * ((r + 0.22) / rows), z1 = z + h * ((r + 0.78) / rows);
    for (let c = 0; c < cols; c++) {
      const v0 = y + d * ((c + 0.16) / cols), v1 = y + d * ((c + 0.84) / cols);
      ctx.fillStyle = glazed ? rgba(glass, 0.42 + 0.18 * hash2(r * 31 + c, seed, 7)) : joint;
      poly(ctx, [project(X1, v0, z1), project(X1, v1, z1), project(X1, v1, z0), project(X1, v0, z0)]);
      const u0 = x + w * ((c + 0.16) / cols), u1 = x + w * ((c + 0.84) / cols);
      ctx.fillStyle = glazed ? rgba(glass, 0.34 + 0.16 * hash2(r * 17 + c, seed + 3, 11)) : joint;
      poly(ctx, [project(u0, Y1, z1), project(u1, Y1, z1), project(u1, Y1, z0), project(u0, Y1, z0)]);
    }
  }
}

// Extrude an arbitrary ground polygon. Side faces shade from their own normal
// and are back-face culled: both +x and +y lean toward the camera, so a face is
// visible only when nx + ny > 0.
export function prism(ctx, base, z, h, color, edge) {
  const n = base.length, top = [], bot = [];
  for (let i = 0; i < n; i++) {
    top.push(project(base[i].x, base[i].y, z + h));
    bot.push(project(base[i].x, base[i].y, z));
  }
  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = base[j].x - base[i].x, ey = base[j].y - base[i].y;
    const el = Math.hypot(ex, ey) || 1;
    const nx = -ey / el, ny = ex / el;
    if (nx + ny <= 0) continue;
    faces.push({
      depth: base[i].x + base[i].y + base[j].x + base[j].y,
      shade: 0.80 + 0.09 * nx - 0.06 * ny,
      quad: [top[i], top[j], bot[j], bot[i]]
    });
  }
  faces.sort((a, b) => a.depth - b.depth);
  for (const f of faces) { ctx.fillStyle = shade(color, f.shade); poly(ctx, f.quad); }
  ctx.fillStyle = shade(color, TOP);
  poly(ctx, top);
  const e = edge === false ? null : (edge || EDGE);
  if (e) { ctx.strokeStyle = e; ctx.lineWidth = 1; ctx.lineJoin = 'round'; polyLine(ctx, top, true); }
}

// ---- revolved solids ------------------------------------------------------
// A circle of radius r on the ground projects to an axis-aligned ellipse with
// semi-axes r*TW*sqrt(2) and r*TH*sqrt(2).
export const ERX = TW * 1.41421, ERY = TH * 1.41421;

export function ellipse(ctx, cx, cy, cz, r, style, a0, a1) {
  const p = project(cx, cy, cz);
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r * ERX, r * ERY, 0, a0 === undefined ? 0 : a0,
    a1 === undefined ? Math.PI * 2 : a1);
  if (style) { ctx.fillStyle = style; ctx.fill(); }
  return p;
}

// Vertical cylinder. o = {x,y,z,r,h,color,cap,capColor,edge,alpha,rib}
export function cylinder(ctx, o) {
  const { x, y, r, h } = o, z = o.z || 0, c = o.color;
  if (o.alpha != null) { ctx.save(); ctx.globalAlpha *= o.alpha; }
  const top = project(x, y, z + h), bot = project(x, y, z);
  const rx = r * ERX, ry = r * ERY;

  // body: the silhouette between the two ellipses
  ctx.beginPath();
  ctx.moveTo(bot.x - rx, bot.y);
  ctx.lineTo(top.x - rx, top.y);
  ctx.ellipse(top.x, top.y, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(bot.x + rx, bot.y);
  ctx.ellipse(bot.x, bot.y, rx, ry, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.fillStyle = shade(c, 0.80);
  ctx.fill();
  // two vertical bands give the curve without a gradient
  ctx.save(); ctx.clip();
  ctx.fillStyle = shade(c, 0.68);
  ctx.fillRect(bot.x - rx, top.y - ry - 2, rx * 0.52, (bot.y - top.y) + ry * 2 + 4);
  ctx.fillStyle = shade(c, 0.95);
  ctx.fillRect(bot.x - rx * 0.10, top.y - ry - 2, rx * 0.62, (bot.y - top.y) + ry * 2 + 4);
  if (o.rib) {
    ctx.strokeStyle = 'rgba(50,44,38,0.13)'; ctx.lineWidth = 1;
    for (let i = 1; i < o.rib; i++) {
      const zz = z + h * (i / o.rib);
      const p = project(x, y, zz);
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI); ctx.stroke();
    }
  }
  ctx.restore();

  if (o.cap !== false) {
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = o.capColor ? o.capColor : shade(c, TOP);
    ctx.fill();
  }
  const edge = o.edge === false ? null : (o.edge || EDGE);
  if (edge) {
    ctx.strokeStyle = edge; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bot.x - rx, bot.y); ctx.lineTo(top.x - rx, top.y);
    ctx.moveTo(bot.x + rx, bot.y); ctx.lineTo(top.x + rx, top.y);
    ctx.stroke();
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(bot.x, bot.y, rx, ry, 0, 0, Math.PI); ctx.stroke();
  }
  if (o.alpha != null) ctx.restore();
  return top;
}

// A profile of revolution, bottom to top: prof = [{t, r}] with t in 0..1.
export function revolve(ctx, o) {
  const { x, y, h, prof } = o, z = o.z || 0, c = o.color;
  const pts = prof.map(s => {
    const p = project(x, y, z + h * s.t);
    return { x: p.x, y: p.y, rx: s.r * ERX, ry: s.r * ERY };
  });
  const tp = pts[pts.length - 1], bp = pts[0];
  ctx.beginPath();
  ctx.moveTo(bp.x - bp.rx, bp.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - pts[i].rx, pts[i].y);
  ctx.ellipse(tp.x, tp.y, tp.rx, tp.ry, 0, Math.PI, 0, true);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x + pts[i].rx, pts[i].y);
  ctx.ellipse(bp.x, bp.y, bp.rx, bp.ry, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.fillStyle = shade(c, 0.82);
  ctx.fill();
  let maxR = 0;
  for (const q of pts) if (q.rx > maxR) maxR = q.rx;
  ctx.save(); ctx.clip();
  ctx.fillStyle = shade(c, 0.68);
  ctx.fillRect(bp.x - maxR, tp.y - tp.ry - 2, maxR * 0.55, (bp.y - tp.y) + bp.ry * 2 + 6);
  ctx.fillStyle = shade(c, 0.98);
  ctx.fillRect(bp.x - maxR * 0.08, tp.y - tp.ry - 2, maxR * 0.60, (bp.y - tp.y) + bp.ry * 2 + 6);
  if (o.rib) {
    ctx.strokeStyle = 'rgba(50,44,38,0.11)'; ctx.lineWidth = 1;
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.beginPath(); ctx.ellipse(pts[i].x, pts[i].y, pts[i].rx, pts[i].ry, 0, 0, Math.PI); ctx.stroke();
    }
  }
  ctx.restore();
  if (o.cap !== false) {
    ctx.beginPath(); ctx.ellipse(tp.x, tp.y, tp.rx, tp.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = o.capColor || shade(c, 0.55); ctx.fill();
    if (o.capInner) {
      ctx.beginPath(); ctx.ellipse(tp.x, tp.y, tp.rx * 0.84, tp.ry * 0.84, 0, 0, Math.PI * 2);
      ctx.fillStyle = o.capInner; ctx.fill();
    }
  }
  if (o.edge !== false) {
    ctx.strokeStyle = o.edge || EDGE; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bp.x - bp.rx, bp.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - pts[i].rx, pts[i].y);
    ctx.moveTo(bp.x + bp.rx, bp.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + pts[i].rx, pts[i].y);
    ctx.stroke();
  }
  return { x: tp.x, y: tp.y };
}

// Natural-draught cooling tower: a true hyperboloid waist.
export function coolingTower(ctx, o) {
  const prof = [];
  const tw = 0.76, waist = 0.60, top = 0.70;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const r = t < tw
      ? o.r * (waist + (1 - waist) * Math.pow((tw - t) / tw, 1.85))
      : o.r * (waist + (top - waist) * Math.pow((t - tw) / (1 - tw), 1.6));
    prof.push({ t, r });
  }
  return revolve(ctx, { ...o, prof, rib: true, capColor: shade(o.color, 0.55), capInner: '#20262b' });
}

// Hemispherical dome sitting on z. Shaded with one radial gradient so the
// curvature reads; the banded shading revolve() uses looks flat on a dome.
export function dome(ctx, o) {
  const b = project(o.x, o.y, o.z || 0);
  const rx = o.r * ERX, ry = o.r * ERY;
  const hpx = o.h * TZ;
  ctx.beginPath();
  ctx.moveTo(b.x - rx, b.y);
  ctx.bezierCurveTo(b.x - rx, b.y - hpx * 0.86, b.x - rx * 0.62, b.y - hpx, b.x, b.y - hpx);
  ctx.bezierCurveTo(b.x + rx * 0.62, b.y - hpx, b.x + rx, b.y - hpx * 0.86, b.x + rx, b.y);
  ctx.ellipse(b.x, b.y, rx, ry, 0, 0, Math.PI, false);
  ctx.closePath();
  const g = ctx.createRadialGradient(
    b.x - rx * 0.34, b.y - hpx * 0.62, rx * 0.06,
    b.x, b.y - hpx * 0.25, rx * 1.25);
  g.addColorStop(0, shade(o.color, 1.10));
  g.addColorStop(0.45, shade(o.color, 0.95));
  g.addColorStop(1, shade(o.color, 0.68));
  ctx.fillStyle = g;
  ctx.fill();
  if (o.edge !== false) {
    ctx.strokeStyle = o.edge || EDGE; ctx.lineWidth = 1; ctx.stroke();
  }
  // Latitudes and meridians. A prestressed concrete dome is poured in lifts
  // with tendon galleries running over it, so the lines are on the real thing
  // as well as being what makes a filled ellipse read as a sphere.
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(58,52,44,0.22)'; ctx.lineWidth = 1;
  for (const t of [0.3, 0.55, 0.78]) {
    const zz = hpx * t, rr = rx * Math.sqrt(Math.max(0, 1 - t * t));
    ctx.beginPath();
    ctx.ellipse(b.x, b.y - zz, rr, rr * (ry / rx) + 1.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(58,52,44,0.15)';
  for (let i = 0; i < 8; i++) {
    const a2 = (i / 8) * Math.PI * 2;
    const ex = Math.cos(a2) * rx, ey = Math.sin(a2) * ry;
    ctx.beginPath();
    ctx.moveTo(b.x + ex, b.y + ey);
    ctx.quadraticCurveTo(b.x + ex * 0.72, b.y + ey * 0.72 - hpx * 0.82, b.x, b.y - hpx);
    ctx.stroke();
  }
  ctx.restore();
  // springline ring
  ctx.strokeStyle = 'rgba(48,43,36,0.3)'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.ellipse(b.x, b.y, rx, ry, 0, 0, Math.PI);
  ctx.stroke();
  return { x: b.x, y: b.y - hpx };
}

export function cone(ctx, o) {
  const b = project(o.x, o.y, o.z || 0), t = project(o.x, o.y, (o.z || 0) + o.h);
  const rx = o.r * ERX, ry = o.r * ERY;
  ctx.beginPath();
  ctx.moveTo(t.x, t.y);
  ctx.lineTo(b.x - rx, b.y);
  ctx.ellipse(b.x, b.y, rx, ry, 0, Math.PI, 0, true);   // near half of the base
  ctx.closePath();
  ctx.fillStyle = shade(o.color, 0.84); ctx.fill();
  ctx.save(); ctx.clip();
  ctx.fillStyle = shade(o.color, 0.70); ctx.fillRect(b.x - rx, t.y - 2, rx * 0.55, (b.y - t.y) + ry + 4);
  ctx.fillStyle = shade(o.color, 1.0); ctx.fillRect(b.x - rx * 0.05, t.y - 2, rx * 0.55, (b.y - t.y) + ry + 4);
  ctx.restore();
  if (o.edge !== false) {
    ctx.strokeStyle = o.edge || EDGE; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y); ctx.lineTo(b.x - rx, b.y);
    ctx.moveTo(t.x, t.y); ctx.lineTo(b.x + rx, b.y);
    ctx.stroke();
  }
}

// Soft ground shadow, drawn from a cached sprite.
let shadowSpr = null;
export function shadow(ctx, x, y, z, rx, ry, a = 0.42) {
  if (!shadowSpr) {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(28,38,30,1)');
    grd.addColorStop(0.5, 'rgba(28,38,30,0.62)');
    grd.addColorStop(1, 'rgba(28,38,30,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.fill();
    shadowSpr = c;
  }
  const p = project(x, y, z);
  ctx.globalAlpha = a;
  ctx.drawImage(shadowSpr, p.x - rx, p.y - ry, rx * 2, ry * 2);
  ctx.globalAlpha = 1;
}

// Lattice pylon, drawn as separate pieces so it never swallows anything.
export function pylon(ctx, o) {
  const base = project(o.x, o.y, o.z), top = project(o.x, o.y, o.z + o.h);
  const wx = (o.w || 0.5) * TW;
  ctx.strokeStyle = o.color || 'rgba(74,80,86,0.95)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(base.x - wx, base.y); ctx.lineTo(top.x - wx * 0.28, top.y);
  ctx.moveTo(base.x + wx, base.y); ctx.lineTo(top.x + wx * 0.28, top.y);
  ctx.stroke();
  ctx.lineWidth = 1;
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const y0 = base.y + (top.y - base.y) * t0, y1 = base.y + (top.y - base.y) * t1;
    const w0 = wx + (wx * 0.28 - wx) * t0, w1 = wx + (wx * 0.28 - wx) * t1;
    ctx.beginPath();
    ctx.moveTo(base.x - w0, y0); ctx.lineTo(base.x + w1, y1);
    ctx.moveTo(base.x + w0, y0); ctx.lineTo(base.x - w1, y1);
    ctx.moveTo(base.x - w1, y1); ctx.lineTo(base.x + w1, y1);
    ctx.stroke();
  }
  for (const t of [0.72, 0.88]) {
    const yy = base.y + (top.y - base.y) * t;
    const aw = wx * 2.1 * (1 - (t - 0.72));
    ctx.beginPath(); ctx.moveTo(base.x - aw, yy - 2); ctx.lineTo(base.x + aw, yy - 2); ctx.stroke();
  }
  return top;
}

// ---- camera ---------------------------------------------------------------
export class Camera {
  constructor(w, h) {
    this.x = 0; this.y = 0; this.zoom = 1;
    this.w = w; this.h = h;
    this.targetZoom = 1; this.tx = 0; this.ty = 0;
    this.shake = 0; this.ox = 0; this.oy = 0;   // screen offset for panels
  }
  resize(w, h) { this.w = w; this.h = h; }
  toScreen(x, y, z = 0) {
    const p = project(x, y, z), c = project(this.x, this.y, 0);
    return [(p.x - c.x) * this.zoom + this.w / 2 + this.ox,
    (p.y - c.y) * this.zoom + this.h / 2 + this.oy];
  }
  screenToWorld(sx, sy) {
    const c = project(this.x, this.y, 0);
    return unproject((sx - this.w / 2 - this.ox) / this.zoom + c.x,
      (sy - this.h / 2 - this.oy) / this.zoom + c.y);
  }
  applyTransform(ctx) {
    const c = project(this.x, this.y, 0);
    let shx = 0, shy = 0;
    if (this.shake > 0.001) {
      shx = (Math.random() - 0.5) * this.shake * 24;
      shy = (Math.random() - 0.5) * this.shake * 24;
    }
    ctx.setTransform(this.zoom, 0, 0, this.zoom,
      this.w / 2 + this.ox - c.x * this.zoom + shx,
      this.h / 2 + this.oy - c.y * this.zoom + shy);
  }
  update(dt) {
    // frame-rate independent easing, ~0.25 s time constant
    const k = 1 - Math.pow(0.02, dt);
    this.zoom += (this.targetZoom - this.zoom) * k;
    this.x += (this.tx - this.x) * (1 - Math.pow(0.05, dt));
    this.y += (this.ty - this.y) * (1 - Math.pow(0.05, dt));
    this.shake *= Math.pow(0.06, dt);
    if (this.shake < 0.002) this.shake = 0;
  }
  focus(x, y, zoom) { this.tx = x; this.ty = y; if (zoom) this.targetZoom = zoom; }
  snap(x, y, zoom) { this.tx = this.x = x; this.ty = this.y = y; if (zoom) this.targetZoom = this.zoom = zoom; }
  jolt(a) { this.shake = Math.min(1.6, this.shake + a); }
}
