/**
 * FREE-FALL DRAG TEST — the prior art this project cited but never tried.
 *
 * Roboflow's 2025 "local AI basketball shot evaluator" write-up documents the
 * exact failure this app has: two shots that went in were recorded as misses
 * because the camera lost the ball right at the hoop. Their answer needs ZERO
 * detections at the rim — read the ball only after it REAPPEARS below, and ask
 * whether it is falling as fast as free fall alone would have made it fall
 * over the occlusion gap. A ball that lost no energy touched nothing.
 *
 * This suite pins three things:
 *   1. The pure physics ({@link dragRatio}) across all four verdicts, with
 *      every expected value computed on paper from the fixture constants so
 *      the assertions cannot be satisfied by the implementation restating
 *      itself.
 *   2. The REFUSALS. 'unknown' is the honest answer far more often than any
 *      verdict is, and the fps arithmetic behind that is asserted, not
 *      asserted-away.
 *   3. BREAD-BALL (INVIOLABLE RULE #1) end to end through the real ShotFsm:
 *      the drag test can only ever REMOVE make evidence. It never mints a
 *      make on its own and never flips a seen geo === false.
 */
import { REAPPEAR, RIM, SHOT_FSM } from '../config';
import { dragRatio } from '../reappearance';
import { ShotFsm } from '../shotFsm';
import type {
  Box,
  FsmFrameInput,
  ResolvedShot,
  RimGeometry,
  TrackedBall,
} from '../types';

// ===========================================================================
// PART 1 — the pure physics
// ===========================================================================

/**
 * Reference framing, chosen to be ordinary rather than convenient: a 60 px
 * rim (a phone on a tripod at a normal distance) and a 4 m/s entry (a shot
 * with a decent arc). Every number below follows from these four lines.
 *
 *   pxPerM   = 60 / 0.45                 = 133.3333 px/m
 *   g        = 9.81 * 133.3333           = 1308.0   px/s²
 *   vyEntry  = 4 m/s * 133.3333          =  533.333 px/s
 *   expected = 533.333 + 1308.0 * 0.25   =  860.333 px/s
 */
const PX_PER_M = 60 / 0.45;
const G = 9.81 * PX_PER_M;
const VY_ENTRY = 4 * PX_PER_M;
const GAP = 0.25;
const EXPECTED = VY_ENTRY + G * GAP;

/** Run the test at the reference framing with a chosen measured speed. */
const at = (vyMeasuredPxPerSec: number, gapSec = GAP) =>
  dragRatio({
    vyEntryPxPerSec: VY_ENTRY,
    gapSec,
    vyMeasuredPxPerSec,
    gravityPxPerSec2: G,
  });

describe('dragRatio — the fixture arithmetic itself', () => {
  test('the reference framing is what the docblock says it is', () => {
    // If this drifts, every hand-computed expectation below drifts with it,
    // so it is pinned first and separately.
    expect(PX_PER_M).toBeCloseTo(133.3333, 3);
    expect(G).toBeCloseTo(1308.0, 1);
    expect(VY_ENTRY).toBeCloseTo(533.3333, 3);
    expect(EXPECTED).toBeCloseTo(860.3333, 3);
  });
});

