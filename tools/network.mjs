// ---------------------------------------------------------------------------
// network.mjs - the station as the fluid library sees it.
//
//   node tools/network.mjs            # writes assets/network.json and checks it
//   node tools/network.mjs --run 60   # ...then steps the library's Solver for
//                                     # 60 s of plant time with the sim's flows
//                                     # imposed, and prints what came out
//
// Reads assets/layout.json (the one description of the station, in metres,
// unit-local, y up, the cut plane z = 0) and writes the same station in the
// schema of ../3d-fluid-simulator (vendored under vendor/fluidsim): volumes
// for the vessel, the boiler shell, the condenser, the pool, the tank and the
// building's floor; junctions where pipes meet; the four pumps and two valves
// as devices; the tube bank, the condenser and the pool coil as exchangers;
// runs matching the sim's circuits. Then validates it with the library and,
// with --run, drives its Solver headless.
//
// This is the first step of moving the sim's hydraulics onto the library
// (the library's HANDOFF open question 5, the sim's register L5): impose the
// present flows so the picture cannot change, then release one circuit at a
// time. Nothing here touches the running app yet.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const L = JSON.parse(readFileSync('assets/layout.json', 'utf8'));
const args = process.argv.slice(2);
const runSecs = args.includes('--run') ? Number(args[args.indexOf('--run') + 1] || 60) : 0;
// --scenario prhr | gravity | inject | vent: the accident-time flows of the
// passive and active designs, each what the plant model asks of the solver
// after a trip: the pool loop on its own buoyancy, the pool draining into a
// depressurised vessel, the injection pump against 155 bar, the building
// venting to the sky
const scenario = args.includes('--scenario') ? String(args[args.indexOf('--scenario') + 1]) : '';

const A = (d) => Math.PI * d * d / 4;
// The sim's legs: bore and how many real pipes one drawn pipe stands for
// (flow.js / unit.js). The drawn diameter is the layout's; n is chosen so
// the library's flow area matches the sim's, and the water runs at the
// speed the reviews approved.
const LEG = {
  hot: [0.787, 4], cold: [0.699, 4], coldB: [0.699, 4], tubes: [0.7, 4],
  steam: [0.75, 4], exhaust: [0.75, 4], feed: [0.45, 4],
  // The condensate suction is sized like the feed line: four paths, 2.4 m/s.
  // As ONE 0.45 m line it carried 1892 kg/s at 9.7 m/s, its entrance and
  // friction losses pulled the pump's suction under the hotwell's own
  // saturation pressure (7.4 kPa, with 1.2 m of water above the pump), and
  // the pump CAVITATED: the library found the suction junction sitting on
  // its pressure floor, 0.01 bar, with tsat there (7 C) read along the
  // line, and nothing converging past it. A real condensate suction runs
  // at a metre or two a second for exactly this reason. (The drawn pipe is
  // one line; the sim's own leg says one path; n is the solver's.)
  cond_suct: [0.45, 4],
  cw: [2.2, 2], cond_tubes: [2.2, 2], vent: [0.8, 1], prhr: [0.2, 2], coil: [0.2, 2],
  gravity: [0.3, 2], fill: [0.3, 2], suction: [0.35, 2], injection: [0.25, 2]
};
function nFor(legKey, drawnDia) {
  const [bore, n] = LEG[legKey];
  return Math.max(1, Math.round(n * A(bore) / A(drawnDia)));
}
const P = L.pipes, R = L.rpv, S = L.sg, C = L.condenser, T = L.turbine;
const CW_CAN = L.sea.pump.can != null ? L.sea.pump.can : 0;   // the sea pump's bowl, metres under its impeller, down its can: the layout's
const CAN_DEPTH = args.includes('--can-depth') ? Number(args[args.indexOf('--can-depth') + 1]) : (L.cond_pump.can != null ? L.cond_pump.can : 3.0);   // the condensate pump's suction bowl, metres under the impeller, down its can: the layout's
// THE HOTWELL IS THE SIM'S REVIEWED POOL: the drum's water up to the top of
// the pool the sim draws (layout condenser.pool, 0.4 m over the drum's floor,
// the tube bank clear above it), as the fraction of a lying cylinder below
// that height. It was 0.3 (2.7 m, the lowest row under water) until the
// library's picture showed it; a hotwell this small put the condensate
// pump's junction on the pressure floor at the first free step until the
// library's f46b882 (its cavitation derate was a switch read a sub-step
// late; it is a two-second time constant now). In the app it settles at
// 2.08 m, 16 cm under the lowest row, every step converged (--cond-fill f
// to try another).
const COND_LEVEL = +(C.pool.y0 + C.pool.h).toFixed(3);
const COND_FILL = args.includes('--cond-fill') ? Number(args[args.indexOf('--cond-fill') + 1])
  : +((() => { const h = COND_LEVEL - (C.y - C.r), th = 2 * Math.acos(1 - h / C.r); return (th - Math.sin(th)) / (2 * Math.PI); })()).toFixed(4);
const base = R.base;
// the fraction of the vessel's volume below a height, from its profile
function lathePart(prof, yTop) {
  let V = 0, Vt = 0;
  for (let i = 1; i < prof.length; i++) {
    const [r0, y0] = prof[i - 1], [r1, y1] = prof[i];
    const seg = (a, b) => { const h = b - a; if (h <= 0) return 0; const ra = r0 + (r1 - r0) * (a - y0) / (y1 - y0), rb = r0 + (r1 - r0) * (b - y0) / (y1 - y0); return Math.PI * h * (ra * ra + ra * rb + rb * rb) / 3; };
    Vt += seg(y0, y1);
    V += seg(y0, Math.min(y1, Math.max(y0, yTop)));
  }
  return V / Vt;
}
// a lathe's volume below a height (cubic metres times pi), and the fraction
// of an ANNULUS (outer lathe less inner lathe) below a height
function latheBelow(prof, yTop) {
  let V = 0;
  for (let i = 1; i < prof.length; i++) {
    const [r0, y0] = prof[i - 1], [r1, y1] = prof[i];
    const b = Math.min(y1, Math.max(y0, yTop));
    if (b <= y0) continue;
    const rb = r0 + (r1 - r0) * (b - y0) / (y1 - y0);
    V += (b - y0) * (r0 * r0 + r0 * rb + rb * rb) / 3;
  }
  return V;
}
function annulusPart(outer, inner, yTop) {
  const yMax = Math.max(...outer.map((p) => p[1]));
  return (latheBelow(outer, yTop) - latheBelow(inner, yTop)) / (latheBelow(outer, yMax) - latheBelow(inner, yMax));
}
const RPV_FILL = +(lathePart(R.profile, 12.2) * (14.8 - base) / (15.29 - base)).toFixed(4);   // the plant's full level, base + 12.2, as the library measures it

// ---- nodes ----------------------------------------------------------------
const abs = (prof, y0) => prof.map(([r, y]) => [r, +(y + y0).toFixed(3)]);
// the boiler's riser (inside the shroud, r 2.3, from the tubesheet to the
// shroud's top at base + 16.7) with the shell's dome over it; the downcomer
// outside the shroud, up the shell's own profile, in absolute metres
// The shroud's top sits just under the water level, as a steam generator's
// wrapper does: the separated water returns OVER it into the downcomer,
// several times the feed flow, so the downcomer runs nearly as hot as the
// riser and the two levels agree (a downcomer fed cold water alone settled
// three metres under the riser, denser water under the same pressure).
const SG_SHROUD_R = 2.3, SG_SHROUD_TOP = +(S.base + 14.5).toFixed(3), SG_LEVEL = 25.6, SG_OVERFLOW_Y = +(S.base + 14.1).toFixed(3);
const SG_RISER = [[0, S.tubesheet], [SG_SHROUD_R, S.tubesheet], [SG_SHROUD_R, SG_SHROUD_TOP], [4, SG_SHROUD_TOP],
  ...abs(S.profile.filter(([, y]) => y > 16.7 + 0.01), S.base)];
