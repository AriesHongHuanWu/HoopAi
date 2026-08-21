/**
 * Form Check — hoop-free shooting-form reps from the back camera.
 *
 * Point the phone at YOURSELF (no hoop, no ball tracking): the screen counts
 * shooting-motion reps with the existing pose-only ReleaseDetector and grades
 * each rep's mechanics (set-point elbow, knee flexion, dip→release tempo,
 * follow-through, release height) with src/core/formCheck.ts. Because no ball
 * is ever seen, this screen NEVER claims a make or a miss, and the ball-
 * trajectory metrics (release/entry angle) render as "not measured" — the
 * honesty contract lives in the core and is repeated in the copy here.
 *
 * ── V2 ───────────────────────────────────────────────────────────────────────
 * The live view is now three zones: a top rail that is EITHER the explicit
 * shadow-rep calibration stepper ("Practice motion 1 of 2 — not scored") or
 * the compact readiness chip row with ONE guidance banner; the camera +
 * skeleton center that nothing may overlap; and the bottom rep numeral with
 * per-phase micro-bars and the action row. The report is a consistency-verdict
 * hero above SegmentedTabs (Overview / Reps / Compare). Every v2 number is
 * confidence-gated in the core and rendered with its honest degradation here:
 * auto-handedness abstains to "ASSUMED", tilt shows "not compensated", metres
 * appear only with a profile height and are labeled estimates, similarity is a
 * style match against a SYNTHESIZED reference — never a quality score.
 * Reports now auto-save to SQLite (insertJump precedent); a failed insert
 * keeps the honest "couldn't be saved" line.
 *
 * ── Camera plumbing ──────────────────────────────────────────────────────────
 * useFormPose is jump.tsx's useJumpPose, verbatim in structure: the same
 * MoveNet asset, the same core-ml/android-gpu → CPU loader ladder, the same
 * NitroModules.box SharedValue, the same frame → useResizer(192, cover) →
 * runSync → parseMoveNet → scheduleOnRN worklet, the same try/finally
 * frame.dispose and the same iOS-seconds/Android-ns timestamp normalization.
 * The only delta: it ships the WHOLE 17-keypoint PoseFrame (plus the sensor
 * dims for overlay mapping) instead of four ankle/hip numbers, because the
 * detector and the sequence packer need every landmark. V2 adds NOTHING to
 * the worklet path — calibration's dual detectors live inside the core
 * session on the JS-side sink, exactly like v1's single detector.
 *
 * The skeleton overlay is deliberately NOT a worklet: a plain Skia canvas on
 * the JS thread, polled from a ref at ~12 Hz (the CaptureProgress precedent).
 * Pose analysis runs faster underneath; the overlay is presentation only and
 * never feeds metrics.
 *
 * Honest about limits: needs ≥ 15 fps pose and your WHOLE body + shooting arm
 * in frame; below any gate the screen pauses rep counting and says why
 * (Jump Lab's refuse-below-15fps contract, reused).
 *
 * ── V3 — stage hardening ─────────────────────────────────────────────────────
 * Everything here removes a stall, relaxes a gate, makes a failure
 * recoverable or makes a state legible. Nothing new is measured.
 *  - the pose model runs TWO throwaway inferences before it is published, so
 *    the CoreML graph compile happens while the guide is on screen instead of
 *    on the first camera frame (useShotEngine's warm-up, which this screen's
 *    verbatim loader copy had dropped);
 *  - the loader ladder no longer swallows its failure: a watchdog and a
 *    Retry pill replace an eternal "Warming up the pose model…";
 *  - the live view is an EARLY RETURN, not an absolute child of the guide's
 *    ScrollView — Zone A used to render above the viewport;
 *  - "Starting the camera…" is a state of its own, so a camera that has not
 *    produced a frame yet stops blaming the room's lighting;
 *  - readiness is stated POSITIVELY ("Ready — shoot when you like.") and at a
 *    size that reads from three metres;
 *  - every relaxed gate the core now reports ({@link FormCheckRep.lowConfidence})
 *    is rendered. A relaxed capture is never presented as a clean one.
 *
 * ── V4 — buffer orientation ──────────────────────────────────────────────────
 * On a real device the skeleton drew HEAD-DOWN, FEET-UP. That is not a
 * drawing offset: a 180°-rotated buffer feeds MoveNet an upside-down person,
 * so release height (a signed ankle−wrist difference), the dip's wrist-y
 * extremum, knee flexion and the tilt estimate are all computed on flipped
 * coordinates. The correction therefore happens ONCE at the PARSE BOUNDARY —
 * in the JS-side sink, before the session or the overlay sees the frame (see
 * src/core/poseOrientation.ts) — so the picture and the numbers can never
 * disagree. Doing it in {@link mapKeypoint} instead would fix the picture and
 * leave the analysis upside down, which is the worst outcome available.
 * The verdict rides in the readiness rail as a chip — in the CALIBRATION
 * stepper as well as the armed chip row, because collecting is the phase the
 * verdict is meant to settle in — and is overridable in one tap; while it is
 * unverified the chip SAYS so and the data stays untouched.
 * Committing is a coordinate-space change, so the session is REBUILT on that
 * edge: baselines locked in the old space would otherwise be compared against
 * the new one, and a rep scored upside down would ride into the report. The
 * stepper says why it restarted.
 * The default camera is now the BACK one: the capture protocol puts the phone
 * at the shooter's side 2–4 m away, where the screen cannot be read anyway,
 * and the back sensor is the better one.
 *
 * ── V5 — a silent bring-up failure is now a legible one ──────────────────────
 * Nearly every way this screen can fail to come up collapsed into the same
 * eternal "Starting the camera… Rep counting is paused." with amber chips, no
 * diagnosis, and a most-prominent recovery control that cannot fix any of
 * them. Three states now separate themselves out of it, each with the action
 * that actually helps:
 *  - EVERY FRAME IS FAILING. The worklet counted only SUCCESSES, and a model
 *    whose delegate cannot Invoke this graph throws on every frame into a
 *    bare `catch {}` — so the success counter never left 0 and the rail said
 *    the camera was starting for the whole session. The catch now counts (it
 *    still swallows: a bad frame must never kill the frame processor), and
 *    (0 successes, N failures) is its own banner with "Switch to CPU", which
 *    reloads the model with the accelerated rung dropped.
 *  - NOBODY IN FRAME on the BACK camera. The back default is right for the
 *    propped protocol and wrong for a person holding the phone to test, and
 *    the only thing the rail said was "Step back — head to feet in frame":
 *    a message about distance for a problem about facing. When nothing at all
 *    is being seen on the sensor that can be pointing away, the rail says so
 *    and puts Flip camera on the banner. The DEFAULT does not move.
 *  - NO FIRST FRAME EVER. {@link frameStall} takes started=false and returns
 *    false by contract, so a loop that never produced a frame could not be
 *    diagnosed at all. It now gets its own bounded warm-up budget as a
 *    DISTINCT, later state — the cold-start copy still owns the whole budget,
 *    because calling a slow cold start a failure is the worse mistake.
 * Every decision above is a pure exported helper next to frameStall and is
 * unit-tested there. The WIRING (the worklet's failure counter, the rail's
 * two new poll reads, the CPU reload) cannot run under jest — the camera and
 * tflite are stubbed inert — and is DEVICE-VERIFIED ONLY.
 * Honesty: none of these actions relaxes a gate or produces a number the app
 * did not read. The CPU interpreter computes the same keypoints more slowly,
 * and a slower rate is caught by the fps gate exactly as before.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as Speech from 'expo-speech';
import { NitroModules } from 'react-native-nitro-modules';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  type InterruptionReason,
} from 'react-native-vision-camera';
import { useResizer } from 'react-native-vision-camera-resizer';
import {
  loadTensorflowModel,
  type TensorflowModel,
} from 'react-native-fast-tflite';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Canvas, Circle, Line, Path, Skia, vec } from '@shopify/react-native-skia';

import { useAppStateGuard } from '@/camera/useAppStateGuard';

import FormCheck3DPanel from '@/components/charts/FormCheck3DPanel';
import { FormMotionStage, type StagePhase } from '@/components/charts/FormMotionStage';
import { PhaseBars } from '@/components/charts/PhaseBars';
import { ArcReveal, arcMotif } from '@/components/motion';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { SegmentedTabs, type SegmentedTabItem } from '@/components/SegmentedTabs';
import { SESSION_FORM_REFERENCE_CAPTION } from '@/components/SessionFormReport';
import { BackPill } from '@/components/ShotList';
import { Card, Chip, PillButton, Row, Screen } from '@/components/ui';
import { color, font, iconSize, layout, radius, space, type } from '@/constants/tokens';
import {
  cameraSessionBanner,
  type CameraSessionStatus,
} from '@/core/cameraSession';
import { FORM } from '@/core/config';
import {
  ELBOW_SPREAD_FLAG_DEG,
  FPS_OVERRIDE_MIN,
  FormCheckSession,
  KNEE_SPREAD_FLAG_DEG,
  MIN_POSE_FPS,
  MIN_SPREAD_REPS,
  RELEASE_HEIGHT_SPREAD_FLAG,
  SHADOW_REPS_TARGET,
  SIDE_PROFILE_TRUSTED,
  TEMPO_SPREAD_FLAG_MS,
  TILT_MAX_COMP_DEG,
  type CalibrationState,
  type FormCheckReadiness,
  type FormCheckRep,
  type FormCheckSessionReport,
  type HandSource,
  type RepConfidenceReason,
  type RepPhaseTiming,
  type SpreadStat,
} from '@/core/formCheck';
import { liftRep, type FormCheck3D } from '@/core/formCheck3d';
import {
  decodeSequence,
  isReconstructibleMotion,
  type DecodedFrame,
} from '@/core/formSequence';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { formSimilarity, type FormSimilarity } from '@/core/formSimilarity';
import {
  PoseOrientationDetector,
  correctPoseFrame,
  type OrientationSource,
  type PoseOrientation,
  type PoseOrientationState,
} from '@/core/poseOrientation';
import { posturePlan, type PostureCue } from '@/core/postureFix';
import type { PoseKeypointName, ShootingHand } from '@/core/types';
import { insertFormSession, type FormSessionFullRow } from '@/data/db';
import { parseMoveNet } from '@/ml/poseParser';
import { useProfile } from '@/state/profileStore';
import { useSettings } from '@/state/settingsStore';
import { haptic } from '@/utils/haptics';

/* eslint-disable @typescript-eslint/no-var-requires */
// RELATIVE on purpose (jump.tsx uses '@/assets/…'): jest's moduleNameMapper
// routes '@/…' into src/, so the alias form can never resolve under the
// render tests this screen carries. Metro treats both spellings identically.
const POSE_ASSET = require('../../assets/models/movenet-pose.tflite');
/* eslint-enable @typescript-eslint/no-var-requires */

/** MoveNet input side (square) — the analysis space every keypoint lives in. */
const POSE_INPUT = 192;

/**
 * The square {@link correctPoseFrame} inverts a flipped buffer around. It is
 * the ANALYSIS square (POSE_INPUT), never `frame.width/height`: parseMoveNet
 * de-normalizes into the 192-square cover-crop, so handing the correction the
 * camera's sensor dims would translate the whole skeleton off the crop.
 * Module-level so the per-frame sink allocates nothing.
 */
const POSE_SQUARE = { width: POSE_INPUT, height: POSE_INPUT } as const;

/** Skeleton overlay poll interval, ms (~12 Hz — CaptureProgress precedent). */
const OVERLAY_POLL_MS = 80;

/** Live rail poll interval, ms (~4 Hz — readiness + calibration snapshot). */
const READINESS_POLL_MS = 250;

/**
 * How long the "Calibrated — scoring armed" ArcReveal owns the rail, ms.
 * 1200, not 2600: the shooter has just been told scoring is armed, so they
 * shoot immediately — a celebration longer than one shooting motion blanks
 * the readiness chips over exactly the window in which they matter. The chip
 * row now renders UNDER the armed text as well, so nothing is hidden at all.
 */
const ARMED_BANNER_MS = 1200;

/**
 * Watchdog on the pose loader, ms. A hung asset load looks exactly like a
 * slow one from the outside, and "Warming up the pose model…" forever is a
 * screen the presenter cannot act on. Past this the rail offers Retry.
 * Generous on purpose — a cold first load on an A11/A12 is seconds, not
 * milliseconds, and a premature Retry offer would be its own stumble.
 */
const MODEL_LOAD_TIMEOUT_MS = 12000;

/**
 * Frames that must have arrived before the rail stops saying "Starting the
 * camera…". Below this the readiness gauges are measuring a camera that has
 * not delivered a frame yet — a red FPS/BODY/ARM row there is not a
 * diagnosis, it is noise.
 */
const WARMUP_FRAMES = 8;

/**
 * How long the frame counter may stand still before the rail calls the pose
 * loop stalled, ms. 750 is ~22 frames at 30 fps and 11 at 15 fps — well clear
 * of any plausible worklet-to-JS visibility delay, so a false stall costs a
 * banner nobody needed, while the state it catches is a green readiness
 * verdict painted over a dead skeleton.
 */
const FRAME_STALL_MS = 750;

/**
 * FAILED inferences — with ZERO successful ones — before the rail stops
 * calling this a warm-up and says the pose model is not running.
 *
 * The worklet only advances its success counter after a whole
 * resize → getPixelBuffer → runSync → parseMoveNet chain lands, so a delegate
 * that constructs but cannot Invoke this graph throws on EVERY frame and the
 * success counter never leaves 0 — "Starting the camera…", forever, over a
 * live preview. 12 is ~0.4 s at 30 fps: long enough that a couple of ragged
 * frames at capture start are not a verdict, short enough that the presenter
 * is not reading a lie for a second.
 */
const INFERENCE_FAIL_FRAMES = 12;

/**
 * How long the live view may sit with NO first frame at all — none counted,
 * none failed — before the rail offers a way out, ms.
 *
 * {@link frameStall} cannot cover this by contract: it takes `started=false`
 * and returns false, because arming before the first frame would call every
 * cold start a failure. That is the right call for the stall banner and it
 * leaves "the loop never produced a frame" undiagnosable, so this budget is
 * its own, LATER state. 12 s is deliberately generous — the same order as
 * {@link MODEL_LOAD_TIMEOUT_MS} — because a cold AVCaptureSession + first
 * CoreML Invoke on an A11 is seconds, and a premature accusation here would
 * be worse than the silence it replaces. The clock only runs while a model is
 * actually published (see the rail's poll): the camera must never be blamed
 * for the loader's seconds.
 */
const FIRST_FRAME_BUDGET_MS = 12000;

/**
 * Body-visible fraction at or below which nothing is in frame AT ALL, as
 * opposed to a shooter framed badly. Not zero: one flickering false-positive
 * keypoint set in a two-second window must not turn "nobody is there" into
 * "step back".
 */
const EMPTY_FRAME_FRAC = 0.05;

/**
 * Frame timestamps are nanoseconds on Android and CMTime SECONDS since boot
 * on iOS. This used to be guessed from the magnitude (`timestamp > 1e6`),
 * which silently inverts on an iPhone that has been up for more than 11.6
 * days (1e6 s): every timestamp would be divided by 1e9, the clock would
 * crawl, and the debounce would never lapse again — exactly one rep, ever,
 * with every gate green. A captured boolean primitive is worklet-safe.
 */
const TS_IS_NANOS = Platform.OS !== 'ios';

/** Below this sideness the guidance says "turn 90°" instead of "a little". */
const SIDE_TURN_HINT = 0.35;

type CheckPhase = 'guide' | 'live' | 'report';

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent (jump.tsx). */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

// ---------------------------------------------------------------------------
// Minimal pose loop — streams full PoseFrames to a JS-side sink.
// ---------------------------------------------------------------------------

/**
 * What the `<Camera>` has actually told this screen about its session, plus
 * the wall clock this attempt started on. {@link cameraSessionBanner} turns
 * it into copy; nothing here decides anything.
 */
interface CameraSessionState extends Omit<CameraSessionStatus, 'elapsedMs'> {
  /** When this capture session began coming up — the deadline's zero. */
  since: number;
}

/** One streamed sample: the parsed pose + the sensor dims (overlay mapping). */
interface FormPoseSample {
  pose: ReturnType<typeof parseMoveNet>;
  frameW: number;
  frameH: number;
}

/**
 * Two throwaway inferences on a dummy frame, BEFORE the model is published.
 *
 * `loadTensorflowModel` resolves as soon as the interpreter and its delegate
 * are constructed — the CoreML delegate does its graph partitioning and ANE
 * compilation lazily, on the FIRST Invoke. Without this, that first Invoke is
 * the `runSync` inside the frame worklet on the first camera frame after the
 * presenter taps Start, while the screen has already stopped saying it is
 * warming up: a live preview, no skeleton, 0 REPS DETECTED, no explanation.
 * useShotEngine has always done this ("the second one is timed"); this
 * screen's verbatim copy of the loader had dropped it.
 *
 * Async `run`, never `runSync`, so it cannot block the JS thread. Any failure
 * is swallowed — a model that will not take a dummy frame must still be
 * published and allowed to fail honestly on real ones.
 */
async function warmUpPose(m: TensorflowModel): Promise<void> {
  try {
    // Size from the model's own input tensor; fall back to what the resizer
    // is configured to emit (uint8 192×192×3 interleaved).
    const shape = m.inputs[0]?.shape;
    const elems =
      shape != null && shape.length > 0
        ? shape.reduce((a, b) => a * Math.max(1, b), 1)
        : POSE_INPUT * POSE_INPUT * 3;
    const dummy = new Uint8Array(elems).buffer;
    await m.run([dummy]);
    await m.run([dummy]);
  } catch (err) {
    console.warn('[formcheck] pose warm-up skipped', err);
  }
}

/**
 * Runs MoveNet on the camera and ships one full {@link FormPoseSample} per
 * analysed frame to `sink`. Active only while `active` is true, so the model
 * isn't burning battery on the guide or report screens. Structure copied from
 * jump.tsx's useJumpPose — see the module doc for the one delta.
 */
