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
 * ── Camera plumbing ──────────────────────────────────────────────────────────
 * useFormPose is jump.tsx's useJumpPose, verbatim in structure: the same
 * MoveNet asset, the same core-ml/android-gpu → CPU loader ladder, the same
 * NitroModules.box SharedValue, the same frame → useResizer(192, cover) →
 * runSync → parseMoveNet → scheduleOnRN worklet, the same try/finally
 * frame.dispose and the same iOS-seconds/Android-ns timestamp normalization.
 * The only delta: it ships the WHOLE 17-keypoint PoseFrame (plus the sensor
 * dims for overlay mapping) instead of four ankle/hip numbers, because the
 * detector and the sequence packer need every landmark.
 *
 * The skeleton overlay is deliberately NOT a worklet: a plain Skia canvas on
 * the JS thread, polled from a ref at ~12 Hz (the CaptureProgress precedent).
 * Pose analysis runs faster underneath; the overlay is presentation only and
 * never feeds metrics.
 *
 * Honest about limits: needs ≥ 15 fps pose and your WHOLE body + shooting arm
 * in frame; below any gate the screen pauses rep counting and says why
 * (Jump Lab's refuse-below-15fps contract, reused). The report is not saved
 * in v1 — the copy says so.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
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
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { useSharedValue } from 'react-native-reanimated';
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
import { Canvas, Circle, Line, vec } from '@shopify/react-native-skia';

import { FormMotionStage, type StagePhase } from '@/components/charts/FormMotionStage';
import { SectionEyebrow } from '@/components/ScreenHeader';
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
  TEMPO_SPREAD_FLAG_MS,
  type FormCheckReadiness,
  type FormCheckRep,
  type FormCheckSessionReport,
  type SpreadStat,
} from '@/core/formCheck';
import { decodeSequence } from '@/core/formSequence';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { posturePlan, type PostureCue } from '@/core/postureFix';
import type { FormMetrics, PoseKeypointName, ShootingHand } from '@/core/types';
import { parseMoveNet } from '@/ml/poseParser';
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

/** Readiness strip poll interval, ms. */
const READINESS_POLL_MS = 250;

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
// Screen
// ---------------------------------------------------------------------------

