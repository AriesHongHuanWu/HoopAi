/**
 * StatStrip — the glanceable scoreboard on the live HUD.
 *
 * Broadcast layout on frosted glass:
 *   • collapsed: one scoreline — scoreboard numeral for points, dot-separated
 *     made/FG% figures on a shared baseline, flame pill escalating through the
 *     heat-tier ladder (HOT / ON FIRE / UNCONSCIOUS at 3 / 5 / 10 — see
 *     hud/heatTier.ts, aligned with STREAKS.celebrateAt);
 *   • expanded: a lead POINTS panel (huge scoreboard numeral), an aligned
 *     Made | FG% grid, the current streak with its heat label, and a compact
 *     2PT / 3PT split line, the 3s inked in downtown gold.
 *
 * Expand/collapse cross-fades and re-flows via Reanimated layout transitions
 * (system reduced-motion respected). Subscribes to the session store with
 * narrow selectors so it only re-renders when a shot resolves — the Skia
 * overlay handles everything per-frame.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
  ReduceMotion,
} from 'react-native-reanimated';

import { color, motion, radius, space, type } from '../../constants/tokens';
import { useSession } from '../../state/sessionStore';
import { Chip, Row, StatNumber } from '../ui';
import { heatState } from './heatTier';
import { HudChip } from './HudChip';

function pct(makes: number, attempts: number): string {
  return attempts > 0 ? `${Math.round((makes / attempts) * 100)}` : '—';
}

const reflow = LinearTransition.duration(motion.standard).reduceMotion(ReduceMotion.System);

/** Middle dot separator — quieter than a hairline, keeps the scoreline one phrase. */
function DotSep() {
  return <Text style={styles.dotSep}>·</Text>;
}

/**
 * PERF (memo): StatStrip subscribes to the session store directly; the only
 * prop from the live screen is the orientation flag. memo means a countdown
 * tick or toast no longer re-renders the strip (and its expanded card).
 */
