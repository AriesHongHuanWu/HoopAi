/**
 * SessionStory — the recap's narrative section: a story headline with the
 * best make run, an honest per-zone breakdown and a horizontal gallery of
 * make trajectories.
 *
 * Purely presentational: every number comes from the pure engine in
 * src/core/sessionStory.ts over the shots/stats the recap already has — no
 * queries, no store writes, nothing that could arm or judge a shot. Mounted
 * once inside SessionRecap so the summary and history screens share it. No
 * entering animations of its own — the parent recap section already animates;
 * any future motion added here must be reduced-motion-guarded.
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';

import { color, radius, space, type } from '../constants/tokens';
import { bestRun, makeArcs, storyHeadline, zoneBreakdown } from '../core/sessionStory';
import type { ZoneLine } from '../core/sessionStory';
import type { ResolvedShot, SessionStats } from '../core/types';
import { buildSparklinePoints, SPARK_HEIGHT, SPARK_WIDTH } from './hud/shotSparkline';
import { Card, Chip, Eyebrow, Row } from './ui';

/** Screen-reader line for one zone row ('—' has no spoken equivalent). */
function zoneA11yLabel(line: ZoneLine): string {
  if (line.fgPct == null) return `${line.label} zone: no decided shots`;
  return (
    `${line.label} zone: ${line.makes} of ${line.decided} decided shots made, ` +
    `${Math.round(line.fgPct * 100)} percent`
  );
}

export function SessionStory({
  shots,
  stats,
}: {
  shots: readonly ResolvedShot[];
  stats: SessionStats;
}): React.JSX.Element | null {
  const run = useMemo(() => bestRun(shots), [shots]);
  const zones = useMemo(() => zoneBreakdown(shots), [shots]);
  const arcs = useMemo(() => makeArcs(shots), [shots]);
  // Skia paths are built once per arc set, not per render.
  const arcPaths = useMemo(
    () =>
      arcs.map((arc) => {
        const points = buildSparklinePoints(arc.trajectory);
        const p = Skia.Path.Make();
        if (points.length >= 2) {
          p.moveTo(points[0]!.x, points[0]!.y);
          for (let i = 1; i < points.length; i++) p.lineTo(points[i]!.x, points[i]!.y);
        }
        return p;
      }),
    [arcs],
  );

  // Too little story below 4 shots — the box-score cards already cover it.
  // (After the hooks so the hook order never changes as shots load in.)
  if (shots.length < 4) return null;

  const hasZoneData = zones.some((line) => line.decided > 0);

  return (
    <View style={{ gap: space.lg }}>
      <Card>
        <Eyebrow>Story of the session</Eyebrow>
        <Text style={styles.headline}>{storyHeadline(stats, run)}</Text>
        {run != null && (
          <Row gap={space.sm} style={{ marginTop: space.sm, alignItems: 'center' }}>
            <Chip label={`🔥 ${run.makes} straight`} tone="accent" />
            <Text style={styles.caption}>
              {`shots ${run.startIndex + 1}–${run.endIndex + 1}`}
            </Text>
          </Row>
        )}
      </Card>

      {hasZoneData && (
        <Card>
          <Eyebrow>Zone breakdown</Eyebrow>
          <View style={{ gap: space.sm }}>
            {zones.map((line) => (
              <View
                key={line.zone}
                accessible
                accessibilityLabel={zoneA11yLabel(line)}
                style={styles.zoneRow}
              >
                <Text style={styles.zoneLabel}>{line.label}</Text>
                <View style={styles.zoneTrack}>
                  <View
                    style={[
                      styles.zoneFill,
                      { width: `${Math.round((line.fgPct ?? 0) * 100)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.zoneValue}>
                  {line.fgPct == null
                    ? '—'
                    : `${line.makes}/${line.decided} · ${Math.round(line.fgPct * 100)}%`}
                </Text>
              </View>
            ))}
          </View>
          <Text style={styles.footnote}>
            Zones are thirds of the camera frame · % excludes unsure shots.
          </Text>
        </Card>
      )}

      {arcs.length >= 2 && (
        <Card>
          {/* Skia canvases can't carry a11y — one label covers the gallery. */}
          <View accessible accessibilityLabel={`Gallery of ${arcs.length} made-shot arcs`}>
            <Eyebrow>Make gallery</Eyebrow>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.galleryRow}
            >
              {arcs.map((arc, i) => (
                <View key={arc.id} style={styles.arcCell}>
                  <Canvas style={styles.arcCanvas} pointerEvents="none">
                    <Path
                      path={arcPaths[i]!}
                      style="stroke"
                      strokeWidth={2}
                      strokeCap="round"
                      strokeJoin="round"
                      color={color.make}
                    />
                  </Canvas>
                  <Text style={styles.arcCaption}>
                    {arc.entryAngleDeg != null ? `${Math.round(arc.entryAngleDeg)}°` : '—'}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headline: {
    ...type.bodyMedium,
    color: color.text,
  },
  caption: {
    ...type.caption,
    color: color.textDim,
  },
  zoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  zoneLabel: {
    ...type.caption,
    color: color.textDim,
    width: 56,
  },
  zoneTrack: {
    flex: 1,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.border,
    overflow: 'hidden',
  },
  zoneFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.make,
  },
  zoneValue: {
    ...type.caption,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
    minWidth: 72,
    textAlign: 'right',
  },
  footnote: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  galleryRow: {
    gap: space.md,
  },
  arcCell: {
    alignItems: 'center',
    gap: space.xs,
  },
  arcCanvas: {
    width: SPARK_WIDTH,
    height: SPARK_HEIGHT,
  },
  arcCaption: {
    ...type.micro,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
});
