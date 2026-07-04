/**
 * yoloParser tests: layout auto-detection + caching, NMS, and the
 * NaN/bounds guards that keep a corrupted tensor read from ever producing
 * a garbage detection.
 */
import { describe, expect, test, beforeEach } from '@jest/globals';

import { CLASS_ORDER, nmsPerClass, parseYoloOutput } from '../yoloParser';
import type { Detection } from '../../core/types';

const NC = CLASS_ORDER.length; // 4: ball, rim, ball_in_basket, person
const ROWS = 4 + NC;

/** Build a channels-first [1, rows, n] tensor for one detection at index i. */
function buildChannelsFirst(
  n: number,
  boxes: { i: number; cx: number; cy: number; w: number; h: number; cls: number; score: number }[],
): Float32Array {
  const data = new Float32Array(ROWS * n);
  for (const b of boxes) {
    data[0 * n + b.i] = b.cx;
    data[1 * n + b.i] = b.cy;
    data[2 * n + b.i] = b.w;
    data[3 * n + b.i] = b.h;
    data[(4 + b.cls) * n + b.i] = b.score;
  }
  return data;
}

/** Build a channels-last [1, n, rows] tensor for one detection at index i. */
function buildChannelsLast(
  n: number,
  boxes: { i: number; cx: number; cy: number; w: number; h: number; cls: number; score: number }[],
): Float32Array {
  const data = new Float32Array(n * ROWS);
  for (const b of boxes) {
    data[b.i * ROWS + 0] = b.cx;
    data[b.i * ROWS + 1] = b.cy;
    data[b.i * ROWS + 2] = b.w;
    data[b.i * ROWS + 3] = b.h;
    data[b.i * ROWS + (4 + b.cls)] = b.score;
  }
  return data;
}

describe('parseYoloOutput — layout auto-detection', () => {
  test('detects channels-first pixel-space boxes', () => {
    const n = 100;
    const data = buildChannelsFirst(n, [
      { i: 10, cx: 320, cy: 200, w: 30, h: 30, cls: 0, score: 0.9 },
    ]);
    const out = parseYoloOutput(data, 1.0, { inputSize: 640 });
    expect(out.debug?.layout).toBe('channels-first');
    expect(out.detections).toHaveLength(1);
    expect(out.detections[0]!.cls).toBe('ball');
    expect(out.detections[0]!.box.x).toBeCloseTo(320 - 15);
    expect(out.detections[0]!.box.y).toBeCloseTo(200 - 15);
  });

  test('detects channels-last pixel-space boxes', () => {
    const n = 100;
    const data = buildChannelsLast(n, [
      { i: 10, cx: 320, cy: 200, w: 30, h: 30, cls: 1, score: 0.8 },
    ]);
    const out = parseYoloOutput(data, 1.0, { inputSize: 640 });
    expect(out.debug?.layout).toBe('channels-last');
    expect(out.detections).toHaveLength(1);
    expect(out.detections[0]!.cls).toBe('rim');
  });

  test('detects normalized 0..1 coords and scales to inputSize', () => {
    const n = 50;
    const data = buildChannelsFirst(n, [
      { i: 5, cx: 0.5, cy: 0.25, w: 0.05, h: 0.05, cls: 2, score: 0.7 },
    ]);
    const out = parseYoloOutput(data, 1.0, { inputSize: 640 });
    // 0.5 * 640 = 320, 0.25 * 640 = 160, 0.05 * 640 = 32
    expect(out.detections[0]!.box.width).toBeCloseTo(32);
    expect(out.detections[0]!.box.x).toBeCloseTo(320 - 16);
    expect(out.detections[0]!.box.y).toBeCloseTo(160 - 16);
  });

  test('rejects the transpose-garbage layout even when it yields far more boxes', () => {
    // Reproduces the on-device "pile of boxes" bug. A REAL channels-first output
    // has coordinate predictions (rows 0..3, normalized ~0.3-0.5) on EVERY
    // anchor but a real class score on only a few. Read in the WRONG layout,
    // those coord values are interpreted as class scores, so a huge fraction of
    // anchors spuriously pass the score floor (~200 junk boxes here) and the old
    // "more boxes wins" rule picked the garbage layout.
    const n = 400;
    const data = new Float32Array(ROWS * n);
    for (let i = 0; i < n; i++) {
      data[0 * n + i] = 0.5; // cx (normalized)
      data[1 * n + i] = 0.5; // cy
      data[2 * n + i] = 0.3; // w
      data[3 * n + i] = 0.3; // h
    }
    data[(4 + 0) * n + 10] = 0.9; // the ONE genuine ball detection
    const out = parseYoloOutput(data, 0, { inputSize: 640 });
    // Guard must reject channels-last (garbage) and keep the clean read.
    expect(out.debug?.layout).toBe('channels-first');
    expect(out.detections).toHaveLength(1);
    expect(out.detections[0]!.cls).toBe('ball');
    expect(out.detections[0]!.box.width).toBeCloseTo(0.3 * 640);
  });

  test('picks the correct layout per frame (pure, no cross-frame state)', () => {
    const n = 100;
    const clData = buildChannelsLast(n, [
      { i: 20, cx: 300, cy: 300, w: 20, h: 20, cls: 0, score: 0.95 },
    ]);
    expect(parseYoloOutput(clData, 0, { inputSize: 640 }).debug?.layout).toBe('channels-last');
    // A later channels-first frame is judged on its own merits (no lock-in).
    const cfData = buildChannelsFirst(n, [
      { i: 20, cx: 300, cy: 300, w: 20, h: 20, cls: 0, score: 0.99 },
    ]);
    expect(parseYoloOutput(cfData, 1, { inputSize: 640 }).debug?.layout).toBe('channels-first');
  });
});

