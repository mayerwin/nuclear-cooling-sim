// ---------------------------------------------------------------------------
// util.js — deterministic RNG, value noise, colour + math helpers
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const rnd = (r, a, b) => a + (b - a) * r();
export const pick = (r, arr) => arr[(r() * arr.length) | 0];
export const TAU = Math.PI * 2;

// --- value noise -----------------------------------------------------------
const P = new Uint8Array(512);
{
  const r = mulberry32(1337);
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 512; i++) P[i] = perm[i & 255];
}
const grad2 = (h, x, y) => {
  switch (h & 7) {
    case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
    case 4: return x; case 5: return -x; case 6: return y; default: return -y;
  }
};
export function noise2(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = smooth(xf), v = smooth(yf);
  const aa = P[P[X] + Y], ab = P[P[X] + Y + 1];
  const ba = P[P[X + 1] + Y], bb = P[P[X + 1] + Y + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 0.7071;
}
export function fbm(x, y, oct = 4, lac = 2.0, gain = 0.5) {
  let f = 1, a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise2(x * f, y * f); n += a; f *= lac; a *= gain; }
  return s / n;
}
export const ridge = (x, y, oct = 4) => 1 - Math.abs(fbm(x, y, oct)) * 2;

// --- colour ----------------------------------------------------------------
export function hsl(h, s, l, a = 1) {
  return `hsla(${h},${s}%,${l}%,${a})`;
}
export function mixRGB(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
export const rgb = (c, a = 1) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
export function shade(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

export function fmtTime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export function fmtNum(v, unit = '', dec = 0) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  let s;
  if (abs >= 1e9) s = (v / 1e9).toFixed(2) + 'G';
  else if (abs >= 1e6) s = (v / 1e6).toFixed(2) + 'M';
  else if (abs >= 1e3) s = (v / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'k';
  else s = v.toFixed(dec);
  return s + unit;
}
