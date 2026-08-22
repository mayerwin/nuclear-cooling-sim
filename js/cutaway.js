// ---------------------------------------------------------------------------
// cutaway.js - the inside of both stations, cut open, with the fluids moving.
//
// The section runs along the map's anti-diagonal: a point at section
// coordinate u maps to grid (ox + u/2, oy - u/2), for which x + y is constant.
// A constant x + y projects to a constant screen row, so the cut plane reads as
// a clean elevation while every solid standing in it is still drawn with the
// same isometric primitives as the site view.
//
// Everything animated here is read from plant.sys, which the physics model
// fills in on the step it computes the heat balance. Nothing here invents a
// flow: if a loop is moving on screen it is moving in the model, and if it has
// stopped, the model stopped it.
// ---------------------------------------------------------------------------
import { project, shade, rgba, mix, hash2, poly, polyLine, TW, TH, TZ } from './iso.js';
import { MODE } from './plant.js';

const STEEL = '#9aa4ad';
const STEEL_D = '#6e777f';
const CONC_D = '#a8a399';
const VOID = '#10161c';
const H2COL = '#d9e04a';
const AIR = '#7fd0e4';
const ERX = TW * 1.41421, ERY = TH * 1.41421;
const ZS = 1.5;                 // height stretch, so a section fills the frame

