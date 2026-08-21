/**
 * REGRESSION SUITE for the "Form Check theater draws a straight line" bug.
 *
 * WHAT SHIPPED. A 20 s screen recording from the owner's phone shows the
 * Compare tab with two figures in the SAME stage through the SAME renderer:
 * the synthesized REFERENCE is a correct stick figure, and YOU — decoded from
 * the captured `rep.sequence` — is a single VERTICAL LINE with the head circle
 * at the BOTTOM, zero horizontal extent, reading "ELBOW 180°" (which is what
 * three collinear points give). On other reps of the same recording YOU is
 * instead TWO LONG HORIZONTAL LINES spanning the whole card. Eleven reps were
 * scored off those shapes, and the cue list told a human being to raise his set
 * point on every one of them.
 *
 * WHY. src/core/formSequence.ts normalized every frame by the AXIS-ALIGNED
 * |ankle.y − nose.y|, accepted any such gap greater than ONE PIXEL, and clamped
 * the result into int16. So:
 *   - the scale was not roll-invariant — at 45° of image roll every coordinate
 *     grew 1.41×, at 90° about 10×, until it saturated the grid at ±4.096
 *     body-heights (the two horizontal lines);
 *   - nothing asked which way was UP — |Δy| is positive either way, so an
 *     upside-down capture encoded cleanly with its head below its hips (the
 *     head circle at the bottom);
 *   - nothing asked whether the thing was a body at all — a 2 px "body", or a
 *     collapsed keypoint column with no lateral extent, passed every check.
 *
 * Every `expect` below that names a refusal FAILED before the fix, because the
 * old packer happily returned a sequence for all four degenerate captures. The
 * upright pins are the invariant those refusals protect.
 */
import {
  SEQ_MAX_JOINT_N,
  SEQ_MISSING,
  SEQ_SCALE,
  buildSequence,
  decodeSequence,
  isReconstructibleMotion,
  sequenceGeometry,
  type DecodedFrame,
  type RawSeqFrame,
} from '../formSequence';
import { referenceSequence } from '../nbaReferenceForms';
import { PLAYER_ARCHETYPES } from '../nbaBenchmarks';
import type { PoseKeypointName } from '../types';

const DT = 1 / 30;
const FRAMES = 12;

interface XY {
  x: number;
  y: number;
}

/** Hip origin and pixel stature of every synthetic shooter below. */
const CX = 300;
const HIP_Y = 400;
const H = 200;

/**
 * A full 13-joint standing shooter with REAL shoulder width, in pixel space,
 * +y down. Offsets are anthropometric fractions of `h`, so the same body at
 * any pixel size is geometrically similar. `raiseU` (0..1) lifts the shooting
 * arm from the pocket to overhead so a sequence is a motion, not a still.
 */
function shooterPts(raiseU: number, h = H, cx = CX, hipY = HIP_Y): Map<PoseKeypointName, XY> {
  const at = (fx: number, fy: number): XY => ({ x: cx + fx * h, y: hipY + fy * h });
  const wristY = -0.16 - raiseU * 0.62;
  const wristX = 0.16 - raiseU * 0.04;
  const m = new Map<PoseKeypointName, XY>([
    ['nose', at(0.01, -0.44)],
    ['left_shoulder', at(-0.13, -0.36)],
    ['right_shoulder', at(0.13, -0.36)],
    ['left_elbow', at(-0.19, -0.17)],
    ['left_wrist', at(-0.13, -0.28)],
    ['right_elbow', at(wristX + 0.05, wristY / 2 - 0.14)],
    ['right_wrist', at(wristX, wristY)],
    ['left_hip', at(-0.09, 0)],
    ['right_hip', at(0.09, 0)],
    ['left_knee', at(-0.1, 0.24)],
    ['right_knee', at(0.1, 0.24)],
    ['left_ankle', at(-0.1, 0.52)],
    ['right_ankle', at(0.1, 0.52)],
  ]);
  return m;
}

