// ---------------------------------------------------------------------------
// props.js - the populated landscape. Every prop is drawn live inside the one
// sorted pass; nothing is baked, so nothing can pop in and out of a cached
// layer or land on the wrong side of a building.
// ---------------------------------------------------------------------------
import {
  project, box, prism, cylinder, cone, shadow, shade, rgba, mix,
  hash2, poly, polyLine, TW, TH, TZ, EDGE
} from './iso.js?v=26b57b2691';

const TRUNK = '#6b5138';
const LEAF_LIVE = ['#4e8f45', '#5aa04e', '#438239', '#67ab55'];
const LEAF_DEAD = ['#8a7c3e', '#9a8b46', '#7a6d36'];
const CONIF_LIVE = ['#2f6f45', '#357a4b', '#2a6440'];
const CONIF_DEAD = ['#6f6a3a', '#7b7442'];

const WALLS = ['#e6ddc9', '#dcd2bc', '#e9e2d2', '#d3c9b4'];
const ROOFS = ['#b4523f', '#a2472f', '#c05c44', '#8f5140'];
const BLOCK = ['#c9c8c2', '#bdbcb6', '#d2d1ca'];

export function propKey(p) {
  if (p.type === 'house') return p.x + p.y + (p.w + p.d) * 0.5;
  return p.x + p.y;
}

export function drawProp(ctx, p, world, time) {
  const gx = Math.max(0, Math.min(world.W - 1, p.x | 0));
  const gy = Math.max(0, Math.min(world.H - 1, p.y | 0));
  const contam = world.contam[gy * world.W + gx] || 0;
  const dead = Math.min(1, contam * 0.8 + (1 - p.hp));
  switch (p.type) {
    case 'tree': return tree(ctx, p, dead, time);
    case 'house': return house(ctx, p, dead, contam, time);
    case 'boat': return boat(ctx, p, time);
    case 'lamp': return lamp(ctx, p, world);
    case 'silo': return silo(ctx, p);
  }
}

