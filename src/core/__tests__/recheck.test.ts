import {
  RECHECK,
  medianRimBox,
  recheckShot,
  recheckShots,
  reconcileOutcome,
  sampleCameraTimes,
  type RecheckDeps,
  type RecheckShotRef,
} from '../recheck';
import type { Box, DetClass, Detection } from '../types';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const FRAME_SIZE = 640;

/** Rim box: planeY=200, cx=320, span 294..346 (with buffer), belowY=230,
 *  upZone 240..400 × 160..200. Same shape the shotFsm tests use. */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };

/** Recording starts at engine-clock 100 s (videoTime = cameraT − 100). */
const REC_START = 100;

/** The unsure shot under re-check; window camera [100, 105] → video [0, 5]. */
const UNSURE_SHOT: RecheckShotRef = { shotId: 7, tResolved: 103.5, outcome: 'unsure' };

function boxAround(cx: number, cy: number, side: number): Box {
  return { x: cx - side / 2, y: cy - side / 2, width: side, height: side };
}

function det(cls: DetClass, score: number, box: Box): Detection {
  return { cls, score, box };
}

const rimDet = (box: Box = RIM_BOX, score = 0.8): Detection => det('rim', score, box);
const ballDet = (cx: number, cy: number): Detection =>
  det('ball', 0.7, boxAround(cx, cy, 24));

/**
 * Synthetic SWISH the live pass missed: a clean gravity parabola in VIDEO
 * time — y(τ) = 165 + 200·(τ − 1.9)² px (+y down) at constant x = 320 — that
 * rises through the up-zone, peaks above the rim plane (y 200) and drops
 * straight through the central span, vanishing into the net below y≈300.
 * The rim is visible every frame. No net-motion, no ball_in_basket — the
 * offline verdict must come from re-tracked GEOMETRY alone.
 */
function swishFrame(videoTimeSec: number): Detection[] {
  const dets: Detection[] = [rimDet()];
  const y = 165 + 200 * (videoTimeSec - 1.9) ** 2;
  if (videoTimeSec >= 0.4 && videoTimeSec <= 2.72 && y <= 600) {
    dets.push(ballDet(320, y));
  }
  return dets;
}