const SG_DOWN_OUTER = [[2.64, S.tubesheet], [2.64, +(S.base + 9.1).toFixed(3)], [3.04, +(S.base + 10.8).toFixed(3)], [3.94, +(S.base + 12.6).toFixed(3)], [3.94, SG_SHROUD_TOP]];
const SG_DOWN_INNER = [[SG_SHROUD_R, S.tubesheet], [SG_SHROUD_R, SG_SHROUD_TOP]];
const SG_FILL = +lathePart(SG_RISER, SG_LEVEL).toFixed(4);
// the downcomer seeded a tenth below its brim: seeded full it read 0.1 m
// over the shroud's top and shed 4.7 t into the hotwell in the first minutes
const SGD_LEVEL = args.includes('--sgd-level') ? Number(args[args.indexOf('--sgd-level') + 1]) : SG_LEVEL - 0.1;
const SG_DOWN_FILL = +annulusPart(SG_DOWN_OUTER, SG_DOWN_INNER, SGD_LEVEL).toFixed(4);
// the primary's steady temperatures, degrees C: the vessel's outlet and the
// tube bank's outlet (the sim's own figures at rated power)
const T_HOT = 333, T_COLD = 304;
// the condenser sits ON its saturation line: 40 C of condensate is 7.4 kPa
const P_COND = 7400, T_COND_K = 313.15;
const nodes = [
  // the vessel: the layout's profile lifted onto its base; water-solid with a
  // pressuriser in the real plant, a free surface here so a level exists
  { id: 'rpv', kind: 'volume', free: !args.includes('--rpv-solid'), at: [R.x, base, 0],
    shape: { kind: 'lathe', profile: abs(R.profile, base) }, gas: { p: 155e5, closed: true }, fill: args.includes('--rpv-solid') ? 1 : RPV_FILL, T: 333,
    display: { range: 'hot', gradient: { from: 'coldB', to: 'hot' } } /* range: the EDGE whose run's span paints this body; gradient: painted from the water arriving (the cold leg, at the floor) to the water leaving (the hot leg, at the top), which is what the core does to it */ },
  // the pressuriser: the primary's one free surface, on a surge line off the hot leg
  { id: 'przr', kind: 'volume', free: true, at: [1.0, 14.5, -3.0],
    shape: { kind: 'lathe', profile: [[0, 14.5], [1.2, 14.5], [1.2, 20.5], [0, 20.5]] }, gas: { p: 155e5, closed: true }, fill: 0.55, T: 345,
    display: { draw: false } },
  // The primary's junctions start at the loop's own steady temperatures
  // (the vessel's outlet on the hot side, the bank's outlet on the cold);
  // left at the schema's 15 C default they poured sea-cold water into a
  // 333 C vessel on day one, and the vessel took ten plant minutes to
  // warm back. A junction's temperature is where the edges leaving it
  // start.
  // The channel head is drawn on the hot junction: a junction given a shape
  // is drawn and stays a joint (no inventory, the physics untouched, its
  // colour from the lines that meet it). One bowl divided by a wall through
  // its axis, the +x half (where the hot leg arrives) painted from the hot
  // leg and the -x half from the cold leg leaving it. The split's at is the
  // ANGLE the far half starts from, measured from +z through +x: from 0 the
  // far half is the +x side, which painted the hot half cold, so it starts
  // half a turn round.
  { id: 'sg_hot', kind: 'junction', at: [S.x, L.hot_y, 0], T: T_HOT,
    shape: { kind: 'lathe', profile: [[0, +(S.base + S.head_profile[0][1]).toFixed(3)], ...abs(S.head_profile, S.base)] },
    display: { range: 'hot', split: { at: Math.PI, range: 'cold' } } },
  { id: 'sg_cold', kind: 'junction', at: [S.x - S.head_r_cold + 0.5, L.xover_y, 0], T: T_COLD },
  { id: 'rcp_j', kind: 'junction', at: [L.rcp.x, L.rcp.y, 0], T: T_COLD },
  // the boiler's secondary side: the shell above the tube sheet, boiling
  // THE BOILER IS TWO BODIES OF WATER. The riser inside the shroud (r 2.3,
  // the tube bank in it, boiling at 70 bar) with the shell's dome over it,
  // and the DOWNCOMER, the annulus between the shroud and the shell, which
  // the feed enters at the top and which drains into the riser at its floor.
  // One body painted at saturation was the library's honest picture of the
  // shell and not the sim's reviewed one (a blue downcomer round an orange
  // bank); two bodies is the truth of a steam generator.
  { id: 'sg', kind: 'volume', free: true, at: [S.x, S.base, 0],
    shape: { kind: 'lathe', profile: SG_RISER },
    gas: { p: 70e5, closed: true }, fill: SG_FILL, T: 285, display: { range: 'feed_in' } },
  { id: 'sg_down', kind: 'volume', free: true, at: [S.x, S.tubesheet, 0],
    shape: { kind: 'annulus', outer: SG_DOWN_OUTER, inner: SG_DOWN_INNER },
    gas: { p: 70e5, closed: true }, fill: SG_DOWN_FILL, T: 230,
    // painted from the feed arriving at its top to its own outlet at the floor
    // (the feed's blue fading into the returned water's orange on the way down)
    display: { range: 'feed_in', gradient: { from: 'feed_in', to: 'downcomer' } } },
  { id: 'turb_in', kind: 'junction', at: [T.x0 + 1.2, T.ax + 2.65, 0], T: 285, p: 70.5e5 },
  // the condenser: a horizontal shell, as an area table
  { id: 'cond', kind: 'volume', free: true, at: [C.x, C.y - C.r, 0],
    // a drum lying along x, the library's own shape for it (the thirteen area
    // rows it replaced under-read the drum by 3.5 per cent and put a
    // nine-tenths level 11 cm out); --lathe-cond keeps the old stand-in
    shape: args.includes('--lathe-cond')
      ? { kind: 'lathe', profile: [[0, C.y - C.r], [Math.sqrt(Math.PI * C.r * C.r * C.len / (Math.PI * 2 * C.r)), C.y - C.r], [Math.sqrt(Math.PI * C.r * C.r * C.len / (Math.PI * 2 * C.r)), C.y + C.r], [0, C.y + C.r]] }
      : { kind: 'cylinder', r: C.r, len: C.len, y0: +(C.y - C.r).toFixed(3), axis: 'x' }, gas: { p: P_COND, closed: true }, fill: COND_FILL, T: 40,
    display: { range: 'cond_suct' } },
  // The condensate pump's suction: a vertical can pump, its casing on the
  // hall floor where it is drawn and its suction bowl CAN_DEPTH down in a
  // can under the floor. The hotwell sits at its own saturation pressure
  // by definition, so a suction at the hotwell's own level has no NPSH at
  // all (the library measured 0.0 m) and a cavitation model stops it
  // dead; three metres of can plus the hotwell's water over the floor is
  // about four metres, against the library's default requirement of one.
  // the condensate line's junctions START AT THEIR WORKING PRESSURES (a
  // junction starts at one atmosphere otherwise, and on the release the
  // check-valve edge into a valve junction at one atmosphere saw eighty bar
  // of drop and surged to 6592 kg/s, three steps of it not converging)
  { id: 'cpump_j', kind: 'junction', at: [L.cond_pump.x, L.cond_pump.y - CAN_DEPTH, 0], T: 40, p: 0.37e5 },
  // the pump's discharge, where the feed line's check valve sits: without
  // one the boiler backfed through a pump too weak to hold its discharge,
  // the suction check shut on the reversal and stayed shut for ever against
  // the dead-headed junction (the library reduced it to three nodes)
  { id: 'disch_j', kind: 'junction', at: [P.feed.pts[1][0], P.feed.pts[1][1], 0], T: 40, p: 80e5 },
  // the feed regulating valve's junction, at the feed line's top corner
  { id: 'fcv_j', kind: 'junction', at: [P.feed.pts[3][0], P.feed.pts[3][1], 0], T: 40, p: 74e5 },
  // The sea pump is a vertical wet-pit pump: its bowl hangs CW_CAN under the
  // impeller drawn on the shore, in the bay's water, and its column rises to
  // the discharge head; a pump on the shore 4 m above the sea cannot lift it
  // (raised 0.3 m onto its junction, its suction margin went and unit A's
  // LOCA row went from 3 unconverged steps to 58)
  { id: 'cwpump_j', kind: 'junction', at: [L.sea.pump.x, L.sea.pump.y - CW_CAN, 0] },
  { id: 'cw_in', kind: 'junction', at: [C.plate_r, C.noz_in_y, 0] },
  { id: 'cw_out_j', kind: 'junction', at: [C.plate_r, C.noz_out_y, 0] },
  { id: 'sea', kind: 'boundary', at: [L.sea.bay_x, L.sea.y, 0], p: 101325, T: 15 },
  // the building's atmosphere, which the vent lets out; and the air outside
  // (steam, so stated ABOVE its saturation at its pressure: at 102 C under
  // 1.1 bar it was water, and every hold on it was unmet)
  { id: 'cont', kind: 'boundary', at: [-L.containment.r_in, P.vent.pts[0][1], 0], fluid: 'steam', p: 110000, T: 115 },
  { id: 'atm', kind: 'boundary', at: [L.vent_mouth.x, L.vent_mouth.y + 1, 0], fluid: 'air', p: 101325, T: 20 },
  // the floor of the building, where spilled water collects
  { id: 'sump', kind: 'volume', free: true, at: [0, 0, 0],
    shape: { kind: 'area', table: [[0, Math.PI * L.containment.r_in ** 2], [3, Math.PI * L.containment.r_in ** 2]] },
    gas: { p: 110000 }, fill: 0.0, T: 40 },
  // passive: the pool, high; active: the tank, on the ground
  { id: 'pool', kind: 'volume', free: true, at: [L.passive.pool.x, L.passive.pool.y + 0.5, 0],
    shape: { kind: 'box', w: L.passive.pool.w - 1.2, d: L.passive.pool.d - 1.2, h: L.passive.pool.h - 0.5, y0: L.passive.pool.y + 0.5 },
    gas: { p: 110000 }, fill: 0.8, T: 18 },
  { id: 'tee', kind: 'junction', at: [L.passive.valve.x, L.passive.valve.y, 0] },
  { id: 'coil_in', kind: 'junction', at: L.passive.hairpin.pts[0] },
  { id: 'coil_out', kind: 'junction', at: L.passive.hairpin.pts[3] },
  { id: 'tank', kind: 'volume', free: true, at: [L.active.tank.x, 0.4, L.active.tank.z || 0],
    shape: { kind: 'box', w: L.active.tank.w - 0.7, d: L.active.tank.d - 0.7, h: L.active.tank.h - 0.4, y0: 0.4 },
    gas: { p: 110000 }, fill: 0.85, T: 18 },
  { id: 'eccs_j', kind: 'junction', at: [L.active.eccs.x, L.active.eccs.y, 0] }
];

