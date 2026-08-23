// ---------------------------------------------------------------------------
// plantview.js - the two stations as they appear on the site map.
//
// Every structure is emitted into the renderer's single sorted list as its own
// piece with its own depth key, so nothing can draw on the wrong side of
// anything else. Nothing is cached in a layer, so nothing pops.
// ---------------------------------------------------------------------------
import {
  project, box, prism, cylinder, revolve, coolingTower, dome, cone, pylon,
  shadow, shade, rgba, mix, hash2, poly, polyLine, TW, TH, TZ, EDGE
} from './iso.js';
import { MODE } from './plant.js';

const CONCRETE = '#cfccc2';
const CONCRETE_D = '#a9a69c';
const SHELL = '#dfe2e2';
const HALL = '#b9c3c9';
const ROOF = '#5d7a8c';
const ROOF_G = '#6f8474';
const STEEL = '#c2c8cc';
const MACHINE = '#8d959b';
const TOWER = '#c6c2b6';
const TARMAC = '#6d6f73';

function gableLow(ctx, x, y, z, w, d, h, c) {
  const my = y + d / 2, tz = z + h;
  const A = project(x, y, z), B = project(x + w, y, z);
  const C = project(x + w, y + d, z), D = project(x, y + d, z);
  const R1 = project(x, my, tz), R2 = project(x + w, my, tz);
  ctx.fillStyle = shade(c, 1.05); poly(ctx, [A, B, R2, R1]);
  ctx.fillStyle = shade(c, 0.86); poly(ctx, [B, R2, C]);
  ctx.fillStyle = shade(c, 0.76); poly(ctx, [D, C, R2, R1]);
  ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.lineJoin = 'round';
  polyLine(ctx, [A, B, R2, R1], true);
  polyLine(ctx, [D, C, R2, R1], true);
}

export class PlantView {
  constructor(plant, site) {
    this.plant = plant;
    this.s = site;
    this.passive = plant.mode === MODE.PASSIVE;
    this.z = site.z;
    this.layout();
  }

  layout() {
    // A 14x14 site square. Local (0,0) is the seaward corner - which is
    // exactly where Gen-II plants historically put the equipment a wave
    // can reach.
    // The site is staged like a set. In this projection x+y is distance from
    // the camera, so: tall things at the BACK (they can never occlude what is
    // in front), the reactor building alone in the MIDDLE where nothing can
    // stand in front of it, and only low things at the FRONT.
    //
    // The occlusion rule: a solid at (mx,my) hides a point at (mx,by) when
    // (w+d)/2 > my - by. Every setback below satisfies it.
    this.parts = {
      intake: { x: -2.3, y: -2.3, w: 2.2, d: 1.7 },
      towers: [{ x: -1.2, y: 7.2, r: 1.85 }, { x: 7.2, y: -1.2, r: 1.85 }],
      edg: { x: 0.8, y: 4.6, w: 3.0, d: 2.2 },
      stack: { x: 4.8, y: 1.4 },
      aux: { x: 2.2, y: 9.0, w: 2.4, d: 3.0 },
      reactor: { x: 7.0, y: 7.0, r: this.passive ? 1.62 : 1.45 },
      fuel: { x: 9.6, y: 2.8, w: 2.6, d: 2.6 },
      turbine: { x: 10.8, y: 8.4, w: 3.4, d: 5.8 },
      switchyard: { x: 4.6, y: 11.8 },
      tanks: [{ x: 9.4, y: 11.2, r: 0.86 }, { x: 10.8, y: 12.4, r: 0.7 }],
      gate: { x: 12.6, y: 5.4 },
      park: { x: 12.4, y: 7.0 }
    };
  }

