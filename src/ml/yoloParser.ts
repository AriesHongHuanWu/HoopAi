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
  /**
   * Sticky layout hint from the PREVIOUS frame. When the two tensor layouts tie
   * on valid-box count this frame, keep the previous layout instead of letting a
   * noise-dominated maxScore flip the pick (which scrambles class labels and box
   * coordinates on degraded input). Thread it forward by reading `debug.layout`
   * back. The worklet stays pure — the caller owns this state (a SharedValue).
   */
  prevLayout?: 'channels-first' | 'channels-last';
  /**
   * YOLOX-family output: one extra OBJECTNESS channel between the 4 box coords
   * and the class scores, so each anchor is `[cx,cy,w,h, obj, cls0..nc-1]`
   * (rows = 5 + nc) and the true confidence is `obj * max(cls)`. YOLOX's decode
   * is folded into the exported graph, so the tensor is ALWAYS channels-last
   * `[1, N, 5+nc]` in input-pixel space — the layout auto-detect is skipped.
   * Ultralytics YOLOv8/11 has no objectness (rows = 4 + nc); leave this false.
   */
  hasObjectness?: boolean;
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
  hasObj: boolean,
): Extracted {
  'worklet';
  // value(row, i)
  const val = (row: number, i: number): number =>
    channelsFirst ? data[row * n + i]! : data[i * rows + row]!;

  // Class scores start after the 4 box coords, plus a YOLOX objectness channel.
  const clsBase = hasObj ? 5 : 4;

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
    let bestCls = 0;
    for (let c = 0; c < nc; c++) {
      const s = val(clsBase + c, i);
      // NaN guard: a corrupted/garbage tensor read (bad delegate output,
      // uninitialized memory) must never win best-class or poison maxScore —
      // every comparison against NaN is false, so an unguarded `s > bestCls`
      // silently skips NaN (safe), but the score comparison below runs on
      // whatever bestCls settled on and needs the same protection.
      if (Number.isFinite(s) && s > bestCls) {
        bestCls = s;
        best = c;
      }
    }
    // YOLOX confidence = objectness * class prob; Ultralytics has no objectness
    // so obj defaults to 1 and score == class prob (unchanged behaviour).
    const obj = hasObj ? val(4, i) : 1;
    const bestScore = Number.isFinite(obj) ? obj * bestCls : 0;
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

// NOTE: parseYoloOutput is a WORKLET. It MUST stay pure — no module-level
// mutable state. Reanimated captures module vars by value (readonly) into the
// frame-processor runtime, so writing to a module `let` from inside the worklet
// throws/crashes on the first frame (this exact "layout lock cache" once did).
// Parsing both layouts every frame is cheap (~2×33k ops) and always correct.

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
    prevLayout,
    hasObjectness = false,
  } = opts;
  const nc = CLASS_ORDER.length;
  const rows = (hasObjectness ? 5 : 4) + nc;
  const n = Math.floor(data.length / rows);

  // Parse under both layouts; keep whichever found more valid boxes (tie ->
  // the higher-confidence one; final tie -> channels-first default).
  const cf = extract(data, nc, n, rows, true, inputSize, scoreMin, normalized, hasObjectness);
  const cl = extract(data, nc, n, rows, false, inputSize, scoreMin, normalized, hasObjectness);
  // Layout pick. A strict valid-box-count winner always wins (self-healing). On
  // a TIE the maxScore tie-break is noise-dominated on degraded input and flips
  // the transposed (wrong) read frame-to-frame, scrambling class labels and
  // coordinates — so on a tie STICK to the previous frame's layout when given,
  // and only fall back to maxScore when there is no prior.
  // Transpose-garbage guard (CRITICAL). Reading the tensor in the WRONG layout
  // interprets box-coordinate values (normalized 0..1) as class scores, so a
  // HUGE fraction of anchors (~27%) spuriously clear the score floor — e.g. 2256
  // "boxes" from the wrong read vs a handful from the correct one. No real frame
  // has anywhere near that many raw detections, so a layout whose raw count
  // exceeds ~5% of the anchors is the garbage read; always prefer the OTHER
  // layout. Without this, the naive "more boxes wins" rule below picked the
  // garbage layout and the HUD filled with a pile of overlapping phantom boxes
  // (verified on device + reproduced frame-for-frame off-line).
  const garbageCeil = n * 0.05;
  const cfGarbage = cf.raw.length > garbageCeil;
  const clGarbage = cl.raw.length > garbageCeil;
  let useCf: boolean;
  if (hasObjectness) {
    // YOLOX folds its decode into the graph and always emits channels-last
    // [1, N, 5+nc]. The layout is known, so skip the auto-detect (parsing it
    // channels-first would read the transposed garbage).
    useCf = false;
  } else if (cfGarbage !== clGarbage) {
    useCf = clGarbage; // exactly one layout is garbage → take the clean one
  } else if (cf.raw.length !== cl.raw.length) {
    useCf = cf.raw.length > cl.raw.length;
  } else if (prevLayout === 'channels-first') {
    useCf = true;
  } else if (prevLayout === 'channels-last') {
    useCf = false;
  } else {
    useCf = cf.maxScore >= cl.maxScore;
  }
  const chosen = useCf ? cf : cl;

  const debug: FrameDebug = {
    outputLen: data.length,
    rows,
    n,
    layout: useCf ? 'channels-first' : 'channels-last',
    rawCount: chosen.raw.length,
    maxScore: chosen.maxScore,
    coordMax: chosen.coordMax,
    // Both layouts garbage ⇒ the delegate returned a corrupted tensor.
    corrupt: cfGarbage && clGarbage,
  };

  return {
    t,
    frameWidth: inputSize,
    frameHeight: inputSize,
    detections: nmsPerClass(chosen.raw, iouThreshold).slice(0, maxDetections),
    debug,
  };
}
