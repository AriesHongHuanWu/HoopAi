/**
 * ShotTimeline — the replay scrubber (the signature of the video screen).
 *
 * A slim leather-orange progress track with an outcome-coloured dot for every
 * shot placed at its video timestamp:
 *   - make   → solid swish-green dot
 *   - miss   → brick-red donut (the open centre keeps the silhouette distinct
 *              from a make for colorblind viewers)
 *   - unsure → chalk-yellow ring
 *   - 3-pointers get a downtown-gold outer ring
 * The shot nearest the playhead (`activeShotId`) is emphasised: scaled up to
 * full opacity with a chalk halo, stacked above its neighbours; the rest sit
 * back slightly so the timeline reads current-first.
 *
 * Tap or drag anywhere on the track to seek; tap a marker to jump to that
 * shot (the parent seeks ~preRoll before it). Every marker is a ≥44pt touch
 * target inside the 48dp-tall track; the visuals stay small. The playhead
 * swells while scrubbing so the grab point stays visible under a thumb.
 *
 * Motion runs through reanimated and respects reduced-motion. The
 * PanResponder seek mechanics and time mapping are untouched — pure
 * view-based (no Skia) so hit testing, accessibility and layout stay plain
 * RN. Times are VIDEO seconds — the parent maps shot-clock times through
 * recordingStartSec before passing markers in.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { formatClock } from '@/components/ShotList';
import { color, motion, radius, touch } from '@/constants/tokens';
import type { ShotOutcome } from '@/core/types';

export interface TimelineMarker {
  /** Per-session shot number (ResolvedShot.id). */
  shotId: number;
  /** Video-time seconds, already mapped and clamped to [0, duration]. */
  timeSec: number;
  outcome: ShotOutcome;
  /** Estimated 3-pointer → downtown-gold ring. */
  is3: boolean;
}

/** Seconds moved per accessibility increment/decrement action. */
const A11Y_STEP_SEC = 5;
/** Touch column width per marker (>= 44pt tap-target requirement). */
const MARKER_TARGET_W = 44;

const OUTCOME_WORD: Record<ShotOutcome, string> = {
  make: 'make',
  miss: 'miss',
  unsure: 'unsure',
};

function MarkerGlyph({ outcome }: { outcome: ShotOutcome }) {
  if (outcome === 'make') return <View style={styles.makeDot} />;
  if (outcome === 'miss') return <View style={styles.missDot} />;
  return <View style={styles.unsureRing} />;
}

/**
 * One tappable shot dot. Emphasis (scale, opacity, halo) animates on
 * active-state changes; reduced motion snaps instead of easing.
 */
function TimelineMarkerDot({
  marker,
  active,
  reducedMotion,
  leftPx,
  onPress,
}: {
  marker: TimelineMarker;
  active: boolean;
  reducedMotion: boolean;
  leftPx: number;
  onPress?: (marker: TimelineMarker) => void;
}) {
  const emphasis = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    emphasis.value = withTiming(active ? 1 : 0, {
      duration: reducedMotion ? 0 : motion.quick,
    });
  }, [active, reducedMotion, emphasis]);

  const glyphStyle = useAnimatedStyle(() => ({
    opacity: 0.72 + emphasis.value * 0.28,
    transform: [{ scale: 1 + emphasis.value * 0.3 }],
  }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: emphasis.value,
    transform: [{ scale: 0.8 + emphasis.value * 0.2 }],
  }));

  return (
    <Pressable
      onPress={() => onPress?.(marker)}
      accessibilityRole="button"
      accessibilityLabel={
        `Shot ${marker.shotId}, ${OUTCOME_WORD[marker.outcome]}` +
        `${marker.is3 ? ', 3 pointer' : ''}, at ${formatClock(marker.timeSec)}`
      }
      accessibilityHint="Seeks playback to just before this shot"
      accessibilityState={{ selected: active }}
      style={[
        styles.markerHit,
        { left: leftPx - MARKER_TARGET_W / 2 },
        active && styles.markerHitActive,
      ]}
    >
      <Animated.View pointerEvents="none" style={[styles.activeHalo, haloStyle]} />
      <Animated.View
        style={[styles.glyphFrame, marker.is3 && styles.threeRing, glyphStyle]}
      >
        <MarkerGlyph outcome={marker.outcome} />
      </Animated.View>
    </Pressable>
  );
}

