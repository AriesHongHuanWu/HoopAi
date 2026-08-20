/**
 * Stage3DStill — a 1080×1350 (4:5, feed-friendly) share still of the Form
 * Studio 3D stage, plus the never-throw share pipeline around it.
 *
 * ARCHITECTURE (mirrors ShareCard.tsx verbatim)
 * ---------------------------------------------
 * The still is a pure Skia element ({@link Stage3DStillGraphic}) rendered
 * fully offscreen via Skia 2.6's `drawAsImage(element, size)` — no hidden
 * Canvas needs to be mounted, and the snapshot is always exactly
 * STILL_W×STILL_H regardless of device pixel ratio. The graphic is HOOK-FREE:
 * drawAsImage runs Skia's offscreen reconciler where hooks crash (see
 * ShareCard.tsx).
 *
 * HONESTY BY RE-RENDERING (never a screenshot)
 * --------------------------------------------
 * The scene is RE-PROJECTED at export resolution with the SAME pure pose3d
 * functions the live stage uses (groundGrid / projectSkeleton / wristTrail /
 * sequenceGroundY), so the solid-vs-hollow joint coding, confidence-faded
 * bones, gap-skipping wrist trail and the dashed ghost all survive at print
 * resolution — and the mandatory "DEPTH INFERRED FROM BODY PROPORTIONS — NOT
 * MEASURED" stamp is baked into every exported pixel.
 *
 * TYPE: Skia can't see fonts loaded through expo-font, so text uses
 * `matchFont` against a condensed SYSTEM face — same approach as
 * ShareCard.tsx.
 *
 * SHARING: snapshot → PNG base64 → expo-file-system cache → RN Share.
 * iOS shares the image file directly; Android saves to the photo library
 * (best-effort) and shares the text caption. NEVER throws.
 */
import {
  Circle,
  DashPathEffect,
  Group,
  ImageFormat,
  Line,
  Rect,
  Text as SkText,
  drawAsImage,
  matchFont,
  vec,
  type SkFont,
} from '@shopify/react-native-skia';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import React from 'react';
import { Platform, Share } from 'react-native';

import { color } from '@/constants/tokens';
import {
  groundGrid,
  projectPoint,
  projectSkeleton,
  strokeWidthFor,
  type OrbitCamera,
} from '@/core/pose3d/camera3d';
import { SKELETON_BONES, type Frame3D, type LiftedSequence } from '@/core/pose3d/lift';
import { sequenceGroundY, wristTrail } from '@/core/pose3d/trail';
import type { PoseKeypointName, ShootingHand } from '@/core/types';

// ---------------------------------------------------------------------------
// Geometry constants (all drawing happens in this fixed design space)
// ---------------------------------------------------------------------------

/** 4:5 feed format — matches ShareCard's CARD_W/CARD_H (kept local on
 *  purpose so the two share graphics never couple). */
export const STILL_W = 1080;
export const STILL_H = 1350;

/** Stage viewport in card px; drawn inside a translateY(STAGE_TOP) group. */
const STAGE_VP = { w: 1080, h: 940 } as const;
const STAGE_TOP = 210;

/** Horizontal breathing room, same value as ShareCard's PAD. */
const PAD = 84;

// Stage styling — duplicated from FormStage3D.tsx (USER_STROKE 5 / REF_STROKE
// 3.5 / LOW_CONFIDENCE 0.55 at live scale), scaled up ~2.4× for the 1080px
// export canvas. LOW_CONFIDENCE is a threshold, not a stroke, so it copies
// unchanged.
const USER_STROKE = 12;
const REF_STROKE = 8;
const LOW_CONFIDENCE = 0.55;

// Wrist-trail rendering rules — same gap-skipping + fade rules as the live
// stage's trail ribbon (FormStage3D), at export scale: taper 4→8 px oldest→
// newest, opacity = age fade × confidence fade, capped at 0.8 so the trail
// always reads as an annotation under the skeleton, never as data.
const TRAIL_W_MIN = 4;
const TRAIL_W_MAX = 8;
const TRAIL_MAX_OPACITY = 0.8;