/** Rotate a frame's keypoints by `deg` about the hip origin (a camera roll). */
function rolled(pts: Map<PoseKeypointName, XY>, deg: number): Map<PoseKeypointName, XY> {
  if (deg === 0) return pts;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out = new Map<PoseKeypointName, XY>();
  for (const [name, p] of pts) {
    const dx = p.x - CX;
    const dy = p.y - HIP_Y;
    out.set(name, { x: CX + dx * c - dy * s, y: HIP_Y + dx * s + dy * c });
  }
  return out;
}

/** A whole captured motion at a given camera roll. */
function capture(rollDeg = 0, h = H): RawSeqFrame[] {
  return Array.from({ length: FRAMES }, (_, i) => ({
    t: i * DT,
    pts: rolled(shooterPts(i / (FRAMES - 1), h), rollDeg),
  }));
}

/** Per-frame extents of a decoded motion (body-heights). */
function extentsOf(frame: DecodedFrame): { xw: number; yh: number } {
  const pts = Object.values(frame) as XY[];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { xw: Math.max(...xs) - Math.min(...xs), yh: Math.max(...ys) - Math.min(...ys) };
}

// ---------------------------------------------------------------------------
// The invariant: a real body round-trips as a real body
// ---------------------------------------------------------------------------

describe('a standing capture round-trips as a standing body', () => {
  it('keeps its geometry, puts the head ABOVE the hips, and has real width', () => {
    const raw = capture(0);
    const seq = buildSequence(raw, 'right');
    expect(seq).not.toBeNull();
    const decoded = decodeSequence(seq!);
    expect(decoded.length).toBe(FRAMES);

    // The convention, restated independently: hip-center origin, +y DOWN,
    // divided by the ROLL-INVARIANT head→foot distance.
    const mid = Math.floor(FRAMES / 2);
    const src = shooterPts(mid / (FRAMES - 1));
    const hip = {
      x: (src.get('left_hip')!.x + src.get('right_hip')!.x) / 2,
      y: (src.get('left_hip')!.y + src.get('right_hip')!.y) / 2,
    };
    const top = src.get('nose')!;
    const bottom = src.get('left_ankle')!;
    const unit = Math.hypot(bottom.x - top.x, bottom.y - top.y);
    const tol = 1 / SEQ_SCALE + 1e-9; // one quantiser step
    for (const [name, p] of src) {
      const got = decoded[mid]![name];
      expect(got).toBeDefined();
      expect(got!.x).toBeCloseTo((p.x - hip.x) / unit, 3);
      expect(got!.y).toBeCloseTo((p.y - hip.y) / unit, 3);
      expect(Math.abs(got!.x - (p.x - hip.x) / unit)).toBeLessThanOrEqual(tol);
    }

    // HEAD ABOVE HIPS, in every frame — the thing the shipped figure got
    // backwards. The origin IS the hip-center, so the sign is the whole test.
    for (const frame of decoded) {
      expect(frame.nose).toBeDefined();
      expect(frame.nose!.y).toBeLessThan(0);
      expect(frame.left_ankle!.y).toBeGreaterThan(0);
      expect(frame.left_shoulder!.y).toBeLessThan(frame.left_hip!.y);
    }

    // NON-ZERO HORIZONTAL EXTENT. A collapsed figure must be impossible to
    // ship again silently: the shipped one measured 0.000 ± 0.02 body-heights
    // across every joint, near, far and trunk planes on one column.
    const g = sequenceGeometry(decoded);
    expect(g.lateralExtent).toBeGreaterThan(0.2);
    expect(g.headBelowHip).toBe(0);
    expect(g.headAboveHip).toBe(FRAMES);
    // Shoulder width specifically survives — not just "some" width.
    const shoulderDx = Math.abs(
      decoded[mid]!.right_shoulder!.x - decoded[mid]!.left_shoulder!.x,
    );
    expect(shoulderDx).toBeGreaterThan(0.2);
  });

  it('lands in the SAME units and orientation as referenceSequence', () => {
    // This is the comparison the recording shows: user and reference in one
    // stage, one shared projection. If the two are not in the same units and
    // the same orientation, the stage is lying whatever it draws.
    const user = decodeSequence(buildSequence(capture(0), 'right')!);
    const ref = referenceSequence(PLAYER_ARCHETYPES[0]!, 'right');

    for (const seq of [user, ref]) {
      for (const frame of seq) {
        // Same origin: hips straddle it.
        expect(frame.left_hip!.x).toBeLessThan(0);
        expect(frame.right_hip!.x).toBeGreaterThan(0);
        // Same orientation: +y is DOWN, so head negative and feet positive.
        expect(frame.nose!.y).toBeLessThan(0);
        expect(frame.left_ankle!.y).toBeGreaterThan(0);
        // Same units: one body-height head-to-foot, give or take proportions.
        const span = frame.left_ankle!.y - frame.nose!.y;
        expect(span).toBeGreaterThan(0.8);
        expect(span).toBeLessThan(1.2);
      }
    }

    // And they are the same SIZE on the shared stage — within a quarter of a
    // body height, not the ~10× the saturated capture was drawn at.
    const uMid = extentsOf(user[Math.floor(user.length / 2)]!);
    const rMid = extentsOf(ref[Math.floor(ref.length / 2)]!);
    expect(Math.abs(uMid.yh - rMid.yh)).toBeLessThan(0.25);
    expect(Math.abs(uMid.xw - rMid.xw)).toBeLessThan(0.25);
  });

  it('a rolled capture keeps its TRUE size instead of magnifying', () => {
    // The old scale was |ankle.y − nose.y|, which shrinks as cos(roll): a 40°
    // roll magnified every coordinate by 1/cos40 = 1.31, and 45° by 1.41. The
    // roll-invariant head→foot distance does not move at all, so the body's
    // own diagonal is preserved and only its ORIENTATION on the stage changes.
    const diag = (frame: DecodedFrame) => {
      const { xw, yh } = extentsOf(frame);
      return Math.hypot(xw, yh);
    };
    const upright = decodeSequence(buildSequence(capture(0), 'right')!);
    const tilted = decodeSequence(buildSequence(capture(40), 'right')!);
    const u = diag(upright[6]!);
    const t = diag(tilted[6]!);
    expect(t / u).toBeGreaterThan(0.9);
    expect(t / u).toBeLessThan(1.1);
  });
});

