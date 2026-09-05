// ---------------------------------------------------------------------------
// network.js - THE LAYOUT. What the network IS, kept separate from the state
// a solver carries and from the meshes a renderer builds.
//
// A network is nodes (junctions, volumes, boundaries), edges (pipes, ducts,
// tube banks) joining them, devices sitting in edges (pump, valve, check,
// orifice, break) and heat links crossing walls. Everything is authored in
// metres and, for temperature only, in degrees Celsius, because that is how
// people write a layout. It is converted ONCE here, on the way in, and after
// that the whole library is strict SI: kg/s, Pa absolute, K, J/kg.
//
// Three tiers of runtime edit, and the whole design of the version counters
// exists to keep them apart:
//
//   1. A DEVICE SETPOINT (open, speed, area, W, UA). Bumps nothing, rebuilds
//      nothing: the coefficient pass reads the live device object every
//      sub-step. Free.
//   2. GEOMETRY (pts, dia, bend, n, cells, rough, k). Bumps `geomVersion`, so
//      the solver recomputes areas, lengths and elbow losses and a renderer
//      knows to rebuild that one tube. Cheap.
//   3. TOPOLOGY (a node, edge, device or heat link added or removed, or an
//      edge's ends changed). Bumps `topoVersion`: the unknown vector changes
//      size and everything is re-indexed. Still under the rebuild budget.
//
// Every counter is monotone and `version` bumps for all three, so a consumer
// that only wants "did anything change" watches one number.
//
// No three.js, no DOM, no clock, no allocation in anything a frame calls: the
// only allocation here happens inside an edit, which is a user action.
// ---------------------------------------------------------------------------

import { clamp, num } from './util.js?v=03485aad37';
import { polylineLength, buildShape, splitPts } from './geometry.js?v=03485aad37';
import { hasFluid, fluidNames, degK } from './props.js?v=03485aad37';

export const DEFAULTS = Object.freeze({
  fluid: 'water', rough: 4.5e-5, bend: 0.6, cells: 8, cd: 0.61
});

// The schema this file reads. A layout carrying anything else is rejected
// rather than guessed at, because a silently mis-read layout draws a plausible
// picture of the wrong plant.
export const SCHEMA_VERSION = 1;

// The dense LDL^T path is exact and cheap up to this many pressure unknowns
// and a sparse path is M2. The limit lives here, not in solver.js, so that
// `validate()` can report it without importing the solver.
// A sanity bound, not an algorithmic one. It used to be 64 because the solve
// was a dense factorisation, which is n cubed in time and n squared in memory;
// past that a whole plant rather than one machine was simply refused. The
// sparse path took the algorithm out of the way, so what is left is a guard
// against a generated file with a million nodes in it, set far above any model
// a person would build by hand or export from Blender.
export const MAX_NODES = 100000;

// A valve at or below this is HARD closed: its edge leaves the matrix and its
// flow is exactly 0.0. The same number is `VALVE_SHUT` in hydraulic.js; it is
// repeated here rather than imported because network.js must not depend on the
// solver, and `components()` needs it to know which edges still join two nodes.
const VALVE_SHUT = 1e-3;

export const NODE_KINDS = Object.freeze(['junction', 'volume', 'boundary']);
export const DEVICE_KINDS = Object.freeze(['pump', 'valve', 'check', 'orifice', 'break']);
export const HEAT_KINDS = Object.freeze(['source', 'sink', 'exchanger', 'ambient']);
export const SHAPE_KINDS = Object.freeze(['lathe', 'box', 'area', 'point']);
export const NORMALISE_KINDS = Object.freeze(['run', 'network', 'absolute']);

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

