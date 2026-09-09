// ---------------------------------------------------------------------------
// hydro.js - the fluid library's solver, running under the station.
//
// Day one of the migration (HANDOFF, "Using the library"): the library's
// Solver runs on the station network every frame with EVERY flow and every
// leg temperature held to what the sim's own flow.js just decided, so it
// reads the same picture the sim draws and cannot change it. Nothing is read
// back yet. What this buys is the solver running in the real frame loop, on
// the real dt, at the real cost, with report counters to look at; the
// releases (sea first, primary next, secondary once the plant's controls
// drive it) each replace one circuit's numbers with the solver's.
//
// The network is assets/network.json, written by tools/network.mjs from the
// layout. Each unit gets its own Network and Solver (the two units are two
// plants). Any failure disables this quietly: the app never depended on it.
// ---------------------------------------------------------------------------
import { THERMAL_W } from '../flow.js?v=d7d0f53269';
import { Network, Solver, props } from '../../vendor/fluidsim/core/index.js?v=d7d0f53269';

let netJson = null;

// the network as loaded, for a renderer that draws it
export function networkJson() { return netJson; }
// The network for ONE design. Elements tagged design: 'passive' or 'active'
// in the JSON belong to that unit alone (the pool loop and the gravity line
// to the passive, the tank and the injection to the active) and are DROPPED
// for the other, runs and heat links included. They used to be kept and shut
// by their valves, which left the active unit a shut pool loop standing 17 m
// above a vessel that a breach had dropped to atmospheric pressure: its
// junction sat on the pressure floor for hours (1890 steps of a LOCA not
// converging, 1.5 million kg adrift). A unit has the lines it has.
export function networkFor(json, design) {
  if (!json) return json;
  const keep = (x) => !x.design || x.design === design;
  const edges = (json.edges || []).filter(keep), edgeIds = new Set(edges.map((e) => e.id));
  return Object.assign({}, json, {
    nodes: (json.nodes || []).filter(keep),
    edges,
    devices: (json.devices || []).filter((d) => keep(d) && (!d.edge || edgeIds.has(d.edge))),
    heat: (json.heat || []).filter(keep),
    runs: (json.runs || []).filter(keep).map((r) => Object.assign({}, r, { edges: (r.edges || []).filter((id) => edgeIds.has(id)) })).filter((r) => r.edges.length)
  });
}
export async function loadNetwork(base = '') {
  if (netJson) return netJson;
  const r = await fetch(base + 'assets/network.json');
  netJson = await r.json();
  const fv = (netJson.devices || []).find((d) => d.id === 'feed_valve');
  if (fv && Number.isFinite(fv.open) && fv.open > 0) FV_OPEN0 = fv.open;
  return netJson;
}

