/**
 * "Detected but untracked" repros — tracker-level tests for the acquisition
 * funnel telemetry, the persistence rescue of the raised-cold-gate band, and
 * the locality-prior aspect fix for cold motion-blur streaks.
 *
 * The scenario under test is the round-2 silent-death chain, step (1): the
 * debug overlay draws ball boxes at DETECTION.ballScoreMin (0.2) while a
 * per-model cold gate (nano-v2 via setColdGate = 0.35) refuses to START a
 * track from them — the ball is visibly "seen" but never tracked, and
 * nothing reported why. Every fix here is one-sided recall-up: it can only
 * ADD tracked balls, never suppress one, and the FSM judge path is untouched.
 *
 * `../kalman` is replaced by the same constant-velocity fake the sibling
 * ballTracker suite uses, so gating logic is exercised independently of the
 * real filter's numerics.
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
);

import { BallTracker } from '../ballTracker';
import { DETECTION, TRACKER } from '../config';
import type { Box, Detection, FrameDetections } from '../types';

const FPS = 30;
const DT = 1 / FPS;

/** Score inside the nano-v2 rescue band [ballScoreMin 0.2, coldGate 0.35). */
const BAND_SCORE =
  (DETECTION.ballScoreMin + DETECTION.ballScoreMinNanoV2) / 2; // 0.275

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

/** A tracker with the nano-v2 raised cold gate — the band is non-empty. */
function nanoV2Tracker(): BallTracker {
  const tracker = new BallTracker({});
  tracker.setColdGate(DETECTION.ballScoreMinNanoV2);
  return tracker;
}