// Every failure names the offending id, the JSON path to the field and, where
// there is a choice, the legal values. A validation message that says only
// "invalid network" costs an hour of somebody's evening.
export class NetworkError extends Error {
  constructor(code, path, msg, hint) {
    super(msg);
    this.name = 'NetworkError';
    this.code = code;
    this.path = path || '';
    this.hint = hint || '';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const list = (a) => a.join(', ');

// Levenshtein distance, stopped as soon as it exceeds `cap`. Two rolling rows,
// so a long id costs nothing to reject.
function editDistance(a, b, cap) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > cap) return cap + 1;
  let prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

// "did you mean X?" for a mistyped id. Two edits is the useful cut: three
// starts suggesting genuinely different names and reads as noise.
function suggest(id, known) {
  if (typeof id !== 'string' || !id) return '';
  let best = null, bestD = 3;
  for (const k of known) {
    if (k === id) continue;
    const d = editDistance(id, k, 2);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best ? ': did you mean "' + best + '"?' : '';
}

function push(errors, code, path, message, hint) {
  errors.push({ code, path, message, hint: hint || '' });
  return errors;
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

// Never throws, and returns EVERY problem at once rather than the first: a
// layout with six typos is fixed in one pass instead of six.
export function validate(json, opts) {
  const errors = [], warnings = [];
  try {
    checkDocument(json, opts || {}, errors, warnings);
  } catch (e) {
    push(errors, 'E_NOT_FINITE', '',
      'the layout could not be read: ' + ((e && e.message) || e),
      'this is a bug in validate() or a layout of an unexpected shape');
  }
  return { ok: errors.length === 0, errors, warnings };
}

function checkDocument(json, opts, errors, warnings) {
  if (!isObj(json)) {
    return push(errors, 'E_VERSION', '', 'the layout is not an object',
      'pass the parsed JSON, not its text');
  }
  if (json.version !== SCHEMA_VERSION) {
    push(errors, 'E_VERSION', '/version',
      'version must be ' + SCHEMA_VERSION + ', got ' + JSON.stringify(json.version),
      'this library reads schema version ' + SCHEMA_VERSION + ' only');
  }
  if (json.tempUnit != null && json.tempUnit !== 'C' && json.tempUnit !== 'K') {
    push(errors, 'E_BAD_KIND', '/tempUnit',
      'tempUnit must be one of C, K, got ' + JSON.stringify(json.tempUnit),
      'C is the default; it applies to the T and Tinf fields and to nothing else');
  }
  // THE DOCUMENT'S DEFAULT FLUID IS CHECKED TOO. Every per-record fluid name
  // was, and this one was not, so a single typo in `defaults` loaded every
  // node that did not name a fluid of its own carrying something that does not
  // exist. The failure appears later, somewhere else, as properties that make
  // no sense, which is the most expensive kind of mistake to find.
  if (isObj(json.defaults) && json.defaults.fluid != null && !hasFluid(json.defaults.fluid)) {
    push(errors, 'E_UNKNOWN_FLUID', '/defaults/fluid',
      'the document default fluid "' + json.defaults.fluid + '" is not a fluid'
      + suggest(json.defaults.fluid, fluidNames()),
      'known fluids: ' + list(fluidNames()) + '; register your own with defineFluid()');
  }
  const nodes = json.nodes, edges = json.edges;
  if (!Array.isArray(nodes) || nodes.length < 1) {
    push(errors, 'E_BAD_KIND', '/nodes', 'nodes must be an array with at least one node',
      'every edge joins two of them');
    return;
  }
  if (json.edges != null && !Array.isArray(edges)) {
    push(errors, 'E_BAD_KIND', '/edges', 'edges must be an array', 'it may be empty');
    return;
  }
  const eArr = Array.isArray(edges) ? edges : [];
  const dArr = Array.isArray(json.devices) ? json.devices : [];
  const hArr = Array.isArray(json.heat) ? json.heat : [];
  const rArr = Array.isArray(json.runs) ? json.runs : [];

  if (nodes.length > MAX_NODES) {
    push(errors, 'E_TOO_LARGE', '/nodes',
      'this network has ' + nodes.length + ' nodes and the limit is ' + MAX_NODES,
      'split the model into more than one network');
  }

  // Ids are unique across the WHOLE layout, not per section: an edge and a
  // device sharing a name makes `release("x")` ambiguous and the error it
  // produces is unreadable.
  const all = new Set(), nodeIds = new Set(), edgeIds = new Set(), devIds = new Set();
  const seen = (raw, path, into) => {
    const id = raw && raw.id;
    if (typeof id !== 'string' || id.length === 0) {
      push(errors, 'E_BAD_KIND', path + '/id', 'every record needs a non-empty string id',
        'ids name things in errors, in runs and in the runtime API');
      return false;
    }
    if (all.has(id)) {
      push(errors, 'E_DUPLICATE_ID', path + '/id', 'duplicate id "' + id + '"',
        'ids must be unique across nodes, edges, devices, heat links and runs');
      return false;
    }
    all.add(id);
    if (into) into.add(id);
    return true;
  };

  for (let i = 0; i < nodes.length; i++) seen(nodes[i], '/nodes/' + i, nodeIds);
  for (let i = 0; i < eArr.length; i++) seen(eArr[i], '/edges/' + i, edgeIds);
  for (let i = 0; i < dArr.length; i++) seen(dArr[i], '/devices/' + i, devIds);
  for (let i = 0; i < hArr.length; i++) seen(hArr[i], '/heat/' + i, null);
  for (let i = 0; i < rArr.length; i++) seen(rArr[i], '/runs/' + i, null);

  for (let i = 0; i < nodes.length; i++) checkNode(nodes[i], '/nodes/' + i, errors);
  for (let i = 0; i < eArr.length; i++) checkEdge(eArr[i], '/edges/' + i, nodeIds, devIds, errors);
  for (let i = 0; i < dArr.length; i++) checkDevice(dArr[i], '/devices/' + i, nodeIds, edgeIds, errors);
  for (let i = 0; i < hArr.length; i++) checkHeat(hArr[i], '/heat/' + i, nodeIds, edgeIds, errors);
  for (let i = 0; i < rArr.length; i++) checkRun(rArr[i], '/runs/' + i, edgeIds, errors);

  checkGraph(nodes, eArr, dArr, hArr, opts, errors, warnings);
}

function checkNumbers(raw, path, fields, errors) {
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (raw[f] != null && !fin(raw[f])) {
      push(errors, 'E_NOT_FINITE', path + '/' + f,
        '"' + raw.id + '" has a ' + f + ' that is not a finite number: ' + JSON.stringify(raw[f]),
        'a NaN here reaches a vertex position and the body of fluid disappears');
    }
  }
}

function checkNode(raw, path, errors) {
  if (!isObj(raw)) return push(errors, 'E_BAD_KIND', path, 'a node must be an object');
  const id = raw.id;
  if (NODE_KINDS.indexOf(raw.kind) < 0) {
    push(errors, 'E_BAD_KIND', path + '/kind',
      'node "' + id + '" has kind ' + JSON.stringify(raw.kind) + '; it must be one of ' + list(NODE_KINDS),
      'junction has no inventory, volume has mass and a level, boundary is held for ever');
  }
  if (!Array.isArray(raw.at) || raw.at.length !== 3 || !fin(raw.at[0]) || !fin(raw.at[1]) || !fin(raw.at[2])) {
    push(errors, 'E_BAD_POINTS', path + '/at',
      'node "' + id + '" needs at: [x, y, z] in metres, three finite numbers',
      'at[1] is the reference elevation and y is up');
  }
  if (raw.fluid != null && !hasFluid(raw.fluid)) {
    push(errors, 'E_UNKNOWN_FLUID', path + '/fluid',
      'node "' + id + '" names an unknown fluid "' + raw.fluid + '"' + suggest(raw.fluid, fluidNames()),
      'known fluids: ' + list(fluidNames()) + '; register your own with defineFluid()');
  }
  if (raw.kind === 'boundary' && raw.p == null) {
    push(errors, 'E_NOT_FINITE', path + '/p',
      'boundary "' + id + '" needs a pressure p in Pa absolute',
      'a boundary holds its pressure and enthalpy for ever, so it must be told them');
  }
  checkNumbers(raw, path, ['p', 'T', 'x', 'fill', 'mixSpan'], errors);
  if (raw.gas != null) {
    if (!isObj(raw.gas) || !fin(raw.gas.p)) {
      push(errors, 'E_NOT_FINITE', path + '/gas/p',
        'node "' + id + '" has a gas space with no finite pressure',
        'gas: { p } in Pa absolute, the pressure above the free surface');
    }
  }
  if (raw.shape != null) checkShape(raw.shape, path + '/shape', id, raw.kind, errors);
  else if (raw.kind === 'volume' && raw.free === true) {
    push(errors, 'E_SHAPE_EMPTY', path + '/shape',
      'volume "' + id + '" has a free surface but no shape, so it holds nothing',
      'give it a lathe, box or area shape; a free surface needs a level and a level needs a volume');
  }
}

function checkShape(s, path, id, kind, errors) {
  if (!isObj(s) || SHAPE_KINDS.indexOf(s.kind) < 0) {
    return push(errors, 'E_BAD_KIND', path + '/kind',
      'node "' + id + '" has a shape kind ' + JSON.stringify(s && s.kind) + '; it must be one of ' + list(SHAPE_KINDS));
  }
  if (s.kind === 'point') return;
  if (s.kind === 'box') {
    if (!fin(s.h) || s.h <= 0 || !fin(s.w) || !fin(s.d) || s.w * s.d <= 0) {
      return push(errors, 'E_SHAPE_SIZE', path,
        'box shape on "' + id + '" needs w, d and h all greater than zero',
        'y0 is the absolute elevation of its floor and h its height in metres');
    }
  } else {
    const key = s.kind === 'lathe' ? 'profile' : 'table';
    const p = s[key];
    if (!Array.isArray(p) || p.length < 2) {
      return push(errors, 'E_SHAPE_SIZE', path + '/' + key,
        s.kind + ' shape on "' + id + '" needs a ' + key + ' of at least two entries');
    }
    // A lathe is [r, y] and an area table is [y, A], so the elevation sits in
    // the other column of each. Getting this the wrong way round builds a
    // vessel lying on its side, which is why both are checked here by name.
    const yi = s.kind === 'lathe' ? 1 : 0, vi = 1 - yi;
    let prev = -Infinity;
    for (let i = 0; i < p.length; i++) {
      const row = p[i];
      if (!Array.isArray(row) || row.length < 2 || !fin(row[0]) || !fin(row[1])) {
        return push(errors, 'E_SHAPE_SIZE', path + '/' + key + '/' + i,
          s.kind + ' shape on "' + id + '" has a bad entry at ' + i + '; each row is two finite numbers');
      }
      // Going BACKWARDS is the error, not standing still. A vessel outline has
      // a flat floor and a flat roof: two entries at the same elevation with
      // different radii are how a lathe draws them, and they add no volume, so
      // the cumulative table stays monotone. Rejecting them would reject every
      // real tank ever drawn.
      if (row[yi] < prev) {
        return push(errors, 'E_SHAPE_Y', path + '/' + key + '/' + i,
          s.kind + ' shape on "' + id + '" has y going backwards at entry ' + i +
          ' (' + row[yi] + ' after ' + prev + ')',
          'the elevations must not decrease, and they are absolute, not relative to the node');
      }
      if (row[vi] < 0) {
        return push(errors, 'E_SHAPE_SIZE', path + '/' + key + '/' + i,
          s.kind + ' shape on "' + id + '" has a negative ' + (s.kind === 'lathe' ? 'radius' : 'area') + ' at entry ' + i);
      }
      prev = row[yi];
    }
  }
  // Everything structural passed, so the built shape can be trusted to tell us
  // whether it actually holds anything.
  let built = null;
  try { built = buildShape(s); } catch (e) {
    // buildShape already decided WHICH failure this is and hung the code on
    // the error, so use it: a vessel that encloses nothing is E_SHAPE_EMPTY
    // and a host branching on that code has to see it. Flattening every build
    // failure to E_SHAPE_SIZE made E_SHAPE_EMPTY unreachable for every shape
    // that had one, which is every shape except a free volume with no shape
    // at all.
    return push(errors, (e && e.code) || 'E_SHAPE_SIZE', path,
      'shape on "' + id + '" could not be built: ' + ((e && e.message) || e),
      (e && e.hint) || '');
  }
  if (built && !(built.Vtotal > 0) && kind === 'volume') {
    push(errors, 'E_SHAPE_EMPTY', path,
      'shape on "' + id + '" encloses no volume (Vtotal = ' + built.Vtotal + ')',
      'a volume with nothing in it should be a junction, or a point shape');
  }
}

function checkEdge(raw, path, nodeIds, devIds, errors) {
  if (!isObj(raw)) return push(errors, 'E_BAD_KIND', path, 'an edge must be an object');
  const id = raw.id;
  for (const end of ['from', 'to']) {
    if (!nodeIds.has(raw[end])) {
      push(errors, 'E_UNKNOWN_NODE', path + '/' + end,
        'edge "' + id + '" has ' + end + ' "' + raw[end] + '" which is not a node' + suggest(raw[end], nodeIds),
        'positive mdot runs from -> to; nothing depends on that being the physical direction');
    }
  }
  if (raw.from === raw.to) {
    push(errors, 'E_SELF_EDGE', path,
      'edge "' + id + '" joins node "' + raw.from + '" to itself',
      'an edge from a node to itself carries no pressure difference and no flow');
  }
  if (!fin(raw.dia) || raw.dia <= 0) {
    push(errors, 'E_ZERO_BORE', path + '/dia',
      'edge "' + id + '" has dia ' + JSON.stringify(raw.dia) + '; it must be a finite bore greater than zero in metres',
      'area, velocity and Reynolds number all divide by it');
  }
  if (!Array.isArray(raw.pts) || raw.pts.length < 2) {
    push(errors, 'E_BAD_POINTS', path + '/pts',
      'edge "' + id + '" needs pts: at least two [x, y, z] points in metres');
  } else {
    let bad = -1;
    for (let i = 0; i < raw.pts.length; i++) {
      const p = raw.pts[i];
      if (!Array.isArray(p) || p.length !== 3 || !fin(p[0]) || !fin(p[1]) || !fin(p[2])) { bad = i; break; }
    }
    if (bad >= 0) {
      push(errors, 'E_BAD_POINTS', path + '/pts/' + bad,
        'edge "' + id + '" has a bad point at index ' + bad + '; each is [x, y, z], three finite numbers');
    } else if (!(polylineLength(raw.pts) > 0)) {
      push(errors, 'E_ZERO_LENGTH', path + '/pts',
        'edge "' + id + '" has zero length: every point is in the same place',
        'a zero-length edge has infinite resistance per metre and no elevation change to drive it');
    }
  }
  if (raw.device != null && !devIds.has(raw.device)) {
    push(errors, 'E_UNKNOWN_DEVICE', path + '/device',
      'edge "' + id + '" names device "' + raw.device + '" which does not exist' + suggest(raw.device, devIds),
      'one in-line device per edge; split the edge to put two in series');
  }
  if (raw.fluid != null && !hasFluid(raw.fluid)) {
    push(errors, 'E_UNKNOWN_FLUID', path + '/fluid',
      'edge "' + id + '" names an unknown fluid "' + raw.fluid + '"' + suggest(raw.fluid, fluidNames()),
      'known fluids: ' + list(fluidNames()));
  }
  if (raw.n != null && (!fin(raw.n) || raw.n < 1)) {
    push(errors, 'E_NOT_FINITE', path + '/n',
      'edge "' + id + '" has n = ' + JSON.stringify(raw.n) + '; it is how many identical parallel paths this one drawn edge stands for, so it is at least 1');
  }
  checkNumbers(raw, path, ['bend', 'rough', 'k', 'cells', 'vmax'], errors);
}

function checkDevice(raw, path, nodeIds, edgeIds, errors) {
  if (!isObj(raw)) return push(errors, 'E_BAD_KIND', path, 'a device must be an object');
  const id = raw.id;
  if (DEVICE_KINDS.indexOf(raw.kind) < 0) {
    return push(errors, 'E_BAD_KIND', path + '/kind',
      'device "' + id + '" has kind ' + JSON.stringify(raw.kind) + '; it must be one of ' + list(DEVICE_KINDS));
  }
  if (!edgeIds.has(raw.edge)) {
    push(errors, 'E_UNKNOWN_EDGE', path + '/edge',
      'device "' + id + '" sits in edge "' + raw.edge + '" which does not exist' + suggest(raw.edge, edgeIds),
      'a device is always in an edge; it is the edge that carries the flow');
  }
  if (raw.kind === 'pump') {
    const c = raw.curve;
    if (!isObj(c) || !fin(c.H0) || !fin(c.Qr) || !fin(c.Hr)) {
      push(errors, 'E_PUMP_CURVE', path + '/curve',
        'pump "' + id + '" needs curve: { H0, Qr, Hr } with three finite numbers',
        'H0 m shutoff head, Qr m3/s rated flow, Hr m head at Qr');
    } else if (!(c.H0 > 0) || !(c.Qr > 0) || c.Hr < 0 || c.Hr > c.H0) {
      push(errors, 'E_PUMP_CURVE', path + '/curve',
        'pump "' + id + '" has an impossible curve H0=' + c.H0 + ' Qr=' + c.Qr + ' Hr=' + c.Hr,
        'H0 > 0, Qr > 0 and 0 <= Hr <= H0: a pump makes less head as it makes more flow, never more');
    }
    checkNumbers(raw, path, ['speed', 'inertia', 'cmd'], errors);
  } else if (raw.kind === 'valve') {
    checkNumbers(raw, path, ['open', 'Kfull', 'tau', 'cmd'], errors);
    if (raw.tau != null && raw.tau <= 0) {
      push(errors, 'E_NOT_FINITE', path + '/tau',
        'valve "' + id + '" has tau = ' + raw.tau + '; it is the seconds to travel full stroke, so it is greater than zero');
    }
  } else if (raw.kind === 'check') {
    if (raw.dir != null && raw.dir !== 1 && raw.dir !== -1) {
      push(errors, 'E_BAD_KIND', path + '/dir',
        'check valve "' + id + '" has dir = ' + JSON.stringify(raw.dir) + '; it must be 1 or -1',
        '1 passes flow from -> to, -1 the other way');
    }
  } else if (raw.kind === 'orifice') {
    checkNumbers(raw, path, ['area', 'cd'], errors);
  } else if (raw.kind === 'break') {
    checkNumbers(raw, path, ['at', 'area', 'cd'], errors);
    if (!nodeIds.has(raw.to)) {
      push(errors, 'E_UNKNOWN_NODE', path + '/to',
        'break "' + id + '" discharges to "' + raw.to + '" which is not a node' + suggest(raw.to, nodeIds),
        'a break has to go somewhere: usually a boundary standing for the atmosphere or the floor');
    }
  }
}

function heatTarget(s) {
  if (typeof s !== 'string') return null;
  if (s.startsWith('node:')) return { kind: 'node', id: s.slice(5) };
  if (s.startsWith('edge:')) return { kind: 'edge', id: s.slice(5) };
  return null;
}

function checkHeatOn(raw, field, path, nodeIds, edgeIds, errors) {
  const t = heatTarget(raw[field]);
  if (!t) {
    return push(errors, 'E_UNKNOWN_HEAT_TARGET', path + '/' + field,
      'heat link "' + raw.id + '" has ' + field + ' = ' + JSON.stringify(raw[field]),
      'it must read "edge:<id>" or "node:<id>"');
  }
  const known = t.kind === 'node' ? nodeIds : edgeIds;
  if (!known.has(t.id)) {
    push(errors, 'E_UNKNOWN_HEAT_TARGET', path + '/' + field,
      'heat link "' + raw.id + '" points at ' + t.kind + ' "' + t.id + '" which does not exist' + suggest(t.id, known));
  }
}

function checkHeat(raw, path, nodeIds, edgeIds, errors) {
  if (!isObj(raw)) return push(errors, 'E_BAD_KIND', path, 'a heat link must be an object');
  const id = raw.id;
  if (HEAT_KINDS.indexOf(raw.kind) < 0) {
    return push(errors, 'E_BAD_KIND', path + '/kind',
      'heat link "' + id + '" has kind ' + JSON.stringify(raw.kind) + '; it must be one of ' + list(HEAT_KINDS));
  }
  if (raw.kind === 'exchanger') {
    checkHeatOn(raw, 'hot', path, nodeIds, edgeIds, errors);
    checkHeatOn(raw, 'cold', path, nodeIds, edgeIds, errors);
    checkNumbers(raw, path, ['UA'], errors);
    if (raw.arrangement != null && ['counter', 'parallel', 'cross'].indexOf(raw.arrangement) < 0) {
      push(errors, 'E_BAD_KIND', path + '/arrangement',
        'exchanger "' + id + '" has arrangement ' + JSON.stringify(raw.arrangement) + '; it must be one of counter, parallel, cross');
    }
  } else {
    checkHeatOn(raw, 'on', path, nodeIds, edgeIds, errors);
    if (raw.kind === 'ambient') checkNumbers(raw, path, ['U', 'perim', 'Tinf'], errors);
    else checkNumbers(raw, path, ['W'], errors);
  }
  if (raw.profile != null && typeof raw.profile === 'string'
    && raw.profile !== 'uniform' && raw.profile !== 'cos') {
    push(errors, 'E_BAD_KIND', path + '/profile',
      'heat link "' + id + '" has profile ' + JSON.stringify(raw.profile) + '; it must be "uniform", "cos" or an array of weights');
  }
  if (Array.isArray(raw.profile)) {
    let sum = 0, bad = false;
    for (let i = 0; i < raw.profile.length; i++) {
      if (!fin(raw.profile[i])) bad = true; else sum += raw.profile[i];
    }
    if (bad || raw.profile.length < 1 || !(Math.abs(sum) > 0)) {
      push(errors, 'E_NOT_FINITE', path + '/profile',
        'heat link "' + id + '" has a profile array that is empty, not finite, or sums to zero',
        'the weights are normalised to sum 1, so they cannot all be zero');
    }
  }
}

function checkRun(raw, path, edgeIds, errors) {
  if (!isObj(raw)) return push(errors, 'E_BAD_KIND', path, 'a run must be an object');
  if (!Array.isArray(raw.edges) || raw.edges.length < 1) {
    return push(errors, 'E_BAD_KIND', path + '/edges',
      'run "' + raw.id + '" needs edges: a list of edge ids in flow order');
  }
  for (let i = 0; i < raw.edges.length; i++) {
    if (!edgeIds.has(raw.edges[i])) {
      push(errors, 'E_UNKNOWN_EDGE', path + '/edges/' + i,
        'run "' + raw.id + '" lists edge "' + raw.edges[i] + '" which does not exist' + suggest(raw.edges[i], edgeIds));
    }
  }
  if (raw.normalise != null && NORMALISE_KINDS.indexOf(raw.normalise) < 0) {
    push(errors, 'E_BAD_KIND', path + '/normalise',
      'run "' + raw.id + '" has normalise ' + JSON.stringify(raw.normalise) + '; it must be one of ' + list(NORMALISE_KINDS));
  }
}

// Whole-graph checks: the ones that cannot be made looking at one record.
function checkGraph(nodes, edges, devices, heat, opts, errors, warnings) {
  const idx = new Map();
  for (let i = 0; i < nodes.length; i++) if (nodes[i] && nodes[i].id != null) idx.set(nodes[i].id, i);
  const parent = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const deg = new Int32Array(nodes.length);
  for (let e = 0; e < edges.length; e++) {
    const a = idx.get(edges[e].from), b = idx.get(edges[e].to);
    if (a == null || b == null) continue;
    deg[a]++; deg[b]++;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < nodes.length; i++) {
    if (deg[i] === 0) {
      push(warnings, 'W_ORPHAN_NODE', '/nodes/' + i,
        'node "' + nodes[i].id + '" has no edges, so nothing can reach it',
        'it will hold its initial state for ever');
    }
  }
  // A component with no boundary and no free volume has no pressure reference:
  // every pressure in it is determined only up to a constant. `hydraulic` pins
  // it at its previous pressure and reports it, so it is a warning here unless
  // the host asked to be strict.
  const hasRef = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const r = find(i);
    const isRef = nodes[i].kind === 'boundary' || (nodes[i].kind === 'volume' && nodes[i].free === true);
    if (isRef || !hasRef.has(r)) hasRef.set(r, (hasRef.get(r) || false) || isRef);
  }
  const reported = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const r = find(i);
    if (hasRef.get(r) || reported.has(r) || deg[i] === 0) continue;
    reported.add(r);
    const where = opts.strictReference ? errors : warnings;
    push(where, 'E_NO_REFERENCE', '/nodes/' + i,
      'the part of the network holding node "' + nodes[i].id + '" has no boundary and no free volume, so it has no pressure reference',
      'give it a boundary, or a volume with free: true; without one the solver pins it at rest and reports it in report.pinned');
  }
  if (heat.length === 0) {
    push(warnings, 'W_NO_HEAT', '/heat',
      'this network has no heat links, so every temperature will stay where it started',
      'add a source, an exchanger or an ambient link to make anything change');
  }
  // A loop whose nodes are all at the same elevation cannot circulate on
  // buoyancy: the driving head integral is identically zero however hot it
  // gets. That is nearly always a layout typo rather than an intention.
  if (edges.length >= 3) {
    let ymin = Infinity, ymax = -Infinity, any = false;
    for (let i = 0; i < nodes.length; i++) {
      if (deg[i] === 0 || !Array.isArray(nodes[i].at) || !fin(nodes[i].at[1])) continue;
      any = true;
      if (nodes[i].at[1] < ymin) ymin = nodes[i].at[1];
      if (nodes[i].at[1] > ymax) ymax = nodes[i].at[1];
    }
    if (any && ymax - ymin < 1e-6 && edges.length >= nodes.length) {
      push(warnings, 'W_FLAT_LOOP', '/nodes',
        'every connected node is at the same elevation, so buoyancy can never drive anything',
        'natural circulation needs the heat in low and the cooling high');
    }
  }
}

