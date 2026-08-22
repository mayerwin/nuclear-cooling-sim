// ---------------------------------------------------------------------------
// textures.js — 100% procedural material library (no external assets)
// Every surface in the sim is generated here at boot into small tiling
// canvases, then used as CanvasPattern fills on skewed isometric faces.
// ---------------------------------------------------------------------------
import { mulberry32, fbm, noise2, clamp, lerp, rgb, mixRGB } from './util.js';

function surf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Fill a canvas with fbm-modulated base colour + optional speckle.
function baseNoise(c, col1, col2, scale, oct, seed) {
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      // tileable fbm via 4-way blend
      const w = c.width, h = c.height;
      const f = (xx, yy) => fbm(xx / scale + seed, yy / scale + seed * 1.7, oct);
      const fx = x / w, fy = y / h;
      const n =
        f(x, y) * (1 - fx) * (1 - fy) +
        f(x - w, y) * fx * (1 - fy) +
        f(x, y - h) * (1 - fx) * fy +
        f(x - w, y - h) * fx * fy;
      const t = clamp(n * 0.5 + 0.5, 0, 1);
      const col = mixRGB(col1, col2, t);
      const i = (y * w + x) * 4;
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return ctx;
}

const M = {};   // material canvases
export const MAT = {};  // material patterns

function reg(name, canvas) {
  M[name] = canvas;
  return canvas;
}

