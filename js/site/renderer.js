// ---------------------------------------------------------------------------
// renderer.js - site view composition.
//
// Order is: sky, ocean, terrain, ground overlays, THE ONE SORTED PASS,
// tsunami wash, particles, then screen-space labels and HUD. Flat things that
// can never occlude are painted before the pass; anything with a footprint
// goes into it, keyed on x + y (+ half its footprint for a box).
// ---------------------------------------------------------------------------
import { W, H, T } from './world.js?v=f4ed110be1';
import { project, unproject, TW, TH, TZ, poly, polyLine, shade, rgba } from './iso.js?v=f4ed110be1';
import { drawProp, propKey } from './props.js?v=f4ed110be1';

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
    return this.drawSite(sim);
  }

  // In the cutaway the WebGL stage owns the screen; this canvas is hidden by
  // CSS, so there is nothing to paint here but the key.
  drawSite(sim) {
    const ctx = this.ctx, cam = sim.cam, w = this.world;
    const CW = this.canvas.width, CH = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const gloom = Math.max(0, Math.min(1, sim.gloom));
    const key = `${CW}x${CH}x${Math.round(gloom * 24)}`;
    if (this.bgKey !== key) this.makeBackdrop(CW, CH, gloom, key);
    // The sky IS the clear. It used to be blitted from an offscreen canvas,
    // and that is the whole frame's only clear: if the browser drops that
    // bitmap - which a phone under memory pressure does, with forty tabs open
    // it does it readily - nothing wipes the canvas. The ground is repainted
    // by the terrain blit, so it stays crisp, but every tree and every roof
    // draws ABOVE the ground line into pixels nobody cleared, and panning
    // smears them upward into long vertical trails. A gradient fill cannot be
    // dropped, costs one fill, and cannot fail.
    ctx.fillStyle = this.sky;
    ctx.fillRect(0, 0, CW, CH);

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
    if (this.vignette) { ctx.fillStyle = this.vignette; ctx.fillRect(0, 0, CW, CH); }
    if (sim.whiteout > 0.01) {
      ctx.fillStyle = `rgba(255,250,235,${Math.min(0.85, sim.whiteout)})`;
      ctx.fillRect(0, 0, CW, CH);
    }
    this.drawUnitBanners(ctx, sim, CW, CH);
    this.drawZoneLabels(ctx, sim, CW, CH);
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
    for (let i = 0; i < 64; i++) {
      const k = i / 64;
      // irregular spacing and length: evenly spaced parallel lines read as
      // corduroy, not water
      const jig = Math.sin(i * 2.399) * 0.5 + Math.sin(i * 5.71) * 0.3;
      const yy = this.shoreY - 1000 + Math.pow(k, 1.6) * 1010 + jig * 9
        + Math.sin(t * 0.7 + i * 0.9) * 2.5;
      if (yy < view.minY - 20 || yy > view.maxY + 20) continue;
      ctx.globalAlpha = (0.04 + 0.10 * k) * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.31)));
      ctx.lineWidth = 0.8 + 1.4 * k;
      const seg = 260 + 520 * Math.abs(Math.sin(i * 0.77));
      const start = x0 + ((i * 317) % Math.max(1, x1 - x0));
      ctx.beginPath();
      for (let x = start, first = true; x < Math.min(x1, start + seg); x += 34, first = false) {
        const off = Math.sin(x * 0.010 + t * 1.3 + i * 0.6) * (1.5 + 4 * k);
        if (first) ctx.moveTo(x, yy + off); else ctx.lineTo(x, yy + off);
      }
      ctx.stroke();
      if (start + seg > x1) {
        ctx.beginPath();
        for (let x = x0, first = true; x < x0 + (start + seg - x1); x += 34, first = false) {
          const off = Math.sin(x * 0.010 + t * 1.3 + i * 0.6) * (1.5 + 4 * k);
          if (first) ctx.moveTo(x, yy + off); else ctx.lineTo(x, yy + off);
        }
        ctx.stroke();
      }
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
      ctx.setLineDash([9 / Math.max(0.4, sim.cam.zoom), 7 / Math.max(0.4, sim.cam.zoom)]);
      for (const rg of [
        { r: c.exclusionR * 0.55, col: '255,70,60' },
        { r: c.exclusionR, col: '255,160,40' },
        { r: c.exclusionR * 1.9, col: '255,232,90' }
      ]) {
        // NOT to scale, and it cannot be: a tile is 25 m, so the whole island
        // is 1.2 km across and a 20 km ring would be four hundred tiles wide.
        // The rings say "it reaches outward, well past the fence"; the radius
        // that goes with each one is written in the key, not measured here.
        const rr = rg.r * 1.6;
        ctx.strokeStyle = `rgba(${rg.col},0.75)`;
        ctx.lineWidth = 3 / Math.max(0.4, sim.cam.zoom);
        ctx.beginPath();
        ctx.ellipse(o.x, o.y, rr * TW * 1.414, rr * TH * 1.414, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(${rg.col},0.085)`;
        ctx.fill();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // ---- unit banners ---------------------------------------------------
  // Always drawn, at every zoom, because "which one is which" is the question
  // the whole page exists to answer. The equipment plates below come and go
  // with the zoom; these two do not.
  drawUnitBanners(ctx, sim, CW, CH) {
    const cam = sim.cam;
    const dpr = CW / (window.innerWidth || CW);
    const cw = CW / dpr, ch = CH / dpr;
    const narrow = cw < 861;
    const padL = narrow ? 6 : 316, padR = narrow ? 6 : 342;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const TONE = { ok: ['#63e08a', 'rgba(10,44,28,.92)'], warn: ['#ffc44d', 'rgba(52,38,8,.92)'],
      crit: ['#ff8b72', 'rgba(56,14,10,.94)'] };
    this._bannerRects = [];
    for (const v of sim.views) {
      const b = v.banner();
      const sc = cam.toScreen(b.x, b.y, b.z);
      const sx = sc[0] / dpr, sy = sc[1] / dpr;
      if (sx < padL - 90 || sx > cw - padR + 90 || sy < -30 || sy > ch - 40) continue;
      const accent = b.passive ? '#57d9ff' : '#ff8b5c';
      // On a phone two full banners do not fit side by side, so they lose the
      // subtitle rather than landing on top of each other.
      const title = narrow ? b.title.split(' ')[0] : b.title;
      ctx.font = `800 ${narrow ? 12 : 13}px ui-sans-serif, system-ui, sans-serif`;
      const wT = ctx.measureText(title).width;
      ctx.font = '700 10.5px ui-sans-serif, system-ui, sans-serif';
      const wS = narrow ? 0 : ctx.measureText(b.sub).width;
      ctx.font = `800 ${narrow ? 10 : 11}px ui-sans-serif, system-ui, sans-serif`;
      const wV = ctx.measureText(b.state).width;
      const w = Math.max(wT, wS, wV) + (narrow ? 22 : 26), h = narrow ? 38 : 54;
      let x = Math.max(padL, Math.min(cw - padR - w, sx - w / 2));
      let y = Math.max(46, sy - h - 8);
      // the wind rose owns the top-left corner; slide out from under it
      if (!narrow && y < 182 && x < padL + 96) x = Math.min(cw - padR - w, padL + 96);
      // and two banners never sit on top of each other
      for (let i = 0; i < 4; i++) {
        const hit = this._bannerRects.some(r =>
          Math.abs(r.cx - (x + w / 2)) < (r.w + w) / 2 + 6 && Math.abs(r.by - y) < Math.max(r.h, h));
        if (!hit) break;
        y += h + 6;
      }
      this._bannerRects.push({ cx: x + w / 2, by: y, w, h });
      ctx.fillStyle = 'rgba(8,14,21,.9)';
      roundRect(ctx, x, y, w, h, 8); ctx.fill();
      ctx.strokeStyle = accent + '66'; ctx.lineWidth = 1.2;
      roundRect(ctx, x, y, w, h, 8); ctx.stroke();
      ctx.fillStyle = accent;
      roundRect(ctx, x, y + 6, 3, h - 12, 1.5); ctx.fill();
      ctx.textAlign = 'left';
      ctx.font = `800 ${narrow ? 12 : 13}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = accent;
      ctx.fillText(title, x + (narrow ? 11 : 13), y + (narrow ? 15 : 17));
      if (!narrow) {
        ctx.font = '700 10.5px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(160,186,205,.95)';
        ctx.fillText(b.sub, x + 13, y + 31);
      }
      const [fg, bg] = TONE[b.tone] || TONE.crit;
      ctx.font = `800 ${narrow ? 10 : 11}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = bg;
      roundRect(ctx, x + (narrow ? 9 : 11), y + (narrow ? 20 : 36), wV + 14, 15, 4); ctx.fill();
      ctx.fillStyle = fg;
      ctx.fillText(b.state, x + (narrow ? 16 : 18), y + (narrow ? 31 : 47));
      ctx.textAlign = 'start';
      // a hairline down to the building it names
      if (sy > y + h) {
        ctx.strokeStyle = accent + '55'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(sx, y + h); ctx.lineTo(sx, sy); ctx.stroke();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- what the rings mean --------------------------------------------
  // Three dashed ovals with no words are decoration. With a radius and a
  // consequence on each they are the part of the picture people actually came
  // to ask about.
  drawZoneLabels(ctx, sim, CW, CH) {
    const cam = sim.cam;
    const dpr = CW / (window.innerWidth || CW);
    const cw = CW / dpr, ch = CH / dpr;
    const narrow = cw < 861;
    const padL = narrow ? 6 : 316, padR = narrow ? 6 : 342;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
    // The outer rings usually run off the island, so the same three numbers get
    // a fixed key as well: the consequence is the part people came to ask
    // about, and it should never be off-screen.
    const worst = sim.views
      .map(v => v.plant.consequences()).sort((a, b) => b.pbq - a.pbq)[0];
    if (worst && worst.pbq >= 1e-4) {
      const rows = [
        [worst.exclusionR * 0.55, '255,70,60', 'emptied for good'],
        [worst.exclusionR, '255,160,40', 'evacuated'],
        [worst.exclusionR * 1.9, '255,232,90', 'stay indoors']
      ].map(([km, col, what]) =>
        [`${km < 10 ? km.toFixed(1) : Math.round(km)} km`, what, col]);
      ctx.font = '800 10px ui-sans-serif, system-ui, sans-serif';
      let wn = 0;
      for (const r of rows) wn = Math.max(wn, ctx.measureText(r[0]).width);
      ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
      let wd = 0;
      for (const r of rows) wd = Math.max(wd, ctx.measureText(r[1]).width);
      ctx.font = '800 9px ui-sans-serif, system-ui, sans-serif';
      const wh = ctx.measureText('AREA AFFECTED  ·  RINGS NOT TO SCALE').width;
      const w = Math.max(25 + wn + 10 + wd + 12, wh + 22), h = 16 + rows.length * 15 + 8;
      const x = padL + 8, y = 190;
      ctx.fillStyle = 'rgba(8,14,21,.82)';
      roundRect(ctx, x, y, w, h, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(120,170,210,.16)'; ctx.lineWidth = 1;
      roundRect(ctx, x, y, w, h, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(150,172,190,.9)';
      ctx.font = '800 9px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('AREA AFFECTED  ·  RINGS NOT TO SCALE', x + 11, y + 14);
      rows.forEach((r, i) => {
        const ry = y + 28 + i * 15;
        ctx.fillStyle = `rgba(${r[2]},0.95)`;
        ctx.fillRect(x + 11, ry - 7, 8, 8);
        ctx.font = '800 10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(r[0], x + 25, ry);
        ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(200,216,230,.88)';
        ctx.fillText(r[1], x + 25 + wn + 10, ry);
      });
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- screen-space labels -------------------------------------------
  // Plates are placed with the dpr transform, sat on their bottom edge above
  // the anchor, and de-collided highest priority first.
  // Plates are screen-space, but they must be placed with the DPR transform,
  // not the identity one: cam.toScreen returns device pixels, and drawing an
  // 11px font into those on a 2x display renders every label at half size.
  drawLabels(ctx, sim, CW, CH) {
    if (!sim.showLabels) return;
    const cam = sim.cam;
    const dpr = CW / (window.innerWidth || CW);
    const cw = CW / dpr, ch = CH / dpr;
    // keep plates clear of the side panels rather than sliding under them
    const narrow = cw < 861;
    // On a phone the whole site is about one plate wide, so the captions only
    // earn their space once the reader has actually zoomed into a station.
    if (cam.zoom < (narrow ? 1.15 : 0.7)) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = narrow ? 8 : 318, padR = narrow ? 8 : 344;
    const plates = [];
    for (const v of sim.views) {
      for (const t of v.tags()) {
        const s = cam.toScreen(t.x, t.y, t.z);
        const sx = s[0] / dpr, sy = s[1] / dpr;
        if (sx < padL - 40 || sx > cw - padR + 40 || sy < 40 || sy > ch - 60) continue;
        plates.push({ ...t, sx, sy });
      }
    }
    plates.sort((a, b) => b.prio - a.prio);
    if (narrow) plates.length = Math.min(plates.length, 5);
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    // Seeded with the unit banners, which are already on screen and outrank
    // every equipment plate.
    const placed = (this._bannerRects || []).map(r => ({ ...r, seed: true }));
    for (const pl of plates) {
      const w = ctx.measureText(pl.text).width + 16;
      // The anchor is where the thing *is*; the plate goes wherever it fits.
      // Keeping the two apart, and joining them with an elbow, is the only way
      // the caption still points at the right building once it has been moved.
      const ax = pl.sx, ay = pl.sy;
      let cx = Math.max(padL + w / 2, Math.min(cw - padR - w / 2, ax));
      let by = ay - 30;
      for (let tries = 0; tries < 22; tries++) {
        let hit = false;
        for (const q of placed) {
          if (Math.abs(q.cx - cx) < (q.w + w) / 2 + 6
            && by < q.by + (q.h || 18) + 3 && q.by < by + 21) { hit = true; break; }
        }
        if (!hit) break;
        by -= 21;
      }
      placed.push({ cx, by, w, h: 18, ax, ay, text: pl.text, danger: pl.danger });
    }
    // leaders first, plates second, so a leader can never be drawn across the
    // face of a caption
    for (const q of placed) {
      if (q.seed) continue;
      ctx.strokeStyle = q.danger ? 'rgba(255,120,90,0.75)' : 'rgba(150,220,255,0.55)';
      ctx.lineWidth = 1.2;
      const bx = q.cx - q.w / 2, mid = q.by + 9;
      ctx.beginPath();
      if (q.ax > bx - 4 && q.ax < bx + q.w + 4) {
        ctx.moveTo(q.ax, q.ay); ctx.lineTo(q.ax, q.by + 18);
      } else {
        const edge = q.ax < bx ? bx : bx + q.w;
        ctx.moveTo(q.ax, q.ay); ctx.lineTo(q.ax, mid); ctx.lineTo(edge, mid);
      }
      ctx.stroke();
      ctx.beginPath(); ctx.arc(q.ax, q.ay, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = q.danger ? 'rgba(255,120,90,0.95)' : 'rgba(150,220,255,0.9)';
      ctx.fill();
    }
    for (const q of placed) {
      if (q.seed) continue;
      const bx = q.cx - q.w / 2;
      ctx.fillStyle = q.danger ? 'rgba(52,15,11,0.94)' : 'rgba(10,20,30,0.92)';
      roundRect(ctx, bx, q.by, q.w, 18, 5); ctx.fill();
      ctx.strokeStyle = q.danger ? 'rgba(255,120,90,0.5)' : 'rgba(150,220,255,0.32)';
      ctx.lineWidth = 1.2;
      roundRect(ctx, bx, q.by, q.w, 18, 5); ctx.stroke();
      ctx.fillStyle = q.danger ? '#ffd9cf' : '#dcefff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(q.text, q.cx, q.by + 9.5);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawCompass(ctx, CW, CH, sim) {
    const dpr = CW / (window.innerWidth || CW);
    const narrow = CW / dpr < 861;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = 28;
    const cx = (narrow ? 18 : 326) + R;
    // Below whatever the toolbar actually is. On a phone it wraps to three
    // rows, and a fixed 100 px put the dial behind it.
    const cy = (narrow ? Math.max(100, (this.topInset || 0) + 46) : 108);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9,15,23,0.5)'; ctx.fill();
    ctx.strokeStyle = 'rgba(140,190,220,0.26)'; ctx.lineWidth = 1; ctx.stroke();
    const th = (sim.fx.windDeg || 0) * Math.PI / 180;
    const ax = Math.sin(th), ay = -Math.cos(th);
    ctx.strokeStyle = '#57d9ff'; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
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
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('WIND', cx, cy - R - 5);
    let tiles = 1;
    for (const c of [16, 8, 4, 2, 1]) {
      if (c * TW * 2 * sim.cam.zoom / dpr <= 120) { tiles = c; break; }
    }
    const px = tiles * TW * 2 * sim.cam.zoom / dpr;
    const bx = cx - R, by = cy + R + 13;
    ctx.strokeStyle = 'rgba(220,235,245,0.7)'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + px, by);
    ctx.lineTo(bx + px, by - 4);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(`${tiles * 25} m`, bx, by + 11);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'left';
  }

  // Two gradient objects, not two bitmaps. They belong to this context, they
  // are rebuilt only when the size or the light changes, and there is nothing
  // in them for the browser to reclaim.
  makeBackdrop(CW, CH, gloom, key) {
    const ctx = this.ctx;
    const L = (a, b) => Math.round(a + (b - a) * gloom);
    const sky = ctx.createLinearGradient(0, 0, 0, CH);
    sky.addColorStop(0, `rgb(${L(122, 62)},${L(176, 66)},${L(220, 76)})`);
    sky.addColorStop(0.55, `rgb(${L(176, 104)},${L(210, 98)},${L(234, 102)})`);
    sky.addColorStop(1, `rgb(${L(220, 138)},${L(230, 120)},${L(226, 110)})`);
    this.sky = sky;
    const rg = ctx.createRadialGradient(CW / 2, CH / 2, Math.min(CW, CH) * 0.36,
      CW / 2, CH / 2, Math.max(CW, CH) * 0.78);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(1, `rgba(6,10,18,${0.3 + gloom * 0.2})`);
    this.vignette = rg;
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