function useFormPose(
  active: boolean,
  position: 'front' | 'back',
  sink: (s: FormPoseSample) => void,
) {
  const device = useCameraDevice(position);
  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();

  const [model, setModel] = useState<TensorflowModel | null>(null);
  /** Non-null once BOTH loader rungs have failed (or the watchdog fired). */
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  /**
   * Skip the accelerated rung entirely on the next load. A delegate can be
   * constructed successfully and still be unable to Invoke this graph — the
   * quantised-MoveNet-on-CoreML case — and re-running the IDENTICAL ladder is
   * not a recovery. This is what the rail's "Switch to CPU" action changes,
   * and it is the only escape on this screen from a rung that is broken for
   * the whole install. It relaxes NO gate and invents no number: the CPU
   * interpreter computes the same keypoints, more slowly, and a slower rate
   * is caught by the fps gate exactly as it always was.
   */
  const [cpuOnly, setCpuOnly] = useState(false);
  const boxedPoseSv = useSharedValue<ReturnType<typeof NitroModules.box> | null>(null);
  const framesSv = useSharedValue(0);
  /**
   * Frames whose inference THREW. The success counter alone cannot tell
   * "the camera has not started" from "every frame is dying": both leave it
   * at 0. This is the second observable that separates them.
   */
  const failedSv = useSharedValue(0);

  // Ask for the camera at SCREEN MOUNT, not at Start: the OS dialog then
  // resolves while the presenter is reading the guide instead of landing in
  // the middle of the demo. Ref-guarded — `requestPermission` is not
  // guaranteed to be referentially stable across renders.
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current || hasPermission) return;
    askedRef.current = true;
    void requestPermission().catch(() => {
      // A refusal is a state, not a crash — the guide/live wall handles it.
    });
  }, [hasPermission, requestPermission]);

  // Foreground guard (live.tsx's contract): a call, a Control Center pull or
  // an app switch interrupts the AVCaptureSession, and VisionCamera left
  // nominally active across the transition comes back with a black preview
  // and a stopped frame processor. Stopping and restarting cleanly is the
  // difference between a 1 s reacquire and a frozen screen with no message.
  const [foreground, setForeground] = useState(true);
  useAppStateGuard({
    onBackground: () => {
      setForeground(false);
      // The rail's "Starting the camera…" state is keyed off this counter, so
      // a restart reads as starting rather than as stale green chips.
      framesSv.value = 0;
      // Both counters or neither: a stale failure count against a fresh
      // success count would accuse the reacquire of the last run's deaths.
      failedSv.value = 0;
    },
    onForeground: () => setForeground(true),
  });

  /**
   * THE CAMERA SESSION'S OWN CHANNEL. VisionCamera reports a session that
   * failed, was interrupted, or never came up through callbacks this screen
   * passed to NOTHING — so `useCamera`'s default handler took them, which is
   * a `console.error` nobody on a phone can see. A camera another app is
   * holding then looks EXACTLY like one that is warming up, forever.
   *
   * The shape is {@link CameraSessionStatus} verbatim (minus the clock, which
   * the rail's poll owns), so the pure {@link cameraSessionBanner} decides
   * what any of it MEANS and this hook only records what was observed.
   */
  const [camSession, setCamSession] = useState<CameraSessionState>(() => ({
    errorMessage: null,
    interruption: null,
    configured: false,
    started: false,
    since: Date.now(),
  }));
  // A new sensor, or a return from the background, is a NEW session: the old
  // one's error and its "started" are both stale, keeping either would let
  // one interruption accuse a session that has since recovered, and the
  // deadline has to start again with it (the reacquire is not a failure).
  useEffect(() => {
    setCamSession({
      errorMessage: null,
      interruption: null,
      configured: false,
      started: false,
      since: Date.now(),
    });
  }, [position, foreground]);
  const onCameraConfigured = useCallback(() => {
    setCamSession((s) => (s.configured ? s : { ...s, configured: true }));
  }, []);
  const onCameraStarted = useCallback(() => {
    // A session that is running is not a session that errored — clearing the
    // message here is what stops a recovered camera wearing an old fault.
    setCamSession((s) => ({ ...s, started: true, errorMessage: null }));
  }, []);
  const onCameraStopped = useCallback(() => {
    setCamSession((s) => (s.started ? { ...s, started: false } : s));
  }, []);
  const onCameraError = useCallback((err: Error) => {
    // Raw text to the console only. On-screen copy says what to DO.
    console.warn('[formcheck] camera session error', err);
    setCamSession((s) => ({ ...s, errorMessage: String(err?.message ?? err) }));
  }, []);
  const onCameraInterruptionStarted = useCallback((reason: InterruptionReason) => {
    setCamSession((s) => ({ ...s, interruption: reason }));
  }, []);
  const onCameraInterruptionEnded = useCallback(() => {
    setCamSession((s) => (s.interruption == null ? s : { ...s, interruption: null }));
  }, []);

  // Load MoveNet once (fast delegate → CPU fallback), mirroring useShotEngine's
  // pose loader. Boxed into a SharedValue so the frame worklet reads it fresh.
  // Runs at screen mount (deps carry no `active`), so the warm-up above is
  // paid while the guide is on screen.
  useEffect(() => {
    let alive = true;
    setModelErr(null);
    // A retry must not leave the previous model boxed: the worklet already
    // no-ops on a null box, so this parks the frame path during the reload.
    boxedPoseSv.value = null;
    const watchdog = setTimeout(() => {
      if (alive) setModelErr('the pose model took too long to load');
    }, MODEL_LOAD_TIMEOUT_MS);
    void (async () => {
      const accel: ('core-ml' | 'android-gpu')[] =
        Platform.OS === 'ios' ? ['core-ml'] : ['android-gpu'];
      const cpu = [] as ('core-ml' | 'android-gpu')[];
      // `cpuOnly` drops the accelerated rung: the presenter has just told the
      // screen that the published model throws on every frame, and that rung
      // is the suspect. Nothing else about the load changes.
      const rungs = cpuOnly ? [cpu] : [accel, cpu];
      let lastError = '';
      for (const d of rungs) {
        try {
          const m = await loadTensorflowModel(POSE_ASSET, d);
          if (!alive) return;
          await warmUpPose(m);
          if (!alive) return;
          clearTimeout(watchdog);
          setModel(m);
          setModelErr(null);
          boxedPoseSv.value = NitroModules.box(m);
          return;
        } catch (err) {
          // Try the next (CPU) rung — but KEEP the reason. A ladder that
          // exhausts itself silently leaves the screen warming up forever.
          lastError = String(err).slice(0, 160);
        }
      }
      if (alive) {
        clearTimeout(watchdog);
        setModelErr(lastError || 'the pose model could not be loaded');
      }
    })();
    return () => {
      alive = false;
      clearTimeout(watchdog);
      boxedPoseSv.value = null;
    };
  }, [boxedPoseSv, cpuOnly, loadNonce]);

  /**
   * Re-run the loader ladder. The frame counters go with it — the same "both
   * counters or neither" rule the background guard and {@link usePoseCpu}
   * follow. Without this the "isn't running" banner outlived the Retry that
   * was offered to clear it: the failure count from the dead interpreter
   * stayed on screen until the NEW one produced its first successful frame.
   */
  const retryModel = useCallback(() => {
    framesSv.value = 0;
    failedSv.value = 0;
    setLoadNonce((n) => n + 1);
  }, [failedSv, framesSv]);

  /**
   * Reload WITHOUT the accelerated rung, and zero the frame counters so the
   * rail judges the new interpreter on its own frames rather than on the dead
   * one's. The re-entered loader effect parks the frame path (it nulls the
   * box) until the CPU rung publishes.
   */
  const usePoseCpu = useCallback(() => {
    framesSv.value = 0;
    failedSv.value = 0;
    setCpuOnly(true);
    setLoadNonce((n) => n + 1);
  }, [failedSv, framesSv]);

  // MoveNet wants NHWC uint8 192×192 (interleaved) — same config as the
  // engine's pose resizer.
  const { resizer } = useResizer({
    width: POSE_INPUT,
    height: POSE_INPUT,
    channelOrder: 'rgb',
    dataType: 'uint8',
    scaleMode: 'cover',
    pixelLayout: 'interleaved',
  });

  const activeSv = useSharedValue(false);
  useEffect(() => {
    activeSv.value = active;
  }, [active, activeSv]);

  const onSample = useMemo(() => (s: FormPoseSample) => sink(s), [sink]);

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    enablePreviewSizedOutputBuffers: true,
    enablePhysicalBufferRotation: true,
    dropFramesWhileBusy: true,
    onFrame(frame) {
      'worklet';
      try {
        if (!activeSv.value) return;
        const boxed = boxedPoseSv.value;
        if (boxed == null || resizer == null) return;
        let resized: { getPixelBuffer(): ArrayBuffer; dispose(): void } | null = null;
        try {
          // Local name distinct from the outer `model` state so the worklet
          // never closes over the non-serializable state object by name.
          const tflite = boxed.unbox() as TensorflowModel;
          resized = resizer.resize(frame);
          const buf = resized.getPixelBuffer();
          const out = tflite.runSync([buf]);
          // Camera presentation timestamp → seconds (iOS seconds; Android ns).
          // Platform-decided, never magnitude-guessed — see TS_IS_NANOS.
          const tSec = TS_IS_NANOS ? frame.timestamp / 1e9 : frame.timestamp;
          // iOS hands over metadata.timestamp.seconds with no CMTime validity
          // guard, so tSec can be NaN. One such frame permanently halts both
          // prune loops and poisons every filter downstream — drop it here,
          // the way PoseOrientationDetector and useShotEngine already do.
          if (!Number.isFinite(tSec)) return;
          // De-normalize into the 192-square analysis space — the detector's
          // vy threshold and the sequence packer both live there.
          const pose = parseMoveNet(
            new Float32Array(out[0]!),
            POSE_INPUT,
            POSE_INPUT,
            tSec,
          );
          framesSv.value += 1;
          scheduleOnRN(onSample, {
            pose,
            frameW: frame.width,
            frameH: frame.height,
          });
        } finally {
          if (resized != null) resized.dispose();
        }
      } catch {
        // A single bad frame must never kill the frame processor — that
        // contract is unchanged. What changes is that the frame is now
        // COUNTED: a model whose delegate cannot Invoke this graph throws
        // here on every frame, and with nothing counting them the only word
        // the screen had for it was "Starting the camera…", forever.
        try {
          failedSv.value += 1;
        } catch {
          // The counter must never become a second way to kill the loop.
        }
      } finally {
        frame.dispose();
      }
    },
  });

  return {
    device,
    hasPermission,
    canRequestPermission,
    requestPermission,
    outputs: [frameOutput],
    modelLoaded: model != null,
    modelErr,
    retryModel,
    usePoseCpu,
    poseCpuOnly: cpuOnly,
    foreground,
    framesSv,
    failedSv,
    /** What the capture session has reported — read by the rail's poll. */
    camSession,
    /** Handed straight to `<Camera>`; see the session-channel note above. */
    onCameraConfigured,
    onCameraStarted,
    onCameraStopped,
    onCameraError,
    onCameraInterruptionStarted,
    onCameraInterruptionEnded,
  };
}

// ---------------------------------------------------------------------------
// Voice rep callouts — the useVoiceAnnouncements pattern, verbatim: device
// locale detected once, stop-before-speak (replace, never queue), every TTS
// failure swallowed. Gated on settings.voiceMetric !== 'none' at the call
// site (no new setting) and fires ONLY on scored reps — never shadow reps.
// ---------------------------------------------------------------------------

function detectSpeechLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale && locale.length >= 2 ? locale : 'en-US';
  } catch {
    return 'en-US';
  }
}

/** Resolved once per process (useVoiceAnnouncements' SPEECH_OPTIONS shape). */
const SPEECH_OPTIONS: Speech.SpeechOptions = {
  language: detectSpeechLocale(),
  rate: 1.0,
  pitch: 1.0,
};

/** Replace-never-queue speak; a TTS failure can never take down the session. */
function speakCallout(text: string): void {
  try {
    void Speech.stop().catch(() => {});
    Speech.speak(text, SPEECH_OPTIONS);
  } catch (err) {
    console.warn('[formcheck] voice callout failed', err);
  }
}

/** Best-effort silence (leaving the live view / unmount). */
function stopSpeech(): void {
  try {
    void Speech.stop().catch(() => {});
  } catch {
    // Speech teardown must never crash on the way out.
  }
}

const COUNT_WORDS = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty',
];

/**
 * The spoken line for one SCORED rep: the count word plus AT MOST one flag,
 * ≤ 5 words total. Priority: a short follow-through (the highest-leverage
 * habit), then the shadow-baseline flags. A rep with nothing to flag is just
 * its number — the voice never nags a clean rep.
 */
export function repCallout(rep: FormCheckRep): string {
  const count = COUNT_WORDS[rep.index] ?? String(rep.index);
  const holdMs = FORM.followThrough.holdSec * 1000;
  if (rep.metrics.followThroughHeldMs != null && rep.metrics.followThroughHeldMs < holdMs) {
    return `${count} — hold the follow-through`;
  }
  if (rep.flags.includes('shallowDip')) return `${count} — sink the dip`;
  if (rep.flags.includes('stanceDrift')) return `${count} — reset your stance`;
  return count;
}

// ---------------------------------------------------------------------------
// Live-rail copy (pure, exported for the render tests)
// ---------------------------------------------------------------------------

/** ARM chip label — 'AUTO'/'ASSUMED' prefix per handSource, never "detected"
 *  for an abstained vote. A manual pick reads as the plain arm. */
export function armChipLabel(hand: ShootingHand, source: HandSource): string {
  const h = hand.toUpperCase();
  if (source === 'auto') return `AUTO ${h}`;
  if (source === 'manual') return `${h} ARM`;
  return `ASSUMED ${h}`;
}

/**
 * VIEW chip label — the buffer-orientation verdict, in four states.
 *
 * 'unknown' reads UNVERIFIED and never "upright": the detector abstained, the
 * keypoints are deliberately left uncorrected, and a green chip there would
 * be the screen claiming a check it never completed. A fired correction says
 * FLIP FIXED — a correction the user cannot see is a correction they cannot
 * overrule. A human's pick is marked MANUAL (armChipLabel's idiom: the
 * automatic call carries no badge, the human's does).
 */
export function orientationChipLabel(
  verdict: PoseOrientation,
  source: OrientationSource | null,
): string {
  if (verdict === 'unknown') return 'VIEW UNVERIFIED';
  const word = verdict === 'flipped' ? 'FLIP FIXED' : 'VIEW UPRIGHT';
  return source === 'manual' ? `${word} · MANUAL` : word;
}

/** Spoken form of {@link orientationChipLabel}, plus what the tap does. */
export function orientationChipHint(
  verdict: PoseOrientation,
  source: OrientationSource | null,
): string {
  if (verdict === 'unknown') {
    return 'Camera orientation unverified — the pose is left uncorrected. Tap if the skeleton is upside down.';
  }
  const what =
    verdict === 'flipped'
      ? 'Camera reads upside down, so the pose is corrected'
      : 'Camera reads upright, so the pose is used as captured';
  const who = source === 'manual' ? 'your pick' : 'auto-detected';
  return `${what} (${who}). Tap to flip it.`;
}

/**
 * FRAME-STALL WATCHDOG (pure, so it is testable off-device).
 *
 * `FormCheckSession` only ever recomputes its readiness inside `push()`, so a
 * pose loop that dies — a wedged interpreter, a frame processor the OS
 * stopped, a resizer that stopped returning — leaves the LAST verdict on the
 * rail forever. The failure the presenter sees is a frozen skeleton under a
 * green "28 FPS" chip and "Ready — shoot when you like."
 *
 * @param framesDelta Frames counted since the previous check (≤ 0 = none).
 * @param elapsedMs   Wall clock since the last frame actually arrived.
 * @param started     Has ANY frame arrived yet? A loop that has not started
 *                    is not stalled — "Starting the camera…" owns that state,
 *                    and arming before the first frame would call every cold
 *                    start a failure.
 */
export function frameStall(
  framesDelta: number,
  elapsedMs: number,
  started: boolean,
): boolean {
  if (!started) return false;
  return framesDelta <= 0 && elapsedMs >= FRAME_STALL_MS;
}

/**
 * EVERY-FRAME-FAILING DETECTOR (pure).
 *
 * The frame worklet advances its success counter only after a whole
 * resize → getPixelBuffer → runSync → parseMoveNet chain lands; anything that
 * throws is counted by the failure counter instead. A published model that
 * the delegate cannot actually Invoke throws on every frame, so the two
 * counters read (0 successes, N failures) — frames ARE arriving and every one
 * of them is dying, which is a diagnosis, not a warm-up.
 *
 * Deliberately keyed on `okFrames === 0`: "every frame is failing" is a
 * claim, and one frame that parsed is a counter-example. A loop that ran and
 * then started throwing stops ADVANCING the success counter, which is the
 * state {@link frameStall} already owns.
 *
 * @param okFrames     Frames that completed inference this run.
 * @param failedFrames Frames whose inference threw this run.
 */
export function inferenceFailing(okFrames: number, failedFrames: number): boolean {
  if (okFrames > 0) return false;
  return failedFrames >= INFERENCE_FAIL_FRAMES;
}

/**
 * NO-FIRST-FRAME BUDGET (pure).
 *
 * {@link frameStall} returns false for `started=false` BY CONTRACT, so a loop
 * that never produced a first frame can never be called stalled — correct for
 * that banner (it must not call every cold start a failure) and the reason
 * "no frame, ever" had no diagnosis at all. This is that diagnosis: a
 * distinct, LATER state that only speaks once a genuinely generous warm-up
 * budget has elapsed with nothing to show for it.
 *
 * @param started   Has ANY frame arrived this run?
 * @param elapsedMs Wall clock since the warm-up clock started — which the
 *                  caller runs only while a model is published, so the camera
 *                  is never blamed for the loader's seconds.
 */
export function noFirstFrame(started: boolean, elapsedMs: number): boolean {
  if (started) return false;
  return elapsedMs >= FIRST_FRAME_BUDGET_MS;
}

/**
 * NOBODY-IN-FRAME DETECTOR (pure) — the back camera facing the wrong way.
 *
 * The screen opens on the BACK sensor, which is right for the documented
 * protocol (phone propped at the shooter's side, screen turned away) and
 * exactly wrong for the way anyone smoke-tests a build: holding the phone and
 * looking at the screen. Then the sensor faces the room, MoveNet clears no
 * keypoint, and the rail says "Step back — head to feet in frame" — a message
 * about DISTANCE for a problem about FACING.
 *
 * The default is not changed here and must not be: propped-with-the-back-
 * camera is the protocol the runbook is written around. What changes is that
 * the mistake is now named and one tap from fixed.
 *
 * Both fractions, not just the body one: a shooter framed from the knees up
 * has `fullBodyFrac` at 0 and `armFrac` near 1, and "no one in frame" would
 * be a false statement about them. Only when nothing at all is being seen —
 * on the sensor that can be pointing away — does this speak.
 */
export function nobodyInFrame(
  r: FormCheckReadiness | null,
  camPosition: 'front' | 'back' | undefined,
): boolean {
  if (r == null || camPosition !== 'back') return false;
  if (r.fullBodyOk) return false;
  return r.fullBodyFrac <= EMPTY_FRAME_FRAC && r.armFrac <= EMPTY_FRAME_FRAC;
}

/**
 * The ONE action the banner may carry, by the same priority the banner text
 * uses — pure, so the pairing can be pinned off-device.
 *
 *  - `retryModel`   the loader gave up; re-run it.
 *  - `poseCpu`      a published model is throwing on every frame; reload it
 *                   without the accelerated rung (the suspect).
 *  - `flipCamera`   nothing is arriving, or nothing is in frame on the sensor
 *                   that can be facing away. One tap re-negotiates the
 *                   capture session on the other sensor AND turns the lens
 *                   around — the two failures it answers.
 *  - `countAnyway`  the measured rate is under the floor but above what the
 *                   core will accept an override for.
 *  - `countSideAnyway` the shooter is measurably squarer to the camera than
 *                   the side floor, in a room that will not let them stand
 *                   anywhere else. Counts the reps and refuses the angles.
 *
 * Every one of these is a RECOVERY, not a relaxation of a measurement: none
 * of them makes the screen claim a number it did not read. The two
 * `count…Anyway` kinds relax a gate, and both ride into the report marked
 * low-confidence ('lowPoseFps' / 'angledStance') — the side one additionally
 * refuses every 2D joint angle the yaw would distort, in the core.
 *
 * THE ORDER BELOW IS {@link guidanceBanner}'S ORDER, BRANCH FOR BRANCH. That
 * is the entire reason this decision lives in its own function: the two used
 * to diverge (`nobodyInFrame` sat above the fps gate here and below it
 * there), so a back camera pointed at a wall on a phone running 12 fps read
 * "Pose is at 12 fps — too slow" over a **Flip camera** button — and the fps
 * override silently vanished at exactly the moment it was needed. If a
 * branch is added to one function, add it to the other in the same place.
 */
