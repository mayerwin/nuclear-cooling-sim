// ---------------------------------------------------------------------------
// geometry.js - centreline mathematics, and the volume a shape holds.
//
// This is where a pipe that somebody moved becomes a different resistance. The
// length that goes into the friction term, the elbows that go into the form
// loss and the elevations that go into the buoyancy head all come from the
// SAME rounded centreline the renderer draws, so a run cannot be solved at one
// length and drawn at another.
//
// No three.js, no DOM, no allocation in anything the frame path calls: every
// function here runs at build or rebuild time, and the ones that walk a
// centreline write their intermediate results into module-level scratch
// instead of returning objects.
//
// ===========================================================================
// THE ONE BEND RULE
// ===========================================================================
//
// src/three/pipe.js already draws pipes, and it is correct and shipped. So the
// drawn construction IS the rule and this file follows it exactly rather than
// the other way round:
//
//   from = pts[0]
//   at each interior vertex c, with next = the vertex after it:
//     rr = min(bend, |from - c| * 0.45, |c - next| * 0.45)
//     a  = c - normalize(c - from) * rr
//     b  = c + normalize(next - c) * rr
//     a straight line from `from` to a, but ONLY if it is longer than 1e-4 m
//     a quadratic Bezier a -> c -> b
//     from = b
//   a straight line from `from` to the last vertex
//
// Two details of that are easy to get wrong and both change the answer:
//
//  * The clamp measures from `from`, which is the PREVIOUS corner's exit
//    point, not from the previous vertex. Two tight corners in a row therefore
//    bend less than either would alone, because the first one has already
//    eaten into the leg they share. Measuring from the vertex gives a longer
//    path than the one on the screen.
//  * The 1e-4 m straight is dropped, not shortened. The drawn path really does
//    skip it, so its length is not in the total either.
//
// If the drawn run and the solved run are different lengths, every velocity in
// the picture is wrong and nothing downstream can correct it. That is why
// there is one implementation of this and both consumers read it.
//
// (Three's own CurvePath.getLength() sums 200 chords per curve, so its number
// for a corner is a few parts in a million short of the true arc. What is
// computed here is the length of the path itself, measured properly. Where the
// two disagree, three's is the approximation.)
// ---------------------------------------------------------------------------

import { clamp, num, lerp, Table } from './util.js';

// The fraction of a leg a corner may consume, from pipe.js. Not a physical
// number: it is there so a corner bends as far as it can instead of
// overshooting into the leg before it.
const BEND_FRAC = 0.45;
// The straight that pipe.js drops rather than draws, metres.
const SEG_EPS = 1e-4;
// Below this deflection a corner is straight: no elbow loss, and no fillet.
const STRAIGHT = 1e-6;
// How far from either end a split may land, metres. A break authored at u = 0
// still has to leave two edges that can be drawn and solved.
const SPLIT_EPS = 1e-6;

// Points arrive as [x, y, z] from JSON, but a host may hand over {x, y, z}.
// num() at the same time, so one bad coordinate lands on the origin instead of
// making the whole run NaN.
const px = (p) => num(p[0] !== undefined ? p[0] : p.x, 0);
const py = (p) => num(p[1] !== undefined ? p[1] : p.y, 0);
const pz = (p) => num(p[2] !== undefined ? p[2] : p.z, 0);

