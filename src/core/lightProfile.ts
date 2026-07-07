/**
 * lightProfile — pure classification of scene luminance into a detection
 * profile ('bright' | 'dim' | 'dark').
 *
 * INPUT: the camera worklet's EMA'd mean-luma estimate, 0..1. It is the mean
 * GREEN-channel value of the detector input tensor (green ≈ luma for natural
 * scenes), sampled sparsely in the loop that already computes the input
 * min/max diagnostics, and compensated for the black 'contain' letterbox bars
 * (bars are excluded, so the value reflects the actual CONTENT brightness).
 *
 * THRESHOLD RATIONALE (0..1, gamma-encoded video — NOT linear light):
 * Camera auto-exposure targets mid-grey, so any scene the AE can properly
 * expose lands around 0.35–0.55 mean regardless of the actual lux — which is
 * why 'bright' is the default and the interesting boundaries sit LOW:
 *  - dark  < 0.16: the AE has maxed out its ISO/exposure headroom and the
 *    frame STILL renders under ~16% mean — a genuinely dark scene (night
 *    court, dim gym corner). This is the regime where a real ball's detector
 *    score sags into the 0.12–0.2 band and cold acquisition starts failing.
 *  - dim   < 0.28: the AE is visibly running out of headroom (evening,
 *    poorly lit gym) but detection still works — surfaced for diagnostics
 *    only; no gate is relaxed here.
 *  - bright ≥ 0.28: normally exposed scene.
 *
 * HYSTERESIS: ±0.02 around each boundary, applied against the PREVIOUS
 * profile, so a scene hovering at a threshold (EMA jitter, auto-exposure
 * hunting) cannot flap the profile — and with it the tracker's cold gate —
 * frame to frame. A transition therefore requires crossing the boundary by
 * the margin in the direction AWAY from the current profile.
 *
 * Pure TypeScript, no I/O — trivially unit-testable.
 */

export type LightProfile = 'bright' | 'dim' | 'dark';

/** Classification thresholds on the 0..1 mean-luma estimate (see file doc). */
export const LIGHT = {
  /** Below this the scene is genuinely dark (relaxed cold ball gate). */
  darkMax: 0.16,
  /** Below this (and ≥ darkMax) the scene is dim (diagnostic only). */
  dimMax: 0.28,
  /** Boundary hysteresis so the profile can't flap on EMA jitter. */
  hysteresis: 0.02,
} as const;

/**
 * Classifies a mean-luma estimate into a light profile.
 *
 * @param meanLuma 0..1 luma estimate (letterbox-compensated, EMA'd).
 * @param prev     The previous profile, enabling hysteresis: boundaries move
 *                 `LIGHT.hysteresis` AWAY from `prev`, so leaving a profile
 *                 requires clearing the boundary by the margin. Omit for a
 *                 stateless classification (e.g. display-only).
 */
export function classifyLight(
  meanLuma: number,
  prev?: LightProfile | null,
): LightProfile {
  const h = LIGHT.hysteresis;
  if (prev === 'dark') {
    // Stay dark until the luma clears the boundary by the margin.
    if (meanLuma < LIGHT.darkMax + h) return 'dark';
    return meanLuma < LIGHT.dimMax ? 'dim' : 'bright';
  }
  if (prev === 'dim') {
    if (meanLuma < LIGHT.darkMax - h) return 'dark';
    if (meanLuma < LIGHT.dimMax + h) return 'dim';
    return 'bright';
  }
  if (prev === 'bright') {
    if (meanLuma < LIGHT.darkMax - h) return 'dark';
    if (meanLuma < LIGHT.dimMax - h) return 'dim';
    return 'bright';
  }
  // No history: plain band classification.
  if (meanLuma < LIGHT.darkMax) return 'dark';
  if (meanLuma < LIGHT.dimMax) return 'dim';
  return 'bright';
}
