/**
 * Correction data flywheel — opt-in export of HARD EXAMPLES: the shots the
 * detector got wrong (user-corrected) or couldn't decide ('unsure'), across
 * every session that still has its master recording.
 *
 * The export is a JSON MANIFEST ONLY — no video ever leaves the phone. Each
 * example carries the session's videoPath plus a [windowStartSec,
 * windowEndSec] trim window (clipPlanner math shifted into video time via
 * recordingStartSec, see src/core/clipPlanner.ts and SessionRow), so the
 * clips can be extracted on a desktop from the original recordings and fed
 * into model training.
 *
 * KNOWN LIMIT: the shots table persists only the CURRENT outcome — a
 * correction overwrites the detector's original call. So `originalOutcome`
 * is only known for uncorrected 'unsure' rows; for corrected rows it is null
 * and the persisted per-shot signals (geo/net/cls) are the record of what
 * the detector saw.
 *
 * Mirrors src/core/csvExport.ts's never-throw write + share pipeline: iOS
 * shares the manifest file (Share.share({ url })); Android's RN Share can't
 * attach arbitrary files, so it shares the JSON as text. Every public
 * function is safe to call from UI code without a try/catch.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform, Share } from 'react-native';

import { CLIPS } from '../core/config';
import type { ShotOutcome, ShotSignals } from '../core/types';
import { getDb } from './db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HardExampleDeviceInfo {
  /** Platform.OS — 'ios' | 'android' | ... */
  os: string;
  /** Human-readable device model (expo-device), when available. */
  model: string | null;
}

/** One hard example — everything needed to cut + label its clip off-device. */
export interface HardExample {
  sessionId: number;
  /** Per-session shot number (1-based) — matches the in-app "Shot N" labels. */
  shotId: number;
  /**
   * What the detector originally called. Only known for uncorrected rows
   * (always 'unsure' here); null for corrected rows, where the correction
   * overwrote it (see module header).
   */
  originalOutcome: ShotOutcome | null;
  /** The user's hand-verified outcome — ground truth. Null when not corrected. */
  correctedOutcome: ShotOutcome | null;
  /** True when the user flipped this shot by hand. */
  corrected: boolean;
  /** The three fused make/miss signals the detector saw (null = unavailable). */
  signals: ShotSignals;
  rimBounce: boolean;
  /** Absolute path of the session's master recording ON THE PHONE. */
  videoPath: string;
  /** Trim window, seconds into the video file at `videoPath`. */
  windowStartSec: number;
  /** Unclamped at the top end — clamp to the file's duration when cutting. */
  windowEndSec: number;
  deviceInfo: HardExampleDeviceInfo;
  appVersion: string;
}

export interface HardExampleManifest {
  format: 'hoopilot-hard-examples';
  version: 1;
  /** ISO-8601 export timestamp. */
  exportedAt: string;
  /** Human note making the no-video contract explicit to whoever opens this. */
  note: string;
  exampleCount: number;
  examples: HardExample[];
}

// ---------------------------------------------------------------------------
// Collection — pure assembly over persisted rows
// ---------------------------------------------------------------------------

/** Joined shot + session row shape the hard-example query selects. */
interface HardExampleRow {
  sessionId: number;
  shotIndex: number;
  tResolved: number;
  outcome: ShotOutcome;
  corrected: number;
  rimBounce: number;
  signalsJson: string;
  videoPath: string;
  recordingStartSec: number;
}

/** Rows that are hard examples AND belong to a session with a recording. */
const HARD_EXAMPLE_WHERE = `
  (sh.corrected = 1 OR sh.outcome = 'unsure')
  AND s.videoPath IS NOT NULL
  AND s.recordingStartSec IS NOT NULL`;

const FALLBACK_SIGNALS: ShotSignals = { geo: null, net: null, cls: null };

/** JSON.parse that can never throw (corrupt persisted rows — see db.ts). */
function parseSignals(raw: string): ShotSignals {
  try {
    return JSON.parse(raw) as ShotSignals;
  } catch {
    return FALLBACK_SIGNALS;
  }
}

function deviceInfo(): HardExampleDeviceInfo {
  return { os: Platform.OS, model: Device.modelName ?? null };
}

function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

/**
 * Map one persisted row to a manifest example, or null when the shot's clip
 * window falls entirely before the recording started (nothing to cut).
 *
 * Window math is planClips's per-shot window shifted into video time:
 * engine [tResolved − preRoll, tResolved + postRoll], minus recordingStartSec
 * (videoTime = tResolved − recordingStartSec, see SessionRow), floored at 0.
 * The top end stays unclamped — the video's duration isn't known here.
 */
