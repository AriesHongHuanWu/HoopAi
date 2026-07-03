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

import { BallTracker } from '../ballTracker';
import { DETECTION, TRACKER } from '../config';
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

  test('relaxed confidence gate applies only inside the hoop ROI', () => {
    const hoopRoi: Box = { x: 300, y: 100, width: 100, height: 100 };
    const score = 0.2; // between ballScoreMinHoopRoi (0.15) and ballScoreMin (0.3)

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

  test('occlusion: predicts for maxPredictedFrames, then resets and returns null', () => {
    const tracker = new BallTracker({});
    warmUp(tracker, 3, 400, 300);

    let step = 3;
    for (let k = 0; k < TRACKER.maxPredictedFrames; k++) {
      const out = tracker.step(frameAt(step * DT, []), null);
      expect(out).not.toBeNull();
      expect(out!.predicted).toBe(true);
      expect(out!.score).toBe(0);
      expect(out!.r).toBeCloseTo(15, 5);
      step++;
    }
    expect(tracker.getHistory()).toHaveLength(3 + TRACKER.maxPredictedFrames);

    // Past the budget: dead track.
    expect(tracker.step(frameAt(step * DT, []), null)).toBeNull();
    step++;
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
});
