// ---------------------------------------------------------------------------
// draw3d.js — isometric solid primitives (textured boxes, cylinders,
// hyperboloid cooling towers, domes, pipes, lattices) + soft shadows
// ---------------------------------------------------------------------------
import { TW, TH, EH } from './iso.js';
import { clamp, lerp, TAU } from './util.js';

// project a world point to *unshifted* screen space (camera transform is
// already applied to the context)
export function P(x, y, z = 0) {
  return [(x - y) * (TW / 2), (x + y) * (TH / 2) - z * EH];
}

export const SHADE = { top: 1.0, right: 0.80, left: 0.60 };

// Fill parallelogram A -> A+u -> A+u+v -> A+v with a repeating pattern.
// Uses CanvasPattern.setTransform rather than clip()+fillRect: clipping is the
// single most expensive canvas operation and this scene draws hundreds of faces.
const _m = (typeof DOMMatrix !== 'undefined') ? new DOMMatrix() : null;
export function quadTex(ctx, A, B, D, pat, k, uTex, vTex, alpha = 1) {
  const C = [B[0] + D[0] - A[0], B[1] + D[1] - A[1]];
  ctx.beginPath();
  ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(D[0], D[1]);
  ctx.closePath();
  if (pat) {
    const a = (B[0] - A[0]) / uTex, b = (B[1] - A[1]) / uTex;
    const c = (D[0] - A[0]) / vTex, d = (D[1] - A[1]) / vTex;
    if (pat.setTransform && _m) {
      _m.a = a; _m.b = b; _m.c = c; _m.d = d; _m.e = A[0]; _m.f = A[1];
      pat.setTransform(_m);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = pat;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.save(); ctx.clip();
      ctx.transform(a, b, c, d, A[0], A[1]);
      ctx.fillStyle = pat; ctx.globalAlpha = alpha;
      ctx.fillRect(-0.5, -0.5, uTex + 1, vTex + 1);
      ctx.restore();
    }
  }
  if (k < 1) { ctx.fillStyle = `rgba(8,12,22,${(1 - k) * 0.92})`; ctx.fill(); }
  else if (k > 1) { ctx.fillStyle = `rgba(255,246,220,${(k - 1) * 0.8})`; ctx.fill(); }
}

export function quadFlat(ctx, A, B, D, style, alpha = 1) {
  const C = [B[0] + D[0] - A[0], B[1] + D[1] - A[1]];
  ctx.globalAlpha = alpha;
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(D[0], D[1]);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
}

