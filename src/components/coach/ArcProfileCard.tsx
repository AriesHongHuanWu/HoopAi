/**
 * ArcProfileCard — the average DETECTED entry angle across the coach window,
 * drawn as the actual arc: a quadratic flight descending into a rim tick at
 * the user's average entry angle, with the 43–52° ideal band shaded as a
 * wedge at the rim (ArcCompare's dashed-reference + rim-tick idiom). Below
 * it, the flat / ideal / steep split bar stays as the legend, plus a one-line
 * coach read.
 *
 * Presentational only: numbers come from arcProfile()
 * (src/core/coachInsights.ts), which grades against the SAME band as the live
 * HUD (ARC_ENTRY_IDEAL_MIN–MAX in src/components/hud/arcHudGeometry.ts), so
 * this card can never disagree with the on-court readout. Copy stays inside
 * the honesty line: these are entry angles the camera DETECTED — never a
 * claim about shots the tracker missed, and never a judgment input. The
 * drawn arc encodes exactly one measured number (the entry tangent at the
 * rim); everything else about the curve is presentation.
 *
 * The split bar is color + text (legend carries the percentages), never color
 * alone (colorblind rule). Below MIN_ARCS detected arcs the card renders a
 * compact charging state — now with a real progress bar, so "charges up" is
 * visibly a charge — instead of an average that would just be noise.
 *
 * Skia here is STATIC: every path is built on the JS thread in useMemo
 * (MiniArcReplay's animate={false} render pattern). No worklets — the
 * fx/particles crash precedent.
 */
import {
  BlurMask,
  Canvas,
  Circle,
  DashPathEffect,
  Line,
  Path,
  vec,
} from '@shopify/react-native-skia';
import { useMemo, useState, type ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  ARC_ENTRY_IDEAL_MAX,
  ARC_ENTRY_IDEAL_MIN,
} from '@/components/hud/arcHudGeometry';
import { AnimatedProgressBar } from '@/components/motion';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Row, StatNumber } from '@/components/ui';
import { color, glow, radius, space, type } from '@/constants/tokens';
import type { ArcProfile } from '@/core/coachInsights';

/** Minimum detected arcs before the average is worth showing. */
const MIN_ARCS = 5;

/** Canvas height for the arc drawing. */
const ARC_H = 116;
/** Headroom above the drawn peak so the stroke never clips. */
const TOP_PAD = 10;
/** Rim tick inset from the right edge (room for the halo). */
const RIM_INSET = 28;
/** Ideal-band wedge ray length cap. */
const WEDGE_MAX = 96;
/**
 * Drawing clamp for the entry angle. The NUMBER shown is always the true
 * average; only the geometry clamps, so a pathological outlier average can't
 * degenerate the curve into a line that leaves the canvas.
 */
const DRAW_DEG_MIN = 20;
const DRAW_DEG_MAX = 70;

interface ArcGeometry {
  /** The flight: quadratic Bézier whose tangent at the rim IS the avg angle. */
  arcPath: string;
  /** Shaded ideal-band wedge anchored at the rim. */
  wedgePath: string;
  /** Dashed wedge boundary rays (min°, max°). */
  edgeMin: { a: { x: number; y: number }; b: { x: number; y: number } };
  edgeMax: { a: { x: number; y: number }; b: { x: number; y: number } };
  rim: { x: number; y: number };
}

/**
 * Static arc geometry, pure JS. The one measured fact on the canvas is the
 * tangent direction at the rim (= avg entry angle): the Bézier control point
 * sits on that tangent line, so the descent into the tick is exact. The
 * launch point and peak are presentation, clamped to keep the curve inside
 * the canvas.
 */
