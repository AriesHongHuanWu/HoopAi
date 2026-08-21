/**
 * Parser for MoveNet SinglePose output → a {@link PoseFrame} for FormAnalyzer.
 *
 * MoveNet Lightning output tensor is [1, 1, 17, 3] = 17 COCO keypoints, each
 * (y, x, score) NORMALIZED 0..1 relative to the (square, cover-cropped) input.
 * We de-normalize into the SAME analysis-frame pixel space the detector uses
 * (both resize the camera frame 'cover' to a square), so ball and pose share
 * one coordinate system.
 */
import type { PoseFrame, PoseKeypointName } from '../core/types';

/** COCO-17 order emitted by MoveNet. */
export const MOVENET_KEYPOINTS: readonly PoseKeypointName[] = [
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
];

/**
 * @param data     Flattened [1,1,17,3] MoveNet output (51 floats, y,x,score).
 * @param frameW   Analysis-frame width in px (square input side).
 * @param frameH   Analysis-frame height in px.
 * @param t        Frame timestamp, seconds. Non-finite = frame refused.
 * @param scoreMin Drop keypoints below this confidence.
 */
export function parseMoveNet(
  data: Float32Array,
  frameW: number,
  frameH: number,
  t: number,
  scoreMin = 0.3,
): PoseFrame {
  'worklet';
  // TIMESTAMP GUARD. `t` is a camera presentation timestamp, and on iOS that
  // is metadata.timestamp.seconds with no CMTime validity check — it can
  // arrive NaN. A non-finite t is not a late frame, it is an unplaceable one:
  // downstream it keys the prune Maps (which then grow unbounded at camera
  // rate), it is subtracted for every dt (poisoning the One-Euro filters and
  // the fps EMA for the rest of the session) and every window test against it
  // is false. Refuse the frame — an EMPTY keypoint set at t 0 says the frame
  // measured nothing, which is exactly what happened. The return TYPE is
  // unchanged: jump.tsx and useShotEngine.ts call this too.
  if (!Number.isFinite(t)) return { t: 0, keypoints: {} };
  const keypoints: PoseFrame['keypoints'] = {};
  // Bounds guard: a truncated/mismatched output buffer (wrong model loaded,
  // delegate returning a short tensor) must never index past the end of
  // `data` — Float32Array reads out of range return `undefined`, which would
  // otherwise flow into the NaN guard below anyway, but computing `n` from
  // the buffer keeps the loop from doing pointless out-of-range work.
  const n = Math.min(MOVENET_KEYPOINTS.length, Math.floor(data.length / 3));
  for (let i = 0; i < n; i++) {
    const y = data[i * 3]!;
    const x = data[i * 3 + 1]!;
    const s = data[i * 3 + 2]!;
    // NaN/bounds guard: a corrupted tensor read must never produce a
    // keypoint with non-finite coordinates — FormAnalyzer's angle math
    // (src/core/formAnalysis.ts) has no defense of its own against that.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(s)) continue;
    if (s >= scoreMin) {
      keypoints[MOVENET_KEYPOINTS[i]!] = { x: x * frameW, y: y * frameH, score: s };
    }
  }
  return { t, keypoints };
}