let BUILT = false;
export function buildMaterials(ctx2d) {
  if (BUILT) { const out = {}; for (const k in M) out[k] = ctx2d.createPattern(M[k], 'repeat'); Object.assign(MAT, out); return out; }
  BUILT = true;
  const R = mulberry32(99);

  // ---- concrete (poured, panel joints) ----
  {
    const c = surf(64, 64);
    const g = baseNoise(c, [176, 176, 172], [206, 206, 200], 9, 4, 3.1);
    g.globalAlpha = 0.20;
    for (let i = 0; i < 260; i++) {
      g.fillStyle = R() > 0.5 ? '#fff' : '#6b6b68';
      g.fillRect(R() * 64, R() * 64, 1, 1);
    }
    g.globalAlpha = 0.35; g.strokeStyle = '#8f8f8b'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 31.5); g.lineTo(64, 31.5); g.moveTo(31.5, 0); g.lineTo(31.5, 64); g.stroke();
    g.globalAlpha = 1;
    reg('concrete', c);
  }
  // ---- weathered dark concrete ----
  {
    const c = surf(64, 64);
    const g = baseNoise(c, [120, 122, 122], [156, 158, 156], 7, 4, 8.4);
    g.globalAlpha = 0.25;
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = '#7b7d7d'; g.lineWidth = R() * 1.2;
      g.beginPath();
      let x = R() * 64, y = R() * 64;
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (R() - 0.5) * 18; y += R() * 10; g.lineTo(x, y); }
      g.stroke();
    }
    g.globalAlpha = 1;
    reg('concreteDark', c);
  }
  // ---- containment shell (smooth painted steel-lined dome) ----
  {
    const c = surf(64, 64);
    const g = baseNoise(c, [198, 202, 205], [226, 230, 232], 14, 3, 2.2);
    g.globalAlpha = 0.12;
    for (let y = 0; y < 64; y += 8) { g.fillStyle = '#8ba0ad'; g.fillRect(0, y, 64, 1); }
    g.globalAlpha = 1;
    reg('shell', c);
  }
  // ---- ribbed metal siding (turbine hall) ----
  {
    const c = surf(48, 48);
    const g = baseNoise(c, [150, 160, 170], [184, 194, 203], 12, 3, 5.5);
    for (let x = 0; x < 48; x += 4) {
      g.globalAlpha = 0.5; g.fillStyle = '#e6edf3'; g.fillRect(x, 0, 1, 48);
      g.globalAlpha = 0.35; g.fillStyle = '#5f6b76'; g.fillRect(x + 2, 0, 1, 48);
    }
    g.globalAlpha = 1;
    reg('siding', c);
  }
  // ---- blue industrial roof ----
  {
    const c = surf(48, 48);
    const g = baseNoise(c, [58, 84, 108], [78, 108, 136], 11, 3, 1.4);
    for (let x = 0; x < 48; x += 6) {
      g.globalAlpha = 0.4; g.fillStyle = '#9dc0d8'; g.fillRect(x, 0, 1, 48);
      g.globalAlpha = 0.3; g.fillStyle = '#22364a'; g.fillRect(x + 3, 0, 1, 48);
    }
    g.globalAlpha = 1;
    reg('roof', c);
  }
  // ---- green roof (aux buildings) ----
  {
    const c = surf(48, 48);
    const g = baseNoise(c, [70, 92, 78], [96, 122, 102], 10, 3, 6.6);
    for (let x = 0; x < 48; x += 6) { g.globalAlpha = 0.3; g.fillStyle = '#c3d8c6'; g.fillRect(x, 0, 1, 48); }
    g.globalAlpha = 1;
    reg('roofGreen', c);
  }
  // ---- glazing / control-room windows ----
  {
    const c = surf(32, 32);
    const g = c.getContext('2d');
    g.fillStyle = '#20303c'; g.fillRect(0, 0, 32, 32);
    for (let y = 0; y < 32; y += 8) for (let x = 0; x < 32; x += 8) {
      const lit = R() > 0.55;
      const grd = g.createLinearGradient(x, y, x + 8, y + 8);
      if (lit) { grd.addColorStop(0, '#ffe9b0'); grd.addColorStop(1, '#d9a94e'); }
      else { grd.addColorStop(0, '#4d6b80'); grd.addColorStop(1, '#263b4c'); }
      g.fillStyle = grd; g.fillRect(x + 0.6, y + 0.6, 6.8, 6.8);
    }
    g.strokeStyle = '#59636b'; g.lineWidth = 1;
    for (let i = 0; i <= 32; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 32); g.moveTo(0, i); g.lineTo(32, i); g.stroke(); }
    reg('glass', c);
  }
  // ---- asphalt / roads ----
  {
    const c = surf(64, 64);
    const g = baseNoise(c, [52, 54, 58], [74, 76, 80], 6, 4, 4.4);
    g.globalAlpha = 0.3;
    for (let i = 0; i < 500; i++) { g.fillStyle = R() > 0.5 ? '#9aa' : '#222'; g.fillRect(R() * 64, R() * 64, 1, 1); }
    g.globalAlpha = 1;
    reg('asphalt', c);
  }
  // ---- gravel yard ----
  {
    const c = surf(64, 64);
    const g = baseNoise(c, [128, 124, 114], [162, 158, 146], 5, 4, 7.7);
    for (let i = 0; i < 700; i++) {
      g.globalAlpha = 0.35 + R() * 0.4;
      g.fillStyle = R() > 0.5 ? '#d6d0c2' : '#6e6a60';
      const s = R() * 1.6 + 0.6;
      g.fillRect(R() * 64, R() * 64, s, s);
    }
    g.globalAlpha = 1;
    reg('gravel', c);
  }
  // ---- rusted steel ----
  {
    const c = surf(48, 48);
    const g = baseNoise(c, [122, 74, 44], [166, 106, 62], 6, 4, 9.9);
    g.globalAlpha = 0.3;
    for (let i = 0; i < 200; i++) { g.fillStyle = R() > 0.5 ? '#3c2416' : '#d79a63'; g.fillRect(R() * 48, R() * 48, R() * 3, R() * 2); }
    g.globalAlpha = 1;
    reg('rust', c);
  }
  // ---- polished steel / tanks ----
  {
    const c = surf(48, 48);
    const g = baseNoise(c, [168, 176, 184], [206, 214, 220], 16, 3, 3.9);
    g.globalAlpha = 0.25;
    for (let y = 0; y < 48; y += 12) { g.fillStyle = '#6f7d88'; g.fillRect(0, y, 48, 1); }
    g.globalAlpha = 1;
    reg('steel', c);
  }
  // ---- copper / turbine housings ----
  {
    const c = surf(48, 48);
    baseNoise(c, [96, 106, 112], [130, 142, 148], 8, 3, 12.2);
    reg('machine', c);
  }
  // ---- brick (town) ----
  {
    const c = surf(48, 32);
    const g = baseNoise(c, [140, 84, 70], [172, 108, 88], 7, 3, 15.1);
    g.strokeStyle = 'rgba(220,214,205,0.55)'; g.lineWidth = 1;
    for (let y = 0; y <= 32; y += 8) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(48, y + 0.5); g.stroke(); }
    for (let y = 0, r = 0; y < 32; y += 8, r++) {
      for (let x = (r % 2) * 8; x <= 48; x += 16) {
        g.beginPath(); g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, y + 8); g.stroke();
      }
    }
    reg('brick', c);
  }
  // ---- stucco house walls ----
  {
    const c = surf(48, 48);
    baseNoise(c, [214, 206, 190], [240, 234, 220], 10, 3, 21.3);
    reg('stucco', c);
  }
  // ---- terracotta roof tiles ----
  {
    const c = surf(32, 24);
    const g = baseNoise(c, [150, 74, 52], [186, 100, 68], 6, 3, 17.7);
    g.strokeStyle = 'rgba(70,30,20,0.35)'; g.lineWidth = 1;
    for (let x = 0; x <= 32; x += 5) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 24); g.stroke(); }
    for (let y = 0; y <= 24; y += 8) {
      g.strokeStyle = 'rgba(255,200,170,0.28)';
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(32, y + 0.5); g.stroke();
    }
    reg('tileRoof', c);
  }
  // ---- solar-ish switchyard pad / transformer ----
  {
    const c = surf(32, 32);
    const g = baseNoise(c, [92, 96, 100], [122, 128, 132], 8, 3, 31.4);
    g.globalAlpha = 0.4;
    for (let x = 2; x < 32; x += 5) { g.fillStyle = '#3b4045'; g.fillRect(x, 0, 2, 32); }
    g.globalAlpha = 1;
    reg('transformer', c);
  }
  // ---- cooling-tower concrete (vertical formwork) ----
  {
    const c = surf(64, 64);
    const g = baseNoise(c, [166, 164, 158], [198, 196, 190], 10, 4, 27.2);
    g.globalAlpha = 0.22;
    for (let x = 0; x < 64; x += 6) { g.fillStyle = '#7d7c78'; g.fillRect(x, 0, 1, 64); }
    for (let y = 0; y < 64; y += 16) { g.fillStyle = '#8b8a86'; g.fillRect(0, y, 64, 1); }
    g.globalAlpha = 1;
    reg('towerConcrete', c);
  }
  // ---- graphite / core internals (Chernobyl debris) ----
  {
    const c = surf(32, 32);
    const g = baseNoise(c, [26, 26, 30], [62, 62, 68], 5, 4, 44.4);
    reg('graphite', c);
  }

  const out = {};
  for (const k in M) out[k] = ctx2d.createPattern(M[k], 'repeat');
  Object.assign(MAT, out);
  return out;
}

export function matCanvas(name) { return M[name]; }