// ---------------------------------------------------------------------------
// normalisation: the layout as this library holds it
// ---------------------------------------------------------------------------

// A record without the underscore fields the library hangs on it: the record
// type tag, the resolved link indices the solver caches there, the provenance
// of a split. None of them belong in a layout a human reads or diffs, and
// leaving them in would make a saved layout depend on solver internals.
function strip(rec) {
  const out = {};
  for (const k in rec) if (k.charCodeAt(0) !== 95) out[k] = rec[k];
  return out;
}

const copyPts = (pts) => {
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) out[i] = [+pts[i][0], +pts[i][1], +pts[i][2]];
  return out;
};

function normShape(s) {
  if (!isObj(s) || s.kind === 'point' || s.kind == null) return { kind: 'point' };
  if (s.kind === 'box') return { kind: 'box', w: +s.w, d: +s.d, y0: num(s.y0, 0), h: +s.h };
  const key = s.kind === 'lathe' ? 'profile' : 'table';
  const rows = new Array(s[key].length);
  for (let i = 0; i < rows.length; i++) rows[i] = [+s[key][i][0], +s[key][i][1]];
  return s.kind === 'lathe' ? { kind: 'lathe', profile: rows } : { kind: 'area', table: rows };
}

function normNode(raw, defaults, toK) {
  const free = raw.kind === 'volume' && raw.free === true;
  const gasP = isObj(raw.gas) ? num(raw.gas.p, 101325) : 101325;
  const rec = {
    id: raw.id,
    kind: raw.kind,
    at: [+raw.at[0], +raw.at[1], +raw.at[2]],
    fluid: raw.fluid == null ? defaults.fluid : raw.fluid,
    shape: normShape(raw.shape),
    free,
    gas: { p: gasP },
    p: num(raw.p, free ? gasP : 101325),
    T: toK(num(raw.T, toK === degK ? 15 : 288.15)),
    x: clamp(num(raw.x, 0), 0, 1),
    fill: clamp(num(raw.fill, free ? 0.5 : 1), 0, 1),
    mixSpan: num(raw.mixSpan, 0.6),
    display: raw.display == null ? {} : raw.display
  };
  return rec;
}

