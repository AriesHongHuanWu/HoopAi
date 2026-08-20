import { DETECTION } from '../config';
import { MULTI_BALL, MultiBallGuard } from '../multiBallGuard';
import { multiBallCountGate } from '../../pipeline/shotPipeline';

describe('MultiBallGuard', () => {
  test('(a) a single multi-ball frame never locks (one noisy frame is not a warmup)', () => {
    const g = new MultiBallGuard();
    expect(g.step(2, 0)).toBe(false);
    expect(g.lockout).toBe(false);
    // Quiet frames afterwards stay unlocked.
    expect(g.step(0, 0.1)).toBe(false);
    expect(g.step(1, 0.2)).toBe(false);
    expect(g.lockout).toBe(false);
  });

  test('(b) two multi-ball frames 0.5 s apart enter lockout', () => {
    const g = new MultiBallGuard();
    expect(g.step(2, 0)).toBe(false);
    expect(g.step(2, 0.5)).toBe(true);
    expect(g.lockout).toBe(true);
  });

  test('(c) two multi-ball frames 1.5 s apart never lock (outside the window)', () => {
    const g = new MultiBallGuard();
    expect(g.step(2, 0)).toBe(false);
    expect(g.step(2, 1.5)).toBe(false);
    expect(g.lockout).toBe(false);
  });

  test('(d) lockout clears exactly after clearSec of < minBalls confident balls', () => {
    const g = new MultiBallGuard();
    g.step(2, 0);
    g.step(2, 0.5); // locked; lastMultiT = 0.5
    expect(g.lockout).toBe(true);
    // Just BEFORE the clear boundary: still locked.
    expect(g.step(0, 0.5 + MULTI_BALL.clearSec - 1e-3)).toBe(true);
    // Just AFTER the boundary: cleared.
    expect(g.step(0, 0.5 + MULTI_BALL.clearSec + 1e-3)).toBe(false);
    expect(g.lockout).toBe(false);
  });

  test('(e) re-entry after a clear works, and needs fresh confirmation again', () => {
    const g = new MultiBallGuard();
    g.step(2, 0);
    g.step(2, 0.5);
    expect(g.lockout).toBe(true);
    expect(g.step(0, 2.1)).toBe(false); // 1.6 s quiet → cleared
    // Old (stale) sightings must not confirm the next lockout: a single new
    // sighting stays unlocked, a second within the window re-locks.
    expect(g.step(2, 10)).toBe(false);
    expect(g.step(2, 10.4)).toBe(true);
    expect(g.lockout).toBe(true);
  });

  test('(f) fps-independence: the same wall-clock scenario at 30 fps and 8 fps gives identical lockout intervals', () => {
    // Multi-ball frames at exactly t = 0.5 and t = 1.0 — both instants lie on
    // BOTH frame grids (15/30 = 4/8 = 0.5, 30/30 = 8/8 = 1.0, all FP-exact),
    // so enter/exit times are comparable without a frame-quantization fudge.
    const count = (t: number): number =>
      Math.abs(t - 0.5) < 1e-9 || Math.abs(t - 1.0) < 1e-9 ? 2 : 0;
    const runAt = (fps: number): { enterT: number | null; exitT: number | null } => {
      const g = new MultiBallGuard();
      let enterT: number | null = null;
      let exitT: number | null = null;
      for (let i = 0; i <= Math.round(3 * fps); i++) {
        const t = i / fps;
        const locked = g.step(count(t), t);
        if (locked && enterT === null) enterT = t;
        if (!locked && enterT !== null && exitT === null) exitT = t;
      }
      return { enterT, exitT };
    };
    const at30 = runAt(30);
    const at8 = runAt(8);
    // Enter on the confirming sighting at t=1.0; clear at t=1.0+clearSec=2.5
    // (75/30 and 20/8 are both exactly 2.5).
    expect(at30.enterT).toBe(1.0);
    expect(at30.exitT).toBe(2.5);
    expect(at8).toEqual(at30);
  });

  test('(g) reset() clears lockout AND stale sighting history', () => {
    const g = new MultiBallGuard();
    g.step(2, 0);
    g.step(2, 0.5);
    expect(g.lockout).toBe(true);
    g.reset();
    expect(g.lockout).toBe(false);
    // Pre-reset sightings must not confirm a post-reset one — and time may
    // legally restart from zero (new session clock).
    expect(g.step(2, 0.6)).toBe(false);
    expect(g.step(2, 1.0)).toBe(true); // fresh pair confirms normally
  });

  test('(i) sighting gate follows the ACTIVE cold gate, floored at the default', () => {
    // Default model: the fixed cold gate.
    expect(multiBallCountGate(null)).toBe(DETECTION.ballScoreMin);
    // nano-v2: phantoms in the 0.2..0.35 band that the tracker ignores must
    // not count as multi-ball sightings either (chronic false arm-lockout).
    expect(multiBallCountGate(DETECTION.ballScoreMinNanoV2)).toBe(
      DETECTION.ballScoreMinNanoV2,
    );
    // A per-model gate can only be stricter — never below the default (a
    // relaxed gate would let faint noise latch the lockout).
    expect(multiBallCountGate(0.05)).toBe(DETECTION.ballScoreMin);
  });

  test('(h) non-monotonic/equal timestamps are ignored, never throw, never confirm', () => {
    const g = new MultiBallGuard();
    expect(g.step(2, 1.0)).toBe(false);
    // Duplicate and backwards frames are dropped — no second sighting exists.
    expect(g.step(2, 1.0)).toBe(false);
    expect(g.step(2, 0.5)).toBe(false);
    expect(g.step(2, Number.NaN)).toBe(false);
    expect(g.lockout).toBe(false);
    // Time resuming forward still works off the one accepted sighting.
    expect(g.step(2, 1.4)).toBe(true);
  });
});
