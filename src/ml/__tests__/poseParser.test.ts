/**
 * poseParser tests: normal MoveNet decode plus the bounds/NaN guards that
 * keep a corrupted or truncated pose tensor from producing a keypoint with
 * non-finite coordinates (FormAnalyzer has no defense of its own against
 * that), and the timestamp guard that refuses a frame the session could
 * never place in time.
 */
import { describe, expect, test } from '@jest/globals';

import { MOVENET_KEYPOINTS, parseMoveNet } from '../poseParser';

/** Build a full 17*3 MoveNet-shaped [y, x, score] buffer, all zeros by default. */
function buildBuffer(overrides: Record<number, [number, number, number]> = {}): Float32Array {
  const data = new Float32Array(MOVENET_KEYPOINTS.length * 3);
  for (const [idx, [y, x, s]] of Object.entries(overrides)) {
    const i = Number(idx);
    data[i * 3] = y;
    data[i * 3 + 1] = x;
    data[i * 3 + 2] = s;
  }
  return data;
}

describe('parseMoveNet', () => {
  test('decodes a confident keypoint and de-normalizes into frame pixels', () => {
    const noseIdx = MOVENET_KEYPOINTS.indexOf('nose');
    const data = buildBuffer({ [noseIdx]: [0.25, 0.5, 0.9] });
    const frame = parseMoveNet(data, 640, 640, 1.23);
    expect(frame.t).toBe(1.23);
    expect(frame.keypoints.nose).toBeDefined();
    expect(frame.keypoints.nose!.x).toBeCloseTo(320);
    expect(frame.keypoints.nose!.y).toBeCloseTo(160);
    expect(frame.keypoints.nose!.score).toBeCloseTo(0.9);
  });

  test('drops keypoints below scoreMin', () => {
    const wristIdx = MOVENET_KEYPOINTS.indexOf('left_wrist');
    const data = buildBuffer({ [wristIdx]: [0.5, 0.5, 0.1] });
    const frame = parseMoveNet(data, 640, 640, 0, 0.3);
    expect(frame.keypoints.left_wrist).toBeUndefined();
  });

  test('drops keypoints with non-finite coordinates or score without throwing', () => {
    const elbowIdx = MOVENET_KEYPOINTS.indexOf('right_elbow');
    const data = buildBuffer({ [elbowIdx]: [NaN, 0.5, 0.9] });
    expect(() => parseMoveNet(data, 640, 640, 0)).not.toThrow();
    const frame = parseMoveNet(data, 640, 640, 0);
    expect(frame.keypoints.right_elbow).toBeUndefined();
  });

  test('drops keypoints with Infinity score without throwing', () => {
    const kneeIdx = MOVENET_KEYPOINTS.indexOf('left_knee');
    const data = buildBuffer({ [kneeIdx]: [0.5, 0.5, Infinity] });
    const frame = parseMoveNet(data, 640, 640, 0);
    expect(frame.keypoints.left_knee).toBeUndefined();
  });

  test('handles a truncated buffer (fewer than 17 keypoints) without throwing or reading out of range', () => {
    const shortData = new Float32Array(5 * 3); // only 5 of 17 keypoints present
    shortData[0] = 0.1; // nose y
    shortData[1] = 0.2; // nose x
    shortData[2] = 0.9; // nose score
    expect(() => parseMoveNet(shortData, 640, 640, 0)).not.toThrow();
    const frame = parseMoveNet(shortData, 640, 640, 0);
    expect(frame.keypoints.nose).toBeDefined();
    // Nothing beyond index 4 should be present; no out-of-range keys.
    expect(Object.keys(frame.keypoints).length).toBeLessThanOrEqual(5);
  });

  test('refuses a non-finite timestamp and returns an empty frame at t 0', () => {
    // iOS frame timestamps are metadata.timestamp.seconds with no CMTime
    // validity guard, so NaN is reachable. One such frame keys the prune Maps
    // on an unplaceable value, poisons every dt (One-Euro filters, the fps
    // EMA) and passes no window test again — for the rest of the session.
    // Refusing it must produce a frame that measured NOTHING, not a frame at
    // an invented time carrying real keypoints.
    const noseIdx = MOVENET_KEYPOINTS.indexOf('nose');
    const data = buildBuffer({ [noseIdx]: [0.25, 0.5, 0.9] });
    for (const bad of [NaN, Infinity, -Infinity]) {
      const frame = parseMoveNet(data, 640, 640, bad);
      expect(frame.t).toBe(0);
      expect(Object.keys(frame.keypoints)).toHaveLength(0);
    }
    // A finite t on the SAME buffer still decodes — the guard refuses the
    // timestamp, never the tensor.
    expect(parseMoveNet(data, 640, 640, 2).keypoints.nose).toBeDefined();
  });

  test('handles an empty buffer gracefully', () => {
    const data = new Float32Array(0);
    expect(() => parseMoveNet(data, 640, 640, 0)).not.toThrow();
    const frame = parseMoveNet(data, 640, 640, 0);
    expect(Object.keys(frame.keypoints)).toHaveLength(0);
  });
});
