// ---------------------------------------------------------------------------
// plant.js - lumped-parameter severe-accident model for two reactor designs
//
//   ACTIVE  : Gen-II LWR. Decay heat is removed only while *powered* pumps
//             run (offsite grid -> emergency diesels -> DC batteries ->
//             steam-driven RCIC). Every one of those is a single point of
//             failure that a flood, quake or fire can take away.
//   PASSIVE : Gen-III+ LWR (AP1000-class). Decay heat is removed by gravity,
//             natural circulation, condensation and evaporation. No pump, no
//             diesel, no operator action for 72 h.
//
// The physics is kept deliberately transparent: Way-Wigner decay heat,
// latent-heat boil-off, Baker-Just style Zr-H2O oxidation with its 6.5 MJ/kg
// exotherm and hydrogen yield, a saturated-pool containment pressure model,
// and a source term anchored to measured releases (Fukushima ~15 PBq Cs-137
// across three units, Chernobyl ~85 PBq).
// ---------------------------------------------------------------------------
import { clamp, smoothstep } from './util.js?v=e81ec7791c';

export const P0 = 3.4e9;             // 3400 MW thermal (~1100 MWe)
const CORE_ZR = 24000;               // kg zircaloy cladding
const CORE_CP = 1.05e8;              // J/K lumped fuel + clad + internals
const H_FG = 1.9e6;                  // J/kg latent heat at operating pressure
const RPV_WATER = 2.6e5;             // kg water covering the core
const CS137_CORE = 2.6e17;           // Bq Cs-137 in a 1 GWe core (~7 MCi)

export const MODE = { ACTIVE: 'active', PASSIVE: 'passive' };
// Where the top of the fuel sits in the vessel, as a fraction of the water
// inventory. Below this the rods are in steam. The cutaway draws its bundle
// from the same number, so the picture and the state label can never disagree
// about whether the fuel is covered - which they did: the panel said "core
// uncovering" at 96% while the drawing still had the rods well under water.
export const FUEL_TOP = 0.71;

// saturation pressure of water, MPa (fits 100-250 C to a few percent)
const psat = (T) => 0.1 * Math.exp(13.7 - 5120 / T);

export class Plant {
  constructor(mode, name) {
    this.mode = mode;
    this.name = name;
    this.reset();
  }

  reset() {
    const P = this.mode === MODE.PASSIVE;
    this.t = 0;
    this.scrammed = false;
    this.tScram = 0;
    this.powerFrac = 1;
    this.excursion = 0;
    this.rupturedByPower = false;
    this.opDays = 500;

    // --- primary system ---
    this.water = RPV_WATER;
    this.Tcore = 583;
    this.Tclad = 583;
    this.pRPV = 15.5;
    this.level = 1;
    this.zrLeft = CORE_ZR;
    this.leakRate = 0;
    this.steamToCtmt = 0;

    // --- damage state ---
    this.coreDamage = 0;
    this.meltFrac = 0;
    this.vesselBreach = false;
    this.corium = 0;
    this.mcci = 0;
    this.oxidising = 0;
    this.oxWarned = false;

    // --- containment ---
    this.h2 = 0;
    this.h2Building = 0;
    this.pCtmt = 0.101;
    this.Tctmt = 320;
    this.ctmtIntact = true;
    this.ctmtLeak = 0;
    this.vented = false;
    this.ventFailLogged = false;
    this.explosions = 0;
    this.puff = false;

    // --- support systems ---
    this.grid = true;
    this.diesels = P ? 2 : 3;
    this.dieselsOk = true;
    this.battery = 1;
    this.batteryHours = P ? 24 : 8;
    this.pumpsOk = true;
    this.uhs = true;                 // ultimate heat sink (sea / river intake)
    this.rcic = !P;                  // steam-driven turbine pump (Gen-II)
    this.rcicOk = true;
    this.rcicTripped = false;
    this.operators = true;
    this.flooded = 0;
    this.quakeDamage = 0;
    this.fire = 0;
    this.acPower = true;
    this.dcPower = true;

    // --- passive systems ---
    this.prhr = P;
    this.prhrOk = true;
    this.irwstCracked = false;
    this.ctmtSump = P ? 0 : 0;        // kg of water on the containment floor
    this.prhrRunning = false;
    this.cmtLevel = P ? 1 : 0;
    this.accumLevel = 1;
    this.irwst = P ? 2.1e6 : 0;      // kg gravity-injection water
    this.pccwst = P ? 3.0e6 : 0;     // kg containment cooling water film
    this.adsFired = false;
    this.gravityInj = false;
    this.pccs = P;
    this.sabotaged = false;

    // --- accounting ---
    this.releasedBq = 0;
    this.releaseRate = 0;
    this.transmission = 0;
    this.doseSite = 0.0001;
    this.qRemoved = 0;
    this.qDecay = P0;
    this.coolingMargin = 1;
    this.paths = [];
    this.alarms = [];
    this.events = [];
    this.state = 'NORMAL';
    this.stateSince = 0;
  }