function normEdge(raw, defaults, nodeById) {
  const from = nodeById.get(raw.from);
  const rec = {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    fluid: raw.fluid == null ? (from ? from.fluid : defaults.fluid) : raw.fluid,
    dia: +raw.dia,
    n: Math.max(1, Math.round(num(raw.n, 1))),
    pts: copyPts(raw.pts),
    bend: Math.max(0, num(raw.bend, defaults.bend)),
    rough: Math.max(0, num(raw.rough, defaults.rough)),
    k: Math.max(0, num(raw.k, 0)),
    cells: clamp(Math.round(num(raw.cells, defaults.cells)), 2, 32),
    device: raw.device == null ? null : raw.device,
    // WHAT SORT OF THING THIS EDGE IS, for whoever draws it. The solver does
    // not read it: a tube bank and a pipe carry water by the same equations.
    // The renderer does, and draws a thin-walled bank as a bare run of water
    // with no casing round it, because what you want to see in a heat
    // exchanger is the water changing colour and not a pipe drawn over it.
    // It was being dropped on load, so a layout that asked for a tube bank got
    // a pipe and there was nothing to say why.
    kind: raw.kind == null ? 'pipe' : String(raw.kind),
    // The velocity limit is a property of what the edge carries, so it can only
    // be defaulted once the fluid is known. `null` means "ask the solver", which
    // reads opts.vmaxLiquid or opts.vmaxVapour at rebuild.
    vmax: raw.vmax == null ? null : num(raw.vmax, null),
    display: raw.display == null ? {} : raw.display,
    // Per-edge geometry stamp: a renderer holding one tube watches this rather
    // than the network-wide geomVersion, so moving one pipe does not rebuild
    // fifty meshes.
    _geomVer: 1
  };
  return rec;
}

