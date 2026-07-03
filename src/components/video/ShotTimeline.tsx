/**
 * ShotTimeline — the replay scrubber (the signature of the video screen).
 *
 * A slim leather-orange progress track with a marker for every shot placed at
 * its video timestamp:
 *   - make   → swish-green dot
 *   - miss   → tiny brick-red X
 *   - unsure → chalk-yellow ring
 *   - 3-pointers get a downtown-gold outer ring
 *
 * Tap or drag anywhere on the track to seek; tap a marker to jump to that
 * shot (the parent seeks ~preRoll before it). Every marker is a ≥24dp touch
 * target inside the 48dp-tall track; the visuals stay small.
 *
 * Pure view-based (no Skia) so hit testing, accessibility and layout stay
 * plain RN. Times are VIDEO seconds — the parent maps shot-clock times
 * through recordingStartSec before passing markers in.
 */
import React, { useCallback, useRef, useState } from 'react';
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

import { formatClock } from '@/components/ShotList';
import { color, radius, touch } from '@/constants/tokens';
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
/** Touch column width per marker (>= 24dp requirement). */
const MARKER_TARGET_W = 32;

const OUTCOME_WORD: Record<ShotOutcome, string> = {
  make: 'make',
  miss: 'miss',
  unsure: 'unsure',
};

function MarkerGlyph({ outcome, is3 }: { outcome: ShotOutcome; is3: boolean }) {
  let core: React.ReactElement;
  if (outcome === 'make') {
    core = <View style={styles.makeDot} />;
  } else if (outcome === 'miss') {
    core = (
      <View style={styles.missBox}>
        <View style={[styles.missBar, { transform: [{ rotate: '45deg' }] }]} />
        <View style={[styles.missBar, { transform: [{ rotate: '-45deg' }] }]} />
      </View>
    );
  } else {
    core = <View style={styles.unsureRing} />;
  }
  return (
    <View style={[styles.glyphFrame, is3 && styles.threeRing]}>{core}</View>
  );
}

export function ShotTimeline({
  durationSec,
  currentSec,
  markers,
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

  // Latest props for the once-created PanResponder.
  const stateRef = useRef({
    width: 0,
    durationSec: 0,
    currentSec: 0,
    onScrub,
    onScrubStart,
    onScrubEnd,
  });
  stateRef.current = {
    width,
    durationSec,
    currentSec,
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
        stateRef.current.onScrubStart?.();
        seekFromPageX(evt.nativeEvent.pageX);
      },
      onPanResponderMove: (evt) => seekFromPageX(evt.nativeEvent.pageX),
      onPanResponderRelease: () => stateRef.current.onScrubEnd?.(),
      onPanResponderTerminate: () => stateRef.current.onScrubEnd?.(),
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
        markers.map((m, i) => {
          const cx = (m.timeSec / durationSec) * width;
          return (
            <Pressable
              key={`${m.shotId}-${i}`}
              onPress={() => onMarkerPress?.(m)}
              accessibilityRole="button"
              accessibilityLabel={
                `Shot ${m.shotId}, ${OUTCOME_WORD[m.outcome]}` +
                `${m.is3 ? ', 3 pointer' : ''}, at ${formatClock(m.timeSec)}`
              }
              accessibilityHint="Seeks playback to just before this shot"
              style={[styles.markerHit, { left: cx - MARKER_TARGET_W / 2 }]}
            >
              <MarkerGlyph outcome={m.outcome} is3={m.is3} />
            </Pressable>
          );
        })}

      {ready && (
        <View
          pointerEvents="none"
          style={[styles.playhead, { left: frac * width - 7 }]}
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
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: color.make,
  },
  missBox: {
    width: 11,
    height: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  missBar: {
    position: 'absolute',
    width: 2,
    height: 12,
    borderRadius: 1,
    backgroundColor: color.miss,
  },
  unsureRing: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 2,
    borderColor: color.unsure,
  },
});
