/**
 * Reel export planning — pure segment math, no native calls.
 *
 * Turns a session's made shots into VIDEO-time stitch windows for the native
 * stitcher. Reuses the same make-window logic as the in-app reel PLAYER
 * (src/core/clipPlanner.ts + src/app/reel/[sessionId].tsx): plan clips in
 * shot-clock time, then shift into video time via
 *
 *     videoTime = shotClockTime − recordingStartSec
 *
 * so the exported MP4 shows exactly the same makes, in the same windows, that
 * the player skips through. Output feeds
 * {@link src/media/videoStitcher.stitch} — which re-sanitizes — but we clamp
 * and merge here too so the plan is honest on its own.
 *
 * Pure and fully unit-tested; the native export is exercised separately.
 */
import { CLIPS } from '../core/config';
import { planClips } from '../core/clipPlanner';
import { clamp } from '../core/geometry';
import type { ResolvedShot } from '../core/types';
import {
  sanitizeSegments,
  type StitchSegment,
} from './videoStitcher';

/** The minimal session shape reel planning needs (a subset of db.SessionRow). */
export interface ReelSession {
  /** Absolute path / URI of the master recording, when recorded. */
  videoPath: string | null;
  /**
   * Engine-clock second at which the recording started. videoTime =
   * shot.tResolved − recordingStartSec. Null for pre-v2 / non-recorded sessions.
   */
  recordingStartSec: number | null;
}

export interface BuildReelOptions {
  /** Length of the source VIDEO in seconds (from the player's sourceLoad). */
  videoDurationSec: number;
  /** Seconds kept before each make. Default {@link CLIPS.preRollSec}. */
  preRollSec?: number;
  /** Seconds kept after each make. Default {@link CLIPS.postRollSec}. */
  postRollSec?: number;
}

/** Why a reel can't be built — mirrors the player's graceful-exit reasons. */
export type ReelUnavailableReason =
  | 'no-recording' // session has no video
  | 'no-offset' // pre-v2 recording without recordingStartSec
  | 'no-duration' // video duration not known yet
  | 'no-makes' // no made shots in range
  | 'empty'; // makes all fell outside the recorded video

export type BuildReelResult =
  | { ok: true; sourceUri: string; segments: StitchSegment[]; totalSec: number }
  | { ok: false; reason: ReelUnavailableReason };

/** VisionCamera hands back bare paths; native wants a proper file URI. */
export function toFileUri(path: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return path;
  return `file://${path}`;
}

/**
 * Build the ordered VIDEO-time stitch windows for a session's makes.
 *
 * Returns `{ ok: false, reason }` for every state the player also bails on
 * (no recording, no timing offset, unknown duration, no makes, or makes that
 * fall entirely outside the recorded footage) so the caller can show the same
 * empty states. On success, `segments` is sorted, clamped to the video and
 * merged — ready to hand to the native stitcher.
 */
export function buildReelSegments(
  session: ReelSession,
  shots: readonly ResolvedShot[],
  opts: BuildReelOptions,
): BuildReelResult {
  if (session.videoPath == null || session.videoPath.length === 0) {
    return { ok: false, reason: 'no-recording' };
  }
  if (session.recordingStartSec == null) {
    return { ok: false, reason: 'no-offset' };
  }
  if (!Number.isFinite(opts.videoDurationSec) || opts.videoDurationSec <= 0) {
    return { ok: false, reason: 'no-duration' };
  }

  const recordingStartSec = session.recordingStartSec;
  const videoDurationSec = opts.videoDurationSec;
  const preRollSec = opts.preRollSec ?? CLIPS.preRollSec;
  const postRollSec = opts.postRollSec ?? CLIPS.postRollSec;

  const makeCount = shots.filter((s) => s.outcome === 'make').length;
  if (makeCount === 0) {
    return { ok: false, reason: 'no-makes' };
  }

  // Plan in shot-clock time over the whole recording span, exactly like the
  // player: sessionDurationSec is the shot-clock end of the video.
  const plans = planClips(shots, {
    keep: 'makes',
    preRollSec,
    postRollSec,
    sessionDurationSec: recordingStartSec + videoDurationSec,
  });

  // Shift into video time and clamp to the actual video.
  const raw: StitchSegment[] = plans.map((p) => ({
    startSec: clamp(p.startSec - recordingStartSec, 0, videoDurationSec),
    endSec: clamp(p.endSec - recordingStartSec, 0, videoDurationSec),
  }));

  // Sanitize: clamp/merge/min-duration. Use the planner's own merge gap so the
  // export groups makes identically to the player. (planClips already merged in
  // shot-clock space, but clamping into video time can create new adjacencies.)
  const segments = sanitizeSegments(raw, {
    durationSec: videoDurationSec,
    mergeGapSec: CLIPS.mergeGapSec,
  });

  if (segments.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  let totalSec = 0;
  for (const s of segments) totalSec += s.endSec - s.startSec;

  return {
    ok: true,
    sourceUri: toFileUri(session.videoPath),
    segments,
    totalSec,
  };
}
