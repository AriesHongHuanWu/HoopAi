/**
 * Tests for the guarded stitcher wrapper. Two concerns:
 *
 *  1. `sanitizeSegments` — the pure clamp/merge/min-duration logic (no native).
 *  2. The guard behaviour of `available` / `stitch` / `onProgress` / `cancel`
 *     when the native module is PRESENT (mocked) and ABSENT (null).
 *
 * The native module (`../../modules/video-stitcher`) is mocked so no native
 * code is ever touched. Each block resets modules so it can install a fresh
 * mock (present vs absent) before importing the wrapper.
 */
import { describe, expect, jest, test, beforeEach } from '@jest/globals';

import { sanitizeSegments, totalSegmentSeconds } from '../videoStitcher';
import type { StitchSegment } from '../videoStitcher';

// ---------------------------------------------------------------------------
// sanitizeSegments — pure
// ---------------------------------------------------------------------------

describe('sanitizeSegments', () => {
  test('drops reversed and zero-length windows', () => {
    const out = sanitizeSegments([
      { startSec: 5, endSec: 3 }, // reversed
      { startSec: 2, endSec: 2 }, // zero length
      { startSec: 1, endSec: 4 }, // keep
    ]);
    expect(out).toEqual([{ startSec: 1, endSec: 4 }]);
  });

  test('drops non-finite windows', () => {
    const out = sanitizeSegments([
      { startSec: NaN, endSec: 4 },
      { startSec: 1, endSec: Infinity },
      { startSec: 2, endSec: 5 },
    ]);
    expect(out).toEqual([{ startSec: 2, endSec: 5 }]);
  });

  test('clamps to [0, durationSec]', () => {
    const out = sanitizeSegments(
      [
        { startSec: -3, endSec: 4 },
        { startSec: 8, endSec: 20 },
      ],
      { durationSec: 10 },
    );
    expect(out).toEqual([
      { startSec: 0, endSec: 4 },
      { startSec: 8, endSec: 10 },
    ]);
  });

  test('a window entirely past the duration collapses and is dropped', () => {
    const out = sanitizeSegments([{ startSec: 15, endSec: 20 }], {
      durationSec: 10,
    });
    // Both clamp to 10 → zero length → dropped.
    expect(out).toEqual([]);
  });

  test('sorts by start before merging', () => {
    const out = sanitizeSegments([
      { startSec: 10, endSec: 12 },
      { startSec: 1, endSec: 3 },
      { startSec: 5, endSec: 7 },
    ]);
    expect(out).toEqual([
      { startSec: 1, endSec: 3 },
      { startSec: 5, endSec: 7 },
      { startSec: 10, endSec: 12 },
    ]);
  });

  test('merges overlapping windows', () => {
    const out = sanitizeSegments([
      { startSec: 1, endSec: 5 },
      { startSec: 4, endSec: 8 },
    ]);
    expect(out).toEqual([{ startSec: 1, endSec: 8 }]);
  });

  test('merges windows within mergeGapSec, keeps ones beyond it', () => {
    const out = sanitizeSegments(
      [
        { startSec: 1, endSec: 4 },
        { startSec: 4.3, endSec: 6 }, // gap 0.3 ≤ 0.5 → merge
        { startSec: 10, endSec: 12 }, // gap 4 > 0.5 → separate
      ],
      { mergeGapSec: 0.5 },
    );
    expect(out).toEqual([
      { startSec: 1, endSec: 6 },
      { startSec: 10, endSec: 12 },
    ]);
  });

  test('default mergeGap is 0 — only touching/overlapping windows merge', () => {
    const out = sanitizeSegments([
      { startSec: 1, endSec: 4 },
      { startSec: 4.3, endSec: 6 }, // 0.3 gap, no merge at default
    ]);
    expect(out).toEqual([
      { startSec: 1, endSec: 4 },
      { startSec: 4.3, endSec: 6 },
    ]);
  });

  test('drops windows shorter than minSegmentSec after merging', () => {
    const out = sanitizeSegments(
      [
        { startSec: 1, endSec: 1.1 }, // 0.1 < 0.2 → dropped
        { startSec: 5, endSec: 6 },
      ],
      { minSegmentSec: 0.2 },
    );
    expect(out).toEqual([{ startSec: 5, endSec: 6 }]);
  });

  test('a short window that MERGES up to min length is kept', () => {
    // Two 0.15s windows touching → merged 0.3s ≥ 0.2 min → kept.
    const out = sanitizeSegments(
      [
        { startSec: 1.0, endSec: 1.15 },
        { startSec: 1.15, endSec: 1.3 },
      ],
      { minSegmentSec: 0.2, mergeGapSec: 0.05 },
    );
    expect(out).toEqual([{ startSec: 1.0, endSec: 1.3 }]);
  });

  test('empty input yields empty output', () => {
    expect(sanitizeSegments([])).toEqual([]);
  });

  test('does not mutate the input array or its objects', () => {
    const input: StitchSegment[] = [
      { startSec: 4, endSec: 8 },
      { startSec: 1, endSec: 5 },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeSegments(input);
    expect(input).toEqual(snapshot);
  });
});

describe('totalSegmentSeconds', () => {
  test('sums window lengths', () => {
    expect(
      totalSegmentSeconds([
        { startSec: 0, endSec: 4 },
        { startSec: 10, endSec: 12 },
      ]),
    ).toBe(6);
  });

  test('empty → 0', () => {
    expect(totalSegmentSeconds([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Guard behaviour — native module ABSENT (requireOptionalNativeModule → null)
// ---------------------------------------------------------------------------

describe('wrapper when native module is ABSENT', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../../modules/video-stitcher', () => ({
      VideoStitcher: null,
    }));
  });

  test('available is false', () => {
    const mod = require('../videoStitcher');
    expect(mod.available).toBe(false);
  });

  test('stitch rejects with ERR_STITCHER_UNAVAILABLE', async () => {
    const mod = require('../videoStitcher');
    await expect(
      mod.stitch({
        sourceUri: 'file:///video.mp4',
        segments: [{ startSec: 1, endSec: 4 }],
      }),
    ).rejects.toMatchObject({ code: mod.ERR_UNAVAILABLE });
  });

  test('onProgress returns a no-op unsubscribe', () => {
    const mod = require('../videoStitcher');
    const unsub = mod.onProgress(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  test('cancel is a safe no-op', () => {
    const mod = require('../videoStitcher');
    expect(() => mod.cancel()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Guard behaviour — native module PRESENT (mocked)
// ---------------------------------------------------------------------------

describe('wrapper when native module is PRESENT', () => {
  const makeMock = (over: Partial<Record<string, unknown>> = {}) => ({
    isAvailable: jest.fn(() => true),
    cancel: jest.fn(),
    stitch: jest.fn(async () => ({ uri: 'file:///out.mp4', durationSec: 6 })),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    ...over,
  });

  test('available reflects isAvailable()', () => {
    jest.resetModules();
    const native = makeMock();
    jest.doMock('../../../modules/video-stitcher', () => ({ VideoStitcher: native }));
    const mod = require('../videoStitcher');
    expect(mod.available).toBe(true);
    expect(native.isAvailable).toHaveBeenCalled();
  });

  test('available is false if isAvailable throws', () => {
    jest.resetModules();
    const native = makeMock({
      isAvailable: jest.fn(() => {
        throw new Error('boom');
      }),
    });
    jest.doMock('../../../modules/video-stitcher', () => ({ VideoStitcher: native }));
    const mod = require('../videoStitcher');
    expect(mod.available).toBe(false);
  });

  test('stitch sanitizes segments before calling native', async () => {
    jest.resetModules();
    const native = makeMock();
    jest.doMock('../../../modules/video-stitcher', () => ({ VideoStitcher: native }));
    const mod = require('../videoStitcher');

    const res = await mod.stitch({
      sourceUri: 'file:///video.mp4',
      // Reversed + overlapping + out-of-range windows.
      segments: [
        { startSec: 4, endSec: 8 },
        { startSec: 7, endSec: 20 }, // overlaps prev, clamps to 10
        { startSec: 5, endSec: 3 }, // reversed → dropped
      ],
      durationSec: 10,
      outputFileName: 'my-reel',
    });

    expect(res).toEqual({ uri: 'file:///out.mp4', durationSec: 6 });
    expect(native.stitch).toHaveBeenCalledTimes(1);
    const arg = (native.stitch as jest.Mock).mock.calls[0][0] as {
      sourceUri: string;
      segments: StitchSegment[];
      outputFileName?: string;
    };
    expect(arg.sourceUri).toBe('file:///video.mp4');
    expect(arg.outputFileName).toBe('my-reel');
    // 4-8 and 7-20 merge and clamp → single 4-10 window.
    expect(arg.segments).toEqual([{ startSec: 4, endSec: 10 }]);
  });

  test('stitch rejects ERR_NO_SEGMENTS when nothing survives sanitizing', async () => {
    jest.resetModules();
    const native = makeMock();
    jest.doMock('../../../modules/video-stitcher', () => ({ VideoStitcher: native }));
    const mod = require('../videoStitcher');

    await expect(
      mod.stitch({
        sourceUri: 'file:///video.mp4',
        segments: [{ startSec: 5, endSec: 3 }], // reversed → dropped
      }),
    ).rejects.toMatchObject({ code: mod.ERR_NO_SEGMENTS });
    expect(native.stitch).not.toHaveBeenCalled();
  });

  test('onProgress subscribes and unsubscribes via native', () => {
    jest.resetModules();
    const remove = jest.fn();
    const native = makeMock({ addListener: jest.fn(() => ({ remove })) });
    jest.doMock('../../../modules/video-stitcher', () => ({ VideoStitcher: native }));
    const mod = require('../videoStitcher');

    const cb = jest.fn();
    const unsub = mod.onProgress(cb);
    expect(native.addListener).toHaveBeenCalledWith('onProgress', cb);
    unsub();
    expect(remove).toHaveBeenCalled();
  });

  test('cancel delegates to native and swallows errors', () => {
    jest.resetModules();
    const native = makeMock({
      cancel: jest.fn(() => {
        throw new Error('nothing running');
      }),
    });
    jest.doMock('../../../modules/video-stitcher', () => ({ VideoStitcher: native }));
    const mod = require('../videoStitcher');
    expect(() => mod.cancel()).not.toThrow();
    expect(native.cancel).toHaveBeenCalled();
  });
});