function buildArcGeometry(width: number, avgDeg: number): ArcGeometry {
  const theta =
    (Math.min(DRAW_DEG_MAX, Math.max(DRAW_DEG_MIN, avgDeg)) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const p0 = { x: 8, y: ARC_H - 12 };
  const rim = { x: width - RIM_INSET, y: ARC_H * 0.52 };

  // Control point up-left of the rim ON the entry tangent. Start from the
  // height that puts the drawn peak at TOP_PAD, then clamp so the control
  // never crosses the launch point on very flat angles (the tangent
  // direction — the measurement — is preserved by both clamps).
  let p1y = 2 * (TOP_PAD - 0.25 * (p0.y + rim.y));
  let len = (rim.y - p1y) / sin;
  let p1x = rim.x - len * cos;
  if (p1x < p0.x + 24) {
    len = (rim.x - (p0.x + 24)) / cos;
    p1x = rim.x - len * cos;
    p1y = rim.y - len * sin;
  }

  const arcPath = `M ${p0.x} ${p0.y} Q ${p1x} ${p1y} ${rim.x} ${rim.y}`;

  // Ideal band: a wedge of the two band-edge rays leaving the rim up-left —
  // the protractor the arc is graded against, drawn where the grading happens.
  const wedgeR = Math.min(WEDGE_MAX, (rim.x - p0.x) * 0.45);
  const ray = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return { x: rim.x - wedgeR * Math.cos(r), y: rim.y - wedgeR * Math.sin(r) };
  };
  const lo = ray(ARC_ENTRY_IDEAL_MIN);
  const hi = ray(ARC_ENTRY_IDEAL_MAX);
  const wedgePath = `M ${rim.x} ${rim.y} L ${lo.x} ${lo.y} L ${hi.x} ${hi.y} Z`;

  return {
    arcPath,
    wedgePath,
    edgeMin: { a: rim, b: lo },
    edgeMax: { a: rim, b: hi },
    rim,
  };
}

/** One-line coach read off the dominant band; ties lean ideal — keep it kind. */
function coachRead(flatPct: number, idealPct: number, steepPct: number): string {
  if (idealPct >= flatPct && idealPct >= steepPct) {
    return (
      `Most of your detected arcs drop in at ${ARC_ENTRY_IDEAL_MIN}–` +
      `${ARC_ENTRY_IDEAL_MAX}° — keep grooving that stroke.`
    );
  }
  if (flatPct >= steepPct) {
    return 'Your arc runs flat — add legs, aim just over the back rim.';
  }
  return 'Your arc runs steep — soften the rainbow and drive the ball forward, not just up.';
}

