/**
 * calibrationGuide — the single source of truth for the calibration coach:
 * landmark walkthrough copy + diagram geometry, tap-sanity checks, solve
 * quality tiers, the rim-lock aim checklist, and the calibration-health model
 * shown in setup/settings. Every surface (guide screen, live overlay, health
 * card) renders from here so the copy and the math can never drift apart.
 *
 * Pure TypeScript: no React, no I/O, no clocks — timestamps are always inputs.
 */
import {
  CALIBRATION_LANDMARK_IDS,
  courtLandmarks,
  type CourtSpec,
  type LandmarkId,
} from './courtModel';

// ---------------------------------------------------------------------------
// Landmark walkthrough: per-landmark copy + normalized diagram positions.
// ---------------------------------------------------------------------------

export interface LandmarkGuideEntry {
  id: LandmarkId;
  title: string;
  instruction: string;
  tip: string;
  /**
   * Normalized half-court diagram coords: x 0..1 left→right, y 0 at the
   * BASELINE (bottom of diagram) growing toward halfcourt.
   */
  pos: { x: number; y: number };
}

/** FIBA/NBA half-court width, meters — the diagram's horizontal extent. */
const COURT_WIDTH_M = 15;
/** Extra diagram depth beyond the arc apex so the top dot isn't on the edge. */
const DEPTH_MARGIN_M = 1.5;

/** Walkthrough copy per landmark. Titles are short; tips disambiguate taps. */
const LANDMARK_COPY: Record<LandmarkId, { title: string; instruction: string; tip: string }> = {
  basket: {
    title: 'Basket',
    instruction: 'Tap the floor directly under the center of the rim.',
    tip: 'Use the shadow under the backboard to find the spot.',
  },
  cornerThreeLeft: {
    title: 'Left corner 3',
    instruction: 'Tap where the LEFT 3-point line meets the baseline.',
    tip: 'The short straight part of the line, in the corner.',
  },
  cornerThreeRight: {
    title: 'Right corner 3',
    instruction: 'Tap where the RIGHT 3-point line meets the baseline.',
    tip: 'The short straight part of the line, in the corner.',
  },
  topOfArc: {
    title: 'Top of the arc',
    instruction: 'Tap the 3-point line at its farthest point, straight out from the basket.',
    tip: 'Follow the arc to its peak — dead center of the court.',
  },
  ftCenter: {
    title: 'Free-throw line',
    instruction: 'Tap the middle of the free-throw line.',
    tip: 'Center of the line, not the circle.',
  },
} as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The 5-landmark tap ritual as diagram entries, in ritual order. Metric court
 * coords (origin under the rim, +X along baseline, +Y into court, baseline at
 * y = -basketFromBaselineM) are normalized into the diagram frame documented
 * on LandmarkGuideEntry.pos.
 */