// Water blue when cold, sand when hot, into the glow of a bare fuel rod.
// Deliberately avoids passing through green: green reads as "fine".
const RAMP = [
  [290, '#2f7fd0'], [480, '#35a8d4'], [620, '#3fc2b4'], [780, '#b7c25a'],
  [950, '#e0a03c'], [1300, '#e2662a'], [1700, '#ef3a22'], [2500, '#ffd8a0'],
  [3200, '#fff6e2']
];
export function tempColor(K) {
  if (K <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i++) {
    if (K <= RAMP[i][0]) {
      return mix(RAMP[i - 1][1], RAMP[i][1],
        (K - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const CUT_GAP = 8.75;     // grid offset between the two sections

export class CutawayView {
  constructor(plant, ox, oy) {
    this.plant = plant;
    this.ox = ox; this.oy = oy;
    this.passive = plant.mode === MODE.PASSIVE;
    this.labels = true;
    this.caps = [];
    this.tagQ = [];
  }

  // section coordinate -> grid
  gx(u) { return this.ox + u * 0.5; }
  gy(u) { return this.oy - u * 0.5; }
  P(u, z) { return project(this.gx(u), this.gy(u), z * ZS); }

  // ---- primitives, all in section coordinates -------------------------
  vessel(ctx, o) {
    const { u, r, z0, z1 } = o;
    const top = this.P(u, z1), bot = this.P(u, z0);
    const rx = r * ERX, ry = r * ERY;
    ctx.beginPath();
    ctx.moveTo(bot.x - rx, bot.y);
    ctx.lineTo(top.x - rx, top.y);
    ctx.ellipse(top.x, top.y, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(bot.x + rx, bot.y);
    ctx.ellipse(bot.x, bot.y, rx, ry, 0, 0, Math.PI, false);
    ctx.closePath();
    ctx.fillStyle = o.void || VOID;
    ctx.fill();

    const lv = Math.max(z0, Math.min(z1, o.level === undefined ? z0 : o.level));
    ctx.save();
    ctx.clip();
    if (lv > z0 + 0.001) {
      const surf = this.P(u, lv);
      ctx.fillStyle = o.liquid || '#2f7fd0';
      ctx.fillRect(top.x - rx - 1, surf.y, rx * 2 + 2, (bot.y + ry) - surf.y + 2);
      ctx.beginPath();
      ctx.ellipse(surf.x, surf.y, rx, ry, 0, Math.PI, 0, false);
      ctx.fillStyle = shade(o.liquid || '#2f7fd0', 1.3);
      ctx.fill();
    }
    if (lv < z1 - 0.02) {
      // whatever is above the water is NOT water: dark, with a steam haze
      const surf = this.P(u, lv);
      ctx.fillStyle = 'rgba(10,14,19,0.72)';
      ctx.fillRect(top.x - rx - 1, top.y - ry - 2, rx * 2 + 2, surf.y - (top.y - ry) + 2);
      if (o.steam) {
        ctx.fillStyle = `rgba(200,216,228,${0.06 + 0.13 * o.steam})`;
        ctx.fillRect(top.x - rx - 1, top.y - ry - 2, rx * 2 + 2, surf.y - (top.y - ry) + 2);
      }
      // a bright waterline so the level is unmissable
      ctx.strokeStyle = shade(o.liquid || '#2f7fd0', 1.5);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(surf.x, surf.y, rx, ry, 0, Math.PI, 0, false);
      ctx.stroke();
    }
    if (o.inner) o.inner(ctx);
    ctx.restore();

    // walls: two bright cut edges and the visible half of each rim
    ctx.strokeStyle = o.wall || STEEL;
    ctx.lineWidth = o.wallW || 3.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bot.x - rx, bot.y); ctx.lineTo(top.x - rx, top.y);
    ctx.moveTo(bot.x + rx, bot.y); ctx.lineTo(top.x + rx, top.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(bot.x, bot.y, rx, ry, 0, 0, Math.PI);
    ctx.stroke();
    if (o.head) {
      ctx.beginPath();
      ctx.moveTo(top.x - rx, top.y);
      ctx.bezierCurveTo(top.x - rx, top.y - rx * 0.75, top.x + rx, top.y - rx * 0.75,
        top.x + rx, top.y);
      ctx.fillStyle = shade(o.wall || STEEL, 0.95);
      ctx.fill();
      ctx.strokeStyle = 'rgba(28,26,22,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(top.x, top.y, rx, ry, 0, Math.PI, 0, true);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(24,22,18,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bot.x - rx, bot.y); ctx.lineTo(top.x - rx, top.y);
    ctx.moveTo(bot.x + rx, bot.y); ctx.lineTo(top.x + rx, top.y);
    ctx.stroke();
    return { top, bot, rx, ry };
  }

  pool(ctx, o) {
    const { u0, u1, z0, z1, level } = o;
    const A = this.P(u0, z1), B = this.P(u1, z1);
    const C = this.P(u1, z0), D = this.P(u0, z0);
    ctx.fillStyle = o.void || VOID;
    poly(ctx, [A, B, C, D]);
    const lv = Math.max(z0, Math.min(z1, level));
    if (lv > z0 + 0.001) {
      const a = this.P(u0, lv), b = this.P(u1, lv);
      ctx.fillStyle = o.liquid || '#2f7fd0';
      poly(ctx, [a, b, C, D]);
      ctx.strokeStyle = shade(o.liquid || '#2f7fd0', 1.35);
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.strokeStyle = o.wall || CONC_D;
    ctx.lineWidth = 3.2; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.lineTo(D.x, D.y); ctx.lineTo(C.x, C.y); ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }

  pipe(ctx, uz, o) {
    const p = uz.map(q => this.P(q[0], q[1]));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const w = (o.w || 7);
    ctx.strokeStyle = 'rgba(20,18,16,0.55)'; ctx.lineWidth = w + 3;
    polyLine(ctx, p, false);
    ctx.strokeStyle = o.wall || STEEL_D; ctx.lineWidth = w;
    polyLine(ctx, p, false);
    const col = o.color || '#2f7fd0';
    ctx.strokeStyle = o.flow > 0 ? col : shade(col, 0.5);
    ctx.lineWidth = Math.max(2, w - 3.5);
    polyLine(ctx, p, false);
    if (o.flow > 0) {
      ctx.save();
      ctx.strokeStyle = shade(col, 1.5);
      ctx.lineWidth = Math.max(1.5, w - 5);
      ctx.setLineDash([5, 12]);
      ctx.lineDashOffset = -(o.phase || 0) * 30 * o.flow * (o.reverse ? -1 : 1);
      polyLine(ctx, p, false);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  valve(ctx, u, z, open) {
    const p = this.P(u, z);
    ctx.beginPath();
    ctx.moveTo(p.x - 5.5, p.y - 5.5); ctx.lineTo(p.x + 5.5, p.y + 5.5);
    ctx.lineTo(p.x + 5.5, p.y - 5.5); ctx.lineTo(p.x - 5.5, p.y + 5.5);
    ctx.closePath();
    ctx.fillStyle = open ? '#5fd08a' : '#c8564a';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16,14,12,0.7)'; ctx.lineWidth = 1; ctx.stroke();
  }

  pump(ctx, u, z, running, time) {
    const p = this.P(u, z);
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = running ? '#5f8fd0' : '#5b6167';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16,14,12,0.7)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(running ? time * 7 : 0.4);
    ctx.strokeStyle = running ? '#eaf4ff' : '#8b9198';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      ctx.rotate(Math.PI * 2 / 3);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(6, 0); ctx.stroke();
    }
    ctx.restore();
  }

  arrows(ctx, uz, o) {
    if (!o.flow) return;
    const p = uz.map(q => this.P(q[0], q[1]));
    const segs = []; let total = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const L = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
      segs.push(L); total += L;
    }
    if (!total) return;
    const n = Math.max(2, Math.round(total / 40));
    const ph = ((o.phase || 0) * o.flow * 0.45) % 1;
    for (let k = 0; k < n; k++) {
      let t = ((k + ph) / n) * total, i = 0;
      while (i < segs.length && t > segs[i]) { t -= segs[i]; i++; }
      if (i >= segs.length) continue;
      const a = p[i], b = p[i + 1], L = segs[i] || 1;
      const cx = a.x + (b.x - a.x) * (t / L), cy = a.y + (b.y - a.y) * (t / L);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.atan2((b.y - a.y) / L, (b.x - a.x) / L));
      ctx.fillStyle = o.color || AIR;
      ctx.globalAlpha = o.alpha === undefined ? 0.9 : o.alpha;
      ctx.beginPath();
      ctx.moveTo(7, 0); ctx.lineTo(-4.5, 4); ctx.lineTo(-4.5, -4);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  bubbles(ctx, u, z0, z1, r, rate, time, seed) {
    if (rate <= 0 || z1 <= z0) return;
    const n = Math.min(20, Math.round(4 + rate * 16));
    for (let i = 0; i < n; i++) {
      const t = ((time * (0.5 + hash2(i, seed, 2) * 0.9) + hash2(i, seed, 1)) % 1);
      const p = this.P(u + (hash2(i, seed, 3) - 0.5) * r * 1.5, z0 + (z1 - z0) * t);
      ctx.fillStyle = `rgba(240,250,255,${0.55 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.4 + hash2(i, seed, 4) * 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  tag(ctx, u, z, text, tone, dy) {
    const p = this.P(u, z);
    this.tagQ.push({ x: p.x, y: p.y + (dy || 0), text, tone });
  }

  flushTags(ctx) {
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    const placed = [];
    for (const t of this.tagQ) {
      const w = ctx.measureText(t.text).width + 12;
      for (let k = 0; k < 12; k++) {
        let hit = false;
        for (const q of placed) {
          if (Math.abs(q.x - t.x) < (q.w + w) / 2 + 5 && Math.abs(q.y - t.y) < 19) { hit = true; break; }
        }
        if (!hit) break;
        t.y -= 19;
      }
      placed.push({ x: t.x, y: t.y, w });
      this.paintTag(ctx, t);
    }
    this.tagQ.length = 0;
  }

  paintTag(ctx, o) {
    const p = { x: o.x, y: o.y };
    const text = o.text, tone = o.tone;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    const y = p.y;
    ctx.fillStyle = tone === 'hot' ? 'rgba(74,20,14,0.92)'
      : tone === 'warn' ? 'rgba(72,50,10,0.92)'
        : tone === 'ok' ? 'rgba(10,44,28,0.9)' : 'rgba(12,20,28,0.88)';
    rr(ctx, p.x - w / 2, y - 8, w, 16, 4); ctx.fill();
    ctx.strokeStyle = tone === 'hot' ? 'rgba(255,120,90,0.65)'
      : tone === 'warn' ? 'rgba(255,196,77,0.6)'
        : tone === 'ok' ? 'rgba(99,224,138,0.55)' : 'rgba(150,200,230,0.35)';
    ctx.lineWidth = 1;
    rr(ctx, p.x - w / 2, y - 8, w, 16, 4); ctx.stroke();
    ctx.fillStyle = tone === 'hot' ? '#ffd6c9' : tone === 'warn' ? '#ffe3ab'
      : tone === 'ok' ? '#c9f7d9' : '#d8e8f4';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x, y);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // Captions are queued, not drawn: a caption painted inline gets covered by
  // whatever geometry comes after it, and two of them land on top of each other.
  caption(ctx, u, z, text) {
    if (!this.labels) return;
    const p = this.P(u, z);
    this.caps.push({ x: p.x, y: p.y, text });
  }

  flushCaptions(ctx) {
    ctx.font = '500 9.5px ui-sans-serif, system-ui, sans-serif';
    const placed = [];
    for (const c of this.caps) {
      const w = ctx.measureText(c.text).width;
      let y = c.y;
      for (let k = 0; k < 10; k++) {
        let hit = false;
        for (const q of placed) {
          if (Math.abs(q.x - c.x) < (q.w + w) / 2 + 6 && Math.abs(q.y - y) < 12) { hit = true; break; }
        }
        if (!hit) break;
        y -= 12;
      }
      placed.push({ x: c.x, y, w });
      ctx.fillStyle = 'rgba(10,16,22,0.72)';
      ctx.fillRect(c.x - w / 2 - 3, y - 8, w + 6, 12);
      ctx.fillStyle = 'rgba(186,208,224,0.92)';
      ctx.textAlign = 'center';
      ctx.fillText(c.text, c.x, y + 1);
      ctx.textAlign = 'left';
    }
    this.caps.length = 0;
  }

  // =====================================================================
  draw(ctx, time) {
    const p = this.plant, s = p.sys || {};
    this.shell(ctx);

    const rpv = { u: this.passive ? 4.9 : 3.7, r: 1.05, z0: 1.7, z1: 6.7 };
    const coreZ0 = 2.4, coreZ1 = 4.4;
    // 0% means the vessel is empty, not 'empty down to the core'
    const surf = rpv.z0 + Math.max(0, Math.min(1, p.level)) * (rpv.z1 - 0.6 - rpv.z0);
    const wt = Math.min(640, p.Tclad);

    this.atmosphere(ctx, time);          // gas fills the space behind the kit
    if (this.passive) this.passiveScene(ctx, rpv, surf, time);
    else this.activeScene(ctx, rpv, surf, time);

    // ---- the vessel itself, drawn last so nothing crosses it -----------
    this.vessel(ctx, {
      u: rpv.u, r: rpv.r, z0: rpv.z0, z1: rpv.z1,
      level: surf, liquid: tempColor(wt), wall: STEEL, head: true,
      steam: p.level < 0.995 ? 1 : 0.25,
      inner: (c) => this.core(c, rpv, coreZ0, coreZ1, surf, time)
    });
    this.bubbles(ctx, rpv.u, rpv.z0 + 0.2, surf, rpv.r, s.boil || 0, time, 11);
    if (p.scrammed) {
      ctx.strokeStyle = 'rgba(70,78,86,0.95)'; ctx.lineWidth = 2;
      for (let i = -2; i <= 2; i++) {
        const a = this.P(rpv.u + i * 0.34, coreZ1);
        const b = this.P(rpv.u + i * 0.34, rpv.z1 + 0.6);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      this.caption(ctx, rpv.u, rpv.z1 + 1.05, 'control rods in');
    }
    this.caption(ctx, rpv.u, rpv.z0 - 0.45, 'reactor vessel');

    this.breachMarks(ctx, time);
    this.powerSpine(ctx, time);
    this.readouts(ctx, rpv, surf);
    this.flushCaptions(ctx);
    this.flushTags(ctx);
  }

  // ---- the building shell --------------------------------------------
  shell(ctx) {
    const P_ = this.passive;
    const inner = { u0: 0.7, u1: 12.3, zTop: P_ ? 10.8 : 10.4, apex: P_ ? 13.6 : 13.8 };
    const A = this.P(inner.u0, inner.zTop), B = this.P(inner.u1, inner.zTop);
    const C = this.P(inner.u1, 0.55), D = this.P(inner.u0, 0.55);
    const apexY = this.P(6.5, inner.apex).y;
    ctx.beginPath();
    ctx.moveTo(D.x, D.y); ctx.lineTo(A.x, A.y);
    ctx.bezierCurveTo(A.x, apexY, B.x, apexY, B.x, B.y);
    ctx.lineTo(C.x, C.y);
    ctx.closePath();
    ctx.fillStyle = '#161d25';
    ctx.fill();
    // floor slab
    const F = this.P(inner.u0 - 0.4, 0.55), G = this.P(inner.u1 + 0.4, 0.55);
    const F2 = this.P(inner.u0 - 0.4, 0.0), G2 = this.P(inner.u1 + 0.4, 0.0);
    ctx.fillStyle = '#5a564d';
    poly(ctx, [F, G, G2, F2]);

    ctx.strokeStyle = P_ ? STEEL : CONC_D;
    ctx.lineWidth = P_ ? 6 : 9;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(D.x, D.y); ctx.lineTo(A.x, A.y);
    ctx.bezierCurveTo(A.x, apexY, B.x, apexY, B.x, B.y);
    ctx.lineTo(C.x, C.y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(20,18,16,0.45)'; ctx.lineWidth = 1; ctx.stroke();
    this.caption(ctx, P_ ? 1.6 : 6.5, P_ ? 11.6 : inner.apex + 0.6,
      P_ ? 'steel containment vessel' : 'reinforced concrete containment');

    if (P_) {
      // the shield building, and the annulus the draught runs up
      const o0 = this.P(-0.35, 11.4), o1 = this.P(13.35, 11.4);
      const c0 = this.P(-0.35, 0.0), c1 = this.P(13.35, 0.0);
      const oApex = this.P(6.5, 14.8).y;
      ctx.strokeStyle = CONC_D; ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(c0.x, c0.y); ctx.lineTo(o0.x, o0.y);
      ctx.bezierCurveTo(o0.x, oApex, o1.x, oApex, o1.x, o1.y);
      ctx.lineTo(c1.x, c1.y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(20,18,16,0.4)'; ctx.lineWidth = 1; ctx.stroke();
      this.caption(ctx, 10.2, 12.35, 'shield building + chimney');
    }
    ctx.lineWidth = 1;
  }

  // ---- fuel -----------------------------------------------------------
  core(ctx, rpv, z0, z1, surf, time) {
    const p = this.plant;
    const n = 9;
    for (let i = 0; i < n; i++) {
      const u = rpv.u - rpv.r * 0.68 + (i / (n - 1)) * rpv.r * 1.36;
      const a = this.P(u, z1), b = this.P(u, z0);
      const T = surf >= z1 ? Math.min(p.Tclad, 700) : p.Tclad;
      ctx.strokeStyle = T < 700 ? '#7d8a95' : tempColor(T);
      ctx.lineWidth = 4.6;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(12,14,16,0.55)'; ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (surf < z1 && p.Tclad > 680) {
      const top = this.P(rpv.u, z1), bot = this.P(rpv.u, Math.max(z0, surf));
      const g = ctx.createLinearGradient(0, top.y, 0, bot.y);
      const a = Math.min(0.8, (p.Tclad - 680) / 1300);
      g.addColorStop(0, `rgba(255,150,60,${a})`);
      g.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(top.x - rpv.r * ERX, top.y, rpv.r * ERX * 2, bot.y - top.y);
    }
    if (p.meltFrac > 0.02) {
      const b = this.P(rpv.u, rpv.z0 + 0.12);
      ctx.fillStyle = `rgba(255,${(150 - 100 * p.meltFrac) | 0},44,${0.55 + 0.4 * p.meltFrac})`;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, rpv.r * ERX * 0.92, rpv.r * ERY * 0.9 + 7 * p.meltFrac, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Gen-II ---------------------------------------------------------
  activeScene(ctx, rpv, surf, time) {
    const p = this.plant, s = p.sys || {};
    const hot = tempColor(Math.min(645, p.Tcore));
    const cold = tempColor(560);
    const flow = Math.max(s.rcp, s.natCirc);

    // sump / suppression water
    this.pool(ctx, {
      u0: 0.85, u1: 12.15, z0: 0.55, z1: 1.65,
      level: 0.55 + 1.0 * (p.vesselBreach ? 0.35 : 1), liquid: tempColor(p.Tctmt)
    });

    // steam generator
    const sg = { u: 8.9, r: 1.0, z0: 1.7, z1: 9.0 };
    this.vessel(ctx, {
      u: sg.u, r: sg.r, z0: sg.z0, z1: sg.z1,
      level: sg.z0 + (s.feed || s.aux || s.rcic ? 4.9 : 2.4),
      liquid: tempColor(555), wall: STEEL, head: true, steam: 1,
      inner: (c) => {
        c.strokeStyle = 'rgba(200,210,218,0.55)'; c.lineWidth = 2;
        for (let i = -2; i <= 2; i++) {
          const a = this.P(sg.u + i * 0.3, sg.z0 + 0.5);
          const b = this.P(sg.u + i * 0.3, sg.z0 + 4.2);
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        }
      }
    });
    this.caption(ctx, sg.u, sg.z0 - 0.45, 'steam generator');

    // pressuriser and the relief valve that ruined TMI
    const pz = { u: 6.3, r: 0.46, z0: 6.2, z1: 9.3 };
    this.vessel(ctx, {
      u: pz.u, r: pz.r, z0: pz.z0, z1: pz.z1,
      level: pz.z0 + 2.0 * Math.max(0.15, Math.min(1, p.level)),
      liquid: tempColor(618), wall: STEEL, head: true, steam: 1
    });
    this.valve(ctx, pz.u, pz.z1 + 0.5, p.leakRate > 0);
    this.caption(ctx, pz.u + 0.9, pz.z1 + 1.1, 'pressuriser + relief valve');

    // primary loop
    this.pipe(ctx, [[rpv.u, rpv.z1 - 0.5], [rpv.u + 0.9, rpv.z1 + 0.7],
    [sg.u - 0.7, rpv.z1 + 0.7], [sg.u, sg.z0 + 1.9]],
      { w: 8, color: hot, flow, phase: time });
    this.pipe(ctx, [[sg.u, sg.z0 + 0.5], [sg.u - 1.0, sg.z0 - 0.55],
    [rpv.u + 1.2, sg.z0 - 0.55], [rpv.u, rpv.z0 + 0.7]],
      { w: 8, color: cold, flow, phase: time });
    this.pump(ctx, rpv.u + 2.1, sg.z0 - 0.55, s.rcp > 0, time);
    this.caption(ctx, rpv.u + 2.2, sg.z0 - 1.25,
      s.rcp > 0 ? 'coolant pump running' : 'coolant pump stopped');
    if (s.natCirc > 0 && !s.rcp) {
      this.arrows(ctx, [[rpv.u, rpv.z1 - 0.5], [sg.u - 0.7, rpv.z1 + 0.7]],
        { flow: s.natCirc, phase: time, color: '#ffd27a' });
    }

    // accumulators: the one passive thing a Gen-II plant already has
    for (let i = 0; i < 2; i++) {
      const u = 10.6 + i * 1.0;
      this.vessel(ctx, {
        u, r: 0.36, z0: 3.0, z1: 4.7,
        level: 3.0 + 1.7 * Math.max(0, Math.min(1, p.accumLevel)),
        liquid: '#2f7fd0', wall: STEEL, head: true
      });
      this.pipe(ctx, [[u, 3.0], [u, 2.35], [rpv.u + 0.8, rpv.z0 + 0.8]],
        { w: 4.5, color: '#2f7fd0', flow: s.accum, phase: time });
    }
    this.caption(ctx, 11.1, 5.35, 'accumulators (~1 min)');

    // emergency injection - a pump, and a pump needs a bus
    const inj = s.aux > 0;
    this.pipe(ctx, [[1.4, 2.4], [2.3, 2.4], [rpv.u - 0.9, rpv.z0 + 0.5]],
      { w: 6, color: '#2f7fd0', flow: inj ? 1 : 0, phase: time });
    this.pump(ctx, 1.4, 2.4, inj, time);
    const needed = p.scrammed && p.coolingMargin < 1.0;
    this.tag(ctx, 2.0, 3.5,
      inj ? 'ECCS RUNNING' : needed ? 'ECCS CANNOT RUN' : 'ECCS standby',
      inj ? 'ok' : needed ? 'hot' : null);

    // containment sprays, which also need that bus
    if (s.sprays > 0) {
      ctx.strokeStyle = 'rgba(130,196,240,0.75)'; ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const u = 1.6 + i * 1.35;
        const a = this.P(u, 9.9);
        const b = this.P(u, 9.9 - 1.1 - ((time * 2 + i * 0.27) % 1) * 1.7);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      this.caption(ctx, 3.4, 10.5, 'containment sprays');
    }

    // the power cycle and its heat sink: the sea, reached by yet more pumps
    const sink = p.uhs && s.feed > 0;
    this.pipe(ctx, [[sg.u, sg.z1 - 0.4], [12.9, sg.z1 - 0.4], [12.9, 4.6], [14.6, 4.6]],
      { w: 6, color: '#cfd8de', flow: s.feed ? 1 : 0, phase: time });
    this.pipe(ctx, [[14.6, 3.4], [12.6, 3.4], [12.6, 2.2], [sg.u + 0.5, 2.2]],
      { w: 6, color: tempColor(330), flow: s.feed ? 1 : 0, phase: time });
    this.pump(ctx, 14.0, 3.4, s.feed > 0, time);
    this.pipe(ctx, [[15.0, 3.4], [15.9, 3.4]],
      { w: 7, color: sink ? '#2f7fd0' : '#4a5058', flow: sink ? 1 : 0, phase: time });
    this.caption(ctx, 15.2, 4.15, p.uhs ? 'to the sea' : 'HEAT SINK LOST');

    // the vent, and whether anybody can open it
    this.valve(ctx, 11.7, 9.4, p.vented);
    this.pipe(ctx, [[11.7, 9.4], [12.9, 9.4], [12.9, 13.2]],
      { w: 6, color: '#c9d4dc', flow: p.vented ? 1 : 0, phase: time });
    this.caption(ctx, 12.9, 13.85, 'hardened vent');
  }

  // ---- Gen-III+ -------------------------------------------------------
  passiveScene(ctx, rpv, surf, time) {
    const p = this.plant, s = p.sys || {};
    const hot = tempColor(Math.min(645, p.Tcore));

    this.pool(ctx, {
      u0: 0.85, u1: 12.15, z0: 0.55, z1: 1.75,
      level: 0.55 + 1.1 * (s.gravity ? 1 : 0.45), liquid: tempColor(p.Tctmt)
    });

    const sg = { u: 9.3, r: 0.92, z0: 1.7, z1: 8.6 };
    this.vessel(ctx, {
      u: sg.u, r: sg.r, z0: sg.z0, z1: sg.z1, level: sg.z0 + 4.5,
      liquid: tempColor(552), wall: STEEL, head: true, steam: 1
    });
    this.caption(ctx, sg.u, sg.z0 - 0.45, 'steam generator');

    const flow = Math.max(s.rcp, s.natCirc);
    this.pipe(ctx, [[rpv.u, rpv.z1 - 0.5], [rpv.u + 1.0, rpv.z1 + 0.6], [sg.u, sg.z0 + 1.9]],
      { w: 8, color: hot, flow, phase: time });
    this.pipe(ctx, [[sg.u, sg.z0 + 0.5], [rpv.u + 1.3, sg.z0 - 0.5], [rpv.u, rpv.z0 + 0.7]],
      { w: 8, color: tempColor(560), flow, phase: time });
    this.pump(ctx, rpv.u + 2.2, sg.z0 - 0.5, s.rcp > 0, time);

    // IRWST: 2,000 t of borated water, inside containment, above the core
    const irw = { u0: 0.95, u1: 3.5, z0: 6.3, z1: 9.3 };
    const irwLvl = irw.z0 + (irw.z1 - irw.z0) * Math.max(0.08, Math.min(1, p.irwst / 2.1e6));
    this.pool(ctx, {
      u0: irw.u0, u1: irw.u1, z0: irw.z0, z1: irw.z1,
      level: irwLvl, liquid: tempColor(Math.min(372, p.Tctmt)), wall: STEEL
    });
    this.caption(ctx, (irw.u0 + irw.u1) / 2, irw.z1 + 0.55, 'IRWST 2,000 t');

    // PRHR heat exchanger, a coil in that pool on a thermosiphon
    const hx = { u: 2.2, z0: irw.z0 + 0.4, z1: irw.z1 - 0.5 };
    ctx.strokeStyle = s.prhr > 0 ? tempColor(Math.min(620, p.Tcore)) : STEEL_D;
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    for (let i = 0; i <= 14; i++) {
      const q = this.P(hx.u + (i % 2 ? 0.48 : -0.48), hx.z0 + (hx.z1 - hx.z0) * (i / 14));
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    this.pipe(ctx, [[rpv.u, rpv.z1 - 0.8], [rpv.u - 0.9, rpv.z1 + 1.0], [hx.u, hx.z0]],
      { w: 7, color: hot, flow: s.prhr, phase: time });
    this.pipe(ctx, [[hx.u, hx.z1], [0.7, hx.z1 + 0.3], [0.7, 3.0], [rpv.u - 1.15, rpv.z0 + 0.9]],
      { w: 7, color: tempColor(400), flow: s.prhr, phase: time });
    if (s.prhr > 0) {
      this.arrows(ctx, [[rpv.u - 0.9, rpv.z1 + 1.0], [hx.u, hx.z0]],
        { flow: s.prhr, phase: time, color: '#ffd27a' });
      this.bubbles(ctx, hx.u, hx.z0, irwLvl, 0.7, 0.6, time, 21);
    }
    this.caption(ctx, hx.u - 0.2, hx.z1 + 0.4, 'PRHR heat exchanger');

    // core makeup tanks
    for (let i = 0; i < 2; i++) {
      const u = 6.6 + i * 1.15;
      this.vessel(ctx, {
        u, r: 0.4, z0: 7.4, z1: 9.7,
        level: 7.4 + 2.3 * Math.max(0, Math.min(1, p.cmtLevel)),
        liquid: '#2f7fd0', wall: STEEL, head: true
      });
      this.pipe(ctx, [[u, 7.4], [u, 6.3], [rpv.u + 0.6, rpv.z0 + 1.5]],
        { w: 5, color: '#2f7fd0', flow: s.cmt, phase: time });
    }
    this.caption(ctx, 7.2, 10.4, 'core makeup tanks');

    // accumulators
    for (let i = 0; i < 2; i++) {
      const u = 10.4 + i * 1.05;
      this.vessel(ctx, {
        u, r: 0.38, z0: 3.1, z1: 4.9,
        level: 3.1 + 1.8 * Math.max(0, Math.min(1, p.accumLevel)),
        liquid: '#2f7fd0', wall: STEEL, head: true
      });
      this.pipe(ctx, [[u, 3.1], [u, 2.4], [rpv.u + 0.7, rpv.z0 + 0.8]],
        { w: 4.5, color: '#2f7fd0', flow: s.accum, phase: time });
    }
    this.caption(ctx, 10.9, 5.45, 'accumulators');

    // automatic depressurisation into the pool
    this.valve(ctx, 5.9, 10.2, s.ads);
    if (s.ads) {
      this.pipe(ctx, [[5.9, 10.2], [2.9, 10.2], [2.9, irwLvl + 0.25]],
        { w: 5, color: '#dbe6ee', flow: 1, phase: time });
    }
    this.caption(ctx, 5.9, 10.8, s.ads ? 'ADS OPEN' : 'ADS armed');

    // gravity injection straight down into the vessel
    this.pipe(ctx, [[irw.u0 + 0.5, irw.z0], [irw.u0 + 0.5, 2.1], [rpv.u - 0.95, rpv.z0 + 0.5]],
      { w: 7, color: '#2f7fd0', flow: s.gravity, phase: time });
    this.valve(ctx, irw.u0 + 0.5, 3.6, s.gravity > 0);

    // the power cycle and its heat sink exist here too - the difference is
    // that nothing safety-related depends on them
    this.pipe(ctx, [[sg.u, sg.z1 - 0.4], [12.9, sg.z1 - 0.4], [12.9, 4.6], [14.6, 4.6]],
      { w: 6, color: '#cfd8de', flow: s.feed ? 1 : 0, phase: time });
    this.pipe(ctx, [[14.6, 3.4], [12.6, 3.4], [12.6, 2.2], [sg.u + 0.5, 2.2]],
      { w: 6, color: tempColor(330), flow: s.feed ? 1 : 0, phase: time });
    this.pump(ctx, 14.0, 3.4, s.feed > 0, time);
    this.pipe(ctx, [[15.0, 3.4], [15.9, 3.4]],
      { w: 7, color: p.uhs && s.feed ? '#2f7fd0' : '#4a5058', flow: p.uhs && s.feed ? 1 : 0, phase: time });
    this.caption(ctx, 15.0, 4.2, p.uhs ? 'to the sea' : 'heat sink lost (not needed here)');

    if (p.sabotaged) {
      this.tag(ctx, 6.5, 12.0, 'PASSIVE SYSTEMS DISABLED (what-if)', 'hot');
      ctx.save();
      ctx.strokeStyle = 'rgba(255,90,70,0.75)'; ctx.lineWidth = 3;
      for (const [u, z] of [[2.6, 7.8], [6.6, 8.5], [10.9, 4.0], [1.45, 4.6]]) {
        const q = this.P(u, z);
        ctx.beginPath();
        ctx.moveTo(q.x - 11, q.y - 11); ctx.lineTo(q.x + 11, q.y + 11);
        ctx.moveTo(q.x + 11, q.y - 11); ctx.lineTo(q.x - 11, q.y + 11);
        ctx.stroke();
      }
      ctx.restore();
    }

    this.pccs(ctx, time);
  }

  // passive containment cooling: film outside, draught up the annulus
  pccs(ctx, time) {
    const p = this.plant, s = p.sys || {};
    const on = s.pccs > 0;
    this.arrows(ctx, [[0.15, 12.2], [0.15, 3.0], [0.4, 1.4]],
      { flow: on ? 0.9 : 0, phase: time, color: AIR, alpha: 0.85 });
    this.arrows(ctx, [[12.85, 1.4], [12.85, 9.2], [10.6, 12.9], [6.5, 15.6]],
      { flow: on ? 0.9 : 0, phase: time, color: '#f2b877', alpha: 0.9 });
    const tank = { u0: 4.9, u1: 8.1, z0: 13.9, z1: 15.0 };
    const lvl = tank.z0 + (tank.z1 - tank.z0) * Math.max(0, Math.min(1, p.pccwst / 3.0e6));
    this.pool(ctx, {
      u0: tank.u0, u1: tank.u1, z0: tank.z0, z1: tank.z1,
      level: lvl, liquid: '#2f7fd0', wall: STEEL
    });
    this.tag(ctx, (tank.u0 + tank.u1) / 2, tank.z1 + 0.75,
      `${(p.pccwst / 1000) | 0} t of water, above everything`, 'ok');
    if (s.film > 0 && on) {
      ctx.strokeStyle = 'rgba(130,206,244,0.8)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 10; i++) {
        const t = ((time * 0.45 + i * 0.1) % 1);
        const u = 1.0 + i * 1.15;
        const zTop = 10.8 - Math.abs(u - 6.5) * 0.28;
        const a = this.P(u, zTop - t * 9.0);
        const b = this.P(u, zTop - t * 9.0 - 0.7);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      this.caption(ctx, 9.6, 11.5, 'evaporating water film');
    }
  }

  // ---- what the end states actually look like -------------------------
  breachMarks(ctx, time) {
    const p = this.plant;
    const u0 = 0.85, u1 = 12.15;
    if (p.vesselBreach) {
      // a hole torn in the vessel bottom, and corium on the containment floor
      const rpvU = this.passive ? 4.9 : 3.7, rpvZ0 = 1.7;
      const a = this.P(rpvU - 0.55, rpvZ0), b = this.P(rpvU + 0.55, rpvZ0);
      ctx.strokeStyle = '#0d1116'; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const c = this.P(rpvU, 0.62);
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 90);
      const f = 0.55 + 0.2 * Math.sin(time * 2);
      g.addColorStop(0, `rgba(255,196,90,${f})`);
      g.addColorStop(0.45, `rgba(238,104,36,${f * 0.7})`);
      g.addColorStop(1, 'rgba(170,40,14,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, 90, 22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e2621f';
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 46 + 14 * p.mcci, 11 + 3 * p.mcci, 0, 0, Math.PI * 2);
      ctx.fill();
      this.caption(ctx, rpvU + 2.6, 0.95, 'corium on the floor');
    }
    if (p.explosions > 0 || p.rupturedByPower) {
      // the top of the building is gone
      const A = this.P(u0 - 0.3, 10.4), B = this.P(u1 + 0.3, 10.4);
      ctx.fillStyle = '#121c26';                      // open sky, not a void
      ctx.fillRect(A.x - 6, A.y - 260, B.x - A.x + 12, 260);
      ctx.strokeStyle = '#8b8579'; ctx.lineWidth = 6; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i <= 26; i++) {
        const u = u0 - 0.3 + (u1 - u0 + 0.6) * (i / 26);
        const q = this.P(u, 10.4 + hash2(i, 3, 1) * 0.9);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,130,70,0.55)'; ctx.lineWidth = 2;
      ctx.stroke();
      this.tag(ctx, 6.5, 11.4, 'ROOF BLOWN OFF', 'hot');
    }
  }

  // ---- containment atmosphere ------------------------------------------
  atmosphere(ctx, time) {
    const p = this.plant;
    const u0 = 0.85, u1 = 12.15;
    const hz = Math.max(0, Math.min(0.45, (p.Tctmt - 320) / 170));
    if (hz > 0.01) {
      const A = this.P(u0, 10.2), B = this.P(u1, 10.2);
      const C = this.P(u1, 1.7), D = this.P(u0, 1.7);
      ctx.fillStyle = `rgba(226,238,246,${hz * 0.45})`;
      poly(ctx, [A, B, C, D]);
    }
    const h2f = Math.min(1, (p.h2 + p.h2Building) / 900);
    if (h2f > 0.01) {
      const zTop = 10.35, zBot = 10.35 - h2f * 7.0;
      const a = this.P(u0, zTop), b = this.P(u1, zTop);
      const c = this.P(u1, zBot), d = this.P(u0, zBot);
      ctx.fillStyle = rgba(H2COL, 0.10 + 0.22 * h2f);
      poly(ctx, [a, b, c, d]);
      ctx.strokeStyle = rgba(H2COL, 0.65); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(c.x, c.y); ctx.stroke();
      this.tag(ctx, 6.5, zBot + 0.6, `hydrogen ${(p.h2 + p.h2Building) | 0} kg`, 'hot');
    }
    if (!p.ctmtIntact && p.explosions === 0) {
      this.tag(ctx, 6.5, 11.1, 'CONTAINMENT FAILED', 'hot');
    }
  }

  // ---- the electrical chain -------------------------------------------
  powerSpine(ctx, time) {
    const p = this.plant, s = p.sys || {};
    const z = -1.8;
    const items = [
      { u: 1.1, label: 'GRID', on: !!s.grid },
      { u: 4.9, label: 'DIESEL', on: !!s.diesel },
      { u: 8.7, label: 'BATTERY', on: s.battery > 0 },
      { u: 12.5, label: 'PUMPS', on: s.rcp > 0 || s.aux > 0 }
    ];
    for (let i = 0; i < items.length - 1; i++) {
      const live = items[i].on && items[i + 1].on;
      this.pipe(ctx, [[items[i].u + 0.55, z], [items[i + 1].u - 0.55, z]],
        { w: 4, wall: '#333a41', color: live ? '#ffd35c' : '#3f454b', flow: live ? 1.6 : 0, phase: time });
    }
    for (const it of items) {
      const q = this.P(it.u, z);
      ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = it.on ? '#ffd35c' : '#3f454b';
      ctx.fill();
      ctx.strokeStyle = 'rgba(16,14,12,0.7)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.font = '700 8.5px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = it.on ? '#f8e9bd' : '#7d848b';
      ctx.textAlign = 'center';
      ctx.fillText(it.label, q.x, q.y + 21);
      ctx.textAlign = 'left';
    }
    const c = this.P(6.5, z - 1.35);
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    if (this.passive) {
      ctx.fillStyle = '#8ff0b4';
      ctx.fillText('nothing above this line depends on this row', c.x, c.y);
    } else {
      // describe the plant, not the lamps: a lit GRID lamp with no cooling
      // path is exactly the contradiction a reader would call out
      const cooled = p.coolingMargin >= 0.99;
      const onBattery = !s.grid && !s.diesel && s.battery > 0;
      let txt, col;
      if (!cooled) { txt = 'no cooling path left - the chain is broken'; col = '#ff9080'; }
      else if (onBattery) {
        txt = `running on batteries - ${(s.battery * p.batteryHours).toFixed(1)} h left`;
        col = '#ffd28a';
      } else { txt = 'every cooling path above needs this chain'; col = 'rgba(200,214,226,0.8)'; }
      ctx.fillStyle = col;
      ctx.fillText(txt, c.x, c.y);
    }
    ctx.textAlign = 'left';
  }

  // ---- numbers on the picture ------------------------------------------
  readouts(ctx, rpv, surf) {
    const p = this.plant;
    const covered = p.level > 0.995;
    const T = p.Tclad - 273;
    this.tag(ctx, rpv.u, rpv.z1 + 1.55, `${T.toFixed(0)} \u00b0C`,
      T > 800 ? 'hot' : T > 360 ? 'warn' : 'ok');
    const a = this.P(rpv.u - 1.85, surf), b = this.P(rpv.u - 1.12, surf);
    ctx.strokeStyle = covered ? 'rgba(99,224,138,0.85)' : 'rgba(255,120,90,0.95)';
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    this.tag(ctx, rpv.u - 2.35, surf, `${(p.level * 100).toFixed(0)}%`,
      covered ? 'ok' : p.level > 0.75 ? 'warn' : 'hot');
  }

  title(ctx) {
    const p = this.plant;
    const q = this.P(6.5, 18.4);
    ctx.textAlign = 'center';
    ctx.font = '800 15px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = this.passive ? '#57d9ff' : '#ff8b5c';
    ctx.fillText(this.passive ? 'PASSIVE \u00b7 Gen III+' : 'ACTIVE \u00b7 Gen II', q.x, q.y);
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(200,218,232,0.7)';
    ctx.fillText(this.passive
      ? 'gravity \u00b7 natural circulation \u00b7 evaporation'
      : 'pumps \u00b7 diesels \u00b7 operators', q.x, q.y + 15);
    // the state, big enough to read across the room
    const good = /SAFE|NORMAL|STABLE/.test(p.state);
    ctx.font = '800 12px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(p.state).width + 20;
    const by = q.y + 26;
    ctx.fillStyle = good ? 'rgba(16,58,36,0.9)' : 'rgba(74,18,12,0.9)';
    rr(ctx, q.x - w / 2, by, w, 20, 5); ctx.fill();
    ctx.strokeStyle = good ? 'rgba(99,224,138,0.55)' : 'rgba(255,110,80,0.6)';
    ctx.lineWidth = 1.2;
    rr(ctx, q.x - w / 2, by, w, 20, 5); ctx.stroke();
    ctx.fillStyle = good ? '#8ff0b4' : '#ff9c88';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.state, q.x, by + 10.5);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  }
}