export function ArcProfileCard({
  profile,
  entering,
}: {
  profile: ArcProfile;
  entering?: ComponentProps<typeof Card>['entering'];
}) {
  // Skia needs real pixel widths; the height is reserved from the first
  // frame so the card never reflows when the canvas lands.
  const [canvasW, setCanvasW] = useState(0);
  const geom = useMemo(
    () =>
      profile.n >= MIN_ARCS && canvasW > 0 && profile.avgEntryDeg != null
        ? buildArcGeometry(canvasW, profile.avgEntryDeg)
        : null,
    [canvasW, profile.n, profile.avgEntryDeg],
  );

  if (profile.n < MIN_ARCS) {
    const body =
      profile.n === 0
        ? 'No detected arcs yet. This card charges up as the camera reads entry angles off your tracked shots.'
        : `${profile.n} of ${MIN_ARCS} detected arcs so far — this card charges up as tracked shots accrue.`;
    return (
      <Card entering={entering}>
        <SectionEyebrow icon="analytics-outline" style={styles.eyebrow}>
          Arc profile
        </SectionEyebrow>
        <Text style={styles.emptyBody} accessibilityLabel={`Arc profile: ${body}`}>
          {body}
        </Text>
        <AnimatedProgressBar
          progress={profile.n / MIN_ARCS}
          height={6}
          accessibilityLabel={`${profile.n} of ${MIN_ARCS} detected arcs`}
          style={styles.chargeBar}
        />
      </Card>
    );
  }

  // n >= MIN_ARCS guarantees every aggregate is non-null.
  const avg = Math.round(profile.avgEntryDeg!);
  const flatPct = profile.flatPct!;
  const idealPct = profile.idealPct!;
  const steepPct = profile.steepPct!;
  const read = coachRead(flatPct, idealPct, steepPct);

  // Low angle → high angle, left to right. flat = miss-warm, ideal =
  // make-teal, steep = unsure-chalk (all from tokens).
  const segments = [
    { key: 'flat', label: 'Flat', pct: flatPct, fill: color.miss },
    { key: 'ideal', label: 'Ideal', pct: idealPct, fill: color.make },
    { key: 'steep', label: 'Steep', pct: steepPct, fill: color.unsure },
  ];

  const a11y =
    `Arc profile from ${profile.n} detected shots: average entry angle ${avg} degrees. ` +
    segments
      .map((s) => `${Math.round(s.pct * 100)} percent ${s.label.toLowerCase()}`)
      .join(', ') +
    `. ${read}`;

  return (
    <Card entering={entering}>
      <SectionEyebrow icon="analytics-outline" style={styles.eyebrow}>
        Arc profile
      </SectionEyebrow>

      <View accessible accessibilityLabel={a11y}>
        <StatNumber value={`${avg}°`} label="avg entry (detected)" size="large" />
        <Text style={styles.sub}>
          {profile.n} detected arcs · ideal entry {ARC_ENTRY_IDEAL_MIN}–
          {ARC_ENTRY_IDEAL_MAX}°
        </Text>

        {/* The arc itself — decorative to the screen reader (the accessible
            wrapper above already speaks the same numbers). */}
        <View
          style={styles.arcBox}
          onLayout={(e) => setCanvasW(Math.round(e.nativeEvent.layout.width))}
        >
          {geom != null && (
            <Canvas style={{ width: canvasW, height: ARC_H }}>
              {/* Ideal band wedge + dashed boundary rays (chalk reference). */}
              <Path path={geom.wedgePath} color={color.make} opacity={0.12} />
              <Line
                p1={vec(geom.edgeMin.a.x, geom.edgeMin.a.y)}
                p2={vec(geom.edgeMin.b.x, geom.edgeMin.b.y)}
                strokeWidth={1.5}
                color={color.textDim}
                opacity={0.5}
              >
                <DashPathEffect intervals={[5, 5]} />
              </Line>
              <Line
                p1={vec(geom.edgeMax.a.x, geom.edgeMax.a.y)}
                p2={vec(geom.edgeMax.b.x, geom.edgeMax.b.y)}
                strokeWidth={1.5}
                color={color.textDim}
                opacity={0.5}
              >
                <DashPathEffect intervals={[5, 5]} />
              </Line>
              {/* The user's average flight: soft glow underlay + crisp stroke. */}
              <Path
                path={geom.arcPath}
                style="stroke"
                strokeWidth={7}
                strokeCap="round"
                color={glow.trailBloom}
              >
                <BlurMask blur={6} style="normal" />
              </Path>
              <Path
                path={geom.arcPath}
                style="stroke"
                strokeWidth={3}
                strokeCap="round"
                color={color.accent}
              />
              {/* Rim tick with a warm halo (ArcCompare's arrival idiom). */}
              <Circle cx={geom.rim.x} cy={geom.rim.y} r={8} color={glow.trailBloom}>
                <BlurMask blur={6} style="normal" />
              </Circle>
              <Circle
                cx={geom.rim.x}
                cy={geom.rim.y}
                r={5}
                style="stroke"
                strokeWidth={2}
                color={color.accent}
              />
            </Canvas>
          )}
        </View>

        <View style={styles.bar}>
          {segments.map(
            (s) =>
              s.pct > 0 && (
                <View key={s.key} style={{ flex: s.pct, backgroundColor: s.fill }} />
              ),
          )}
        </View>

        <View style={styles.legend}>
          {segments.map((s) => (
            <Row key={s.key} gap={4}>
              <View style={[styles.swatch, { backgroundColor: s.fill }]} />
              <Text style={styles.legendText}>
                {s.label} {Math.round(s.pct * 100)}%
              </Text>
            </Row>
          ))}
        </View>

        <Text style={styles.read}>{read}</Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Shared SectionEyebrow leaves margins to the call site (screens own rhythm).
  eyebrow: {
    marginBottom: space.sm,
  },
  emptyBody: {
    ...type.body,
    color: color.textDim,
  },
  chargeBar: {
    marginTop: space.md,
  },
  sub: {
    ...type.caption,
    color: color.textFaint,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    marginTop: space.xs,
  },
  arcBox: {
    height: ARC_H,
    marginTop: space.md,
  },
  bar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
    marginTop: space.md,
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  swatch: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  legendText: {
    ...type.micro,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  read: {
    ...type.body,
    color: color.textDim,
    marginTop: space.md,
  },
});
