import {
  THERMAL,
  THERMAL_LEVELS,
  ThermalGovernor,
} from '../thermalGovernor';

/**
 * Feeds `gov` a constant inference time from `fromSec` (inclusive) to `toSec`
 * (exclusive) at 15 fps by default. Returns every level the governor passed
 * through (deduped), so tests can assert one-step-at-a-time transitions.
 */
function feed(
  gov: ThermalGovernor,
  ms: number,
  fromSec: number,
  toSec: number,
  dt = 1 / 15,
): number[] {
  const levels: number[] = [gov.decision.level];
  for (let t = fromSec; t < toSec; t += dt) {
    gov.push(ms, t);
    const l = gov.decision.level;
    if (levels[levels.length - 1] !== l) levels.push(l);
  }
  return levels;
}

describe('THERMAL_LEVELS table', () => {
  test('pins the shedding ladder the engine wiring relies on', () => {
    // Sanity-pin the tunables the timing math in this file depends on.
    expect(THERMAL.baselineSec).toBe(20);
    expect(THERMAL.minSamples).toBe(30);
    expect(THERMAL.enterRatios).toEqual([1.5, 2.0, 2.75]);
    expect(THERMAL.exitFactor).toBe(0.85);
    expect(THERMAL.dwellSec).toBe(8);

    expect(THERMAL_LEVELS).toEqual([
      { level: 0, minGateMs: 0, inferMultiplier: 1.4, allowRoi: true, allowPose: true },
      { level: 1, minGateMs: 0, inferMultiplier: 1.6, allowRoi: false, allowPose: true },
      { level: 2, minGateMs: 66, inferMultiplier: 2.0, allowRoi: false, allowPose: true },
      { level: 3, minGateMs: 100, inferMultiplier: 2.6, allowRoi: false, allowPose: false },
    ]);
    // Work only ever sheds as the level rises (never returns at a hotter level).
    for (let i = 1; i < THERMAL_LEVELS.length; i++) {
      expect(THERMAL_LEVELS[i].inferMultiplier).toBeGreaterThan(
        THERMAL_LEVELS[i - 1].inferMultiplier,
      );
      expect(THERMAL_LEVELS[i].minGateMs).toBeGreaterThanOrEqual(
        THERMAL_LEVELS[i - 1].minGateMs,
      );
    }
  });
});

