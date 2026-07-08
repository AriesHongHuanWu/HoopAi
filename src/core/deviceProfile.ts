/**
 * Device performance profiling — per-model tuning defaults, with a graceful
 * path for unknown / future phones.
 *
 * THE PROBLEM this solves: the small-ball YOLOX-Tiny detector is ~5x the
 * compute of Nano. On an A15+ iPhone it runs real-time and its recall is
 * worth it; on an iPhone XR (A12) it crawls at ~2fps and STARVES the tracker
 * (an arc gets 3-4 samples, no fit, no arm). One global default can't be
 * right for both. So each device is classified into a capability TIER, and
 * each tier gets tuned defaults (input size, delegate, detection rate, which
 * heavy features are safe, and which model rung to START on so a known-slow
 * phone never wastes a second loading Tiny just to step back down to Nano).
 *
 * THREE SIGNALS, most-precise-first (this is what keeps it working on phones
 * that don't exist yet):
 *   1. iOS modelId ("iPhone11,8") — an exact, monotonic generation number.
 *      Future iPhones only ever INCREASE the major version, so `major >= 14`
 *      (A15+) auto-classifies `high` with zero maintenance.
 *   2. deviceYearClass + totalMemory — the Android path and the fallback when
 *      the model is unrecognised.
 *   3. A runtime inference-time benchmark ({@link tierFromBenchmarkMs}) — the
 *      ground truth. Whatever we GUESSED from the model string, the measured
 *      ms on THIS silicon wins for the model-rung decision. An unknown 2027
 *      phone that benchmarks fast is treated as `high` even though we've never
 *      heard of it.
 *
 * Pure + fully unit-tested; no expo-device import here (the caller passes
 * {@link DeviceSignals} in, so this stays testable off-device).
 */

/** Capability tier a device is tuned for. */
export type DeviceTier = 'entry' | 'mid' | 'high';

/** Ordered weakest→strongest, for comparisons. */
export const TIER_ORDER: readonly DeviceTier[] = ['entry', 'mid', 'high'];

/** Raw device facts (from expo-device), passed in so this module stays pure. */
export interface DeviceSignals {
  /** 'ios' | 'android' | null. */
  os: string | null;
  /** expo-device modelId, e.g. 'iPhone11,8' (XR) or an Android model code. */
  modelId: string | null;
  /** expo-device deviceYearClass — the device's capability "year". */
  deviceYearClass: number | null;
  /** expo-device totalMemory in BYTES. */
  totalMemoryBytes: number | null;
}

/** Which detector knobs + capability hints a tier recommends. */
export interface DeviceTuning {
  /** Detector input resolution. 'speed' = 416 (measured BETTER than 640 on the
   *  small-ball model, and half the cost — see settingsStore perfMode). */
  perfMode: 'quality' | 'speed';
  /** Compute delegate default. Entry stays on CPU (numerically safe + the
   *  Metal GPU degrades YOLOX on some older devices); mid/high try GPU. */
  detectorAccel: 'cpu' | 'gpu';
  /** Frame-analysis cadence gate. */
  detectionRate: 'auto' | 'battery' | 'max';
  /**
   * Which model rung to LOAD FIRST. 'nano' skips the doomed Tiny load on a
   * known-slow phone; 'tiny' starts on the high-recall model; 'auto' lets the
   * loader's runtime speed budget decide (used when the tier is uncertain).
   */
  startRung: 'nano' | 'tiny' | 'auto';
  /** Is the second pose model (form analysis) cheap enough to suggest here? */
  poseSafe: boolean;
  /** Is the ROI-zoom second detection pass affordable here? */
  roiZoomSafe: boolean;
}

/**
 * Per-tier tuning table. Note perfMode is 'speed' (416) across the board:
 * 416 tested more accurate AND faster than 640 on the small-ball model, so
 * the tier mostly varies the delegate, cadence, starting model, and which
 * heavy extras are on by default — not the input size.
 */
export const DEVICE_TUNING: Record<DeviceTier, DeviceTuning> = {
  entry: {
    perfMode: 'speed',
    detectorAccel: 'cpu',
    detectionRate: 'auto',
    startRung: 'nano',
    poseSafe: false,
    roiZoomSafe: false,
  },
  mid: {
    perfMode: 'speed',
    detectorAccel: 'gpu',
    detectionRate: 'auto',
    startRung: 'auto',
    poseSafe: false,
    roiZoomSafe: true,
  },
  high: {
    perfMode: 'speed',
    detectorAccel: 'gpu',
    detectionRate: 'max',
    startRung: 'tiny',
    poseSafe: true,
    roiZoomSafe: true,
  },
};

