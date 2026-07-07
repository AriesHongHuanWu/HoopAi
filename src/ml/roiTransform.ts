/**
 * Pure coordinate helpers for the rim-anchored ROI ("digital zoom") second
 * detection pass (see the ROI block in useShotEngine.ts).
 *
 * Kept out of the camera worklet so the math is unit-testable OFF-device (the
 * worklet's TFLite/GPU parts cannot be). Both functions are marked 'worklet' so
 * the frame processor can call them directly — Reanimated captures imported
 * 'worklet' functions into the frame-processor runtime, exactly like the parser
 * does with nmsPerClass / parseYoloOutput.
 *
 * All coordinates are ANALYSIS-FRAME px: the detInputSize×detInputSize
 * letterboxed square the detector runs on and the tracker consumes. The ROI
 * pass crops a SQUARE sub-region of that space, upscales it to a full
 * detInputSize² detector input, runs the detector again, then maps the returned
 * boxes back into this same analysis-frame space so they merge cleanly with the
 * full-frame detections.
 */
import type { Box } from '../core/types';

/** A clamped square crop rectangle in analysis-frame px. */
export interface CropRect {
  /** Top-left x, clamped so the square stays inside the frame: [0, S-rs]. */
  rx: number;
  /** Top-left y, clamped so the square stays inside the frame: [0, S-rs]. */
  ry: number;
  /** Side length of the square, in (0, S]. */
  rs: number;
}

/**
 * A SQUARE crop centered on `hoop`, clamped inside an S×S frame.
 *
 * Square (not the hoop's own aspect) so the upscale to the detector input is a
 * single uniform zoom with NO internal letterbox — matching the detector's
 * square training input and keeping the back-map a single scale. The side is
 * `min(S, max(hoop.width, hoop.height))` so a tall or wide hoopRoi is still
 * fully covered, and the square never exceeds the frame. The top-left is
 * clamped into `[0, S-rs]` so the crop never straddles the letterbox bars.
 */
export function squareCropRect(hoop: Box, S: number): CropRect {
  'worklet';
  const cx = hoop.x + hoop.width / 2;
  const cy = hoop.y + hoop.height / 2;
  const rs = Math.min(S, Math.max(hoop.width, hoop.height));
  const rx = Math.max(0, Math.min(S - rs, Math.round(cx - rs / 2)));
  const ry = Math.max(0, Math.min(S - rs, Math.round(cy - rs / 2)));
  return { rx, ry, rs };
}

/**
 * Map a detection box from the ROI pass's `Sroi`×`Sroi` output space back into
 * analysis-frame px.
 *
 * The crop (rx, ry, rs) was upscaled by z = Sroi / rs, so the inverse is a
 * single scale by rs / Sroi plus the crop origin. No letterbox term because the
 * crop was forced square before upscaling (uniform scale, zero crop offset).
 */
export function remapRoiBox(box: Box, rx: number, ry: number, rs: number, Sroi: number): Box {
  'worklet';
  const inv = rs / Sroi;
  return {
    x: rx + box.x * inv,
    y: ry + box.y * inv,
    width: box.width * inv,
    height: box.height * inv,
  };
}