// --- the length of one Bezier corner ---------------------------------------
//
// A quadratic Bezier with control points a, c, b where |a - c| = |c - b| = rr
// has speed |P'(t)| = 2*rr*|(1-t)*u + t*w| for the two unit leg directions u
// and w. Since u.w = cos(theta), that reduces exactly to
//
//   arc = 2*rr * integral over v in [0,1] of sqrt( cos^2(th/2) + sin^2(th/2)*v^2 )
//
// with th the deflection angle. One scalar integrand, bounded between 0 and 1,
// with no vectors left in it.
//
// WHY NOT THE CLOSED FORM. That integral does have one, and it is the usual
// answer, but it carries a 1/sin(theta/2) in front of an asinh that has to
// cancel it. At the nearly straight corner that most of a real run is made of
// the two halves are a 0/0 in the limit and lose most of their significant
// digits just before it, exactly where this function has to agree with the
// drawn path to a nanometre. A fixed Gauss-Legendre rule is a weighted sum of
// square roots with no branch in it at all: exact for the straight corner,
// exact for a right angle to the last bit, and it cannot be rearranged into
// something that cancels.
const GL_X = new Float64Array([
  -0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
  0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363
]);
const GL_W = new Float64Array([
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
  0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763
]);

function gl8(cc, kk, lo, hi) {
  const m = 0.5 * (lo + hi), h = 0.5 * (hi - lo);
  let s = 0;
  for (let i = 0; i < 8; i++) {
    const t = m + h * GL_X[i];
    s += GL_W[i] * Math.sqrt(cc + kk * t * t);
  }
  return s * h;
}

// Integral from 0 to v of sqrt(cc + kk*t*t) dt.
//
// The integrand turns a corner of its own at t = sqrt(cc/kk), which is where a
// polynomial rule struggles: for a deflection near 180 degrees that corner sits
// almost on the origin and a single rule over [0, v] would be out in the sixth
// digit. So the interval is halved towards zero until the panels are smaller
// than the feature, which costs one panel for an ordinary elbow, two for a
// hairpin, and keeps the whole thing at machine precision for both.
function quad(cc, kk, v) {
  if (!(v > 0)) return 0;
  // cc = 0 is the exact 180 degree reversal: the integrand is sqrt(kk)*t, a
  // straight line, and one Gauss-Legendre panel integrates it exactly.
  if (!(cc > 0)) return gl8(cc, kk, 0, v);
  // kk = 0 is the straight corner, where the drawn Bezier is a line and its
  // length is the two tangents. Most of a real run is made of those, so it is
  // worth not integrating them.
  if (!(kk > 0)) return Math.sqrt(cc) * v;
  const q = Math.sqrt(cc / kk);
  const tiny = v * 1e-13;
  let hi = v, acc = 0;
  for (let n = 0; n < 60 && hi > q && hi > tiny; n++) {
    const lo = hi * 0.5;
    acc += gl8(cc, kk, lo, hi);
    hi = lo;
  }
  return acc + gl8(cc, kk, 0, hi);
}

// The arc length of the whole corner, from the tangent length and the COSINE
// of the deflection. The cosine rather than the angle because the half-angle
// terms the integral wants are cos^2(th/2) = (1+cos th)/2 and sin^2(th/2) =
// (1-cos th)/2, which the dot product of the two leg directions already is:
// there is no trigonometry anywhere in the length of a run.
function bezierArc(rr, cosT) {
  if (!(rr > 0)) return 0;
  return 2 * rr * quad(0.5 * (1 + cosT), 0.5 * (1 - cosT), 1);
}

// Arc length from the start of the corner to parameter t, using the same
// substitution: v = 1 - 2t runs from 1 down to -1, and the integrand is even
// in v, so the piece behind the midpoint is the odd extension of the same
// integral.
function arcTo(rr, cc, kk, q1, t) {
  const v = 1 - 2 * t;
  const f = v >= 0 ? quad(cc, kk, v) : -quad(cc, kk, -v);
  return rr * (q1 - f);
}

