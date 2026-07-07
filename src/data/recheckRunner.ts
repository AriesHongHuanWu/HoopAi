/**
 * Session-level driver for the offline unsure-shot re-check
 * (src/core/recheck.ts — pure; this file owns every side effect).
 *
 * Binding: frames come out of the session recording via
 * expo-video-thumbnails (getThumbnailAsync at a timestamp → JPEG), and each
 * frame runs through the app's EXACT still-image detector
 * (src/camera/detectImage.ts — same model, preprocessing and gates as the
 * live camera, minus the real-time budget). The detector model is loaded once
 * per engine and cached at module level, mirroring the Test AI screen.
 *
 * Persistence: an accepted verdict goes through the EXISTING correction
 * pathway — db.updateShotOutcome(rowId, outcome, corrected = false) —
 * because this is the machine's own re-read of its own recording, NOT a user
 * edit; the "Edited" badge must not appear. Every examined shot is also
 * stamped shots.rechecked = 1 so a later tap never repeats the same
 * expensive pass.
 *
 * Performance: ~6 fps × 5 s ≈ 30 thumbnail+inference rounds PER SHOT, so runs
 * are strictly sequential with progress callbacks, and the returned handle's
 * `cancel()` stops between frames (screens call it on unmount).
 */
import * as VideoThumbnails from 'expo-video-thumbnails';
import type { TensorflowModel } from 'react-native-fast-tflite';

import {
  detectImageToBoxes,
  loadDetector,
  resolveDetectorConfig,
  type DetectorConfig,
} from '../camera/detectImage';
import { recheckShots, type RecheckShotResult } from '../core/recheck';
import type { Detection } from '../core/types';
import {
  getSession,
  markShotRechecked,
  sessionShots,
  updateShotOutcome,
  type ShotRow,
} from './db';

/** Thumbnail JPEG quality — model input + nothing else, so keep it light. */
const THUMB_QUALITY = 0.7;

/** One accepted verdict, keyed both ways so screens can patch local state. */
export interface RecheckCorrection {
  /** shots.id (db row). */
  rowId: number;
  /** In-session shot number (ResolvedShot.id). */
  shotIndex: number;
  outcome: 'make' | 'miss';
}

/** Why a run ended without re-checking anything. */
export type RecheckFailure =
  /** Session has no recording (or no recording offset) to re-read. */
  | 'no-recording'
  /** The detector model could not be loaded on this device. */
  | 'no-model'
  /** No unsure, uncorrected, not-yet-rechecked shots to examine. */
  | 'nothing-to-check';

export interface RecheckRunResult {
  /** Shots fully re-analysed this run. */
  checked: number;
  corrections: RecheckCorrection[];
  cancelled: boolean;
  /** Set when the run never got going (checked stays 0). */
  failure?: RecheckFailure;
}

export interface RecheckHandle {
  /** Resolves when the run finishes, is cancelled, or fails — never rejects. */
  promise: Promise<RecheckRunResult>;
  /** Stop between frames; already-persisted verdicts stay. */
  cancel: () => void;
}

/** Eligibility: still unsure, never hand-corrected, not already re-checked. */
function isRecheckable(row: ShotRow): boolean {
  return row.outcome === 'unsure' && row.corrected !== 1 && row.rechecked !== 1;
}

/**
 * How many of a session's shots the re-check pass would examine. Screens use
 * this to decide whether to offer the button at all.
 */
export async function countRecheckableShots(sessionId: number): Promise<number> {
  const rows = await sessionShots(sessionId);
  return rows.filter(isRecheckable).length;
}

// --- model cache (mirrors src/app/session/analyze.tsx) ----------------------

let cachedModel: TensorflowModel | null = null;
let cachedLabel: string | null = null;
let loadInFlight: Promise<TensorflowModel | null> | null = null;

/** Load the detector for `config` once and reuse it; engine switch reloads. */
async function ensureModel(config: DetectorConfig): Promise<TensorflowModel | null> {
  if (cachedModel !== null && cachedLabel === config.label) return cachedModel;
  if (cachedLabel !== config.label) {
    cachedModel = null;
    loadInFlight = null;
    cachedLabel = config.label;
  }
  if (loadInFlight === null) loadInFlight = loadDetector(config);
  cachedModel = await loadInFlight;
  return cachedModel;
}

