/**
 * Guarded TypeScript wrapper over the `video-stitcher` local native module.
 *
 * The Reel exports a single MP4 (make-clips concatenated on-device) that's
 * ready to drop straight into Instagram Reels. The heavy lifting is native
 * (AVFoundation on iOS, media3-transformer on Android); this layer is a thin,
 * fully-tested guard so the rest of the app never has to know whether the
 * native module is present.
 *
 * When the native module is ABSENT — Expo Go, Jest, or a binary built before
 * the module landed — every call no-ops safely: `available` is false and
 * `stitch` rejects with a clear coded error instead of crashing. UI can branch
 * on `available` to hide the Export button entirely.
 *
 * The pure `sanitizeSegments` helper (merge/clamp/min-duration) is exported and
 * unit-tested independently of any native code.
 */
import {
  VideoStitcher,
  type StitchOptions,
  type StitchProgressEvent,
  type StitchResult,
  type StitchSegment,
} from '../../modules/video-stitcher';

export type {
  StitchOptions,
  StitchProgressEvent,
  StitchResult,
  StitchSegment,
} from '../../modules/video-stitcher';

/** Segments shorter than this (seconds) are dropped — nothing to see. */
export const MIN_SEGMENT_SEC = 0.2;

/** Options for {@link sanitizeSegments}. */
export interface SanitizeOptions {
  /**
   * Total source duration in seconds. Segments are clamped to [0, duration];
   * when omitted, only the lower bound (0) is enforced.
   */
  durationSec?: number;
  /** Minimum kept segment length, seconds. Default {@link MIN_SEGMENT_SEC}. */
  minSegmentSec?: number;
  /**
   * Merge two segments whose gap is at or below this (seconds). Default 0 —
   * only truly overlapping/touching windows merge. reelExport passes a small
   * positive gap so near-adjacent makes join into one clip.
   */
  mergeGapSec?: number;
}

/**
 * Normalize raw stitch windows into a clean, ordered, non-overlapping set the
 * native side can trust:
 *
 *  1. Coerce non-finite / reversed windows away (start ≤ end, both finite).
 *  2. Clamp to [0, durationSec] when a duration is given.
 *  3. Sort by start.
 *  4. Merge windows that overlap or sit within `mergeGapSec`.
 *  5. Drop anything shorter than `minSegmentSec` AFTER merging.
 *
 * Pure — no I/O, no native calls. The native modules re-clamp defensively, but
 * doing it here keeps the contract obvious and testable.
 */
export function sanitizeSegments(
  segments: readonly StitchSegment[],
  opts: SanitizeOptions = {},
): StitchSegment[] {
  const duration = opts.durationSec;
  const minSeg = opts.minSegmentSec ?? MIN_SEGMENT_SEC;
  const mergeGap = Math.max(0, opts.mergeGapSec ?? 0);

  // 1 + 2: keep only finite, forward windows; clamp to bounds.
  const cleaned: StitchSegment[] = [];
  for (const seg of segments) {
    let start = seg.startSec;
    let end = seg.endSec;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0) start = 0;
    if (duration != null && Number.isFinite(duration)) {
      const hi = Math.max(0, duration);
      if (start > hi) start = hi;
      if (end > hi) end = hi;
    }
    if (end <= start) continue;
    cleaned.push({ startSec: start, endSec: end });
  }
  if (cleaned.length === 0) return [];

  // 3: sort by start.
  cleaned.sort((a, b) => a.startSec - b.startSec);

  // 4: merge overlapping / near-adjacent windows.
  const merged: StitchSegment[] = [{ ...cleaned[0] }];
  for (let i = 1; i < cleaned.length; i++) {
    const next = cleaned[i];
    const cur = merged[merged.length - 1];
    if (next.startSec - cur.endSec <= mergeGap) {
      cur.endSec = Math.max(cur.endSec, next.endSec);
    } else {
      merged.push({ ...next });
    }
  }

  // 5: drop sub-minimum windows.
  return merged.filter((s) => s.endSec - s.startSec >= minSeg);
}

/** Total seconds covered by a set of (assumed non-overlapping) segments. */
export function totalSegmentSeconds(segments: readonly StitchSegment[]): number {
  let total = 0;
  for (const s of segments) total += Math.max(0, s.endSec - s.startSec);
  return total;
}

/** Whether the native stitcher is linked AND reports itself available. */
export const available: boolean = (() => {
  if (VideoStitcher == null) return false;
  try {
    return VideoStitcher.isAvailable();
  } catch {
    return false;
  }
})();

/** Coded error thrown by {@link stitch} when the native module is unavailable. */
export const ERR_UNAVAILABLE = 'ERR_STITCHER_UNAVAILABLE';

/** Coded error thrown by {@link stitch} when there are no usable segments. */
export const ERR_NO_SEGMENTS = 'ERR_NO_SEGMENTS';

class StitcherError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StitcherError';
    this.code = code;
  }
}

/**
 * Subscribe to per-segment progress. Returns an unsubscribe function; a no-op
 * when the native module is absent (the listener simply never fires).
 */
export function onProgress(
  listener: (event: StitchProgressEvent) => void,
): () => void {
  if (VideoStitcher == null) return () => {};
  const sub = VideoStitcher.addListener('onProgress', listener);
  return () => sub.remove();
}

/**
 * Export a single MP4 by concatenating `segments` out of `sourceUri`. The input
 * is sanitized (clamped/merged) before it reaches native. Rejects with a coded
 * error (`err.code`) — never crashes — when the module is missing or the input
 * yields no usable segments.
 *
 * @param options.durationSec optional source duration; when known, segments are
 *   clamped to it so out-of-range windows can't reach native.
 */
export async function stitch(
  options: StitchOptions & { durationSec?: number; mergeGapSec?: number },
): Promise<StitchResult> {
  if (VideoStitcher == null || !available) {
    throw new StitcherError(
      ERR_UNAVAILABLE,
      'The video stitcher native module is not available in this build.',
    );
  }
  const segments = sanitizeSegments(options.segments, {
    durationSec: options.durationSec,
    mergeGapSec: options.mergeGapSec,
  });
  if (segments.length === 0) {
    throw new StitcherError(
      ERR_NO_SEGMENTS,
      'No usable segments to stitch after sanitizing.',
    );
  }
  return VideoStitcher.stitch({
    sourceUri: options.sourceUri,
    segments,
    outputFileName: options.outputFileName,
  });
}

/** Best-effort cancel of an in-flight export (no-op when unavailable). */
export function cancel(): void {
  if (VideoStitcher == null) return;
  try {
    VideoStitcher.cancel();
  } catch {
    // Nothing running / already torn down — cancellation is best effort.
  }
}