// The parameter t at which the corner has run out `s` metres of arc. Plain
// bisection with a fixed iteration count: it halves a bounded interval, so it
// always returns a number in [0, 1] and there is no convergence to fail. The
// callers are edit-time (a break placed on a run, an edge split), never the
// frame path.
function arcParam(rr, cc, kk, s) {
  const q1 = quad(cc, kk, 1);
  let lo = 0, hi = 1;
  for (let i = 0; i < 44; i++) {
    const mid = 0.5 * (lo + hi);
    if (arcTo(rr, cc, kk, q1, mid) < s) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// --- walking the corners ----------------------------------------------------
// CORNER is module scratch so the walk allocates nothing:
//   0 rr, 1 cos(theta), 2..4 a, 5..7 b, 8 the lead-in straight that is
//   actually drawn (0 when pipe.js would have dropped it).
// The cosine rather than the angle, because only elbows() wants the angle
// itself and it can take the arccosine there. The arc length is not computed
// here either, for the same reason: elbows() would pay for an integral it
// never reads.
const CORNER = new Float64Array(9);

function corner(pts, bend, i, fx, fy, fz) {
  const p = pts[i], q = pts[i + 1];
  const cx = px(p), cy = py(p), cz = pz(p);
  const nx = px(q), ny = py(q), nz = pz(q);
  let ix = cx - fx, iy = cy - fy, iz = cz - fz;
  let ox = nx - cx, oy = ny - cy, oz = nz - cz;
  const li = Math.sqrt(ix * ix + iy * iy + iz * iz);
  const lo = Math.sqrt(ox * ox + oy * oy + oz * oz);
  // three's Vector3.normalize divides by (length || 1), so a repeated point
  // leaves a zero direction rather than a NaN one. Match that: the radius
  // clamp is zero on such a leg anyway, so the corner simply collapses.
  const si = li > 0 ? 1 / li : 0;
  const so = lo > 0 ? 1 / lo : 0;
  ix *= si; iy *= si; iz *= si;
  ox *= so; oy *= so; oz *= so;
  // min(bend, li*0.45, lo*0.45), written as comparisons so a host's NaN bend
  // has already landed on 0 and cannot reappear here.
  let rr = Math.max(0, num(bend, 0));
  if (li * BEND_FRAC < rr) rr = li * BEND_FRAC;
  if (lo * BEND_FRAC < rr) rr = lo * BEND_FRAC;
  const ax = cx - ix * rr, ay = cy - iy * rr, az = cz - iz * rr;
  const bx = cx + ox * rr, by = cy + oy * rr, bz = cz + oz * rr;
  // Clamped because the dot product of two unit vectors can leave [-1, 1] by
  // an ulp, and because it is the last gate before the arc length: a value
  // that is not a number lands on -1 and the corner reads as a full reversal
  // rather than sending a NaN down the length of the run.
  const cosT = clamp(ix * ox + iy * oy + iz * oz, -1, 1);
  const dx = ax - fx, dy = ay - fy, dz = az - fz;
  const lead = Math.sqrt(dx * dx + dy * dy + dz * dz);
  CORNER[0] = rr; CORNER[1] = cosT;
  CORNER[2] = ax; CORNER[3] = ay; CORNER[4] = az;
  CORNER[5] = bx; CORNER[6] = by; CORNER[7] = bz;
  CORNER[8] = lead > SEG_EPS ? lead : 0;
  return CORNER;
}

// --- lengths ----------------------------------------------------------------

// The straight-line length of the polyline itself, metres. This is the upper
// bound on the rounded length and is what a network with bend = 0 gets.
export function polylineLength(pts) {
  const n = pts ? pts.length : 0;
  if (n < 2) return 0;
  let total = 0;
  let x = px(pts[0]), y = py(pts[0]), z = pz(pts[0]);
  for (let i = 1; i < n; i++) {
    const nx = px(pts[i]), ny = py(pts[i]), nz = pz(pts[i]);
    const dx = nx - x, dy = ny - y, dz = nz - z;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    x = nx; y = ny; z = nz;
  }
  return total;
}

// The length of the path pipe.js draws for the same points and bend radius.
// This is the L that goes into f*L/D, and it is shorter than the polyline
// because a corner cuts it.
export function roundedLength(pts, bend) {
  const n = pts ? pts.length : 0;
  if (n < 2) return 0;
  let fx = px(pts[0]), fy = py(pts[0]), fz = pz(pts[0]);
  let total = 0;
  for (let i = 1; i < n - 1; i++) {
    corner(pts, bend, i, fx, fy, fz);
    total += CORNER[8] + bezierArc(CORNER[0], CORNER[1]);
    fx = CORNER[5]; fy = CORNER[6]; fz = CORNER[7];
  }
  const dx = px(pts[n - 1]) - fx, dy = py(pts[n - 1]) - fy, dz = pz(pts[n - 1]) - fz;
  return total + Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Everything the buoyancy and hydrostatic terms need from a centreline's
// heights, in one pass. `rise` and `fall` are both positive: how much this run
// climbs in total and how much it drops, which are not the same as dz on a run
// that goes over a hump.
//
// The heights are taken from the polyline's own vertices. A Bezier corner
// stays inside the convex hull of its three control points, so yMin and yMax
// bound the rounded path as well.
//
// `out` may be passed in to fill an object the caller already owns.
export function elevations(pts, out) {
  const o = out || { yFrom: 0, yTo: 0, dz: 0, yMin: 0, yMax: 0, rise: 0, fall: 0 };
  const n = pts ? pts.length : 0;
  if (n === 0) {
    o.yFrom = o.yTo = o.dz = o.yMin = o.yMax = o.rise = o.fall = 0;
    return o;
  }
  let y = py(pts[0]);
  let lo = y, hi = y, rise = 0, fall = 0;
  for (let i = 1; i < n; i++) {
    const ny = py(pts[i]);
    const d = ny - y;
    if (d > 0) rise += d; else fall -= d;
    if (ny < lo) lo = ny;
    if (ny > hi) hi = ny;
    y = ny;
  }
  o.yFrom = py(pts[0]);
  o.yTo = y;
  o.dz = y - o.yFrom;
  o.yMin = lo;
  o.yMax = hi;
  o.rise = rise;
  o.fall = fall;
  return o;
}

// One entry per interior vertex that actually bends, for the form loss.
//
// The drawn corner is a quadratic Bezier, not a circular arc, so there is a
// choice about what "the bend radius" means in r/D. The tangent length rr is
// what the two constructions share exactly, so the radius reported is that of
// the circular elbow with the same tangent length, r = rr / tan(theta/2). That
// is the radius a fitter would measure off the drawing, and it is the quantity
// the published K tables are written against.
export function elbows(pts, bend, dia) {
  const out = [];
  const n = pts ? pts.length : 0;
  if (n < 3) return out;
  const d = Math.max(1e-6, num(dia, 1e-6));
  let fx = px(pts[0]), fy = py(pts[0]), fz = pz(pts[0]);
  for (let i = 1; i < n - 1; i++) {
    corner(pts, bend, i, fx, fy, fz);
    const rr = CORNER[0], cosT = CORNER[1];
    fx = CORNER[5]; fy = CORNER[6]; fz = CORNER[7];
    const theta = Math.acos(cosT);
    if (!(theta > STRAIGHT)) continue;
    // tan(theta/2) from the same cosine: sqrt((1-c)/(1+c)). A corner with no
    // room to bend (two vertices on top of each other, or bend = 0) is a
    // mitre: radius zero, and the table's worst entry.
    const t2 = Math.sqrt((1 - cosT) / Math.max(1e-300, 1 + cosT));
    const r = rr > 0 ? rr / t2 : 0;
    out.push({ theta, rOverD: r / d });
  }
  return out;
}

// The dimensionless form loss of one bend, from the 90 degree table scaled
// linearly by the angle. Monotone decreasing in r/D, so halving a bend radius
// always raises the loss and never lowers it; flat outside the knots, because
// beyond 8 diameters a bend is a slightly longer pipe and below 1 it is a
// mitre and no table is honest there anyway.
export function bendK(theta, rOverD) {
  const th = clamp(theta, 0, Math.PI);
  const rd = clamp(rOverD, 1, 8);
  let k90;
  if (rd <= 2) k90 = lerp(0.75, 0.35, rd - 1);
  else if (rd <= 4) k90 = lerp(0.35, 0.20, (rd - 2) * 0.5);
  else k90 = lerp(0.20, 0.17, (rd - 4) * 0.25);
  return k90 * th / (Math.PI * 0.5);
}

// Flow area, m2. `n` is how many identical parallel paths the one drawn edge
// stands for, so a tube bank of 200 tubes is one edge with the area of 200.
export function areaOf(dia, n) {
  const d = Math.max(0, num(dia, 0));
  const k = Math.max(1, Math.round(num(n, 1)));
  return k * Math.PI * d * d * 0.25;
}

// --- points along the rounded path ------------------------------------------
// LOC is module scratch:
//   0..2 the point on the DRAWN path
//   3    the index of the underlying polyline segment it belongs to
//   4..6 the corresponding point ON the polyline, for splitting
const LOC = new Float64Array(7);

function setLoc(x, y, z, seg, sx, sy, sz) {
  LOC[0] = x; LOC[1] = y; LOC[2] = z;
  LOC[3] = seg;
  LOC[4] = sx; LOC[5] = sy; LOC[6] = sz;
}

// Walk the same construction roundedLength walks, stopping at fraction u of
// the total.
//
// Splitting needs a point that is ON the polyline, because both halves have to
// be valid polylines and inserting a point off to one side would move the run.
// Inside a corner the drawn path has left the polyline, so the split point is
// taken at the same fraction of the way along a -> c -> b, which is on the
// polyline, is continuous, and lands on the same leg the drawn point is
// nearest to.
function locate(pts, bend, u) {
  const n = pts ? pts.length : 0;
  if (n === 0) { setLoc(0, 0, 0, 0, 0, 0, 0); return LOC; }
  const x0 = px(pts[0]), y0 = py(pts[0]), z0 = pz(pts[0]);
  if (n === 1) { setLoc(x0, y0, z0, 0, x0, y0, z0); return LOC; }
  const total = roundedLength(pts, bend);
  const target = clamp(u, 0, 1) * total;
  let fx = x0, fy = y0, fz = z0;
  let acc = 0;
  for (let i = 1; i < n - 1; i++) {
    corner(pts, bend, i, fx, fy, fz);
    const rr = CORNER[0], cosT = CORNER[1];
    const ax = CORNER[2], ay = CORNER[3], az = CORNER[4];
    const bx = CORNER[5], by = CORNER[6], bz = CORNER[7];
    const lead = CORNER[8], arc = bezierArc(rr, cosT);
    if (target <= acc + lead) {
      const f = lead > 0 ? clamp((target - acc) / lead, 0, 1) : 0;
      const x = lerp(fx, ax, f), y = lerp(fy, ay, f), z = lerp(fz, az, f);
      setLoc(x, y, z, i - 1, x, y, z);
      return LOC;
    }
    acc += lead;
    if (target <= acc + arc) {
      const t = arc > 0
        ? arcParam(rr, 0.5 * (1 + cosT), 0.5 * (1 - cosT), target - acc)
        : 0;
      const cx = px(pts[i]), cy = py(pts[i]), cz = pz(pts[i]);
      const w0 = (1 - t) * (1 - t), w1 = 2 * t * (1 - t), w2 = t * t;
      const x = w0 * ax + w1 * cx + w2 * bx;
      const y = w0 * ay + w1 * cy + w2 * by;
      const z = w0 * az + w1 * cz + w2 * bz;
      if (t <= 0.5) {
        const g = t * 2;
        setLoc(x, y, z, i - 1, lerp(ax, cx, g), lerp(ay, cy, g), lerp(az, cz, g));
      } else {
        const g = t * 2 - 1;
        setLoc(x, y, z, i, lerp(cx, bx, g), lerp(cy, by, g), lerp(cz, bz, g));
      }
      return LOC;
    }
    acc += arc;
    fx = bx; fy = by; fz = bz;
  }
  const lx = px(pts[n - 1]), ly = py(pts[n - 1]), lz = pz(pts[n - 1]);
  const dx = lx - fx, dy = ly - fy, dz = lz - fz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const f = len > 0 ? clamp((target - acc) / len, 0, 1) : 1;
  const x = lerp(fx, lx, f), y = lerp(fy, ly, f), z = lerp(fz, lz, f);
  setLoc(x, y, z, n - 2, x, y, z);
  return LOC;
}

// The point on the drawn path at rounded-arclength fraction u. `out` may be an
// array to fill, so a caller in a loop allocates nothing.
export function sampleAt(pts, bend, u, out) {
  locate(pts, bend, u);
  const o = out || [0, 0, 0];
  o[0] = LOC[0]; o[1] = LOC[1]; o[2] = LOC[2];
  return o;
}

// The y of the above, metres. This is what a break at u, or a heat link
// pinned to a point on a run, needs for its hydrostatic head.
export function elevationAt(pts, bend, u) {
  locate(pts, bend, u);
  return LOC[1];
}

// Split a centreline at rounded-arclength fraction u into two centrelines that
// share the split point. The point is inserted on the underlying polyline
// segment that contains u, so each half is a polyline in its own right and is
// drawn by the renderer and solved here from the same points.
//
// THE TWO HALVES DO NOT ADD UP TO THE WHOLE, and they cannot. The split point
// is a new end vertex, so a corner near it now has a shorter leg to bend
// through, and the one bend rule then gives that corner a smaller radius and a
// slightly longer path. Splitting a metre away from a corner costs nothing;
// splitting a bend radius away from one costs a few tenths of a per cent of
// the length. The alternative is to have the drawn pipe and the solved pipe
// disagree at every break, which is the one thing this file exists to prevent.
export function splitPts(pts, bend, u) {
  const n = pts ? pts.length : 0;
  const a = [], b = [];
  if (n < 2) {
    for (let i = 0; i < n; i++) {
      a.push([px(pts[i]), py(pts[i]), pz(pts[i])]);
      b.push([px(pts[i]), py(pts[i]), pz(pts[i])]);
    }
    return [a, b];
  }
  // A break authored at 0 or 1 still has to leave two edges with a length, a
  // bore and two ends. Held off the ends by a micron, which is far below
  // anything a picture or a resistance can show and far above the point where
  // a zero-length edge starts dividing by its own area.
  const total = roundedLength(pts, bend);
  let uu = clamp(u, 0, 1);
  if (total > 4 * SPLIT_EPS) {
    const m = SPLIT_EPS / total;
    uu = clamp(uu, m, 1 - m);
  }
  locate(pts, bend, uu);
  const seg = clamp(LOC[3] | 0, 0, n - 2);
  const sx = LOC[4], sy = LOC[5], sz = LOC[6];
  for (let i = 0; i <= seg; i++) a.push([px(pts[i]), py(pts[i]), pz(pts[i])]);
  a.push([sx, sy, sz]);
  b.push([sx, sy, sz]);
  for (let i = seg + 1; i < n; i++) b.push([px(pts[i]), py(pts[i]), pz(pts[i])]);
  return [a, b];
}

// ===========================================================================
// Shapes: volume against level
// ===========================================================================
//
// A volume node holds mass; the picture needs a level. Both directions are
// wanted every frame (level from inventory, and area at that level for the
// free surface), so the profile is integrated once at build time into a pair
// of tables and looked up afterwards. 64 samples is enough for anything a
// vessel profile can do and keeps a lathe's curvature to under a millimetre of
// level; the tables cost 1 kB per volume and never allocate again.
//
// The cumulative volume at each sample is worked out EXACTLY, from the
// profile's own knots: a lathe segment is a conical frustum, not a trapezoid
// in area, because A = PI*r^2 is quadratic in y and integrating it as a
// trapezoid puts a cone out by several per cent. Only the interpolation
// between the 64 samples is linear.
//
// Y MUST NOT DECREASE, BUT IT MAY REPEAT. A vessel profile is drawn as an
// outline: out along the floor, up the wall, back in along the roof, which
// puts two knots at the same elevation at each end. That is how the sim's
// vessels are written, how the worked example in the specification is written,
// and a vertical face contributes no volume, so it costs the integral nothing.
// What is rejected is a profile that turns back DOWN, because that is the real
// mistake this check is for: rows entered out of order or upside down.

export const SHAPE_SAMPLES = 64;

// The errors carry a code and the offending id in the message. They are plain
// Errors on purpose: network.js owns NetworkError and imports this file, not
// the other way round, so it catches these and re-throws its own with the
// JSON path attached.
function shapeError(code, id, msg, hint) {
  const e = new Error("shape '" + id + "': " + msg);
  e.code = code;
  e.hint = hint;
  return e;
}

// spec is one of
//   {kind:'lathe', profile:[[r,y],...]}   y non-decreasing, absolute y
//   {kind:'box',   w, d, y0, h}
//   {kind:'area',  table:[[y,A],...]}     y non-decreasing, absolute y
//   {kind:'point'}                        no inventory
// yNode is the node's own reference elevation, used by a point shape and as
// the floor of a box that did not say where it starts.
export function buildShape(spec, yNode) {
  const s = spec || { kind: 'point' };
  const kind = s.kind || 'point';
  const id = s.id == null ? kind : s.id;

  if (kind === 'point') {
    // A single-knot table answers with its one value at any x and its one x at
    // any y, which is exactly what a node with no inventory should say.
    const y = num(s.y, num(s.y0, num(yNode, 0)));
    return Object.freeze({
      kind: 'point', y0: y, y1: y, Vtotal: 0,
      cum: new Table([y], [0]), areaT: new Table([y], [0])
    });
  }

  // All three of the real kinds reduce to a list of knots up the shape's own
  // height, so there is one integration and one lookup rather than three.
  // A lathe carries radii, a box and an area table carry areas.
  let yk = null, vk = null, m = 0;
  const lathe = kind === 'lathe';

  if (kind === 'box') {
    const w = num(s.w, 0), d = num(s.d, 0), h = num(s.h, 0);
    if (!(h > 0)) throw shapeError('E_SHAPE_SIZE', id, 'a box needs h > 0, got ' + s.h,
      'height in metres, measured up from y0');
    if (!(w * d > 0)) throw shapeError('E_SHAPE_SIZE', id,
      'a box needs w and d > 0, got ' + s.w + ' x ' + s.d, 'plan dimensions in metres');
    const y0 = num(s.y0, num(yNode, 0));
    m = 2;
    yk = new Float64Array([y0, y0 + h]);
    vk = new Float64Array([w * d, w * d]);
  } else if (lathe || kind === 'area') {
    const rows = lathe ? s.profile : s.table;
    m = rows ? rows.length : 0;
    if (m < 2) throw shapeError('E_SHAPE_Y', id, 'a ' + kind + ' needs at least two rows',
      lathe ? 'profile is [[r, y], ...] read bottom upwards'
        : 'table is [[y, A], ...] read bottom upwards');
    yk = new Float64Array(m);
    vk = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const row = rows[i] || [];
      // A lathe row is [r, y]; an area row is [y, A]. The orders differ
      // because a lathe profile is read as a drawing (radius out, height up)
      // and an area table as a curve of A against y.
      yk[i] = lathe ? num(row[1], 0) : num(row[0], 0);
      // A negative radius or area is meaningless rather than fatal, so it is
      // floored at zero and the shape simply holds nothing there.
      vk[i] = Math.max(0, lathe ? num(row[0], 0) : num(row[1], 0));
      if (i > 0 && !(yk[i] >= yk[i - 1])) {
        throw shapeError('E_SHAPE_Y', id,
          'y must not decrease, row ' + i + ' is ' + yk[i] + ' after ' + yk[i - 1],
          'a profile is read bottom upwards, in absolute metres; a flat floor '
          + 'or roof repeats a y, which is allowed');
      }
    }
  } else {
    throw shapeError('E_BAD_KIND', id, "unknown shape kind '" + kind + "'",
      "one of 'lathe', 'box', 'area', 'point'");
  }

  const y0 = yk[0], y1 = yk[m - 1];

  // The exact cumulative volume at each knot. A lathe segment is a frustum,
  // integral of PI*r(y)^2; an area segment is the trapezoid it is defined to
  // be. A vertical face has zero height and so adds nothing, which is what
  // lets a profile repeat a y.
  const ck = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    const h = yk[i] - yk[i - 1];
    const a = vk[i - 1], b = vk[i];
    const dv = lathe ? (Math.PI / 3) * (a * a + a * b + b * b) * h : 0.5 * (a + b) * h;
    ck[i] = ck[i - 1] + (dv > 0 ? dv : 0);
  }
  const Vtotal = ck[m - 1];
  if (!(Vtotal > 0)) {
    throw shapeError('E_SHAPE_EMPTY', id, 'holds no volume', 'give it a height and a bore');
  }

  const N = SHAPE_SAMPLES;
  const ys = new Float64Array(N), as = new Float64Array(N), cv = new Float64Array(N);
  const dy = (y1 - y0) / (N - 1);
  let k = 0;
  for (let i = 0; i < N; i++) {
    // The last sample is set from y1 rather than accumulated, so the top of
    // the table is the top of the shape to the last bit and a full vessel
    // reads as exactly full.
    const y = i === N - 1 ? y1 : y0 + i * dy;
    ys[i] = y;
    // Walk the knots with the samples: both are increasing, so this is one
    // pass. Stepping over a knot at exactly this elevation is what picks the
    // face ABOVE a flat floor and the face BELOW a flat roof, which are the
    // two the liquid is actually against.
    while (k < m - 2 && yk[k + 1] <= y) k++;
    const h = yk[k + 1] - yk[k];
    const f = h > 0 ? (y - yk[k]) / h : 0;
    const a = vk[k], b = vk[k + 1];
    const v = a + (b - a) * f;
    if (lathe) {
      as[i] = Math.PI * v * v;
      cv[i] = ck[k] + (Math.PI / 3) * (a * a + a * v + v * v) * (y - yk[k]);
    } else {
      as[i] = v;
      cv[i] = ck[k] + 0.5 * (a + v) * (y - yk[k]);
    }
  }
  cv[N - 1] = Vtotal;
  for (let i = 1; i < N; i++) {
    // Non-decreasing whatever the arithmetic did: cum is inverted to get a
    // level, and one step backwards in it would put a level below the one a
    // smaller inventory gave.
    if (!(cv[i] > cv[i - 1])) cv[i] = cv[i - 1];
  }

  return Object.freeze({
    kind, y0, y1, Vtotal, cum: new Table(ys, cv), areaT: new Table(ys, as)
  });
}

// m3 of liquid below absolute elevation y, clamped to the shape.
export function volumeAt(shape, y) {
  if (!shape || shape.kind === 'point') return 0;
  return clamp(shape.cum.at(y), 0, shape.Vtotal);
}

// The absolute elevation of the surface of volume V. Clamped into the shape,
// so an over-full vessel reads at its top rather than above its own roof.
export function levelOf(shape, V) {
  if (!shape) return 0;
  if (shape.kind === 'point') return shape.y0;
  return clamp(shape.cum.inv(V), shape.y0, shape.y1);
}

// The free-surface area at absolute elevation y, m2. This is what a splash
// spreads over and what a pour is divided by.
export function areaAt(shape, y) {
  if (!shape || shape.kind === 'point') return 0;
  return Math.max(0, shape.areaT.at(y));
}
