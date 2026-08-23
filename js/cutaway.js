// ---------------------------------------------------------------------------
// cutaway.js - the inside of both stations, drawn as a process mimic.
//
// Design rules, taken from the standards this kind of display actually has:
//
//   ISA-101 (high-performance HMI). Normal operation is drawn quiet and
//   desaturated; saturated colour is reserved for deviation from normal. That
//   is not just convention here, it is the lesson: the passive unit stays grey
//   and blue for the whole scenario while the active unit lights up.
//
//   ISA-5.1 (instrumentation symbols). A centrifugal pump is a circle with a
//   triangle, a valve is a bow-tie, a heat exchanger is a coil in its shell,
//   a vessel carries a level scale beside it with marked trip points. Readers
//   who know P&IDs read this for free; readers who do not still get shapes
//   that stay distinct from each other.
//
//   Level is shown the way a control room shows it: a scale with BAF and TAF
//   (bottom / top of active fuel) marked, an indicator that tracks the real
//   number, and a colour change the moment the water drops past the fuel.
//
//   Flow is encoded twice - line weight proportional to flow, plus a moving
//   chevron - because a static dashed line does not say which way anything is
//   going, and direction is half the story in a natural-circulation loop.
//
//   Equipment that needs electricity is marked. That marker is the difference
//   between the two plants, made visible without reading a word.
//
// The section maps u (across) and z (up) to grid (ox + u/2, oy - u/2) at
// height z*ZS. x + y is then constant along the section, and a constant x + y
// projects to a constant screen row, so the cut reads as a true elevation
// while everything standing in it is still drawn with the isometric
// primitives used by the site view.
//
// Every animated quantity is read from plant.sys, which the model fills in on
// the step it computes the heat balance.
// ---------------------------------------------------------------------------
import { project, shade, rgba, mix, hash2, poly, polyLine, TW, TH, TZ } from './iso.js';
import { MODE } from './plant.js';

const ZS = 1.5;
const ERX = TW * 1.41421, ERY = TH * 1.41421;

// ---- palette: quiet by default ---------------------------------------------
const C = {
  wall: '#79838d',          // equipment outline
  wallDim: '#4d565f',       // de-energised / not in service
  fill: '#1b232c',          // inside of a vessel, empty
  steel: '#8b959e',
  conc: '#8a857a',
  floor: '#3b4148',
  text: '#c4d2dd',
  textDim: '#7c8a95',
  ok: '#63e08a',
  warn: '#ffc44d',
  bad: '#ff5c48',
  h2: '#d9e04a',
  air: '#7fd0e4',
  power: '#ffd35c',
  cold: '#4a6b82'           // water at rest: deliberately undramatic
};