// The sim's legs and circuits, and the edges of the network they stand for.
// One drawn leg may be several edges (the cold leg is cold + coldB; the sea
// leg is four runs). Circuits carry the mass flow; legs carry T0 and T1.
const EDGES = [
  ['primary', 'legHot', ['hot']], ['primary', 'legTubes', ['sg_tubes']], ['primary', 'legCold', ['cold', 'coldB']],
  ['secondary', 'legSteam', ['steam', 'exhaust']], ['secondary', 'legFeed', ['feed', 'feed_out', 'feed_in', 'downcomer']], ['secondary', 'legCond', ['cond_suct']],
  ['cw', 'legCw', ['cw_suct', 'cw_disch', 'cond_tubes', 'cw_out']],
  ['prhr', 'legPrhrUp', ['prhr_up']], ['prhr', 'legCoil', ['coil']], ['prhr', 'legPrhrDn', ['prhr_down']],
  ['gravity', 'legGrav', ['gravity']], ['fillC', 'legFill', ['fill']],
  ['inject', 'legSuct', ['suction']], ['inject', 'legInj', ['injection']],
  ['ventCircuit', 'legVent', ['vent']]
];
const K = 273.15;
// The pressures the plant model owns, held on the solver's vessels every
// frame (day one holds what the plant knows): the primary from the plant's
// pRPV (MPa), the boiler shell at its fixed 70 bar, the condenser at its
// vacuum, the open vessels at the building's pressure. A closed pressuriser
// left to itself loses pressure as its steam condenses (nothing here is its
// heaters), and over the plant's accelerated hours the held hot leg then
// flashes: the pressure was wrong before the velocity was.
// Two seconds a step, not the library's ten: at ten a closed vessel under a
// pressure hold gains mass (reported to the library, defect A); at two it
// gains an eighth of that, and the level hold below corrects the rest.
// The solver steps in FIXED quanta of STEP plant seconds, at most
// STEPS_PER_FRAME a frame, whatever the plant's speed: plant time
// accumulates between frames and a step is taken whenever a quantum has
// gathered. It used to step min(STEP, the frame's plant dt), so at real
// time it stepped at the frame's 0.03 s, and the library has measured
// (its C29) that a released primary at steps under half a second boils
// the vessel dry inside ten plant minutes while at 2 s it is steady; the
// app's probes had all been at the default speed, where a frame is 2 s of
// plant time or more. At real time the flows now update every two real
// seconds, which nothing in the plant outruns. The backlog is capped so a
// jump to top speed cannot queue an hour of steps.
// ONE step a frame since the library's 4b91306 (the worked exhaust edge is
// sub-stepped now and a governed step costs 370 us here against 134): at
// two steps a frame the solver added 2 ms mean and 3.7 ms at p90 to the
// frame gaps (tools/perf.mjs, both units); the price of one is lag at top
// speed, where the solver already runs far behind the plant clock.
const STEP = 2, STEPS_PER_FRAME = 1, BACKLOG_MAX = STEP * 4;
// Sub-cycles per step. The library measured, on this station at 10 s
// steps, one sub-step against eight as a factor of three in cost and four
// tenths of a kelvin on the tube outlet; two is the trade taken here.
// The sub-step cap, the library's own default. It was 2 here for cost, and
// that cap was binding: the station asks for 48 sub-steps a step (the
// turbine takes 2.7 GW out of 5.4 t of steam, 240 K of the edge's own
// contents in a 2 s step), and at 2 the vessel sat at 593.7 K with the
// exhaust on the enthalpy floor, at 4 597.6 K, at 8 599.8 K with the
// exhaust at 353 K (tools/network.mjs --maxsub). At one step a frame the
// cost is 0.46 ms a step a unit here, inside the frame budget.
// EIGHT AGAIN, and the exhaust converges anyway: the library's C28 (its
// 885a895) showed the exhaust's 1.70 energy ratio was this cap, not its work
// term (the exhaust left at 350.2 K under 8, 381.7 under 16, 400.7 under
// 32, 414.2 from 128 upward), and in the app 32 cost 1.5 to 1.8 ms a step a
// unit and put the frame at 9.6 ms mean against 5.6. Its bc70714 sub-cycles
// PER EDGE (an edge that may go alone takes its own finer steps inside one
// network sub-step and hands over the mean slug): the worked exhaust edge
// asked for 96 while the whole rest of the station asked for 8, and it now
// leaves at 414.1 K at this cap for eight per cent on the step headless.
// report.subWanted, subCapped, subWantedBy and subWantedWhy say what the
// cap is doing (health.mjs).
const MAX_SUB = 8;
// The circuits the solver owns. Released one at a time, sea first: its
// flow comes from its pump's curve against the network, its temperatures
// from the sea and the condenser's exchanger, and the sim's leg is written
// from the solver instead of from flow.js. ?hydro=hold holds everything
// again (day one), for a comparison capture.
const ALL = ['cw', 'primary', 'secondary', 'prhr', 'gravity', 'fillC', 'inject', 'ventCircuit'];
// ?hskip=pool,tank,sump,cont,surge,level,shut,vapt drops one of the app's
// holds, for bisecting a solver failure against the harness (debug only)
const HSKIP = new Set((() => { try { return (new URLSearchParams(location.search).get('hskip') || '').split(',').filter(Boolean); } catch (e) { return []; } })());
// ?trace=n records every nth step in the trace ring (8 by default; 1 to see the
// first minutes step by step, debug only)
const TRACE_EVERY = (() => { try { return Math.max(1, Number(new URLSearchParams(location.search).get('trace')) || 8); } catch (e) { return 8; } })();
const RELEASED = new Set((() => {
  try {
    const q = new URLSearchParams(location.search).get('hydro');
    return q === 'hold' ? [] : q === 'sea' ? ['cw'] : q === 'primary' ? ['cw', 'primary'] : q === 'secondary' ? ['cw', 'primary', 'secondary'] : ALL;
  } catch (e) { return ALL; }
})());
// the sim draws the sea's rise amplified, so ten degrees show at all
const CW_DRAWN_GAIN = 10;
// the condenser's vacuum: 40 C of condensate is 7.4 kPa
const P_COND = 7400;
// The secondary's energy per kilogramme (tools/network.mjs SEC, kept in
// step): 70 bar saturated steam at 2772 kJ/kg, feed the plant's heaters
// would bring to 975 (they are not in the network yet: the boiler is held
// by the plant model, so the feed goes in at the condenser's 40 C and the
// books are the plant's), condensate at 168. The plant's steam demand is
// its secondary heat over the first difference (1892 kg/s at 3.4 GW); the
// turbine takes everything the condenser does not reject (2.2 GW at
// rated), which is the turbine's own 1.1 GW and the extraction steam that
// would have fed the heaters.
const H_STEAM = 2772e3, H_FEED_HOT = 975e3, H_COND = 168e3, COND_W = 2200e6;
const STEAM_RATED = THERMAL_W / (H_STEAM - H_FEED_HOT);
// the feed valve's opening at rated flow: the network's seed (settled headless)
let FV_OPEN0 = 0.393;
const DH_TURB = H_STEAM - (H_COND + COND_W / STEAM_RATED);
// the governor: the turbine's drop is a slow integral of the flow error (a
// bar a second per unit) plus a small proportional term (bar per unit)
const GOV_KI = 0.3e5, GOV_KP = 0.2e5;
// the condensate pump: its speed from the boiler's level (per metre short,
// proportional and integral per second) and the level's RATE (per metre per
// second, a falling level asks for more); never from an edge's flow, which
// chased itself once the library published the honest mean of a line that
// chatters (a shut sub-step lowers the mean, the pump pushes harder)
const CP_KP_LEVEL = 0.04, CP_KI_LEVEL = 0.0015, CP_KD_LEVEL = 1.5;
// THE LAW DRIVES THE FEED REGULATING VALVE (feed_valve on feed_in); the
// pump runs at CP_SPEED whenever the plant carries heat through its
// secondary and stops otherwise. It drove the pump's speed once: below 0.8
// the pump's shut-off head could not hold the boiler's back-pressure, and
// at 0.8 it still pushed 1800 kg/s where decay heat needs 213, so the
// boiler overfilled and the hotwell drained to its nozzle. The valve's
// opening has a FEED-FORWARD from the steam leaving the boiler (the hotwell
// holds five seconds of rated flow, so the feed must follow the steam
// within seconds; the steam is the governor's doing, not the feed's, so
// this cannot chase itself), and the law holds the boiler's INVENTORY
// (riser plus downcomer, in metres-equivalent at 12 t a metre of
// waterline) rather than its mixture level, which shrinks four metres at
// decay heat with the mass unchanged. The integrator holds while the
// suction is starved or the valve is at a stop (anti-windup).
const CP_SPEED = 0.87, FV_MIN = 0.01, SG_T_PER_M = 12000;
// (The steam flow the picture is given used to be smoothed over a second,
// because with every device frozen the solver's steam flow alternated
// fifteen per cent step to step. That was the turbine's work term landing
// on whatever water was resident and swinging the line feeding it; the
// library's 3b4f088 marked the loss device's edge as a worked edge and the
// flow is flat to the kilogramme since. The picture draws the flow as it
// comes.)