// -----------------------------------------------------------------------------

/**
 * Start the offline re-check for a session's unsure shots. Runs sequentially;
 * `onProgress(index, total)` fires as each shot begins (1-based, for
 * "Re-checking 2 of 3…"). The returned handle's promise NEVER rejects — every
 * failure collapses into a quiet result.
 */
export function startSessionRecheck(
  sessionId: number,
  onProgress?: (index: number, total: number) => void,
): RecheckHandle {
  let cancelled = false;
  const promise = runSessionRecheck(sessionId, () => cancelled, onProgress).catch(
    (err): RecheckRunResult => {
      // Defensive: thumbnails/inference can throw in unforeseen ways on
      // device; a re-check failure must never crash a results screen.
      console.warn('[recheck] run failed', err);
      return { checked: 0, corrections: [], cancelled };
    },
  );
  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
  };
}

async function runSessionRecheck(
  sessionId: number,
  isCancelled: () => boolean,
  onProgress?: (index: number, total: number) => void,
): Promise<RecheckRunResult> {
  const session = await getSession(sessionId);
  const videoPath = session?.videoPath ?? null;
  const recordingStartSec = session?.recordingStartSec ?? null;
  if (videoPath === null || recordingStartSec === null) {
    return { checked: 0, corrections: [], cancelled: false, failure: 'no-recording' };
  }

  const rows = await sessionShots(sessionId);
  const eligible = rows.filter(isRecheckable);
  if (eligible.length === 0) {
    return { checked: 0, corrections: [], cancelled: false, failure: 'nothing-to-check' };
  }

  // Same engine + preprocessing as the live camera and the Test AI screen.
  const config = resolveDetectorConfig();
  const model = await ensureModel(config);
  if (model === null) {
    return { checked: 0, corrections: [], cancelled: false, failure: 'no-model' };
  }

  const S = config.input;
  const detectFrame = async (videoTimeSec: number): Promise<Detection[]> => {
    let uri: string;
    try {
      const thumb = await VideoThumbnails.getThumbnailAsync(videoPath, {
        time: Math.max(0, Math.round(videoTimeSec * 1000)),
        quality: THUMB_QUALITY,
      });
      uri = thumb.uri;
    } catch {
      // One unreadable timestamp shouldn't sink the shot — empty frame.
      return [];
    }
    try {
      const boxes = await detectImageToBoxes(uri, model, config);
      // detectImageToBoxes normalizes 0..1 against the model's square input;
      // the tracker/FSM core wants analysis-frame pixels of that same square.
      return boxes.map((b) => ({
        cls: b.cls,
        score: b.score,
        box: { x: b.x * S, y: b.y * S, width: b.w * S, height: b.h * S },
      }));
    } catch {
      return [];
    }
  };

  const byShotId = new Map<number, ShotRow>(eligible.map((r) => [r.id, r]));
  const corrections: RecheckCorrection[] = [];

  const summary = await recheckShots(
    eligible.map((r) => ({ shotId: r.id, tResolved: r.tResolved, outcome: r.outcome })),
    { detectFrame, frameSize: S, recordingStartSec, isCancelled },
    {
      onProgress,
      onResult: async (result: RecheckShotResult) => {
        const row = byShotId.get(result.shotId);
        if (row === undefined) return;
        // Stamp per shot as it completes, so a later cancel keeps the work
        // already done instead of repeating it next run.
        await markShotRechecked(row.id);
        if (result.verdict !== null) {
          // The machine's own re-read — corrected stays FALSE (not a user edit).
          await updateShotOutcome(row.id, result.verdict, false);
          corrections.push({
            rowId: row.id,
            shotIndex: row.shotIndex,
            outcome: result.verdict,
          });
        }
      },
    },
  );

  return { checked: summary.checked, corrections, cancelled: summary.cancelled };
}
