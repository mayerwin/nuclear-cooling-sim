// ---------------------------------------------------------------------------
// plantview.js — isometric geometry for the two stations, including how they
// come apart. Structures are emitted into a shared depth-sorted draw list so
// they interleave correctly with terrain props.
// ---------------------------------------------------------------------------
import { MAT } from './textures.js';
import { P, box, cylinder, coolingTower, dome, pipe, pylon, cone, quadFlat, shadow, revolve } from './draw3d.js';
import { TW, TH, EH } from './iso.js';
import { clamp, lerp, TAU, mulberry32, smoothstep } from './util.js';
import { MODE } from './plant.js';

export class PlantView {
  constructor(plant, site) {
    this.plant = plant;
    this.s = site;
    this.rng = mulberry32(plant.mode === MODE.PASSIVE ? 22 : 11);
    this.passive = plant.mode === MODE.PASSIVE;
    this.t = 0;
    this.layout();
  }

  L(lx, ly) { return [this.s.x + lx, this.s.y + ly]; }

  layout() {
    const z = this.s.z;
    const P_ = this.passive;
    this.z = z;
    // Local layout is expressed in a 14x14 site square. Local (0,0) is the
    // seaward corner (lowest x+y), which is exactly where Gen-II plants
    // historically put the equipment a wave can reach.
    this.parts = {
      intake: { x: -4.2, y: -4.2, w: 2.2, h: 1.8, z: 0.1 },
      edg: { x: 0.6, y: 1.0, w: 3.4, h: 2.4 },
      reactor: { x: 5.6, y: 5.6, r: 1.45 },
      aux: { x: 2.4, y: 4.8, w: 2.4, h: 3.8 },
      turbine: { x: 8.6, y: 2.4, w: 4.6, h: 8.4 },
      stack: { x: 4.4, y: 1.6 },
      fuel: { x: 2.0, y: 9.6, w: 3.0, h: 3.2 },
      switchyard: { x: 9.2, y: 11.0 },
      tanks: [{ x: 6.6, y: 11.6, r: 0.95 }, { x: 8.4, y: 11.9, r: 0.8 }],
      towers: [{ x: 11.8, y: 13.2, r: 1.95 }, { x: 14.4, y: 10.4, r: 1.95 }],
      gate: { x: 12.0, y: 0.9 }
    };
    this.crater = null;
  }

  // ---------------------------------------------------------------------
  // Everything that does not change frame-to-frame is baked into the scene
  // layer; only the reactor building (glow, damage) is redrawn live.
  sig() {
    const p = this.plant;
    return [p.grid ? 1 : 0, p.flooded > 1 ? 1 : 0, p.fire > 0.15 ? 1 : 0, p.explosions,
    p.ctmtIntact ? 1 : 0, Math.round((p.pccwst || 0) / 3e5), Math.round(p.coreDamage * 6)].join(',');
  }

  collect(list, world, want) {
    const p = this.plant, S = this.s;
    const push = (lx, ly, fn, bias = 0, st = true) => {
      if (want === 'static' && !st) return;
      if (want === 'live' && st) return;
      list.push({ d: (S.x + lx) + (S.y + ly) + bias, fn });
    };
    const P_ = this.passive;

    // ---- seawater intake (only the active design needs it for safety) ----
    push(this.parts.intake.x, this.parts.intake.y, (ctx) => this.drawIntake(ctx));
    // ---- perimeter fence ----
    push(0, 0, (ctx) => this.drawFence(ctx), -14);
    push(0, 0, (ctx) => this.drawPads(ctx), -13.9);

    push(this.parts.edg.x, this.parts.edg.y, (ctx) => this.drawEDG(ctx));
    push(this.parts.fuel.x, this.parts.fuel.y, (ctx) => this.drawFuelBldg(ctx));
    push(this.parts.aux.x, this.parts.aux.y, (ctx) => this.drawAux(ctx));
    push(this.parts.stack.x, this.parts.stack.y, (ctx) => this.drawStack(ctx));
    push(this.parts.reactor.x, this.parts.reactor.y, (ctx) => this.drawReactor(ctx), 0, false);
    push(this.parts.turbine.x, this.parts.turbine.y, (ctx) => this.drawTurbine(ctx));
    for (const t of this.parts.tanks) push(t.x, t.y, (ctx) => this.drawTank(ctx, t));
    push(this.parts.switchyard.x, this.parts.switchyard.y, (ctx) => this.drawSwitchyard(ctx));
    for (const t of this.parts.towers) push(t.x, t.y, (ctx) => this.drawTower(ctx, t));
    push(this.parts.gate.x, this.parts.gate.y, (ctx) => this.drawGate(ctx));
  }