describe('ThermalGovernor', () => {
  test('cool run: 60 s at 30 ms stays level 0 with ratio 1', () => {
    const gov = new ThermalGovernor();
    const levels = feed(gov, 30, 0, 60);
    expect(levels).toEqual([0]);
    expect(gov.ratio).toBeCloseTo(1, 6);
    // decision hands out the shared table row — no per-read allocation.
    expect(gov.decision).toBe(THERMAL_LEVELS[0]);
    expect(gov.decision).toBe(gov.decision);
  });

  test('heat ramp: 50 ms after a 30 ms baseline raises to L1 only after dwell', () => {
    const gov = new ThermalGovernor();
    feed(gov, 30, 0, 25);
    // fastEma crosses 45 (ratio 1.5) ~0.6 s after the jump; dwell adds 8 s.
    feed(gov, 50, 25, 32); // +7 s: dwell not yet served
    expect(gov.decision.level).toBe(0);
    feed(gov, 50, 32, 34); // +9 s: dwell served
    expect(gov.decision.level).toBe(1);
    expect(gov.ratio).toBeCloseTo(50 / 30, 2);
  });

  test('full ladder: hotter plateaus climb 1 → 2 → 3 in order, one step each', () => {
    const gov = new ThermalGovernor();
    const levels = [
      ...feed(gov, 30, 0, 25), // baseline 30 ms
      ...feed(gov, 50, 25, 40), // ratio 1.67 → L1
      ...feed(gov, 65, 40, 55), // ratio 2.17 → L2
      ...feed(gov, 90, 55, 70), // ratio 3.00 → L3
    ];
    // Dedup across the concatenated segments, then assert no level skipped.
    const transitions = levels.filter((l, i) => i === 0 || l !== levels[i - 1]);
    expect(transitions).toEqual([0, 1, 2, 3]);
    expect(gov.decision).toBe(THERMAL_LEVELS[3]);
    expect(gov.decision.minGateMs).toBe(100);
    expect(gov.decision.allowRoi).toBe(false);
    expect(gov.decision.allowPose).toBe(false);
  });

  test('spike: an instant 3x ratio still walks up one level per dwell window', () => {
    const gov = new ThermalGovernor();
    feed(gov, 30, 0, 25);
    feed(gov, 90, 25, 34); // +9 s: exactly one dwell served
    expect(gov.decision.level).toBe(1);
    const levels = feed(gov, 90, 34, 50); // two more dwell windows
    expect(levels).toEqual([1, 2, 3]);
  });

  test('hysteresis: L1 holds through a dip above the exit ratio, drops below it', () => {
    const gov = new ThermalGovernor();
    feed(gov, 30, 0, 25);
    feed(gov, 46.5, 25, 37); // ratio 1.55 → L1 (~34 s)
    expect(gov.decision.level).toBe(1);

    // Dip to ratio 1.35 — above the exit ratio 1.5 * 0.85 = 1.275 → held.
    feed(gov, 40.5, 37, 57);
    expect(gov.decision.level).toBe(1);
    expect(gov.ratio).toBeCloseTo(1.35, 2);

    // Dip to ratio 1.2 — below the exit ratio; drops only after dwell.
    feed(gov, 36, 57, 64); // +7 s: still held
    expect(gov.decision.level).toBe(1);
    feed(gov, 36, 64, 67); // dwell served
    expect(gov.decision.level).toBe(0);
  });

  test('no oscillation: ratio flapping across the enter threshold never raises', () => {
    const gov = new ThermalGovernor();
    feed(gov, 30, 0, 25);
    // Alternate ratio 1.45 / 1.55 every second: the >=1.5 condition is never
    // continuously true for dwellSec, so the level must never move.
    const levels: number[] = [];
    for (let s = 0; s < 40; s++) {
      levels.push(...feed(gov, s % 2 === 0 ? 43.5 : 46.5, 25 + s, 26 + s));
    }
    expect(levels.every((l) => l === 0)).toBe(true);
    expect(gov.decision.level).toBe(0);
  });

  test('baseline only drifts down: a cooler stretch lowers it for good', () => {
    const gov = new ThermalGovernor();
    feed(gov, 30, 0, 25); // baseline 30
    feed(gov, 50, 25, 45); // heat → L1
    expect(gov.decision.level).toBe(1);

    // Long cool stretch at 25 ms: slow EMA sinks and drags the baseline down.
    feed(gov, 25, 45, 165);
    expect(gov.decision.level).toBe(0);
    expect(gov.ratio).toBeCloseTo(1, 1);

    // The ORIGINAL 30 ms now reads as mild heat against the lowered baseline.
    feed(gov, 30, 165, 175);
    expect(gov.ratio).toBeGreaterThan(1.15);
    expect(gov.ratio).toBeLessThan(1.3);
    expect(gov.decision.level).toBe(0); // 1.2 < 1.5 — informational only
  });

  test('reset returns to level 0 with an unformed baseline', () => {
    const gov = new ThermalGovernor();
    feed(gov, 30, 0, 25);
    feed(gov, 90, 25, 60);
    expect(gov.decision.level).toBeGreaterThan(0);

    gov.reset();
    expect(gov.decision).toBe(THERMAL_LEVELS[0]);
    expect(gov.ratio).toBe(1);
    // Post-reset hot samples seed a NEW baseline regime instead of judging
    // against the old one.
    feed(gov, 200, 60, 70);
    expect(gov.decision.level).toBe(0);
    expect(gov.ratio).toBe(1); // baseline window not yet elapsed
  });

  test('minSamples guard: sparse pushes never judge even past the window', () => {
    const gov = new ThermalGovernor();
    // 10 pushes spread over 25 s: the 20 s baseline window elapses, but the
    // sample count stays below minSamples — a 6.7x jump must not register.
    feed(gov, 30, 0, 12.5, 2.5);
    feed(gov, 200, 12.5, 25, 2.5);
    expect(gov.decision.level).toBe(0);
    expect(gov.ratio).toBe(1);
  });

  test('ignores non-positive inference times', () => {
    const gov = new ThermalGovernor();
    feed(gov, 30, 0, 30);
    const before = gov.ratio;
    for (let i = 0; i < 50; i++) {
      gov.push(0, 30 + i / 15);
      gov.push(-5, 30 + i / 15);
    }
    expect(gov.ratio).toBe(before);
    expect(gov.decision.level).toBe(0);
  });
});
