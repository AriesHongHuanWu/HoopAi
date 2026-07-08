/**
 * useShotEngine — the heart of the live session.
 *
 * camera mode: VisionCamera V5 frame output → GPU resize → TFLite runSync →
 *   parse (all inside the worklet) → scheduleOnRN → ShotPipeline (JS thread).
 * demo mode: scripted mock detector drives the same pipeline at 30fps with no
 *   camera/model (simulators, UI work, missing model file).
 *
 * The engine automatically falls back to demo mode when the TFLite model
 * fails to load (e.g. the placeholder asset hasn't been replaced by a trained
 * model yet — see docs/MODELS.md).
 */
import { DeviceMotion } from 'expo-sensors';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import {
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  useVideoOutput,
  type CameraOutput,
} from 'react-native-vision-camera';
import { useResizer } from 'react-native-vision-camera-resizer';
import {
  loadTensorflowModel,
  type TensorflowModel,
  type TensorflowModelDelegate,
} from 'react-native-fast-tflite';
import { NitroModules } from 'react-native-nitro-modules';

import { DETECTION } from '../core/config';
import type { Box, ResolvedShot, RimGeometry } from '../core/types';
import { createMockDetector } from '../ml/mockDetector';
import { parseYoloOutput, nmsPerClass } from '../ml/yoloParser';
import { parseMoveNet } from '../ml/poseParser';
import { findMotionCandidate } from '../ml/motionCandidate';
import { cullLetterboxDetections } from '../ml/letterboxCull';
import { squareCropRect, remapRoiBox } from '../ml/roiTransform';
import {
  ShotPipeline,
  type FramePayload,
  type FtCaptureOutcome,
} from '../pipeline/shotPipeline';
import { useSettings } from '../state/settingsStore';
import { resolvedTuning } from './deviceTuning';

// Bundled detectors (user-selectable in Settings). 'standard' = YOLO11n
// (fast); 'precise' = YOLO11s trained on more scenes (accurate, slower).
/* eslint-disable @typescript-eslint/no-var-requires */
const MODEL_ASSETS = {
  standard: require('../../assets/models/hoopai-det.tflite'),
  precise: require('../../assets/models/hoopai-det-precise.tflite'),
  // 320-input nano for 'speed' perf mode (~4× faster on older phones).
  fast: require('../../assets/models/hoopai-det-fast.tflite'),
  // Apache-2.0 YOLOX-Nano (obj-aware, NHWC 0..1 input, decode folded). Two input
  // sizes from the SAME weights: 416 (fast) and 640 (Quality — the ball is ~2.3x
  // bigger in pixels, so it's detected in ~2x more frames + higher confidence,
  // at ~1.8x the inference cost). Selected by Settings > Performance.
  yolox: require('../../assets/models/hoopai-yolox.tflite'),
  yolox640: require('../../assets/models/hoopai-yolox-640.tflite'),
  // Nano fallbacks (same IO contract, ~5x lighter). The primary yolox assets
  // are the small-ball TINY finetune — far better recall, but ~5x the compute:
  // an iPhone XR-class CPU runs Tiny@640 at ~2fps, which STARVES the tracker
  // (3-4 samples per arc → no fit, no arm) and makes detection WORSE overall.
  // The loader speed-budgets the Tiny rungs and steps down to Nano on slow
  // devices: fast phones get Tiny's recall, old phones keep a usable fps.
  yoloxNano: require('../../assets/models/hoopai-yolox-nano.tflite'),
  yoloxNano640: require('../../assets/models/hoopai-yolox-nano-640.tflite'),
} as const;
// MoveNet SinglePose Lightning (Apache-2.0) for opt-in form analysis.
const POSE_ASSET = require('../../assets/models/movenet-pose.tflite');
/* eslint-enable @typescript-eslint/no-var-requires */

/** MoveNet input side (square). Separate from the detector's 640. */
const POSE_INPUT = 192;
/** Detector input side for the 'speed' perf mode (matches the fast model export). */
const SPEED_INPUT = 320;
/** YOLOX-Nano input side (matches the hoopai-yolox export; fixed, not perf-scaled). */
const YOLOX_INPUT = 416; // Speed
const YOLOX_INPUT_HQ = 640; // Quality — bigger ball, better detection, slower

/**
 * 'auto' detector budget: keep the precise model only when a smoke-test
 * inference beats this. ~55ms ≈ 18fps detection — the Kalman tracker
 * interpolates that to a smooth 30fps overlay; anything slower steps down to
 * the standard model (iPhone XR/11-class or delegates that fell back to CPU).
 */
const AUTO_PRECISE_MAX_MS = 55;

/**
 * YOLOX-Tiny speed budget: keep the small-ball Tiny model only when a smoke
 * inference beats this, else step down to Nano. 120ms ≈ 8fps detection — the
 * floor where the Kalman tracker + FSM still get enough arc samples to fit
 * and arm reliably. Below that (XR-class CPUs run Tiny@640 at ~500ms) the
 * per-frame recall win is erased by trajectory starvation.
 */
const YOLOX_TINY_MAX_MS = 120;

export type EngineMode = 'auto' | 'demo' | 'camera';