describe('the repro: seen at 0.2+, never tracked under a raised cold gate', () => {
  test('with rescue OFF the banded ball dies silently forever — and telemetry says why', () => {
    const tracker = nanoV2Tracker();
    tracker.setRescue(false);
    for (let i = 0; i < 10; i++) {
      // A REAL moving ball the overlay would draw (score above 0.2)...
      const out = tracker.step(
        frameAt(i * DT, [ballDet(100 + 20 * i, 300, { score: BAND_SCORE })]),
        null,
      );
      // ...that the tracker never picks up: the historic silent death.
      expect(out).toBeNull();
      const stats = tracker.lastStepStats();
      expect(stats.ballDets).toBe(1);
      expect(stats.rejScore).toBe(1);
      expect(stats.lastReject).toBe('score');
      expect(stats.floor).toBeCloseTo(DETECTION.ballScoreMinNanoV2);
      expect(stats.accepted).toBe(false);
      expect(stats.rescued).toBe(false);
      expect(stats.gate).toBe('none');
    }
    expect(tracker.getHistory()).toHaveLength(0);
  });

  test('rescue (default ON) adopts after 3 coherent moving sightings', () => {
    const tracker = nanoV2Tracker();
    // Sightings 20 px apart (r=15 → step ≤ 3·30=90 px, net 40 ≥ 0.75·30=22.5).
    expect(
      tracker.step(frameAt(0, [ballDet(100, 300, { score: BAND_SCORE })]), null),
    ).toBeNull();
    expect(
      tracker.step(frameAt(DT, [ballDet(120, 300, { score: BAND_SCORE })]), null),
    ).toBeNull();
    const out = tracker.step(
      frameAt(2 * DT, [ballDet(140, 300, { score: BAND_SCORE })]),
      null,
    );
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(140);
    expect(out!.cy).toBeCloseTo(300);
    expect(out!.score).toBeCloseTo(BAND_SCORE);

    const stats = tracker.lastStepStats();
    expect(stats.rescued).toBe(true);
    expect(stats.accepted).toBe(true);
    expect(stats.gate).toBe('cold');
    // Honest accounting: the det DID fail the raised score gate first.
    expect(stats.rejScore).toBe(1);

    // The adopted track then CONTINUES at the tracking floor like any other.
    const next = tracker.step(
      frameAt(3 * DT, [ballDet(160, 300, { score: BAND_SCORE })]),
      null,
    );
    expect(next).not.toBeNull();
    expect(next!.predicted).toBe(false);
    const nextStats = tracker.lastStepStats();
    expect(nextStats.rescued).toBe(false);
    expect(nextStats.gate).toBe('tracking');
  });

  test('a STATIC banded phantom (light/rafter/background hoop) is never adopted', () => {
    const tracker = nanoV2Tracker();
    for (let i = 0; i < 15; i++) {
      const out = tracker.step(
        frameAt(i * DT, [ballDet(200, 200, { score: BAND_SCORE })]),
        null,
      );
      expect(out).toBeNull();
      expect(tracker.lastStepStats().rescued).toBe(false);
    }
  });

  test('slow drift below the net-travel floor is never adopted', () => {
    const tracker = nanoV2Tracker();
    // 5 px/frame: over the 4-slot buffer the net travel (15 px) stays under
    // 0.75 diameters (22.5 px) — a shimmering static-ish phantom.
    for (let i = 0; i < 15; i++) {
      const out = tracker.step(
        frameAt(i * DT, [ballDet(200 + 5 * i, 200, { score: BAND_SCORE })]),
        null,
      );
      expect(out).toBeNull();
    }
  });

  test('incoherent teleporting sightings reset the chain and never adopt', () => {
    const tracker = nanoV2Tracker();
    for (let i = 0; i < 12; i++) {
      const p = i % 2 === 0 ? { x: 100, y: 100 } : { x: 400, y: 400 };
      const out = tracker.step(
        frameAt(i * DT, [ballDet(p.x, p.y, { score: BAND_SCORE })]),
        null,
      );
      expect(out).toBeNull();
    }
  });

  test('sightings too sparse in time (outside rescueWindowSec) never adopt', () => {
    const tracker = nanoV2Tracker();
    const gap = TRACKER.rescueWindowSec - 0.05; // 0.2 s between sightings
    for (let i = 0; i < 10; i++) {
      const out = tracker.step(
        frameAt(i * gap, [ballDet(100 + 30 * i, 300, { score: BAND_SCORE })]),
        null,
      );
      // The prune keeps at most the previous sighting in the window, so the
      // chain never reaches rescueFrames.
      expect(out).toBeNull();
    }
  });

  test('below ballScoreMin is NOT in the band — no rescue however coherent', () => {
    const tracker = nanoV2Tracker();
    const under = DETECTION.ballScoreMin - 0.02;
    for (let i = 0; i < 10; i++) {
      expect(
        tracker.step(
          frameAt(i * DT, [ballDet(100 + 20 * i, 300, { score: under })]),
          null,
        ),
      ).toBeNull();
      expect(tracker.lastStepStats().rescued).toBe(false);
    }
  });

  test('at/above the raised floor the ball is accepted normally, not rescued', () => {
    const tracker = nanoV2Tracker();
    const out = tracker.step(
      frameAt(0, [ballDet(100, 300, { score: DETECTION.ballScoreMinNanoV2 })]),
      null,
    );
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    const stats = tracker.lastStepStats();
    expect(stats.rescued).toBe(false);
    expect(stats.gate).toBe('cold');
  });

  test('rescued dets must still pass the size cap (incl. session shrink)', () => {
    // 96 px box = 0.15 of the frame: under the config cap but over a 0.10
    // session cap — the rescue must honor the ACTIVE (shrunk) cap.
    const tracker = nanoV2Tracker();
    tracker.setSessionBallSizeCap(0.1);
    for (let i = 0; i < 10; i++) {
      expect(
        tracker.step(
          frameAt(i * DT, [
            ballDet(100 + 20 * i, 300, { score: BAND_SCORE, w: 96, h: 96 }),
          ]),
          null,
        ),
      ).toBeNull();
    }
  });

  test('rescued dets must still pass the aspect gate (elongated band boxes die)', () => {
    const tracker = nanoV2Tracker();
    for (let i = 0; i < 10; i++) {
      expect(
        tracker.step(
          frameAt(i * DT, [
            ballDet(100 + 20 * i, 300, { score: BAND_SCORE, w: 20, h: 60 }),
          ]),
          null,
        ),
      ).toBeNull();
    }
  });
});