describe('dragRatio — the three physics bands', () => {
  test("~100% of free fall ⇒ 'untouched': nothing bled energy off it", () => {
    // Falling at exactly the speed free fall would have produced means the
    // ball crossed the whole occlusion in clean air: in front of / behind the
    // hoop, or a clean miss. It did NOT pass through a net.
    const r = at(860.3333);
    expect(r.ratio).toBeCloseTo(1.0, 4);
    expect(r.verdict).toBe('untouched');
  });

  test("10–90% of free fall ⇒ 'through': something braked it", () => {
    // Half speed: 430.1667 / 860.3333 = 0.5. A ball cannot lose half its
    // downward momentum in mid-air, so something took it — net and/or rim.
    const half = at(EXPECTED / 2);
    expect(half.ratio).toBeCloseTo(0.5, 6);
    expect(half.verdict).toBe('through');

    // A gentler, more realistic net brake: 1 m/s off a 6.45 m/s expected
    // speed. 860.3333 − 133.3333 = 727.0 px/s ⇒ 0.845.
    const gentle = at(EXPECTED - PX_PER_M);
    expect(gentle.ratio).toBeCloseTo(0.845, 3);
    expect(gentle.verdict).toBe('through');
  });

  test("~0% or negative ⇒ 'reject': this is not the same ball", () => {
    // Barely moving — a ball sitting on the floor in frame, or a tracker
    // switch onto a stationary object. 43.0167 / 860.3333 = 0.05.
    const still = at(EXPECTED * 0.05);
    expect(still.ratio).toBeCloseTo(0.05, 6);
    expect(still.verdict).toBe('reject');

    // Travelling UPWARD: a rebound already on its way back up.
    const rising = at(-400);
    expect(rising.ratio).toBeCloseTo(-400 / 860.3333, 4);
    expect(rising.verdict).toBe('reject');
  });

  test('band edges land where config says, to the pixel', () => {
    // 0.90 · 860.3333 = 774.30 px/s — the last speed still called 'through'.
    expect(at(REAPPEAR.dragThroughMax * EXPECTED).verdict).toBe('through');
    expect(at(REAPPEAR.dragThroughMax * EXPECTED + 1).verdict).toBe('untouched');
    // 0.10 · 860.3333 = 86.03 px/s — the slowest still called 'through'.
    expect(at(REAPPEAR.dragRejectMax * EXPECTED).verdict).toBe('through');
    expect(at(REAPPEAR.dragRejectMax * EXPECTED - 1).verdict).toBe('reject');
  });
});