/** Overlay state published every analysed frame; consumed by the Skia HUD. */
/** One raw model detection for the debug box overlay (analysis px). */
export interface OverlayDet {
  cls: string;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface OverlayState {
  /**
   * Latest tracked ball. x,y,r are analysis-frame px. vx,vy are the Kalman
   * velocity in analysis-frame px/SECOND and t is the camera-clock sample time
   * (seconds). The overlay carries velocity + t so it can GLIDE the drawn ball
   * between processed frames (which arrive at only ~15-30fps) — the HUD
   * extrapolates x+vx*dt each display frame. t is used only as a change key to
   * detect a new sample, never subtracted from the UI display clock.
   */
  ball: { x: number; y: number; r: number; vx: number; vy: number; t: number } | null;
  rim: Box | null;
  /** Flattened x,y pairs of the live shot trajectory (analysis px). */
  traj: number[];
  phase: 'IDLE' | 'SHOT_LIVE' | 'COOLDOWN';
  frameW: number;
  frameH: number;
  /**
   * Camera-frame dimensions in px, from the physically-rotated buffer
   * (enablePhysicalBufferRotation + orientationSource "interface"), so they are
   * DISPLAY-oriented and match the preview. The detector input and the <Camera>
   * preview both use scaleMode 'contain', letterboxing this frame into the
   * analysis square and the view respectively; the overlay inverts the analysis
   * letterbox and applies the preview one, so it needs the real source aspect
   * (not a hardcoded 9:16 guess that broke landscape). 0 until the first frame.
   */
  srcW: number;
  srcH: number;
  /** Every raw detection this frame (for the debug box overlay). */
  dets: OverlayDet[];
  /** Predicted landing point of the live shot (analysis px) + on-target flag.
   *  Null outside SHOT_LIVE / before the arc fit is trustworthy. */
  pred: { x: number; y: number; inSpan: boolean } | null;
  /** Flattened x,y pairs of the FUTURE arc (ball → predicted landing) — the
   *  dashed "where it's going" path drawn while the ball may be undetected. */
  predTraj: number[];
  /** Flattened x,y pairs of the OBSERVED full-flight arc (analysis px), drawn
   *  regardless of phase so the line traces the whole flight (3-pointers / high
   *  arcs), not only near the rim. Strictly visual; empty unless the global arc
   *  is confident. */
  fullArc: number[];
  /** Seconds left on the pre-lock "hold steady" countdown (HUD shows ceil() as a
   *  3-2-1 reticle), or null when not counting / already locked. */
  rimCountdown: number | null;
  /**
   * EMA'd mean scene luminance 0..1 from the frame worklet (green-channel
   * proxy over the detector input, letterbox bars compensated out). 0 until
   * measured (demo mode / model warm-up). Classified via
   * src/core/lightProfile.ts by consumers (placement grade's low-light hint).
   */
  light: number;
}

export const EMPTY_OVERLAY: OverlayState = {
  ball: null,
  rim: null,
  traj: [],
  phase: 'IDLE',
  frameW: 640,
  frameH: 640,
  srcW: 0,
  srcH: 0,
  dets: [],
  rimCountdown: null,
  pred: null,
  predTraj: [],
  fullArc: [],
  light: 0,
};

/** Live diagnostics for the on-screen debug panel (helps fix on-device ML). */
export interface EngineDebug {
  mode: 'demo' | 'camera';
  modelLoaded: boolean;
  /** Frames the worklet has processed (proves the camera pipeline runs). */
  frames: number;
  /** Raw output tensor length + inferred layout/anchors from the parser. */
  outputLen: number;
  layout: string;
  /** Max class score this frame (0 across all frames = bad input/model). */
  maxScore: number;
  /** Detections after NMS this frame. */
  detCount: number;
  /** Model input value range (should be ~0..1). */
  inputMin: number;
  inputMax: number;
  /** Resizer output buffer size in bytes (640*640*3*4 = 4915200 for float32). */
  bufBytes: number;
  /** % of sampled input pixels that are non-zero (0 = black/empty input). */
  nonZeroPct: number;
  /**
   * EMA'd mean scene luminance 0..1 (green-channel proxy, letterbox bars
   * compensated). 0 until measured. The debug panel renders it alongside its
   * classified profile (bright/dim/dark — src/core/lightProfile.ts).
   */
  light: number;
  /** Which delegate the model loaded with ('core-ml' | 'android-gpu' | 'cpu' | 'loading'). */
  delegate: string;
  /** Load failure reason OR per-frame detect-path error, empty when fine. */
  modelError: string;
  /** Live EMA of inference time (ms) — rises as the chip thermally throttles. */
  avgMs: number;
  /** Effective detection fps after the adaptive thermal gate. */
  fps: number;
  /**
   * Frames the camera delivered but DROPPED before onFrame ran (VisionCamera
   * backpressure). Diagnostic: frames=0 AND dropped=0 ⇒ the camera output never
   * streamed; dropped climbing ⇒ frames arrive but every one is dropped
   * (processing too slow / worklet failing); frames climbing ⇒ we're live.
   */
  dropped: number;
  /** ROI ("digital zoom") second passes actually run this session. 0 = the
   *  feature never fired (off, phone too slow via the thermal gate, or no
   *  qualifying live-shot miss). */
  roiFrames: number;
  /** ROI passes that recovered a ball the full frame missed (the payoff). */
  roiHits: number;
  /** Live EMA of the ROI pass's own inference time (ms), separate from avgMs. */
  roiAvgMs: number;
}

export const EMPTY_DEBUG: EngineDebug = {
  mode: 'demo',
  modelLoaded: false,
  frames: 0,
  outputLen: 0,
  layout: '-',
  maxScore: 0,
  detCount: 0,
  inputMin: 0,
  inputMax: 0,
  bufBytes: 0,
  nonZeroPct: 0,
  light: 0,
  delegate: 'loading',
  modelError: '',
  avgMs: 0,
  fps: 0,
  dropped: 0,
  roiFrames: 0,
  roiHits: 0,
  roiAvgMs: 0,
};

export interface ShotEngineEvents {
  onShot?: (shot: ResolvedShot) => void;
  onRimLocked?: (rim: RimGeometry) => void;
  onRimDrift?: () => void;
}

export interface ShotEngine {
  /** 'demo' when running scripted, 'camera' when live. */
  activeMode: 'demo' | 'camera';
  /** Overlay SharedValue for the Skia canvas. */
  overlay: SharedValue<OverlayState>;
  /** Live diagnostics for the debug panel. */
  debug: SharedValue<EngineDebug>;
  /** Camera plumbing (null in demo mode). */
  camera: {
    device: ReturnType<typeof useCameraDevice>;
    outputs: CameraOutput[];
    hasPermission: boolean;
    requestPermission: () => Promise<boolean>;
  } | null;
  /** Session-relative seconds on the JS clock (fallback only). */
  nowSec: () => number;
  /**
   * Latest camera presentation-timestamp second — the SAME media clock the
   * recorded MP4 uses and that shot.tResolved is now stamped with. Sample this
   * (not nowSec) for recordingStartSec so videoTime = tResolved − recordingStart
   * is true seconds into the video. Returns nowSec() until the first frame.
   */
  nowCameraSec: () => number;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  isModelLoaded: boolean;
  /**
   * Smoke-test inference latency in milliseconds — a simple device-tier hint
   * (lower = faster phone). 0 until the model finishes loading (or when it
   * never loads, e.g. demo mode). Also surfaced in the debug SharedValue's
   * `delegate` label as "<delegate> · <ms>ms".
   */
  inferenceMs: number;
  setManualRim: (box: Box) => void;
  /** Drop the rim lock and return to acquiring (the "Re-aim" control). */
  reAim: () => void;
  /**
   * OPTIONAL FT-line calibration capture: medians the shooter's foot over the
   * next few confident frames and derives a per-session 2/3 distance
   * refinement. Resolves with success or a quiet reject reason; never throws
   * and never affects shot detection either way.
   */
  captureFtAnchor: () => Promise<FtCaptureOutcome>;
}

export function useShotEngine(mode: EngineMode, events: ShotEngineEvents): ShotEngine {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  // Manual model loading with a delegate fallback chain: the accelerator
  // delegates (CoreML on iOS / GPU on Android) reject some models outright,
  // and the useTensorflowModel hook just parks in 'error' silently. Try the
  // fast delegate first, fall back to plain CPU (always compatible), and
  // surface the failure reason to the debug panel.
  const [modelState, setModelState] = useState<{
    model: TensorflowModel | null;
    delegate: string;
    error: string;
    /** Smoke-test latency (ms) of the winning delegate; 0 until measured. */
    inferenceMs: number;
  }>({ model: null, delegate: 'loading', error: '', inferenceMs: 0 });

  // Self-healing delegate. The detector starts on the fast accelerator (Metal
  // GPU on iOS). If its output comes back CORRUPT — both tensor layouts read as
  // garbage, the iOS CoreML/Metal-on-YOLO failure mode — `forceCpu` flips and
  // the model reloads on the plain CPU delegate (always numerically correct)
  // with the lighter 320px model, so it stays real-time. Set once per session.
  const [forceCpu, setForceCpu] = useState(false);
  const forceCpuRef = useRef(false);
  const corruptStreak = useRef(0);

  const detectorModel = useSettings((s) => s.detectorModel);
  const perfMode = useSettings((s) => s.perfMode);
  // Device tier → which model rung to LOAD FIRST. An 'entry' phone (iPhone XR
  // class) is KNOWN to run Tiny too slowly, so we load Nano straight away
  // instead of wasting ~1s loading Tiny only for the speed budget to step it
  // back down. 'high' starts on Tiny; 'auto'/mid let the runtime budget
  // decide. Refined live by the last measured benchmark (resolveTier).
  const deviceTierOverride = useSettings((s) => s.deviceTierOverride);
  const lastBenchmark = useSettings((s) => s.lastBenchmark);
  const startRung = resolvedTuning(deviceTierOverride, lastBenchmark?.ms ?? null).tuning.startRung;
  // Opt-in Apache-2.0 YOLOX detector (beta). When on, it overrides model + input
  // size + pixel layout; when off (default) every path is byte-identical to the
  // shipping YOLO11 pipeline, so there is zero regression risk.
  const detectorEngine = useSettings((s) => s.detectorEngine);
  const useYolox = detectorEngine === 'yolox';
  // YOLOX delegate choice — CPU (accurate, default) vs GPU (faster, may degrade).
  // The user picks in Settings since only their device shows the real fps.
  const detectorAccel = useSettings((s) => s.detectorAccel);
  // Detector input side. For YOLOX, Performance = Quality uses 640 (bigger ball,
  // better detection) and Speed uses 416. For YOLO11, 'speed' uses a 320 nano.
  // Every consumer (resizer, parser, net-motion, pose) reads this single value.
  const detInputSize = useYolox
    ? perfMode === 'speed'
      ? YOLOX_INPUT
      : YOLOX_INPUT_HQ
    : perfMode === 'speed' || forceCpu
      ? SPEED_INPUT
      : DETECTION.inputSize;

  useEffect(() => {
    let alive = true;
    setModelState({ model: null, delegate: 'loading', error: '', inferenceMs: 0 });
    void (async () => {
      // Self-healing delegate. Start on the FAST accelerator (Metal GPU on iOS /
      // GPU on Android) for real-time speed. Both iOS accelerators can mis-run
      // this YOLO model — CoreML (ANE), and on some devices Metal, partition the
      // graph and return a CORRUPT output tensor (jumping / phantom boxes). The
      // smoke test below rejects a delegate whose output reads as corrupt, and at
      // runtime a sustained corrupt streak flips `forceCpu`, reloading on the
      // plain CPU (XNNPACK) delegate — always numerically correct — with the
      // lighter 320px model so it stays usable. (A standard-conv model like YOLOX
      // should run correctly on Metal; this one may not.)
      const fast: { label: string; delegates: TensorflowModelDelegate[] } =
        forceCpu
          ? { label: 'cpu', delegates: [] }
          : Platform.OS === 'ios'
            ? { label: 'metal', delegates: ['metal'] }
            : { label: 'android-gpu', delegates: ['android-gpu'] };
      type Delegates = TensorflowModelDelegate[];
      interface Attempt {
        asset: number;
        label: string;
        delegates: Delegates;
        /** Reject when the measured inference exceeds this (auto stepdown). */
        maxMs?: number;
      }
      // 'auto' (default): try PRECISE on the fast delegate but keep it only
      // when this device actually runs it fast enough (older phones like the
      // iPhone XR/11 step down to STANDARD automatically). Manual picks keep
      // the selected model with delegate→CPU fallback; the last rung is
      // always "the other model on CPU" so the user is never stranded in demo.
      const none: Delegates = [];
      // YOLOX: order the delegates by the user's Settings choice. CPU (XNNPACK)
      // is always numerically correct — the Test AI verify screen runs YOLOX on
      // CPU and gets accurate, stable boxes on the exact same model. On device the
      // Metal GPU delegate DEGRADED YOLOX output (imprecise / missed boxes) without
      // producing the fully-garbage tensor the self-heal corrupt-check catches, so
      // 'cpu' is the accurate default. 'gpu' is offered for speed on phones where
      // CPU can't keep up; the other delegate is always the fallback rung.
      // Quality = 640 model (bigger ball), Speed = 416. Must match detInputSize.
      // Two capability tiers per size: TINY (small-ball finetune, ~5x compute,
      // speed-budgeted) with NANO as the always-fast fallback — see the
      // MODEL_ASSETS comment. The nano rung has no budget: it is the floor.
      const speed416 = perfMode === 'speed';
      const tinyAsset = speed416 ? MODEL_ASSETS.yolox : MODEL_ASSETS.yolox640;
      const nanoAsset = speed416 ? MODEL_ASSETS.yoloxNano : MODEL_ASSETS.yoloxNano640;
      const sizeTag = speed416 ? '416' : '640';
      const tinyGpu = {
        asset: tinyAsset,
        label: `tiny${sizeTag}/${fast.label}`,
        delegates: fast.delegates,
        maxMs: YOLOX_TINY_MAX_MS,
      };
      const tinyCpu = {
        asset: tinyAsset,
        label: `tiny${sizeTag}/cpu`,
        delegates: none,
        maxMs: YOLOX_TINY_MAX_MS,
      };
      const nanoCpu = { asset: nanoAsset, label: `nano${sizeTag}/cpu`, delegates: none };
      const nanoGpu = {
        asset: nanoAsset,
        label: `nano${sizeTag}/${fast.label}`,
        delegates: fast.delegates,
      };
      // Entry-tier phones load Nano first (Tiny is known-too-slow here); every
      // other tier tries Tiny first and lets the speed budget step down.
      const gpuFirst = detectorAccel === 'gpu';
      const tinyFirst: Attempt[] = gpuFirst
        ? [tinyGpu, tinyCpu, nanoGpu, nanoCpu]
        : [tinyCpu, nanoCpu];
      const nanoFirst: Attempt[] = gpuFirst
        ? [nanoGpu, nanoCpu, tinyGpu, tinyCpu]
        : [nanoCpu, tinyCpu];
      const attempts: Attempt[] = useYolox
        ? startRung === 'nano'
          ? nanoFirst
          : tinyFirst
        : perfMode === 'speed' || forceCpu
          ? [
              { asset: MODEL_ASSETS.fast, label: `fast/${fast.label}`, delegates: fast.delegates },
              { asset: MODEL_ASSETS.fast, label: 'fast/cpu', delegates: none },
            ]
          : detectorModel === 'auto'
          ? [
              { asset: MODEL_ASSETS.precise, label: `precise/${fast.label}`, delegates: fast.delegates, maxMs: AUTO_PRECISE_MAX_MS },
              { asset: MODEL_ASSETS.standard, label: `standard/${fast.label}`, delegates: fast.delegates },
              { asset: MODEL_ASSETS.standard, label: 'standard/cpu', delegates: none },
              { asset: MODEL_ASSETS.precise, label: 'precise/cpu', delegates: none },
            ]
          : [
              { asset: MODEL_ASSETS[detectorModel], label: `${detectorModel}/${fast.label}`, delegates: fast.delegates },
              { asset: MODEL_ASSETS[detectorModel], label: `${detectorModel}/cpu`, delegates: none },
              {
                asset: MODEL_ASSETS[detectorModel === 'standard' ? 'precise' : 'standard'],
                label: `${detectorModel === 'standard' ? 'precise' : 'standard'}/cpu`,
                delegates: none,
              },
            ];
      let lastError = '';
      for (const a of attempts) {
        try {
          const m = await loadTensorflowModel(a.asset, a.delegates);
          // Runtime smoke test — a delegate can load fine yet still fail (or
          // crawl) at inference. First run warms the delegate up (CoreML
          // compiles here), the second one is timed for the debug panel. Any
          // throw or empty output drops us to the next fallback level.
          const dummy = new Float32Array(detInputSize * detInputSize * 3);
          await m.run([dummy.buffer]);
          const t1 = performance.now();
          const out = await m.run([dummy.buffer]);
          const ms = Math.round(performance.now() - t1);
          const o0 = out?.[0];
          if (o0 == null || new Float32Array(o0 as ArrayBuffer).length < 8) {
            throw new Error('smoke test: empty output tensor');
          }
          if (a.maxMs !== undefined && ms > a.maxMs) {
            throw new Error(`auto: ${ms}ms > ${a.maxMs}ms budget — stepping down`);
          }
          // Correctness self-test: an accelerator that mis-compiled the graph
          // returns a tensor that reads as garbage in BOTH layouts. Reject that
          // delegate and fall to the next (CPU) rung — never ship a corrupt
          // detector. Only gate the accelerator rungs (delegates.length > 0); the
          // plain-CPU rung is the trusted fallback and is never corrupt-rejected.
          if (
            a.delegates.length > 0 &&
            parseYoloOutput(new Float32Array(o0 as ArrayBuffer), 0, {
              inputSize: detInputSize,
              hasObjectness: useYolox,
            }).debug?.corrupt
          ) {
            throw new Error(`smoke test: ${a.label} corrupt output — stepping down`);
          }
          if (!alive) return;
          // Persist the measured tier so Settings can show real device
          // numbers ("precise/core-ml · 42ms") without running the camera.
          useSettings.getState().set('lastBenchmark', { delegate: a.label, ms });
          setModelState({
            model: m,
            delegate: `${a.label} · ${ms}ms`,
            error: lastError,
            inferenceMs: ms,
          });
          return;
        } catch (e) {
          lastError = `${a.label}: ${String(e).slice(0, 160)}`;
          if (!alive) return;
          setModelState({ model: null, delegate: a.label, error: lastError, inferenceMs: 0 });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [detectorModel, perfMode, detInputSize, forceCpu, useYolox, detectorAccel]);

  const isModelLoaded = modelState.model != null;
  // 'camera' as soon as a real device exists and we're not in EXPLICIT demo
  // mode — independent of model load. The preview + frame processor mount
  // immediately; detection just stays pending until the model finishes loading
  // (the worklet's boxed==null heartbeat branch safely no-ops — it does NOT run
  // the scripted mock). Scripted demo / DemoCourt only for a true demo:
  // mode==='demo', or genuinely no camera device (simulator).
  const activeMode: 'demo' | 'camera' =
    mode === 'demo' || device == null ? 'demo' : 'camera';


  const overlay = useSharedValue<OverlayState>(EMPTY_OVERLAY);
  const debug = useSharedValue<EngineDebug>({ ...EMPTY_DEBUG });
  // Source camera-frame dims, written by the frame worklet (frame.width/height)
  // and read on the JS thread when building the overlay. Constant within a
  // session (orientation is locked), so a 1-frame lag is irrelevant. Feeds the
  // orientation-correct 'contain' letterbox mapping in the HUD overlays.
  const srcDimsSv = useSharedValue({ w: 0, h: 0 });
  // EMA'd mean scene luminance 0..1 (green-channel proxy over the detector
  // input, letterbox bars compensated out). 0 = not measured yet — the
  // sentinel consumers key off, so a real measurement is floored just above 0.
  // Written by the frame worklet; read on the JS thread for the overlay/debug
  // publish and the FramePayload's light field (light-aware detection profile).
  const lightSv = useSharedValue(0);

  // Mirror the load state into the debug panel as soon as it changes.
  useEffect(() => {
    debug.value = {
      ...debug.value,
      modelLoaded: isModelLoaded,
      delegate: modelState.delegate,
      modelError: modelState.error,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelState, isModelLoaded]);

  // Session clock: monotonic seconds since engine mount. Fallback only (used
  // when a frame carries no valid presentation timestamp).
  const t0 = useRef<number>(performance.now());
  const nowSec = useMemo(() => () => (performance.now() - t0.current) / 1000, []);

  // CAMERA MEDIA CLOCK — the presentation timestamp of the most recent frame,
  // in the SAME timebase the recorded MP4 is authored on. Shot times AND the
  // recording start must both be sampled from THIS clock so that
  //   videoTime = shot.tResolved − recordingStartSec
  // is true seconds into the video file (not the JS performance.now() clock,
  // whose offset from the media clock is unbounded → every replay marker was
  // clamped to the END of the video).
  const lastFrameSec = useRef<number>(0);
  const nowCameraSec = useMemo(
    () => () => (lastFrameSec.current > 0 ? lastFrameSec.current : nowSec()),
    [nowSec],
  );

  // Keep latest events in a ref so the pipeline never holds stale closures.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Net ROI (analysis-frame px) published to the frame worklet so it can
  // compute the net-motion make/miss signal; previous samples live worklet-side.
  const netRoiSv = useSharedValue<Box | null>(null);
  const prevNetSamples = useSharedValue<number[]>([]);
  // Previous frame's coarse luma grid for the frame-diff motion assist.
  const prevMotionGrid = useSharedValue<number[]>([]);
  // Locked-rim hoop ROI + FSM phase, published to the worklet so the ROI
  // ("digital zoom") second pass can decide when it's worth re-running the
  // detector on a magnified crop of the rim region (see the ROI block).
  const hoopRoiSv = useSharedValue<Box | null>(null);
  const phaseSv = useSharedValue<number>(0); // 0 IDLE, 1 SHOT_LIVE, 2 COOLDOWN
  // Sticky YOLO output layout — read fresh in the worklet, updated each frame.
  // Stops the parser's dual-layout tie-break from flipping on noise (which
  // scrambles class labels/coords on degraded input).
  const prevLayoutSv = useSharedValue<'channels-first' | 'channels-last' | undefined>(
    undefined,
  );

  const pipeline = useMemo(() => {
    const p = new ShotPipeline();
    let lastRimRef: unknown = null;
    p.setEvents({
      onShot: (s) => eventsRef.current.onShot?.(s),
      onRimLocked: (r) => eventsRef.current.onRimLocked?.(r),
      onRimDrift: () => eventsRef.current.onRimDrift?.(),
      onFrame: (state) => {
        // Keep the worklet's net + hoop ROIs in sync with the locked rim (rare
        // writes — only when the rim reference changes: lock / re-lock / drift).
        if (state.rim !== lastRimRef) {
          lastRimRef = state.rim;
          netRoiSv.value = state.rim ? { ...state.rim.netRoi } : null;
          hoopRoiSv.value = state.rim ? { ...state.rim.hoopRoi } : null;
        }
        // FSM phase for the ROI trigger (published every frame; the worklet
        // reads it one analysed frame late, which the net-motion arm covers).
        phaseSv.value = state.phase === 'SHOT_LIVE' ? 1 : state.phase === 'COOLDOWN' ? 2 : 0;
        overlay.value = {
          ball: state.ball
            ? {
                x: state.ball.cx,
                y: state.ball.cy,
                r: state.ball.r,
                // Kalman velocity (analysis px/s) + camera-clock sample time,
                // carried so the HUD can glide the ball between processed frames.
                vx: state.ball.vx,
                vy: state.ball.vy,
                t: state.ball.t,
              }
            : null,
          rim: state.rim?.box ?? null,
          traj: flattenTrajectory(state.liveTrajectory),
          phase: state.phase,
          frameW: state.frameWidth,
          frameH: state.frameHeight,
          srcW: srcDimsSv.value.w,
          srcH: srcDimsSv.value.h,
          dets: state.detections.map((d) => ({
            cls: d.cls,
            x: d.box.x,
            y: d.box.y,
            w: d.box.width,
            h: d.box.height,
            score: d.score,
          })),
          rimCountdown: state.rimCountdown,
          pred: state.predictedLanding,
          predTraj: state.predictedPath,
          fullArc: state.fullFlightPath,
          light: lightSv.value,
        };
      },
    });
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Demo mode: scripted scene at 30fps.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (activeMode !== 'demo') return;
    const mock = createMockDetector();
    debug.value = {
      ...EMPTY_DEBUG,
      mode: 'demo',
      modelLoaded: isModelLoaded,
      delegate: modelState.delegate,
      modelError: modelState.error,
    };
    const id = setInterval(() => {
      const t = nowSec();
      const state = pipeline.step({ frame: mock.frameAt(t), netMotionScore: 0 });
      debug.value = {
        ...debug.value,
        frames: debug.value.frames + 1,
        detCount: state.ball ? 1 : 0,
      };
    }, 33);
    return () => {
      clearInterval(id);
      pipeline.reset();
    };
  }, [activeMode, pipeline, nowSec, isModelLoaded, modelState.delegate, modelState.error, debug]);

  // Camera-mode teardown, mirroring the demo effect's cleanup above: leaving
  // the live screen (or flipping camera → demo) must reset the pipeline so an
  // in-flight FT anchor capture RESOLVES (reason 'reset') instead of leaving
  // the calibration chip's promise dangling forever. reset() also clears the
  // tracker/rim/FSM/calibration — the right scope here, since this pipeline
  // instance only lives as long as the hook and every mode restart begins
  // from a fresh rim lock anyway.
  useEffect(() => {
    if (activeMode !== 'camera') return;
    return () => {
      pipeline.reset();
    };
  }, [activeMode, pipeline]);

  // -------------------------------------------------------------------------
  // Camera mode: worklet → detections → JS pipeline.
  //
  // CRITICAL: the boxed model rides in a SharedValue, NOT the worklet closure.
  // useFrameOutput registers the worklet once; a closure would freeze the
  // "model still loading" undefined forever (observed on-device: frames never
  // advanced past the demo warm-up). A SharedValue is read fresh every frame.
  // -------------------------------------------------------------------------
  const boxedModelSv = useSharedValue<ReturnType<typeof NitroModules.box> | null>(null);
  useEffect(() => {
    boxedModelSv.value =
      modelState.model != null ? NitroModules.box(modelState.model) : null;
  }, [modelState.model, boxedModelSv]);

  // Pose model (MoveNet) for opt-in form analysis. Loaded only when the setting
  // is on, on the fast delegate with a CPU fallback. Rides a SharedValue like
  // the detector so the frame worklet reads it fresh (never a stale closure).
  const formAnalysis = useSettings((s) => s.formAnalysis);
  const shootingHand = useSettings((s) => s.shootingHand);
  const ballSize = useSettings((s) => s.ballSize);
  const boxedPoseSv = useSharedValue<ReturnType<typeof NitroModules.box> | null>(null);
  useEffect(() => {
    pipeline.setFormHand(shootingHand);
  }, [pipeline, shootingHand]);
  useEffect(() => {
    pipeline.setBallSize(ballSize);
  }, [pipeline, ballSize]);
  const rimHeightM = useSettings((s) => s.rimHeightM);
  useEffect(() => {
    pipeline.setRimHeight(rimHeightM);
  }, [pipeline, rimHeightM]);
  const depthVeto = useSettings((s) => s.depthVeto);
  useEffect(() => {
    pipeline.setDepthVeto(depthVeto);
  }, [pipeline, depthVeto]);
  const metric23 = useSettings((s) => s.metric23);
  useEffect(() => {
    pipeline.setMetric23(metric23);
  }, [pipeline, metric23]);
  const courtRange = useSettings((s) => s.courtRange);
  useEffect(() => {
    pipeline.setCourtRange(courtRange);
  }, [pipeline, courtRange]);
  const reappearance = useSettings((s) => s.reappearance);
  useEffect(() => {
    pipeline.setReappearance(reappearance);
  }, [pipeline, reappearance]);
  const useFlightArc = useSettings((s) => s.useFlightArc);
  useEffect(() => {
    pipeline.setUseFlightArc(useFlightArc);
  }, [pipeline, useFlightArc]);

  // IMU camera pitch (degrees, +up): from the gravity vector at ~4Hz, EMA'd.
  // Feeds the view-band classifier (under-hoop vs overhead disambiguation)
  // and the metric 2/3 estimator. The phone is static on a tripod/ground, so
  // a slow, smoothed sample is exactly right. Sign convention: back camera
  // axis elevation = asin(g_z/|g|) in device coords — surfaced in the debug
  // panel so a device check can confirm/flip it before the bands ship on.
  useEffect(() => {
    if (activeMode !== 'camera') return;
    let ema: number | null = null;
    DeviceMotion.setUpdateInterval(250);
    const sub = DeviceMotion.addListener((m) => {
      const g = m.accelerationIncludingGravity;
      if (!g) return;
      const norm = Math.hypot(g.x ?? 0, g.y ?? 0, g.z ?? 0);
      if (!(norm > 4)) return; // free-fall/garbage guard
      const pitch = (Math.asin(Math.max(-1, Math.min(1, (g.z ?? 0) / norm))) * 180) / Math.PI;
      ema = ema == null ? pitch : ema * 0.8 + pitch * 0.2;
      pipeline.setViewPitch(ema);
    });
    return () => {
      sub.remove();
      pipeline.setViewPitch(null);
    };
  }, [activeMode, pipeline]);
  useEffect(() => {
    let alive = true;
    if (!formAnalysis) {
      boxedPoseSv.value = null;
      return;
    }
    void (async () => {
      const delegates: ('core-ml' | 'android-gpu')[] =
        Platform.OS === 'ios' ? ['core-ml'] : ['android-gpu'];
      for (const d of [delegates, [] as ('core-ml' | 'android-gpu')[]]) {
        try {
          const pm = await loadTensorflowModel(POSE_ASSET, d);
          if (!alive) return;
          boxedPoseSv.value = NitroModules.box(pm);
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
  }, [formAnalysis, boxedPoseSv]);

  // Detection-rate budget (Settings > Detection). Captured as a plain const —
  // changing the setting re-renders and re-registers the frame worklet with
  // the new gate. 'battery' ~15fps (66ms), 'auto' ~30fps (33ms), 'max' = every
  // frame (0 = no gate, current behavior).
  const detectionRate = useSettings((s) => s.detectionRate);
  const gateMs = detectionRate === 'battery' ? 66 : detectionRate === 'max' ? 0 : 33;
  const lastRunMs = useSharedValue(0);
  // Rim-anchored ROI ("digital zoom") second pass. Captured as a plain const —
  // toggling the setting re-renders and re-registers the frame worklet. Its
  // per-frame trigger is self-limiting (see the ROI block below). The hoopRoi +
  // phase it needs are published from JS via hoopRoiSv/phaseSv (declared beside
  // netRoiSv above); cadence/timing/diagnostic counters live worklet-side.
  const roiZoom = useSettings((s) => s.roiZoom);
  // Frame-diff motion assist — experimental, default OFF (field reports showed
  // non-ball movers distracting the tracker). Captured by the worklet like
  // roiZoom, so toggling re-registers the frame processor.
  const motionAssist = useSettings((s) => s.motionAssist);
  const lastRoiRunMs = useSharedValue(0);
  const avgRoiMs = useSharedValue(0);
  const roiFramesSv = useSharedValue(0); // ROI passes actually run
  const roiHitsSv = useSharedValue(0); // ROI passes that recovered a ball
  // Rolling avg of measured inference time. Doubles as a THERMAL PROXY: a hot
  // chip clocks down, so inference slows — when it does, the adaptive gate
  // below backs the detection rate off to shed sustained load and let the phone
  // cool (the Kalman tracker keeps the overlay smooth through the gaps). No
  // native thermal API needed.
  const avgInferMs = useSharedValue(0);
  // Diagnostic: how many delivered frames VisionCamera dropped before onFrame.
  const droppedFrames = useSharedValue(0);

  const { resizer } = useResizer({
    width: detInputSize,
    height: detInputSize,
    // Channel order MUST match how the model was trained/validated:
    //  - YOLOX (Megvii) is trained on cv2 BGR frames (no RGB swap) — and the
    //    offline validation that confirmed this model detects used BGR, so the
    //    device MUST feed BGR too or the ball/rim colours invert and it detects
    //    nothing.
    //  - YOLO11 (Ultralytics) is trained on RGB.
    channelOrder: useYolox ? 'bgr' : 'rgb',
    dataType: 'float32',
    // 'contain' letterboxes the WHOLE frame into the square input (bars on the
    // short axis) instead of 'cover' center-cropping it. 'cover' discarded the
    // sides of a wide LANDSCAPE frame — taking the hoop out of the model input
    // entirely, so nothing detected. 'contain' keeps the whole scene visible in
    // any orientation, and matches the letterbox preprocessing both detectors
    // were validated with. The <Camera> preview uses 'contain' too so the boxes
    // line up (see live.tsx + the HUD overlay mapping).
    scaleMode: 'contain',
    // Layout MUST match the model's input tensor exactly — fast-tflite does NOT
    // transpose, and a mismatch silently collapses every score to ~0.
    //  - YOLO11 export is [1,3,S,S] channels-first  → PLANAR (NCHW).
    //  - YOLOX  export is [1,416,416,3]             → INTERLEAVED (NHWC).
    // Both take float32 0..1 (YOLOX bakes the *255 rescale into the graph).
    pixelLayout: useYolox ? 'interleaved' : 'planar',
  });

  // Pose resizer: MoveNet wants NHWC uint8 192×192 (INTERLEAVED — verified the
  // model input tensor is [1,192,192,3] uint8, standard TFLite layout, unlike
  // the detector's planar float).
  const { resizer: poseResizer } = useResizer({
    width: POSE_INPUT,
    height: POSE_INPUT,
    channelOrder: 'rgb',
    dataType: 'uint8',
    scaleMode: 'cover',
    pixelLayout: 'interleaved',
  });

  const onPayload = useMemo(
    () => (payload: FramePayload) => {
      // Use the CAMERA presentation timestamp (payload.frame.t, carried from the
      // worklet's frame.timestamp) as the shot clock so tResolved aligns with the
      // recorded video timeline. Fall back to nowSec() only when the frame had no
      // valid timestamp (t <= 0). The pose frame is rebased to the SAME value so
      // FormAnalyzer's cross-frame durations stay consistent.
      const t = payload.frame.t > 0 ? payload.frame.t : nowSec();
      // Publish this second as the camera media clock so recordingStartSec
      // (sampled in live.tsx via engine.nowCameraSec()) shares the exact clock.
      lastFrameSec.current = t;
      // Self-heal watch: a corrupt output tensor (both layouts garbage) means the
      // accelerator delegate mis-ran the graph. A sustained streak (~0.5s of
      // detections) flips to the CPU delegate, which reloads the model — once per
      // session, so it can never thrash. A single stray frame never trips it.
      const dbg = payload.frame.debug;
      if (dbg) {
        if (dbg.corrupt) {
          corruptStreak.current += 1;
          if (corruptStreak.current >= 15 && !forceCpuRef.current) {
            forceCpuRef.current = true;
            setForceCpu(true);
          }
        } else {
          corruptStreak.current = 0;
        }
      }
      pipeline.step({
        ...payload,
        frame: { ...payload.frame, t },
        pose: payload.pose ? { ...payload.pose, t } : payload.pose,
      });
    },
    [pipeline, nowSec],
  );

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    // ML gets small buffers; the video output keeps recording at full res.
    enablePreviewSizedOutputBuffers: true,
    // Physically rotate the frame buffer to the output orientation (the locked
    // interface — see <Camera orientationSource="interface"> in live.tsx). Without
    // this the buffer stays in the camera's SENSOR-NATIVE orientation, so the
    // model sees the scene rotated/flipped relative to the preview: detections
    // track but land in the wrong place, and an upside-down landscape (or portrait)
    // scene detects poorly. With it, frame.orientation is 'up', frame.width/height
    // are display-oriented, and the analysis frame is pixel-identical to what the
    // preview shows — so the HUD overlay maps exactly. Small per-frame cost on the
    // preview-sized buffer.
    enablePhysicalBufferRotation: true,
    // Backpressure: drop frames while the detector is still running.
    dropFramesWhileBusy: true,
    // Diagnostic: count drops so the debug panel can tell "camera never
    // streamed" (frames=0, dropped=0) apart from "every frame dropped"
    // (dropped climbing). Runs on the JS thread — a plain callback, not a
    // worklet — so touching debug.value here is safe.
    onFrameDropped() {
      droppedFrames.value += 1;
      debug.value = { ...debug.value, dropped: droppedFrames.value, mode: 'camera' };
    },
    onFrame(frame) {
      'worklet';
      try {
        // Diagnostic: mark that the frame processor entered at least once, even
        // if the gate skips this frame below. If the debug panel still shows
        // mode:demo after a live session, onFrame NEVER ran (camera output not
        // streaming) — vs mode:camera + low frames (entering but gated/erroring).
        if (debug.value.mode !== 'camera') {
          debug.value = { ...debug.value, mode: 'camera' };
        }
        // Adaptive thermal gate: run no faster than the base rate AND no faster
        // than ~1.4× the current inference time — so a hot, throttled chip (slow
        // inference) gets idle time between frames to cool, while a cool chip
        // runs at the full requested rate. 'max' (gateMs 0) still self-limits by
        // inference time to avoid pinning the chip at 100% in the sun.
        const effGate = Math.max(gateMs, avgInferMs.value * 1.4);
        if (effGate > 0) {
          const nowMs = Date.now();
          if (nowMs - lastRunMs.value < effGate) return;
          lastRunMs.value = nowMs;
        }
        const boxed = boxedModelSv.value;
        if (boxed == null || resizer == null) {
          // Heartbeat: prove the camera worklet is alive on the debug panel
          // even while the model is still loading.
          debug.value = {
            ...debug.value,
            mode: 'camera',
            frames: debug.value.frames + 1,
          };
          return;
        }
        // Everything from resize → runSync is wrapped so any native failure
        // (unsupported pixel format, buffer handoff) is CAPTURED to the debug
        // panel instead of silently producing no detections.
        let inMin = 0;
        let inMax = 0;
        let bufBytes = 0;
        let nonZeroPct = 0;
        let detErr = '';
        let parsed: ReturnType<typeof parseYoloOutput> | null = null;
        let netMotionScore = 0;
        // Hoisted so the finally can ALWAYS dispose it — otherwise a throw
        // between resize() and the old dispose() call (e.g. runSync failing on
        // one frame) leaks the GPU buffer, and leaked buffers accumulate until
        // the app slows to a freeze / gets OOM-killed.
        let resized: { getPixelBuffer(): ArrayBuffer; dispose(): void } | null = null;
        try {
        const tflite = boxed.unbox() as TensorflowModel;
        // Camera-frame dims for the HUD's letterbox mapping. With
        // enablePhysicalBufferRotation (frame output) + orientationSource
        // "interface" (Camera), the buffer is physically rotated to the locked UI
        // orientation, so frame.width/height are DISPLAY-oriented and match the
        // preview exactly. Constant within a locked-orientation session.
        srcDimsSv.value = { w: frame.width, h: frame.height };
        resized = resizer.resize(frame);
        const rawBuffer = resized.getPixelBuffer();
        bufBytes = rawBuffer.byteLength;
        // IMPORTANT: the MODEL is fed the RAW zero-copy buffer (native code reads
        // it directly). The JS Float32Array below is ONLY for debug sampling —
        // if the JS view can't read the Nitro buffer it reads 0 (nonZeroPct 0),
        // which tells us the JS/native discrepancy WITHOUT breaking the model.
        const inArr = new Float32Array(rawBuffer);
        let mn = 1e9;
        let mx = -1e9;
        let nz = 0;
        let sampled = 0;
        // Mean-luma accumulation rides the SAME sparse loop (zero extra
        // passes): the green channel is a fine luma proxy, and which sampled
        // indices ARE green depends on the buffer layout (must match the
        // resizer's pixelLayout): INTERLEAVED (YOLOX, B,G,R triplets) green
        // is k % 3 === 1; PLANAR (YOLO11) green is the middle S*S plane.
        const lumaPlaneStart = detInputSize * detInputSize;
        const lumaPlaneEnd = 2 * lumaPlaneStart;
        let lumaSum = 0;
        let lumaN = 0;
        for (let k = 0; k < inArr.length; k += 1499) {
          const v = inArr[k]!;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          if (v !== 0) nz++;
          sampled++;
          if (useYolox ? k % 3 === 1 : k >= lumaPlaneStart && k < lumaPlaneEnd) {
            lumaSum += v;
            lumaN++;
          }
        }
        if (mn === 1e9) mn = 0;
        if (mx === -1e9) mx = 0;
        nonZeroPct = sampled > 0 ? Math.round((100 * nz) / sampled) : 0;
        let meanLuma = lumaN > 0 ? lumaSum / lumaN : 0;
        // Insurance: YOLO expects 0..1 input. If the resizer emits 0..255 floats
        // on some device, normalize — a wrong input range is the classic
        // "model loaded but maxScore stays 0" failure.
        if (mx > 1.6) {
          for (let k = 0; k < inArr.length; k++) inArr[k] = inArr[k]! / 255;
          mn /= 255;
          mx /= 255;
          meanLuma /= 255;
        }
        inMin = mn;
        inMax = mx;
        // Scene luminance → light profile input. The 'contain' letterbox pads
        // the square with black bars which would deflate the mean; the bars
        // read exactly 0, so dividing the whole-square mean by the content-
        // area fraction recovers the CONTENT mean with no per-sample bounds
        // test (same geometry as ml/letterboxCull.ts). EMA'd hard — lighting
        // changes slowly, and classifyLight's hysteresis kills residual
        // jitter at the profile boundaries.
        if (lumaN > 0 && frame.width > 0 && frame.height > 0) {
          const lumaScale = detInputSize / Math.max(frame.width, frame.height);
          const contentFrac =
            (frame.width * lumaScale * (frame.height * lumaScale)) /
            (detInputSize * detInputSize);
          let luma = contentFrac > 0 ? meanLuma / contentFrac : meanLuma;
          if (luma > 1) luma = 1;
          // Floor a real measurement just above 0 so "measured pitch-black"
          // stays distinguishable from the 0 = never-measured sentinel.
          if (luma < 0.0001) luma = 0.0001;
          lightSv.value =
            lightSv.value === 0 ? luma : lightSv.value * 0.9 + luma * 0.1;
        }
        // Net-motion signal: sample a 12×12 grid of green-channel values inside
        // the locked rim's net ROI and diff against the previous frame. A made
        // shot whips the net → a burst of change. Score normalizes mean |Δ|
        // (0..1 floats) so ~0.12 saturates to 1. Costs ~144 reads/frame.
        const roi = netRoiSv.value;
        if (roi != null) {
          const S = detInputSize;
          const N = 12;
          // Green-channel index depends on the buffer layout (must match the
          // resizer's pixelLayout above):
          //  - PLANAR (YOLO11): green plane starts after the red plane at S*S,
          //    so green(px,py) = inArr[S*S + py*S + px].
          //  - INTERLEAVED (YOLOX): pixels are R,G,B,R,G,B…, so green(px,py) =
          //    inArr[(py*S + px)*3 + 1].
          const gPlane = S * S;
          const samples: number[] = new Array(N * N);
          let si = 0;
          for (let gy = 0; gy < N; gy++) {
            let py = Math.round(roi.y + ((gy + 0.5) / N) * roi.height);
            if (py < 0) py = 0;
            if (py > S - 1) py = S - 1;
            for (let gx = 0; gx < N; gx++) {
              let px = Math.round(roi.x + ((gx + 0.5) / N) * roi.width);
              if (px < 0) px = 0;
              if (px > S - 1) px = S - 1;
              samples[si++] = useYolox
                ? inArr[(py * S + px) * 3 + 1]!
                : inArr[gPlane + py * S + px]!;
            }
          }
          const prev = prevNetSamples.value;
          if (prev.length === samples.length) {
            let acc = 0;
            for (let i = 0; i < samples.length; i++) {
              acc += Math.abs(samples[i]! - prev[i]!);
            }
            const meanDiff = acc / samples.length;
            netMotionScore = Math.min(1, meanDiff / 0.12);
          }
          prevNetSamples.value = samples;
        }

        // Camera presentation timestamp for THIS frame, in seconds, so
        // tResolved and recordingStartSec share identical units (iOS reports
        // seconds; Android a nanosecond-scale value — the >1e6 test normalizes
        // it). 0 for an invalid frame → onPayload falls back to nowSec().
        const frameTsSec = frame.timestamp > 1e6 ? frame.timestamp / 1e9 : frame.timestamp;
        const t0 = performance.now();
        const outputs = tflite.runSync([rawBuffer]);
        const infMs = performance.now() - t0;
        // EMA of inference time — feeds the adaptive thermal gate next frame.
        avgInferMs.value = avgInferMs.value === 0 ? infMs : avgInferMs.value * 0.85 + infMs * 0.15;
        parsed = parseYoloOutput(new Float32Array(outputs[0]!), frameTsSec, {
          inputSize: detInputSize,
          prevLayout: prevLayoutSv.value,
          hasObjectness: useYolox,
        });
        // Persist the chosen layout so next frame's tie-break sticks instead of
        // flipping on noise (which scrambles labels). Only lock in a real layout.
        if (
          parsed.debug?.layout === 'channels-first' ||
          parsed.debug?.layout === 'channels-last'
        ) {
          prevLayoutSv.value = parsed.debug.layout;
        }

        // Letterbox phantom cull: the 'contain' resize pads the square with
        // black bars, and the model hallucinates detections there (worst:
        // 'person' boxes hugging the frame edges). Nothing physical can be in
        // the bars — drop every detection centered in them BEFORE the ROI
        // recall gate, tracker, FSM or HUD see it. See ml/letterboxCull.ts.
        {
          const culled = cullLetterboxDetections(
            parsed.detections,
            detInputSize,
            frame.width,
            frame.height,
          );
          if (culled !== parsed.detections) {
            parsed = { ...parsed, detections: culled as typeof parsed.detections };
          }
        }

        // --- Rim-anchored ROI ("digital zoom") second pass -----------------
        // Recover a small, net-occluded ball at the make/miss instant that the
        // cheap full-frame pass missed: crop the locked-rim region out of the
        // tensor we ALREADY have (inArr), upscale it to a full detector input,
        // and run the SAME model again — a ~15px ball becomes ~50px, the size
        // band the detector reliably hits. inArr MUST be read HERE, before the
        // `finally` frees the GPU buffer it views. The whole block is inside the
        // inner try, so any ROI failure leaves the primary `parsed` untouched.
        //
        // CEILING (honest): we upscale the already-downsampled analysis tensor,
        // not raw sensor pixels (VisionCamera exposes no frame-crop primitive),
        // so this recovers no NEW detail — only magnification + centering into
        // the model's reliable size band. A ball too small to survive the first
        // resize cannot be resurrected. Self-limiting: it only fires during a
        // live shot, only when the cheap pass missed a near-rim ball, throttled,
        // and only on phones whose inference is fast enough (thermal gate).
        const hoop = hoopRoiSv.value;
        if (
          roiZoom &&
          hoop != null &&
          avgInferMs.value < DETECTION.roi.skipIfAvgMsAbove &&
          (phaseSv.value === 1 || netMotionScore > DETECTION.roi.netMotionArm)
        ) {
          // Recall gate: only pay for the 2nd inference when the full-frame pass
          // had NO confident ball inside the hoop ROI (the exact miss zoom helps).
          let ballInHoop = false;
          for (let i = 0; i < parsed.detections.length; i++) {
            const dd = parsed.detections[i]!;
            if (dd.cls !== 'ball' || dd.score < DETECTION.ballScoreMin) continue;
            const bcx = dd.box.x + dd.box.width / 2;
            const bcy = dd.box.y + dd.box.height / 2;
            if (
              bcx >= hoop.x &&
              bcx <= hoop.x + hoop.width &&
              bcy >= hoop.y &&
              bcy <= hoop.y + hoop.height
            ) {
              ballInHoop = true;
              break;
            }
          }
          const nowRoiMs = Date.now();
          const roiGate = Math.max(
            gateMs * DETECTION.roi.cadenceFactor,
            avgInferMs.value * 2.8,
          );
          if (!ballInHoop && nowRoiMs - lastRoiRunMs.value >= roiGate) {
            lastRoiRunMs.value = nowRoiMs;
            roiFramesSv.value = roiFramesSv.value + 1;
            // Sroi === S: the loaded TFLite model has a FIXED input side, so the
            // ROI pass must feed the same square the model was compiled for.
            const S = detInputSize;
            const crop = squareCropRect(hoop, S);
            const rx = crop.rx;
            const ry = crop.ry;
            const rs = crop.rs;
            // Bilinear-upscale the rs×rs crop of inArr into a fresh S×S buffer,
            // in the SAME pixel layout the model expects (interleaved YOLOX /
            // planar YOLO11 — mirrors the net-motion green-channel indexing).
            const roiBuf = new Float32Array(S * S * 3);
            const gPlane = S * S;
            for (let oy = 0; oy < S; oy++) {
              const fy = ry + ((oy + 0.5) * rs) / S - 0.5;
              const yf = Math.floor(fy);
              const wy = fy - yf;
              const y0 = yf < 0 ? 0 : yf > S - 1 ? S - 1 : yf;
              const y1r = yf + 1;
              const y1 = y1r < 0 ? 0 : y1r > S - 1 ? S - 1 : y1r;
              for (let ox = 0; ox < S; ox++) {
                const fx = rx + ((ox + 0.5) * rs) / S - 0.5;
                const xf = Math.floor(fx);
                const wx = fx - xf;
                const x0 = xf < 0 ? 0 : xf > S - 1 ? S - 1 : xf;
                const x1r = xf + 1;
                const x1 = x1r < 0 ? 0 : x1r > S - 1 ? S - 1 : x1r;
                if (useYolox) {
                  const i00 = (y0 * S + x0) * 3;
                  const i01 = (y0 * S + x1) * 3;
                  const i10 = (y1 * S + x0) * 3;
                  const i11 = (y1 * S + x1) * 3;
                  const di = (oy * S + ox) * 3;
                  for (let c = 0; c < 3; c++) {
                    const top = inArr[i00 + c]! * (1 - wx) + inArr[i01 + c]! * wx;
                    const bot = inArr[i10 + c]! * (1 - wx) + inArr[i11 + c]! * wx;
                    roiBuf[di + c] = top * (1 - wy) + bot * wy;
                  }
                } else {
                  const di = oy * S + ox;
                  for (let c = 0; c < 3; c++) {
                    const base = c * gPlane;
                    const top =
                      inArr[base + y0 * S + x0]! * (1 - wx) +
                      inArr[base + y0 * S + x1]! * wx;
                    const bot =
                      inArr[base + y1 * S + x0]! * (1 - wx) +
                      inArr[base + y1 * S + x1]! * wx;
                    roiBuf[base + di] = top * (1 - wy) + bot * wy;
                  }
                }
              }
            }
            const rt0 = performance.now();
            const roiOut = tflite.runSync([roiBuf.buffer]);
            const rMs = performance.now() - rt0;
            // Separate EMA — the ROI time must NOT feed avgInferMs (that gate
            // governs primary detection; inflating it would throttle the app).
            avgRoiMs.value = avgRoiMs.value === 0 ? rMs : avgRoiMs.value * 0.85 + rMs * 0.15;
            const roiParsed = parseYoloOutput(new Float32Array(roiOut[0]!), frameTsSec, {
              inputSize: S,
              prevLayout: prevLayoutSv.value,
              hasObjectness: useYolox,
              scoreMin: DETECTION.ballScoreMinHoopRoi,
            });
            // Keep ONLY the 'ball' class from the ROI pass — deliberately DROP
            // any ROI 'ball_in_basket'. That class drives a make through the
            // FSM's `cls && occludedAtRim` branch WITHOUT geometric confirmation,
            // and a magnified crop of the net/rim is exactly where the detector
            // could hallucinate one — flipping a genuine MISS into a false MAKE.
            // The ROI's real value is recovering the small BALL so its trajectory
            // (and the geo make/miss crossing) is complete; the tracker's
            // jump/aspect/score gates still vet every ROI ball. The occluded-make
            // signal keeps coming from the full-frame pass only, unchanged.
            //
            // Merge the FULL primary list (already capped at maxDetections) with
            // the ROI balls, then NMS + cap — no pre-slice that could drop a real
            // off-court ball before the union.
            //
            // The remapped ROI boxes get the SAME letterbox cull as the primary
            // pass: squareCropRect clamps the crop to the S×S square, NOT the
            // content rect, so a hoop near a content edge puts magnified black
            // bar INTO the crop — the exact padding the model hallucinates in,
            // at the exact make/miss instant the ROI pass fires. Without this
            // re-cull, a bar-phantom ball would ride the relaxed hoopRoi score
            // gate straight into the tracker.
            const merged = parsed.detections.slice();
            let added = 0;
            for (let i = 0; i < roiParsed.detections.length; i++) {
              const rd = roiParsed.detections[i]!;
              if (rd.cls !== 'ball') continue;
              merged.push({ cls: rd.cls, score: rd.score, box: remapRoiBox(rd.box, rx, ry, rs, S) });
              added++;
            }
            if (added > 0) {
              const culledMerged = cullLetterboxDetections(
                merged,
                detInputSize,
                frame.width,
                frame.height,
              );
              parsed = {
                ...parsed,
                detections: nmsPerClass(culledMerged as typeof merged, 0.45).slice(0, 16),
              };
              roiHitsSv.value = roiHitsSv.value + 1;
            }
          }
        }

        // --- frame-diff motion assist ---------------------------------------
        // Coarse luma grid over the whole frame (~2.3k reads). When the
        // detector produced NO usable ball this frame, the strongest local
        // mover (outside people + the net) is injected as a synthetic 'ball'
        // candidate at score 0.13 — continuation-only by construction (the
        // tracker's cold gate is 0.2). inArr must be read HERE, before the
        // finally frees its buffer. Gated behind the experimental motionAssist
        // setting (default OFF) — zero cost when disabled.
        if (motionAssist) {
          const MG = DETECTION.motionCandidate.grid;
          const S = detInputSize;
          const gPlane = S * S;
          const grid: number[] = new Array(MG * MG);
          let gi = 0;
          for (let gy = 0; gy < MG; gy++) {
            const py = Math.min(S - 1, Math.round(((gy + 0.5) / MG) * S));
            for (let gx = 0; gx < MG; gx++) {
              const px = Math.min(S - 1, Math.round(((gx + 0.5) / MG) * S));
              grid[gi++] = useYolox
                ? inArr[(py * S + px) * 3 + 1]!
                : inArr[gPlane + py * S + px]!;
            }
          }
          const prev = prevMotionGrid.value;
          const hasBall = parsed.detections.some(
            (d) => d.cls === 'ball' && d.score >= DETECTION.ballScoreMinTracking,
          );
          if (!hasBall && prev.length === grid.length) {
            const exclude: Box[] = [];
            const net = netRoiSv.value;
            if (net != null) exclude.push(net);
            for (let i = 0; i < parsed.detections.length; i++) {
              const d = parsed.detections[i]!;
              if (d.cls === 'person' && d.score >= DETECTION.personScoreMin) {
                exclude.push({
                  x: d.box.x - d.box.width * 0.15,
                  y: d.box.y - d.box.height * 0.15,
                  width: d.box.width * 1.3,
                  height: d.box.height * 1.3,
                });
              }
            }
            const mc = findMotionCandidate(prev, grid, {
              grid: MG,
              size: S,
              minCellDiff: DETECTION.motionCandidate.minCellDiff,
              maxActiveFrac: DETECTION.motionCandidate.maxActiveFrac,
              exclude,
            });
            if (mc != null) {
              const r = S * DETECTION.motionCandidate.radiusFrac;
              parsed = {
                ...parsed,
                detections: [
                  ...parsed.detections,
                  {
                    cls: 'ball',
                    score: DETECTION.motionCandidate.score,
                    box: { x: mc.cx - r, y: mc.cy - r, width: 2 * r, height: 2 * r },
                  },
                ],
              };
            }
          }
          prevMotionGrid.value = grid;
        }
        } catch (e) {
          detErr = `detect: ${String(e).slice(0, 130)}`;
        } finally {
          // ALWAYS free the resized GPU buffer, success or throw.
          if (resized != null) resized.dispose();
        }
        const d = parsed ? parsed.debug : null;
        debug.value = {
          mode: 'camera',
          modelLoaded: true,
          frames: debug.value.frames + 1,
          outputLen: d ? d.outputLen : 0,
          layout: d ? d.layout : '-',
          maxScore: d ? d.maxScore : 0,
          detCount: parsed ? parsed.detections.length : 0,
          inputMin: inMin,
          inputMax: inMax,
          bufBytes,
          nonZeroPct,
          light: lightSv.value,
          delegate: debug.value.delegate,
          modelError: detErr,
          avgMs: Math.round(avgInferMs.value),
          fps: Math.round(1000 / Math.max(gateMs, avgInferMs.value * 1.4, 1)),
          dropped: droppedFrames.value,
          roiFrames: roiFramesSv.value,
          roiHits: roiHitsSv.value,
          roiAvgMs: Math.round(avgRoiMs.value),
        };
        if (!parsed) {
          // Detection threw this frame — still disposed via finally; skip the
          // pipeline hop (nothing to send).
          return;
        }

        // Opt-in form analysis: run the pose model on a separate 192×192 uint8
        // resize and attach the keypoints. Entirely skipped unless the pose
        // model is loaded (form-analysis setting on), so normal detection is
        // never slowed. Guarded so a pose failure can't kill the frame.
        let pose = null;
        const poseBox = boxedPoseSv.value;
        if (poseBox != null && poseResizer != null) {
          let pResized: { getPixelBuffer(): ArrayBuffer; dispose(): void } | null = null;
          try {
            const pModel = poseBox.unbox() as TensorflowModel;
            pResized = poseResizer.resize(frame);
            const pBuf = pResized.getPixelBuffer();
            const pOut = pModel.runSync([pBuf]);
            pose = parseMoveNet(
              new Float32Array(pOut[0]!),
              detInputSize,
              detInputSize,
              0,
            );
          } catch {
            pose = null;
          } finally {
            if (pResized != null) pResized.dispose();
          }
        }

        scheduleOnRN(onPayload, {
          frame: parsed,
          netMotionScore,
          pose,
          // Light-aware detection profile: the pipeline classifies this and
          // relaxes the tracker's cold ball gate in genuinely dark scenes.
          light: lightSv.value,
        });
      } catch (outerErr) {
        // A throw ANYWHERE in the frame worklet outside the inner detect
        // try/catch (the gate, a debug write, scheduleOnRN, the pose path)
        // used to propagate uncaught — and an uncaught worklet exception can
        // make VisionCamera stop delivering frames for the rest of the session
        // (frame processor stuck after a few frames). Swallow it, surface it to
        // the debug panel, and keep the processor alive for the next frame.
        debug.value = {
          ...debug.value,
          mode: 'camera',
          modelError: `frame: ${String(outerErr).slice(0, 120)}`,
        };
      } finally {
        frame.dispose();
      }
    },
  });

  const videoOutput = useVideoOutput({ enableAudio: true, fileType: 'mp4' });
  const recorderRef = useRef<{ stop: () => Promise<void>; path: Promise<string> } | null>(null);

  const startRecording = useMemo(
    () => async () => {
      if (activeMode !== 'camera') return;
      const recorder = await videoOutput.createRecorder({});
      let resolvePath!: (p: string) => void;
      let rejectPath!: (e: unknown) => void;
      const path = new Promise<string>((res, rej) => {
        resolvePath = res;
        rejectPath = rej;
      });
      await recorder.startRecording(
        (p: string) => resolvePath(p),
        (e: unknown) => rejectPath(e),
      );
      recorderRef.current = { stop: () => recorder.stopRecording(), path };
    },
    [activeMode, videoOutput],
  );

  const stopRecording = useMemo(
    () => async () => {
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (!rec) return null;
      await rec.stop();
      try {
        return await rec.path;
      } catch {
        return null;
      }
    },
    [],
  );

  return {
    activeMode,
    overlay,
    debug,
    camera:
      activeMode === 'camera'
        ? {
            device,
            outputs: [videoOutput, frameOutput],
            hasPermission,
            requestPermission,
          }
        : null,
    nowSec,
    nowCameraSec,
    startRecording,
    stopRecording,
    isModelLoaded,
    inferenceMs: modelState.inferenceMs,
    setManualRim: (box: Box) =>
      pipeline.setManualRim(box, {
        width: detInputSize,
        height: detInputSize,
      }),
    reAim: () => pipeline.reAim(),
    captureFtAnchor: () => pipeline.captureFtAnchor(),
  };
}

function flattenTrajectory(traj: readonly { cx: number; cy: number }[]): number[] {
  const out: number[] = new Array(traj.length * 2);
  for (let i = 0; i < traj.length; i++) {
    out[i * 2] = traj[i]!.cx;
    out[i * 2 + 1] = traj[i]!.cy;
  }
  return out;
}
