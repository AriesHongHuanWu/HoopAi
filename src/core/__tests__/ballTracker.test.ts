/**
 * BallTracker tests.
 *
 * `./kalman` is developed in parallel, so it is replaced here by a minimal
 * fake implementing the agreed API (constant-velocity passthrough): the suite
 * exercises BallTracker's gating/occlusion/history logic independently of the
 * real filter's numerics. `virtual: true` keeps the mock working even before
 * kalman.ts exists on disk.
 */
jest.mock(
  '../kalman',
  () => {
    /** Constant-velocity passthrough fake of the real BallKalman. */
    class BallKalman {
      private s: { x: number; y: number; vx: number; vy: number } | null = null;

      private lastT = 0;

      constructor(_opts: {
        gravityPxPerSec2: number;
        processNoise?: number;
        measurementNoise?: number;
      }) {
        // Fake: gravity/noise priors unused.
      }

      get initialized(): boolean {
        return this.s !== null;
      }

      get state(): { x: number; y: number; vx: number; vy: number } | null {
        return this.s;
      }

      init(x: number, y: number, t: number): void {
        this.s = { x, y, vx: 0, vy: 0 };
        this.lastT = t;
      }

      predict(t: number): { x: number; y: number; vx: number; vy: number } {
        const s = this.s!;
        const dt = t - this.lastT;
        this.s = {
          x: s.x + s.vx * dt,
          y: s.y + s.vy * dt,
          vx: s.vx,
          vy: s.vy,
        };
        this.lastT = t;
        return this.s;
      }

      update(
        x: number,
        y: number,
        t: number,
        _scale?: number,
      ): { x: number; y: number; vx: number; vy: number } {
        const prev = this.s!;
        const dt = t - this.lastT;
        this.s = {
          x,
          y,
          vx: dt > 0 ? (x - prev.x) / dt : prev.vx,
          vy: dt > 0 ? (y - prev.y) / dt : prev.vy,
        };
        this.lastT = t;
        return this.s;
      }
    }

    return { BallKalman };
  },
  { virtual: true },
);

import { BallTracker, distToSegment } from '../ballTracker';
import { DETECTION, RELEASE, TRACKER } from '../config';
import type { Box, Detection, FrameDetections } from '../types';

const FPS = 30;
const DT = 1 / FPS;

function ballDet(
  cx: number,
  cy: number,
  opts: { score?: number; w?: number; h?: number; cls?: Detection['cls'] } = {},
): Detection {
  const w = opts.w ?? 30;
  const h = opts.h ?? 30;
  return {
    cls: opts.cls ?? 'ball',
    score: opts.score ?? 0.8,
    box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
  };
}

function frameAt(t: number, detections: Detection[]): FrameDetections {
  return { t, frameWidth: 640, frameHeight: 640, detections };
}

