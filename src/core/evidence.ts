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
import type { ResolvedShot, ShotOutcome, ShotSignals, ShotValueSource } from './types';

/** Chip tone for one signal state (subset of ui.tsx Chip tones). */
export type EvidenceTone = 'make' | 'miss' | 'default';

export interface EvidenceChannel {
  /** One of the three fusion channels (not the diagnostic `illusion` tag). */
  key: 'geo' | 'net' | 'cls';
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
 * Tiny receipt-chip label for a depth-illusion ("錯視") veto, or null when the
 * parallax guard did not overturn this shot. Reads as the same uppercase fine
 * print as the PATH/NET/SEEN chips.
 */
export function illusionChipLabel(signals: ShotSignals): string | null {
  if (signals.illusion === 'front') return '✕ IN FRONT';
  if (signals.illusion === 'behind') return '✕ BEHIND';
  return null;
}

/** Human phrase for the accessibility summary, or null when no illusion veto. */
export function illusionPhrase(signals: ShotSignals): string | null {
  if (signals.illusion === 'front')
    return 'ball crossed in front of the hoop — optical illusion, not a make';
  if (signals.illusion === 'behind')
    return 'ball passed behind the hoop — optical illusion, not a make';
  return null;
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
  const illusion = illusionPhrase(signals);
  if (illusion) parts.push(illusion);
  return `Evidence: ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// 2/3 provenance + ONE confidence language (shared by every detection surface)
// ---------------------------------------------------------------------------

/** Coarse confidence tier — the single scale the receipt, badge + zone tint
 *  all speak, so "confidence" reads as one signal app-wide (not three meters). */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Map a 0..1 confidence to its tier. Boundaries: ≥0.8 high, ≥0.55 medium. */
export function confidenceLevel(c: number): ConfidenceLevel {
  if (c >= 0.8) return 'high';
  if (c >= 0.55) return 'medium';
  return 'low';
}

/** Short human label for a confidence tier. */
export function confidenceLabel(level: ConfidenceLevel): string {
  return level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';
}

/** Short label for which estimator decided the 2/3 value. */
export function valueSourceLabel(source: ShotValueSource): string {
  switch (source) {
    case 'court':
      return 'Court-registered';
    case 'metric':
      return 'Measured';
    case 'heuristic':
      return 'Estimated';
    case 'manual':
      return 'Manual';
  }
}

/** One-line explanation of the 2/3 provenance for the receipt. */
export function valueSourcePhrase(source: ShotValueSource): string {
  switch (source) {
    case 'court':
      return 'mapped to your calibrated court — corner-accurate';
    case 'metric':
      return 'real-distance estimate from rim geometry';
    case 'heuristic':
      return 'image-distance estimate (uncalibrated)';
    case 'manual':
      return 'you set the court range by hand';
  }
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

// ---------------------------------------------------------------------------
// Receipt detail — plain-English channel + verdict explanations
// ---------------------------------------------------------------------------

/**
 * One plain-English line per fusion channel for the expanded receipt detail.
 * Mirrors the glyph chips exactly: yes / no / no data, never a guess.
 */
export function channelExplanation(
  key: 'geo' | 'net' | 'cls',
  value: boolean | null,
): string {
  switch (key) {
    case 'geo':
      return value === true
        ? 'Path — the tracked flight crossed down through the hoop'
        : value === false
          ? 'Path — the tracked flight never went through the hoop'
          : 'Path — the crossing was blocked from view';
    case 'net':
      return value === true
        ? 'Net — the net moved right when the ball arrived'
        : value === false
          ? 'Net — the net stayed still'
          : 'Net — no net in view on this hoop';
    case 'cls':
      return value === true
        ? 'Seen — the AI saw the ball inside the hoop'
        : value === false
          ? 'Seen — the AI never saw the ball inside the hoop'
          : 'Seen — no clear look inside the hoop';
  }
}

/**
 * One-sentence verdict narrative derived STRICTLY from the persisted signals.
 * It explains the call that was already made — it never re-judges.
 * Invariant (copy-layer mirror of the bread-ball rule): the word MAKE must
 * never appear in a miss or unsure narrative.
 *
 * `corrected`: pass the shot's corrected flag. A corrected outcome is the
 * USER'S call — corrections rewrite `outcome` but never `signalsJson`, so the
 * persisted signals still describe the ORIGINAL machine call. Rendering a
 * machine-verdict sentence ("Called MAKE — the strongest signals pointed
 * in.") over three channels that all said NO would fabricate machine-make
 * attribution; a corrected shot instead gets an honest correction sentence
 * and the signals below keep describing the original call.
 */
export function verdictNarrative(
  outcome: ShotOutcome,
  signals: ShotSignals,
  rimBounce: boolean,
  corrected?: boolean,
): string {
  if (corrected === true) {
    const noun =
      outcome === 'make' ? 'MAKE' : outcome === 'miss' ? 'MISS' : 'UNSURE';
    return `You corrected this to ${noun} — the signals below show the original call, not your correction.`;
  }
  let base: string;
  if (outcome === 'make') {
    if (signals.geo === true && signals.net === true) {
      base = 'Called MAKE — the ball’s path and the net agree.';
    } else if (signals.geo === true && signals.net === null) {
      base = 'Called MAKE — clean path through the hoop (no net in view).';
    } else if (signals.net === true && signals.cls === true) {
      base = 'Called MAKE — the net moved and the ball was seen inside.';
    } else {
      base = 'Called MAKE — the strongest signals pointed in.';
    }
  } else if (outcome === 'miss') {
    if (signals.illusion != null) {
      base = 'Called MISS — the ball only LOOKED like it went in from this angle.';
    } else if (signals.geo === false) {
      base = 'Called MISS — the path never went through the hoop.';
    } else {
      base = 'Called MISS — no signal showed the ball going in.';
    }
  } else {
    base =
      'Called UNSURE — the signals disagreed, so no guess was made. You can correct it below; your corrections are always labeled.';
  }
  if (rimBounce && outcome !== 'unsure') base += ' It rattled the rim on the way.';
  return base;
}