export type BannerActionKind =
  | 'retryModel'
  | 'poseCpu'
  | 'flipCamera'
  | 'countAnyway'
  | 'countSideAnyway';

export function bannerActionKind(
  r: FormCheckReadiness | null,
  opts: {
    modelErr?: string | null;
    /** The camera session REPORTED a fault — see {@link cameraSessionBanner}. */
    cameraFault?: string | null;
    /** The pose model is not published yet (warm-up copy owns the rail). */
    modelLoaded?: boolean;
    /** See {@link inferenceFailing}. */
    inferenceFailing?: boolean;
    /** The accelerated rung is already dropped — there is nothing to switch
     *  to, so the only honest remaining move is another load. */
    poseCpuOnly?: boolean;
    /** No frame has arrived yet this run. */
    warming?: boolean;
    /** …and the warm-up budget is spent — see {@link noFirstFrame}. */
    noFirstFrame?: boolean;
    /** Frames STARTED and then stopped — see {@link frameStall}. */
    stalled?: boolean;
    camPosition?: 'front' | 'back';
    /** Calibration is collecting practice motions — the banner skips the arm
     *  branch there (calibration is what determines the arm), so this one
     *  must too or the side escape is unreachable in exactly the phase the
     *  presenter is stuck in. */
    collecting?: boolean;
  } = {},
): BannerActionKind | null {
  if (opts.modelErr != null) return 'retryModel';
  // A reported camera fault names an EXTERNAL fix ("close the other app",
  // "let it cool"): no button on this screen performs it, and a Flip camera
  // pill under that sentence would be a control that cannot clear it.
  if (opts.cameraFault != null) return null;
  if (opts.modelLoaded === false) return null;
  if (opts.inferenceFailing === true) {
    return opts.poseCpuOnly === true ? 'retryModel' : 'poseCpu';
  }
  if (r == null) return null;
  // Nothing has arrived yet: past the budget the flip is the one control that
  // rebuilds the capture session, and before it there is nothing to offer but
  // patience. `r.fps <= 0` mirrors the banner's own warm-up test.
  if (opts.warming === true || r.fps <= 0) {
    return opts.noFirstFrame === true ? 'flipCamera' : null;
  }
  // A stalled loop is not a rate to override — see the banner's own note.
  if (opts.stalled === true) return null;
  // The core refuses an override below FPS_OVERRIDE_MIN (no velocity sample
  // survives), so offering one there would be a promise the screen can't keep.
  // Either way this branch OWNS the state: the banner is talking about the
  // rate, so nothing below may answer it with a different button.
  if (!r.fpsOk) return r.fps >= FPS_OVERRIDE_MIN ? 'countAnyway' : null;
  if (nobodyInFrame(r, opts.camPosition)) return 'flipCamera';
  if (!r.fullBodyOk) return null;
  // The arm gate has its own control (the chip), not a banner pill.
  if (opts.collecting !== true && !r.armOk) return null;
  // The side gate is the one gate the shooter cannot always comply with —
  // the room decides where they may stand. See FormCheckSession.overrideSideFloor.
  if (!r.sideOk) return 'countSideAnyway';
  return null;
}

/** The live gauges the readiness chips draw, after the no-reading rule. */
export interface ChipGauges {
  fps: number;
  fpsOk: boolean;
  overridden: boolean;
  fullBodyOk: boolean;
  armOk: boolean;
  sideOk: boolean;
  /** The side gate is only passing because the presenter overrode it. */
  sideOverridden: boolean;
}

/**
 * Resolve the chip gauges from the last readiness verdict.
 *
 * THE RULE: a gauge may read green only when it is reading something RIGHT
 * NOW. `readiness` is a latched verdict from the last frame that arrived, so
 * whenever frames are not arriving, showing it is the rail asserting a
 * measurement it is not taking — the same over-claim the app refuses to make
 * about a basket.
 *
 * Two ways to have no reading, and both must be handled or the rule leaks:
 *  - STALLED: the loop died while the camera was nominally running.
 *  - WARMING: no frame has arrived yet this run. This is the COMMON one —
 *    returning from the background stops and restarts the capture session, so
 *    for the ~1s reacquire the verdict is pre-interruption and was rendering
 *    green underneath a banner that says the camera is starting.
 * Cold start needs no special case: `readiness` is null, so everything is
 * already amber.
 *
 * Pure so the rule can be pinned; the chips themselves are presentation.
 */
export function chipGauges(
  readiness: FormCheckReadiness | null,
  opts: { stalled?: boolean; warming?: boolean } = {},
): ChipGauges {
  const noReading = opts.stalled === true || opts.warming === true;
  return {
    fps: noReading ? 0 : (readiness?.fps ?? 0),
    fpsOk: !noReading && (readiness?.fpsOk ?? false),
    overridden: !noReading && readiness?.fpsOverridden === true,
    fullBodyOk: !noReading && (readiness?.fullBodyOk ?? false),
    armOk: !noReading && (readiness?.armOk ?? false),
    // Side-profile defaults OPEN (true) when unknown, so it must not turn
    // green just because nothing contradicted it while blind.
    sideOk: !noReading && (readiness?.sideOk ?? true),
    // An overridden gate is not a passing one — the fps chip's precedent.
    sideOverridden: !noReading && readiness?.sideOverridden === true,
  };
}

/**
 * The ONE guidance banner, chosen by priority: model error → camera fault →
 * model warmup → every-frame-failing → camera warmup (and, past its budget,
 * no-first-frame) → frame stall → fps → nobody-in-frame → full body → arm →
 * side-profile → low-confidence advisories → all clear.
 * {@link bannerActionKind} walks this exact list — keep them in step. Hard gates pause rep counting (the caller appends
 * the paused line); the advisories never pause — the capture is degraded,
 * not refused, and the honest move is to say so and keep counting.
 * While `collecting`, the arm branch is skipped (calibration is what
 * determines the arm) and no tilt exists yet.
 *
 * V3 adds `opts` as a TRAILING optional argument on purpose: every existing
 * five-argument call site (and its pinned test) keeps compiling and keeps
 * its exact string.
 */
export function guidanceBanner(
  modelLoaded: boolean,
  r: FormCheckReadiness | null,
  hand: ShootingHand,
  calib: CalibrationState | null,
  collecting: boolean,
  opts: {
    /** Both loader rungs failed (or the watchdog fired) — Retry is offered. */
    modelErr?: string | null;
    /**
     * The camera session REPORTED a fault (an `onError`, or an interruption
     * that stops THIS screen's capture) — {@link cameraSessionBanner} already
     * turned it into the one line that names the fix. Ahead of the model
     * warm-up because it outlives it: a camera another app is holding does
     * not start when the loader finishes.
     */
    cameraFault?: string | null;
    /** Frames are arriving and EVERY one is throwing — {@link inferenceFailing}. */
    inferenceFailing?: boolean;
    /** The accelerated rung is already dropped — there is no CPU left to
     *  switch to, and saying otherwise would be an offer the screen can't
     *  keep. */
    poseCpuOnly?: boolean;
    /** No camera frame has arrived yet. */
    warming?: boolean;
    /** …and the warm-up budget is spent — see {@link noFirstFrame}. */
    noFirstFrame?: boolean;
    /** Frames STARTED and then stopped — see {@link frameStall}. */
    stalled?: boolean;
    /** Front camera in a dim room has a recovery the presenter can perform. */
    camPosition?: 'front' | 'back';
  } = {},
): { text: string; pauses: boolean } | null {
  if (opts.modelErr != null) {
    return { text: "The pose model didn't load — tap Retry.", pauses: true };
  }
  if (opts.cameraFault != null) return { text: opts.cameraFault, pauses: true };
  if (!modelLoaded) return { text: 'Warming up the pose model…', pauses: true };
  // A model that loaded and then throws on every single frame outranks the
  // warm-up copy, because it IS what the warm-up copy was hiding: the counter
  // it is keyed off can never move, so "Starting the camera…" would own the
  // rail for the whole session. Ahead of the null-readiness return too — a
  // dead frame path is worth saying with or without a session to poll.
  if (opts.inferenceFailing === true) {
    return {
      text:
        opts.poseCpuOnly === true
          ? "The pose model isn't running — tap Retry."
          : "The pose model isn't running — tap Switch to CPU.",
      pauses: true,
    };
  }
  if (r == null) return null;
  // "No data yet" is NOT "measured and too slow". Blaming the room's light
  // before a single frame has landed is the first thing the audience reads.
  if (opts.warming === true || r.fps <= 0) {
    // A DISTINCT, later state — never a widening of the line above it. Cold
    // starts keep "Starting the camera…" for as long as the budget allows;
    // only a warm-up that has run out of budget with nothing to show gets
    // called anything else.
    if (opts.noFirstFrame === true) {
      return {
        text: 'No camera frames yet — tap Flip camera to try the other one.',
        pauses: true,
      };
    }
    return { text: 'Starting the camera…', pauses: true };
  }
  // Ahead of every readiness gate below, because those gates are reading a
  // verdict that stopped updating: `readiness` is only recomputed inside
  // push(), so a stalled loop makes each of them report the last live frame
  // as if it were the current one. A stale green gate outranked by nothing is
  // the screen claiming a measurement it is no longer taking.
  if (opts.stalled === true) {
    return { text: 'No camera frames — the pose loop stalled.', pauses: true };
  }
  if (!r.fpsOk) {
    return {
      text:
        opts.camPosition === 'front'
          ? `Pose is at ${Math.round(r.fps)} fps — too slow. Tap flip for the back camera.`
          : `Pose is at ${Math.round(r.fps)} fps — too slow. More light helps.`,
      pauses: true,
    };
  }
  // Ahead of "Step back", because it is the same gate failing for a reason
  // stepping back cannot fix: on the BACK sensor with nothing at all in
  // frame, the likeliest truth is that the lens is pointing away from the
  // person reading this. See {@link nobodyInFrame}.
  if (nobodyInFrame(r, opts.camPosition)) {
    return { text: 'No one in frame — tap Flip camera if it faces away.', pauses: true };
  }
  if (!r.fullBodyOk) return { text: 'Step back — head to feet in frame.', pauses: true };
  if (!collecting && !r.armOk) {
    return { text: `Can't see your ${hand} arm — tap the arm chip to flip.`, pauses: true };
  }
  if (!r.sideOk) {
    return {
      text:
        r.sideness != null && r.sideness < SIDE_TURN_HINT
          ? 'Stand side-on — turn 90°.'
          : 'Turn a little more side-on.',
      pauses: true,
    };
  }
  // — advisories: counting continues, confidence is stated —
  if (r.fpsOverridden === true) {
    return {
      text: `Counting below the ${MIN_POSE_FPS} fps floor — timing numbers are low-confidence.`,
      pauses: false,
    };
  }
  // The side twin, and it must NOT borrow the "read low" wording below: under
  // the override the core does not report a small angle, it REFUSES the angle
  // (a 'stanceNotSideOn' refusal on elbow, knee and follow-through). Saying
  // they read low would describe a measurement nobody took.
  if (r.sideOverridden === true) {
    return {
      text: 'Counting square to the camera — elbow and knee angles are not read.',
      pauses: false,
    };
  }
  // Measured-but-angled: the gate passes at SIDE_PROFILE_MIN, the ANGLES do
  // not survive the same tolerance. An unmeasurable stance (sideness null)
  // says nothing either way and earns no claim.
  if (r.sideTrusted === false && r.sideness != null) {
    return { text: 'Angled to the camera — elbow and knee angles read low.', pauses: false };
  }
  const tilt = calib?.tilt;
  if (tilt != null && Math.abs(tilt.tiltDeg) > TILT_MAX_COMP_DEG) {
    return { text: 'Straighten the phone.', pauses: false };
  }
  return null;
}

/** Short chip word per low-confidence reason (rep rows + the report banner). */
const CONFIDENCE_WORD: Record<RepConfidenceReason, string> = {
  lowPoseFps: 'low pose fps',
  gateDropout: 'landmarks dropped',
  angledStance: 'angled stance',
};

/** What each reason actually costs, in plain words. */
const CONFIDENCE_REASON: Record<RepConfidenceReason, string> = {
  lowPoseFps: `pose ran under ${MIN_POSE_FPS} fps, so tempo and phase timing are coarse`,
  gateDropout: 'landmarks dropped mid-motion, so some numbers are missing',
  angledStance: 'the stance was angled to the camera, so 2D angles read low',
};

/**
 * The report's low-confidence line, or null when every counted rep had a
 * clean capture. The core relaxed its gates so the demo could happen; this
 * is the other half of that bargain — the reps are real, their numbers are
 * worth less, and the report says which and why.
 */
export function lowConfidenceLine(report: FormCheckSessionReport): string | null {
  const lc = report.lowConfidence;
  if (lc == null || lc.reps <= 0 || lc.reasons.length === 0) return null;
  const why = lc.reasons.map((k) => CONFIDENCE_REASON[k]).join('; ');
  const which =
    lc.reps === report.repCount
      ? `All ${lc.reps} ${lc.reps === 1 ? 'rep was' : 'reps were'}`
      : `${lc.reps} of ${report.repCount} reps were`;
  return `${which} caught under a relaxed gate — ${why}. Really measured, just lower-confidence.`;
}

// ---------------------------------------------------------------------------
// Report math helpers (pure, exported for the render tests)
// ---------------------------------------------------------------------------

/** Median of a numeric list (null when empty). */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The hero verdict headline — honest at every rep count. */
export function verdictHeadline(report: FormCheckSessionReport): string {
  if (report.repCount < MIN_SPREAD_REPS) {
    const need = MIN_SPREAD_REPS - report.repCount;
    return `Need ${need} more ${need === 1 ? 'rep' : 'reps'}`;
  }
  const { steady, measured } = report.verdict;
  if (measured === 0) return 'No consistency read';
  if (steady === measured) return 'Steady session';
  return `${measured - steady} of ${measured} drifting`;
}

/** Per-phase median + min/max across the session's reps (nulls abstain). */
export function sessionPhaseStats(reps: readonly FormCheckRep[]): {
  median: RepPhaseTiming;
  min: RepPhaseTiming;
  max: RepPhaseTiming;
  measured: number;
} {
  const keys = ['dipMs', 'riseMs', 'releaseMs', 'followMs'] as const;
  const median: RepPhaseTiming = { dipMs: null, riseMs: null, releaseMs: null, followMs: null };
  const min: RepPhaseTiming = { dipMs: null, riseMs: null, releaseMs: null, followMs: null };
  const max: RepPhaseTiming = { dipMs: null, riseMs: null, releaseMs: null, followMs: null };
  let measured = 0;
  for (const k of keys) {
    const vals: number[] = [];
    for (const r of reps) {
      const v = r.phases[k];
      if (v != null) vals.push(v);
    }
    if (vals.length === 0) continue;
    measured++;
    median[k] = medianOf(vals);
    min[k] = Math.min(...vals);
    max[k] = Math.max(...vals);
  }
  return { median, min, max, measured };
}

/**
 * The persisted row for one finished session (write time is the only chance
 * to capture bestRepJson). summaryJson carries per-rep metrics + phases +
 * flags but NO sequences — exactly ONE encoded sequence rides in bestRepJson,
 * so a marathon session's row stays bounded.
 *
 * The relaxed-gate receipt (`lowConfidence`, per rep AND session-level) is
 * written HERE for the same reason the live report shows it: saving a
 * session must not launder it. Without these two keys a run the presenter
 * counted at 11 fps would reappear in the Coach receipt and the tempo trend
 * indistinguishable from a clean check. See core `savedLowConfidenceOf`.
 */
