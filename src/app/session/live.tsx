/**
 * Live session — the flagship screen. Portrait or landscape, immersive,
 * keep-awake.
 *
 * Layers (bottom → top):
 *   camera feed (or demo court scene) → Skia trajectory overlay → aiming
 *   guidance (until rim lock) → shot flash → glass HUD chips → bottom bar.
 *
 * Orientation: the HUD relayouts via useWindowDimensions — portrait stacks the
 * stat strip full-width up top; landscape docks it (plus the mode banner) in a
 * compact top-left column so the rim stays unobstructed. Safe-area insets are
 * applied on all four edges for notch / Dynamic Island in both orientations.
 *
 * The shot engine drives everything; this screen only wires events into the
 * session store and renders store state. No per-frame React updates.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Camera } from 'react-native-vision-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppStateGuard } from '../../camera/useAppStateGuard';
import { useShotEngine, type ShotEngine } from '../../camera/useShotEngine';
import { playSound, useShotSounds } from '../../camera/useShotSounds';
import { useVoiceAnnouncements } from '../../camera/useVoiceAnnouncements';
import { HudChip } from '../../components/hud/HudChip';
import { ShotFlash } from '../../components/hud/ShotFlash';
import { DebugPanel } from '../../components/hud/DebugPanel';
import { StatStrip } from '../../components/hud/StatStrip';
import { TrajectoryOverlay } from '../../components/hud/TrajectoryOverlay';
import { ModeBanner } from '../../components/modes/ModeBanner';
import { ModeComplete } from '../../components/modes/ModeComplete';
import { Card, Chip, PillButton, Row, Screen } from '../../components/ui';
import { color, radius, space, type } from '../../constants/tokens';
import type { ResolvedShot } from '../../core/types';
import { useMode } from '../../state/modeStore';
import { useSession } from '../../state/sessionStore';
import { useSettings } from '../../state/settingsStore';

const DRIFT_BANNER_MS = 4000;
const PAUSED_CHIP_MS = 4000;
/** Width of the docked HUD column in landscape (compact, rim stays clear). */
const LANDSCAPE_HUD_WIDTH = 300;

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export default function LiveSessionScreen() {
  useKeepAwake();
  useShotSounds();
  useVoiceAnnouncements();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  const rimLocked = useSession((s) => s.rimLocked);
  const isRecording = useSession((s) => s.isRecording);

  const activeMode = useMode((s) => s.activeMode);
  const modeDone = activeMode?.done ?? false;
  const isTimedMode = activeMode?.modeId === 'timed';

  const [drift, setDrift] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [backgrounded, setBackgrounded] = useState(false);
  const [pausedChip, setPausedChip] = useState(false);

  const engineRef = useRef<ShotEngine | null>(null);
  const driftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Entering this screen directly (deep link, dev reload) still gets a
  // coherent session.
  useEffect(() => {
    if (useSession.getState().phase === 'idle') useSession.getState().beginSetup();
  }, []);

  const onShot = useCallback((shot: ResolvedShot) => {
    useSession.getState().addShot(shot);
    // Fold the same resolved shot into the active game mode (no-op when none).
    // Use the wall clock (seconds) so the timed-mode countdown shares one clock
    // with the tick loop below — shot.tResolved is camera-frame time, a
    // different origin that would desync the timer.
    useMode.getState().applyShot(shot, Date.now() / 1000);
    if (useSettings.getState().hapticsEnabled) {
      const feedback =
        shot.outcome === 'make'
          ? Haptics.NotificationFeedbackType.Success
          : shot.outcome === 'miss'
            ? Haptics.NotificationFeedbackType.Error
            : Haptics.NotificationFeedbackType.Warning;
      void Haptics.notificationAsync(feedback);
    }
  }, []);

  const onRimLocked = useCallback(() => {
    setDrift(false);
    const store = useSession.getState();
    if (store.rimLocked) return; // re-lock after drift — already live
    store.setRimLocked(true);
    if (useSettings.getState().soundsEnabled) playSound('rim_locked');

    const { recordVideo, keepMode } = useSettings.getState();
    void (async () => {
      // Stats-only sessions still go live; recording is additive.
      await store.goLive({ keepMode: recordVideo ? keepMode : 'none', nowMs: Date.now() });
      const engine = engineRef.current;
      if (recordVideo && engine?.activeMode === 'camera') {
        try {
          await engine.startRecording();
          // Engine-clock start so shot timestamps map onto the video timeline
          // (videoTime = shot.tResolved − recordingStartSec).
          useSession.getState().setRecording(true, null, engine.nowSec());
        } catch {
          // Recording failed (storage, codec) — session continues stats-only.
          useSession.getState().setRecording(false);
        }
      }
    })();
  }, []);

  const onRimDrift = useCallback(() => {
    setDrift(true);
    if (driftTimer.current) clearTimeout(driftTimer.current);
    driftTimer.current = setTimeout(() => setDrift(false), DRIFT_BANNER_MS);
  }, []);

  const engine = useShotEngine('auto', { onShot, onRimLocked, onRimDrift });
  const debugMode = useSettings((s) => s.debugMode);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);
  useEffect(() => () => {
    if (driftTimer.current) clearTimeout(driftTimer.current);
    if (pausedTimer.current) clearTimeout(pausedTimer.current);
  }, []);

  // App backgrounding (call, app switch, lock): stop any active recording
  // safely — the OS tears the camera down anyway — and freeze the mode-timer
  // tick loop. On return, show a brief "Session paused" chip so the gap in
  // tracking is explained. Everything else (rim lock, stats) survives as-is.
  const onBackground = useCallback(() => {
    setBackgrounded(true);
    if (useSession.getState().isRecording) {
      void engineRef.current
        ?.stopRecording()
        .then((path) => useSession.getState().setRecording(false, path))
        .catch(() => useSession.getState().setRecording(false));
    }
  }, []);
  const onForeground = useCallback(() => {
    setBackgrounded(false);
    if (useSession.getState().phase === 'live') {
      setPausedChip(true);
      if (pausedTimer.current) clearTimeout(pausedTimer.current);
      pausedTimer.current = setTimeout(() => setPausedChip(false), PAUSED_CHIP_MS);
    }
  }, []);
  useAppStateGuard({ onBackground, onForeground });

  // Timed-mode countdown. Arms + drains the clock on the same wall-clock source
  // as applyShot (see onShot). Only runs while the timed game is live and not
  // yet finished; tickMode is a no-op for every other mode. Paused while the
  // app is backgrounded so the clock can't expire mid-phone-call unseen.
  useEffect(() => {
    if (!isTimedMode || !rimLocked || modeDone || ending || backgrounded) return;
    const id = setInterval(() => {
      useMode.getState().tick(Date.now() / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [isTimedMode, rimLocked, modeDone, ending, backgrounded]);

  const endSession = useCallback(async () => {
    setEnding(true);
    let path: string | null = null;
    try {
      path = (await engineRef.current?.stopRecording()) ?? null;
    } catch {
      path = null;
    }
    // A recording stopped early (app was backgrounded) already stashed its
    // file path on the store — don't lose that video.
    path = path ?? useSession.getState().recordingPath;
    await useSession.getState().finish({ nowMs: Date.now(), videoPath: path });
    // The game ends with the session — clear it so it never leaks into the next
    // run (the hero quick-start also resets, but this covers the mode paths).
    useMode.getState().reset();
    router.replace('/session/summary');
  }, []);

  // Restart the just-finished mode for another run without leaving the session:
  // re-init the same mode (fresh clock/score) and keep shooting.
  const replayMode = useCallback(() => {
    const mode = useMode.getState().activeMode;
    if (mode == null) return;
    useMode.getState().selectMode(mode.modeId, mode.config ?? undefined);
  }, []);

  // ---------------------------------------------------------------------
  // Camera permission gate (camera mode only; demo mode needs nothing).
  // ---------------------------------------------------------------------
  const cam = engine.camera;
  if (cam != null && !cam.hasPermission) {
    return (
      <Screen style={styles.permissionScreen}>
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionBody}>
          The live view watches the rim to count makes and misses. Everything stays on this
          phone.
        </Text>
        <PillButton
          label="Allow camera access"
          onPress={() => void cam.requestPermission()}
          style={styles.permissionCta}
        />
        <PillButton label="Back to setup" variant="ghost" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <View style={styles.root}>
      {cam != null && cam.device != null ? (
        <Camera
          style={StyleSheet.absoluteFill}
          isActive={!ending}
          device={cam.device}
          outputs={cam.outputs}
        />
      ) : (
        <DemoCourt />
      )}

      <TrajectoryOverlay overlay={engine.overlay} />

      {debugMode && <DebugPanel debug={engine.debug} />}

      {!rimLocked && <AimingOverlay />}

      <ShotFlash />

      {/* Top HUD — full-width in portrait, a compact left-docked column in
          landscape so the hoop (usually center/right of frame) stays clear. */}
      <View
        style={[
          styles.topHud,
          {
            top: insets.top + space.md,
            left: insets.left + space.lg,
            right: isLandscape ? undefined : insets.right + space.lg,
            width: isLandscape
              ? Math.min(LANDSCAPE_HUD_WIDTH, width - insets.left - insets.right - space.lg * 2)
              : undefined,
          },
        ]}
        pointerEvents="none"
      >
        {rimLocked && <StatStrip compact={isLandscape} />}
        {rimLocked && activeMode != null && (
          <View style={styles.modeBanner}>
            <ModeBanner mode={activeMode} />
          </View>
        )}
        {engine.activeMode === 'demo' && (
          <View style={styles.topCenter}>
            <Chip label="DEMO MODE — scripted scene" tone="accent" />
          </View>
        )}
        {drift && (
          <View style={styles.topCenter}>
            <HudChip>
              <Text style={styles.driftText}>Camera moved — re-aiming…</Text>
            </HudChip>
          </View>
        )}
        {pausedChip && !drift && (
          <View style={styles.topCenter}>
            <HudChip>
              <Text
                style={styles.pausedText}
                accessibilityLiveRegion="polite"
                accessibilityLabel="Session paused while the app was in the background"
              >
                Session paused
              </Text>
            </HudChip>
          </View>
        )}
      </View>

      {/* Bottom bar — inset on all edges so the End button stays reachable on
          notched devices in either orientation. */}
      <View
        style={[
          styles.bottomBar,
          {
            left: insets.left + space.lg,
            right: insets.right + space.lg,
            paddingBottom: insets.bottom + (isLandscape ? space.md : space.lg),
          },
        ]}
      >
        {isRecording ? <RecIndicator /> : <View />}
        <PillButton
          label="End session"
          variant="ghost"
          onPress={() => setConfirmEnd(true)}
          style={styles.endButton}
        />
      </View>

      {/* Mode-complete celebration sheet */}
      {activeMode != null && modeDone && !confirmEnd && !ending && (
        <ModeComplete mode={activeMode} onReplay={replayMode} onExit={() => void endSession()} />
      )}

      {/* In-screen end confirmation */}
      {confirmEnd && (
        <View style={styles.confirmScrim} accessibilityViewIsModal>
          <Card style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>End this session?</Text>
            <Text style={styles.confirmBody}>
              {isRecording
                ? 'Your stats and video will be saved to the summary.'
                : 'Your stats will be saved to the summary.'}
            </Text>
            <Row style={styles.confirmActions} gap={space.md}>
              <PillButton
                label="Keep shooting"
                variant="ghost"
                onPress={() => setConfirmEnd(false)}
                disabled={ending}
                style={styles.confirmButton}
              />
              <PillButton
                label={ending ? 'Saving…' : 'End session'}
                onPress={() => void endSession()}
                disabled={ending}
                style={styles.confirmButton}
              />
            </Row>
          </Card>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Aiming guidance — shown until the rim locks.
// ---------------------------------------------------------------------------

function AimingOverlay() {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);
  const boxStyle = useAnimatedStyle(() => ({
    opacity: 0.45 + pulse.value * 0.55,
    transform: [{ scale: 1 + pulse.value * 0.04 }],
  }));

  return (
    <View style={styles.aiming} pointerEvents="none">
      <Animated.View style={[styles.rimPlaceholder, boxStyle]} />
      <Text style={styles.aimTitle}>Point the camera at the hoop</Text>
      <Text style={styles.aimSub}>Hold steady — the rim locks in automatically</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Demo scene — coal background with a subtle court line drawing. The mock
// detector still drives the same pipeline, so the overlay animates on top.
// ---------------------------------------------------------------------------

function DemoCourt() {
  const [size, setSize] = useState({ w: 0, h: 0 });

  const courtPath = useMemo(() => {
    const p = Skia.Path.Make();
    const { w, h } = size;
    if (w <= 0 || h <= 0) return p;
    const baseY = h * 0.8;
    // Baseline
    p.moveTo(0, baseY);
    p.lineTo(w, baseY);
    // The key
    const keyW = w * 0.44;
    const keyH = h * 0.26;
    const keyX = (w - keyW) / 2;
    p.addRect(Skia.XYWHRect(keyX, baseY - keyH, keyW, keyH));
    // Free-throw arc on top of the key — the shot-arc motif in the floor.
    p.addArc(Skia.XYWHRect(keyX, baseY - keyH - keyW / 2, keyW, keyW), 180, 180);
    return p;
  }, [size]);

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.demoRoot]}
      onLayout={(e) =>
        setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Path path={courtPath} style="stroke" strokeWidth={2} color={color.border} opacity={0.9} />
      </Canvas>
    </View>
  );
}

// ---------------------------------------------------------------------------
// REC indicator — red dot + elapsed time, only while recording.
// ---------------------------------------------------------------------------

function RecIndicator() {
  const startedAtMs = useSession((s) => s.startedAtMs);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const totalSec = startedAtMs != null ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)) : 0;
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');

  return (
    <HudChip style={styles.recChip}>
      <Row gap={space.sm}>
        <View style={styles.recDot} accessibilityLabel="Recording" />
        <Text style={styles.recText}>{`REC ${mm}:${ss}`}</Text>
      </Row>
    </HudChip>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
  },
  demoRoot: {
    backgroundColor: color.bg,
  },
  topHud: {
    position: 'absolute',
  },
  topCenter: {
    alignItems: 'center',
    marginTop: space.sm,
  },
  modeBanner: {
    marginTop: space.sm,
  },
  driftText: {
    ...type.bodyMedium,
    color: color.unsure,
  },
  pausedText: {
    ...type.bodyMedium,
    color: color.text,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  endButton: {
    backgroundColor: color.hudGlass,
  },
  recChip: {
    borderRadius: radius.pill,
  },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: color.miss,
  },
  recText: {
    ...type.caption,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  aiming: {
    ...absoluteFill,
    backgroundColor: color.hudGlass,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  rimPlaceholder: {
    width: 168,
    height: 96,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: color.accent,
    marginBottom: space.xl,
  },
  aimTitle: {
    ...type.title,
    color: color.text,
    textAlign: 'center',
  },
  aimSub: {
    ...type.body,
    color: color.textDim,
    textAlign: 'center',
    marginTop: space.sm,
  },
  confirmScrim: {
    ...absoluteFill,
    backgroundColor: color.hudGlass,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  confirmCard: {
    // Full-width in portrait; capped like a dialog in landscape (the scrim's
    // alignItems: 'center' keeps it centered when clamped).
    width: '100%',
    maxWidth: 480,
  },
  confirmTitle: {
    ...type.heading,
    color: color.text,
  },
  confirmBody: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  confirmActions: {
    marginTop: space.lg,
  },
  confirmButton: {
    flex: 1,
  },
  permissionScreen: {
    justifyContent: 'center',
  },
  permissionTitle: {
    ...type.title,
    color: color.text,
  },
  permissionBody: {
    ...type.body,
    color: color.textDim,
    marginTop: space.sm,
    marginBottom: space.xl,
  },
  permissionCta: {
    marginBottom: space.md,
  },
});
