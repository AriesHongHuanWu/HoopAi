/**
 * CompareBars — side-by-side comparison of two sessions (this vs previous).
 * One row per metric (FG%, points, attempts, 3PT%, avg entry angle): a label,
 * then two horizontal bars — current in leather, previous in chalk-faint —
 * scaled against the row's larger value. The better value gets a small ▲ in
 * make-green; for entry angle "better" means closer to the optimal-band
 * center (FORM.entryAngle). Null-safe: a metric without data shows an em dash
 * and an empty track, and never earns a marker.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Row } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import { FORM } from '@/core/config';
import type { SessionStats } from '@/core/types';

/** Bar track height, px. */
const BAR_H = 10;
/** Fixed value column so numbers right-align across rows, px. */
const VALUE_W = 68;

const OPTIMAL_ENTRY_MID = (FORM.entryAngle.min + FORM.entryAngle.max) / 2;

interface Metric {
  key: string;
  label: string;
  value: (s: SessionStats) => number | null;
  format: (v: number) => string;
  /** Positive when `a` beats `b`, negative when `b` wins, 0 for a tie. */
  compare: (a: number, b: number) => number;
}

const higherIsBetter = (a: number, b: number) => a - b;

const METRICS: readonly Metric[] = [
  {
    key: 'fg',
    label: 'FG%',
    value: (s) => (s.makes + s.misses > 0 ? s.fgPct : null),
    format: (v) => `${Math.round(v * 100)}%`,
    compare: higherIsBetter,
  },
  {
    key: 'points',
    label: 'Points',
    value: (s) => s.points,
    format: (v) => String(Math.round(v)),
    compare: higherIsBetter,
  },
  {
    key: 'attempts',
    label: 'Attempts',
    value: (s) => s.attempts,
    format: (v) => String(Math.round(v)),
    compare: higherIsBetter,
  },
  {
    key: 'three',
    label: '3PT%',
    value: (s) => (s.threePtAttempts > 0 ? s.threePtPct : null),
    format: (v) => `${Math.round(v * 100)}%`,
    compare: higherIsBetter,
  },
  {
    key: 'entry',
    label: 'Avg entry angle',
    // Closer to the 45° optimal-band center wins.
    value: (s) => s.avgEntryAngleDeg,
    format: (v) => `${Math.round(v)}°`,
    compare: (a, b) =>
      Math.abs(b - OPTIMAL_ENTRY_MID) - Math.abs(a - OPTIMAL_ENTRY_MID),
  },
];

function BarLine({
  value,
  frac,
  fill,
  win,
  format,
  dim = false,
}: {
  value: number | null;
  /** 0..1 share of the row max; null when the metric has no data. */
  frac: number | null;
  fill: string;
  win: boolean;
  format: (v: number) => string;
  dim?: boolean;
}) {
  return (
    <Row gap={space.sm}>
      <View style={styles.track}>
        {frac != null && frac > 0 && (
          <View
            style={[
              styles.fill,
              { width: `${Math.min(100, frac * 100)}%`, backgroundColor: fill },
            ]}
          />
        )}
      </View>
      <Row gap={3} style={styles.valueCell}>
        {win && <Text style={styles.win}>▲</Text>}
        <Text style={[styles.value, dim && { color: color.textDim }]}>
          {value != null ? format(value) : '—'}
        </Text>
      </Row>
    </Row>
  );
}

export interface CompareBarsProps {
  /** Stats of the session being viewed. */
  current: SessionStats;
  /** Stats of the previous comparable session. */
  previous: SessionStats;
  currentLabel?: string;
  previousLabel?: string;
}

export function CompareBars({
  current,
  previous,
  currentLabel = 'This session',
  previousLabel = 'Previous',
}: CompareBarsProps) {
  return (
    <View style={{ gap: space.md }}>
      <Row gap={space.lg}>
        <Row gap={space.xs}>
          <View style={[styles.swatch, { backgroundColor: color.accent }]} />
          <Text style={styles.legend}>{currentLabel}</Text>
        </Row>
        <Row gap={space.xs}>
          <View style={[styles.swatch, { backgroundColor: color.textFaint }]} />
          <Text style={styles.legend}>{previousLabel}</Text>
        </Row>
      </Row>

      {METRICS.map((m) => {
        const cur = m.value(current);
        const prv = m.value(previous);
        const cmp = cur != null && prv != null ? m.compare(cur, prv) : 0;
        const rowMax = Math.max(cur ?? 0, prv ?? 0);
        const fracOf = (v: number | null) =>
          v == null ? null : rowMax > 0 ? v / rowMax : 0;
        const a11yLabel =
          `${m.label}. This session ${cur != null ? m.format(cur) : 'no data'}, ` +
          `previous ${prv != null ? m.format(prv) : 'no data'}` +
          (cmp > 0 ? '. Better this session.' : cmp < 0 ? '. Better previously.' : '.');
        return (
          <View key={m.key} accessible accessibilityLabel={a11yLabel} style={{ gap: space.xs }}>
            <Text style={styles.label}>{m.label}</Text>
            <BarLine
              value={cur}
              frac={fracOf(cur)}
              fill={color.accent}
              win={cmp > 0}
              format={m.format}
            />
            <BarLine
              value={prv}
              frac={fracOf(prv)}
              fill={color.textFaint}
              win={cmp < 0}
              format={m.format}
              dim
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legend: {
    ...type.caption,
    color: color.textFaint,
  },
  label: {
    ...type.caption,
    color: color.textDim,
  },
  track: {
    flex: 1,
    height: BAR_H,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
  },
  valueCell: {
    width: VALUE_W,
    justifyContent: 'flex-end',
  },
  value: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  win: {
    ...type.micro,
    color: color.make,
  },
});