// ---- trees ----------------------------------------------------------------
function tree(ctx, p, dead, time) {
  const s = p.s;
  if (p.hp <= 0.12) {                        // snapped / burnt stump
    shadow(ctx, p.x, p.y, p.z, 9 * s, 5 * s, 0.2);
    cylinder(ctx, { x: p.x, y: p.y, z: p.z, r: 0.07 * s, h: 0.28 * s, color: '#3a2f26' });
    const b = project(p.x, p.y, p.z);
    ctx.strokeStyle = 'rgba(58,47,38,0.85)'; ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + 13 * s, b.y + 3 * s);
    ctx.stroke();
    return;
  }
  shadow(ctx, p.x, p.y, p.z, 15 * s, 8 * s, 0.24);
  const burnt = p.hp < 0.55;
  const trunkH = (p.conifer ? 0.30 : 0.5) * s;
  const b0 = project(p.x, p.y, p.z);
  ctx.fillStyle = burnt ? '#3d3128' : TRUNK;
  ctx.fillRect(b0.x - 2.1 * s, b0.y - trunkH * TZ, 4.2 * s, trunkH * TZ + 1);
  const pal = p.conifer
    ? (dead > 0.5 ? CONIF_DEAD : CONIF_LIVE)
    : (dead > 0.5 ? LEAF_DEAD : LEAF_LIVE);
  const col = burnt ? '#4a4034' : pal[(hash2(p.gx, p.gy, 3) * pal.length) | 0];

  if (p.conifer) {
    // three tiers, drawn bottom first so each sits in front of the one above
    for (let i = 0; i < 3; i++) {
      cone(ctx, {
        x: p.x, y: p.y, z: p.z + trunkH + i * 0.40 * s,
        r: (0.60 - i * 0.155) * s, h: 0.78 * s,
        color: mix(col, '#e2f2d6', i * 0.13)
      });
    }
  } else {
    // three overlapping lobes, each a squat revolve-free blob
    const lobes = [
      { dx: 0, dy: 0, dz: 0.52, r: 0.62 },
      { dx: -0.20, dy: 0.14, dz: 0.30, r: 0.46 },
      { dx: 0.21, dy: -0.10, dz: 0.34, r: 0.44 }
    ];
    for (const L of lobes) {
      const c = project(p.x + L.dx * s, p.y + L.dy * s, p.z + trunkH + L.dz * s);
      const rr = L.r * s * TW * 0.8;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rr, rr * 0.86, 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(col, 0.86); ctx.fill();
      ctx.beginPath();
      ctx.ellipse(c.x - rr * 0.22, c.y - rr * 0.24, rr * 0.7, rr * 0.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = shade(col, 1.06); ctx.fill();
    }
    const c = project(p.x, p.y, p.z + trunkH + 0.52 * s);
    ctx.strokeStyle = 'rgba(46,58,40,0.28)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 0.62 * s * TW * 0.8, 0.62 * s * TW * 0.8 * 0.86, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (p.burn > 0.1) fireGlow(ctx, p.x, p.y, p.z + trunkH, 16 * s, time, p.gx);
}

// ---- buildings ------------------------------------------------------------
function house(ctx, p, dead, contam, time) {
  const w = p.w, d = p.d;
  if (p.hp <= 0.28) {                          // rubble
    shadow(ctx, p.x + w / 2, p.y + d / 2, p.z, 22, 12, 0.28);
    for (let i = 0; i < 7; i++) {
      const hx = hash2(p.gx * 7 + i, p.gy, 5), hy = hash2(p.gx, p.gy * 7 + i, 9);
      box(ctx, {
        x: p.x + hx * w * 0.7, y: p.y + hy * d * 0.7, z: p.z,
        w: 0.16 + hx * 0.16, d: 0.14 + hy * 0.14, h: 0.08 + hy * 0.2,
        color: '#8c877e', edge: false
      });
    }
    return;
  }
  const burnt = p.hp < 0.72;
  const seed = (p.gx * 31 + p.gy * 17) | 0;
  const h = p.h * (p.tall ? 2.3 : 1);
  shadow(ctx, p.x + w / 2, p.y + d / 2, p.z, 26, 14, 0.26);

  let wall = p.tall ? BLOCK[(hash2(p.gx, p.gy, 2) * BLOCK.length) | 0]
    : WALLS[(hash2(p.gx, p.gy, 1) * WALLS.length) | 0];
  if (burnt) wall = mix(wall, '#4a4038', 0.65);
  if (contam > 0.35) wall = mix(wall, '#9a9a55', Math.min(0.45, contam * 0.3));

  if (p.barn) {
    box(ctx, { x: p.x, y: p.y, z: p.z, w, d, h: h * 0.62, color: burnt ? '#5b4d42' : '#9c5a44' });
    gable(ctx, p.x, p.y, p.z + h * 0.62, w, d, 0.42, burnt ? '#3f362f' : '#7d4234');
  } else if (p.tall) {
    box(ctx, {
      x: p.x, y: p.y, z: p.z, w, d, h, color: wall,
      windows: { cols: 3, rows: Math.max(2, Math.round(h * 1.5)), seed, dark: '#7d8f9c' }
    });
    box(ctx, { x: p.x + 0.1, y: p.y + 0.1, z: p.z + h, w: w - 0.2, d: d - 0.2, h: 0.12, color: '#8d8b84', edge: false });
  } else {
    box(ctx, {
      x: p.x, y: p.y, z: p.z, w, d, h, color: wall,
      windows: { cols: 2, rows: Math.max(1, Math.round(h * 1.2)), seed, dark: '#7d8f9c' }
    });
    gable(ctx, p.x, p.y, p.z + h, w, d, 0.46,
      burnt ? '#4a3f36' : ROOFS[(hash2(p.gx, p.gy, 4) * ROOFS.length) | 0]);
  }
  if (p.burn > 0.1) fireGlow(ctx, p.x + w / 2, p.y + d / 2, p.z + h, 22, time, p.gx);
}

// Pitched roof with the ridge running along +x. Both slopes are visible.
function gable(ctx, x, y, z, w, d, h, c) {
  const my = y + d / 2, tz = z + h;
  const A = project(x, y, z), B = project(x + w, y, z);
  const C = project(x + w, y + d, z), D = project(x, y + d, z);
  const R1 = project(x, my, tz), R2 = project(x + w, my, tz);
  ctx.fillStyle = shade(c, 1.03); poly(ctx, [A, B, R2, R1]);
  ctx.fillStyle = shade(c, 0.86); poly(ctx, [B, R2, C]);
  ctx.fillStyle = shade(c, 0.74); poly(ctx, [D, C, R2, R1]);
  ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.lineJoin = 'round';
  polyLine(ctx, [A, B, R2, R1], true);
  polyLine(ctx, [D, C, R2, R1], true);
  polyLine(ctx, [B, R2, C], true);
}

function silo(ctx, p) {
  shadow(ctx, p.x, p.y, p.z, 16, 9, 0.24);
  cylinder(ctx, { x: p.x, y: p.y, z: p.z, r: 0.34, h: 1.5, color: '#cfcabb', rib: 4 });
  cone(ctx, { x: p.x, y: p.y, z: p.z + 1.5, r: 0.38, h: 0.4, color: '#8d8b84' });
}

function boat(ctx, p, time) {
  const bob = Math.sin(time * 1.5 + p.gx) * 0.05;
  const c = project(p.x, p.y, 0.1 + bob);
  const sunk = p.hp <= 0.4;
  ctx.save();
  ctx.translate(c.x, c.y);
  if (sunk) ctx.rotate(0.45);
  ctx.fillStyle = sunk ? '#5c4a3e' : '#e4dccb';
  ctx.beginPath();
  ctx.moveTo(-11, 0); ctx.quadraticCurveTo(0, 7, 11, 0);
  ctx.quadraticCurveTo(0, -3, -11, 0); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(60,52,42,0.45)'; ctx.lineWidth = 1; ctx.stroke();
  if (!sunk) {
    ctx.fillStyle = '#4a7ba0'; ctx.fillRect(-3, -7, 7, 7);
    ctx.fillStyle = '#cfd4d8'; ctx.fillRect(-1, -12, 1.6, 6);
  }
  ctx.restore();
}

function lamp(ctx, p, world) {
  const b = project(p.x, p.y, p.z);
  ctx.strokeStyle = 'rgba(80,84,88,0.9)'; ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y - 20);
  ctx.lineTo(b.x + 5, b.y - 22);
  ctx.stroke();
  ctx.fillStyle = world.gridPower === false ? 'rgba(120,124,128,0.8)' : 'rgba(255,226,160,0.9)';
  ctx.beginPath(); ctx.arc(b.x + 5.5, b.y - 22, 2.2, 0, Math.PI * 2); ctx.fill();
}

function fireGlow(ctx, x, y, z, r, time, seed) {
  const a = 0.30 + 0.22 * Math.sin(time * 8 + seed);
  const c = project(x, y, z);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.max(0, a);
  ctx.fillStyle = 'rgba(255,168,64,0.6)';
  ctx.beginPath(); ctx.ellipse(c.x, c.y, r, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
