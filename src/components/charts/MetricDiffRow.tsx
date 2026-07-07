/**
 * MetricDiffRow — one make-vs-miss comparison row for a Shot Lab metric:
 * label + make/miss means up top, then a shared horizontal axis with the
 * ideal band shaded, every shot as a dot (makes lane above, misses lane
 * below) and each group's mean as a tick. A "key difference" chip appears
 * when the effect size clears the differentiator floor.
 *
 * Pure RN views (no canvas): the dots are few and the layout is 1-D.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Row } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import type { MetricSplit } from '@/core/shotLab';

/** Track height including both lanes, px. */
const TRACK_H = 34;
const DOT = 7;

export function MetricDiffRow({ split }: { split: MetricSplit }) {
  const { def, make, miss, points, effect } = split;
  const fmt = (v: number | null) =>
    v == null ? '—' : `${v.toFixed(def.digits)}${def.unit}`;

  // Axis domain: data ∪ ideal band, padded 8%.
  let lo = Infinity;
  let hi = -Infinity;
  for (const [v] of points) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (def.ideal) {
    lo = Math.min(lo, def.ideal[0]);
    // Open-ended bands (hi = 10000ms) shouldn't stretch the axis.
    if (def.ideal[1] < 9999) hi = Math.max(hi, def.ideal[1]);
  }
  const usable = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
  const pad = usable ? (hi - lo) * 0.08 : 0;
  const min = lo - pad;
  const span = usable ? hi - lo + pad * 2 : 1;
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / span) * 100))}%` as const;

  const isKey = effect != null && Math.abs(effect) >= 0.35;

  return (
    <View style={styles.wrap}>
      <Row style={styles.header} gap={space.sm}>
        <Text style={styles.label} numberOfLines={1}>
          {def.label}
        </Text>
        {isKey && (
          <View style={styles.keyChip}>
            <Text style={styles.keyChipText}>key difference</Text>
          </View>
        )}
        <View style={styles.values}>
          <Text style={[styles.value, { color: color.make }]}>{fmt(make.mean)}</Text>
          <Text style={styles.vs}> vs </Text>
          <Text style={[styles.value, { color: color.miss }]}>{fmt(miss.mean)}</Text>
        </View>
      </Row>
      {usable && points.length > 0 ? (
        <View
          style={styles.track}
          accessible
          accessibilityLabel={`${def.label}: makes average ${fmt(make.mean)}, misses average ${fmt(miss.mean)}`}
        >
          {def.ideal && (
            <View
              style={[
                styles.band,
                {
                  left: pct(Math.max(def.ideal[0], min)),
                  width: `${Math.max(
                    2,
                    ((Math.min(def.ideal[1], min + span) - Math.max(def.ideal[0], min)) / span) * 100,
                  )}%`,
                },
              ]}
            />
          )}
          {points.map(([v, isMake], i) => (
            <View
              key={i}
              style={[
                styles.dot,
                {
                  left: pct(v),
                  top: isMake ? 5 : TRACK_H - 5 - DOT,
                  backgroundColor: isMake ? color.make : color.miss,
                },
              ]}
            />
          ))}
          {make.mean != null && (
            <View style={[styles.meanTick, { left: pct(make.mean), backgroundColor: color.make, top: 2 }]} />
          )}
          {miss.mean != null && (
            <View
              style={[styles.meanTick, { left: pct(miss.mean), backgroundColor: color.miss, top: TRACK_H / 2 }]}
            />
          )}
        </View>
      ) : (
        <Text style={styles.noData}>
          {def.needsPose ? 'Needs form analysis on (Settings › Coaching).' : 'Not enough data yet.'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.xs,
    paddingVertical: space.sm,
  },
  header: {
    alignItems: 'center',
  },
  label: {
    ...type.bodyMedium,
    color: color.text,
    flexShrink: 1,
  },
  keyChip: {
    backgroundColor: color.accentTint,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  keyChipText: {
    ...type.micro,
    color: color.accent,
  },
  values: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginLeft: 'auto',
  },
  value: {
    ...type.bodyMedium,
    fontVariant: ['tabular-nums'],
  },
  vs: {
    ...type.caption,
    color: color.textFaint,
  },
  track: {
    height: TRACK_H,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: color.accentTint,
    opacity: 0.55,
  },
  dot: {
    position: 'absolute',
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    marginLeft: -DOT / 2,
    opacity: 0.85,
  },
  meanTick: {
    position: 'absolute',
    width: 2.5,
    height: TRACK_H / 2 - 2,
    marginLeft: -1.25,
    borderRadius: 1,
  },
  noData: {
    ...type.caption,
    color: color.textFaint,
  },
});
