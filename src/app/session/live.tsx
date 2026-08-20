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
import {
  Dimensions,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutRectangle,
} from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Camera, useCameraPermission } from 'react-native-vision-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppStateGuard } from '../../camera/useAppStateGuard';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { useShotEngine, type ShotEngine } from '../../camera/useShotEngine';
import { mapAnalysisToView, type Mapping } from '../../components/hud/overlayMapping';
import { CourtCalibrationOverlay } from '../../components/hud/CourtCalibrationOverlay';
import { useCourtCalibration } from '../../state/courtCalibrationStore';
import { playSound, useShotSounds } from '../../camera/useShotSounds';
import { useVoiceAnnouncements } from '../../camera/useVoiceAnnouncements';
import { CoachMarks, useCoachMarks, type CoachStep } from '../../components/coach/CoachMarks';
import { ghostAimRect } from '../../components/coach/liveTourRects';
import { FtSeedChip, type FtSeedFeedback } from '../../components/hud/FtSeedChip';
import { HintChip } from '../../components/hud/HintChip';
import { HudChip } from '../../components/hud/HudChip';
import {
  GHOST_RIM_ASPECT,
  GHOST_RIM_CENTER_Y_FRAC,
  GHOST_RIM_WIDTH_FRAC,
  GhostRim,
  PlacementGradeChip,
  usePlacementGrade,
} from '../../components/hud/PlacementGrade';
import { ShotFlash } from '../../components/hud/ShotFlash';
import { DebugPanel } from '../../components/hud/DebugPanel';
import { DetectionBoxes } from '../../components/hud/DetectionBoxes';
import { DetectionHealthPanel } from '../../components/hud/DetectionHealthPanel';
import { DrillOverlay } from '../../components/hud/DrillOverlay';
import { FirstBallRitual } from '../../components/hud/FirstBallRitual';
import { FormCueToast } from '../../components/hud/FormCueToast';
import { GoalChip } from '../../components/hud/GoalChip';
import { RimLockChecklist } from '../../components/hud/RimLockChecklist';
import { ShotToast } from '../../components/hud/ShotToast';
import { StatStrip } from '../../components/hud/StatStrip';
import { TrajectoryOverlay } from '../../components/hud/TrajectoryOverlay';
import { ModeBanner } from '../../components/modes/ModeBanner';
import { ModeComplete } from '../../components/modes/ModeComplete';
import { Card, Chip, PillButton, Row, Screen } from '../../components/ui';
import { color, motion, radius, space, type } from '../../constants/tokens';
import type { ResolvedShot } from '../../core/types';
import type { FtCaptureOutcome } from '../../pipeline/shotPipeline';
import { useMode } from '../../state/modeStore';
import { useSession } from '../../state/sessionStore';
import { useSettings } from '../../state/settingsStore';
import { haptic } from '@/utils/haptics';

const DRIFT_BANNER_MS = 4000;
const PAUSED_CHIP_MS = 4000;
/** Width of the docked HUD column in landscape (compact, rim stays clear). */
const LANDSCAPE_HUD_WIDTH = 300;
/**
 * Floor for the docked column so its internal chips/buttons never compress
 * below a usable width on a small landscape viewport (older phone rotated,
 * split-screen multitasking). Below this the column scrolls instead of
 * shrinking further.
 */
const LANDSCAPE_HUD_MIN_WIDTH = 220;

/**
 * Vertical clearance reserved above the action bar so the drill guidance chip
 * floats clear of the End / Re-aim buttons (their ~44pt touch target + gap).
 */
const BOTTOM_BAR_CLEARANCE = 56;

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

/**
 * Wrapped in its own {@link ErrorBoundary} so a crash mid-session (camera
 * frame processor, Skia overlay, mode logic) shows a local recovery screen
 * and lets the player restart the live screen fresh, instead of unwinding the
 * whole app tree and losing the root navigation/splash state too — the root
 * boundary in app/_layout.tsx still catches anything that escapes this one.
 */
export default function LiveSessionScreenBoundary() {
  return (
    <ErrorBoundary>
      <LiveSessionScreen />
    </ErrorBoundary>
  );
}

