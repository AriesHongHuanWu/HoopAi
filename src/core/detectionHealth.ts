/**
 * Detection health — pure derivations behind the live HUD health panel and
 * rim-lock beacon. Translates raw engine telemetry (EngineDebug fields,
 * OverlayState rim state) into user-facing tiers and copy.
 * Visual/informational only — nothing here feeds detection or judgment.
 */

export type SignalTier = 'good' | 'weak' | 'blind';

/**
 * Tier for the per-frame max class score. Thresholds (>0.3 good, >0.05 weak)
 * replicate the legacy DetectionHeartbeat in live.tsx exactly so the HUD
 * behavior is unchanged by the panel swap.
 */
export function signalTier(maxScore: number): SignalTier {
  return maxScore > 0.3 ? 'good' : maxScore > 0.05 ? 'weak' : 'blind';
}

export type FpsTier = 'smooth' | 'ok' | 'slow' | 'off';

/** Tier for effective analysis fps. */
export function fpsTier(fps: number): FpsTier {
  if (fps >= 20) return 'smooth';
  if (fps >= 10) return 'ok';
  if (fps > 0) return 'slow';
  return 'off';
}

export type LightTier = 'unmeasured' | 'dark' | 'dim' | 'good';

/**
 * Tier for the EMA'd scene luminance. Exactly 0 is the engine sentinel for
 * "never measured" (real pitch-black is floored to 0.0001 upstream), so it
 * must read as unmeasured, not dark.
 */
export function lightTier(light: number): LightTier {
  if (light === 0) return 'unmeasured';
  if (light >= 0.45) return 'good';
  if (light >= 0.2) return 'dim';
  return 'dark';
}

/**
 * Map the engine's free-form delegate label string to user words plus a
 * GPU/CPU suffix. Substring-tolerant on purpose: the raw label format is
 * load-bearing elsewhere and must be treated as read-only free text here.
 */
export function delegateLabel(delegate: string): string {
  const d = delegate.toLowerCase();
  if (d.includes('loading')) return 'Loading model…';
  const base = d.includes('nanov2')
    ? 'Compact model v2'
    : d.includes('nano')
      ? 'Compact model'
      : d.includes('tiny') || d.includes('yolox')
        ? 'Standard model'
        : d.includes('precise')
          ? 'High-accuracy model'
          : d.includes('fast') || d.includes('320')
            ? 'Lite model'
            : 'On-device model';
  const suffix =
    d.includes('gpu') || d.includes('metal') || d.includes('coreml') || d.includes('nnapi')
      ? ' · GPU'
      : d.includes('cpu')
        ? ' · CPU'
        : '';
  return base + suffix;
}

export type BeaconState = 'searching' | 'locking' | 'locked' | 'drift';

/**
 * Rim-lock beacon state. Precedence: drift always wins (the camera moved, a
 * stale lock must not read as healthy), then a held lock, then an in-flight
 * countdown, then searching.
 */
export function beaconState(i: {
  rimLocked: boolean;
  drift: boolean;
  countdown: number | null;
}): BeaconState {
  if (i.drift) return 'drift';
  if (i.rimLocked) return 'locked';
  if (i.countdown != null) return 'locking';
  return 'searching';
}

export interface HealthSnapshot {
  signal: SignalTier;
  fps: FpsTier;
  light: LightTier;
}

/**
 * One contextual tip for the expanded panel, or null when healthy.
 * Priority (first match wins): a blind signal is always the most actionable
 * problem, then darkness, then a slow device.
 */
export function healthTip(s: HealthSnapshot): string | null {
  if (s.signal === 'blind') return HEALTH_COPY.tipBlind;
  if (s.light === 'dark') return HEALTH_COPY.tipDark;
  if (s.fps === 'slow') return HEALTH_COPY.tipSlow;
  return null;
}

/** Every user-facing string of the health panel, in one place. */
export const HEALTH_COPY = {
  signalGood: 'Tracking',
  signalWeak: 'Weak signal',
  signalBlind: 'No detection',
  lightUnmeasured: 'Measuring light…',
  lightGood: 'Good light',
  lightDim: 'Dim — tracking may weaken',
  lightDark: 'Very dark — calls get harder',
  fpsSmooth: 'Smooth',
  fpsOk: 'Steady',
  fpsSlow: 'Slow',
  fpsOff: 'Starting…',
  beaconSearching: 'Scanning for rim…',
  beaconLocking: 'Locking on…',
  beaconLocked: 'Rim locked',
  beaconDrift: 'Camera moved — re-aiming',
  rowSignal: 'SIGNAL',
  rowLight: 'LIGHT',
  rowSpeed: 'SPEED',
  rowEngine: 'ENGINE',
  tipBlind: 'Point the camera so the hoop and ball are both in view.',
  tipDark: 'More light means better calls — brighten the court if you can.',
  tipSlow: 'This phone is working hard — closing other apps can speed up calls.',
} as const;