// What every edge holds on day one, in kelvin, from the network's own nodes:
// the temperature of the node it leaves, end to end, because a pipe with
// nothing to warm it is at one temperature; an edge with a heat link ramps
// from the node it leaves to the node it reaches. (The solver starts every
// edge at the schema's 15 C whatever its nodes say; freed at once, the loop
// poured sea-cold water into a 333 C vessel and took ten plant minutes to
// warm back. Asked of the library; seeded here until it does it itself.)
function dayOne(net) {
  const T = new Map();
  for (const n of net.nodes || []) T.set(n.id, (Number.isFinite(n.T) ? n.T : 15) + K);
  const linked = new Set();
  for (const h of net.heat || []) for (const k of ['on', 'hot', 'cold']) {
    const m = /^edge:(.+)$/.exec(h[k] || ''); if (m) linked.add(m[1]);
  }
  const seed = new Map();
  for (const e of net.edges || []) {
    const T0 = T.get(e.from), T1 = linked.has(e.id) ? T.get(e.to) : T0;
    if (Number.isFinite(T0) && Number.isFinite(T1)) seed.set(e.id, { T0, T1 });
  }
  return seed;
}

export class Hydro {
  constructor(unit) {
    this.unit = unit;
    this.ok = false;
    this.failed = null;
    this.ms = 0;         // the last step's cost, for the settings panel
    this.steps = 0;
    try {
      this.json = networkFor(netJson, unit.passive ? 'passive' : 'active');
      this.net = Network.fromJSON(this.json);
      this.solver = new Solver(this.net, { clock: () => performance.now(), maxSub: MAX_SUB });
      // the edges that exist in this network, by the sim's names
      this.map = [];
      for (const [circuit, leg, ids] of EDGES) {
        if (!unit[circuit] || !unit[leg]) continue;
        const edges = ids.filter((id) => this.net.edge(id));
        if (edges.length) this.map.push({ circuit, leg, edges });
      }
      this.ok = this.map.length > 0;
      this.seed = dayOne(this.json);
      this.vapour = new Set((this.json.edges || []).filter((e) => e.fluid === 'steam').map((e) => e.id));
      // a box volume's level for a fraction of the water it starts with
      const boxLevel = (id) => {
        const n = (this.json.nodes || []).find((x) => x.id === id);
        if (!n || !n.shape || n.shape.kind !== 'box') return null;
        const y0 = n.shape.y0, h = n.shape.h, fill = Number.isFinite(n.fill) ? n.fill : 0.5;
        return (f) => y0 + h * fill * Math.max(0, Math.min(1, f));
      };
      this.lvlPool = boxLevel('pool');
      this.lvlTank = boxLevel('tank');
      // The lines of the design this unit does not have are shut by their
      // VALVES (the pool loop's isolation valve, the gravity valve, the
      // injection valve, all authored shut), which is enough: they used to
      // be held at zero flow here as well, from the day the pool loop ran
      // free at 676 kg/s in the active unit before it had a valve, and on
      // the library's check-valve retry build a dead-end line held at zero
      // flow sent the active unit's condensate pump onto its pressure floor
      // every twentieth step and drained its boiler (bisected in the app
      // with ?hskip=shut). A hold on a line a valve already shuts is a
      // second answer to the same question.
    } catch (e) {
      this.failed = e;
      console.warn('hydro: solver not started', e);
    }
  }