  // ---------------------------------------------------------------------
  // Emit every piece into the shared sorted list. key = x + y + (w+d)/2 for
  // footprints, x + y for anything drawn from its centre.
  collect(list, time) {
    const S = this.s, z = this.z, P_ = this.passive, p = this.plant;
    const put = (k, f) => list.push({ k, f });
    const pt = this.parts;

    // flat ground dressing first (they never occlude, but they must sit under
    // the structures, so they get a very low key)
    put(-1e6, (c) => this.drawApron(c));

    const it = pt.intake;
    put(S.x + it.x + S.y + it.y + (it.w + it.h) / 2, (c) => this.drawIntake(c));

    const e = pt.edg;
    put(S.x + e.x + S.y + e.y + (e.w + e.d) / 2, (c) => this.drawEDG(c));

    const a = pt.aux;
    put(S.x + a.x + S.y + a.y + (a.w + a.d) / 2, (c) => this.drawAux(c));

    const f = pt.fuel;
    put(S.x + f.x + S.y + f.y + (f.w + f.d) / 2, (c) => this.drawFuel(c));

    put(S.x + pt.stack.x + S.y + pt.stack.y, (c) => this.drawStack(c));
    put(S.x + pt.reactor.x + S.y + pt.reactor.y, (c) => this.drawReactor(c, time));

    const t = pt.turbine;
    put(S.x + t.x + S.y + t.y + (t.w + t.d) / 2, (c) => this.drawTurbine(c));
    // transformer bank stands apart from the hall so it sorts on its own depth
    put(S.x + t.x - 1.0 + S.y + t.y + 2.4, (c) => this.drawTransformers(c));

    for (const tk of pt.tanks) put(S.x + tk.x + S.y + tk.y, (c) => this.drawTank(c, tk));
    put(S.x + pt.switchyard.x + S.y + pt.switchyard.y, (c) => this.drawSwitchyard(c));
    for (const tw of pt.towers) put(S.x + tw.x + S.y + tw.y, (c) => this.drawTower(c, tw));
    put(S.x + pt.gate.x + S.y + pt.gate.y, (c) => this.drawGate(c));
    put(S.x + pt.park.x + S.y + pt.park.y, (c) => this.drawCars(c));

    // The fence is four separate runs: a single key would put the near run
    // behind the buildings it is supposed to stand in front of.
    put(S.x + 0.2 + S.y + 0.2 - 0.1, (c) => this.fenceRun(c, 0.2, 0.2, 13.8, 0.2));
    put(S.x + 0.2 + S.y + 0.2, (c) => this.fenceRun(c, 0.2, 0.2, 0.2, 13.8));
    put(S.x + 13.8 + S.y + 0.2, (c) => this.fenceRun(c, 13.8, 0.2, 13.8, 13.8));
    put(S.x + 0.2 + S.y + 13.8, (c) => this.fenceRun(c, 0.2, 13.8, 13.8, 13.8));
  }

  L(lx, ly) { return [this.s.x + lx, this.s.y + ly]; }

  // ---- flat dressing --------------------------------------------------
  drawApron(ctx) {
    const S = this.s, z = this.z;
    const quad = (x0, y0, x1, y1, col, alpha) => {
      const A = project(S.x + x0, S.y + y0, z), B = project(S.x + x1, S.y + y0, z);
      const C = project(S.x + x1, S.y + y1, z), D = project(S.x + x0, S.y + y1, z);
      ctx.globalAlpha = alpha === undefined ? 1 : alpha;
      ctx.fillStyle = col;
      poly(ctx, [A, B, C, D]);
      ctx.globalAlpha = 1;
    };
    quad(0.6, 0.6, 13.4, 13.4, '#c3c0b6');
    quad(0.6, 0.6, 13.4, 13.4, 'rgba(120,116,106,0.10)');
    // roadway ring
    quad(5.6, 0.8, 6.4, 13.2, TARMAC, 0.5);
    quad(0.8, 10.4, 13.2, 11.2, TARMAC, 0.42);
    // hazard striping at the nuclear island
    const A = project(S.x + 5.2, S.y + 5.2, z), B = project(S.x + 8.8, S.y + 5.2, z);
    const C = project(S.x + 8.8, S.y + 8.8, z), D = project(S.x + 5.2, S.y + 8.8, z);
    ctx.strokeStyle = 'rgba(206,176,64,0.45)';
    ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
    polyLine(ctx, [A, B, C, D], true);
    ctx.setLineDash([]);
  }

  fenceRun(ctx, x0, y0, x1, y1) {
    const S = this.s, z = this.z, h = 0.52;
    const a0 = project(S.x + x0, S.y + y0, z + h), a1 = project(S.x + x1, S.y + y1, z + h);
    const b0 = project(S.x + x0, S.y + y0, z), b1 = project(S.x + x1, S.y + y1, z);
    ctx.strokeStyle = 'rgba(126,132,138,0.9)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();
    ctx.globalAlpha = 0.3;
    const n = 22;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = a0.x + (a1.x - a0.x) * t, py = a0.y + (a1.y - a0.y) * t;
      ctx.moveTo(px, py); ctx.lineTo(px, py + h * TZ);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(b0.x, b0.y); ctx.lineTo(b1.x, b1.y);
    ctx.strokeStyle = 'rgba(90,96,102,0.5)'; ctx.stroke();
  }