// ---------------------------------------------------------------------------
// The refusals: every one of these returned a "body" before the fix
// ---------------------------------------------------------------------------

describe('a capture that is not a standing body is REFUSED, never drawn', () => {
  it('refuses a body lying on its side instead of magnifying it ~10×', () => {
    // BEFORE: |ankle.y − nose.y| collapsed to the body's lateral width, every
    // coordinate blew past the grid and saturated at ±4.096 body-heights —
    // the "two long horizontal lines spanning the card" shape.
    expect(buildSequence(capture(90), 'right')).toBeNull();
    expect(buildSequence(capture(-90), 'right')).toBeNull();
  });

  it('refuses an upside-down capture instead of encoding head-below-hips', () => {
    // BEFORE: this encoded cleanly with nose at +0.458 and ankle at −0.542 —
    // the head circle at the BOTTOM of the vertical line in the recording.
    expect(buildSequence(capture(180), 'right')).toBeNull();
  });

  it('refuses a two-pixel body', () => {
    // BEFORE: the only size gate was `h > 1`, so a 2 px human normalized fine
    // and every joint angle read off it was quantiser noise.
    expect(buildSequence(capture(0, 2), 'right')).toBeNull();
    // And the honest boundary: a body big enough to measure still packs.
    expect(buildSequence(capture(0, 120), 'right')).not.toBeNull();
  });

  it('refuses a collapsed keypoint column — the exact shape that shipped', () => {
    // Every keypoint on one x, a plausible y span, head below hips: what a
    // mis-detected pose looks like, and what the owner's phone drew as a
    // shooting form for eleven reps.
    const column: RawSeqFrame[] = Array.from({ length: FRAMES }, (_, i) => {
      const pts = new Map<PoseKeypointName, XY>();
      let k = 0;
      for (const name of [
        'left_ankle',
        'right_ankle',
        'left_knee',
        'right_knee',
        'left_shoulder',
        'right_shoulder',
        'left_hip',
        'right_hip',
        'left_elbow',
        'right_elbow',
        'left_wrist',
        'right_wrist',
        'nose',
      ] as PoseKeypointName[]) {
        pts.set(name, { x: CX, y: HIP_Y - 60 + k * 10 });
        k++;
      }
      return { t: i * DT, pts };
    });
    expect(buildSequence(column, 'right')).toBeNull();
  });

  it('never stores a saturated (fabricated) coordinate', () => {
    // A joint further out than any limb reaches comes back MISSING. It must
    // NOT come back as ±32767 = ±4.096 body-heights, which is a position the
    // detector never reported and every rule downstream would trust.
    const raw = capture(0).map((f) => {
      const pts = new Map(f.pts);
      pts.set('right_wrist', { x: CX + 12 * H, y: HIP_Y - 12 * H });
      return { t: f.t, pts };
    });
    const seq = buildSequence(raw, 'right');
    expect(seq).not.toBeNull();
    for (const v of seq!.data) {
      expect(Math.abs(v)).not.toBe(32767);
      expect(Math.abs(v)).toBeLessThanOrEqual(
        Math.max(SEQ_MAX_JOINT_N * SEQ_SCALE, Math.abs(SEQ_MISSING)),
      );
    }
    for (const frame of decodeSequence(seq!)) {
      expect(frame.right_wrist).toBeUndefined();
      expect(frame.nose).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The stage's own guard: sequences already persisted on the owner's phone
// ---------------------------------------------------------------------------

describe('isReconstructibleMotion guards what the stage is handed', () => {
  /** The shape the recording shows, as a decoded motion. */
  const collapsed: DecodedFrame[] = Array.from({ length: 8 }, () => ({
    nose: { x: 0, y: 0.6 },
    left_shoulder: { x: 0, y: 0.2 },
    right_shoulder: { x: 0, y: 0.2 },
    left_hip: { x: 0, y: 0 },
    right_hip: { x: 0, y: 0 },
    left_knee: { x: 0, y: -0.15 },
    left_ankle: { x: 0, y: -0.35 },
  }));

  it('refuses the collapsed, inverted figure the owner was shown', () => {
    expect(isReconstructibleMotion(collapsed)).toBe(false);
    const g = sequenceGeometry(collapsed);
    expect(g.lateralExtent).toBe(0);
    expect(g.headBelowHip).toBe(8);
  });

  it('refuses a saturated figure even with width to spare', () => {
    const exploded: DecodedFrame[] = Array.from({ length: 8 }, () => ({
      nose: { x: 4.096, y: 0 },
      left_shoulder: { x: 4.096, y: -4.096 },
      right_shoulder: { x: -4.096, y: -4.096 },
      left_hip: { x: -0.1, y: 0 },
      right_hip: { x: 0.1, y: 0 },
      left_knee: { x: -4.096, y: 4.096 },
      left_ankle: { x: 4.096, y: 4.096 },
    }));
    expect(isReconstructibleMotion(exploded)).toBe(false);
  });

  it('accepts what buildSequence now ships, and refuses what it rejects', () => {
    const good = decodeSequence(buildSequence(capture(0), 'right')!);
    expect(isReconstructibleMotion(good)).toBe(true);
    expect(isReconstructibleMotion([])).toBe(false);
    expect(isReconstructibleMotion([good[0]!])).toBe(false); // one pose, no motion
  });
});