export function exampleFromRow(
  row: HardExampleRow,
  device: HardExampleDeviceInfo,
  version: string,
): HardExample | null {
  const videoTimeSec = row.tResolved - row.recordingStartSec;
  const windowEndSec = videoTimeSec + CLIPS.postRollSec;
  if (windowEndSec <= 0) return null; // Resolved before the recording began.
  const corrected = row.corrected === 1;
  return {
    sessionId: row.sessionId,
    shotId: row.shotIndex,
    originalOutcome: corrected ? null : row.outcome,
    correctedOutcome: corrected ? row.outcome : null,
    corrected,
    signals: parseSignals(row.signalsJson),
    rimBounce: row.rimBounce === 1,
    videoPath: row.videoPath,
    windowStartSec: Math.max(0, videoTimeSec - CLIPS.preRollSec),
    windowEndSec,
    deviceInfo: device,
    appVersion: version,
  };
}

/**
 * Collect the most recent hard examples (corrected OR unsure shots) across
 * all sessions that still have a recording, newest session first. Never
 * throws — any persistence failure returns an empty list.
 */
export async function collectHardExamples(limit = 50): Promise<HardExample[]> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<HardExampleRow>(
      `SELECT sh.sessionId, sh.shotIndex, sh.tResolved, sh.outcome,
              sh.corrected, sh.rimBounce, sh.signalsJson,
              s.videoPath, s.recordingStartSec
       FROM shots sh
       JOIN sessions s ON s.id = sh.sessionId
       WHERE ${HARD_EXAMPLE_WHERE}
       ORDER BY s.startedAt DESC, sh.shotIndex ASC
       LIMIT ?`,
      limit,
    );
    const device = deviceInfo();
    const version = appVersion();
    const examples: HardExample[] = [];
    for (const row of rows) {
      const example = exampleFromRow(row, device, version);
      if (example != null) examples.push(example);
    }
    return examples;
  } catch (err) {
    console.warn('[hardExamples] collectHardExamples failed', err);
    return [];
  }
}

/**
 * How many hard examples an export would cover — drives the live count on
 * the Settings row. Never throws; failures report 0.
 */
export async function countHardExamples(): Promise<number> {
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM shots sh
       JOIN sessions s ON s.id = sh.sessionId
       WHERE ${HARD_EXAMPLE_WHERE}`,
    );
    return row?.n ?? 0;
  } catch (err) {
    console.warn('[hardExamples] countHardExamples failed', err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Manifest build + never-throw share pipeline
// ---------------------------------------------------------------------------

/** Pure manifest envelope around collected examples. */
export function buildManifest(
  examples: readonly HardExample[],
  nowMs = Date.now(),
): HardExampleManifest {
  return {
    format: 'hoopilot-hard-examples',
    version: 1,
    exportedAt: new Date(nowMs).toISOString(),
    note:
      'Manifest only — no video is included. Each example points at a ' +
      'session recording on the exporting phone (videoPath) with a ' +
      '[windowStartSec, windowEndSec] trim window; extract the clips from ' +
      'those recordings on a desktop.',
    exampleCount: examples.length,
    examples: [...examples],
  };
}

const MANIFEST_FILE_NAME = 'hoopilot-hard-examples.json';

async function shareManifestText(json: string): Promise<boolean> {
  try {
    await Share.share({ message: json });
    return true;
  } catch {
    return false;
  }
}

/** Result of {@link exportHardExamples} — `count` is 0 when there was nothing to export. */
export interface HardExampleExportResult {
  ok: boolean;
  count: number;
}

/**
 * One-tap, fully manual export: collect the hard examples, write the JSON
 * manifest to the app cache and hand it to the native share sheet. iOS
 * shares the file directly (Share.share({ url })); Android falls back to
 * sharing the JSON text inline — the same tradeoff src/core/csvExport.ts
 * makes. Resolves { ok: false } when there is nothing to export or when
 * even the text share failed. NEVER throws.
 */
export async function exportHardExamples(limit = 50): Promise<HardExampleExportResult> {
  const examples = await collectHardExamples(limit);
  if (examples.length === 0) return { ok: false, count: 0 };
  const json = JSON.stringify(buildManifest(examples), null, 2);
  try {
    const dir = FileSystem.cacheDirectory;
    if (dir == null) return { ok: await shareManifestText(json), count: examples.length };
    const uri = `${dir}${MANIFEST_FILE_NAME}`;
    await FileSystem.writeAsStringAsync(uri, json, { encoding: 'utf8' });
    if (Platform.OS === 'ios') {
      await Share.share({ url: uri });
      return { ok: true, count: examples.length };
    }
    return { ok: await shareManifestText(json), count: examples.length };
  } catch (err) {
    console.warn('[hardExamples] Export failed, falling back to text share', err);
    return { ok: await shareManifestText(json), count: examples.length };
  }
}