  // ---- structures ------------------------------------------------------
  drawIntake(ctx) {
    const S = this.s, o = this.parts.intake;
    const x = S.x + o.x, y = S.y + o.y;
    const drowned = this.plant.flooded > 1;
    // a pier on piles, running back to the shore, so the pumphouse is not a
    // slab floating on open water
    const px0 = x + o.w, py0 = y + 0.45, px1 = x + o.w + 1.9, py1 = y + 1.9;
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const cx = px0 + (px1 - px0) * t, cy = py0 + (py1 - py0) * t;
      const a = project(cx, cy, 0.45), b = project(cx, cy, -0.45);
      ctx.strokeStyle = 'rgba(84,74,62,0.85)'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    const A0 = project(px0, py0 - 0.26, 0.45), A1 = project(px1, py1 - 0.26, 0.45);
    const B1 = project(px1, py1 + 0.26, 0.45), B0 = project(px0, py0 + 0.26, 0.45);
    ctx.fillStyle = '#b3a894';
    poly(ctx, [A0, A1, B1, B0]);
    ctx.strokeStyle = 'rgba(60,54,46,0.5)'; ctx.lineWidth = 1;
    polyLine(ctx, [A0, A1, B1, B0], true);
    box(ctx, {
      x, y, z: -0.3, w: o.w, d: o.h, h: 1.9,
      color: drowned ? mix(CONCRETE_D, '#3f6a80', 0.5) : CONCRETE_D, top: ROOF_G
    });
    for (let i = 0; i < 3; i++) {
      box(ctx, {
        x: x + 0.3 + i * 0.65, y: y + 0.45, z: 1.6, w: 0.4, d: 0.5, h: 0.35,
        color: MACHINE, edge: false
      });
    }
  }

