/**
 * Jump Lab — measure your vertical jump from pose, track it over time, and
 * train it.
 *
 * ── How pose gets here (the least-invasive path) ─────────────────────────────
 * The live shot engine (src/camera/useShotEngine.ts) only runs the MoveNet pose
 * model when the "form analysis" setting is on, and even then it consumes the
 * keypoints INTERNALLY (FormAnalyzer / release detector) — the raw ankle/hip
 * positions are never surfaced on its public overlay/debug SharedValues. Editing
 * useShotEngine to expose them was out of scope (it is the flagship live path and
 * off-limits here). So Jump Lab runs its OWN minimal, self-contained pose loop:
 * the same primitives useShotEngine uses (VisionCamera useFrameOutput + a
 * dedicated useResizer + react-native-fast-tflite), but it loads ONLY MoveNet,
 * runs it at a modest rate, and does nothing but stream the ankle/hip y of each
 * frame to the JS thread. No detector, no rim lock, no FSM — a jump test needs
 * none of that. This keeps the flagship engine untouched while still reusing the
 * exact frame → resize → runSync → parse worklet pattern it established.
 *
 * The physics + all analysis are pure (src/core/jumpLab.ts) and unit-tested;
 * this screen is the camera plumbing + presentation only.
 *
 * Honest about limits: needs ≥15 fps pose and your WHOLE body in frame. Below
 * that it refuses rather than guess. The number is a measurement aid, not a
 * lab instrument, and the training programs are general fitness guidance, not
 * medical advice.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { NitroModules } from 'react-native-nitro-modules';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
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

import { Sparkline } from '@/components/charts/Sparkline';
import { CountUp, SuccessBurst, useCardStagger } from '@/components/motion';
import { Card, Chip, PillButton, Row, Screen } from '@/components/ui';
import { color, font, layout, radius, space, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';
import {
  PLYO_PROGRAMS,
  estimateJump,
  jumpHistoryStats,
  metersPerPxFromHeight,
  type JumpEstimate,
  type JumpSample,
  type PlyoProgram,
  type ProgramLevel,
} from '@/core/jumpLab';
import { parseMoveNet } from '@/ml/poseParser';
import { bestJumpCm, insertJump, listJumps, type JumpRow } from '@/data/db';

/* eslint-disable @typescript-eslint/no-var-requires */
const POSE_ASSET = require('@/assets/models/movenet-pose.tflite');
/* eslint-enable @typescript-eslint/no-var-requires */

/** MoveNet input side (square). */
const POSE_INPUT = 192;
/** How long we capture after JUMP! before scoring, ms. A jump + reset fits. */
const CAPTURE_MS = 2600;
/** Assumed athlete height (cm) for the displacement cross-check when no rim is
 *  locked. Only feeds the SECONDARY estimator — the primary hang-time number is
 *  scale-free and never uses this. Kept deliberately generic. */
const ASSUMED_HEIGHT_CM = 175;

type MeasurePhase = 'idle' | 'ready' | 'capturing' | 'scoring' | 'result';

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent (see live.tsx). */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

// ---------------------------------------------------------------------------
// Minimal pose loop — streams ankle/hip y samples to a JS-side ref buffer.
// ---------------------------------------------------------------------------

/**
 * Runs MoveNet on the camera and pushes one {@link JumpSample} per analysed
 * frame into `sink`. Active only while `active` is true (during a capture),
 * so the model isn't burning battery on the idle screen. Returns the camera
 * plumbing to mount, plus liveliness diagnostics.
 */
