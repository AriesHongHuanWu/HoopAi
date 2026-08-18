/**
 * The ONE rule for when the live HUD overlay is allowed to do PER-FRAME work.
 *
 * WHY this exists as a named, tested rule rather than two inline `phase ===`
 * checks: TrajectoryOverlay is a full-screen Skia canvas carrying six BlurMask
 * passes. Any prop that changes every display frame forces the whole picture to
 * be re-recorded and repainted — so a single free-running animated value kept
 * that blurred canvas repainting at 60–120 Hz for the ENTIRE camera session,
 * competing with the detector and the camera preview for the same GPU, even
 * with no ball, no rim and nothing drawn. Two independent things had to be
 * gated on the same condition (the ambient pulse and the display clock that
 * feeds the ball-glide extrapolation), and they must never drift apart:
 * gating one but not the other buys nothing, because either one alone still
 * dirties the canvas every frame.
 *
 * The rule itself: only a live or cooling shot has per-frame motion to show.
 *   - SHOT_LIVE — the ball glides between detection samples, the rim wash and
 *     the landing-ghost crosshair throb.
 *   - COOLDOWN  — the latched landing ghost fades out over ~1.2 s.
 *   - IDLE      — nothing on screen is time-driven. The rim lock-on brackets
 *     and the idle ball reticle sit at their base opacity, which is exactly
 *     the look this overlay already ships under reduced motion.
 *
 * Pure + worklet-safe so both the UI-thread frame callback and the animated
 * reaction can call it, and so it can be unit-tested without Skia or the
 * Reanimated runtime.
 */
import type { OverlayState } from '../../camera/useShotEngine';

export type OverlayPhase = OverlayState['phase'];

/**
 * True when the overlay has real per-frame work to do for this FSM phase.
 *
 * Correctness note: this gates DISPLAY only. It never reads, feeds or delays
 * anything the detector or the shot FSM sees — the overlay is downstream of
 * both, and every judgment still happens on the detection frames themselves.
 */
export function isAnimatedPhase(phase: OverlayPhase): boolean {
  'worklet';
  return phase === 'SHOT_LIVE' || phase === 'COOLDOWN';
}
