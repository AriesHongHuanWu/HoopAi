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
 * @param t        Frame timestamp, seconds.
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
  const keypoints: PoseFrame['keypoints'] = {};
  const n = MOVENET_KEYPOINTS.length;
  for (let i = 0; i < n; i++) {
    const y = data[i * 3]!;
    const x = data[i * 3 + 1]!;
    const s = data[i * 3 + 2]!;
    if (s >= scoreMin) {
      keypoints[MOVENET_KEYPOINTS[i]!] = { x: x * frameW, y: y * frameH, score: s };
    }
  }
  return { t, keypoints };
}