/** Bottom brand hook — duplicated from ShareCard.tsx (HOOK_TEXT) so every
 *  share leaves the app branded; keep the two strings in sync. */
const HOOK_TEXT = 'TRACK YOUR GAME · HOOPILOT';
/** "ILOT" picks up the accent, echoing the HOOP|ILOT header lockup
 *  (ShareCard's HOOK_ACCENT_INDEX trick, done as two measured SkText runs). */
const HOOK_ACCENT_INDEX = HOOK_TEXT.indexOf('ILOT');

/** MANDATORY honesty stamp — baked into every exported still. */
const HONESTY_STAMP = 'DEPTH INFERRED FROM BODY PROPORTIONS — NOT MEASURED';

// ---------------------------------------------------------------------------
// Fonts — condensed SYSTEM face via matchFont (Skia can't see expo-font
// faces; same approach and cache shape as ShareCard.tsx)
// ---------------------------------------------------------------------------

const DISPLAY_FAMILY = Platform.select({
  ios: 'Avenir Next Condensed',
  default: 'sans-serif-condensed',
});

const fontCache = new Map<number, SkFont>();

function displayFont(size: number): SkFont {
  let font = fontCache.get(size);
  if (font == null) {
    font = matchFont({
      fontFamily: DISPLAY_FAMILY,
      fontSize: size,
      fontStyle: 'normal',
      fontWeight: 'bold',
    });
    fontCache.set(size, font);
  }
  return font;
}

