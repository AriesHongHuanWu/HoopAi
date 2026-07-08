/**
 * Shared analysis→view coordinate mapping for the live HUD overlays
 * (TrajectoryOverlay + DetectionBoxes). Keeping it in one worklet guarantees the
 * trajectory, ball, rim and debug boxes all land on the exact same pixels.
 *
 * THE TWO LETTERBOXES
 * -------------------
 * The detector input (useShotEngine resizer) and the <Camera> preview BOTH use
 * scaleMode 'contain': the SAME camera frame is letterboxed into
 *   - the S×S analysis square (S = max(frameW, frameH)), and
 *   - the on-screen view (w×h).
 * A detection arrives in analysis-square px. To draw it we invert the analysis
 * letterbox (analysis px → frame fraction) and apply the preview letterbox
 * (frame fraction → view px). Because both are uniform, centered scales of the
 * same-aspect frame, the composition collapses to ONE uniform scale + centering
 * offset — so callers just do `view = analysis * scale + offset` on both axes.
 *
 * This replaces the old scaleMode:'cover' mapping that assumed a hardcoded 9:16
 * portrait source and a center-square crop — which put the analysis square on
 * the wrong region and, in landscape, cropped the hoop out of the model input
 * entirely. The mapping is orientation-correct because it reads the REAL source
 * frame dimensions (OverlayState.srcW/srcH) instead of guessing.
 */
import type { OverlayState } from '../../camera/useShotEngine';

export interface Mapping {
  ok: boolean;
  /** Uniform analysis-px → view-px scale. */
  scale: number;
  /** View-px offset on x/y after scaling. */
  ox: number;
  oy: number;
}

/**
 * Compose the analysis 'contain' letterbox (into the S×S square) with the
 * preview 'contain' letterbox (into the w×h view). Pure worklet.
 */
export function mapAnalysisToView(o: OverlayState, view: { w: number; h: number }): Mapping {
  'worklet';
  const { w, h } = view;
  const S = Math.max(o.frameW, o.frameH); // analysis square side
  let sw = o.srcW;
  let sh = o.srcH;
  if (w <= 0 || h <= 0 || S <= 0 || sw <= 0 || sh <= 0) {
    return { ok: false, scale: 0, ox: 0, oy: 0 };
  }
  // srcW/srcH come from the physically-rotated buffer (enablePhysicalBufferRotation
  // + orientationSource "interface"), so they are display-oriented and normally
  // match the view orientation exactly. This swap is a defensive fallback: if a
  // device ever delivers sensor-oriented dims, align the aspect to what's on
  // screen so boxes still land in the right-shaped region.
  if (w > h !== sw > sh) {
    const t = sw;
    sw = sh;
    sh = t;
  }
  // 'contain' into the square: the longer source side maps to S.
  const scaleA = S / Math.max(sw, sh);
  // 'contain' into the view: fit the whole frame, so the tighter axis wins.
  const scaleV = Math.min(w / sw, h / sh);
  const k = scaleV / scaleA; // analysis px → view px
  const cxA0 = (S - sw * scaleA) / 2;
  const cyA0 = (S - sh * scaleA) / 2;
  const cxV0 = (w - sw * scaleV) / 2;
  const cyV0 = (h - sh * scaleV) / 2;
  return { ok: true, scale: k, ox: cxV0 - cxA0 * k, oy: cyV0 - cyA0 * k };
}

/**
 * Invert {@link mapAnalysisToView}: a VIEW-px point (e.g. a court-calibration
 * tap on the live preview) → ANALYSIS-square px, the space the detector, rim
 * boxes and the court homography all live in. Returns null for a bad mapping.
 */
export function mapViewToAnalysis(
  m: Mapping,
  viewX: number,
  viewY: number,
): { x: number; y: number } | null {
  'worklet';
  if (!m.ok || m.scale === 0) return null;
  return { x: (viewX - m.ox) / m.scale, y: (viewY - m.oy) / m.scale };
}