function areaTable(C) {
  // a horizontal cylinder of radius r and length len: width at height y is
  // 2 sqrt(r^2 - (y - yc)^2)
  const rows = [];
  const N = 12, y0 = C.y - C.r, y1 = C.y + C.r;
  for (let i = 0; i <= N; i++) {
    const y = y0 + (y1 - y0) * i / N;
    const h = Math.max(0, C.r * C.r - (y - C.y) ** 2);
    rows.push([+y.toFixed(3), +(2 * Math.sqrt(h) * C.len).toFixed(3)]);
  }
  return rows;
}

// ---- edges ----------------------------------------------------------------
// A pipe's centreline carries the layout's REACH: its ends run on into the
// vessels they serve by reach[0] / reach[1] along the end segments, the way
// the model's casings do (tools/blender/plant.py reached()), so the water the
// library draws passes through the wall and ends inside the vessel's water.
// Without it the edge stopped at the outer surface and the pipe read as
// blocked by the wall.
// A pipe's centreline is the layout's, as drawn: the solver reads each end's
// elevation from it, so an end must sit where its junction is, and the
// layout's reach (the casing run on into a wall for the model's boolean cut)
// is not applied here. The water still ends inside what it serves: every
// layout profile is a CAVITY and the model's wall stands outside it.
const pts = (p) => p.pts.map((q) => q.slice(0, 3));
const edges = [
  { id: 'surge', from: 'sg_hot', to: 'przr', dia: 0.3, bend: 0.5, cells: 4, pts: [[-6.1, 13.0, 0], [1.0, 13.0, -3.0], [1.0, 14.6, -3.0]], display: { draw: false } },
  { id: 'hot', from: 'rpv', to: 'sg_hot', dia: P.hot.dia, n: nFor('hot', P.hot.dia), bend: P.hot.bend, pts: pts(P.hot) },
  // the tube bank: the layout's five drawn U-tubes stand for the bundle
  { id: 'sg_tubes', kind: 'tubes', from: 'sg_hot', to: 'sg_cold', dia: S.tubes.r * 2, n: nFor('tubes', S.tubes.r * 2), bend: 0.9, cells: 16,
    pts: tubePath(S),
    // drawn as the bank the layout has: n nested U-tubes, the legs' separation
    // growing by 2 dw a copy (the sim's w0 + k dw either side of the axis)
    display: { bundle: { n: S.tubes.n, widen: +(2 * S.tubes.dw).toFixed(3) } } },
  { id: 'cold', from: 'sg_cold', to: 'rcp_j', dia: P.cold.dia, n: nFor('cold', P.cold.dia), bend: P.cold.bend, pts: pts(P.cold), device: 'rcp' },
  { id: 'coldB', from: 'rcp_j', to: 'rpv', dia: P.coldB.dia, n: nFor('coldB', P.coldB.dia), bend: P.coldB.bend, pts: pts(P.coldB) },
  { id: 'steam', from: 'sg', to: 'turb_in', dia: P.steam.dia, n: nFor('steam', P.steam.dia), bend: P.steam.bend, pts: pts(P.steam), fluid: 'steam', ...(args.includes('--orifice') ? { device: 'turb_adm' } : {}) },
  // the turbine and its exhaust: an expansion from the line to the shell,
  // given as a loss (the library has no turbine kind yet)
  { id: 'exhaust', from: 'turb_in', to: 'cond', dia: P.exhaust.dia, n: nFor('exhaust', P.exhaust.dia), bend: P.exhaust.bend, k: 400,
    pts: [[T.x0 + 1.2, T.ax + 2.65, 0], [T.x0 + 1.2, T.ax, 0], [P.exhaust.pts[0][0], T.ax, 0], ...pts(P.exhaust)], fluid: 'steam' },
  { id: 'cond_suct', from: 'cond', to: 'cpump_j', dia: P.cond_suct.dia, n: nFor('cond_suct', P.cond_suct.dia), bend: P.cond_suct.bend, pts: [...pts(P.cond_suct), [L.cond_pump.x, L.cond_pump.y, 0], [L.cond_pump.x, L.cond_pump.y - CAN_DEPTH, 0]], device: args.includes('--no-suction-check') ? undefined : 'cond_check' },
  { id: 'feed', from: 'cpump_j', to: 'disch_j', dia: P.feed.dia, n: nFor('feed', P.feed.dia), bend: P.feed.bend, pts: [[L.cond_pump.x, L.cond_pump.y - CAN_DEPTH, 0], [L.cond_pump.x, L.cond_pump.y, 0], ...pts(P.feed).slice(0, 2)], device: 'cpump' },
  { id: 'feed_out', from: 'disch_j', to: 'fcv_j', dia: P.feed.dia, n: nFor('feed', P.feed.dia), bend: P.feed.bend, pts: pts(P.feed).slice(1, 4), device: 'feed_check' },
  // the last leg into the downcomer carries the regulating valve
  { id: 'feed_in', from: 'fcv_j', to: 'sg_down', dia: P.feed.dia, n: nFor('feed', P.feed.dia), bend: P.feed.bend, pts: pts(P.feed).slice(3), device: 'feed_valve' },
  // the downcomer's floor into the riser: a short wide path, not drawn (the
  // annulus body is the water)
  { id: 'downcomer', from: 'sg_down', to: 'sg', dia: 0.6, n: 8, bend: 0, k: 1, pts: [[S.x + 2.47, S.tubesheet + 0.6, 0], [S.x + 2.47, S.tubesheet + 0.1, 0]], display: { draw: false } },
  // the return over the wrapper: the riser's separated water into the
  // downcomer's top, a wide short path the levels drive, never held
  { id: 'recirc', from: 'sg', to: 'sg_down', dia: 1.0, n: 12, bend: 0, k: 2, pts: [[S.x + 2.0, SG_OVERFLOW_Y, 0], [S.x + 2.6, SG_OVERFLOW_Y, 0]], display: { draw: false } },
  { id: 'cw_suct', from: 'sea', to: 'cwpump_j', dia: P.cw_suct.dia, n: nFor('cw', P.cw_suct.dia), bend: P.cw_suct.bend, pts: [...pts(P.cw_suct).slice(0, -1), [L.sea.pump.x, L.sea.pump.y - CW_CAN, 0]] },
  { id: 'cw_disch', from: 'cwpump_j', to: 'cw_in', dia: P.cw_disch.dia, n: nFor('cw', P.cw_disch.dia), bend: P.cw_disch.bend, pts: [[L.sea.pump.x, L.sea.pump.y - CW_CAN, 0], [L.sea.pump.x, L.sea.pump.y, 0], ...pts(P.cw_disch)], device: 'cwpump' },
  { id: 'cond_tubes', kind: 'tubes', from: 'cw_in', to: 'cw_out_j', dia: C.tube_r * 2, n: nFor('cond_tubes', C.tube_r * 2), bend: 0.5, cells: 16,
    // the middle row of three nested U-tubes in the vertical plane; the
    // rows' separation steps by a constant and their turn by half of it,
    // which is exactly the library's widening
    pts: [[C.plate_r, C.rows_lo[1], C.tube_z], [C.turn_x[1], C.rows_lo[1], C.tube_z], [C.turn_x[1], C.rows_hi[1], C.tube_z], [C.plate_r, C.rows_hi[1], C.tube_z]],
    display: { bundle: { n: C.rows_lo.length, widen: +((C.rows_hi[0] - C.rows_lo[0]) - (C.rows_hi[1] - C.rows_lo[1])).toFixed(3) } } },
  { id: 'cw_out', from: 'cw_out_j', to: 'sea', dia: P.cw_out.dia, n: nFor('cw', P.cw_out.dia), bend: P.cw_out.bend, pts: pts(P.cw_out) },
  { id: 'vent', from: 'cont', to: 'atm', dia: P.vent.dia, n: nFor('vent', P.vent.dia), bend: P.vent.bend, pts: pts(P.vent), fluid: 'steam', device: 'vent_valve' },
  // passive: the residual heat loop and the gravity line
  { id: 'prhr_up', from: 'rpv', to: 'coil_in', dia: L.passive.prhr_up.dia, n: nFor('prhr', L.passive.prhr_up.dia), bend: L.passive.prhr_up.bend, pts: pts(L.passive.prhr_up), device: 'prhr_valve' },
  { id: 'coil', kind: 'coil', from: 'coil_in', to: 'coil_out', dia: L.passive.hairpin.r * 2, n: nFor('coil', L.passive.hairpin.r * 2), bend: L.passive.hairpin.bend, cells: 12, pts: pts(L.passive.hairpin) },
  { id: 'prhr_down', from: 'coil_out', to: 'rpv', dia: L.passive.prhr_down.dia, n: nFor('prhr', L.passive.prhr_down.dia), bend: L.passive.prhr_down.bend, pts: pts(L.passive.prhr_down) },
  { id: 'gravity', from: 'pool', to: 'tee', dia: L.passive.gravity.dia, n: nFor('gravity', L.passive.gravity.dia), bend: L.passive.gravity.bend, pts: pts(L.passive.gravity), device: 'grav_valve' },
  { id: 'fill', from: 'tee', to: 'rpv', dia: L.passive.fill.dia, n: nFor('fill', L.passive.fill.dia), bend: L.passive.fill.bend, pts: pts(L.passive.fill) },
  // active: the emergency pump from the tank into the cold leg
  { id: 'suction', from: 'tank', to: 'eccs_j', dia: L.active.suction.dia, n: nFor('suction', L.active.suction.dia), bend: L.active.suction.bend, pts: pts(L.active.suction), device: 'inj_valve' },
  { id: 'injection', from: 'eccs_j', to: 'rcp_j', dia: L.active.injection.dia, n: nFor('injection', L.active.injection.dia), bend: L.active.injection.bend, pts: pts(L.active.injection), device: 'eccs' }
];