export function formSessionRowOf(
  report: FormCheckSessionReport,
  reps: readonly FormCheckRep[],
  ts: number,
): Omit<FormSessionFullRow, 'id'> {
  const calib = report.calibration;
  const heights: number[] = [];
  for (const r of reps) if (r.releaseHeightM != null) heights.push(r.releaseHeightM);
  const summary = {
    reps: reps.map((r) => ({
      index: r.index,
      metrics: r.metrics,
      phases: r.phases,
      flags: r.flags,
      /** Why this rep's numbers are worth less. Empty = clean capture. */
      lowConfidence: r.lowConfidence ?? [],
      releaseHeightM: r.releaseHeightM,
      tips: r.tips.map((t) => t.title),
    })),
    spreads: report.spreads,
    best: report.best,
    verdict: report.verdict,
    /** Session-level relaxed-gate receipt — the half saved-session surfaces
     *  read back (they never page the per-rep array). */
    lowConfidence: report.lowConfidence ?? { reps: 0, reasons: [] },
    calibration: calib,
    /** The archetype the report screen scores similarity against by default. */
    similarityArchetype: PLAYER_ARCHETYPES[0]!.name,
  };
  const bestRep =
    report.best != null ? reps.find((r) => r.index === report.best!.index) ?? null : null;
  return {
    ts,
    hand: calib.hand,
    handSource: calib.handSource,
    repCount: report.repCount,
    medianPoseFps: report.medianPoseFps,
    elbowSpreadDeg: report.spreads.setPointElbowSpreadDeg.value,
    tempoSpreadMs: report.spreads.tempoSpreadMs.value,
    kneeSpreadDeg: report.spreads.kneeSpreadDeg.value,
    releaseHeightSpread: report.spreads.releaseHeightSpread.value,
    releaseHeightM: medianOf(heights),
    tiltDeg: calib.tilt?.confident ? calib.tilt.tiltDeg : null,
    summaryJson: JSON.stringify(summary),
    bestRepJson:
      bestRep != null && bestRep.sequence != null
        ? JSON.stringify({
            index: bestRep.index,
            metrics: bestRep.metrics,
            tips: bestRep.tips,
            sequence: bestRep.sequence,
          })
        : null,
  };
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function FormCheckScreen() {
  useKeepAwake();
  const reducedMotion = useReducedMotion();
  const settingsHand = useSettings((s) => s.shootingHand);
  // Canonical height source: the PROFILE (settingsStore.playerHeightCm is the
  // legacy key — reading it would resurrect the split-brain settings.tsx fixed).
  const heightCm = useProfile((s) => s.heightCm);

  const [phase, setPhase] = useState<CheckPhase>('guide');
  /**
   * BACK by default. The capture protocol props the phone at the shooter's
   * side 2–4 m away, screen turned away — the front preview was never
   * readable from there, and the back sensor is the better one. The flip pill
   * stays, so a front capture is still one tap away.
   */
  const [camPosition, setCamPosition] = useState<'front' | 'back'>('back');
  // Screen-local watched arm — seeded from Settings, never written back.
  // Kept in sync BOTH ways: a manual flip pushes into the session, and the
  // session's auto-handedness commit (at calibration lock) syncs back here.
  const [hand, setHand] = useState<ShootingHand>(settingsHand);
  const [repCount, setRepCount] = useState(0);
  const [lastRep, setLastRep] = useState<FormCheckRep | null>(null);
  const [reps, setReps] = useState<readonly FormCheckRep[]>([]);
  const [report, setReport] = useState<FormCheckSessionReport | null>(null);
  /** null = save in flight, ≥0 = row id, −1 = insert failed (stay honest). */
  const [savedId, setSavedId] = useState<number | null>(null);

  const sessionRef = useRef<FormCheckSession | null>(null);
  const latestRef = useRef<FormPoseSample | null>(null);
  const handRef = useRef<ShootingHand>(settingsHand);
  /**
   * Which session's auto-save the report is allowed to believe. The screen no
   * longer unmounts between runs (Check again / Restart), so a slow insert
   * from the PREVIOUS session could otherwise land on the NEXT session's
   * report and stamp it "Saved on this phone" against a row that is not it.
   */
  const saveTokenRef = useRef(0);
  /**
   * Buffer-orientation verdict for THIS camera session. Held in a ref, not
   * state: it is fed on the JS-side sink at frame rate (the worklet hands
   * every sample over with scheduleOnRN), and the rail polls its snapshot at
   * 4 Hz like everything else on this screen.
   */
  const orientRef = useRef<PoseOrientationDetector>(new PoseOrientationDetector());
  /** True while the sink is actively correcting frames. See the rebuild. */
  const correctingRef = useRef(false);
  /**
   * Height for a session the SINK has to rebuild. A ref because the sink is
   * deliberately dependency-free — a re-render must never re-arm the camera
   * loop — so it cannot close over the profile value.
   */
  const heightRef = useRef<number | null>(heightCm ?? null);
  useEffect(() => {
    heightRef.current = heightCm ?? null;
  }, [heightCm]);
  /**
   * Has something STRONGER than the Settings default decided the arm — a
   * manual chip flip, or the session's own auto-handedness commit? Both are
   * statements about the shooter; the rehydration sync below must never
   * overwrite one.
   */
  const handPinnedRef = useRef(false);
  /**
   * The settings store persists through expo-sqlite and rehydrates
   * ASYNCHRONOUSLY, so the two seeds above run on first render against the
   * built-in 'right' default and a left-handed user's saved pick lands after
   * them — every angle, phase timing and spread of the session, plus the
   * persisted hand column, then describes the arm they don't shoot with.
   * Re-sync from the store, exactly as heightRef does above.
   *
   * Gated on 'guide': mid-session this would desync sessionRef's watched arm
   * from handRef and split one report across two arms. The guide is the only
   * phase where nothing is being measured.
   */
  useEffect(() => {
    if (phase !== 'guide' || handPinnedRef.current) return;
    handRef.current = settingsHand;
    setHand(settingsHand);
  }, [phase, settingsHand]);
  /** A space change threw this session away — the stepper says so. */
  const [viewReset, setViewReset] = useState(false);

  /**
   * The verdict committing is a COORDINATE-SPACE CHANGE, not just a picture
   * fix: from that frame on the session is fed numbers in a different space
   * from everything before it. Nothing the old session holds survives it —
   * the locked set-point wrist y and the standing baseline would be compared
   * across spaces (a ~28 px phantom difference on a 144 px body, enough to
   * flag `shallowDip` on every rep of the session), the 2 s rolling window
   * would straddle both, and any rep already scored was scored upside down.
   * So the session is REBUILT rather than patched: in the flipped case
   * everything it held was garbage anyway, and discarding it is the only
   * move that cannot leave a mixed-space number on the report.
   *
   * The human's ARM pick is the one thing carried over: it is a statement
   * about the shooter, not about the buffer.
   */
  const rebuildForSpaceChange = useCallback(() => {
    const old = sessionRef.current;
    if (old == null) return;
    const manualHand = old.calibration.handSource === 'manual';
    const next = new FormCheckSession({
      hand: handRef.current,
      frameHeight: POSE_INPUT,
      heightCm: heightRef.current,
    });
    if (manualHand) next.setHand(handRef.current, 'manual');
    sessionRef.current = next;
    setRepCount(0);
    setLastRep(null);
    setViewReset(true);
  }, []);

  const sink = useCallback((s: FormPoseSample) => {
    // THE PARSE BOUNDARY. A 180°-rotated buffer hands MoveNet an upside-down
    // person, and then EVERY number downstream is computed on flipped
    // coordinates — release height is a signed ankle−wrist difference, the
    // dip walks the wrist y hunting an extremum, knee flexion and tilt read
    // the ankle→hip→shoulder line. Correcting once here, before the session
    // and before latestRef, is what keeps the drawing and the metrics from
    // ever disagreeing. It must NOT move into mapKeypoint: that fixes the
    // picture and leaves the analysis running upside down.
    const verdict = orientRef.current.push(s.pose);
    const fixed = correctPoseFrame(s.pose, verdict, POSE_SQUARE);
    // Same reference back = nothing to correct (upright, or not yet
    // verified) — keep the original sample rather than reallocating it.
    const correcting = fixed !== s.pose;
    const sample = correcting ? { ...s, pose: fixed } : s;
    latestRef.current = sample;
    // The flag CHANGING is the space change — in either direction, and from
    // an auto commit or a manual override alike. Rebuild before this frame
    // is pushed, so the new session's first frame is its first frame.
    if (correcting !== correctingRef.current) {
      correctingRef.current = correcting;
      rebuildForSpaceChange();
    }
    const session = sessionRef.current;
    if (session == null) return;
    const rep = session.push(sample.pose);
    // Auto-handedness may flip the watched arm at calibration lock — mirror
    // it into screen state WITHOUT calling setHand back into the session
    // (that would read as a manual pick and disable the vote).
    if (session.hand !== handRef.current) {
      handRef.current = session.hand;
      // A measured verdict about the shooter outranks the Settings default —
      // returning to the guide must not undo it.
      handPinnedRef.current = true;
      setHand(session.hand);
    }
    if (rep != null) {
      // Scored reps only (shadow reps return null): success for a clean rep,
      // a plain tick otherwise — both through the settings-gated gateway.
      if (rep.tips.length === 0) haptic.success();
      else haptic.impactMedium();
      if (useSettings.getState().voiceMetric !== 'none') {
        speakCallout(repCallout(rep));
      }
      setRepCount(session.reps.length);
      setLastRep(rep);
    }
    // rebuildForSpaceChange is itself dependency-free, so the sink identity
    // is still stable for the life of the screen and the camera loop is
    // never re-armed by a re-render.
  }, [rebuildForSpaceChange]);

  const live = phase === 'live';
  const pose = useFormPose(live, camPosition, sink);

  /**
   * A camera change can change the buffer's orientation, so the latched
   * verdict must never survive one — including a MANUAL one, which was made
   * about the other sensor. Runs on mount too, where it is a no-op.
   */
  useEffect(() => {
    orientRef.current.reset();
  }, [camPosition]);

  /**
   * Start (or restart) a live session IN PLACE. The screen never unmounts, so
   * the loaded + warmed TensorflowModel and its boxed SharedValue survive —
   * a second take costs zero warm-up. Clears the previous report so the
   * report early-return cannot flash stale numbers on the way through.
   */
  const startLive = useCallback(() => {
    handRef.current = hand;
    sessionRef.current = new FormCheckSession({
      hand,
      frameHeight: POSE_INPUT,
      heightCm: heightCm ?? null,
    });
    latestRef.current = null;
    // A fresh session re-decides the orientation from scratch: the previous
    // run's latch (auto or manual) says nothing about how this one is framed.
    orientRef.current.reset();
    // The reset detector emits uncorrected frames again, so the sink's space
    // flag has to start there too — otherwise the first frame of the new
    // session would read as a space change and rebuild it immediately.
    correctingRef.current = false;
    setViewReset(false);
    saveTokenRef.current++;
    setRepCount(0);
    setLastRep(null);
    setReport(null);
    setReps([]);
    setSavedId(null);
    setPhase('live');
    haptic.impactMedium();
  }, [hand, heightCm]);

  const cancelLive = useCallback(() => {
    sessionRef.current = null;
    stopSpeech();
    setPhase('guide');
  }, []);

  const endSession = useCallback(() => {
    const session = sessionRef.current;
    if (session == null) return;
    const sessionReport = session.finalizeSession();
    const sessionReps = session.reps.slice();
    setReport(sessionReport);
    setReps(sessionReps);
    sessionRef.current = null;
    stopSpeech();
    haptic.success();
    setSavedId(null);
    setPhase('report');
    // Auto-save (insertJump precedent). safe() already degrades any failure
    // to −1, so this can never throw — the report renders its honest state.
    // Gated on ≥1 scored rep: a 0-rep abort is not a receipt and must never
    // persist a row (or flip the Coach card's NEW promo). Defense-in-depth —
    // the End session pill is already disabled at zero reps.
    if (sessionReport.repCount > 0) {
      const token = ++saveTokenRef.current;
      void insertFormSession(formSessionRowOf(sessionReport, sessionReps, Date.now())).then(
        (id) => {
          // A restart happened while this insert was in flight — the row is
          // still saved, it just isn't THIS report's receipt any more.
          if (saveTokenRef.current !== token) return;
          setSavedId(id);
        },
      );
    }
  }, []);

  const flipHand = useCallback(() => {
    const next: ShootingHand = handRef.current === 'right' ? 'left' : 'right';
    handRef.current = next;
    // The human's pick outranks the Settings default for the rest of the
    // screen — the guide-phase re-sync must not walk it back.
    handPinnedRef.current = true;
    // A manual pick wins permanently for the session and disables auto.
    sessionRef.current?.setHand(next, 'manual');
    setHand(next);
    haptic.selection();
  }, []);

  const recalibrate = useCallback(() => {
    sessionRef.current?.recalibrate();
    // This trip through collecting was ASKED for, so the stepper must stop
    // blaming the view fix for it.
    setViewReset(false);
    haptic.selection();
  }, []);

  /**
   * The human override, one tap: the presenter's call wins and LATCHES over
   * the detector's (`override` marks it manual, and a latched verdict stops
   * every later vote). From 'unknown' it asserts FLIPPED — the only reason
   * anyone reaches for this control is a skeleton standing on its head that
   * the detector has not committed on yet.
   */
  const flipOrientation = useCallback(() => {
    const det = orientRef.current;
    det.override(det.verdict === 'flipped' ? 'upright' : 'flipped');
    haptic.selection();
  }, []);

  // Silence any in-flight callout on the way out.
  useEffect(() => stopSpeech, []);

  const cardEnter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(360);

  // Camera permission gate. NOT conditioned on a device object existing:
  // useCameraDevice can return null until permission is granted, and the old
  // `device != null && …` form left a fresh install with a black live view,
  // no system prompt and no way into one.
  const needsPermission = !pose.hasPermission;

  if (phase === 'report' && report != null) {
    return (
      <Screen scroll>
        <View style={styles.stack}>
          <Row style={styles.header}>
            <BackPill />
          </Row>
          <FormCheckReport
            reps={reps}
            report={report}
            hand={hand}
            savedId={savedId}
            heightCm={heightCm ?? null}
            onAgain={startLive}
            onDone={() => router.back()}
          />
        </View>
      </Screen>
    );
  }

  // The live view is its OWN root, not an absolute child of the guide's
  // ScrollView. Inside the scroller its absoluteFill resolved against a
  // content box ~1000pt tall, so Zone A — the calibration stepper and every
  // guidance banner — rendered above the viewport and the presenter never saw
  // it. As a bonus the guide's cards and Skia diagram unmount while the
  // camera and MoveNet run.
  if (live) {
    return (
      <View style={styles.liveRoot}>
        <LiveOverlay
          pose={pose}
          needsPermission={needsPermission}
          camPosition={camPosition}
          onFlipCamera={() =>
            setCamPosition((p) => (p === 'front' ? 'back' : 'front'))
          }
          hand={hand}
          onFlipHand={flipHand}
          onRecalibrate={recalibrate}
          latestRef={latestRef}
          sessionRef={sessionRef}
          orientRef={orientRef}
          onFlipOrientation={flipOrientation}
          viewReset={viewReset}
          repCount={repCount}
          lastRep={lastRep}
          onEnd={endSession}
          onRestart={startLive}
          onCancel={cancelLive}
        />
      </View>
    );
  }

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <Row style={styles.header}>
          <BackPill />
        </Row>

        <View>
          <Text style={styles.kicker}>FORM CHECK</Text>
          <Text style={styles.title} accessibilityRole="header">
            Check your shooting motion
          </Text>
        </View>

        {/* Hero promise */}
        <Card entering={cardEnter(0)}>
          <SectionEyebrow icon="body-outline">No hoop needed</SectionEyebrow>
          <Text style={styles.heroLead}>
            The phone reads your shooting motion and scores your mechanics rep
            by rep.
          </Text>
          <Text style={styles.body}>
            Elbow set point, knee bend, dip-to-release tempo, follow-through
            and release height — from your body alone. Motion only: it never
            claims a make or a miss, because it never sees a ball.
          </Text>
        </Card>

        {/* Placement */}
        <Card entering={cardEnter(1)}>
          <SectionEyebrow icon="scan-outline">Where to put the phone</SectionEyebrow>
          <PlacementDiagram />
          <PlacementRule
            n={1}
            // Camera, not screen: the check now opens on the BACK sensor, so
            // the screen faces away and cannot be read from 2–4 m anyway.
            text="Prop the phone at your SIDE, on your shooting-arm side, camera pointing at you."
          />
          <PlacementRule
            n={2}
            text="2–4 m away. Your WHOLE body — head to feet — must be in frame. Closer than that and the phone can't see your legs; it will refuse to count."
          />
          <PlacementRule n={3} text="Stand side-on to the camera, in profile." />
          <PlacementRule
            n={4}
            text={`Take ${SHADOW_REPS_TARGET} practice motions first — they calibrate the check and are never scored.`}
          />
          <Text style={styles.footnote}>
            Form Check counts shooting MOTIONS, deliberately sensitively — a
            raised arm can count. Needs at least {MIN_POSE_FPS} fps pose;
            below that the screen refuses to count reps rather than guess.
          </Text>
        </Card>

        {/* Permission is requested at mount; this is the DENIED path, on the
            guide where there is time to fix it — never mid-demo. */}
        {needsPermission && (
          <PillButton
            label={
              pose.canRequestPermission
                ? 'Allow camera access'
                : 'Open settings for camera access'
            }
            icon="camera-outline"
            variant="ghost"
            onPress={() =>
              pose.canRequestPermission
                ? void pose.requestPermission().catch(() => {})
                : void Linking.openSettings()
            }
          />
        )}

        <PillButton
          label="Start form check"
          icon="body-outline"
          onPress={startLive}
          style={styles.startCta}
        />
      </View>
    </Screen>
  );
}

function PlacementRule({ n, text }: { n: number; text: string }) {
  return (
    <Row gap={space.sm} style={styles.ruleRow}>
      <View style={styles.ruleBadge}>
        <Text style={styles.ruleBadgeText}>{n}</Text>
      </View>
      <Text style={[styles.body, { flex: 1 }]}>{text}</Text>
    </Row>
  );
}

