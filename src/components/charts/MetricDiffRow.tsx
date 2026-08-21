/**
 * MetricDiffRow — one make-vs-miss comparison row for a Shot Lab metric:
 * label up top with the two group means right-aligned in fixed tabular
 * columns (make = green dot marker, miss = red ✕ — color + shape, never
 * color alone), then a shared horizontal axis with the ideal band shaded
 * and edge-lined, every shot as a dot (makes lane above, misses lane below,
 * split by a hairline) and each group's mean as a tick. A footer line
 * carries the delta as a caret arrow in make-green ("what your makes do
 * differently") and, when the effect size clears the differentiator floor,
 * a "key difference" chip.
 *
 * Pure RN views (no canvas): the dots are few and the layout is 1-D.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Row } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import type { MetricSplit } from '@/core/shotLab';

/** Track height including both lanes, px. */
const TRACK_H = 40;
const DOT = 7;

export function MetricDiffRow({ split }: { split: MetricSplit }) {
  const { def, make, miss, points, delta, effect } = split;
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
  const pctNum = (v: number) => Math.max(0, Math.min(100, ((v - min) / span) * 100));
  const pct = (v: number) => `${pctNum(v)}%` as const;

  // Ideal band geometry (numeric, so the in-band label can gate on width).
  const bandLo = def.ideal ? Math.max(def.ideal[0], min) : 0;
  const bandHi = def.ideal ? Math.min(def.ideal[1], min + span) : 0;
  const bandLeftPct = def.ideal ? pctNum(bandLo) : 0;
  const bandWidthPct = def.ideal ? Math.max(2, ((bandHi - bandLo) / span) * 100) : 0;

  const isKey = effect != null && Math.abs(effect) >= 0.35;
  const deltaText =
    delta == null
      ? null
      : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(def.digits)}${def.unit}`;

  return (
    <View style={styles.wrap}>
      <Row style={styles.header} gap={space.sm}>
        <Text style={styles.label} numberOfLines={1}>
          {def.label}
        </Text>
        <View
          style={styles.valueGroup}
          accessible
          accessibilityLabel={`makes average ${fmt(make.mean)}`}
        >
          <View style={styles.makeMarker} />
          <Text style={[styles.value, { color: color.make }]}>{fmt(make.mean)}</Text>
        </View>
        <View
          style={styles.valueGroup}
          accessible
          accessibilityLabel={`misses average ${fmt(miss.mean)}`}
        >
          <Text style={styles.missMarker}>✕</Text>
          <Text style={[styles.value, { color: color.miss }]}>{fmt(miss.mean)}</Text>
        </View>
      </Row>
      {usable && points.length > 0 ? (
        <View
          style={styles.track}
          accessible
          accessibilityLabel={`${def.label}: makes average ${fmt(make.mean)}, misses average ${fmt(miss.mean)}${
            deltaText ? `, makes ${deltaText} versus misses` : ''
          }`}
        >
          {def.ideal && (
            <>
              <View
                style={[styles.band, { left: `${bandLeftPct}%`, width: `${bandWidthPct}%` }]}
              >
                {bandWidthPct >= 22 && <Text style={styles.bandLabel}>IDEAL</Text>}
              </View>
              <View style={[styles.bandEdge, { left: `${bandLeftPct}%` }]} />
              <View style={[styles.bandEdge, { left: `${bandLeftPct + bandWidthPct}%` }]} />
            </>
          )}
          {/* Lane divider: makes above, misses below. */}
          <View style={styles.laneDivider} />
          {points.map(([v, isMake], i) => (
            <View
              key={i}
              style={[
                styles.dot,
                {
                  left: pct(v),
                  top: isMake ? 6 : TRACK_H - 6 - DOT,
                  backgroundColor: isMake ? color.make : color.miss,
                },
              ]}
            />
          ))}
          {make.mean != null && (
            <View style={[styles.meanTick, { left: pct(make.mean), backgroundColor: color.make, top: 3 }]} />
          )}
          {miss.mean != null && (
            <View
              style={[
                styles.meanTick,
                { left: pct(miss.mean), backgroundColor: color.miss, top: TRACK_H / 2 + 2 },
              ]}
            />
          )}
        </View>
      ) : (
        <Text style={styles.noData}>
          {def.needsPose ? 'Needs form analysis on (Settings › Coaching).' : 'Not enough data yet.'}
        </Text>
      )}
      {(deltaText != null || isKey) && (
        <Row gap={space.xs} style={styles.footer}>
          {deltaText != null && (
            <>
              <Ionicons
                name={delta != null && delta >= 0 ? 'caret-up' : 'caret-down'}
                size={11}
                color={color.make}
              />
              <Text style={styles.deltaValue}>{deltaText}</Text>
              <Text style={styles.deltaText}>makes vs misses</Text>
            </>
          )}
          {isKey && (
            <View style={styles.keyChip}>
              <Text style={styles.keyChipText}>key difference</Text>
            </View>
          )}
        </Row>
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
    flex: 1,
  },
  valueGroup: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.xs,
  },
  value: {
    ...type.bodyMedium,
    fontVariant: ['tabular-nums'],
    minWidth: 56,
    textAlign: 'right',
  },
  makeMarker: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.make,
  },
  missMarker: {
    ...type.micro,
    color: color.miss,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  bandEdge: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    marginLeft: -0.5,
    backgroundColor: color.accentEdge,
  },
  bandLabel: {
    ...type.micro,
    letterSpacing: 1.2,
    color: color.accent,
    opacity: 0.9,
  },
  laneDivider: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: TRACK_H / 2,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
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
    width: 3,
    height: TRACK_H / 2 - 5,
    marginLeft: -1.5,
    borderRadius: 1.5,
  },
  footer: {
    alignItems: 'center',
  },
  deltaValue: {
    ...type.caption,
    color: color.make,
    fontVariant: ['tabular-nums'],
  },
  deltaText: {
    ...type.caption,
    color: color.textFaint,
  },
  keyChip: {
    backgroundColor: color.accentTint,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    marginLeft: 'auto',
  },
  keyChipText: {
    ...type.micro,
    color: color.accent,
  },
  noData: {
    ...type.caption,
    color: color.textFaint,
  },
});