  // Hold every edge to what the sim decided this frame, and every vessel to
  // the pressure the plant model gives it, then step. The sim's temperatures
  // are in C; the solver's are kelvin. The plant's dt can be up to 32 s of
  // plant time a frame at top speed; the solver steps at most twice at its
  // 10 s ceiling and lags the rest (stepping longer goes wrong, stepping
  // more often costs frame time; this is the compromise until a circuit
  // that is released needs better).
  frame(dt, st) {
    if (!this.ok) return;
    const u = this.unit, s = this.solver, p = u.plant;
    // DAY ONE IS THE PLANT'S FIRST TICK, not the page's first frame. On the
    // first frame the plant has not set its systems yet (feed 0, qSec 0), so
    // the secondary was seeded at ZERO flow and released from rest a step
    // later: 8743 kg/s of steam into the condenser in one step, the pump's
    // junction at its bound for five unconverged steps that booked 25 t of
    // water into the hotwell, which then sat two rows up the tube bank.
    if (this.steps === 0 && !(p && p.t > 0)) return;
    try {
      const pPri = Number.isFinite(p.pRPV) ? p.pRPV * 1e6 : 155e5;
      const pBld = Number.isFinite(p.pCtmt) ? p.pCtmt * 1e6 : 101325;
      if (this.net.node('sump') && !HSKIP.has('sump')) s.impose('sump', { p: pBld });
      // The pool's water is the plant's (p.irwst, boiled and spilt by the
      // plant model); the tank's the sim never drains in the picture; both
      // held at their levels so the solver's draining cannot part from
      // what is drawn. The building's steam is steam: a boundary held at a
      // pressure must sit above its saturation there or it is water (at
      // 102 C under 1.5 bar the vent line filled with water).
      // (the pool's LEVEL is held only where the unit has a pool to drain:
      // the active unit's pool has no water in the plant, and a volume held
      // at zero water sent the solver's condensate pump onto its pressure
      // floor every twentieth step; its lines are shut, so its pressure is
      // all it needs)
      if (HSKIP.has('pool')) { /* dropped for the bisect */ }
      else if (this.lvlPool && u.gravity) s.impose('pool', { p: pBld, level: this.lvlPool(Number.isFinite(p.irwst) ? Math.max(0, Math.min(1, p.irwst / 2.1e6)) : 1) });
      else if (this.net.node('pool')) s.impose('pool', { p: pBld });
      if (this.lvlTank && !HSKIP.has('tank')) s.impose('tank', { p: pBld, level: this.lvlTank(1) });
      if (this.net.node('cont') && !HSKIP.has('cont')) s.impose('cont', { p: pBld, T: props.tsat(pBld) + 2 });
      // The pressuriser holds the plant's pressure, and its surge line is
      // held at zero flow: in normal operation it carries nothing, and left
      // free between two pressure holds it drained the pressuriser into the
      // boiler head and painted the hot leg as warming along its length.
      // (Holding the pressuriser's level instead superheated it.)
      if (this.net.node('przr')) s.impose('przr', { p: pPri });
      if (!this.surgeHeld && this.net.edge('surge') && !HSKIP.has('surge')) { s.imposeFlow('surge', 0); this.surgeHeld = true; }
      // The vessels whose state the plant model owns hold pressure AND what
      // the plant says of them: the reactor's level (so the hot leg can
      // uncover in an accident), the boiler saturated at 70 bar, the
      // condenser at 40 C under its vacuum. Left to the solver with the
      // secondary's flows held, the shell cooled and the bank drained the
      // primary through an exchanger with a cold shell.
      // The reactor's level is held only while the plant says it is
      // falling. Held at full, the hold fought the solver's own (closed,
      // steady) inventory with hundreds of kilograms of makeup a step and
      // that makeup cooled the vessel eleven kelvin.
      // ...and held to it whenever the solver's own level has wandered
      // more than 0.3 m from the plant's (released again within 0.1 m), so
      // the makeup that corrects it fires now and then rather than every
      // step, and its cooling stays small.
      // The reactor's level is the plant's, and it is held ALL the time. It
      // used to be held with hysteresis (engaged when the solver's level had
      // wandered 0.3 m from the plant's, released within 0.1 m), and that
      // engaged for ONE step at boot (the authored fill sits 0.4 m under the
      // plant's level at day-one temperature), then released; a level hold
      // applied for a step and released leaves the vessel in a state the
      // library cannot repair (its C25), and on its 488aee9 that one step
      // sent the condensate line into a reversal the check-valve retry never
      // recovered from: the active unit's boiler drained to nothing in three
      // minutes. Held continuously the makeup is thirty kilogrammes a step
      // and every step converges, on both builds.
      const lvl = st && Number.isFinite(st.lvl) ? st.lvl : 1;
      if (this.net.node('rpv') && u.waterLevelY) {
        if (HSKIP.has('level')) s.impose('rpv', { p: pPri }); else s.impose('rpv', { p: pPri, level: u.waterLevelY(lvl) });
        this.levelHeld = true;
      }
      // the boiler, its downcomer and the condenser are held ONCE (their
      // holds never change): re-imposed every frame, the condenser's hold
      // made up twenty-five tonnes of water in the first eight steps (1.1 t
      // a step at step 8, decaying to nothing by step 90) and the hotwell
      // rose from 2.8 to 4.2 m; imposed once, as the harness does, nothing
      if (!this.vesselsHeld) {
        this.vesselsHeld = true;
        if (this.net.node('sg')) s.impose('sg', { p: 70e5, T: props.tsat(70e5) });
        // the downcomer shares the shell's pressure; its water is the feed's
        if (this.net.node('sg_down')) s.impose('sg_down', { p: 70e5 });
        if (this.net.node('cond')) s.impose('cond', { p: P_COND, T: props.tsat(P_COND) });
      }
      // THE SECONDARY AFTER A TRIP. While the plant carries heat through it
      // and has a condenser (power and a heat sink), the steam goes to the
      // condenser at whatever the plant demands. Otherwise the steam line is
      // ISOLATED (the isolation valves shut on a blackout) and the boiler's
      // holds stay as they are: held at pressure and saturation with the line
      // OPEN it made steam as its level fell, dried in minutes and put seven
      // thousand tonnes of it into the condenser; held at pressure alone (a
      // relief, the honest boil-off) its riser and downcomer, both at 70 bar
      // with nothing to damp them, sloshed sixty tonnes back and forth every
      // sixteen seconds and the downcomer overfilled. The plant model has no
      // boiler dry-out story, so the boiler sits at its holds, its level put.
      if (RELEASED.has('secondary') && this.steps > 0 && this.net.edge('steam')) {
        const isolated = !this.carrying(st) || !(p.uhs && p.acPower);
        if (isolated !== !!this.isolated) {
          this.isolated = isolated;
          // the boiler's own circulation is frozen with it: with no feed and
          // no steam the split of its water between riser and downcomer has
          // nothing to pin it (both at 70 bar, equal levels a neutral
          // equilibrium), and the solver drifted sixty tonnes into the
          // downcomer over a blackout, a thousand steps not converging
          for (const id of ['steam', 'exhaust', 'downcomer', 'recirc']) if (this.net.edge(id)) s.imposeFlow(id, isolated ? 0 : null);
        }
      }
      for (const { circuit, leg, edges } of this.map) {
        const c = u[circuit], l = u[leg];
        if (RELEASED.has(circuit)) {
          if (!this.freed) this.freed = new Set();
          if (this.steps === 0) {
            // day one: the circuit runs at the sim's flow and its pipes
            // hold their steady temperatures for ONE step, so the loop is
            // freed running and warm rather than started from sea-cold rest
            // (the secondary at the network's own rated flow: the sim's
            // 2267 kg/s is a drawing number, 3.4 GW over its 1.5 MJ/kg)
            const mdot0 = circuit === 'secondary' ? this.steamDemand(st) : Number.isFinite(c.mdot) ? c.mdot : 0;
            // (a vapour's temperature is its pressure's: no temperature seed
            // on a steam line, as the harness never had; seeded, the active
            // unit failed the same way on the retry build, ?hskip=vapt)
            for (const id of edges) { s.imposeFlow(id, mdot0); const sd = this.seed.get(id); s.imposeEdgeT(id, sd && !this.vapour.has(id) ? sd : null); }
          } else {
            for (const id of edges) if (!this.freed.has(id)) { s.imposeFlow(id, null); s.imposeEdgeT(id, null); this.freed.add(id); }
          }
          continue;
        }
        const mdot = Number.isFinite(c.mdot) ? c.mdot : 0;
        // A vapour leg's temperature is not the sim's to state (its steam is
        // whatever the shell makes), and a leg the sim never gave a
        // temperature (T0 at zero) is left to the solver's own transport:
        // holding 0 C on a condensate line once froze the boiler.
        const holdT = l.kind !== 'steam' && Number.isFinite(l.T0) && l.T0 > 1 && Number.isFinite(l.T1) && l.T1 > 1;
        const T0 = holdT ? l.T0 + K : 0, T1 = holdT ? l.T1 + K : 0;
        for (const id of edges) {
          s.imposeFlow(id, mdot);
          s.imposeEdgeT(id, holdT ? { T0, T1 } : null);
        }
      }
      // the released circuits' drivers, from the plant's state
      if (RELEASED.has('cw')) {
        const pump = s.pump('cwpump');
        if (pump) pump.cmd = (p.uhs && (u.qSec || 0) > 0) ? 1 : 0;
      }
      if (RELEASED.has('primary')) {
        // the pump at the speed the plant runs it, the core's heat as the
        // plant makes it (full power while the boiler is fed, decay heat
        // after); with the pump off the loop runs on the solver's buoyancy
        const rcp = s.pump('rcp');
        if (rcp) rcp.cmd = st ? Math.max(0, Math.min(1, st.s.rcp || 0)) : 1;
        const q = st ? ((st.s.feed || 0) > 0 ? THERMAL_W : (p.qDecay || 0)) : THERMAL_W;
        s.heat('core', q);
      }
      if (RELEASED.has('secondary') && this.steps > 0) this.governSecondary(dt, st);
      // The accident lines: each valve follows the plant's own decision, as
      // the sim's setFlow() did, and the solver finds the flow (the pool
      // loop on its buoyancy, the pool on its head, the pump on its curve).
      if (st) {
        const sys = st.s || {};
        const cmd = (id, on) => { const d = s.device(id); if (d && d.cmd !== (on ? 1 : 0)) d.cmd = on ? 1 : 0; };
        if (RELEASED.has('prhr') && u.prhr) cmd('prhr_valve', (sys.prhr || 0) > 0);
        if (RELEASED.has('gravity') && u.gravity) {
          const on = (sys.gravity || 0) > 0 || (sys.cmt || 0) > 0;
          cmd('grav_valve', on && (Number.isFinite(p.irwst) ? p.irwst > 1e5 : true));
        }
        if (RELEASED.has('inject') && u.inject) {
          cmd('inj_valve', !!st.injecting);
          const e = s.pump('eccs'), want = st.injecting ? (sys.rcic ? 0.65 : 1) : 0; if (e && e.cmd !== want) e.cmd = want;
        }
        if (RELEASED.has('ventCircuit') && u.ventCircuit) cmd('vent_valve', (sys.vent || 0) > 0);
      }
      // the first step is taken at once, so the readback is in place
      // from the first frame rather than two plant seconds later
      this.acc = this.steps === 0 ? STEP : Math.min(BACKLOG_MAX, (this.acc || 0) + Math.max(0, dt));
      let rep = null, ms = 0;
      for (let k = 0; k < STEPS_PER_FRAME && this.acc >= STEP; k++) {
        rep = s.step(STEP);
        // the solver's health over the run, for the probes: steps that did not
        // converge, steps with a node at a bound, the worst iteration count
        if (!rep.converged) this.unconv = (this.unconv || 0) + 1;
        if (rep.atBoundNode) this.bound = (this.bound || 0) + 1;
        if (rep.atBoundNode) { const b = this.boundNodes || (this.boundNodes = {}); b[rep.atBoundNode] = (b[rep.atBoundNode] || 0) + 1; }
        // the library's d1460f2 names a junction holding its pressure with no
        // open edge (trapped), the precise form of a node at a bound
        if (rep.trapped) { this.trappedSteps = (this.trappedSteps || 0) + 1; const tn = this.trappedNodes || (this.trappedNodes = {}); if (rep.trappedNode) tn[rep.trappedNode] = (tn[rep.trappedNode] || 0) + 1; }
        // and the EVENT (its d355d40): junctions that became trapped this step,
        // summed over the run; trapped is the state, this is the news
        if (rep.trappedNew) this.trappedNew = (this.trappedNew || 0) + rep.trappedNew;
        // the sub-step cap: what the criterion asked (the worst over the run)
        // and how many steps the cap bound (its 885a895)
        if ((rep.subWanted || 0) > (this.subWantedMax || 0)) this.subWantedMax = rep.subWanted;
        if (rep.subCapped) this.subCapped = (this.subCapped || 0) + 1;
        if ((rep.iters || 0) > (this.itMax || 0)) this.itMax = rep.iters;
        // THE FAILING STEPS' REPORTS, with the report of the step before each
        // (a step that fails is often paying for the one before it): every
        // primitive field the library publishes, the last 64 failures, for
        // the health tool's FAILS=n and the library's reading
        {
          const flat = { k: this.steps + 1 };
          for (const key of Object.keys(rep)) { const v = rep[key]; if (v !== null && typeof v !== 'object' && typeof v !== 'function') flat[key] = v; }
          if (!rep.converged) { (this.fails || (this.fails = [])).push({ prev: this.prevRep || null, fail: flat }); if (this.fails.length > 64) this.fails.shift(); }
          this.prevRep = flat;
        }
        ms += rep.ms || 0;
        this.acc -= STEP;
        this.steps++;
      }
      this.ms = ms;
      if (rep) this.report = rep;
      // a trace of every eighth step (the last 128 of them), for the probes:
      // what moved first when a picture went wrong
      if (rep && this.steps % TRACE_EVERY === 0) {
        const rv = s.volumes.find((v) => v.id === 'rpv'), sgv = s.volumes.find((v) => v.id === 'sg'), cdv = s.volumes.find((v) => v.id === 'cond');
        const hot = s.edge('hot'), stm = s.edge('steam'), fd = s.edge('feed'), inj = s.edge('injection'), vt = s.edge('vent'), pu = s.edge('prhr_up'), fl = s.edge('fill');
        const sdv = s.volumes.find((v) => v.id === 'sg_down'), ex = s.edge('exhaust'), cs = s.edge('cond_suct'), fo = s.edge('feed_out');
        const rnd = (x) => Number.isFinite(x) ? Math.round(x) : null;
        (this.trace || (this.trace = [])).push({ k: this.steps, it: rep.iters, c: rep.converged ? 1 : 0, mk: rnd(rep.hostMakeup), sh: rep.shutEdge, ab: rep.atBoundNode,
          // the secondary's books: the three vessels' masses and the flows between them
          sgm: rnd(sgv && sgv.mass), sdm: rnd(sdv && sdv.mass), cdm: rnd(cdv && cdv.mass), cdl: cdv && Number.isFinite(cdv.level) ? +cdv.level.toFixed(2) : null,
          ex: rnd(ex && ex.mdot), cs: rnd(cs && cs.mdot), fo: rnd(fo && fo.mdot),
          rT: rv && +rv.T.toFixed(1), rX: rv && +(rv.x || 0).toFixed(3), rM: rv && rnd(rv.mass), rL: rv && +rv.level.toFixed(2), held: this.levelHeld ? 1 : 0,
          sgM: sgv && rnd(sgv.mass), cdM: cdv && rnd(cdv.mass), hot: hot && rnd(hot.mdot), stm: stm && rnd(stm.mdot), fd: fd && rnd(fd.mdot), inj: inj && rnd(inj.mdot), vt: vt && rnd(vt.mdot), pu: pu && rnd(pu.mdot), fl: fl && rnd(fl.mdot) });
        if (this.trace.length > 128) this.trace.shift();
      }
      // read the released circuits back into the sim's legs
      const rerange = (c) => { if (c && u.ranges) u.ranges.set(c, c.range()); };
      if (RELEASED.has('primary') && u.primary) {
        const hot = s.edge('hot'), tubes = s.edge('sg_tubes'), cold = s.edge('cold');
        const ok = (e) => e && Number.isFinite(e.v) && Number.isFinite(e.T0) && Number.isFinite(e.T1);
        // A leg with no heat source carries ONE temperature: the hot leg is
        // the vessel's outlet end to end and the cold leg the bank's outlet,
        // and the bank's inlet is the hot leg's. The solver's own outlet
        // cell on the hot leg sits a few kelvin above its inlet for hours
        // at the app's step (reported); painting that would put a warming
        // on a pipe that has nothing to warm it, and a step at the head.
        if (ok(hot) && ok(tubes) && ok(cold) && u.legHot && u.legTubes && u.legCold) {
          const tHot = hot.T0 - K, tCold = tubes.T1 - K;
          u.legHot.v = hot.v; u.legHot.T0 = tHot; u.legHot.T1 = tHot;
          u.legTubes.v = tubes.v; u.legTubes.T0 = tHot; u.legTubes.T1 = tCold;
          u.legCold.v = cold.v; u.legCold.T0 = tCold; u.legCold.T1 = tCold;
          // the vessel's column: cold-leg water in at the bottom, hot-leg
          // water out at the top; the downcomer is the cold leg's
          if (u.legDown) { u.legDown.T0 = tCold; u.legDown.T1 = tCold; }
          if (u.legCore) { u.legCore.T0 = tCold; u.legCore.T1 = tHot; }
          // the pool loop takes the hot leg's water up
          if (u.prhr) u.prhr.setTemps(tHot);
          // The colour ramp spans each circuit's own coldest and hottest
          // water, and that span was taken from the plant model's legs
          // before this readback: the solver's hot leg sat in the middle of
          // it and read tan. Take the span again from what was just read.
          rerange(u.primary);
          rerange(u.prhr);
        }
        if (hot && Number.isFinite(hot.mdot)) u.primary.mdot = hot.mdot;
      }
      if (RELEASED.has('secondary') && u.secondary) {
        // the loop's flow from the steam line; the sim's own densities and
        // areas turn it into the legs' speeds (its condensate speed is
        // derived from the circuit's flow further down update())
        const stE = s.edge('steam');
        if (stE && Number.isFinite(stE.mdot)) u.secondary.setFlow(Math.max(0, stE.mdot));
      }
      // the accident lines back into the sim's legs: the speeds are the
      // solver's; the pool loop's temperatures too (one temperature a leg,
      // the coil carrying the drop); the injected water stays the sim's
      // tank-cold. Behind a shut valve a line is at rest whatever a dead-end
      // cell says (a dead-end line under a depressurising vessel once read
      // 57 kg/s from nothing; reported).
      const readV = (edgeId, valveId, ...legs) => {
        const e = s.edge(edgeId); if (!e || !Number.isFinite(e.v)) return null;
        const d = valveId ? s.device(valveId) : null;
        const shut = d && (d.open || 0) < 0.01;
        for (const l of legs) if (l) l.v = shut ? 0 : e.v;
        return shut ? 0 : e.mdot;
      };
      if (RELEASED.has('prhr') && u.prhr && u.legPrhrUp) {
        const up = s.edge('prhr_up'), coil = s.edge('coil');
        const m = readV('prhr_up', 'prhr_valve', u.legPrhrUp);
        readV('coil', 'prhr_valve', u.legCoil);
        readV('prhr_down', 'prhr_valve', u.legCoilOut, u.legPrhrDn);
        if (m !== null) u.prhr.mdot = Math.max(0, m);
        if (m && up && coil && Number.isFinite(up.T0) && Number.isFinite(coil.T1)) {
          const tIn = up.T0 - K, tOut = coil.T1 - K;
          u.legPrhrUp.T0 = tIn; u.legPrhrUp.T1 = tIn;
          u.legCoil.T0 = tIn; u.legCoil.T1 = tOut;
          for (const l of [u.legCoilOut, u.legPrhrDn]) if (l) { l.T0 = tOut; l.T1 = tOut; }
          rerange(u.prhr);
        }
      }
      if (RELEASED.has('gravity') && u.gravity) { const m = readV('gravity', 'grav_valve', u.legGrav); if (m !== null) u.gravity.mdot = Math.max(0, m); }
      if (RELEASED.has('fillC') && u.fillC) { const m = readV('fill', 'grav_valve', u.legFill); if (m !== null) u.fillC.mdot = Math.max(0, m); }
      if (RELEASED.has('inject') && u.inject) {
        readV('suction', 'inj_valve', u.legSuct);
        const m = readV('injection', 'inj_valve', u.legInj);
        if (m !== null) u.inject.mdot = Math.max(0, m);
      }
      if (RELEASED.has('ventCircuit') && u.ventCircuit) {
        // a vapour leg's drawn speed is the sim's convention (its steam at
        // one density), so the flow goes through setFlow as the main steam
        // line's does; behind a shut valve the line is at rest
        const e = s.edge('vent'), d = s.device('vent_valve');
        if (e && Number.isFinite(e.mdot)) u.ventCircuit.setFlow(d && (d.open || 0) < 0.01 ? 0 : Math.max(0, e.mdot));
      }
      if (RELEASED.has('cw') && u.legCw && u.cw) {
        // the intake's temperature is the sea's; the rise is what the
        // condenser's tubes put into it; the drawn rise is amplified as the
        // sim always drew it, and capped so an off secondary cannot paint
        // the outfall hotter than the reactor
        const e = s.edge('cw_disch'), tb = s.edge('cond_tubes');
        if (e && tb && Number.isFinite(e.v) && Number.isFinite(e.T0) && Number.isFinite(tb.T1)) {
          u.cw.mdot = e.mdot;
          u.legCw.v = e.v;
          u.legCw.T0 = e.T0 - K;
          u.legCw.T1 = e.T0 - K + Math.min(100, Math.max(0, tb.T1 - e.T0) * CW_DRAWN_GAIN);
          rerange(u.cw);
        }
      }
    } catch (e) {
      this.ok = false;
      this.failed = e;
      console.warn('hydro: solver stopped', e);
    }
  }
}

