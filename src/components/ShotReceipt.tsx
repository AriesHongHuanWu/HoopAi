/**
 * ShotReceipt — the per-shot evidence receipt ("shows its work"), extracted
 * from ShotList's internal SignalReceipts and upgraded with an expandable
 * plain-English detail view.
 *
 * Collapsed, it renders EXACTLY what SignalReceipts rendered: one tiny chip
 * per fusion channel (geo/net/cls) — green check when the signal said make,
 * red x when it said miss, dim "—" when the channel had no data that shot —
 * plus a rim-bounce chip, an optional depth-illusion veto chip, and the 2/3
 * provenance line (which estimator decided the point value, its confidence on
 * the one shared scale, and the real distance when court-registered).
 *
 * Tapping the row (when `expandable`) opens a receipt detail: a one-sentence
 * verdict narrative plus one plain-English line per channel. Every string
 * comes verbatim from the pure helpers in src/core/evidence.ts — this
 * component explains the call that was already made; it never re-judges and
 * never invents confidence the shot doesn't carry.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  useReducedMotion,
} from 'react-native-reanimated';

import { Chip } from '@/components/ui';
import { Ionicons } from '@expo/vector-icons';

import { color, confidenceColor, motion, space, type } from '@/constants/tokens';
import {
  channelExplanation,
  confidenceLabel,
  confidenceLevel,
  EVIDENCE_CHANNELS,
  evidenceGlyph,
  evidenceSummary,
  evidenceTone,
  illusionChipLabel,
  valueSourceLabel,
  valueSourcePhrase,
  verdictNarrative,
  type EvidenceTone,
} from '@/core/evidence';
import type { ResolvedShot } from '@/core/types';

// ---------------------------------------------------------------------------
// Pure derivations (exported for tests — the render maps over these verbatim)
// ---------------------------------------------------------------------------

/** Glyph tint per evidence tone — mirrors the Chip tones the row shows. */
export const EVIDENCE_TONE_COLOR: Record<EvidenceTone, string> = {
  make: color.make,
  miss: color.miss,
  default: color.textFaint,
};

/**
 * Accessibility label for the collapsed receipt row: the evidence summary
 * plus the 2/3 provenance suffix when the shot carries one. Byte-identical to
 * the label ShotList's SignalReceipts produced.
 */
export function receiptA11yLabel(shot: ResolvedShot): string {
  const source = shot.valueSource;
  const level =
    shot.valueConfidence != null ? confidenceLevel(shot.valueConfidence) : null;
  const provenance =
    source != null
      ? `. Two or three call by ${valueSourceLabel(source)}${
          level != null ? `, ${confidenceLabel(level)} confidence` : ''
        }`
      : '';
  return evidenceSummary(shot.signals, shot.rimBounce) + provenance;
}

export interface ReceiptChannelLine {
  key: 'geo' | 'net' | 'cls';
  /** Receipt glyph for the channel's persisted state (✓ / ✕ / —). */
  glyph: string;
  /** Tone driving the glyph tint (never recomputed in render). */
  tone: EvidenceTone;
  /** Plain-English explanation, verbatim from channelExplanation. */
  text: string;
}

export interface ReceiptDetail {
  /** One-sentence verdict narrative, verbatim from verdictNarrative. */
  narrative: string;
  /** One line per fusion channel, in EVIDENCE_CHANNELS order. */
  channels: ReceiptChannelLine[];
  /** "2/3 call: …" provenance phrase, or null when 2/3 estimation didn't run. */
  provenance: string | null;
}

/**
 * Everything the expanded detail renders, derived STRICTLY from the persisted
 * shot via the evidence helpers — the component adds no copy of its own, so
 * the honesty truth-table tests on this function cover the whole detail view.
 */
export function receiptDetail(shot: ResolvedShot): ReceiptDetail {
  return {
    // Corrections rewrite `outcome` but never the persisted signals, so a
    // corrected shot must get the correction-aware sentence — rendering a
    // machine "Called MAKE/MISS" over the original signals would fabricate
    // machine attribution for the user's call.
    narrative: verdictNarrative(
      shot.outcome,
      shot.signals,
      shot.rimBounce,
      shot.corrected === true,
    ),
    channels: EVIDENCE_CHANNELS.map((c) => {
      const value = shot.signals[c.key];
      return {
        key: c.key,
        glyph: evidenceGlyph(value),
        tone: evidenceTone(value),
        text: channelExplanation(c.key, value),
      };
    }),
    provenance:
      shot.valueSource != null
        ? `2/3 call: ${valueSourcePhrase(shot.valueSource)}`
        : null,
  };
}