/** Steps `n` frames of a stationary-ish ball starting at frame index `i0`. */
function warmUp(
  tracker: BallTracker,
  n: number,
  cx: number,
  cy: number,
  i0 = 0,
): void {
  for (let i = 0; i < n; i++) {
    const out = tracker.step(frameAt((i0 + i) * DT, [ballDet(cx, cy)]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
  }
}

describe('BallTracker', () => {
  test('ignores non-ball classes and low-confidence balls in open court', () => {
    const tracker = new BallTracker({});
    const rim: Detection = {
      cls: 'rim',
      score: 0.95,
      box: { x: 100, y: 100, width: 60, height: 40 },
    };
    expect(tracker.step(frameAt(0, [rim]), null)).toBeNull();

    const lowBall = ballDet(200, 200, { score: DETECTION.ballScoreMin - 0.05 });
    expect(tracker.step(frameAt(DT, [lowBall]), null)).toBeNull();
    expect(tracker.getHistory()).toHaveLength(0);
  });

  test('setColdGate raises the cold-acquisition bar per model (nano-v2), null restores default', () => {
    // A score above the default cold gate but below the nano-v2 override.
    const mid = (DETECTION.ballScoreMin + DETECTION.ballScoreMinNanoV2) / 2;
    // Default gate: the mid-score ball STARTS a track.
    const dflt = new BallTracker({});
    expect(dflt.step(frameAt(0, [ballDet(200, 200, { score: mid })]), null)).not.toBeNull();
    // Raised (nano-v2) gate: the SAME ball is rejected in open court.
    const raised = new BallTracker({});
    raised.setColdGate(DETECTION.ballScoreMinNanoV2);
    expect(raised.step(frameAt(0, [ballDet(200, 200, { score: mid })]), null)).toBeNull();
    expect(raised.getHistory()).toHaveLength(0);
    // Clearing the override restores the default (mid-score now acquires).
    raised.setColdGate(null);
    expect(raised.step(frameAt(DT, [ballDet(200, 200, { score: mid })]), null)).not.toBeNull();
  });

  test('rejects a giant near-frame-size ball box (no phantom track / screen-covering circle)', () => {
    const tracker = new BallTracker({});
    // A false "ball" filling most of a 640 frame (600×600): round aspect and
    // high score, so ONLY the max-size gate can stop it. Must not start a track
    // (otherwise r=(w+h)/4 → a huge overlay circle covering the screen).
    const giant = ballDet(320, 320, { score: 0.9, w: 600, h: 600 });
    expect(tracker.step(frameAt(0, [giant]), null)).toBeNull();
    expect(tracker.getHistory()).toHaveLength(0);
    // A normal-size ball right after is still tracked fine.
    const ok = tracker.step(frameAt(DT, [ballDet(320, 320, { w: 30, h: 30 })]), null);
    expect(ok).not.toBeNull();
    expect(ok!.predicted).toBe(false);
  });

  test('relaxed confidence gate applies only inside the hoop ROI', () => {
    const hoopRoi: Box = { x: 300, y: 100, width: 100, height: 100 };
    // Midway between the relaxed hoop-ROI gate and the open-court gate, so it's
    // accepted inside the ROI but rejected outside — derived from the constants
    // so it survives threshold retuning.
    const score = (DETECTION.ballScoreMinHoopRoi + DETECTION.ballScoreMin) / 2;

    // Same score OUTSIDE the ROI: rejected.
    const outside = new BallTracker({});
    expect(
      outside.step(frameAt(0, [ballDet(50, 50, { score })]), hoopRoi),
    ).toBeNull();

    // Inside the ROI: accepted.
    const inside = new BallTracker({});
    const out = inside.step(frameAt(0, [ballDet(350, 150, { score })]), hoopRoi);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.score).toBeCloseTo(score);
    expect(out!.cx).toBeCloseTo(350);
    expect(out!.cy).toBeCloseTo(150);

    // Below even the relaxed gate inside the ROI: rejected.
    const tooLow = new BallTracker({});
    expect(
      tooLow.step(
        frameAt(0, [ballDet(350, 150, { score: DETECTION.ballScoreMinHoopRoi - 0.05 })]),
        hoopRoi,
      ),
    ).toBeNull();
  });

  test('flight corridor relaxes the cold floor for a candidate on the predicted path', () => {
    // Score BETWEEN the tracking floor (0.12) and the cold floor (0.2): the
    // exact faint-mid-arc band the corridor exists to rescue.
    const score = (DETECTION.ballScoreMinTracking + DETECTION.ballScoreMin) / 2;
    const corridor = { p: { x: 200, y: 200 }, tubeR: 40 };

    // No corridor (cold tracker, no ROI): rejected at the cold floor.
    const bare = new BallTracker({});
    expect(bare.step(frameAt(0, [ballDet(200, 200, { score })]), null)).toBeNull();

    // Candidate ON the corridor path: relaxed to the tracking floor => accepted.
    const onPath = new BallTracker({});
    const out = onPath.step(
      frameAt(0, [ballDet(200, 200, { score })]),
      null,
      corridor,
    );
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(200);

    // Same score but OUTSIDE the tube: the corridor doesn't reach it => rejected.
    const offPath = new BallTracker({});
    expect(
      offPath.step(
        frameAt(0, [ballDet(400, 400, { score })]),
        null,
        corridor,
      ),
    ).toBeNull();
  });

  test('flight corridor never rescues a candidate below the tracking floor', () => {
    // Below 0.12: even sitting on the predicted path it must stay rejected —
    // the corridor relaxes the floor to tracking, not to zero.
    const score = DETECTION.ballScoreMinTracking - 0.03;
    const corridor = { p: { x: 200, y: 200 }, tubeR: 40 };
    const tracker = new BallTracker({});
    expect(
      tracker.step(frameAt(0, [ballDet(200, 200, { score })]), null, corridor),
    ).toBeNull();
  });

  describe('corridor capsule (segment between successive corridor points)', () => {
    // In the tracking band (>= 0.12) but under cold acquisition (0.2): the
    // faint fast-flight band the capsule exists to keep alive at low fps.
    const faintScore =
      (DETECTION.ballScoreMinTracking + DETECTION.ballScoreMin) / 2; // 0.16
    const corridorA = { p: { x: 100, y: 300 }, tubeR: 40 };
    const corridorB = { p: { x: 300, y: 300 }, tubeR: 40 };

    test('distToSegment: interior projection, endpoint clamp, degenerate segment', () => {
      expect(distToSegment(200, 310, 100, 300, 300, 300)).toBeCloseTo(10);
      // Beyond endpoint A: clamps to the endpoint, not the infinite line.
      expect(distToSegment(50, 300, 100, 300, 300, 300)).toBeCloseTo(50);
      // Degenerate (zero-length) segment = plain point distance.
      expect(distToSegment(0, 0, 3, 4, 3, 4)).toBeCloseTo(5);
    });

    test('capsule accepts between corridor points', () => {
      const tracker = new BallTracker({});
      // Prime last frame's corridor point A, then step frame B 1/8 s later
      // (within the 0.35 s capsule gap). The candidate at (200,310) sits 10 px
      // off segment A-B but ~100 px from EITHER point — the per-frame point
      // test alone would reject it (100 > tubeR 40).
      tracker.step(frameAt(0, []), null, corridorA);
      const out = tracker.step(
        frameAt(1 / 8, [ballDet(200, 310, { score: faintScore })]),
        null,
        corridorB,
      );
      expect(out).not.toBeNull();
      expect(out!.predicted).toBe(false);
      expect(out!.cx).toBeCloseTo(200);
      expect(out!.cy).toBeCloseTo(310);
    });

    test('capsule inert when stale (corridor points too far apart in time)', () => {
      const tracker = new BallTracker({});
      // Same geometry but 0.5 s between corridor frames (> 0.35 s gap): the
      // capsule must NOT bridge — back to the point test, which rejects.
      tracker.step(frameAt(0, []), null, corridorA);
      expect(
        tracker.step(
          frameAt(0.5, [ballDet(200, 310, { score: faintScore })]),
          null,
          corridorB,
        ),
      ).toBeNull();
    });

    test('capsule inert without a current corridor (cold gate applies)', () => {
      const tracker = new BallTracker({});
      // A last corridor point alone opens nothing: with corridor=null this
      // frame the faint candidate faces the full cold-acquisition gate.
      tracker.step(frameAt(0, []), null, corridorA);
      expect(
        tracker.step(
          frameAt(1 / 8, [ballDet(200, 310, { score: faintScore })]),
          null,
          null,
        ),
      ).toBeNull();
    });
  });

  test('gravity-aware projection: the gravity-corrected candidate wins the weighting', () => {
    const g = 900;
    const tracker = new BallTracker({ gravityPxPerSec2: g });
    // Two accepts giving vy ≈ +400 px/s (descending, +y down) at t1.
    const y1 = 100 + 400 * DT;
    tracker.step(frameAt(0, [ballDet(300, 100)]), null);
    tracker.step(frameAt(DT, [ballDet(300, y1)]), null);

    // After a 0.15 s detection gap (still inside jumpWindowSec so the track is
    // fresh), offer the constant-velocity position vs the gravity-corrected
    // one (+0.5·g·0.15² ≈ +10 px lower) at EQUAL scores: the inverse-distance
    // weighting must pick the physically correct (gravity) position.
    const gap = 0.15;
    const cvY = y1 + 400 * gap;
    const gravY = cvY + 0.5 * g * gap * gap;
    const out = tracker.step(
      frameAt(DT + gap, [
        ballDet(300, cvY, { score: 0.5 }),
        ballDet(300, gravY, { score: 0.5 }),
      ]),
      null,
    );
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cy).toBeCloseTo(gravY, 3);
  });

  test('tracks a clean projectile arc (y down: rising ball has vy < 0)', () => {
    const g = 900;
    const tracker = new BallTracker({ gravityPxPerSec2: g });
    const x0 = 100;
    const y0 = 500;
    const vx0 = 150;
    const vy0 = 400; // upward launch speed (px/s)

    for (let i = 0; i < 14; i++) {
      const t = i * DT;
      const cx = x0 + vx0 * t;
      const cy = y0 - vy0 * t + 0.5 * g * t * t;
      const out = tracker.step(frameAt(t, [ballDet(cx, cy)]), null);
      expect(out).not.toBeNull();
      expect(out!.predicted).toBe(false);
      expect(out!.cx).toBeCloseTo(cx, 5);
      expect(out!.cy).toBeCloseTo(cy, 5);
      expect(out!.r).toBeCloseTo(15, 5);
      if (i > 0) {
        // Still on the way up for this whole window.
        expect(out!.vy).toBeLessThan(0);
        expect(out!.vx).toBeGreaterThan(0);
      }
    }
    expect(tracker.getHistory()).toHaveLength(14);
    expect(tracker.getHistory().every((s) => !s.predicted)).toBe(true);
  });

  test('prefers the candidate near the Kalman prediction over a farther higher-score one', () => {
    const tracker = new BallTracker({});
    warmUp(tracker, 3, 100, 100);

    const near = ballDet(105, 100, { score: 0.4 });
    const far = ballDet(160, 100, { score: 0.9 }); // still inside the jump gate
    const out = tracker.step(frameAt(3 * DT, [far, near]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(105);
    expect(out!.score).toBeCloseTo(0.4);
  });

  test('aspect gate rejects a tall skinny box at slow speed and falls back to prediction', () => {
    const tracker = new BallTracker({});
    // Slow horizontal drift: 1 px/frame — far below the blur-streak speed.
    for (let i = 0; i < 3; i++) {
      tracker.step(frameAt(i * DT, [ballDet(200 + i, 200)]), null);
    }
    // w * 1.4 = 28 < 60 = h → non-round; speed too low for the exception.
    const tall = ballDet(203, 200, { w: 20, h: 60, score: 0.9 });
    const out = tracker.step(frameAt(3 * DT, [tall]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(true);
    expect(out!.score).toBe(0);
    // Prediction continues the slow drift, not the rejected box's inflation.
    expect(out!.cx).toBeCloseTo(203, 0);
    expect(out!.cy).toBeCloseTo(200, 0);
  });

  test('blur-streak exception: elongated box along a fast vertical velocity is accepted', () => {
    const tracker = new BallTracker({});
    // Fast fall: 100 px/frame (3000 px/s) — over 2 diameters (60 px) per frame.
    tracker.step(frameAt(0, [ballDet(300, 100)]), null);
    tracker.step(frameAt(DT, [ballDet(300, 200)]), null);

    // Vertically elongated streak on the predicted path.
    const streak = ballDet(300, 300, { w: 20, h: 80, score: 0.5 });
    const out = tracker.step(frameAt(2 * DT, [streak]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(300);
    expect(out!.cy).toBeCloseTo(300);
  });

  test('blur-streak exception does NOT apply across the velocity direction', () => {
    const tracker = new BallTracker({});
    // Fast HORIZONTAL motion: 100 px/frame.
    tracker.step(frameAt(0, [ballDet(100, 300)]), null);
    tracker.step(frameAt(DT, [ballDet(200, 300)]), null);

    // Tall (vertically elongated) box across the horizontal velocity.
    const tall = ballDet(300, 300, { w: 20, h: 80, score: 0.9 });
    const out = tracker.step(frameAt(2 * DT, [tall]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(true);
  });

  test('aspect gate rejects a wide short box at slow speed and falls back to prediction', () => {
    const tracker = new BallTracker({});
    // Slow vertical drift: 1 px/frame — far below the blur-streak speed.
    for (let i = 0; i < 3; i++) {
      tracker.step(frameAt(i * DT, [ballDet(200, 200 + i)]), null);
    }
    // h * 1.4 = 28 < 60 = w → non-round (wide/short); speed too low for the exception.
    const wide = ballDet(200, 203, { w: 60, h: 20, score: 0.9 });
    const out = tracker.step(frameAt(3 * DT, [wide]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(true);
    expect(out!.score).toBe(0);
    // Prediction continues the slow drift, not the rejected box's position.
    expect(out!.cx).toBeCloseTo(200, 0);
    expect(out!.cy).toBeCloseTo(203, 0);
  });

  test('blur-streak exception applies to a wide/short box along a fast horizontal velocity', () => {
    const tracker = new BallTracker({});
    // Fast horizontal fall: 100 px/frame (3000 px/s) — over 2 diameters (60 px) per frame.
    tracker.step(frameAt(0, [ballDet(100, 300)]), null);
    tracker.step(frameAt(DT, [ballDet(200, 300)]), null);

    // Horizontally elongated streak on the predicted path (crosscourt pass blur).
    const streak = ballDet(300, 300, { w: 80, h: 20, score: 0.5 });
    const out = tracker.step(frameAt(2 * DT, [streak]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(300);
    expect(out!.cy).toBeCloseTo(300);
  });

  test('wide/short blur-streak exception does NOT apply across the velocity direction', () => {
    const tracker = new BallTracker({});
    // Fast VERTICAL motion: 100 px/frame.
    tracker.step(frameAt(0, [ballDet(300, 100)]), null);
    tracker.step(frameAt(DT, [ballDet(300, 200)]), null);

    // Wide (horizontally elongated) box across the vertical velocity —
    // e.g. a horizontal limb/arm across the ball, not a real blur streak.
    const wide = ballDet(300, 300, { w: 80, h: 20, score: 0.9 });
    const out = tracker.step(frameAt(2 * DT, [wide]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(true);
  });

  test('jump gate rejects a teleporting box, then re-acquires after the window', () => {
    const tracker = new BallTracker({});
    warmUp(tracker, 3, 100, 100);

    // r = 15 → jump threshold = 4 * 30 = 120 px; (400,400) is ~424 px away.
    let step = 3;
    for (let k = 0; k < TRACKER.jumpWindowFrames; k++) {
      const out = tracker.step(
        frameAt(step * DT, [ballDet(400, 400, { score: 0.95 })]),
        null,
      );
      expect(out).not.toBeNull();
      expect(out!.predicted).toBe(true);
      // Prediction stays near the last real track, it does not teleport.
      expect(out!.cx).toBeLessThan(200);
      expect(out!.cy).toBeLessThan(200);
      step++;
    }

    // Window elapsed: the gate releases and the track re-acquires.
    const out = tracker.step(
      frameAt(step * DT, [ballDet(400, 400, { score: 0.95 })]),
      null,
    );
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(400);
    expect(out!.cy).toBeCloseTo(400);
  });

  test('occlusion: bridges through the time budget, then resets and returns null', () => {
    const tracker = new BallTracker({});
    warmUp(tracker, 3, 400, 300);
    const lastAcceptT = 2 * DT; // 3rd (last) warm-up frame's timestamp

    // Bridge a stationary ball through occlusion until the tracker gives up.
    // Count every predicted frame — the cap is now TIME-based, so at 30fps the
    // 0.5s budget binds before the 20-frame ceiling.
    let step = 3;
    let predicted = 0;
    for (;;) {
      const out = tracker.step(frameAt(step * DT, []), null);
      if (out === null) break;
      expect(out.predicted).toBe(true);
      expect(out.score).toBe(0);
      expect(out.r).toBeCloseTo(15, 5);
      predicted++;
      step++;
      // Safety: the frame ceiling must always eventually stop the loop.
      expect(predicted).toBeLessThanOrEqual(TRACKER.maxPredictedFrames);
    }

    // The TIME budget bound the bridge (fewer than the frame ceiling at 30fps):
    // the last emitted prediction sits within maxPredictedSec of the last real
    // detection, and one more frame would have exceeded it.
    expect(predicted).toBeLessThan(TRACKER.maxPredictedFrames);
    const history = tracker.getHistory();
    const lastPredT = history[history.length - 1].t;
    expect(lastPredT - lastAcceptT).toBeLessThanOrEqual(TRACKER.maxPredictedSec + 1e-9);
    expect(lastPredT + DT - lastAcceptT).toBeGreaterThan(TRACKER.maxPredictedSec);

    // Past the budget: dead track.
    expect(tracker.step(frameAt(step * DT, []), null)).toBeNull();
    step++;

    // After the reset a detection anywhere re-initializes with zero velocity.
    const out = tracker.step(frameAt(step * DT, [ballDet(100, 50)]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(100);
    expect(out!.cy).toBeCloseTo(50);
    expect(out!.vx).toBe(0);
    expect(out!.vy).toBe(0);
  });

  test('off-frame ghost cull: drops the track once a coasting prediction runs well off-frame', () => {
    const tracker = new BallTracker({});
    // Fast rightward motion near the right edge: two accepted detections 100px
    // apart (within the 120px jump gate) → vx ≈ 3000 px/s in the CV fake.
    tracker.step(frameAt(0, [ballDet(500, 300)]), null);
    const moving = tracker.step(frameAt(DT, [ballDet(600, 300)]), null);
    expect(moving).not.toBeNull();
    expect(moving!.predicted).toBe(false);

    // Occlude. The constant-velocity prediction marches right ~100px/frame.
    // Cull fires once predicted x passes 640 + 640*predictOffFrameMarginFrac.
    const cullX = 640 + 640 * TRACKER.predictOffFrameMarginFrac;
    let step = 2;
    let lastPredX = 600;
    for (;;) {
      const out = tracker.step(frameAt(step * DT, []), null);
      if (out === null) break;
      expect(out.predicted).toBe(true);
      expect(out.cx).toBeGreaterThan(lastPredX); // still marching right
      expect(out.cx).toBeLessThanOrEqual(cullX + 1); // never a wildly-off ghost
      lastPredX = out.cx;
      step++;
      expect(step).toBeLessThan(30); // safety
    }

    // It coasted off the right edge, then the cull dropped the track (rather
    // than the time/frame budget running out).
    expect(lastPredX).toBeGreaterThan(640);
    const reacq = tracker.step(frameAt(step * DT, [ballDet(320, 300)]), null);
    expect(reacq).not.toBeNull();
    expect(reacq!.predicted).toBe(false);
    expect(reacq!.vx).toBe(0); // fresh init, not the old rightward velocity
  });

  test('history ring buffer caps at TRACKER.historyLen', () => {
    const tracker = new BallTracker({});
    const total = TRACKER.historyLen + 10;
    for (let i = 0; i < total; i++) {
      tracker.step(frameAt(i * DT, [ballDet(100, 100)]), null);
    }
    const history = tracker.getHistory();
    expect(history).toHaveLength(TRACKER.historyLen);
    // Oldest retained sample is the (total - historyLen)-th frame.
    expect(history[0].t).toBeCloseTo((total - TRACKER.historyLen) * DT, 6);
    expect(history[history.length - 1].t).toBeCloseTo((total - 1) * DT, 6);
  });

  test('history prunes samples older than staleSampleSec', () => {
    const tracker = new BallTracker({});
    warmUp(tracker, 5, 100, 100);
    expect(tracker.getHistory()).toHaveLength(5);

    // Big time gap (> staleSampleSec) with the ball still nearby.
    const tLate = 4 * DT + TRACKER.staleSampleSec + 1.0;
    const out = tracker.step(frameAt(tLate, [ballDet(102, 100)]), null);
    expect(out).not.toBeNull();
    const history = tracker.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].t).toBeCloseTo(tLate, 6);
  });

  test('reset clears history and track state', () => {
    const tracker = new BallTracker({});
    warmUp(tracker, 5, 250, 250);
    tracker.reset();
    expect(tracker.getHistory()).toHaveLength(0);

    // Fresh init: zero velocity, no jump gate against the pre-reset track.
    const out = tracker.step(frameAt(1.0, [ballDet(600, 30)]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.vx).toBe(0);
    expect(out!.vy).toBe(0);
    expect(tracker.getHistory()).toHaveLength(1);
  });

  describe('flight-continuation relaxed gate', () => {
    // Between hoop-ROI floor (0.1) and the tracking floor (0.12)? No — pick a
    // score between tracking (0.12) and open-court (0.2): real mid-flight band.
    const flightScore =
      (DETECTION.ballScoreMinTracking + DETECTION.ballScoreMin) / 2; // 0.16

    test('continues a fresh track through low-score flight detections', () => {
      const tracker = new BallTracker({});
      warmUp(tracker, 3, 100, 100); // strong acquisitions at 0.8
      // Mid-flight: the dark/small ball now scores ~0.16 — previously dropped.
      const out = tracker.step(
        frameAt(3 * DT, [ballDet(110, 90, { score: flightScore })]),
        null,
      );
      expect(out).not.toBeNull();
      expect(out!.predicted).toBe(false); // REAL detection accepted
      expect(out!.cx).toBeCloseTo(110);
    });

    test('never STARTS a track from a low score (cold acquisition needs 0.2)', () => {
      const tracker = new BallTracker({});
      const out = tracker.step(
        frameAt(0, [ballDet(200, 200, { score: flightScore })]),
        null,
      );
      expect(out).toBeNull();
    });

    test('gate re-tightens once the track goes stale (window expired)', () => {
      const tracker = new BallTracker({});
      warmUp(tracker, 3, 100, 100);
      // Starve the track past the jump window (all empty frames).
      let step = 3;
      for (let k = 0; k <= TRACKER.jumpWindowFrames; k++) {
        tracker.step(frameAt(step * DT, []), null);
        step++;
      }
      // Track is no longer fresh: a 0.16 far detection must NOT re-acquire.
      const out = tracker.step(
        frameAt(step * DT, [ballDet(400, 400, { score: flightScore })]),
        null,
      );
      // Either predicted-coast or null — never a real acceptance.
      if (out != null) expect(out.predicted).toBe(true);
    });
  });

  describe('dark-scene relaxed cold acquisition (setLightProfile)', () => {
    // Between the dark cold floor (0.16) and the bright cold floor (0.2):
    // the low-light regime the 'dark' profile exists for. 0.17 in practice.
    const darkScore = DETECTION.ballScoreMinDark + 0.01;

    test('the dark floor sits between tracking and cold acquisition', () => {
      expect(DETECTION.ballScoreMinDark).toBeGreaterThan(
        DETECTION.ballScoreMinTracking,
      );
      expect(DETECTION.ballScoreMinDark).toBeLessThan(DETECTION.ballScoreMin);
      expect(darkScore).toBeLessThan(DETECTION.ballScoreMin);
    });

    test("STARTS a track from a 0.17 ball in 'dark'", () => {
      const tracker = new BallTracker({});
      tracker.setLightProfile('dark');
      const out = tracker.step(
        frameAt(0, [ballDet(200, 200, { score: darkScore })]),
        null,
      );
      expect(out).not.toBeNull();
      expect(out!.predicted).toBe(false);
      expect(out!.cx).toBeCloseTo(200);
      expect(out!.score).toBeCloseTo(darkScore);
    });

    test('rejects the same ball cold in bright (the default profile)', () => {
      const tracker = new BallTracker({});
      expect(
        tracker.step(frameAt(0, [ballDet(200, 200, { score: darkScore })]), null),
      ).toBeNull();
    });

    test("'dim' changes nothing — the full cold gate still applies", () => {
      const tracker = new BallTracker({});
      tracker.setLightProfile('dim');
      expect(
        tracker.step(frameAt(0, [ballDet(200, 200, { score: darkScore })]), null),
      ).toBeNull();
    });

    test('below the dark floor is still rejected cold, even in dark', () => {
      const tracker = new BallTracker({});
      tracker.setLightProfile('dark');
      // Above the tracking floor (0.12) but under the dark cold floor (0.16):
      // proves dark relaxes cold acquisition to 0.16, NOT to the tracking gate.
      const tooLow = DETECTION.ballScoreMinDark - 0.01;
      expect(tooLow).toBeGreaterThan(DETECTION.ballScoreMinTracking);
      expect(
        tracker.step(frameAt(0, [ballDet(200, 200, { score: tooLow })]), null),
      ).toBeNull();
    });

    test('every other defense stays armed in dark: the giant-box cap still rejects', () => {
      const tracker = new BallTracker({});
      tracker.setLightProfile('dark');
      const giant = ballDet(320, 320, { score: 0.9, w: 600, h: 600 });
      expect(tracker.step(frameAt(0, [giant]), null)).toBeNull();
      expect(tracker.getHistory()).toHaveLength(0);
    });

    test('flipping back to bright re-tightens the cold gate', () => {
      const tracker = new BallTracker({});
      tracker.setLightProfile('dark');
      tracker.setLightProfile('bright');
      expect(
        tracker.step(frameAt(0, [ballDet(200, 200, { score: darkScore })]), null),
      ).toBeNull();
    });
  });

  describe('wrist-seeded reacquisition (pose release event)', () => {
    // In the tracking band (>= 0.12) but under cold acquisition (0.2): the
    // faint just-released ball the wrist prior exists for.
    const faintScore =
      (DETECTION.ballScoreMinTracking + DETECTION.ballScoreMin) / 2; // 0.16

    test('STARTS a track from a faint ball near the released wrist', () => {
      const tracker = new BallTracker({});
      tracker.setReleaseEvent(300, 200, 0);
      // 28 px from the wrist — well inside 0.15 × 640 = 96 px. With no prior
      // track this same detection was rejected before (see the cold-
      // acquisition test above); the wrist prior substitutes for locality.
      const out = tracker.step(
        frameAt(DT, [ballDet(320, 180, { score: faintScore })]),
        null,
      );
      expect(out).not.toBeNull();
      expect(out!.predicted).toBe(false);
      expect(out!.cx).toBeCloseTo(320);
      expect(out!.cy).toBeCloseTo(180);
    });

    test('a faint ball far from the wrist still needs the cold-acquisition score', () => {
      const tracker = new BallTracker({});
      tracker.setReleaseEvent(300, 200, 0);
      // ~360 px away — the seed must not open a court-wide low-score hole.
      expect(
        tracker.step(frameAt(DT, [ballDet(100, 500, { score: faintScore })]), null),
      ).toBeNull();
    });

    test('the seed expires after RELEASE.seedWindowSec', () => {
      const tracker = new BallTracker({});
      tracker.setReleaseEvent(300, 200, 0);
      const late = RELEASE.seedWindowSec + 0.1;
      expect(
        tracker.step(frameAt(late, [ballDet(320, 180, { score: faintScore })]), null),
      ).toBeNull();
    });
  });

  test('history interleaves accepted and predicted samples in order', () => {
    const tracker = new BallTracker({});
    warmUp(tracker, 2, 300, 300);
    tracker.step(frameAt(2 * DT, []), null); // predicted
    tracker.step(frameAt(3 * DT, [ballDet(300, 300)]), null); // re-accepted

    const history = tracker.getHistory();
    expect(history.map((s) => s.predicted)).toEqual([false, false, true, false]);
    for (let i = 1; i < history.length; i++) {
      expect(history[i].t).toBeGreaterThan(history[i - 1].t);
    }
  });

  describe('session ball size cap (setSessionBallSizeCap, shrink-only)', () => {
    // 0.15 of the 640 frame: comfortably under the config cap (0.22) but over
    // a 0.10 session cap. Round box, high score — only size gates it.
    const box015 = ballDet(320, 320, { score: 0.9, w: 96, h: 96 });

    test('a 0.15-fraction box is accepted by default but rejected after a 0.10 cap', () => {
      const dflt = new BallTracker({});
      const ok = dflt.step(frameAt(0, [box015]), null);
      expect(ok).not.toBeNull();
      expect(ok!.predicted).toBe(false);

      const capped = new BallTracker({});
      capped.setSessionBallSizeCap(0.1);
      expect(capped.step(frameAt(0, [box015]), null)).toBeNull();
      expect(capped.getHistory()).toHaveLength(0);
      const stats = capped.lastStepStats();
      expect(stats.rejSize).toBe(1);
      expect(stats.lastReject).toBe('size');
    });

    test('a loosening cap (0.5) clamps to the config default — behavior identical', () => {
      const capped = new BallTracker({});
      capped.setSessionBallSizeCap(0.5);
      // Under the config cap: still accepted.
      expect(capped.step(frameAt(0, [box015]), null)).not.toBeNull();
      // Over the config cap (0.23 > 0.22): still rejected — the session cap
      // can never LOOSEN the gate.
      const over = ballDet(320, 320, {
        score: 0.9,
        w: 640 * (DETECTION.ballMaxSizeFraction + 0.01),
        h: 640 * (DETECTION.ballMaxSizeFraction + 0.01),
      });
      const fresh = new BallTracker({});
      fresh.setSessionBallSizeCap(0.5);
      expect(fresh.step(frameAt(0, [over]), null)).toBeNull();
    });

    test('null restores the config default', () => {
      const tracker = new BallTracker({});
      tracker.setSessionBallSizeCap(0.1);
      expect(tracker.step(frameAt(0, [box015]), null)).toBeNull();
      tracker.setSessionBallSizeCap(null);
      expect(tracker.step(frameAt(DT, [box015]), null)).not.toBeNull();
    });

    test('non-finite or non-positive input is treated as null (default cap)', () => {
      for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
        const tracker = new BallTracker({});
        tracker.setSessionBallSizeCap(junk);
        expect(tracker.step(frameAt(0, [box015]), null)).not.toBeNull();
      }
    });

    test('score floors, aspect gate, and jump gate are unchanged by the cap', () => {
      // Score floor: a low-score small ball still fails cold acquisition.
      const scoreT = new BallTracker({});
      scoreT.setSessionBallSizeCap(0.1);
      expect(
        scoreT.step(
          frameAt(0, [ballDet(200, 200, { score: DETECTION.ballScoreMin - 0.05 })]),
          null,
        ),
      ).toBeNull();
      expect(scoreT.lastStepStats().lastReject).toBe('score');

      // Aspect gate: a slow tall-skinny box still falls back to prediction.
      const aspectT = new BallTracker({});
      aspectT.setSessionBallSizeCap(0.1);
      for (let i = 0; i < 3; i++) {
        aspectT.step(frameAt(i * DT, [ballDet(200 + i, 200)]), null);
      }
      const tall = ballDet(203, 200, { w: 20, h: 60, score: 0.9 });
      const aspectOut = aspectT.step(frameAt(3 * DT, [tall]), null);
      expect(aspectOut).not.toBeNull();
      expect(aspectOut!.predicted).toBe(true);
      expect(aspectT.lastStepStats().lastReject).toBe('aspect');

      // Jump gate: a teleporting box is still rejected inside the window.
      const jumpT = new BallTracker({});
      jumpT.setSessionBallSizeCap(0.1);
      warmUp(jumpT, 3, 100, 100);
      const jumpOut = jumpT.step(
        frameAt(3 * DT, [ballDet(400, 400, { score: 0.95 })]),
        null,
      );
      expect(jumpOut).not.toBeNull();
      expect(jumpOut!.predicted).toBe(true);
      expect(jumpT.lastStepStats().lastReject).toBe('jump');

      // Dark-profile floor still applies with a cap set.
      const darkT = new BallTracker({});
      darkT.setSessionBallSizeCap(0.1);
      darkT.setLightProfile('dark');
      expect(
        darkT.step(
          frameAt(0, [ballDet(200, 200, { score: DETECTION.ballScoreMinDark + 0.01 })]),
          null,
        ),
      ).not.toBeNull();
    });
  });

  describe('acquisition telemetry on the existing fixtures (regression + stats)', () => {
    test('a clean cold accept reports accepted/cold with zero rejects', () => {
      const tracker = new BallTracker({});
      const out = tracker.step(frameAt(0, [ballDet(100, 100)]), null);
      expect(out).not.toBeNull();
      const stats = tracker.lastStepStats();
      expect(stats).toEqual({
        ballDets: 1,
        floor: DETECTION.ballScoreMin,
        gate: 'cold',
        rejScore: 0,
        rejSize: 0,
        rejAspect: 0,
        rejJump: 0,
        lastReject: null,
        accepted: true,
        rescued: false,
      });
    });

    test('an empty frame reports an inert stats object (floor still active)', () => {
      const tracker = new BallTracker({});
      tracker.step(frameAt(0, []), null);
      const stats = tracker.lastStepStats();
      expect(stats.ballDets).toBe(0);
      expect(stats.accepted).toBe(false);
      expect(stats.gate).toBe('none');
      expect(stats.lastReject).toBeNull();
      expect(stats.floor).toBeCloseTo(DETECTION.ballScoreMin);
    });
  });
});
