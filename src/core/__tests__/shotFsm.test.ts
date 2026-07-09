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

/** Rim box: planeY=200, cx=320, span 304..336, belowY=230, upZone 240..400 × 160..200, hoopRoi 270..370 × 185..235, layupZone 245..395 × 172.5..247.5. */
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

  test('(5) occluded layup: ball at the hoop, lost at rim, cls 0.5 → make', () => {
    const fsm = newFsm();
    const person: Box = { x: 280, y: 180, width: 60, height: 120 };
    const frames: FsmFrameInput[] = [
      // Ball above the plane, descending gently (vy > 0 so the up-zone branch
      // cannot arm) INSIDE the layup zone → ball-first layup arming. The
      // person box is only along for the origin annotation.
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

  test('(10) layup arming gate rejects a clearly falling ball near the hoop (rebound/pass)', () => {
    const fsm = newFsm();
    // Ball above the plane, inside the layup zone, but falling fast
    // (vy=300 >> maxFallVy = 5 * rimWidth(40) = 200 px/s) — a rebound or
    // pass dropping past the hoop, must NOT arm as a layup.
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i < 10; i++) {
      const t = i / FPS;
      frames.push(fin(t, tb(310, 190 + i, t, 300)));
    }
    const { resolved, results } = run(fsm, frames);
    expect(resolved).toHaveLength(0);
    for (const r of results) {
      expect(r.phase).toBe('IDLE');
    }
  });

  test('(11) layup arming allows a slowly-rising or gently-descending ball at the hoop — no person needed', () => {
    const fsm = newFsm();
    // Ball above the plane, still descending well past the fall-fast gate
    // (vy=250 > maxFallVy=200) — must NOT arm.
    const notArmed = fsm.step(fin(0, tb(310, 190, 0, 250)));
    expect(notArmed.phase).toBe('IDLE');

    // A soft layup: ball gently descending in the hand right at the hoop
    // (vy=80, well under the fall-fast gate) — arms with NO person box at
    // all. This is the ball-first headline: a missed/absent person detection
    // can no longer silently drop a real layup attempt.
    const fsm2 = newFsm();
    const armed = fsm2.step(fin(0, tb(310, 190, 0, 80)));
    expect(armed.phase).toBe('SHOT_LIVE');

    // A controlled rising layup (vy < 0) above the plane near the hoop also arms.
    const fsm3 = newFsm();
    const armedRising = fsm3.step(fin(0, tb(310, 190, 0, -50)));
    expect(armedRising.phase).toBe('SHOT_LIVE');
  });

  test('(11b) layup arming is BALL-first: a ball far from the hoop cannot arm, even with a person at the hoop', () => {
    // Under the old person-gated logic this ARMED: any ball above the plane
    // anywhere on screen + a (possibly hallucinated) person box touching the
    // hoopRoi. A ball dribbled high in the frame across the court + a phantom
    // edge person = phantom attempt. Ball-first arming requires the BALL in
    // the layup zone (hoopRoi ×1.5 ≈ x 245..395), so cx=100 must not arm.
    const fsm = newFsm();
    const person: Box = { x: 280, y: 180, width: 60, height: 120 }; // ∩ hoopRoi
    const r = fsm.step(fin(0, tb(100, 190, 0, 80), { personBox: person }));
    expect(r.phase).toBe('IDLE');
  });

  test('(11c) layup arming demands a real ball — coasts and one-frame crumbs cannot start attempts', () => {
    // A Kalman-predicted coast at the hoop: no arm.
    const fsm = newFsm();
    const coast = fsm.step(fin(0, tb(310, 190, 0, 80, { predicted: true })));
    expect(coast.phase).toBe('IDLE');

    // A single relaxed-gate tracking crumb (score 0.12 < layupArmMinBallScore
    // 0.2, streak 1 < persist 3) may CONTINUE a flight but not START one.
    const fsm2 = newFsm();
    const crumb = fsm2.step(fin(0, tb(310, 190, 0, 80, { score: 0.12 })));
    expect(crumb.phase).toBe('IDLE');
  });

  test('(11d) occluded low-score layup arms via persistence: 3 consecutive real in-zone samples at 0.15', () => {
    // A ball at the rim is routinely occluded/blurred and scores 0.12-0.19 —
    // a hard 0.2 gate would silently drop the most common layup presentation.
    // Persistence substitutes for confidence: the 3rd consecutive real
    // in-zone sample arms.
    const fsm = newFsm();
    const r1 = fsm.step(fin(0 / 30, tb(310, 190, 0 / 30, 80, { score: 0.15 })));
    expect(r1.phase).toBe('IDLE');
    const r2 = fsm.step(fin(1 / 30, tb(311, 191, 1 / 30, 80, { score: 0.15 })));
    expect(r2.phase).toBe('IDLE');
    const r3 = fsm.step(fin(2 / 30, tb(312, 192, 2 / 30, 80, { score: 0.15 })));
    expect(r3.phase).toBe('SHOT_LIVE');

    // A predicted coast in the middle breaks the streak — no arm on frame 3.
    const fsm2 = newFsm();
    fsm2.step(fin(0 / 30, tb(310, 190, 0 / 30, 80, { score: 0.15 })));
    fsm2.step(fin(1 / 30, tb(311, 191, 1 / 30, 80, { score: 0.15, predicted: true })));
    const broken = fsm2.step(fin(2 / 30, tb(312, 192, 2 / 30, 80, { score: 0.15 })));
    expect(broken.phase).toBe('IDLE');
  });

  test('(11e) pass-through guard: a layup-armed geo-only "make" (no net, no cls) demotes to unsure', () => {
    // A pass/lob crossing the rim's 2D projection can arm the ball-first
    // layup branch and then descend through the plane in-span — geo=true
    // with zero corroboration. That must NOT mint a make.
    const cross = (net: (t: number) => number): FsmFrameInput[] => [
      fin(0, tb(310, 190, 0, 80)), // arms (layup branch, score 0.8)
      fin(1 / 30, tb(312, 195, 1 / 30, 150), { netMotionScore: net(1 / 30) }),
      fin(2 / 30, tb(314, 210, 2 / 30, 200), { netMotionScore: net(2 / 30) }),
      fin(3 / 30, tb(316, 232, 3 / 30, 250), { netMotionScore: net(3 / 30) }), // belowY → resolve
    ];

    const silent = run(newFsm(), cross(() => 0));
    expect(silent.resolved).toHaveLength(1);
    expect(silent.resolved[0].signals.geo).toBe(true);
    expect(silent.resolved[0].signals.net).toBeNull();
    expect(silent.resolved[0].signals.cls).toBe(false);
    expect(silent.resolved[0].outcome).toBe('unsure'); // NOT 'make'

    // The same crossing WITH a net burst is a real layup make — untouched.
    const swished = run(newFsm(), cross(() => 0.7));
    expect(swished.resolved).toHaveLength(1);
    expect(swished.resolved[0].outcome).toBe('make');
  });

  test('(13) virtual crossing: occluded swish (track dies above the plane) + net burst → make', () => {
    // Jump-shot arc that vanishes ~0.15s BEFORE crossing the plane (net/rim
    // occlusion) — no observed crossing pair, so geo would be null and the
    // shot 'unsure'. The trailing real descending samples fit a clean
    // parabola ending at the hoop; with a net burst at the PROJECTED
    // crossing time, the virtual-crossing corroborator upgrades geo → make.
    const lostT = T_CROSS_DOWN - 0.15;
    const frames = arcFrames({
      x0: X0_CENTER,
      frames: Math.floor(lostT * FPS),
      net: (t) => (t >= T_CROSS_DOWN - 0.02 && t <= T_CROSS_DOWN + 0.1 ? 0.6 : 0),
    });
    // Ball fully lost after lostT; net keeps reporting through the crossing.
    for (let i = Math.floor(lostT * FPS); i <= Math.floor((lostT + 1.6) * FPS); i++) {
      const t = i / FPS;
      frames.push(
        fin(t, null, {
          netMotionScore: t >= T_CROSS_DOWN - 0.02 && t <= T_CROSS_DOWN + 0.1 ? 0.6 : 0,
        }),
      );
    }
    const { resolved } = run(newFsm(), frames);
    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.virtualCross).toBeDefined();
    expect(s.virtualCross!.r2y).toBeGreaterThanOrEqual(0.9);
    // Projected crossing lands on the rim center (fixture built that way).
    expect(Math.abs(s.virtualCross!.xCross - 320)).toBeLessThan(6);
    expect(s.signals.geo).toBe(true); // upgraded by the corroborator
    expect(s.signals.net).toBe(true); // burst matched the PROJECTED time
    expect(s.outcome).toBe('make');
  });

  test('(13b) virtual crossing NEVER acts alone: same occluded arc, silent net, no cls → unsure', () => {
    const lostT = T_CROSS_DOWN - 0.15;
    const frames = arcFrames({ x0: X0_CENTER, frames: Math.floor(lostT * FPS) });
    for (let i = Math.floor(lostT * FPS); i <= Math.floor((lostT + 1.6) * FPS); i++) {
      frames.push(fin(i / FPS, null));
    }
    const { resolved } = run(newFsm(), frames);
    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    // The projection ran (diagnostics present) but with zero corroboration
    // the naive-projection fake-make bug stays blocked: geo stays null.
    expect(s.virtualCross).toBeDefined();
    expect(s.signals.geo).toBeNull();
    expect(s.outcome).not.toBe('make');
  });

  test('(13c) virtual crossing refuses an off-target projection even with a net burst', () => {
    // Same occluded arc but aimed ~30px LEFT of the rim center — still rises
    // through the up-zone (arms normally) but the projected crossing lands
    // OUTSIDE the span, so even a (spurious) net burst can't upgrade geo.
    // Off-target stays null, not miss: projection isn't precise enough to
    // convict.
    const lostT = T_CROSS_DOWN - 0.15;
    const frames = arcFrames({
      x0: X0_CENTER - 30,
      frames: Math.floor(lostT * FPS),
      net: (t) => (t >= T_CROSS_DOWN - 0.02 && t <= T_CROSS_DOWN + 0.1 ? 0.6 : 0),
    });
    for (let i = Math.floor(lostT * FPS); i <= Math.floor((lostT + 1.6) * FPS); i++) {
      const t = i / FPS;
      frames.push(
        fin(t, null, {
          netMotionScore: t >= T_CROSS_DOWN - 0.02 && t <= T_CROSS_DOWN + 0.1 ? 0.6 : 0,
        }),
      );
    }
    const { resolved } = run(newFsm(), frames);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].signals.geo).toBeNull();
    expect(resolved[0].outcome).not.toBe('make');
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

  test('(14) wedged ball resting on the rim: ONE timeout resolve, then re-arming is suppressed', () => {
    // A ball stuck rim/backboard: center just above the plane, inside the
    // layup zone, motionless, high score. It satisfies the layup arm every
    // IDLE frame, so without the stationary suppressor the machine loops
    // arm → 4s maxLiveSec timeout → 'unsure' → 1.5s cooldown → re-arm,
    // emitting a junk review shot every ~5.5s. 10 seconds covers two loop
    // periods: exactly one resolve (the original event) may come out.
    const fsm = newFsm();
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i < 300; i++) {
      const t = i / FPS;
      frames.push(fin(t, tb(320, 195, t, 0)));
    }
    const { resolved, results } = run(fsm, frames);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe('unsure');
    // After the first resolve the machine never goes live again.
    const resolveIdx = results.findIndex((r) => r.resolved !== null);
    for (let i = resolveIdx + 1; i < results.length; i++) {
      expect(results[i].phase).not.toBe('SHOT_LIVE');
    }
  });

  test('(14b) dislodging the wedged ball is not an attempt; arming resumes after it leaves the zone', () => {
    const fsm = newFsm();
    const frames: FsmFrameInput[] = [];
    // 6s wedged: arms once at t=0, times out at ~4.03s, suppression latched
    // (1s of stillness observed DURING the live attempt), re-arm refused.
    for (let i = 0; i < 180; i++) {
      const t = i / FPS;
      frames.push(fin(t, tb(320, 195, t, 0)));
    }
    // The dislodging poke: ball nudged UP (a rising in-up-zone sample the
    // jump branch would normally arm!) then dropping straight through the
    // hoop in-span with a net burst — the classic phantom-make signature.
    frames.push(fin(6.0, tb(320, 193, 6.0, -40)));
    frames.push(fin(6.0 + 1 / 30, tb(320, 205, 6.0 + 1 / 30, 250), { netMotionScore: 0.7 }));
    frames.push(fin(6.0 + 2 / 30, tb(320, 215, 6.0 + 2 / 30, 350), { netMotionScore: 0.7 }));
    frames.push(fin(6.0 + 3 / 30, tb(320, 228, 6.0 + 3 / 30, 400), { netMotionScore: 0.7 }));
    frames.push(fin(6.0 + 4 / 30, tb(320, 242, 6.0 + 4 / 30, 450)));
    const { resolved } = run(fsm, frames);
    // Only the original timeout resolve — the poke armed nothing.
    expect(resolved).toHaveLength(1);
    expect(resolved[0].outcome).toBe('unsure');

    // Ball lands below the zone: a REAL out-of-zone sample lifts suppression.
    fsm.step(fin(6.2, tb(320, 300, 6.2, 200)));
    // A fresh soft layup at the hoop later must arm again.
    const rearmed = fsm.step(fin(7.0, tb(310, 190, 7.0, 80)));
    expect(rearmed.phase).toBe('SHOT_LIVE');
  });

  test('(15) floater falling into the hoop at ~400 px/s arms via descending entry and scores the make', () => {
    // A 2–4m floater: released far LEFT of the up-zone (x < 240 throughout
    // its rise), peaking well above the layup band, re-entering the hoop
    // ROI descending at ~390–420 px/s — over the layup branch's fall gate
    // (5 × 40 = 200 px/s). Before the descending-entry branch this armed via
    // NEITHER path and a made floater left net motion with no attempt.
    const VYF = -734.8; // apex at y ≈ 100
    const XF0 = 178.3;
    const VXF = 110; // descending crossing lands at x ≈ 320 (rim center)
    const netF = (t: number): number => (t >= 1.28 && t <= 1.36 ? 0.6 : 0);
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i <= 42; i++) {
      const t = i / FPS;
      const cy = Y0 + VYF * t + 0.5 * G * t * t;
      frames.push(
        fin(t, tb(XF0 + VXF * t, cy, t, VYF + G * t, { vx: VXF }), {
          netMotionScore: netF(t),
        }),
      );
    }
    const { resolved } = run(newFsm(), frames);

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.outcome).toBe('make');
    expect(s.signals).toEqual({ geo: true, net: true, cls: false });
    expect(Math.abs((s.xCross as number) - 320)).toBeLessThan(2);
    // Armed retroactively on hoop entry (~t=1.27), not at release…
    expect(s.tStart).toBeGreaterThan(1.2);
    // …but the trajectory was seeded from the pre-arm buffer, so the release
    // metrics come from the true approach, well before the arm frame.
    expect(s.trajectory[0].t).toBeLessThan(s.tStart - 0.5);
    expect(s.releasePoint).toEqual({ x: s.trajectory[0].cx, y: s.trajectory[0].cy });
  });

  test('(15b) descend-armed geo-only "make" (netless, no cls) demotes to unsure like a layup', () => {
    // Same floater on a silent net: the pass-through guard must apply to the
    // descending-entry branch too — a lob sailing through the rim's 2D
    // projection would produce exactly this signature.
    const VYF = -734.8;
    const XF0 = 178.3;
    const VXF = 110;
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i <= 42; i++) {
      const t = i / FPS;
      const cy = Y0 + VYF * t + 0.5 * G * t * t;
      frames.push(fin(t, tb(XF0 + VXF * t, cy, t, VYF + G * t, { vx: VXF })));
    }
    const { resolved } = run(newFsm(), frames);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].signals.geo).toBe(true); // attempt + crossing recorded
    expect(resolved[0].outcome).toBe('unsure'); // but never a geo-only make
  });

  test('(15c) descending entry demands a confident ball: the same floater at score 0.15 never arms', () => {
    // This branch arms on a FALLING ball, so relaxed-gate tracking crumbs
    // (0.12–0.19) may continue flights but must not START attempts here.
    const VYF = -734.8;
    const XF0 = 178.3;
    const VXF = 110;
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i <= 42; i++) {
      const t = i / FPS;
      const cy = Y0 + VYF * t + 0.5 * G * t * t;
      frames.push(
        fin(t, tb(XF0 + VXF * t, cy, t, VYF + G * t, { vx: VXF, score: 0.15 })),
      );
    }
    const { resolved, results } = run(newFsm(), frames);
    expect(resolved).toHaveLength(0);
    for (const r of results) expect(r.phase).toBe('IDLE');
  });

  test('(15d) descending entry refuses an arc that originated INSIDE the layup zone (at-rim junk)', () => {
    // A loose ball popping up off the rim and dropping back into the hoop
    // ROI: fast-falling (past the layup gate), real, confident, ballistic —
    // but its pre-arm arc STARTS inside the layup zone, which is the
    // discriminator against rebound residue. Kept below the plane and below
    // the up-zone band the whole time so no other branch can arm either.
    const seq: Array<[number, number]> = [
      // [cy, vy] at x=320 — bounce from y=240 up to y=205 and back down.
      [240, -450],
      [225, -390],
      [212, -210],
      [205, 90],
      [208, 300],
      [218, 350],
      [232, 420],
    ];
    const frames = seq.map(([cy, vy], i) => fin(i / FPS, tb(320, cy, i / FPS, vy)));
    const { resolved, results } = run(newFsm(), frames);
    expect(resolved).toHaveLength(0);
    for (const r of results) expect(r.phase).toBe('IDLE');
  });

  test('(16) release event + real upper-frame ball arms the 4th path and stamps releaseToRimSec', () => {
    // The (15) floater fixture with a pose-gated release event on frame 0.
    // Without the event this arc arms via descending entry only at hoop
    // entry (~t=1.27); the release path must arm it ~1.2 s EARLIER, on the
    // first REAL ball sample in the upper 60% of the frame (frame 1,
    // cy ≈ 376 < 0.6 × 640 = 384) inside the 0.7 s corroboration window.
    const VYF = -734.8;
    const XF0 = 178.3;
    const VXF = 110; // descending crossing lands at x ≈ 320 (rim center)
    const T_CROSS_F =
      (734.8 + Math.sqrt(734.8 * 734.8 - 4 * (G / 2) * (Y0 - 200))) / (2 * (G / 2));
    const netF = (t: number): number => (t >= 1.28 && t <= 1.36 ? 0.6 : 0);
    const frames: FsmFrameInput[] = [];
    for (let i = 0; i <= 42; i++) {
      const t = i / FPS;
      const cy = Y0 + VYF * t + 0.5 * G * t * t;
      frames.push(
        fin(t, tb(XF0 + VXF * t, cy, t, VYF + G * t, { vx: VXF }), {
          netMotionScore: netF(t),
          ...(i === 0 ? { releaseEventT: 0 } : {}),
        }),
      );
    }
    const { resolved } = run(newFsm(), frames);

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.outcome).toBe('make');
    expect(s.signals).toEqual({ geo: true, net: true, cls: false });
    // Armed at release (frame 1), not retroactively at hoop entry.
    expect(s.tStart).toBeLessThan(0.1);
    // Release-to-rim time = crossing time − event time (event at t=0).
    expect(s.releaseToRimSec).toBeDefined();
    expect(Math.abs(s.releaseToRimSec! - T_CROSS_F)).toBeLessThan(0.05);
    // Post-event pre-arm samples were seeded as the trajectory head.
    expect(s.trajectory[0].t).toBeLessThanOrEqual(s.tStart);
    expect(s.releasePoint).toEqual({ x: s.trajectory[0].cx, y: s.trajectory[0].cy });
  });

  test('(16b) a release event alone never arms: no ball, or a ball low in the frame', () => {
    // Pose says "released" but the detector never sees a ball at all — a
    // pump fake, a pass out of frame. Nothing may arm.
    const fsm = newFsm();
    const frames: FsmFrameInput[] = [fin(0, null, { releaseEventT: 0 })];
    for (let i = 1; i < 30; i++) frames.push(fin(i / FPS, null));
    const { resolved, results } = run(fsm, frames);
    expect(resolved).toHaveLength(0);
    for (const r of results) expect(r.phase).toBe('IDLE');

    // A real ball in the LOWER frame (cy = 500 > 384) right after the event
    // is a dribble/floor ball, not a climbing shot — still no arm. Placed at
    // x=150, outside every rim zone, so no other branch can fire either.
    const fsm2 = newFsm();
    const frames2: FsmFrameInput[] = [fin(0, null, { releaseEventT: 0 })];
    for (let i = 1; i < 20; i++) {
      frames2.push(fin(i / FPS, tb(150, 500, i / FPS, -300)));
    }
    const low = run(fsm2, frames2);
    expect(low.resolved).toHaveLength(0);
    for (const r of low.results) expect(r.phase).toBe('IDLE');
  });

  test('(16c) predicted-only ball after a release event does not arm (real evidence required)', () => {
    // The Kalman coast keeps a ghost ball alive in the upper frame — but a
    // prediction is the tracker's OPINION, not evidence. The release path
    // demands a never-predicted sample; coasts must not start attempts.
    const fsm = newFsm();
    const frames: FsmFrameInput[] = [
      fin(0, tb(150, 150, 0, -300, { predicted: true, score: 0 }), { releaseEventT: 0 }),
    ];
    for (let i = 1; i < 25; i++) {
      frames.push(fin(i / FPS, tb(150, 150 + i, i / FPS, -300, { predicted: true, score: 0 })));
    }
    const { resolved, results } = run(fsm, frames);
    expect(resolved).toHaveLength(0);
    for (const r of results) expect(r.phase).toBe('IDLE');
  });

  test('(16d) release events respect cooldown, and go stale past armWindowSec', () => {
    const fsm = newFsm();
    const first = run(fsm, arcFrames({ x0: X0_CENTER, net: swishNet }));
    expect(first.resolved).toHaveLength(1);
    const t1 = first.resolved[0].tResolved;

    // Event + perfectly corroborating real upper-frame ball 0.2 s into the
    // shot cooldown: must not arm (reuses the same guard every branch obeys).
    const rCd = fsm.step(
      fin(t1 + 0.2, tb(150, 150, t1 + 0.2, -300), { releaseEventT: t1 + 0.2 }),
    );
    expect(rCd.phase).toBe('COOLDOWN');
    const rCd2 = fsm.step(fin(t1 + 0.4, tb(150, 150, t1 + 0.4, -300)));
    expect(rCd2.phase).toBe('COOLDOWN');

    // Once IDLE resumes (t1 + 1.6) the latched event is older than
    // armWindowSec (0.7 s) — stale, so the upper-frame ball still can't arm
    // off it. A shot the pose saw during cooldown was residue, not a fresh
    // attempt window.
    const rIdle = fsm.step(fin(t1 + 1.6, tb(150, 150, t1 + 1.6, -300)));
    expect(rIdle.phase).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------
// Depth-illusion (parallax) veto — the "錯視" guard, now default-ON in the app.
// A ball whose apparent size shows it crossed the 2D rim line while flying IN
// FRONT of the hoop must be overturned from a make to a miss, and the receipt
// must carry the reason (signals.illusion). The veto is bread-ball-safe: it can
// ONLY remove a make, never mint one.
// ---------------------------------------------------------------------------

describe('ShotFsm — depth-illusion (parallax) veto', () => {
  // Rim width 92px clears the gate's ~40px enablement floor and matches the
  // known-firing geometry in depthRatioGate.test.ts (rim ~92px, ball ~66px →
  // ratio ~0.75 → veto_front). The stock RIM_BOX (width 40) sits AT the floor,
  // where σ is too large to fire — hence a bespoke wider rim here.
  const WIDE_RIM: Box = { x: 274, y: 200, width: 92, height: 46 };

  function vetoFsm(): ShotFsm {
    const fsm = new ShotFsm(rimFromBox(WIDE_RIM), FRAME, { useDepthRatioVeto: true });
    fsm.setBallSize(7);
    return fsm;
  }

  // A purely DESCENDING "drop" into the hoop (arms via the descend path). It
  // never rises through the rim, so it can't trip rimBounce (which would make
  // the gate stand down). cy(t)=40+250t+450t² crosses the plane (y=200) at
  // t≈0.38; x0 places that descending crossing on the rim center (x=320).
  const DVY0 = 250;
  const DY0 = 40;
  const DVX = 40;
  const DG = 900;
  const T_DROP_CROSS =
    (-DVY0 + Math.sqrt(DVY0 * DVY0 - 4 * (DG / 2) * (DY0 - 200))) / (2 * (DG / 2));
  const DROP_X0_CENTER = 320 - DVX * T_DROP_CROSS;

  /** Descending drop: fixed ball radius r (the depth cue) + optional net. */
  function dropFrames(x0: number, r: number, net?: (t: number) => number): FsmFrameInput[] {
    const out: FsmFrameInput[] = [];
    for (let i = 0; i < 24; i++) {
      const t = i / FPS;
      const cx = x0 + DVX * t;
      const cy = DY0 + DVY0 * t + 0.5 * DG * t * t;
      out.push(
        fin(t, tb(cx, cy, t, DVY0 + DG * t, { vx: DVX, r }), {
          netMotionScore: net ? net(t) : 0,
        }),
      );
    }
    return out;
  }

  /** Net burst straddling the drop's plane crossing (~t=0.38). */
  const dropNet = (t: number): number => (t >= 0.35 && t <= 0.55 ? 0.6 : 0);

  test('front airball (ball too big for rim depth) is vetoed even over net: → miss + illusion=front', () => {
    // r=36 → diameter 72px → ratio ≈ 0.69 at rim width 92 → veto_front. The
    // veto flips geo false, which fuse() turns into a miss BEFORE net is read.
    const { resolved } = run(vetoFsm(), dropFrames(DROP_X0_CENTER, 36, dropNet));
    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.geoDepth?.decision).toBe('veto_front');
    expect(s.signals.geo).toBe(false);
    expect(s.signals.illusion).toBe('front');
    expect(s.outcome).toBe('miss');
  });

  test('the SAME shot with the veto OFF is a make — proving the veto is what overturned it', () => {
    // Default FSM (veto off): geo true + net burst → make (geo && net).
    const { resolved } = run(
      new ShotFsm(rimFromBox(WIDE_RIM), FRAME),
      dropFrames(DROP_X0_CENTER, 36, dropNet),
    );
    expect(resolved[0].outcome).toBe('make');
    expect(resolved[0].signals.geo).toBe(true);
    expect(resolved[0].signals.illusion).toBeUndefined();
  });

  test('a real make at rim depth survives the veto (silent — no false veto)', () => {
    // r=25 → diameter 50px → ratio ≈ 0.99 → inside the make zone → silent, so
    // geo stays true and the net burst carries it to a make.
    const { resolved } = run(vetoFsm(), dropFrames(DROP_X0_CENTER, 25, dropNet));
    const s = resolved[0];
    expect(s.geoDepth?.decision).toBe('silent');
    expect(s.signals.geo).toBe(true);
    expect(s.signals.illusion).toBeUndefined();
    expect(s.outcome).toBe('make');
  });

  test('BREAD-BALL: the veto only removes makes — a seen out-of-span miss (with net) never becomes a make', () => {
    // Crossing shifted well left of the span: geo is already false, so the
    // veto (which runs only on geo===true) has nothing to touch, and net can't
    // mint a make over a seen out-of-span crossing. Never a make.
    const { resolved } = run(vetoFsm(), dropFrames(DROP_X0_CENTER - 90, 36, dropNet));
    expect(resolved).toHaveLength(1);
    expect(resolved[0].signals.geo).toBe(false);
    expect(resolved[0].outcome).not.toBe('make');
  });
});