function normDevice(raw, defaults) {
  const d = { id: raw.id, kind: raw.kind, edge: raw.edge };
  if (raw.kind === 'pump') {
    d.curve = { H0: +raw.curve.H0, Qr: +raw.curve.Qr, Hr: +raw.curve.Hr };
    d.speed = num(raw.speed, 1);
    d.inertia = Math.max(1e-3, num(raw.inertia, 6));
    d.cmd = num(raw.cmd, d.speed);
  } else if (raw.kind === 'valve') {
    d.open = clamp(num(raw.open, 1), 0, 1);
    d.Kfull = Math.max(0, num(raw.Kfull, 4));
    d.tau = Math.max(1e-3, num(raw.tau, 2));
    d.cmd = clamp(num(raw.cmd, d.open), 0, 1);
  } else if (raw.kind === 'check') {
    d.dir = raw.dir === -1 ? -1 : 1;
  } else if (raw.kind === 'orifice') {
    d.area = Math.max(0, num(raw.area, 0));
    d.cd = num(raw.cd, defaults.cd);
  } else if (raw.kind === 'break') {
    d.at = clamp(num(raw.at, 0.5), 0, 1);
    d.area = Math.max(0, num(raw.area, 0));
    d.cd = num(raw.cd, defaults.cd);
    d.to = raw.to;
  }
  return d;
}

function normHeat(raw) {
  const h = { id: raw.id, kind: raw.kind };
  if (raw.kind === 'exchanger') {
    h.hot = raw.hot; h.cold = raw.cold;
    h.UA = Math.max(0, num(raw.UA, 0));
    h.arrangement = raw.arrangement == null ? 'counter' : raw.arrangement;
  } else if (raw.kind === 'ambient') {
    h.on = raw.on;
    h.U = Math.max(0, num(raw.U, 0));
    h.perim = Math.max(0, num(raw.perim, 0));
    // Left UNSET when the layout did not author one, so that fromJSON can tell
    // an authored temperature (which is in the document's own unit and has to
    // be converted) from the default (which is already kelvin and must not be).
    // Defaulting here instead put 288.15 through the Celsius conversion and
    // loaded every unstated ambient in a Celsius layout at 288 C: a boiling hot
    // room, quietly heating the whole model, with nothing to see but numbers
    // that were too high.
    h.Tinf = raw && Number.isFinite(raw.Tinf) ? raw.Tinf : null;
  } else {
    h.on = raw.on;
    h.W = num(raw.W, 0);
    // A profile array is carried through EXACTLY as authored and normalised at
    // the point of use. Normalising it here would make toJSON emit a slightly
    // different array from the one it read (the sum of a normalised array is
    // not bit-exactly 1), and serialisation would stop being a fixed point.
    //
    // A SINK IS SUGAR FOR A SOURCE WITH -W, and that means it carries an axial
    // profile too. Reading the profile only for kind "source" silently threw
    // away the shape of every cooler: a condenser written to take its heat out
    // of the top two cells of a downcomer was spread over the whole leg
    // instead, which moves the thermal centre of the sink by half the height
    // of the loop and changes the natural-circulation flow it drives. The
    // shape of a sink is not decoration; it is where the cold water is, and
    // that is what buoyancy integrates.
    h.profile = Array.isArray(raw.profile) ? raw.profile.slice() : (raw.profile == null ? 'uniform' : raw.profile);
  }
  return h;
}

function normRun(raw) {
  return {
    id: raw.id,
    edges: raw.edges.slice(),
    normalise: raw.normalise == null ? 'run' : raw.normalise,
    extra: Array.isArray(raw.extra) ? raw.extra.slice() : []
  };
}

// ---------------------------------------------------------------------------
// the Network
// ---------------------------------------------------------------------------

export class Network {
  constructor() {
    this.tempUnit = 'C';
    this.defaults = Object.assign({}, DEFAULTS);
    this.opts = {};
    this._nodes = []; this._edges = []; this._devices = []; this._heat = []; this._runs = [];
    this._byId = new Map();
    this._version = 1; this._geomVersion = 1; this._topoVersion = 1;
    this._editing = false;
    this._frozen = 0;
    this._dirty = 0; this._dirtyGeom = false; this._dirtyTopo = false; this._sawEdit = false;
    this._added = []; this._removed = []; this._changed = [];
    this._listeners = new Map();
  }

  // Strict: the first error is thrown, with its id, its path and a hint. Use
  // validate() first if you want all of them.
  static fromJSON(json, opts) {
    const o = opts || {};
    const v = validate(json, o);
    if (!v.ok) {
      const e = v.errors[0];
      throw new NetworkError(e.code, e.path, e.message, e.hint);
    }
    const net = new Network();
    net.opts = o;
    net.tempUnit = json.tempUnit == null ? 'C' : json.tempUnit;
    net.defaults = Object.assign({}, DEFAULTS, isObj(json.defaults) ? json.defaults : null);
    // The ONE conversion in the whole library. After this line every
    // temperature in this process is kelvin.
    const toK = net.tempUnit === 'C' ? degK : (t) => t;

    for (const raw of json.nodes) net._insert(net._nodes, normNode(raw, net.defaults, toK));
    for (const raw of (json.edges || [])) net._insert(net._edges, normEdge(raw, net.defaults, net._byId));
    for (const raw of (json.devices || [])) net._insert(net._devices, normDevice(raw, net.defaults));
    for (const raw of (json.heat || [])) {
      const h = normHeat(raw);
      // Convert only what was written down. An unstated ambient is fifteen
      // degrees, in kelvin, whatever unit the rest of the document is in.
      if (h.kind === 'ambient') h.Tinf = h.Tinf == null ? 288.15 : toK(h.Tinf);
      net._insert(net._heat, h);
    }
    for (const raw of (json.runs || [])) net._insert(net._runs, normRun(raw));

    // THE LINK IS WRITTEN FROM BOTH ENDS, so it has to be READ from both ends.
    // A device names its edge and an edge may name its device, and addDevice()
    // has always filled in the edge's half when a host adds one through the
    // API. Doing it only there meant that a layout which said it once, on the
    // device, where the schema makes the field mandatory, loaded a pump that
    // was attached to nothing: no head, no droop, no error, and a loop that
    // quietly runs on gravity. Filling it in here makes the two ways of
    // writing the same sentence mean the same thing.
    //
    // A `break` is left alone. Its device belongs on the discharge edge that
    // the split below creates, not on the line it is cut into, and putting it
    // on the line first would carry it to the wrong half.
    for (let i = 0; i < net._devices.length; i++) {
      const d = net._devices[i];
      if (d.kind === 'break') continue;
      const e = net._byId.get(d.edge);
      if (e && e._t === 2 && e.device == null) e.device = d.id;
    }

    // A `break` in the layout is DECLARATIVE: the split it describes is
    // performed once, here, so that a broken line in a saved layout and a line
    // broken at run time by splitEdge() are the same network afterwards and
    // there is only one code path to test.
    //
    // The test for "already split" is structural rather than a flag, because a
    // flag would not survive toJSON: a break edge that already ends at its own
    // discharge node IS the discharge path and needs no second split. That is
    // what makes serialisation a fixed point.
    for (let i = 0; i < net._devices.length; i++) {
      const d = net._devices[i];
      if (d.kind !== 'break') continue;
      const e = net._byId.get(d.edge);
      if (!e || e.to === d.to) continue;
      net._splitEdgeInner(d.edge, d.at, d);
    }
    net._dirty = 0; net._dirtyGeom = false; net._dirtyTopo = false;
    net._added.length = 0; net._removed.length = 0; net._changed.length = 0;
    return net;
  }

  // Normalised, with every default written out and every temperature in
  // KELVIN, which is why tempUnit comes back as "K": the runtime API is SI and
  // a layout written out by the library reads back to exactly the same
  // network. Network.fromJSON(net.toJSON()).toJSON() deep-equals net.toJSON().
  toJSON() {
    const nodes = new Array(this._nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const n = this._nodes[i];
      nodes[i] = {
        id: n.id, kind: n.kind, at: n.at.slice(), fluid: n.fluid,
        shape: normShape(n.shape), free: n.free, gas: { p: n.gas.p },
        p: n.p, T: n.T, x: n.x, fill: n.fill, mixSpan: n.mixSpan, display: n.display
      };
    }
    const edges = new Array(this._edges.length);
    for (let i = 0; i < edges.length; i++) {
      const e = this._edges[i];
      edges[i] = {
        id: e.id, from: e.from, to: e.to, fluid: e.fluid, dia: e.dia, n: e.n,
        pts: copyPts(e.pts), bend: e.bend, rough: e.rough, k: e.k, cells: e.cells,
        device: e.device, vmax: e.vmax, display: e.display
      };
    }
    const devices = new Array(this._devices.length);
    for (let i = 0; i < devices.length; i++) {
      const d = strip(this._devices[i]);
      if (d.curve) d.curve = { H0: d.curve.H0, Qr: d.curve.Qr, Hr: d.curve.Hr };
      devices[i] = d;
    }
    const heat = new Array(this._heat.length);
    for (let i = 0; i < heat.length; i++) {
      const h = strip(this._heat[i]);
      if (Array.isArray(h.profile)) h.profile = h.profile.slice();
      heat[i] = h;
    }
    const runs = new Array(this._runs.length);
    for (let i = 0; i < runs.length; i++) {
      runs[i] = { id: this._runs[i].id, edges: this._runs[i].edges.slice(), normalise: this._runs[i].normalise, extra: this._runs[i].extra.slice() };
    }
    return {
      version: SCHEMA_VERSION,
      tempUnit: 'K',
      defaults: Object.assign({}, this.defaults),
      nodes, edges, devices, heat, runs
    };
  }