  // ---------------------------------------------------------------------
  drawPads(ctx) {
    const S = this.s, z = this.z;
    ctx.save();
    // concrete apron under the nuclear island
    const a = P(S.x + 1.4, S.y + 1.4, z), b = P(S.x + 12.6, S.y + 1.4, z);
    const c = P(S.x + 12.6, S.y + 12.6, z), d = P(S.x + 1.4, S.y + 12.6, z);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath();
    ctx.save(); ctx.clip();
    ctx.save();
    ctx.transform((b[0] - a[0]) / 340, (b[1] - a[1]) / 340, (d[0] - a[0]) / 340, (d[1] - a[1]) / 340, a[0], a[1]);
    ctx.fillStyle = MAT.concrete; ctx.fillRect(0, 0, 340, 340);
    ctx.restore();
    const bx0 = Math.min(a[0], b[0], c[0], d[0]), bx1 = Math.max(a[0], b[0], c[0], d[0]);
    const by0 = Math.min(a[1], b[1], c[1], d[1]), by1 = Math.max(a[1], b[1], c[1], d[1]);
    ctx.fillStyle = 'rgba(20,26,34,0.10)'; ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
    ctx.restore();
    // yellow hazard striping at the island edge
    ctx.strokeStyle = 'rgba(214,182,60,0.5)'; ctx.lineWidth = 2; ctx.setLineDash([7, 6]);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
  }