  drawEDG(ctx) {
    const S = this.s, o = this.parts.edg, z = this.z;
    const x = S.x + o.x, y = S.y + o.y;
    const drowned = this.plant.flooded > 1;
    shadow(ctx, x + o.w / 2, y + o.d / 2, z, 46, 24, 0.22);
    box(ctx, {
      x, y, z, w: o.w, d: o.d, h: 1.9,
      color: drowned ? mix(CONCRETE_D, '#2f5f78', 0.55) : CONCRETE_D,
      top: ROOF_G, panels: { cols: 5, rows: 2, seed: 3, joint: 'rgba(60,54,46,0.16)' }
    });
    for (let i = 0; i < 3; i++) {
      cylinder(ctx, {
        x: x + 0.7 + i * 1.0, y: y + 0.5, z: z + 1.9, r: 0.14, h: 1.2,
        color: drowned ? '#6d5b4c' : '#9c6a4a'
      });
    }
    // louvre band on the sunny face
    const l0 = project(x + o.w, y + 0.3, z + 1.55), l1 = project(x + o.w, y + o.d - 0.3, z + 1.55);
    ctx.strokeStyle = 'rgba(60,66,72,0.4)'; ctx.lineWidth = 1;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(l0.x, l0.y + k * 3.2); ctx.lineTo(l1.x, l1.y + k * 3.2); ctx.stroke();
    }
  }

  drawAux(ctx) {
    const S = this.s, o = this.parts.aux, z = this.z;
    const x = S.x + o.x, y = S.y + o.y;
    shadow(ctx, x + o.w / 2, y + o.d / 2, z, 50, 26, 0.24);
    box(ctx, {
      x, y, z, w: o.w, d: o.d, h: 3.2, color: CONCRETE, top: ROOF_G,
      windows: { cols: 3, rows: 4, seed: 11 }
    });
    box(ctx, {
      x: x + 0.3, y: y + o.d * 0.22, z: z + 3.2, w: o.w - 0.6, d: o.d * 0.56, h: 0.8,
      color: '#8fa4b0', top: ROOF, windows: { cols: 3, rows: 1, seed: 5 }
    });
  }

  drawFuel(ctx) {
    const S = this.s, o = this.parts.fuel, z = this.z;
    const x = S.x + o.x, y = S.y + o.y;
    shadow(ctx, x + o.w / 2, y + o.d / 2, z, 52, 26, 0.24);
    box(ctx, { x, y, z, w: o.w, d: o.d, h: 2.7, color: CONCRETE, top: ROOF });
    // spent-fuel pool skylight; it glows faintly blue, and green if the core
    // next door has come apart
    const A = project(x + 0.6, y + 0.6, z + 2.7), B = project(x + o.w - 0.6, y + 0.6, z + 2.7);
    const C = project(x + o.w - 0.6, y + o.d - 0.6, z + 2.7), D = project(x + 0.6, y + o.d - 0.6, z + 2.7);
    ctx.fillStyle = this.plant.coreDamage > 0.2 ? 'rgba(126,240,180,0.55)' : 'rgba(112,190,224,0.5)';
    poly(ctx, [A, B, C, D]);
    ctx.strokeStyle = 'rgba(70,62,52,0.35)'; ctx.lineWidth = 1;
    polyLine(ctx, [A, B, C, D], true);
  }

  drawStack(ctx) {
    const S = this.s, o = this.parts.stack, z = this.z;
    const x = S.x + o.x, y = S.y + o.y;
    const broken = this.plant.explosions > 1;
    const h = broken ? 3.6 : 8.0;
    cylinder(ctx, { x, y, z, r: 0.28, h, color: broken ? '#8f8a80' : CONCRETE, rib: 5 });
    if (!broken) {
      for (const t of [0.42, 0.62, 0.82]) {
        const p = project(x, y, z + h * t);
        ctx.strokeStyle = 'rgba(196,72,56,0.75)'; ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, 0.28 * TW * 1.414, 0.28 * TH * 1.414, 0, 0.15, Math.PI - 0.15);
        ctx.stroke();
      }
    }
  }

  drawTurbine(ctx) {
    const S = this.s, o = this.parts.turbine, z = this.z;
    const x = S.x + o.x, y = S.y + o.y;
    shadow(ctx, x + o.w / 2, y + o.d / 2, z, 100, 52, 0.26);
    box(ctx, {
      x, y, z, w: o.w, d: o.d, h: 2.9, color: HALL, top: HALL,
      panels: { cols: 10, rows: 5, band: 4, seed: 21, color: '#a8c6da' }
    });
    // low-pitch roof and a run of ridge vents
    gableLow(ctx, x, y, z + 2.9, o.w, o.d, 0.6, ROOF);
    for (let i = 0; i < 5; i++) {
      box(ctx, {
        x: x + o.w * 0.42, y: y + 0.6 + i * 1.05, z: z + 3.5, w: o.w * 0.16, d: 0.45, h: 0.22,
        color: '#8ea3ae', edge: false
      });
    }
    // gantry crane rail down the hall
    const g0 = project(x + o.w * 0.5, y + 0.2, z + 3.0), g1 = project(x + o.w * 0.5, y + o.d - 0.2, z + 3.0);
    ctx.strokeStyle = 'rgba(96,104,110,0.5)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(g0.x, g0.y); ctx.lineTo(g1.x, g1.y); ctx.stroke();
    // overhead pipe bridge to the containment
    const A = project(x, y + 3.0, z + 2.6), B = project(S.x + 7.2, S.y + 6.2, z + 2.6);
    ctx.strokeStyle = 'rgba(150,156,162,0.95)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(70,62,52,0.3)'; ctx.lineWidth = 1; ctx.stroke();
  }

  drawTransformers(ctx) {
    const S = this.s, o = this.parts.turbine, z = this.z;
    const x = S.x + o.x - 1.35, y = S.y + o.y + 1.2;
    for (let i = 0; i < 3; i++) {
      box(ctx, { x, y: y + i * 2.2, z, w: 1.0, d: 1.2, h: 1.0, color: MACHINE, top: '#6f767c' });
      cylinder(ctx, { x: x + 0.5, y: y + i * 2.2 + 0.6, z: z + 1.0, r: 0.16, h: 0.5, color: '#6f767c', edge: false });
    }
  }

  drawTank(ctx, t) {
    const S = this.s, z = this.z;
    const x = S.x + t.x, y = S.y + t.y;
    shadow(ctx, x, y, z, 24, 12, 0.2);
    cylinder(ctx, { x, y, z, r: t.r, h: 1.8, color: STEEL, rib: 3, capColor: shade(STEEL, 0.98) });
  }

  drawSwitchyard(ctx) {
    const S = this.s, o = this.parts.switchyard, z = this.z;
    const x = S.x + o.x, y = S.y + o.y;
    const dead = !this.plant.grid;
    for (let i = 0; i < 3; i++) {
      box(ctx, {
        x: x + i * 1.4, y, z, w: 0.9, d: 1.0, h: 0.9,
        color: dead ? mix(MACHINE, '#5a4a44', 0.4) : MACHINE, top: '#6f767c'
      });
    }
    for (let i = 0; i < 2; i++) {
      pylon(ctx, {
        x: x + 0.6 + i * 2.4, y: y + 2.2, z, h: 3.8, w: 0.5,
        color: dead ? 'rgba(96,80,74,0.9)' : 'rgba(88,94,100,0.95)'
      });
    }
    // conductors span pylon to pylon and then to an off-site tower, so no
    // wire ends in empty sky
    const far = pylon(ctx, { x: x - 3.4, y: y + 5.6, z, h: 3.6, w: 0.5, color: dead ? 'rgba(96,80,74,0.9)' : 'rgba(88,94,100,0.95)' });
    const A = project(x + 0.6, y + 2.2, z + 3.6), B = project(x + 3.0, y + 2.2, z + 3.6);
    ctx.strokeStyle = dead ? 'rgba(110,90,80,0.6)' : 'rgba(52,58,64,0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo((A.x + B.x) / 2, A.y + 7, B.x, B.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.quadraticCurveTo((A.x + far.x) / 2, Math.max(A.y, far.y) + 12, far.x, far.y);
    ctx.stroke();
  }

  drawTower(ctx, t) {
    const S = this.s, z = this.z;
    const x = S.x + t.x, y = S.y + t.y;
    shadow(ctx, x, y, z, 92, 48, 0.26);
    coolingTower(ctx, { x, y, z, r: t.r, h: 9.6, color: TOWER });
    // a deep shaft: bright rim, dark interior, near wall lit and far wall dark
    const rimZ = z + 9.6, rr = t.r * 0.70;
    const rim = project(x, y, rimZ);
    ctx.beginPath();
    ctx.ellipse(rim.x, rim.y, rr * TW * 1.414, rr * TH * 1.414, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#2b2f33'; ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rim.x, rim.y, rr * TW * 1.414 * 0.82, rr * TH * 1.414 * 0.82, 0, Math.PI, 0, false);
    ctx.fillStyle = '#4c5359'; ctx.fill();
    ctx.strokeStyle = 'rgba(240,238,230,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(rim.x, rim.y, rr * TW * 1.414, rr * TH * 1.414, 0, Math.PI, 0, true);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(94,90,84,0.8)'; ctx.lineWidth = 1.3;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      if (Math.cos(a) + Math.sin(a) <= -0.2) continue;
      const b0 = project(x + Math.cos(a) * t.r, y + Math.sin(a) * t.r, z);
      const b1 = project(x + Math.cos(a) * t.r * 0.86, y + Math.sin(a) * t.r * 0.86, z + 0.85);
      ctx.beginPath(); ctx.moveTo(b0.x, b0.y); ctx.lineTo(b1.x, b1.y); ctx.stroke();
    }
  }

  drawGate(ctx) {
    const S = this.s, o = this.parts.gate, z = this.z;
    box(ctx, {
      x: S.x + o.x, y: S.y + o.y, z, w: 1.1, d: 1.0, h: 0.85,
      color: '#e2dac8', top: '#b4523f'
    });
  }

  drawCars(ctx) {
    const S = this.s, o = this.parts.park, z = this.z;
    const cols = ['#c8564a', '#4a7ba0', '#e0ddd4', '#5c6f5a', '#d0a44e'];
    for (let i = 0; i < 8; i++) {
      const hx = hash2(i, 7, 1), hy = hash2(i, 9, 2);
      const cx = S.x + o.x + (i % 4) * 0.45, cy = S.y + o.y + Math.floor(i / 4) * 0.7 + hy * 0.1;
      box(ctx, {
        x: cx, y: cy, z, w: 0.30, d: 0.5, h: 0.16,
        color: cols[(hx * cols.length) | 0], edge: false
      });
    }
  }

  // ---- the reactor building -------------------------------------------
  drawReactor(ctx, time) {
    const S = this.s, r = this.parts.reactor, z = this.z;
    const x = S.x + r.x, y = S.y + r.y;
    const p = this.plant;
    const wrecked = p.explosions > 0 || p.rupturedByPower;

    shadow(ctx, x, y, z, 78, 40, 0.28);

    if (this.passive) {
      // AP1000-style shield building: a cylinder with an air-inlet band near
      // the top, a gravity water tank on the roof and a central air diffuser.
      cylinder(ctx, { x, y, z, r: r.r, h: 6.2, color: CONCRETE, rib: 6, cap: false });
      // air inlet band
      const bandZ = z + 5.5;
      const p0 = project(x, y, bandZ);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(p0.x, p0.y, r.r * TW * 1.414, r.r * TH * 1.414 + 14, 0, 0, Math.PI * 2);
      ctx.clip();
      const top = project(x, y, z + 6.2);
      ctx.fillStyle = '#2b3238';
      ctx.fillRect(p0.x - 140, top.y, 280, 15);
      ctx.strokeStyle = 'rgba(180,190,198,0.8)'; ctx.lineWidth = 1.4;
      for (let i = -10; i <= 10; i++) {
        ctx.beginPath(); ctx.moveTo(p0.x + i * 8, top.y); ctx.lineTo(p0.x + i * 8, top.y + 15); ctx.stroke();
      }
      ctx.restore();
      cylinder(ctx, { x, y, z: z + 6.2, r: r.r * 1.1, h: 0.32, color: CONCRETE_D });
      // the tank whose 3,000 t of water buys 72 hours
      const lvl = Math.max(0, Math.min(1, p.pccwst / 3.0e6));
      cylinder(ctx, {
        x, y, z: z + 6.52, r: r.r * 0.8, h: 1.5, color: STEEL, rib: 3,
        capColor: lvl > 0.02 ? mix('#1d4d68', '#2f7c9c', lvl) : '#5f676c'
      });
      const lp = project(x, y, z + 6.52 + 1.5);
      ctx.strokeStyle = 'rgba(150,166,176,0.9)'; ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(lp.x, lp.y, r.r * 0.8 * TW * 1.414, r.r * 0.8 * TH * 1.414, 0, 0, Math.PI * 2);
      ctx.stroke();
      cylinder(ctx, { x, y, z: z + 8.02, r: r.r * 0.34, h: 1.1, color: STEEL, capColor: '#33393e' });
      box(ctx, {
        x: x + r.r * 0.55, y: y + r.r * 0.55, z, w: 1.1, d: 1.1, h: 1.7, color: '#c2bfb5'
      });
      if (wrecked) this.drawWreck(ctx, x, y, z, r.r, 6.2);
    } else {
      // Gen-II: concrete containment cylinder under a hemispherical dome
      const h = wrecked ? 3.0 : 5.0;
      cylinder(ctx, { x, y, z, r: r.r, h, color: CONCRETE_D, rib: 5, cap: wrecked });
      if (!wrecked) dome(ctx, { x, y, z: z + h, r: r.r, h: r.r * 1.5, color: SHELL });
      else this.drawWreck(ctx, x, y, z, r.r, h);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        if (Math.cos(a) + Math.sin(a) <= 0) continue;
        box(ctx, {
          x: x + Math.cos(a) * r.r * 0.98 - 0.18, y: y + Math.sin(a) * r.r * 0.98 - 0.18,
          z, w: 0.36, d: 0.36, h: wrecked ? 2.0 : 3.0, color: CONCRETE_D, edge: false
        });
      }
      // equipment hatch and personnel airlock on the camera-facing quarter
      box(ctx, {
        x: x + r.r * 0.55, y: y + r.r * 0.55, z, w: 1.0, d: 1.0, h: 1.5, color: '#b8b5ab'
      });
      cylinder(ctx, {
        x: x + r.r * 0.62, y: y - r.r * 0.28, z: z + 0.9, r: 0.34, h: 0.9,
        color: '#a6a39a', cap: true
      });
    }

    // corium glow at the base once the core is coming apart
    const glow = p.vesselBreach ? 1 : p.coreDamage;
    if (glow > 0.05) {
      const g0 = project(x, y, z + 0.08);
      const rr = (24 + 34 * glow) * (p.vesselBreach ? 1.5 : 1);
      const grd = ctx.createRadialGradient(g0.x, g0.y, 0, g0.x, g0.y, rr);
      const a = (0.22 + 0.5 * glow) * (0.85 + 0.15 * Math.sin(time * 3));
      grd.addColorStop(0, `rgba(255,${(200 - 130 * glow) | 0},70,${a})`);
      grd.addColorStop(0.55, `rgba(255,${(110 - 60 * glow) | 0},28,${a * 0.45})`);
      grd.addColorStop(1, 'rgba(170,40,10,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.ellipse(g0.x, g0.y, rr, rr * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  drawWreck(ctx, x, y, z, r, h) {
    // the blown-open core, glowing up out of the ruin
    const g0 = project(x, y, z + h - 0.5);
    const grd = ctx.createRadialGradient(g0.x, g0.y, 0, g0.x, g0.y, r * TW * 1.5);
    grd.addColorStop(0, 'rgba(255,190,90,0.85)');
    grd.addColorStop(0.5, 'rgba(240,110,40,0.4)');
    grd.addColorStop(1, 'rgba(180,50,20,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(g0.x, g0.y, r * TW * 1.5, r * TH * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i <= 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      const rr = r * (0.86 + hash2(i, 3, 1) * 0.32);
      const q = project(x + Math.cos(a) * rr, y + Math.sin(a) * rr,
        z + h - 0.35 - hash2(i, 5, 2) * 0.8);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.fillStyle = '#2a2724'; ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(64,58,52,0.9)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 20; i++) {
      const a = hash2(i, 11, 3) * Math.PI * 2, rr = r * (0.7 + hash2(i, 13, 4) * 0.4);
      const b0 = project(x + Math.cos(a) * rr, y + Math.sin(a) * rr, z + h - 0.4);
      ctx.beginPath();
      ctx.moveTo(b0.x, b0.y);
      ctx.quadraticCurveTo(b0.x + (hash2(i, 17, 5) - 0.5) * 24, b0.y - 10 - hash2(i, 19, 6) * 20,
        b0.x + (hash2(i, 23, 7) - 0.5) * 36, b0.y - 18 - hash2(i, 29, 8) * 26);
      ctx.stroke();
    }
  }

  // ---- annotations (screen space, drawn after the sorted pass) ---------
  tags() {
    const S = this.s, z = this.z, p = this.plant, P_ = this.passive, pt = this.parts;
    const out = [];
    const add = (lx, ly, lz, text, danger, prio) =>
      out.push({ x: S.x + lx, y: S.y + ly, z: lz, text, danger, prio: prio || 1 });
    add(pt.intake.x + 1.2, pt.intake.y + 1, 1.5,
      P_ ? 'Circulating water (power cycle only)' : 'Seawater intake - the safety heat sink', !P_, 2);
    add(pt.edg.x + 1.5, pt.edg.y + 1.1, z + 2.0,
      P_ ? 'Diesels (convenience, not safety)'
        : (p.flooded > 1 ? 'Emergency diesels - FLOODED' : 'Emergency diesels - at grade'),
      !P_ || p.flooded > 1, 3);
    add(pt.aux.x + 1.2, pt.aux.y + 1.5, z + 4.3, 'Control room', false, 1);
    add(pt.turbine.x + 1.7, pt.turbine.y + 2.9, z + 4.0, 'Turbine hall', false, 1);
    add(pt.switchyard.x + 1.6, pt.switchyard.y + 1.2, z + 4.2,
      p.grid ? 'Switchyard - offsite grid' : 'Switchyard - OFFSITE POWER LOST', !p.grid, 3);
    if (P_) {
      add(pt.reactor.x, pt.reactor.y, z + 9.6,
        `Gravity tank - ${(p.pccwst / 1000).toFixed(0)} t above the core`, false, 4);
    } else {
      add(pt.reactor.x, pt.reactor.y, z + 8.0,
        p.ctmtIntact ? 'Containment - powered sprays only' : 'CONTAINMENT BREACHED', true, 4);
    }
    return out;
  }

  // ---- particle emission ----------------------------------------------
  emit(fx, dt, simDt) {
    const p = this.plant, S = this.s, z = this.z;
    const r = this.parts.reactor;
    const rx = S.x + r.x, ry = S.y + r.y;

    if (p.powerFrac > 0.05 && !p.scrammed) {
      for (const t of this.parts.towers)
        fx.steam(S.x + t.x, S.y + t.y, z + 10.4, 5, dt,
          { r: 0.6, grow: 0.36, max: 5.2, rise: 2.4, spread: 1.35, a: 0.10, turb: 0.7 });
    } else if (p.powerFrac > 0.002) {
      for (const t of this.parts.towers)
        fx.steam(S.x + t.x, S.y + t.y, z + 10.2, 2, dt,
          { r: 0.45, grow: 0.26, max: 3.4, rise: 1.5, spread: 1.0, a: 0.07, turb: 0.5 });
    }
    if (!p.grid && p.dieselsOk && p.diesels > 0 && p.acPower) {
      const e = this.parts.edg;
      fx.smoke(S.x + e.x + 1.6, S.y + e.y + 0.5, z + 3.2, 7, dt,
        { r: 0.22, grow: 0.26, max: 3.4, rise: 1.7, col: [64, 60, 56], a: 0.36, spread: 0.7, turb: 0.4 });
    }
    if (this.passive && !p.sabotaged && (p.Tctmt > 330 || p.coolingMargin < 1.02)) {
      const inten = Math.max(0.15, Math.min(2.2, (p.Tctmt - 320) / 60));
      fx.steam(rx, ry, z + 9.2, 5 * inten, dt,
        { r: 0.5, grow: 0.42, max: 4.6, rise: 2.1, spread: 0.5, a: 0.22 });
    }
    if (!this.passive && p.scrammed && p.steamToCtmt > 1) {
      fx.steam(rx + 1.0, ry - 1.0, z + 5.4, Math.max(1, Math.min(16, p.steamToCtmt * 0.5)), dt,
        { r: 0.5, grow: 0.45, max: 4.5, rise: 2.0, spread: 0.7, a: 0.28 });
    }
    if (p.vented || !p.ctmtIntact) {
      const st = this.parts.stack;
      fx.steam(S.x + st.x, S.y + st.y, z + (p.explosions > 1 ? 3.8 : 8.0), 6, dt,
        { r: 0.45, grow: 0.5, max: 6, rise: 2.4, spread: 0.35, col: [214, 222, 212], a: 0.3 });
    }
    if (p.fire > 0.15) {
      const sy = this.parts.switchyard;
      fx.fire(S.x + sy.x + 1, S.y + sy.y + 0.5, z + 0.9, 10 * p.fire, dt, { spread: 1.0, r: 0.32 });
      fx.smoke(S.x + sy.x + 1, S.y + sy.y + 0.5, z + 1.9, 11 * p.fire, dt,
        { r: 0.28, grow: 0.28, max: 7, rise: 1.9, col: [36, 32, 32], a: 0.32, spread: 0.7, turb: 0.5 });
    }
    if (p.explosions > 0) {
      // The column starts above the ruin, not on top of it: the wreck is the
      // thing worth looking at and smoke drawn at its base just erases it.
      fx.fire(rx, ry, z + 2.2, 8, dt, { spread: 1.6, r: 0.3, a: 0.42 });
      fx.smoke(rx, ry, z + 5.4, 11, dt,
        { r: 0.32, grow: 0.24, max: 9, rise: 3.0, col: [34, 31, 31], a: 0.26, spread: 0.9, turb: 1.0 });
    }
    if (p.vesselBreach) {
      fx.smoke(rx, ry, z + 0.9, 10, dt,
        { r: 0.36, grow: 0.3, max: 9, rise: 1.5, col: [64, 54, 48], a: 0.3, spread: 1.1, turb: 0.4 });
    }
    if (p.releaseRate > 1e6) {
      const hot = p.explosions > 0 || !p.ctmtIntact;
      fx.plume(rx, ry, z + (hot ? 5.5 : 9), p.releaseRate * simDt, dt, hot ? 2.2 : 1.1);
    }
  }

  boom(fx, cam, world, power) {
    const S = this.s, r = this.parts.reactor, z = this.z;
    const x = S.x + r.x, y = S.y + r.y;
    fx.flash(x, y, z + 4, 6 * power, 0.7);
    fx.ring(x, y, z + 1, 9 * power, 9 * power);
    fx.debris(x, y, z + 5, 64 * power, 5.2 * power);
    for (let i = 0; i < 44; i++) {
      fx.smoke(x, y, z + 3 + i * 0.14, 1, 1,
        { r: 0.5, grow: 0.42, max: 12, rise: 3.8, col: [44, 40, 38], a: 0.34, spread: 1.6, turb: 1.5 });
    }
    for (let i = 0; i < 16; i++) fx.fire(x, y, z + 3, 1, 1, { spread: 2.4, r: 0.7 });
    cam.jolt(1.1 * power);
    world.blast(x, y, 5 * power, 0.55 * power);
  }
}