describe('dragRatio — the refusals (never a guess)', () => {
  test('gap too short ⇒ unknown, but the ratio is still reported', () => {
    // Same physics, a 0.15 s gap. Under REAPPEAR.dragMinGapSec the free-fall
    // increment g·gap does not stand clear of pixel noise, so the bands mean
    // nothing — but telemetry still gets the number so they can be re-fit.
    const r = at(400, 0.15);
    expect(r.verdict).toBe('unknown');
    expect(Number.isFinite(r.ratio)).toBe(true);
    // Sanity: with a long-enough gap the SAME kind of measurement is answerable.
    expect(at(400, 0.35).verdict).not.toBe('unknown');
  });

  test('THE FPS STORY: 3 occluded frames answers at 15 fps, refuses at 30', () => {
    // This is the whole honest limitation in one assertion. A rim occlusion is
    // typically 3–6 frames. Three frames is 0.100 s at 30 fps and 0.200 s at
    // 15 fps — and only the second clears REAPPEAR.dragMinGapSec, whose value
    // is derived from requiring g·gap ≥ 3σ_v (see the arithmetic in config).
    // So on a 30 fps device this technique refuses to answer most occlusions.
    // That refusal is the feature working correctly, not failing.
    expect(3 / 30).toBeLessThan(REAPPEAR.dragMinGapSec);
    expect(3 / 15).toBeGreaterThanOrEqual(REAPPEAR.dragMinGapSec);
    expect(at(EXPECTED, 3 / 30).verdict).toBe('unknown');
    expect(at(EXPECTED, 3 / 15).verdict).toBe('untouched');
  });

  test('expected speed near zero ⇒ unknown (the denominator collapses)', () => {
    // The ball was still RISING hard when it was lost, so vyEntry + g·gap is
    // small and pixel noise swamps the ratio. Floor is scale-free: expected
    // must be at least dragMinExpectedFreeFallSec of free fall.
    const barely = G * REAPPEAR.dragMinExpectedFreeFallSec;
    const rising = dragRatio({
      vyEntryPxPerSec: barely - G * GAP - 1, // expected = barely − 1
      gapSec: GAP,
      vyMeasuredPxPerSec: 100,
      gravityPxPerSec2: G,
    });
    expect(rising.verdict).toBe('unknown');
    expect(Number.isNaN(rising.ratio)).toBe(true);
    // One px/s more and the floor is cleared.
    const ok = dragRatio({
      vyEntryPxPerSec: barely - G * GAP + 1,
      gapSec: GAP,
      vyMeasuredPxPerSec: 100,
      gravityPxPerSec2: G,
    });
    expect(Number.isFinite(ok.ratio)).toBe(true);
  });

  test('faster than free fall ⇒ unknown, NOT a confident untouched', () => {
    // Nothing accelerates a falling ball beyond g, so a reading well above 1
    // is a broken measurement. Labelling it 'untouched' would be a confident
    // verdict on garbage; refusing is the honest move. Noise just above 1 is
    // still 'untouched' — that is what the band up to dragImpossibleMin is for.
    expect(at(EXPECTED * 1.1).verdict).toBe('untouched');
    expect(at(EXPECTED * REAPPEAR.dragImpossibleMin).verdict).toBe('unknown');
    expect(at(EXPECTED * 3).verdict).toBe('unknown');
  });

  test('unusable inputs ⇒ unknown with a NaN ratio, never a verdict', () => {
    const bad = [
      { vyEntryPxPerSec: NaN, gapSec: GAP, vyMeasuredPxPerSec: 500, gravityPxPerSec2: G },
      { vyEntryPxPerSec: VY_ENTRY, gapSec: NaN, vyMeasuredPxPerSec: 500, gravityPxPerSec2: G },
      { vyEntryPxPerSec: VY_ENTRY, gapSec: GAP, vyMeasuredPxPerSec: NaN, gravityPxPerSec2: G },
      { vyEntryPxPerSec: VY_ENTRY, gapSec: GAP, vyMeasuredPxPerSec: 500, gravityPxPerSec2: NaN },
      { vyEntryPxPerSec: VY_ENTRY, gapSec: GAP, vyMeasuredPxPerSec: 500, gravityPxPerSec2: 0 },
      { vyEntryPxPerSec: VY_ENTRY, gapSec: GAP, vyMeasuredPxPerSec: 500, gravityPxPerSec2: -G },
      { vyEntryPxPerSec: VY_ENTRY, gapSec: 0, vyMeasuredPxPerSec: 500, gravityPxPerSec2: G },
      { vyEntryPxPerSec: VY_ENTRY, gapSec: -0.3, vyMeasuredPxPerSec: 500, gravityPxPerSec2: G },
      {
        vyEntryPxPerSec: VY_ENTRY,
        gapSec: GAP,
        vyMeasuredPxPerSec: Infinity,
        gravityPxPerSec2: G,
      },
    ];
    for (const input of bad) {
      const r = dragRatio(input);
      expect(r.verdict).toBe('unknown');
      expect(Number.isNaN(r.ratio)).toBe(true);
    }
  });

  test('pure and deterministic: same inputs, same answer, no state', () => {
    const first = at(500);
    at(860.3333); // an intervening call with different inputs
    at(-1);
    expect(at(500)).toEqual(first);
  });
});

// ===========================================================================
// PART 2 — bread-ball, end to end through the real ShotFsm
// ===========================================================================

const FRAME = { width: 640, height: 640 };
/** Same rim as the other FSM suites: planeY=200, span 304..336, belowY=230. */
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

/**
 * The flight, in the SAME coherent camera the drag test will assume:
 *
 *   rim width 40 px  ⇒  pxPerM = 40/0.45 = 88.889  ⇒  g = 872.0 px/s²
 *   y(t) = 195 − 350·t + 436·t²      (2·ya = 872, so the arc's own curvature
 *                                     agrees with the rim exactly — otherwise
 *                                     REAPPEAR.dragGravityAgreeFrac refuses)
 *
 * A REAL shot, not a token one: the ball arms rising through the up-zone at
 * (320, 195), peaks at y ≈ 124.8 (75 px above the rim plane), and descends
 * through y = 200 at t = 0.816792 s doing 362 px/s ≈ 4.1 m/s — the entry speed
 * of an ordinary jump shot. The earlier flat fixture entered at only 3.0 m/s
 * and was refused by REAPPEAR.dragMinExpectedFreeFallSec, which is the floor
 * working as designed.
 */
