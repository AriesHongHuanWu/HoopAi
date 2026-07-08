/**
 * SeasonCard — the player's rolling 30-day "season" as a broadcast stat card.
 *
 * Treats the last 30 days like a real season: total makes, shooting %, sessions,
 * and a run toward a season makes goal, plus the season's best day-streak and
 * best week. Loads its own session summaries (startedAt/makes/attempts) so it
 * drops straight into any screen. Sits quiet with an invitation before the first
 * session, then comes alive once there's a shot to count.
 *
 * Pure presentational logic lives in src/core/seasonStats.ts; this file only
 * loads + renders.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ComponentProps } from 'react';

import { Card, Row, StatNumber } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import {
  SEASON_DAYS,
  SEASON_MAKES_GOAL,
  seasonGoalProgress,
  seasonStats,
  type SeasonStats,
} from '@/core/seasonStats';
import { listSessions } from '@/data/db';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** How many recent sessions to scan for the season window. */
const SCAN_LIMIT = 120;

/** A single sub-stat (best streak / best week) with an icon. */
function MiniStat({ icon, value, label }: { icon: IconName; value: string; label: string }) {
  return (
    <View style={styles.mini} accessible accessibilityLabel={`${value} ${label}`}>
      <Ionicons name={icon} size={14} color={color.accent} />
      <Text style={styles.miniValue}>{value}</Text>
      <Text style={styles.miniLabel}>{label}</Text>
    </View>
  );
}

export function SeasonCard({
  entering,
}: {
  entering?: ComponentProps<typeof Card>['entering'];
}) {
  const [rows, setRows] = useState<{ startedAt: number; makes: number; attempts: number }[] | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const summaries = await listSessions(SCAN_LIMIT);
        if (alive) {
          setRows(
            summaries.map((r) => ({ startedAt: r.startedAt, makes: r.makes, attempts: r.attempts })),
          );
        }
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // nowMs is read once per mount; a stat card doesn't need to tick live.
  const season = useMemo<SeasonStats | null>(
    () => (rows == null ? null : seasonStats(rows, Date.now())),
    [rows],
  );

  // Loading / not-yet-computed: render nothing (the profile above stands alone).
  if (season == null) return null;

  const started = season.attempts > 0;
  const pct = Math.round(season.rate * 100);
  const goalPct = seasonGoalProgress(season.makes);

  return (
    <Card entering={entering}>
      <Row style={styles.head}>
        <Text style={styles.eyebrow}>SEASON · LAST {SEASON_DAYS} DAYS</Text>
        {started && season.bestDayStreak > 0 && (
          <Text style={styles.flame}>{`${season.bestDayStreak}🔥`}</Text>
        )}
      </Row>

      {started ? (
        <>
          {/* Headline trio */}
          <Row gap={space.lg} style={styles.statRow}>
            <StatNumber size="large" value={`${pct}%`} label="FG" tint={color.accent} />
            <View style={styles.statDivider} />
            <StatNumber size="large" value={String(season.makes)} label="Makes" />
            <View style={styles.statDivider} />
            <StatNumber size="large" value={String(season.sessions)} label="Sessions" />
          </Row>

          {/* Season makes goal — a run to chase */}
          <View style={styles.goal}>
            <Row style={styles.goalHead}>
              <Text style={styles.goalLabel}>Season goal</Text>
              <Text style={styles.goalCount}>{`${season.makes} / ${SEASON_MAKES_GOAL} makes`}</Text>
            </Row>
            <View style={styles.track} importantForAccessibility="no-hide-descendants">
              <View style={[styles.fill, { width: `${Math.max(2, goalPct * 100)}%` }]} />
            </View>
          </View>

          {/* Best-of footer */}
          <Row gap={space.lg} style={styles.footer}>
            <MiniStat icon="flame-outline" value={String(season.bestDayStreak)} label="day streak" />
            <MiniStat
              icon="calendar-outline"
              value={String(season.bestWeekSessions)}
              label="best week"
            />
            <MiniStat icon="basketball-outline" value={String(season.attempts)} label="shots" />
          </Row>
        </>
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Your season starts with your next shot</Text>
          <Text style={styles.emptyBody}>
            Track a session and this becomes your rolling {SEASON_DAYS}-day scoreboard — makes,
            shooting %, and a run to {SEASON_MAKES_GOAL}.
          </Text>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: {
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.md,
  },
  eyebrow: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
  },
  flame: {
    ...type.bodyMedium,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  statRow: {
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: color.border,
  },
  goal: {
    marginTop: space.lg,
    gap: space.xs,
  },
  goalHead: {
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  goalLabel: {
    ...type.bodyMedium,
    color: color.text,
  },
  goalCount: {
    ...type.caption,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  track: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  footer: {
    marginTop: space.lg,
    justifyContent: 'space-between',
  },
  mini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  miniValue: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  miniLabel: {
    ...type.caption,
    color: color.textDim,
  },
  empty: {
    gap: space.xs,
    paddingVertical: space.sm,
  },
  emptyTitle: {
    ...type.heading,
    color: color.text,
  },
  emptyBody: {
    ...type.body,
    color: color.textDim,
  },
});
