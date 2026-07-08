import {
  FormSequenceBuffer,
  buildSequence,
  decodeSequence,
  SEQ_KEYPOINT_ORDER,
  SEQ_MISSING,
  SEQ_SCALE,
  SEQ_STRIDE,
  SEQ_TARGET_FRAMES,
  type RawSeqFrame,
} from '../formSequence';
import type { PoseFrame, PoseKeypoint, PoseKeypointName } from '../types';

const DT = 1 / 30;

function kp(x: number, y: number, score = 0.9): PoseKeypoint {
  return { x, y, score };
}

/**
 * A full standing figure centered around (cx, hipY), `h` px tall. Every offset
 * scales with `h` so two figures at different pixel sizes are geometrically
 * SIMILAR — normalization by body height must then encode them identically.
 */
function fullPose(t: number, cx = 300, hipY = 400, h = 200): PoseFrame {
  const kps: PoseFrame['keypoints'] = {
    nose: kp(cx, hipY - h * 0.5),
    left_shoulder: kp(cx - h * 0.15, hipY - h * 0.4),
    right_shoulder: kp(cx + h * 0.15, hipY - h * 0.4),
    left_hip: kp(cx - h * 0.1, hipY),
    right_hip: kp(cx + h * 0.1, hipY),
    left_knee: kp(cx - h * 0.11, hipY + h * 0.26),
    right_knee: kp(cx + h * 0.11, hipY + h * 0.26),
    left_ankle: kp(cx - h * 0.11, hipY + h * 0.5),
    right_ankle: kp(cx + h * 0.11, hipY + h * 0.5),
    right_elbow: kp(cx + h * 0.2, hipY - h * 0.2),
    right_wrist: kp(cx + h * 0.14, hipY - h * 0.35),
  };
  return { t, keypoints: kps };
}

function rawFrame(t: number, entries: [PoseKeypointName, [number, number]][]): RawSeqFrame {
  const pts = new Map<PoseKeypointName, { x: number; y: number }>();
  for (const [n, [x, y]] of entries) pts.set(n, { x, y });
  return { t, pts };
}

describe('FormSequenceBuffer', () => {
  test('finalize returns null on too few frames', () => {
    const b = new FormSequenceBuffer({ hand: 'right' });
    b.push(fullPose(0));
    b.push(fullPose(DT));
    expect(b.length).toBe(2);
    expect(b.finalize()).toBeNull();
  });

  test('captures, normalizes and downsamples a full motion to <= target frames', () => {
    const b = new FormSequenceBuffer({ hand: 'right' });
    // 30 frames over 1 second — inside the retained window.
    for (let f = 0; f < 30; f++) b.push(fullPose(f * DT, 300, 400 + f, 200));
    const seq = b.finalize();
    expect(seq).not.toBeNull();
    expect(seq!.v).toBe(1);
    expect(seq!.hand).toBe('right');
    expect(seq!.frames).toBeLessThanOrEqual(SEQ_TARGET_FRAMES);
    expect(seq!.data.length).toBe(seq!.frames * SEQ_STRIDE);
    expect(seq!.durationSec).toBeGreaterThan(0);
  });

  test('normalization cancels absolute size: two differently-scaled figures encode near-identically', () => {
    const small = new FormSequenceBuffer({ hand: 'right' });
    const big = new FormSequenceBuffer({ hand: 'right' });
    for (let f = 0; f < 24; f++) {
      small.push(fullPose(f * DT, 200, 300, 150));
      big.push(fullPose(f * DT, 900, 1200, 400));
    }
    const a = decodeSequence(small.finalize()!);
    const c = decodeSequence(big.finalize()!);
    const midA = a[Math.floor(a.length / 2)]!;
    const midC = c[Math.floor(c.length / 2)]!;
    // Same body shape at different pixel scales ⇒ same normalized coords.
    for (const name of ['right_wrist', 'left_ankle', 'nose'] as PoseKeypointName[]) {
      expect(midA[name]!.x).toBeCloseTo(midC[name]!.x, 2);
      expect(midA[name]!.y).toBeCloseTo(midC[name]!.y, 2);
    }
  });

  test('hip-center sits near the normalized origin', () => {
    const b = new FormSequenceBuffer({ hand: 'right' });
    for (let f = 0; f < 24; f++) b.push(fullPose(f * DT));
    const frames = decodeSequence(b.finalize()!);
    const mid = frames[Math.floor(frames.length / 2)]!;
    const cx = (mid.left_hip!.x + mid.right_hip!.x) / 2;
    const cy = (mid.left_hip!.y + mid.right_hip!.y) / 2;
    expect(Math.abs(cx)).toBeLessThan(0.2);
    expect(Math.abs(cy)).toBeLessThan(0.05);
  });

  test('reset clears the buffer', () => {
    const b = new FormSequenceBuffer({ hand: 'right' });
    for (let f = 0; f < 10; f++) b.push(fullPose(f * DT));
    b.reset();
    expect(b.length).toBe(0);
    expect(b.finalize()).toBeNull();
  });

  test('old frames outside the window are pruned', () => {
    const b = new FormSequenceBuffer({ hand: 'right' });
    // Frames spread over 5 s — only the last ~1.2 s should be retained.
    for (let f = 0; f < 150; f++) b.push(fullPose(f * DT));
    // 1.2 s at 30 fps ≈ 36 frames retained.
    expect(b.length).toBeLessThanOrEqual(40);
    expect(b.length).toBeGreaterThan(20);
  });
});

