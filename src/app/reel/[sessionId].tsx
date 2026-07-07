/**
 * Highlight reel — every session's makes, back-to-back, one tap.
 *
 * There are no per-shot clip FILES on disk (shots.clipPath is never written);
 * a session has ONE master recording plus planClips time windows. So the reel
 * is sequential seek-and-play over that MP4: seek to each make window's start,
 * play to its end, jump to the next — the same expo-video window-skipping
 * mechanic as the replay player's highlights mode (src/app/video/[id].tsx),
 * but hands-free: playback starts on load and rolls through every window.
 *
 * Chrome: a "Make i of n" counter pill, an outcome-tinted segmented progress
 * rail (the live segment animates its fill; reduced-motion snaps), a brief
 * broadcast-style outcome flash as each new clip lands, and tap-to-pause on
 * the video. When the last window finishes the reel ends on the branded
 * ShareCard stat frame (src/components/ShareCard.tsx) given a hero
 * treatment — warm glow, staged entrance — with the existing
 * shareSessionCard flow wired to the primary share CTA; the reel's whole
 * point is leaving the gym with something Instagram-ready.
 *
 * Graceful exits (EmptyState): session missing, no recording, pre-v2
 * recordings without a recordingStartSec offset, and sessions with no makes.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEvent, useEventListener } from 'expo';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import {
  useVideoPlayer,
  VideoView,
  type SourceLoadEventPayload,
  type TimeUpdateEventPayload,
} from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  sessionCardData,
  ShareCard,
  shareSessionCard,
} from '@/components/ShareCard';
import {
  BackPill,
  formatSessionDate,
  useSessionRecord,
} from '@/components/ShotList';
import { Chip, EmptyState, ErrorCard, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, font, motion, radius, space, type } from '@/constants/tokens';
import { planClips } from '@/core/clipPlanner';
import { clamp } from '@/core/geometry';
import type { ResolvedShot, SessionStats, ShotOutcome } from '@/core/types';
import type { SessionRow } from '@/data/db';
import { useSettings } from '@/state/settingsStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** VisionCamera hands back bare paths; expo-video wants a proper URI. */
function toFileUri(path: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return path;
  return `file://${path}`;
}

/** A reel window in VIDEO time (plan times mapped through the offset). */
interface ReelWindow {
  shotId: number;
  outcome: ShotOutcome;
  startSec: number;
  endSec: number;
}

function outcomeTint(outcome: ShotOutcome): string {
  if (outcome === 'make') return color.make;
  if (outcome === 'miss') return color.miss;
  return color.unsure;
}

function outcomeTintBg(outcome: ShotOutcome): string {
  if (outcome === 'make') return color.makeTint;
  if (outcome === 'miss') return color.missTint;
  // Matches the ui.tsx Chip "unsure" tone tint.
  return 'rgba(232, 184, 79, 0.14)';
}

const OUTCOME_ICON: Record<ShotOutcome, React.ComponentProps<typeof Ionicons>['name']> = {
  make: 'checkmark-circle',
  miss: 'close-circle',
  unsure: 'help-circle',
};

const OUTCOME_FLASH_WORD: Record<ShotOutcome, string> = {
  make: 'MAKE',
  miss: 'MISS',
  unsure: 'SHOT',
};

/** How long the between-clips outcome flash stays on screen (ms). */
const FLASH_HOLD_MS = 900;

// ---------------------------------------------------------------------------
// Progress rail — one outcome-tinted segment per window; the live segment
// animates its fill and sits a touch taller than its neighbours
// ---------------------------------------------------------------------------