describe('parseYoloOutput — NaN / bounds guards', () => {
  test('drops boxes with non-finite score without throwing', () => {
    const n = 10;
    const data = buildChannelsFirst(n, []);
    // Poison one column's ball-class score with NaN directly.
    data[(4 + 0) * n + 2] = NaN;
    data[0 * n + 2] = 100;
    data[1 * n + 2] = 100;
    data[2 * n + 2] = 20;
    data[3 * n + 2] = 20;
    expect(() => parseYoloOutput(data, 0, { inputSize: 640 })).not.toThrow();
    const out = parseYoloOutput(data, 0, { inputSize: 640 });
    expect(out.detections).toHaveLength(0);
  });

  test('drops boxes with non-finite coordinates without throwing', () => {
    const n = 10;
    const data = buildChannelsFirst(n, [
      { i: 4, cx: Infinity, cy: 100, w: 20, h: 20, cls: 0, score: 0.9 },
    ]);
    expect(() => parseYoloOutput(data, 0, { inputSize: 640 })).not.toThrow();
    const out = parseYoloOutput(data, 0, { inputSize: 640 });
    expect(out.detections).toHaveLength(0);
  });

  test('drops degenerate zero/negative-size boxes', () => {
    const n = 10;
    const data = buildChannelsFirst(n, [
      { i: 1, cx: 100, cy: 100, w: 0, h: 20, cls: 0, score: 0.9 },
      { i: 2, cx: 100, cy: 100, w: 20, h: -5, cls: 0, score: 0.9 },
    ]);
    const out = parseYoloOutput(data, 0, { inputSize: 640 });
    expect(out.detections).toHaveLength(0);
  });

  test('handles an empty/too-short buffer gracefully', () => {
    const data = new Float32Array(0);
    expect(() => parseYoloOutput(data, 0, { inputSize: 640 })).not.toThrow();
    const out = parseYoloOutput(data, 0, { inputSize: 640 });
    expect(out.detections).toHaveLength(0);
  });
});

describe('nmsPerClass', () => {
  function det(cls: Detection['cls'], score: number, x: number, y: number, w = 20, h = 20): Detection {
    return { cls, score, box: { x, y, width: w, height: h } };
  }

  test('passes through 0 or 1 detections without allocating/sorting', () => {
    expect(nmsPerClass([], 0.45)).toEqual([]);
    const single = [det('ball', 0.5, 0, 0)];
    // Same array identity is an acceptable/expected fast-path optimization.
    expect(nmsPerClass(single, 0.45)).toBe(single);
  });

  test('suppresses heavily overlapping same-class boxes, keeping the higher score', () => {
    const a = det('ball', 0.9, 100, 100);
    const b = det('ball', 0.6, 102, 101); // near-identical box, lower score
    const out = nmsPerClass([b, a], 0.45);
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(0.9);
  });

  test('keeps overlapping boxes of different classes', () => {
    const a = det('ball', 0.9, 100, 100);
    const b = det('rim', 0.8, 100, 100);
    const out = nmsPerClass([a, b], 0.45);
    expect(out).toHaveLength(2);
  });

  test('keeps well-separated same-class boxes', () => {
    const a = det('ball', 0.9, 0, 0);
    const b = det('ball', 0.8, 500, 500);
    const out = nmsPerClass([a, b], 0.45);
    expect(out).toHaveLength(2);
  });
});