// ---- ground shadow blob (pre-rendered sprite: a fresh radial gradient per
//      object per frame was costing more than every building put together) ---
let _shadowSpr = null;
function shadowSprite() {
  if (_shadowSpr) return _shadowSpr;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(10,18,26,1)');
  grd.addColorStop(0.55, 'rgba(10,18,26,0.55)');
  grd.addColorStop(1, 'rgba(10,18,26,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.fill();
  _shadowSpr = c;
  return c;
}
export function shadow(ctx, x, y, z, rx, ry, a = 0.3) {
  const c = P(x, y, z);
  const spr = shadowSprite();
  ctx.globalAlpha = a;
  ctx.drawImage(spr, c[0] - rx, c[1] - ry, rx * 2, ry * 2);
  ctx.globalAlpha = 1;
}

// ---- textured box ---------------------------------------------------------
// x,y = min corner in tiles; sx,sy = footprint; h = height in EH units
export function box(ctx, x, y, z, sx, sy, h, opt = {}) {
  const wall = opt.wall, top = opt.top || opt.wall;
  const tint = opt.tint || null;
  const den = opt.density || 34;

  // +x face (points down-left on screen)
  const a1 = P(x + sx, y, z + h), b1 = P(x + sx, y + sy, z + h);
  const d1 = P(x + sx, y, z);
  quadTex(ctx, a1, b1, d1, wall, SHADE.left * (opt.k || 1), sy * den, h * den * 0.62);
  // +y face (points down-right)
  const a2 = P(x, y + sy, z + h), b2 = P(x + sx, y + sy, z + h);
  const d2 = P(x, y + sy, z);
  quadTex(ctx, a2, b2, d2, wall, SHADE.right * (opt.k || 1), sx * den, h * den * 0.62);
  // top
  const t0 = P(x, y, z + h), t1 = P(x + sx, y, z + h), t3 = P(x, y + sy, z + h);
  quadTex(ctx, t0, t1, t3, top, SHADE.top * (opt.k || 1), sx * den, sy * den);

  if (tint) {
    quadFlat(ctx, a1, b1, d1, tint, 0.55);
    quadFlat(ctx, a2, b2, d2, tint, 0.45);
    quadFlat(ctx, t0, t1, t3, tint, 0.35);
  }
  if (opt.outline !== false) {
    ctx.strokeStyle = 'rgba(12,18,28,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(t0[0], t0[1]); ctx.lineTo(t1[0], t1[1]);
    const t2 = P(x + sx, y + sy, z + h);
    ctx.lineTo(t2[0], t2[1]); ctx.lineTo(t3[0], t3[1]); ctx.closePath();
    ctx.stroke();
  }
}

// ---- generic revolved solid: profile = [{t, r}] bottom->top -------------
export function revolve(ctx, cx, cy, z, h, profile, pat, opt = {}) {
  const k = opt.k || 1;
  const pts = [];
  for (const s of profile) {
    const zz = z + h * s.t;
    const c = P(cx, cy, zz);
    pts.push({ x: c[0], y: c[1], rx: s.r * TW * 0.7071, ry: s.r * TH * 0.7071 });
  }
  // silhouette
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x - pts[0].rx, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - pts[i].rx, pts[i].y);
  const tp = pts[pts.length - 1];
  ctx.ellipse(tp.x, tp.y, tp.rx, tp.ry, 0, Math.PI, 0, true);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x + pts[i].rx, pts[i].y);
  const bp = pts[0];
  ctx.ellipse(bp.x, bp.y, bp.rx, bp.ry, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.clip();

  let maxR = 0;
  for (const q of pts) if (q.rx > maxR) maxR = q.rx;
  const cxs = pts[0].x;
  const yTop = pts[pts.length - 1].y - pts[pts.length - 1].ry - 2;
  const yBot = pts[0].y + pts[0].ry + 2;
  if (pat) {
    ctx.save();
    ctx.fillStyle = pat;
    ctx.translate(cxs - maxR, yTop);
    ctx.fillRect(0, 0, maxR * 2, yBot - yTop);
    ctx.restore();
  }
  // cylindrical shading
  const g = ctx.createLinearGradient(cxs - maxR, 0, cxs + maxR, 0);
  g.addColorStop(0.00, `rgba(6,10,18,${0.55 * (2 - k)})`);
  g.addColorStop(0.26, `rgba(6,10,18,${0.14 * (2 - k)})`);
  g.addColorStop(0.46, `rgba(255,250,235,${0.20 * k})`);
  g.addColorStop(0.72, 'rgba(6,10,18,0.16)');
  g.addColorStop(1.00, 'rgba(6,10,18,0.52)');
  ctx.fillStyle = g;
  ctx.fillRect(cxs - maxR - 2, yTop, maxR * 2 + 4, yBot - yTop);
  if (opt.tint) { ctx.fillStyle = opt.tint; ctx.fillRect(cxs - maxR - 2, yTop, maxR * 2 + 4, yBot - yTop); }
  ctx.restore();

  // top rim
  if (opt.cap !== false) {
    ctx.beginPath();
    ctx.ellipse(tp.x, tp.y, tp.rx, tp.ry, 0, 0, TAU);
    ctx.fillStyle = opt.capColor || 'rgba(70,78,86,0.95)';
    ctx.fill();
    if (opt.capInner) {
      ctx.beginPath();
      ctx.ellipse(tp.x, tp.y, tp.rx * 0.86, tp.ry * 0.86, 0, 0, TAU);
      ctx.fillStyle = opt.capInner; ctx.fill();
    }
  }
  return tp;
}

export function cylinder(ctx, cx, cy, z, r, h, pat, opt = {}) {
  return revolve(ctx, cx, cy, z, h, [{ t: 0, r }, { t: 1, r }], pat, opt);
}