describe('rescue is provably inert when the band is empty', () => {
  test('default model (coldFloor == ballScoreMin): banded scores do not exist', () => {
    const tracker = new BallTracker({});
    // 0.25 ≥ 0.2 is a plain cold acquisition on the default model.
    const out = tracker.step(
      frameAt(0, [ballDet(100, 300, { score: 0.25 })]),
      null,
    );
    expect(out).not.toBeNull();
    expect(tracker.lastStepStats().rescued).toBe(false);

    // Below 0.2 stays rejected with NO rescue accumulation, however coherent.
    const cold = new BallTracker({});
    for (let i = 0; i < 10; i++) {
      expect(
        cold.step(frameAt(i * DT, [ballDet(100 + 20 * i, 300, { score: 0.18 })]), null),
      ).toBeNull();
      expect(cold.lastStepStats().rescued).toBe(false);
    }
  });

  test('dark profile LOWERS the floor below ballScoreMin — band empty there too', () => {
    const tracker = new BallTracker({});
    tracker.setLightProfile('dark');
    // 0.17 ≥ dark floor 0.16: plain dark cold acquisition, no rescue path.
    const out = tracker.step(
      frameAt(0, [ballDet(100, 300, { score: 0.17 })]),
      null,
    );
    expect(out).not.toBeNull();
    expect(tracker.lastStepStats().rescued).toBe(false);

    // Under the dark floor: rejected, never rescued.
    const under = new BallTracker({});
    under.setLightProfile('dark');
    for (let i = 0; i < 10; i++) {
      expect(
        under.step(frameAt(i * DT, [ballDet(100 + 20 * i, 300, { score: 0.15 })]), null),
      ).toBeNull();
      expect(under.lastStepStats().rescued).toBe(false);
    }
  });

  test('setRescue(false) is a byte-identical escape hatch; re-enabling restores it', () => {
    const off = nanoV2Tracker();
    off.setRescue(false);
    for (let i = 0; i < 5; i++) {
      expect(
        off.step(frameAt(i * DT, [ballDet(100 + 20 * i, 300, { score: BAND_SCORE })]), null),
      ).toBeNull();
    }
    off.setRescue(true);
    // Chain restarts cleanly after re-enable (buffer was never fed while off).
    expect(
      off.step(frameAt(5 * DT, [ballDet(200, 300, { score: BAND_SCORE })]), null),
    ).toBeNull();
    expect(
      off.step(frameAt(6 * DT, [ballDet(220, 300, { score: BAND_SCORE })]), null),
    ).toBeNull();
    const out = off.step(
      frameAt(7 * DT, [ballDet(240, 300, { score: BAND_SCORE })]),
      null,
    );
    expect(out).not.toBeNull();
    expect(off.lastStepStats().rescued).toBe(true);
  });
});

describe('cold motion-blur streak with a locality prior (aspect fix)', () => {
  const corridor = { p: { x: 300, y: 300 }, tubeR: 40 };

  test('cold elongated box INSIDE the flight corridor is accepted', () => {
    const tracker = new BallTracker({});
    const streak = ballDet(300, 300, { w: 20, h: 80, score: 0.5 });
    const out = tracker.step(frameAt(0, [streak]), null, corridor);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
    expect(out!.cx).toBeCloseTo(300);
    expect(out!.cy).toBeCloseTo(300);
  });

  test('the same cold elongated box WITHOUT any prior stays rejected (legacy)', () => {
    const tracker = new BallTracker({});
    const streak = ballDet(300, 300, { w: 20, h: 80, score: 0.5 });
    expect(tracker.step(frameAt(0, [streak]), null)).toBeNull();
    const stats = tracker.lastStepStats();
    expect(stats.rejAspect).toBe(1);
    expect(stats.lastReject).toBe('aspect');
  });

  test('an elongated box FAR from the corridor is still rejected — bounded, not blanket', () => {
    const tracker = new BallTracker({});
    // High score passes the cold floor, but the box sits nowhere near the
    // corridor: no locality prior, so the cold aspect reject stands.
    const farStreak = ballDet(500, 100, { w: 20, h: 80, score: 0.9 });
    expect(tracker.step(frameAt(0, [farStreak]), null, corridor)).toBeNull();
    expect(tracker.lastStepStats().lastReject).toBe('aspect');
  });

  test('cold elongated box near the released wrist is accepted', () => {
    const tracker = new BallTracker({});
    tracker.setReleaseEvent(300, 300, 0);
    const streak = ballDet(310, 290, { w: 20, h: 80, score: 0.5 });
    const out = tracker.step(frameAt(DT, [streak]), null);
    expect(out).not.toBeNull();
    expect(out!.predicted).toBe(false);
  });
});

