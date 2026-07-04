import { RIM } from '../config';
import { ShotFsm } from '../shotFsm';
import type {
  Box,
  FsmFrameInput,
  FsmStepResult,
  ResolvedShot,
  RimGeometry,
  TrackedBall,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const FRAME = { width: 640, height: 640 };

/** Rim box: planeY=200, cx=320, span 304..336, belowY=230, upZone 240..400 × 160..200, hoopRoi 270..370 × 185..235. */
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

function newFsm(): ShotFsm {
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

interface RunResult {
  resolved: ResolvedShot[];
  results: FsmStepResult[];
}

function run(fsm: ShotFsm, frames: FsmFrameInput[]): RunResult {
  const resolved: ResolvedShot[] = [];
  const results: FsmStepResult[] = [];
  for (const f of frames) {
    const r = fsm.step(f);
    results.push(r);
    if (r.resolved) resolved.push(r.resolved);
  }
  return { resolved, results };
}

// ---------------------------------------------------------------------------
// Synthetic projectile (y down: y(t) = y0 + vy0*t + 0.5*g*t², vy0 < 0 = up)
// ---------------------------------------------------------------------------

const G = 900;
const VY0 = -700;
const Y0 = 400;
const VX = 60;
const FPS = 30;

/** Time of the DESCENDING crossing of the rim plane (y = 200). */
const T_CROSS_DOWN =
  (700 + Math.sqrt(700 * 700 - 4 * (G / 2) * (Y0 - 200))) / (2 * (G / 2));

/** x0 such that the descending crossing lands exactly on the rim center. */
const X0_CENTER = 320 - VX * T_CROSS_DOWN;

/** Analytic entry angle: atan2(vy_at_crossing, vx), degrees above horizontal. */
const ENTRY_ANALYTIC =
  (Math.atan2(VY0 + G * T_CROSS_DOWN, VX) * 180) / Math.PI;

function arcFrames(opts: {
  x0: number;
  net?: (t: number) => number;
  person?: Box | null;
  frames?: number;
}): FsmFrameInput[] {
  const n = opts.frames ?? 46;
  const out: FsmFrameInput[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / FPS;
    const cx = opts.x0 + VX * t;
    const cy = Y0 + VY0 * t + 0.5 * G * t * t;
    out.push(
      fin(t, tb(cx, cy, t, VY0 + G * t, { vx: VX }), {
        netMotionScore: opts.net ? opts.net(t) : 0,
        personBox: opts.person ?? null,
      }),
    );
  }
  return out;
}

/** Net burst covering the crossing (0.6 for ~0.12s right after the plane). */
const swishNet = (t: number): number => (t >= 1.2 && t <= 1.32 ? 0.6 : 0);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShotFsm', () => {
  test('(1) clean swish through rim center + net burst → make (geo & net), entry angle ≈ analytic', () => {
    const fsm = newFsm();
    const { resolved, results } = run(
      fsm,
      arcFrames({ x0: X0_CENTER, net: swishNet }),
    );

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.id).toBe(1);
    expect(s.outcome).toBe('make');
    expect(s.signals).toEqual({ geo: true, net: true, cls: false });
    expect(s.rimBounce).toBe(false);
    expect(s.xCross).not.toBeNull();
    expect(Math.abs((s.xCross as number) - 320)).toBeLessThan(1);
    expect(s.entryAngleDeg).not.toBeNull();
    expect(Math.abs((s.entryAngleDeg as number) - ENTRY_ANALYTIC)).toBeLessThan(1);
    // Analytic release angle over the first 5 samples is ~78° above horizontal.
    expect(s.releaseAngleDeg).toBeGreaterThan(70);
    expect(s.releaseAngleDeg).toBeLessThan(85);
    // Release point = first buffered sample.
    expect(s.releasePoint).toEqual({ x: s.trajectory[0].cx, y: s.trajectory[0].cy });
    expect(s.trajectory.length).toBeGreaterThan(20);
    // Arming happened while the ball was rising through the up-zone (~t=0.4).
    expect(s.tStart).toBeGreaterThan(0.3);
    expect(s.tStart).toBeLessThan(0.6);

    // On the resolve frame the machine enters COOLDOWN and empties the buffer.
    const resolveResult = results.find((r) => r.resolved !== null) as FsmStepResult;
    expect(resolveResult.phase).toBe('COOLDOWN');
    expect(resolveResult.liveTrajectory).toHaveLength(0);
  });

  test('(2) front-rim brick crossing outside span, no net → miss', () => {
    const fsm = newFsm();
    // Crossing at x = 290, left of spanLeft = 304. Net silent all session.
    const { resolved } = run(fsm, arcFrames({ x0: 290 - VX * T_CROSS_DOWN }));

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.outcome).toBe('miss');
    expect(s.signals).toEqual({ geo: false, net: null, cls: false });
    expect(Math.abs((s.xCross as number) - 290)).toBeLessThan(1);
  });

  test('(2b) netless brick + phantom ball_in_basket stays a MISS (geometry overrides noisy cls)', () => {
    const fsm = newFsm();
    // Same front-rim brick as (2): descending crossing at x=290, outside the
    // span (304..336), net silent — but the detector falsely fires the
    // ball_in_basket class the whole flight. Geometry (geo=false) must win, or
    // a noisy cls fabricates a phantom "make" on an obvious miss (the
    // "shot becomes a make" bug on netless outdoor hoops).
    const frames = arcFrames({ x0: 290 - VX * T_CROSS_DOWN }).map((f) => ({
      ...f,
      ballInBasketScore: 0.5,
    }));
    const { resolved } = run(fsm, frames);

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.outcome).toBe('miss');
    expect(s.signals.geo).toBe(false);
    expect(s.signals.cls).toBe(true);
  });

  test('(3) rim-rattler: bounce then drop through + late net burst above raised threshold → make, rimBounce', () => {
    const fsm = newFsm();
    // [t, cx, cy, vy, net] — arm in up-zone, touch rim, re-ascend above the
    // plane (bounce), then final descent through the center with a net burst.
    const seq: Array<[number, number, number, number, number]> = [
      [0 / 30, 320, 180, -100, 0],
      [1 / 30, 320, 178, -50, 0],
      [2 / 30, 318, 190, 150, 0],
      [3 / 30, 315, 205, 200, 0], // touching the rim (inflated rim box)
      [4 / 30, 316, 195, -250, 0], // re-ascended above planeY → rimBounce
      [5 / 30, 318, 185, -100, 0],
      [6 / 30, 319, 190, 100, 0],
      [7 / 30, 320, 202, 250, 0], // final descending crossing near center
      [8 / 30, 321, 215, 350, 0.6], // net burst: 0.6 > 0.25 * 1.5 = 0.375
      [9 / 30, 322, 232, 400, 0.6], // below belowY → resolve
    ];
    const { resolved } = run(
      fsm,
      seq.map(([t, cx, cy, vy, net]) =>
        fin(t, tb(cx, cy, t, vy), { netMotionScore: net }),
      ),
    );

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.rimBounce).toBe(true);
    expect(s.outcome).toBe('make');
    expect(s.signals.geo).toBe(true);
    expect(s.signals.net).toBe(true);
    // The FINAL crossing (post-bounce) is the one scored.
    expect(Math.abs((s.xCross as number) - 319.83)).toBeLessThan(0.5);
  });

  test('(3b) rim-rattler with weak net burst below the raised threshold → miss', () => {
    const fsm = newFsm();
    // Same rattler, but the burst (0.3) clears the base threshold (0.25)
    // while failing the rim-bounce-raised one (0.375) → net=false → miss.
    const seq: Array<[number, number, number, number, number]> = [
      [0 / 30, 320, 180, -100, 0],
      [1 / 30, 320, 178, -50, 0],
      [2 / 30, 318, 190, 150, 0],
      [3 / 30, 315, 205, 200, 0],
      [4 / 30, 316, 195, -250, 0],
      [5 / 30, 318, 185, -100, 0],
      [6 / 30, 319, 190, 100, 0],
      [7 / 30, 320, 202, 250, 0],
      [8 / 30, 321, 215, 350, 0.3],
      [9 / 30, 322, 232, 400, 0.3],
    ];
    const { resolved } = run(
      fsm,
      seq.map(([t, cx, cy, vy, net]) =>
        fin(t, tb(cx, cy, t, vy), { netMotionScore: net }),
      ),
    );

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.rimBounce).toBe(true);
    expect(s.signals).toEqual({ geo: true, net: false, cls: false });
    expect(s.outcome).toBe('miss');
  });

  test('(4) airball drifting below the rim without up-zone entry never arms', () => {
    const fsm = newFsm();
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i < 30; i++) {
      const t = i / FPS;
      // Falling wide of the hoop, always below the rim plane (cy ≥ 250).
      frames.push(fin(t, tb(200 + 3 * i, 250 + 4 * i, t, 120, { vx: 90 })));
    }
    const { resolved, results } = run(fsm, frames);

    expect(resolved).toHaveLength(0);
    for (const r of results) {
      expect(r.phase).toBe('IDLE');
      expect(r.liveTrajectory).toHaveLength(0);
      expect(r.resolved).toBeNull();
    }
  });

  test('(5) occluded layup: person overlaps hoopRoi, ball lost at rim, cls 0.5 → make', () => {
    const fsm = newFsm();
    const person: Box = { x: 280, y: 180, width: 60, height: 120 };
    const frames: FsmFrameInput[] = [
      // Ball above the plane, descending (vy > 0 so the up-zone branch cannot
      // arm) while the person overlaps the hoop ROI → layup arming path.
      fin(0 / 30, tb(310, 190, 0 / 30, 80), { personBox: person }),
      fin(1 / 30, tb(312, 193, 1 / 30, 80), { personBox: person }),
      fin(2 / 30, tb(313, 196, 2 / 30, 80, { predicted: true, score: 0 }), {
        personBox: person,
      }),
    ];
    // Ball fully lost at the rim; 'ball_in_basket' fires at 0.5 for a moment.
    for (let i = 3; i <= 50; i++) {
      const t = i / FPS;
      frames.push(
        fin(t, null, {
          personBox: person,
          ballInBasketScore: i <= 6 ? 0.5 : 0,
        }),
      );
    }
    const { resolved } = run(fsm, frames);

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.outcome).toBe('make');
    expect(s.signals.cls).toBe(true);
    expect(s.signals.geo).toBeNull(); // never crossed the plane downward
    expect(s.signals.net).toBeNull(); // net silent → channel unavailable
    expect(s.tStart).toBe(0);
    // Resolved via the lost-ball timer (1.5 s after the last sample at t=2/30).
    expect(s.tResolved).toBeCloseTo(2 / 30 + 1.5, 5);
    // Origin from the person's foot midpoint, normalized.
    expect(s.originX).toBeCloseTo(310 / 640, 6);
    expect(s.originY).toBeCloseTo(300 / 640, 6);
  });

  test('(6a) second attempt 0.5 s after a resolve does not arm (shot cooldown)', () => {
    const fsm = newFsm();
    const first = run(fsm, arcFrames({ x0: X0_CENTER, net: swishNet }));
    expect(first.resolved).toHaveLength(1);
    const t1 = first.resolved[0].tResolved;

    // Perfectly armable ball 0.5 s later — must be ignored.
    const r = fsm.step(fin(t1 + 0.5, tb(320, 180, t1 + 0.5, -100)));
    expect(r.phase).toBe('COOLDOWN');
    expect(r.resolved).toBeNull();
    expect(r.liveTrajectory).toHaveLength(0);

    // After the cooldown elapses the machine returns to IDLE.
    const r2 = fsm.step(fin(t1 + 1.6, null));
    expect(r2.phase).toBe('IDLE');
  });

  test('(6b) make within basketCooldownSec of the previous make downgrades to unsure', () => {
    const fsm = newFsm();
    const first = run(fsm, arcFrames({ x0: X0_CENTER, net: swishNet }));
    expect(first.resolved[0].outcome).toBe('make');
    const t1 = first.resolved[0].tResolved; // lastMakeT

    // Second shot arms after the 1.5 s shot cooldown and resolves as a
    // geometric+net make at t1 + 1.7 < t1 + 2.0 (basket cooldown) → unsure.
    const a = t1 + 1.6;
    const seq: FsmFrameInput[] = [
      fin(a, tb(320, 180, a, -100)),
      fin(a + 1 / 30, tb(320, 195, a + 1 / 30, 300)),
      fin(a + 2 / 30, tb(320, 210, a + 2 / 30, 400), { netMotionScore: 0.7 }),
      fin(a + 3 / 30, tb(320, 232, a + 3 / 30, 450), { netMotionScore: 0.7 }),
    ];
    const second = run(fsm, seq);

    expect(second.resolved).toHaveLength(1);
    const s = second.resolved[0];
    expect(s.id).toBe(2);
    // The signals say make — only the double-count guard demotes it.
    expect(s.signals.geo).toBe(true);
    expect(s.signals.net).toBe(true);
    expect(s.outcome).toBe('unsure');
  });

  test('(6c) a geo-miss resolving within basketCooldownSec of a make downgrades to unsure', () => {
    const fsm = newFsm();
    const first = run(fsm, arcFrames({ x0: X0_CENTER, net: swishNet }));
    expect(first.resolved[0].outcome).toBe('make');
    const t1 = first.resolved[0].tResolved; // lastMakeT

    // Second shot arms after the 1.5s shot cooldown and crosses OUTSIDE the
    // span (a real geo-miss) at t1 + 1.7 < t1 + 2.0 (basket cooldown) — the
    // extended guard should still demote it to unsure rather than letting it
    // count as a genuine miss (residual motion/false crossing so soon after
    // a real make shouldn't zero the streak).
    const a = t1 + 1.6;
    const seq: FsmFrameInput[] = [
      fin(a, tb(250, 180, a, -100)),
      fin(a + 1 / 30, tb(250, 195, a + 1 / 30, 300)),
      fin(a + 2 / 30, tb(250, 210, a + 2 / 30, 400)),
      fin(a + 3 / 30, tb(250, 232, a + 3 / 30, 450)),
    ];
    const second = run(fsm, seq);

    expect(second.resolved).toHaveLength(1);
    const s = second.resolved[0];
    expect(s.signals.geo).toBe(false); // crossing was a genuine geo-miss
    expect(s.outcome).toBe('unsure'); // but demoted by the cooldown guard
  });

  test('(7) netless hoop (all netMotionScore = 0): geo-only make still scores make', () => {
    const fsm = newFsm();
    const { resolved } = run(fsm, arcFrames({ x0: X0_CENTER }));

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.signals).toEqual({ geo: true, net: null, cls: false });
    expect(s.outcome).toBe('make');
  });

  test('(8) maxLiveSec force-resolve → unsure', () => {
    const fsm = newFsm();
    const frames: FsmFrameInput[] = [fin(0, tb(320, 180, 0, -100))]; // arms
    // Ball hovers above the plane forever (never below rim, never lost).
    for (let i = 1; i <= 130; i++) {
      const t = i / FPS;
      const up = i % 2 === 0;
      frames.push(fin(t, tb(320, up ? 178 : 184, t, up ? -60 : 60)));
    }
    const { resolved } = run(fsm, frames);

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.outcome).toBe('unsure');
    expect(s.tResolved - s.tStart).toBeGreaterThan(4);
    expect(s.signals.geo).toBeNull();
  });

  test('(10) layup arming gate rejects a clearly falling ball near the hoop (rebound/pass), even with person overlap', () => {
    const fsm = newFsm();
    const person: Box = { x: 280, y: 180, width: 60, height: 120 };
    // Ball above the plane but falling fast (vy=300 >> maxFallVy = 10 * rimHeight(20) = 200 px/s)
    // while a person overlaps the hoop ROI — must NOT arm as a layup.
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i < 10; i++) {
      const t = i / FPS;
      frames.push(fin(t, tb(310, 190 + i, t, 300), { personBox: person }));
    }
    const { resolved, results } = run(fsm, frames);
    expect(resolved).toHaveLength(0);
    for (const r of results) {
      expect(r.phase).toBe('IDLE');
    }
  });

  test('(11) layup arming gate allows a slowly-rising or gently-descending ball near the hoop with person overlap', () => {
    const fsm = newFsm();
    const person: Box = { x: 280, y: 180, width: 60, height: 120 };
    // Ball above the plane, still descending well past the fall-fast gate
    // (vy=250 > maxFallVy=200) — must NOT arm.
    const notArmed = fsm.step(fin(0, tb(310, 190, 0, 250), { personBox: person }));
    expect(notArmed.phase).toBe('IDLE');

    // A soft layup: ball gently descending in the hand right at the hoop
    // (vy=80, well under the fall-fast gate) — arms normally.
    const fsm2 = newFsm();
    const armed = fsm2.step(fin(0, tb(310, 190, 0, 80), { personBox: person }));
    expect(armed.phase).toBe('SHOT_LIVE');

    // A controlled rising layup (vy < 0) above the plane near the hoop also arms.
    const fsm3 = newFsm();
    const armedRising = fsm3.step(fin(0, tb(310, 190, 0, -50), { personBox: person }));
    expect(armedRising.phase).toBe('SHOT_LIVE');
  });

  test('(12) resolve prefers a real (non-predicted) descending crossing over a later predicted one', () => {
    const fsm = newFsm();
    // Arm, then a REAL descending crossing well inside the span (cx=320,
    // planeY=200), followed by a brief occlusion right at the rim producing
    // Kalman-predicted samples that would (if treated identically to real
    // detections) fabricate a LATER "crossing" via extrapolated jitter
    // outside the span. The FINAL-real-crossing preference should still
    // score geo from the real, in-span crossing.
    const seq: FsmFrameInput[] = [
      fin(0 / 30, tb(320, 180, 0 / 30, -100)), // arm (up-zone)
      fin(1 / 30, tb(320, 190, 1 / 30, 250)),
      fin(2 / 30, tb(320, 210, 2 / 30, 300)), // REAL descending crossing, cx=320 (in span)
      // Occlusion begins: predicted samples drift horizontally outside the
      // span while still hovering near the plane, then dip back above and
      // below the plane again — a fabricated crossing from extrapolation.
      fin(3 / 30, tb(400, 195, 3 / 30, -50, { predicted: true, score: 0 })),
      fin(4 / 30, tb(400, 205, 4 / 30, 50, { predicted: true, score: 0 })),
      fin(5 / 30, tb(400, 232, 5 / 30, 400, { predicted: true, score: 0 })), // below belowY → resolve
    ];
    const { resolved } = run(fsm, seq);

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    // Must have used the REAL crossing (cx≈320, in span) not the predicted
    // one further out (cx=400, outside span).
    expect(s.xCross).not.toBeNull();
    expect(Math.abs((s.xCross as number) - 320)).toBeLessThan(5);
    expect(s.signals.geo).toBe(true);
  });

  test('(9) origin captured normalized from the person foot midpoint at arming', () => {
    const fsm = newFsm();
    const person: Box = { x: 100, y: 300, width: 50, height: 200 };
    const { resolved } = run(
      fsm,
      arcFrames({ x0: X0_CENTER, net: swishNet, person }),
    );

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.originX).toBeCloseTo(125 / 640, 6);
    expect(s.originY).toBeCloseTo(500 / 640, 6);

    // And with no person tracked the origin is null.
    const fsm2 = newFsm();
    const { resolved: r2 } = run(fsm2, arcFrames({ x0: X0_CENTER }));
    expect(r2[0].originX).toBeNull();
    expect(r2[0].originY).toBeNull();
  });
});
