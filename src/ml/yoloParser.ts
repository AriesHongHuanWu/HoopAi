/**
 * Parser for Ultralytics-style detection outputs (YOLOv8/11/26 family).
 *
 * On-device, the exported TFLite output can be EITHER layout:
 *   - channels-first  [1, 4+nc, N]  → value(row,i) = data[row*N + i]
 *   - channels-last   [1, N, 4+nc]  → value(row,i) = data[i*(4+nc) + row]
 * We can't know which until it runs on a device, so we parse BOTH and keep the
 * one that yields more valid boxes (self-healing). Coords may be normalized
 * 0..1 or pixel 0..inputSize — auto-detected too.
 *
 * The trained HoopAI model has 4 classes (see docs/MODELS.md):
 *   0 ball, 1 rim, 2 ball_in_basket, 3 person
 */
import type { DetClass, Detection, FrameDebug, FrameDetections } from '../core/types';

// Path B model: YOLO11n trained on merged Roboflow datasets (mAP50 ~0.84),
// 4 classes matching the full make/miss pipeline.
export const CLASS_ORDER: readonly DetClass[] = ['ball', 'rim', 'ball_in_basket', 'person'];

export interface YoloParseOptions {
  /** Detector input side in px (boxes are emitted in this pixel space). */
  inputSize: number;
  /** Minimum score to keep a raw box before NMS. */
  scoreMin?: number;
  /** IoU threshold for class-wise NMS. */
  iouThreshold?: number;
  /** Max detections returned after NMS. */
  maxDetections?: number;
  /** Model emits normalized 0..1 coords instead of pixels (auto when undefined). */
  normalized?: boolean;
}

interface Extracted {
  raw: Detection[];
  maxScore: number;
  coordMax: number;
}

function extract(
  data: Float32Array,
  nc: number,
  n: number,
  rows: number,
  channelsFirst: boolean,
  inputSize: number,
  scoreMin: number,
  normalized: boolean | undefined,
): Extracted {
  'worklet';
  // value(row, i)
  const val = (row: number, i: number): number =>
    channelsFirst ? data[row * n + i]! : data[i * rows + row]!;

  let coordMax = 0;
  for (let i = 0; i < n; i++) {
    const v = val(0, i);
    if (Number.isFinite(v) && v > coordMax) coordMax = v;
  }
  const scale =
    normalized === undefined
      ? coordMax <= 2
        ? inputSize
        : 1
      : normalized
        ? inputSize
        : 1;

  const raw: Detection[] = [];
  let maxScore = 0;
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < nc; c++) {
      const s = val(4 + c, i);
      // NaN guard: a corrupted/garbage tensor read (bad delegate output,
      // uninitialized memory) must never win best-class or poison maxScore —
      // every comparison against NaN is false, so an unguarded `s > bestScore`
      // silently skips NaN (safe), but `bestScore > maxScore` below runs on
      // whatever bestScore settled on and needs the same protection.
      if (Number.isFinite(s) && s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (bestScore > maxScore) maxScore = bestScore;
    if (best < 0 || bestScore < scoreMin) continue;
    const cx = val(0, i) * scale;
    const cy = val(1, i) * scale;
    const w = val(2, i) * scale;
    const h = val(3, i) * scale;
    // Bounds/NaN guard: reject boxes with non-finite geometry or degenerate
    // size before they reach NMS/the tracker (a single garbage box can other-
    // wise propagate Infinity/NaN into IoU math and the Kalman filter).
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue;
    }
    if (w <= 0 || h <= 0) continue;
    raw.push({
      cls: CLASS_ORDER[best]!,
      score: bestScore,
      box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
    });
  }
  return { raw, maxScore, coordMax };
}

