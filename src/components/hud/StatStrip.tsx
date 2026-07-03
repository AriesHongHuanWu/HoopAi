/**
 * StatStrip — the glanceable scoreboard on the live HUD.
 *
 * Broadcast layout on frosted glass:
 *   • a lead POINTS panel (huge scoreboard numeral),
 *   • FG% and the current streak (streak goes hot ≥ 3),
 *   • a compact 2PT / 3PT split line, the 3s inked in downtown gold.
 *
 * Subscribes to the session store with narrow selectors so it only re-renders
 * when a shot resolves — the Skia overlay handles everything per-frame.
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, space, type } from '../../constants/tokens';
import { useSession } from '../../state/sessionStore';
import { Row, StatNumber } from '../ui';
import { HudChip } from './HudChip';

function pct(makes: number, attempts: number): string {
  return attempts > 0 ? `${Math.round((makes / attempts) * 100)}` : '—';
}

export function StatStrip({ style }: { style?: StyleProp<ViewStyle> }) {
  const makes = useSession((s) => s.stats.makes);
  const attempts = useSession((s) => s.stats.attempts);
  const fgPct = useSession((s) => s.stats.fgPct);
  const streak = useSession((s) => s.stats.currentStreak);
  const points = useSession((s) => s.stats.points);
  const twoPtMakes = useSession((s) => s.stats.twoPtMakes);
  const twoPtAttempts = useSession((s) => s.stats.twoPtAttempts);
  const threePtMakes = useSession((s) => s.stats.threePtMakes);
  const threePtAttempts = useSession((s) => s.stats.threePtAttempts);

  const hot = streak >= 3;
  const a11y =
    `${points} points. ${makes} of ${attempts} made, ${Math.round(fgPct * 100)} percent. ` +
    `Twos ${twoPtMakes} of ${twoPtAttempts}. Threes ${threePtMakes} of ${threePtAttempts}. ` +
    `Streak ${streak}.`;

  return (
    <View accessible accessibilityLabel={a11y} style={style}>
      <Row style={styles.strip} gap={space.sm}>
        <HudChip deep style={styles.pointsChip}>
          <StatNumber value={`${points}`} label="Points" size="large" />
        </HudChip>
        <View style={styles.sideCol}>
          <HudChip style={styles.sideChip}>
            <Row style={styles.sideRow}>
              <StatNumber value={`${makes}/${attempts}`} label="Made" size="medium" />
              <View style={styles.divider} />
              <StatNumber value={pct(makes, attempts)} label="FG%" size="medium" />
            </Row>
          </HudChip>
          <HudChip style={styles.sideChip} tone={hot ? 'accent' : 'default'}>
            <StatNumber
              value={hot ? `🔥 ${streak}` : `${streak}`}
              label="Streak"
              size="medium"
              tint={hot ? color.accent : undefined}
            />
          </HudChip>
        </View>
      </Row>

      {/* 2PT / 3PT split — downtown gold on the threes */}
      <Row style={styles.splitRow} gap={space.sm}>
        <HudChip style={styles.splitChip}>
          <Row style={styles.splitInner}>
            <Text style={styles.splitLabel}>2PT</Text>
            <Text style={styles.splitValue}>
              {twoPtMakes}
              <Text style={styles.splitDim}>/{twoPtAttempts}</Text>
            </Text>
          </Row>
        </HudChip>
        <HudChip style={styles.splitChip} tone="downtown">
          <Row style={styles.splitInner}>
            <Text style={[styles.splitLabel, styles.splitLabelGold]}>3PT</Text>
            <Text style={[styles.splitValue, styles.splitValueGold]}>
              {threePtMakes}
              <Text style={styles.splitDimGold}>/{threePtAttempts}</Text>
            </Text>
          </Row>
        </HudChip>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    justifyContent: 'center',
    alignItems: 'stretch',
  },
  pointsChip: {
    flex: 1.1,
    paddingVertical: space.md,
  },
  sideCol: {
    flex: 1,
    gap: space.sm,
  },
  sideChip: {
    paddingVertical: space.sm,
  },
  sideRow: {
    justifyContent: 'center',
    gap: space.md,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: color.hudGlassBorder,
  },
  splitRow: {
    justifyContent: 'center',
    alignItems: 'stretch',
    marginTop: space.sm,
  },
  splitChip: {
    flex: 1,
    paddingVertical: space.xs,
  },
  splitInner: {
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    gap: space.sm,
  },
  splitLabel: {
    ...type.micro,
    color: color.textDim,
  },
  splitLabelGold: {
    color: color.threePt,
  },
  splitValue: {
    ...type.statMedium,
    fontSize: 22,
    lineHeight: 24,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  splitValueGold: {
    color: color.threePt,
  },
  splitDim: {
    color: color.textFaint,
  },
  splitDimGold: {
    color: 'rgba(242, 193, 78, 0.6)',
  },
});
