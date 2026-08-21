/**
 * Low-fps BallTracker matrix.
 *
 * The tracker's time-based gates (jump window, occlusion bridge, flight
 * continuation) must behave by WALL CLOCK, not frame count, so an iPhone XR at
 * 8 fps sees the same ~167 ms flight-continuation window and ~0.5 s occlusion
 * bridge as a 30 fps phone. These tests sample the SAME continuous motion at
 * 8 / 12 / 15 / 24 / 30 fps and assert the wall-clock-invariant behaviour.
 *
 * Same constant-velocity Kalman fake as ballTracker.test.ts so the gating
 * logic is exercised independently of the real filter numerics.
 */
jest.mock(
  '../kalman',
  () => {
    class BallKalman {
      private s: { x: number; y: number; vx: number; vy: number } | null = null;
      private lastT = 0;
      constructor(_opts: { gravityPxPerSec2: number }) {}
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
        this.s = { x: s.x + s.vx * dt, y: s.y + s.vy * dt, vx: s.vx, vy: s.vy };
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
);

import { BallTracker } from '../ballTracker';
import { DETECTION, TRACKER } from '../config';
import type { Detection, FrameDetections } from '../types';

const FPS_RATES = [8, 12, 15, 24, 30] as const;

function ballDet(
  cx: number,
  cy: number,
  opts: { score?: number; w?: number; h?: number } = {},
): Detection {
  const w = opts.w ?? 30;
  const h = opts.h ?? 30;
  return {
    cls: 'ball',
    score: opts.score ?? 0.8,
    box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
  };
}

function frameAt(t: number, detections: Detection[]): FrameDetections {
  return { t, frameWidth: 640, frameHeight: 640, detections };
}

describe('BallTracker low-fps matrix', () => {
  describe('occlusion bridge lasts the same ~0.5 s of WALL CLOCK at every fps', () => {
    for (const fps of FPS_RATES) {
      test(`${fps}fps: last prediction is within maxPredictedSec of the last real detection`, () => {
        const tracker = new BallTracker({});
        const dt = 1 / fps;
        // Warm up a moving track (so predictions have velocity), then occlude.
        for (let i = 0; i < 4; i++) {
          tracker.step(frameAt(i * dt, [ballDet(200 + i * 5, 300)]), null);
        }
        const lastAcceptT = 3 * dt;
        let step = 4;
        let lastPredT = lastAcceptT;
        let predicted = 0;
        for (;;) {
          const out = tracker.step(frameAt(step * dt, []), null);
          if (out === null) break;
          expect(out.predicted).toBe(true);
          lastPredT = step * dt;
          predicted++;
          step++;
          expect(predicted).toBeLessThanOrEqual(TRACKER.maxPredictedFrames);
        }
        // The bridge spanned ~maxPredictedSec of wall clock regardless of fps:
        // the last kept prediction is inside the budget, and one more frame
        // would have exceeded it. (At 8 fps that is ~4 frames; at 30 fps ~15.)
        expect(lastPredT - lastAcceptT).toBeLessThanOrEqual(
          TRACKER.maxPredictedSec + 1e-9,
        );
        expect(lastPredT + dt - lastAcceptT).toBeGreaterThan(
          TRACKER.maxPredictedSec - 1e-9,
        );
      });
    }
  });

  describe('flight-continuation window is wall-clock: a low-score mid-flight ball is continued the same ~167 ms at every fps', () => {
    // A real mid-flight ball scores ~0.16 (between the tracking floor 0.12 and
    // the cold gate 0.2). It must be accepted while the track is fresh (within
    // jumpWindowSec of the last real accept) at every rate.
    const flightScore =
      (DETECTION.ballScoreMinTracking + DETECTION.ballScoreMin) / 2;
    for (const fps of FPS_RATES) {
      test(`${fps}fps: a 0.16 ball one frame after acquisition is continued`, () => {
        const tracker = new BallTracker({});
        const dt = 1 / fps;
        // Strong acquisitions.
        for (let i = 0; i < 3; i++) {
          tracker.step(frameAt(i * dt, [ballDet(100 + i * 4, 100)]), null);
        }
        // One frame later (well within jumpWindowSec at every fps ≤ 30) a faint
        // real detection near the prediction is accepted, not dropped.
        const out = tracker.step(
          frameAt(3 * dt, [ballDet(112, 100, { score: flightScore })]),
          null,
        );
        expect(out).not.toBeNull();
        expect(out!.predicted).toBe(false);
        expect(out!.cx).toBeCloseTo(112);
      });
    }
  });

  test('cold acquisition still needs the full 0.2 at low fps (noise cannot START a track)', () => {
    // The relaxed floor is for CONTINUING a fresh track; a cold low-score ball
    // is rejected at every rate. (fps-independent, but verified at 8 fps to be
    // sure the cadence machinery did not weaken cold acquisition.)
    const tracker = new BallTracker({});
    const faint = (DETECTION.ballScoreMinTracking + DETECTION.ballScoreMin) / 2;
    expect(
      tracker.step(frameAt(0, [ballDet(200, 200, { score: faint })]), null),
    ).toBeNull();
  });

  describe('jump gate releases after the same wall-clock window at every fps', () => {
    // After the track goes stale (no accepts for > jumpWindowSec) the jump gate
    // releases and a far detection re-acquires — at the same ~167 ms regardless
    // of fps. At 8 fps that is ~1–2 empty frames; at 30 fps ~5.
    for (const fps of FPS_RATES) {
      test(`${fps}fps: a far ball re-acquires once the window has elapsed`, () => {
        const tracker = new BallTracker({});
        const dt = 1 / fps;
        for (let i = 0; i < 3; i++) {
          tracker.step(frameAt(i * dt, [ballDet(100, 100)]), null);
        }
        const lastAcceptT = 2 * dt;
        // Step empty frames until strictly past the wall-clock window.
        let step = 3;
        while (step * dt - lastAcceptT <= TRACKER.jumpWindowSec + 1e-6) {
          tracker.step(frameAt(step * dt, []), null);
          step++;
        }
        // Now the gate is released: a far, strong detection re-acquires as real.
        const out = tracker.step(
          frameAt(step * dt, [ballDet(420, 420, { score: 0.95 })]),
          null,
        );
        expect(out).not.toBeNull();
        expect(out!.predicted).toBe(false);
        expect(out!.cx).toBeCloseTo(420);
      });
    }
  });
});
