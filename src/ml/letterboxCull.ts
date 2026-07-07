/**
 * Letterbox phantom cull.
 *
 * The detector input is the camera frame 'contain'-fitted into an S×S square:
 * the content is CENTERED and the leftover space is black bars (left/right in
 * portrait, top/bottom in landscape — see overlayMapping.ts for the same
 * geometry on the drawing side). The model was never trained on black padding
 * and regularly hallucinates detections there — most damagingly 'person'
 * boxes hugging the frame edge, which used to leak into the shot FSM.
 *
 * Nothing physical can be detected in the bars, so any detection whose CENTER
 * lies outside the content rect (plus a small rounding margin) is dropped —
 * every class, before anything downstream (ROI recall gate, tracker, FSM,
 * HUD) sees it. A real object half-off the frame edge keeps its center inside
 * the content rect and survives.
 *
 * Kept out of the camera worklet so the math is unit-testable OFF-device;
 * marked 'worklet' so the frame processor captures it, like roiTransform.ts.
 */
import type { Detection } from '../core/types';

/** Margin around the content rect, as a fraction of S, tolerating resize rounding. */
export const LETTERBOX_CULL_MARGIN_FRAC = 0.01;

/**
 * Drop detections whose center sits in the letterbox padding.
 *
 * @param dets Detections in analysis-square px (the S×S detector space).
 * @param S    Analysis square side (detector input size).
 * @param srcW Source camera-frame width (display-oriented).
 * @param srcH Source camera-frame height (display-oriented).
 * @returns The same array if nothing was culled (no realloc on the hot path).
 */
export function cullLetterboxDetections(
  dets: readonly Detection[],
  S: number,
  srcW: number,
  srcH: number,
): readonly Detection[] {
  'worklet';
  // Unknown/degenerate source dims ⇒ can't place the bars; cull nothing.
  if (S <= 0 || srcW <= 0 || srcH <= 0) return dets;
  const scale = S / Math.max(srcW, srcH);
  const margin = S * LETTERBOX_CULL_MARGIN_FRAC;
  // Content rect is centered, so the far edge mirrors the near one.
  const x0 = (S - srcW * scale) / 2 - margin;
  const y0 = (S - srcH * scale) / 2 - margin;
  const x1 = S - x0;
  const y1 = S - y0;
  let kept: Detection[] | null = null;
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i]!;
    const cx = d.box.x + d.box.width / 2;
    const cy = d.box.y + d.box.height / 2;
    const inside = cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    if (!inside && kept === null) {
      // First cull: copy the survivors so far, then keep filtering.
      kept = [];
      for (let j = 0; j < i; j++) kept.push(dets[j]!);
    } else if (inside && kept !== null) {
      kept.push(d);
    }
  }
  return kept ?? dets;
}
