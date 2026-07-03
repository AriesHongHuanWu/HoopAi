/**
 * Trends — FG% across the last 30 sessions: hero sparkline, per-session bars
 * (Skia rects, latest highlighted in the hot accent), an averages row, the
 * entry-angle histogram of the last session and a lifetime strip.
 * Empty state until at least two sessions exist.
 */
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BackPill } from '@/components/ShotList';
import {
  AngleHistogram,
  decidedEntryAngles,
} from '@/components/charts/AngleHistogram';
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
import { fgTrend, listSessions, sessionShots } from '@/data/db';

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

/** One bar per session, rounded caps; the latest session gets the full accent. */
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
  const capR = Math.min(4, barW / 2);
  return (
    <Canvas style={{ width, height }}>
      {/* 50% reference line, then the baseline. */}
      <Rect
        x={0}
        y={Math.round(height / 2)}
        width={width}
        height={1}
        color={color.border}
        opacity={0.55}
      />
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
            r={capR}
            color={i === n - 1 ? color.accent : color.accentTint}
          />
        );
      })}
    </Canvas>
  );
}

export default function TrendsScreen() {
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  /** Entry angles of the LAST session's decided shots (null = loading). */
  const [lastAngles, setLastAngles] = useState<number[] | null>(null);
  const [lifetime, setLifetime] = useState<{
    sessions: number;
    makes: number;
  } | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void fgTrend(30).then(async (t) => {
        if (!alive) return;
        setTrend(t);
        const last = t[t.length - 1];
        if (last == null) {
          setLastAngles([]);
          return;
        }
        const rows = await sessionShots(last.sessionId);
        if (alive) setLastAngles(decidedEntryAngles(rows));
      });
      void listSessions(1000).then((rows) => {
        if (!alive) return;
        const tracked = rows.filter((r) => r.attempts > 0);
        setLifetime({
          sessions: tracked.length,
          // SUM over a shot-less session can surface as null — guard it.
          makes: tracked.reduce((sum, r) => sum + (r.makes ?? 0), 0),
        });
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
        <Card>
          <Text style={styles.dim}>Loading trends…</Text>
        </Card>
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
                tone={deltaPct > 0 ? 'make' : deltaPct < 0 ? 'miss' : 'default'}
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
            <Row
              style={{ justifyContent: 'space-between', marginTop: space.xs }}
            >
              <Text style={styles.caption}>
                One bar per session — the latest is highlighted.
              </Text>
              <Text style={styles.micro}>50% LINE</Text>
            </Row>
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

          {lastAngles != null && (
            <Card>
              <Eyebrow>Entry angles — last session</Eyebrow>
              <AngleHistogram angles={lastAngles} />
            </Card>
          )}

          {lifetime != null && lifetime.sessions > 0 && (
            <Card>
              <Eyebrow>Lifetime</Eyebrow>
              <Row style={{ justifyContent: 'space-around' }}>
                <StatNumber
                  value={String(lifetime.sessions)}
                  size="medium"
                  label="sessions"
                />
                <StatNumber
                  value={String(lifetime.makes)}
                  size="medium"
                  label="total makes"
                />
              </Row>
            </Card>
          )}
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
    flexShrink: 1,
  },
  micro: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
});