const G_FSM = 9.81 * (40 / 0.45);
const yFree = (t: number): number => 195 - 350 * t + 0.5 * G_FSM * t * t;
const vyFree = (t: number): number => -350 + G_FSM * t;
const T_CROSS = (350 + Math.sqrt(350 * 350 + 2 * G_FSM * 5)) / G_FSM;

/**
 * Vertical speed the net strips at the crossing, px/s. 120 px/s at this
 * fixture's 88.9 px/m scale is ~1.35 m/s off a 4.4 m/s expected speed, which
 * lands the ratio at 0.693 — mid-band, hugging neither edge. ⚠ A GUESS: see
 * REAPPEAR.drag* for the standing warning that nobody has measured this.
 */
const NET_BRAKE = 120;

/** y(t) with `brake` px/s removed at the crossing instant. */
function yBraked(t: number, brake: number): number {
  if (t <= T_CROSS) return yFree(t);
  const dt = t - T_CROSS;
  return yFree(T_CROSS) + (vyFree(T_CROSS) - brake) * dt + 0.5 * G_FSM * dt * dt;
}

function tb(
  cx: number,
  cy: number,
  t: number,
  vy: number,
  predicted = false,
): TrackedBall {
  return { cx, cy, r: 10, t, score: predicted ? 0 : 0.8, predicted, vx: 0, vy };
}

function fin(
  t: number,
  ball: TrackedBall | null,
  netMotionScore = 0,
): FsmFrameInput {
  return { t, ball, ballInBasketScore: 0, netMotionScore, personBox: null };
}

function run(fsm: ShotFsm, frames: FsmFrameInput[]): ResolvedShot[] {
  const out: ResolvedShot[] = [];
  for (const f of frames) {
    const r = fsm.step(f);
    if (r.resolved) out.push(r.resolved);
  }
  return out;
}

/**
 * One occluded shot at 30 fps — the shape this whole technique exists for.
 *
 *   frames 0–17   REAL, rising through the up-zone, over the apex, back down
 *                 to y ≈ 137. This is the pre-gap arc the trap fits.
 *   frames 18–24  PREDICTED — the tracker coasting through the rim occlusion
 *                 (0.233 s, an ordinary net/rim dropout). The crossing at
 *                 t = 0.8168 s happens INSIDE this gap, which is exactly why
 *                 geo is `null`: a Kalman coast is not a sighting.
 *   frames 25+    REAL again, below the plane at cx = `belowCx`.
 *
 * `brake` selects the physics of the reappearance and NOTHING else: every gate
 * the reappearance corroborator already had (y-residual, below-plane,
 * descending, widened span, depth) passes identically either way. The braked
 * ball's largest y-residual before the trap fires is 6 px against a 40 px
 * allowance, so the pre-existing gates genuinely cannot separate these two.
 */
function occludedShot(brake: number, belowCx: number, net: number): FsmFrameInput[] {
  const frames: FsmFrameInput[] = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    const predicted = i >= 18 && i <= 24;
    // x drifts from the shot line to the deflected exit across the occlusion.
    const cx =
      i <= 17 ? 320 : i >= 25 ? belowCx : 320 + ((belowCx - 320) * (i - 17)) / 8;
    const vy = vyFree(t) - (t > T_CROSS ? brake : 0);
    frames.push(fin(t, tb(cx, yBraked(t, brake), t, vy, predicted), net));
  }
  return frames;
}

/**
 * cx for the below-rim samples: 339 px. INSIDE the reappearance's widened span
 * (304..336 widened 15% per side ⇒ 299.2..340.8, the net-deflection allowance)
 * but OUTSIDE the raw span, which keeps geoExitObserved — an INDEPENDENT
 * corroborator the drag veto deliberately does not touch — from upgrading geo
 * on its own and masking what these tests are measuring.
 */
const DEFLECTED_CX = 339;

function reappFsm(): ShotFsm {
  // dragVetoEnabled is passed EXPLICITLY: the veto ships OFF (see the WHY on
  // REAPPEAR.dragVetoEnabled), so these tests exercise the MECHANISM rather
  // than the shipped default. The shipped default is pinned separately below.
  return new ShotFsm(rimFromBox(RIM_BOX), FRAME, {
    useReappearance: true,
    dragVetoEnabled: true,
  });
}

