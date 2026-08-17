/**
 * Make-preservation pins for the two stricter-make levers added in ed80a08
 * (useRattleGuard + useSettleWindow).
 *
 * WHY THIS SUITE EXISTS: both levers ship ON in the live app, and empirical
 * probes against the real ShotFsm proved they were eating GENUINE makes — the
 * exact "clean-exit-required" behaviour the commit message says was rejected
 * for that reason:
 *
 *  - The rattle-out guard's trigger was "the ball was seen deep AND
 *    geoExitObserved() is false". But the belowRim RESOLVE TRIGGER uses the
 *    same `cy > rim.belowY` threshold, so "seen deep" is true for essentially
 *    every shot that resolves on a real below-rim sample — collapsing the
 *    guard into "a make now REQUIRES a clean geometric exit". geoExitObserved
 *    compares only the IMMEDIATELY PRECEDING real sample for its descending
 *    test, so ONE non-monotone cy (net occlusion shifting the box centroid,
 *    motion blur, a re-acquired track) killed the make.
 *  - The settle window amplified it by appending ~4 post-drop frames — the
 *    noisiest boxes of the whole shot, the ball inside/behind the net — to the
 *    very trajectory the guard then judged.
 *  - settleReascended had no spatial gate, so a tracker switch to a blob
 *    anywhere in the upper frame read as a bounce-out.
 *  - The settle window could push the below-rim moment past maxLiveSec, and
 *    `reason === 'timeout'` is blanket-forced to 'unsure' — erasing a decision
 *    made with full evidence in hand.
 *
 * Every test here asserts a MAKE survives, or that a demotion still fires on
 * POSITIVE carom evidence. Nothing in this file asks for a new make term: the
 * scenarios that must still demote are pinned right next to the ones that must
 * not, so the fix can only be a narrowing.
 */
import { RIM } from '../config';
import { ShotFsm, caromOutObserved } from '../shotFsm';
import type {
  BallSample,
  Box,
  FsmFrameInput,
  ResolvedShot,
  RimGeometry,
  TrackedBall,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures & helpers (mirrors shotFsm.test.ts — same rim, same frame)
// ---------------------------------------------------------------------------

const FRAME = { width: 640, height: 640 };

/** Rim box: planeY=200, cx=320, span 304..336, belowY=230, hoopRoi 270..370 × 185..235. */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };

function rimFromBox(box: Box): RimGeometry {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const planeY = box.y;
  const halfSpan = (box.width * RIM.spanFraction) / 2;
  const upW = box.width * RIM.upZoneWidthFactor;
  const upH = box.height * RIM.upZoneHeightFactor;
  const roiW = box.width * RIM.hoopRoiFactor;
  const roiH = box.height * RIM.hoopRoiFactor;
  return {
    box,
    cx,
    cy,
    planeY,
    spanLeft: cx - halfSpan,
    spanRight: cx + halfSpan,
    belowY: box.y + box.height + RIM.belowMarginFactor * box.height,
    upZone: { x: cx - upW / 2, y: planeY - upH, width: upW, height: upH },
    hoopRoi: { x: cx - roiW / 2, y: cy - roiH / 2, width: roiW, height: roiH },
    netRoi: {
      x: box.x,
      y: box.y + box.height,
      width: box.width,
      height: box.height * RIM.netRoiHeightFactor,
    },
  };
}

const RIM_GEO = rimFromBox(RIM_BOX);

/** Both levers ON — the LIVE app configuration this suite defends. */
function liveFsm(): ShotFsm {
  return new ShotFsm(rimFromBox(RIM_BOX), FRAME, {
    useRattleGuard: true,
    useSettleWindow: true,
  });
}

/** Rattle-out guard only (settle window OFF). */
function guardOnlyFsm(): ShotFsm {
  return new ShotFsm(rimFromBox(RIM_BOX), FRAME, { useRattleGuard: true });
}

/** Both levers OFF — the conservative constructor baseline. */
function baselineFsm(): ShotFsm {
  return new ShotFsm(rimFromBox(RIM_BOX), FRAME);
}