  drawFence(ctx) {
    const S = this.s, z = this.z, h = 0.55;
    const pts = [[0.2, 0.2], [13.8, 0.2], [13.8, 13.8], [0.2, 13.8], [0.2, 0.2]];
    ctx.strokeStyle = 'rgba(120,128,136,0.85)';
    ctx.lineWidth = 1;
    for (let i = 0; i < pts.length - 1; i++) {
      const a0 = P(S.x + pts[i][0], S.y + pts[i][1], z + h);
      const a1 = P(S.x + pts[i + 1][0], S.y + pts[i + 1][1], z + h);
      const b0 = P(S.x + pts[i][0], S.y + pts[i][1], z);
      ctx.beginPath();
      ctx.moveTo(a0[0], a0[1]); ctx.lineTo(a1[0], a1[1]);
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(a0[0], a0[1]); ctx.lineTo(b0[0], b0[1]); ctx.stroke();
      ctx.globalAlpha = 1;
      // mesh hint
      const n = 14;
      ctx.globalAlpha = 0.22;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const px = lerp(a0[0], a1[0], t), py = lerp(a0[1], a1[1], t);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + h * EH); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  drawIntake(ctx) {
    const S = this.s, pt = this.parts.intake;
    const x = S.x + pt.x, y = S.y + pt.y;
    const dmg = this.plant.flooded > 2 ? 1 : 0;
    shadow(ctx, x + pt.w / 2, y + pt.h / 2, pt.z, 40, 20, 0.22);
    box(ctx, x, y, pt.z, pt.w, pt.h, 1.5, { wall: MAT.concreteDark, top: MAT.roofGreen, k: dmg ? 0.75 : 1 });
    // intake channel water
    const a = P(x - 1.2, y - 1.2, 0.02), b = P(x + pt.w + 1.2, y - 1.2, 0.02);
    ctx.save();
    ctx.globalAlpha = 0.35; ctx.fillStyle = '#2a6f92';
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    const c = P(x + pt.w + 1.2, y + pt.h + 1, 0.02), d = P(x - 1.2, y + pt.h + 1, 0.02);
    ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  drawEDG(ctx) {
    const S = this.s, e = this.parts.edg, z = this.z;
    const x = S.x + e.x, y = S.y + e.y;
    const drowned = this.plant.flooded > 1;
    shadow(ctx, x + e.w / 2, y + e.h / 2, z, 56, 28, 0.25);
    box(ctx, x, y, z, e.w, e.h, 2.0, {
      wall: MAT.concreteDark, top: MAT.roofGreen, k: drowned ? 0.6 : 1,
      tint: drowned ? 'rgba(20,60,80,0.45)' : null
    });
    // exhaust stacks
    for (let i = 0; i < 3; i++) {
      cylinder(ctx, x + 0.6 + i * 1.0, y + 0.5, z + 2.0, 0.16, 1.5, MAT.rust, { k: drowned ? 0.7 : 1 });
    }
    // louvre detail
    const a = P(x + e.w, y + 0.3, z + 1.6), b = P(x + e.w, y + e.h - 0.3, z + 1.6);
    ctx.strokeStyle = 'rgba(30,40,50,0.55)'; ctx.lineWidth = 1;
    for (let k = 0; k < 5; k++) {
      ctx.beginPath();
      ctx.moveTo(a[0], a[1] + k * 3); ctx.lineTo(b[0], b[1] + k * 3); ctx.stroke();
    }
  }

  drawFuelBldg(ctx) {
    const S = this.s, f = this.parts.fuel, z = this.z;
    const x = S.x + f.x, y = S.y + f.y;
    shadow(ctx, x + f.w / 2, y + f.h / 2, z, 60, 30, 0.25);
    box(ctx, x, y, z, f.w, f.h, 3.0, { wall: MAT.concrete, top: MAT.roof });
    // spent-fuel pool skylight glow
    const a = P(x + 0.6, y + 0.6, z + 3.0), b = P(x + f.w - 0.6, y + 0.6, z + 3.0);
    const d = P(x + 0.6, y + f.h - 0.6, z + 3.0);
    quadFlat(ctx, a, b, d, this.plant.coreDamage > 0.2 ? 'rgba(120,255,190,0.5)' : 'rgba(90,180,220,0.45)', 0.9);
  }

  drawAux(ctx) {
    const S = this.s, a = this.parts.aux, z = this.z;
    const x = S.x + a.x, y = S.y + a.y;
    shadow(ctx, x + a.w / 2, y + a.h / 2, z, 60, 30, 0.28);
    box(ctx, x, y, z, a.w, a.h, 3.6, { wall: MAT.concrete, top: MAT.roofGreen });
    box(ctx, x + 0.3, y + a.h * 0.25, z + 3.6, a.w - 0.6, a.h * 0.5, 0.9, { wall: MAT.glass, top: MAT.roof, density: 26 });
  }

  drawStack(ctx) {
    const S = this.s, st = this.parts.stack, z = this.z;
    const x = S.x + st.x, y = S.y + st.y;
    const broken = this.plant.explosions > 1;
    cylinder(ctx, x, y, z, 0.3, broken ? 4 : 8.2, MAT.concrete, { k: 1 });
    if (!broken) {
      const top = P(x, y, z + 8.2);
      ctx.fillStyle = 'rgba(220,60,50,0.9)';
      ctx.beginPath(); ctx.ellipse(top[0], top[1], 0.3 * TW * 0.7071, 0.3 * TH * 0.7071, 0, 0, TAU); ctx.fill();
      // red/white bands
      for (let i = 0; i < 3; i++) {
        const zz = z + 3 + i * 2.2;
        const p0 = P(x, y, zz);
        ctx.globalAlpha = 0.5; ctx.strokeStyle = '#c8443c'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.ellipse(p0[0], p0[1], 0.3 * TW * 0.7071, 0.3 * TH * 0.7071, 0, Math.PI * 0.05, Math.PI * 0.95); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  drawReactor(ctx) {
    const S = this.s, r = this.parts.reactor, z = this.z;
    const x = S.x + r.x, y = S.y + r.y;
    const p = this.plant;
    const wrecked = p.explosions > 0 || !p.ctmtIntact;
    const glow = p.vesselBreach ? 1 : p.coreDamage;

    shadow(ctx, x, y, z, 96, 48, 0.3);

    if (this.passive) {
      // --- AP1000-style shield building: cylinder + air-inlet ring +
      //     PCCWST gravity tank on the roof + central air diffuser ---
      cylinder(ctx, x, y, z, r.r * 1.12, 6.4, MAT.concrete, { k: 1, cap: false });
      // air inlet band
      const bz = z + 5.6;
      const bp = P(x, y, bz);
      ctx.save();
      ctx.beginPath(); ctx.ellipse(bp[0], bp[1], r.r * TW * 0.7071, r.r * TH * 0.7071 + 12, 0, 0, TAU);
      ctx.clip();
      ctx.fillStyle = 'rgba(24,32,40,0.9)';
      const top = P(x, y, z + 6.4);
      ctx.fillRect(bp[0] - 200, top[1], 400, 22);
      ctx.strokeStyle = 'rgba(150,164,176,0.9)'; ctx.lineWidth = 1.4;
      for (let i = -9; i <= 9; i++) {
        ctx.beginPath(); ctx.moveTo(bp[0] + i * 9, top[1]); ctx.lineTo(bp[0] + i * 9, top[1] + 22); ctx.stroke();
      }
      ctx.restore();
      // roof slab
      cylinder(ctx, x, y, z + 6.4, r.r * 1.16, 0.35, MAT.concrete, { capColor: 'rgba(176,178,174,0.98)' });
      // PCCWST — the tank whose water buys 72 hours
      const lvl = clamp(p.pccwst / 3.0e6, 0, 1);
      cylinder(ctx, x, y, z + 6.75, r.r * 0.86, 1.6, MAT.steel, {
        capColor: 'rgba(96,104,110,0.95)',
        capInner: `rgba(${lerp(120, 40, lvl) | 0},${lerp(140, 130, lvl) | 0},${lerp(150, 190, lvl) | 0},0.95)`
      });
      // level band
      const tp = P(x, y, z + 6.75 + 1.6 * lvl);
      ctx.strokeStyle = 'rgba(90,200,255,0.75)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(tp[0], tp[1], r.r * 0.86 * TW * 0.7071, r.r * 0.86 * TH * 0.7071, 0, 0, TAU); ctx.stroke();
      // air diffuser chimney
      cylinder(ctx, x, y, z + 8.35, r.r * 0.36, 1.2, MAT.steel, { capColor: 'rgba(40,48,54,0.95)' });
      if (wrecked) this.drawWreck(ctx, x, y, z, r.r, 6.0);
    } else {
      // --- Gen-II: concrete containment cylinder + hemispherical dome ---
      const h = wrecked ? 3.2 : 5.0;
      cylinder(ctx, x, y, z, r.r, h, MAT.concreteDark, { cap: !wrecked, capColor: 'rgba(150,152,150,0.95)' });
      if (!wrecked) {
        const prof = [];
        for (let i = 0; i <= 10; i++) { const t = i / 10; prof.push({ t, r: r.r * Math.cos(t * Math.PI * 0.5) }); }
        revolve(ctx, x, y, z + h, 1.9, prof, MAT.shell, { cap: false });
      } else {
        this.drawWreck(ctx, x, y, z, r.r, h);
      }
      // buttresses
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        box(ctx, x + Math.cos(a) * r.r * 0.98 - 0.2, y + Math.sin(a) * r.r * 0.98 - 0.2,
          z, 0.4, 0.4, wrecked ? 2.0 : 3.0, { wall: MAT.concreteDark, top: MAT.concreteDark, outline: false });
      }
    }

    // corium / molten core glow at the base
    if (glow > 0.05) {
      const g0 = P(x, y, z + 0.1);
      const rr = (28 + 40 * glow) * (p.vesselBreach ? 1.6 : 1);
      const gr = ctx.createRadialGradient(g0[0], g0[1], 0, g0[0], g0[1], rr);
      const a = 0.25 + 0.55 * glow;
      gr.addColorStop(0, `rgba(255,${200 - 120 * glow | 0},80,${a})`);
      gr.addColorStop(0.5, `rgba(255,${120 - 60 * glow | 0},30,${a * 0.5})`);
      gr.addColorStop(1, 'rgba(180,40,10,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = gr;
      ctx.save(); ctx.translate(g0[0], g0[1]); ctx.scale(1, 0.5);
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.fill(); ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
    }

  }

  drawWreck(ctx, x, y, z, r, h) {
    const R = mulberry32(7);
    const top = P(x, y, z + h);
    // jagged blown-out top
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * TAU;
      const rr = r * (0.85 + R() * 0.35);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      const q = P(px, py, z + h - 0.4 - R() * 0.9);
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(28,26,28,0.92)'; ctx.fill();
    ctx.restore();
    // twisted rebar
    ctx.strokeStyle = 'rgba(58,52,48,0.9)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 22; i++) {
      const a = R() * TAU, rr = r * (0.7 + R() * 0.4);
      const b0 = P(x + Math.cos(a) * rr, y + Math.sin(a) * rr, z + h - 0.5);
      ctx.beginPath(); ctx.moveTo(b0[0], b0[1]);
      ctx.quadraticCurveTo(b0[0] + (R() - 0.5) * 26, b0[1] - 12 - R() * 22,
        b0[0] + (R() - 0.5) * 40, b0[1] - 20 - R() * 30);
      ctx.stroke();
    }
  }

  drawTurbine(ctx) {
    const S = this.s, t = this.parts.turbine, z = this.z;
    const x = S.x + t.x, y = S.y + t.y;
    shadow(ctx, x + t.w / 2, y + t.h / 2, z, 120, 60, 0.3);
    box(ctx, x, y, z, t.w, t.h, 3.6, { wall: MAT.siding, top: MAT.roof, density: 30 });
    // saw-tooth roof monitors
    for (let i = 0; i < 4; i++) {
      box(ctx, x + 0.6, y + 0.8 + i * 2.0, z + 3.6, t.w - 1.2, 0.9, 0.55,
        { wall: MAT.glass, top: MAT.roof, density: 24, outline: false });
    }
    // transformer bank + bus ducts on the seaward face
    for (let i = 0; i < 3; i++) {
      box(ctx, x - 1.3, y + 1.4 + i * 2.2, z, 1.0, 1.2, 1.1, { wall: MAT.transformer, top: MAT.machine, outline: false });
    }
  }

  drawTank(ctx, t) {
    const S = this.s, z = this.z;
    const x = S.x + t.x, y = S.y + t.y;
    shadow(ctx, x, y, z, 30, 15, 0.22);
    cylinder(ctx, x, y, z, t.r, 2.2, MAT.steel, { capColor: 'rgba(160,168,174,0.95)' });
    if (this.passive) {
      const p0 = P(x, y, z + 2.35);
      ctx.fillStyle = 'rgba(80,190,240,0.85)'; ctx.font = 'bold 9px system-ui';
      ctx.textAlign = 'center';
    }
  }

  drawSwitchyard(ctx) {
    const S = this.s, sy = this.parts.switchyard, z = this.z;
    const x = S.x + sy.x, y = S.y + sy.y;
    const dead = !this.plant.grid;
    for (let i = 0; i < 3; i++) {
      box(ctx, x + i * 1.5, y, z, 1.0, 1.1, 1.0, { wall: MAT.transformer, top: MAT.machine, outline: false, k: dead ? 0.7 : 1 });
    }
    for (let i = 0; i < 2; i++) {
      const t = pylon(ctx, x + 0.6 + i * 2.4, y + 2.4, z, 4.2, 0.6, dead ? 'rgba(70,62,58,0.9)' : 'rgba(84,92,100,0.95)');
    }
    // catenary wires heading off-site
    ctx.strokeStyle = dead ? 'rgba(60,50,46,0.6)' : 'rgba(40,46,52,0.8)';
    ctx.lineWidth = 1;
    const a = P(x + 0.6, y + 2.4, z + 4.0), b = P(x + 3.0, y + 2.4, z + 4.0);
    const c = P(x + 7.5, y + 7.5, z + 3.6);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo((a[0] + b[0]) / 2, a[1] + 6, b[0], b[1]);
    ctx.quadraticCurveTo((b[0] + c[0]) / 2, b[1] + 14, c[0], c[1]); ctx.stroke();
  }

  drawTower(ctx, t) {
    const S = this.s, z = this.z;
    const x = S.x + t.x, y = S.y + t.y;
    shadow(ctx, x, y, z, 110, 55, 0.3);
    coolingTower(ctx, x, y, z, t.r, 11.5, MAT.towerConcrete, {});
    // support columns at the base
    ctx.strokeStyle = 'rgba(90,90,86,0.85)'; ctx.lineWidth = 1.4;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      const rr = t.r;
      const b0 = P(x + Math.cos(a) * rr, y + Math.sin(a) * rr, z);
      const b1 = P(x + Math.cos(a) * rr * 0.86, y + Math.sin(a) * rr * 0.86, z + 0.9);
      ctx.beginPath(); ctx.moveTo(b0[0], b0[1]); ctx.lineTo(b1[0], b1[1]); ctx.stroke();
    }
  }

  drawGate(ctx) {
    const S = this.s, g = this.parts.gate, z = this.z;
    const x = S.x + g.x, y = S.y + g.y;
    box(ctx, x, y, z, 1.1, 1.0, 0.9, { wall: MAT.stucco, top: MAT.tileRoof, outline: false });
  }

  // --- annotations, drawn live so they stay screen-sized -----------------
  drawTags(ctx) {
    if (!PlantView.explain || PlantView.zoom < 0.85) return;
    const S = this.s, z = this.z, p = this.plant, P_ = this.passive;
    const e = this.parts.edg, r = this.parts.reactor, sy = this.parts.switchyard;
    const it = this.parts.intake, t = this.parts.turbine, a = this.parts.aux;
    this.tag(ctx, S.x + it.x + it.w / 2, S.y + it.y + it.h / 2, it.z + 1.5,
      P_ ? 'Circulating-water intake (power cycle only)' : 'Seawater intake - the safety heat sink', !P_);
    this.tag(ctx, S.x + e.x + e.w / 2, S.y + e.y + e.h / 2, z + 2.0,
      P_ ? 'Diesels (non-safety, convenience only)'
        : (p.flooded > 1 ? 'Emergency diesels - FLOODED' : 'Emergency diesel generators - at grade'),
      !P_ || p.flooded > 1);
    this.tag(ctx, S.x + a.x + a.w / 2, S.y + a.y + a.h / 2, z + 4.6, 'Control room / auxiliary building', false);
    this.tag(ctx, S.x + t.x + t.w / 2, S.y + t.y + t.h / 2, z + 4.4, 'Turbine hall & generator', false);
    this.tag(ctx, S.x + sy.x + 2, S.y + sy.y + 1.5, z + 4.6,
      p.grid ? 'Switchyard - offsite grid' : 'Switchyard - OFFSITE POWER LOST', !p.grid);
    if (P_) {
      this.tag(ctx, S.x + r.x, S.y + r.y, z + 10.4,
        `PCCWST gravity tank - ${(p.pccwst / 1000).toFixed(0)} t of water above the core`, false);
      this.tag(ctx, S.x + r.x + 2.4, S.y + r.y - 2.4, z + 6.6,
        'Steel containment cooled by an air draught', false);
    } else {
      this.tag(ctx, S.x + r.x, S.y + r.y, z + 8.2,
        p.ctmtIntact ? 'Containment - cooled only by powered sprays' : 'CONTAINMENT BREACHED', true);
    }
  }

  // --- floating annotation (only in explain mode) ------------------------
  tag(ctx, x, y, z, text, danger) {
    const p = P(x, y, z);
    const dy = -26;
    ctx.save();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 16;
    ctx.strokeStyle = danger ? 'rgba(255,120,90,0.85)' : 'rgba(150,220,255,0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0], p[1] + dy); ctx.stroke();
    ctx.beginPath(); ctx.arc(p[0], p[1], 2.4, 0, TAU);
    ctx.fillStyle = danger ? 'rgba(255,120,90,0.95)' : 'rgba(150,220,255,0.9)'; ctx.fill();
    const bx = p[0] - w / 2, by = p[1] + dy - 17;
    ctx.fillStyle = danger ? 'rgba(48,14,10,0.88)' : 'rgba(10,20,30,0.86)';
    roundRect(ctx, bx, by, w, 18, 5); ctx.fill();
    ctx.strokeStyle = danger ? 'rgba(255,120,90,0.5)' : 'rgba(150,220,255,0.35)';
    roundRect(ctx, bx, by, w, 18, 5); ctx.stroke();
    ctx.fillStyle = danger ? '#ffd9cf' : '#dcefff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, p[0], by + 9.5);
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // particle emission driven by the physics state
  emit(fx, dt, simDt) {
    const p = this.plant, S = this.s, z = this.z;
    const r = this.parts.reactor;
    const rx = S.x + r.x, ry = S.y + r.y;

    // cooling-tower vapour while making power
    if (p.powerFrac > 0.05 && !p.scrammed) {
      for (const t of this.parts.towers)
        fx.steam(S.x + t.x, S.y + t.y, z + 11.7, 4.5, dt, { r: 0.85, grow: 0.5, max: 5.2, rise: 1.9, spread: 1.1, a: 0.20 });
    } else if (p.powerFrac > 0.002) {
      for (const t of this.parts.towers)
        fx.steam(S.x + t.x, S.y + t.y, z + 11.7, 1.2, dt, { r: 0.6, grow: 0.4, max: 3.4, rise: 1.2, spread: 0.9, a: 0.12 });
    }
    // diesel exhaust
    if (!p.grid && p.dieselsOk && p.diesels > 0 && p.acPower) {
      const e = this.parts.edg;
      fx.smoke(S.x + e.x + 1.6, S.y + e.y + 0.5, z + 3.4, 7, dt,
        { r: 0.28, grow: 0.3, max: 3.4, rise: 1.6, col: [58, 54, 52], a: 0.42, spread: 0.9 });
    }
    // passive containment: warm air + steam out of the top diffuser
    if (this.passive && !p.sabotaged && (p.Tctmt > 330 || p.coolingMargin < 1.02)) {
      const inten = clamp((p.Tctmt - 320) / 60, 0.15, 2.2);
      fx.steam(rx, ry, z + 9.0, 5 * inten, dt,
        { r: 0.5, grow: 0.42, max: 4.6, rise: 2.1, spread: 0.5, a: 0.22 });
    }
    // PRHR / relief-valve steam from the active plant's stack + roof
    if (!this.passive && p.scrammed && p.steamToCtmt > 1) {
      fx.steam(rx + 1.2, ry - 1.2, z + 5.6, clamp(p.steamToCtmt * 0.5, 1, 16), dt,
        { r: 0.55, grow: 0.5, max: 4.5, rise: 2.0, spread: 0.8, a: 0.3 });
    }
    // venting / leaking containment
    if (p.vented || !p.ctmtIntact) {
      const st = this.parts.stack;
      fx.steam(S.x + st.x, S.y + st.y, z + (p.explosions > 1 ? 5 : 10.5), 6, dt,
        { r: 0.5, grow: 0.6, max: 6, rise: 2.4, spread: 0.4, col: [214, 224, 210], a: 0.34 });
    }
    // fires
    if (p.fire > 0.15) {
      const sy = this.parts.switchyard;
      fx.fire(S.x + sy.x + 1, S.y + sy.y + 0.5, z + 1.0, 12 * p.fire, dt, { spread: 1.1, r: 0.4 });
      fx.smoke(S.x + sy.x + 1, S.y + sy.y + 0.5, z + 2.0, 12 * p.fire, dt,
        { r: 0.3, grow: 0.3, max: 7, rise: 1.9, col: [32, 29, 31], a: 0.34, spread: 0.8, turb: 0.4 });
    }
    // burning wreckage after an explosion
    if (p.explosions > 0) {
      fx.fire(rx, ry, z + 2.5, 16, dt, { spread: 1.7, r: 0.34 });
      fx.smoke(rx, ry, z + 4.2, 18, dt, { r: 0.42, grow: 0.30, max: 10, rise: 2.6, col: [30, 27, 28], a: 0.34, spread: 1.1, turb: 0.5 });
    }
    if (p.vesselBreach) {
      fx.smoke(rx, ry, z + 1.0, 12, dt, { r: 0.4, grow: 0.34, max: 9, rise: 1.5, col: [62, 52, 46], a: 0.34, spread: 1.2, turb: 0.4 });
    }
    // radioactive plume
    if (p.releaseRate > 1e6) {
      const hot = p.explosions > 0 || !p.ctmtIntact;
      fx.plume(rx, ry, z + (hot ? 6 : 10), p.releaseRate * simDt, dt, hot ? 2.2 : 1.1);
    }
  }

  // explosion visuals
  boom(fx, cam, world, power, kind) {
    const S = this.s, r = this.parts.reactor, z = this.z;
    const x = S.x + r.x, y = S.y + r.y;
    fx.flash(x, y, z + 4, 6 * power, 0.7);
    fx.ring(x, y, z + 1, 9 * power, 9 * power);
    fx.debris(x, y, z + 5, 70 * power, 5.5 * power);
    for (let i = 0; i < 46; i++) {
      fx.smoke(x, y, z + 3 + i * 0.14, 1, 1,
        { r: 0.55, grow: 0.45, max: 13, rise: 3.8, col: [42, 38, 36], a: 0.38, spread: 1.7, turb: 1.5 });
    }
    for (let i = 0; i < 18; i++) fx.fire(x, y, z + 3, 1, 1, { spread: 2.6, r: 0.8 });
    cam.jolt(1.1 * power);
    world.blast(x, y, 5 * power, 0.55 * power);
  }
}
PlantView.explain = true;
PlantView.zoom = 1;

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