function tubePath(S) {
  // the outermost of the five drawn U-tubes, up one side and down the other
  // the MIDDLE tube of the bank: the library's bundle is centred on the
  // authored path, each copy a stated separation wider than the last
  const k = (S.tubes.n - 1) / 2, w = S.tubes.w0 + k * S.tubes.dw, top = S.tubesheet + S.tubes.top_over_sheet + w * S.tubes.top_k;
  const z = S.tubes.z, foot = S.tubesheet + S.tubes.foot;
  return [[S.x + w, foot, z], [S.x + w, top, z], [S.x - w, top, z], [S.x - w, foot, z]];
}

// ---- devices ----------------------------------------------------------------
// Pump curves: shutoff head H0, rated flow Qr (m3/s) and head Hr at it,
// sized from the sim's rated mass flows (flow.js) and the heads a plant has.
const rho = 720, mdotRated = 3400e6 / (5500 * 35);        // ~17.7 t/s primary
// The secondary's energy, per kilogramme, so its books close with the
// boiler and the condenser FREE: 70 bar saturated steam at 2772 kJ/kg, feed
// heated to 227 C (975 kJ/kg) by the feed heaters, condensate at 40 C
// (168 kJ/kg). 3.4 GW makes 1892 kg/s of steam from heated feed (the sim's
// own 1.5 MJ/kg cycle figure, 2267 kg/s, was a drawing number: no feed on
// earth is at 290 C). The turbine takes everything the condenser does not
// reject (2.2 GW at rated, the sim's cond_hx), which is the turbine's own
// 1.1 GW and the extraction steam that would have fed the heaters; the
// feed heaters put that back into the feed. Both scale with the flow.
const SEC = (() => {
  const hSteam = 2772e3, hFeedHot = 975e3, hCond = 168e3, condW = 2200e6, q = 3400e6;
  const mdot = q / (hSteam - hFeedHot);
  const hExh = hCond + condW / mdot;
  // the turbine's drop at rated flow (66 bar of the 70; the lines and the
  // exhaust's expansion take the rest) and the condensate pump's speed,
  // both measured settled, so day one starts where it will stay
  // (--cpump-speed <x> for the library's fixture: at 0.85 every step after
  // the release converges, at 0.95 none does)
  // THE FEED IS THROTTLED BY A VALVE, the pump runs at speed. A pump
  // slowed to hold the level could not go below 0.8 (its shut-off head
  // against 70 bar) and at 0.8 still pushed 1800 kg/s where decay heat
  // needs 213: the boiler overfilled and the hotwell drained to its nozzle.
  // The valve's Kfull is its authority (it burns 130 m at rated, wide open,
  // and closes to a few per cent at decay heat); the pump's speed carries
  // that margin; the opening is the settled day-one figure.
  const cpumpSpeed = args.includes('--cpump-speed') ? Number(args[args.indexOf('--cpump-speed') + 1]) : 0.87;
  const fvK = args.includes('--fv-k') ? Number(args[args.indexOf('--fv-k') + 1]) : 50;
  const fvOpen = args.includes('--fv-open') ? Number(args[args.indexOf('--fv-open') + 1]) : 0.393;
  const dpTurb = (args.includes('--turb-dp') ? Number(args[args.indexOf('--turb-dp') + 1]) : 53.39) * 1e5;   // 61.66 until the library sub-cycled the exhaust per edge: 64 K hotter, it needs 8 bar less
  return { mdot, dhTurb: hSteam - hExh, dhHeat: hFeedHot - hCond, hExh, dpTurb, cpumpSpeed, fvK, fvOpen };
})();
const devices = [
  { id: 'rcp', kind: 'pump', edge: 'cold', curve: { H0: 90, Qr: mdotRated / rho, Hr: 46 }, speed: 1, inertia: 8 },
  // rated 2.5 m3/s against the boiler's 70 bar (1000 m of feed) with a
  // margin, so its speed control has somewhere to go
  { id: 'cpump', kind: 'pump', edge: 'feed', curve: { H0: 1350, Qr: 2.5, Hr: 1050 }, speed: SEC.cpumpSpeed, cmd: SEC.cpumpSpeed, inertia: 3 },
  { id: 'cwpump', kind: 'pump', edge: 'cw_disch', curve: { H0: 22, Qr: 60, Hr: 9 }, speed: 1, inertia: 4 },
  // the injection pump: 45 kg/s rated at 1500 m, so it puts the sim's 40
  // into a vessel at 155 bar (at 100 kg/s rated it put 85)
  { id: 'eccs', kind: 'pump', edge: 'injection', curve: { H0: 1800, Qr: 0.045, Hr: 1500 }, speed: 0, cmd: 0, inertia: 2 },
  // The gravity line's valve: wide open it passes the sim's 55 kg/s under
  // the pool's two bars of head (K 2500 over the line's 0.14 m2), which is
  // what a throttled injection line does; at K 4 it would pour hundreds.
  { id: 'grav_valve', kind: 'valve', edge: 'gravity', open: 0, Kfull: 2500, tau: 3 },
  // the pool loop's isolation valve, opened when the plant calls for the
  // pool (the loop then runs on the solver's own buoyancy)
  { id: 'prhr_valve', kind: 'valve', edge: 'prhr_up', open: 0, Kfull: 4, tau: 5 },
  { id: 'inj_valve', kind: 'valve', edge: 'suction', open: 0, Kfull: 4, tau: 2 },
  // the condensate pump's check valve (without it, every step after the
  // secondary's release failed to converge and the two edges of the
  // condensate line disagreed by a thousand kg/s at the pump's junction)
  // The check on the suction STAYS, although a condensate pump has one on
  // its discharge only (feed_check): without it the app, every circuit free
  // and the reactor's level held, starved the feed to 790 kg/s within 400
  // steps and dried the boiler, while the harness's canonical run was fine.
  // With one on each side of the pump a hotwell ten centimetres lower had
  // the suction's check shut on a sub-step reversal and the pump's junction
  // left between two shut checks with nothing to fix its pressure (74 bar
  // at a condensate suction, 230 iterations a step): --no-suction-check is
  // that fixture for the library.
  ...(args.includes('--no-suction-check') ? [] : [{ id: 'cond_check', kind: 'check', edge: 'cond_suct', dir: 1 }]),
  { id: 'feed_check', kind: 'check', edge: 'feed_out', dir: 1 },
  { id: 'feed_valve', kind: 'valve', edge: 'feed_in', open: SEC.fvOpen, cmd: SEC.fvOpen, Kfull: SEC.fvK, tau: 1.5 },
  // the containment vent: K 150 passes the sim's 12 kg/s of steam under
  // half a bar of building pressure over the atmosphere
  { id: 'vent_valve', kind: 'valve', edge: 'vent', open: 0, Kfull: 150, tau: 2 },
  // The turbine: the generic component on the exhaust, a pressure drop
  // the governor drives to the plant's steam demand and the shaft power
  // taken out of the steam, both starting at their rated settings so day
  // one is steady. (Its admission as a choked orifice on the steam line is
  // the truer physics; the library's Newton did not converge on it and the
  // station blew up, reported. A constant drop driven to a flow target
  // needs the boiler held, which the plant model does anyway: left free
  // with it, the boiler blew down to 5 bar through a drop that opened to
  // nothing when the flow was short.)
  { id: 'turb', kind: 'loss', edge: 'exhaust', dp: SEC.dpTurb, W: SEC.dhTurb * SEC.mdot },
  // --orifice: the admission as a choked orifice on the steam line, the
  // library's fixture for the solve that did not converge on it
  ...(args.includes('--orifice') ? [{ id: 'turb_adm', kind: 'orifice', edge: 'steam', area: SEC.mdot / (0.61 * Math.sqrt(2 * 36 * 66.1e5)), cd: 0.61 }] : [])
];

// ---- heat ---------------------------------------------------------------
const heat = [
  { id: 'core', kind: 'source', on: 'node:rpv', W: 3400e6 },
  // NO feed heaters yet. On the feed line, the edge that carries the pump,
  // a heat source broke the solve on release (every step non-converged,
  // flows reversing: the edge's cells take their pressure from its two ends
  // whatever a device in it does, so water heated to 227 C sat in cells at
  // the pump's suction pressure and flashed); on the condensate line before
  // the pump it is 227 C water at a third of a bar, which flashes for real.
  // Heaters belong after the pump on their own edge (a junction at the
  // pump's discharge), and that is how they will go in when the boiler is
  // freed; with the boiler held by the plant model its energy books are the
  // plant's, and the feed goes in at the condenser's 40 C (SEC.dhHeat is
  // what the heaters would add). Reported to the library; --feed-heat puts
  // the heaters back on the feed line for its fixture.
  ...(args.includes('--feed-heat') ? [{ id: 'feed_heat', kind: 'source', on: 'edge:feed', W: SEC.mdot * SEC.dhHeat }] : []),
  // The tube bank, sized with MARGIN. Effectiveness-NTU with a saturated
  // shell is closed-form (eps = 1 - exp(-UA/Cmin), Cmin the primary's
  // 17.2 t/s at 6.17 kJ/kg/K = 106 MW/K): at 3400e6/54 the bank carried
  // 3.34 GW at the authored 48 K inlet difference against a 3.4 GW core,
  // two per cent inside its own limit, and looked healthy only because
  // the library's exchanger over-delivered by a third at 2 s steps (its
  // C29); at the honest duty the vessel climbed to saturation and boiled.
  // At 3400e6/26 (NTU 1.23, eps 0.71) the bank carries 3.6 GW at 48 K and
  // the vessel settles a few kelvin under its authored 607 K.
  { id: 'sg_hx', kind: 'exchanger', hot: 'edge:sg_tubes', cold: 'node:sg', UA: 3400e6 / 26, arrangement: 'counter' },
  { id: 'cond_hx', kind: 'exchanger', hot: 'node:cond', cold: 'edge:cond_tubes', UA: 2200e6 / 12, arrangement: 'counter' },
  { id: 'prhr_hx', kind: 'exchanger', hot: 'edge:coil', cold: 'node:pool', UA: 4e7, arrangement: 'counter' }
];

