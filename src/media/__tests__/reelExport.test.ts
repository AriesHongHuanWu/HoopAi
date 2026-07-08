/**
 * Tests for buildReelSegments — pure reel-plan math (shot-clock → video time).
 *
 * The native stitcher is never touched here (buildReelSegments only imports the
 * pure `sanitizeSegments` from the wrapper, which needs no native module — but
 * we still mock it away so importing the wrapper can't reach native).
 */
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../../../modules/video-stitcher', () => ({ VideoStitcher: null }));

import { buildReelSegments, toFileUri } from '../reelExport';
import type { ReelSession } from '../reelExport';
import { CLIPS } from '../../core/config';
import type { ResolvedShot, ShotOutcome } from '../../core/types';

/** Minimal valid ResolvedShot with overridable fields. */
function shot(
  id: number,
  tResolved: number,
  outcome: ShotOutcome = 'make',
): ResolvedShot {
  return {
    id,
    tStart: tResolved - 1.5,
    tResolved,
    outcome,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
  };
}

const recorded: ReelSession = {
  videoPath: '/data/rec.mp4',
  recordingStartSec: 10,
};

describe('toFileUri', () => {
  test('bare path gets file:// scheme', () => {
    expect(toFileUri('/data/rec.mp4')).toBe('file:///data/rec.mp4');
  });
  test('already-schemed uri is untouched', () => {
    expect(toFileUri('file:///data/rec.mp4')).toBe('file:///data/rec.mp4');
    expect(toFileUri('content://media/1')).toBe('content://media/1');
  });
});

describe('buildReelSegments graceful exits', () => {
  const base = { videoDurationSec: 120 };

  test('no recording', () => {
    const r = buildReelSegments(
      { videoPath: null, recordingStartSec: 10 },
      [shot(1, 30)],
      base,
    );
    expect(r).toEqual({ ok: false, reason: 'no-recording' });
  });

  test('empty video path', () => {
    const r = buildReelSegments(
      { videoPath: '', recordingStartSec: 10 },
      [shot(1, 30)],
      base,
    );
    expect(r).toEqual({ ok: false, reason: 'no-recording' });
  });

  test('no recordingStartSec offset (pre-v2)', () => {
    const r = buildReelSegments(
      { videoPath: '/data/rec.mp4', recordingStartSec: null },
      [shot(1, 30)],
      base,
    );
    expect(r).toEqual({ ok: false, reason: 'no-offset' });
  });

  test('unknown video duration', () => {
    const r = buildReelSegments(recorded, [shot(1, 30)], {
      videoDurationSec: 0,
    });
    expect(r).toEqual({ ok: false, reason: 'no-duration' });
  });

  test('no makes', () => {
    const r = buildReelSegments(
      recorded,
      [shot(1, 30, 'miss'), shot(2, 60, 'unsure')],
      base,
    );
    expect(r).toEqual({ ok: false, reason: 'no-makes' });
  });

  test('makes fall entirely outside the recorded video', () => {
    // recordingStartSec 10, make at shot-clock t=5 → pre-roll pushes the whole
    // window before the video start (video time < 0), clamps to zero length.
    const r = buildReelSegments(
      { videoPath: '/data/rec.mp4', recordingStartSec: 100 },
      [shot(1, 5, 'make')],
      { videoDurationSec: 120 },
    );
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('buildReelSegments success', () => {
  test('maps a single make into a video-time window', () => {
    // Make resolved at shot-clock t=40; recordingStartSec=10 → video t=30.
    // preRoll 6 / postRoll 2 → shot-clock [34,42] → video [24,32].
    const r = buildReelSegments(recorded, [shot(1, 40, 'make')], {
      videoDurationSec: 120,
      preRollSec: 6,
      postRollSec: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceUri).toBe('file:///data/rec.mp4');
    expect(r.segments).toEqual([{ startSec: 24, endSec: 32 }]);
    expect(r.totalSec).toBe(8);
  });

  test('only makes are included (misses/unsure filtered)', () => {
    const r = buildReelSegments(
      recorded,
      [shot(1, 40, 'make'), shot(2, 70, 'miss'), shot(3, 100, 'make')],
      { videoDurationSec: 200, preRollSec: 6, postRollSec: 2 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // make@40 → video [24,32]; make@100 → video [84,92]. miss@70 excluded.
    expect(r.segments).toEqual([
      { startSec: 24, endSec: 32 },
      { startSec: 84, endSec: 92 },
    ]);
    expect(r.totalSec).toBe(16);
  });

  test('adjacent makes merge into one clip (planClips merge preserved)', () => {
    // Two makes 3s apart: windows [pre,post] overlap heavily → one segment.
    const r = buildReelSegments(
      recorded,
      [shot(1, 40, 'make'), shot(2, 43, 'make')],
      { videoDurationSec: 120, preRollSec: 6, postRollSec: 2 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // make@40 → [34,42]; make@43 → [37,45]; merged shot-clock [34,45] → video [24,35].
    expect(r.segments).toEqual([{ startSec: 24, endSec: 35 }]);
  });

  test('windows clamp to the video duration', () => {
    // Make near the very end; postRoll would run past the video → clamps.
    const r = buildReelSegments(recorded, [shot(1, 128, 'make')], {
      videoDurationSec: 120,
      preRollSec: 6,
      postRollSec: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // shot-clock [122,130] → video [112,120] (clamped from 130-10=120).
    expect(r.segments).toEqual([{ startSec: 112, endSec: 120 }]);
  });

  test('defaults to CLIPS pre/post roll when not provided', () => {
    const r = buildReelSegments(recorded, [shot(1, 40, 'make')], {
      videoDurationSec: 120,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [seg] = r.segments;
    // video t = 40-10 = 30; window = [30 - preRoll, 30 + postRoll].
    expect(seg.startSec).toBeCloseTo(30 - CLIPS.preRollSec, 5);
    expect(seg.endSec).toBeCloseTo(30 + CLIPS.postRollSec, 5);
  });
});