// Temperature ramp. Normal operating temperature is a calm steel blue - it has
// to be, or the display is shouting before anything has gone wrong.
const RAMP = [
  [290, '#3f6d8c'], [560, '#4a7f96'], [620, '#5a8a92'],
  [700, '#9b9a63'], [900, '#d0a03e'], [1200, '#dd6a2b'],
  [1600, '#e83b22'], [2200, '#ff8a4a'], [3000, '#ffe3b0']
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

export class CutawayView {
  constructor(plant, ox, oy) {
    this.plant = plant;
    this.ox = ox; this.oy = oy;
    this.passive = plant.mode === MODE.PASSIVE;
    this.labels = true;
    this.caps = [];
    this.tagQ = [];
    // Annotation is screen furniture, not part of the drawing: `ts` converts a
    // CSS pixel into the world units the camera transform is currently using,
    // so a caption is the same size to read whether one section is on screen
    // or two.
    this.ts = 1;
    // the top of this section's own geometry: the title sits just above it, so
    // the active unit does not get a hole where the shield building would be
    this.topZ = 14.6;
  }

  // Anything drawn at a screen size has to be declared, or the camera fits the
  // geometry and clips the captions.
  mark(cx, w) {
    if (w === undefined) { this.extL = Math.min(this.extL, cx); this.extR = Math.max(this.extR, cx); return; }
    this.extL = Math.min(this.extL, cx - w / 2);
    this.extR = Math.max(this.extR, cx + w / 2);
  }

  // font at a true CSS pixel size, under the camera transform
  f(px, weight) {
    return `${weight || 500} ${(px * this.ts).toFixed(2)}px ui-sans-serif, system-ui, sans-serif`;
  }

  gx(u) { return this.ox + u * 0.5; }
  gy(u) { return this.oy - u * 0.5; }
  P(u, z) { return project(this.gx(u), this.gy(u), z * ZS); }

  // =====================================================================
  // primitives
  // =====================================================================

  // A vessel: outline, contents, and - if asked - a proper level scale beside
  // it with the fuel trip points marked.
  vessel(ctx, o) {
    const { u, r, z0, z1 } = o;
    const top = this.P(u, z1), bot = this.P(u, z0);
    const rx = r * ERX, ry = r * ERY;

    // The silhouette closes over the FAR side of the top rim, so the inside of
    // the far wall is part of the vessel. Closing it over the near rim instead
    // leaves a lens-shaped hole above the water that reads as a hole in the
    // drawing the moment a vessel is anywhere near full.
    const capH = rx * 0.44;
    ctx.beginPath();
    ctx.moveTo(bot.x - rx, bot.y);
    ctx.lineTo(top.x - rx, top.y);
    if (o.head) {
      ctx.bezierCurveTo(top.x - rx, top.y - capH, top.x + rx, top.y - capH,
        top.x + rx, top.y);
    } else {
      ctx.ellipse(top.x, top.y, rx, ry, 0, Math.PI, 0, false);
    }
    ctx.lineTo(bot.x + rx, bot.y);
    ctx.ellipse(bot.x, bot.y, rx, ry, 0, 0, Math.PI, false);
    ctx.closePath();
    ctx.fillStyle = C.fill;
    ctx.fill();

    ctx.save();
    ctx.clip();
    const lv = o.level === undefined ? z0 : Math.max(z0, Math.min(z1, o.level));
    if (lv > z0 + 0.001) {
      const surf = this.P(u, lv);
      ctx.fillStyle = o.liquid || C.cold;
      ctx.fillRect(top.x - rx - 1, surf.y, rx * 2 + 2, (bot.y + ry) - surf.y + 2);
      ctx.beginPath();
      ctx.ellipse(surf.x, surf.y, rx, ry, 0, Math.PI, 0, false);
      ctx.fillStyle = shade(o.liquid || C.cold, 1.22);
      ctx.fill();
    }
    if (o.inner) o.inner(ctx);
    ctx.restore();

    // waterline, drawn bright: this is the number the reader is tracking
    if (o.level !== undefined && lv < z1 - 0.02 && lv > z0 + 0.02) {
      const surf = this.P(u, lv);
      ctx.strokeStyle = shade(o.liquid || C.cold, 1.6);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(surf.x, surf.y, rx, ry, 0, Math.PI, 0, false);
      ctx.stroke();
    }

    const wall = o.dead ? C.wallDim : (o.wall || C.wall);
    ctx.strokeStyle = wall;
    ctx.lineWidth = o.wallW || 2.6;
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
      ctx.bezierCurveTo(top.x - rx, top.y - capH, top.x + rx, top.y - capH,
        top.x + rx, top.y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(top.x, top.y, rx, ry, 0, Math.PI, 0, true);
      ctx.stroke();
    }
    return { top, bot, rx, ry };
  }

  // The level scale. Ticks every unit, BAF and TAF called out, an indicator
  // that moves with the real level, and a red state the moment it drops below
  // the top of the fuel.
  levelScale(ctx, o) {
    const { u, z0, z1, level, baf, taf } = o;
    const a = this.P(u, z0), b = this.P(u, z1);
    const below = level < taf;
    ctx.strokeStyle = C.wallDim; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    for (let z = z0; z <= z1 + 0.001; z += (z1 - z0) / 8) {
      const q = this.P(u, z);
      ctx.beginPath(); ctx.moveTo(q.x - 3, q.y); ctx.lineTo(q.x + 3, q.y); ctx.stroke();
    }
    for (const [z, name] of [[baf, 'BAF'], [taf, 'TAF']]) {
      const q = this.P(u, z);
      const hot = name === 'TAF' && below;
      ctx.strokeStyle = hot ? C.bad : C.textDim;
      ctx.lineWidth = hot ? 2 : 1.4;
      ctx.beginPath(); ctx.moveTo(q.x - 8, q.y); ctx.lineTo(q.x + 5, q.y); ctx.stroke();
      const t = this.ts;
      ctx.font = this.f(8, '600');
      const tw = ctx.measureText(name).width;
      ctx.fillStyle = 'rgba(12,18,24,0.82)';
      ctx.fillRect(q.x - 12 * t - tw - 2 * t, q.y - 5 * t, tw + 4 * t, 10 * t);
      ctx.fillStyle = hot ? C.bad : C.textDim;
      ctx.textAlign = 'right';
      ctx.fillText(name, q.x - 12 * t, q.y + 3 * t);
      ctx.textAlign = 'left';
    }
    const q = this.P(u, Math.max(z0, Math.min(z1, level)));
    ctx.fillStyle = below ? C.bad : C.ok;
    ctx.beginPath();
    ctx.moveTo(q.x + 12, q.y); ctx.lineTo(q.x + 3, q.y - 5); ctx.lineTo(q.x + 3, q.y + 5);
    ctx.closePath(); ctx.fill();
  }

  pool(ctx, o) {
    const { u0, u1, z0, z1, level } = o;
    const A = this.P(u0, z1), B = this.P(u1, z1);
    const D = this.P(u1, z0), E = this.P(u0, z0);
    ctx.fillStyle = C.fill;
    poly(ctx, [A, B, D, E]);
    const lv = Math.max(z0, Math.min(z1, level));
    if (lv > z0 + 0.001) {
      const a = this.P(u0, lv), b = this.P(u1, lv);
      ctx.fillStyle = o.liquid || C.cold;
      poly(ctx, [a, b, D, E]);
      ctx.strokeStyle = shade(o.liquid || C.cold, 1.5);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.strokeStyle = o.wall || C.wall;
    ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.lineTo(E.x, E.y); ctx.lineTo(D.x, D.y); ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }

  // A pipe. Weight carries the flow, a chevron carries the direction, and a
  // dead line is thin and grey so "nothing is moving here" needs no caption.
  pipe(ctx, uz, o) {
    const p = uz.map(q => this.P(q[0], q[1]));
    const flow = o.flow || 0;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const base = o.w || 6;
    const w = flow > 0 ? base * (0.72 + 0.45 * Math.min(1, flow)) : base * 0.5;
    ctx.strokeStyle = flow > 0 ? C.wall : C.wallDim;
    ctx.lineWidth = w + 2.6;
    polyLine(ctx, p, false);
    const col = o.color || C.cold;
    ctx.strokeStyle = flow > 0 ? col : '#2a3138';
    ctx.lineWidth = w;
    polyLine(ctx, p, false);
    if (flow > 0) this.chevrons(ctx, p, o, shade(col, 1.55), w);
  }

  chevrons(ctx, p, o, col, w) {
    const segs = []; let total = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const L = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
      segs.push(L); total += L;
    }
    if (total < 26) return;
    const n = Math.max(1, Math.round(total / 78));
    for (let k = 0; k < n; k++) {
      let t = ((((o.phase || 0) * o.flow * 0.20 + k / n) % 1) + 1) % 1;
      if (o.reverse) t = 1 - t;
      t *= total;
      let i = 0;
      while (i < segs.length && t > segs[i]) { t -= segs[i]; i++; }
      if (i >= segs.length) continue;
      const a = p[i], b = p[i + 1], L = segs[i] || 1;
      const cx = a.x + (b.x - a.x) * (t / L), cy = a.y + (b.y - a.y) * (t / L);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.atan2((b.y - a.y) / L, (b.x - a.x) / L) + (o.reverse ? Math.PI : 0));
      ctx.fillStyle = col;
      const s = Math.max(3, w * 0.62);
      ctx.beginPath();
      ctx.moveTo(s, 0); ctx.lineTo(-s * 0.85, s * 0.9); ctx.lineTo(-s * 0.85, -s * 0.9);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // ---- ISA-5.1 style symbols -------------------------------------------
  // Centrifugal pump: a circle with a triangle. `powered` draws the marker
  // that says this thing stops when the bus does.
  pump(ctx, u, z, running, powered) {
    const p = this.P(u, z);
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = running ? '#2c3f52' : '#20262c';
    ctx.fill();
    ctx.strokeStyle = running ? C.wall : C.wallDim;
    ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 4.5, p.y - 5); ctx.lineTo(p.x + 6, p.y); ctx.lineTo(p.x - 4.5, p.y + 5);
    ctx.closePath();
    ctx.fillStyle = running ? '#8fc4ee' : '#495159';
    ctx.fill();
    if (powered) this.powerMark(ctx, p.x + 10, p.y - 9, running);
  }

  // Bow-tie valve. Filled = shut, open = open, red = it should not be.
  valve(ctx, u, z, open, powered, alarm) {
    const p = this.P(u, z);
    const s = 6;
    ctx.beginPath();
    ctx.moveTo(p.x - s, p.y - s); ctx.lineTo(p.x, p.y); ctx.lineTo(p.x - s, p.y + s);
    ctx.closePath();
    ctx.moveTo(p.x + s, p.y - s); ctx.lineTo(p.x, p.y); ctx.lineTo(p.x + s, p.y + s);
    ctx.closePath();
    ctx.fillStyle = alarm ? C.bad : open ? '#1d3a2a' : '#2b2f34';
    ctx.fill();
    ctx.strokeStyle = alarm ? C.bad : open ? C.ok : C.wall;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    if (powered) this.powerMark(ctx, p.x + 9, p.y - 9, open);
  }

  // The marker that carries the whole argument: this item needs a live bus.
  powerMark(ctx, x, y, live) {
    ctx.fillStyle = live ? C.power : '#4a5058';
    ctx.font = this.f(9, '700');
    ctx.fillText('⚡', x, y + 4);
  }

  // Heat exchanger: a coil inside its shell.
  coilHX(ctx, u, z0, z1, hot, wide) {
    const w = wide || 0.5;
    ctx.strokeStyle = hot ? C.wall : C.wallDim;
    ctx.lineWidth = 4.6;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const q = this.P(u + (i % 2 ? w : -w), z0 + (z1 - z0) * (i / 12));
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    if (hot) {
      ctx.strokeStyle = hot;
      ctx.lineWidth = 2.6;
      ctx.stroke();
    }
  }

  bubbles(ctx, u, z0, z1, r, rate, time, seed) {
    if (rate <= 0 || z1 <= z0) return;
    const n = Math.min(18, Math.round(3 + rate * 15));
    for (let i = 0; i < n; i++) {
      const t = ((time * (0.5 + hash2(i, seed, 2) * 0.9) + hash2(i, seed, 1)) % 1);
      const p = this.P(u + (hash2(i, seed, 3) - 0.5) * r * 1.5, z0 + (z1 - z0) * t);
      ctx.fillStyle = `rgba(226,240,250,${0.5 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.3 + hash2(i, seed, 4) * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- annotation -------------------------------------------------------
  // Numbered callouts with a key, the way a technical cutaway is labelled.
  // Captions painted next to the equipment is what makes a mimic unreadable
  // the moment the plant gets busy: there are a dozen of them and they all
  // land on top of the thing they describe. A numbered disc costs the reader
  // one lookup and costs the drawing nothing.
  //
  // Numbers 1-7 mean the same item in both sections, so the two drawings
  // difference cleanly. Everything from 8 up is what the two plants do not
  // share, which is exactly the comparison.
  callout(ctx, u, z, n, text, opts) {
    if (!this.labels) return;
    const o = opts || {};
    let e = this.caps.find(c => c.n === n);
    if (!e) { e = { n, text, power: !!o.power, aux: !!o.aux, pts: [] }; this.caps.push(e); }
    e.pts.push(this.P(u, z));
  }

  // A caption placed directly, for the two or three things that sit in empty
  // space where a number would be more work than a word.
  note(ctx, u, z, text, align) {
    if (!this.labels) return;
    const q = this.P(u, z), t = this.ts;
    ctx.font = this.f(9.5, '500');
    ctx.fillStyle = 'rgba(160,182,197,0.92)';
    ctx.textAlign = align || 'center';
    ctx.fillText(text, q.x, q.y);
    ctx.textAlign = 'left';
  }

  // The off-page connector: where a line leaves the section it gets the
  // standard flag rather than simply stopping in mid-air.
  offPage(ctx, u, z, text, live) {
    const q = this.P(u, z), t = this.ts;
    ctx.font = this.f(8.5, '600');
    const w = ctx.measureText(text).width + 15 * t, h = 15 * t;
    this.mark(q.x); this.mark(q.x + w + 4 * t);
    ctx.beginPath();
    ctx.moveTo(q.x, q.y - h / 2);
    ctx.lineTo(q.x + w - 7 * t, q.y - h / 2);
    ctx.lineTo(q.x + w, q.y);
    ctx.lineTo(q.x + w - 7 * t, q.y + h / 2);
    ctx.lineTo(q.x, q.y + h / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(20,28,36,0.92)';
    ctx.fill();
    ctx.strokeStyle = live ? 'rgba(150,190,215,0.5)' : C.wallDim;
    ctx.lineWidth = 1.2 * t;
    ctx.stroke();
    ctx.fillStyle = live ? C.text : C.textDim;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, q.x + 6 * t, q.y + 0.5 * t);
    ctx.textBaseline = 'alphabetic';
  }

  tag(ctx, u, z, text, tone) {
    const p = this.P(u, z);
    this.tagQ.push({ x: p.x, y: p.y, text, tone });
  }

  // the discs, on the drawing
  flushCallouts(ctx) {
    const t = this.ts, r = 7.5 * t;
    ctx.font = this.f(9, '700');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of this.caps) {
      for (const q of c.pts) {
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(13,19,25,0.9)'; ctx.fill();
        ctx.strokeStyle = c.power ? 'rgba(255,211,92,0.75)' : 'rgba(150,178,199,0.6)';
        ctx.lineWidth = 1.3 * t; ctx.stroke();
        ctx.fillStyle = c.power ? '#f4dfa6' : C.text;
        ctx.fillText(String(c.n), q.x, q.y + 0.5 * t);
      }
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // the key, under the electrical row, in three columns
  keyPanel(ctx, topY) {
    if (!this.labels || !this.caps.length) return topY;
    const t = this.ts;
    const list = this.caps.slice().sort((a, b) => a.n - b.n);
    this.mark(this.P(-0.6, 0).x); this.mark(this.P(13.6, 0).x);
    const x0 = this.P(-0.6, 0).x, x1 = this.P(13.6, 0).x;
    // three columns only if a column is actually wide enough to hold a caption
    const cols = ((x1 - x0) / 3) / t >= 126 ? 3 : 2;
    const colW = (x1 - x0) / cols;
    const rows = Math.ceil(list.length / cols);
    const rowH = 13.5 * t, r = 5.6 * t;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const cx = x0 + (i % cols) * colW;
      const cy = topY + Math.floor(i / cols) * rowH;
      ctx.beginPath(); ctx.arc(cx + r, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(13,19,25,0.9)'; ctx.fill();
      ctx.strokeStyle = c.power ? 'rgba(255,211,92,0.75)' : 'rgba(150,178,199,0.55)';
      ctx.lineWidth = 1.2 * t; ctx.stroke();
      ctx.font = this.f(8, '700');
      ctx.fillStyle = c.power ? '#f4dfa6' : C.text;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(c.n), cx + r, cy + 0.4 * t);
      ctx.textAlign = 'left';
      ctx.font = this.f(9.5, '500');
      ctx.fillStyle = c.power ? '#e9d6a4' : 'rgba(196,210,221,0.88)';
      const tx = cx + r * 2 + 4 * t, room = colW - (r * 2 + 4 * t) - 10 * t;
      let label = (c.power ? '\u26a1 ' : '') + c.text;
      while (label.length > 2 && ctx.measureText(label).width > room) {
        label = label.slice(0, -2) + '\u2026';
      }
      ctx.fillText(label, tx, cy + 0.4 * t);
      ctx.textBaseline = 'alphabetic';
    }
    const need = list.filter(c => c.power).length;
    const safety = list.filter(c => c.power && !c.aux).length;
    const cy = topY + rows * rowH + 4 * t;
    ctx.font = this.f(10, '700');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = safety ? C.warn : C.ok;
    const sum = safety
      ? `\u26a1 ${safety} of these ${list.length} need the row above \u2014 and they are the cooling`
      : `\u26a1 only ${need} of these ${list.length} need the row above \u2014 neither one cools the core`;
    ctx.fillText(sum, (x0 + x1) / 2, cy + 6 * t);
    this.mark((x0 + x1) / 2, ctx.measureText(sum).width);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    this.caps.length = 0;
    return cy + 16 * t;
  }

  flushTags(ctx) {
    const t = this.ts;
    ctx.font = this.f(10, '700');
    const placed = [];
    for (const q of this.tagQ) {
      const w = ctx.measureText(q.text).width + 13 * t;
      for (let k = 0; k < 12; k++) {
        let hit = false;
        for (const o of placed) {
          if (Math.abs(o.x - q.x) < (o.w + w) / 2 + 5 * t && Math.abs(o.y - q.y) < 19 * t) { hit = true; break; }
        }
        if (!hit) break;
        q.y -= 19 * t;
      }
      placed.push({ x: q.x, y: q.y, w });
      this.mark(q.x, w);
      const tone = q.tone;
      ctx.fillStyle = tone === 'bad' ? 'rgba(76,18,12,0.94)'
        : tone === 'warn' ? 'rgba(70,50,10,0.94)'
          : tone === 'ok' ? 'rgba(10,44,28,0.92)' : 'rgba(14,20,26,0.9)';
      rr(ctx, q.x - w / 2, q.y - 8 * t, w, 17 * t, 4 * t); ctx.fill();
      ctx.strokeStyle = tone === 'bad' ? C.bad : tone === 'warn' ? C.warn
        : tone === 'ok' ? C.ok : 'rgba(150,190,215,0.32)';
      ctx.lineWidth = 1.2 * t;
      rr(ctx, q.x - w / 2, q.y - 8 * t, w, 17 * t, 4 * t); ctx.stroke();
      ctx.fillStyle = tone === 'bad' ? '#ffd2c6' : tone === 'warn' ? '#ffe3ab'
        : tone === 'ok' ? '#c6f6d6' : C.text;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(q.text, q.x, q.y + 0.5 * t);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    this.tagQ.length = 0;
  }

  // =====================================================================
  // the scene
  // =====================================================================
  draw(ctx, time) {
    const p = this.plant, s = p.sys || {};
    this.extL = this.P(-0.9, 0).x - 10 * this.ts;
    this.extR = this.P(13.8, 0).x;
    // shared geometry: both sections are the same drawing wherever they can
    // be, so the eye can difference them
    const G = this.geom = {
      wallU0: 0.7, wallU1: 12.3, floorZ: 0.9, springZ: 9.5, apexZ: 12.7,
      rpv: { u: 3.5, r: 0.95, z0: 1.9, z1: 6.5 },
      core: { z0: 2.7, z1: 4.7 },
      sg: { u: 7.4, r: 0.95, z0: 2.1, z1: 8.6 },
      hotZ: 5.35, coldZ: 4.45,
      przr: { u: 5.6, r: 0.44, z0: 6.3, z1: 9.0 }
    };
    const surf = G.rpv.z0 + Math.max(0, Math.min(1, p.level)) * (G.rpv.z1 - 0.08 - G.rpv.z0);
    this.surf = surf;

    this.shell(ctx);
    this.atmosphere(ctx);
    this.sump(ctx);

    if (this.passive) this.passiveScene(ctx, time);
    else this.activeScene(ctx, time);

    this.primaryLoop(ctx, time);
    this.reactor(ctx, time);
    this.breach(ctx, time);
    const rowY = this.powerRow(ctx, time);
    this.flushCallouts(ctx);
    const keyBottom = this.keyPanel(ctx, rowY);
    this.annunciators(ctx);
    this.flushTags(ctx);
    // What the camera has to fit. Measured, not assumed: the annotation is
    // screen-sized, so how much room it takes in world units depends on the
    // zoom the camera is about to pick.
    const t = this.ts;
    this.bounds = {
      top: this.P(6.5, this.topZ + 1.55).y - 14 * t,
      bottom: keyBottom,
      left: this.extL - 10 * t,
      right: this.extR + 10 * t
    };
  }

  // ---- the building -----------------------------------------------------
  shellPath(ctx, u0, u1, zTop, apexZ, zBot) {
    const A = this.P(u0, zTop), B = this.P(u1, zTop);
    const Cc = this.P(u1, zBot), D = this.P(u0, zBot);
    const apexY = this.P((u0 + u1) / 2, apexZ).y;
    ctx.beginPath();
    ctx.moveTo(D.x, D.y);
    ctx.lineTo(A.x, A.y);
    ctx.bezierCurveTo(A.x, apexY, B.x, apexY, B.x, B.y);
    ctx.lineTo(Cc.x, Cc.y);
    return { A, B, C: Cc, D };
  }

  shell(ctx) {
    const G = this.geom, P_ = this.passive;
    this.shellPath(ctx, G.wallU0, G.wallU1, G.springZ, G.apexZ, G.floorZ);
    ctx.closePath();
    ctx.fillStyle = '#131a21';
    ctx.fill();

    // basemat
    const f0 = this.P(G.wallU0 - 0.5, G.floorZ), f1 = this.P(G.wallU1 + 0.5, G.floorZ);
    const g0 = this.P(G.wallU0 - 0.5, 0), g1 = this.P(G.wallU1 + 0.5, 0);
    ctx.fillStyle = C.floor;
    poly(ctx, [f0, f1, g1, g0]);

    this.shellPath(ctx, G.wallU0, G.wallU1, G.springZ, G.apexZ, G.floorZ);
    ctx.strokeStyle = P_ ? C.steel : C.conc;
    ctx.lineWidth = P_ ? 4.5 : 7;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
    this.callout(ctx, G.wallU0, G.springZ - 5.9, 6,
      P_ ? 'steel containment' : 'containment');

    if (P_) {
      // the shield building, and the annulus the draught runs up
      this.shellPath(ctx, -0.35, 13.35, G.springZ + 1.0, G.apexZ + 1.5, 0);
      ctx.strokeStyle = C.conc; ctx.lineWidth = 6;
      ctx.stroke();
    }
  }

  sump(ctx) {
    const G = this.geom, p = this.plant, s = p.sys || {};
    const lvl = G.floorZ + (this.passive
      ? (s.gravity ? 0.95 : 0.4)
      : (p.vesselBreach ? 0.35 : 0.75));
    this.pool(ctx, {
      u0: G.wallU0 + 0.15, u1: G.wallU1 - 0.15, z0: G.floorZ, z1: G.floorZ + 1.1,
      level: lvl, liquid: tempColor(p.Tctmt)
    });
    this.callout(ctx, G.wallU1 - 0.75, G.floorZ + 0.45, 7,
      this.passive ? 'containment sump' : 'suppression pool');
  }

  // ---- reactor vessel, core, and the level readout ----------------------
  reactor(ctx, time) {
    const p = this.plant, s = p.sys || {}, G = this.geom, r = G.rpv;
    const wt = Math.min(640, p.Tclad);

    this.vessel(ctx, {
      u: r.u, r: r.r, z0: r.z0, z1: r.z1, level: this.surf,
      liquid: tempColor(wt), wall: C.steel, head: true,
      inner: (c) => this.core(c, time)
    });
    this.bubbles(ctx, r.u, r.z0 + 0.2, this.surf, r.r, s.boil || 0, time, 11);

    if (p.scrammed) {
      ctx.strokeStyle = C.wall; ctx.lineWidth = 2;
      for (let i = -2; i <= 2; i++) {
        const a = this.P(r.u + i * 0.3, G.core.z1);
        const b = this.P(r.u + i * 0.3, r.z1 + 0.55);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    this.levelScale(ctx, {
      u: r.u - 1.28, z0: r.z0, z1: r.z1, level: this.surf,
      baf: G.core.z0, taf: G.core.z1
    });
    this.callout(ctx, r.u - r.r * 0.62, r.z1 - 0.35, 1, 'reactor vessel');
    this.callout(ctx, r.u + r.r * 0.62, (G.core.z0 + G.core.z1) / 2, 2, 'fuel in the core');

    const T = p.Tclad - 273;
    this.tag(ctx, r.u, r.z0 - 0.85, `core ${T.toFixed(0)} °C`,
      T > 800 ? 'bad' : T > 360 ? 'warn' : 'ok');
    this.tag(ctx, r.u - 2.45, this.surf, `${(p.level * 100).toFixed(0)}%`,
      p.level > 0.995 ? 'ok' : p.level > 0.75 ? 'warn' : 'bad');
  }

  core(ctx, time) {
    const p = this.plant, G = this.geom, r = G.rpv;
    const z0 = G.core.z0, z1 = G.core.z1;
    const n = 9;
    // the shroud, so the fuel reads as being inside something
    const a = this.P(r.u - r.r * 0.8, z1 + 0.15), b = this.P(r.u + r.r * 0.8, z1 + 0.15);
    const c = this.P(r.u + r.r * 0.8, z0 - 0.15), d = this.P(r.u - r.r * 0.8, z0 - 0.15);
    ctx.strokeStyle = 'rgba(150,162,172,0.5)'; ctx.lineWidth = 1.4;
    polyLine(ctx, [a, b, c, d], true);
    for (let i = 0; i < n; i++) {
      const u = r.u - r.r * 0.66 + (i / (n - 1)) * r.r * 1.32;
      const p0 = this.P(u, z1), p1 = this.P(u, z0);
      const T = this.surf >= z1 ? Math.min(p.Tclad, 700) : p.Tclad;
      ctx.strokeStyle = T < 700 ? '#96a3ad' : tempColor(T);
      ctx.lineWidth = 4.4;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(10,14,18,0.5)'; ctx.lineWidth = 1.1;
      ctx.stroke();
    }
    if (this.surf < z1 && p.Tclad > 680) {
      const top = this.P(r.u, z1), bot = this.P(r.u, Math.max(z0, this.surf));
      const g = ctx.createLinearGradient(0, top.y, 0, bot.y);
      const al = Math.min(0.75, (p.Tclad - 680) / 1300);
      g.addColorStop(0, `rgba(255,150,60,${al})`);
      g.addColorStop(1, 'rgba(255,90,30,0)');
      ctx.fillStyle = g;
      ctx.fillRect(top.x - r.r * ERX, top.y, r.r * ERX * 2, bot.y - top.y);
    }
    if (p.meltFrac > 0.02) {
      const q = this.P(r.u, r.z0 + 0.12);
      ctx.fillStyle = `rgba(255,${(150 - 100 * p.meltFrac) | 0},44,${0.6 + 0.35 * p.meltFrac})`;
      ctx.beginPath();
      ctx.ellipse(q.x, q.y, r.r * ERX * 0.9, r.r * ERY * 0.9 + 7 * p.meltFrac, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- the primary loop, identical in both plants ------------------------
  primaryLoop(ctx, time) {
    const p = this.plant, s = p.sys || {}, G = this.geom;
    const r = G.rpv, sg = G.sg;
    const flow = Math.max(s.rcp, s.natCirc);
    const hot = tempColor(Math.min(645, p.Tcore));
    const cold = tempColor(Math.min(600, p.Tcore - 30));

    // steam generator: secondary side, with its own level
    const fed = s.feed || s.aux || s.rcic;
    this.vessel(ctx, {
      u: sg.u, r: sg.r, z0: sg.z0, z1: sg.z1,
      level: sg.z0 + (fed ? 4.6 : 2.2), liquid: tempColor(555),
      wall: C.steel, head: true,
      inner: (c) => {
        // U-tubes: the primary side inside the secondary
        c.strokeStyle = flow > 0 ? shade(hot, 1.1) : C.wallDim;
        c.lineWidth = 2.2;
        for (let i = -2; i <= 2; i++) {
          if (!i) continue;
          const x0 = sg.u + i * 0.26;
          const a = this.P(x0, sg.z0 + 0.6), b = this.P(x0, sg.z0 + 4.3);
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        }
      }
    });
    this.callout(ctx, sg.u - sg.r * 0.55, sg.z1 - 1.7, 3, 'steam generator');

    // hot leg: vessel nozzle to the SG channel head
    this.pipe(ctx, [[r.u + r.r * 0.9, G.hotZ], [6.35, G.hotZ], [6.35, 3.05], [sg.u - 0.85, 3.05]],
      { w: 7, color: hot, flow, phase: time });
    // cold leg: channel head, through the pump, back to the vessel
    const rcpU = this.passive ? sg.u + 0.95 : 9.15;
    this.pipe(ctx, [[sg.u + 0.85, 3.05], [rcpU, 3.05], [rcpU, G.coldZ], [r.u + r.r * 0.9, G.coldZ]],
      { w: 7, color: cold, flow, phase: time, reverse: true });

    // The pumps. On the Gen-II plant they sit in the cold leg; on the AP1000
    // they are canned-motor pumps mounted on the steam generator channel head.
    // Both plants have them - the difference is that only one plant needs them.
    const rcpZ = this.passive ? 2.4 : 3.9;
    this.pump(ctx, rcpU, rcpZ, s.rcp > 0, true);
    this.callout(ctx, rcpU, rcpZ - 0.62, 5,
      'coolant pumps', { power: true, aux: this.passive });
    if (!s.rcp) {
      this.tag(ctx, rcpU + 1.05, rcpZ - 0.05,
        this.passive ? 'pumps off - not needed' : 'PUMPS STOPPED',
        this.passive ? 'ok' : 'bad');
    }

    if (s.natCirc > 0 && !s.rcp) {
      this.tag(ctx, 6.35, G.hotZ + 0.75, 'natural circulation', 'ok');
    }

    // pressuriser, hanging off the hot leg on a surge line
    const pz = G.przr;
    this.pipe(ctx, [[pz.u, pz.z0], [pz.u, G.hotZ]],
      { w: 4.5, color: hot, flow: flow ? 0.25 : 0, phase: time });
    this.vessel(ctx, {
      u: pz.u, r: pz.r, z0: pz.z0, z1: pz.z1,
      level: pz.z0 + 1.9 * Math.max(0.15, Math.min(1, p.level)),
      liquid: tempColor(618), wall: C.steel, head: true
    });
    this.callout(ctx, pz.u - pz.r * 0.7, pz.z1 - 0.4, 4, 'pressuriser');
    this.valve(ctx, pz.u, pz.z1 + 0.45, p.leakRate > 0, false, p.leakRate > 0 && !this.passive);
    if (p.leakRate > 0 && !this.passive) {
      this.tag(ctx, pz.u + 1.5, pz.z1 + 0.5, 'RELIEF VALVE STUCK OPEN', 'bad');
    }

    // the power cycle: steam out to the turbine, condensate back, heat to the
    // sea. Present on both plants, because the difference is not here.
    this.pipe(ctx, [[sg.u, sg.z1 + 0.25], [13.95, sg.z1 + 0.25]],
      { w: 5.5, color: '#9fb0bc', flow: s.feed ? 1 : 0, phase: time });
    this.pipe(ctx, [[13.95, sg.z1 - 1.15], [12.55, sg.z1 - 1.15], [12.55, 2.3], [sg.u + 0.4, 2.3]],
      { w: 5.5, color: tempColor(330), flow: s.feed ? 1 : 0, phase: time });
    this.pump(ctx, 12.55, 3.2, s.feed > 0, true);
    this.callout(ctx, 12.55, 3.2 - 0.62, 8, 'feedwater pump', { power: true, aux: this.passive });
    this.offPage(ctx, 14.05, sg.z1 + 0.25, p.uhs ? 'turbine' : 'NO SINK',
      !!p.uhs && !!s.feed);
    this.offPage(ctx, 14.05, sg.z1 - 1.15, 'condenser', !!p.uhs && !!s.feed);
  }

  // ---- Gen-II specific ---------------------------------------------------
  activeScene(ctx, time) {
    const p = this.plant, s = p.sys || {}, G = this.geom;
    const r = G.rpv;

    // emergency injection: a pump, outside, on a bus
    const inj = s.aux > 0;
    const needed = p.scrammed && p.coolingMargin < 1.0;
    this.pipe(ctx, [[-0.4, 2.35], [2.05, 2.35], [2.05, r.z0 + 0.75],
      [r.u - r.r * 0.85, r.z0 + 0.75]],
      { w: 5, color: C.cold, flow: inj ? 1 : 0, phase: time });
    this.pump(ctx, -0.4, 2.35, inj, true);
    this.valve(ctx, 1.05, 2.35, inj, true, needed && !inj);
    this.callout(ctx, -0.4, 1.72, 9, 'ECCS pumps', { power: true });
    if (needed && !inj) this.tag(ctx, 2.7, 1.35, 'ECCS CANNOT RUN', 'bad');

    // accumulators: the one passive item a Gen-II plant already has
    for (let i = 0; i < 2; i++) {
      const u = 10.1 + i * 0.95;
      this.vessel(ctx, {
        u, r: 0.34, z0: 6.2, z1: 7.9,
        level: 6.2 + 1.7 * Math.max(0, Math.min(1, p.accumLevel)),
        liquid: C.cold, wall: C.steel, head: true
      });
      this.pipe(ctx, [[u, 6.2], [u, 5.02], [r.u + 1.42, 5.02], [r.u + 1.42, G.coldZ]],
        { w: 4, color: C.cold, flow: s.accum, phase: time });
    }
    this.callout(ctx, 10.1, 7.9 + 0.55, 10, 'accumulators');

    // containment sprays, also on the bus
    const spr = s.sprays > 0;
    ctx.strokeStyle = spr ? 'rgba(120,190,238,0.8)' : 'rgba(90,100,110,0.4)';
    ctx.lineWidth = 2;
    const hdr0 = this.P(1.9, 9.62), hdr1 = this.P(11.1, 9.62);
    ctx.beginPath(); ctx.moveTo(hdr0.x, hdr0.y); ctx.lineTo(hdr1.x, hdr1.y); ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const u = 2.2 + i * 1.27;
      const a = this.P(u, 9.62);
      const drop = spr ? 0.55 + ((time * 2 + i * 0.27) % 1) * 0.9 : 0.25;
      const b = this.P(u, 9.62 - drop);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    this.powerMark(ctx, this.P(11.1, 9.62).x + 6 * this.ts, this.P(11.1, 9.62).y - 4 * this.ts, spr);
    this.callout(ctx, 3.15, 9.62, 11, 'containment sprays', { power: true });

    // hardened vent
    this.valve(ctx, 0.05, 7.4, p.vented, true, false);
    this.pipe(ctx, [[1.15, 7.4], [-0.4, 7.4], [-0.4, 11.5]],
      { w: 4.5, color: '#b9c6d0', flow: p.vented ? 1 : 0, phase: time });
    this.callout(ctx, -0.4, 10.3, 12, 'hardened vent', { power: true });
    if (p.vented) this.tag(ctx, 0.4, 12.1, 'VENTING to atmosphere', 'bad');
  }

  // ---- AP1000 specific ---------------------------------------------------
  passiveScene(ctx, time) {
    const p = this.plant, s = p.sys || {}, G = this.geom;
    const r = G.rpv;
    const DVI = r.u + 1.42;   // the direct vessel injection riser everything tees into
    const hot = tempColor(Math.min(645, p.Tcore));

    // IRWST, above the core, inside containment
    const irw = { u0: 0.95, u1: 2.9, z0: 6.4, z1: 9.1 };
    const irwLvl = irw.z0 + (irw.z1 - irw.z0) * Math.max(0.08, Math.min(1, p.irwst / 2.1e6));
    this.pool(ctx, {
      u0: irw.u0, u1: irw.u1, z0: irw.z0, z1: irw.z1,
      level: irwLvl, liquid: tempColor(Math.min(372, p.Tctmt)), wall: C.steel
    });
    this.callout(ctx, irw.u1 - 0.26, irw.z1 - 0.45, 9, 'IRWST \u00b7 2,000 t');

    // PRHR: a C-tube bundle in that pool, on a thermosiphon from the hot leg
    // back to the steam generator channel head. No pump anywhere in it.
    const hx = { u: (irw.u0 + irw.u1) / 2, z0: irw.z0 + 0.35, z1: irw.z1 - 0.45 };
    this.coilHX(ctx, hx.u, hx.z0, hx.z1, s.prhr > 0 ? hot : null, 0.55);
    this.pipe(ctx, [[5.0, G.hotZ], [5.0, hx.z1 + 0.7], [hx.u, hx.z1 + 0.7], [hx.u, hx.z1]],
      { w: 5.5, color: hot, flow: s.prhr, phase: time });
    this.pipe(ctx, [[hx.u, hx.z0], [hx.u, 2.52], [G.sg.u - 0.85, 2.52], [G.sg.u - 0.85, 3.05]],
      { w: 5.5, color: tempColor(420), flow: s.prhr, phase: time });
    this.callout(ctx, hx.u, (hx.z0 + hx.z1) / 2, 10, 'PRHR HX (no pump)');
    if (s.prhr > 0) {
      this.bubbles(ctx, hx.u, hx.z0, irwLvl, 0.7, 0.55, time, 21);
      this.tag(ctx, irw.u1 - 1.05, irw.z1 + 0.78, 'PRHR thermosiphon', 'ok');
    }

    // core makeup tanks: full pressure, driven by a balance line
    for (let i = 0; i < 2; i++) {
      const u = 3.5 + i * 0.95;
      this.vessel(ctx, {
        u, r: 0.34, z0: 7.2, z1: 9.2,
        level: 7.2 + 2.0 * Math.max(0, Math.min(1, p.cmtLevel)),
        liquid: C.cold, wall: C.steel, head: true
      });
      // down the shared direct-injection riser into the vessel
      this.pipe(ctx, [[u, 7.2], [u, 6.02], [DVI, 6.02], [DVI, r.z0 + 1.1],
        [r.u + r.r * 0.85, r.z0 + 1.1]],
        { w: 4, color: C.cold, flow: s.cmt, phase: time });
      // pressure balance line: the tanks sit at system pressure, so the water
      // falls out of them the moment the level in the loop drops
      this.pipe(ctx, [[u, 9.2], [u, 9.6], [DVI, 9.6], [DVI, G.coldZ]],
        { w: 2.4, color: '#5c6a76', flow: 0 });
    }
    this.callout(ctx, 3.5, 9.2 - 0.35, 11, 'core makeup tanks');

    // accumulators
    for (let i = 0; i < 2; i++) {
      const u = 10.1 + i * 0.95;
      this.vessel(ctx, {
        u, r: 0.34, z0: 6.2, z1: 7.9,
        level: 6.2 + 1.7 * Math.max(0, Math.min(1, p.accumLevel)),
        liquid: C.cold, wall: C.steel, head: true
      });
      this.pipe(ctx, [[u, 6.2], [u, 5.02], [DVI, 5.02], [DVI, r.z0 + 1.1]],
        { w: 4, color: C.cold, flow: s.accum, phase: time });
    }
    this.callout(ctx, 10.1, 7.9 + 0.55, 12, 'accumulators');

    // automatic depressurisation, venting the pressuriser into the pool
    this.valve(ctx, G.przr.u - 0.75, G.przr.z1 + 0.45, s.ads, false, false);
    this.pipe(ctx, [[G.przr.u - 0.75, G.przr.z1 + 0.45], [irw.u1 - 0.5, G.przr.z1 + 0.45],
    [irw.u1 - 0.5, irwLvl + 0.2]],
      { w: 4.5, color: '#c6d3dc', flow: s.ads ? 1 : 0, phase: time });
    this.callout(ctx, G.przr.u - 0.75, G.przr.z1 + 1.05, 13, 'depressurisation');
    if (s.ads) this.tag(ctx, G.przr.u + 1.4, G.przr.z1 + 1.15, 'ADS OPEN', 'ok');

    // gravity injection, straight down into the vessel
    this.pipe(ctx, [[irw.u0 + 0.4, irw.z0], [irw.u0 + 0.4, 2.32],
      [r.u - r.r * 0.85, 2.32]],
      { w: 5.5, color: C.cold, flow: s.gravity, phase: time });
    this.valve(ctx, irw.u0 + 0.4, 3.6, s.gravity > 0, false, false);
    if (s.gravity > 0) this.tag(ctx, irw.u0 + 1.7, 1.72, 'GRAVITY INJECTION', 'ok');

    if (p.sabotaged) {
      ctx.save();
      ctx.strokeStyle = C.bad; ctx.lineWidth = 3;
      for (const [u, z] of [[hx.u, (hx.z0 + hx.z1) / 2], [5.0, 8.2], [10.6, 7.0],
      [irw.u0 + 0.4, 3.6]]) {
        const q = this.P(u, z);
        ctx.beginPath();
        ctx.moveTo(q.x - 11, q.y - 11); ctx.lineTo(q.x + 11, q.y + 11);
        ctx.moveTo(q.x + 11, q.y - 11); ctx.lineTo(q.x - 11, q.y + 11);
        ctx.stroke();
      }
      ctx.restore();
      this.tag(ctx, 6.5, 11.4, 'PASSIVE SYSTEMS DISABLED (what-if)', 'bad');
    }

    this.pccs(ctx, time);
  }

  // passive containment cooling: film on the shell, draught up the annulus
  pccs(ctx, time) {
    const p = this.plant, s = p.sys || {}, G = this.geom;
    const on = s.pccs > 0;
    // the gravity tank, sitting on the shield building
    const tank = { u0: 4.9, u1: 8.1, z0: 11.5, z1: 12.6 };
    const lvl = tank.z0 + (tank.z1 - tank.z0) * Math.max(0, Math.min(1, p.pccwst / 3.0e6));
    this.pool(ctx, {
      u0: tank.u0, u1: tank.u1, z0: tank.z0, z1: tank.z1,
      level: lvl, liquid: C.cold, wall: C.steel
    });
    this.pccwT = (p.pccwst / 1000) | 0;

    // air in at the bottom of the annulus, out over the dome
    const arrow = (uz, col, flow) => {
      if (!flow) return;
      const pts = uz.map(q => this.P(q[0], q[1]));
      let total = 0; const segs = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const L = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        segs.push(L); total += L;
      }
      const n = Math.max(2, Math.round(total / 46));
      for (let k = 0; k < n; k++) {
        let t = (((time * 0.4 + k / n) % 1)) * total, i = 0;
        while (i < segs.length && t > segs[i]) { t -= segs[i]; i++; }
        if (i >= segs.length) continue;
        const a = pts[i], b = pts[i + 1], L = segs[i] || 1;
        ctx.save();
        ctx.translate(a.x + (b.x - a.x) * (t / L), a.y + (b.y - a.y) * (t / L));
        ctx.rotate(Math.atan2((b.y - a.y) / L, (b.x - a.x) / L));
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(6, 0); ctx.lineTo(-4, 3.6); ctx.lineTo(-4, -3.6);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    };
    arrow([[0.2, 11.4], [0.2, 2.1], [0.85, 1.25]], C.air, on ? 1 : 0);
    arrow([[12.75, 1.3], [12.75, 9.6], [11.2, 12.0], [6.5, 13.3]], '#f0b070', on ? 1 : 0);
    this.callout(ctx, (tank.u0 + tank.u1) / 2, tank.z0 + 0.6, 14,
      `PCCS tank \u00b7 ${this.pccwT.toLocaleString()} t`);
    this.note(ctx, 0.4, 0.3, 'air in');
    this.note(ctx, 10.9, 12.35, 'warm air out');

    // the evaporating film, drawn ON the shell
    if (s.film > 0 && on) {
      ctx.strokeStyle = 'rgba(158,220,252,0.95)';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      // Over the crown, on the shell itself: the film is water running on the
      // outside of the steel, which is the whole mechanism, so it has to be
      // drawn there and not floating in the room.
      const A = this.P(G.wallU0, G.springZ), B = this.P(G.wallU1, G.springZ);
      const apexY = this.P(6.5, G.apexZ).y;
      const crown = (q) => {
        const m = 1 - q;
        return {
          x: A.x * (m * m * m + 3 * m * m * q) + B.x * (3 * m * q * q + q * q * q),
          y: m * m * m * A.y + 3 * m * m * q * apexY + 3 * m * q * q * apexY + q * q * q * B.y
        };
      };
      for (let i = 0; i < 9; i++) {
        const q = ((time * 0.10 + i / 9) % 1) * 0.94 + 0.03;
        const p0 = crown(q), p1 = crown(Math.min(0.999, q + 0.035));
        const dx = p1.x - p0.x, dy = p1.y - p0.y, L = Math.hypot(dx, dy) || 1;
        const off = 4 * this.ts;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(p0.x + (dy / L) * off, p0.y - (dx / L) * off);
        ctx.lineTo(p1.x + (dy / L) * off, p1.y - (dx / L) * off);
        ctx.stroke();
      }
      for (let i = 0; i < 8; i++) {
        const t = ((time * 0.42 + i * 0.125) % 1);
        const u = (i % 2 ? G.wallU1 + 0.28 : G.wallU0 - 0.28);
        const z0 = G.springZ + 0.15 - t * (G.springZ - G.floorZ);
        const a = this.P(u, z0), b = this.P(u, z0 - 0.55);
        ctx.globalAlpha = 0.3 + 0.55 * (1 - t);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      this.note(ctx, 3.7, G.springZ + 1.05, 'evaporating film');
    }
  }

  // ---- containment atmosphere -------------------------------------------
  atmosphere(ctx) {
    const p = this.plant, G = this.geom;
    ctx.save();
    this.shellPath(ctx, G.wallU0, G.wallU1, G.springZ, G.apexZ, G.floorZ);
    ctx.closePath();
    ctx.clip();
    const box = () => {
      const a = this.P(G.wallU0 - 1, G.apexZ + 1), b = this.P(G.wallU1 + 1, G.floorZ - 1);
      return [a.x, a.y, b.x - a.x, b.y - a.y];
    };
    const hz = Math.max(0, Math.min(0.45, (p.Tctmt - 320) / 170));
    if (hz > 0.01) {
      ctx.fillStyle = `rgba(214,228,238,${hz * 0.4})`;
      ctx.fillRect(...box());
    }
    const h2 = p.h2 + p.h2Building;
    const h2f = Math.min(1, h2 / 900);
    if (h2f > 0.01) {
      const zBot = G.springZ - h2f * 6.6;
      const a = this.P(G.wallU0 - 1, G.apexZ + 1), c = this.P(G.wallU1 + 1, zBot);
      ctx.fillStyle = rgba(C.h2, 0.10 + 0.2 * h2f);
      ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
      ctx.strokeStyle = rgba(C.h2, 0.75); ctx.lineWidth = 1.8;
      const d0 = this.P(G.wallU0, zBot), d1 = this.P(G.wallU1, zBot);
      ctx.beginPath(); ctx.moveTo(d0.x, d0.y); ctx.lineTo(d1.x, d1.y); ctx.stroke();
      ctx.restore();
      this.tag(ctx, 6.5, zBot + 0.65, `hydrogen ${h2 | 0} kg`, 'bad');
      return;
    }
    ctx.restore();
  }

  // ---- the end states, drawn rather than asserted ------------------------
  breach(ctx, time) {
    const p = this.plant, G = this.geom, r = G.rpv;
    if (p.vesselBreach) {
      const a = this.P(r.u - 0.5, r.z0), b = this.P(r.u + 0.5, r.z0);
      ctx.strokeStyle = '#0c1015'; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const c = this.P(r.u, G.floorZ + 0.2);
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 86);
      const f = 0.55 + 0.2 * Math.sin(time * 2);
      g.addColorStop(0, `rgba(255,196,90,${f})`);
      g.addColorStop(0.45, `rgba(238,104,36,${f * 0.65})`);
      g.addColorStop(1, 'rgba(170,40,14,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, 86, 20, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e2621f';
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 42 + 13 * p.mcci, 10 + 3 * p.mcci, 0, 0, Math.PI * 2);
      ctx.fill();
      this.tag(ctx, r.u + 3.5, G.floorZ + 0.5, 'corium on the basemat', 'bad');
    }
    if (p.explosions > 0 || p.rupturedByPower) {
      const A = this.P(G.wallU0 - 0.4, G.springZ), B = this.P(G.wallU1 + 0.4, G.springZ);
      ctx.fillStyle = '#0f151b';
      ctx.fillRect(A.x - 8, A.y - 300, B.x - A.x + 16, 300);
      ctx.strokeStyle = '#8b8579'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i <= 26; i++) {
        const u = G.wallU0 - 0.4 + (G.wallU1 - G.wallU0 + 0.8) * (i / 26);
        const q = this.P(u, G.springZ + hash2(i, 3, 1) * 0.85);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,130,70,0.5)'; ctx.lineWidth = 2;
      ctx.stroke();
      this.tag(ctx, 6.5, G.springZ + 1.4, 'ROOF BLOWN OFF', 'bad');
    } else if (!p.ctmtIntact) {
      this.tag(ctx, 6.5, G.springZ + 1.0, 'CONTAINMENT FAILED', 'bad');
    }
  }

  // ---- the electrical chain ----------------------------------------------
  powerRow(ctx, time) {
    const p = this.plant, s = p.sys || {}, t = this.ts;
    const z = -1.6;
    const items = [
      { u: 1.2, label: 'GRID', on: !!s.grid },
      { u: 4.9, label: 'DIESELS', on: !!s.diesel },
      { u: 8.6, label: 'BATTERY', on: s.battery > 0 },
      { u: 12.3, label: 'PUMPS', on: s.rcp > 0 || s.aux > 0 || s.feed > 0 }
    ];
    for (let i = 0; i < items.length - 1; i++) {
      const live = items[i].on && items[i + 1].on;
      this.pipe(ctx, [[items[i].u + 0.5, z], [items[i + 1].u - 0.5, z]],
        { w: 3.4, color: live ? C.power : '#394046', flow: live ? 1.5 : 0, phase: time });
    }
    for (const it of items) {
      const q = this.P(it.u, z);
      ctx.beginPath(); ctx.arc(q.x, q.y, 8.5 * t, 0, Math.PI * 2);
      ctx.fillStyle = it.on ? C.power : '#333940';
      ctx.fill();
      ctx.strokeStyle = it.on ? shade(C.power, 0.7) : C.wallDim;
      ctx.lineWidth = 1.4 * t; ctx.stroke();
      ctx.font = this.f(8.5, '700');
      ctx.fillStyle = it.on ? '#f6e8bf' : '#767d84';
      ctx.textAlign = 'center';
      ctx.fillText(it.label, q.x, q.y + 20 * t);
      ctx.textAlign = 'left';
    }
    const base = this.P(6.5, z);
    // one line of state for the chain itself; the per-item story is the key
    const cy = base.y + 34 * t;
    let txt = null, col = C.textDim;
    if (this.passive) {
      txt = 'electrical supply \u2014 nothing safety-related hangs off it';
      col = 'rgba(150,168,182,0.8)';
    } else if (p.coolingMargin < 0.99) {
      txt = 'no cooling path left \u2014 the chain above is broken'; col = C.bad;
    } else if (!s.grid && !s.diesel && s.battery > 0) {
      txt = `running on batteries \u2014 ${(s.battery * p.batteryHours).toFixed(1)} h left`;
      col = C.warn;
    } else {
      txt = 'electrical supply \u2014 every safety function below depends on it';
      col = 'rgba(198,212,224,0.8)';
    }
    ctx.font = this.f(10, '600');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = col;
    ctx.fillText(txt, base.x, cy);
    this.mark(base.x, ctx.measureText(txt).width);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    return cy + 18 * t;
  }

  // ---- annunciator row, the way a control room does it -------------------
  annunciators(ctx) {
    const p = this.plant;
    const list = p.alarms.slice(0, 3).map(a => a.length > 19 ? a.slice(0, 18) + '\u2026' : a);
    if (!list.length) return;
    const t = this.ts;
    const base = this.P(6.5, this.topZ - 0.62);
    ctx.font = this.f(8.5, '700');
    const pad = 9 * t, gap = 5 * t;
    let total = 0;
    const ws = list.map(a => { const w = ctx.measureText(a).width + pad * 2; total += w + gap; return w; });
    const span = this.P(13.4, 0).x - this.P(-0.4, 0).x;
    if (total - gap > span) {                 // squeeze rather than overflow
      const k = span / (total - gap);
      for (let i = 0; i < ws.length; i++) ws[i] *= k;
      total = span + gap;
    }
    let x = base.x - (total - gap) / 2;
    this.mark(base.x, total - gap);
    for (let i = 0; i < list.length; i++) {
      ctx.fillStyle = 'rgba(74,18,12,0.92)';
      rr(ctx, x, base.y - 8 * t, ws[i], 16 * t, 3 * t); ctx.fill();
      ctx.strokeStyle = 'rgba(255,92,72,0.65)'; ctx.lineWidth = 1 * t;
      rr(ctx, x, base.y - 8 * t, ws[i], 16 * t, 3 * t); ctx.stroke();
      ctx.fillStyle = '#ffcbbf';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(list[i], x + ws[i] / 2, base.y + 0.5 * t);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      x += ws[i] + gap;
    }
  }

  title(ctx) {
    const p = this.plant, t = this.ts;
    const q = this.P(6.5, this.topZ + 1.55);
    // the title runs after draw(), so it widens the box the camera just measured
    const grow = (w) => {
      if (!this.bounds) return;
      this.bounds.left = Math.min(this.bounds.left, q.x - w / 2 - 4 * t);
      this.bounds.right = Math.max(this.bounds.right, q.x + w / 2 + 4 * t);
    };
    ctx.textAlign = 'center';
    ctx.font = this.f(15, '800');
    ctx.fillStyle = this.passive ? '#57d9ff' : '#ff8b5c';
    ctx.fillText(this.passive ? 'PASSIVE · Gen III+' : 'ACTIVE · Gen II', q.x, q.y);
    grow(ctx.measureText(this.passive ? 'PASSIVE \u00b7 Gen III+' : 'ACTIVE \u00b7 Gen II').width);
    ctx.font = this.f(11, '600');
    ctx.fillStyle = 'rgba(198,214,228,0.7)';
    ctx.fillText(this.passive
      ? 'gravity \u00b7 natural circulation \u00b7 evaporation'
      : 'pumps \u00b7 diesels \u00b7 operators', q.x, q.y + 15 * t);
    const good = /SAFE|NORMAL|STABLE/.test(p.state);
    ctx.font = this.f(12, '800');
    const w = ctx.measureText(p.state).width + 22 * t;
    const by = q.y + 26 * t;
    ctx.fillStyle = good ? 'rgba(16,58,36,0.92)' : 'rgba(74,18,12,0.92)';
    rr(ctx, q.x - w / 2, by, w, 20 * t, 5 * t); ctx.fill();
    ctx.strokeStyle = good ? 'rgba(99,224,138,0.6)' : 'rgba(255,110,80,0.65)';
    ctx.lineWidth = 1.2 * t;
    rr(ctx, q.x - w / 2, by, w, 20 * t, 5 * t); ctx.stroke();
    ctx.fillStyle = good ? '#8ff0b4' : '#ff9c88';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.state, q.x, by + 10.5 * t);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  }
}