describe('per-step telemetry (lastStepStats)', () => {
  test('counts only ball-class dets and resets every step', () => {
    const tracker = new BallTracker({});
    const rim: Detection = {
      cls: 'rim',
      score: 0.9,
      box: { x: 100, y: 100, width: 60, height: 40 },
    };
    tracker.step(
      frameAt(0, [rim, ballDet(200, 200, { score: 0.05 }), ballDet(400, 400, { score: 0.1 })]),
      null,
    );
    let stats = tracker.lastStepStats();
    expect(stats.ballDets).toBe(2);
    expect(stats.rejScore).toBe(2);
    expect(stats.lastReject).toBe('score');

    // Next step: counters restart from zero.
    tracker.step(frameAt(DT, [rim]), null);
    stats = tracker.lastStepStats();
    expect(stats.ballDets).toBe(0);
    expect(stats.rejScore).toBe(0);
    expect(stats.lastReject).toBeNull();
  });

  test('reports the relaxation used by the accepted candidate', () => {
    // hoopRoi accept.
    const hoopRoi: Box = { x: 300, y: 100, width: 100, height: 100 };
    const roiTracker = new BallTracker({});
    const roiScore = (DETECTION.ballScoreMinHoopRoi + DETECTION.ballScoreMin) / 2;
    expect(
      roiTracker.step(frameAt(0, [ballDet(350, 150, { score: roiScore })]), hoopRoi),
    ).not.toBeNull();
    expect(roiTracker.lastStepStats().gate).toBe('hoopRoi');

    // cold accept.
    const coldTracker = new BallTracker({});
    expect(coldTracker.step(frameAt(0, [ballDet(100, 100)]), null)).not.toBeNull();
    expect(coldTracker.lastStepStats().gate).toBe('cold');

    // tracking (flight continuation) accept.
    const flightScore =
      (DETECTION.ballScoreMinTracking + DETECTION.ballScoreMin) / 2;
    expect(
      coldTracker.step(frameAt(DT, [ballDet(105, 95, { score: flightScore })]), null),
    ).not.toBeNull();
    expect(coldTracker.lastStepStats().gate).toBe('tracking');
  });

  test('size and jump rejections are attributed to their gates', () => {
    const tracker = new BallTracker({});
    // Giant round box: size reject.
    tracker.step(frameAt(0, [ballDet(320, 320, { score: 0.9, w: 600, h: 600 })]), null);
    let stats = tracker.lastStepStats();
    expect(stats.rejSize).toBe(1);
    expect(stats.lastReject).toBe('size');
    expect(stats.accepted).toBe(false);

    // Establish a track, then teleport: jump reject.
    tracker.step(frameAt(DT, [ballDet(100, 100)]), null);
    tracker.step(frameAt(2 * DT, [ballDet(102, 100)]), null);
    tracker.step(frameAt(3 * DT, [ballDet(500, 500, { score: 0.95 })]), null);
    stats = tracker.lastStepStats();
    expect(stats.rejJump).toBe(1);
    expect(stats.lastReject).toBe('jump');
  });

  test('lastStepStats returns a defensive copy', () => {
    const tracker = new BallTracker({});
    tracker.step(frameAt(0, [ballDet(100, 100)]), null);
    const a = tracker.lastStepStats();
    a.rejScore = 999;
    a.gate = 'none';
    const b = tracker.lastStepStats();
    expect(b.rejScore).toBe(0);
    expect(b.gate).toBe('cold');
  });

  test('floor reports the ACTIVE cold floor per profile/model', () => {
    const dark = new BallTracker({});
    dark.setLightProfile('dark');
    dark.step(frameAt(0, []), null);
    expect(dark.lastStepStats().floor).toBeCloseTo(DETECTION.ballScoreMinDark);

    const nano = nanoV2Tracker();
    nano.step(frameAt(0, []), null);
    expect(nano.lastStepStats().floor).toBeCloseTo(
      DETECTION.ballScoreMinNanoV2,
    );

    const dflt = new BallTracker({});
    dflt.step(frameAt(0, []), null);
    expect(dflt.lastStepStats().floor).toBeCloseTo(DETECTION.ballScoreMin);
  });
});