function useJumpPose(active: boolean, sink: (s: JumpSample) => void) {
  const device = useCameraDevice('back');
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

  // MoveNet wants NHWC uint8 192×192 (interleaved) — same config as the engine's
  // pose resizer.
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

  const onSample = useMemo(
    () => (s: JumpSample) => sink(s),
    [sink],
  );

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
          // De-normalize into the 192-square analysis space (parseMoveNet
          // multiplies the 0..1 keypoints by frameW/H). Absolute px scale is
          // irrelevant to the primary hang-time estimator; the displacement
          // cross-check scales by a height ruler in the same space.
          const pose = parseMoveNet(
            new Float32Array(out[0]!),
            POSE_INPUT,
            POSE_INPUT,
            0,
          );
          // Camera presentation timestamp → seconds (iOS seconds; Android ns).
          const tSec =
            frame.timestamp > 1e6 ? frame.timestamp / 1e9 : frame.timestamp;

          const la = pose.keypoints.left_ankle;
          const ra = pose.keypoints.right_ankle;
          let ankleY: number | null = null;
          let ankleScore = 0;
          if (la && ra) {
            ankleY = (la.y + ra.y) / 2;
            ankleScore = Math.min(la.score, ra.score);
          } else if (la) {
            ankleY = la.y;
            ankleScore = la.score;
          } else if (ra) {
            ankleY = ra.y;
            ankleScore = ra.score;
          }
          const lh = pose.keypoints.left_hip;
          const rh = pose.keypoints.right_hip;
          let hipY: number | null = null;
          if (lh && rh) hipY = (lh.y + rh.y) / 2;
          else if (lh) hipY = lh.y;
          else if (rh) hipY = rh.y;

          framesSv.value += 1;
          scheduleOnRN(onSample, { t: tSec, ankleY, ankleScore, hipY });
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

export default function JumpLabScreen() {
  useKeepAwake();
  const { width } = useWindowDimensions();

  const [phase, setPhase] = useState<MeasurePhase>('idle');
  const [estimate, setEstimate] = useState<JumpEstimate | null>(null);
  const [history, setHistory] = useState<JumpRow[] | null>(null);
  const [pb, setPb] = useState(0);
  const [isNewPb, setIsNewPb] = useState(false);

  // Sample buffer for the current capture (JS thread; the worklet streams here).
  const samplesRef = useRef<JumpSample[]>([]);
  const captureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const capturing = phase === 'capturing';
  const sink = useCallback((s: JumpSample) => {
    if (samplesRef.current.length < 400) samplesRef.current.push(s);
  }, []);
  const pose = useJumpPose(capturing, sink);

  const loadHistory = useCallback(async () => {
    const [rows, best] = await Promise.all([listJumps(), bestJumpCm()]);
    setHistory(rows);
    setPb(best);
  }, []);
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Canonical card stagger (self-gates under reduced motion → undefined).
  const cardEnter = useCardStagger({ stepMs: 70 });

  // ── Capture lifecycle ──────────────────────────────────────────────────
  const startCapture = useCallback(() => {
    samplesRef.current = [];
    setEstimate(null);
    setPhase('capturing');
    haptic.impactMedium();
    captureTimer.current = setTimeout(() => {
      setPhase('scoring');
    }, CAPTURE_MS);
  }, []);

  // When capture ends, score the collected series.
  useEffect(() => {
    if (phase !== 'scoring') return;
    const samples = samplesRef.current;
    // Displacement cross-check scale: a standing body height (baseline ankle →
    // standing head) in px, converted with an assumed real height. The primary
    // hang-time number ignores this entirely.
    const est = estimateJump(samples, { metersPerPx: estimateMppFromPose(samples) });
    setEstimate(est);
    setPhase('result');
    if (est.method !== 'none') {
      haptic.success();
      // Persist + refresh history / PB.
      void (async () => {
        const wasPb = est.heightCm > pb;
        setIsNewPb(wasPb);
        await insertJump({
          ts: Date.now(),
          heightCm: est.heightCm,
          method: est.method,
          confidence: est.confidence,
        });
        await loadHistory();
      })();
    } else {
      setIsNewPb(false);
    }
  }, [phase, pb, loadHistory]);

  useEffect(
    () => () => {
      if (captureTimer.current) clearTimeout(captureTimer.current);
    },
    [],
  );

  const stats = useMemo(
    () =>
      jumpHistoryStats(
        (history ?? []).map((r) => ({
          id: r.id,
          ts: r.ts,
          heightCm: r.heightCm,
          method: r.method,
          confidence: r.confidence,
        })),
      ),
    [history],
  );

  // ── Camera permission gate (only matters once the user starts a measure) ──
  const needsPermission = pose.device != null && !pose.hasPermission;

  // Measuring overlay takes over the whole screen (READY / JUMP! / scoring).
  const measuring = phase === 'ready' || phase === 'capturing' || phase === 'scoring';

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <Row style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={10}
            style={styles.backPill}
          >
            <Ionicons name="chevron-back" size={18} color={color.text} />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </Row>

        <View>
          <Text style={styles.kicker}>VERTICAL</Text>
          <Text style={styles.title} accessibilityRole="header">
            Jump Lab
          </Text>
        </View>

        {/* Hero measure card */}
        <Card entering={cardEnter(0)}>
          <Row gap={6} style={styles.eyebrowRow}>
            <Ionicons name="pulse" size={12} color={color.accent} />
            <Text style={styles.eyebrowText}>MEASURE</Text>
          </Row>
          {estimate == null || estimate.method === 'none' ? (
            <>
              <Text style={styles.measureLead}>
                Measure your vertical from hang time — no tape measure, no wall.
              </Text>
              <Text style={styles.measureBody}>
                Prop the phone so your WHOLE body is in frame, tap Measure, and
                jump straight up with both feet. Needs at least 15 fps pose and
                good light — if the phone can't keep up, it'll say so instead of
                guessing.
              </Text>
              {estimate?.method === 'none' && (
                <View style={styles.refuseBox}>
                  <Ionicons name="alert-circle-outline" size={16} color={color.unsure} />
                  <Text style={styles.refuseText}>{estimate.note}</Text>
                </View>
              )}
            </>
          ) : (
            <JumpResult estimate={estimate} isNewPb={isNewPb} />
          )}
          <PillButton
            label={estimate?.method === 'hang-time' ? 'Measure again' : 'Measure my jump'}
            icon="body-outline"
            onPress={() => setPhase('ready')}
            style={styles.measureCta}
          />
        </Card>

        {/* History + PB */}
        <Card entering={cardEnter(1)}>
          <Row gap={6} style={styles.eyebrowRow}>
            <Ionicons name="trending-up" size={12} color={color.accent} />
            <Text style={styles.eyebrowText}>YOUR NUMBERS</Text>
          </Row>
          {stats.count === 0 ? (
            <Text style={styles.measureBody}>
              No jumps logged yet. Your personal best and trend will show up here
              after your first measurement.
            </Text>
          ) : (
            <>
              <Row gap={space.xl} style={styles.statRow}>
                <View style={styles.statCol}>
                  <Text style={styles.statNum}>{fmtCm(stats.bestCm)}</Text>
                  <Text style={styles.statLabel}>PERSONAL BEST</Text>
                </View>
                <View style={styles.statCol}>
                  <Text style={styles.statNum}>{fmtCm(stats.avgCm)}</Text>
                  <Text style={styles.statLabel}>AVERAGE</Text>
                </View>
                <View style={styles.statCol}>
                  <Text style={styles.statNum}>{stats.count}</Text>
                  <Text style={styles.statLabel}>JUMPS</Text>
                </View>
              </Row>
              {stats.sparkline.length >= 2 && (
                <View style={styles.sparkWrap}>
                  <Sparkline
                    data={normalizeSpark(stats.sparkline)}
                    width={Math.min(width - 76, 520)}
                    height={72}
                    accessibilityLabel={`Your jump height trend over ${stats.sparkline.length} measurements, most recent on the right`}
                  />
                  <Row style={styles.sparkAxis}>
                    <Text style={styles.sparkAxisLabel}>oldest</Text>
                    <Text style={styles.sparkAxisLabel}>latest {fmtCm(stats.latestCm)}</Text>
                  </Row>
                </View>
              )}
            </>
          )}
        </Card>

        {/* Training */}
        <View>
          <Row gap={6} style={styles.eyebrowRow}>
            <Ionicons name="barbell-outline" size={12} color={color.accent} />
            <Text style={styles.eyebrowText}>TRAIN YOUR JUMP</Text>
          </Row>
          <Text style={styles.trainingIntro}>
            Pick the program that matches where you are. Plyometrics are about
            quality and full recovery — a few explosive reps beat many tired
            ones.
          </Text>
        </View>
        {PLYO_PROGRAMS.map((p, i) => (
          <ProgramCard key={p.level} program={p} entering={cardEnter(2 + i)} />
        ))}

        <View style={styles.disclaimer}>
          <Ionicons name="information-circle-outline" size={15} color={color.textFaint} />
          <Text style={styles.disclaimerText}>
            Not medical advice. These are general training guidelines, not a
            personalized program. Warm up first, stop if anything hurts, and
            check with a doctor or a qualified coach before starting a new
            training plan.
          </Text>
        </View>
      </View>

      {/* Full-screen measure overlay (camera + READY/JUMP!/scoring) */}
      {measuring && (
        <MeasureOverlay
          phase={phase}
          pose={pose}
          needsPermission={needsPermission}
          onArmed={startCapture}
          onCancel={() => {
            if (captureTimer.current) clearTimeout(captureTimer.current);
            setPhase('idle');
          }}
        />
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Measure overlay — camera preview with the READY → JUMP! → scoring states.
// ---------------------------------------------------------------------------

function MeasureOverlay({
  phase,
  pose,
  needsPermission,
  onArmed,
  onCancel,
}: {
  phase: MeasurePhase;
  pose: ReturnType<typeof useJumpPose>;
  needsPermission: boolean;
  onArmed: () => void;
  onCancel: () => void;
}) {
  const { canRequestPermission } = useCameraPermission();

  if (needsPermission) {
    return (
      <View style={styles.overlay}>
        <View style={styles.overlayContent}>
          <Text style={styles.overlayTitle}>Camera access needed</Text>
          <Text style={styles.overlaySub}>
            Jump Lab watches your body to time your jump. Everything stays on
            this phone.
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
      <View style={styles.overlayScrim} pointerEvents="box-none">
        <View style={styles.overlayContent} pointerEvents="box-none">
          {phase === 'ready' && (
            <>
              <Text style={styles.overlayTitle}>Get set</Text>
              <Text style={styles.overlaySub}>
                Stand so your whole body — head to feet — is in frame. When you
                tap Jump, you'll have a moment, then jump straight up with both
                feet and land in the same spot.
              </Text>
              {!pose.modelLoaded && (
                <Text style={styles.overlayWarming}>Warming up the pose model…</Text>
              )}
              <PillButton
                label="JUMP!"
                onPress={onArmed}
                disabled={!pose.modelLoaded}
                style={styles.overlayCta}
              />
              <PillButton label="Cancel" variant="ghost" onPress={onCancel} />
            </>
          )}
          {phase === 'capturing' && (
            <Animated.View entering={FadeIn} style={styles.captureBadge}>
              <Text style={styles.captureBig}>JUMP!</Text>
              <Text style={styles.captureSub}>Explode straight up — land in frame</Text>
              <CaptureProgress framesSv={pose.framesSv} />
            </Animated.View>
          )}
          {phase === 'scoring' && (
            <Animated.View entering={FadeIn} style={styles.captureBadge}>
              <Text style={styles.captureBig}>Measuring…</Text>
              <Text style={styles.captureSub}>Reading your hang time</Text>
            </Animated.View>
          )}
        </View>
      </View>
    </View>
  );
}

/** A thin "we're seeing frames" pulse under JUMP!, driven by the frame counter. */
function CaptureProgress({ framesSv }: { framesSv: ReturnType<typeof useSharedValue<number>> }) {
  const [frames, setFrames] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrames(framesSv.value), 120);
    return () => clearInterval(id);
  }, [framesSv]);
  return (
    <Text style={styles.captureFrames} accessibilityLiveRegion="polite">
      {frames > 0 ? `tracking (${frames} frames)` : 'looking for you…'}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Result block (inside the hero card) with count-up.
// ---------------------------------------------------------------------------

function JumpResult({ estimate, isNewPb }: { estimate: JumpEstimate; isNewPb: boolean }) {
  // The number rolls on the UI thread (fx/CountUp) — no per-frame re-render.
  // Re-roll per measurement is guaranteed by mounting: the parent clears
  // `estimate` on every new capture, so this block remounts for each result;
  // `trigger` re-rolls too when consecutive results differ.
  const inches = estimate.heightCm / 2.54;
  const conf = estimate.confidence;
  const confLabel = conf >= 0.75 ? 'High' : conf >= 0.5 ? 'Medium' : 'Low';
  const confTone: React.ComponentProps<typeof Chip>['tone'] =
    conf >= 0.75 ? 'make' : conf >= 0.5 ? 'accent' : 'unsure';

  return (
    <Animated.View entering={FadeIn}>
      {isNewPb && (
        <Row gap={6} style={styles.pbRow}>
          <Ionicons name="trophy" size={14} color={color.accent} />
          <Text style={styles.pbText}>NEW PERSONAL BEST</Text>
        </Row>
      )}
      <Row gap={space.sm} style={styles.resultHeroRow}>
        <CountUp
          to={estimate.heightCm}
          durationMs={900}
          decimals={1}
          trigger={estimate.heightCm}
          style={[styles.resultHero, styles.countUpFix]}
        />
        <Text style={styles.resultUnit}>cm</Text>
        <CountUp
          to={inches}
          durationMs={900}
          decimals={1}
          prefix="("
          suffix={'")'}
          trigger={estimate.heightCm}
          style={[styles.resultInches, styles.countUpFix]}
        />
      </Row>
      <Row gap={space.sm} style={styles.resultChips}>
        <Chip label={confLabel + ' confidence'} tone={confTone} />
        <Chip label="Hang time" />
        {estimate.flightSec != null && (
          <Chip label={`${(estimate.flightSec * 1000).toFixed(0)} ms aloft`} />
        )}
      </Row>
      <View style={styles.methodGrid}>
        <View style={styles.methodCol}>
          <Text style={styles.methodLabel}>HANG TIME</Text>
          <Text style={styles.methodVal}>
            {estimate.hangTimeCm != null ? fmtCm(estimate.hangTimeCm) : '—'}
          </Text>
          <Text style={styles.methodHint}>primary · scale-free</Text>
        </View>
        <View style={styles.methodCol}>
          <Text style={styles.methodLabel}>DISPLACEMENT</Text>
          <Text style={styles.methodVal}>
            {estimate.displacementCm != null ? fmtCm(estimate.displacementCm) : '—'}
          </Text>
          <Text style={styles.methodHint}>cross-check</Text>
        </View>
        <View style={styles.methodCol}>
          <Text style={styles.methodLabel}>POSE FPS</Text>
          <Text style={styles.methodVal}>{estimate.fps.toFixed(0)}</Text>
          <Text style={styles.methodHint}>this measure</Text>
        </View>
      </View>
      {estimate.note.length > 0 && <Text style={styles.resultNote}>{estimate.note}</Text>}
      {isNewPb && (
        // One-shot PB celebration over the result block only (inside the hero
        // card — NEVER the camera overlay). Renders null under reduced motion;
        // the NEW PERSONAL BEST row above is the static carrier of the meaning.
        <SuccessBurst trigger={estimate.heightCm} pieces={16} />
      )}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Program card.
// ---------------------------------------------------------------------------

function ProgramCard({
  program,
  entering,
}: {
  program: PlyoProgram;
  entering?: React.ComponentProps<typeof Card>['entering'];
}) {
  const [open, setOpen] = useState(false);
  const tone = LEVEL_TONE[program.level];
  return (
    <Card entering={entering}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button">
        <Row style={styles.programHead}>
          <View style={{ flex: 1 }}>
            <Row gap={space.sm} style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Text style={styles.programTitle}>{program.title}</Text>
              <Chip label={program.level} tone={tone} />
            </Row>
            <Text style={styles.programWho}>{program.who}</Text>
          </View>
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={20}
            color={color.textFaint}
          />
        </Row>
      </Pressable>

      <Row gap={space.md} style={styles.programMeta}>
        <MetaPill icon="calendar-outline" text={program.schedule} />
        <MetaPill icon="repeat-outline" text={`${program.daysPerWeek}×/week`} />
        <MetaPill icon="hourglass-outline" text={`${program.weeks} weeks`} />
      </Row>

      {open && (
        <Animated.View entering={FadeIn}>
          <View style={styles.exerciseList}>
            {program.exercises.map((e, i) => (
              <Row key={e.name} style={[styles.exerciseRow, i > 0 && styles.exerciseDivider]}>
                <Text style={[styles.exerciseName, { flex: 1 }]}>{e.name}</Text>
                <Text style={styles.exerciseSpec}>
                  {e.sets} × {e.reps}
                  {e.unit === 'sec' ? 's' : ''}
                </Text>
                <Text style={styles.exerciseRest}>{e.restSec}s rest</Text>
              </Row>
            ))}
          </View>
          <View style={styles.principleBox}>
            <Ionicons name="bulb-outline" size={15} color={color.accent} />
            <Text style={styles.principleText}>{program.principle}</Text>
          </View>
        </Animated.View>
      )}
    </Card>
  );
}

function MetaPill({
  icon,
  text,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  text: string;
}) {
  return (
    <Row gap={4}>
      <Ionicons name={icon} size={13} color={color.textFaint} />
      <Text style={styles.metaText}>{text}</Text>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const LEVEL_TONE: Record<ProgramLevel, React.ComponentProps<typeof Chip>['tone']> = {
  beginner: 'make',
  intermediate: 'accent',
  advanced: 'miss',
};

function fmtCm(cm: number): string {
  return `${cm.toFixed(cm >= 100 ? 0 : 1)} cm`;
}

/** Map a cm series to 0..1 for the Sparkline, padding the range so a flat-ish
 *  history still shows shape (min maps a little above 0, max near the top). */
function normalizeSpark(cm: readonly number[]): number[] {
  if (cm.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of cm) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (span < 1) return cm.map(() => 0.5);
  return cm.map((v) => 0.1 + 0.85 * ((v - lo) / span));
}

/**
 * Rough metres-per-pixel for the displacement cross-check, from the standing
 * body: the vertical span from the ankle baseline to the standing head/eye,
 * scaled by an assumed real height. This only ever feeds the SECONDARY
 * estimator; a bad guess never affects the scale-free hang-time number.
 * Returns undefined when the standing pose was too incomplete to measure.
 */
function estimateMppFromPose(samples: readonly JumpSample[]): number | undefined {
  // Standing frames = ankle near its resting (largest y). Take the median head
  // (nose is unavailable here since we only stream ankle/hip) — approximate the
  // body span with ankle→hip and gross it up: hip is ~0.53 of standing height.
  const standing: { ankleY: number; hipY: number }[] = [];
  for (const s of samples) {
    if (s.ankleY != null && s.hipY != null && s.ankleScore >= 0.3) {
      standing.push({ ankleY: s.ankleY, hipY: s.hipY });
    }
  }
  if (standing.length < 5) return undefined;
  // Use the largest ankle-y quartile as "on the ground".
  standing.sort((a, b) => b.ankleY - a.ankleY);
  const grounded = standing.slice(0, Math.max(3, Math.floor(standing.length / 4)));
  let ankleSum = 0;
  let hipSum = 0;
  for (const g of grounded) {
    ankleSum += g.ankleY;
    hipSum += g.hipY;
  }
  const ankleBase = ankleSum / grounded.length;
  const hipBase = hipSum / grounded.length;
  const ankleToHipPx = ankleBase - hipBase; // +y down: hip above ankle
  if (!(ankleToHipPx > 4)) return undefined;
  // Hip height ≈ 0.53 × standing height → full standing span in px ≈ ankleToHip / 0.53.
  const standingSpanPx = ankleToHipPx / 0.53;
  const mpp = metersPerPxFromHeight(ASSUMED_HEIGHT_CM, standingSpanPx);
  return mpp ?? undefined;
}

// ---------------------------------------------------------------------------
// Styles.
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  stack: {
    // Common rhythm — see `layout` in constants/tokens.ts. No paddingBottom:
    // Screen already tails the scroll with insets.bottom + space.xxl.
    gap: layout.sectionGap,
    paddingTop: space.md,
  },
  header: {
    marginBottom: space.sm,
  },
  backPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: space.xs,
    paddingRight: space.sm,
  },
  backText: {
    ...type.bodyMedium,
    color: color.text,
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
  eyebrowRow: {
    marginBottom: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
  },
  measureLead: {
    ...type.headingLarge,
    color: color.text,
  },
  measureBody: {
    ...type.body,
    color: color.textDim,
    marginTop: space.sm,
  },
  measureCta: {
    marginTop: space.lg,
    alignSelf: 'stretch',
  },
  refuseBox: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    backgroundColor: color.unsureTint,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.md,
  },
  refuseText: {
    ...type.body,
    color: color.unsure,
    flex: 1,
  },
  // result
  pbRow: {
    marginBottom: space.xs,
  },
  pbText: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.2,
  },
  resultHeroRow: {
    alignItems: 'baseline',
  },
  resultHero: {
    fontFamily: font.display,
    fontSize: 64,
    lineHeight: 64,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  resultUnit: {
    ...type.statMedium,
    color: color.textDim,
  },
  resultInches: {
    ...type.body,
    color: color.textFaint,
  },
  // CountUp renders through a TextInput; strip Android's extra font padding so
  // its baseline matches the sibling Texts in the baseline-aligned row.
  countUpFix: {
    includeFontPadding: false,
  },
  resultChips: {
    marginTop: space.md,
    flexWrap: 'wrap',
  },
  methodGrid: {
    flexDirection: 'row',
    marginTop: space.lg,
    gap: space.md,
  },
  methodCol: {
    flex: 1,
  },
  methodLabel: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 0.8,
  },
  methodVal: {
    ...type.statSmall,
    color: color.text,
    marginTop: 2,
  },
  methodHint: {
    ...type.micro,
    color: color.textFaint,
  },
  resultNote: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.md,
  },
  // stats
  statRow: {
    marginTop: space.xs,
  },
  statCol: {
    alignItems: 'flex-start',
  },
  statNum: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 0.8,
    marginTop: 2,
  },
  sparkWrap: {
    marginTop: space.lg,
  },
  sparkAxis: {
    justifyContent: 'space-between',
    marginTop: space.xs,
  },
  sparkAxisLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  // training
  trainingIntro: {
    ...type.body,
    color: color.textDim,
  },
  programHead: {
    alignItems: 'flex-start',
  },
  programTitle: {
    ...type.headingLarge,
    color: color.text,
  },
  programWho: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  programMeta: {
    marginTop: space.md,
    flexWrap: 'wrap',
  },
  metaText: {
    ...type.caption,
    color: color.textDim,
  },
  exerciseList: {
    marginTop: space.lg,
  },
  exerciseRow: {
    paddingVertical: space.sm,
    alignItems: 'center',
  },
  exerciseDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  exerciseName: {
    ...type.body,
    color: color.text,
  },
  exerciseSpec: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
    minWidth: 56,
    textAlign: 'right',
  },
  exerciseRest: {
    ...type.caption,
    color: color.textFaint,
    minWidth: 68,
    textAlign: 'right',
  },
  principleBox: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    backgroundColor: color.accentTint,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.md,
  },
  principleText: {
    ...type.body,
    color: color.text,
    flex: 1,
  },
  disclaimer: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
    marginTop: space.xs,
  },
  disclaimerText: {
    ...type.caption,
    color: color.textFaint,
    flex: 1,
    lineHeight: 17,
  },
  // overlay
  overlay: {
    ...absoluteFill,
    backgroundColor: color.bg,
    zIndex: 10,
  },
  overlayScrim: {
    ...absoluteFill,
    backgroundColor: color.hudGlass,
    justifyContent: 'flex-end',
  },
  overlayContent: {
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
  overlayWarming: {
    ...type.caption,
    color: color.unsure,
  },
  overlayCta: {
    alignSelf: 'stretch',
  },
  captureBadge: {
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: space.hero,
  },
  captureBig: {
    fontFamily: font.display,
    fontSize: 72,
    lineHeight: 74,
    color: color.make,
    letterSpacing: 1,
  },
  captureSub: {
    ...type.body,
    color: color.text,
    marginTop: space.sm,
  },
  captureFrames: {
    ...type.caption,
    color: color.textDim,
    marginTop: space.md,
  },
});
