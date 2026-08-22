// ---------------------------------------------------------------------------
// props.js - the populated landscape: trees, houses, barns, boats, lamps,
// plus their burnt / flattened / irradiated states.
// Tree canopies are pre-rendered into sprite sheets: drawing five radial
// gradients per tree per frame is not something a phone will forgive.
// ---------------------------------------------------------------------------
import { MAT } from './textures.js';
import { P, box, cylinder, cone, shadow } from './draw3d.js';
import { TW, TH, EH } from './iso.js';
import { mulberry32, clamp, lerp, TAU } from './util.js';

const TREE = {};
const TSIZE = 96;
function treeSprite(kind) {
  if (TREE[kind]) return TREE[kind];
  const [form, health] = kind.split(':');
  const c = document.createElement('canvas');
  c.width = c.height = TSIZE;
  const g = c.getContext('2d');
  const R = mulberry32(form === 'conifer' ? 5 : 9);
  const dead = health === 'dead';
  const cx = TSIZE / 2, cy = TSIZE / 2;
  if (form === 'conifer') {
    const g0 = dead ? '#8a7838' : '#357a41', g1 = dead ? '#4d4324' : '#1b4526';
    for (let i = 0; i < 4; i++) {
      const t = i / 4;
      const w = (30 - i * 6), h = 26;
      const yy = cy + 26 - i * 15;
      const grd = g.createLinearGradient(cx - w, 0, cx + w, 0);
      grd.addColorStop(0, g1); grd.addColorStop(0.42, g0); grd.addColorStop(1, g1);
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(cx, yy - h); g.lineTo(cx - w, yy); g.lineTo(cx + w, yy); g.closePath();
      g.fill();
    }
  } else {
    const g0 = dead ? '#7a6a3a' : '#3f8438', g1 = dead ? '#4d4324' : '#25542a',
      g2 = dead ? '#93813f' : '#63ab4f';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.6;
      const rr = 21 * (0.6 + R() * 0.5);
      const px = cx + Math.cos(a) * 13, py = cy + 8 + Math.sin(a) * 6 - 8;
      const grd = g.createRadialGradient(px - rr * 0.32, py - rr * 0.42, rr * 0.1, px, py, rr);
      grd.addColorStop(0, g2); grd.addColorStop(0.6, g0); grd.addColorStop(1, g1);
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(px, py, rr, rr * 0.84, 0, 0, TAU); g.fill();
    }
  }
  TREE[kind] = c;
  return c;
}

export function drawProp(ctx, p, world, time) {
  const R = mulberry32(p.seed | 0);
  const contam = world.contam[world.idx(clamp(p.x | 0, 0, 47), clamp(p.y | 0, 0, 47))] || 0;
  const dead = clamp(contam * 0.9 + (1 - p.hp), 0, 1);
  const PF = window.__prof; const q0 = PF ? performance.now() : 0;
  const done = () => { if (PF) PF['t_' + p.type] = (PF['t_' + p.type] || 0) + (performance.now() - q0); };
  switch (p.type) {
    case 'tree': { const r = tree(ctx, p, R, dead, time); done(); return r; }
    case 'house': { const r = house(ctx, p, R, dead, contam); done(); return r; }
    case 'boat': return boat(ctx, p, R, time);
    case 'lamp': return lamp(ctx, p, world);
  }
}

