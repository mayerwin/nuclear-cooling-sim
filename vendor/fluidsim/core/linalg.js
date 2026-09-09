// ---------------------------------------------------------------------------
// linalg.js - two symmetric solves for the same matrix, one dense and one not.
//
// The nodal Newton's Jacobian is a weighted graph Laplacian with a
// non-negative diagonal shift: symmetric and positive definite. It is also
// very sparse, because a node is joined only to the handful of nodes it shares
// a pipe with, and that is what decides which solve to use.
//
// SMALL: a dense LDL^T. Exact, cheaper than any iterative scheme at this size
// (12^3/3 flops for a twelve-unknown network), and it cannot be truncated. A
// relaxation stopped early publishes mass flows that do not close at the
// nodes, and the whole library rests on them closing.
//
// LARGE: a Jacobi-preconditioned conjugate gradient over the same matrix held
// in compressed rows. The dense factorisation is O(n^3) in time and O(n^2) in
// memory, so a whole plant rather than one machine went from expensive to
// impossible: measured, 42 unknowns cost 112 us a step and 62 cost 579, and
// past 64 the solver refused to run at all. CG is O(edges) an iteration, warm
// starts from the pressures the last frame settled on, and on a Laplacian that
// has barely moved since is usually done in a few of them.
//
// Truncating CG is safe HERE, where truncating a relaxation would not be,
// because of what surrounds it: every CG iterate is a descent direction for
// the Newton model, the Armijo line search outside rejects a step that does
// not actually reduce the residual, and the flows that get published are
// recomputed from whatever pressures survive that test. An imperfect step
// costs an extra Newton iteration; it cannot publish flows that do not close.
//
// LDL^T rather than Cholesky: no square roots, so no way to take the root of a
// negative pivot that round-off has produced, and the pivots stay visible as
// plain numbers we can floor.
//
// No imports, no allocation: the caller owns every array. NOTHING HERE MAY
// RETURN NaN, even handed a singular matrix, because the result becomes a
// pressure and then a velocity and then a vertex position.
// ---------------------------------------------------------------------------

export const LDL_EPS = 1e-12;

// In-place LDL^T of a dense symmetric n x n matrix stored row-major in A
// (a Float64Array of length >= n*n). On return the strict lower triangle holds
// L (unit diagonal implied) and the diagonal holds D. Only the lower triangle
// and the diagonal of the input are read, so a caller that fills one triangle
// is enough; the upper triangle is left exactly as it was.
//
// Returns the number of floored pivots, which is the honest signal that the
// matrix was not what it claimed to be: for an operational network it is 0,
// and any other number means a component had no reference and was pinned, or
// an edge conductance underflowed.
export function ldl(A, n) {
  // The floor is scaled by the matrix's own size, so it means the same thing
  // for a network in pascals per kg/s as for one in any other units. A trace
  // that is zero or not finite (an empty system, or a host's NaN that reached
  // a conductance) falls back to the bare epsilon rather than to a floor of
  // zero, which is the one value that would let the division below blow up.
  let tr = 0;
  for (let i = 0; i < n; i++) {
    const d = A[i * n + i];
    tr += Number.isFinite(d) ? Math.abs(d) : 0;
  }
  let fl = LDL_EPS * tr / Math.max(1, n);
  if (!(fl > 0)) fl = LDL_EPS;

  let floored = 0;
  for (let j = 0; j < n; j++) {
    const jj = j * n;
    let d = A[jj + j];
    for (let k = 0; k < j; k++) {
      const l = A[jj + k];
      d -= l * l * A[k * n + k];
    }
    // A SIGNED floor, not a floor on the magnitude. In exact arithmetic every
    // pivot of this matrix is positive, so a pivot at or below the floor is
    // either round-off or a component nothing pins, and lifting it to a small
    // positive number keeps the factor positive definite and the Newton step a
    // descent direction. Written this way round, a NaN pivot also lands on the
    // floor instead of being propagated through the whole factorisation.
    if (!(d > fl)) { d = fl; floored++; }
    A[jj + j] = d;

    for (let i = j + 1; i < n; i++) {
      const ii = i * n;
      let s = A[ii + j];
      for (let k = 0; k < j; k++) s -= A[ii + k] * A[jj + k] * A[k * n + k];
      const l = s / d;
      // The last gate on a non-finite value getting into the factor at all: a
      // NaN that arrived in an off-diagonal entry becomes a zero coupling
      // rather than a NaN pressure everywhere downstream of it.
      A[ii + j] = Number.isFinite(l) ? l : 0;
    }
  }
  return floored;
}

