// ---------------------------------------------------------------------------
// util.js - the numeric floor the rest of the core stands on.
//
// No physics, no imports, no allocation in anything the frame path calls. The
// three grow* helpers and IdMap allocate, and they are called from rebuild()
// only; everything else here is pure arithmetic on numbers a caller already
// has.
//
// EVERY GUARD IN THIS FILE IS WRITTEN SO THAT NaN LANDS ON A BOUND rather than
// passing through, the same convention props.js and surface.js already use.
// `v < a ? a : v > b ? b : v` returns NaN for NaN because every comparison
// with NaN is false; one NaN arriving from a host then travels through a
// density, a velocity and a vertex position until the body of water
// disappears from the picture. Nothing in this library may return NaN.
// ---------------------------------------------------------------------------

export const clamp = (v, a, b) => (v >= a ? (v <= b ? v : b) : a);
export const lerp = (a, b, t) => a + (b - a) * t;

// A number, or the fallback if the host handed over something that is not one.
// Math.max(0, NaN) is NaN, which is exactly the trap this closes.
export const num = (v, d) => (Number.isFinite(v) ? v : d);

// The sign of x, with +1 for both zeros and for NaN. Used to give a mass flow
// its direction from the sign of a driving head: a head of exactly zero must
// pick a direction rather than produce a signless zero, and NaN must pick one
// too rather than poison the flow.
export const sign0 = (x) => (x < 0 ? -1 : 1);

// Hermite ramp on 0..1. The uncovering ramp at a nozzle and the moving/still
// fades use it, so a thing that switches on does it with a zero derivative at
// both ends and nothing in the picture steps.
export const smoothstep = (t) => { const s = clamp(t, 0, 1); return s * s * (3 - 2 * s); };

// The sim's own integer hash, carried over from js/flow.js unchanged so that a
// tracer or a seed computed here lands where it landed there. Deterministic
// and cheap: no Math.random anywhere in this library, because a screenshot has
// to be reproducible to be a proof.
export function hash1(i) {
  let h = Math.imul(i | 0, 374761393) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- growable typed arrays --------------------------------------------------
// Doubling, so a network that is edited repeatedly stops allocating once it
// has reached its high-water mark. The old contents are carried over because
// rebuild() copies state across by id afterwards and needs the old values to
// still be there while it does it.

function nextPow2(n) {
  let c = 1;
  while (c < n) c += c;
  return c;
}

export function growF64(arr, n) {
  const want = Math.max(1, Math.ceil(num(n, 0)));
  if (arr && arr.length >= want) return arr;
  const out = new Float64Array(nextPow2(want));
  if (arr) out.set(arr);
  return out;
}

export function growI32(arr, n) {
  const want = Math.max(1, Math.ceil(num(n, 0)));
  if (arr && arr.length >= want) return arr;
  const out = new Int32Array(nextPow2(want));
  if (arr) out.set(arr);
  return out;
}

export function growU8(arr, n) {
  const want = Math.max(1, Math.ceil(num(n, 0)));
  if (arr && arr.length >= want) return arr;
  const out = new Uint8Array(nextPow2(want));
  if (arr) out.set(arr);
  return out;
}

// --- string id -> dense integer index ---------------------------------------
// Every array in Sys is indexed by an integer from one of these. The index of
// an id never changes while the map lives, so a flyweight bound to an index
// stays bound; a rebuild makes a new map and carries state across BY ID, never
// by index, which is the only thing that makes editing the network safe.

export class IdMap {
  constructor() {
    this._m = new Map();
    this._ids = [];
  }

  // -1 for an id that is not here. -1 rather than undefined so a caller can
  // put the result straight into an Int32Array.
  index(id) {
    const i = this._m.get(id);
    return i === undefined ? -1 : i;
  }

  // The existing index, or the next free one.
  intern(id) {
    let i = this._m.get(id);
    if (i === undefined) {
      i = this._ids.length;
      this._m.set(id, i);
      this._ids.push(id);
    }
    return i;
  }

  get size() { return this._ids.length; }

  // The live array, in index order, so reading it allocates nothing. It is the
  // map's own storage: do not mutate it.
  ids() { return this._ids; }

  clear() {
    this._m.clear();
    this._ids.length = 0;
    return this;
  }
}

// --- monotone 1-D table -----------------------------------------------------
// A shape's volume against its level, a profile's radius against its height, a
// pump curve: all of them are a handful of points with something looked up
// between them, both ways, thousands of times a second and never allocating.
//
// The cached index is what makes that cheap. The lookups this serves move a
// little from frame to frame (a level rises slowly), so the answer is almost
// always in the same interval as last time or the one next to it, and the
// binary search behind it is only ever paid on a jump.

export class Table {
  // xs strictly increasing. Both are copied into Float64Arrays, so the caller
  // may hand over a plain array and then throw it away.
  constructor(xs, ys) {
    const n = Math.min(xs ? xs.length : 0, ys ? ys.length : 0);
    this.n = n;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = num(xs[i], 0);
      this.ys[i] = num(ys[i], 0);
    }
    this._i = 0;   // cached interval for at()
    this._j = 0;   // cached interval for inv()
  }

  // y at x, clamped flat outside both ends. A table asked for a level below
  // the floor of a vessel answers with the floor's value rather than
  // extrapolating a negative volume.
  at(x) {
    const n = this.n;
    if (n === 0) return 0;
    const ys = this.ys;
    if (n === 1) return ys[0];
    const xs = this.xs;
    const v = clamp(x, xs[0], xs[n - 1]);
    let i = this._i;
    if (i < 0 || i > n - 2) i = 0;
    // One test covers the cached interval; anything else falls through to the
    // search. The bracket is inclusive at both ends so a value sitting exactly
    // on a knot does not force a search every time.
    if (!(v >= xs[i] && v <= xs[i + 1])) {
      let lo = 0, hi = n - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (xs[mid] <= v) lo = mid; else hi = mid - 1;
      }
      i = lo;
    }
    this._i = i;
    const d = xs[i + 1] - xs[i];
    const f = d > 0 ? (v - xs[i]) / d : 0;
    return ys[i] + (ys[i + 1] - ys[i]) * f;
  }

  // x at y, for ys monotone non-decreasing, clamped at both ends.
  //
  // A flat run in ys is a real case: a vessel profile pinched to zero radius
  // adds no volume over that height. The answer there is the BOTTOM of the
  // flat, because the liquid that volume represents does not reach any higher
  // than that; taking the top would float the surface up a dead zone it has no
  // water in.
  inv(y) {
    const n = this.n;
    if (n === 0) return 0;
    const xs = this.xs;
    if (n === 1) return xs[0];
    const ys = this.ys;
    const v = clamp(y, ys[0], ys[n - 1]);
    let i = this._j;
    if (i < 0 || i > n - 2) i = 0;
    if (!(v >= ys[i] && v < ys[i + 1])) {
      if (v >= ys[n - 1]) return xs[n - 1];
      // The smallest interval whose upper knot is strictly above v, which is
      // what puts a flat run's answer at its lower end.
      let lo = 0, hi = n - 2;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ys[mid + 1] > v) hi = mid; else lo = mid + 1;
      }
      i = lo;
    }
    this._j = i;
    const d = ys[i + 1] - ys[i];
    const f = d > 0 ? (v - ys[i]) / d : 0;
    return xs[i] + (xs[i + 1] - xs[i]) * f;
  }
}
