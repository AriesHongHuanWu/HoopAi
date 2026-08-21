/**
 * Session replay — broadcast-grade playback of the session recording.
 *
 * - 16:9 letterboxed VideoView (full-bleed with overlay chrome in landscape).
 * - Custom chrome: Ionicons transport (play/pause pill, prev/next shot) with
 *   spring press feedback, m:ss clock and the ShotTimeline scrubber with an
 *   outcome-coloured dot per shot at
 *   videoTime = shot.tResolved − recordingStartSec; the shot nearest the
 *   playhead renders emphasised.
 * - Highlights mode: a Full game / Highlights segmented control (sliding
 *   thumb, reduced-motion aware) that auto-plays only the planClips windows
 *   (shot-clock plan times mapped through recordingStartSec), with a
 *   "Clip i/n" chip and a "Replay highlights" overlay at the end.
 * - recordingStartSec == null (unrecorded / pre-v2 sessions) hides all
 *   time-mapped features gracefully; the plain player still works.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEvent, useEventListener } from 'expo';
import { useLocalSearchParams } from 'expo-router';
import {
  useVideoPlayer,
  VideoView,
  type SourceLoadEventPayload,
  type TimeUpdateEventPayload,
} from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandMark } from '@/components/BrandMark';
import {
  BackPill,
  formatClock,
  formatSessionDate,
  useSessionRecord,
} from '@/components/ShotList';
import { Chip, ErrorCard, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { ShotInfoStrip } from '@/components/video/ShotInfoStrip';
import { ShotTimeline, type TimelineMarker } from '@/components/video/ShotTimeline';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import { planClips } from '@/core/clipPlanner';
import { clamp } from '@/core/geometry';
import type { ResolvedShot } from '@/core/types';
import type { SessionRow } from '@/data/db';
import { useSettings } from '@/state/settingsStore';
import { haptic } from '@/utils/haptics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** VisionCamera hands back bare paths; expo-video wants a proper URI. */
function toFileUri(path: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return path;
  return `file://${path}`;
}

/** A highlights window in VIDEO time (plan times mapped through the offset). */
interface ClipWindow {
  shotId: number;
  startSec: number;
  endSec: number;
}

/** Seek epsilon so prev/next don't re-target the shot we just jumped to. */
const SEEK_EPS_SEC = 0.5;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// ---------------------------------------------------------------------------
// Transport — Ionicons glyphs on spring-pressed pills
// ---------------------------------------------------------------------------

function TransportButton({
  label,
  hint,
  onPress,
  disabled = false,
  primary = false,
  icon,
  iconSize = 20,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconSize?: number;
}) {
  const reducedMotion = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  // Press micro-interaction: a quick spring scale-down, applied directly on
  // the Pressable so call-site row layout is untouched.
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        setPressed(true);
        if (!reducedMotion) {
          scale.value = withSpring(0.92, { damping: 20, stiffness: 400 });
        }
      }}
      onPressOut={() => {
        setPressed(false);
        if (!reducedMotion) {
          scale.value = withSpring(1, { damping: 16, stiffness: 300 });
        }
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      style={[
        styles.transportBtn,
        primary && styles.transportBtnPrimary,
        pressed &&
          !disabled &&
          (primary
            ? { backgroundColor: color.accentPressed }
            : { backgroundColor: color.surfaceRaised }),
        disabled && { opacity: 0.35 },
        animStyle,
      ]}
    >
      <Ionicons
        name={icon}
        size={iconSize}
        color={primary ? color.onAccent : color.text}
        // The play triangle is optically left-heavy; nudge it to centre.
        style={icon === 'play' ? { marginLeft: 3 } : undefined}
      />
    </AnimatedPressable>
  );
}

// ---------------------------------------------------------------------------
// Full game / Highlights segmented control (styling only — the parent still
// owns the exact same toggle logic)
// ---------------------------------------------------------------------------

const SEGMENT_W = 116;
const SEGMENT_PAD = 2;

