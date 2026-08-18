/**
 * The live overlay's per-frame work gate. TrajectoryOverlay is a full-screen
 * Skia canvas with six blur passes, so anything that ticks every display frame
 * repaints all of it; this rule is what keeps that repaint confined to the
 * phases that actually have motion to show.
 *
 * These tests pin the INTENT, not an implementation detail: a live shot and its
 * cooldown must keep animating (the ball glide and the landing-ghost fade both
 * read the display clock), and IDLE must not. Loosening the IDLE case would
 * silently restore a full-session 60–120 Hz blurred repaint alongside the
 * detector; tightening COOLDOWN would truncate the landing-ghost fade.
 */
import { isAnimatedPhase, type OverlayPhase } from '../overlayActivity';

describe('isAnimatedPhase', () => {
  it('animates while a shot is live — the ball glides between samples', () => {
    expect(isAnimatedPhase('SHOT_LIVE')).toBe(true);
  });

  it('keeps animating through COOLDOWN — the landing ghost fades over ~1.2s', () => {
    expect(isAnimatedPhase('COOLDOWN')).toBe(true);
  });

  it('does NOT animate in IDLE: nothing on screen is time-driven between shots', () => {
    expect(isAnimatedPhase('IDLE')).toBe(false);
  });

  it('covers every phase OverlayState can carry (a new phase must opt in)', () => {
    const all: OverlayPhase[] = ['IDLE', 'SHOT_LIVE', 'COOLDOWN'];
    expect(all.filter(isAnimatedPhase)).toEqual(['SHOT_LIVE', 'COOLDOWN']);
  });
});
