/**
 * shareFrame — pick the "shooting moment" timestamp in the session recording to
 * use as a share-card background.
 *
 * The video timeline is anchored at `recordingStartSec` (camera clock, the same
 * clock shot.tResolved and the trajectory samples are stamped with — see
 * live.tsx setRecording). So a shot's position in the video is its camera time
 * minus that anchor. We prefer the trajectory APEX (the ball at the top of its
 * arc — the iconic frame) and fall back to the resolve moment.
 *
 * Pure + no I/O: returns seconds into the clip, clamped to [0, duration]. The
 * caller feeds this to expo-video-thumbnails.
 */
import type { ResolvedShot } from './types';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Seconds into the recording for a shot's most shareable frame.
 *
 * @param shot              The resolved shot (carries tResolved + trajectory,
 *                          both on the camera clock).
 * @param recordingStartSec Camera-clock time the recording began.
 * @param durationSec       Clip duration (upper clamp); pass Infinity if unknown.
 */
export function shotMomentSec(
  shot: Pick<ResolvedShot, 'tResolved' | 'trajectory'>,
  recordingStartSec: number,
  durationSec: number,
): number {
  // Apex = trajectory sample with the smallest cy (highest point on screen,
  // +y is DOWN). Prefer a real (non-predicted) sample. Falls back to tResolved.
  let apexT: number | null = null;
  let apexCy = Infinity;
  const traj = shot.trajectory ?? [];
  for (let i = 0; i < traj.length; i++) {
    const s = traj[i]!;
    if (s.predicted) continue;
    if (s.cy < apexCy) {
      apexCy = s.cy;
      apexT = s.t;
    }
  }
  const cameraT = apexT ?? shot.tResolved;
  const hi = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
  return clamp(cameraT - recordingStartSec, 0, hi);
}

/**
 * For a whole-session card, the moment to feature: the apex of the best made
 * shot (highest arc among makes), else the first make, else the first shot,
 * else 0. Returns seconds into the clip, or null when there are no shots.
 */
export function sessionMomentSec(
  shots: readonly ResolvedShot[],
  recordingStartSec: number,
  durationSec: number,
): number | null {
  if (shots.length === 0) return null;
  const makes = shots.filter((s) => s.outcome === 'make');
  const pool = makes.length > 0 ? makes : shots;
  // Highest arc = smallest min-cy across the trajectory.
  let best = pool[0]!;
  let bestCy = Infinity;
  for (const s of pool) {
    let minCy = Infinity;
    for (const p of s.trajectory ?? []) if (!p.predicted && p.cy < minCy) minCy = p.cy;
    if (minCy < bestCy) {
      bestCy = minCy;
      best = s;
    }
  }
  return shotMomentSec(best, recordingStartSec, durationSec);
}
