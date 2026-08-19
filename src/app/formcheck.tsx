/**
 * Form Check — hoop-free shooting-form reps from the front camera.
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
} from 'react-native-vision-camera';
import { useResizer } from 'react-native-vision-camera-resizer';
import {
  loadTensorflowModel,
  type TensorflowModel,
} from 'react-native-fast-tflite';
import { Canvas, Circle, Line, Path, Skia, vec } from '@shopify/react-native-skia';

import { FormMotionStage, type StagePhase } from '@/components/charts/FormMotionStage';
import { PhaseBars } from '@/components/charts/PhaseBars';
import { ArcReveal, arcMotif } from '@/components/motion';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { SegmentedTabs, type SegmentedTabItem } from '@/components/SegmentedTabs';
import { SESSION_FORM_REFERENCE_CAPTION } from '@/components/SessionFormReport';
import { BackPill } from '@/components/ShotList';
import { Card, Chip, PillButton, Row, Screen } from '@/components/ui';
import { color, font, iconSize, layout, radius, space, type } from '@/constants/tokens';
import { FORM } from '@/core/config';
import {
  ELBOW_SPREAD_FLAG_DEG,
  FormCheckSession,
  KNEE_SPREAD_FLAG_DEG,
  MIN_POSE_FPS,
  MIN_SPREAD_REPS,
  RELEASE_HEIGHT_SPREAD_FLAG,
  SHADOW_REPS_TARGET,
  TEMPO_SPREAD_FLAG_MS,
  TILT_MAX_COMP_DEG,
  type CalibrationState,
  type FormCheckReadiness,
  type FormCheckRep,
  type FormCheckSessionReport,
  type HandSource,
  type RepPhaseTiming,
  type SpreadStat,
} from '@/core/formCheck';
import { decodeSequence } from '@/core/formSequence';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { formSimilarity, type FormSimilarity } from '@/core/formSimilarity';
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

/** Skeleton overlay poll interval, ms (~12 Hz — CaptureProgress precedent). */
const OVERLAY_POLL_MS = 80;

/** Live rail poll interval, ms (~4 Hz — readiness + calibration snapshot). */
const READINESS_POLL_MS = 250;

/** How long the "Calibrated — scoring armed" ArcReveal owns the rail, ms. */
const ARMED_BANNER_MS = 2600;

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

/** One streamed sample: the parsed pose + the sensor dims (overlay mapping). */
interface FormPoseSample {
  pose: ReturnType<typeof parseMoveNet>;
  frameW: number;
  frameH: number;
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
  const { hasPermission, requestPermission } = useCameraPermission();

  const [model, setModel] = useState<TensorflowModel | null>(null);
  const boxedPoseSv = useSharedValue<ReturnType<typeof NitroModules.box> | null>(null);
  const framesSv = useSharedValue(0);