function textW(font: SkFont, text: string): number {
  return font.measureText(text).width;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** Everything the still needs, precomputed by the screen so drawing stays
 *  dumb. Labels arrive as final strings (the ≈ low-confidence prefix and
 *  ESTIMATED wording are the caller's responsibility to carry through). */
export interface Stage3DStillData {
  user: LiftedSequence;
  /** Ghost or compare-B skeleton; drawn dashed like the live stage. */
  reference?: LiftedSequence | null;
  /** Legend text, e.g. 'GHOST · CURRY-STYLE' or 'SHOT B · MISS'. */
  refLabel?: string | null;
  /** Scrub fraction 0..1 (same parent-clocked contract as FormStage3D). */
  pos: number;
  camera: OrbitCamera;
  hand: ShootingHand;
  /** Draw the wrist trail up to the scrub frame. */
  trail: boolean;
  /** e.g. 'SHOT 4 · MAKE'. */
  title: string;
  /** e.g. 'ELBOW ≈92° · KNEE 118° · FOREARM TILT 21°' or 'FRAME 12/24'. */
  subtitle: string;
  /** e.g. 'DEPTH CONFIDENCE: MEDIUM'. */
  confidenceLine: string;
}

// ---------------------------------------------------------------------------
// Scene helpers (pure)
// ---------------------------------------------------------------------------

/** Nearest-frame index at scrub fraction `pos` — the tiny frameAt rule
 *  duplicated from FormStage3D.tsx (a component must not be imported here). */
function frameIndexAt(frameCount: number, pos: number): number {
  if (frameCount === 0) return 0;
  return Math.min(frameCount - 1, Math.max(0, Math.round(pos * (frameCount - 1))));
}

/** A projected 2D segment ready to draw. */
interface Seg2D {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface BoneDraw extends Seg2D {
  kind: 'ref' | 'user';
  strokeWidth: number;
  opacity: number;
}

interface TrailDraw extends Seg2D {
  strokeWidth: number;
  opacity: number;
}

interface DotDraw {
  x: number;
  y: number;
  r: number;
  solid: boolean;
}

// ---------------------------------------------------------------------------
// The graphic — a pure, HOOK-FREE Skia element in STILL_W×STILL_H space
// ---------------------------------------------------------------------------

/**
 * The still itself. Renderable inside any `<Canvas>` or offscreen via
 * `drawAsImage`. No hooks (plain consts only) — Skia's offscreen reconciler
 * cannot run them.
 */
export function Stage3DStillGraphic({
  data,
}: {
  data: Stage3DStillData;
}): React.JSX.Element {
  const { user, reference, camera, hand } = data;
  const vp = STAGE_VP;

  // Shared ground-plane rule — byte-identical floor height to the live stage.
  const groundY = sequenceGroundY(user);

  const curIdx = frameIndexAt(user.frames.length, data.pos);
  const userFrame: Frame3D = user.frames[curIdx] ?? {};
  const refFrame: Frame3D | null = reference
    ? (reference.frames[frameIndexAt(reference.frames.length, data.pos)] ?? {})
    : null;

  // Ground grid on the ankle plane (axis cross omitted — cleaner print).
  const grid: Seg2D[] = groundGrid(camera, vp, { y: groundY, extent: 1.2, step: 0.3 }).map(
    ([a, b]) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }),
  );

  // Wrist trail — estimated pose path, never ball tracking. wristTrail only
  // returns frames where the wrist existed; segments additionally connect
  // ADJACENT source frames only, so a detection dropout stays a visible gap
  // (never bridged — honesty).
  const trail: TrailDraw[] = [];
  if (data.trail) {
    const pts = wristTrail(user, hand, curIdx);
    const segCount = pts.length - 1;
    for (let k = 0; k < segCount; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      if (b.frame !== a.frame + 1) continue;
      const pa = projectPoint(a, camera, vp);
      const pb = projectPoint(b, camera, vp);
      if (!pa || !pb) continue;
      // t: 0 = oldest segment, 1 = newest (at the current frame).
      const t = segCount > 1 ? k / (segCount - 1) : 1;
      trail.push({
        x1: pa.x,
        y1: pa.y,
        x2: pb.x,
        y2: pb.y,
        strokeWidth: TRAIL_W_MIN + (TRAIL_W_MAX - TRAIL_W_MIN) * t,
        // Age fade × depth-confidence fade, capped below full opacity — the
        // EXACT live formula from FormStage3D (incl. its +0.25 confidence
        // grace) so a trail the user sees on screen survives into the still.
        opacity: Math.min(
          TRAIL_MAX_OPACITY,
          (0.2 + 0.5 * t) * Math.min(1, Math.min(a.c, b.c) + 0.25),
        ),
      });
    }
  }

  // ONE painter-sorted pass across BOTH skeletons so ghost and user bones
  // occlude each other correctly — exact port of FormStage3D's merged sort.
  const refSegs = refFrame ? projectSkeleton(refFrame, SKELETON_BONES, camera, vp) : [];
  const userSegs = projectSkeleton(userFrame, SKELETON_BONES, camera, vp);
  const bones: BoneDraw[] = [
    ...refSegs.map((seg) => ({ seg, kind: 'ref' as const })),
    ...userSegs.map((seg) => ({ seg, kind: 'user' as const })),
  ]
    .sort((a, b) => b.seg.depth - a.seg.depth)
    .map(({ seg, kind }) => ({
      x1: seg.a.x,
      y1: seg.a.y,
      x2: seg.b.x,
      y2: seg.b.y,
      kind,
      strokeWidth: strokeWidthFor(seg.depth, camera, kind === 'user' ? USER_STROKE : REF_STROKE),
      // Low-confidence user bones read fainter — a visible honesty cue.
      opacity: kind === 'user' ? Math.min(1, 0.45 + seg.c) : 1,
    }));

  // User joints only (the ghost stays a clean dashed outline). Hollow ring
  // below the confidence gate = "this joint's depth is estimated".
  const joints: DotDraw[] = [];
  for (const name of Object.keys(userFrame) as PoseKeypointName[]) {
    const j = userFrame[name];
    if (!j) continue;
    const p = projectPoint(j, camera, vp);
    if (!p) continue;
    joints.push({
      x: p.x,
      y: p.y,
      r: strokeWidthFor(p.depth, camera, USER_STROKE) * 0.75,
      solid: j.c >= LOW_CONFIDENCE,
    });
  }

  // Heads — the lift has no eye/ear depth, so a circle at the nose.
  const headAt = (frame: Frame3D, base: number): { x: number; y: number; r: number } | null => {
    const nose = frame.nose;
    if (!nose) return null;
    const p = projectPoint(nose, camera, vp);
    if (!p) return null;
    return { x: p.x, y: p.y, r: strokeWidthFor(p.depth, camera, base) * 1.6 };
  };
  const userHead = headAt(userFrame, USER_STROKE);
  const refHead = refFrame ? headAt(refFrame, REF_STROKE) : null;

  // Type — every x centered from measureText, no hardcoded text widths.
  const eyebrowFont = displayFont(30);
  const titleFont = displayFont(76);
  const subtitleFont = displayFont(40);
  const confFont = displayFont(30);
  const stampFont = displayFont(28);
  const legendFont = displayFont(28);
  const hookFont = displayFont(34);

  const eyebrow = 'FORM STUDIO 3D · ESTIMATED RECONSTRUCTION';
  const eyebrowX = (STILL_W - textW(eyebrowFont, eyebrow)) / 2;
  const titleX = (STILL_W - textW(titleFont, data.title)) / 2;
  const subtitleX = (STILL_W - textW(subtitleFont, data.subtitle)) / 2;
  const confX = (STILL_W - textW(confFont, data.confidenceLine)) / 2;
  const stampX = (STILL_W - textW(stampFont, HONESTY_STAMP)) / 2;

  // Brand hook split into two measured runs so 'ILOT' takes the accent.
  const hookPrefix = HOOK_TEXT.slice(0, HOOK_ACCENT_INDEX);
  const hookAccent = HOOK_TEXT.slice(HOOK_ACCENT_INDEX);
  const hookPrefixW = textW(hookFont, hookPrefix);
  const hookX = (STILL_W - (hookPrefixW + textW(hookFont, hookAccent))) / 2;

  // Dashed-sample legend, top-right of the stage area (only with a ref).
  const legendLabel = data.refLabel;
  const LEGEND_SAMPLE_W = 48;
  const LEGEND_GAP = 16;
  const legendTextW = legendLabel != null ? textW(legendFont, legendLabel) : 0;
  const legendX = STILL_W - PAD - (LEGEND_SAMPLE_W + LEGEND_GAP + legendTextW);
  const legendBaselineY = 48; // inside the stage group (card y ≈ 258)

  return (
    <Group>
      {/* Full-bleed coal background. */}
      <Rect x={0} y={0} width={STILL_W} height={STILL_H} color={color.bg} />

      {/* Header. */}
      <SkText x={eyebrowX} y={96} text={eyebrow} font={eyebrowFont} color={color.textDim} />
      <SkText x={titleX} y={176} text={data.title} font={titleFont} color={color.text} />

      {/* Stage — re-projected at export resolution, never screenshotted. */}
      <Group transform={[{ translateY: STAGE_TOP }]}>
        {grid.map((ln, i) => (
          <Line
            key={`g-${i}`}
            p1={vec(ln.x1, ln.y1)}
            p2={vec(ln.x2, ln.y2)}
            strokeWidth={2}
            color={color.ghostTint}
          />
        ))}

        {/* Wrist trail — under the skeletons. */}
        {trail.map((s, i) => (
          <Line
            key={`t-${i}`}
            p1={vec(s.x1, s.y1)}
            p2={vec(s.x2, s.y2)}
            strokeWidth={s.strokeWidth}
            strokeCap="round"
            color={color.accent}
            opacity={s.opacity}
          />
        ))}

        {/* Both skeletons, far→near from the single merged sort. */}
        {bones.map((b, i) =>
          b.kind === 'ref' ? (
            <Line
              key={`b-${i}`}
              p1={vec(b.x1, b.y1)}
              p2={vec(b.x2, b.y2)}
              strokeWidth={b.strokeWidth}
              strokeCap="round"
              color={color.ghost}
            >
              <DashPathEffect intervals={[10, 10]} />
            </Line>
          ) : (
            <Line
              key={`b-${i}`}
              p1={vec(b.x1, b.y1)}
              p2={vec(b.x2, b.y2)}
              strokeWidth={b.strokeWidth}
              strokeCap="round"
              color={color.accent}
              opacity={b.opacity}
            />
          ),
        )}

        {/* User joints: filled = trusted depth, hollow ring = estimated. */}
        {joints.map((j, i) =>
          j.solid ? (
            <Circle key={`j-${i}`} cx={j.x} cy={j.y} r={j.r} color={color.accent} />
          ) : (
            <Circle
              key={`j-${i}`}
              cx={j.x}
              cy={j.y}
              r={j.r}
              style="stroke"
              strokeWidth={5}
              color={color.accent}
            />
          ),
        )}

        {/* Heads. */}
        {refHead && (
          <Circle
            cx={refHead.x}
            cy={refHead.y}
            r={refHead.r}
            style="stroke"
            strokeWidth={5}
            color={color.ghost}
          >
            <DashPathEffect intervals={[10, 10]} />
          </Circle>
        )}
        {userHead && (
          <Circle
            cx={userHead.x}
            cy={userHead.y}
            r={userHead.r}
            style="stroke"
            strokeWidth={7}
            color={color.accent}
          />
        )}

        {/* Dashed legend for the ghost / shot-B skeleton. */}
        {legendLabel != null && (
          <>
            <Line
              p1={vec(legendX, legendBaselineY - 10)}
              p2={vec(legendX + LEGEND_SAMPLE_W, legendBaselineY - 10)}
              strokeWidth={4}
              strokeCap="round"
              color={color.ghost}
            >
              <DashPathEffect intervals={[10, 10]} />
            </Line>
            <SkText
              x={legendX + LEGEND_SAMPLE_W + LEGEND_GAP}
              y={legendBaselineY}
              text={legendLabel}
              font={legendFont}
              color={color.ghost}
            />
          </>
        )}
      </Group>

      {/* Readouts + the mandatory honesty stamp. */}
      <SkText x={subtitleX} y={1190} text={data.subtitle} font={subtitleFont} color={color.textDim} />
      <SkText
        x={confX}
        y={1240}
        text={data.confidenceLine}
        font={confFont}
        color={color.textFaint}
      />
      <SkText x={stampX} y={1284} text={HONESTY_STAMP} font={stampFont} color={color.textFaint} />

      {/* Bottom brand hook — 'ILOT' in the accent, echoing the app lockup. */}
      <SkText x={hookX} y={1330} text={hookPrefix} font={hookFont} color={color.textDim} />
      <SkText
        x={hookX + hookPrefixW}
        y={1330}
        text={hookAccent}
        font={hookFont}
        color={color.accent}
      />
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Share pipeline (never throws)
// ---------------------------------------------------------------------------
// Never-throw share pipeline — duplicated from ShareCard.tsx (shareCardImage)
// because its helpers are module-private; keep the two in sync.

const FALLBACK =
  'My shooting form in 3D — estimated reconstruction, built on-device. TRACK YOUR GAME · HOOPILOT';

async function shareText(message: string): Promise<boolean> {
  try {
    await Share.share({ message });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort save to the photo library (Android path). Never throws. */
async function saveToLibrary(uri: string): Promise<void> {
  try {
    // writeOnly → add-only scope where the platform supports it.
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) return;
    await MediaLibrary.saveToLibraryAsync(uri);
  } catch (err) {
    console.warn('[stage3dStill] Could not save still to library', err);
  }
}

/**
 * Render `data` to a PNG and hand it to the native share sheet.
 * iOS: shares the image file. Android: saves the still to Photos
 * (best-effort) and shares the text caption. Any failure anywhere falls back
 * to a plain text share; resolves false only when even that failed.
 * NEVER throws; always resolves a boolean.
 */
export async function shareStage3DStill(data: Stage3DStillData): Promise<boolean> {
  try {
    const image = await drawAsImage(<Stage3DStillGraphic data={data} />, {
      width: STILL_W,
      height: STILL_H,
    });
    const base64 = image?.encodeToBase64(ImageFormat.PNG);
    const dir = FileSystem.cacheDirectory;
    if (image == null || base64 == null || base64.length === 0 || dir == null) {
      return shareText(FALLBACK);
    }
    const uri = `${dir}hoopai-3d-${Date.now()}.png`;
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });
    if (Platform.OS === 'ios') {
      await Share.share({ url: uri });
      return true;
    }
    await saveToLibrary(uri);
    return shareText(FALLBACK);
  } catch (err) {
    console.warn('[stage3dStill] share failed, falling back to text', err);
    return shareText(FALLBACK);
  }
}