describe('free-fall drag test — end to end through ShotFsm', () => {
  test('CONTROL: a net-braked reappearance + net motion still resolves MAKE', () => {
    // The pre-existing behaviour, unchanged. Without this control the veto
    // test below would pass just as well if the feature had broken the
    // corroborator outright.
    const resolved = run(reappFsm(), occludedShot(NET_BRAKE, DEFLECTED_CX, 0.6));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.reappDrag?.verdict).toBe('through');
    expect(shot.signals.net).toBe(true);
    expect(shot.signals.geo).toBe(true); // corroborator upgraded null -> true
    expect(shot.outcome).toBe('make');
    expect(shot.holds ?? []).not.toContain('reappDragVeto');
  });

  test('THE VETO: the SAME shot falling at 100% of free fall is not a make', () => {
    // Identical geometry, identical net burst, identical detections — the only
    // difference is that this ball lost no speed, so nothing touched it, so it
    // did not go through the net. Every pre-existing gate passes it; only the
    // physics separates the two. This is the whole feature.
    const resolved = run(reappFsm(), occludedShot(0, DEFLECTED_CX, 0.6));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.reappDrag?.verdict).toBe('untouched');
    expect(shot.reappDrag?.ratio).toBeCloseTo(1.0, 2);
    expect(shot.signals.net).toBe(true); // the net channel still says "burst"
    expect(shot.signals.geo).toBeNull(); // …but the upgrade was suppressed
    expect(shot.outcome).not.toBe('make');
    // Auditable from a real session rather than invisible.
    expect(shot.holds).toContain('reappDragVeto');
  });

  test('the veto is a SUPPRESSION: it never manufactures a miss', () => {
    // The safe failure direction. A vetoed shot loses its make term and lands
    // on 'unsure' — it is never converted into a decided miss, because "we
    // proved it did not swish" is not "we proved it missed" (it could have
    // rolled in off the rim through a gap we never measured).
    const shot = run(reappFsm(), occludedShot(0, DEFLECTED_CX, 0.6))[0];
    expect(shot.outcome).toBe('unsure');
    expect(shot.signals.geo).not.toBe(false);
  });

  test('BREAD-BALL: a through-verdict alone NEVER mints a make', () => {
    // Same braked (genuinely made-looking) shot, but with the net channel
    // silent and no ball_in_basket. The drag test says 'through' — and that
    // buys exactly nothing, because 'through' is not evidence, it is only the
    // absence of a veto. The corroborator contract (net === true, or
    // net === null && cls) is untouched by this feature.
    const resolved = run(reappFsm(), occludedShot(NET_BRAKE, DEFLECTED_CX, 0));
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.reappDrag?.verdict).toBe('through');
    expect(shot.signals.net).toBeNull(); // no net motion was ever observed
    expect(shot.signals.cls).toBe(false);
    expect(shot.signals.geo).toBeNull(); // NOT upgraded
    expect(shot.outcome).not.toBe('make');
  });

  test('BREAD-BALL: a corroborating reappearance never flips a SEEN geo === false', () => {
    // An OBSERVED out-of-span crossing (both samples real) is a seen miss and
    // outranks every corroborator. Here the ball is watched all the way
    // through the plane at cx = 350 — outside the span 304..336 — then drops
    // out for a frame and reappears below, braked, inside the widened span.
    // The reappearance trap arms and CORROBORATES; the shot is still a miss,
    // because the corroborator branch is gated on `geo == null` and this
    // feature did not touch that gate.
    //
    // HONEST NOTE ON WHAT THIS CAN AND CANNOT PIN: once the crossing is
    // OBSERVED, the ball reaches belowY (30 px under the plane) within ~3
    // frames and the FSM resolves there — so the occlusion gap available after
    // an observed crossing is structurally shorter than
    // REAPPEAR.dragMinGapSec, and the drag verdict here is necessarily
    // 'unknown'. A 'through' verdict COEXISTING with a seen geo === false is
    // not reachable in this codebase's geometry, which is itself part of why
    // the corroborator contract is safe: the drag test only ever has anything
    // to say about crossings nobody saw.
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i <= 28; i++) {
      const t = i / 30;
      // Real through the crossing (0–25, pair 24/25 straddles y=200),
      // one occluded frame (26), real below (27–28).
      const predicted = i === 26;
      const cx = i <= 25 ? 350 : DEFLECTED_CX;
      const vy = vyFree(t) - (t > T_CROSS ? NET_BRAKE : 0);
      frames.push(fin(t, tb(cx, yBraked(t, NET_BRAKE), t, vy, predicted), 0.6));
    }
    const resolved = run(reappFsm(), frames);
    expect(resolved).toHaveLength(1);
    const shot = resolved[0];
    expect(shot.signals.geo).toBe(false); // seen, out of span
    expect(shot.outcome).toBe('miss');
    // The trap really did fire and really did measure — it just had nothing
    // to add, and could not have added it if it had.
    expect(shot.reappDrag).toBeDefined();
    expect(shot.reappDrag!.verdict).toBe('unknown');
    expect(shot.reappDrag!.gapSec).toBeLessThan(REAPPEAR.dragMinGapSec);
  });

  test('diagnostics carry every input, not just the answer', () => {
    // The bands are unvalidated guesses; re-fitting them from real sessions
    // needs the raw numbers, so the whole reading rides on the resolved shot.
    const shot = run(reappFsm(), occludedShot(NET_BRAKE, DEFLECTED_CX, 0.6))[0];
    const d = shot.reappDrag;
    expect(d).toBeDefined();
    // g from the LOCKED RIM: 9.81 · 40/0.45 = 872.0 px/s².
    expect(d!.gravityPxPerSec2).toBeCloseTo(872.0, 1);
    // Last real pre-gap sample is frame 17 (t = 17/30 = 0.566667 s):
    //   vyEntry = −350 + 872·0.566667 = 144.133 px/s
    expect(d!.vyEntryPxPerSec).toBeCloseTo(144.133, 2);
    // Measurement epoch is the midpoint of frames 25 and 26 = 0.850000 s,
    //   gap      = 0.850000 − 0.566667 = 0.283333 s
    //   expected = 144.133 + 872·0.283333 = 391.200 px/s
    expect(d!.gapSec).toBeCloseTo(0.283333, 5);
    expect(d!.expectedPxPerSec).toBeCloseTo(391.2, 2);
    // Braking by NET_BRAKE (120) ⇒ 271.200 px/s ⇒ ratio 0.6933.
    expect(d!.vyMeasuredPxPerSec).toBeCloseTo(391.2 - NET_BRAKE, 2);
    expect(d!.ratio).toBeCloseTo((391.2 - NET_BRAKE) / 391.2, 4);
    expect(d!.refusal).toBeUndefined();
  });

  test('inert when the reappearance corroborator is off', () => {
    // The drag test lives inside the reappearance trap, which is opt-in
    // (SHOT_FSM.useReappearance is false at the constructor baseline that
    // offline recheck replays against). With the flag off, nothing is measured
    // and nothing is reported — the resolve path is untouched.
    expect(SHOT_FSM.useReappearance).toBe(false);
    const baseline = new ShotFsm(rimFromBox(RIM_BOX), FRAME);
    const shot = run(baseline, occludedShot(0, DEFLECTED_CX, 0.6))[0];
    expect(shot.reappDrag).toBeUndefined();
    expect(shot.holds ?? []).not.toContain('reappDragVeto');
  });
});

describe('shipped default', () => {
  test('the drag VETO ships OFF — it can only subtract makes, and it is blind on a netless hoop', () => {
    // A true swish through a netless / chain / worn hoop touches nothing, so it
    // falls at ~1.0x free fall and reads as 'untouched' — the veto would eat
    // exactly the real makes it cannot distinguish from a ball passing behind
    // the rim. It is also mostly inert at 30fps (the gap is under
    // dragMinGapSec), and every band below is borrowed from another team's
    // camera and net. The ratio is still computed and reported as telemetry so
    // it can earn its way on from real footage.
    expect(REAPPEAR.dragVetoEnabled).toBe(false);
  });
});