// natural-draught cooling tower silhouette (true hyperboloid of revolution)
export function coolingTower(ctx, cx, cy, z, r, h, pat, opt = {}) {
  const prof = [];
  const tw = 0.76, waist = 0.60, top = 0.70;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    let rr;
    if (t < tw) rr = r * (waist + (1 - waist) * Math.pow((tw - t) / tw, 1.85));
    else rr = r * (waist + (top - waist) * Math.pow((t - tw) / (1 - tw), 1.6));
    prof.push({ t, r: rr });
  }
  const tp = revolve(ctx, cx, cy, z, h, prof, pat, {
    ...opt, capColor: 'rgba(126,130,130,0.95)', capInner: 'rgba(26,30,34,0.95)'
  });
  // horizontal formwork lifts for scale
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.strokeStyle = '#3d4348'; ctx.lineWidth = 1;
  for (let i = 1; i < 16; i++) {
    const s2 = prof[i];
    const c = P(cx, cy, z + h * s2.t);
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], s2.r * TW * 0.7071, s2.r * TH * 0.7071, 0, 0, Math.PI);
    ctx.stroke();
  }
  ctx.restore();
  return tp;
}

// hemispherical dome
export function dome(ctx, cx, cy, z, r, hFrac, pat, opt = {}) {
  const prof = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    prof.push({ t, r: r * Math.cos(t * Math.PI * 0.5) });
  }
  return revolve(ctx, cx, cy, z, r * hFrac * (EH ? (TH / EH) * 1.0 : 1) * 1.0, prof, pat,
    { ...opt, cap: false });
}

// ---- pipe run (elevated cylinder along an axis) ---------------------------
export function pipe(ctx, x0, y0, x1, y1, z, rad, col = '#9aa6ae', shadeCol = '#4d5760') {
  const a = P(x0, y0, z), b = P(x1, y1, z);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  const w = rad * TH;
  ctx.beginPath();
  ctx.moveTo(a[0] + nx * w, a[1] + ny * w);
  ctx.lineTo(b[0] + nx * w, b[1] + ny * w);
  ctx.lineTo(b[0] - nx * w, b[1] - ny * w);
  ctx.lineTo(a[0] - nx * w, a[1] - ny * w);
  ctx.closePath();
  const g = ctx.createLinearGradient(a[0] + nx * w, a[1] + ny * w, a[0] - nx * w, a[1] - ny * w);
  g.addColorStop(0, shadeCol); g.addColorStop(0.4, col); g.addColorStop(1, shadeCol);
  ctx.fillStyle = g; ctx.fill();
}

// ---- lattice pylon / transmission tower ----------------------------------
export function pylon(ctx, x, y, z, h, w = 0.5, col = 'rgba(78,86,94,0.95)') {
  const base = P(x, y, z), top = P(x, y, z + h);
  const wx = w * TW * 0.5;
  ctx.strokeStyle = col; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(base[0] - wx, base[1]); ctx.lineTo(top[0] - wx * 0.28, top[1]);
  ctx.moveTo(base[0] + wx, base[1]); ctx.lineTo(top[0] + wx * 0.28, top[1]);
  ctx.stroke();
  ctx.lineWidth = 1;
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const y0 = lerp(base[1], top[1], t0), y1 = lerp(base[1], top[1], t1);
    const w0 = lerp(wx, wx * 0.28, t0), w1 = lerp(wx, wx * 0.28, t1);
    ctx.beginPath();
    ctx.moveTo(base[0] - w0, y0); ctx.lineTo(base[0] + w1, y1);
    ctx.moveTo(base[0] + w0, y0); ctx.lineTo(base[0] - w1, y1);
    ctx.moveTo(base[0] - w1, y1); ctx.lineTo(base[0] + w1, y1);
    ctx.stroke();
  }
  // cross-arms
  for (const t of [0.72, 0.88]) {
    const yy = lerp(base[1], top[1], t);
    const aw = wx * 2.1 * (1 - (t - 0.72));
    ctx.beginPath();
    ctx.moveTo(base[0] - aw, yy - 2); ctx.lineTo(base[0] + aw, yy - 2); ctx.stroke();
  }
  return top;
}

// ---- generic cone (tree canopy, sirens) ----------------------------------
export function cone(ctx, cx, cy, z, r, h, c0, c1) {
  const b = P(cx, cy, z), t = P(cx, cy, z + h);
  const rx = r * TW * 0.7071, ry = r * TH * 0.7071;
  ctx.beginPath();
  ctx.moveTo(t[0], t[1]);
  ctx.lineTo(b[0] - rx, b[1]);
  ctx.ellipse(b[0], b[1], rx, ry, 0, Math.PI, 0, false);
  ctx.closePath();
  const g = ctx.createLinearGradient(b[0] - rx, 0, b[0] + rx, 0);
  g.addColorStop(0, c1); g.addColorStop(0.42, c0); g.addColorStop(1, c1);
  ctx.fillStyle = g; ctx.fill();
}
