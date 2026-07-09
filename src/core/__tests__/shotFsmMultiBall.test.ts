/**
 * FSM armLockout contract tests (multi-ball guard / rim drift hold).
 *
 * Written against the detection-accuracy integration contract: types.ts gains
 * an optional `armLockout?: boolean` on FsmFrameInput and shotFsm.ts canArm()
 * gains `if (input.armLockout) return null;` as its first check. Until that
 * shared-file integration lands, the lockout-blocking cases below FAIL (the
 * field is ignored) — that is expected and nothing here is skipped.
 *
 * IRON RULE under test: armLockout is SUPPRESSION-ONLY. It may prevent a NEW
 * attempt from arming; it must never touch a shot that is already live, and
 * an absent field must behave exactly like `false`.
 *
 * Fixtures are copied verbatim from shotFsm.test.ts so the two suites judge
 * the same synthetic shots.
 */
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

/**
 * FsmFrameInput plus the `armLockout` field the integrator adds to types.ts.
 * Intersected locally so this suite compiles BEFORE the shared-file edit
 * lands; once FsmFrameInput carries the optional field, the intersection is
 * a no-op and this alias can be deleted.
 */
type LockableFrameInput = FsmFrameInput & { armLockout?: boolean };

// ---------------------------------------------------------------------------
// Fixtures & helpers (verbatim from shotFsm.test.ts)
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
// Descend-armed floater (verbatim recipe from shotFsm.test.ts test (15)):
// released far LEFT of the up-zone, re-enters the hoop ROI descending at
// ~390–420 px/s — arms via the descending-entry branch only, at hoop entry.
// ---------------------------------------------------------------------------

const VYF = -734.8; // apex at y ≈ 100
const XF0 = 178.3;
const VXF = 110; // descending crossing lands at x ≈ 320 (rim center)
const netF = (t: number): number => (t >= 1.28 && t <= 1.36 ? 0.6 : 0);

function floaterFrames(net?: (t: number) => number): FsmFrameInput[] {
  const out: FsmFrameInput[] = [];
  for (let i = 0; i <= 42; i++) {
    const t = i / FPS;
    const cy = Y0 + VYF * t + 0.5 * G * t * t;
    out.push(
      fin(t, tb(XF0 + VXF * t, cy, t, VYF + G * t, { vx: VXF }), {
        netMotionScore: net ? net(t) : 0,
      }),
    );
  }
  return out;
}

/** Soft layup at the hoop (shotFsm.test.ts test (11) recipe, held 10 frames). */
function layupFrames(): FsmFrameInput[] {
  const out: FsmFrameInput[] = [];
  for (let i = 0; i < 10; i++) {
    const t = i / FPS;
    out.push(fin(t, tb(310 + i, 190, t, 80)));
  }
  return out;
}

/** Stamp armLockout: true onto every frame whose time satisfies `on`. */
function withLockout(
  frames: FsmFrameInput[],
  on: (t: number) => boolean,
): LockableFrameInput[] {
  return frames.map((f) => (on(f.t) ? { ...f, armLockout: true } : f));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShotFsm — armLockout (multi-ball / rim-drift arm suppression)', () => {
  test('(1) lockout blocks the jump arm: a clean make fixture never arms, never resolves', () => {
    // Sanity: identical frames WITHOUT lockout resolve a make — so the
    // lockout, not the fixture, is what blocks below.
    const clean = run(newFsm(), arcFrames({ x0: X0_CENTER, net: swishNet }));
    expect(clean.resolved).toHaveLength(1);
    expect(clean.resolved[0].outcome).toBe('make');

    const { resolved, results } = run(
      newFsm(),
      withLockout(arcFrames({ x0: X0_CENTER, net: swishNet }), () => true),
    );
    expect(resolved).toHaveLength(0);
    for (const r of results) {
      expect(r.phase).toBe('IDLE');
      expect(r.resolved).toBeNull();
    }
  });

  test('(2a) lockout blocks the layup arm', () => {
    // Sanity: the soft layup arms on its first frame without lockout.
    const armed = newFsm().step(fin(0, tb(310, 190, 0, 80)));
    expect(armed.phase).toBe('SHOT_LIVE');

    const { resolved, results } = run(newFsm(), withLockout(layupFrames(), () => true));
    expect(resolved).toHaveLength(0);
    for (const r of results) expect(r.phase).toBe('IDLE');
  });

  test('(2b) lockout blocks the descending-entry arm', () => {
    // Sanity: the floater resolves a make without lockout (shotFsm test 15).
    const clean = run(newFsm(), floaterFrames(netF));
    expect(clean.resolved).toHaveLength(1);
    expect(clean.resolved[0].outcome).toBe('make');

    const { resolved, results } = run(newFsm(), withLockout(floaterFrames(netF), () => true));
    expect(resolved).toHaveLength(0);
    for (const r of results) expect(r.phase).toBe('IDLE');
  });

  test('(3) lifting lockout mid-approach recovers via descend: the pre-arm buffer seeds the retro-arm', () => {
    // Gym crowded for the first half of the floater's flight, clear after —
    // the shot must still resolve because the guard suppresses ARMING only;
    // evidence collection (the pre-arm buffer) continues under lockout.
    const frames = floaterFrames(netF);
    const half = frames[Math.floor(frames.length / 2)].t; // ≈ 0.7 s
    const { resolved } = run(newFsm(), withLockout(frames, (t) => t < half));

    expect(resolved).toHaveLength(1);
    const s = resolved[0];
    expect(s.outcome).toBe('make');
    expect(s.signals.geo).toBe(true);
    expect(s.signals.net).toBe(true);
    // Armed retroactively at hoop entry, after the lockout lifted…
    expect(s.tStart).toBeGreaterThan(half);
    // …with the trajectory head seeded from samples buffered DURING lockout.
    expect(s.trajectory[0].t).toBeLessThan(half);
  });

  test('(4) IRON-RULE: lockout raised during SHOT_LIVE never touches the live shot — resolve is identical', () => {
    const plain = run(newFsm(), arcFrames({ x0: X0_CENTER, net: swishNet }));
    expect(plain.resolved).toHaveLength(1);

    // Arming completes by tStart < 0.6 (see shotFsm.test.ts test (1)); raise
    // the lockout well after that and keep it up across the plane crossing,
    // the resolve, and the cooldown.
    const locked = run(
      newFsm(),
      withLockout(arcFrames({ x0: X0_CENTER, net: swishNet }), (t) => t >= 0.8),
    );
    expect(locked.resolved).toEqual(plain.resolved);
  });

  test('(5) BASELINE: armLockout absent and armLockout:false on every frame are identical', () => {
    const absent = run(newFsm(), arcFrames({ x0: X0_CENTER, net: swishNet }));
    expect(absent.resolved).toHaveLength(1);

    const explicitFalse = run(
      newFsm(),
      arcFrames({ x0: X0_CENTER, net: swishNet }).map(
        (f): LockableFrameInput => ({ ...f, armLockout: false }),
      ),
    );
    expect(explicitFalse.resolved).toEqual(absent.resolved);
  });
});
