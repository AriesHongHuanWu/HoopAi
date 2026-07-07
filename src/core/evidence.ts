/**
 * Evidence receipts — pure helpers behind the per-shot "shows its work" row.
 *
 * Every resolved shot carries the three fused make/miss channels
 * ({@link ShotSignals}: geo/net/cls, null = channel unavailable that shot)
 * plus the rimBounce flag. The shot list renders them as tiny receipt chips
 * under each verdict so the app never asks to be trusted blindly; these
 * helpers keep the chip content, the accessibility summary and the
 * correction-undo bookkeeping testable and consistent across screens.
 */
import type { ResolvedShot, ShotOutcome, ShotSignals } from './types';

/** Chip tone for one signal state (subset of ui.tsx Chip tones). */
export type EvidenceTone = 'make' | 'miss' | 'default';

export interface EvidenceChannel {
  key: keyof ShotSignals;
  /** Tiny chip label — receipts read as uppercase fine print. */
  label: string;
  /** Human phrase used in the accessibility summary. */
  phrase: string;
}

/** The three fusion channels, in the order the receipt row shows them. */
export const EVIDENCE_CHANNELS: readonly EvidenceChannel[] = [
  // Geometric rim-plane crossing test (shotFsm's geo channel).
  { key: 'geo', label: 'PATH', phrase: 'ball path through hoop' },
  // Net-motion burst within the resolve window.
  { key: 'net', label: 'NET', phrase: 'net movement' },
  // 'ball_in_basket' detector class fired during the live shot.
  { key: 'cls', label: 'SEEN', phrase: 'ball seen in hoop' },
] as const;

/** Receipt glyph: signal said make / said miss / had no data. */
export function evidenceGlyph(value: boolean | null): '✓' | '✕' | '—' {
  return value === true ? '✓' : value === false ? '✕' : '—';
}

/** Chip tone matching the glyph (dim default for a silent channel). */
export function evidenceTone(value: boolean | null): EvidenceTone {
  return value === true ? 'make' : value === false ? 'miss' : 'default';
}

function phraseState(value: boolean | null): string {
  return value === true ? 'yes' : value === false ? 'no' : 'no data';
}

/**
 * One-sentence accessibility summary of a shot's evidence, e.g.
 * "Evidence: ball path through hoop yes, net movement no, ball seen in hoop
 * no data, rim bounce."
 */
export function evidenceSummary(signals: ShotSignals, rimBounce: boolean): string {
  const parts = EVIDENCE_CHANNELS.map(
    (c) => `${c.phrase} ${phraseState(signals[c.key])}`,
  );
  if (rimBounce) parts.push('rim bounce');
  return `Evidence: ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Correction undo bookkeeping (swipe-to-correct snackbar)
// ---------------------------------------------------------------------------

/** Snackbar line for a just-applied outcome correction. */
export function correctionMessage(shotId: number, outcome: ShotOutcome): string {
  const noun =
    outcome === 'make' ? 'a make' : outcome === 'miss' ? 'a miss' : 'unsure';
  return `Shot ${shotId} marked ${noun}`;
}

/**
 * What to re-apply to UNDO a correction, computed from the PRE-correction
 * shot snapshot: its previous outcome and its previous corrected flag — so
 * undoing a first-ever correction also clears the "Edited" badge instead of
 * leaving a stale one behind.
 */
export function correctionRevert(
  shot: Pick<ResolvedShot, 'outcome' | 'corrected'>,
): { outcome: ShotOutcome; corrected: boolean } {
  return { outcome: shot.outcome, corrected: shot.corrected === true };
}