function RailSegment({
  frac,
  tint,
  state,
  reducedMotion,
}: {
  frac: number;
  tint: string;
  state: 'done' | 'active' | 'upcoming';
  reducedMotion: boolean;
}) {
  const fill = useSharedValue(frac);
  useEffect(() => {
    fill.value = reducedMotion
      ? frac
      : withTiming(frac, { duration: motion.standard, easing: Easing.linear });
  }, [frac, reducedMotion, fill]);
  const fillStyle = useAnimatedStyle(() => ({
    width: `${fill.value * 100}%`,
  }));
  return (
    <View style={[styles.progressTrack, state === 'active' && styles.progressTrackActive]}>
      <Animated.View
        style={[
          styles.progressFill,
          { backgroundColor: tint },
          state === 'done' && styles.progressFillDone,
          fillStyle,
        ]}
      />
    </View>
  );
}

function ReelProgress({
  windows,
  index,
  currentSec,
  done,
}: {
  windows: readonly ReelWindow[];
  index: number;
  currentSec: number;
  done: boolean;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <View
      style={styles.progressRow}
      accessible
      accessibilityLabel={`Reel progress: clip ${Math.min(index + 1, windows.length)} of ${windows.length}`}
    >
      {windows.map((w, i) => {
        const frac = done || i < index
          ? 1
          : i > index
            ? 0
            : clamp((currentSec - w.startSec) / Math.max(0.1, w.endSec - w.startSec), 0, 1);
        const state: 'done' | 'active' | 'upcoming' =
          done || i < index ? 'done' : i === index ? 'active' : 'upcoming';
        return (
          <RailSegment
            key={`${w.shotId}-${i}`}
            frac={frac}
            tint={outcomeTint(w.outcome)}
            state={state}
            reducedMotion={reducedMotion}
          />
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Outcome flash — a broadcast bug that lands as each new clip starts
// ---------------------------------------------------------------------------

function OutcomeFlash({
  outcome,
  reducedMotion,
}: {
  outcome: ShotOutcome;
  reducedMotion: boolean;
}) {
  const tint = outcomeTint(outcome);
  return (
    <Animated.View
      pointerEvents="none"
      entering={reducedMotion ? undefined : ZoomIn.duration(motion.quick)}
      exiting={reducedMotion ? undefined : FadeOut.duration(motion.quick)}
      style={styles.flashWrap}
    >
      <View style={[styles.flashPill, { borderColor: tint }]}>
        <Ionicons name={OUTCOME_ICON[outcome]} size={18} color={tint} />
        <Text style={[styles.flashWord, { color: tint }]}>
          {OUTCOME_FLASH_WORD[outcome]}
        </Text>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// End frame — the branded stat card as the reel's closing shot, hero-staged
// ---------------------------------------------------------------------------

function ReelEndFrame({
  session,
  shots,
  stats,
  onReplay,
}: {
  session: SessionRow;
  shots: readonly ResolvedShot[];
  stats: SessionStats;
  onReplay: () => void;
}) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const [sharing, setSharing] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);

  const label =
    session.label.trim() !== '' ? session.label.trim() : 'Shooting session';
  const cardData = useMemo(
    () => sessionCardData({ stats, shots, label, dateMs: session.startedAt }),
    [stats, shots, label, session.startedAt],
  );
  const cardW = Math.min(width - space.lg * 2, 280);

  // Staged entrance: title → hero card → CTAs. Reduced motion renders still.
  const enter = (delayMs: number) =>
    reducedMotion ? undefined : FadeInDown.duration(motion.standard).delay(delayMs);
  const cardEnter = reducedMotion
    ? undefined
    : ZoomIn.duration(motion.celebrate).delay(120);

  // Share the same story card the summary/history flows produce
  // (shareSessionCard never throws; a failure just shows a quiet chip).
  const onShare = () => {
    if (sharing) return;
    void Haptics.selectionAsync();
    setSharing(true);
    setShareFailed(false);
    void shareSessionCard({
      stats,
      shots,
      label,
      dateMs: session.startedAt,
    }).then((ok) => {
      setSharing(false);
      if (!ok) setShareFailed(true);
    });
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.endFrame}
      showsVerticalScrollIndicator={false}
    >
      <Animated.View entering={enter(0)} style={{ alignItems: 'center' }}>
        <Text style={styles.endTitle}>That&apos;s the reel.</Text>
        <Text style={styles.endMeta}>
          {stats.makes}/{stats.attempts} makes · best run {stats.bestStreak}
        </Text>
      </Animated.View>

      <Animated.View entering={cardEnter} style={styles.cardHero}>
        {/* Warm spotlight behind the card (leather at whisper opacity). */}
        <View pointerEvents="none" style={styles.cardGlowOuter} />
        <View pointerEvents="none" style={styles.cardGlowInner} />
        <ShareCard data={cardData} width={cardW} />
      </Animated.View>

      {shareFailed && (
        <View style={{ marginTop: space.md }}>
          <Chip label="Couldn't share — try again" tone="unsure" />
        </View>
      )}

      <Animated.View entering={enter(220)} style={styles.endActions}>
        <PillButton
          label={sharing ? 'Preparing…' : 'Share my card'}
          icon="share-social"
          onPress={onShare}
          disabled={sharing}
          style={{ alignSelf: 'stretch' }}
        />
        <PillButton
          variant="ghost"
          label="Replay reel"
          icon="refresh"
          onPress={() => {
            void Haptics.selectionAsync();
            onReplay();
          }}
          style={{ marginTop: space.md, alignSelf: 'center' }}
        />
      </Animated.View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export default function HighlightReelScreen() {
  const { sessionId: raw } = useLocalSearchParams<{ sessionId: string }>();
  const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
  const sessionId = Number.isInteger(parsed) ? parsed : null;
  const record = useSessionRecord(sessionId);
  const session = record.session;

  const header = (
    <Row style={{ marginBottom: space.lg }}>
      <BackPill />
    </Row>
  );

  if (!record.loaded) {
    return (
      <Screen>
        {header}
        <Eyebrow>Highlight reel</Eyebrow>
        <Text style={styles.dim}>Loading reel…</Text>
      </Screen>
    );
  }

  if (session == null) {
    return (
      <Screen>
        {header}
        <Eyebrow>Highlight reel</Eyebrow>
        <ErrorCard
          title="Session not found"
          body="This session may have been deleted. Head back to your history."
        />
      </Screen>
    );
  }

  if (session.videoPath == null || session.videoPath.length === 0) {
    return (
      <Screen>
        {header}
        <Eyebrow>Highlight reel</Eyebrow>
        <EmptyState
          title="No recording for this session"
          body="Your reel cuts itself from the session video. Turn on video recording in settings and your next session comes with one."
        />
      </Screen>
    );
  }

  if (session.recordingStartSec == null) {
    return (
      <Screen>
        {header}
        <Eyebrow>Highlight reel</Eyebrow>
        <EmptyState
          title="This recording can't be cut"
          body="Shot timing isn't available for this session's video, so the reel can't find your makes. Newly recorded sessions will work."
        />
      </Screen>
    );
  }

  const makeCount = record.shots.filter((s) => s.outcome === 'make').length;
  if (makeCount === 0) {
    return (
      <Screen>
        {header}
        <Eyebrow>Highlight reel</Eyebrow>
        <EmptyState
          title="No makes this session"
          body="The reel builds itself from your made shots. Get back out there — the next one cuts itself."
        />
      </Screen>
    );
  }

  return (
    <ReelPlayer
      session={session}
      videoPath={session.videoPath}
      recordingStartSec={session.recordingStartSec}
      shots={record.shots}
      stats={record.stats}
    />
  );
}

// ---------------------------------------------------------------------------
// Player — sequential seek-and-play over the make windows
// ---------------------------------------------------------------------------

function ReelPlayer({
  session,
  videoPath,
  recordingStartSec,
  shots,
  stats,
}: {
  session: SessionRow;
  videoPath: string;
  recordingStartSec: number;
  shots: readonly ResolvedShot[];
  stats: SessionStats;
}) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
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
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);

  // Make windows: plan in shot-clock time, then shift into video time —
  // identical mapping to the replay player's highlights mode.
  const windows = useMemo<ReelWindow[]>(() => {
    if (durationSec <= 0 || shots.length === 0) return [];
    const plans = planClips(shots, {
      keep: 'makes',
      preRollSec,
      postRollSec,
      sessionDurationSec: recordingStartSec + durationSec,
    });
    return plans
      .map((p) => ({
        shotId: p.shotId,
        outcome: p.outcome,
        startSec: clamp(p.startSec - recordingStartSec, 0, durationSec),
        endSec: clamp(p.endSec - recordingStartSec, 0, durationSec),
      }))
      .filter((w) => w.endSec - w.startSec > 0.2);
  }, [shots, recordingStartSec, durationSec, preRollSec, postRollSec]);

  // Latest values for the stable timeUpdate listener.
  const runtimeRef = useRef({ windows, index, done, durationSec });
  runtimeRef.current = { windows, index, done, durationSec };

  const handleSourceLoad = useCallback((payload: SourceLoadEventPayload) => {
    if (payload.duration > 0) setDurationSec(payload.duration);
  }, []);
  useEventListener(player, 'sourceLoad', handleSourceLoad);

  const startReel = useCallback(() => {
    const first = runtimeRef.current.windows[0];
    if (first == null) return;
    setDone(false);
    setIndex(0);
    player.currentTime = first.startSec;
    setCurrentSec(first.startSec);
    player.play();
  }, [player]);

  // One-tap promise: playback starts itself as soon as the windows exist.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || windows.length === 0) return;
    startedRef.current = true;
    startReel();
  }, [windows, startReel]);

  const handleTimeUpdate = useCallback(
    (payload: TimeUpdateEventPayload) => {
      const t = payload.currentTime;
      setCurrentSec(t);
      const rt = runtimeRef.current;
      if (rt.durationSec <= 0 && player.duration > 0) {
        setDurationSec(player.duration);
      }
      if (rt.done || rt.windows.length === 0) return;
      // First window we haven't finished yet; none left → the reel is over.
      const i = rt.windows.findIndex((w) => t < w.endSec - 0.05);
      if (i === -1) {
        player.pause();
        setDone(true);
        return;
      }
      // Between windows (or before the first): jump to the window start.
      if (t < rt.windows[i].startSec - 0.25) {
        player.currentTime = rt.windows[i].startSec;
        setCurrentSec(rt.windows[i].startSec);
      }
      if (i !== rt.index) setIndex(i);
    },
    [player],
  );
  useEventListener(player, 'timeUpdate', handleTimeUpdate);

  // Between-clips outcome flash: fires whenever a new window lands (visual
  // chrome only — playback and window math above are untouched).
  const [flash, setFlash] = useState<{ key: number; outcome: ShotOutcome } | null>(null);
  const prevIndexRef = useRef(0);
  useEffect(() => {
    if (index === prevIndexRef.current) return;
    prevIndexRef.current = index;
    const w = windows[index];
    if (w == null || done) return;
    setFlash({ key: index, outcome: w.outcome });
    const t = setTimeout(() => setFlash(null), FLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, [index, windows, done]);

  const togglePlay = () => {
    if (done) return;
    void Haptics.selectionAsync();
    if (player.playing) player.pause();
    else player.play();
  };

  const current = windows[Math.min(index, Math.max(0, windows.length - 1))];
  const counterOutcome: ShotOutcome = current?.outcome ?? 'make';
  const counterTint = outcomeTint(counterOutcome);

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
        <Eyebrow>Highlight reel</Eyebrow>
        <Text style={styles.title}>{formatSessionDate(session.startedAt)}</Text>
      </View>

      {done ? (
        <ReelEndFrame
          session={session}
          shots={shots}
          stats={stats}
          onReplay={startReel}
        />
      ) : (
        <>
          <Pressable
            onPress={togglePlay}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? 'Pause reel' : 'Resume reel'}
            accessibilityHint="Toggles reel playback"
            style={styles.videoBox}
          >
            <VideoView
              player={player}
              nativeControls={false}
              contentFit="contain"
              style={StyleSheet.absoluteFill}
            />
            {status === 'error' && (
              <View style={styles.videoOverlay} pointerEvents="none">
                <Text style={styles.overlayText}>Couldn&apos;t play this recording</Text>
              </View>
            )}
            {!isPlaying && status !== 'error' && windows.length > 0 && (
              <View style={styles.videoOverlay} pointerEvents="none">
                <View style={styles.pausePill}>
                  <Ionicons name="play" size={16} color={color.text} />
                  <Text style={styles.overlayText}>Paused — tap to resume</Text>
                </View>
              </View>
            )}
            {flash != null && status !== 'error' && (
              <OutcomeFlash
                key={flash.key}
                outcome={flash.outcome}
                reducedMotion={reducedMotion}
              />
            )}
          </Pressable>

          <View style={styles.chrome}>
            {windows.length === 0 ? (
              durationSec > 0 ? (
                <EmptyState
                  title="Couldn't cut this recording"
                  body="Your makes fall outside the recorded video, so there's nothing to reel."
                />
              ) : (
                <Row gap={space.sm}>
                  <ActivityIndicator size="small" color={color.accent} />
                  <Text style={styles.dim}>Cueing up your makes…</Text>
                </Row>
              )
            ) : (
              <>
                <ReelProgress
                  windows={windows}
                  index={index}
                  currentSec={currentSec}
                  done={done}
                />
                <Row style={{ justifyContent: 'space-between' }}>
                  <View
                    style={[
                      styles.counterPill,
                      { backgroundColor: outcomeTintBg(counterOutcome) },
                    ]}
                    accessible
                    accessibilityLabel={`Make ${Math.min(index + 1, windows.length)} of ${windows.length}`}
                  >
                    <Ionicons
                      name={OUTCOME_ICON[counterOutcome]}
                      size={14}
                      color={counterTint}
                    />
                    <Text style={[styles.counterLabel, { color: counterTint }]}>
                      Make {Math.min(index + 1, windows.length)} of {windows.length}
                    </Text>
                  </View>
                  <Text style={styles.countMeta}>
                    {stats.makes}/{stats.attempts} FG
                  </Text>
                </Row>
                <Text style={styles.footnote}>
                  Plays every make back-to-back, then your shareable stat card.
                </Text>
              </>
            )}
          </View>
        </>
      )}
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
  dim: {
    ...type.body,
    color: color.textDim,
  },
  videoBox: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: color.bg,
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
  pausePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.hudGlassDeep,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  flashWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flashPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.hudGlassDeep,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
  },
  flashWord: {
    fontFamily: font.display,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: 2,
  },
  chrome: {
    flex: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    gap: space.md,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  progressTrack: {
    flex: 1,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  progressTrackActive: {
    height: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
  },
  progressFillDone: {
    opacity: 0.55,
  },
  counterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  counterLabel: {
    ...type.caption,
    fontVariant: ['tabular-nums'],
  },
  countMeta: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  footnote: {
    ...type.caption,
    color: color.textFaint,
  },
  endFrame: {
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },
  endTitle: {
    ...type.title,
    color: color.text,
  },
  endMeta: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  cardHero: {
    marginTop: space.lg,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Leather spotlight rings behind the hero card (whisper opacity). */
  cardGlowOuter: {
    position: 'absolute',
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: 'rgba(240, 90, 36, 0.05)',
  },
  cardGlowInner: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: 'rgba(240, 90, 36, 0.09)',
  },
  endActions: {
    alignSelf: 'stretch',
    marginTop: space.xl,
  },
});