  log(msg, kind = 'info') {
    this.events.push({ t: this.t, msg, kind });
    if (this.events.length > 400) this.events.shift();
    this.onLog && this.onLog(msg, kind);
  }

  // A pipe broken by hand (or by anything else) becomes physics, not paint.
  // Each kind maps to the physical consequence that break would actually
  // have, and everything downstream - levels, pressures, temperatures, what
  // the safety systems can still do - follows from the ordinary model step.
  breakPipe(kind) {
    this.broken = this.broken || {};
    if (this.broken[kind]) return false;
    this.broken[kind] = true;
    switch (kind) {
      case 'primary':
        this.leakRate = Math.max(this.leakRate, 45);
        this.scram('primary pipe rupture, loss-of-coolant accident');
        this.log('Primary pipe ruptured. Reactor coolant is escaping into the containment', 'crit');
        break;
      case 'steamline':
        this.scram('main steam line rupture');
        this.log('Steam line severed. The boiler can no longer carry heat to the turbine', 'crit');
        break;
      case 'feedline':
        this.scram('feedwater line rupture');
        this.log('Feed line severed. Nothing is putting water back into the boiler', 'crit');
        break;
      case 'prhr':
        this.prhrOk = false;
        this.log('Passive cooling line severed. The pool can no longer take the heat', 'crit');
        break;
      case 'gravity':
        this.log('Gravity injection line severed. The pool cannot reach the reactor', 'crit');
        break;
      case 'inject':
        this.log('Injection line severed. The backup pump has nowhere to pump', 'crit');
        break;
      case 'cw':
        this.uhs = false;
        this.log('Sea water line severed. ULTIMATE HEAT SINK LOST', 'crit');
        break;
      case 'vent':
        this.ventFailLogged = true;
        this.log('Vent line severed. The containment can no longer be vented on purpose', 'crit');
        break;
    }
    return true;
  }

  scram(reason) {
    if (this.scrammed) return;
    this.scrammed = true;
    this.tScram = this.t;
    this.log(`SCRAM - ${reason}`, 'warn');
  }

  // Way-Wigner decay heat fraction after shutdown
  decayFrac() {
    if (!this.scrammed) return 1;
    const ts = Math.max(1, this.t - this.tScram);
    const t0 = this.opDays * 86400;
    return 0.066 * (Math.pow(ts, -0.2) - Math.pow(ts + t0, -0.2));
  }