/** 1 GiB in bytes, for memory thresholds. */
const GB = 1024 * 1024 * 1024;

/**
 * Parse the major generation number out of an Apple modelId
 * ("iPhone11,8" → 11, "iPad13,4" → 13). Null when not an Apple identifier.
 */
export function appleMajor(modelId: string | null): number | null {
  if (!modelId) return null;
  const m = /^(iPhone|iPad|iPod)(\d+),\d+$/.exec(modelId);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify an iPhone by generation number. Mapping (chip → our floor is the
 * XR = A12):
 *   ≤11  A12/A11 and older (iPhone XR/XS, X, 8)      → entry
 *   12,13 A13/A14 (iPhone 11, 12, SE2)               → mid
 *   ≥14  A15+ (iPhone 13, 14, 15, 16 …)              → high  (future-proof:
 *        new iPhones only raise the number, so they land here automatically)
 */
function iphoneTier(major: number): DeviceTier {
  if (major <= 11) return 'entry';
  if (major <= 13) return 'mid';
  return 'high';
}

/**
 * Fallback classification from deviceYearClass + RAM — the Android path and
 * the last resort for an unrecognised Apple model. Conservative: when in
 * doubt, prefer the lower tier so a weak phone is never over-driven (the
 * runtime benchmark can still promote it).
 */
function tierFromYearAndMemory(
  yearClass: number | null,
  totalMemoryBytes: number | null,
): DeviceTier {
  const mem = totalMemoryBytes ?? 0;
  const yc = yearClass ?? 0;
  if (yc >= 2021 || mem >= 6 * GB) return 'high';
  if (yc >= 2019 || mem >= 4 * GB) return 'mid';
  if (yc > 0 || mem > 0) return 'entry';
  // No signal at all: 'mid' is the safe middle; the benchmark will correct it.
  return 'mid';
}

/**
 * STATIC device classification from model string / year / memory. This is the
 * first guess; {@link resolveTier} refines it with the runtime benchmark.
 */
export function classifyDevice(signals: DeviceSignals): DeviceTier {
  const major = appleMajor(signals.modelId);
  if (major !== null && /^iPhone/.test(signals.modelId ?? '')) {
    return iphoneTier(major);
  }
  // iPad: modern iPads are strong, but generations are noisy — lean on
  // year/memory, floored at 'mid' since even old supported iPads are capable.
  if (/^iPad/.test(signals.modelId ?? '')) {
    const t = tierFromYearAndMemory(signals.deviceYearClass, signals.totalMemoryBytes);
    return t === 'entry' ? 'mid' : t;
  }
  return tierFromYearAndMemory(signals.deviceYearClass, signals.totalMemoryBytes);
}

/**
 * The capability tier implied by a MEASURED single-frame inference time (ms)
 * of the Tiny model at 416. This is the ground-truth override: it needs no
 * model database, so it classifies phones that don't exist yet.
 *   ≤45ms  (~22fps+)  the Tiny model flies                → high
 *   ≤120ms (~8fps+)   Tiny is usable (tracker still fits)  → mid
 *   >120ms            Tiny starves the tracker             → entry (use Nano)
 * Mirrors YOLOX_TINY_MAX_MS (120) in useShotEngine so the two agree.
 */
export function tierFromBenchmarkMs(ms: number): DeviceTier {
  if (ms <= 45) return 'high';
  if (ms <= 120) return 'mid';
  return 'entry';
}

/** Lower of two tiers (weakest wins — the cautious choice). */
export function minTier(a: DeviceTier, b: DeviceTier): DeviceTier {
  return TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * Final tier for tuning decisions: the STATIC guess, corrected by the runtime
 * benchmark when one is available. The benchmark can only ever LOWER the tier
 * (a phone that measures slow is slow no matter what its model string claims —
 * thermal throttling, background load, an underclocked variant), never raise
 * it above the static guess, so a mislabelled fast benchmark on a genuinely
 * weak phone can't over-drive it. Unknown static (null benchmark) returns the
 * static guess unchanged.
 */
export function resolveTier(
  staticTier: DeviceTier,
  benchmarkMs: number | null,
): DeviceTier {
  if (benchmarkMs == null || !Number.isFinite(benchmarkMs) || benchmarkMs <= 0) {
    return staticTier;
  }
  return minTier(staticTier, tierFromBenchmarkMs(benchmarkMs));
}

/** Human label for the Settings display. */
export function tierLabel(tier: DeviceTier): string {
  switch (tier) {
    case 'entry':
      return 'Entry';
    case 'mid':
      return 'Balanced';
    case 'high':
      return 'High';
  }
}