export function landmarkGuide(spec: CourtSpec): LandmarkGuideEntry[] {
  const landmarks = courtLandmarks(spec);
  const depthM = spec.arcRadiusM + spec.basketFromBaselineM + DEPTH_MARGIN_M;
  return CALIBRATION_LANDMARK_IDS.map((id) => {
    const landmark = landmarks.find((l) => l.id === id)!;
    const copy = LANDMARK_COPY[id];
    return {
      id,
      title: copy.title,
      instruction: copy.instruction,
      tip: copy.tip,
      pos: {
        x: clamp01((landmark.court.x + COURT_WIDTH_M / 2) / COURT_WIDTH_M),
        y: clamp01((landmark.court.y + spec.basketFromBaselineM) / depthM),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Tap sanity: two near-coincident taps make the homography solve degenerate.
// ---------------------------------------------------------------------------

/**
 * First pair of points closer than minDist (same units as the inputs — the
 * overlay calls this in VIEW px), or null when all taps are well separated.
 * O(n²) over at most 5 points.
 */
export function closePair(
  points: readonly { id: LandmarkId; x: number; y: number }[],
  minDist: number,
): [LandmarkId, LandmarkId] | null {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < minDist) {
        return [points[i].id, points[j].id];
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Solve quality tiers, from the solver's mean reprojection error (meters).
// ---------------------------------------------------------------------------

export type CalQualityTier = 'dialed' | 'good' | 'rough';

/**
 * Tier a committed solve by mean reprojection error. The engine already
 * rejects anything above MAX_REPROJECTION_ERROR_M = 0.5 (courtCalibration.ts),
 * so 'rough' spans (0.30, 0.5] — accepted, but worth a re-tap.
 */
export function qualityTier(reprojErrM: number): CalQualityTier {
  if (reprojErrM <= 0.15) return 'dialed';
  if (reprojErrM <= 0.3) return 'good';
  return 'rough';
}

export function qualityLabel(tier: CalQualityTier): string {
  switch (tier) {
    case 'dialed':
      return 'Dialed in — within ±0.15 m';
    case 'good':
      return 'Good — within ±0.3 m';
    case 'rough':
      return 'Usable — consider re-tapping the fuzzy ones';
  }
}

// ---------------------------------------------------------------------------
// Rim-lock aim checklist: 3 steps derived from engine SharedValue snapshots.
// ---------------------------------------------------------------------------

export interface AimSnap {
  rimSeen: boolean;
  countdown: number | null;
  locked: boolean;
  /** 0..1 EMA luma; 0 = never measured (sentinel) */
  light: number;
}

export interface AimStep {
  id: 'find' | 'steady' | 'locked';
  label: string;
  state: 'todo' | 'doing' | 'done';
}

/**
 * Below this EMA luma the scene is dim enough to warn about. Mirrors the
 * context in which DETECTION.ballScoreMinDark (0.16) applies — do NOT import
 * DETECTION here; this module stays free of config coupling.
 */
export const LOW_LIGHT_THRESHOLD = 0.16;

/**
 * Derive the 3-step rim-aim checklist from a live snapshot. light === 0 is
 * the never-measured sentinel (useShotEngine) and must never flag lowLight.
 */
export function rimAimChecklist(snap: AimSnap): { steps: AimStep[]; lowLight: boolean } {
  let states: [AimStep['state'], AimStep['state'], AimStep['state']];
  if (snap.locked) {
    states = ['done', 'done', 'done'];
  } else if (snap.countdown != null) {
    states = ['done', 'doing', 'todo'];
  } else if (snap.rimSeen) {
    states = ['done', 'todo', 'todo'];
  } else {
    states = ['doing', 'todo', 'todo'];
  }
  return {
    steps: [
      { id: 'find', label: 'Frame the rim', state: states[0] },
      { id: 'steady', label: 'Hold steady', state: states[1] },
      { id: 'locked', label: 'Locked in', state: states[2] },
    ],
    lowLight: snap.light > 0 && snap.light < LOW_LIGHT_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Calibration health: the rim/court/FT trust model for setup + settings.
// ---------------------------------------------------------------------------

export interface HealthInput {
  hasRegistration: boolean;
  reprojectionErrorM: number | null;
  hasFtCal: boolean;
  lastCourtCal: { ts: number; reprojErrM: number } | null;
  lastFtCal: { ts: number } | null;
  nowMs: number;
}

export type HealthStatus = 'active' | 'idle';

export interface HealthItem {
  key: 'rim' | 'court' | 'ft';
  title: string;
  status: HealthStatus;
  detail: string;
  benefit: string;
}

export interface CalibrationHealth {
  items: HealthItem[];
  footer: string;
}

const DAY_MS = 86400000;

/** Coarse recency label for calibration receipts. Pure ms math, no locale. */
export function daysAgoLabel(nowMs: number, ts: number): string {
  const delta = Math.max(0, nowMs - ts);
  if (delta < DAY_MS) return 'today';
  if (delta < 2 * DAY_MS) return 'yesterday';
  return `${Math.floor(delta / DAY_MS)} days ago`;
}

/**
 * The 3-item calibration health model. Honesty rule: registrations are
 * per-camera-pose and per-session, so this never claims a saved homography —
 * past calibrations show up only as receipts ("last measured ..."), never as
 * anything active. When a registration is active but its error is unknown,
 * assume the worst the engine accepts (0.5 m) rather than flatter the user.
 */
export function buildCalibrationHealth(input: HealthInput): CalibrationHealth {
  const rim: HealthItem = {
    key: 'rim',
    title: 'Rim lock',
    status: 'idle',
    detail: 'Automatic every session — frame the rim and hold steady.',
    benefit: 'Everything starts here: shot detection, angles, distance.',
  };

  let courtStatus: HealthStatus = 'idle';
  let courtDetail: string;
  if (input.hasRegistration) {
    courtStatus = 'active';
    courtDetail = `Active this session — ${qualityLabel(qualityTier(input.reprojectionErrorM ?? 0.5))}`;
  } else if (input.lastCourtCal) {
    courtDetail = `Not set. Last court-tap ${daysAgoLabel(input.nowMs, input.lastCourtCal.ts)} (±${input.lastCourtCal.reprojErrM.toFixed(2)} m).`;
  } else {
    courtDetail = 'Not set — tap 5 court points after rim lock.';
  }
  const court: HealthItem = {
    key: 'court',
    title: 'Court mapping',
    status: courtStatus,
    detail: courtDetail,
    benefit: 'Corner-accurate 2s and 3s, plus a real shot map.',
  };

  let ftStatus: HealthStatus = 'idle';
  let ftDetail: string;
  if (input.hasFtCal) {
    ftStatus = 'active';
    ftDetail = 'Active this session — distance is measured, not estimated.';
  } else if (input.lastFtCal) {
    ftDetail = `Not set. Last measured ${daysAgoLabel(input.nowMs, input.lastFtCal.ts)}.`;
  } else {
    ftDetail = 'Not set — stand at the free-throw line when the chip offers it.';
  }
  const ft: HealthItem = {
    key: 'ft',
    title: 'Free-throw distance',
    status: ftStatus,
    detail: ftDetail,
    benefit: 'Sharper distance for the 2/3 call when you skip the court tap.',
  };

  return {
    items: [rim, court, ft],
    footer: 'Calibration lives and dies with your camera position — it is never saved between sessions.',
  };
}

// ---------------------------------------------------------------------------
// Guide-screen copy. Ladder labels align with evidence.ts valueSourceLabel.
// ---------------------------------------------------------------------------

export const WHY_CALIBRATE = {
  headline: 'Get every 2 and 3 called right',
  body: 'Uncalibrated, Hoopilot ESTIMATES your distance from the rim size in frame. One free-throw anchor upgrades that to MEASURED. Five court taps make it COURT-REGISTERED — corner 3s included.',
  ladder: [
    { source: 'heuristic', label: 'Estimated', blurb: 'Rim-size geometry. Solid, but corners can fool it.' },
    { source: 'metric', label: 'Measured', blurb: 'Your free-throw anchor scales the whole scene.' },
    { source: 'ftSeed', label: 'FT-anchored', blurb: 'Your first free throw pins scale and direction. Court-placed calls, no taps.' },
    { source: 'court', label: 'Court-registered', blurb: 'A tapped court map. Corner-accurate 2/3 calls.' },
  ],
} as const;

export const PLACEMENT_STEPS = [
  {
    id: 'side',
    title: 'Shoot from the side',
    body: 'Set the phone to the SIDE of the hoop, not behind you — the arc reads best in profile.',
  },
  {
    id: 'frame',
    title: 'Whole rim + some floor',
    body: 'The full rim in frame, with court floor visible below it for the tap ritual.',
  },
  {
    id: 'height',
    title: 'Chest height, locked down',
    body: 'Tripod or a stable ledge around chest height. Once it is set, do not move it.',
  },
] as const;
