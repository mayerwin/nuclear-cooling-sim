// ---------------------------------------------------------------------------
// world.js - terrain generation, baking, contamination + flood fields
// ---------------------------------------------------------------------------
import { TW, TH, TZ, project, P } from './iso.js?v=e81ec7791c';
import { mulberry32, fbm, clamp, lerp, smoothstep, rgb, mixRGB, pick, rnd, TAU } from '../util.js?v=e81ec7791c';

export const W = 48, H = 48;
export const T = {
  OCEAN: 0, BEACH: 1, GRASS: 2, MEADOW: 3, FOREST: 4, FARM: 5,
  ROAD: 6, GRAVEL: 7, CONCRETE: 8, RIVER: 9, ROCK: 10, DIRT: 11, PARK: 12
};

const PAL = {
  [T.BEACH]: [[214, 198, 152], [236, 224, 186]],
  [T.GRASS]: [[86, 132, 66], [122, 168, 88]],
  [T.MEADOW]: [[108, 148, 74], [148, 182, 100]],
  [T.FOREST]: [[52, 92, 52], [82, 122, 68]],
  [T.FARM]: [[142, 138, 74], [176, 168, 98]],
  [T.ROAD]: [[58, 60, 64], [82, 84, 88]],
  [T.GRAVEL]: [[136, 132, 122], [172, 168, 156]],
  [T.CONCRETE]: [[168, 170, 168], [200, 202, 198]],
  [T.ROCK]: [[112, 110, 106], [148, 146, 140]],
  [T.DIRT]: [[122, 100, 74], [156, 132, 100]],
  [T.PARK]: [[96, 146, 74], [136, 182, 96]],
  [T.RIVER]: [[36, 84, 110], [60, 118, 146]],
  [T.OCEAN]: [[22, 62, 92], [40, 96, 128]]
};