// ---------------------------------------------------------------------------
// ShotReceipt
// ---------------------------------------------------------------------------

export function ShotReceipt({
  shot,
  expandable = true,
}: {
  shot: ResolvedShot;
  expandable?: boolean;
}) {
  // Expansion state lives HERE: ShotListItem is React.memo'd on the shot
  // object, so a row toggling open must never re-render its siblings.
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();

  const source = shot.valueSource;
  const level =
    shot.valueConfidence != null ? confidenceLevel(shot.valueConfidence) : null;
  const detail = open ? receiptDetail(shot) : null;

  const column = (
    <Animated.View
      // Layout on the column so the host FlatList row grows smoothly when the
      // detail opens (the list is scrollEnabled={false} inside a ScrollView,
      // so height growth is safe).
      layout={
        expandable && !reducedMotion
          ? LinearTransition.duration(motion.quick)
          : undefined
      }
      style={styles.receiptCol}
    >
      <View
        accessible
        accessibilityLabel={receiptA11yLabel(shot)}
        style={styles.receiptRow}
      >
        {EVIDENCE_CHANNELS.map((c) => {
          const value = shot.signals[c.key];
          return (
            <Chip
              key={c.key}
              compact
              tone={evidenceTone(value)}
              label={`${evidenceGlyph(value)} ${c.label}`}
            />
          );
        })}
        {shot.rimBounce && <Chip compact tone="unsure" label="RIM BOUNCE" />}
        {illusionChipLabel(shot.signals) != null && (
          <Chip compact tone="miss" label={illusionChipLabel(shot.signals)!} />
        )}
        {expandable && (
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={12}
            color={color.textFaint}
            style={styles.chevron}
          />
        )}
      </View>
      {source != null && (
        <View style={styles.provenanceRow} importantForAccessibility="no-hide-descendants">
          <Ionicons
            name={source === 'court' ? 'locate' : 'analytics-outline'}
            size={11}
            color={source === 'court' ? color.make : color.textFaint}
          />
          <Text style={styles.provenanceText} numberOfLines={1}>
            {'2/3: '}
            <Text style={styles.provenanceSource}>{valueSourceLabel(source)}</Text>
            {level != null && (
              <Text style={{ color: confidenceColor[level] }}>{` · ${confidenceLabel(level)}`}</Text>
            )}
            {source === 'court' && shot.distanceM != null && (
              <Text style={styles.provenanceText}>{` · ${shot.distanceM.toFixed(1)} m`}</Text>
            )}
          </Text>
        </View>
      )}
      {detail != null && (
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.duration(motion.quick)}
          accessible
          accessibilityLabel={detail.narrative}
        >
          <Text style={styles.narrative}>{detail.narrative}</Text>
          {detail.channels.map((line) => (
            <Text key={line.key} style={styles.detailLine}>
              <Text style={{ color: EVIDENCE_TONE_COLOR[line.tone] }}>
                {line.glyph}
              </Text>
              {` ${line.text}`}
            </Text>
          ))}
          {detail.provenance != null && (
            <Text style={styles.detailProvenance}>{detail.provenance}</Text>
          )}
        </Animated.View>
      )}
    </Animated.View>
  );

  if (!expandable) return column;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Shows why this call was made"
      accessibilityState={{ expanded: open }}
      hitSlop={6}
      onPress={() => setOpen((v) => !v)}
    >
      {column}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // receiptCol / receiptRow / provenance* replicate ShotList's SignalReceipts
  // styles exactly — collapsed rendering must not drift from the original.
  receiptCol: {
    gap: 4,
  },
  receiptRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.xs,
  },
  provenanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  provenanceText: {
    ...type.micro,
    color: color.textFaint,
  },
  provenanceSource: {
    ...type.micro,
    color: color.textDim,
  },
  chevron: {
    marginLeft: 'auto',
  },
  narrative: {
    ...type.caption,
    color: color.text,
    marginTop: space.sm,
  },
  detailLine: {
    ...type.micro,
    color: color.textDim,
    marginTop: space.xs,
  },
  detailProvenance: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.xs,
  },
});