function iou(a: Detection, b: Detection): number {
  'worklet';
  const ax2 = a.box.x + a.box.width;
  const ay2 = a.box.y + a.box.height;
  const bx2 = b.box.x + b.box.width;
  const by2 = b.box.y + b.box.height;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.box.x, b.box.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.box.y, b.box.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const union = a.box.width * a.box.height + b.box.width * b.box.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy class-wise non-maximum suppression, highest score first. */
export function nmsPerClass(dets: Detection[], iouThreshold: number): Detection[] {
  'worklet';
  // Common case after the score gate: 0 or 1 raw detection. Nothing to
  // suppress, so skip the sort/allocate/compare work entirely (this runs
  // every analysed frame on the worklet thread).
  if (dets.length <= 1) return dets;

  const out: Detection[] = [];
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  for (const d of sorted) {
    let keep = true;
    for (const k of out) {
      if (k.cls === d.cls && iou(k, d) > iouThreshold) {
        keep = false;
        break;
      }
    }
    if (keep) out.push(d);
  }
  return out;
}

// Layout self-detection is a per-BUILD constant (the exported model's output
// tensor shape never changes frame to frame at runtime), so we only need to
// run the expensive double-parse until we've seen a handful of confident
// frames, then lock the winning layout in for the rest of the session. This
// lives as worklet-module state: each Reanimated worklet runtime keeps its
// own copy, which is exactly what we want (persists across calls on the
// frame-processor thread, doesn't leak into the JS-thread module instance).
let cachedChannelsFirst: boolean | null = null;
/** How many confident (non-empty) frames to self-detect over before locking. */
const LAYOUT_LOCK_AFTER_FRAMES = 5;
let confidentFrameCount = 0;

/** Test-only: reset the cached layout decision between unrelated test cases. */
export function __resetLayoutCacheForTests(): void {
  cachedChannelsFirst = null;
  confidentFrameCount = 0;
}

// IMPORTANT: this function calls nmsPerClass (and extract, above), and must
// be declared AFTER both. Reanimated's worklet Babel plugin turns every
// 'worklet' function into an immediately-invoked factory that captures its
// module-scope closure (other worklets it calls) EAGERLY, at the point the
// factory runs during module evaluation — not lazily on first call. If this
// function were declared before nmsPerClass in source order, its closure
// would capture `nmsPerClass` while that binding was still `undefined`,
// making every call throw "nmsPerClass is not a function". Verified via
// `babel.transform` with babel-preset-expo: keep parseYoloOutput below every
// worklet it references.
export function parseYoloOutput(
  data: Float32Array,
  t: number,
  opts: YoloParseOptions,
): FrameDetections {
  'worklet';
  const {
    inputSize,
    scoreMin = 0.15,
    iouThreshold = 0.45,
    maxDetections = 16,
    normalized,
  } = opts;
  const nc = CLASS_ORDER.length;
  const rows = 4 + nc;
  const n = Math.floor(data.length / rows);

  let useCf: boolean;
  let chosen: Extracted;

  if (cachedChannelsFirst !== null) {
    // Layout already locked in for this session — skip the second parse.
    useCf = cachedChannelsFirst;
    chosen = extract(data, nc, n, rows, useCf, inputSize, scoreMin, normalized);
  } else {
    // Parse under both layouts; keep whichever found more valid boxes (tie ->
    // the higher-confidence one; final tie -> channels-first default).
    const cf = extract(data, nc, n, rows, true, inputSize, scoreMin, normalized);
    const cl = extract(data, nc, n, rows, false, inputSize, scoreMin, normalized);
    useCf =
      cf.raw.length > cl.raw.length ||
      (cf.raw.length === cl.raw.length && cf.maxScore >= cl.maxScore);
    chosen = useCf ? cf : cl;

    // Only count frames that actually found something toward the lock — an
    // all-empty warm-up frame (camera still settling) shouldn't win the race.
    if (chosen.raw.length > 0) {
      confidentFrameCount++;
      if (confidentFrameCount >= LAYOUT_LOCK_AFTER_FRAMES) {
        cachedChannelsFirst = useCf;
      }
    }
  }

  const debug: FrameDebug = {
    outputLen: data.length,
    rows,
    n,
    layout: useCf ? 'channels-first' : 'channels-last',
    rawCount: chosen.raw.length,
    maxScore: chosen.maxScore,
    coordMax: chosen.coordMax,
  };

  return {
    t,
    frameWidth: inputSize,
    frameHeight: inputSize,
    detections: nmsPerClass(chosen.raw, iouThreshold).slice(0, maxDetections),
    debug,
  };
}