  // =====================================================================
  step(dt) {
    this.t += dt;
    const P = this.mode === MODE.PASSIVE;

    // ---- fission power / reactivity excursion --------------------------
    if (this.excursion > 0) {
      // A positive void coefficient turns boiling into more power. A modern
      // light-water core is moderated by its own coolant, so the same
      // insertion is strongly self-terminating.
      const gain = P ? -2.4 : 1.0;
      this.powerFrac = clamp(this.powerFrac + this.excursion * gain * dt * 12, 0, 120);
      this.excursion = Math.max(0, this.excursion - dt * 0.10);
      if (this.powerFrac > 30 && !this.rupturedByPower) {
        this.rupturedByPower = true;
        this.log('POWER EXCURSION - fuel channels rupture, steam explosion', 'crit');
        this.ctmtIntact = false;
        this.coreDamage = Math.max(this.coreDamage, 0.6);
        this.Tclad = Math.max(this.Tclad, 2200);
        this.water *= 0.25;
        this.onSteamExplosion && this.onSteamExplosion();
      }
    } else if (this.scrammed && !this.rupturedByPower) {
      this.powerFrac = this.decayFrac();
    }
    const Pth = P0 * this.powerFrac;
    this.qDecay = Pth;

    // ---- electrical supply ---------------------------------------------
    const dieselAvail = this.dieselsOk && this.diesels > 0 && this.flooded < 1.0
      && this.quakeDamage < 0.85 && this.fire < 0.8;
    const acPower = this.grid || dieselAvail;
    this.acPower = acPower;
    if (!acPower) this.battery = Math.max(0, this.battery - dt / (this.batteryHours * 3600));
    const dcPower = this.battery > 0;
    this.dcPower = dcPower;

    // ---- heat removal ---------------------------------------------------
    this.prhrRunning = false;
    // Everything the cutaway view animates is read from here, so the picture
    // can never disagree with the model.
    const sys = this.sys = {
      rcp: 0, natCirc: 0, feed: 0, aux: 0, rcic: 0, prhr: 0, cmt: 0,
      accum: 0, gravity: 0, sprays: 0, pccs: 0, film: 0, boil: 0, sink: 'none',
      ads: false, vent: false, grid: false, diesel: false, battery: 0
    };
    let q = 0;          // W removed from the primary system
    let qInside = 0;    // of which is dumped *inside* the containment
    let inject = 0;     // kg/s makeup
    this.paths = [];

    const BK = this.broken || {};
    if (!this.scrammed && acPower && this.uhs && this.pumpsOk
      && !BK.steamline && !BK.feedline) {
      q = Pth;
      sys.feed = 1;
      this.paths.push('Main feedwater + condenser');
    } else {
      if (acPower && this.pumpsOk && this.uhs && this.quakeDamage < 0.8
        && !BK.steamline && !BK.feedline) {
        q += Pth * 1.15;
        inject += BK.inject ? 0 : 40;
        sys.aux = 1;
        this.paths.push(P ? 'Normal RHR (non-safety)' : 'Aux feedwater + RHR pumps');
      }
      if (!P) {
        // Gen-II last resort: a steam-driven turbine pump. It needs DC power
        // for its valves and it exhausts into the suppression pool, so it
        // trips itself once that pool gets hot enough.
        if (this.rcic && this.rcicOk && dcPower && this.pRPV > 1.0
          && this.water > 3e4 && this.pCtmt < 0.46) {
          const qr = Math.min(Pth, P0 * 0.02);
          q += qr; qInside += qr;
          inject += 22;
          sys.rcic = 1;
          this.paths.push('RCIC steam-driven pump (on batteries)');
        } else if (this.rcic && this.rcicOk && this.pCtmt >= 0.46 && !this.rcicTripped) {
          this.rcicTripped = true;
          this.log('RCIC trips on high turbine exhaust back-pressure', 'crit');
        }
      }
    }

    // Primary pressure on the Gen-II side. With the relief valves cycling the
    // loop stays near setpoint - which is exactly why the accumulators, set at
    // 4.9 MPa, cannot help: the plant is too *high* pressure for them until
    // something opens the loop. A stuck-open relief valve or a break lets it
    // down, and a breached vessel is at containment pressure by definition.
    if (!P) {
      const tgt = this.vesselBreach ? this.pCtmt
        : this.leakRate > 0.5 ? this.pCtmt
          : this.leakRate > 0 ? 3.2 : 15.5;
      const tau = this.vesselBreach ? 12 : this.leakRate > 0.5 ? 40 : 900;
      this.pRPV += (tgt - this.pRPV) * Math.min(1, dt / tau);
    }

    // Accumulators are passive kit a Gen-II plant already has. They dump on
    // low pressure, empty in about a minute, and then the design is back to
    // needing a running pump.
    if (!P && this.accumLevel > 0 && this.pRPV < 4.9) {
      inject += 55;
      sys.accum = 1;
      this.accumLevel = Math.max(0, this.accumLevel - dt / 620);
      this.paths.push('Accumulators (passive, ~1 min of water)');
    }

    // Ground motion well past the design basis is not something the label
    // "passive" protects you from. The pool and the PRHR line are Seismic
    // Category I, but qualification has a number on it, and past that number
    // these are just a tank and a pipe.
    if (P && this.quakeDamage >= 0.30 && !this.irwstCracked) {
      this.irwstCracked = true;
      this.log('Ground motion cracks the in-containment pool - it is losing water', 'crit');
    }
    if (P && this.quakeDamage >= 0.55 && this.prhrOk) {
      this.prhrOk = false;
      this.log('PRHR heat-exchanger line fails on the shaking - no passive heat path', 'crit');
    }
    if (P && this.irwstCracked) {
      const spill = Math.min(this.irwst, 26 * dt);
      this.irwst -= spill;
      this.ctmtSump += spill;        // onto the floor, still inside the boundary
    }

    if (P && !this.sabotaged) {
      // PRHR heat exchanger: natural circulation to the in-containment tank.
      // Its isolation valve is fail-open, so *losing* power starts it.
      const needPRHR = this.scrammed || !acPower || q < Pth;
      if (needPRHR && this.prhr && this.prhrOk && this.irwst > 1e5) {
        const cap = P0 * 0.020 * clamp(this.Tcore / 583, 0.4, 2.2);
        const qp = Math.min(Math.max(0, Pth * 1.25 - q), cap);
        q += qp; qInside += qp;
        this.prhrRunning = qp > 0;
        sys.prhr = qp > 0 ? Math.max(0.35, Math.min(1, qp / (P0 * 0.02))) : 0;
        // What the heat exchanger boils out of the pool does not leave the
        // building. It condenses on the inside of the cold steel shell and the
        // gutters take it back to the pool. That closed loop is the whole
        // reason the passive plant is quoted in days rather than hours - and
        // it is exactly what a breached containment takes away.
        const boiled = (qp / H_FG) * dt * 0.55;
        const back = this.ctmtIntact && this.pccs && !this.sabotaged ? boiled * 0.94 : 0;
        this.irwst = Math.max(0, this.irwst - boiled + back);
        if (qp > 0) this.paths.push('PRHR HX - natural circulation');
      }
      // Core makeup tanks. Their discharge valves are fail-open air-operated
      // valves: losing power OPENS them, so in a blackout the tanks come into
      // service immediately. While the loop is still full they recirculate -
      // cold water down the injection line, hot water up the balance line -
      // and only drain in earnest once the loop is actually losing inventory.
      const cmtOpen = !acPower || this.water < RPV_WATER * 0.94 || this.pRPV < 12;
      const cmtDraining = this.water < RPV_WATER * 0.97 || this.pRPV < 12;
      if (this.cmtLevel > 0 && cmtOpen) {
        inject += cmtDraining ? 26 : 5;
        sys.cmt = cmtDraining ? 1 : 0.35;
        this.cmtLevel = Math.max(0, this.cmtLevel - dt / (cmtDraining ? 4200 : 34000));
        this.paths.push(cmtDraining
          ? 'Core makeup tanks draining into the vessel (gravity)'
          : 'Core makeup tanks in service, recirculating (gravity)');
      }
      // Automatic depressurisation, then gravity injection
      if (!this.adsFired && (this.water < RPV_WATER * 0.72 || this.cmtLevel < 0.4)) {
        this.adsFired = true;
        this.log('ADS actuates - RPV depressurising so gravity can take over', 'ok');
      }
      if (this.adsFired) this.pRPV = Math.max(0.14, this.pRPV - dt * 0.02);
      if (this.accumLevel > 0 && this.pRPV < 4.9) {
        inject += 60;
        sys.accum = 1;
        this.accumLevel = Math.max(0, this.accumLevel - dt / 900);
        this.paths.push('Nitrogen accumulators');
      }
      // Gravity injection, then gravity recirculation. Once the reactor is
      // depressurised the pool drains into it; what boils off condenses on the
      // containment shell and runs back to the floor, and the same nozzles
      // draw it up again. It only stops when the containment stops holding.
      if (this.pRPV < 0.9 && !(this.broken && this.broken.gravity)) {
        const fromPool = this.irwst > 1e5;
        const fromSump = this.ctmtIntact && this.ctmtSump > 1e5;
        if (fromPool || fromSump) {
          this.gravityInj = true;
          inject += 90;
          sys.gravity = 1;
          if (fromPool) {
            const used = Math.min(this.irwst, 90 * dt);
            this.irwst -= used;
            this.ctmtSump += used * 0.75;      // most of it comes back down
          } else {
            // same closed loop, one storey lower: injected water boils in the
            // vessel, goes out of the depressurisation valves as steam,
            // condenses on the shell and runs back to the floor. What is
            // missing at any instant is the steam in flight, not water lost.
            this.ctmtSump = Math.max(0, this.ctmtSump - 90 * dt * 0.02);
          }
          this.paths.push(fromPool
            ? 'Gravity injection from the pool'
            : 'Gravity recirculation from the containment floor');
        }
      }
      // A breached containment vents the steam instead of condensing it, so
      // the water that used to come back simply leaves.
      if (!this.ctmtIntact) this.ctmtSump = Math.max(0, this.ctmtSump - 55 * dt);
    } else if (P && this.sabotaged) {
      this.paths.push('PASSIVE SYSTEMS DISABLED (what-if)');
    }

    // Where the heat is actually going, which is not the same box in every
    // case: a Gen-III+ plant in a blackout is not using its steam generator at
    // all, it is dumping into the pool inside containment.
    sys.sink = sys.prhr > 0 ? 'pool' : (sys.feed || sys.aux || sys.rcic) ? 'turbine' : 'none';
    // sys.pccs is not known until the containment balance further down; the
    // shell can be the sink on its own, so the answer is finished there.
    this.qRemoved = q;
    this.coolingMargin = Pth > 0 ? clamp(q / Pth, 0, 2) : 2;

    // ---- primary inventory ----------------------------------------------
    const net = Pth - q;
    if (net > 0) {
      this.steamToCtmt = net / H_FG;                       // kg/s boiled off
      this.water = Math.max(0, this.water - this.steamToCtmt * dt);
      if (!this.scrammed) this.scram('heat sink lost');
    } else {
      this.steamToCtmt = Math.max(0, this.steamToCtmt * Math.pow(0.2, dt));
      // Steam condensing back into the vessel only makes water if there is
      // something cool enough to condense on. Ungated, this term refilled a
      // core that had already melted - the level visibly crept back up during
      // a meltdown, which is water appearing out of nowhere.
      if (!this.vesselBreach && this.Tclad < 900) {
        this.water = Math.min(RPV_WATER, this.water + (-net / H_FG) * 0.15 * dt);
      }
    }
    this.water = Math.min(RPV_WATER * 1.02, this.water + inject * dt);
    if (this.leakRate) this.water = Math.max(0, this.water - this.leakRate * dt);
    // A vessel with a hole in the bottom does not hold water. Whatever is
    // injected runs straight through to the cavity floor.
    if (this.vesselBreach) this.water = Math.max(0, this.water - (inject + 60) * dt);

    // ---- core temperature ------------------------------------------------
    const covered = clamp(this.water / (RPV_WATER * 0.55), 0, 1);
    this.level = covered;
    const exposed = 1 - covered;
    let qNet = 0;
    if (exposed > 0.02) {
      qNet += Pth * exposed * 0.92;
      qNet -= 5.5e-8 * 0.75 * 2400 * (Math.pow(this.Tclad, 4) - Math.pow(650, 4)) * 1e-3;
      qNet -= (this.Tclad - 620) * 5.0e3;
    } else {
      this.Tclad += (620 - this.Tclad) * Math.min(1, dt * 0.02);
      this.Tcore += (this.Tclad + 40 - this.Tcore) * Math.min(1, dt * 0.02);
    }

    // ---- Zr + 2H2O -> ZrO2 + 2H2  (+6.5 MJ per kg of Zr) ------------------
    if (this.Tclad > 1100 && this.zrLeft > 0) {
      // The steam supply throttles the reaction once the vessel runs dry, but
      // residual boil-off from the lower plenum keeps it ticking over.
      const steamF = clamp(this.water / 2.0e4, 0.16, 1);
      const rate = Math.min(this.zrLeft / 60,
        2.5e5 * Math.exp(-16000 / this.Tclad) * (0.35 + 0.65 * exposed) * steamF);
      const dZr = Math.min(this.zrLeft, rate * dt);
      this.zrLeft -= dZr;
      this.oxidising = rate;
      qNet += rate * 6.5e6;
      this.h2 += dZr * 0.0442;
      this.water = Math.max(0, this.water - dZr * 0.39);
      if (!this.oxWarned && rate > 0.5) {
        this.oxWarned = true;
        this.log('Zircaloy-steam reaction has started - hydrogen being generated', 'crit');
      }
    } else this.oxidising = 0;

    if (exposed > 0.02 || qNet !== 0) {
      this.Tclad = clamp(this.Tclad + (qNet / CORE_CP) * dt, 400, 3200);
      this.Tcore = this.Tclad + 60 * exposed;
    }

    // ---- damage progression ---------------------------------------------
    if (this.Tclad > 1200) {
      this.coreDamage = clamp(this.coreDamage
        + smoothstep(1200, 2100, this.Tclad) * dt * 0.0016, 0, 1);
    }
    if (this.Tclad > 2500) {
      this.meltFrac = clamp(this.meltFrac
        + smoothstep(2500, 2900, this.Tclad) * dt * 0.0012, 0, 1);
    }
    if (!this.vesselBreach && this.meltFrac > 0.45 && this.water < 2e4) {
      this.vesselBreach = true;
      this.corium = 90000 * this.meltFrac;
      this.log('REACTOR VESSEL FAILS - corium relocates to the cavity', 'crit');
      this.onVesselBreach && this.onVesselBreach();
    }
    if (this.vesselBreach) this.mcci = Math.min(3.5, this.mcci + dt * 2.2e-5);

    // ---- containment ------------------------------------------------------
    // Energy inside the containment boundary: closed-loop heat exchangers
    // (RCIC -> suppression pool, PRHR -> IRWST), boil-off steam through the
    // relief valves, primary leaks, oxidation heat and ex-vessel corium.
    const V = P ? 5.8e4 : 4.2e4;                  // m3 free volume
    const Cctmt = P ? 1.7e10 : 1.05e10;           // J/K pool + shell + air
    const needPCCS = this.scrammed || this.Tctmt > 326 || !acPower || !this.ctmtIntact;
    let qCtmt = qInside + Math.max(0, net) + (this.leakRate || 0) * 1.1e6;
    if (this.vesselBreach) qCtmt += Pth * 0.75;
    if (this.oxidising > 0) qCtmt += this.oxidising * 6.5e6 * 0.35;

    let ctmtRemoval;
    if (P && this.pccs && !this.sabotaged && needPCCS) {
      // steel shell + natural air draught + an evaporating gravity water film
      const film = this.pccwst > 0 ? 1 : 0.42;
      ctmtRemoval = (14e6 + 30e6 * film) * clamp((this.Tctmt - 322) / 55, 0, 1.6);
      sys.pccs = clamp((this.Tctmt - 322) / 55, 0.12, 1.6);
      sys.film = this.pccwst > 0 ? 1 : 0;
      if (this.pccwst > 0) this.pccwst = Math.max(0, this.pccwst - dt * (ctmtRemoval / 2.3e6) * 0.6);
      this.paths.push(this.pccwst > 0
        ? 'PCCS - air draught + gravity water film' : 'PCCS - air-cooled only');
      // With the pool gone the core still boils, the shell still condenses and
      // the water still comes back. Calling that "no heat sink" was wrong: the
      // sink is the outside air, through the steel.
      if (sys.sink === 'none' && this.ctmtIntact && this.level > 0.45) sys.sink = 'shell';
    } else if (acPower && this.uhs) {
      ctmtRemoval = 34e6 * clamp((this.Tctmt - 315) / 40, 0, 1.4);
      sys.sprays = clamp((this.Tctmt - 315) / 40, 0.15, 1.4);
      this.paths.push('Containment sprays / fan coolers');
    } else {
      ctmtRemoval = 1.2e6;      // conduction through the shell, and that is all
    }
    this.qCtmtIn = qCtmt; this.qCtmtOut = ctmtRemoval;
    this.Tctmt = clamp(this.Tctmt + ((qCtmt - ctmtRemoval) / Cctmt) * dt, 300, 900);

    const pH2 = (this.h2 / 0.002) * 8.314 * this.Tctmt / (V * 1e6);
    this.pCtmt = 0.101 * (this.Tctmt / 300) + psat(this.Tctmt) - 0.0035 + pH2;
    if (!this.ctmtIntact) this.pCtmt = Math.min(this.pCtmt, 0.13);

    // design pressure ~0.45 MPa; realistic ultimate capacity roughly twice that
    const pFail = P ? 1.05 : 0.84;
    if (this.ctmtIntact && this.pCtmt > pFail * 0.72 && !this.vented && !P) {
      if (this.operators && dcPower && !(this.broken && this.broken.vent)) {
        this.vented = true;
        this.log('Hardened vent opened - a deliberate release to save the containment', 'crit');
        this.ctmtLeak = Math.max(this.ctmtLeak, 3e-4);
      } else if (!this.ventFailLogged) {
        this.ventFailLogged = true;
        this.log('Vent valves cannot be opened - no power, no air, no access', 'crit');
      }
    }
    if (this.vented) {
      this.Tctmt = Math.min(this.Tctmt, 418);
      this.pCtmt = Math.min(this.pCtmt, pFail * 0.68);
    }
    if (this.ctmtIntact && this.pCtmt > pFail) {
      this.ctmtIntact = false;
      this.ctmtLeak = 2.5e-3;
      this.log('CONTAINMENT OVERPRESSURE FAILURE - a direct path to the atmosphere', 'crit');
      this.onContainmentFail && this.onContainmentFail();
    }

    // ---- hydrogen migration and deflagration ------------------------------
    if (this.h2 > 0) {
      // An intact, sub-design-pressure containment holds its hydrogen. The
      // leak path opens when it is over-pressurised, vented (this is how
      // Fukushima filled its reactor buildings) or already broken.
      let leakK;
      if (!this.ctmtIntact) leakK = 4e-3;
      else if (this.vented) leakK = 2.6e-4;
      else leakK = 1e-7 + 5e-5 * clamp((this.pCtmt - 0.45) / 0.3, 0, 1);
      const leak = this.h2 * leakK * dt;
      this.h2 -= leak;
      this.h2Building += leak * (P ? 0.15 : 1.0);
      // AP1000-class designs carry passive autocatalytic recombiners and an
      // enormous free volume. A Mark-I reactor building had neither.
      if (P) this.h2Building = Math.max(0, this.h2Building - dt * 0.02);
    }
    const h2Limit = P ? 420 : 110;
    if (this.h2Building > h2Limit && this.explosions < 3) {
      this.explosions++;
      this.h2Building = 0;
      this.log('HYDROGEN EXPLOSION - reactor building blown apart', 'crit');
      this.ctmtIntact = false;
      this.ctmtLeak = Math.max(this.ctmtLeak, 4e-3);
      this.puff = true;
      this.onExplosion && this.onExplosion(this.explosions);
    }

    // ---- source term ------------------------------------------------------
    // Two questions decide a release: how much caesium has left the fuel, and
    // how many intact barriers stand between it and the wind.
    const gap = smoothstep(0.02, 0.30, this.coreDamage) * 0.06;
    const inVessel = smoothstep(0.25, 0.95, this.coreDamage) * 0.58;
    const exVessel = this.vesselBreach ? Math.min(0.22, this.mcci * 0.08) : 0;
    const mobile = clamp(gap + inVessel + exVessel, 0, 0.86);

    let trans;
    if (this.rupturedByPower) trans = 0.40;       // core blown open, no containment
    else if (this.explosions > 0) trans = 0.055;
    else if (!this.ctmtIntact) trans = 0.030;
    else if (this.vented) trans = 0.008;          // pool-scrubbed release
    else trans = 6e-5;                            // design leakage
    if (P) trans *= 0.40;                         // bigger volume, IRWST scrubbing, PARs
    this.transmission = trans;

    const target = CS137_CORE * mobile * trans;
    this.releaseRate = Math.max(0, target - this.releasedBq) / 18000;
    if (this.puff) {                              // prompt puff from a deflagration
      this.puff = false;
      const extra = Math.max(0, target - this.releasedBq) * 0.28;
      this.releasedBq += extra;
      this.releaseRate += extra / 12;
    }
    this.releasedBq += this.releaseRate * dt;
    this.doseSite = 0.0001 + this.releaseRate * 3.0e-13
      + this.coreDamage * 0.02 * (this.ctmtIntact ? 0.01 : 1);

    // reactor coolant pumps, or the natural circulation that replaces them
    sys.rcp = (acPower && this.pumpsOk && this.quakeDamage < 0.8)
      ? (this.scrammed ? 0.55 : 1) : 0;
    if (!sys.rcp && this.level > 0.9 && this.water > 1e5) sys.natCirc = 0.3;
    sys.boil = Math.min(1, (this.steamToCtmt || 0) / 40);
    sys.ads = this.adsFired;
    sys.vent = this.vented;
    sys.grid = this.grid;
    sys.diesel = dieselAvail && !this.grid;
    sys.battery = this.battery;

    // ---- state label ------------------------------------------------------
    // Evaluated fresh every step in severity order, so the plant can never get
    // stuck describing itself as "recovered" while its core is on the floor.
    let st;
    if (this.rupturedByPower) st = 'CORE DESTROYED';
    else if (this.vesselBreach) st = 'VESSEL BREACH';
    else if (this.explosions > 0) st = 'HYDROGEN EXPLOSION';
    else if (this.meltFrac > 0.01) st = 'FUEL MELTING';
    else if (this.coreDamage > 0.01) st = 'CORE DAMAGE';
    else if (!this.ctmtIntact) st = 'CONTAINMENT FAILURE';
    else if (this.level < FUEL_TOP) st = 'FUEL UNCOVERED';
    else if (this.level < 0.97) st = 'LOSING WATER';
    else if (this.Tclad > 700) st = 'CORE HEATING UP';
    else if (!acPower) {
      // Boiling water off and replacing it by gravity is cooling. The margin
      // only measures heat taken out of the loop, so on its own it called a
      // stable, full, covered core a blackout emergency.
      const holding = this.coolingMargin >= 0.99
        || (this.ctmtIntact && this.level > 0.97 && (sys.gravity || sys.cmt));
      st = (P && holding && !this.sabotaged) ? 'SAFE - PASSIVE COOLING' : 'STATION BLACKOUT';
    } else if (!this.uhs && !P) st = 'ULTIMATE HEAT SINK LOST';
    else if (this.coolingMargin < 0.98) st = 'DEGRADED COOLING';
    else if (this.scrammed) {
      st = (P && (this.adsFired || this.gravityInj || this.prhrRunning))
        ? 'SAFE - PASSIVE COOLING' : 'SHUT DOWN - STABLE';
    } else st = 'NORMAL';
    this.setState(st);

    // ---- alarms -----------------------------------------------------------
    this.alarms = [];
    if (!acPower) this.alarms.push('LOSS OF AC POWER');
    if (!dcPower && !acPower) this.alarms.push('BATTERIES EXHAUSTED');
    if (this.level < 0.95) this.alarms.push('LOW RPV LEVEL');
    if (this.Tclad > 1100) this.alarms.push('HIGH CLAD TEMP');
    if (this.h2 > 20) this.alarms.push('HYDROGEN IN CONTAINMENT');
    if (this.pCtmt > 0.4) this.alarms.push('HIGH CONTAINMENT PRESSURE');
    if (this.releaseRate > 1e8) this.alarms.push('RADIOLOGICAL RELEASE');
    if (!this.uhs) this.alarms.push('ULTIMATE HEAT SINK LOST');
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateSince = this.t;
    this.log(`STATE: ${s}`, /SAFE|STABLE|NORMAL/.test(s) ? 'ok' : 'crit');
  }