  // Ids are unique across the whole layout, so one map answers all five and
  // the tag written at insertion says which kind came back. Guessing the kind
  // from the shape of the record works right up until two kinds agree on a
  // field name, and then it fails silently.
  node(id) { const r = this._byId.get(id); return r && r._t === 1 ? r : undefined; }
  edge(id) { const r = this._byId.get(id); return r && r._t === 2 ? r : undefined; }
  device(id) { const r = this._byId.get(id); return r && r._t === 3 ? r : undefined; }
  heatLink(id) { const r = this._byId.get(id); return r && r._t === 4 ? r : undefined; }
  run(id) { const r = this._byId.get(id); return r && r._t === 5 ? r : undefined; }

  // The live arrays, in insertion order. They are handed out rather than
  // copied because a solver walks them every rebuild and a renderer every
  // frame; do not mutate them, use the add/remove methods.
  get nodes() { return this._nodes; }
  get edges() { return this._edges; }
  get devices() { return this._devices; }
  get heat() { return this._heat; }
  get runs() { return this._runs; }

  get version() { return this._version; }
  get geomVersion() { return this._geomVersion; }
  get topoVersion() { return this._topoVersion; }

  on(evt, fn) {
    let a = this._listeners.get(evt);
    if (!a) { a = []; this._listeners.set(evt, a); }
    a.push(fn);
    return this;
  }
  off(evt, fn) {
    const a = this._listeners.get(evt);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    return this;
  }
  _emit(evt, payload) {
    const a = this._listeners.get(evt);
    if (!a) return;
    for (let i = 0; i < a.length; i++) a[i](payload);
  }

  // --- editing ------------------------------------------------------------

  // Batches every mutation inside `fn` into ONE version bump and one rebuild.
  // Not re-entrant: an edit that starts inside another edit would publish a
  // half-applied network, and the counters would no longer say what changed.
  edit(fn) {
    if (this._editing) {
      throw new NetworkError('E_REENTRANT', '', 'net.edit() is not re-entrant',
        'finish the outer edit first, or make one call that does both');
    }
    this._guard();
    this._editing = true;
    this._sawEdit = false;
    try { fn(this); } finally { this._editing = false; }
    // A host is free to poke a field on a record it got from net.edge(id).
    // Nothing here can see that, so an edit that used none of the mutators is
    // assumed to have changed geometry. Over-reporting costs one rebuild;
    // under-reporting draws the old pipe for ever.
    if (!this._sawEdit) { this._dirty = 1; this._dirtyGeom = true; }
    this._flush();
    return this;
  }

  _guard() {
    if (this._frozen > 0) {
      throw new NetworkError('E_REENTRANT', '',
        'the network cannot be edited from inside Solver.step()',
        'edit it between steps: the solver is walking these arrays right now');
    }
  }

  // Used by Solver to make the network read-only for the duration of a step.
  _freeze() { this._frozen++; }
  _thaw() { if (this._frozen > 0) this._frozen--; }

  _touch(level, id, how) {
    this._guard();
    this._sawEdit = true;
    this._dirty = 1;
    if (level >= 2) this._dirtyGeom = true;
    if (level >= 3) this._dirtyTopo = true;
    if (id != null) {
      const a = how === 'add' ? this._added : how === 'remove' ? this._removed : this._changed;
      if (a.indexOf(id) < 0) a.push(id);
    }
    if (!this._editing) this._flush();
  }

  _flush() {
    if (!this._dirty) return;
    this._version++;
    if (this._dirtyGeom) this._geomVersion++;
    if (this._dirtyTopo) this._topoVersion++;
    const payload = {
      added: this._added.slice(), removed: this._removed.slice(),
      changed: this._changed.slice(), version: this._version
    };
    this._dirty = 0; this._dirtyGeom = false; this._dirtyTopo = false;
    this._added.length = 0; this._removed.length = 0; this._changed.length = 0;
    this._emit('change', payload);
  }

  _insert(arr, rec) {
    rec._t = arr === this._nodes ? 1 : arr === this._edges ? 2
      : arr === this._devices ? 3 : arr === this._heat ? 4 : 5;
    this._byId.set(rec.id, rec);
    arr.push(rec);
    return rec;
  }

  _unique(id, what) {
    if (typeof id !== 'string' || !id) {
      throw new NetworkError('E_BAD_KIND', '', 'a ' + what + ' needs a non-empty string id');
    }
    if (this._byId.has(id)) {
      throw new NetworkError('E_DUPLICATE_ID', '', 'duplicate id "' + id + '"',
        'ids are unique across nodes, edges, devices, heat links and runs');
    }
  }

  _ctx() {
    const nodeIds = new Set(), edgeIds = new Set(), devIds = new Set();
    for (const n of this._nodes) nodeIds.add(n.id);
    for (const e of this._edges) edgeIds.add(e.id);
    for (const d of this._devices) devIds.add(d.id);
    return { nodeIds, edgeIds, devIds };
  }

  _throwFirst(errors) {
    if (errors.length) {
      const e = errors[0];
      throw new NetworkError(e.code, e.path, e.message, e.hint);
    }
  }

  addNode(spec) {
    this._unique(spec && spec.id, 'node');
    const errors = [];
    checkNode(spec, '/nodes/+', errors);
    this._throwFirst(errors);
    const rec = this._insert(this._nodes, normNode(spec, this.defaults, (t) => t));
    this._touch(3, rec.id, 'add');
    return rec;
  }

  addEdge(spec) {
    this._unique(spec && spec.id, 'edge');
    const c = this._ctx();
    const errors = [];
    checkEdge(spec, '/edges/+', c.nodeIds, c.devIds, errors);
    this._throwFirst(errors);
    const rec = this._insert(this._edges, normEdge(spec, this.defaults, this._byId));
    this._touch(3, rec.id, 'add');
    return rec;
  }

  addDevice(spec) {
    this._unique(spec && spec.id, 'device');
    const c = this._ctx();
    const errors = [];
    checkDevice(spec, '/devices/+', c.nodeIds, c.edgeIds, errors);
    this._throwFirst(errors);
    const rec = this._insert(this._devices, normDevice(spec, this.defaults));
    const e = this.edge(rec.edge);
    if (e) e.device = rec.id;
    this._touch(3, rec.id, 'add');
    return rec;
  }

  addHeatLink(spec) {
    this._unique(spec && spec.id, 'heat link');
    const c = this._ctx();
    const errors = [];
    checkHeat(spec, '/heat/+', c.nodeIds, c.edgeIds, errors);
    this._throwFirst(errors);
    const rec = this._insert(this._heat, normHeat(spec));
    this._touch(3, rec.id, 'add');
    return rec;
  }

  addRun(spec) {
    this._unique(spec && spec.id, 'run');
    const c = this._ctx();
    const errors = [];
    checkRun(spec, '/runs/+', c.edgeIds, errors);
    this._throwFirst(errors);
    const rec = this._insert(this._runs, normRun(spec));
    this._touch(1, rec.id, 'add');
    return rec;
  }

  _drop(arr, rec) {
    const i = arr.indexOf(rec);
    if (i >= 0) arr.splice(i, 1);
    this._byId.delete(rec.id);
  }

  // Removing a node takes its edges with it, because an edge with one end
  // missing is not a network, it is a crash waiting for the next rebuild.
  removeNode(id) {
    const n = this.node(id);
    if (!n) return false;
    for (let i = this._edges.length - 1; i >= 0; i--) {
      if (this._edges[i].from === id || this._edges[i].to === id) this.removeEdge(this._edges[i].id);
    }
    for (let i = this._heat.length - 1; i >= 0; i--) {
      const h = this._heat[i];
      if (h.on === 'node:' + id || h.hot === 'node:' + id || h.cold === 'node:' + id) this.removeHeatLink(h.id);
    }
    this._drop(this._nodes, n);
    this._touch(3, id, 'remove');
    return true;
  }

