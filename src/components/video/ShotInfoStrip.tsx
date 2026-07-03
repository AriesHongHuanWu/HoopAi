/**
 * ShotInfoStrip — compact "now playing" strip for the replay screen.
 *
 * Shows the shot the playhead is at (or nearest to): shot number, outcome
 * (color + shape via MakeMissDot), the estimated 2/3 value badge and the
 * entry-angle chip. The parent recomputes the nearest shot as playback
 * crosses markers, so this stays a pure presentational row.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Chip, MakeMissDot } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import type { ResolvedShot, ShotOutcome } from '@/core/types';

const OUTCOME_LABEL: Record<ShotOutcome, string> = {
  make: 'Make',
  miss: 'Miss',
  unsure: 'Unsure',
};

const OUTCOME_TINT: Record<ShotOutcome, string> = {
  make: color.make,
  miss: color.miss,
  unsure: color.unsure,
};

export function ShotInfoStrip({ shot }: { shot: ResolvedShot | null }) {
  if (shot == null) return null;
  const is3 = shot.shotValue === 3;
  const entry = shot.entryAngleDeg;
  const a11y =
    `Shot ${shot.id}: ${OUTCOME_LABEL[shot.outcome]}, ` +
    `${is3 ? 'three' : 'two'} pointer` +
    (entry != null ? `, ${Math.round(entry)} degree entry` : '');

  return (
    <View accessible accessibilityLabel={a11y} style={styles.strip}>
      <MakeMissDot outcome={shot.outcome} />
      <Text style={styles.shotNum}>Shot {shot.id}</Text>
      <Text style={[styles.outcome, { color: OUTCOME_TINT[shot.outcome] }]}>
        {OUTCOME_LABEL[shot.outcome]}
      </Text>
      <View style={[styles.valueBadge, is3 && styles.valueBadge3]}>
        <Text style={[styles.valueBadgeText, is3 && styles.valueBadgeText3]}>
          {is3 ? '3PT' : '2PT'}
        </Text>
      </View>
      {entry != null && <Chip label={`${Math.round(entry)}° entry`} />}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touch.minTarget,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  shotNum: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  outcome: {
    ...type.caption,
  },
  valueBadge: {
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  valueBadge3: {
    borderColor: color.threePt,
    backgroundColor: color.threePtTint,
  },
  valueBadgeText: {
    ...type.micro,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  valueBadgeText3: {
    color: color.threePt,
  },
});