/** Static placement sketch: phone at the side, shooter 2–4 m away, side-on. */
function PlacementDiagram() {
  const w = 260;
  const h = 96;
  const ground = h - 14;
  return (
    <View style={styles.diagramWrap}>
      <Canvas style={{ width: w, height: h }}>
        {/* Ground */}
        <Line
          p1={vec(8, ground)}
          p2={vec(w - 8, ground)}
          strokeWidth={1}
          color={color.border}
        />
        {/* Phone glyph (propped, at the side) */}
        <Line p1={vec(24, ground)} p2={vec(24, ground - 34)} strokeWidth={6} color={color.accent} />
        {/* Dashed distance line */}
        {Array.from({ length: 9 }, (_, i) => (
          <Line
            key={i}
            p1={vec(40 + i * 16, ground - 16)}
            p2={vec(48 + i * 16, ground - 16)}
            strokeWidth={1.5}
            color={color.textFaint}
          />
        ))}
        {/* Stick shooter, side-on */}
        <Circle cx={206} cy={ground - 62} r={7} style="stroke" strokeWidth={2.5} color={color.text} />
        <Line p1={vec(206, ground - 55)} p2={vec(206, ground - 26)} strokeWidth={2.5} color={color.text} />
        <Line p1={vec(206, ground - 46)} p2={vec(220, ground - 60)} strokeWidth={2.5} color={color.text} />
        <Line p1={vec(206, ground - 26)} p2={vec(198, ground)} strokeWidth={2.5} color={color.text} />
        <Line p1={vec(206, ground - 26)} p2={vec(214, ground)} strokeWidth={2.5} color={color.text} />
      </Canvas>
      <Text style={styles.diagramLabel}>2–4 m, side-on, whole body in frame</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Live overlay — Zone A rail, Zone B camera+skeleton, Zone C rep + actions.
// ---------------------------------------------------------------------------

function LiveOverlay({
  pose,
  needsPermission,
  camPosition,
  onFlipCamera,
  hand,
  onFlipHand,
  onRecalibrate,
  latestRef,
  sessionRef,
  orientRef,
  onFlipOrientation,
  viewReset,
  repCount,
  lastRep,
  onEnd,
  onRestart,
  onCancel,
}: {
  pose: ReturnType<typeof useFormPose>;
  needsPermission: boolean;
  camPosition: 'front' | 'back';
  onFlipCamera: () => void;
  hand: ShootingHand;
  onFlipHand: () => void;
  onRecalibrate: () => void;
  latestRef: React.MutableRefObject<FormPoseSample | null>;
  sessionRef: React.MutableRefObject<FormCheckSession | null>;
  orientRef: React.MutableRefObject<PoseOrientationDetector>;
  onFlipOrientation: () => void;
  /** This session was rebuilt because the pose coordinate space changed. */
  viewReset: boolean;
  repCount: number;
  lastRep: FormCheckRep | null;
  onEnd: () => void;
  /** Fresh session, still live — the one-tap recovery from any stumble. */
  onRestart: () => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  /** "Hold to recalibrate" — a tap must not silently reset the session. */
  const [holdHint, setHoldHint] = useState(false);
  useEffect(() => {
    if (!holdHint) return undefined;
    const id = setTimeout(() => setHoldHint(false), 1600);
    return () => clearTimeout(id);
  }, [holdHint]);

  // Permission overlay — jump.tsx's MeasureOverlay branch, same promise.
  if (needsPermission) {
    return (
      <View style={styles.overlay}>
        <View style={styles.overlayContent}>
          <Text style={styles.overlayTitle}>Camera access needed</Text>
          <Text style={styles.overlaySub}>
            Form Check watches your body to count reps and read your shooting
            mechanics. Everything stays on this phone.
          </Text>
          <PillButton
            label={pose.canRequestPermission ? 'Allow camera access' : 'Open settings'}
            onPress={() =>
              pose.canRequestPermission
                ? void pose.requestPermission()
                : void Linking.openSettings()
            }
            style={styles.overlayCta}
          />
          <PillButton label="Cancel" variant="ghost" onPress={onCancel} />
        </View>
      </View>
    );
  }

  // Permission granted but no camera enumerated (an iPad, a hardware hiccup,
  // an enumeration still in flight). Previously this rendered a black scrim
  // whose only content was a rail blaming the room's lighting.
  if (pose.device == null) {
    return (
      <View style={styles.overlay}>
        <View style={styles.overlayContent}>
          <Text style={styles.overlayTitle}>No camera available</Text>
          <Text style={styles.overlaySub}>
            This phone reported no usable camera, so there is nothing to read a
            shooting motion from.
          </Text>
          <PillButton label="Cancel" variant="ghost" onPress={onCancel} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.overlay}>
      <Camera
        style={StyleSheet.absoluteFill}
        // Stop cleanly across a background transition instead of being
        // interrupted mid-flight and coming back black (live.tsx's contract).
        isActive={pose.foreground}
        device={pose.device}
        outputs={pose.outputs}
        // Pin the frame duration. Left unconstrained, AVFoundation is free to
        // stretch exposure indoors and drop capture toward 15-20 fps — which
        // this screen's own MIN_POSE_FPS floor then reads as a refusal the
        // presenter cannot act on. A darker image is a far cheaper price than
        // a session that will not count.
        constraints={[{ fps: 30 }]}
        // Never trade frame rate for exposure (the library's default, stated
        // here because the fps floor is load-bearing on this screen).
        enableLowLightBoost={false}
        resizeMode="contain"
        orientationSource="interface"
        // THE SESSION'S OWN CHANNEL. Left unpassed, every one of these fell
        // to the library default (a console.error) and a camera that never
        // came up was indistinguishable from one still warming up. See
        // useFormPose's session-channel note and src/core/cameraSession.ts.
        onConfigured={pose.onCameraConfigured}
        onStarted={pose.onCameraStarted}
        onStopped={pose.onCameraStopped}
        onError={pose.onCameraError}
        onInterruptionStarted={pose.onCameraInterruptionStarted}
        onInterruptionEnded={pose.onCameraInterruptionEnded}
      />
      {/* Zone B: presentation-only skeleton — a front preview is mirrored, so
          the overlay x-flips to match. Never feeds metrics. Nothing else may
          overlap the body. */}
      <SkeletonOverlay
        latestRef={latestRef}
        mirrored={camPosition === 'front'}
        hand={hand}
      />
      <View style={styles.liveScrim} pointerEvents="box-none">
        {/* Zone A: ONE strip — calibration stepper or chip row + one banner. */}
        <LiveRail
          sessionRef={sessionRef}
          modelLoaded={pose.modelLoaded}
          modelErr={pose.modelErr}
          onRetryModel={pose.retryModel}
          onPoseCpu={pose.usePoseCpu}
          poseCpuOnly={pose.poseCpuOnly}
          framesSv={pose.framesSv}
          failedSv={pose.failedSv}
          camSession={pose.camSession}
          camPosition={camPosition}
          onFlipCamera={onFlipCamera}
          onFlipHand={onFlipHand}
          orientRef={orientRef}
          onFlipOrientation={onFlipOrientation}
          viewReset={viewReset}
        />
        {/* Zone C: the big rep numeral, the last-rep phase line, actions. */}
        <View
          style={[styles.liveBottom, { paddingBottom: insets.bottom + space.lg }]}
          pointerEvents="box-none"
        >
          <View style={styles.repBlock}>
            <Text style={styles.repBig}>{repCount}</Text>
            <Text style={styles.repLabel}>REPS DETECTED</Text>
            {lastRep != null && (
              <Animated.View
                key={lastRep.index}
                entering={FadeIn.reduceMotion(ReduceMotion.System)}
                style={styles.lastRepRow}
              >
                <Text style={styles.lastRepText}>{`REP ${lastRep.index}`}</Text>
                <PhaseBars phases={lastRep.phases} width={168} compact />
              </Animated.View>
            )}
          </View>
          <Row gap={space.sm} style={styles.liveActions}>
            <Pressable
              onPress={onFlipCamera}
              accessibilityRole="button"
              accessibilityLabel={`Switch to the ${camPosition === 'front' ? 'back' : 'front'} camera`}
              style={styles.flipPill}
            >
              <Ionicons name="camera-reverse-outline" size={iconSize.lg} color={color.text} />
            </Pressable>
            {/* Long-press only. A stray tap beside the flip pill used to drop
                an ARMED session back into calibration — the rep counter
                freezes and nothing at the bottom of the screen, where the
                presenter is looking, changes. */}
            <Pressable
              onPress={() => setHoldHint(true)}
              onLongPress={onRecalibrate}
              delayLongPress={450}
              accessibilityRole="button"
              accessibilityLabel="Recalibrate"
              accessibilityHint="Hold to recalibrate"
              style={styles.flipPill}
            >
              <Ionicons name="refresh-outline" size={iconSize.lg} color={color.text} />
            </Pressable>
            <PillButton
              label="End session"
              onPress={onEnd}
              disabled={repCount === 0}
              style={{ flex: 1 }}
            />
          </Row>
          {holdHint && <Text style={styles.holdHint}>Hold to recalibrate</Text>}
          <Row gap={space.sm}>
            {/* play-outline, not refresh-outline: the Recalibrate pill one
                row up already owns that glyph and they do different things. */}
            <PillButton
              label="Restart"
              icon="play-outline"
              variant="ghost"
              onPress={onRestart}
              style={{ flex: 1 }}
            />
            <PillButton
              label="Cancel"
              variant="ghost"
              onPress={onCancel}
              style={{ flex: 1 }}
            />
          </Row>
        </View>
      </View>
    </View>
  );
}

/** Measured-metric fragment, e.g. "elbow 84° · dip→release 0.61 s". */
function repSummary(rep: FormCheckRep): string {
  const parts: string[] = [];
  if (rep.metrics.setPointElbowDeg != null) {
    parts.push(`elbow ${Math.round(rep.metrics.setPointElbowDeg)}°`);
  }
  if (rep.metrics.releaseTimeMs != null) {
    parts.push(`dip→release ${(rep.metrics.releaseTimeMs / 1000).toFixed(2)} s`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Zone A rail — calibration stepper / readiness chips + one banner.
// ---------------------------------------------------------------------------

interface RailSnap {
  readiness: FormCheckReadiness;
  calib: CalibrationState;
}

function railSnapOf(session: FormCheckSession | null): RailSnap | null {
  if (session == null) return null;
  return { readiness: session.readiness, calib: session.calibration };
}

/**
 * The one top strip. Polls the session at ~4 Hz (never per frame — the live
 * view keeps its re-render surface minimal). While collecting, the explicit
 * calibration stepper owns the rail; on completion the ArcReveal armed moment
 * plays (static text carrier under reduced motion); armed, the compact chip
 * row + at most ONE guidance banner. Hard gates always end "Rep counting is
 * paused." — the refuse-don't-guess contract, visible.
 */
function LiveRail({
  sessionRef,
  modelLoaded,
  modelErr,
  onRetryModel,
  onPoseCpu,
  poseCpuOnly,
  framesSv,
  failedSv,
  camSession,
  camPosition,
  onFlipCamera,
  onFlipHand,
  orientRef,
  onFlipOrientation,
  viewReset,
}: {
  sessionRef: React.MutableRefObject<FormCheckSession | null>;
  modelLoaded: boolean;
  modelErr: string | null;
  onRetryModel: () => void;
  /** Reload the model without the accelerated rung. */
  onPoseCpu: () => void;
  /** The accelerated rung is already dropped — offering it again is a lie. */
  poseCpuOnly: boolean;
  /** Frame counter written by the worklet; read ONLY inside the poll below. */
  framesSv: { value: number };
  /** Failed-frame counter, same contract — see {@link inferenceFailing}. */
  failedSv: { value: number };
  /** What the capture session has reported — see {@link cameraSessionBanner}. */
  camSession: CameraSessionState;
  camPosition: 'front' | 'back';
  onFlipCamera: () => void;
  onFlipHand: () => void;
  orientRef: React.MutableRefObject<PoseOrientationDetector>;
  onFlipOrientation: () => void;
  /** This session was rebuilt because the pose coordinate space changed. */
  viewReset: boolean;
}) {
  const { width: winW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [snap, setSnap] = useState<RailSnap | null>(() => railSnapOf(sessionRef.current));
  const [warming, setWarming] = useState(true);
  const [stalled, setStalled] = useState(false);
  /** Frames are arriving and every one is throwing — {@link inferenceFailing}. */
  const [failing, setFailing] = useState(false);
  /** No first frame at all, past the budget — {@link noFirstFrame}. */
  const [noFrames, setNoFrames] = useState(false);
  const [orient, setOrient] = useState<PoseOrientationState>(() =>
    orientRef.current.state(),
  );
  /** Frame counter and wall clock as of the last tick that saw NEW frames. */
  const lastFramesRef = useRef(0);
  const lastFramesAtRef = useRef(0);
  /**
   * When the warm-up budget started running. Held (reset to now) while no
   * model is published, so the 12 s belongs to the CAMERA and never to the
   * loader — which has its own watchdog and its own copy.
   */
  const warmClockRef = useRef(0);
  const modelReadyRef = useRef(modelLoaded);
  useEffect(() => {
    modelReadyRef.current = modelLoaded;
  }, [modelLoaded]);
  /**
   * The camera session's own report, as of the last poll. A ref, not a dep of
   * the interval: re-creating the 4 Hz poll every time a callback fires would
   * restart the stall clock with it.
   */
  const camSessionRef = useRef(camSession);
  useEffect(() => {
    camSessionRef.current = camSession;
  }, [camSession]);
  /** A fault that the session REPORTED, already worded — never an inference. */
  const [camFault, setCamFault] = useState<string | null>(null);
  /** The last INFERRED fault written to the console (once per fault, not 4×/s). */
  const camWarnedRef = useRef<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      setSnap(railSnapOf(sessionRef.current));
      // A SharedValue read on the JS thread is legal in a callback, never in
      // a render body — this is the file's existing poll pattern.
      const frames = framesSv?.value ?? 0;
      const failed = failedSv?.value ?? 0;
      setWarming(frames < WARMUP_FRAMES);
      // Frame-stall watchdog on the SAME poll. Wall clock, not frame time:
      // the whole point is that no frame time is arriving.
      const now = Date.now();
      if (lastFramesAtRef.current === 0) lastFramesAtRef.current = now;
      // Frames arriving, none surviving. Nothing to time — the counters say
      // it outright.
      setFailing(inferenceFailing(frames, failed));
      // THE COUNTER WENT BACKWARDS — the loop was reset (the foreground guard
      // zeroes it on every background/restore; so do Retry and Switch to CPU).
      // That is a RESTART, and every clock measuring "how long has nothing
      // arrived" restarts with it. The stall clock always did; the warm-up
      // clock did not, so an app-switch longer than the 12 s budget came back
      // accusing the camera — "No camera frames yet — tap Flip camera" over a
      // perfectly healthy ~1 s reacquire, offering the one button that breaks
      // the propped protocol. Ordered ABOVE the budget read below so the
      // accusation cannot land on the very tick that detects the restart.
      const restarted = frames < lastFramesRef.current;
      if (restarted) {
        lastFramesRef.current = frames;
        lastFramesAtRef.current = now;
        warmClockRef.current = now;
        setStalled(false);
      } else {
        const delta = frames - lastFramesRef.current;
        setStalled(
          frameStall(delta, now - lastFramesAtRef.current, lastFramesRef.current > 0),
        );
        if (delta > 0) {
          lastFramesRef.current = frames;
          lastFramesAtRef.current = now;
        }
      }
      // The warm-up budget. The clock is HELD at `now` while there is no
      // model to run or a frame has already landed, so it only accumulates
      // over the window where a published model and a live camera should be
      // producing frames and are not.
      if (warmClockRef.current === 0 || frames > 0 || !modelReadyRef.current) {
        warmClockRef.current = now;
      }
      setNoFrames(noFirstFrame(frames > 0, now - warmClockRef.current));
      // THE CAMERA SESSION'S OWN REPORT. Two kinds, and the difference is
      // what stops this from fighting the budget above:
      //  - TOLD (an onError, or an interruption that stops this capture):
      //    information no watchdog can guess, whose fix is outside this app.
      //    It goes on the rail and outranks the warm-up copy.
      //  - INFERRED (a deadline passed in silence): says only that nothing
      //    arrived — which noFirstFrame above already says, later, with a
      //    control attached. Two deadlines for one silence would show two
      //    different instructions, so this one takes the console instead: it
      //    is what separates "the camera never came up" from "the camera is
      //    running and the frame path is dead", which the counters cannot.
      const cam = cameraSessionBanner({
        ...camSessionRef.current,
        elapsedMs: now - camSessionRef.current.since,
      });
      setCamFault(cam != null && cam.told ? cam.text : null);
      if (cam != null && !cam.told) {
        if (camWarnedRef.current !== cam.fault) {
          camWarnedRef.current = cam.fault;
          console.warn(`[formcheck] camera session ${cam.fault}`);
        }
      } else {
        camWarnedRef.current = null;
      }
      // Same 4 Hz poll: the detector runs at frame rate on the sink and the
      // rail never re-renders per frame.
      setOrient(orientRef.current.state());
    }, READINESS_POLL_MS);
    return () => clearInterval(id);
  }, [sessionRef, framesSv, failedSv, orientRef]);
  const refresh = useCallback(() => setSnap(railSnapOf(sessionRef.current)), [sessionRef]);
  /** The override must land on the chip NOW, not on the next 250 ms tick. */
  const flipOrientation = useCallback(() => {
    onFlipOrientation();
    setOrient(orientRef.current.state());
  }, [onFlipOrientation, orientRef]);
  const stripStyle = [styles.readyStrip, { paddingTop: insets.top + space.md }];

  // The armed moment: fires once on the collecting → done edge (a completed
  // calibration — a Skip earns no celebration, it calibrated nothing).
  const calibPhase = snap?.calib.phase ?? null;
  const prevPhase = useRef<typeof calibPhase>(calibPhase);
  const [justArmed, setJustArmed] = useState(false);
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = calibPhase;
    if (prev === 'collecting' && calibPhase === 'done') {
      setJustArmed(true);
      const id = setTimeout(() => setJustArmed(false), ARMED_BANNER_MS);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [calibPhase]);

  const calib = snap?.calib ?? null;
  const readiness = snap?.readiness ?? null;
  const collecting = calibPhase === 'collecting';
  const railW = Math.max(0, winW - space.lg * 2 - space.md * 2);

  // ONE object into BOTH decisions — that is what makes the words and the
  // button structurally incapable of disagreeing (they walk the same list;
  // see bannerActionKind's header).
  const bannerOpts = {
    modelErr,
    cameraFault: camFault,
    modelLoaded,
    inferenceFailing: failing,
    poseCpuOnly,
    warming,
    noFirstFrame: noFrames,
    stalled,
    camPosition,
    collecting,
  };
  const banner = guidanceBanner(
    modelLoaded,
    readiness,
    calib?.hand ?? 'right',
    calib,
    collecting,
    bannerOpts,
  );

  /**
   * The ONE action attached to the banner — WHICH one is decided by the pure
   * {@link bannerActionKind}, in the same priority the banner text uses, so
   * the words and the button can never disagree. Every one of them is an
   * escape from a state the presenter cannot otherwise leave on stage: a
   * loader that gave up, a published model that throws on every frame, a
   * camera that has produced nothing (or is pointing at the wall), and a
   * room + phone that cannot make the fps floor.
   *
   * "Count anyway" needs no "already overridden" test: while the override is
   * doing the work `fpsOk` is true, and below FPS_OVERRIDE_MIN the rate test
   * hides the pill anyway — which is exactly where the core would refuse it.
   */
  const actionKind = bannerActionKind(readiness, bannerOpts);
  const bannerAction: { label: string; onPress: () => void } | null =
    actionKind === 'retryModel'
      ? {
          label: 'Retry',
          onPress: () => {
            // A reload is a fresh start for the frame budget too: the loader
            // has its own watchdog and its own copy, and charging its seconds
            // to the camera's 12 s is what the budget's doc forbids.
            warmClockRef.current = Date.now();
            onRetryModel();
          },
        }
      : actionKind === 'poseCpu'
        ? {
            label: 'Switch to CPU',
            onPress: () => {
              warmClockRef.current = Date.now();
              onPoseCpu();
              haptic.impactMedium();
            },
          }
        : actionKind === 'flipCamera'
          ? {
              label: 'Flip camera',
              onPress: () => {
                onFlipCamera();
                haptic.impactMedium();
              },
            }
          : actionKind === 'countAnyway'
            ? {
                label: 'Count anyway',
                onPress: () => {
                  sessionRef.current?.overrideFpsFloor();
                  haptic.impactMedium();
                  refresh();
                },
              }
            : actionKind === 'countSideAnyway'
              ? {
                  /**
                   * THE SIDE ESCAPE. Same label as the fps twin because it is
                   * the same bargain: the room will not let the shooter stand
                   * side-on, so the gate opens and the price is stated
                   * everywhere — SIDE · OVERRIDE on the chip, an advisory on
                   * the rail, 'angledStance' on every rep, and the elbow,
                   * knee and follow-through angles REFUSED in the core rather
                   * than reported foreshortened.
                   *
                   * It has to reach CALIBRATION, which is where the dead end
                   * actually is: the shadow collector reads the same
                   * readiness.sideOk, so without this the stepper freezes on
                   * "practice motion 1 of 2" and "Start scoring" is never
                   * offered. The pill renders in the stepper for that reason.
                   */
                  label: 'Count anyway',
                  onPress: () => {
                    sessionRef.current?.overrideSideFloor();
                    haptic.impactMedium();
                    refresh();
                  },
                }
              : null;

  const chipRow = (
    <ChipRow
      readiness={readiness}
      stalled={stalled}
      warming={warming}
      calib={calib}
      onFlipHand={onFlipHand}
      orient={orient}
      onFlipOrientation={flipOrientation}
    />
  );

  if (collecting && calib != null) {
    const step = Math.min(calib.shadowReps + 1, SHADOW_REPS_TARGET);
    return (
      <View style={stripStyle}>
        <View style={styles.railCard}>
          <Row gap={space.md}>
            <PulsingStepRing progress={calib.shadowReps / SHADOW_REPS_TARGET} />
            <View style={{ flex: 1, minWidth: 0 }}>
              {/* Static text carrier — the step read survives reduced motion. */}
              <Text style={styles.stepTitle}>
                {`PRACTICE MOTION ${step} OF ${SHADOW_REPS_TARGET}`}
              </Text>
              <Text style={styles.stepSub}>
                {viewReset
                  ? 'Not scored — restarted after the view flipped.'
                  : 'Not scored — calibrating.'}
              </Text>
            </View>
          </Row>
          {/* The chips ride HERE too, not only past calibration. Collecting is
              the exact window the orientation verdict is designed to settle
              in, and a chip that is invisible then is a verdict nobody can
              check and an override nobody can reach — which is the whole
              honesty contract, unreachable in the phase that needs it. */}
          {chipRow}
          {banner != null && (
            <Text style={styles.stepGate}>
              {banner.text} Practice motions are paused.
            </Text>
          )}
          <Row gap={space.sm} style={styles.stepActions}>
            {bannerAction != null && (
              <Pressable
                onPress={bannerAction.onPress}
                accessibilityRole="button"
                accessibilityLabel={bannerAction.label}
                style={[styles.stepPill, styles.stepPillPrimary]}
              >
                <Text style={styles.stepPillPrimaryText}>{bannerAction.label}</Text>
              </Pressable>
            )}
            {calib.shadowReps >= 1 && (
              <Pressable
                onPress={() => {
                  sessionRef.current?.completeCalibration();
                  haptic.impactMedium();
                  refresh();
                }}
                accessibilityRole="button"
                accessibilityLabel="Start scoring now"
                style={[styles.stepPill, styles.stepPillPrimary]}
              >
                <Text style={styles.stepPillPrimaryText}>Start scoring</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                sessionRef.current?.skipCalibration();
                haptic.selection();
                refresh();
              }}
              accessibilityRole="button"
              accessibilityLabel="Skip calibration"
              style={styles.stepPill}
            >
              <Text style={styles.stepPillText}>Skip</Text>
            </Pressable>
          </Row>
        </View>
      </View>
    );
  }

  if (justArmed) {
    return (
      <View style={stripStyle}>
        <View style={styles.railCard}>
          <ArmedReveal width={railW} />
          {/* Static carrier — reduced motion still reads the state change. */}
          <Text style={styles.armedText}>Calibrated — scoring armed</Text>
          {/* The chips stay UNDER the celebration: the shooter shoots the
              instant they read "armed", and a blank rail through exactly that
              window is how a rep silently fails to count. */}
          {chipRow}
        </View>
      </View>
    );
  }

  return (
    <View style={stripStyle}>
      {chipRow}
      {banner != null ? (
        <View style={[styles.readyBanner, !banner.pauses && styles.readyBannerInfo]}>
          <Ionicons
            name={banner.pauses ? 'alert-circle-outline' : 'information-circle-outline'}
            size={iconSize.md}
            color={banner.pauses ? color.unsure : color.info}
          />
          <Text
            style={[styles.readyBannerText, !banner.pauses && styles.readyBannerTextInfo]}
          >
            {banner.pauses ? `${banner.text} Rep counting is paused.` : banner.text}
          </Text>
          {bannerAction != null && (
            <Pressable
              onPress={bannerAction.onPress}
              accessibilityRole="button"
              accessibilityLabel={bannerAction.label}
              style={[styles.stepPill, styles.stepPillPrimary]}
            >
              <Text style={styles.stepPillPrimaryText}>{bannerAction.label}</Text>
            </Pressable>
          )}
        </View>
      ) : (
        // The POSITIVE state. Without it, "the app is measuring you" was
        // signalled only by the absence of a warning — four 10pt chips on
        // translucent pills, unreadable from three metres.
        readiness?.ready === true && (
          <View style={[styles.readyBanner, styles.readyBannerOk]}>
            <Ionicons
              name="checkmark-circle-outline"
              size={iconSize.md}
              color={color.make}
            />
            <Text style={[styles.readyBannerText, styles.readyBannerTextOk]}>
              Ready — shoot when you like.
            </Text>
          </View>
        )
      )}
    </View>
  );
}

/**
 * The readiness chips. Extracted so the armed celebration can render them
 * underneath itself instead of replacing them.
 */
function ChipRow({
  readiness,
  stalled = false,
  warming = false,
  calib,
  onFlipHand,
  orient,
  onFlipOrientation,
}: {
  readiness: FormCheckReadiness | null;
  /** The pose loop stopped delivering frames — see {@link frameStall}. */
  stalled?: boolean;
  /** No frames yet this run: cold start, or the camera restarting after the
   *  app came back to the foreground. */
  warming?: boolean;
  calib: CalibrationState | null;
  onFlipHand: () => void;
  orient: PoseOrientationState;
  onFlipOrientation: () => void;
}) {
  // The no-reading rule lives in {@link chipGauges} so it can be pinned. The
  // VIEW chip is deliberately NOT in it — that one reports a latched verdict
  // about the buffer, not a live gauge.
  const { fps, fpsOk, overridden, fullBodyOk, armOk, sideOk, sideOverridden } =
    chipGauges(readiness, { stalled, warming });
  const chipHand = calib?.hand ?? 'right';
  const chipSource = calib?.handSource ?? 'settings';

  return (
    <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
      {/* An overridden rate is NOT a passing rate — the chip stays amber and
          says so, however green the gate now reads. */}
      <Chip
        label={overridden ? `${Math.round(fps)} FPS · OVERRIDE` : `${Math.round(fps)} FPS`}
        tone={fpsOk && !overridden ? 'make' : 'unsure'}
        compact
      />
      <Chip label="BODY" tone={fullBodyOk ? 'make' : 'unsure'} compact />
      <Pressable
        onPress={onFlipHand}
        accessibilityRole="button"
        accessibilityLabel={`Watching your ${chipHand} arm (${chipSource === 'auto' ? 'auto-detected' : chipSource === 'manual' ? 'your pick' : 'assumed from Settings'}). Tap to watch the other arm.`}
      >
        <Chip
          label={armChipLabel(chipHand, chipSource)}
          tone={armOk ? 'make' : 'unsure'}
          compact
        />
      </Pressable>
      <SideChip
        sideness={stalled ? null : (readiness?.sideness ?? null)}
        ok={sideOk}
        trusted={!stalled && readiness?.sideTrusted !== false}
        overridden={sideOverridden}
      />
      {/* A correction that fires must be VISIBLE — one nobody can see is one
          nobody can overrule. Only a verified-upright buffer earns green:
          UNVERIFIED means the pose is going through untouched and the screen
          says so rather than implying it checked. Tap = the human's call. */}
      <Pressable
        onPress={onFlipOrientation}
        accessibilityRole="button"
        accessibilityLabel={orientationChipHint(orient.verdict, orient.source)}
      >
        <Chip
          label={orientationChipLabel(orient.verdict, orient.source)}
          tone={orient.verdict === 'upright' ? 'make' : 'unsure'}
          compact
        />
      </Pressable>
    </Row>
  );
}

/** Ring stroke for the calibration stepper. */
const STEP_RING_SIZE = 44;
const STEP_RING_STROKE = 4;

/**
 * The stepper's arc ring: arcMotif echo inside a progress circle that fills
 * per shadow rep (static Skia, JS-built paths). The pulse is a plain
 * reanimated opacity loop on the wrapper — no worklet math beyond the style —
 * and is dropped entirely under reduced motion (the text row is the carrier).
 */
function PulsingStepRing({ progress }: { progress: number }) {
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withTiming(0.55, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    // The stepper unmounts on collecting → done while the camera + pose
    // pipeline keep running — the infinite loop must die with it (the
    // Shimmer/CalibrationScenes cleanup convention).
    return () => cancelAnimation(pulse);
  }, [reducedMotion, pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const r = (STEP_RING_SIZE - STEP_RING_STROKE) / 2;
  const track = useMemo(() => {
    const p = Skia.Path.Make();
    p.addCircle(STEP_RING_SIZE / 2, STEP_RING_SIZE / 2, r);
    return p;
  }, [r]);
  const sweep = useMemo(() => {
    const p = Skia.Path.Make();
    const deg = 360 * Math.max(0, Math.min(1, progress));
    if (deg > 0) {
      p.addArc(
        Skia.XYWHRect(STEP_RING_STROKE / 2, STEP_RING_STROKE / 2, r * 2, r * 2),
        -90,
        deg,
      );
    }
    return p;
  }, [progress, r]);
  const motifPath = useMemo(
    () => arcMotif(STEP_RING_SIZE, STEP_RING_SIZE, { rimInset: 10 }).path,
    [],
  );

  return (
    <Animated.View style={reducedMotion ? undefined : pulseStyle}>
      <Canvas style={{ width: STEP_RING_SIZE, height: STEP_RING_SIZE }}>
        <Path path={motifPath} style="stroke" strokeWidth={1.5} color={color.text} opacity={0.14} />
        <Path
          path={track}
          style="stroke"
          strokeWidth={STEP_RING_STROKE}
          color={color.hudGlassBorder}
        />
        <Path
          path={sweep}
          style="stroke"
          strokeWidth={STEP_RING_STROKE}
          strokeCap="round"
          color={color.accent}
        />
      </Canvas>
    </Animated.View>
  );
}

/**
 * "Calibrated — scoring armed" arc moment. A thin wrapper so the rail's JSX
 * stays flat; ArcReveal itself renders the finished static arc under reduced
 * motion, and the caller keeps the text carrier beside it.
 */
function ArmedReveal({ width }: { width: number }) {
  if (width <= 0) return null;
  return <ArcReveal width={width} height={44} rimInset={24} />;
}

/**
 * Tiny 0–1 side-profile arc meter chip. Null = the gauge honestly can't vote
 * (occlusion) — the chip shows a dash and the gate PASSES.
 *
 * Four states, not two: the gate passes from SIDE_PROFILE_MIN (≈40° of
 * tolerance, so an ordinary room can be used) but 2D joint angles are only
 * trustworthy from SIDE_PROFILE_TRUSTED. A passing-but-angled stance stays
 * amber — green would be the screen claiming a squareness it measured itself
 * to not have — and an OVERRIDDEN stance says the word outright.
 */
function SideChip({
  sideness,
  ok,
  trusted = true,
  overridden = false,
}: {
  sideness: number | null;
  ok: boolean;
  trusted?: boolean;
  /** The gate is passing because the presenter overrode it, not because the
   *  stance cleared the floor. The FPS chip's precedent: an overridden gauge
   *  stays amber and SAYS so, however green the gate now reads. */
  overridden?: boolean;
}) {
  const w = 18;
  const h = 11;
  const clean = ok && trusted && !overridden;
  const track = useMemo(() => {
    const p = Skia.Path.Make();
    p.addArc(Skia.XYWHRect(2, 2, w - 4, (h - 3) * 2), 180, 180);
    return p;
  }, []);
  return (
    <View
      style={[
        styles.sideChip,
        { backgroundColor: clean ? color.makeTint : 'rgba(232,184,79,0.14)' },
      ]}
      accessible
      accessibilityLabel={
        sideness != null
          ? `Side-on ${Math.round(sideness * 100)} percent${
              overridden
                ? ', counting anyway, angles not read'
                : clean
                  ? ''
                  : ', angles read low'
            }`
          : 'Side-on not measurable'
      }
    >
      <Text style={[styles.sideChipLabel, { color: clean ? color.make : color.unsure }]}>
        {overridden ? 'SIDE · OVERRIDE' : 'SIDE'}
      </Text>
      {sideness != null ? (
        <Canvas style={{ width: w, height: h }}>
          <Path path={track} style="stroke" strokeWidth={2.5} color={color.border} />
          <Path
            path={track}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            color={clean ? color.make : color.unsure}
            start={0}
            end={Math.max(0, Math.min(1, sideness))}
          />
        </Canvas>
      ) : (
        <Text style={[styles.sideChipLabel, { color: color.textFaint }]}>—</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Skeleton overlay — JS-thread Skia canvas polled from a ref (~12 Hz).
// ---------------------------------------------------------------------------

/** COCO bone topology (mirrors FormMotionStage's stage skeleton). */
const OVERLAY_BONES: readonly [PoseKeypointName, PoseKeypointName][] = [
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

/**
 * Map a 192-square keypoint into view px: fraction of the cover-crop square →
 * centered square of the sensor rect → 'contain' letterbox of the sensor in
 * the view; a mirrored (front) preview flips x. Registration depends on the
 * buffer arriving in interface orientation (enablePhysicalBufferRotation) —
 * presentation-only, so a device-specific offset can never touch metrics.
 */
function mapKeypoint(
  kx: number,
  ky: number,
  frameW: number,
  frameH: number,
  viewW: number,
  viewH: number,
  mirrored: boolean,
): { x: number; y: number } {
  const square = Math.min(frameW, frameH);
  const sx = (frameW - square) / 2 + (kx / POSE_INPUT) * square;
  const sy = (frameH - square) / 2 + (ky / POSE_INPUT) * square;
  const scale = Math.min(viewW / frameW, viewH / frameH);
  const dx = (viewW - frameW * scale) / 2;
  const dy = (viewH - frameH * scale) / 2;
  let vx = dx + sx * scale;
  const vy = dy + sy * scale;
  if (mirrored) vx = viewW - vx;
  return { x: vx, y: vy };
}

/**
 * Static Skia skeleton over the preview, rebuilt on the JS thread from the
 * latest pose in `latestRef` at ~12 Hz. Explicitly NOT a worklet — pose runs
 * faster underneath; this is an honest low-rate visual aid.
 */
function SkeletonOverlay({
  latestRef,
  mirrored,
  hand,
}: {
  latestRef: React.MutableRefObject<FormPoseSample | null>;
  mirrored: boolean;
  hand: ShootingHand;
}) {
  const { width: viewW, height: viewH } = useWindowDimensions();
  const [sample, setSample] = useState<FormPoseSample | null>(null);
  useEffect(() => {
    const id = setInterval(() => setSample(latestRef.current), OVERLAY_POLL_MS);
    return () => clearInterval(id);
  }, [latestRef]);

  const geom = useMemo(() => {
    if (sample == null || sample.frameW <= 0 || sample.frameH <= 0) return null;
    const pts = new Map<PoseKeypointName, { x: number; y: number }>();
    for (const [name, kp] of Object.entries(sample.pose.keypoints) as [
      PoseKeypointName,
      { x: number; y: number; score: number },
    ][]) {
      if (kp == null || kp.score < FORM.keypointScoreMin) continue;
      pts.set(
        name,
        mapKeypoint(kp.x, kp.y, sample.frameW, sample.frameH, viewW, viewH, mirrored),
      );
    }
    const bones: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
    for (const [an, bn] of OVERLAY_BONES) {
      const a = pts.get(an);
      const b = pts.get(bn);
      if (a && b) bones.push({ a, b });
    }
    return { pts, bones };
  }, [sample, viewW, viewH, mirrored]);

  if (geom == null) return null;
  const wrist = geom.pts.get(`${hand}_wrist` as PoseKeypointName);
  const elbow = geom.pts.get(`${hand}_elbow` as PoseKeypointName);

  return (
    <View style={absoluteFill} pointerEvents="none">
      <Canvas style={{ width: viewW, height: viewH }}>
        {geom.bones.map((b, i) => (
          <Line
            key={i}
            p1={vec(b.a.x, b.a.y)}
            p2={vec(b.b.x, b.b.y)}
            strokeWidth={3}
            strokeCap="round"
            color={color.accent}
            opacity={0.8}
          />
        ))}
        {[...geom.pts.values()].map((p, i) => (
          <Circle key={`j-${i}`} cx={p.x} cy={p.y} r={3} color={color.text} opacity={0.9} />
        ))}
        {/* Shooting-side wrist + elbow highlighted — the measured joints. */}
        {elbow != null && <Circle cx={elbow.x} cy={elbow.y} r={5} color={color.accent} />}
        {wrist != null && <Circle cx={wrist.x} cy={wrist.y} r={6} color={color.accent} />}
      </Canvas>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Report — exported so the non-camera render test can drive it directly.
// ---------------------------------------------------------------------------

/** Phase label for a scrub fraction (formstudio's timeline mapping). */
function phaseForPos(pos: number): StagePhase {
  if (pos < 0.35) return 'DIP';
  if (pos < 0.66) return 'RISE';
  if (pos < 0.82) return 'RELEASE';
  return 'FOLLOW';
}

type ReportSeg = 'overview' | 'reps' | 'compare' | 'depth';

/** Report chip word per hand source — honest at a glance. */
const SOURCE_WORD: Record<HandSource, string> = {
  auto: 'auto',
  manual: 'chosen',
  settings: 'assumed',
};

interface SpreadRowSpec {
  label: string;
  unit: string;
  flag: number;
  stat: SpreadStat;
  format: (v: number) => string;
}

/**
 * The Skia stage plus its transport (autoplay + scrub; a frame stepper under
 * reduced motion). EXTRACTED from FormCheckReport on purpose: the rAF loop
 * calls setPos once per animation frame, and while `pos` lived on the report
 * that reconciled the verdict hero, four spread rows, the tabs, the receipt
 * and the stage 60 times a second on an A12 — exactly when the presenter
 * presses Play to show the theater off. Owning `pos` here confines the
 * re-render to the stage, the track and the phase label. Pure extraction:
 * the caller keys this by rep/archetype where it used to reset on a effect.
 */
function MotionTheater({
  seq,
  reference,
  hand,
  repIndex,
  archetypeName,
  width,
  reducedMotion,
}: {
  seq: readonly DecodedFrame[];
  reference: readonly DecodedFrame[];
  hand: ShootingHand;
  repIndex: number;
  archetypeName: string;
  width: number;
  reducedMotion: boolean;
}) {
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef(0);
  useEffect(() => {
    if (!playing || reducedMotion) return;
    const step = (ts: number) => {
      if (lastTs.current === 0) lastTs.current = ts;
      const dt = (ts - lastTs.current) / 1000;
      lastTs.current = ts;
      setPos((p) => {
        const next = p + dt / 1.4;
        return next >= 1 ? 0 : next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTs.current = 0;
    };
  }, [playing, reducedMotion]);

  const trackWidthRef = useRef(1);
  const seekFromEvent = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    setPos(Math.max(0, Math.min(1, x / trackWidthRef.current)));
  };
  const frameCount = seq.length;
  const stepFrame = (dir: 1 | -1) => {
    const cur = Math.round(pos * (frameCount - 1));
    const next = Math.max(0, Math.min(frameCount - 1, cur + dir));
    setPos(frameCount <= 1 ? 0 : next / (frameCount - 1));
  };
  const stagePhase = phaseForPos(pos);
  const stageW = Math.min(width - 40, 560);
  const stageH = Math.round(stageW * 0.62);

  return (
    <>
      <View style={{ alignItems: 'center' }}>
        <FormMotionStage
          user={seq}
          reference={reference}
          pos={pos}
          hand={hand}
          phase={stagePhase}
          width={stageW}
          height={stageH}
          accessibilityLabel={`Rep ${repIndex}'s motion at the ${stagePhase} phase beside a synthesized ${archetypeName} reference form`}
        />
      </View>
      {/* Scrub track (formstudio transport). */}
      <View
        style={styles.track}
        onLayout={(e) => {
          trackWidthRef.current = e.nativeEvent.layout.width;
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          setPlaying(false);
          seekFromEvent(e);
        }}
        onResponderMove={seekFromEvent}
        accessibilityRole="adjustable"
        accessibilityLabel="Scrub the shooting motion"
        accessibilityValue={{ now: Math.round(pos * 100), min: 0, max: 100 }}
      >
        <View style={styles.trackFill} />
        <View style={[styles.trackProgress, { width: `${pos * 100}%` }]} />
        <View style={[styles.trackThumb, { left: `${pos * 100}%` }]} />
      </View>
      {reducedMotion ? (
        <Row gap={space.md} style={styles.transport}>
          <Pressable
            onPress={() => stepFrame(-1)}
            accessibilityRole="button"
            accessibilityLabel="Previous frame"
            style={styles.stepBtn}
          >
            <Ionicons name="play-back" size={18} color={color.text} />
          </Pressable>
          <Text style={styles.phaseInline}>{stagePhase}</Text>
          <Pressable
            onPress={() => stepFrame(1)}
            accessibilityRole="button"
            accessibilityLabel="Next frame"
            style={styles.stepBtn}
          >
            <Ionicons name="play-forward" size={18} color={color.text} />
          </Pressable>
        </Row>
      ) : (
        <Row gap={space.md} style={styles.transport}>
          <Pressable
            onPress={() => {
              lastTs.current = 0;
              setPlaying((p) => !p);
            }}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : 'Play'}
            style={styles.playBtn}
          >
            <Ionicons name={playing ? 'pause' : 'play'} size={20} color={color.onAccent} />
          </Pressable>
          <Text style={styles.phaseInline}>{stagePhase}</Text>
        </Row>
      )}
    </>
  );
}

export function FormCheckReport({
  reps,
  report,
  hand,
  savedId,
  heightCm = null,
  onAgain,
  onDone,
}: {
  reps: readonly FormCheckRep[];
  report: FormCheckSessionReport;
  hand: ShootingHand;
  /** null = save in flight, ≥0 = saved row id, −1 = insert failed. */
  savedId: number | null;
  /** Profile height (for the receipt's honest "why no metres" branch). */
  heightCm?: number | null;
  /** One tap back into a fresh live session — the screen never unmounts. */
  onAgain?: () => void;
  onDone?: () => void;
}) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();

  // Theater: reps whose sequence decodes into a body the stage can honestly
  // draw. Computed BEFORE `seg` so the report can open on the segment that
  // actually has something in it.
  //
  // The filter used to be `seq.length >= 2` — "we have rows" — which is how the
  // stage came to draw a single vertical line with the head at the bottom, and
  // how the cue engine came to coach a human being from it. isReconstructible-
  // Motion is the same predicate buildSequence now applies to what it ships,
  // repeated HERE because reports rehydrated from this phone were written
  // before that gate existed and still carry degenerate sequences. A rep that
  // fails it is left out; the Compare tab says so rather than drawing a body
  // that was never seen.
  const decodedReps = useMemo(
    () =>
      reps.map((rep) => {
        const seq = rep.sequence != null ? decodeSequence(rep.sequence) : [];
        return { rep, seq, drawable: isReconstructibleMotion(seq) };
      }),
    [reps],
  );
  const theaterReps = useMemo(
    () => decodedReps.filter((r) => r.drawable),
    [decodedReps],
  );

  /**
   * Reps that DID record pose rows and were still refused by the gate above.
   * Counted so the Compare tab can say which of the two silences it is in —
   * "nothing was captured" and "what was captured is not a body" are different
   * facts, and the second one is the one the shooter can act on.
   */
  const refusedMotions = useMemo(
    () => decodedReps.filter((r) => r.rep.sequence != null && !r.drawable).length,
    [decodedReps],
  );

  // A short stage demo is two or three reps, which lands Overview on a nag
  // headline and four em dashes. When a rep captured a decodable motion the
  // report opens ON the theater instead; otherwise it falls back to Overview.
  const [seg, setSeg] = useState<ReportSeg>(() =>
    theaterReps.length > 0 ? 'compare' : 'overview',
  );

  const calib = report.calibration;
  const contentW = Math.max(160, Math.min(width, 600) - space.lg * 4);

  const spreadRows: SpreadRowSpec[] = [
    {
      label: 'Elbow set point',
      unit: '°',
      flag: ELBOW_SPREAD_FLAG_DEG,
      stat: report.spreads.setPointElbowSpreadDeg,
      format: (v) => `±${v.toFixed(1)}°`,
    },
    {
      label: 'Release height',
      unit: 'frame',
      flag: RELEASE_HEIGHT_SPREAD_FLAG,
      stat: report.spreads.releaseHeightSpread,
      format: (v) => `±${(v * 100).toFixed(1)}% of frame`,
    },
    {
      label: 'Dip → release tempo',
      unit: 'ms',
      flag: TEMPO_SPREAD_FLAG_MS,
      stat: report.spreads.tempoSpreadMs,
      format: (v) => `±${Math.round(v)} ms`,
    },
    {
      label: 'Knee flexion',
      unit: '°',
      flag: KNEE_SPREAD_FLAG_DEG,
      stat: report.spreads.kneeSpreadDeg,
      format: (v) => `±${v.toFixed(1)}°`,
    },
  ];

  const [theaterIdx, setTheaterIdx] = useState(0);
  const [archIdx, setArchIdx] = useState(0);
  const selected =
    theaterReps[Math.min(theaterIdx, Math.max(0, theaterReps.length - 1))] ?? null;
  const archetype: PlayerArchetype = PLAYER_ARCHETYPES[archIdx] ?? PLAYER_ARCHETYPES[0]!;
  const reference = useMemo(
    () => referenceSequence(archetype, hand),
    [archetype, hand],
  );
  const cues = useMemo<PostureCue[]>(
    () => (selected ? posturePlan(selected.seq, reference, hand, 3) : []),
    [selected, reference, hand],
  );

  // Per-rep similarity — computed HERE, in the report layer, from decoded
  // sequences against the CURRENT archetype (never inside FormCheckSession,
  // so a hand flip or archetype change can't desync core state).
  const simByIndex = useMemo(() => {
    const m = new Map<number, FormSimilarity | null>();
    for (const tr of theaterReps) {
      m.set(tr.rep.index, formSimilarity(tr.seq, reference, hand));
    }
    return m;
  }, [theaterReps, reference, hand]);

  // In-session trend series (rep order, measured values only).
  const tempoVals = useMemo(
    () =>
      reps
        .map((r) => r.metrics.releaseTimeMs)
        .filter((v): v is number => v != null),
    [reps],
  );
  const medTempo = medianOf(tempoVals);
  const simVals = useMemo(() => {
    const vals: number[] = [];
    for (const r of reps) {
      const s = simByIndex.get(r.index);
      if (s != null) vals.push(s.score);
    }
    return vals;
  }, [reps, simByIndex]);

  const pStats = useMemo(() => sessionPhaseStats(reps), [reps]);

  const jumpToCompare = useCallback(
    (repIndex: number) => {
      const i = theaterReps.findIndex((tr) => tr.rep.index === repIndex);
      if (i >= 0) setTheaterIdx(i);
      setSeg('compare');
    },
    [theaterReps],
  );

  // The selected rep lifted into 3D. Declared ABOVE `segments` because the tab
  // badge reads it — a helper referenced before its declaration is the TDZ trap
  // this file has been bitten by before.
  //
  // Depth is an ESTIMATE (bone-length priors), never a measurement, and
  // liftRep returns null rather than a half-skeleton when the rep is too thin
  // or the depth scale cannot be trusted. A null here means the 3D tab is
  // ATTENTIVELY empty, not broken.
  const lifted3d = useMemo(
    () => (selected != null ? liftRep(selected.rep) : null),
    [selected],
  );

  const segments: SegmentedTabItem<ReportSeg>[] = [
    { value: 'overview', label: 'Overview' },
    {
      value: 'reps',
      label: 'Reps',
      badge: report.repCount,
      badgeLabel: `${report.repCount} ${report.repCount === 1 ? 'rep' : 'reps'}`,
    },
    {
      value: 'compare',
      label: 'Compare',
      badge: theaterReps.length > 0 ? ('dot' as const) : undefined,
      badgeLabel: theaterReps.length > 0 ? 'motion captured' : undefined,
    },
    {
      value: 'depth',
      label: '3D',
      badge: lifted3d != null ? ('dot' as const) : undefined,
      badgeLabel: lifted3d != null ? 'depth estimated' : undefined,
    },
  ];

  const lowConfLine = lowConfidenceLine(report);
  const savedLine =
    savedId != null && savedId >= 0
      ? 'Saved on this phone — nothing leaves it.'
      : savedId === -1
        ? "This report couldn't be saved this time — it lives only until you leave this screen."
        : null;

  return (
    <View style={styles.reportStack}>
      <View>
        <Text style={styles.kicker}>FORM CHECK</Text>
        <Text style={styles.title} accessibilityRole="header">
          Session report
        </Text>
      </View>
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        <Chip label={`${report.repCount} reps detected`} tone="accent" />
        <Chip label={`pose ${Math.round(report.medianPoseFps)} fps`} />
        <Chip label={`${calib.hand} arm · ${SOURCE_WORD[calib.handSource]}`} />
        {savedId != null && savedId >= 0 && <Chip label="Saved" tone="make" />}
        {savedId === -1 && <Chip label="Not saved" tone="unsure" />}
      </Row>

      {/* The other half of the relaxed-gate bargain: the reps are real, the
          numbers are worth less, and the report says which and why. */}
      {lowConfLine != null && (
        <View style={styles.lowConfBanner}>
          <Ionicons name="alert-circle-outline" size={iconSize.md} color={color.unsure} />
          <Text style={styles.lowConfText}>{lowConfLine}</Text>
        </View>
      )}

      {/* HERO — the consistency verdict, above the tabs (coach.tsx idiom). */}
      <Card style={styles.verdictCard}>
        <SectionEyebrow icon="pulse">Consistency</SectionEyebrow>
        <Row gap={space.lg} style={styles.verdictRow}>
          <VerdictRing steady={report.verdict.steady} measured={report.verdict.measured} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.verdictHeadline}>{verdictHeadline(report)}</Text>
            <Text style={styles.metricBand}>
              {report.repCount < MIN_SPREAD_REPS
                ? `Spreads need at least ${MIN_SPREAD_REPS} measured reps — never fabricated from fewer.`
                : `${report.verdict.steady} of ${report.verdict.measured} measured spreads steady.`}
            </Text>
          </View>
        </Row>
        {spreadRows.map((row, i) => (
          <View key={row.label} style={[styles.spreadRow, i > 0 && styles.rowDivider]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.metricLabel}>{row.label}</Text>
              {row.stat.value == null && (
                <Text style={styles.metricBand}>{row.stat.reason ?? 'not measured'}</Text>
              )}
            </View>
            {row.stat.value != null ? (
              <Row gap={space.sm}>
                <Text style={styles.metricValue}>{row.format(row.stat.value)}</Text>
                <Chip
                  label={row.stat.value <= row.flag ? 'steady' : 'drifting'}
                  tone={row.stat.value <= row.flag ? 'make' : 'unsure'}
                  compact
                />
              </Row>
            ) : (
              <Text style={styles.metricDash}>—</Text>
            )}
          </View>
        ))}
        <Text style={styles.footnote}>
          Spreads are rep-to-rep sample deviations of pose-measured numbers.
          Release height is camera-relative (frame heights), not centimetres.
        </Text>
      </Card>

      <View style={styles.segmentBlock}>
        <SegmentedTabs
          segments={segments}
          value={seg}
          onChange={setSeg}
          accessibilityLabel="Report sections"
        />

        {/* ---- Overview -------------------------------------------------- */}
        {seg === 'overview' && (
          <View style={styles.segmentBody}>
            {tempoVals.length >= MIN_SPREAD_REPS && (
              <Card>
                <SectionEyebrow icon="trending-up-outline">In-session trend</SectionEyebrow>
                <Text style={styles.trendLabel}>DIP → RELEASE TEMPO PER REP</Text>
                <TrendLine values={tempoVals} width={contentW} height={56} median={medTempo} />
                {medTempo != null && (
                  <Text style={styles.trendCaption}>
                    {`median ${(medTempo / 1000).toFixed(2)} s`}
                  </Text>
                )}
                {simVals.length >= 3 && (
                  <>
                    <Text style={[styles.trendLabel, { marginTop: space.md }]}>
                      STYLE MATCH PER REP
                    </Text>
                    <TrendLine values={simVals} width={contentW} height={44} tint={color.info} />
                    <Text style={styles.trendCaption}>
                      {`style match vs synthesized ${archetype.name} reference — not a quality score`}
                    </Text>
                  </>
                )}
              </Card>
            )}

            {report.best != null && (
              <Card>
                <SectionEyebrow icon="star-outline">Best rep</SectionEyebrow>
                <Row gap={space.lg} style={styles.bestRow}>
                  <Text style={styles.bestIndex}>{report.best.index}</Text>
                  <Text style={[styles.body, { flex: 1, marginTop: 0 }]}>
                    {report.best.reason}
                  </Text>
                </Row>
                {theaterReps.some((tr) => tr.rep.index === report.best!.index) && (
                  <PillButton
                    label="View in Compare"
                    variant="ghost"
                    icon="film-outline"
                    onPress={() => jumpToCompare(report.best!.index)}
                    style={styles.bestCta}
                  />
                )}
              </Card>
            )}

            {pStats.measured > 0 && (
              <Card>
                <SectionEyebrow icon="timer-outline">Phase timing</SectionEyebrow>
                <View style={{ marginTop: space.sm }}>
                  <PhaseBars
                    phases={pStats.median}
                    range={{ min: pStats.min, max: pStats.max }}
                    width={contentW}
                  />
                </View>
                <Text style={styles.footnote}>
                  Session medians; the small ranges are your fastest and slowest
                  rep. Unmeasured phases stay blank — never interpolated.
                </Text>
              </Card>
            )}

            {/* Calibration receipt — what the check measured about ITSELF. */}
            <Card>
              <SectionEyebrow icon="options-outline">Calibration receipt</SectionEyebrow>
              {calib.phase === 'skipped' && (
                <Text style={styles.body}>Calibration skipped — no gauges, plain scoring.</Text>
              )}
              {calib.phase === 'collecting' && (
                <Text style={styles.body}>Session ended during calibration — nothing locked.</Text>
              )}
              <ReceiptRow
                label="Watched arm"
                value={`${calib.hand} — ${
                  calib.handSource === 'auto'
                    ? 'auto-detected'
                    : calib.handSource === 'manual'
                      ? 'chosen by you'
                      : 'assumed from Settings'
                }`}
              />
              <ReceiptRow
                label="Side-on"
                value={
                  calib.sidenessAvg == null
                    ? '—'
                    : calib.sidenessAvg < SIDE_PROFILE_TRUSTED
                      ? // The gate passes here, the ANGLES do not survive it.
                        `${Math.round(calib.sidenessAvg * 100)}% side-on — 2D angles read low when you're angled toward the camera`
                      : `${Math.round(calib.sidenessAvg * 100)}% side-on`
                }
              />
              <ReceiptRow
                label="Camera tilt"
                value={
                  calib.tilt == null
                    ? 'not measured'
                    : calib.tilt.confident
                      ? `compensated ${calib.tilt.tiltDeg > 0 ? '+' : ''}${Math.round(calib.tilt.tiltDeg)}°`
                      : 'not compensated'
                }
              />
              {calib.scale != null ? (
                <ReceiptRow
                  label="Metres"
                  value={`on — from your ${Math.round(calib.scale.heightCm)} cm profile height (estimate)`}
                />
              ) : heightCm == null ? (
                <Pressable
                  onPress={() => router.push('/settings')}
                  accessibilityRole="button"
                  accessibilityLabel="Height not set. Add it in Settings for metres."
                  style={styles.receiptLink}
                >
                  <Text style={styles.receiptLinkText}>
                    Height not set — add it in Settings for metres
                  </Text>
                  <Ionicons name="chevron-forward" size={iconSize.sm} color={color.accent} />
                </Pressable>
              ) : (
                <ReceiptRow label="Metres" value="off — standing span too unsteady" />
              )}
            </Card>

            {/* Honesty footer */}
            <View style={styles.honesty}>
              <Ionicons
                name="information-circle-outline"
                size={iconSize.md}
                color={color.textFaint}
              />
              <Text style={styles.honestyText}>
                These are 2D angles in the camera plane from pose keypoints —
                not a 3D measurement. Reps are detected from your motion
                signature, not a tracked ball, so nothing here claims a make or
                a miss.{savedLine != null ? ` ${savedLine}` : ''}
              </Text>
            </View>
          </View>
        )}

        {/* ---- Reps ------------------------------------------------------ */}
        {seg === 'reps' && (
          <View style={styles.segmentBody}>
            <Card>
              <SectionEyebrow icon="list-outline">Rep by rep</SectionEyebrow>
              {reps.map((rep) => (
                <RepRow
                  key={rep.index}
                  rep={rep}
                  best={report.best?.index === rep.index}
                  sim={simByIndex.get(rep.index) ?? null}
                />
              ))}
            </Card>
          </View>
        )}

        {/* ---- Compare (the motion theater, moved here wholesale) -------- */}
        {seg === 'compare' && (
          <View style={styles.segmentBody}>
            {selected != null ? (
              <Card>
                <SectionEyebrow icon="film-outline">Motion theater</SectionEyebrow>
                {theaterReps.length > 1 && (
                  <Row gap={space.sm} style={{ flexWrap: 'wrap', marginBottom: space.sm }}>
                    {theaterReps.map((r, i) => (
                      <Pressable
                        key={r.rep.index}
                        onPress={() => setTheaterIdx(i)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: i === theaterIdx }}
                        style={[styles.pick, i === theaterIdx && styles.pickOn]}
                      >
                        <Text style={[styles.pickText, i === theaterIdx && styles.pickTextOn]}>
                          Rep {r.rep.index}
                        </Text>
                      </Pressable>
                    ))}
                  </Row>
                )}
                <Row gap={space.sm} style={{ flexWrap: 'wrap', marginBottom: space.sm }}>
                  {PLAYER_ARCHETYPES.map((a, i) => (
                    <Pressable
                      key={a.name}
                      onPress={() => setArchIdx(i)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: i === archIdx }}
                      style={[styles.pick, i === archIdx && styles.pickOn]}
                    >
                      <Text style={[styles.pickText, i === archIdx && styles.pickTextOn]}>
                        {a.name}
                      </Text>
                    </Pressable>
                  ))}
                </Row>
                {/* The rAF transport owns its own `pos` — see MotionTheater.
                    The key resets it when the rep or the archetype changes. */}
                <MotionTheater
                  key={`${theaterIdx}-${archIdx}`}
                  seq={selected.seq}
                  reference={reference}
                  hand={hand}
                  repIndex={selected.rep.index}
                  archetypeName={archetype.name}
                  width={width}
                  reducedMotion={reducedMotion}
                />

                {/* Rep-vs-reference similarity — a STYLE MATCH, never a
                    quality score; refuses below 5 measured rules. */}
                <View style={styles.simBlock}>
                  {(() => {
                    const sim = simByIndex.get(selected.rep.index) ?? null;
                    return sim != null ? (
                      <Row gap={space.md}>
                        <Text style={styles.simScore}>{sim.score}</Text>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.trendLabel}>
                            {`STYLE MATCH · ${sim.measuredRules} OF ${sim.totalRules} RULES MEASURED`}
                          </Text>
                          <Text style={styles.metricBand}>
                            {`style match vs synthesized ${archetype.name} reference — not a quality score`}
                          </Text>
                        </View>
                      </Row>
                    ) : (
                      <Text style={styles.metricBand}>
                        similarity — (too few joints seen)
                      </Text>
                    );
                  })()}
                </View>

                {cues.length > 0 && (
                  <View style={styles.cueList}>
                    {cues.map((cue, i) => (
                      <Row key={cue.id} gap={space.sm} style={styles.cueRow}>
                        <View style={styles.ruleBadge}>
                          <Text style={styles.ruleBadgeText}>{i + 1}</Text>
                        </View>
                        <Text style={[styles.body, { flex: 1 }]}>
                          {cue.joint}: {cue.cue}
                        </Text>
                      </Row>
                    ))}
                  </View>
                )}
                <Text style={styles.footnote}>{SESSION_FORM_REFERENCE_CAPTION}</Text>
              </Card>
            ) : (
              <Card>
                <Text style={styles.body}>
                  {refusedMotions > 0
                    ? `${refusedMotions === 1 ? 'One rep' : `${refusedMotions} reps`} recorded a motion window, but the pose in it could not be reconstructed as a standing body — the camera was rolled too far, or the keypoints collapsed. Nothing is drawn from it: a figure here would be invented, not measured. Stand side-on with the phone upright and the whole body in frame, then check again.`
                    : 'No rep captured a full motion window — nothing to compare yet.'}
                </Text>
              </Card>
            )}
          </View>
        )}

        {seg === 'depth' && (
          <View style={styles.segmentBody}>
            {lifted3d != null ? (
              <FormCheck3DPanel result={lifted3d} width={contentW} />
            ) : (
              <Card>
                <Text style={styles.body}>
                  {selected == null
                    ? 'No rep captured a full motion window, so there is nothing to lift into 3D yet.'
                    : 'This rep could not be lifted into 3D — too few frames, or the depth scale could not be trusted. It is left out rather than shown flat.'}
                </Text>
              </Card>
            )}
          </View>
        )}
      </View>

      {/* Foot — outside the tabs. */}
      <PillButton
        label="Compare your tracked shots in Form Studio"
        variant="ghost"
        icon="film-outline"
        onPress={() => router.push('/formstudio')}
      />
      <Text style={styles.footnote}>
        Form Studio compares TRACKED shots from live sessions — Form Check reps
        are motion-only and are not shots.
      </Text>
      {/* One tap back into a live session. Done leaves the screen entirely,
          which re-mounts it and re-pays the model load — the worst thing to
          do right after a stumble. */}
      {onAgain != null && (
        <PillButton label="Check again" icon="refresh-outline" onPress={onAgain} />
      )}
      {onDone != null && <PillButton label="Done" variant="ghost" onPress={onDone} />}
    </View>
  );
}

/** One calibration-receipt line: label left, measured value (or dash) right. */
function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={[styles.metricRowLine, styles.metricRow]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { flexShrink: 1 }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Verdict ring — the report's ONE earned arc moment (WssRing idiom, static).
// ---------------------------------------------------------------------------

const VERDICT_RING_SIZE = 64;
const VERDICT_RING_STROKE = 5;

function VerdictRing({ steady, measured }: { steady: number; measured: number }) {
  const r = (VERDICT_RING_SIZE - VERDICT_RING_STROKE) / 2;
  const progress = measured > 0 ? Math.max(0, Math.min(1, steady / measured)) : 0;

  const track = useMemo(() => {
    const p = Skia.Path.Make();
    p.addCircle(VERDICT_RING_SIZE / 2, VERDICT_RING_SIZE / 2, r);
    return p;
  }, [r]);
  const sweep = useMemo(() => {
    const p = Skia.Path.Make();
    const deg = 360 * progress;
    if (deg > 0) {
      p.addArc(
        Skia.XYWHRect(VERDICT_RING_STROKE / 2, VERDICT_RING_STROKE / 2, r * 2, r * 2),
        -90,
        deg,
      );
    }
    return p;
  }, [progress, r]);
  const motifPath = useMemo(
    () => arcMotif(VERDICT_RING_SIZE, VERDICT_RING_SIZE, { rimInset: 12 }).path,
    [],
  );

  return (
    // Hidden from the screen reader: the headline beside it speaks the verdict.
    <View style={styles.verdictRing} accessibilityElementsHidden>
      <Canvas style={{ width: VERDICT_RING_SIZE, height: VERDICT_RING_SIZE }}>
        <Path path={motifPath} style="stroke" strokeWidth={1.5} color={color.text} opacity={0.14} />
        <Path
          path={track}
          style="stroke"
          strokeWidth={VERDICT_RING_STROKE}
          color={color.hudGlassBorder}
          opacity={0.9}
        />
        <Path
          path={sweep}
          style="stroke"
          strokeWidth={VERDICT_RING_STROKE}
          strokeCap="round"
          color={color.accent}
        />
      </Canvas>
      <View style={styles.verdictCenter} pointerEvents="none">
        <Text style={styles.verdictRingValue}>{`${steady}/${measured}`}</Text>
        <Text style={styles.verdictRingLabel}>STEADY</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Trend line — small STATIC Skia polyline (PlacementDiagram precedent; no
// worklets, no new core). Values are plotted in draw order with an optional
// dashed median line.
// ---------------------------------------------------------------------------

function TrendLine({
  values,
  width,
  height,
  median = null,
  tint = color.accent,
}: {
  values: readonly number[];
  width: number;
  height: number;
  median?: number | null;
  tint?: string;
}) {
  const PAD = 6;
  if (values.length < 2 || width <= 0 || height <= 0) return null;
  const min = Math.min(...values, ...(median != null ? [median] : []));
  const max = Math.max(...values, ...(median != null ? [median] : []));
  const span = max - min || 1;
  const px = (i: number) => PAD + (i / (values.length - 1)) * (width - PAD * 2);
  const py = (v: number) => PAD + (1 - (v - min) / span) * (height - PAD * 2);
  const pts = values.map((v, i) => ({ x: px(i), y: py(v) }));
  const medY = median != null ? py(median) : null;
  const dashCount = Math.max(2, Math.floor((width - PAD * 2) / 14));

  return (
    <View style={{ width, height }}>
      <Canvas style={{ width, height }}>
        {medY != null &&
          Array.from({ length: dashCount }, (_, i) => (
            <Line
              key={`m-${i}`}
              p1={vec(PAD + i * 14, medY)}
              p2={vec(Math.min(PAD + i * 14 + 8, width - PAD), medY)}
              strokeWidth={1}
              color={color.textFaint}
            />
          ))}
        {pts.slice(1).map((p, i) => (
          <Line
            key={`l-${i}`}
            p1={vec(pts[i]!.x, pts[i]!.y)}
            p2={vec(p.x, p.y)}
            strokeWidth={2}
            strokeCap="round"
            color={tint}
          />
        ))}
        {pts.map((p, i) => (
          <Circle key={`d-${i}`} cx={p.x} cy={p.y} r={2.5} color={tint} />
        ))}
      </Canvas>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Per-rep row — compact line expanding to a metric table (FormReportCard
// idiom, with the tempo row honestly relabeled "Dip → release").
// ---------------------------------------------------------------------------

interface RepMetricRow {
  label: string;
  hint: (rep: FormCheckRep) => string;
  value: (rep: FormCheckRep) => string | null;
}

const REP_ROWS: RepMetricRow[] = [
  {
    label: 'Elbow set point',
    hint: () => `${FORM.elbowSetPoint.min}–${FORM.elbowSetPoint.max}°`,
    value: (r) =>
      r.metrics.setPointElbowDeg != null ? `${Math.round(r.metrics.setPointElbowDeg)}°` : null,
  },
  {
    label: 'Knee flexion',
    hint: () => `${FORM.kneeFlexion.min}–${FORM.kneeFlexion.max}°`,
    value: (r) =>
      r.metrics.kneeFlexionDeg != null ? `${Math.round(r.metrics.kneeFlexionDeg)}°` : null,
  },
  {
    label: 'Dip → release',
    hint: () => 'pose-timed tempo',
    value: (r) =>
      r.metrics.releaseTimeMs != null ? `${(r.metrics.releaseTimeMs / 1000).toFixed(2)}s` : null,
  },
  {
    label: 'Follow-through hold',
    hint: () => `${Math.round(FORM.followThrough.holdSec * 1000)}ms+`,
    value: (r) =>
      r.metrics.followThroughHeldMs != null
        ? `${Math.round(r.metrics.followThroughHeldMs)}ms`
        : null,
  },
  {
    // Metres only with a calibrated height scale (one decimal — it is an
    // estimate); otherwise v1's camera-relative % of frame, verbatim.
    label: 'Release height',
    hint: (r) =>
      r.releaseHeightM != null ? 'estimate from your profile height' : 'camera-relative',
    value: (r) =>
      r.releaseHeightM != null
        ? `≈ ${r.releaseHeightM.toFixed(1)} m`
        : r.metrics.releaseHeightNorm != null
          ? `${Math.round(r.metrics.releaseHeightNorm * 100)}%`
          : null,
  },
  {
    label: 'Release angle',
    hint: () => 'needs the ball — not measured here',
    value: () => null,
  },
  {
    label: 'Entry angle',
    hint: () => 'needs the ball — not measured here',
    value: () => null,
  },
];

/** Info-toned flag chip (annotate-only shadow-baseline flags). */
function FlagChip({ label }: { label: string }) {
  return (
    <View style={styles.flagChip}>
      <Text style={styles.flagChipText}>{label}</Text>
    </View>
  );
}

/** Amber sibling of FlagChip — a relaxed-gate reason, not an observation. */
function UnsureChip({ label }: { label: string }) {
  return (
    <View style={styles.unsureChip}>
      <Text style={styles.unsureChipText}>{label}</Text>
    </View>
  );
}

function RepRow({
  rep,
  best,
  sim,
}: {
  rep: FormCheckRep;
  best: boolean;
  sim: FormSimilarity | null;
}) {
  const [open, setOpen] = useState(false);
  const headline = rep.tips.find((t) => t.severity === 3) ?? rep.tips[0] ?? null;
  const lowConf = rep.lowConfidence ?? [];
  return (
    <View style={styles.repRowWrap}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`Rep ${rep.index} details${best ? ', best rep' : ''}`}
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Row gap={space.xs}>
              {best && <Ionicons name="star" size={iconSize.sm} color={color.accent} />}
              <Text style={styles.repRowTitle}>
                Rep {rep.index}
                {headline != null ? ` — ${headline.title}` : ''}
              </Text>
            </Row>
            <Text style={styles.metricBand}>{repSummary(rep) || 'tap for the metric table'}</Text>
            <View style={styles.repRowBar}>
              <PhaseBars phases={rep.phases} width={148} compact />
            </View>
            {(sim != null || rep.flags.length > 0 || lowConf.length > 0) && (
              <Row gap={space.xs} style={styles.repChipRow}>
                {sim != null && <FlagChip label={`match ${sim.score}`} />}
                {rep.flags.includes('shallowDip') && <FlagChip label="shallow dip" />}
                {rep.flags.includes('stanceDrift') && <FlagChip label="stance drift" />}
                {/* Amber, not info-blue: these are not observations about the
                    shot, they are the price of a relaxed gate. */}
                {lowConf.map((k) => (
                  <UnsureChip key={k} label={CONFIDENCE_WORD[k]} />
                ))}
              </Row>
            )}
          </View>
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={iconSize.lg}
            color={color.textFaint}
          />
        </Row>
      </Pressable>
      {open && (
        <View style={styles.repTable}>
          {headline != null && (
            <Text style={styles.repCue}>
              {headline.title}: {headline.message}
            </Text>
          )}
          {lowConf.length > 0 && (
            <Text style={styles.repLowConf}>
              {`Caught under a relaxed gate — ${lowConf
                .map((k) => CONFIDENCE_REASON[k])
                .join('; ')}.`}
            </Text>
          )}
          {REP_ROWS.map((row) => {
            const display = row.value(rep);
            return (
              <View
                key={row.label}
                style={[styles.metricRowLine, styles.metricRow]}
                accessible
                accessibilityLabel={
                  display != null
                    ? `${row.label}: ${display}`
                    : `${row.label}: not measured`
                }
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.metricLabel}>{row.label}</Text>
                  <Text style={styles.metricBand}>{row.hint(rep)}</Text>
                </View>
                <Text style={display != null ? styles.metricValue : styles.metricDash}>
                  {display ?? '—'}
                </Text>
              </View>
            );
          })}
          {/* Style match — labeled for what it is; refuses under 5 rules. */}
          <View
            style={[styles.metricRowLine, styles.metricRow]}
            accessible
            accessibilityLabel={
              sim != null
                ? `Style match: ${sim.score} out of 100, ${sim.measuredRules} of ${sim.totalRules} rules measured`
                : 'Style match: too few joints seen'
            }
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.metricLabel}>Style match</Text>
              <Text style={styles.metricBand}>
                {sim != null
                  ? 'vs a synthesized reference — not a quality score'
                  : 'too few joints seen'}
              </Text>
            </View>
            <Text style={sim != null ? styles.metricValue : styles.metricDash}>
              {sim != null ? String(sim.score) : '—'}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  stack: {
    // Common rhythm — see `layout` in constants/tokens.ts. No paddingBottom:
    // Screen already tails the scroll with insets.bottom + space.xxl.
    gap: layout.sectionGap,
    paddingTop: space.md,
  },
  reportStack: {
    gap: layout.sectionGap,
  },
  header: {
    marginBottom: space.sm,
  },
  kicker: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.4,
    marginBottom: 2,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  heroLead: {
    ...type.headingLarge,
    color: color.text,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.sm,
  },
  footnote: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  startCta: {
    alignSelf: 'stretch',
  },
  ruleRow: {
    marginTop: space.md,
    alignItems: 'flex-start',
  },
  ruleBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ruleBadgeText: {
    fontFamily: font.display,
    fontSize: 13,
    lineHeight: 16,
    color: color.accent,
  },
  diagramWrap: {
    alignItems: 'center',
    marginTop: space.sm,
  },
  diagramLabel: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.xs,
  },
  // live overlay
  /** The live phase's own root — NOT a child of the guide's ScrollView. */
  liveRoot: {
    flex: 1,
    backgroundColor: color.bg,
  },
  overlay: {
    ...absoluteFill,
    backgroundColor: color.bg,
    zIndex: 10,
  },
  liveScrim: {
    ...absoluteFill,
    justifyContent: 'space-between',
  },
  overlayContent: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: space.xl,
    gap: space.md,
  },
  overlayTitle: {
    ...type.title,
    color: color.text,
  },
  overlaySub: {
    ...type.body,
    color: color.textDim,
  },
  overlayCta: {
    alignSelf: 'stretch',
  },
  readyStrip: {
    // paddingTop is set at the call site from the safe-area inset: the strip
    // is now pinned to the TRUE top of the screen, so the notch is the only
    // thing between it and the status bar.
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  railCard: {
    backgroundColor: color.hudGlassDeep,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    padding: space.md,
    gap: space.sm,
  },
  stepTitle: {
    // headingLarge, not eyebrow: this line is the presenter's only read of
    // where calibration is, on a phone that may be three metres away or
    // mirrored to a projector. letterSpacing restated — headingLarge drops it.
    ...type.headingLarge,
    letterSpacing: 1.2,
    color: color.accent,
  },
  stepSub: {
    ...type.caption,
    color: color.textDim,
  },
  stepGate: {
    ...type.caption,
    color: color.unsure,
  },
  stepActions: {
    marginTop: space.xs,
  },
  stepPill: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  stepPillPrimary: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  stepPillText: {
    ...type.caption,
    color: color.text,
  },
  stepPillPrimaryText: {
    ...type.caption,
    color: color.onAccent,
  },
  armedText: {
    ...type.bodyMedium,
    color: color.text,
    textAlign: 'center',
  },
  readyBanner: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    backgroundColor: color.hudGlassDeep,
    borderRadius: radius.md,
    padding: space.md,
  },
  readyBannerInfo: {
    // Advisory tone — visually distinct from the pausing gates.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.info,
  },
  readyBannerOk: {
    // The positive state, given the same weight as a warning: "the app is
    // measuring you" must be as loud as "the app is refusing".
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.make,
  },
  readyBannerText: {
    // heading, not body — this is the one line that has to read at distance.
    ...type.heading,
    color: color.unsure,
    flex: 1,
  },
  readyBannerTextInfo: {
    color: color.info,
  },
  readyBannerTextOk: {
    color: color.make,
  },
  holdHint: {
    ...type.caption,
    color: color.textDim,
    textAlign: 'center',
  },
  sideChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  sideChipLabel: {
    ...type.micro,
  },
  liveBottom: {
    padding: space.xl,
    gap: space.md,
  },
  repBlock: {
    alignItems: 'center',
    marginBottom: space.sm,
  },
  repBig: {
    fontFamily: font.display,
    fontSize: 72,
    lineHeight: 74,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  repLabel: {
    ...type.micro,
    color: color.textDim,
    letterSpacing: 1.2,
  },
  lastRepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.sm,
  },
  lastRepText: {
    ...type.caption,
    color: color.text,
  },
  liveActions: {
    alignItems: 'center',
  },
  flipPill: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: color.hudGlass,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // report
  verdictCard: {
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.accentEdge,
  },
  verdictRow: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  verdictHeadline: {
    ...type.heading,
    color: color.text,
  },
  verdictRing: {
    width: VERDICT_RING_SIZE,
    height: VERDICT_RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verdictCenter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verdictRingValue: {
    fontFamily: font.display,
    fontSize: 18,
    lineHeight: 20,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  verdictRingLabel: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1,
  },
  segmentBlock: {
    gap: layout.cardGap,
  },
  segmentBody: {
    gap: layout.sectionGap,
  },
  trendLabel: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1,
    marginTop: space.sm,
  },
  trendCaption: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.xs,
  },
  bestRow: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  bestIndex: {
    ...type.statMedium,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  bestCta: {
    marginTop: space.md,
    alignSelf: 'flex-start',
  },
  receiptLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingVertical: space.sm,
  },
  receiptLinkText: {
    ...type.caption,
    color: color.accent,
    flex: 1,
  },
  simBlock: {
    marginTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingTop: space.sm,
  },
  simScore: {
    ...type.statMedium,
    color: color.info,
    fontVariant: ['tabular-nums'],
  },
  spreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.sm,
    marginTop: space.xs,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  metricRow: {
    justifyContent: 'space-between',
    paddingVertical: space.sm,
    gap: space.md,
  },
  metricRowLine: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metricLabel: {
    ...type.bodyMedium,
    color: color.text,
  },
  metricBand: {
    ...type.micro,
    color: color.textFaint,
  },
  metricValue: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  metricDash: {
    ...type.bodyMedium,
    color: color.textFaint,
  },
  repRowWrap: {
    marginTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingTop: space.md,
  },
  repRowTitle: {
    ...type.bodyMedium,
    color: color.text,
  },
  repRowBar: {
    marginTop: space.xs,
  },
  repChipRow: {
    marginTop: space.xs,
    flexWrap: 'wrap',
  },
  flagChip: {
    borderRadius: radius.pill,
    backgroundColor: color.infoTint,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  flagChipText: {
    ...type.micro,
    color: color.info,
  },
  unsureChip: {
    borderRadius: radius.pill,
    backgroundColor: 'rgba(232,184,79,0.14)',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  unsureChipText: {
    ...type.micro,
    color: color.unsure,
  },
  repLowConf: {
    ...type.caption,
    color: color.unsure,
    paddingBottom: space.sm,
  },
  lowConfBanner: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    backgroundColor: 'rgba(232,184,79,0.10)',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.unsure,
    padding: space.md,
  },
  lowConfText: {
    ...type.body,
    color: color.unsure,
    flex: 1,
  },
  repTable: {
    marginTop: space.sm,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  repCue: {
    ...type.body,
    color: color.accent,
    paddingVertical: space.sm,
  },
  pick: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  pickOn: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  pickText: {
    ...type.caption,
    color: color.textDim,
  },
  pickTextOn: {
    color: color.accent,
  },
  track: {
    height: 28,
    marginTop: space.md,
    justifyContent: 'center',
  },
  trackFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.surfaceRaised,
  },
  trackProgress: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.accent,
  },
  trackThumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    backgroundColor: color.accent,
    borderWidth: 2,
    borderColor: color.bg,
  },
  transport: {
    marginTop: space.md,
    alignItems: 'center',
  },
  playBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phaseInline: {
    ...type.caption,
    color: color.accent,
    letterSpacing: 1,
  },
  cueList: {
    marginTop: space.md,
  },
  cueRow: {
    marginTop: space.sm,
    alignItems: 'flex-start',
  },
  honesty: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
  },
  honestyText: {
    ...type.caption,
    color: color.textFaint,
    flex: 1,
    lineHeight: 17,
  },
});
