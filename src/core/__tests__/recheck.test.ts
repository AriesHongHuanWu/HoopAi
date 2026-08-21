import { SHOT_FSM } from '../config';
import { depthRatioGate } from '../depthRatioGate';
import {
  RECHECK,
  medianRimBox,
  offlineMakeCorroborated,
  recheckShot,
  recheckShots,
  reconcileOutcome,
  sampleCameraTimes,
  type RecheckDeps,
  type RecheckShotRef,
} from '../recheck';
import type { Box, DetClass, Detection, ShotSignals } from '../types';

/**
 * Constructor opts of every replay ShotFsm recheckShot builds, plus every
 * ball size pushed into one. The spy SUBCLASSES the real FSM (requireActual),
 * so every other test in this file still runs the genuine state machine — this
 * only records what crosses the boundary, which is the one thing no fixture
 * can observe from the outside.
 */
const mockFsmOpts: Record<string, unknown>[] = [];
const mockFsmBallSizes: unknown[] = [];

jest.mock('../shotFsm', () => {
  const actual = jest.requireActual('../shotFsm');
  class SpyShotFsm extends actual.ShotFsm {
    constructor(rim: never, frame: never, opts: Record<string, unknown> = {}) {
      super(rim, frame, opts);
      mockFsmOpts.push(opts);
    }
    setBallSize(size: unknown): void {
      mockFsmBallSizes.push(size);
      super.setBallSize(size);
    }
  }
  return { ...actual, ShotFsm: SpyShotFsm };
});

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
/** A 'ball_in_basket' blip at the hoop — the cls half of the corroboration pair. */
const clsDet = (): Detection => det('ball_in_basket', 0.6, boxAround(320, 215, 20));

/**
 * Synthetic SWISH the live pass missed: a clean gravity parabola in VIDEO
 * time — y(τ) = 165 + 200·(τ − 1.9)² px (+y down) at constant x = 320 — that
 * rises through the up-zone, peaks above the rim plane (y 200) and drops
 * straight through the central span, vanishing into the net below y≈300.
 * The rim is visible every frame. No net-motion, no ball_in_basket — so the
 * offline verdict would rest on re-tracked GEOMETRY alone, which is exactly
 * what the replay is no longer allowed to convict on.
 */
function swishFrame(videoTimeSec: number): Detection[] {
  const dets: Detection[] = [rimDet()];
  const y = 165 + 200 * (videoTimeSec - 1.9) ** 2;
  if (videoTimeSec >= 0.4 && videoTimeSec <= 2.72 && y <= 600) {
    dets.push(ballDet(320, y));
  }
  return dets;
}

/** The same swish, CORROBORATED by a ball_in_basket blip at the hoop. */
function corroboratedSwishFrame(videoTimeSec: number): Detection[] {
  const dets = swishFrame(videoTimeSec);
  if (videoTimeSec >= 2.2 && videoTimeSec <= 2.9) dets.push(clsDet());
  return dets;
}

/**
 * The same swish, but the ball RENDERS BIG (40px across, not 24px) — the
 * presentation of a ball flying well IN FRONT of the hoop. That is exactly the
 * reading the depth-ratio veto exists to catch, and it is veto-bait ONLY if
 * the camera placement is one the gate is valid in. The offline pass cannot
 * know the placement, so it must not act on this. Still no net and no
 * ball_in_basket, so the honest offline answer is "no verdict".
 */
function frontHeavySwishFrame(videoTimeSec: number): Detection[] {
  const dets: Detection[] = [rimDet()];
  const y = 165 + 200 * (videoTimeSec - 1.9) ** 2;
  if (videoTimeSec >= 0.4 && videoTimeSec <= 2.72 && y <= 600) {
    dets.push(det('ball', 0.7, boxAround(320, y, 40)));
  }
  return dets;
}