export const StatStrip = React.memo(function StatStrip({
  style,
  compact = false,
}: {
  style?: StyleProp<ViewStyle>;
  /**
   * Landscape / small-height layout: smaller numerals + tighter padding so the
   * strip fits a narrow docked column without covering the court.
   */
  compact?: boolean;
}) {
  const makes = useSession((s) => s.stats.makes);
  const attempts = useSession((s) => s.stats.attempts);
  const fgPct = useSession((s) => s.stats.fgPct);
  const streak = useSession((s) => s.stats.currentStreak);
  const points = useSession((s) => s.stats.points);
  const twoPtMakes = useSession((s) => s.stats.twoPtMakes);
  const twoPtAttempts = useSession((s) => s.stats.twoPtAttempts);
  const threePtMakes = useSession((s) => s.stats.threePtMakes);
  const threePtAttempts = useSession((s) => s.stats.threePtAttempts);

  const heat = heatState(streak);
  const hot = heat.tier >= 1;
  const a11y =
    `${points} points. ${makes} of ${attempts} made, ${Math.round(fgPct * 100)} percent. ` +
    `Twos ${twoPtMakes} of ${twoPtAttempts}. Threes ${threePtMakes} of ${threePtAttempts}. ` +
    `Streak ${streak}${heat.label != null ? ', ' + heat.label.toLowerCase() : ''}.`;

  // MINIMAL BY DEFAULT: the court is the star, not the scoreboard. One tap
  // toggles between a single glanceable line and the full broadcast cards.
  const [expanded, setExpanded] = useState(false);

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={expanded ? 'Collapses to the compact scoreline' : 'Expands the full scoreboard'}
      onPress={() => setExpanded((e) => !e)}
      style={style}
    >
      <Animated.View layout={reflow}>
        {!expanded ? (
          <Animated.View
            key="mini"
            entering={FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System)}
          >
            <HudChip deep style={styles.miniChip}>
              {/* Shared text baseline: the 32pt numeral and 15pt figures sit on
                  one line instead of floating at their own vertical centers. */}
              <Row style={styles.miniRow} gap={space.sm}>
                <Text style={styles.miniPoints}>{points}</Text>
                <Text style={styles.miniUnit}>PTS</Text>
                <DotSep />
                <Text style={styles.miniStat}>
                  {makes}/{attempts}
                </Text>
                <DotSep />
                <Text style={styles.miniStat}>
                  {pct(makes, attempts)}
                  <Text style={styles.miniStatUnit}>%</Text>
                </Text>
                {hot && (
                  <View
                    style={[
                      styles.flamePill,
                      heat.tier === 2 && styles.flamePillFire,
                      heat.tier === 3 && styles.flamePillGold,
                    ]}
                  >
                    <Text
                      style={[
                        styles.flameText,
                        heat.tier === 2 && styles.flameTextFire,
                        heat.tier === 3 && styles.flameTextGold,
                      ]}
                    >{`🔥${streak}`}</Text>
                  </View>
                )}
                <Ionicons
                  name="chevron-down"
                  size={14}
                  color={color.textFaint}
                  style={styles.chevron}
                />
              </Row>
            </HudChip>
          </Animated.View>
        ) : (
          <Animated.View
            key="full"
            entering={FadeInDown.duration(motion.quick).reduceMotion(ReduceMotion.System)}
          >
            <Row style={styles.strip} gap={space.sm}>
              <HudChip deep style={[styles.pointsChip, compact && styles.pointsChipCompact]}>
                <StatNumber value={`${points}`} label="Points" size={compact ? 'medium' : 'large'} />
              </HudChip>
              <View style={styles.sideCol}>
                <HudChip style={[styles.sideChip, compact && styles.sideChipCompact]}>
                  {/* Equal-flex columns so Made | FG% land on a real grid. */}
                  <Row style={styles.sideRow}>
                    <StatNumber
                      value={`${makes}/${attempts}`}
                      label="Made"
                      size="medium"
                      style={styles.sideStat}
                    />
                    <View style={styles.divider} />
                    <StatNumber
                      value={pct(makes, attempts)}
                      label="FG%"
                      size="medium"
                      style={styles.sideStat}
                    />
                  </Row>
                </HudChip>
                <HudChip
                  style={[styles.sideChip, compact && styles.sideChipCompact]}
                  tone={heat.tier >= 3 ? 'downtown' : hot ? 'accent' : 'default'}
                >
                  <StatNumber
                    value={hot ? `🔥 ${streak}` : `${streak}`}
                    label="Streak"
                    size="medium"
                    tint={heat.tier >= 3 ? color.threePt : hot ? color.accent : undefined}
                  />
                  {heat.label != null && (
                    <View style={styles.heatLabelWrap}>
                      <Chip label={heat.label} tone="accent" compact />
                    </View>
                  )}
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
          </Animated.View>
        )}
      </Animated.View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  miniChip: {
    alignSelf: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  miniRow: {
    alignItems: 'baseline',
  },
  miniPoints: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  miniUnit: {
    ...type.micro,
    color: color.textFaint,
    marginLeft: -space.xs,
  },
  dotSep: {
    ...type.bodyMedium,
    color: color.textFaint,
  },
  miniStat: {
    ...type.bodyMedium,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  miniStatUnit: {
    color: color.textFaint,
  },
  flamePill: {
    alignSelf: 'center',
    backgroundColor: color.accentTint,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  flameText: {
    ...type.caption,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  /** Tier 2 (ON FIRE) — inverted, loud: solid accent pill, coal text. */
  flamePillFire: {
    backgroundColor: color.accent,
  },
  flameTextFire: {
    color: color.bg,
  },
  /** Tier 3 (UNCONSCIOUS) — downtown gold, same ink as the 3PT identity. */
  flamePillGold: {
    backgroundColor: color.threePtTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.threePt,
  },
  flameTextGold: {
    color: color.threePt,
  },
  heatLabelWrap: {
    marginTop: space.xs,
  },
  chevron: {
    alignSelf: 'center',
  },
  strip: {
    justifyContent: 'center',
    alignItems: 'stretch',
  },
  pointsChip: {
    flex: 1.1,
    paddingVertical: space.md,
  },
  pointsChipCompact: {
    paddingVertical: space.sm,
  },
  sideCol: {
    flex: 1,
    gap: space.sm,
  },
  sideChip: {
    paddingVertical: space.sm,
  },
  sideChipCompact: {
    paddingVertical: space.xs,
  },
  sideRow: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    gap: space.sm,
  },
  sideStat: {
    flex: 1,
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
    alignItems: 'baseline',
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