export function ShotTimeline({
  durationSec,
  currentSec,
  markers,
  activeShotId = null,
  onScrub,
  onScrubStart,
  onScrubEnd,
  onMarkerPress,
  style,
}: {
  /** Total video duration, seconds. <= 0 renders an inert track. */
  durationSec: number;
  /** Current playback position, seconds. */
  currentSec: number;
  markers: readonly TimelineMarker[];
  /** Shot nearest the playhead — its marker renders emphasised. */
  activeShotId?: number | null;
  /** Continuous seek callback while tapping/dragging the track. */
  onScrub: (sec: number) => void;
  /** Called when a drag/tap begins (parent may pause playback). */
  onScrubStart?: () => void;
  /** Called when the drag/tap ends (parent may resume playback). */
  onScrubEnd?: () => void;
  /** Tap on a shot marker (parent seeks ~preRoll before the shot). */
  onMarkerPress?: (marker: TimelineMarker) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [width, setWidth] = useState(0);
  const viewRef = useRef<View>(null);
  const reducedMotion = useReducedMotion();

  /** Scrub-in-progress emphasis for the playhead (visual only). */
  const scrubbing = useSharedValue(0);

  // Latest props for the once-created PanResponder.
  const stateRef = useRef({
    width: 0,
    durationSec: 0,
    currentSec: 0,
    reducedMotion,
    onScrub,
    onScrubStart,
    onScrubEnd,
  });
  stateRef.current = {
    width,
    durationSec,
    currentSec,
    reducedMotion,
    onScrub,
    onScrubStart,
    onScrubEnd,
  };
  /** Track's window x — resolved on grant so pageX maps to a fraction. */
  const originXRef = useRef(0);

  const seekFromPageX = useCallback((pageX: number) => {
    const { width: w, durationSec: dur, onScrub: scrub } = stateRef.current;
    if (w <= 0 || dur <= 0) return;
    const frac = Math.min(1, Math.max(0, (pageX - originXRef.current) / w));
    scrub(frac * dur);
  }, []);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => stateRef.current.durationSec > 0,
      // Also claim moves so a drag that STARTED on a marker still scrubs.
      onMoveShouldSetPanResponder: () => stateRef.current.durationSec > 0,
      onPanResponderGrant: (evt) => {
        // Fast estimate from the touch itself, then refine asynchronously —
        // locationX is unreliable when the responder was stolen mid-gesture.
        originXRef.current = evt.nativeEvent.pageX - evt.nativeEvent.locationX;
        viewRef.current?.measureInWindow((x) => {
          if (Number.isFinite(x)) originXRef.current = x;
        });
        scrubbing.value = withTiming(1, {
          duration: stateRef.current.reducedMotion ? 0 : motion.instant,
        });
        stateRef.current.onScrubStart?.();
        seekFromPageX(evt.nativeEvent.pageX);
      },
      onPanResponderMove: (evt) => seekFromPageX(evt.nativeEvent.pageX),
      onPanResponderRelease: () => {
        scrubbing.value = withTiming(0, {
          duration: stateRef.current.reducedMotion ? 0 : motion.quick,
        });
        stateRef.current.onScrubEnd?.();
      },
      onPanResponderTerminate: () => {
        scrubbing.value = withTiming(0, {
          duration: stateRef.current.reducedMotion ? 0 : motion.quick,
        });
        stateRef.current.onScrubEnd?.();
      },
    }),
  ).current;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const onA11yAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const { durationSec: dur, currentSec: cur, onScrub: scrub } = stateRef.current;
      if (dur <= 0) return;
      const action = e.nativeEvent.actionName;
      if (action === 'increment') scrub(Math.min(dur, cur + A11Y_STEP_SEC));
      else if (action === 'decrement') scrub(Math.max(0, cur - A11Y_STEP_SEC));
    },
    [],
  );

  const playheadStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + scrubbing.value * 0.35 }],
  }));

  const frac =
    durationSec > 0 ? Math.min(1, Math.max(0, currentSec / durationSec)) : 0;
  const ready = width > 0 && durationSec > 0;

  return (
    <View
      ref={viewRef}
      onLayout={onLayout}
      style={[styles.container, style]}
      {...pan.panHandlers}
    >
      {/* Invisible adjustable layer for screen readers (markers stay focusable). */}
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
        accessibilityHint="Swipe up or down to seek"
        accessibilityValue={{
          min: 0,
          max: Math.max(0, Math.round(durationSec)),
          now: Math.max(0, Math.round(currentSec)),
          text: `${formatClock(currentSec)} of ${formatClock(durationSec)}`,
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onA11yAction}
        style={StyleSheet.absoluteFill}
      />

      <View pointerEvents="none" style={styles.track}>
        <View style={[styles.fill, { width: `${frac * 100}%` }]} />
      </View>

      {ready &&
        markers.map((m, i) => (
          <TimelineMarkerDot
            key={`${m.shotId}-${i}`}
            marker={m}
            active={m.shotId === activeShotId}
            reducedMotion={reducedMotion}
            leftPx={(m.timeSec / durationSec) * width}
            onPress={onMarkerPress}
          />
        ))}

      {ready && (
        <Animated.View
          pointerEvents="none"
          style={[styles.playhead, { left: frac * width - 7 }, playheadStyle]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: touch.minTarget,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  playhead: {
    position: 'absolute',
    top: touch.minTarget / 2 - 7,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: color.text,
    borderWidth: 2,
    borderColor: color.bg,
  },
  markerHit: {
    position: 'absolute',
    top: 0,
    width: MARKER_TARGET_W,
    height: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerHitActive: {
    zIndex: 2,
  },
  activeHalo: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: color.text,
  },
  glyphFrame: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  threeRing: {
    borderWidth: 1.5,
    borderColor: color.threePt,
  },
  makeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: color.make,
  },
  /** Donut, not a filled dot — shape keeps make/miss apart without color. */
  missDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 3,
    borderColor: color.miss,
  },
  unsureRing: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 2,
    borderColor: color.unsure,
  },
});