export class World {
  constructor(seed = 7) {
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.type = new Uint8Array(W * H);
    this.z = new Float32Array(W * H);
    this.contam = new Float32Array(W * H);   // Bq/m2 normalised 0..1+
    this.scorch = new Float32Array(W * H);   // blast/fire damage
    this.flood = new Float32Array(W * H);    // water depth (elev units)
    this.props = [];
    this.dirtyOverlay = true;
    this.W = W; this.H = H;
    this.generate();
  }
  idx(x, y) { return y * W + x; }
  inb(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
  tileAt(x, y) { return this.inb(x, y) ? this.type[this.idx(x, y)] : T.OCEAN; }
  zAt(x, y) { return this.inb(x, y) ? this.z[this.idx(x, y)] : 0; }

  // --- terrain -------------------------------------------------------------
  generate() {
    const R = this.rng;
    this.shore = 24;          // x+y below this is sea
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = this.idx(x, y);
        const sum = x + y;
        const diff = x - y;
        const wob = fbm(x * 0.055, y * 0.055, 3) * 4.2;
        const coast = sum - this.shore + wob;               // <0 = ocean
        // base elevation ramp inland + rolling hills
        let h = smoothstep(-2, 16, coast) * 2.2
          + Math.max(0, (sum - 62) / 30) * 3.4
          + fbm(x * 0.055 + 11, y * 0.055 - 4, 4) * 1.9;
        // river valley along diff ~ 0
        const riverWob = fbm(x * 0.08 - 20, y * 0.08 + 9, 3) * 6.0;
        const rd = Math.abs(diff + riverWob);
        const isRiver = rd < 1.9 && coast > 1.0;
        h -= smoothstep(7, 0, rd) * 1.15;

        let t;
        if (coast < 0) { t = T.OCEAN; h = 0; }
        else if (coast < 1.6) { t = T.BEACH; h = clamp(h, 0.05, 0.6); }
        else if (isRiver) { t = T.RIVER; h = Math.max(0.05, h); }
        else {
          const veg = fbm(x * 0.07 + 40, y * 0.07 + 40, 4);
          if (sum > 74 && veg > 0.02) t = T.FOREST;
          else if (veg > 0.20) t = T.FOREST;
          else if (veg < -0.16) t = T.MEADOW;
          else t = T.GRASS;
          if (h > 4.6) t = T.ROCK;
        }
        this.type[i] = t;
        this.z[i] = Math.round(clamp(h, 0, 6) * 2) / 2;
      }
    }
    this.flattenSites();
    this.carveRoads();
    this.makeFarms();
    this.placeProps();
  }

  setRect(x0, y0, w, h, type, z) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      if (!this.inb(x, y)) continue;
      const i = this.idx(x, y);
      if (type !== null) this.type[i] = type;
      if (z !== undefined) this.z[i] = z;
    }
  }

  flattenSites() {
    // two symmetric plant platforms straddling the river
    this.sites = {
      active: { x: 6, y: 21, w: 14, h: 14, z: 1.5 },
      passive: { x: 21, y: 6, w: 14, h: 14, z: 1.5 }
    };
    for (const k in this.sites) {
      const s = this.sites[k];
      for (let y = s.y - 2; y < s.y + s.h + 2; y++)
        for (let x = s.x - 2; x < s.x + s.w + 2; x++) {
          if (!this.inb(x, y)) continue;
          const i = this.idx(x, y);
          if (this.type[i] === T.OCEAN) continue;
          const inCore = x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h;
          this.z[i] = inCore ? s.z : lerp(this.z[i], s.z, 0.55);
          if (inCore && this.type[i] !== T.RIVER) this.type[i] = T.GRAVEL;
        }
    }
  }

  carveRoads() {
    // coastal highway following constant x+y, plus spurs to each site
    const road = (pts, wdt = 1) => {
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
        const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
        for (let s = 0; s <= n; s++) {
          const x = Math.round(lerp(ax, bx, s / n)), y = Math.round(lerp(ay, by, s / n));
          for (let dy = 0; dy < wdt; dy++) for (let dx = 0; dx < wdt; dx++) {
            if (!this.inb(x + dx, y + dy)) continue;
            const i = this.idx(x + dx, y + dy);
            if (this.type[i] === T.OCEAN || this.type[i] === T.RIVER) continue;
            this.type[i] = T.ROAD;
          }
        }
      }
    };
    road([[2, 42], [10, 38], [18, 32], [26, 24], [34, 16], [42, 8], [46, 2]], 1);
    road([[24, 26], [28, 31], [31, 36], [33, 42]], 1);  // to town
    road([[19, 30], [22, 28], [24, 27]], 1);            // active site spur
    road([[30, 19], [28, 22], [26, 25]], 1);            // passive site spur
    this.town = { x: 26, y: 31, w: 14, h: 13 };
  }

  makeFarms() {
    const R = this.rng;
    for (let f = 0; f < 9; f++) {
      const cx = 6 + Math.floor(R() * 40), cy = 6 + Math.floor(R() * 42);
      const w = 4 + Math.floor(R() * 6), h = 4 + Math.floor(R() * 6);
      let ok = true;
      for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) {
        if (!this.inb(x, y)) { ok = false; continue; }
        const t = this.type[this.idx(x, y)];
        if (t === T.OCEAN || t === T.RIVER || t === T.ROAD || t === T.GRAVEL || t === T.ROCK) ok = false;
      }
      if (!ok) continue;
      for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++)
        this.type[this.idx(x, y)] = T.FARM;
    }
  }

  // --- props ---------------------------------------------------------------
  inSite(x, y, pad = 3) {
    for (const k in this.sites) {
      const s = this.sites[k];
      if (x >= s.x - pad && y >= s.y - pad && x < s.x + s.w + pad && y < s.y + s.h + pad) return true;
    }
    return false;
  }

  placeProps() {
    const R = this.rng;
    const occupied = new Set();
    const key = (x, y) => y * W + x;
    // trees on forest / meadow
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = this.type[this.idx(x, y)];
      if (this.inSite(x, y)) continue;
      const dense = t === T.FOREST ? 0.62 : t === T.MEADOW ? 0.10 : t === T.GRASS ? 0.05 : 0;
      if (dense && R() < dense) {
        // keep plant yards clear
        this.props.push({
          type: 'tree', gx: x, gy: y,
          x: x + 0.2 + R() * 0.6, y: y + 0.2 + R() * 0.6,
          z: this.z[this.idx(x, y)], s: 0.72 + R() * 0.66,
          conifer: R() < (t === T.FOREST ? 0.55 : 0.2), hp: 1, burn: 0
        });
        occupied.add(key(x, y));
      }
    }
    // town houses
    const tw = this.town;
    for (let y = tw.y; y < tw.y + tw.h; y++) for (let x = tw.x; x < tw.x + tw.w; x++) {
      if (!this.inb(x, y)) continue;
      const i = this.idx(x, y);
      const t = this.type[i];
      if (t === T.OCEAN || t === T.RIVER || t === T.ROAD || t === T.ROCK) continue;
      // one road in four, not one in three, and the rest gets gardens
      if ((x + y) % 4 === 0) { this.type[i] = T.ROAD; continue; }
      if ((x * 3 + y) % 7 === 0) { this.type[i] = T.PARK; continue; }
      if (R() < 0.62) {
        this.type[i] = T.PARK;
        this.props.push({
          type: 'house', gx: x, gy: y, x: x + 0.12, y: y + 0.12, z: this.z[i],
          w: 0.76, d: 0.76, h: 0.85 + R() * 1.2,
          tall: R() < 0.22, hp: 1, burn: 0
        });
      }
    }
    // scattered rural homes + barns
    for (let n = 0; n < 26; n++) {
      const x = 4 + Math.floor(R() * 44), y = 4 + Math.floor(R() * 44);
      if (!this.inb(x, y)) continue;
      const i = this.idx(x, y);
      const t = this.type[i];
      if (t !== T.GRASS && t !== T.MEADOW && t !== T.FARM) continue;
      if (this.inSite(x, y)) continue;
      this.props.push({
        type: 'house', gx: x, gy: y, x: x + 0.15, y: y + 0.15, z: this.z[i],
        w: 0.72, d: 0.72, h: 0.8 + R() * 0.6, barn: R() < 0.45, hp: 1, burn: 0
      });
    }
    // farm silos
    for (let n = 0; n < 10; n++) {
      const x = 4 + Math.floor(R() * 40), y = 4 + Math.floor(R() * 40);
      if (!this.inb(x, y) || this.inSite(x, y)) continue;
      if (this.type[this.idx(x, y)] !== T.FARM) continue;
      this.props.push({ type: 'silo', gx: x, gy: y, x: x + 0.5, y: y + 0.5, z: this.zAt(x, y), hp: 1, burn: 0 });
    }
    // fishing boats
    for (let n = 0; n < 7; n++) {
      const s = 4 + R() * 14;
      const d = (R() - 0.5) * 34;
      const x = (s + d) / 2, y = (s - d) / 2;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      this.props.push({ type: 'boat', gx: x | 0, gy: y | 0, x, y, z: 0, hp: 1, burn: 0 });
    }
    // road-side lamp posts near town
    for (let n = 0; n < 40; n++) {
      const x = Math.floor(R() * W), y = Math.floor(R() * H);
      if (this.tileAt(x, y) !== T.ROAD) continue;
      this.props.push({ type: 'lamp', gx: x, gy: y, x: x + 0.5, y: y + 0.5, z: this.zAt(x, y), hp: 1, burn: 0 });
    }
  }

  // --- deposition ----------------------------------------------------------
  deposit(x, y, amount) {
    if (!this.inb(x | 0, y | 0)) return;
    const i = this.idx(x | 0, y | 0);
    const before = this.contam[i];
    this.contam[i] = Math.min(3.0, before + amount);
    this.hasOverlay = true;
    // only force a re-bake when the change is actually visible
    this.contamAcc = (this.contamAcc || 0) + (this.contam[i] - before);
    if (this.contamAcc > 0.35) { this.contamAcc = 0; this.dirtyOverlay = true; }
  }
  blast(cx, cy, radius, power) {
    this.hasOverlay = true;
    for (let y = Math.max(0, cy - radius | 0); y < Math.min(H, cy + radius + 1); y++)
      for (let x = Math.max(0, cx - radius | 0); x < Math.min(W, cx + radius + 1); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius) continue;
        const f = (1 - d / radius) * power;
        const i = this.idx(x, y);
        this.scorch[i] = Math.min(1, this.scorch[i] + f);
      }
    for (const p of this.props) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (d < radius) {
        const f = (1 - d / radius) * power;
        p.hp = Math.max(0, p.hp - f * 1.4);
        if (p.hp <= 0.35) p.burn = Math.max(p.burn, Math.min(1, f));
      }
    }
    this.dirtyOverlay = true;
  }

  // --- baking --------------------------------------------------------------
  bounds() {
    const xs = [], ys = [];
    for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H]]) {
      const p = P(x, y, 0); xs.push(p[0]); ys.push(p[1]);
    }
    const minX = Math.min(...xs) - 8, maxX = Math.max(...xs) + 8;
    const minY = Math.min(...ys) - 7 * TZ - 8, maxY = Math.max(...ys) + 8;
    return { minX, minY, w: maxX - minX, h: maxY - minY };
  }

  bakeTerrain(makePatterns) {
    const b = this.bounds();
    this.bakeBox = b;
    const c = document.createElement('canvas');
    c.width = Math.ceil(b.w); c.height = Math.ceil(b.h);
    const g = c.getContext('2d');
    g.translate(-b.minX, -b.minY);
    const R = mulberry32(4242);

    // draw back-to-front
    for (let s = 0; s <= W + H; s++) {
      for (let x = Math.max(0, s - H + 1); x < Math.min(W, s + 1); x++) {
        const y = s - x;
        if (y < 0 || y >= H) continue;
        this.drawTile(g, x, y, R);
      }
    }
    this.terrainCanvas = c;
    return c;
  }

  drawTile(g, x, y, R) {
    const i = this.idx(x, y);
    const t = this.type[i], z = this.z[i];
    if (t === T.OCEAN) return;                       // ocean drawn dynamically
    const pal = PAL[t] || PAL[T.GRASS];
    const n = fbm(x * 0.35, y * 0.35, 3) * 0.5 + 0.5;
    const base = mixRGB(pal[0], pal[1], n);
    const a = P(x, y, z), b = P(x + 1, y, z), c2 = P(x + 1, y + 1, z), d = P(x, y + 1, z);

    // cliff faces where neighbours are lower
    const zr = this.inb(x + 1, y) ? this.z[this.idx(x + 1, y)] : 0;
    const zd = this.inb(x, y + 1) ? this.z[this.idx(x, y + 1)] : 0;
    const cliff = (p1, p2, drop, k) => {
      if (drop <= 0.01) return;
      const q1 = [p1[0], p1[1] + drop * TZ], q2 = [p2[0], p2[1] + drop * TZ];
      g.beginPath();
      g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.lineTo(q2[0], q2[1]); g.lineTo(q1[0], q1[1]);
      g.closePath();
      const isRock = t === T.ROCK || drop > 1.2;
      const cc = isRock ? [118, 112, 104] : [104, 84, 58];
      g.fillStyle = rgb([cc[0] * k, cc[1] * k, cc[2] * k]);
      g.fill();
      // striations
      g.globalAlpha = 0.18;
      for (let s = 0.2; s < 1; s += 0.22) {
        g.strokeStyle = '#2b2118'; g.lineWidth = 1;
        g.beginPath();
        g.moveTo(p1[0], p1[1] + drop * TZ * s); g.lineTo(p2[0], p2[1] + drop * TZ * s); g.stroke();
      }
      g.globalAlpha = 1;
    };
    cliff(b, c2, z - zr, 0.62);
    cliff(c2, d, z - zd, 0.78);

    // top diamond
    g.beginPath();
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c2[0], c2[1]); g.lineTo(d[0], d[1]);
    g.closePath();
    g.fillStyle = rgb(base);
    g.fill();

    // per-type detailing
    g.save(); g.clip();
    const cx = (a[0] + c2[0]) / 2, cy = (a[1] + c2[1]) / 2;
    if (t === T.GRASS || t === T.MEADOW || t === T.PARK || t === T.FOREST) {
      for (let k = 0; k < 16; k++) {
        const px = cx + (R() - 0.5) * TW * 0.8, py = cy + (R() - 0.5) * TH * 0.8;
        g.strokeStyle = rgb(mixRGB(base, [230, 245, 180], 0.35), 0.35 + R() * 0.3);
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + (R() - 0.5) * 2, py - 2 - R() * 2); g.stroke();
      }
    } else if (t === T.FARM) {
      g.globalAlpha = 0.35;
      const dir = ((x * 7 + y * 3) % 2) === 0;
      for (let k = -4; k <= 4; k++) {
        g.strokeStyle = rgb(mixRGB(base, [90, 70, 40], 0.5));
        g.lineWidth = 1.4;
        g.beginPath();
        if (dir) { g.moveTo(a[0] + k * 4, a[1] + Math.abs(k) * 2); g.lineTo(c2[0] + k * 4, c2[1] - Math.abs(k) * 2); }
        else { g.moveTo(b[0] + k * 4, b[1] + Math.abs(k) * 2); g.lineTo(d[0] + k * 4, d[1] - Math.abs(k) * 2); }
        g.stroke();
      }
      g.globalAlpha = 1;
    } else if (t === T.ROAD) {
      g.globalAlpha = 0.5;
      for (let k = 0; k < 26; k++) {
        g.fillStyle = R() > 0.5 ? '#9aa2aa' : '#25272b';
        g.fillRect(cx + (R() - 0.5) * TW * 0.9, cy + (R() - 0.5) * TH * 0.9, 1.4, 1.2);
      }
      g.globalAlpha = 1;
    } else if (t === T.GRAVEL || t === T.CONCRETE) {
      g.globalAlpha = 0.45;
      for (let k = 0; k < 30; k++) {
        g.fillStyle = R() > 0.5 ? '#e2ded2' : '#5f5c55';
        g.fillRect(cx + (R() - 0.5) * TW * 0.9, cy + (R() - 0.5) * TH * 0.9, 1.6, 1.4);
      }
      g.globalAlpha = 1;
    } else if (t === T.BEACH) {
      g.globalAlpha = 0.4;
      for (let k = 0; k < 22; k++) {
        g.fillStyle = R() > 0.5 ? '#fff6dc' : '#c2ab7e';
        g.fillRect(cx + (R() - 0.5) * TW * 0.9, cy + (R() - 0.5) * TH * 0.9, 1.3, 1.1);
      }
      g.globalAlpha = 1;
    } else if (t === T.RIVER) {
      // continuous ripples that ignore the tile grid, so the water reads as
      // one moving body rather than a row of diamonds
      g.globalAlpha = 0.5;
      for (let k = 0; k < 5; k++) {
        const ph = fbm(x * 0.6 + k * 3.1, y * 0.6 - k * 1.7, 2);
        g.strokeStyle = k % 2 ? 'rgba(150,206,228,0.5)' : 'rgba(18,58,88,0.45)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(a[0] + 3, a[1] + (k + 0.5) * (TH * 2 / 5) + ph * 3);
        g.lineTo(c2[0] - 3, c2[1] - (4.5 - k) * (TH * 2 / 5) + ph * 3);
        g.stroke();
      }
      g.globalAlpha = 1;
    } else if (t === T.ROCK) {
      g.globalAlpha = 0.35;
      for (let k = 0; k < 8; k++) {
        g.fillStyle = R() > 0.5 ? '#c9c6bd' : '#5c5a55';
        const s = 2 + R() * 4;
        g.fillRect(cx + (R() - 0.5) * TW * 0.8, cy + (R() - 0.5) * TH * 0.8, s, s * 0.6);
      }
      g.globalAlpha = 1;
    }
    g.restore();

    // subtle tile seam for readability
    g.strokeStyle = 'rgba(0,0,0,0.06)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c2[0], c2[1]); g.lineTo(d[0], d[1]);
    g.closePath(); g.stroke();
  }

  // contamination + scorch overlay, re-baked lazily
  bakeOverlay() {
    if (!this.overlayCanvas) {
      const b = this.bakeBox;
      const c = document.createElement('canvas');
      c.width = this.terrainCanvas.width; c.height = this.terrainCanvas.height;
      this.overlayCanvas = c;
      this.overlayCtx = c.getContext('2d');
      this.overlayCtx.translate(-b.minX, -b.minY);
    }
    const g = this.overlayCtx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    g.restore();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = this.idx(x, y);
      const cm = this.contam[i], sc = this.scorch[i];
      if (cm < 0.01 && sc < 0.01) continue;
      if (this.type[i] === T.OCEAN) continue;
      const z = this.z[i];
      const a = P(x, y, z), b = P(x + 1, y, z), c2 = P(x + 1, y + 1, z), d = P(x, y + 1, z);
      g.beginPath();
      g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c2[0], c2[1]); g.lineTo(d[0], d[1]);
      g.closePath();
      if (sc > 0.01) {
        g.fillStyle = `rgba(${30 + 20 * (1 - sc) | 0},${24 + 16 * (1 - sc) | 0},${20 + 12 * (1 - sc) | 0},${Math.min(0.92, sc)})`;
        g.fill();
      }
      const fl = this.flood[i];
      if (fl > 0.02) {
        g.fillStyle = `rgba(52,84,96,${Math.min(0.62, 0.24 + fl * 0.32)})`;
        g.fill();
        g.strokeStyle = 'rgba(150,196,214,0.35)'; g.lineWidth = 1;
        g.stroke();
      }
      if (cm > 0.01) {
        // yellowed, dying vegetation, then a dusty caesium sheen on top
        const t = Math.min(1, cm / 1.2);
        g.fillStyle = `rgba(${152 + 60 * t | 0},${164 + 54 * t | 0},${54 * (1 - t) + 22 | 0},${0.34 + 0.5 * t})`;
        g.fill();
        if (t > 0.55) {
          g.save(); g.clip();
          g.globalAlpha = (t - 0.55) * 0.9;
          g.strokeStyle = '#e8ff8a'; g.lineWidth = 1;
          const cx2 = (a[0] + c2[0]) / 2, cy2 = (a[1] + c2[1]) / 2;
          for (let k = -2; k <= 2; k++) {
            g.beginPath();
            g.moveTo(cx2 - 26 + k * 9, cy2 - 12);
            g.lineTo(cx2 + 6 + k * 9, cy2 + 12);
            g.stroke();
          }
          g.globalAlpha = 1;
          g.restore();
        }
      }
    }
    this.dirtyOverlay = false;
  }
}
