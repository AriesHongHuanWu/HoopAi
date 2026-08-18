/**
 * SegmentedTabs — the in-screen section switcher.
 *
 * WHY THIS EXISTS: the app's long screens (Coach, session summary, Home) stack
 * eight-to-ten cards of identical weight in one endless scroll, so everything
 * below the fold is functionally invisible and the user has to remember what is
 * down there. Sub-navigation is the fix the owner chose: group the cards by the
 * question they answer and let the user pick the question. Screens were about
 * to hand-roll that control one at a time — the week-chip row on Coach is
 * already a half-version of it — so it lands here once, in the app's own
 * broadcast language, instead of as three drifting dialects.
 *
 * CONTROLLED ON PURPOSE (`value` + `onChange`): the selected section is screen
 * state, not widget state. Screens need to read it (to decide what to load, and
 * to restart their entrance stagger per section) and sometimes to write it (a
 * deep link or a "see the plan" button jumping the user to a section). A
 * self-managing control would make both of those reach into a child.
 *
 * MOTION: the indicator SLIDES between segments over `motion.tab` — the token
 * that already governs the lateral tab cross-fade, because this is the same
 * gesture one level down. Under reduced motion it does not slide: it lands on
 * the new segment in the same frame. A slide is precisely the vestibular motion
 * the OS setting asks us to drop, and swapping in a cross-fade instead would
 * just be a second, different animation — so the reduced path has none.
 *
 * HONESTY: a badge only ever shows a count the caller actually has. A numeric
 * badge of 0 renders nothing rather than a "0" that reads as a broken counter,
 * and `badgeLabel` exists so the screen reader hears what the number MEANS
 * ("3 findings") instead of a bare digit floating after the tab name.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// Imported from the CONCRETE module, not the '@/components/motion' barrel —
// the same call the shared kit in components/ui.tsx makes, for the same
// reason: this control sits UNDERNEATH screens, and screen suites routinely
// stub that barrel down to the two or three symbols the screen under test
// uses. Reaching past the barrel keeps the press spring real in every suite
// instead of resolving to `undefined` in any that happens to mock it.
import { PressScale } from './motion/PressScale';
import { color, font, motion, radius, space, touch, type } from '@/constants/tokens';

/** Inset of the indicator (and the segments) inside the track. */
const TRACK_INSET = space.xs;
/**
 * Segment height. TRACK_INSET on both sides brings the whole control to the
 * 48dp floor in `touch.minTarget`, so the tappable row is exactly one target
 * tall without the control looking like a button bar.
 */
const SEGMENT_HEIGHT = touch.minTarget - TRACK_INSET * 2;

/** testID on the sliding indicator — it has no text, so tests need a handle. */
export const SEGMENT_INDICATOR_TEST_ID = 'segmentedTabsIndicator';

export interface SegmentedTabItem<V extends string = string> {
  /** Stable identity handed back to `onChange`. */
  value: V;
  /** Visible label. Kept to one or two words — segments are equal-width. */
  label: string;
  /**
   * Optional marker. A number renders a count pill (0 renders nothing); 'dot'
   * renders a presence dot for "there is something here" with no count to back
   * it up.
   */
  badge?: number | 'dot';
  /**
   * What the badge MEANS, for the screen reader — e.g. '3 findings'. Always
   * pass this when you set `badge`: a bare number read after the tab name is
   * ambiguous, and a dot is silent without it.
   */
  badgeLabel?: string;
  /** Overrides the composed screen-reader label for this tab. */
  accessibilityLabel?: string;
}

export interface SegmentedTabsProps<V extends string = string> {
  segments: readonly SegmentedTabItem<V>[];
  /** Currently selected segment value. */
  value: V;
  onChange: (value: V) => void;
  /**
   * Names the tablist itself. Required in practice: a screen can carry more
   * than one tablist (Coach also has its week picker), and two unnamed ones
   * are indistinguishable to a screen reader.
   */
  accessibilityLabel: string;
  /** Settings-gated haptic fired when the selection CHANGES. Default 'selection'. */
  haptic?: 'none' | 'selection';
  style?: StyleProp<ViewStyle>;
}

/** Composed screen-reader name: label, then what the badge means. */
function composeLabel<V extends string>(seg: SegmentedTabItem<V>): string {
  if (seg.accessibilityLabel != null) return seg.accessibilityLabel;
  if (seg.badgeLabel != null) return `${seg.label}, ${seg.badgeLabel}`;
  if (seg.badge === 'dot') return `${seg.label}, flagged`;
  if (typeof seg.badge === 'number' && seg.badge > 0) return `${seg.label}, ${seg.badge}`;
  return seg.label;
}

