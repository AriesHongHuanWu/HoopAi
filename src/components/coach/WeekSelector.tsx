/**
 * WeekSelector — the Mon–Sun week picker above the weekly hero.
 *
 * Extracted from coach.tsx, and upgraded from a wrapping chip cloud to a
 * single-row horizontal shelf: with months of history the wrap grew to three
 * lines and pushed the hero (the screen's actual headline) under the fold.
 * Weeks come in newest-first from weeksOf(), so the shelf naturally leads
 * with the most recent week at the left edge.
 *
 * The active chip is auto-scrolled into view with a plain ref scrollTo — a
 * JS-thread call on layout data we already hold. Deliberately NOT a worklet
 * (the fx/particles crash precedent: this file adds no UI-thread code).
 */
import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { color, font, radius, space, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';

export function WeekSelector({
  weeks,
  activeIndex,
  onPick,
}: {
  weeks: { startMs: number; label: string; sessions: number }[];
  activeIndex: number;
  onPick: (i: number) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  /** Chip left edges, filled by onLayout (indexes are stable per render). */
  const chipX = useRef<Map<number, number>>(new Map());

  // Bring the active chip into view whenever the selection moves — including
  // picks made OUTSIDE this control (the four-week timeline bars jump the
  // selector too). Plain ref scrollTo; ScrollView clamps overshoot itself.
  useEffect(() => {
    const x = chipX.current.get(activeIndex);
    if (x != null) {
      scrollRef.current?.scrollTo({ x: Math.max(0, x - space.lg), animated: true });
    }
  }, [activeIndex, weeks.length]);

  if (weeks.length <= 1) return null;
  return (
    // Named, because this screen now carries TWO tablists (weeks here, the
    // section switcher below the hero) and an unnamed pair is indistinguishable
    // to a screen reader.
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel="Pick a week"
      contentContainerStyle={styles.weekBar}
    >
      {weeks.map((w, i) => {
        const active = i === activeIndex;
        return (
          <Pressable
            key={w.startMs}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Week of ${w.label}, ${w.sessions} ${w.sessions === 1 ? 'session' : 'sessions'}`}
            onPress={() => {
              // Selection tick only when the week actually CHANGES — the
              // SegmentedTabs grammar. Gateway call, JS thread (this file's
              // no-UI-thread-code rule holds).
              if (!active) haptic.selection();
              onPick(i);
            }}
            onLayout={(e) => chipX.current.set(i, e.nativeEvent.layout.x)}
            style={({ pressed }) => [
              styles.weekChip,
              active && styles.weekChipActive,
              pressed && !active && styles.weekChipPressed,
            ]}
          >
            <Text style={[styles.weekChipText, active && styles.weekChipTextActive]} numberOfLines={1}>
              {w.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  weekBar: {
    flexDirection: 'row',
    gap: space.sm,
  },
  weekChip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  weekChipActive: {
    backgroundColor: color.accentTint,
    borderColor: color.accentEdge,
  },
  weekChipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  weekChipText: {
    ...type.caption,
    color: color.textDim,
  },
  weekChipTextActive: {
    color: color.accent,
    fontFamily: font.bodySemiBold,
  },
});