export default function FormCheckScreen() {
  useKeepAwake();
  const reducedMotion = useReducedMotion();
  const settingsHand = useSettings((s) => s.shootingHand);

  const [phase, setPhase] = useState<CheckPhase>('guide');
  const [camPosition, setCamPosition] = useState<'front' | 'back'>('front');
  // Screen-local watched arm — seeded from Settings, never written back.
  const [hand, setHand] = useState<ShootingHand>(settingsHand);
  const [repCount, setRepCount] = useState(0);
  const [lastRep, setLastRep] = useState<FormCheckRep | null>(null);
  const [reps, setReps] = useState<readonly FormCheckRep[]>([]);
  const [report, setReport] = useState<FormCheckSessionReport | null>(null);

  const sessionRef = useRef<FormCheckSession | null>(null);
  const latestRef = useRef<FormPoseSample | null>(null);

  const sink = useCallback((s: FormPoseSample) => {
    latestRef.current = s;
    const session = sessionRef.current;
    if (session == null) return;
    const rep = session.push(s.pose);
    if (rep != null) {
      haptic.impactMedium();
      setRepCount(session.reps.length);
      setLastRep(rep);
    }
  }, []);

  const live = phase === 'live';
  const pose = useFormPose(live, camPosition, sink);

  const startLive = useCallback(() => {
    sessionRef.current = new FormCheckSession({
      hand,
      frameHeight: POSE_INPUT,
    });
    latestRef.current = null;
    setRepCount(0);
    setLastRep(null);
    setPhase('live');
    haptic.impactMedium();
  }, [hand]);

  const cancelLive = useCallback(() => {
    sessionRef.current = null;
    setPhase('guide');
  }, []);

  const endSession = useCallback(() => {
    const session = sessionRef.current;
    if (session == null) return;
    setReport(session.finalizeSession());
    setReps(session.reps.slice());
    sessionRef.current = null;
    haptic.success();
    setPhase('report');
  }, []);

  const flipHand = useCallback(() => {
    setHand((h) => (h === 'right' ? 'left' : 'right'));
    haptic.selection();
  }, []);
  // Keep the live session watching the chosen arm (updater stays pure).
  useEffect(() => {
    sessionRef.current?.setHand(hand);
  }, [hand]);

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
// Live overlay — camera, skeleton, readiness strip, rep counter.
// ---------------------------------------------------------------------------

function LiveOverlay({
  pose,
  needsPermission,
  camPosition,
  onFlipCamera,
  hand,
  onFlipHand,
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
      {/* Presentation-only skeleton — a front preview is mirrored, so the
          overlay x-flips to match. Never feeds metrics. */}
      <SkeletonOverlay
        latestRef={latestRef}
        mirrored={camPosition === 'front'}
        hand={hand}
      />
      <View style={styles.liveScrim} pointerEvents="box-none">
        <ReadinessStrip
          sessionRef={sessionRef}
          hand={hand}
          onFlipHand={onFlipHand}
          modelLoaded={pose.modelLoaded}
        />
        <View style={styles.liveBottom} pointerEvents="box-none">
          <View style={styles.repBlock}>
            <Text style={styles.repBig}>{repCount}</Text>
            <Text style={styles.repLabel}>REPS DETECTED</Text>
            {lastRep != null && (
              <Animated.View
                key={lastRep.index}
                entering={FadeIn.reduceMotion(ReduceMotion.System)}
              >
                <Text style={styles.lastRepText}>{lastRepLine(lastRep)}</Text>
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

/** One-line last-rep strip, e.g. "Rep 4 — elbow 84° · dip→release 0.61 s". */
function lastRepLine(rep: FormCheckRep): string {
  const summary = repSummary(rep);
  return `Rep ${rep.index}${summary.length > 0 ? ` — ${summary}` : ''}`;
}

/**
 * Readiness strip: pose fps, full-body and shooting-arm gates. Polls the
 * session at ~4 Hz (never per frame — the live view keeps its re-render
 * surface minimal). While any gate fails, rep counting is PAUSED and the
 * banner says why — the refuse-don't-guess contract.
 */
function ReadinessStrip({
  sessionRef,
  hand,
  onFlipHand,
  modelLoaded,
}: {
  sessionRef: React.MutableRefObject<FormCheckSession | null>;
  hand: ShootingHand;
  onFlipHand: () => void;
  modelLoaded: boolean;
}) {
  const [readiness, setReadiness] = useState<FormCheckReadiness | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      setReadiness(sessionRef.current?.readiness ?? null);
    }, READINESS_POLL_MS);
    return () => clearInterval(id);
  }, [sessionRef]);

  const fps = readiness?.fps ?? 0;
  const fpsOk = readiness?.fpsOk ?? false;
  const fullBodyOk = readiness?.fullBodyOk ?? false;
  const armOk = readiness?.armOk ?? false;
  const ready = readiness?.ready ?? false;

  let banner: string | null = null;
  if (!modelLoaded) banner = 'Warming up the pose model…';
  else if (!fpsOk)
    banner = `Pose is running at ${Math.round(fps)} fps — too slow to count reps. More light helps.`;
  else if (!fullBodyOk) banner = 'Step back — head to feet must be in frame.';
  else if (!armOk)
    banner = `Can't see your ${hand} arm clearly — camera on your shooting-arm side, or tap the arm chip to flip.`;

  return (
    <View style={styles.readyStrip}>
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        <Chip
          label={`POSE ${Math.round(fps)} FPS`}
          tone={fpsOk ? 'make' : 'unsure'}
          compact
        />
        <Chip label="FULL BODY" tone={fullBodyOk ? 'make' : 'unsure'} compact />
        <Pressable
          onPress={onFlipHand}
          accessibilityRole="button"
          accessibilityLabel={`Watching your ${hand} arm. Tap to watch the other arm.`}
        >
          <Chip
            label={`WATCHING ${hand.toUpperCase()} ARM`}
            tone={armOk ? 'make' : 'unsure'}
            compact
          />
        </Pressable>
      </Row>
      {banner != null && (
        <View style={styles.readyBanner}>
          <Ionicons name="alert-circle-outline" size={iconSize.md} color={color.unsure} />
          <Text style={styles.readyBannerText}>
            {banner} Rep counting is paused.
          </Text>
        </View>
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
  onDone,
}: {
  reps: readonly FormCheckRep[];
  report: FormCheckSessionReport;
  hand: ShootingHand;
  onDone?: () => void;
}) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();

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
        <Chip label={`${hand} arm`} />
      </Row>

      {/* Consistency first — the cross-rep read is the session's headline. */}
      <Card>
        <SectionEyebrow icon="pulse">Consistency</SectionEyebrow>
        {report.repCount < MIN_SPREAD_REPS && (
          <Text style={styles.body}>
            Need {MIN_SPREAD_REPS - report.repCount} more{' '}
            {MIN_SPREAD_REPS - report.repCount === 1 ? 'rep' : 'reps'} for a
            consistency read — spreads are only computed from at least{' '}
            {MIN_SPREAD_REPS} measured reps, never fabricated from fewer.
          </Text>
        )}
        {spreadRows.map((row, i) => (
          <View key={row.label} style={[styles.spreadRow, i > 0 && styles.rowDivider]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.metricLabel}>{row.label}</Text>
              <Text style={styles.metricBand}>
                {row.stat.value != null
                  ? `flagged past ±${row.unit === 'ms' ? `${row.flag} ms` : row.unit === 'frame' ? `${row.flag * 100}% of frame` : `${row.flag}°`}`
                  : row.stat.reason ?? 'not measured'}
              </Text>
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

      {/* Per-rep detail */}
      <Card>
        <SectionEyebrow icon="list-outline">Rep by rep</SectionEyebrow>
        {reps.map((rep) => (
          <RepRow key={rep.index} rep={rep} />
        ))}
      </Card>

      {/* Motion theater */}
      {selected != null && (
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
      )}

      {/* Honesty footer */}
      <View style={styles.honesty}>
        <Ionicons name="information-circle-outline" size={iconSize.md} color={color.textFaint} />
        <Text style={styles.honestyText}>
          These are 2D angles in the camera plane from pose keypoints — not a
          3D measurement. Reps are detected from your motion signature, not a
          tracked ball, so nothing here claims a make or a miss. This report is
          not saved yet — it lives only until you leave this screen.
        </Text>
      </View>
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

// ---------------------------------------------------------------------------
// Per-rep row — compact line expanding to a metric table (FormReportCard
// idiom, with the tempo row honestly relabeled "Dip → release").
// ---------------------------------------------------------------------------

interface RepMetricRow {
  label: string;
  hint: string;
  value: (m: FormMetrics) => string | null;
}

const REP_ROWS: RepMetricRow[] = [
  {
    label: 'Elbow set point',
    hint: `${FORM.elbowSetPoint.min}–${FORM.elbowSetPoint.max}°`,
    value: (m) => (m.setPointElbowDeg != null ? `${Math.round(m.setPointElbowDeg)}°` : null),
  },
  {
    label: 'Knee flexion',
    hint: `${FORM.kneeFlexion.min}–${FORM.kneeFlexion.max}°`,
    value: (m) => (m.kneeFlexionDeg != null ? `${Math.round(m.kneeFlexionDeg)}°` : null),
  },
  {
    label: 'Dip → release',
    hint: 'pose-timed tempo',
    value: (m) => (m.releaseTimeMs != null ? `${(m.releaseTimeMs / 1000).toFixed(2)}s` : null),
  },
  {
    label: 'Follow-through hold',
    hint: `${Math.round(FORM.followThrough.holdSec * 1000)}ms+`,
    value: (m) =>
      m.followThroughHeldMs != null ? `${Math.round(m.followThroughHeldMs)}ms` : null,
  },
  {
    label: 'Release height',
    hint: 'camera-relative',
    value: (m) =>
      m.releaseHeightNorm != null ? `${Math.round(m.releaseHeightNorm * 100)}%` : null,
  },
  {
    label: 'Release angle',
    hint: 'needs the ball — not measured here',
    value: () => null,
  },
  {
    label: 'Entry angle',
    hint: 'needs the ball — not measured here',
    value: () => null,
  },
];

function RepRow({ rep }: { rep: FormCheckRep }) {
  const [open, setOpen] = useState(false);
  const headline = rep.tips.find((t) => t.severity === 3) ?? rep.tips[0] ?? null;
  return (
    <View style={styles.repRowWrap}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`Rep ${rep.index} details`}
      >
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.repRowTitle}>
              Rep {rep.index}
              {headline != null ? ` — ${headline.title}` : ''}
            </Text>
            <Text style={styles.metricBand}>{repSummary(rep) || 'tap for the metric table'}</Text>
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
            const display = row.value(rep.metrics);
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
                  <Text style={styles.metricBand}>{row.hint}</Text>
                </View>
                <Text style={display != null ? styles.metricValue : styles.metricDash}>
                  {display ?? '—'}
                </Text>
              </View>
            );
          })}
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
  readyBanner: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    backgroundColor: color.hudGlassDeep,
    borderRadius: radius.md,
    padding: space.md,
  },
  readyBannerText: {
    ...type.body,
    color: color.unsure,
    flex: 1,
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
  lastRepText: {
    ...type.body,
    color: color.text,
    marginTop: space.sm,
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
