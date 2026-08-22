// ---------------------------------------------------------------------------
// renderer.js - site view composition.
//
// Order is: sky, ocean, terrain, ground overlays, THE ONE SORTED PASS,
// tsunami wash, particles, then screen-space labels and HUD. Flat things that
// can never occlude are painted before the pass; anything with a footprint
// goes into it, keyed on x + y (+ half its footprint for a box).
// ---------------------------------------------------------------------------
import { W, H, T } from './world.js';
import { project, unproject, TW, TH, TZ, poly, polyLine, shade, rgba } from './iso.js';
import { drawProp, propKey } from './props.js';

export class Renderer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.list = [];
    this.shorePts = [];
  }

  // -------------------------------------------------------------------
  buildOcean() {
    const w = this.world;
    // The sea runs to the horizon, so it is one big triangle in grid space
    // rather than a set of tiles; land is painted on top of it.
    const K = w.shore + 8, F = 90;
    const p = new Path2D();
    [[-F, -F], [K + F, -F], [-F, K + F]].forEach((q, i) => {
      const s = project(q[0], q[1], 0);
      if (i === 0) p.moveTo(s.x, s.y); else p.lineTo(s.x, s.y);
    });
    p.closePath();
    this.oceanPath = p;
    this.shoreY = project(K, 0, 0).y;

    this.shorePts = [];
    for (let s = 0; s <= W + H; s++) {
      for (let x = Math.max(0, s - H + 1); x < Math.min(W, s + 1); x++) {
        const y = s - x;
        if (y < 0 || y >= H) continue;
        if (w.type[w.idx(x, y)] !== T.OCEAN) continue;
        if (w.tileAt(x + 1, y) !== T.OCEAN || w.tileAt(x, y + 1) !== T.OCEAN)
          this.shorePts.push([x + 1, y + 1]);
      }
    }
    this.shorePts.sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));
    const sh = new Path2D();
    for (const [x, y] of this.shorePts) {
      const a = project(x - 1, y - 1, 0), b = project(x + 1, y - 1, 0);
      const c = project(x + 1, y + 1, 0), d = project(x - 1, y + 1, 0);
      sh.moveTo(a.x, a.y); sh.lineTo(b.x, b.y); sh.lineTo(c.x, c.y); sh.lineTo(d.x, d.y); sh.closePath();
    }
    this.shallowPath = sh;
  }

  // -------------------------------------------------------------------
  draw(sim) {
    if (sim.view === 'cut') return this.drawCut(sim);
    return this.drawSite(sim);
  }

  // The inside of both plants, cut open. Drawn back to front by hand: the
  // geometry is fixed, so a sort would only add a way to get it wrong.
  drawCut(sim) {
    const ctx = this.ctx, cam = sim.cutCam;
    const CW = this.canvas.width, CH = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, CH);
    g.addColorStop(0, '#0c141d');
    g.addColorStop(0.5, '#121c26');
    g.addColorStop(1, '#0a1119');
    ctx.fillStyle = g; ctx.fillRect(0, 0, CW, CH);
    // faint blueprint grid
    ctx.strokeStyle = 'rgba(120,170,210,0.05)';
    ctx.lineWidth = 1;
    const step = 40;
    ctx.beginPath();
    for (let x = 0; x < CW; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, CH); }
    for (let y = 0; y < CH; y += step) { ctx.moveTo(0, y); ctx.lineTo(CW, y); }
    ctx.stroke();

    cam.applyTransform(ctx);
    for (const c of sim.cuts) { c.draw(ctx, sim.visTime); c.title(ctx); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawCutLegend(ctx, CW, CH);
    return undefined;
  }

  drawCutLegend(ctx, CW, CH) {
    const dpr = CW / (window.innerWidth || CW);
    const narrow = CW / dpr < 861;
    const items = [
      ['#3a8fd8', 'cold water'], ['#41a9c4', 'warm'], ['#d3a53c', 'hot'],
      ['#ef4326', 'fuel > 1300 C'], ['#d9e04a', 'hydrogen'],
      ['#8fd8e8', 'air draught'], ['#ffd35c', 'electrical power']
    ];
    const left = (narrow ? 10 : 322) * dpr;
    const right = CW - (narrow ? 10 : 348) * dpr;
    ctx.save();
    ctx.font = `${9.5 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    // a strip behind it, or it lands on top of the section captions
    const stripH = 34 * dpr;
    ctx.fillStyle = 'rgba(8,13,19,0.82)';
    ctx.fillRect(0, CH - (narrow ? 140 : 40) * dpr, CW, stripH);
    // lay out into as many rows as it takes
    const rows = [[]];
    let x = left;
    for (const it of items) {
      const w = ctx.measureText(it[1]).width + 22 * dpr;
      if (x + w > right && rows[rows.length - 1].length) { rows.push([]); x = left; }
      rows[rows.length - 1].push([it, x, w]);
      x += w;
    }
    const baseY = CH - (narrow ? 126 : 26) * dpr - (rows.length - 1) * 15 * dpr;
    rows.forEach((row, ri) => {
      const y = baseY + ri * 15 * dpr;
      for (const [it, px] of row) {
        ctx.fillStyle = it[0];
        ctx.fillRect(px, y - 7 * dpr, 9 * dpr, 9 * dpr);
        ctx.fillStyle = 'rgba(205,222,236,0.85)';
        ctx.fillText(it[1], px + 13 * dpr, y + dpr);
      }
    });
    ctx.restore();
  }

  drawSite(sim) {
    const ctx = this.ctx, cam = sim.cam, w = this.world;
    const CW = this.canvas.width, CH = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const gloom = Math.max(0, Math.min(1, sim.gloom));
    const key = `${CW}x${CH}x${Math.round(gloom * 24)}`;
    if (this.bgKey !== key) this.makeBackdrop(CW, CH, gloom, key);
    ctx.drawImage(this.bgCanvas, 0, 0);

    cam.applyTransform(ctx);
    const cc = project(cam.x, cam.y, 0);
    const halfW = (CW / 2) / cam.zoom, halfH = (CH / 2) / cam.zoom;
    const view = {
      minX: cc.x - halfW - cam.ox / cam.zoom,
      maxX: cc.x + halfW - cam.ox / cam.zoom,
      minY: cc.y - halfH - cam.oy / cam.zoom,
      maxY: cc.y + halfH - cam.oy / cam.zoom
    };
    this.view = view;

    this.drawOcean(ctx, sim, view);

    const bb = w.bakeBox;
    this.blit(ctx, w.terrainCanvas, bb, view);
    if (w.overlayCanvas && w.hasOverlay) this.blit(ctx, w.overlayCanvas, bb, view);

    // ---- the one sorted pass ----
    const list = this.list; list.length = 0;
    for (const p of w.props) {
      const q = project(p.x, p.y, p.z);
      if (q.x < view.minX - 90 || q.x > view.maxX + 90 ||
        q.y < view.minY - 160 || q.y > view.maxY + 90) continue;
      list.push({ k: propKey(p), p });
    }
    for (const v of sim.views) v.collect(list, sim.visTime);
    list.sort((a, b) => a.k - b.k);
    for (const it of list) {
      if (it.p) drawProp(ctx, it.p, w, sim.visTime);
      else it.f(ctx);
    }

    // water washes over whatever it has swallowed
    if (sim.tsunami && sim.tsunami.active) this.drawFlood(ctx, sim, view);

    sim.fx.draw(ctx, cam, view);
    if (sim.showZones) this.drawZones(ctx, sim);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.vgCanvas) ctx.drawImage(this.vgCanvas, 0, 0);
    if (sim.whiteout > 0.01) {
      ctx.fillStyle = `rgba(255,250,235,${Math.min(0.85, sim.whiteout)})`;
      ctx.fillRect(0, 0, CW, CH);
    }
    this.drawLabels(ctx, sim, CW, CH);
    this.drawCompass(ctx, CW, CH, sim);
  }

  blit(ctx, img, bb, view) {
    const sx = Math.max(0, Math.floor(view.minX - bb.minX) - 2);
    const sy = Math.max(0, Math.floor(view.minY - bb.minY) - 2);
    const sw = Math.min(img.width - sx, Math.ceil(view.maxX - view.minX) + 6);
    const sh = Math.min(img.height - sy, Math.ceil(view.maxY - view.minY) + 6);
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(img, sx, sy, sw, sh, bb.minX + sx, bb.minY + sy, sw, sh);
  }

  // -------------------------------------------------------------------
  drawOcean(ctx, sim, view) {
    const t = sim.visTime;
    ctx.save();
    ctx.clip(this.oceanPath);
    const x0 = view.minX - 60, x1 = view.maxX + 60;
    const g = ctx.createLinearGradient(0, this.shoreY - 1000, 0, this.shoreY + 30);
    g.addColorStop(0.00, '#0d2740');
    g.addColorStop(0.42, '#154566');
    g.addColorStop(0.78, '#217495');
    g.addColorStop(1.00, '#3aa6b2');
    ctx.fillStyle = g;
    ctx.fillRect(x0, this.shoreY - 2600, x1 - x0, 2640);
    ctx.strokeStyle = '#d5f0ff';
    for (let i = 0; i < 60; i++) {
      const k = i / 60;
      const yy = this.shoreY - 1000 + Math.pow(k, 1.6) * 1010 + Math.sin(t * 0.7 + i * 0.9) * 2.5;
      if (yy < view.minY - 20 || yy > view.maxY + 20) continue;
      ctx.globalAlpha = 0.05 + 0.11 * k;
      ctx.lineWidth = 0.8 + 1.5 * k;
      ctx.beginPath();
      for (let x = x0, first = true; x < x1; x += 36, first = false) {
        const off = Math.sin(x * 0.010 + t * 1.3 + i * 0.6) * (1.5 + 4 * k);
        if (first) ctx.moveTo(x, yy + off); else ctx.lineTo(x, yy + off);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.save();
    ctx.clip(this.shallowPath);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#4fbcc0';
    ctx.fillRect(x0, this.shoreY - 2600, x1 - x0, 2640);
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.save();
    ctx.lineCap = 'round';
    for (const pass of [[9, 0.16, '#bfe8f5'], [3.4, 0.5, '#f2fbff']]) {
      ctx.globalAlpha = pass[1]; ctx.strokeStyle = pass[2]; ctx.lineWidth = pass[0];
      ctx.beginPath();
      for (let i = 0; i < this.shorePts.length; i++) {
        const [x, y] = this.shorePts[i];
        const q = project(x, y, 0.03 + Math.sin(t * 2.2 + (x + y) * 0.8) * 0.035);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawFlood(ctx, sim, view) {
    const w = this.world, ts = sim.tsunami, t = sim.visTime;
    const front = ts.front;
    ctx.save();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x + y > front) continue;
        const i = w.idx(x, y);
        if (w.type[i] === T.OCEAN) continue;
        const z = w.z[i], surf = ts.level;
        if (z >= surf) continue;
        const a = project(x, y, surf);
        if (a.x < view.minX - 70 || a.x > view.maxX + 70 ||
          a.y < view.minY - 70 || a.y > view.maxY + 70) continue;
        const b = project(x + 1, y, surf), c = project(x + 1, y + 1, surf), d = project(x, y + 1, surf);
        const murk = Math.max(0.25, Math.min(0.85, (surf - z) / 6));
        const shim = 0.06 * Math.sin(t * 3 + x * 0.7 + y * 0.5);
        ctx.fillStyle = `rgba(${(38 + 26 * (1 - murk)) | 0},${(80 + 26 * (1 - murk)) | 0},${(96 + 18 * (1 - murk)) | 0},${Math.min(0.9, 0.42 + murk * 0.3 + shim)})`;
        poly(ctx, [a, b, c, d]);
      }
    }
    if (ts.advancing) {
      const crest = (dz, lw, col, al) => {
        ctx.globalAlpha = al; ctx.strokeStyle = col; ctx.lineWidth = lw;
        ctx.beginPath();
        let started = false;
        for (let x = -2; x < W + 2; x += 0.5) {
          const q = project(x, front - x, ts.level + dz
            + Math.sin(t * 5 + x * 0.9) * 0.09 + Math.sin(t * 2.3 + x * 0.31) * 0.14);
          if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      };
      crest(0.30, 26, '#17384f', 0.5);
      crest(0.62, 15, '#2f7ea0', 0.55);
      crest(0.86, 8, '#bfe9f7', 0.7);
      crest(0.99, 3.5, '#ffffff', 0.9);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawZones(ctx, sim) {
    for (const v of sim.views) {
      const c = v.plant.consequences();
      if (c.pbq < 1e-4) continue;
      const o = project(v.s.x + v.parts.reactor.x, v.s.y + v.parts.reactor.y, 0);
      ctx.save();
      ctx.setLineDash([8, 6]);
      for (const rg of [
        { r: c.exclusionR * 0.55, col: '255,70,60' },
        { r: c.exclusionR, col: '255,160,40' },
        { r: c.exclusionR * 1.9, col: '255,232,90' }
      ]) {
        const rr = rg.r * 1.6;      // km -> tiles, 1 tile ~ 625 m
        ctx.strokeStyle = `rgba(${rg.col},0.5)`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(o.x, o.y, rr * TW * 1.414, rr * TH * 1.414, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(${rg.col},0.045)`;
        ctx.fill();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // ---- screen-space labels -------------------------------------------
  // Plates are placed with the dpr transform, sat on their bottom edge above
  // the anchor, and de-collided highest priority first.
  drawLabels(ctx, sim, CW, CH) {
    if (!sim.showLabels || sim.cam.zoom < 0.7) return;
    const cam = sim.cam;
    const plates = [];
    for (const v of sim.views) {
      for (const t of v.tags()) {
        const s = cam.toScreen(t.x, t.y, t.z);
        if (s[0] < -160 || s[0] > CW + 160 || s[1] < -60 || s[1] > CH + 60) continue;
        plates.push({ ...t, sx: s[0], sy: s[1] });
      }
    }
    plates.sort((a, b) => b.prio - a.prio);
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const placed = [];
    for (const pl of plates) {
      const w = ctx.measureText(pl.text).width + 16;
      let by = pl.sy - 30;
      for (let tries = 0; tries < 14; tries++) {
        let hit = false;
        for (const q of placed) {
          if (Math.abs(q.cx - pl.sx) < (q.w + w) / 2 + 4 && Math.abs(q.by - by) < 21) { hit = true; break; }
        }
        if (!hit) break;
        by -= 21;
      }
      placed.push({ cx: pl.sx, by, w });
      const bx = pl.sx - w / 2;
      ctx.strokeStyle = pl.danger ? 'rgba(255,120,90,0.8)' : 'rgba(150,220,255,0.6)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(pl.sx, pl.sy); ctx.lineTo(pl.sx, by + 18); ctx.stroke();
      ctx.beginPath(); ctx.arc(pl.sx, pl.sy, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = pl.danger ? 'rgba(255,120,90,0.95)' : 'rgba(150,220,255,0.9)'; ctx.fill();
      ctx.fillStyle = pl.danger ? 'rgba(52,15,11,0.9)' : 'rgba(10,20,30,0.88)';
      roundRect(ctx, bx, by, w, 18, 5); ctx.fill();
      ctx.strokeStyle = pl.danger ? 'rgba(255,120,90,0.5)' : 'rgba(150,220,255,0.32)';
      roundRect(ctx, bx, by, w, 18, 5); ctx.stroke();
      ctx.fillStyle = pl.danger ? '#ffd9cf' : '#dcefff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pl.text, pl.sx, by + 9.5);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  drawCompass(ctx, CW, CH, sim) {
    const dpr = CW / (window.innerWidth || CW);
    const narrow = CW / dpr < 861;
    const R = 28 * dpr;
    const cx = (narrow ? 18 : 326) * dpr + R;
    const cy = (narrow ? 100 : 108) * dpr;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9,15,23,0.5)'; ctx.fill();
    ctx.strokeStyle = 'rgba(140,190,220,0.26)'; ctx.lineWidth = dpr; ctx.stroke();
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
    let tiles = 1;
    for (const c of [16, 8, 4, 2, 1]) {
      if (c * TW * 2 * sim.cam.zoom <= 120 * dpr) { tiles = c; break; }
    }
    const px = tiles * TW * 2 * sim.cam.zoom;
    const bx = cx - R, by = cy + R + 13 * dpr;
    ctx.strokeStyle = 'rgba(220,235,245,0.7)'; ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4 * dpr); ctx.lineTo(bx, by); ctx.lineTo(bx + px, by);
    ctx.lineTo(bx + px, by - 4 * dpr);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(`${tiles * 25} m`, bx, by + 11 * dpr);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  makeBackdrop(CW, CH, gloom, key) {
    if (!this.bgCanvas) {
      this.bgCanvas = document.createElement('canvas');
      this.vgCanvas = document.createElement('canvas');
    }
    for (const c of [this.bgCanvas, this.vgCanvas]) { c.width = CW; c.height = CH; }
    const L = (a, b) => Math.round(a + (b - a) * gloom);
    const g = this.bgCanvas.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, CH);
    sky.addColorStop(0, `rgb(${L(122, 62)},${L(176, 66)},${L(220, 76)})`);
    sky.addColorStop(0.55, `rgb(${L(176, 104)},${L(210, 98)},${L(234, 102)})`);
    sky.addColorStop(1, `rgb(${L(220, 138)},${L(230, 120)},${L(226, 110)})`);
    g.fillStyle = sky; g.fillRect(0, 0, CW, CH);
    const v = this.vgCanvas.getContext('2d');
    const rg = v.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.36,
      CW / 2, CH / 2, Math.max(CW, CH) * 0.78);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(1, `rgba(6,10,18,${0.3 + gloom * 0.2})`);
    v.fillStyle = rg; v.fillRect(0, 0, CW, CH);
    this.bgKey = key;
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