/** Wrap a scripted frame function into RecheckDeps, recording call times. */
function depsFor(
  stub: (videoTimeSec: number) => Detection[],
  overrides: Partial<RecheckDeps> = {},
): { deps: RecheckDeps; calls: number[] } {
  const calls: number[] = [];
  const deps: RecheckDeps = {
    detectFrame: (videoTimeSec: number) => {
      calls.push(videoTimeSec);
      return Promise.resolve(stub(videoTimeSec));
    },
    frameSize: FRAME_SIZE,
    recordingStartSec: REC_START,
    ...overrides,
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// reconcileOutcome — the conservative upgrade rule
// ---------------------------------------------------------------------------

describe('reconcileOutcome', () => {
  it('upgrades unsure to a decided offline outcome', () => {
    expect(reconcileOutcome('unsure', 'make')).toBe('make');
    expect(reconcileOutcome('unsure', 'miss')).toBe('miss');
  });

  it('keeps unsure when the offline pass is also unsure', () => {
    expect(reconcileOutcome('unsure', 'unsure')).toBeNull();
  });

  it('never flips an already-decided shot', () => {
    expect(reconcileOutcome('make', 'miss')).toBeNull();
    expect(reconcileOutcome('miss', 'make')).toBeNull();
    expect(reconcileOutcome('make', 'unsure')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// medianRimBox
// ---------------------------------------------------------------------------

describe('medianRimBox', () => {
  it('returns null for no boxes', () => {
    expect(medianRimBox([])).toBeNull();
  });

  it('returns the single box unchanged', () => {
    expect(medianRimBox([RIM_BOX])).toEqual(RIM_BOX);
  });

  it('takes the per-component median (odd count)', () => {
    const boxes: Box[] = [
      { x: 10, y: 20, width: 30, height: 40 },
      { x: 12, y: 18, width: 34, height: 44 },
      { x: 11, y: 19, width: 32, height: 42 },
    ];
    expect(medianRimBox(boxes)).toEqual({ x: 11, y: 19, width: 32, height: 42 });
  });

  it('averages the middle pair (even count)', () => {
    const boxes: Box[] = [
      { x: 10, y: 10, width: 10, height: 10 },
      { x: 20, y: 20, width: 20, height: 20 },
    ];
    expect(medianRimBox(boxes)).toEqual({ x: 15, y: 15, width: 15, height: 15 });
  });

  it('shrugs off a wild outlier', () => {
    const boxes: Box[] = [
      RIM_BOX,
      RIM_BOX,
      { x: 500, y: 500, width: 300, height: 300 },
      RIM_BOX,
      RIM_BOX,
    ];
    expect(medianRimBox(boxes)).toEqual(RIM_BOX);
  });
});

// ---------------------------------------------------------------------------
// sampleCameraTimes
// ---------------------------------------------------------------------------

describe('sampleCameraTimes', () => {
  const opts = {
    fps: RECHECK.fps,
    windowBeforeSec: RECHECK.windowBeforeSec,
    windowAfterSec: RECHECK.windowAfterSec,
  };

  it('spans [tResolved − 3.5, tResolved + 1.5] at ~6 fps', () => {
    const times = sampleCameraTimes(103.5, 100, opts);
    expect(times[0]).toBeCloseTo(100.0, 6);
    expect(times[times.length - 1]).toBeCloseTo(105.0, 6);
    expect(times.length).toBe(31); // 5 s × 6 fps + endpoint
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(1 / 6, 6);
    }
  });

  it('skips instants before the recording began', () => {
    // Window opens at camera 98.5, but the recording starts at 100.
    const times = sampleCameraTimes(102, 100, opts);
    expect(times.every((t) => t >= 100)).toBe(true);
    expect(times[times.length - 1]).toBeCloseTo(103.5, 6);
  });
});

// ---------------------------------------------------------------------------
// recheckShot — the offline second pass
// ---------------------------------------------------------------------------

describe('recheckShot', () => {
  it('upgrades an unsure shot to MAKE from a re-tracked swish (geo alone, netless fusion)', async () => {
    const { deps } = depsFor(swishFrame);
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.shotId).toBe(7);
    expect(result.verdict).toBe('make');
    expect(result.signals).not.toBeNull();
    expect(result.signals!.geo).toBe(true);
    expect(result.signals!.net).toBeNull(); // no net channel offline
    expect(result.reason).toBeUndefined();
    expect(result.framesSampled).toBe(31);
  });

  it('feeds the injected detector VIDEO time (camera − recordingStartSec)', async () => {
    const { deps, calls } = depsFor(swishFrame);
    await recheckShot(UNSURE_SHOT, deps);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBeCloseTo(0.0, 6); // window start == recording start
    expect(Math.max(...calls)).toBeLessThanOrEqual(5.0 + 1e-6);
  });

  it('survives rim jitter and a one-frame decoy via the median rim box', async () => {
    let frameNo = 0;
    const { deps } = depsFor((videoT) => {
      frameNo++;
      const jitter = frameNo % 2 === 0 ? 2 : -2;
      const rim =
        frameNo === 5
          ? rimDet({ x: 80, y: 480, width: 120, height: 90 }, 0.9) // decoy
          : rimDet({ ...RIM_BOX, x: RIM_BOX.x + jitter, y: RIM_BOX.y + jitter });
      const dets = swishFrame(videoT).filter((d) => d.cls !== 'rim');
      return [rim, ...dets];
    });
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).toBe('make');
  });

  it('keeps a shot unsure when no ball is ever re-detected', async () => {
    const { deps } = depsFor(() => [rimDet()]);
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe('no-resolve');
    expect(result.signals).toBeNull();
    expect(result.framesSampled).toBe(31);
  });

  it('skips the shot when the rim is never re-detected', async () => {
    // Ball flies, but with no rim there is no geometry to judge by.
    const { deps } = depsFor((videoT) =>
      swishFrame(videoT).filter((d) => d.cls !== 'rim'),
    );
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe('no-rim');
  });

  it('refuses to re-judge an already-decided shot without sampling a frame', async () => {
    const { deps, calls } = depsFor(swishFrame);
    const result = await recheckShot(
      { shotId: 3, tResolved: 103.5, outcome: 'make' },
      deps,
    );
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe('not-unsure');
    expect(calls.length).toBe(0);
  });

  it('ignores a resolve outside the ±match tolerance of the original', async () => {
    // Same swish, but demand the offline resolve land within 50 ms of the
    // live tResolved — the re-tracked resolve is ~0.7–1 s earlier, so no match.
    const { deps } = depsFor(swishFrame, { matchToleranceSec: 0.05 });
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe('no-resolve');
  });

  it('stops between frames when cancelled', async () => {
    let fetches = 0;
    const { deps } = depsFor(
      (videoT) => {
        fetches++;
        return swishFrame(videoT);
      },
      { isCancelled: () => fetches >= 4 },
    );
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe('cancelled');
    expect(result.framesSampled).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// recheckShots — sequential multi-shot run
// ---------------------------------------------------------------------------

describe('recheckShots', () => {
  /** Shot 1 replays the swish; shot 2's window (video 3.5–8.5) has no ball. */
  const TWO_SHOTS: RecheckShotRef[] = [
    UNSURE_SHOT,
    { shotId: 9, tResolved: 107, outcome: 'unsure' },
  ];

  it('walks shots in order with progress + per-result hooks', async () => {
    const { deps } = depsFor(swishFrame);
    const progress: [number, number][] = [];
    const resultIds: number[] = [];
    const summary = await recheckShots(TWO_SHOTS, deps, {
      onProgress: (index, total) => progress.push([index, total]),
      onResult: (r) => {
        resultIds.push(r.shotId);
      },
    });
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(resultIds).toEqual([7, 9]);
    expect(summary.checked).toBe(2);
    expect(summary.corrected).toBe(1); // swish upgraded, empty window kept unsure
    expect(summary.cancelled).toBe(false);
    expect(summary.results[0].verdict).toBe('make');
    expect(summary.results[1].verdict).toBeNull();
  });

  it('cancellation between shots keeps completed work and stops the rest', async () => {
    let cancelled = false;
    const { deps } = depsFor(swishFrame, { isCancelled: () => cancelled });
    const summary = await recheckShots(TWO_SHOTS, deps, {
      onResult: () => {
        cancelled = true; // flip right after the first shot lands
      },
    });
    expect(summary.results.length).toBe(1);
    expect(summary.results[0].verdict).toBe('make');
    expect(summary.checked).toBe(1);
    expect(summary.corrected).toBe(1);
    expect(summary.cancelled).toBe(true);
  });
});
