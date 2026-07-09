/**
 * SeasonStrip — last 4 weeks vs the 4 before, as a broadcast box-score strip
 * of paired value + delta cells (FG% / shots / sessions).
 *
 * Presentational only: the comparison comes from seasonComparison()
 * (src/core/coachInsights.ts). Deltas always carry a glyph (▲/▼/'level')
 * alongside color — never color alone (colorblind rule).
 *
 * The caller guarantees comparison.prior.attempts > 0 (coach.tsx only renders
 * this strip when there is a prior block to compare against), so there is no
 * empty-state branch here.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Row, StatNumber } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { SeasonComparison } from '@/core/coachInsights';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Local replica of coach.tsx's SectionEyebrow (the screen doesn't export it). */
function SectionEyebrow({ icon, children }: { icon: IconName; children: string }) {
  return (
    <Row gap={6} style={styles.eyebrowRow}>
      <Ionicons name={icon} size={12} color={color.accent} />
      <Text style={styles.eyebrowText}>{children.toUpperCase()}</Text>
    </Row>
  );
}

type DeltaVisual = { text: string; fg: string; spoken: string };

/** FG% delta in points; ±0.5 pt deadband reads as 'level' (same as WeeklyHero). */
function fgDeltaVisual(deltaPts: number | null): DeltaVisual | null {
  if (deltaPts == null) return null;
  if (deltaPts > 0.5) {
    const n = Math.round(deltaPts);
    return { text: `▲ ${n} pts`, fg: color.make, spoken: `up ${n} points` };
  }
  if (deltaPts < -0.5) {
    const n = Math.round(Math.abs(deltaPts));
    return { text: `▼ ${n} pts`, fg: color.miss, spoken: `down ${n} points` };
  }
  return { text: 'level', fg: color.textFaint, spoken: 'level' };
}

/** Whole-count delta (shots, sessions): signed number or 'level' at zero. */
function countDeltaVisual(delta: number): DeltaVisual {
  if (delta > 0) return { text: `+${delta}`, fg: color.make, spoken: `up ${delta}` };
  if (delta < 0) {
    return { text: `−${Math.abs(delta)}`, fg: color.miss, spoken: `down ${Math.abs(delta)}` };
  }
  return { text: 'level', fg: color.textFaint, spoken: 'level' };
}

export function SeasonStrip({
  comparison,
  entering,
}: {
  comparison: SeasonComparison;
  entering?: ComponentProps<typeof Card>['entering'];
}) {
  const { recent } = comparison;
  const fgText = recent.fgPct != null ? `${Math.round(recent.fgPct * 100)}%` : '—';
  const fgDelta = fgDeltaVisual(comparison.fgDeltaPts);
  const shotsDelta = countDeltaVisual(comparison.attemptsDelta);
  const sessionsDelta = countDeltaVisual(comparison.sessionsDelta);

  const a11y =
    `Last four weeks versus the four before: field goals ${fgText}` +
    `${fgDelta ? `, ${fgDelta.spoken}` : ''}, ` +
    `${recent.attempts} shots, ${shotsDelta.spoken}, ` +
    `${recent.sessions} sessions, ${sessionsDelta.spoken}.`;

  return (
    <Card entering={entering}>
      <SectionEyebrow icon="swap-horizontal-outline">
        Last 4 weeks vs the 4 before
      </SectionEyebrow>

      <View style={styles.strip} accessible accessibilityLabel={a11y}>
        <View style={styles.col}>
          <StatNumber value={fgText} label="FG" size="medium" />
          {fgDelta != null && (
            <Text style={[styles.delta, { color: fgDelta.fg }]}>{fgDelta.text}</Text>
          )}
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <StatNumber value={String(recent.attempts)} label="shots" size="medium" />
          <Text style={[styles.delta, { color: shotsDelta.fg }]}>{shotsDelta.text}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <StatNumber value={String(recent.sessions)} label="sessions" size="medium" />
          <Text style={[styles.delta, { color: sessionsDelta.fg }]}>{sessionsDelta.text}</Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  eyebrowRow: {
    marginBottom: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
  },

  // Box-score strip (same shape as coach.tsx's WeeklyHero strip).
  strip: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: space.lg,
    marginTop: space.sm,
  },
  col: {
    flex: 1,
    alignItems: 'center',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 44,
    backgroundColor: color.border,
    marginBottom: space.xs,
  },
  delta: {
    ...type.micro,
    fontVariant: ['tabular-nums'],
    marginTop: space.xs,
  },
});