function tb(
  cx: number,
  cy: number,
  t: number,
  vy: number,
  opts: Partial<TrackedBall> = {},
): TrackedBall {
  return { cx, cy, r: 10, t, score: 0.8, predicted: false, vx: 0, vy, ...opts };
}

function fin(
  t: number,
  ball: TrackedBall | null,
  opts: Partial<Omit<FsmFrameInput, 't' | 'ball'>> = {},
): FsmFrameInput {
  return { t, ball, ballInBasketScore: 0, netMotionScore: 0, personBox: null, ...opts };
}

function run(fsm: ShotFsm, frames: FsmFrameInput[]): ResolvedShot[] {
  const resolved: ResolvedShot[] = [];
  for (const f of frames) {
    const r = fsm.step(f);
    if (r.resolved) resolved.push(r.resolved);
  }
  return resolved;
}

/** [frameIdx, cx, cy, vy, netScore] rows at 30 fps. */
type Row = [number, number, number, number, number];

function frames30(rows: readonly Row[]): FsmFrameInput[] {
  return rows.map(([i, cx, cy, vy, net]) => {
    const t = i / 30;
    return fin(t, tb(cx, cy, t, vy), { netMotionScore: net });
  });
}

/** Plain trajectory sample for the direct caromOutObserved unit tests. */
function s(cx: number, cy: number, t: number, predicted = false): BallSample {
  return { cx, cy, r: 10, t, score: predicted ? 0 : 0.8, predicted };
}

// ---------------------------------------------------------------------------
// D1/D2 — the in-net centroid jitter that was eating swishes
// ---------------------------------------------------------------------------

/**
 * A GENUINE swish: real in-span crossing, net burst across it, then a deep
 * in-span drop — and ONE below-rim sample whose in-net centroid jitters UP 8px
 * (frame 8: cy 284 -> 276). That single non-monotone sample is the last deep
 * in-span sample, so geoExitObserved()'s "compare the immediately preceding
 * real sample" descending test reads false, and the old guard demoted the
 * make. Nothing here is a bounce-out: the ball never climbs back over the rim
 * plane (276 is well below planeY=200) and never leaves the span.
 */
const jitterSwish: readonly Row[] = [
  [0, 320, 180, -100, 0], // arm (jump: rising through the up-zone)
  [1, 320, 178, -50, 0], // apex
  [2, 320, 196, 200, 0.6], // descending toward the plane + net burst
  [3, 321, 210, 250, 0.6], // FINAL crossing (interp x≈320.3, in-span) + rim-band touch
  [4, 320, 236, 280, 0], // FIRST below belowY, in-span → settle window arms
  [5, 320, 252, 300, 0], // deeper, in-span
  [6, 321, 268, 320, 0], // deeper, in-span
  [7, 322, 284, 340, 0], // deeper, in-span
  [8, 322, 276, -20, 0], // in-net centroid jitter UP 8px → deferred resolve fires here
];

describe('make preservation — in-net centroid jitter (D1/D2)', () => {
  test('a genuine swish with ONE 8px in-net jitter is a MAKE with both levers ON', () => {
    const resolved = run(liveFsm(), frames30(jitterSwish));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    // The evidence is a textbook geo+net make…
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    expect(shot.signals.cls).toBe(false);
    // …and no lever may take it away: the jitter is not carom evidence.
    expect(shot.outcome).toBe('make');
    expect(shot.holds).toBeUndefined();
  });

  test('the same swish is a make with the levers OFF — the levers must not disagree with the baseline', () => {
    const resolved = run(baselineFsm(), frames30(jitterSwish));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe('make');
  });

  test('the rattle-out guard ALONE (no settle window) also keeps the jitter swish a make', () => {
    // Guard OFF settle window: the shot resolves on frame 4 (the first
    // below-rim sample), so the noisy post-drop frames never even exist. Pins
    // that the guard's trigger, not just the window, stopped being
    // "clean exit required".
    const resolved = run(guardOnlyFsm(), frames30(jitterSwish));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe('make');
  });
});

// ---------------------------------------------------------------------------
// The demotions that MUST survive — positive carom evidence
// ---------------------------------------------------------------------------

