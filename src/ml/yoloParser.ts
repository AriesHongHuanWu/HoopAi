/**
 * Parser for Ultralytics-style detection outputs (YOLOv8/11/26 family or any
 * model exported to the [1, 4+numClasses, numAnchors] TFLite layout).
 *
 * The trained HoopAI model has 4 classes in this order (see docs/MODELS.md):
 *   0 ball, 1 rim, 2 ball_in_basket, 3 person
 */
import type { DetClass, Detection, FrameDetections } from '../core/types';

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
  /** Model emits normalized 0..1 coords instead of pixels. */
  normalized?: boolean;
}

/**
 * Parse a raw output tensor laid out as [1, 4+nc, N] (channels-first,
 * Ultralytics TFLite export default): rows are cx, cy, w, h, then one score
 * row per class.
 */
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
  // Coordinate scale. YOLO TFLite exports vary: some emit normalized 0..1
  // coords, others pixel coords in [0, inputSize]. Auto-detect when the caller
  // doesn't say, so a model swap never needs a code change + rebuild: scan the
  // cx row and treat everything as normalized when the max is ~<=1.
  let scale: number;
  if (normalized === undefined) {
    let maxCx = 0;
    for (let i = 0; i < n; i++) {
      const v = data[i]!;
      if (v > maxCx) maxCx = v;
    }
    scale = maxCx <= 2 ? inputSize : 1;
  } else {
    scale = normalized ? inputSize : 1;
  }

  const raw: Detection[] = [];
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < nc; c++) {
      const s = data[(4 + c) * n + i]!;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (best < 0 || bestScore < scoreMin) continue;
    const cx = data[0 * n + i]! * scale;
    const cy = data[1 * n + i]! * scale;
    const w = data[2 * n + i]! * scale;
    const h = data[3 * n + i]! * scale;
    if (w <= 0 || h <= 0) continue;
    raw.push({
      cls: CLASS_ORDER[best]!,
      score: bestScore,
      box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
    });
  }

  return {
    t,
    frameWidth: inputSize,
    frameHeight: inputSize,
    detections: nmsPerClass(raw, iouThreshold).slice(0, maxDetections),
  };
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