describe('buildSequence / encoding', () => {
  test('missing keypoints round-trip as absent, present ones quantize back', () => {
    const raw: RawSeqFrame[] = [];
    for (let f = 0; f < 6; f++) {
      raw.push(
        rawFrame(f * DT, [
          ['left_hip', [280, 400]],
          ['right_hip', [320, 400]],
          ['nose', [300, 300]],
          ['left_ankle', [278, 500]],
          ['right_ankle', [322, 500]],
          // right_wrist deliberately absent in every frame
        ]),
      );
    }
    const seq = buildSequence(raw, 'right')!;
    expect(seq).not.toBeNull();
    const wristIdx = SEQ_KEYPOINT_ORDER.indexOf('right_wrist');
    // Every frame's right_wrist slot is the missing sentinel.
    for (let f = 0; f < seq.frames; f++) {
      const base = f * SEQ_STRIDE + wristIdx * 2;
      expect(seq.data[base]).toBe(SEQ_MISSING);
      expect(seq.data[base + 1]).toBe(SEQ_MISSING);
    }
    const decoded = decodeSequence(seq);
    expect(decoded[0]!.right_wrist).toBeUndefined();
    expect(decoded[0]!.nose).toBeDefined();
  });

  test('quantization error is sub-1% of a body height', () => {
    const raw: RawSeqFrame[] = [];
    for (let f = 0; f < 8; f++) {
      raw.push(
        rawFrame(f * DT, [
          ['left_hip', [290, 400]],
          ['right_hip', [310, 400]],
          ['nose', [300, 300]],
          ['left_ankle', [290, 500]],
          ['right_ankle', [310, 500]],
          ['right_wrist', [340, 340]],
        ]),
      );
    }
    const seq = buildSequence(raw, 'right')!;
    const decoded = decodeSequence(seq)[0]!;
    // body height ≈ 200 px; hip center (300,400). right_wrist normalized:
    const expX = (340 - 300) / 200;
    const expY = (340 - 400) / 200;
    expect(decoded.right_wrist!.x).toBeCloseTo(expX, 3);
    expect(decoded.right_wrist!.y).toBeCloseTo(expY, 3);
  });

  test('int16 grid holds without overflow for extreme reaches', () => {
    const raw: RawSeqFrame[] = [];
    for (let f = 0; f < 5; f++) {
      raw.push(
        rawFrame(f * DT, [
          ['left_hip', [295, 400]],
          ['right_hip', [305, 400]],
          ['nose', [300, 300]],
          ['left_ankle', [295, 500]],
          ['right_ankle', [305, 500]],
          // wrist far away → ~1.5 body-heights out
          ['right_wrist', [600, 100]],
        ]),
      );
    }
    const seq = buildSequence(raw, 'right')!;
    for (const v of seq.data) {
      expect(v).toBeGreaterThanOrEqual(SEQ_MISSING);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });

  test('decodeSequence tolerates a truncated/corrupt data array', () => {
    const raw: RawSeqFrame[] = [];
    for (let f = 0; f < 6; f++) {
      raw.push(
        rawFrame(f * DT, [
          ['left_hip', [290, 400]],
          ['right_hip', [310, 400]],
          ['nose', [300, 300]],
          ['left_ankle', [290, 500]],
          ['right_ankle', [310, 500]],
        ]),
      );
    }
    const seq = buildSequence(raw, 'right')!;
    const corrupt = { ...seq, data: seq.data.slice(0, SEQ_STRIDE + 3) };
    // Should decode the one clean frame and stop, never throw.
    expect(() => decodeSequence(corrupt)).not.toThrow();
    expect(decodeSequence(corrupt).length).toBe(1);
  });

  test('serialized size stays modest (a few KB) for a full 24-frame shot', () => {
    const b = new FormSequenceBuffer({ hand: 'right' });
    for (let f = 0; f < 30; f++) b.push(fullPose(f * DT, 300, 400 + f, 200));
    const seq = b.finalize()!;
    const json = JSON.stringify(seq);
    // Sanity budget: well under 8 KB.
    expect(json.length).toBeLessThan(8000);
  });
});