/** The same parabola offset to x = 380 — outside the crossing span, a MISS. */
function missFrame(videoTimeSec: number): Detection[] {
  const dets: Detection[] = [rimDet()];
  const y = 165 + 200 * (videoTimeSec - 1.9) ** 2;
  if (videoTimeSec >= 0.4 && videoTimeSec <= 2.72 && y <= 600) {
    dets.push(ballDet(380, y));
  }
  return dets;
}

/**
 * TWO attempts inside one re-check window — the rebound/put-back case the
 * matching rule has to survive.
 *
 *  - Attempt A (video 0.0–1.8, x = 320, ball_in_basket firing): a corroborated
 *    MAKE that resolves at video 1.5, i.e. camera 101.5 — 2.0 s from the live
 *    tResolved of 103.5, and FIRST in sequence.
 *  - Attempt B (video 3.0–, x = 380): the shot actually under re-check. Crosses
 *    the plane outside the span, so it resolves MISS at video 4.333 — camera
 *    104.333, 0.833 s from the live tResolved.
 *
 * The two resolves are 2.8 s apart, comfortably clear of SHOT_FSM's own
 * shotCooldownSec, so both are genuine separate attempts.
 */
function twoAttemptsFrame(videoTimeSec: number): Detection[] {
  const dets: Detection[] = [rimDet()];
  if (videoTimeSec >= 0 && videoTimeSec <= 1.8) {
    const y = 165 + 400 * (videoTimeSec - 0.6) ** 2;
    if (y <= 600) dets.push(ballDet(320, y));
  }
  if (videoTimeSec >= 0.9 && videoTimeSec <= 1.8) dets.push(clsDet());
  if (videoTimeSec >= 3.0) {
    const y = 165 + 400 * (videoTimeSec - 3.5) ** 2;
    if (y <= 600) dets.push(ballDet(380, y));
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

function signals(over: Partial<ShotSignals> = {}): ShotSignals {
  return { geo: null, net: null, cls: null, ...over };
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
// offlineMakeCorroborated — a netless geo-only make is not evidence
// ---------------------------------------------------------------------------

describe('offlineMakeCorroborated', () => {
  it('refuses a make that rests on 2D geometry alone', () => {
    // The offline pass has no net channel at all, so this is the shape EVERY
    // geometry-only replay make arrives in: geo true, net null, cls false.
    expect(offlineMakeCorroborated(signals({ geo: true, net: null, cls: false }))).toBe(
      false,
    );
    expect(offlineMakeCorroborated(signals({ geo: true, net: null, cls: null }))).toBe(
      false,
    );
  });

  it('accepts a second channel — ball_in_basket or net motion', () => {
    expect(offlineMakeCorroborated(signals({ geo: true, net: null, cls: true }))).toBe(
      true,
    );
    expect(offlineMakeCorroborated(signals({ geo: true, net: true, cls: false }))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// RECHECK tunables
// ---------------------------------------------------------------------------

describe('RECHECK tunables', () => {
  // Iron rule for the matching window. At the old 2.0 the "same attempt"
  // tolerance was WIDER than the FSM's own minimum spacing between attempts,
  // so a rebound or put-back was inside the window BY CONSTRUCTION and could
  // supply the verdict for the shot next to it. Pinned as an inequality so the
  // two constants can never drift back past each other.
  it('the same-attempt tolerance stays inside the FSM shot cooldown', () => {
    expect(RECHECK.matchToleranceSec).toBeLessThan(SHOT_FSM.shotCooldownSec);
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
  beforeEach(() => {
    mockFsmOpts.length = 0;
    mockFsmBallSizes.length = 0;
  });

  // RE-PINNED (was: "upgrades an unsure shot to MAKE from a re-tracked swish
  // (geo alone, netless fusion)"). The replay sees 6 fps and has no net
  // channel; its "crossing pair" spans 167 ms. Calling a make off that is the
  // weakest reading in the system out-claiming the live pass, which declined to
  // decide with the full frame rate AND the net channel available. The evidence
  // is still recorded on the receipt — only the verdict is refused.
  it('refuses a MAKE that rests on re-tracked geometry alone', async () => {
    const { deps } = depsFor(swishFrame);
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.shotId).toBe(7);
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe('uncorroborated-make');
    // The receipt still carries WHAT the replay saw, so the refusal is legible.
    expect(result.signals).not.toBeNull();
    expect(result.signals!.geo).toBe(true);
    expect(result.signals!.net).toBeNull(); // no net channel offline
    expect(result.signals!.cls).toBe(false);
    expect(result.framesSampled).toBe(31);
  });

  it('upgrades to MAKE when ball_in_basket corroborates the geometry', async () => {
    const { deps } = depsFor(corroboratedSwishFrame);
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).toBe('make');
    expect(result.reason).toBeUndefined();
    expect(result.signals!.geo).toBe(true);
    expect(result.signals!.cls).toBe(true);
  });

  it('still upgrades a clean MISS (crossing outside the span)', async () => {
    // The refusal is one-directional: it guards the MAKE term only. An
    // observed descending crossing OUTSIDE the rim span is the same geometric
    // reading the live pass convicts a miss on.
    const { deps } = depsFor(missFrame);
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).toBe('miss');
    expect(result.signals!.geo).toBe(false);
  });

  // THE POINT OF THIS BLOCK. An earlier version of this test asserted the four
  // guard flags and stopped there, which is how a wrong verdict shipped: the
  // flags were right and the FSM was still judging on values nobody had given
  // it. Every test below pins what the replay DOES.

  it('never convicts an unsure shot as a MISS on an assumed camera placement', async () => {
    // The fixture really is veto-bait: under the 'side_wing' the FSM defaults
    // to, these exact pixels fire the depth gate. (If this assertion ever goes
    // stale the behavioural one underneath becomes vacuous, so it is pinned
    // here rather than assumed.)
    expect(
      depthRatioGate({
        ballDiaPxAvg: 40,
        nRealSamples: 5,
        rimWidthPx: RIM_BOX.width,
        rimLockContaminated: false,
        ballSize: 7,
        viewBand: 'side_wing',
        crossingReal: true,
        rimBounce: false,
        clsStrongContext: false,
      }).decision,
    ).toBe('veto_front');
    // The session never persisted its camera placement, so the replay has no
    // way to know whether the gate is valid here. A fired veto would flip geo
    // true->false and fuse() returns 'miss' on that first line — writing a
    // decided MISS into the user's history off an assumed tripod position.
    const { deps } = depsFor(frontHeavySwishFrame);
    const result = await recheckShot(UNSURE_SHOT, deps);
    expect(result.verdict).not.toBe('miss');
    // And it does not swing the other way either: with no net and no
    // ball_in_basket the geometry-only make is still refused, so the shot
    // simply keeps the unsure the live pass gave it.
    expect(result.verdict).toBeNull();
    expect(result.reason).toBe('uncorroborated-make');
  });

  it('replays the demote-or-corroborate guards, minus the unknowable one', async () => {
    // config.ts ships these constructor-default FALSE as the unit-test
    // baseline; shotPipeline.adoptRim turns them on from settingsStore.
    // Passing no opts here ran the offline pass on a MORE permissive FSM than
    // the live one — more confidence from less evidence. The three below are
    // demote-or-corroborate only, so enabling them can only make the replay
    // stricter. The depth veto is OFF because it is the one guard that needs a
    // camera placement the session did not persist; see recheck.ts for why an
    // assumed band is worse than no depth claim at all.
    const { deps } = depsFor(corroboratedSwishFrame);
    await recheckShot(UNSURE_SHOT, deps);
    expect(mockFsmOpts).toHaveLength(1);
    expect(mockFsmOpts[0]).toEqual({
      useDepthRatioVeto: false,
      useReappearance: true,
      useRattleGuard: true,
      useSettleWindow: true,
    });
  });

  it("hands the FSM the user's real ball size, not the size-7 default", async () => {
    // Ball diameter is the metric ruler for the reappearance guard's depth
    // check, which the replay DOES run. Assumed 7 applied a ~10% ratio error
    // to every size 5/6 player, offline, regardless of their setting.
    const { deps } = depsFor(corroboratedSwishFrame, { ballSize: 5 });
    await recheckShot(UNSURE_SHOT, deps);
    expect(mockFsmBallSizes).toEqual([5]);
  });

  it('leaves the FSM on its documented default when no ball size is given', async () => {
    const { deps } = depsFor(corroboratedSwishFrame);
    await recheckShot(UNSURE_SHOT, deps);
    expect(mockFsmBallSizes).toEqual([]);
  });

  it('feeds the injected detector VIDEO time (camera − recordingStartSec)', async () => {
    const { deps, calls } = depsFor(swishFrame);
    await recheckShot(UNSURE_SHOT, deps);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBeCloseTo(0.0, 6); // window start == recording start
    expect(Math.max(...calls)).toBeLessThanOrEqual(5.0 + 1e-6);
  });

  // RE-PINNED: the fixture now carries the ball_in_basket corroboration the
  // make gate requires, so this keeps testing the MEDIAN RIM BOX (its actual
  // subject) end-to-end instead of silently becoming a duplicate of the
  // geometry-only refusal above.
  it('survives rim jitter and a one-frame decoy via the median rim box', async () => {
    let frameNo = 0;
    const { deps } = depsFor((videoT) => {
      frameNo++;
      const jitter = frameNo % 2 === 0 ? 2 : -2;
      const rim =
        frameNo === 5
          ? rimDet({ x: 80, y: 480, width: 120, height: 90 }, 0.9) // decoy
          : rimDet({ ...RIM_BOX, x: RIM_BOX.x + jitter, y: RIM_BOX.y + jitter });
      const dets = corroboratedSwishFrame(videoT).filter((d) => d.cls !== 'rim');
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
    // live tResolved — the re-tracked resolve is ~0.7 s earlier, so no match.
    const { deps } = depsFor(corroboratedSwishFrame, { matchToleranceSec: 0.05 });
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

  describe('a neighbouring attempt cannot speak for this shot', () => {
    it('the default tolerance keeps the neighbour out of the window', async () => {
      // Attempt A (a corroborated make) resolves 2.0 s from the live
      // tResolved. The tolerance is now narrower than shotCooldownSec, so A is
      // simply not the same attempt and only B — the real one — is considered.
      const { deps } = depsFor(twoAttemptsFrame);
      const result = await recheckShot(UNSURE_SHOT, deps);
      expect(result.verdict).toBe('miss');
      expect(result.signals!.geo).toBe(false);
      expect(result.signals!.cls).toBe(false); // A's cls did not come along
    });

    it('the CLOSEST resolve wins, not the first one in sequence', async () => {
      // Widen the tolerance back to the old 2.0 so BOTH resolves are in the
      // window — the selection rule is what is under test here, and it has to
      // hold on its own. A fires first (2.0 s away, make + cls); B is the real
      // attempt (0.83 s away, miss). The old first-matching-resolve rule
      // handed this shot A's MAKE.
      const { deps } = depsFor(twoAttemptsFrame, { matchToleranceSec: 2.0 });
      const result = await recheckShot(UNSURE_SHOT, deps);
      expect(result.verdict).toBe('miss');
      expect(result.signals!.geo).toBe(false);
      expect(result.signals!.cls).toBe(false);
    });
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
    const { deps } = depsFor(corroboratedSwishFrame);
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

  it('an uncorroborated make counts as checked, never as corrected', async () => {
    const { deps } = depsFor(swishFrame);
    const summary = await recheckShots(TWO_SHOTS, deps);
    expect(summary.checked).toBe(2);
    expect(summary.corrected).toBe(0);
    expect(summary.results[0].reason).toBe('uncorroborated-make');
  });

  it('cancellation between shots keeps completed work and stops the rest', async () => {
    let cancelled = false;
    const { deps } = depsFor(corroboratedSwishFrame, { isCancelled: () => cancelled });
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