export function SegmentedTabs<V extends string = string>({
  segments,
  value,
  onChange,
  accessibilityLabel,
  haptic = 'selection',
  style,
}: SegmentedTabsProps<V>) {
  const reduced = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);

  const count = Math.max(1, segments.length);
  const found = segments.findIndex((s) => s.value === value);
  // An unknown `value` parks the indicator at the first segment and leaves
  // every tab unselected — visibly wrong at the call site rather than quietly
  // pretending a segment is active.
  const index = found >= 0 ? found : 0;
  const segmentWidth = trackWidth > 0 ? (trackWidth - TRACK_INSET * 2) / count : 0;

  const x = useSharedValue(0);
  // First real measurement must SNAP, not slide: without this the indicator
  // animates in from the left edge on mount whenever the screen opens on a
  // segment other than the first (a restored selection, a deep link).
  const measured = useRef(false);

  useEffect(() => {
    if (segmentWidth <= 0) return;
    const target = index * segmentWidth;
    if (!measured.current || reduced) {
      measured.current = true;
      x.value = target;
      return;
    }
    x.value = withTiming(target, {
      duration: motion.tab,
      easing: Easing.out(Easing.cubic),
    });
  }, [index, segmentWidth, reduced, x]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
  }));

  const onTrackLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    // Guarded so a re-layout at the same width can't spin the state.
    setTrackWidth((prev) => (Math.abs(prev - w) < 1 ? prev : w));
  }, []);

  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={onTrackLayout}
      style={[styles.track, style]}
    >
      <Animated.View
        testID={SEGMENT_INDICATOR_TEST_ID}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.indicator, { width: segmentWidth }, indicatorStyle]}
      />
      {segments.map((seg) => {
        const selected = seg.value === value;
        const countBadge =
          typeof seg.badge === 'number' && seg.badge > 0 ? String(seg.badge) : null;
        const dotBadge = seg.badge === 'dot';
        const select = () => {
          // Re-tapping the live segment is a no-op, and firing onChange (or a
          // haptic tick) for it would make screens re-run selection work for
          // nothing.
          if (selected) return;
          onChange(seg.value);
        };
        return (
          // The a11y node is this wrapper, not the PressScale inside it:
          // PressScale forwards a role and a label but not
          // `accessibilityState`, and "which tab is selected" is the one thing
          // this control has to say. `onAccessibilityTap` keeps VoiceOver's
          // double-tap wired to the same handler as a finger.
          <View
            key={seg.value}
            accessible
            focusable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={composeLabel(seg)}
            onAccessibilityTap={select}
            style={styles.slot}
          >
            <PressScale
              onPress={select}
              haptic={selected ? 'none' : haptic}
              accessibilityRole="none"
              style={styles.segment}
            >
              <Text
                numberOfLines={1}
                style={[styles.label, selected && styles.labelSelected]}
              >
                {seg.label}
              </Text>
              {countBadge != null && (
                <View style={[styles.badge, selected && styles.badgeSelected]}>
                  <Text style={[styles.badgeText, selected && styles.badgeTextSelected]}>
                    {countBadge}
                  </Text>
                </View>
              )}
              {dotBadge && <View style={[styles.dot, selected && styles.dotSelected]} />}
            </PressScale>
          </View>
        );
      })}
    </View>
  );
}

export default SegmentedTabs;

const styles = StyleSheet.create({
  /**
   * A recessed track, not a raised bar: the control is a filter over the cards
   * below it, so it sits one step BEHIND them (canvas ground inside a hairline)
   * and the selected segment is the only lit thing in the row.
   */
  track: {
    flexDirection: 'row',
    alignItems: 'stretch',
    padding: TRACK_INSET,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.bg,
  },
  indicator: {
    position: 'absolute',
    left: TRACK_INSET,
    top: TRACK_INSET,
    bottom: TRACK_INSET,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    // Same accent-tint-on-accent-edge pair the week chips and the Coach hero
    // wear, so "this one is live" reads identically wherever it appears.
    backgroundColor: color.accentTint,
    borderColor: color.accentEdge,
  },
  slot: {
    flex: 1,
    minWidth: 0,
  },
  segment: {
    flex: 1,
    minHeight: SEGMENT_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
  },
  label: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  labelSelected: {
    color: color.accent,
    fontFamily: font.bodySemiBold,
  },
  badge: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: {
    backgroundColor: color.accent,
  },
  badgeText: {
    ...type.micro,
    color: color.textDim,
    letterSpacing: 0,
    fontVariant: ['tabular-nums'],
  },
  badgeTextSelected: {
    color: color.onAccent,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.textFaint,
  },
  dotSelected: {
    backgroundColor: color.accent,
  },
});