// ---- runs, the sim's circuits in flow order --------------------------------
const runs = [
  { id: 'run_primary', edges: ['hot', 'sg_tubes', 'cold', 'coldB'], normalise: 'run', extra: ['rpv'] },
  { id: 'run_secondary', edges: ['steam', 'exhaust', 'cond_suct', 'feed', 'feed_out', 'feed_in', 'downcomer', 'recirc'], normalise: 'run', extra: ['sg', 'sg_down', 'cond'] },
  { id: 'run_sea', edges: ['cw_suct', 'cw_disch', 'cond_tubes', 'cw_out'], normalise: 'run' },
  { id: 'run_prhr', edges: ['prhr_up', 'coil', 'prhr_down'], normalise: 'run' },
  // The cold lines take the reactor into their span. A run is painted over
  // its own span, and at rest the gravity and injection runs span three
  // kelvin (the tank at 18 C, its line at 15); the library paints the warm
  // end of any span past its two-kelvin deadband hot, so the emergency
  // water read as boiling. Both lines end in the primary, so the vessel's
  // water belongs to the span they are judged against, and against it they
  // are what they are, cold. That is what the schema's extra says; the
  // library carries it and does not count it yet (a run's span is its own
  // edges'), and its normalise 'network' is validated and never applied:
  // both reported. Until it lands the tank and the pool paint hot.
  { id: 'run_gravity', edges: ['gravity', 'fill'], normalise: 'run', extra: ['rpv'] },
  { id: 'run_inject', edges: ['suction', 'injection'], normalise: 'run', extra: ['rpv'] },
  { id: 'run_vent', edges: ['vent'], normalise: 'run' }
];

// WHICH DESIGN OWNS WHAT. The passive unit alone has the pool loop and the
// gravity line, the active unit alone the tank and the injection; the app
// builds each unit's network without the other design's elements (runs and
// heat links included) rather than keeping them shut by valves, which left
// the active unit a shut pool loop 17 m above a breached vessel at
// atmospheric pressure, its junction on the pressure floor for hours.
// --unit active|passive builds the same here.
const DESIGN = {
  passive: new Set(['pool', 'coil_in', 'coil_out', 'tee', 'prhr_up', 'coil', 'prhr_down', 'gravity', 'fill', 'prhr_valve', 'grav_valve', 'prhr_hx', 'run_prhr', 'run_gravity']),
  active: new Set(['tank', 'eccs_j', 'suction', 'injection', 'eccs', 'inj_valve', 'run_inject'])
};
for (const list of [nodes, edges, devices, heat, runs]) for (const x of list) for (const d of Object.keys(DESIGN)) if (DESIGN[d].has(x.id)) x.design = d;
function networkFor(json, design) {
  const keep = (x) => !x.design || x.design === design;
  const e2 = (json.edges || []).filter(keep), edgeIds = new Set(e2.map((e) => e.id));
  return Object.assign({}, json, {
    nodes: (json.nodes || []).filter(keep), edges: e2,
    devices: (json.devices || []).filter((d) => keep(d) && (!d.edge || edgeIds.has(d.edge))),
    heat: (json.heat || []).filter(keep),
    runs: (json.runs || []).filter(keep).map((r) => Object.assign({}, r, { edges: (r.edges || []).filter((id) => edgeIds.has(id)) })).filter((r) => r.edges.length)
  });
}
const net = {
  _: 'The station of nuclear-cooling-sim in the schema of 3d-fluid-simulator, written by tools/network.mjs from assets/layout.json. Unit-local metres, y up, the cut plane z = 0. Both designs are in one file, tagged: elements with design passive (the pool loop, the gravity line) or active (the tank, the injection) belong to that unit alone and are dropped from the network of the other unit (hydro.js networkFor).',
  version: 1, tempUnit: 'C',
  defaults: { fluid: 'water', rough: 4.5e-5, bend: 1.0, cells: 8, cd: 0.61 },
  nodes, edges, devices, heat, runs
};
// NETWORK_OUT=<path> writes the network elsewhere (a fixture run while the
// app is booting from assets/network.json must not rewrite it under it)
writeFileSync(process.env.NETWORK_OUT || 'assets/network.json', JSON.stringify(net, null, 2) + '\n');
console.log(`assets/network.json: ${nodes.length} nodes, ${edges.length} edges, ${devices.length} devices, ${heat.length} heat links, ${runs.length} runs`);

// ---- the library's opinion --------------------------------------------------
const core = await import(pathToFileURL(process.cwd() + '/vendor/fluidsim/core/index.js').href);
const problems = core.validate(net);
const list = Array.isArray(problems) ? problems : (problems && problems.errors) || [];
if (list.length) {
  console.log('validate:', list.length, 'problems');
  for (const p of list.slice(0, 40)) console.log('  ', typeof p === 'string' ? p : JSON.stringify(p));
} else console.log('validate: clean', problems && problems.warnings ? JSON.stringify(problems.warnings).slice(0, 600) : '');