  // INES level estimated from released activity and damage
  ines() {
    const pbq = this.releasedBq / 1e15;
    if (pbq > 40) return 7;
    if (pbq > 4) return 6;
    if (pbq > 0.4) return 5;
    if (this.vesselBreach || this.coreDamage > 0.5) return 5;
    if (pbq > 0.005 || this.coreDamage > 0.05) return 4;
    if (this.coreDamage > 0.001 || this.explosions) return 3;
    if (!/NORMAL|SAFE|STABLE/.test(this.state)) return 2;
    return 0;
  }

  // Consequences, anchored on Fukushima (15 PBq) and Chernobyl (85 PBq)
  consequences() {
    const pbq = this.releasedBq / 1e15;
    const land = Math.pow(pbq, 0.92) * 120;        // km2 above 555 kBq/m2
    const evac = Math.pow(pbq, 0.85) * 13500;      // people displaced
    const cost = Math.pow(pbq, 0.75) * 32;         // billion USD
    const collective = pbq * 2600;                 // person-Sv, order of magnitude
    const cancers = collective * 0.05;             // LNT, model-dependent
    const acute = (this.explosions > 0 && this.coreDamage > 0.5)
      ? Math.round(2 + this.explosions * 6
        + (this.mode === MODE.ACTIVE ? 20 : 0) * this.meltFrac) : 0;
    const exclusionR = Math.pow(pbq, 0.35) * 8.5;  // km
    return { pbq, land, evac, cost, collective, cancers, acute, exclusionR };
  }
}
