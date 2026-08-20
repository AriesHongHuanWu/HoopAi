/**
 * GoalChip — compact daily-goal progress on the live HUD.
 *
 * Displayed count = DB baseline + live store makes. The baseline is fetched
 * once per [goal, sessionId] via goalBaselineMakes, which EXCLUDES the
 * current session's persisted row: shots persist as they resolve, and this
 * chip mounts under `rimLocked` (flips false→true on every re-aim), so a
 * remount would otherwise double-count tonight's makes — once in the DB row,
 * once in live stats.makes. Re-running the effect when sessionId arrives late
 * (goLive is async) is intentional: it swaps the unexcluded baseline for the
 * excluded one as soon as the row id exists.
 *
 * Subscribes to the stores with narrow selectors only — re-renders at most
 * once per resolved shot, never per frame (live-screen iron rule).
 */
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '../../constants/tokens';
import { goalBaselineMakes, goalProgress } from '../../core/goals';
import { listSessions } from '../../data/db';
import { useSession } from '../../state/sessionStore';
import { useSettings } from '../../state/settingsStore';
import { Row } from '../ui';
import { HudChip } from './HudChip';

export function GoalChip(): React.JSX.Element | null {
  const goal = useSettings((s) => s.dailyGoalMakes);
  const liveMakes = useSession((s) => s.stats.makes);
  const sessionId = useSession((s) => s.sessionId);

  const [baseline, setBaseline] = useState<number | null>(null);
  useEffect(() => {
    if (goal <= 0) return;
    // listSessions never throws (returns [] on failure) — no catch needed.
    void listSessions(100).then((rows) => {
      setBaseline(goalBaselineMakes(rows, Date.now(), sessionId ?? undefined));
    });
  }, [goal, sessionId]);

  const made = (baseline ?? 0) + liveMakes;
  const hit = goal > 0 && baseline != null && made >= goal;

  // One-shot announcement — the moment the goal flips to hit, exactly once
  // per mount. StatStrip owns the ongoing scoreboard narration.
  const announced = useRef(false);
  useEffect(() => {
    if (hit && !announced.current) {
      announced.current = true;
      AccessibilityInfo.announceForAccessibility(`Daily goal hit — ${goal} makes today`);
    }
  }, [hit, goal]);

  if (goal <= 0 || baseline == null) return null;

  const progress = goalProgress(made, goal);

  return (
    <HudChip
      style={styles.chip}
      accessible
      accessibilityLabel={
        `Daily goal: ${made} of ${goal} makes today` + (hit ? ', goal hit' : '')
      }
    >
      <Row gap={space.sm} style={styles.row}>
        <Text style={styles.label}>GOAL</Text>
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              { width: `${Math.round(progress * 100)}%` },
              hit && styles.fillHit,
            ]}
          />
        </View>
        <Text style={[styles.count, hit && styles.countHit]}>
          {made}/{goal}
        </Text>
        {hit && <Text style={styles.hitTag}>HIT</Text>}
      </Row>
    </HudChip>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    marginTop: space.sm,
  },
  row: {
    alignItems: 'center',
  },
  label: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1.2,
  },
  track: {
    width: 72,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.hudGlassBorder,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    backgroundColor: color.accent,
  },
  fillHit: {
    backgroundColor: color.threePt,
  },
  count: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  countHit: {
    color: color.threePt,
  },
  hitTag: {
    ...type.micro,
    color: color.threePt,
  },
});