if (runSecs > 0) {
  const unitDesign = args.includes('--unit') ? args[args.indexOf('--unit') + 1] : null;
  const unitNet = unitDesign === 'active' || unitDesign === 'passive' ? networkFor(net, unitDesign) : net;
  if (unitNet !== net) console.log('unit', unitDesign + ':', unitNet.nodes.length, 'nodes', unitNet.edges.length, 'edges', unitNet.devices.length, 'devices', unitNet.heat.length, 'heat links', unitNet.runs.length, 'runs');
  const network = core.Network.fromJSON(unitNet);
  // --dt <s> steps as the app does (up to 10 s a step); --maxsub <n> its sub-cycles
  const maxSub = args.includes('--maxsub') ? Number(args[args.indexOf('--maxsub') + 1]) : undefined;
  const solver = new core.Solver(network, maxSub ? { clock: () => performance.now(), maxSub } : { clock: () => performance.now() });
  // --twin: a second solver on the same network, given every hold the first
  // gets and stepped after it each step, as the app steps its two units;
  // if the first goes wrong only with the twin present, the library shares
  // state between instances
  const twin = args.includes('--twin') ? new core.Solver(core.Network.fromJSON(net), maxSub ? { clock: () => performance.now(), maxSub } : { clock: () => performance.now() }) : null;
  if (twin) for (const m of ['impose', 'imposeFlow', 'imposeEdgeT', 'heat']) { const f = solver[m].bind(solver), g = twin[m].bind(twin); solver[m] = (...a) => { g(...a); return f(...a); }; }
  // the sim's present flows, imposed, so the picture cannot change on day one
  const imposed = { hot: mdotRated, sg_tubes: mdotRated, cold: mdotRated, coldB: mdotRated,
    steam: SEC.mdot, exhaust: SEC.mdot, cond_suct: SEC.mdot, feed: SEC.mdot, feed_out: SEC.mdot, feed_in: SEC.mdot, downcomer: SEC.mdot,
    cw_suct: 60000, cw_disch: 60000, cond_tubes: 60000, cw_out: 60000,
    // the pool loop is at rest at power (its valve is shut); left free it
    // ran at 676 kg/s on its own buoyancy, boiled the pool and took
    // 600 MW off the primary, which cooled the vessel 15 K
    prhr_up: 0, coil: 0, prhr_down: 0 };
  // --free: nothing imposed, the pumps drive the flows
  // --free-cond: the condensate side solves itself (its pump drives it) while
  // everything else is held, so the hotwell can only give what it has
  // --free-sea / --free-primary: the migration's first two releases, each
  // circuit solving itself while everything else stays held
  const skip = new Set();
  if (args.includes('--free-cond')) for (const id of ['cond_suct', 'feed']) skip.add(id);
  if (args.includes('--free-sea')) for (const id of ['cw_suct', 'cw_disch', 'cond_tubes', 'cw_out']) skip.add(id);
  if (args.includes('--free-secondary')) for (const id of ['steam', 'exhaust', 'cond_suct', 'feed', 'feed_out', 'feed_in', 'downcomer']) skip.add(id);
  if (args.includes('--free-primary')) for (const id of ['hot', 'sg_tubes', 'cold', 'coldB']) skip.add(id);
  // --free-passive: the pool loop (shut by its valve until a scenario opens
  // it) and the other accident lines (already free, their valves shut)
  if (args.includes('--free-passive') || scenario) for (const id of ['prhr_up', 'coil', 'prhr_down']) skip.add(id);
  // --seed-accident: the accident lines seeded as the app seeds them (held
  // at zero flow and their day-one temperature for one step, then freed)
  if (args.includes('--seed-accident')) for (const id of ['suction', 'injection', 'vent', 'gravity', 'fill']) { imposed[id] = 0; skip.add(id); }
  // --unit active: the active unit's solver as the app runs it: the passive
  // design's lines held shut, its own accident lines seeded then freed
  // --unit active: the active unit's solver as the app runs it: the passive
  // design's lines are not in its network now; its own accident lines
  // seeded then freed
  if (args.includes('--unit') && args[args.indexOf('--unit') + 1] === 'active') {
    for (const id of ['suction', 'injection', 'vent']) { imposed[id] = 0; skip.add(id); }
  }
  for (const id of Object.keys(imposed)) if (!network.edge(id)) delete imposed[id];
  // a scenario is the plant after a trip: the turbine shut and the feed off
  // (the secondary's lines held at zero), the pumps off, decay heat
  if (scenario) { for (const id of ['steam', 'exhaust', 'cond_suct', 'feed', 'feed_out', 'feed_in', 'downcomer']) { imposed[id] = 0; skip.delete(id); } }
  // a scenario's primary and sea are FREE (the pumps are off; natural
  // circulation is the solver's to find): held at rated flow under a vessel
  // that flashes, a held edge divided by a density of 0.667 read 13941 m/s,
  // which was this harness's number and not the library's (its C39 round)
  if (scenario) for (const id of ['hot', 'sg_tubes', 'cold', 'coldB', 'cw_suct', 'cw_disch', 'cond_tubes', 'cw_out']) skip.add(id);
  // Day one for a freed circuit: its edges hold the sim's flow and their
  // steady temperatures (the node each leaves, end to end; an edge with a
  // heat link ramps to the node it reaches) for the FIRST step and are
  // freed after it, as hydro.js does. The solver starts every edge at 15 C
  // whatever its nodes say, and a loop freed from that poured sea-cold
  // water into the vessel for ten plant minutes.
  const seeded = [];
  if (!args.includes('--free')) {
    const nodeT = new Map(net.nodes.map((n) => [n.id, (Number.isFinite(n.T) ? n.T : 15) + 273.15]));
    const linked = new Set(net.heat.flatMap((h) => ['on', 'hot', 'cold'].map((k) => (/^edge:(.+)$/.exec(h[k] || '') || [])[1]).filter(Boolean)));
    for (const [id, m] of Object.entries(imposed)) {
      if (!skip.has(id)) { solver.imposeFlow(id, m); continue; }
      const e = net.edges.find((x) => x.id === id);
      const T0 = nodeT.get(e.from), T1 = linked.has(id) ? nodeT.get(e.to) : T0;
      solver.imposeFlow(id, m);
      if (e.fluid !== 'steam' || args.includes('--seed-vapour-t')) solver.imposeEdgeT(id, { T0, T1 });   // a vapour's temperature is its pressure's (--seed-vapour-t seeds it anyway, as the app does)
      seeded.push(id);
    }
  }
  if (args.includes('--govern')) console.log("governed: the turbine's drop driven to the plant's steam demand, the condensate pump's speed driven to match the feed to the steam");
  else if (args.includes('--free')) console.log('free run: nothing imposed');
  const govern = args.includes('--govern');
  const trace = args.includes('--trace') ? Number(args[args.indexOf('--trace') + 1]) : 0;
  // --trip s: the plant trips at that second the way the app does it (pumps
  // off, decay heat --trip-power (0.02), the steam line and the boiler's own
  // circulation held at zero, the feed pump stopped with its valve OPEN so the
  // check valve isolates); --trip-valve shut leaves the junction between the
  // closed check and the shut valve with no open edge, the library's
  // trapped-segment fixture (it wandered to a bound for 1400 steps in the
  // app, the check reporting 1593 kg/s backwards on the unconverged steps)
  const tripAt = args.includes('--trip') ? Number(args[args.indexOf('--trip') + 1]) : -1;
  const tripValve = args.includes('--trip-valve') ? args[args.indexOf('--trip-valve') + 1] : 'open';
  const tripPower = args.includes('--trip-power') ? Number(args[args.indexOf('--trip-power') + 1]) : 0.02;
  // --trip-pump on: the condensate pump kept running through the trip (the
  // app's mistake of counting the steam-driven RCIC as feed): dead-headed
  // against the valve, or draining the hotwell through it
  const tripPump = args.includes('--trip-pump') ? args[args.indexOf('--trip-pump') + 1] : 'off';
  let tripped = false, unconvAfterTrip = 0, stepsAfterTrip = 0;
  // every step that did not converge, by number, whatever the run: the
  // release's own steps are what is left on day one
  const unconvSteps = [];
  const gov = {};   // the controllers' state
  const KP_L = args.includes('--kpl') ? Number(args[args.indexOf('--kpl') + 1]) : 0.04, KD_L = args.includes('--kdl') ? Number(args[args.indexOf('--kdl') + 1]) : 1.5;   // the pump: per metre of level, per metre a second of its rate
  const CP_SPEED = args.includes('--cp-speed') ? Number(args[args.indexOf('--cp-speed') + 1]) : SEC.cpumpSpeed;   // the condensate pump's running speed
  const KP_GOV = args.includes('--kp') ? Number(args[args.indexOf('--kp') + 1]) * 1e5 : 0.5e5;   // the governor's proportional term, bar per unit of flow error
  const tail = { steam: 0, feed: 0 };   // the mean of the last ten steps
  const hw = { lo: Infinity, hi: -Infinity, npsh: Infinity, shut: 0 };   // the hotwell's level over the run, the suction's NPSH
  // the plant's steam demand at full power, kg/s: the sim's own figure
  // --demand kg/s: the plant's steam demand (decay heat is about 213)
  const STEAM_DEMAND = args.includes('--demand') ? Number(args[args.indexOf('--demand') + 1]) : SEC.mdot;
  const FV_MIN = 0.01;   // the valve never quite shuts under the law
  // --demand: the core makes what the secondary carries (a riser fed 3.4 GW
  // and steaming 213 kg/s boils its own water to quality one in 200 s)
  if (args.includes('--demand')) solver.heat('core', STEAM_DEMAND * (2772e3 - 975e3));
  const TURB_W_SCALE = args.includes('--turb-w') ? Number(args[args.indexOf('--turb-w') + 1]) : 1;

  if (TURB_W_SCALE !== 1) { const d = solver.device('turb'); if (d) d.W = (d.W || 0) * TURB_W_SCALE; }
  // --pin-vessels: hold the vessels' pressures as the app does (the plant
  // model owns them), to see what a held pressure does to a closed volume
  if (scenario) {
    // the plant after a trip: pumps off, decay heat at two per cent, the
    // secondary shut; then the scenario's own valve
    const rcp = solver.pump('rcp'); if (rcp) rcp.cmd = 0;
    solver.heat('core', 3400e6 * 0.02);
    const dev = { prhr: 'prhr_valve', gravity: 'grav_valve', inject: 'inj_valve', vent: 'vent_valve' }[scenario];
    const d = dev && solver.device(dev); if (d) d.cmd = 1;
    if (scenario === 'inject') { const e = solver.pump('eccs'); if (e) e.cmd = 1; }
    console.log('scenario', scenario + ': pumps off, decay heat 68 MW, secondary shut,', dev, 'opening');
  }
  // --pin-vessels holds every vessel the plant model owns; --unpin sg,cond
  // leaves the named ones to the solver (the secondary's release)
  if (args.includes('--pin-vessels')) {
    const unpin = new Set(args.includes('--unpin') ? String(args[args.indexOf('--unpin') + 1]).split(',') : []);
    const pRpv = scenario === 'gravity' ? 1.1e5 : 155e5;    // the plant depressurises before the pool can drain in
    for (const [id, p] of Object.entries({ przr: pRpv, rpv: pRpv, sg: 70e5, sg_down: 70e5, cond: P_COND, pool: 1.1e5, tank: 1.1e5 })) if (network.node(id) && !unpin.has(id)) solver.impose(id, { p });
    // the building's steam is steam: a boundary held at a pressure must
    // be held above its saturation there, or it is water (at 102 C and
    // 1.5 bar the vent line filled with water and passed 560 kg/s)
    // --rpv-level <m>: the reactor's level held as the app holds it
    if (args.includes('--rpv-level')) solver.impose('rpv', { p: pRpv, level: Number(args[args.indexOf('--rpv-level') + 1]) });
    // --pool-level <m>: the pool held at a level, as the app holds it (the
    // active unit's pool has no water: its level is the box's floor)
    if (args.includes('--pool-level')) solver.impose('pool', { p: 1.1e5, level: Number(args[args.indexOf('--pool-level') + 1]) });
    // the app's other holds: --pin-sump (the orphan sump's pressure), --pin-cont (the
    // building at the plant's pressure two kelvin over saturation), --tank-level <m>
    if (args.includes('--pin-sump') && network.node('sump')) solver.impose('sump', { p: 101325 });
    if (args.includes('--pin-cont') && network.node('cont')) solver.impose('cont', { p: 101325, T: core.props.tsat(101325) + 2 });
    if (args.includes('--tank-level')) solver.impose('tank', { p: 101325, level: Number(args[args.indexOf('--tank-level') + 1]) });
    // --hold-surge: the pressuriser's surge line held at zero flow, as the app holds it
    if (args.includes('--hold-surge') && network.edge('surge')) solver.imposeFlow('surge', 0);
    // --rpv-level-once: the reactor's level held for the FIRST step only and released, as the app's hysteresis does at boot
    if (args.includes('--rpv-level-once')) solver.impose('rpv', { p: pRpv, level: Number(args[args.indexOf('--rpv-level-once') + 1]) });
    if (scenario === 'vent' && network.node('cont')) solver.impose('cont', { p: 1.5e5, T: core.props.tsat(1.5e5) + 2 });
    // both boil, so both are held ON the saturation line (a hold a kelvin
    // off it is unmet, and report.unmetHold said so)
    if (!unpin.has('sg')) solver.impose('sg', { p: 70e5, T: core.props.tsat(70e5) });
    if (!unpin.has('cond')) solver.impose('cond', { p: P_COND, T: core.props.tsat(P_COND) });
    console.log('vessel pressures held' + (unpin.size ? ', except ' + [...unpin].join(', ') : ''));
  }
  if (args.includes('--pin')) {
    const pins = { sg_hot: 155e5, sg_cold: 155e5, rcp_j: 155e5, turb_in: 70e5, cpump_j: P_COND, cw_in: 3e5, cw_out_j: 2.5e5, cwpump_j: 3e5 };
    for (const [id, p] of Object.entries(pins)) solver.impose(id, { p });
    console.log('junction pressures pinned');
  }
  const dt = args.includes('--dt') ? Number(args[args.indexOf('--dt') + 1]) : 0.05, N = Math.round(runSecs / dt);
  let worst = 0, nanAt = -1, ms = 0, last = null;
  for (let i = 0; i < N; i++) {
    // --freeze-gov <s>: the controllers stop moving after s seconds, to
    // see whether an oscillation is theirs or the solver's
    const frozen = args.includes('--freeze-gov') && i * dt >= Number(args[args.indexOf('--freeze-gov') + 1]);
    if (tripAt >= 0 && !tripped && i * dt >= tripAt) {
      tripped = true;
      const rcp = solver.pump('rcp'); if (rcp) rcp.cmd = 0;
      const cw = solver.pump('cwpump'); if (cw) cw.cmd = 0;
      const cp = solver.pump('cpump'); if (cp) cp.cmd = tripPump === 'on' ? (cp.cmd || 0.87) : 0;
      const fv = solver.device('feed_valve'); if (fv) fv.cmd = tripValve === 'shut' ? 0 : tripValve === 'crack' ? 0.01 : 1;
      const tb = solver.device('turb'); if (tb) { const pSg = solver.volumes.find((v) => v.id === 'sg').p, pC = solver.volumes.find((v) => v.id === 'cond').p; tb.dp = Math.max(0, pSg - pC); tb.W = 0; }
      solver.heat('core', 3400e6 * tripPower);
      for (const id of ['steam', 'exhaust', 'downcomer', 'recirc']) if (network.edge(id)) solver.imposeFlow(id, 0);
      console.log('trip at', (i * dt).toFixed(0), 's: pumps off, decay heat', (tripPower * 100).toFixed(0) + '%, steam line and boiler circulation held, feed valve', tripValve, 'pump', tripPump);
    }
    if (govern && !frozen && !tripped) {
      // The plant's two secondary controls, as feedback the host applies
      // to DEVICES (imposing the flows was a hold by another name):
      // the governor sets the turbine's pressure drop so the steam flow
      // meets the plant's demand, and the condensate pump's speed is
      // driven so the feed matches the steam (a variable-speed feed pump
      // is the plant's own level control).
      const turb = solver.device('turb'), cp = solver.pump('cpump'), fv = solver.device('feed_valve');
      const st = solver.edge('steam'), fd = solver.edge('feed');
      // The drop the turbine may take: the boiler's pressure less the
      // condenser's, from the VESSELS. Taken from the turb_in junction it
      // read one atmosphere on the first step (a junction starts there),
      // clamped the drop to a bar, and the loop was freed into a surge of
      // 8000 kg/s that filled the condenser and dried the boiler.
      const pSg = solver.volumes.find((v) => v.id === 'sg').p;
      const pC = solver.volumes.find((v) => v.id === 'cond').p;
      const avail = Math.max(0, pSg - pC);
      if (turb && st && !args.includes('--orifice')) {
        // Too much flow: more drop. The flow is stiff in the drop (four bar
        // of the seventy drive it through the lines), so the drop is a slow
        // integral of the flow error (a bar a second per unit, no more) plus
        // a proportional term (half a bar per unit; two made a two-step limit cycle) that stops the hunt; the
        // error is clamped to one unit (a transient reverse flow on the
        // first free step read as minus thirty units and zeroed the drop).
        const err = Math.max(-1, Math.min(1, (st.mdot - STEAM_DEMAND) / STEAM_DEMAND));
        if (gov.dpI === undefined) gov.dpI = turb.dp || 0;
        gov.dpI = Math.max(0, Math.min(avail, gov.dpI + 0.3e5 * err * Math.min(2, dt)));
        turb.dp = Math.max(0, Math.min(avail, gov.dpI + KP_GOV * err));
        // The shaft power follows the flow on the rotor's time constant,
        // not the step: set from the step's own flow it fed back on the
        // flow one step late (more flow, more power out, a wetter exhaust,
        // less friction) and the steam alternated 1560/2200 kg/s for ever.
        if (gov.mW === undefined) gov.mW = st.mdot;
        gov.mW += (st.mdot - gov.mW) * Math.min(1, dt / 10);
        turb.W = TURB_W_SCALE * SEC.dhTurb * Math.max(0, gov.mW);
      }

      if (args.includes('--feed-heat') && fd) solver.heat('feed_heat', SEC.dhHeat * Math.max(0, fd.mdot));
      if (cp && st && fd) {
        // The pump's speed from the boiler's LEVEL, which is real under the
        // pressure hold (hostMakeup is 0): a proportional term on the level
        // error, a slow integral of it, and a proportional term on the flow
        // mismatch so a step in demand is met before the level has moved.
        // Two integrators on flow alone hunted for twenty minutes and moved
        // sixty tonnes from the boiler to the condenser while they did.
        // The pump's speed from the boiler's LEVEL and its RATE only. A term
        // on the flow mismatch (steam less feed) chased itself the moment the
        // library published the honest mean of a chattering line: a shut
        // sub-step lowers the mean, the term pushes harder, the line chatters
        // more (1 of 301 unconverged became 299). The level's rate is the
        // inventory rate the volume's books conserve, and cannot be made to
        // chase itself.
        // THE LAW DRIVES THE VALVE; the pump runs at its speed. (It drove the
        // pump's speed once, and could not go below 0.8 without stalling
        // against 70 bar, nor deliver less than 1800 kg/s at 0.8.)
        // FEED-FORWARD ON THE STEAM FLOW, the law trimming. The hotwell holds
        // five seconds of rated flow, so the feed has to follow the steam
        // within seconds: the valve's opening is set from the steam leaving
        // the boiler (flow is near enough proportional to opening through
        // the range, so the loop's gain is the same at decay heat as at
        // rated) and the level law only corrects the rest. On the DEMAND it
        // cut the feed thirty seconds before the governor had brought the
        // steam down, the boiler lost thirty tonnes, the law poured them
        // back through a hotwell that holds nine, and wound up. The steam
        // flow is what the governor makes, not what the feed does, so this
        // is a feed-forward and cannot chase itself (a term on steam LESS
        // feed did). ANTI-WINDUP: the integrator holds while the suction is
        // starved or the valve is at a stop.
        // THE LAW HOLDS THE BOILER'S INVENTORY (riser plus downcomer), in
        // metres-equivalent at 12 t a metre of waterline, not its mixture
        // level: at decay heat the riser's void collapses and the level
        // drops four metres with the mass unchanged (shrink), and a law on
        // the level poured sixty tonnes after it that the hotwell (nine)
        // never had. The level the picture shows is then the honest one.
        const sgV = solver.volumes.find((v) => v.id === 'sg'), sdV = solver.volumes.find((v) => v.id === 'sg_down');
        const inv = (sgV.mass || 0) + (sdV ? sdV.mass || 0 : 0);
        if (gov.inv0 === undefined) { gov.inv0 = inv; gov.sgLevel0 = sgV.level; gov.cmdI = 0; gov.invPrev = inv; gov.mSteam = SEC.mdot; }
        if (i === 0) { cp.cmd = CP_SPEED; } else {
        gov.mSteam += (Math.max(0, st.mdot) - gov.mSteam) * Math.min(1, dt / 4);
        const ff = SEC.fvOpen * gov.mSteam / SEC.mdot;
        const eL = Math.max(-2, Math.min(2, (gov.inv0 - inv) / 12000));            // metres-equivalent short of the set inventory
        const rate = Math.max(-0.05, Math.min(0.05, (inv - gov.invPrev) / 12000 / Math.max(1e-3, dt)));  // m/s equivalent, falling is negative
        gov.invPrev = inv;
        const starved = last && (last.atBoundNode === 'cpump_j' || last.shutEdge === 'cond_suct');
        const atStop = fv && (fv.cmd >= 1 || fv.cmd <= FV_MIN);
        if (!starved && !(atStop && Math.sign(eL) === Math.sign(fv.cmd - 0.5))) gov.cmdI = Math.max(FV_MIN - ff, Math.min(1 - ff, gov.cmdI + 0.0015 * eL * Math.min(2, dt)));
        cp.cmd = CP_SPEED;
        if (fv) fv.cmd = Math.max(FV_MIN, Math.min(1, ff + gov.cmdI + KP_L * eL - KD_L * rate));
        }
      }
    }
    if (twin) { const t1 = twin.device('turb'), t0 = solver.device('turb'), c1 = twin.pump('cpump'), c0 = solver.pump('cpump'), r1 = twin.pump('rcp'), r0 = solver.pump('rcp'); if (t1 && t0) { t1.dp = t0.dp; t1.W = t0.W; } if (c1 && c0) c1.cmd = c0.cmd; if (r1 && r0) r1.cmd = r0.cmd; }
    // --reimpose: every vessel hold re-applied before every step, as the app
    // applies its holds every frame (the harness sets them once at setup)
    if (args.includes('--reimpose') && args.includes('--pin-vessels')) {
      const pR = scenario === 'gravity' ? 1.1e5 : 155e5;
      for (const [id, p] of Object.entries({ przr: pR, sg: 70e5, sg_down: 70e5, cond: P_COND, tank: 1.1e5 })) if (network.node(id)) solver.impose(id, { p });
      solver.impose('sg', { p: 70e5, T: core.props.tsat(70e5) }); solver.impose('cond', { p: P_COND, T: core.props.tsat(P_COND) });
      if (args.includes('--rpv-level')) solver.impose('rpv', { p: pR, level: Number(args[args.indexOf('--rpv-level') + 1]) }); else solver.impose('rpv', { p: pR });
      if (args.includes('--pool-level')) solver.impose('pool', { p: 1.1e5, level: Number(args[args.indexOf('--pool-level') + 1]) }); else if (network.node('pool')) solver.impose('pool', { p: 1.1e5 });
      if (args.includes('--pin-sump') && network.node('sump')) solver.impose('sump', { p: 101325 });
      if (args.includes('--pin-cont') && network.node('cont')) solver.impose('cont', { p: 101325, T: core.props.tsat(101325) + 2 });
      if (args.includes('--tank-level')) solver.impose('tank', { p: 101325, level: Number(args[args.indexOf('--tank-level') + 1]) });
      if (args.includes('--hold-surge') && network.edge('surge')) solver.imposeFlow('surge', 0);
    }
    const rep = solver.step(dt); last = rep;
    if (tripped) { stepsAfterTrip++; if (!rep.converged) unconvAfterTrip++; }
    if (!rep.converged) unconvSteps.push(i + 1 + (rep.worstNode ? ':' + rep.worstNode : ''));
    if (twin) { const r2 = twin.step(dt); if (trace > i) { const v = twin.volumes.find((x) => x.id === 'sg'), h = twin.edge('hot'); console.log('     twin: conv', r2.converged, r2.iters, 'atBound', r2.atBoundNode, 'sg', Math.round(v.mass), 'hot', Math.round(h.mdot)); } }
    if (i >= N - 10) { const st = solver.edge('steam'), fd = solver.edge('feed'); tail.steam += (st.mdot || 0) / 10; tail.feed += (fd.mdot || 0) / 10; }
    { const cv = solver.volumes.find((v) => v.id === 'cond'); if (cv) { hw.lo = Math.min(hw.lo, cv.level); hw.hi = Math.max(hw.hi, cv.level); }
      const cs = solver.edge('feed'); if (cs && Number.isFinite(cs.npsh)) hw.npsh = Math.min(hw.npsh, cs.npsh); if (rep.shutEdge === 'cond_suct') hw.shut++; }
    if (trace > i) { const tb = solver.device('turb'), st = solver.edge('steam'), fd = solver.edge('feed'), cs = solver.edge('cond_suct'); const sgL = solver.volumes.find((v) => v.id === 'sg').level, cdL = solver.volumes.find((v) => v.id === 'cond').level; const vol = (id) => solver.volumes.find((v) => v.id === id) || {}, ed = (id) => solver.edge(id) || {}; console.log('   step', i, 'cw', Math.round(ed('cw_suct').mdot || 0), 'npsh', Number.isFinite(ed('feed').npsh) ? ed('feed').npsh.toFixed(2) : '-', 'shut', rep.shutEdge + '/' + rep.shutWhy, 'ab', rep.atBoundNode || '-', 'cond lvl', cdL.toFixed(2), 'kg', Math.round(vol('cond').mass || 0), 'sg_down lvl', (vol('sg_down').level || 0).toFixed(2), 'set', (gov.sgLevel0 || 0).toFixed(2), 'steam', (st.mdot || 0).toFixed(0), 'feed', (fd.mdot || 0).toFixed(0), 'fv', ((solver.device('feed_valve') || {}).open || 0).toFixed(3), 'inv', Math.round(((vol('sg').mass || 0) + (vol('sg_down').mass || 0)) / 1000) + 't', 'sg', Math.round((vol('sg').mass || 0) / 1000) + 't/x' + (vol('sg').x || 0).toFixed(3) + '/T' + ((vol('sg').T || 0) - 273.15).toFixed(1), 'sgd', Math.round((vol('sg_down').mass || 0) / 1000) + 't/' + (vol('sg_down').level || 0).toFixed(2), 'cond_suct', (cs.mdot || 0).toFixed(0), 'dp', ((tb && tb.dp || 0) / 1e5).toFixed(2), 'sg lvl', sgL.toFixed(2), 'conv', rep.converged, rep.iters); }
    // --seed-steps n: the day-one seed held for n steps before the release (1)
    if (i === (args.includes('--seed-steps') ? Number(args[args.indexOf('--seed-steps') + 1]) : 1) - 1) for (const id of seeded) { solver.imposeFlow(id, null); solver.imposeEdgeT(id, null); }
    if (i === 0 && args.includes('--rpv-level-once')) { solver.impose('rpv', null); solver.impose('rpv', { p: 155e5 }); }
    ms += rep.ms || 0;
    worst = Math.max(worst, Math.abs(rep.massResidual || 0));
    if (nanAt < 0) for (const e of solver.edges) if (!Number.isFinite(e.mdot) || !Number.isFinite(e.T1)) { nanAt = i; break; }
  }
  if (govern) { const tb = solver.device('turb'), cp = solver.pump('cpump'), fv = solver.device('feed_valve'); console.log('  governor: turbine dp', ((tb && tb.dp || 0) / 1e5).toFixed(2), 'bar, W', ((tb && tb.W || 0) / 1e6).toFixed(0), 'MW; cpump cmd', (cp && cp.cmd || 0).toFixed(3), 'speed', (cp && cp.speed || 0).toFixed(3), '; feed valve open', (fv && fv.open || 0).toFixed(3), 'cmd', (fv && fv.cmd || 0).toFixed(3)); }
  if (govern) console.log('  last ten steps: steam', tail.steam.toFixed(0), 'feed', tail.feed.toFixed(0), 'kg/s (mean)');
  if (Number.isFinite(hw.lo)) console.log('  hotwell: level', hw.lo.toFixed(2), 'to', hw.hi.toFixed(2), 'm; suction npsh min', Number.isFinite(hw.npsh) ? hw.npsh.toFixed(2) : 'n/a', 'm; suction shut', hw.shut, 'steps');
  console.log('  steps that did not converge:', unconvSteps.length, 'of', N, unconvSteps.length ? '(' + unconvSteps.slice(0, 12).join(' ') + (unconvSteps.length > 12 ? ' ...' : '') + ')' : '');
  if (tripped) console.log('  after the trip:', unconvAfterTrip, 'of', stepsAfterTrip, 'steps did not converge; mass adrift', Math.round((last && last.massAdrift) || 0), 'kg; last report atBound', (last && last.atBoundNode) || '-', 'shut', (last && last.shutEdge) || '-');
  console.log(`stepped ${N} x ${dt}s: ${(ms / N * 1000).toFixed(1)} us/step, worst mass residual ${worst.toExponential(2)}, NaN at step ${nanAt}`);
  if (last) console.log('  last report:', JSON.stringify({ converged: last.converged, iters: last.iters, adrift: last.adrift, overspeedEdges: last.overspeedEdges, overspeedEdge: last.overspeedEdge, worstNode: last.worstNode, shutEdges: last.shutEdges, shutEdge: last.shutEdge, shutWhy: last.shutWhy, carried: last.carried, rejectedField: last.rejectedField, unmetHolds: last.unmetHolds, unmetHold: last.unmetHold, hostMakeup: last.hostMakeup, overfilled: last.overfilled, overfilledNode: last.overfilledNode, atBound: last.atBound, atBoundNode: last.atBoundNode }));
  for (const e of solver.edges) console.log('  ', String(e.id).padEnd(11), 'mdot', (e.mdot || 0).toFixed(1).padStart(9), 'v', (e.v || 0).toFixed(2).padStart(7), 'T', (e.T0 || 0).toFixed(1), '->', (e.T1 || 0).toFixed(1));
  for (const id of ['sg_hot', 'sg_cold', 'rcp_j', 'turb_in', 'cpump_j', 'cwpump_j', 'cw_in', 'cw_out_j', 'tee', 'coil_in']) {
    const i = solver.sys.nodeIds.index(id);
    if (i >= 0) console.log('   junction', id.padEnd(9), 'p', ((solver.sys.ndP ? solver.sys.ndP[i] : NaN) / 1e5).toFixed(3), 'bar');
  }
  if (scenario) { for (const id of ['prhr_valve', 'grav_valve', 'inj_valve', 'vent_valve']) { const d = solver.device(id); if (d) console.log('   valve', id.padEnd(10), 'open', (d.open || 0).toFixed(2)); } const e = solver.pump('eccs'); if (e) console.log('   eccs speed', (e.speed || 0).toFixed(2)); }
  for (const v of solver.volumes) console.log('  ', String(v.id).padEnd(11), 'level', (v.level || 0).toFixed(2), 'T', (v.T || 0).toFixed(1), 'p', ((v.p || 0) / 1e5).toFixed(2), 'bar', 'x', (v.x || 0).toFixed(3), 'mass', (v.m ?? v.mass ?? NaN).toFixed(0), 'kg');
}