/**
 * A real carom-OUT: in-span crossing + net brush, then the ball drifts right
 * and its first deep (below belowY) sample sits at cx=360, OUTSIDE the span
 * (304..336). That is POSITIVE proof the ball left the rim cylinder instead of
 * passing through it.
 */
const caromRight: readonly Row[] = [
  [0, 320, 180, -100, 0], // arm (jump)
  [1, 320, 178, -50, 0], // apex
  [2, 320, 195, 200, 0], // descending toward the plane
  [3, 322, 205, 250, 0.6], // FINAL crossing (interp x=321, in-span) + net brush
  [4, 340, 222, 300, 0.6], // caroming right, still above belowY
  [5, 360, 240, 350, 0], // DEEP at cx=360 → out of span → carom proven
];

describe('carom-out demotions still fire (positive evidence only)', () => {
  test('out-of-span deep sample still demotes with the guard ON (settle window OFF)', () => {
    const resolved = run(guardOnlyFsm(), frames30(caromRight));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    expect(shot.outcome).toBe('unsure');
    expect(shot.holds).toContain('rattleOut');
  });

  test('out-of-span deep sample still demotes with BOTH levers ON (frozen prefix contains it)', () => {
    // The prefix frozen when the settle window arms ENDS on the first
    // below-rim sample — which is exactly the out-of-span one — so freezing
    // the exit evidence cannot hide a real carom.
    const f = frames30(caromRight);
    f.push(fin(6 / 30, null), fin(7 / 30, null), fin(8 / 30, null), fin(9 / 30, null));
    const resolved = run(liveFsm(), f);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe('unsure');
    expect(resolved[0].holds).toContain('rattleOut');
  });

  test('a real re-ascent above the rim plane AT THE HOOP still demotes (bounce-out)', () => {
    // Dips below the rim bottom in-span, then a real sample climbs back ABOVE
    // the plane at cx=318/cy=188 — inside the hoop ROI, where a physical
    // bounce-out has to be. Both the settle detector and the carom helper
    // read this as a carom.
    const bounceOut: readonly Row[] = [
      [0, 320, 180, -100, 0], // arm (jump)
      [1, 320, 178, -50, 0], // apex
      [2, 320, 196, 200, 0.6], // descending + net brush
      [3, 321, 210, 250, 0.6], // FINAL crossing in-span
      [4, 322, 236, 300, 0], // FIRST below belowY, in-span → window arms
      [5, 320, 214, -180, 0], // rising back, still below the plane
      [6, 318, 188, -160, 0], // RE-ASCENT above the plane, AT the hoop → bounce-out
    ];
    const f = frames30(bounceOut);
    f.push(fin(7 / 30, null), fin(8 / 30, null));
    const resolved = run(liveFsm(), f);
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    expect(shot.outcome).toBe('unsure');
    expect(shot.holds).toContain('settleReascend');
  });
});

// ---------------------------------------------------------------------------
// D3 — the far-away blob during the settle window
// ---------------------------------------------------------------------------