function HighlightsSegmented({
  highlightsOn,
  onSelect,
  highlightsDisabled,
}: {
  highlightsOn: boolean;
  onSelect: (mode: 'full' | 'highlights') => void;
  highlightsDisabled: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const offset = useSharedValue(highlightsOn ? 1 : 0);
  useEffect(() => {
    offset.value = withTiming(highlightsOn ? 1 : 0, {
      duration: reducedMotion ? 0 : motion.quick,
    });
  }, [highlightsOn, reducedMotion, offset]);
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value * SEGMENT_W }],
  }));

  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      <Animated.View pointerEvents="none" style={[styles.segThumb, thumbStyle]} />
      <Pressable
        onPress={() => onSelect('full')}
        accessibilityRole="radio"
        accessibilityLabel="Full game"
        accessibilityHint="Plays the whole recording"
        accessibilityState={{ checked: !highlightsOn }}
        style={({ pressed }) => [styles.segment, pressed && { opacity: 0.7 }]}
      >
        <Text style={[styles.segLabel, !highlightsOn && styles.segLabelActive]}>
          Full game
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onSelect('highlights')}
        disabled={highlightsDisabled}
        accessibilityRole="radio"
        accessibilityLabel="Highlights"
        accessibilityHint="Plays only the moments around your shots"
        accessibilityState={{ checked: highlightsOn, disabled: highlightsDisabled }}
        style={({ pressed }) => [
          styles.segment,
          highlightsDisabled && { opacity: 0.35 },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Ionicons
          name="sparkles"
          size={12}
          color={highlightsOn ? color.accent : color.textFaint}
        />
        <Text style={[styles.segLabel, highlightsOn && styles.segLabelHot]}>
          Highlights
        </Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export default function VideoReplayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const parsed = typeof id === 'string' ? Number(id) : Number.NaN;
  const sessionId = Number.isInteger(parsed) ? parsed : null;
  const record = useSessionRecord(sessionId);
  const session = record.session;

  if (!record.loaded) {
    return (
      <Screen>
        <Row style={{ marginBottom: space.lg }}>
          <BackPill />
        </Row>
        <Eyebrow>Replay</Eyebrow>
        <Text style={styles.dim}>Loading replay…</Text>
      </Screen>
    );
  }

  if (session == null || session.videoPath == null || session.videoPath.length === 0) {
    return (
      <Screen>
        <Row style={{ marginBottom: space.lg }}>
          <BackPill />
        </Row>
        <Eyebrow>Replay</Eyebrow>
        <ErrorCard
          title={session == null ? 'Session not found' : 'No recording for this session'}
          body={
            session == null
              ? 'This session may have been deleted. Head back to your history.'
              : 'This session was saved without video. Turn on video recording in settings to capture your next one.'
          }
        />
      </Screen>
    );
  }

  return (
    <ReplayPlayer
      session={session}
      videoPath={session.videoPath}
      shots={record.shots}
    />
  );
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

function ReplayPlayer({
  session,
  videoPath,
  shots,
}: {
  session: SessionRow;
  videoPath: string;
  shots: readonly ResolvedShot[];
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = width > height;

  const preRollSec = useSettings((s) => s.clipPreRollSec);
  const postRollSec = useSettings((s) => s.clipPostRollSec);

  const source = useMemo(() => ({ uri: toFileUri(videoPath) }), [videoPath]);
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.25;
  });

  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [highlightsOn, setHighlightsOn] = useState(false);
  const [highlightsDone, setHighlightsDone] = useState(false);
  const [clipIndex, setClipIndex] = useState(0);

  const recordingStartSec = session.recordingStartSec;

  // Shot markers in video time. Empty when the offset is unknown (session
  // wasn't recorded through the v2 pipeline) — time-mapped chrome hides.
  const markers = useMemo<TimelineMarker[]>(() => {
    if (recordingStartSec == null || durationSec <= 0) return [];
    return shots.map((s) => ({
      shotId: s.id,
      timeSec: clamp(s.tResolved - recordingStartSec, 0, durationSec),
      outcome: s.outcome,
      is3: s.shotValue === 3,
    }));
  }, [shots, recordingStartSec, durationSec]);

  // Highlights windows: plan in shot-clock time, then shift into video time.
  const clips = useMemo<ClipWindow[]>(() => {
    if (recordingStartSec == null || durationSec <= 0 || shots.length === 0) {
      return [];
    }
    const keep =
      session.keepMode === 'all' || session.keepMode === 'decided'
        ? session.keepMode
        : 'makes';
    const plans = planClips(shots, {
      keep,
      preRollSec,
      postRollSec,
      sessionDurationSec: recordingStartSec + durationSec,
    });
    return plans
      .map((p) => ({
        shotId: p.shotId,
        startSec: clamp(p.startSec - recordingStartSec, 0, durationSec),
        endSec: clamp(p.endSec - recordingStartSec, 0, durationSec),
      }))
      .filter((w) => w.endSec - w.startSec > 0.2);
  }, [shots, session.keepMode, recordingStartSec, durationSec, preRollSec, postRollSec]);

  // Latest values for the stable timeUpdate listener.
  const runtimeRef = useRef({
    highlightsOn,
    clips,
    clipIndex,
    durationSec,
  });
  runtimeRef.current = { highlightsOn, clips, clipIndex, durationSec };

  const handleSourceLoad = useCallback((payload: SourceLoadEventPayload) => {
    if (payload.duration > 0) setDurationSec(payload.duration);
  }, []);
  useEventListener(player, 'sourceLoad', handleSourceLoad);

  const handleTimeUpdate = useCallback(
    (payload: TimeUpdateEventPayload) => {
      const t = payload.currentTime;
      setCurrentSec(t);
      const rt = runtimeRef.current;
      if (rt.durationSec <= 0 && player.duration > 0) {
        setDurationSec(player.duration);
      }
      if (!rt.highlightsOn || rt.clips.length === 0) return;
      // First window we haven't finished yet; none left → highlights done.
      const i = rt.clips.findIndex((w) => t < w.endSec - 0.05);
      if (i === -1) {
        player.pause();
        setHighlightsDone(true);
        return;
      }
      // Between windows (or before the first): jump to the window start.
      if (t < rt.clips[i].startSec - 0.25) {
        player.currentTime = rt.clips[i].startSec;
        setCurrentSec(rt.clips[i].startSec);
      }
      if (i !== rt.clipIndex) setClipIndex(i);
    },
    [player],
  );
  useEventListener(player, 'timeUpdate', handleTimeUpdate);

  // ---- Seeking -------------------------------------------------------------

  const seekTo = useCallback(
    (sec: number) => {
      const dur = runtimeRef.current.durationSec;
      const t = dur > 0 ? clamp(sec, 0, dur) : Math.max(0, sec);
      player.currentTime = t;
      setCurrentSec(t);
      setHighlightsDone(false);
    },
    [player],
  );

  const wasPlayingRef = useRef(false);
  const onScrubStart = useCallback(() => {
    wasPlayingRef.current = player.playing;
    player.pause();
  }, [player]);
  const onScrubEnd = useCallback(() => {
    if (wasPlayingRef.current) player.play();
  }, [player]);

  const handleMarkerPress = useCallback(
    (m: TimelineMarker) => {
      haptic.selection();
      seekTo(m.timeSec - preRollSec);
    },
    [seekTo, preRollSec],
  );

  // Prev/next shot: each marker's seek target sits preRoll before the shot.
  const markerTargets = useMemo(
    () => markers.map((m) => Math.max(0, m.timeSec - preRollSec)),
    [markers, preRollSec],
  );
  let prevTarget: number | null = null;
  let nextTarget: number | null = null;
  for (const t of markerTargets) {
    if (t < currentSec - SEEK_EPS_SEC) prevTarget = t;
    if (nextTarget == null && t > currentSec + SEEK_EPS_SEC) nextTarget = t;
  }

  const goPrev = () => {
    haptic.selection();
    seekTo(prevTarget ?? 0);
  };
  const goNext = () => {
    if (nextTarget == null) return;
    haptic.selection();
    seekTo(nextTarget);
  };

  // ---- Transport / highlights ----------------------------------------------

  const togglePlay = () => {
    haptic.selection();
    if (player.playing) player.pause();
    else player.play();
  };

  const startHighlights = useCallback(() => {
    const first = runtimeRef.current.clips[0];
    if (first == null) return;
    setHighlightsOn(true);
    setHighlightsDone(false);
    setClipIndex(0);
    player.currentTime = first.startSec;
    setCurrentSec(first.startSec);
    player.play();
  }, [player]);

  const toggleHighlights = () => {
    haptic.selection();
    if (highlightsOn) {
      setHighlightsOn(false);
      setHighlightsDone(false);
    } else {
      startHighlights();
    }
  };

  /** Segmented control adapter — same toggle logic, no-op on reselect. */
  const selectMode = (mode: 'full' | 'highlights') => {
    const wantsHighlights = mode === 'highlights';
    if (wantsHighlights === highlightsOn) return;
    toggleHighlights();
  };

  // Nearest shot to the playhead for the info strip.
  const currentShot = useMemo<ResolvedShot | null>(() => {
    if (markers.length === 0) return null;
    let bestId = markers[0].shotId;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const m of markers) {
      const d = Math.abs(m.timeSec - currentSec);
      if (d < bestDist) {
        bestDist = d;
        bestId = m.shotId;
      }
    }
    return shots.find((s) => s.id === bestId) ?? null;
  }, [markers, currentSec, shots]);

  // ---- Shared chrome pieces --------------------------------------------------

  const hasMarkers = markers.length > 0;

  const timeline = (
    <ShotTimeline
      durationSec={durationSec}
      currentSec={currentSec}
      markers={markers}
      activeShotId={currentShot?.id ?? null}
      onScrub={seekTo}
      onScrubStart={onScrubStart}
      onScrubEnd={onScrubEnd}
      onMarkerPress={handleMarkerPress}
    />
  );

  const transport = (
    <Row gap={space.md}>
      <TransportButton
        label="Previous shot"
        hint="Seeks to just before the previous shot"
        onPress={goPrev}
        disabled={!hasMarkers}
        icon="play-skip-back"
      />
      <TransportButton
        label={isPlaying ? 'Pause' : 'Play'}
        onPress={togglePlay}
        primary
        icon={isPlaying ? 'pause' : 'play'}
        iconSize={26}
      />
      <TransportButton
        label="Next shot"
        hint="Seeks to just before the next shot"
        onPress={goNext}
        disabled={!hasMarkers || nextTarget == null}
        icon="play-skip-forward"
      />
    </Row>
  );

  const clock = (
    <Text style={styles.clock} accessibilityLabel="Playback time">
      {formatClock(currentSec)}
      <Text style={styles.clockTotal}> / {formatClock(durationSec)}</Text>
    </Text>
  );

  const highlightsControl = hasMarkers ? (
    <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
      <HighlightsSegmented
        highlightsOn={highlightsOn}
        onSelect={selectMode}
        highlightsDisabled={clips.length === 0}
      />
      {highlightsOn && clips.length > 0 && (
        <Chip
          label={`Clip ${Math.min(clipIndex + 1, clips.length)}/${clips.length}`}
          tone="accent"
        />
      )}
    </Row>
  ) : null;

  const videoOverlays = (
    <>
      {status === 'error' && (
        <View style={styles.videoOverlay} pointerEvents="none">
          <Text style={styles.overlayText}>Couldn't play this recording</Text>
        </View>
      )}
      {highlightsDone && (
        <View style={styles.videoOverlay}>
          <PillButton label="Replay highlights" icon="refresh" onPress={startHighlights} />
        </View>
      )}
    </>
  );

  // Brand watermark — replays get screen-recorded and shared, so playback
  // quietly carries the mark. Only while PLAYING: paused or scrubbing
  // (scrubbing pauses the player) hides it so it never blocks inspecting a
  // frame. Decorative only.
  const showWatermark = isPlaying && status !== 'error';

  // ---- Landscape: full-bleed video, glass chrome overlay ---------------------

  if (isLandscape) {
    return (
      <View style={styles.root}>
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="contain"
          style={StyleSheet.absoluteFill}
        />
        {videoOverlays}
        {/* Top-right, safe-area aware — clear of the back pill (top-left)
            and the glass transport panel (bottom). */}
        {showWatermark && (
          <BrandMark
            style={[
              styles.watermark,
              { top: insets.top + space.sm, right: insets.right + space.lg },
            ]}
          />
        )}
        <View
          style={{
            position: 'absolute',
            top: insets.top + space.sm,
            left: insets.left + space.lg,
          }}
        >
          <View style={styles.backGlass}>
            <BackPill />
          </View>
        </View>
        <View
          style={[
            styles.glassPanel,
            {
              left: insets.left + space.lg,
              right: insets.right + space.lg,
              bottom: insets.bottom + space.md,
            },
          ]}
        >
          {timeline}
          <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }} gap={space.md}>
            {transport}
            {highlightsControl}
            {clock}
          </Row>
        </View>
      </View>
    );
  }

  // ---- Portrait: letterboxed video, chrome below ------------------------------

  return (
    <View style={styles.root}>
      <View
        style={{
          paddingTop: insets.top + space.sm,
          paddingHorizontal: space.lg,
          paddingBottom: space.md,
        }}
      >
        <Row style={{ marginBottom: space.md }}>
          <BackPill />
        </Row>
        <Eyebrow>Session replay</Eyebrow>
        <Text style={styles.title}>{formatSessionDate(session.startedAt)}</Text>
      </View>

      <View style={styles.videoBox}>
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="contain"
          style={StyleSheet.absoluteFill}
        />
        {videoOverlays}
        {showWatermark && (
          <BrandMark
            style={[styles.watermark, { top: space.sm, right: space.sm + insets.right }]}
          />
        )}
      </View>

      <View style={styles.chrome}>
        {timeline}
        {recordingStartSec == null && (
          <Row gap={space.xs}>
            <Ionicons
              name="information-circle-outline"
              size={14}
              color={color.textFaint}
            />
            <Text style={styles.markerNote}>
              Shot markers aren't available for this recording.
            </Text>
          </Row>
        )}
        <Row style={{ justifyContent: 'space-between' }}>
          {transport}
          {clock}
        </Row>
        {highlightsControl}
        <ShotInfoStrip shot={currentShot} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  heading: {
    ...type.heading,
    color: color.text,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  videoBox: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: color.bg,
  },
  /** Corner brand watermark; each layout supplies its own top/right offsets. */
  watermark: {
    position: 'absolute',
  },
  videoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.hudGlass,
  },
  overlayText: {
    ...type.bodyMedium,
    color: color.text,
  },
  chrome: {
    flex: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
    gap: space.md,
  },
  markerNote: {
    ...type.caption,
    color: color.textFaint,
  },
  clock: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  clockTotal: {
    color: color.textFaint,
  },
  transportBtn: {
    width: touch.minTarget,
    height: touch.minTarget,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transportBtnPrimary: {
    width: 76,
    borderWidth: 0,
    backgroundColor: color.accent,
  },
  segmented: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: SEGMENT_PAD,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  segThumb: {
    position: 'absolute',
    top: SEGMENT_PAD,
    bottom: SEGMENT_PAD,
    left: SEGMENT_PAD,
    width: SEGMENT_W,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
  },
  segment: {
    width: SEGMENT_W,
    minHeight: touch.minTarget - SEGMENT_PAD * 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  segLabel: {
    ...type.caption,
    color: color.textDim,
  },
  segLabelActive: {
    color: color.text,
  },
  segLabelHot: {
    color: color.accent,
  },
  backGlass: {
    backgroundColor: color.hudGlassDeep,
    borderRadius: radius.pill,
  },
  glassPanel: {
    position: 'absolute',
    backgroundColor: color.hudGlassDeep,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.sm,
  },
});
