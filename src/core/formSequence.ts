/**
 * Motion-sequence capture + compact serialization for Form Studio.
 *
 * The {@link FormAnalyzer} (src/core/formAnalysis.ts) already detects the shot
 * phases and snapshots the single RELEASE pose. Form Studio needs the whole
 * MOTION — the shooter's body through dip → rise → release → follow-through —
 * so it can play the user's form back beside a reference form and annotate the
 * angle differences over time.
 *
 * {@link FormSequenceBuffer} does exactly that, ADDITIVELY: it consumes the
 * same per-frame poses the analyzer sees (fed alongside, never replacing it),
 * keeps a rolling window, and on finalize downsamples to a fixed ~24-frame
 * grid, normalizes each frame to the shooter's hip-center + body height (so
 * absolute pixel size cancels and any two shooters overlay directly), and
 * quantizes to a small int16 grid. The output {@link FormSequence} serializes
 * as flat ints, so a whole shot's motion adds only a few KB to formJson.
 *
 * IMPORTANT (honesty): these are 2D MoveNet keypoints. The studio ILLUSTRATES
 * depth with limb layering + parallax — it does NOT reconstruct real 3D.
 * Genuine 2D→3D lifting (a lifter model) is a future upgrade; nothing here
 * claims a true depth capture.
 *
 * Pure TypeScript: no I/O, no wall clock (time comes from frame timestamps).
 */
import { clamp } from './geometry';
import type {
  FormSequence,
  PoseFrame,
  PoseKeypoint,
  PoseKeypointName,
  ShootingHand,
} from './types';

// ---------------------------------------------------------------------------
// Encoding constants
// ---------------------------------------------------------------------------

/**
 * COCO-17 keypoint order the flat `data` array is packed in. Fixed and
 * exported so packer, unpacker and any renderer share one index mapping. This
 * is exactly MoveNet's output order (src/ml/poseParser.ts).
 */
export const SEQ_KEYPOINT_ORDER: readonly PoseKeypointName[] = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

/** Two coordinates (x, y) per keypoint. */
const DIMS = 2;
/** Ints per frame (17 keypoints × 2). */
export const SEQ_STRIDE = SEQ_KEYPOINT_ORDER.length * DIMS;

/**
 * Quantization scale: grid units per one body-height. Normalized coordinates
 * sit within roughly ±2 body-heights of the hip-center, so 8000 units/height
 * maps that into ±16000 — safely inside int16 range (±32767) with sub-pixel
 * resolution to spare.
 */
export const SEQ_SCALE = 8000;

/**
 * Sentinel for a keypoint that was missing/low-confidence in a frame. Chosen
 * below the int16 floor so it can never collide with a real quantized value.
 */
export const SEQ_MISSING = -32768;

/** Target downsampled frame count (~24 over the ~1.2 s window). */
export const SEQ_TARGET_FRAMES = 24;

/**
 * Shot-window duration to retain, seconds. The buffer keeps a rolling window
 * this long; on finalize the last {@link SEQ_TARGET_FRAMES} are sampled from
 * it. ~1.2 s comfortably spans dip → follow-through for a normal jumper.
 */
export const SEQ_WINDOW_SEC = 1.2;

/** Score gate below which a keypoint is treated as missing (matches FORM). */
const KP_SCORE_MIN = 0.3;

// ---------------------------------------------------------------------------
// Body-frame normalization
// ---------------------------------------------------------------------------

interface XY {
  x: number;
  y: number;
}

/** One buffered raw frame: timestamp + usable keypoints (px, analysis space). */
export interface RawSeqFrame {
  t: number;
  pts: Map<PoseKeypointName, XY>;
}

/**
 * Hip-center of a frame (midpoint of both hips; falls back to whichever hip is
 * present). Null when no hip is visible — such a frame can't be normalized.
 */
function hipCenter(pts: Map<PoseKeypointName, XY>): XY | null {
  const l = pts.get('left_hip');
  const r = pts.get('right_hip');
  if (l && r) return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  return l ?? r ?? null;
}

/**
 * A robust body-height estimate in pixels for one frame: vertical span from
 * the highest visible head/shoulder point to the lowest visible ankle/knee.
 * Falls back to the shoulder→hip trunk (×2.5, a coarse full-body estimate)
 * when the legs aren't visible. Returns null when too little is visible.
 */
function bodyHeightPx(pts: Map<PoseKeypointName, XY>): number | null {
  const top =
    pts.get('nose') ??
    pts.get('left_shoulder') ??
    pts.get('right_shoulder') ??
    null;
  const bottom =
    pts.get('left_ankle') ??
    pts.get('right_ankle') ??
    pts.get('left_knee') ??
    pts.get('right_knee') ??
    null;
  if (top && bottom) {
    const h = Math.abs(bottom.y - top.y);
    if (h > 1) return h;
  }
  // Trunk fallback: shoulder→hip is ~0.4 of standing height.
  const shoulder = pts.get('left_shoulder') ?? pts.get('right_shoulder') ?? null;
  const hip = pts.get('left_hip') ?? pts.get('right_hip') ?? null;
  if (shoulder && hip) {
    const trunk = Math.abs(hip.y - shoulder.y);
    if (trunk > 1) return trunk * 2.5;
  }
  return null;
}

// ---------------------------------------------------------------------------
// FormSequenceBuffer
// ---------------------------------------------------------------------------

/**
 * Rolling per-shot pose-sequence recorder. Feed EVERY frame's pose while a
 * shot is in progress (the same poses the FormAnalyzer receives), then call
 * {@link finalize} once the shot resolves and {@link reset} before the next.
 *
 * Allocation-light: keeps at most the frames inside {@link SEQ_WINDOW_SEC}.
 */