// The plant's steam demand, kg/s: its secondary heat over what a kilogramme
// of steam carries above heated feed.
Hydro.prototype.steamDemand = function (st) {
  const q = Number.isFinite(this.unit.qSec) ? this.unit.qSec : THERMAL_W;
  return Math.max(0, q) / (H_STEAM - H_FEED_HOT);
};

// The plant's two secondary controls, applied to the solver's devices once
// a frame: the governor sets the turbine's drop so the steam flow meets the
// plant's demand (the drop's ceiling is the boiler's pressure less the
// condenser's, from the VESSELS: a junction starts at one atmosphere), and
// the condensate pump's speed holds the boiler's level, which is real under
// the pressure hold. The shaft power taken out of the steam follows the flow
// on the rotor's time constant, not the step. With no feed at all the pump
// is stopped and the turbine shut. Worked out headless in tools/network.mjs
// --govern, whose gains these are.
Hydro.prototype.governSecondary = function (dt, st) {
  const s = this.solver, g = this.gov || (this.gov = {});
  const h = Math.max(0, Math.min(2, dt));
  const turb = s.device('turb'), cp = s.pump('cpump'), stE = s.edge('steam'), fd = s.edge('feed');
  const sgV = s.volumes.find((v) => v.id === 'sg'), cdV = s.volumes.find((v) => v.id === 'cond');
  if (!turb || !cp || !stE || !fd || !sgV || !cdV) return;
  const demand = this.steamDemand(st);
  const avail = Math.max(0, sgV.p - cdV.p);
  const m = Number.isFinite(stE.mdot) ? stE.mdot : 0, f = Number.isFinite(fd.mdot) ? fd.mdot : 0;
  if (g.dpI === undefined) g.dpI = turb.dp || 0;
  if (demand < 1) {
    g.dpI = avail; turb.dp = avail;            // turbine shut
  } else {
    const err = Math.max(-1, Math.min(1, (m - demand) / demand));
    g.dpI = Math.max(0, Math.min(avail, g.dpI + GOV_KI * err * h));
    turb.dp = Math.max(0, Math.min(avail, g.dpI + GOV_KP * err));
  }
  if (g.mW === undefined) g.mW = m;
  g.mW += (m - g.mW) * Math.min(1, h / 10);
  turb.W = DH_TURB * Math.max(0, g.mW);
  const fv = s.device('feed_valve'), sdV = s.volumes.find((v) => v.id === 'sg_down');
  const carrying = this.carrying(st);
  // PUMP STOPPED, VALVE SHUT. The valve was left open for a while so that
  // the check alone isolated the line: with both shut, the junction between
  // them had no open edge and no equation, the solver wandered for 1400
  // steps of a blackout and the check passed 1593 kg/s backwards. The
  // library holds such a junction now (C36: it keeps its pressure and reports
  // trapped, the benign form, which is what cpump_j reads through every
  // blackout). And OPEN, the leg between the check and the boiler was a dead
  // end of 40 C water hanging five metres down into the 230 C downcomer, a
  // buoyancy head that would genuinely circulate with nowhere to go, and its
  // junction's residual sat at exactly 0.111 on every failing step of unit
  // A's breach rows (the library's reading of the failing steps' reports).
  // A station shuts the regulating valve when the line is isolated.
  if (!carrying) { cp.cmd = 0; if (fv) fv.cmd = 0; return; }
  cp.cmd = CP_SPEED;
  if (!fv) return;
  const inv = (sgV.mass || 0) + (sdV ? sdV.mass || 0 : 0);
  if (g.inv0 === undefined) { g.inv0 = inv; g.cmdI = 0; g.invPrev = inv; g.invStep = this.steps; g.mSteam = Number.isFinite(fv.open) ? fv.open * STEAM_RATED / FV_OPEN0 : m; }
  // the feed-forward: the steam flow, on a four-second filter
  g.mSteam += (Math.max(0, m) - g.mSteam) * Math.min(1, h / 4);
  const ff = FV_OPEN0 * g.mSteam / STEAM_RATED;
  const eL = Math.max(-2, Math.min(2, (g.inv0 - inv) / SG_T_PER_M));   // metres-equivalent short
  // the inventory's rate over the solver's own steps (it moves only when
  // the solver steps; between steps the rate is the last one measured)
  if (this.steps !== g.invStep) {
    const dtl = STEP * (this.steps - g.invStep);
    g.rate = Math.max(-0.05, Math.min(0.05, (inv - g.invPrev) / SG_T_PER_M / Math.max(1e-3, dtl)));
    g.invPrev = inv; g.invStep = this.steps;
  }
  const rep = this.report;
  const starved = !!(rep && (rep.atBoundNode === 'cpump_j' || rep.shutEdge === 'cond_suct'));
  const atStop = fv.cmd >= 1 || fv.cmd <= FV_MIN;
  if (!starved && !(atStop && Math.sign(eL) === Math.sign(fv.cmd - 0.5))) g.cmdI = Math.max(FV_MIN - ff, Math.min(1 - ff, g.cmdI + CP_KI_LEVEL * eL * h));
  fv.cmd = Math.max(FV_MIN, Math.min(1, ff + g.cmdI + CP_KP_LEVEL * eL - CP_KD_LEVEL * (g.rate || 0)));
};

// Whether the plant feeds its boiler through the condensate line: main feed
// or aux feed, both on AC power. NOT the steam-driven pump (rcic): that one
// injects into the reactor on batteries and needs no condensate pump, and
// counting it ran unit A's condensate pump through a blackout against a
// valve the law had closed to one per cent (the steam line isolated, so
// its feed-forward read zero): the hotwell drained through the pump, the
// suction uncovered, and five thousand steps of the blackout never
// converged while the check valve passed 1593 kg/s backwards.
Hydro.prototype.carrying = function (st) {
  return st ? ((st.s.feed || 0) > 0 || (st.s.aux || 0) > 0) : true;
};

// Make one for a unit, or nothing when the network is not loaded.
export function makeHydro(unit) {
  if (!netJson) return null;
  const h = new Hydro(unit);
  return h.ok ? h : null;
}