  removeEdge(id) {
    const e = this.edge(id);
    if (!e) return false;
    for (let i = this._devices.length - 1; i >= 0; i--) {
      if (this._devices[i].edge === id) this.removeDevice(this._devices[i].id);
    }
    for (let i = this._heat.length - 1; i >= 0; i--) {
      const h = this._heat[i];
      if (h.on === 'edge:' + id || h.hot === 'edge:' + id || h.cold === 'edge:' + id) this.removeHeatLink(h.id);
    }
    for (const r of this._runs) {
      const k = r.edges.indexOf(id);
      if (k >= 0) r.edges.splice(k, 1);
    }
    this._drop(this._edges, e);
    this._touch(3, id, 'remove');
    return true;
  }

  removeDevice(id) {
    const d = this.device(id);
    if (!d) return false;
    const e = this.edge(d.edge);
    if (e && e.device === id) e.device = null;
    this._drop(this._devices, d);
    this._touch(3, id, 'remove');
    return true;
  }

  removeHeatLink(id) {
    const h = this.heatLink(id);
    if (!h) return false;
    this._drop(this._heat, h);
    this._touch(3, id, 'remove');
    return true;
  }

  // Tier 2. A moved pipe end is a changed length, a changed elevation and a
  // changed set of elbows, so it is a changed resistance: this is the call
  // that makes "move a pipe and see the effect" mean something.
  setPts(edgeId, pts) {
    const e = this.edge(edgeId);
    if (!e) {
      throw new NetworkError('E_UNKNOWN_EDGE', '', 'setPts: no edge "' + edgeId + '"' + suggest(edgeId, this._edges.map((x) => x.id)));
    }
    const errors = [];
    checkEdge({ id: e.id, from: e.from, to: e.to, dia: e.dia, pts }, '/edges/' + edgeId,
      new Set([e.from, e.to]), new Set(), errors);
    this._throwFirst(errors);
    e.pts = copyPts(pts);
    e._geomVer++;
    this._touch(2, edgeId, 'change');
    return e;
  }

  // Tier 2 for everything else geometric. Going through here rather than
  // poking the record keeps the version counters honest, which is what tells a
  // renderer that exactly this one tube needs rebuilding.
  setEdge(edgeId, patch) {
    const e = this.edge(edgeId);
    if (!e) throw new NetworkError('E_UNKNOWN_EDGE', '', 'setEdge: no edge "' + edgeId + '"');
    let level = 1;
    for (const key in patch) {
      const v = patch[key];
      if (key === 'pts') { this.setPts(edgeId, v); continue; }
      if (key === 'from' || key === 'to') {
        if (!this.node(v)) {
          throw new NetworkError('E_UNKNOWN_NODE', '', 'setEdge: edge "' + edgeId + '" cannot attach to "' + v + '", which is not a node' + suggest(v, this._nodes.map((n) => n.id)));
        }
        e[key] = v; level = 3; continue;
      }
      if (key === 'dia' || key === 'bend' || key === 'rough' || key === 'k' || key === 'n' || key === 'cells' || key === 'vmax') {
        if (key === 'dia' && !(num(v, 0) > 0)) {
          throw new NetworkError('E_ZERO_BORE', '', 'setEdge: edge "' + edgeId + '" needs a bore greater than zero');
        }
        e[key] = key === 'cells' ? clamp(Math.round(num(v, e.cells)), 2, 32)
          : key === 'n' ? Math.max(1, Math.round(num(v, e.n)))
            : num(v, e[key]);
        if (level < 2) level = 2;
        continue;
      }
      e[key] = v;
    }
    if (level >= 2) e._geomVer++;
    this._touch(level, edgeId, 'change');
    return e;
  }

  setNode(nodeId, patch) {
    const n = this.node(nodeId);
    if (!n) throw new NetworkError('E_UNKNOWN_NODE', '', 'setNode: no node "' + nodeId + '"');
    let level = 1;
    for (const key in patch) {
      if (key === 'at') {
        const a = patch.at;
        if (!Array.isArray(a) || !fin(a[0]) || !fin(a[1]) || !fin(a[2])) {
          throw new NetworkError('E_BAD_POINTS', '', 'setNode: "' + nodeId + '" needs at: [x, y, z], three finite numbers');
        }
        n.at = [+a[0], +a[1], +a[2]]; level = 2; continue;
      }
      if (key === 'shape') { n.shape = normShape(patch.shape); level = 2; continue; }
      if (key === 'kind' || key === 'free') { n[key] = patch[key]; level = 3; continue; }
      n[key] = patch[key];
    }
    this._touch(level, nodeId, 'change');
    return n;
  }

  // Insert a junction at rounded-arclength fraction u and, when a device spec
  // is given, one edge from it to the device's `to` node carrying that device.
  // This is how a break is made at run time; it is also how the declarative
  // break in a layout is applied, so there is one implementation.
  splitEdge(edgeId, u, deviceSpec) {
    const r = this._splitEdgeInner(edgeId, u, deviceSpec);
    this._touch(3, edgeId, 'remove');
    this._touch(3, r.aId, 'add');
    this._touch(3, r.bId, 'add');
    this._touch(3, r.nodeId, 'add');
    if (r.edgeId) this._touch(3, r.edgeId, 'add');
    return r;
  }

  _splitEdgeInner(edgeId, u, deviceSpec) {
    const e = this.edge(edgeId);
    if (!e) {
      throw new NetworkError('E_UNKNOWN_EDGE', '', 'splitEdge: no edge "' + edgeId + '"' + suggest(edgeId, this._edges.map((x) => x.id)));
    }
    const f = clamp(num(u, 0.5), 1e-3, 1 - 1e-3);
    const halves = splitPts(e.pts, e.bend, f);
    const ptsA = halves[0], ptsB = halves[1];
    const at = ptsA[ptsA.length - 1];
    const aId = edgeId + '#a', bId = edgeId + '#b', nId = edgeId + '#n';

    this._insert(this._nodes, {
      id: nId, kind: 'junction', at: [at[0], at[1], at[2]], fluid: e.fluid,
      shape: { kind: 'point' }, free: false, gas: { p: 101325 },
      p: 101325, T: 288.15, x: 0, fill: 1, mixSpan: 0.6, display: {},
      // Nothing authored this junction, so its temperature is meaningless.
      // The solver seeds it from what its neighbours hold, which is the
      // difference between breaking a hot line and dropping an ice cube in it.
      _seedH: true
    });

    const half = (id, from, to, pts, share, lo, hi) => {
      const rec = {
        id, from, to, fluid: e.fluid, dia: e.dia, n: e.n, pts: copyPts(pts),
        bend: e.bend, rough: e.rough,
        // The lumped loss is authored for the whole edge, so it is shared out
        // by length. Putting it all on one half would move the resistance of
        // the loop to one side of the break.
        k: e.k * share,
        cells: clamp(Math.round(e.cells * share), 2, 32),
        device: null, vmax: e.vmax, display: e.display, _geomVer: 1,
        // Where this edge's cells come from at the next rebuild, so that
        // breaking a hot line does not reset it to cold: the span [a,b] of
        // THIS edge is filled from the span [c,d] of the source edge.
        _seed: [{ id: edgeId, a: 0, b: 1, c: lo, d: hi }],
        // And the water in it is still moving. A half of a split edge inherits
        // the mass flow the whole edge was carrying, because breaking a pipe
        // does not stop the fluid inside it: with the inertia term on, a half
        // that started from rest has to be accelerated back up from zero, so
        // the frame after a break showed the flow collapsing to a fraction of
        // what it was and then climbing again over a second, which is the
        // opposite of what a break does. The discharge stub deliberately does
        // NOT carry this flag: nothing was coming out of the hole before there
        // was a hole.
        _seedM: 1
      };
      return this._insert(this._edges, rec);
    };
    const a = half(aId, e.from, nId, ptsA, f, 0, f);
    half(bId, nId, e.to, ptsB, 1 - f, f, 1);
    // The original in-line device stays upstream of the split: a pump feeding a
    // broken line still feeds the part of it that is left.
    //
    // A BREAK IS NOT AN IN-LINE DEVICE and must never be carried over. It is a
    // hole, and a hole becomes its own third edge to wherever it discharges;
    // the pipe it was cut into is not itself a break. Carried over, the
    // upstream half held a break device whose area was zero, read that as
    // "shut", and SEVERED THE LINE THE MOMENT A BREAK WAS DECLARED, intact or
    // not. A network that merely says where a pipe could one day fail would
    // have had no flow in it at all, which is a hard fault to see because the
    // picture is simply still.
    if (e.device) {
      const d = this.device(e.device);
      if (d && d.kind !== 'break') { a.device = e.device; d.edge = aId; }
    }
    // A heater on the line stays on the upstream half rather than pointing at
    // an edge that no longer exists. A link that silently resolves to nothing
    // is how a broken pipe ends up cold and nobody notices for a week.
    const wasOn = 'edge:' + edgeId, nowOn = 'edge:' + aId;
    for (const h of this._heat) {
      if (h.on === wasOn) h.on = nowOn;
      if (h.hot === wasOn) h.hot = nowOn;
      if (h.cold === wasOn) h.cold = nowOn;
    }
    // A declared run walks the same path it always did, now in two hops. Left
    // naming the old edge it would refer to nothing, and a layout written
    // out after a break would no longer load.
    for (const r of this._runs) {
      const k = r.edges.indexOf(edgeId);
      if (k >= 0) r.edges.splice(k, 1, aId, bId);
    }
    // Everything needed to put the edge back exactly as it was.
    a._orig = { id: e.id, from: e.from, to: e.to, fluid: e.fluid, dia: e.dia, n: e.n, pts: copyPts(e.pts), bend: e.bend, rough: e.rough, k: e.k, cells: e.cells, device: e.device, vmax: e.vmax, display: e.display };

    let dEdgeId = null;
    if (deviceSpec) {
      const toNode = this.node(deviceSpec.to);
      if (!toNode) {
        throw new NetworkError('E_UNKNOWN_NODE', '',
          'splitEdge: the device on "' + edgeId + '" discharges to "' + deviceSpec.to + '", which is not a node' + suggest(deviceSpec.to, this._nodes.map((n) => n.id)),
          'a break needs somewhere to go: usually a boundary standing for the atmosphere');
      }
      dEdgeId = edgeId + '#d';
      const dev = this._byId.get(deviceSpec.id) || this._insert(this._devices, normDevice(deviceSpec, this.defaults));
      dev.edge = dEdgeId;
      this._insert(this._edges, {
        id: dEdgeId, from: nId, to: toNode.id, fluid: e.fluid,
        // The discharge path is the hole itself: a short stub whose resistance
        // is the orifice term, not its length.
        dia: e.dia, n: 1,
        pts: [[at[0], at[1], at[2]], [toNode.at[0], toNode.at[1], toNode.at[2]]],
        bend: e.bend, rough: e.rough, k: 0, cells: 2, device: dev.id,
        vmax: e.vmax, display: {}, _geomVer: 1,
        _seed: [{ id: edgeId, a: 0, b: 1, c: f, d: Math.min(1, f + 0.05) }]
      });
    }
    this._drop(this._edges, e);
    return { aId, bId, nodeId: nId, edgeId: dEdgeId };
  }