  // Load MoveNet once (fast delegate → CPU fallback), mirroring useShotEngine's
  // pose loader. Boxed into a SharedValue so the frame worklet reads it fresh.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const accel: ('core-ml' | 'android-gpu')[] =
        Platform.OS === 'ios' ? ['core-ml'] : ['android-gpu'];
      for (const d of [accel, [] as ('core-ml' | 'android-gpu')[]]) {
        try {
          const m = await loadTensorflowModel(POSE_ASSET, d);
          if (!alive) return;
          setModel(m);
          boxedPoseSv.value = NitroModules.box(m);
          return;
        } catch {
          // try next (CPU) rung
        }
      }
    })();
    return () => {
      alive = false;
      boxedPoseSv.value = null;
    };
  }, [boxedPoseSv]);

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
          const tSec =
            frame.timestamp > 1e6 ? frame.timestamp / 1e9 : frame.timestamp;
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
        // A single bad frame must never kill the frame processor.
      } finally {
        frame.dispose();
      }
    },
  });

  return {
    device,
    hasPermission,
    requestPermission,
    outputs: [frameOutput],
    modelLoaded: model != null,
    framesSv,
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
 * The ONE guidance banner, chosen by priority: model warmup → fps → full
 * body → arm → side-profile → tilt advisory. Hard gates pause rep counting
 * (the caller appends the paused line); the tilt advisory never pauses —
 * the detector degrades under heavy roll, so we ask for a level phone rather
 * than pretend to fix it. While `collecting`, the arm branch is skipped
 * (calibration is what determines the arm) and no tilt exists yet.
 */
export function guidanceBanner(
  modelLoaded: boolean,
  r: FormCheckReadiness | null,
  hand: ShootingHand,
  calib: CalibrationState | null,
  collecting: boolean,
): { text: string; pauses: boolean } | null {
  if (!modelLoaded) return { text: 'Warming up the pose model…', pauses: true };
  if (r == null) return null;
  if (!r.fpsOk) {
    return {
      text: `Pose is at ${Math.round(r.fps)} fps — too slow. More light helps.`,
      pauses: true,
    };
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
  const tilt = calib?.tilt;
  if (tilt != null && Math.abs(tilt.tiltDeg) > TILT_MAX_COMP_DEG) {
    return { text: 'Straighten the phone.', pauses: false };
  }
  return null;
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
      releaseHeightM: r.releaseHeightM,
      tips: r.tips.map((t) => t.title),
    })),
    spreads: report.spreads,
    best: report.best,
    verdict: report.verdict,
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
  const [camPosition, setCamPosition] = useState<'front' | 'back'>('front');
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

  const sink = useCallback((s: FormPoseSample) => {
    latestRef.current = s;
    const session = sessionRef.current;
    if (session == null) return;
    const rep = session.push(s.pose);
    // Auto-handedness may flip the watched arm at calibration lock — mirror
    // it into screen state WITHOUT calling setHand back into the session
    // (that would read as a manual pick and disable the vote).
    if (session.hand !== handRef.current) {
      handRef.current = session.hand;
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
  }, []);

  const live = phase === 'live';
  const pose = useFormPose(live, camPosition, sink);

  const startLive = useCallback(() => {
    handRef.current = hand;
    sessionRef.current = new FormCheckSession({
      hand,
      frameHeight: POSE_INPUT,
      heightCm: heightCm ?? null,
    });
    latestRef.current = null;
    setRepCount(0);
    setLastRep(null);
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
      void insertFormSession(formSessionRowOf(sessionReport, sessionReps, Date.now())).then(
        (id) => setSavedId(id),
      );
    }
  }, []);

  const flipHand = useCallback(() => {
    const next: ShootingHand = handRef.current === 'right' ? 'left' : 'right';
    handRef.current = next;
    // A manual pick wins permanently for the session and disables auto.
    sessionRef.current?.setHand(next, 'manual');
    setHand(next);
    haptic.selection();
  }, []);

  const recalibrate = useCallback(() => {
    sessionRef.current?.recalibrate();
    haptic.selection();
  }, []);

  // Silence any in-flight callout on the way out.
  useEffect(() => stopSpeech, []);

  const cardEnter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(360);

  // Camera permission gate — only matters once the user starts a check.
  const needsPermission = pose.device != null && !pose.hasPermission;

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
            onDone={() => router.back()}
          />
        </View>
      </Screen>
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
            text="Prop the phone at your SIDE, on your shooting-arm side, screen facing you."
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
            Needs at least {MIN_POSE_FPS} fps pose. Below that the screen
            refuses to count reps rather than guess.
          </Text>
        </Card>

        <PillButton
          label="Start form check"
          icon="body-outline"
          onPress={startLive}
          style={styles.startCta}
        />
      </View>

      {/* Full-screen live overlay */}
      {live && (
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
          repCount={repCount}
          lastRep={lastRep}
          onEnd={endSession}
          onCancel={cancelLive}
        />
      )}
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
  repCount,
  lastRep,
  onEnd,
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
  repCount: number;
  lastRep: FormCheckRep | null;
  onEnd: () => void;
  onCancel: () => void;
}) {
  const { canRequestPermission } = useCameraPermission();

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
            label={canRequestPermission ? 'Allow camera access' : 'Open settings'}
            onPress={() =>
              canRequestPermission
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

  return (
    <View style={styles.overlay}>
      {pose.device != null && (
        <Camera
          style={StyleSheet.absoluteFill}
          isActive
          device={pose.device}
          outputs={pose.outputs}
          resizeMode="contain"
          orientationSource="interface"
        />
      )}
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
          onFlipHand={onFlipHand}
        />
        {/* Zone C: the big rep numeral, the last-rep phase line, actions. */}
        <View style={styles.liveBottom} pointerEvents="box-none">
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
            <Pressable
              onPress={onRecalibrate}
              accessibilityRole="button"
              accessibilityLabel="Recalibrate"
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
          <PillButton label="Cancel" variant="ghost" onPress={onCancel} />
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
  onFlipHand,
}: {
  sessionRef: React.MutableRefObject<FormCheckSession | null>;
  modelLoaded: boolean;
  onFlipHand: () => void;
}) {
  const { width: winW } = useWindowDimensions();
  const [snap, setSnap] = useState<RailSnap | null>(() => railSnapOf(sessionRef.current));
  useEffect(() => {
    const id = setInterval(() => setSnap(railSnapOf(sessionRef.current)), READINESS_POLL_MS);
    return () => clearInterval(id);
  }, [sessionRef]);
  const refresh = useCallback(() => setSnap(railSnapOf(sessionRef.current)), [sessionRef]);

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

  const banner = guidanceBanner(
    modelLoaded,
    readiness,
    calib?.hand ?? 'right',
    calib,
    collecting,
  );

  if (collecting && calib != null) {
    const step = Math.min(calib.shadowReps + 1, SHADOW_REPS_TARGET);
    return (
      <View style={styles.readyStrip}>
        <View style={styles.railCard}>
          <Row gap={space.md}>
            <PulsingStepRing progress={calib.shadowReps / SHADOW_REPS_TARGET} />
            <View style={{ flex: 1, minWidth: 0 }}>
              {/* Static text carrier — the step read survives reduced motion. */}
              <Text style={styles.stepTitle}>
                {`PRACTICE MOTION ${step} OF ${SHADOW_REPS_TARGET}`}
              </Text>
              <Text style={styles.stepSub}>Not scored — calibrating.</Text>
            </View>
          </Row>
          {banner != null && (
            <Text style={styles.stepGate}>
              {banner.text} Practice motions are paused.
            </Text>
          )}
          <Row gap={space.sm} style={styles.stepActions}>
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
      <View style={styles.readyStrip}>
        <View style={styles.railCard}>
          <ArmedReveal width={railW} />
          {/* Static carrier — reduced motion still reads the state change. */}
          <Text style={styles.armedText}>Calibrated — scoring armed</Text>
        </View>
      </View>
    );
  }

  const fps = readiness?.fps ?? 0;
  const fpsOk = readiness?.fpsOk ?? false;
  const fullBodyOk = readiness?.fullBodyOk ?? false;
  const armOk = readiness?.armOk ?? false;
  const sideOk = readiness?.sideOk ?? true;
  const chipHand = calib?.hand ?? 'right';
  const chipSource = calib?.handSource ?? 'settings';

  return (
    <View style={styles.readyStrip}>
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        <Chip label={`${Math.round(fps)} FPS`} tone={fpsOk ? 'make' : 'unsure'} compact />
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
        <SideChip sideness={readiness?.sideness ?? null} ok={sideOk} />
      </Row>
      {banner != null && (
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
        </View>
      )}
    </View>
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

/** Tiny 0–1 side-profile arc meter chip. Null = the gauge honestly can't
 *  vote (occlusion) — the chip shows a dash and the gate PASSES. */
function SideChip({ sideness, ok }: { sideness: number | null; ok: boolean }) {
  const w = 18;
  const h = 11;
  const track = useMemo(() => {
    const p = Skia.Path.Make();
    p.addArc(Skia.XYWHRect(2, 2, w - 4, (h - 3) * 2), 180, 180);
    return p;
  }, []);
  return (
    <View
      style={[styles.sideChip, { backgroundColor: ok ? color.makeTint : 'rgba(232,184,79,0.14)' }]}
      accessible
      accessibilityLabel={
        sideness != null
          ? `Side-on ${Math.round(sideness * 100)} percent`
          : 'Side-on not measurable'
      }
    >
      <Text style={[styles.sideChipLabel, { color: ok ? color.make : color.unsure }]}>SIDE</Text>
      {sideness != null ? (
        <Canvas style={{ width: w, height: h }}>
          <Path path={track} style="stroke" strokeWidth={2.5} color={color.border} />
          <Path
            path={track}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            color={ok ? color.make : color.unsure}
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

type ReportSeg = 'overview' | 'reps' | 'compare';

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

export function FormCheckReport({
  reps,
  report,
  hand,
  savedId,
  heightCm = null,
  onDone,
}: {
  reps: readonly FormCheckRep[];
  report: FormCheckSessionReport;
  hand: ShootingHand;
  /** null = save in flight, ≥0 = saved row id, −1 = insert failed. */
  savedId: number | null;
  /** Profile height (for the receipt's honest "why no metres" branch). */
  heightCm?: number | null;
  onDone?: () => void;
}) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const [seg, setSeg] = useState<ReportSeg>('overview');

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

  // Theater: reps whose sequence decodes.
  const theaterReps = useMemo(
    () =>
      reps
        .map((rep) => ({
          rep,
          seq: rep.sequence != null ? decodeSequence(rep.sequence) : [],
        }))
        .filter((r) => r.seq.length >= 2),
    [reps],
  );
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

  // Transport (formstudio pattern: autoplay + scrub; stepper under reduced
  // motion).
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
  useEffect(() => {
    setPlaying(false);
    setPos(0);
  }, [theaterIdx, archIdx]);

  const trackWidthRef = useRef(1);
  const seekFromEvent = (e: GestureResponderEvent) => {
    const x = e.nativeEvent.locationX;
    setPos(Math.max(0, Math.min(1, x / trackWidthRef.current)));
  };
  const frameCount = selected ? selected.seq.length : 1;
  const stepFrame = (dir: 1 | -1) => {
    const cur = Math.round(pos * (frameCount - 1));
    const next = Math.max(0, Math.min(frameCount - 1, cur + dir));
    setPos(frameCount <= 1 ? 0 : next / (frameCount - 1));
  };
  const stagePhase = phaseForPos(pos);
  const stageW = Math.min(width - 40, 560);
  const stageH = Math.round(stageW * 0.62);

  const jumpToCompare = useCallback(
    (repIndex: number) => {
      const i = theaterReps.findIndex((tr) => tr.rep.index === repIndex);
      if (i >= 0) setTheaterIdx(i);
      setSeg('compare');
    },
    [theaterReps],
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
  ];

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
                  calib.sidenessAvg != null
                    ? `${Math.round(calib.sidenessAvg * 100)}% side-on`
                    : '—'
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
                <View style={{ alignItems: 'center' }}>
                  <FormMotionStage
                    user={selected.seq}
                    reference={reference}
                    pos={pos}
                    hand={hand}
                    phase={stagePhase}
                    width={stageW}
                    height={stageH}
                    accessibilityLabel={`Rep ${selected.rep.index}'s motion at the ${stagePhase} phase beside a synthesized ${archetype.name} reference form`}
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
                      <Ionicons
                        name={playing ? 'pause' : 'play'}
                        size={20}
                        color={color.onAccent}
                      />
                    </Pressable>
                    <Text style={styles.phaseInline}>{stagePhase}</Text>
                  </Row>
                )}

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
                  No rep captured a full motion window — nothing to compare yet.
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
      {onDone != null && <PillButton label="Done" onPress={onDone} />}
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
            {(sim != null || rep.flags.length > 0) && (
              <Row gap={space.xs} style={styles.repChipRow}>
                {sim != null && <FlagChip label={`match ${sim.score}`} />}
                {rep.flags.includes('shallowDip') && <FlagChip label="shallow dip" />}
                {rep.flags.includes('stanceDrift') && <FlagChip label="stance drift" />}
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
    paddingTop: space.hero,
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
    ...type.eyebrow,
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
  readyBannerText: {
    ...type.body,
    color: color.unsure,
    flex: 1,
  },
  readyBannerTextInfo: {
    color: color.info,
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
