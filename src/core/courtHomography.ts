/**
 * courtHomography — map image pixels ⇄ the court plane with a plane-to-plane
 * homography, so 2/3 works from ANY camera placement.
 *
 * A homography is a 3×3 projective transform between two planes. Given ≥4
 * correspondences between tapped/detected image points and their known court
 * coordinates (src/core/courtModel.ts), we solve for H mapping image → court.
 * Because it captures the full projective relationship, it is INHERENTLY
 * orientation-agnostic: side-on, baseline, top-of-key — whatever the angle, a
 * foot pixel maps to a true court position, and threePointLine.ts then gives a
 * corner-accurate 2/3. This is the same court-registration idea the incumbents
 * use, done explicitly and offline-testably.
 *
 * Solve = normalized DLT (Hartley conditioning) with the inhomogeneous h33 = 1
 * parameterization; exact for 4 points, least-squares (normal equations) for
 * more. Pure TS, no deps — round-trip unit-tested against synthetic perspective
 * scenes where ground truth is exact.
 */

/** Row-major 3×3 homography [h11,h12,h13, h21,h22,h23, h31,h32,h33]. */
export type Homography = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface Correspondence {
  /** Point in the analysis image (pixels). */
  image: { x: number; y: number };
  /** The same point's court-plane coordinate (meters, basket origin). */
  court: { x: number; y: number };
}

/** Square linear solve A·x = b (n×n) via Gauss-Jordan w/ partial pivoting. */
function solveLinear(Ain: readonly number[][], bin: readonly number[], n: number): number[] | null {
  const A = Ain.map((r) => r.slice());
  const b = bin.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(A[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r]![col]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-12) return null; // singular / degenerate correspondences
    if (piv !== col) {
      const tr = A[col]!;
      A[col] = A[piv]!;
      A[piv] = tr;
      const tb = b[col]!;
      b[col] = b[piv]!;
      b[piv] = tb;
    }
    const pv = A[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / pv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r]![c] = A[r]![c]! - f * A[col]![c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = b[i]! / A[i]![i]!;
  return x;
}

interface Norm {
  /** Similarity transform (row-major 3×3) mapping raw → normalized. */
  s: number;
  cx: number;
  cy: number;
  pts: { x: number; y: number }[];
}

/** Hartley normalization: center at the centroid, scale mean distance to √2. */
function normalize(pts: readonly { x: number; y: number }[]): Norm | null {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let meanDist = 0;
  for (const p of pts) meanDist += Math.hypot(p.x - cx, p.y - cy);
  meanDist /= n;
  if (!(meanDist > 1e-12)) return null; // all points coincident
  const s = Math.SQRT2 / meanDist;
  return {
    s,
    cx,
    cy,
    pts: pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
  };
}

/** Multiply two row-major 3×3 matrices. */
function mul3(A: readonly number[], B: readonly number[]): number[] {
  const C = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[r * 3 + k]! * B[k * 3 + c]!;
      C[r * 3 + c] = s;
    }
  }
  return C;
}

/**
 * Solve the image→court homography from ≥4 correspondences, or null when the
 * points are degenerate (fewer than 4, coincident, or collinear).
 */
export function solveHomography(corr: readonly Correspondence[]): Homography | null {
  if (corr.length < 4) return null;
  const ni = normalize(corr.map((c) => c.image));
  const nc = normalize(corr.map((c) => c.court));
  if (!ni || !nc) return null;

  // Build the 2N×8 inhomogeneous DLT system on the NORMALIZED points.
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < corr.length; i++) {
    const { x: u, y: v } = ni.pts[i]!;
    const { x, y } = nc.pts[i]!;
    rows.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    rhs.push(y);
  }

  let h: number[] | null;
  if (rows.length === 8) {
    h = solveLinear(rows, rhs, 8);
  } else {
    // Overdetermined → normal equations AᵀA h = Aᵀb (8×8).
    const AtA: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
    const Atb = new Array<number>(8).fill(0);
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k]!;
      const bk = rhs[k]!;
      for (let i = 0; i < 8; i++) {
        Atb[i]! += row[i]! * bk;
        for (let j = 0; j < 8; j++) AtA[i]![j]! += row[i]! * row[j]!;
      }
    }
    h = solveLinear(AtA, Atb, 8);
  }
  if (!h) return null;

  // Normalized homography (h33 = 1), then denormalize: H = Tc⁻¹ · Hn · Ti.
  const Hn = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
  const Ti = [ni.s, 0, -ni.s * ni.cx, 0, ni.s, -ni.s * ni.cy, 0, 0, 1];
  // Inverse of the court similarity (analytic): undo scale, then translate back.
  const TcInv = [1 / nc.s, 0, nc.cx, 0, 1 / nc.s, nc.cy, 0, 0, 1];
  const H = mul3(mul3(TcInv, Hn), Ti);
  if (Math.abs(H[8]!) < 1e-12) return null;
  return H.map((v) => v / H[8]!) as unknown as Homography;
}

/** Apply H to an image pixel → court coordinate, or null if it maps to infinity. */
export function applyHomography(H: Homography, u: number, v: number): { x: number; y: number } | null {
  const w = H[6] * u + H[7] * v + H[8];
  if (Math.abs(w) < 1e-9) return null;
  return {
    x: (H[0] * u + H[1] * v + H[2]) / w,
    y: (H[3] * u + H[4] * v + H[5]) / w,
  };
}
