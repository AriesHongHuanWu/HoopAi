/**
 * Trends — FG% across the last 30 sessions: hero sparkline, per-session bars
 * (Skia rects, latest highlighted in the hot accent) and an averages row.
 * Empty state until at least two sessions exist.
 */
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BackPill } from '@/components/ShotList';
import { Sparkline } from '@/components/charts/Sparkline';
import {
  Card,
  Chip,
  Eyebrow,
  PillButton,
  Row,
  Screen,
  StatNumber,
} from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import { fgTrend } from '@/data/db';

type TrendPoint = Awaited<ReturnType<typeof fgTrend>>[number];

const SPARK_H = 120;
const BARS_H = 110;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Measures its own width and renders children once it is known. */
function MeasuredWidth({
  accessibilityLabel,
  children,
}: {
  accessibilityLabel?: string;
  children: (width: number) => React.ReactNode;
}) {
  const [width, setWidth] = useState(0);
  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 ? children(width) : null}
    </View>
  );
}

/** One bar per session; the latest session gets the full accent. */
function TrendBars({
  data,
  width,
  height,
}: {
  data: readonly number[];
  width: number;
  height: number;
}) {
  const n = data.length;
  const slot = width / n;
  const barW = Math.min(28, Math.max(4, slot * 0.55));
  return (
    <Canvas style={{ width, height }}>
      <Rect x={0} y={height - 1} width={width} height={1} color={color.border} />
      {data.map((v, i) => {
        const h = Math.max(3, clamp01(v) * (height - 4));
        const x = slot * i + (slot - barW) / 2;
        return (
          <RoundedRect
            key={i}
            x={x}
            y={height - h}
            width={barW}
            height={h}
            r={2}
            color={i === n - 1 ? color.accent : color.accentTint}
          />
        );
      })}
    </Canvas>
  );
}

export default function TrendsScreen() {
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void fgTrend(30).then((t) => {
        if (alive) setTrend(t);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  const points = trend?.map((p) => p.fgPct) ?? [];
  const enough = points.length >= 2;
  const latest = points[points.length - 1] ?? 0;
  const previous = points[points.length - 2] ?? 0;
  const deltaPct = Math.round((latest - previous) * 100);
  const avg =
    points.length > 0
      ? points.reduce((a, b) => a + b, 0) / points.length
      : 0;
  const best = points.length > 0 ? Math.max(...points) : 0;
  const attempts = trend?.reduce((a, p) => a + p.attempts, 0) ?? 0;

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Eyebrow>Trends</Eyebrow>
      <Text style={styles.title}>FG% over time</Text>

      {trend === null ? (
        <Text style={styles.dim}>Loading trends…</Text>
      ) : !enough ? (
        <Card>
          <Text style={styles.heading}>Not enough sessions yet</Text>
          <Text style={[styles.dim, { marginTop: space.xs }]}>
            Finish at least two tracked sessions and your FG% trend will draw
            itself here.
          </Text>
          <PillButton
            variant="ghost"
            label="View history"
            onPress={() => router.push('/history')}
            style={{ marginTop: space.lg, alignSelf: 'flex-start' }}
          />
        </Card>
      ) : (
        <View style={{ gap: space.lg }}>
          <Card>
            <Eyebrow>Field goal %</Eyebrow>
            <Row style={{ justifyContent: 'space-between' }}>
              <StatNumber
                value={`${Math.round(latest * 100)}%`}
                size="large"
                label="latest session"
                style={{ alignItems: 'flex-start' }}
              />
              <Chip
                label={`${deltaPct >= 0 ? '+' : ''}${deltaPct}% vs last`}
                tone={deltaPct > 0 ? 'make' : 'default'}
              />
            </Row>
            <View style={{ marginTop: space.lg }}>
              <MeasuredWidth
                accessibilityLabel={`FG% trend across ${points.length} sessions, latest ${Math.round(latest * 100)} percent`}
              >
                {(w) => <Sparkline data={points} width={w} height={SPARK_H} />}
              </MeasuredWidth>
            </View>
            <Row
              style={{ justifyContent: 'space-between', marginTop: space.xs }}
            >
              <Text style={styles.micro}>OLDEST</Text>
              <Text style={styles.micro}>LATEST</Text>
            </Row>
          </Card>

          <Card>
            <Eyebrow>By session</Eyebrow>
            <MeasuredWidth
              accessibilityLabel={`Bar chart of FG% for the last ${points.length} sessions`}
            >
              {(w) => <TrendBars data={points} width={w} height={BARS_H} />}
            </MeasuredWidth>
            <Text style={styles.caption}>
              Each bar is one session&apos;s FG%. The latest is highlighted.
            </Text>
          </Card>

          <Card>
            <Eyebrow>{`Across ${points.length} sessions`}</Eyebrow>
            <Row style={{ justifyContent: 'space-around' }}>
              <StatNumber
                value={`${Math.round(avg * 100)}%`}
                size="medium"
                label="avg FG"
              />
              <StatNumber
                value={`${Math.round(best * 100)}%`}
                size="medium"
                label="best"
              />
              <StatNumber
                value={String(attempts)}
                size="medium"
                label="attempts"
              />
            </Row>
          </Card>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  heading: {
    ...type.heading,
    color: color.text,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  caption: {
    ...type.caption,
    color: color.textDim,
    marginTop: space.sm,
  },
  micro: {
    ...type.micro,
    color: color.textFaint,
  },
});
