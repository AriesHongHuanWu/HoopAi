/**
 * CSV export — pure RFC-4180 builders for session summaries (and optionally
 * their shots), plus a never-throw pipeline that writes the CSV to the
 * expo-file-system legacy cache and hands it to the native share sheet.
 *
 * Mirrors src/components/ShareCard.tsx's share pipeline: iOS shares the file
 * directly (Share.share({ url })); Android's RN Share can't attach arbitrary
 * files, so it falls back to sharing the CSV as share text (same pattern as
 * src/data/videoLibrary.ts's never-throw file helpers). Every public
 * function here is safe to call from UI code without a try/catch.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { Platform, Share } from 'react-native';

import type { SessionSummaryRow } from '../data/db';
import type { ShotOutcome } from './types';

// ---------------------------------------------------------------------------
// RFC-4180 field/row helpers
// ---------------------------------------------------------------------------

/**
 * Quote a single CSV field per RFC-4180: wrap in double quotes (doubling any
 * embedded quote) whenever the value contains a comma, a double quote, or a
 * line break. Plain values pass through unquoted.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join already-escaped fields into one CRLF-terminated CSV row. */
export function csvRow(fields: readonly (string | number | boolean | null | undefined)[]): string {
  return fields.map(csvField).join(',') + '\r\n';
}

// ---------------------------------------------------------------------------
// Session summary CSV
// ---------------------------------------------------------------------------

const SESSION_HEADER = [
  'Session ID',
  'Date',
  'Time',
  'Tag',
  'Mode',
  'Attempts',
  'Makes',
  'FG%',
] as const;

/** "YYYY-MM-DD" in local time, sortable and locale-independent. */
function isoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "HH:MM" 24h local time. */
function isoTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Build an RFC-4180 CSV of session summaries — one row per session, header
 * first. Pure; does no I/O. `rows` should already be in the order the caller
 * wants exported (History exports newest-first, matching the list).
 */
export function sessionsToCsv(rows: readonly SessionSummaryRow[]): string {
  let out = csvRow(SESSION_HEADER);
  for (const r of rows) {
    out += csvRow([
      r.id,
      isoDate(r.startedAt),
      isoTime(r.startedAt),
      r.label,
      r.modeId ?? '',
      r.attempts,
      r.makes,
      r.attempts > 0 ? Math.round(r.fgPct * 1000) / 10 : 0,
    ]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shot detail CSV
// ---------------------------------------------------------------------------

/** Minimal shot shape the CSV builder needs — a subset of ResolvedShot. */
export interface CsvShotInput {
  id: number;
  tResolved: number;
  outcome: ShotOutcome;
  shotValue?: number;
  entryAngleDeg: number | null;
  releaseAngleDeg: number | null;
  corrected?: boolean;
}

const SHOT_HEADER = [
  'Session ID',
  'Shot #',
  'Time (s)',
  'Outcome',
  'Points',
  'Entry angle',
  'Release angle',
  'Corrected',
] as const;

/**
 * Build an RFC-4180 CSV of individual shots across one or more sessions —
 * one row per shot, header first. `sessionId` is attached per-shot so a
 * multi-session export stays joinable to the sessions CSV.
 */
export function shotsToCsv(
  shotsBySession: readonly { sessionId: number; shots: readonly CsvShotInput[] }[],
): string {
  let out = csvRow(SHOT_HEADER);
  for (const { sessionId, shots } of shotsBySession) {
    for (const s of shots) {
      out += csvRow([
        sessionId,
        s.id,
        Math.round(s.tResolved * 10) / 10,
        s.outcome,
        s.shotValue === 3 ? 3 : 2,
        s.entryAngleDeg != null ? Math.round(s.entryAngleDeg) : '',
        s.releaseAngleDeg != null ? Math.round(s.releaseAngleDeg) : '',
        s.corrected === true ? 'yes' : 'no',
      ]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Never-throw write + share pipeline
// ---------------------------------------------------------------------------

async function shareCsvText(csv: string): Promise<boolean> {
  try {
    await Share.share({ message: csv });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a CSV string to the app cache and hand it to the native share sheet.
 * iOS shares the file directly (Share.share({ url })) so it opens cleanly in
 * Files/Mail/etc; Android falls back to sharing the CSV text inline (RN
 * Share can't attach arbitrary files there — same tradeoff ShareCard makes
 * for images). Any failure anywhere falls back to the text share. Resolves
 * false only when even that failed. NEVER throws.
 */
export async function exportCsv(csv: string, fileName = 'hoopilot-export.csv'): Promise<boolean> {
  try {
    const dir = FileSystem.cacheDirectory;
    if (dir == null) return shareCsvText(csv);
    const uri = `${dir}${fileName}`;
    await FileSystem.writeAsStringAsync(uri, csv, { encoding: 'utf8' });
    if (Platform.OS === 'ios') {
      await Share.share({ url: uri });
      return true;
    }
    return shareCsvText(csv);
  } catch (err) {
    console.warn('[csvExport] Export failed, falling back to text share', err);
    return shareCsvText(csv);
  }
}