export class FormSequenceBuffer {
  private readonly hand: ShootingHand;
  private frames: RawSeqFrame[] = [];

  constructor(opts: { hand: ShootingHand }) {
    this.hand = opts.hand;
  }

  /** Feed one frame's pose. Low-confidence keypoints are dropped per frame. */
  push(pose: PoseFrame): void {
    const pts = new Map<PoseKeypointName, XY>();
    for (const name of SEQ_KEYPOINT_ORDER) {
      const kp: PoseKeypoint | undefined = pose.keypoints[name];
      if (
        kp &&
        kp.score >= KP_SCORE_MIN &&
        Number.isFinite(kp.x) &&
        Number.isFinite(kp.y)
      ) {
        pts.set(name, { x: kp.x, y: kp.y });
      }
    }
    // Ignore frames with no usable landmarks at all.
    if (pts.size === 0) return;
    this.frames.push({ t: pose.t, pts });
    this.pruneOld(pose.t);
  }

  /** Drop frames older than the retained window relative to the newest time. */
  private pruneOld(nowT: number): void {
    const cutoff = nowT - SEQ_WINDOW_SEC;
    // Frames arrive in time order; drop from the front.
    let i = 0;
    while (i < this.frames.length && this.frames[i]!.t < cutoff) i++;
    if (i > 0) this.frames = this.frames.slice(i);
  }

  /**
   * Build the compact {@link FormSequence} from the buffered window, or null
   * when too little was captured to be meaningful (fewer than 4 usable frames
   * or no frame with both a hip-center and a body-height estimate).
   *
   * Downsamples to at most {@link SEQ_TARGET_FRAMES} evenly across the window,
   * normalizes each frame to hip-center + body height, and quantizes.
   */
  finalize(): FormSequence | null {
    return buildSequence(this.frames, this.hand);
  }

  /** Clear buffered frames for the next shot. */
  reset(): void {
    this.frames = [];
  }

  /** Number of buffered frames (diagnostics/tests). */
  get length(): number {
    return this.frames.length;
  }
}

// ---------------------------------------------------------------------------
// Pure builders (exported for tests + non-streaming callers)
// ---------------------------------------------------------------------------

/**
 * Evenly pick up to `target` indices spanning [0, n). Always includes the
 * first and last so the motion's endpoints (dip start, follow-through end)
 * survive downsampling.
 */
function pickIndices(n: number, target: number): number[] {
  if (n <= target) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    out.push(Math.round((i * (n - 1)) / (target - 1)));
  }
  // De-dup (rounding can collide at the ends).
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

/** Quantize one normalized coordinate to the int16 grid. */
function quantize(v: number): number {
  const q = Math.round(v * SEQ_SCALE);
  return clamp(q, -32767, 32767);
}

/**
 * Core packer: takes raw (px) frames and produces a normalized, quantized
 * {@link FormSequence}. Exported so tests and any offline reprocessing can
 * build a sequence without the streaming buffer. Returns null on too-little
 * data.
 */
export function buildSequence(
  rawFrames: readonly RawSeqFrame[],
  hand: ShootingHand,
): FormSequence | null {
  if (rawFrames.length < 4) return null;
  const idx = pickIndices(rawFrames.length, SEQ_TARGET_FRAMES);
  const data: number[] = [];
  let kept = 0;
  for (const i of idx) {
    const f = rawFrames[i]!;
    const center = hipCenter(f.pts);
    const height = bodyHeightPx(f.pts);
    // A frame we can't anchor/scale contributes an all-missing row so the
    // timeline stays evenly spaced (renderers skip missing points).
    if (!center || !height || height <= 1) {
      for (let k = 0; k < SEQ_STRIDE; k++) data.push(SEQ_MISSING);
      continue;
    }
    kept++;
    for (const name of SEQ_KEYPOINT_ORDER) {
      const p = f.pts.get(name);
      if (!p) {
        data.push(SEQ_MISSING, SEQ_MISSING);
        continue;
      }
      const nx = (p.x - center.x) / height;
      const ny = (p.y - center.y) / height;
      data.push(quantize(nx), quantize(ny));
    }
  }
  if (kept < 4) return null;
  const t0 = rawFrames[idx[0]!]!.t;
  const t1 = rawFrames[idx[idx.length - 1]!]!.t;
  return {
    v: 1,
    hand,
    frames: idx.length,
    durationSec: Math.max(0, t1 - t0),
    data,
  };
}

// ---------------------------------------------------------------------------
// Decoding — for renderers (Form Studio)
// ---------------------------------------------------------------------------

/** One decoded frame: keypoint → normalized {x,y} (missing keypoints absent). */
export type DecodedFrame = Partial<Record<PoseKeypointName, XY>>;

/**
 * Decode a {@link FormSequence} back to per-frame normalized keypoint maps
 * (body-relative units, +y down, hip-center origin). Missing keypoints and
 * malformed/short `data` are handled gracefully — a corrupt persisted blob
 * yields whatever frames decode cleanly, never a throw.
 */
export function decodeSequence(seq: FormSequence): DecodedFrame[] {
  const out: DecodedFrame[] = [];
  const total = seq.frames;
  for (let f = 0; f < total; f++) {
    const frame: DecodedFrame = {};
    const base = f * SEQ_STRIDE;
    if (base + SEQ_STRIDE > seq.data.length) break;
    for (let k = 0; k < SEQ_KEYPOINT_ORDER.length; k++) {
      const xi = seq.data[base + k * DIMS]!;
      const yi = seq.data[base + k * DIMS + 1]!;
      if (xi === SEQ_MISSING || yi === SEQ_MISSING) continue;
      frame[SEQ_KEYPOINT_ORDER[k]!] = { x: xi / SEQ_SCALE, y: yi / SEQ_SCALE };
    }
    out.push(frame);
  }
  return out;
}
