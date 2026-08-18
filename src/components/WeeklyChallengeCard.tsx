/**
 * WeeklyChallengeCard — the deck's 每週挑戰 (weekly challenges) on Home,
 * sitting directly beneath the daily three.
 *
 * WHY a component and not more JSX in (tabs)/index.tsx: Home is already the
 * longest screen in the app, and this block carries real branching (done
 * state, honest notes, an empty week). Lifting it out keeps Home readable and
 * makes the block render-testable against a fixed WeekAggregate with no DB,
 * no clock and no navigation.
 *
 * WHY it mirrors the daily row's shape exactly (same icon chip, same title +
 * n/target line, same 5px track, same points chip): daily and weekly are one
 * habit loop with two clocks, so they must read as one list with two headers,
 * not two unrelated widgets. Only the eyebrow and the points readout differ.
 *
 * PURE PRESENTATION: every number comes from src/core/weeklyChallenges.ts —
 * this file computes nothing, calls no clock, and stores nothing. The parent
 * owns the week key, the aggregate load and the points award.
 *
 * HONESTY: some weekly goals can be blocked by MISSING INPUT rather than by
 * effort (no previous week to beat, no court placement behind a spots count).
 * The evaluator reports that as `note`, and this card renders the note under
 * the frozen bar — and repeats it in the accessibility label — so a stuck 0
 * is never silently passed off as a lazy week. Nothing here ever invents a
 * number for an unmeasured input.
 */
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import type Animated from 'react-native-reanimated';

import { Card, Chip, Eyebrow, Row } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import {
  evaluateWeekly,
  weeklyPoints,
  type WeeklyChallengeDef,
  type WeekAggregate,
  type WeeklyResult,
} from '@/core/weeklyChallenges';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export interface WeeklyChallengeCardProps {
  /** This ISO week's deterministic picks (src/core/weeklyChallenges.ts). */
  challenges: readonly WeeklyChallengeDef[];
  /** The week's folded session facts. Pass an empty aggregate while loading. */
  agg: WeekAggregate;
  /** Card stagger entrance from the parent's useCardStagger. */
  entering?: React.ComponentProps<typeof Animated.View>['entering'];
}

/** Screen-reader sentence for one challenge row, notes included. */
function rowLabel(r: WeeklyResult): string {
  const base = `${r.def.title}, ${r.progress} of ${r.target}${
    r.done ? ', completed' : ''
  }, worth ${r.def.points} points`;
  return r.note ? `${base}. ${r.note}` : base;
}

export function WeeklyChallengeCard({ challenges, agg, entering }: WeeklyChallengeCardProps) {
  // Defensive: the deterministic draw always returns three, but a card with
  // nothing to show should show nothing rather than an empty frame.
  if (challenges.length === 0) return null;

  const results = evaluateWeekly(challenges, agg);
  const earned = weeklyPoints(results);
  const offered = results.reduce((sum, r) => sum + Math.max(0, r.def.points), 0);
  /** Nothing tracked in the window at all — say so instead of implying a bad week. */
  const untouched = agg.attempts === 0 && agg.sessions === 0;

  return (
    <Card entering={entering}>
      <Row style={styles.header}>
        <Eyebrow>Weekly challenges</Eyebrow>
        {/* '★ earned/offered', matching the daily card's '★ N' voice — PTS is
            reserved app-wide for scored basketball points. */}
        <Text
          style={styles.points}
          accessibilityLabel={`${earned} of ${offered} weekly challenge points earned this week`}
        >
          {`★ ${earned}/${offered}`}
        </Text>
      </Row>

      {untouched && (
        <Text style={styles.zeroState}>
          No shots tracked this week yet — every bar below is a true zero, not an
          estimate. The set resets Monday.
        </Text>
      )}

      <View style={styles.list}>
        {results.map((r) => {
          const frac = r.target > 0 ? Math.min(1, r.progress / r.target) : 0;
          return (
            <View key={r.def.id} accessible accessibilityLabel={rowLabel(r)} style={styles.row}>
              <View style={[styles.iconChip, r.done && styles.iconChipDone]}>
                <Ionicons
                  name={r.done ? 'checkmark' : (r.def.icon as IoniconName)}
                  size={15}
                  color={r.done ? color.make : color.accent}
                />
              </View>
              <View style={styles.body}>
                <Row style={styles.titleRow}>
                  <Text style={[styles.title, r.done && styles.titleDone]} numberOfLines={1}>
                    {r.def.title}
                  </Text>
                  <Text style={styles.count}>{`${r.progress}/${r.target}`}</Text>
                </Row>
                <View style={styles.track}>
                  <View
                    style={[styles.fill, { width: `${frac * 100}%` }, r.done && styles.fillDone]}
                  />
                </View>
                {r.note != null && (
                  <Row gap={space.xs} style={styles.noteRow}>
                    <Ionicons
                      name="information-circle-outline"
                      size={12}
                      color={color.textFaint}
                    />
                    <Text style={styles.note}>{r.note}</Text>
                  </Row>
                )}
              </View>
              <Chip compact label={`+${r.def.points}`} tone={r.done ? 'make' : 'accent'} />
            </View>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  points: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  zeroState: {
    ...type.body,
    color: color.textDim,
    marginTop: space.sm,
  },
  list: {
    gap: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  iconChip: {
    // Same tinted circle as the daily challenge rows — one icon voice.
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconChipDone: {
    backgroundColor: color.makeTint,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: space.xs,
  },
  titleRow: {
    justifyContent: 'space-between',
  },
  title: {
    ...type.bodyMedium,
    color: color.text,
    flexShrink: 1,
  },
  titleDone: {
    color: color.textDim,
  },
  count: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  fillDone: {
    backgroundColor: color.make,
  },
  noteRow: {
    alignItems: 'flex-start',
  },
  note: {
    ...type.micro,
    color: color.textFaint,
    flexShrink: 1,
    // micro's letterSpacing is tuned for uppercase chips; a full sentence
    // needs its normal line rhythm back to stay readable at 10pt.
    letterSpacing: 0,
    lineHeight: 15,
  },
});
