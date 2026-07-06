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
import { parseYoloOutput } from '../ml/yoloParser';
import { parseMoveNet } from '../ml/poseParser';
import { ShotPipeline, type FramePayload } from '../pipeline/shotPipeline';
import { useSettings } from '../state/settingsStore';

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
  /** Seconds left on the pre-lock "hold steady" countdown (HUD shows ceil() as a
   *  3-2-1 reticle), or null when not counting / already locked. */
  rimCountdown: number | null;
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
  delegate: 'loading',
  modelError: '',
  avgMs: 0,
  fps: 0,
  dropped: 0,
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
      const yoloxAsset = perfMode === 'speed' ? MODEL_ASSETS.yolox : MODEL_ASSETS.yolox640;
      const yoloxTag = perfMode === 'speed' ? 'yolox416' : 'yolox640';
      const yoloxGpu = { asset: yoloxAsset, label: `${yoloxTag}/${fast.label}`, delegates: fast.delegates };
      const yoloxCpu = { asset: yoloxAsset, label: `${yoloxTag}/cpu`, delegates: none };
      const attempts: Attempt[] = useYolox
        ? detectorAccel === 'gpu'
          ? [yoloxGpu, yoloxCpu]
          : [yoloxCpu, yoloxGpu]
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
        // Keep the worklet's net ROI in sync with the locked rim (rare writes).
        if (state.rim !== lastRimRef) {
          lastRimRef = state.rim;
          netRoiSv.value = state.rim ? { ...state.rim.netRoi } : null;
        }
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
  const boxedPoseSv = useSharedValue<ReturnType<typeof NitroModules.box> | null>(null);
  useEffect(() => {
    pipeline.setFormHand(shootingHand);
  }, [pipeline, shootingHand]);
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
        for (let k = 0; k < inArr.length; k += 1499) {
          const v = inArr[k]!;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          if (v !== 0) nz++;
          sampled++;
        }
        if (mn === 1e9) mn = 0;
        if (mx === -1e9) mx = 0;
        nonZeroPct = sampled > 0 ? Math.round((100 * nz) / sampled) : 0;
        // Insurance: YOLO expects 0..1 input. If the resizer emits 0..255 floats
        // on some device, normalize — a wrong input range is the classic
        // "model loaded but maxScore stays 0" failure.
        if (mx > 1.6) {
          for (let k = 0; k < inArr.length; k++) inArr[k] = inArr[k]! / 255;
          mn /= 255;
          mx /= 255;
        }
        inMin = mn;
        inMax = mx;
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
          delegate: debug.value.delegate,
          modelError: detErr,
          avgMs: Math.round(avgInferMs.value),
          fps: Math.round(1000 / Math.max(gateMs, avgInferMs.value * 1.4, 1)),
          dropped: droppedFrames.value,
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

        scheduleOnRN(onPayload, { frame: parsed, netMotionScore, pose });
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