function tree(ctx, p, R, dead, time) {
  const s = p.s;
  if (p.hp <= 0.12) {           // flattened / burnt stump
    shadow(ctx, p.x, p.y, p.z, 12 * s, 6 * s, 0.2);
    const b0 = P(p.x, p.y, p.z);
    ctx.fillStyle = 'rgba(38,30,24,0.95)';
    ctx.fillRect(b0[0] - 2 * s, b0[1] - 7 * s, 4 * s, 7 * s);
    ctx.strokeStyle = 'rgba(40,32,26,0.8)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(b0[0], b0[1]); ctx.lineTo(b0[0] + 14 * s, b0[1] + 3); ctx.stroke();
    return;
  }
  shadow(ctx, p.x, p.y, p.z, 16 * s, 8 * s, 0.24);
  const trunkH = 0.5 * s;
  const b = P(p.x, p.y, p.z);
  ctx.fillStyle = 'rgba(76,56,38,1)';
  ctx.fillRect(b[0] - 2 * s, b[1] - trunkH * EH, 4 * s, trunkH * EH);
  const spr = treeSprite((p.conifer ? 'conifer' : 'broad') + ':' + (dead > 0.55 ? 'dead' : 'live'));
  const sway = Math.sin(time * 1.1 + p.seed) * 1.4;
  const w = TSIZE * 0.55 * s, h = TSIZE * 0.55 * s;
  ctx.drawImage(spr, b[0] - w / 2 + sway, b[1] - trunkH * EH - h * 0.78, w, h);
  if (p.burn > 0.1) {
    const a = 0.35 + 0.3 * Math.sin(time * 9 + p.seed);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.fillStyle = 'rgba(255,170,70,0.5)';
    ctx.beginPath(); ctx.ellipse(b[0], b[1] - 10 * s, 16 * s, 12 * s, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function house(ctx, p, R, dead, contam) {
  const w = p.w, d = p.d;
  if (p.hp <= 0.25) {   // rubble
    shadow(ctx, p.x + w / 2, p.y + d / 2, p.z, 26, 13, 0.3);
    for (let i = 0; i < 9; i++) {
      const bx = p.x + R() * w, by = p.y + R() * d;
      box(ctx, bx, by, p.z, 0.16 + R() * 0.16, 0.14 + R() * 0.14, 0.08 + R() * 0.22,
        { wall: MAT.concreteDark, top: MAT.concreteDark, outline: false, k: 0.8 });
    }
    return;
  }
  const h = p.h * (p.tall ? 2.2 : 1);
  shadow(ctx, p.x + w / 2, p.y + d / 2, p.z, 30, 15, 0.28);
  const burnt = p.hp < 0.7;
  const wall = p.barn ? MAT.siding : (p.tall ? MAT.concrete : (R() > 0.5 ? MAT.stucco : MAT.brick));
  box(ctx, p.x, p.y, p.z, w, d, h, {
    wall, top: p.tall ? MAT.roof : MAT.tileRoof,
    k: burnt ? 0.62 : 1, tint: contam > 0.4 ? 'rgba(120,130,50,0.18)' : null
  });
  // pitched roof for small houses
  if (!p.tall) {
    const a = P(p.x, p.y, p.z + h), b = P(p.x + w, p.y, p.z + h);
    const c = P(p.x + w, p.y + d, p.z + h), e = P(p.x, p.y + d, p.z + h);
    const apex = P(p.x + w / 2, p.y + d / 2, p.z + h + 0.5);
    const faces = [[a, b], [b, c], [c, e], [e, a]];
    const ks = [0.78, 0.9, 1.0, 0.68];
    faces.forEach((f, i) => {
      ctx.beginPath();
      ctx.moveTo(f[0][0], f[0][1]); ctx.lineTo(f[1][0], f[1][1]); ctx.lineTo(apex[0], apex[1]);
      ctx.closePath();
      const base = burnt ? [70, 58, 52] : (p.barn ? [138, 62, 48] : [162, 82, 58]);
      ctx.fillStyle = `rgb(${base[0] * ks[i] | 0},${base[1] * ks[i] | 0},${base[2] * ks[i] | 0})`;
      ctx.fill();
    });
  }
  // lit windows
  if (!burnt) {
    const wx = P(p.x + w, p.y + d * 0.3, p.z + h * 0.45);
    ctx.fillStyle = 'rgba(255,214,140,0.55)';
    ctx.fillRect(wx[0] - 5, wx[1] - 6, 4, 5);
  }
  if (p.burn > 0.1) {
    const c = P(p.x + w / 2, p.y + d / 2, p.z + h);
    const grd = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], 26);
    grd.addColorStop(0, 'rgba(255,180,80,0.5)'); grd.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(c[0], c[1], 26, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}

function boat(ctx, p, R, time) {
  const bob = Math.sin(time * 1.6 + p.seed) * 0.06;
  const c = P(p.x, p.y, 0.12 + bob);
  const sunk = p.hp <= 0.4;
  ctx.save();
  ctx.translate(c[0], c[1]);
  if (sunk) ctx.rotate(0.5);
  ctx.fillStyle = sunk ? '#5a4a40' : '#d8d2c4';
  ctx.beginPath();
  ctx.moveTo(-11, 0); ctx.quadraticCurveTo(0, 7, 11, 0);
  ctx.quadraticCurveTo(0, -3, -11, 0); ctx.closePath(); ctx.fill();
  if (!sunk) {
    ctx.fillStyle = '#3f6d92'; ctx.fillRect(-3, -7, 7, 7);
    ctx.fillStyle = '#c8ccd0'; ctx.fillRect(-1, -12, 1.6, 6);
  }
  ctx.restore();
}

function lamp(ctx, p, world) {
  const b = P(p.x, p.y, p.z);
  ctx.strokeStyle = 'rgba(70,76,82,0.9)'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0], b[1] - 22); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(b[0], b[1] - 22); ctx.lineTo(b[0] + 5, b[1] - 24); ctx.stroke();
  const on = world.gridPower !== false;
  if (on) {
    const g = ctx.createRadialGradient(b[0] + 5, b[1] - 24, 0, b[0] + 5, b[1] - 24, 16);
    g.addColorStop(0, 'rgba(255,226,160,0.5)'); g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b[0] + 5, b[1] - 24, 16, 0, TAU); ctx.fill();
  }
}