describe('make preservation — tracker switch during the settle window (D3)', () => {
  test('a far-away blob rising in the frame does NOT demote a genuine make', () => {
    // Identical swish to jitterSwish through frame 7, then the tracker switches
    // to a blob at cx=100/cy=150 — above the rim plane and rising, but nowhere
    // near the hoop. A physical bounce-out is AT the rim on the frame it
    // re-ascends, so this must not read as one.
    const blobSwitch: readonly Row[] = [
      [0, 320, 180, -100, 0], // arm (jump)
      [1, 320, 178, -50, 0], // apex
      [2, 320, 196, 200, 0.6], // descending + net burst
      [3, 321, 210, 250, 0.6], // FINAL crossing in-span
      [4, 320, 236, 280, 0], // FIRST below belowY, in-span → window arms
      [5, 320, 252, 300, 0], // deeper, in-span
      [6, 321, 268, 320, 0], // deeper, in-span
      [7, 322, 284, 340, 0], // deeper, in-span
      [8, 100, 150, -200, 0], // tracker switch: far-away blob, above the plane, rising
    ];
    const resolved = run(liveFsm(), frames30(blobSwitch));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    expect(shot.outcome).toBe('make');
    expect(shot.holds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D4 — the settle window colliding with maxLiveSec
// ---------------------------------------------------------------------------

/**
 * A long live attempt (stuck/occluded track hovering above the rim) whose
 * below-rim moment lands at t=3.9667 — inside settleWindowSec of
 * maxLiveSec (4.0). The deferred resolve therefore never gets to fire on its
 * own: the maxLiveSec force-resolve wins at t=4.0333. A below-rim resolve was
 * already pending with full evidence in hand, so the REASON must be
 * 'belowRim', not 'timeout' (which is blanket-forced to 'unsure').
 */
function maxLiveCollisionFrames(): FsmFrameInput[] {
  const out: FsmFrameInput[] = [fin(0, tb(320, 180, 0, -100))]; // arm (jump)
  for (let i = 1; i <= 116; i++) {
    const t = i / 30;
    out.push(fin(t, tb(320, 180, t, -100))); // held above the plane, never resolves
  }
  const tail: readonly Row[] = [
    [117, 320, 196, 200, 0.6], // descending toward the plane + net burst
    [118, 321, 210, 250, 0.6], // FINAL crossing in-span (rim-band touch)
    [119, 320, 236, 280, 0], // FIRST below belowY at t=3.9667 → window arms
    [120, 321, 252, 300, 0], // t=4.0 — window not elapsed, maxLiveSec not passed
    [121, 322, 268, 320, 0], // t=4.0333 — maxLiveSec force-resolve lands HERE
  ];
  out.push(...frames30(tail));
  return out;
}

describe('make preservation — settle window vs maxLiveSec (D4)', () => {
  test('a below-rim resolve pending at maxLiveSec resolves as belowRim → make, not timeout-unsure', () => {
    const resolved = run(liveFsm(), maxLiveCollisionFrames());
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.tResolved).toBeCloseTo(121 / 30, 6);
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    // The decision was made with the crossing, the net burst and the deep
    // in-span drop all observed — the clock running out must not erase it.
    expect(shot.outcome).toBe('make');
    expect(shot.holds).toBeUndefined();
  });

  test('a real timeout (no below-rim resolve pending) still forces unsure and tags it', () => {
    // Ball wedged above the rim for the whole window: it never drops past
    // belowY, so nothing is pending and the timeout demotion stands.
    const out: FsmFrameInput[] = [];
    for (let i = 0; i <= 130; i++) {
      const t = i / 30;
      out.push(fin(t, tb(320, 180, t, -100)));
    }
    const resolved = run(liveFsm(), out);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe('unsure');
    expect(resolved[0].holds).toContain('timeout');
  });
});

// ---------------------------------------------------------------------------
// F5 — no rim contact means nothing to wait for
// ---------------------------------------------------------------------------

describe('make preservation — settle window only arms after rim contact (F5)', () => {
  test('a swish that never touched the rim region resolves immediately (no settle latency)', () => {
    // 10 fps cadence: the ball jumps from well above the plane (cy=176) to well
    // below the rim bottom (cy=244) without ever sampling inside the rim band,
    // so touchedRim stays false. With no rim contact there is no bounce-out to
    // wait for — the shot must resolve on the below-rim frame itself (t=0.3),
    // saving 4 frames of make latency AND 4 frames of noise exposure.
    const rows: Array<[number, number, number, number, number]> = [
      [0.0, 320, 180, -100, 0], // arm (jump: rising in the up-zone)
      [0.1, 320, 168, -60, 0], // apex, clear of the rim band
      [0.2, 321, 176, 200, 0.6], // descending, clear of the rim band + net burst
      [0.3, 322, 244, 300, 0.6], // straight past belowY, in-span → resolve HERE
      [0.4, 323, 300, 320, 0], // trailing frames: only a deferred resolve would use them
      [0.5, 324, 340, 340, 0],
    ];
    const f = rows.map(([t, cx, cy, vy, net]) =>
      fin(t, tb(cx, cy, t, vy), { netMotionScore: net }),
    );
    const resolved = run(liveFsm(), f);
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.rimBounce).toBe(false);
    expect(shot.tResolved).toBeCloseTo(0.3, 6);
    expect(shot.signals.geo).toBe(true);
    expect(shot.signals.net).toBe(true);
    expect(shot.outcome).toBe('make');
  });
});

// ---------------------------------------------------------------------------
// caromOutObserved — the positive-evidence helper itself
// ---------------------------------------------------------------------------

describe('caromOutObserved', () => {
  // crossIdx is the index of the FIRST sample of the crossing pair, exactly as
  // resolve() computes it: traj[crossIdx].cy <= planeY < traj[crossIdx+1].cy.

  test('a monotone deep in-span drop is NOT carom evidence', () => {
    const traj = [
      s(320, 190, 0), // above the plane
      s(321, 215, 1 / 30), // crossing pair partner (crossIdx = 0)
      s(321, 240, 2 / 30), // deep, in-span
      s(322, 280, 3 / 30), // deeper, in-span
    ];
    expect(caromOutObserved(traj, RIM_GEO, 0)).toBe(false);
  });

  test('an in-net centroid jitter on the deep tail is NOT carom evidence', () => {
    // The exact D2 signature: a non-monotone cy inside the net. geoExitObserved
    // reads false here (its descending test looks only one real sample back) —
    // caromOutObserved must not inherit that false alarm.
    const traj = [
      s(320, 190, 0),
      s(321, 215, 1 / 30),
      s(321, 284, 2 / 30),
      s(322, 276, 3 / 30), // jittered UP 8px, still far below the plane
    ];
    expect(caromOutObserved(traj, RIM_GEO, 0)).toBe(false);
  });

  test('a deep sample OUTSIDE the span IS carom evidence', () => {
    const traj = [
      s(320, 190, 0),
      s(325, 215, 1 / 30),
      s(360, 240, 2 / 30), // deep at cx=360, out of span (304..336)
    ];
    expect(caromOutObserved(traj, RIM_GEO, 0)).toBe(true);
  });

  test('a re-ascent above the plane AFTER the deepest deep sample IS carom evidence', () => {
    const traj = [
      s(320, 190, 0),
      s(321, 215, 1 / 30),
      s(322, 240, 2 / 30), // deep, in-span
      s(320, 214, 3 / 30), // rising, still below the plane
      s(318, 188, 4 / 30), // back ABOVE the plane → bounce-out
    ];
    expect(caromOutObserved(traj, RIM_GEO, 0)).toBe(true);
  });

  test('PREDICTED samples can never prove a carom', () => {
    const traj = [
      s(320, 190, 0),
      s(325, 215, 1 / 30),
      s(360, 240, 2 / 30, true), // Kalman coast out of span — not evidence
      s(318, 188, 3 / 30, true), // Kalman coast above the plane — not evidence
    ];
    expect(caromOutObserved(traj, RIM_GEO, 0)).toBe(false);
  });

  test('PRE-crossing deep samples are ignored (the release-armed ball in the hands)', () => {
    // A release-armed attempt is seeded at the shooter's hands — far below
    // belowY and usually far outside the span. Scanning the whole trajectory
    // would read those as a carom and demote every genuine release-armed make.
    const traj = [
      s(178, 400, 0), // in the hands: deep AND out of span, pre-crossing
      s(200, 330, 1 / 30), // rising
      s(300, 190, 2 / 30), // above the plane
      s(320, 215, 3 / 30), // crossing pair partner (crossIdx = 2)
      s(322, 250, 4 / 30), // deep, in-span → a clean exit
    ];
    expect(caromOutObserved(traj, RIM_GEO, 2)).toBe(false);
  });

  test('no deep sample at all is NOT carom evidence (absence of an exit proves nothing)', () => {
    // THE D1 fix in one assertion: the ball vanished into the net above the rim
    // bottom. The old trigger treated the missing clean exit as carom evidence.
    const traj = [s(320, 190, 0), s(321, 215, 1 / 30), s(321, 222, 2 / 30)];
    expect(caromOutObserved(traj, RIM_GEO, 0)).toBe(false);
  });

  test('an empty or crossing-less trajectory is never carom evidence', () => {
    expect(caromOutObserved([], RIM_GEO, -1)).toBe(false);
    expect(caromOutObserved([s(320, 240, 0)], RIM_GEO, -1)).toBe(false);
  });
});