  // Put a split edge back. Refuses when it was never split, because silently
  // doing nothing is how a host ends up believing a break is repaired.
  heal(edgeId) {
    const a = this.edge(edgeId + '#a');
    if (!a || !a._orig) {
      throw new NetworkError('E_NOT_SPLIT', '', 'heal: edge "' + edgeId + '" was never split',
        'heal takes the id of the ORIGINAL edge, not of one of its halves');
    }
    const orig = a._orig;
    const bId = edgeId + '#b', nId = edgeId + '#n', dId = edgeId + '#d';
    const b = this.edge(bId);
    // The rounded-arclength fraction the split happened at, recovered from the
    // two halves, so the healed edge's cells come back in the right places.
    const la = a.pts.length ? polylineLength(a.pts) : 0;
    const lb = b ? polylineLength(b.pts) : 0;
    const f = clamp(la / Math.max(1e-12, la + lb), 1e-3, 1 - 1e-3);
    const d = this.edge(dId);
    if (d) {
      const dev = this.device(d.device);
      if (dev) this.removeDevice(dev.id);
      this.removeEdge(dId);
    }
    if (a.device) { const dev = this.device(a.device); if (dev) dev.edge = orig.id; }
    // Put the heat links back on the whole edge before its halves go, or
    // removeEdge would take them with it.
    const aIdStr = edgeId + '#a';
    const wasOn = 'edge:' + aIdStr, nowOn = 'edge:' + orig.id;
    for (const h of this._heat) {
      if (h.on === wasOn) h.on = nowOn;
      if (h.hot === wasOn) h.hot = nowOn;
      if (h.cold === wasOn) h.cold = nowOn;
    }
    // The two hops become one again, in the same place in the run.
    for (const r of this._runs) {
      const k = r.edges.indexOf(aIdStr);
      if (k < 0) continue;
      r.edges.splice(k, 1, orig.id);
      const kb = r.edges.indexOf(bId);
      if (kb >= 0) r.edges.splice(kb, 1);
    }
    this.removeEdge(bId);
    this.removeEdge(edgeId + '#a');
    this.removeNode(nId);
    const rec = this._insert(this._edges, Object.assign({}, orig, {
      pts: copyPts(orig.pts), _geomVer: 1,
      _seed: [{ id: edgeId + '#a', a: 0, b: f, c: 0, d: 1 }, { id: bId, a: f, b: 1, c: 0, d: 1 }]
    }));
    this._touch(3, rec.id, 'add');
    return rec;
  }
}

// ---------------------------------------------------------------------------
// derived views of the graph
// ---------------------------------------------------------------------------

// Maximal chains of edges through degree-2 JUNCTION nodes. A run is not
// authored and does not have to be: it exists so a colour range can be scaled
// over one physical path and a renderer can walk it in flow order. A declared
// run in the layout overrides the derived one.
export function autoRuns(net) {
  const edges = net.edges, nodes = net.nodes;
  const nIdx = new Map();
  for (let i = 0; i < nodes.length; i++) nIdx.set(nodes[i].id, i);
  const inc = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) inc[i] = [];
  for (let e = 0; e < edges.length; e++) {
    const a = nIdx.get(edges[e].from), b = nIdx.get(edges[e].to);
    if (a != null) inc[a].push(e);
    if (b != null) inc[b].push(e);
  }
  const isSeam = (n) => n != null && nodes[n].kind === 'junction' && inc[n].length === 2;
  const other = (n, e) => (inc[n][0] === e ? inc[n][1] : inc[n][0]);
  const far = (e, n) => {
    const a = nIdx.get(edges[e].from), b = nIdx.get(edges[e].to);
    return a === n ? b : a;
  };
  const used = new Uint8Array(edges.length);
  const out = [];
  for (let e0 = 0; e0 < edges.length; e0++) {
    if (used[e0]) continue;
    const chain = [e0];
    used[e0] = 1;
    // Forward, out of the `to` end, so the chain comes out in flow order.
    let cur = e0, node = nIdx.get(edges[e0].to);
    while (isSeam(node)) {
      const nxt = other(node, cur);
      if (nxt === e0 || used[nxt]) break;
      used[nxt] = 1; chain.push(nxt);
      node = far(nxt, node); cur = nxt;
    }
    // Backward, out of the `from` end.
    cur = e0; node = nIdx.get(edges[e0].from);
    while (isSeam(node)) {
      const prv = other(node, cur);
      if (prv === e0 || used[prv]) break;
      used[prv] = 1; chain.unshift(prv);
      node = far(prv, node); cur = prv;
    }
    const ids = new Array(chain.length);
    for (let i = 0; i < chain.length; i++) ids[i] = edges[chain[i]].id;
    out.push({ id: 'run:' + ids[0], edges: ids, normalise: 'run', extra: [] });
  }
  return out;
}

// Union-find over the edges that can still carry flow. A hard-closed valve
// really does divide the network, and a part with nothing to fix its pressure
// has to be pinned rather than solved.
export function components(net) {
  const nodes = net.nodes, edges = net.edges;
  const nIdx = new Map();
  for (let i = 0; i < nodes.length; i++) nIdx.set(nodes[i].id, i);
  const parent = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const devById = new Map();
  for (const d of net.devices) devById.set(d.id, d);
  for (let e = 0; e < edges.length; e++) {
    const dev = edges[e].device ? devById.get(edges[e].device) : null;
    if (dev && dev.kind === 'valve' && !(dev.open > VALVE_SHUT)) continue;
    const a = nIdx.get(edges[e].from), b = nIdx.get(edges[e].to);
    if (a == null || b == null) continue;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const label = new Map(), out = new Map();
  let next = 0;
  for (let i = 0; i < nodes.length; i++) {
    const r = find(i);
    if (!label.has(r)) label.set(r, next++);
    out.set(nodes[i].id, label.get(r));
  }
  return out;
}
