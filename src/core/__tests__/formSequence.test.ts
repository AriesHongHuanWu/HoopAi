import {
  FormSequenceBuffer,
  buildSequence,
  decodeSequence,
  RELEASE_MATCH_SLACK_SEC,
  SEQ_KEYPOINT_ORDER,
  SEQ_MISSING,
  SEQ_SCALE,
  SEQ_STRIDE,
  SEQ_TARGET_FRAMES,
  type FormSequenceWithRelease,
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

describe('releaseFrame marker', () => {
  /** A fully anchored frame (hips + nose + ankles) at time t; body ≈ 200 px. */
  function anchoredFrame(t: number): RawSeqFrame {
    return rawFrame(t, [
      ['left_hip', [290, 400]],
      ['right_hip', [310, 400]],
      ['nose', [300, 300]],
      ['left_ankle', [290, 500]],
      ['right_ankle', [310, 500]],
    ]);
  }

  function anchoredStream(n: number): RawSeqFrame[] {
    return Array.from({ length: n }, (_, f) => anchoredFrame(f * DT));
  }

  test('releaseT exactly on a sampled frame maps to that output index', () => {
    // 8 frames ≤ target ⇒ output index space is the raw index space.
    const seq = buildSequence(anchoredStream(8), 'right', 4 * DT) as
      | FormSequenceWithRelease
      | null;
    expect(seq!.releaseFrame).toBe(4);
  });

  test('downsampled stream: releaseT at the last raw frame marks the last OUTPUT index', () => {
    // 30 raw frames > SEQ_TARGET_FRAMES ⇒ indices are remapped; pickIndices
    // always keeps the last frame, so its output index is frames - 1.
    const seq = buildSequence(anchoredStream(30), 'right', 29 * DT) as
      | FormSequenceWithRelease
      | null;
    expect(seq!.frames).toBe(SEQ_TARGET_FRAMES);
    expect(seq!.releaseFrame).toBe(seq!.frames - 1);
  });

  test('releaseT between two sampled frames: nearest wins', () => {
    const raw = anchoredStream(8);
    const closerTo3 = buildSequence(raw, 'right', 3.4 * DT) as
      | FormSequenceWithRelease
      | null;
    const closerTo4 = buildSequence(raw, 'right', 3.6 * DT) as
      | FormSequenceWithRelease
      | null;
    expect(closerTo3!.releaseFrame).toBe(3);
    expect(closerTo4!.releaseFrame).toBe(4);
  });

  test('null / undefined / NaN releaseT produce no releaseFrame key', () => {
    const raw = anchoredStream(8);
    for (const t of [null, undefined, Number.NaN]) {
      const seq = buildSequence(raw, 'right', t);
      expect(seq).not.toBeNull();
      expect('releaseFrame' in seq!).toBe(false);
    }
  });

  test('releaseT beyond the slack gate is omitted, not snapped', () => {
    const raw = anchoredStream(8);
    const lastT = 7 * DT;
    // 0.5 s after the last buffered frame — outside RELEASE_MATCH_SLACK_SEC.
    const far = buildSequence(raw, 'right', lastT + 0.5);
    expect('releaseFrame' in far!).toBe(false);
    // Just inside the gate still matches (pins the constant's meaning).
    const near = buildSequence(
      raw,
      'right',
      lastT + RELEASE_MATCH_SLACK_SEC - 1e-6,
    ) as FormSequenceWithRelease | null;
    expect(near!.releaseFrame).toBe(7);
  });

  test('an all-missing row still occupies an index and can carry the marker', () => {
    // 10 frames; frame 5 has NO hip ⇒ it packs as an all-missing row but
    // still owns output index 5 with a valid timestamp.
    const raw = anchoredStream(10);
    raw[5] = rawFrame(5 * DT, [
      ['nose', [300, 300]],
      ['left_ankle', [290, 500]],
      ['right_ankle', [310, 500]],
    ]);
    const seq = buildSequence(raw, 'right', 5 * DT) as
      | FormSequenceWithRelease
      | null;
    expect(seq!.frames).toBe(10);
    expect(seq!.releaseFrame).toBe(5);
    // Confirm row 5 really is the all-missing row.
    for (let k = 0; k < SEQ_STRIDE; k++) {
      expect(seq!.data[5 * SEQ_STRIDE + k]).toBe(SEQ_MISSING);
    }
  });

  test('regression: two-arg buildSequence output is byte-identical to pre-marker shape', () => {
    const M = SEQ_MISSING;
    // Expected packed row for anchoredFrame: center (300,400), height 200.25.
    // SEQ_KEYPOINT_ORDER: nose, eyes/ears (missing), shoulders/elbows/wrists
    // (missing), hips, knees (missing), ankles.
    //
    // RE-PINNED (the "theater draws a straight line" bug). The nose/ankle y
    // values moved −4000 → −3995 and 4000 → 3995, i.e. by 0.06% of a body
    // height. The old numbers came from dividing by the AXIS-ALIGNED
    // |ankle.y − nose.y| = 200 px; the scale is now the roll-invariant
    // head→foot distance, and this fixture's head (300,300) and lowest foot
    // (290,500) are hypot(10,200) = 200.25 px apart. That difference is the
    // whole point: the axis-aligned span shrinks as the capture rolls, which
    // magnified rolled captures ~1.4× at 45° and ~10× at 90° until they
    // saturated the int16 grid. The pin is NOT a threshold — it is the exact
    // packing, and it moved because the scale it divides by is now correct.
    const row = [
      0, -3995, // nose
      M, M, M, M, M, M, M, M, // eyes + ears
      M, M, M, M, // shoulders
      M, M, M, M, // elbows
      M, M, M, M, // wrists
      -400, 0, 400, 0, // hips
      M, M, M, M, // knees
      -400, 3995, 400, 3995, // ankles
    ];
    const raw = anchoredStream(4);
    const seq = buildSequence(raw, 'right');
    expect(seq).toEqual({
      v: 1,
      hand: 'right',
      frames: 4,
      durationSec: 3 * DT,
      data: [...row, ...row, ...row, ...row],
    });
    // Key set is exactly the pre-change one — no releaseFrame key at all.
    expect(Object.keys(seq!).sort()).toEqual([
      'data',
      'durationSec',
      'frames',
      'hand',
      'v',
    ]);
    // Explicit null behaves identically to the two-arg call.
    expect(buildSequence(raw, 'right', null)).toEqual(seq);
  });

  test('decodeSequence output is unaffected by the marker', () => {
    const raw = anchoredStream(8);
    const plain = buildSequence(raw, 'right')!;
    const marked = buildSequence(raw, 'right', 4 * DT)! as FormSequenceWithRelease;
    expect(marked.releaseFrame).toBe(4);
    expect(decodeSequence(marked)).toEqual(decodeSequence(plain));
  });

  test('FormSequenceBuffer.finalize forwards releaseT', () => {
    const b = new FormSequenceBuffer({ hand: 'right' });
    // 20 frames (0.63 s) — inside the window, no pruning, identity sampling.
    for (let f = 0; f < 20; f++) b.push(fullPose(f * DT));
    const seq = b.finalize(10 * DT) as FormSequenceWithRelease | null;
    expect(seq).not.toBeNull();
    expect(seq!.releaseFrame).toBe(10);
    // Zero-arg finalize still omits the marker.
    expect('releaseFrame' in b.finalize()!).toBe(false);
  });
});
