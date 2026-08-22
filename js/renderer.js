// ---------------------------------------------------------------------------
// renderer.js — scene composition: sky, animated ocean, baked terrain,
// tsunami inundation, depth-sorted solids, particles and map overlays.
// ---------------------------------------------------------------------------
import { W, H, T } from './world.js';
import { P } from './draw3d.js';
import { TW, TH, EH } from './iso.js';
import { clamp, lerp, TAU, fbm, smoothstep } from './util.js';
import { drawProp } from './props.js';
import { roundRect, PlantView } from './plantview.js';

export class Renderer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.oceanPath = null;
    this.shorePts = [];
    this.list = [];
  }

  // Blit only the part of a baked layer that is actually on screen. Scaling a
  // 3000x1600 layer every frame is what kills this on a phone.
  blit(ctx, img, bb, view) {
    const sx = Math.max(0, Math.floor(view.minX - bb.minX) - 2);
    const sy = Math.max(0, Math.floor(view.minY - bb.minY) - 2);
    const sw = Math.min(img.width - sx, Math.ceil(view.maxX - view.minX) + 6);
    const sh = Math.min(img.height - sy, Math.ceil(view.maxY - view.minY) + 6);
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(img, sx, sy, sw, sh, bb.minX + sx, bb.minY + sy, sw, sh);
  }

  buildOcean() {
    const w = this.world;
    // The sea is not a set of tiles — it runs to the horizon. Everything with
    // x+y < K is water; land is blitted on top of it afterwards.
    const K = w.shore + 8;
    const F = 90;
    const p = new Path2D();
    const v = [[-F, -F], [K + F, -F], [-F, K + F]];
    v.forEach((q, i) => {
      const s2 = P(q[0], q[1], 0);
      if (i === 0) p.moveTo(s2[0], s2[1]); else p.lineTo(s2[0], s2[1]);
    });
    p.closePath();
    this.oceanPath = p;
    // shallow band + foam line follow the real coastline
    this.shorePts = [];
    for (let s2 = 0; s2 <= W + H; s2++) {
      for (let x = Math.max(0, s2 - H + 1); x < Math.min(W, s2 + 1); x++) {
        const y = s2 - x;
        if (y < 0 || y >= H) continue;
        if (w.type[w.idx(x, y)] !== T.OCEAN) continue;
        if (w.tileAt(x + 1, y) !== T.OCEAN || w.tileAt(x, y + 1) !== T.OCEAN)
          this.shorePts.push([x + 1, y + 1]);
      }
    }
    this.shorePts.sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));
    // shallow-water strip drawn just seaward of the coast
    const sh = new Path2D();
    for (const [x, y] of this.shorePts) {
      const a = P(x - 1, y - 1, 0), b = P(x + 1, y - 1, 0), c = P(x + 1, y + 1, 0), d = P(x - 1, y + 1, 0);
      sh.moveTo(a[0], a[1]); sh.lineTo(b[0], b[1]); sh.lineTo(c[0], c[1]); sh.lineTo(d[0], d[1]); sh.closePath();
    }
    this.shallowPath = sh;
    const shoreY = P(K, 0, 0)[1];          // the coast projects to a constant screen y
    this.shoreY = shoreY;
    this.oceanBox = { x: -14000, y: shoreY - 2600, w: 28000, h: 2640 };
  }

  // -------------------------------------------------------------------
  draw(sim) {
    const ctx = this.ctx, cam = sim.cam, w = this.world;
    const CW = this.canvas.width, CH = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // ---- sky + vignette (cached; regenerated only when the mood changes) ----
    const gloom = clamp(sim.gloom, 0, 1);
    const key = `${CW}x${CH}x${Math.round(gloom * 24)}`;
    if (this.bgKey !== key) this.makeBackdrop(CW, CH, gloom, key);
    ctx.drawImage(this.bgCanvas, 0, 0);


    cam.applyTransform(ctx);

    // visible rectangle in scene coordinates — everything below culls to it
    const cc = P(cam.x, cam.y, 0);
    const halfW = (CW / 2) / cam.zoom, halfH = (CH / 2) / cam.zoom;
    const view = { minX: cc[0] - halfW, maxX: cc[0] + halfW, minY: cc[1] - halfH, maxY: cc[1] + halfH };
    this.view = view;

    // ---- ocean ----
    this.drawOcean(ctx, sim, view);

    // ---- terrain + baked layers (visible sub-rectangle only) ----
    const bb = w.bakeBox;
    this.blit(ctx, w.terrainCanvas, bb, view);
    if (w.overlayCanvas && w.hasOverlay) this.blit(ctx, w.overlayCanvas, bb, view);
    if (w.propsCanvas) this.blit(ctx, w.propsCanvas, bb, view);

    // ---- flood water on land ----
    if (sim.tsunami && sim.tsunami.active) this.drawFlood(ctx, sim, view);

    PlantView.zoom = cam.zoom;
    // ---- solids ----
    const list = this.list; list.length = 0;
    let live = 0;
    for (const p of w.props) {
      if (!w.isLive(p, sim.tsunami)) continue;
      live++;
      const q = P(p.x, p.y, p.z);
      if (q[0] < view.minX - 90 || q[0] > view.maxX + 90 ||
        q[1] < view.minY - 140 || q[1] > view.maxY + 90) continue;
      list.push({ d: p.x + p.y, p });
    }
    if (live !== w.liveCount) { w.liveCount = live; w.dirtyProps = true; }
    for (const v of sim.views) v.collect(list, w, 'live');
    list.sort((a, b) => a.d - b.d);
    for (const it of list) {
      if (it.p) drawProp(ctx, it.p, w, sim.visTime);
      else it.fn(ctx);
    }

    // second water pass so the flood visibly washes over what it swallowed
    if (sim.tsunami && sim.tsunami.active) this.drawFlood(ctx, sim, view, 1);

    // ---- annotations (screen-sized, so drawn live) ----
    for (const v of sim.views) v.drawTags(ctx);

    // ---- particles ----
    sim.fx.draw(ctx, cam, view);

    // ---- map overlays ----
    if (sim.showZones) this.drawZones(ctx, sim);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawVignette(ctx, CW, CH, sim);
    this.drawCompass(ctx, CW, CH, sim);
  }

  drawOcean(ctx, sim, view) {
    const t = sim.visTime;
    ctx.save();
    ctx.clip(this.oceanPath);
    const b = this.oceanBox;
    const x0 = Math.max(b.x, view.minX - 60), x1 = Math.min(b.x + b.w, view.maxX + 60);
    const g = ctx.createLinearGradient(0, this.shoreY - 1000, 0, this.shoreY + 30);
    g.addColorStop(0.00, '#0a2036');
    g.addColorStop(0.42, '#11405f');
    g.addColorStop(0.78, '#1d6f90');
    g.addColorStop(1.00, '#38a2b0');
    ctx.fillStyle = g;
    ctx.fillRect(x0, b.y, x1 - x0, b.h);
    // long swell lines, denser toward the horizon
    ctx.strokeStyle = '#d5f0ff';
    for (let i = 0; i < 70; i++) {
      const k = i / 70;
      const yy = this.shoreY - 1000 + Math.pow(k, 1.6) * 1010 + Math.sin(t * 0.7 + i * 0.9) * 2.5;
      ctx.globalAlpha = 0.05 + 0.12 * k;
      ctx.lineWidth = 0.8 + 1.6 * k;
      if (yy < view.minY - 20 || yy > view.maxY + 20) continue;
      ctx.beginPath();
      for (let x = x0, first = true; x < x1; x += 34, first = false) {
        const off = Math.sin(x * 0.010 + t * 1.3 + i * 0.6) * (1.5 + 4 * k);
        if (first) ctx.moveTo(x, yy + off); else ctx.lineTo(x, yy + off);
      }
      ctx.stroke();
    }
    // sun glitter
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 120; i++) {
      const sx = x0 + ((i * 137.5 + t * 22) % Math.max(1, x1 - x0));
      const sy = this.shoreY - 940 + ((i * 89.3 + Math.sin(t * 0.6 + i) * 14) % 930);
      ctx.fillRect(sx, sy, 4 + (i % 3) * 3, 1.1);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // shallows over the sea floor near the beach
    ctx.save();
    ctx.clip(this.shallowPath);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#49b7bf';
    ctx.fillRect(x0, b.y, x1 - x0, b.h);
    ctx.globalAlpha = 1;
    ctx.restore();

    // breaking foam along the coastline
    ctx.save();
    ctx.lineCap = 'round';
    for (const pass of [[9, 0.16, '#bfe8f5'], [3.4, 0.55, '#f2fbff']]) {
      ctx.globalAlpha = pass[1];
      ctx.strokeStyle = pass[2];
      ctx.lineWidth = pass[0];
      ctx.beginPath();
      for (let i = 0; i < this.shorePts.length; i++) {
        const [x, y] = this.shorePts[i];
        const q = P(x, y, 0.03 + Math.sin(t * 2.2 + (x + y) * 0.8) * 0.035);
        if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawFlood(ctx, sim, view, pass = 0) {
    const w = this.world, ts = sim.tsunami;
    const t = sim.visTime;
    const front = ts.front;
    ctx.save();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = x + y;
        if (s > front) continue;
        const i = w.idx(x, y);
        if (w.type[i] === T.OCEAN) continue;
        const z = w.z[i];
        const surf = ts.level;
        if (z >= surf) continue;
        const depth = surf - z;
        const a = P(x, y, surf), b2 = P(x + 1, y, surf), c = P(x + 1, y + 1, surf), d = P(x, y + 1, surf);
        if (a[0] < view.minX - 70 || a[0] > view.maxX + 70 || a[1] < view.minY - 70 || a[1] > view.maxY + 70) continue;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
        ctx.closePath();
        const murk = clamp(depth / 6, 0.25, 0.85);
        const shimmer = 0.06 * Math.sin(t * 3 + x * 0.7 + y * 0.5);
        const a0 = pass ? 0.30 : clamp(0.55 + murk * 0.35 + shimmer, 0, 0.95);
        ctx.fillStyle = `rgba(${34 + 30 * (1 - murk) | 0},${74 + 30 * (1 - murk) | 0},${92 + 20 * (1 - murk) | 0},${a0})`;
        ctx.fill();
      }
    }
    // breaking crest: a dark wall of water, a foam lip and spray
    if (ts.advancing && !pass) {
      const crest = (dz, w, col, a) => {
        ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = w;
        ctx.beginPath();
        let started = false;
        for (let x = -2; x < W + 2; x += 0.5) {
          const y = front - x;
          const q = P(x, y, ts.level + dz + Math.sin(t * 5 + x * 0.9) * 0.09
            + Math.sin(t * 2.3 + x * 0.31) * 0.14);
          if (!started) { ctx.moveTo(q[0], q[1]); started = true; } else ctx.lineTo(q[0], q[1]);
        }
        ctx.stroke();
      };
      crest(0.30, 26, '#17384f', 0.55);
      crest(0.62, 15, '#2f7ea0', 0.6);
      crest(0.86, 8, '#bfe9f7', 0.75);
      crest(0.99, 3.5, '#ffffff', 0.95);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawZones(ctx, sim) {
    for (const v of sim.views) {
      const p = v.plant;
      const c = p.consequences();
      if (c.pbq < 1e-4) continue;
      const x = v.s.x + v.parts.reactor.x, y = v.s.y + v.parts.reactor.y;
      const o = P(x, y, 0);
      const rings = [
        { r: c.exclusionR * 0.55, col: '255,70,60', lbl: 'Exclusion' },
        { r: c.exclusionR, col: '255,160,40', lbl: 'Evacuation' },
        { r: c.exclusionR * 1.9, col: '255,232,90', lbl: 'Sheltering' }
      ];
      ctx.save();
      for (const rg of rings) {
        const rr = rg.r * 1.6;   // km -> tiles (1 tile ~ 625 m)
        ctx.strokeStyle = `rgba(${rg.col},0.55)`;
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(o[0], o[1], rr * TW * 0.7071, rr * TH * 0.7071, 0, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = `rgba(${rg.col},0.05)`;
        ctx.fill();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // wind rose + scale bar, tucked into the empty sky beside the left panel
  drawCompass(ctx, CW, CH, sim) {
    const dpr = CW / (window.innerWidth || CW);
    const narrow = CW / dpr < 861;
    const R = 30 * dpr;
    const cx = (narrow ? 20 : 328) * dpr + R;
    const cy = (narrow ? 104 : 112) * dpr;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU);
    ctx.fillStyle = 'rgba(9,15,23,0.55)'; ctx.fill();
    ctx.strokeStyle = 'rgba(140,190,220,0.28)'; ctx.lineWidth = 1 * dpr; ctx.stroke();
    // the direction the plume travels, in screen terms
    const th = (sim.fx.windDeg || 0) * Math.PI / 180;
    const ax = Math.sin(th), ay = -Math.cos(th);
    ctx.strokeStyle = '#57d9ff'; ctx.lineWidth = 2.4 * dpr; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - ax * R * 0.6, cy - ay * R * 0.6);
    ctx.lineTo(cx + ax * R * 0.62, cy + ay * R * 0.62);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + ax * R * 0.72, cy + ay * R * 0.72);
    ctx.lineTo(cx + ax * R * 0.3 - ay * R * 0.26, cy + ay * R * 0.3 + ax * R * 0.26);
    ctx.lineTo(cx + ax * R * 0.3 + ay * R * 0.26, cy + ay * R * 0.3 - ax * R * 0.26);
    ctx.closePath();
    ctx.fillStyle = '#57d9ff'; ctx.fill();
    ctx.fillStyle = 'rgba(210,232,244,0.85)';
    ctx.font = `${9 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('WIND', cx, cy - R - 5 * dpr);
    // scale bar: one tile is about 25 m; pick a round length that fits
    let tiles = 1;
    for (const c of [16, 8, 4, 2, 1]) {
      if (c * TW * sim.cam.zoom <= 120 * dpr) { tiles = c; break; }
    }
    const px = tiles * TW * sim.cam.zoom;
    const bx = cx - R, by = cy + R + 14 * dpr;
    ctx.strokeStyle = 'rgba(220,235,245,0.75)'; ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4 * dpr); ctx.lineTo(bx, by); ctx.lineTo(bx + px, by);
    ctx.lineTo(bx + px, by - 4 * dpr);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(`${tiles * 25} m`, bx, by + 11 * dpr);
    ctx.restore();
  }

  makeBackdrop(CW, CH, gloom, key) {
    if (!this.bgCanvas) { this.bgCanvas = document.createElement('canvas'); this.vgCanvas = document.createElement('canvas'); }
    for (const c of [this.bgCanvas, this.vgCanvas]) { c.width = CW; c.height = CH; }
    const g = this.bgCanvas.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, CH);
    sky.addColorStop(0, `rgb(${lerp(126, 66, gloom) | 0},${lerp(178, 68, gloom) | 0},${lerp(222, 78, gloom) | 0})`);
    sky.addColorStop(0.55, `rgb(${lerp(178, 108, gloom) | 0},${lerp(212, 100, gloom) | 0},${lerp(236, 104, gloom) | 0})`);
    sky.addColorStop(1, `rgb(${lerp(222, 140, gloom) | 0},${lerp(232, 122, gloom) | 0},${lerp(228, 112, gloom) | 0})`);
    g.fillStyle = sky; g.fillRect(0, 0, CW, CH);
    const v = this.vgCanvas.getContext('2d');
    const rg = v.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.34,
      CW / 2, CH / 2, Math.max(CW, CH) * 0.78);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(1, `rgba(4,8,16,${0.34 + gloom * 0.2})`);
    v.fillStyle = rg; v.fillRect(0, 0, CW, CH);
    this.bgKey = key;
  }

  drawVignette(ctx, CW, CH, sim) {
    if (this.vgCanvas) ctx.drawImage(this.vgCanvas, 0, 0);
    if (sim.whiteout > 0.01) {
      ctx.fillStyle = `rgba(255,250,235,${clamp(sim.whiteout, 0, 0.85)})`;
      ctx.fillRect(0, 0, CW, CH);
    }
  }
}
