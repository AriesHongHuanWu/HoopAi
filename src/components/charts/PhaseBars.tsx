/**
 * PhaseBars — the 4-segment shooting-motion timing bar (DIP → RISE → RELEASE
 * → FOLLOW) for Form Check reps.
 *
 * Purely presentational and deliberately View-based: no Skia, no worklets —
 * this is a proportion read, not a curve, and plain Views keep it renderable
 * in every jest suite the screen carries. The parent supplies pixel width and
 * a {@link RepPhaseTiming}; each measured segment gets width proportional to
 * its duration, and an UNMEASURED segment renders as a fixed narrow gap with
 * an em dash — never interpolated, never hidden (an absent phase is a fact
 * the bar must show).
 *
 * `range` (min/max across a session's reps) renders per-segment whisker
 * captions under the labels — the honest "how much this phase wandered" read
 * for the Overview's session-median bar.
 *
 * Segments share ONE hue (the accent) on an opacity ramp; meaning is carried
 * by position + label, so the ramp stays legible for colorblind users.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, space, type } from '@/constants/tokens';
import type { RepPhaseTiming } from '@/core/formCheck';

/** Draw order of the four phases — the shot's own chronology. */
export const PHASE_KEYS = ['dipMs', 'riseMs', 'releaseMs', 'followMs'] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];

/** Bar labels — the motion theater's phase vocabulary, one word each. */
export const PHASE_LABEL: Record<PhaseKey, string> = {
  dipMs: 'DIP',
  riseMs: 'RISE',
  releaseMs: 'RELEASE',
  followMs: 'FOLLOW',
};

/** Accent opacity ramp per phase (position + label carry the meaning). */
const PHASE_OPACITY: Record<PhaseKey, number> = {
  dipMs: 0.35,
  riseMs: 0.6,
  releaseMs: 1,
  followMs: 0.45,
};

/** Fixed width of an unmeasured segment's gap slot, px. */
const GAP_SLOT_W = 14;
/** Bar heights. */
const BAR_H = 10;
const BAR_H_COMPACT = 6;
/** Floor width for a measured segment so a tiny phase stays visible. */
const MIN_SEG_W = 6;

export interface PhaseBarsProps {
  /** Segment durations, ms — each independently nullable. */
  phases: RepPhaseTiming;
  /** Total pixel width the bar may occupy. */
  width: number;
  /** Micro variant: bar only, no labels (live last-rep line, rep rows). */
  compact?: boolean;
  /**
   * Per-segment min/max across the session's reps — rendered as a whisker
   * caption ("0.38–0.61 s") under each measured segment. Overview only.
   */
  range?: { min: RepPhaseTiming; max: RepPhaseTiming } | null;
  /** Override for the composed screen-reader label. */
  accessibilityLabel?: string;
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Composed screen-reader read: every phase, measured or honestly not. */
export function phaseBarsA11y(phases: RepPhaseTiming): string {
  return PHASE_KEYS.map((k) => {
    const v = phases[k];
    return `${PHASE_LABEL[k]} ${v != null ? fmtSec(v) : 'not measured'}`;
  }).join(', ');
}

export function PhaseBars({
  phases,
  width,
  compact = false,
  range = null,
  accessibilityLabel,
}: PhaseBarsProps) {
  const measured = PHASE_KEYS.filter((k) => phases[k] != null);
  const gaps = PHASE_KEYS.length - measured.length;
  const total = measured.reduce((sum, k) => sum + (phases[k] ?? 0), 0);
  const usable = Math.max(0, width - gaps * GAP_SLOT_W);
  const barH = compact ? BAR_H_COMPACT : BAR_H;

  /** Pixel width of one segment (null = its fixed gap slot). */
  const segW = (k: PhaseKey): number => {
    const v = phases[k];
    if (v == null) return GAP_SLOT_W;
    if (total <= 0 || usable <= 0) return MIN_SEG_W;
    return Math.max(MIN_SEG_W, (v / total) * usable);
  };

  return (
    <View
      style={{ width }}
      accessible
      accessibilityLabel={accessibilityLabel ?? phaseBarsA11y(phases)}
    >
      <View style={styles.barRow}>
        {PHASE_KEYS.map((k) => {
          const v = phases[k];
          return v != null ? (
            <View
              key={k}
              style={[
                styles.seg,
                {
                  width: segW(k),
                  height: barH,
                  backgroundColor: color.accent,
                  opacity: PHASE_OPACITY[k],
                },
              ]}
            />
          ) : (
            // Unmeasured: a hollow gap slot — a hole in the record, not zero.
            <View key={k} style={[styles.gapSlot, { width: GAP_SLOT_W, height: barH }]} />
          );
        })}
      </View>
      {!compact && (
        <View style={styles.labelRow}>
          {PHASE_KEYS.map((k) => {
            const v = phases[k];
            const min = range?.min[k];
            const max = range?.max[k];
            return (
              <View key={k} style={[styles.labelCell, { width: segW(k) }]}>
                <Text style={styles.phaseName} numberOfLines={1}>
                  {PHASE_LABEL[k]}
                </Text>
                <Text style={v != null ? styles.phaseValue : styles.phaseDash} numberOfLines={1}>
                  {v != null ? fmtSec(v) : '—'}
                </Text>
                {v != null && min != null && max != null && (
                  <Text style={styles.phaseRange} numberOfLines={1}>
                    {`${(min / 1000).toFixed(2)}–${(max / 1000).toFixed(2)} s`}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default PhaseBars;

const styles = StyleSheet.create({
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  seg: {
    borderRadius: 3,
  },
  gapSlot: {
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: 'transparent',
  },
  labelRow: {
    flexDirection: 'row',
    gap: 2,
    marginTop: space.xs,
  },
  labelCell: {
    minWidth: GAP_SLOT_W,
  },
  phaseName: {
    ...type.micro,
    color: color.textFaint,
  },
  phaseValue: {
    ...type.micro,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  phaseDash: {
    ...type.micro,
    color: color.textFaint,
  },
  phaseRange: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
});
