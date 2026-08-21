/**
 * CoachTimelineCard — the past 4 weeks as tappable WSS bar columns.
 *
 * Presentational only: weeks come in oldest-first from coachTimeline()
 * (src/core/coachInsights.ts); tapping a column reports the picked week's
 * start back through onPickWeek so the screen can move its week selector.
 * No store reads, no router — the integrator wires those in coach.tsx.
 */
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Row } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import type { TimelineWeek } from '@/core/coachInsights';
import { haptic } from '@/utils/haptics';

/** Fixed bar-track height; WSS (0–100) maps directly onto it as a % fill. */
const TRACK_HEIGHT = 72;

/** 'Jun 22 – 28' → 'Jun 22' (the tick under each column). */
function weekTick(label: string): string {
  return (label.split('–')[0] ?? label).trim().slice(0, 6);
}

export function CoachTimelineCard({
  weeks,
  activeStartMs,
  onPickWeek,
  entering,
}: {
  /** Oldest-first, length 4 (from coachTimeline). */
  weeks: readonly TimelineWeek[];
  /** weekStartMs of the currently selected week. */
  activeStartMs: number;
  onPickWeek: (weekStartMs: number) => void;
  entering?: ComponentProps<typeof Card>['entering'];
}) {
  return (
    <Card entering={entering}>
      <SectionEyebrow icon="stats-chart-outline" style={styles.eyebrow}>
        Past 4 weeks
      </SectionEyebrow>

      <Row gap={space.sm} style={styles.bars}>
        {weeks.map((w) => {
          const active = w.weekStartMs === activeStartMs;
          const played = w.sessions > 0;
          // Min 4% stub so a played-but-low week is still visible; empty = 0.
          const fillPct = Math.max(w.wss, played ? 4 : 0);
          const pctText = w.fgPct != null ? `${Math.round(w.fgPct * 100)}%` : '—';
          return (
            <Pressable
              key={w.weekStartMs}
              accessibilityRole="button"
              // Empty weeks aren't in coach.tsx's week selector (weeksOf only
              // yields weeks WITH sessions), so a pick would no-op — disable
              // the column and drop the 'Shows that week' promise instead.
              disabled={!played}
              accessibilityState={{ selected: active, disabled: !played }}
              accessibilityLabel={
                played
                  ? `Week of ${w.label}: WSS ${w.wss}, ${w.makes} makes at ${pctText}. ${
                      active ? 'Selected.' : 'Shows that week.'
                    }`
                  : `Week of ${w.label}: no sessions.`
              }
              onPress={() => {
                // A column IS a week pick — same tick, same change-only gate,
                // as the SegmentedTabs and week chips around it.
                if (!active) haptic.selection();
                onPickWeek(w.weekStartMs);
              }}
              style={({ pressed }) => [styles.colPress, pressed && !active && { opacity: 0.7 }]}
            >
              <View style={[styles.track, active && styles.trackActive]}>
                <View
                  style={[
                    styles.fill,
                    {
                      height: `${fillPct}%`,
                      backgroundColor: played ? color.accent : 'transparent',
                    },
                    played && !active && { opacity: 0.45 },
                  ]}
                />
              </View>
              <Text style={[styles.wss, w.sessions === 0 && { color: color.textFaint }]}>
                {played ? String(w.wss) : '—'}
              </Text>
              <Text style={styles.fg}>{pctText}</Text>
              <Text style={styles.tick} numberOfLines={1}>
                {weekTick(w.label)}
              </Text>
            </Pressable>
          );
        })}
      </Row>

      <Text style={styles.footnote}>
        WSS blends accuracy, volume and consistency (0–100). Tap a week to inspect it.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Shared SectionEyebrow leaves margins to the call site (screens own rhythm).
  eyebrow: {
    marginBottom: space.sm,
  },
  bars: {
    alignItems: 'flex-end',
    marginTop: space.xs,
  },
  colPress: {
    flex: 1,
    alignItems: 'stretch',
    gap: space.xs,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceRaised,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  trackActive: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accent,
  },
  fill: {
    width: '100%',
  },
  wss: {
    // The dense-grid numeral step from the shared ladder — was a hand-rolled
    // font.display 18/20. Four 22px tabular columns hold on a 320pt device:
    // 320 − screen padding (2·16) − card padding (2·16) − 3 gaps (3·8) = 232,
    // i.e. 58pt per flex column vs ~40pt for a three-digit WSS numeral.
    ...type.statSmall,
    color: color.text,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  fg: {
    ...type.micro,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  tick: {
    ...type.micro,
    color: color.textFaint,
    textAlign: 'center',
  },
  footnote: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.md,
  },
});
