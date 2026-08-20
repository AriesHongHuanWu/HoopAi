/**
 * liveTourRects — pure spotlight-rect math for the pre-lock live tour.
 *
 * Step 2 of the 'live' CoachMarks tour spotlights the ghost-rim aim zone that
 * AimingOverlay draws. That zone is pure math from the exported ghost-rim
 * constants (src/components/hud/PlacementGrade.tsx), so no measureInWindow
 * pass is needed: this module reproduces the overlay's geometry and pads it so
 * the spotlight ring frames the whole target zone rather than hugging the thin
 * rim silhouette.
 *
 * Geometry note: live.tsx sizes the ghost off the SHORTER view side
 * (`Math.min(width, height) * GHOST_RIM_WIDTH_FRAC`) so portrait and landscape
 * draw the same absolute target. This helper mirrors that — the spotlight must
 * frame what is actually on screen, in both orientations.
 *
 * Pure + deterministic: no I/O, no time, no react — unit-testable with exact
 * numbers. No clamping: callers pass real view dimensions.
 */
import type { LayoutRectangle } from 'react-native';

import {
  GHOST_RIM_ASPECT,
  GHOST_RIM_CENTER_Y_FRAC,
  GHOST_RIM_WIDTH_FRAC,
} from '@/components/hud/PlacementGrade';

/**
 * Spotlight padding around the ghost rim, per side, as a fraction of the rim
 * WIDTH. The rim silhouette is wide and shallow (aspect 0.4), so padding off
 * the width gives the ring comfortable breathing room on every side.
 */
export const AIM_RECT_PAD_FRAC = 0.6;

/**
 * The ghost-rim aim zone in view coordinates, padded for the spotlight ring.
 * Mirrors AimingOverlay's drawing math exactly, then pads by
 * {@link AIM_RECT_PAD_FRAC} x rim width on every side.
 */
export function ghostAimRect(viewWidth: number, viewHeight: number): LayoutRectangle {
  const rimW = Math.min(viewWidth, viewHeight) * GHOST_RIM_WIDTH_FRAC;
  const rimH = rimW * GHOST_RIM_ASPECT;
  const centerX = viewWidth / 2;
  const centerY = viewHeight * GHOST_RIM_CENTER_Y_FRAC;
  const pad = AIM_RECT_PAD_FRAC * rimW;
  return {
    x: centerX - rimW / 2 - pad,
    y: centerY - rimH / 2 - pad,
    width: rimW + 2 * pad,
    height: rimH + 2 * pad,
  };
}