function LiveSessionScreen() {
  useKeepAwake();
  useShotSounds();
  useVoiceAnnouncements();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const { orient } = useLocalSearchParams<{ orient?: string }>();

  const rimLocked = useSession((s) => s.rimLocked);
  const isRecording = useSession((s) => s.isRecording);
  const streak = useSession((s) => s.stats.currentStreak);

  const activeMode = useMode((s) => s.activeMode);
  const modeDone = activeMode?.done ?? false;
  /** Tick-driven modes: Timed's countdown and Ghost's race clock. */
  const isTickDrivenMode =
    activeMode?.modeId === 'timed' || activeMode?.modeId === 'ghost';
  /** A structured drill is running (rides inside spotShooting via config.drill). */
  const isDrill = activeMode?.config?.drill != null;

  const [drift, setDrift] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [backgrounded, setBackgrounded] = useState(false);
  const [pausedChip, setPausedChip] = useState(false);
  // Last resolved shot for the micro-replay toast (ShotToast times itself).
  const [toastShot, setToastShot] = useState<ResolvedShot | null>(null);
  // One-shot contextual hint after the first UNSURE call — HintChip renders
  // null once its persisted flag is set, so no teardown logic is needed.
  const [showUnsureHint, setShowUnsureHint] = useState(false);

  // First-run intro — teaches physical setup before the rim locks. The second
  // step spotlights the ghost-rim aiming box (same geometry the AimingOverlay
  // draws, via ghostAimRect). Independent of the camera permission flow (it
  // renders in the same tree either way, and only actually shows once
  // permission is granted and the camera mounts).
  const liveSteps = useMemo<CoachStep[]>(
    () => [
      {
        title: 'Prop your phone',
        text: 'Set it on a tripod, a bench or a water bottle 15–30 feet to the side of the court, low enough that the whole rim is visible in frame.',
      },
      {
        title: 'Aim here',
        text: 'Line the hoop up with this box — whole rim in frame, upper third, held steady. The reticle locks on by itself.',
        targetRect: ghostAimRect(width, height),
      },
    ],
    [width, height],
  );
  const liveCoach = useCoachMarks('live', liveSteps);

  // Post-lock HUD tour — two spotlit steps (stat strip, bottom bar) measured
  // in window coordinates, the same space CoachMarks positions in. Measure
  // inside rAF (Home's measured-rect precedent) so layout has settled; an
  // undefined rect just centers the card, so a missed measure degrades safely.
  const statStripWrapRef = useRef<View>(null);
  const bottomBarRef = useRef<View>(null);
  const [statRect, setStatRect] = useState<LayoutRectangle | undefined>();
  const [barRect, setBarRect] = useState<LayoutRectangle | undefined>();
  // Only measure while the tour is actually pending/visible — for the >99% of
  // sessions where the liveHud tour is already seen, an always-on measure
  // re-rendered the WHOLE screen on every StatStrip layout change (every shot,
  // every expand/collapse tap) for rects nobody would ever read. The equality
  // check keeps settled layouts from re-rendering the screen either way
  // (measureInWindow hands back a fresh callback per layout pass, so the
  // setState below would otherwise always see a new object).
  const measureRef =
    (ref: React.RefObject<View | null>, setRect: React.Dispatch<React.SetStateAction<LayoutRectangle | undefined>>) => () => {
      requestAnimationFrame(() =>
        ref.current?.measureInWindow((x, y, w, h) => {
          if (w > 0 && h > 0)
            setRect((prev) =>
              prev != null && prev.x === x && prev.y === y && prev.width === w && prev.height === h
                ? prev
                : { x, y, width: w, height: h },
            );
        }),
      );
    };
  const hudSteps = useMemo<CoachStep[]>(
    () => [
      {
        title: 'Your live stat line',
        text: 'Points, FG% and streak, updated after every shot. Tap the strip any time to expand it.',
        targetRect: statRect,
      },
      {
        title: 'Session controls',
        text: "Re-aim if the camera moves, Calibrate for corner-accurate 3s, End when you're done. Now go shoot.",
        targetRect: barRect,
        placement: 'above',
      },
    ],
    [statRect, barRect],
  );
  const hudCoach = useCoachMarks('liveHud', hudSteps);

  const engineRef = useRef<ShotEngine | null>(null);
  const cameraRef = useRef<React.ComponentRef<typeof Camera>>(null);
  const driftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Wall-clock ms when the app went to background — drives the REAL mode-
   *  clock pause on foreground (see onForeground / shiftClock). */
  const backgroundedAtMs = useRef<number | null>(null);

  // Entering this screen directly (deep link, dev reload) still gets a
  // coherent session.
  useEffect(() => {
    if (useSession.getState().phase === 'idle') useSession.getState().beginSetup();
  }, []);

  // Lock the session to the orientation chosen at setup. A FIXED orientation is
  // what makes the live detection overlay reliable: the camera frame and the
  // preview never rotate mid-session, so the boxes can't dislocate on a
  // portrait/landscape flip. Unlock back to the app default on leave.
  useEffect(() => {
    const target =
      orient === 'landscape'
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    ScreenOrientation.lockAsync(target).catch(() => {});
    return () => {
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, [orient]);

  // Guard against leaving mid-session via swipe-back / hardware back button:
  // a live session (rim locked, maybe recording) should never vanish silently.
  // Intercept every pop attempt and surface the same confirm-end sheet the
  // "End session" button uses; `endSession` itself calls router.replace, which
  // is not a "back" navigation and passes straight through untouched.
  const navigation = useNavigation();
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e) => {
      if (ending) return; // already saving + navigating away on purpose
      if (!rimLocked) return; // nothing to lose yet — let the back gesture through
      e.preventDefault();
      setConfirmEnd(true);
    });
    return sub;
  }, [navigation, rimLocked, ending]);

  const onShot = useCallback((shot: ResolvedShot) => {
    useSession.getState().addShot(shot);
    setToastShot(shot); // feeds the last-shot micro-replay toast
    // First UNSURE call arms the one-shot honesty hint under the toast.
    if (shot.outcome === 'unsure') setShowUnsureHint(true);
    // Fold the same resolved shot into the active game mode (no-op when none).
    // Use the wall clock (seconds) so the timed-mode countdown shares one clock
    // with the tick loop below — shot.tResolved is camera-frame time, a
    // different origin that would desync the timer.
    useMode.getState().applyShot(shot, Date.now() / 1000);
    // haptic.* gates on the Settings toggle internally.
    if (shot.outcome === 'make') {
      haptic.success();
    } else if (shot.outcome === 'miss') {
      haptic.error();
    } else {
      haptic.warning();
    }
  }, []);

  // LOCK the full 3A pipeline (focus + exposure + white balance) on the rim
  // the moment it locks. Mid-session AF/AE hunting changes the ball's
  // appearance frame-to-frame — a prime suspect for dark/small-ball dropouts
  // — and the rim region is exactly where make/miss is decided. 'steady'
  // (we're filming), locked until re-aim resets it. Fire-and-forget: devices
  // without metering support just keep continuous auto — no worse than before.
  const focusOnRim = useCallback(() => {
    const eng = engineRef.current;
    const camera = cameraRef.current;
    if (eng == null || camera == null) return;
    const o = eng.overlay.value;
    if (o.rim == null) return;
    const win = Dimensions.get('window');
    const m = mapAnalysisToView(o, { w: win.width, h: win.height });
    if (!m.ok || m.scale <= 0) return;
    const fx = (o.rim.x + o.rim.width / 2) * m.scale + m.ox;
    const fy = (o.rim.y + o.rim.height / 2) * m.scale + m.oy;
    camera
      .focusTo(
        { x: fx, y: fy },
        { responsiveness: 'steady', adaptiveness: 'locked', autoResetAfter: null },
      )
      .catch(() => {
        // Unsupported device or metering race — continuous auto keeps working.
      });
  }, []);

  const onRimLocked = useCallback(() => {
    setDrift(false);
    focusOnRim();
    const store = useSession.getState();
    if (store.rimLocked) return; // re-lock after drift — already live
    store.setRimLocked(true);
    if (useSettings.getState().soundsEnabled) {
      playSound('rim_locked', useSettings.getState().soundPack);
    }
    // Success haptic at the lock moment — the tactile half of the green-lock
    // beat (the aiming overlay's ghost/countdown have just read fully green).
    // Settings-gated inside the util.
    haptic.success();

    const { recordVideo, keepMode } = useSettings.getState();
    void (async () => {
      // Stats-only sessions still go live; recording is additive.
      await store.goLive({
        keepMode: recordVideo ? keepMode : 'none',
        nowMs: Date.now(),
        modeId: useMode.getState().activeMode?.modeId,
      });
      const engine = engineRef.current;
      if (recordVideo && engine?.activeMode === 'camera') {
        try {
          await engine.startRecording();
          // Anchor recordingStartSec to the CAMERA MEDIA CLOCK (the same clock
          // shot.tResolved is stamped with, and the clock the MP4 is authored
          // on) — NOT the JS engine clock. engine.nowSec() put the start on a
          // different clock than the video timeline, so every replay marker
          // overshot the file duration and clamped to the end.
          useSession.getState().setRecording(true, null, engine.nowCameraSec());
        } catch {
          // Recording failed (storage, codec) — session continues stats-only.
          useSession.getState().setRecording(false);
        }
      }
    })();
  }, [focusOnRim]);

  const onRimDrift = useCallback(() => {
    setDrift(true);
    if (driftTimer.current) clearTimeout(driftTimer.current);
    driftTimer.current = setTimeout(() => setDrift(false), DRIFT_BANNER_MS);
  }, []);

  const engine = useShotEngine('auto', { onShot, onRimLocked, onRimDrift });
  // FT-seed engine seam — armFtSeed/cancelFtSeed/ftSeedLast ship with the
  // ft-position useShotEngine work (concurrent integrator). The structural
  // widening keeps this file compiling in either merge order (optional-call
  // no-ops until the handle exports them); drop the cast once the engine
  // handle carries the members directly. The pipeline's FtSeedFeedback is a
  // structural superset of the chip's, so the payload flows through as-is.
  const seedEngine = engine as ShotEngine & {
    armFtSeed?: () => void;
    cancelFtSeed?: () => void;
    ftSeedLast?: FtSeedFeedback | null;
  };
  const debugMode = useSettings((s) => s.debugMode);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  // Pre-lock "hold steady" countdown (3-2-1). Poll the overlay SharedValue at
  // 5 Hz — it changes ~once/second, so no need for a per-frame React update.
  const [countdown, setCountdown] = useState<number | null>(null);
  const overlaySv = engine.overlay;
  useEffect(() => {
    const id = setInterval(() => {
      const c = overlaySv.value.rimCountdown;
      const n = c != null ? Math.max(1, Math.ceil(c)) : null;
      setCountdown((prev) => (prev !== n ? n : prev));
    }, 200);
    return () => clearInterval(id);
  }, [overlaySv]);

  // Tap-to-set-rim — the single most important manual override. A wrong/failed
  // auto-lock gates ALL shot detection, and until now the only recovery was
  // ending the session. The user taps the real rim; we invert the HUD overlay
  // mapping (view px -> analysis-frame px) and lock the rim there.
  const onTapSetRim = useCallback(
    (x: number, y: number) => {
      const eng = engineRef.current;
      if (eng == null) return;
      const o = eng.overlay.value;
      const m = mapAnalysisToView(o, { w: width, h: height });
      if (!m.ok || m.scale <= 0) return;
      const ax = (x - m.ox) / m.scale;
      const ay = (y - m.oy) / m.scale;
      const S = Math.max(o.frameW, o.frameH) || 416;
      // Reuse the last-seen rim size when there is one (re-placing a same-size
      // rim); otherwise a sensible default (~12% of the frame, 2:1).
      const w = o.rim != null && o.rim.width > 0 ? o.rim.width : S * 0.12;
      const h = o.rim != null && o.rim.height > 0 ? o.rim.height : Math.max(8, w * 0.5);
      eng.setManualRim({ x: ax - w / 2, y: ay - h / 2, width: w, height: h });
      // Lock 3A where the user says the rim is — same reasoning as focusOnRim.
      cameraRef.current
        ?.focusTo(
          { x, y },
          { responsiveness: 'steady', adaptiveness: 'locked', autoResetAfter: null },
        )
        .catch(() => {});
      haptic.selection();
    },
    [width, height],
  );

  // Court calibration ("tap the court") — the corner-accurate, any-placement
  // 2/3 upgrade. Snapshot the analysis↔view mapping (the camera is static once
  // locked) and start the ritual; the overlay drives it from here.
  const calSession = useCourtCalibration((s) => s.session);
  const calRegistration = useCourtCalibration((s) => s.registration);
  const beginCal = useCourtCalibration((s) => s.begin);
  const [calMapping, setCalMapping] = useState<Mapping | null>(null);
  const startCalibrate = useCallback(() => {
    const eng = engineRef.current;
    if (eng == null) return;
    const m = mapAnalysisToView(eng.overlay.value, { w: width, h: height });
    if (!m.ok) return;
    setCalMapping(m);
    beginCal();
    haptic.selection();
  }, [width, height, beginCal]);

  // FT-line calibration capture — hands the chip a stable callback into the
  // engine (optional 2/3 refinement; a missing engine just reports a quiet no).
  const captureFt = useCallback((): Promise<FtCaptureOutcome> => {
    const eng = engineRef.current;
    if (eng == null) return Promise.resolve({ ok: false, reason: 'no-rim' });
    return eng.captureFtAnchor();
  }, []);

  // Re-aim — drop the lock and return to aiming (auto-lock or tap-to-set again).
  const onReAim = useCallback(() => {
    engineRef.current?.reAim();
    // Release the 3A lock so aiming at a new spot re-meters continuously.
    cameraRef.current?.resetFocus().catch(() => {});
    useSession.getState().setRimLocked(false);
    // A moved camera invalidates any court registration — the homography was
    // solved for the OLD pose. Clear it so a stale court can't mis-score 2/3.
    useCourtCalibration.getState().clear();
    setCalMapping(null);
    haptic.selection();
  }, []);
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
    backgroundedAtMs.current = Date.now();
    if (useSession.getState().isRecording) {
      void engineRef.current
        ?.stopRecording()
        .then((path) => useSession.getState().setRecording(false, path))
        .catch(() => useSession.getState().setRecording(false));
    }
  }, []);
  const onForeground = useCallback(() => {
    setBackgrounded(false);
    // Make the mode-clock pause REAL. Freezing the tick loop below stops UI
    // updates, but Timed/Ghost clocks are wall-clock (elapsed = now − started)
    // — without this shift the whole background gap would drain the clock the
    // instant the app returns, and a phone call could silently end the game.
    // Shifting `started` forward by the gap resumes exactly where it left off
    // (the ghost's recorded pace pauses with it, so its result stays fair).
    const wentBackgroundAt = backgroundedAtMs.current;
    backgroundedAtMs.current = null;
    if (wentBackgroundAt != null) {
      useMode.getState().shiftClock((Date.now() - wentBackgroundAt) / 1000);
    }
    if (useSession.getState().phase === 'live') {
      setPausedChip(true);
      if (pausedTimer.current) clearTimeout(pausedTimer.current);
      pausedTimer.current = setTimeout(() => setPausedChip(false), PAUSED_CHIP_MS);
    }
  }, []);
  useAppStateGuard({ onBackground, onForeground });

  // Mode clock tick (Timed countdown / Ghost race pace). Arms + drains the
  // clock on the same wall-clock source as applyShot (see onShot). Only runs
  // while a tick-driven game is live and not yet finished; tickMode is a no-op
  // for every other mode (and the ghost clock additionally waits for the first
  // shot). While the app is backgrounded the interval stops AND onForeground
  // shifts `started` forward by the gap (shiftClock), so the pause is real —
  // stopping the ticks alone would only hide a wall-clock that keeps draining.
  useEffect(() => {
    if (!isTickDrivenMode || !rimLocked || modeDone || ending || backgrounded) return;
    const id = setInterval(() => {
      useMode.getState().tick(Date.now() / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [isTickDrivenMode, rimLocked, modeDone, ending, backgrounded]);

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
    // Snapshot the finished mode's final state (score, letters, spots…) so
    // History can reconstruct its breakdown later. Omit entirely for Free
    // Play / no mode so endSession leaves any previously persisted result
    // untouched rather than clearing it.
    //
    // Strip the ghost race TIMELINE before persisting: it carries one point
    // per ghost make (a multi-KB blob for a long session) and every
    // listSessions consumer (History cards, lifetimeTotals' mode scan…)
    // re-parses modeResultJson. History only reads the final scoreboard —
    // ghost.finalGhostMakes / result / finalMargin plus durationSec — all of
    // which survive; an empty timeline is a valid GhostConfig shape.
    const finishedMode = useMode.getState().activeMode;
    const persistedMode =
      finishedMode?.config?.ghost == null
        ? finishedMode
        : {
            ...finishedMode,
            config: {
              ...finishedMode.config,
              ghost: { ...finishedMode.config.ghost, timeline: [] },
            },
          };
    await useSession.getState().finish({
      nowMs: Date.now(),
      videoPath: path,
      ...(persistedMode != null ? { modeResultJson: JSON.stringify(persistedMode) } : {}),
    });
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
    // A structured drill rides inside spotShooting (config.drill set): re-init
    // via its own builder so the drill's variable spots/goals rebuild — a plain
    // selectMode('spotShooting') would reset it to the fixed 5-spot mode.
    const drill = mode.config?.drill;
    if (drill != null) {
      useMode.getState().selectDrill(drill.id);
      return;
    }
    useMode.getState().selectMode(mode.modeId, mode.config ?? undefined);
  }, []);

  // ---------------------------------------------------------------------
  // Camera permission gate (camera mode only; demo mode needs nothing).
  // `canRequestPermission` comes straight from VisionCamera's own hook (same
  // underlying permission state the engine reads) so a permanently-denied
  // permission (user tapped "Don't allow" twice, or toggled it off in
  // Settings) offers a path to Settings instead of a request that silently
  // no-ops.
  // ---------------------------------------------------------------------
  const cam = engine.camera;
  const { canRequestPermission } = useCameraPermission();
  if (cam != null && !cam.hasPermission) {
    return (
      <Screen style={styles.permissionScreen}>
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionBody}>
          {canRequestPermission
            ? 'The live view watches the rim to count makes and misses. Everything stays on this phone.'
            : 'Camera access is off. Turn it on in system settings to track shots.'}
        </Text>
        <PillButton
          label={canRequestPermission ? 'Allow camera access' : 'Open settings'}
          onPress={() =>
            canRequestPermission ? void cam.requestPermission() : void Linking.openSettings()
          }
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
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          isActive={!ending}
          device={cam.device}
          outputs={cam.outputs}
          // 'contain' shows the WHOLE camera frame (letterboxed), matching the
          // detector input (scaleMode:'contain' in useShotEngine) so the overlay
          // boxes line up exactly and nothing the model sees is cropped off the
          // preview — critical in landscape, where the default 'cover' hid the
          // sides of the scene.
          resizeMode="contain"
          // Orient the frame buffer to the LOCKED UI orientation (not the raw
          // physical device angle), so it matches this screen's fixed
          // portrait/landscape lock. Paired with enablePhysicalBufferRotation on
          // the frame output (useShotEngine), the frames the model sees are the
          // same upright image as the preview → overlay boxes map exactly.
          orientationSource="interface"
        />
      ) : (
        <DemoCourt />
      )}

      <TrajectoryOverlay overlay={engine.overlay} />

      {debugMode && <DetectionBoxes overlay={engine.overlay} />}
      {debugMode && <DebugPanel debug={engine.debug} overlay={engine.overlay} />}

      {!rimLocked && (
        <AimingOverlay
          countdown={countdown}
          warming={engine.activeMode === 'camera' && !engine.isModelLoaded}
          overlay={engine.overlay}
          debug={engine.debug}
          onTap={onTapSetRim}
        />
      )}
      {/* Rim-lock checklist — self-positioned, pointerEvents none, so the
          tap-to-set-rim Pressable underneath keeps every touch. */}
      {!rimLocked && engine.activeMode === 'camera' && (
        <RimLockChecklist overlay={engine.overlay} debug={engine.debug} />
      )}

      {!rimLocked && liveCoach.visible && (
        <CoachMarks
          tapToAdvance
          steps={liveCoach.steps}
          onFinish={liveCoach.finish}
          onSkip={liveCoach.finish}
        />
      )}

      <ShotFlash />

      {/* Top HUD — full-width in portrait, a compact left-docked column in
          landscape so the hoop (usually center/right of frame) stays clear.
          Width is clamped between a usable floor (so internal chips/buttons
          never crush below a comfortable tap size) and whatever the viewport
          actually has available — never wider than the screen itself. */}
      <View
        style={[
          styles.topHud,
          {
            top: insets.top + space.md,
            left: insets.left + space.lg,
            right: isLandscape ? undefined : insets.right + space.lg,
            width: isLandscape
              ? Math.min(
                  LANDSCAPE_HUD_WIDTH,
                  Math.max(
                    LANDSCAPE_HUD_MIN_WIDTH,
                    width - insets.left - insets.right - space.lg * 2,
                  ),
                )
              : undefined,
            maxWidth: isLandscape ? width - insets.left - insets.right - space.lg * 2 : undefined,
          },
        ]}
        // box-none (not none): touches fall through to the camera everywhere
        // except on children that actually claim them — the ShotToast dismiss
        // tap and the StatStrip expand/collapse Pressable.
        pointerEvents="box-none"
      >
        {engine.activeMode === 'camera' && (
          <DetectionHealthPanel debug={engine.debug} overlay={engine.overlay} drift={drift} />
        )}
        {rimLocked && (
          // Plain measured wrapper inside the box-none column — StatStrip's
          // own expand/collapse Pressable keeps working; collapsable={false}
          // guarantees a real native view for measureInWindow (HUD tour rect).
          <View
            ref={statStripWrapRef}
            onLayout={hudCoach.visible ? measureRef(statStripWrapRef, setStatRect) : undefined}
            collapsable={false}
          >
            <StatStrip compact={isLandscape} />
          </View>
        )}
        {rimLocked && activeMode == null && <GoalChip />}
        {rimLocked && activeMode != null && (
          <View style={styles.modeBanner}>
            <ModeBanner mode={activeMode} />
          </View>
        )}
        <ShotToast shot={toastShot} streak={streak} />
        {/* One-shot honesty hint after the first UNSURE call. HintChip claims
            only its own small tap target inside this box-none column (rim
            tap-to-set only exists pre-lock, so no camera-tap conflict) and
            renders null once the persisted flag is set. */}
        {showUnsureHint && (
          <HintChip
            hintKey="unsureLive"
            text="UNSURE stays unsure — no guessing. Swipe it in the summary to correct; corrections are labeled and never re-judge."
            style={styles.unsureHint}
          />
        )}
        <FormCueToast shot={toastShot} streak={streak} />
        {engine.activeMode === 'camera' && <FirstBallRitual overlay={engine.overlay} />}
        {/* One-time FT-seed offer (optional 2/3 refinement): shoot your first
            shot from the FT line and the pipeline derives scale + heading from
            it; the legacy stand-and-hold capture stays as the secondary path.
            Mounts fresh at each rim lock (rimLocked flips false on re-aim),
            self-hides after FtSeedChip's own offer window, and renders nothing
            once done. NEVER mounts during a clock mode (Timed countdown /
            Ghost race): the ritual would burn live game clock — offer it only
            when no mode is active or the active mode has no running clock. */}
        {rimLocked && !isTickDrivenMode && (
          <FtSeedChip
            armSeed={() => seedEngine.armFtSeed?.()}
            cancelSeed={() => seedEngine.cancelFtSeed?.()}
            captureStandStill={captureFt}
            feedback={seedEngine.ftSeedLast ?? null}
          />
        )}
        {engine.activeMode === 'demo' && (
          <View style={styles.topCenter}>
            <Chip label="DEMO MODE — scripted scene" tone="accent" />
          </View>
        )}
        {drift && (
          <View style={styles.topCenter}>
            <HudChip>
              <Text
                style={styles.driftText}
                accessibilityLiveRegion="polite"
                accessibilityLabel="Camera moved, re-aiming"
              >
                Camera moved — re-aiming…
              </Text>
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

      {/* Drill guidance — an honest half-court map of the active spot (no fake
          AR floor marker). Bottom-center, above the action bar; only while a
          structured drill is running and the rim is locked, and it steps aside
          for the mode-complete sheet. */}
      {rimLocked && isDrill && activeMode != null && !modeDone && (
        <View
          pointerEvents="box-none"
          style={[
            styles.drillOverlay,
            { bottom: insets.bottom + BOTTOM_BAR_CLEARANCE + (isLandscape ? space.md : space.lg) },
          ]}
        >
          <DrillOverlay mode={activeMode} />
        </View>
      )}

      {/* Bottom bar — inset on all edges so the End button stays reachable on
          notched devices in either orientation. */}
      <View
        ref={bottomBarRef}
        onLayout={hudCoach.visible ? measureRef(bottomBarRef, setBarRect) : undefined}
        collapsable={false}
        style={[
          styles.bottomBar,
          {
            left: insets.left + space.lg,
            right: insets.right + space.lg,
            paddingBottom: insets.bottom + (isLandscape ? space.md : space.lg),
          },
        ]}
      >
        {isRecording && <RecIndicator />}
        {rimLocked && (
          <PillButton
            label="Re-aim"
            icon="scan-outline"
            variant="ghost"
            onPress={onReAim}
            style={styles.endButton}
          />
        )}
        {rimLocked && !isTickDrivenMode && calSession == null && (
          <PillButton
            label={calRegistration == null ? 'Calibrate' : 'Recalibrate'}
            icon="grid-outline"
            variant="ghost"
            onPress={startCalibrate}
            style={styles.endButton}
          />
        )}
        <PillButton
          label="End session"
          icon="stop-circle-outline"
          variant="ghost"
          onPress={() => setConfirmEnd(true)}
          style={[styles.endButton, styles.endSessionButton]}
        />
      </View>

      {/* Post-lock HUD tour — two spotlit steps over the stat strip and the
          bottom bar. The !isTickDrivenMode gate is load-bearing: a scrimmed
          tour must never sit over a draining Timed/Ghost clock (same reasoning
          as the FtSeedChip gate above). Also steps aside for the end-confirm
          sheet and the court-calibration ritual, which own the screen. */}
      {rimLocked &&
        !isTickDrivenMode &&
        !confirmEnd &&
        calMapping == null &&
        hudCoach.visible && (
          <CoachMarks
            tapToAdvance
            steps={hudCoach.steps}
            onFinish={hudCoach.finish}
            onSkip={hudCoach.finish}
          />
        )}

      {/* Mode-complete celebration sheet */}
      {activeMode != null && modeDone && !confirmEnd && !ending && (
        <ModeComplete mode={activeMode} onReplay={replayMode} onExit={() => void endSession()} />
      )}

      {/* Court calibration ("tap the court") — owns taps while active. Renders
          over everything so its landmark taps aren't intercepted by the HUD.
          Gated on the mapping ONLY: a successful commit nulls the session
          before the overlay's post-commit success card can render, and the
          overlay itself renders null when there is neither a session nor a
          pending success receipt. */}
      {calMapping != null && (
        <CourtCalibrationOverlay mapping={calMapping} onDone={() => setCalMapping(null)} />
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

function AimingOverlay({
  countdown,
  warming,
  overlay,
  debug,
  onTap,
}: {
  countdown: number | null;
  /** Detector still loading — first seconds after the camera opens. */
  warming: boolean;
  /** Engine overlay SharedValue — polled at 5 Hz for the placement grade. */
  overlay: ShotEngine['overlay'];
  /** Engine diagnostics SharedValue — effective fps feeds the grade. */
  debug: ShotEngine['debug'];
  /** Tap anywhere on the court to place the rim there (view px). */
  onTap: (x: number, y: number) => void;
}) {
  const { width, height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();

  // Three stages, one overlay: warming (model loading — the previously-blank
  // dead seconds now say what's happening), aiming (frame the hoop over the
  // ghost rim), and counting down (rim stable, locking in N — everything
  // reads make-green so the lock moment lands unmistakably).
  const counting = countdown != null;

  // Live placement grade — Good/OK/Poor + ONE actionable reason, polled at
  // 5 Hz exactly like the rimCountdown poll above (no per-frame React
  // updates). Hidden while the model warms — nothing to grade yet.
  const placement = usePlacementGrade(overlay, debug, !warming);

  // Ghost pulse. Respect reduced motion (hold steady); while counting the
  // ghost also goes solid — the sudden stillness itself signals "locking".
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion || counting) {
      pulse.value = withTiming(1, { duration: motion.quick });
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reducedMotion, counting]);
  const ghostAnimStyle = useAnimatedStyle(() => ({
    opacity: 0.45 + pulse.value * 0.55,
  }));

  // Ghost rim geometry: the IDEAL apparent rim — GHOST_RIM_WIDTH_FRAC of the
  // shorter view side, centered horizontally in the upper third of the frame.
  // Frame the real hoop over it and the grade lands in the good band.
  const ghostW = Math.round(Math.min(width, height) * GHOST_RIM_WIDTH_FRAC);
  const ghostH = Math.round(ghostW * GHOST_RIM_ASPECT);

  return (
    <Pressable
      style={styles.aiming}
      onPress={(e) => onTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}
      accessibilityRole="button"
      accessibilityLiveRegion="polite"
      accessibilityLabel={
        warming
          ? 'Starting the shot tracker.'
          : counting
            ? `Rim found. Locking in ${countdown}. Hold steady, or tap the rim to set it yourself.`
            : `Frame the hoop over the ghost rim outline near the top of the screen. ${
                placement != null ? `${placement.reason}. ` : ''
              }It locks automatically, or tap the rim to set it yourself.`
      }
    >
      {/* Ghost rim — dashed silhouette at the ideal apparent size/position;
          solid make-green while the 3-2-1 countdown runs (the lock reticle). */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.ghostWrap,
          {
            left: Math.round((width - ghostW) / 2),
            top: Math.round(height * GHOST_RIM_CENTER_Y_FRAC - ghostH / 2),
            width: ghostW,
            height: ghostH,
          },
          ghostAnimStyle,
        ]}
      >
        <GhostRim width={ghostW} height={ghostH} active={counting} />
      </Animated.View>

      <View pointerEvents="none" style={styles.aimContent}>
        {counting && <Text style={styles.countdownNum}>{countdown}</Text>}
        <Text style={styles.aimTitle}>
          {warming
            ? 'Waking up the AI…'
            : counting
              ? 'Hold steady — locking on the rim'
              : 'Frame the hoop over the ghost rim'}
        </Text>
        <Text style={styles.aimSub}>
          {warming
            ? 'A second or two — then frame the hoop over the ghost rim'
            : counting
              ? `Locking in ${countdown}… or tap the rim to set it now`
              : 'It locks automatically — or tap the rim to place it yourself'}
        </Text>
        {!warming && placement != null && (
          <View style={styles.gradeChip}>
            <PlacementGradeChip result={placement} />
          </View>
        )}
      </View>
    </Pressable>
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
        <Text
          style={styles.recText}
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Recording, ${mm} minutes ${ss} seconds`}
        >{`REC ${mm}:${ss}`}</Text>
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
  /** One-shot UNSURE honesty hint — centered under the shot toast. */
  unsureHint: {
    alignSelf: 'center',
    marginTop: space.sm,
    maxWidth: 340,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    // Wrap so a crowded row (recording + Re-aim + Calibrate + End) drops onto a
    // second line instead of pushing a button off-screen.
    flexWrap: 'wrap',
    columnGap: space.md,
    rowGap: space.sm,
  },
  // End sits at the right edge of its line; the setup buttons cluster left.
  endSessionButton: {
    marginLeft: 'auto',
  },
  drillOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
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
  /** Positioned per-render at the ideal rim band (upper third, centered). */
  ghostWrap: {
    position: 'absolute',
  },
  aimContent: {
    alignItems: 'center',
  },
  countdownNum: {
    ...type.title,
    fontSize: 56,
    lineHeight: 60,
    fontWeight: '800',
    color: color.make,
    fontVariant: ['tabular-nums'],
    marginBottom: space.md,
  },
  gradeChip: {
    marginTop: space.lg,
    maxWidth: '100%',
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
