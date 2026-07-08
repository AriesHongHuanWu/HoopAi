/**
 * CourtPlacementMap — plots each shot at its REAL, homography-mapped court
 * position on a to-scale 3-point line (arc + flattened corners from the court
 * model). This is the visual proof of court registration: unlike the camera-
 * space ShotChart, these are true metres on a real court, so corner 3s sit
 * exactly where they were taken. Renders only shots that carry courtPos (i.e.
 * a calibration ran) — honest by construction.
 *
 * Pure Skia over the court geometry; no device data beyond each shot's courtPos.
 */
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MakeMissDot, Row } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import { cornerJunctionY, type CourtSpec } from '@/core/courtModel';
import type { ResolvedShot } from '@/core/types';

/** Lateral half-width shown, metres (corner distance + a margin). */
const MAX_LATERAL_M = 7.8;
const PAD = 16;
const MARK_R = 5;
const X_ARM = 4.5;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function CourtPlacementMap({
  shots,
  spec,
}: {
  shots: readonly ResolvedShot[];
  spec: CourtSpec;
}) {
  const [width, setWidth] = useState(0);

  const placed = useMemo(
    () => shots.filter((s) => s.courtPos != null),
    [shots],
  );

  const geom = useMemo(() => {
    if (width <= 0) return null;
    const scale = (width - 2 * PAD) / (2 * MAX_LATERAL_M);
    const hoopX = width / 2;
    // Baseline sits at the top; the hoop is basketFromBaseline metres into court.
    const topPad = 18;
    const hoopY = topPad + spec.basketFromBaselineM * scale;
    const toCanvas = (mx: number, my: number) => ({
      x: hoopX + mx * scale,
      y: hoopY + my * scale,
    });
    const maxShotY = placed.reduce((m, s) => Math.max(m, s.courtPos!.y), 0);
    const depthMax = clamp(maxShotY + 0.6, 6, 10);
    const height = hoopY + depthMax * scale + PAD;
    return { scale, hoopX, hoopY, toCanvas, height };
  }, [width, placed, spec]);

  // The real 3-point line: two vertical corner segments + the arc between them.
  const linePath = useMemo(() => {
    if (!geom) return null;
    const p = Skia.Path.Make();
    const cornerX = spec.cornerDistanceM;
    const junctionY = cornerJunctionY(spec);
    const baselineY = -spec.basketFromBaselineM;
    const thetaMax = Math.asin(Math.min(1, cornerX / spec.arcRadiusM));
    const left = geom.toCanvas(-cornerX, baselineY);
    p.moveTo(left.x, left.y);
    const lj = geom.toCanvas(-cornerX, junctionY);
    p.lineTo(lj.x, lj.y);
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const theta = -thetaMax + (2 * thetaMax * i) / N;
      const pt = geom.toCanvas(spec.arcRadiusM * Math.sin(theta), spec.arcRadiusM * Math.cos(theta));
      p.lineTo(pt.x, pt.y);
    }
    const rc = geom.toCanvas(cornerX, baselineY);
    p.lineTo(rc.x, rc.y);
    return p;
  }, [geom, spec]);

  // Baseline across the top.
  const baselinePath = useMemo(() => {
    if (!geom) return null;
    const p = Skia.Path.Make();
    const y = geom.toCanvas(0, -spec.basketFromBaselineM).y;
    p.moveTo(PAD, y);
    p.lineTo(width - PAD, y);
    return p;
  }, [geom, spec, width]);

  const makePath = useMemo(() => {
    const p = Skia.Path.Make();
    if (!geom) return p;
    for (const s of placed) {
      if (s.outcome !== 'make') continue;
      const c = geom.toCanvas(s.courtPos!.x, s.courtPos!.y);
      p.addCircle(c.x, c.y, MARK_R);
    }
    return p;
  }, [placed, geom]);

  const missPath = useMemo(() => {
    const p = Skia.Path.Make();
    if (!geom) return p;
    for (const s of placed) {
      if (s.outcome !== 'miss') continue;
      const c = geom.toCanvas(s.courtPos!.x, s.courtPos!.y);
      p.moveTo(c.x - X_ARM, c.y - X_ARM);
      p.lineTo(c.x + X_ARM, c.y + X_ARM);
      p.moveTo(c.x + X_ARM, c.y - X_ARM);
      p.lineTo(c.x - X_ARM, c.y + X_ARM);
    }
    return p;
  }, [placed, geom]);

  // Downtown ring around decided 3s so threes read at a glance.
  const threeRingPath = useMemo(() => {
    const p = Skia.Path.Make();
    if (!geom) return p;
    for (const s of placed) {
      if (s.shotValue === 3 && s.outcome !== 'unsure') {
        const c = geom.toCanvas(s.courtPos!.x, s.courtPos!.y);
        p.addCircle(c.x, c.y, MARK_R + 3.5);
      }
    }
    return p;
  }, [placed, geom]);

  const makes = placed.filter((s) => s.outcome === 'make').length;
  const threes = placed.filter((s) => s.shotValue === 3 && s.outcome !== 'unsure').length;
  const a11y = `Court placement map: ${placed.length} shots mapped to real court positions, ${makes} makes, ${threes} threes.`;

  return (
    <View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height: geom?.height ?? 220 }}
        accessible
        accessibilityLabel={a11y}
      >
        {geom != null && (
          <Canvas style={{ width, height: geom.height }}>
            {baselinePath != null && (
              <Path path={baselinePath} style="stroke" strokeWidth={1.5} color={color.border} />
            )}
            {linePath != null && (
              <Path path={linePath} style="stroke" strokeWidth={1.5} strokeCap="round" color={color.threePt} opacity={0.6} />
            )}
            <Circle cx={geom.hoopX} cy={geom.hoopY} r={4} color={color.accent} />
            <Path path={threeRingPath} style="stroke" strokeWidth={1.5} color={color.threePt} opacity={0.9} />
            <Path path={makePath} color={color.make} />
            <Path path={missPath} style="stroke" strokeWidth={2} strokeCap="round" color={color.miss} />
          </Canvas>
        )}
      </View>

      <Row gap={space.lg} style={{ marginTop: space.sm }}>
        <Row gap={space.xs}>
          <MakeMissDot outcome="make" size={10} />
          <Text style={styles.legend}>Make</Text>
        </Row>
        <Row gap={space.xs}>
          <MakeMissDot outcome="miss" size={10} />
          <Text style={styles.legend}>Miss</Text>
        </Row>
        {threes > 0 && (
          <Row gap={space.xs}>
            <View style={styles.threeSwatch} />
            <Text style={styles.legend}>3PT</Text>
          </Row>
        )}
      </Row>
      <Text style={styles.legend}>Mapped from your court calibration — real positions, corner-accurate.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.xs,
  },
  threeSwatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: color.threePt,
  },
});
