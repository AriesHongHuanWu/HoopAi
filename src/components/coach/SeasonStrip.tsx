/**
 * SeasonStrip — the last 4 weeks as a broadcast box-score strip (FG% / shots
 * / sessions), with head-to-head delta cells against the 4 weeks before when
 * that prior window actually has attempts.
 *
 * Presentational only: the comparison comes from seasonComparison()
 * (src/core/coachInsights.ts). Deltas always carry a glyph (▲/▼/'level')
 * alongside color — never color alone (colorblind rule).
 *
 * When the prior 28-day block is empty (new users with under ~5 weeks of
 * history) the strip still renders the current 28-day numbers but drops every
 * delta and shows an honest unlock line instead. Prior numbers are NEVER
 * faked or imputed as a zero baseline — a "▲ +40 shots" against nothing would
 * be a lie.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Row, StatNumber } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { SeasonComparison } from '@/core/coachInsights';

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

/**
 * Copy for the no-prior unlock line. Fixed wording: SeasonComparison carries
 * no history-extent field, so an exact "N more weeks" countdown cannot be
 * computed honestly from these props.
 */
const UNLOCK_COPY = 'Keep logging sessions — the head-to-head unlocks after 4 more weeks.';

export function SeasonStrip({
  comparison,
  entering,
}: {
  comparison: SeasonComparison;
  entering?: ComponentProps<typeof Card>['entering'];
}) {
  const { recent } = comparison;
  const hasPrior = comparison.prior.attempts > 0;
  const fgText = recent.fgPct != null ? `${Math.round(recent.fgPct * 100)}%` : '—';
  const fgDelta = hasPrior ? fgDeltaVisual(comparison.fgDeltaPts) : null;
  const shotsDelta = hasPrior ? countDeltaVisual(comparison.attemptsDelta) : null;
  const sessionsDelta = hasPrior ? countDeltaVisual(comparison.sessionsDelta) : null;

  const a11y = hasPrior
    ? `Last four weeks versus the four before: field goals ${fgText}` +
      `${fgDelta ? `, ${fgDelta.spoken}` : ''}, ` +
      `${recent.attempts} shots, ${shotsDelta!.spoken}, ` +
      `${recent.sessions} sessions, ${sessionsDelta!.spoken}.`
    : `Last four weeks: field goals ${fgText}, ${recent.attempts} shots, ` +
      `${recent.sessions} sessions. ${UNLOCK_COPY}`;

  return (
    <Card entering={entering}>
      <SectionEyebrow
        icon={hasPrior ? 'swap-horizontal-outline' : 'calendar-outline'}
        style={styles.eyebrow}
      >
        {hasPrior ? 'Last 4 weeks vs the 4 before' : 'Last 4 weeks'}
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
          {shotsDelta != null && (
            <Text style={[styles.delta, { color: shotsDelta.fg }]}>{shotsDelta.text}</Text>
          )}
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <StatNumber value={String(recent.sessions)} label="sessions" size="medium" />
          {sessionsDelta != null && (
            <Text style={[styles.delta, { color: sessionsDelta.fg }]}>{sessionsDelta.text}</Text>
          )}
        </View>
      </View>

      {!hasPrior && (
        <Row gap={6} style={styles.unlockRow}>
          <Ionicons name="lock-closed-outline" size={12} color={color.textFaint} />
          <Text style={styles.unlockText}>{UNLOCK_COPY}</Text>
        </Row>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  // Shared SectionEyebrow leaves margins to the call site (screens own rhythm).
  eyebrow: {
    marginBottom: space.sm,
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

  // Honest unlock line shown while the prior 28-day block is still empty.
  unlockRow: {
    marginTop: space.md,
  },
  unlockText: {
    ...type.caption,
    color: color.textFaint,
    flex: 1,
  },
});