// Solve A x = b using the factorisation left in A by ldl(). x may alias b.
export function ldlSolve(A, n, b, x) {
  // Forward substitution through the unit lower triangle.
  for (let i = 0; i < n; i++) {
    const ii = i * n;
    let s = b[i];
    if (!Number.isFinite(s)) s = 0;
    for (let k = 0; k < i; k++) s -= A[ii + k] * x[k];
    x[i] = s;
  }
  // The diagonal. Every pivot was floored away from zero by ldl(), so this
  // division is safe by construction rather than by hope.
  for (let i = 0; i < n; i++) {
    const v = x[i] / A[i * n + i];
    x[i] = Number.isFinite(v) ? v : 0;
  }
  // Back substitution through L^T, which is the same storage read the other
  // way: L^T[i][k] is A[k*n + i].
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= A[k * n + i] * x[k];
    x[i] = Number.isFinite(s) ? s : 0;
  }
  return x;
}

// Both norms report a non-finite component as an INFINITE norm rather than
// skipping it. The Newton line search accepts a step when the residual norm
// falls, and `NaN > something` is false: a norm that quietly ignored a NaN
// would let the one step that must never be taken look like the best one.
export function norm1(v, n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = v[i];
    if (!Number.isFinite(a)) return Infinity;
    s += a < 0 ? -a : a;
  }
  return s;
}

export function normInf(v, n) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = v[i];
    if (!Number.isFinite(a)) return Infinity;
    const b = a < 0 ? -a : a;
    if (b > m) m = b;
  }
  return m;
}

// --- the sparse path ---------------------------------------------------------
// The same matrix, held in compressed rows: rowPtr has n+1 entries, colIdx and
// val have rowPtr[n] entries, and row i occupies [rowPtr[i], rowPtr[i+1]). The
// FULL symmetric matrix is stored, both triangles, because a matrix-vector
// product over one triangle needs a scatter and this one is a hot loop.
//
// Jacobi preconditioning is the diagonal, which for a Laplacian is the sum of
// the conductances at a node: exactly the scale of that row, and it costs one
// divide. Anything stronger would need a factorisation, which is the thing
// being avoided.
//
// Every working vector is the caller's, so this allocates nothing. x is both
// the starting guess and the answer, which is what makes the warm start work:
// hand back the previous step's solution and a settled network converges in
// one or two iterations.
//
// Returns the number of iterations taken. It never throws, and if the matrix
// is degenerate it stops on the guard below and leaves x finite.
export function pcg(rowPtr, colIdx, val, diag, n, b, x, r, z, p, Ap, maxIter, tol) {
  if (n <= 0) return 0;

  // r = b - A x, and z = M^-1 r with M the diagonal.
  let rz = 0;
  for (let i = 0; i < n; i++) {
    let ax = 0;
    for (let k = rowPtr[i], e = rowPtr[i + 1]; k < e; k++) ax += val[k] * x[colIdx[k]];
    const ri = b[i] - ax;
    r[i] = ri;
    // A diagonal that is zero or not finite means a row with nothing on it:
    // preconditioning it by one leaves the iteration well defined instead of
    // handing an infinity to the next multiply.
    const d = diag[i];
    const zi = d > 0 && Number.isFinite(d) ? ri / d : ri;
    z[i] = zi;
    p[i] = zi;
    rz += ri * zi;
  }
  if (!Number.isFinite(rz)) { for (let i = 0; i < n; i++) x[i] = 0; return 0; }

  // The tolerance is relative to the right-hand side, so it means the same
  // thing whether the network is in pascals or in anything else.
  let bn = 0;
  for (let i = 0; i < n; i++) { const a = b[i]; bn += a < 0 ? -a : a; }
  const stop = tol * (bn > 1 ? bn : 1);

  let it = 0;
  for (; it < maxIter; it++) {
    let pAp = 0;
    for (let i = 0; i < n; i++) {
      let ax = 0;
      for (let k = rowPtr[i], e = rowPtr[i + 1]; k < e; k++) ax += val[k] * p[colIdx[k]];
      Ap[i] = ax;
      pAp += p[i] * ax;
    }
    // A non-positive curvature cannot happen for a positive definite matrix,
    // so if it does the matrix is not what it claimed to be. Stopping with the
    // iterate in hand is right: it is still a descent direction and the line
    // search outside will decide what to do with it.
    if (!(pAp > 0) || !Number.isFinite(pAp)) break;

    const alpha = rz / pAp;
    if (!Number.isFinite(alpha)) break;

    let rn = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      const ri = r[i] - alpha * Ap[i];
      r[i] = ri;
      rn += ri < 0 ? -ri : ri;
    }
    if (!(rn > stop)) { it++; break; }

    let rzNew = 0;
    for (let i = 0; i < n; i++) {
      const d = diag[i];
      const zi = d > 0 && Number.isFinite(d) ? r[i] / d : r[i];
      z[i] = zi;
      rzNew += r[i] * zi;
    }
    if (!Number.isFinite(rzNew)) break;
    const beta = rzNew / rz;
    rz = rzNew;
    if (!Number.isFinite(beta)) break;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }

  // Whatever happened above, the caller gets numbers it can use.
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) x[i] = 0;
  return it;
}
