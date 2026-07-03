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
import { loadTensorflowModel, type TensorflowModel } from 'react-native-fast-tflite';
import { NitroModules } from 'react-native-nitro-modules';

import { DETECTION } from '../core/config';
import type { Box, ResolvedShot, RimGeometry } from '../core/types';
import { createMockDetector } from '../ml/mockDetector';
import { parseYoloOutput } from '../ml/yoloParser';
import { ShotPipeline, type FramePayload } from '../pipeline/shotPipeline';
import { useSettings } from '../state/settingsStore';

// Bundled detectors (user-selectable in Settings). 'standard' = YOLO11n
// (fast); 'precise' = YOLO11s trained on more scenes (accurate, slower).
/* eslint-disable @typescript-eslint/no-var-requires */
const MODEL_ASSETS = {
  standard: require('../../assets/models/hoopai-det.tflite'),
  precise: require('../../assets/models/hoopai-det-precise.tflite'),
} as const;
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * 'auto' detector budget: keep the precise model only when a smoke-test
 * inference beats this. ~55ms ≈ 18fps detection — the Kalman tracker
 * interpolates that to a smooth 30fps overlay; anything slower steps down to
 * the standard model (iPhone XR/11-class or delegates that fell back to CPU).
 */
const AUTO_PRECISE_MAX_MS = 55;

export type EngineMode = 'auto' | 'demo' | 'camera';

/** Overlay state published every analysed frame; consumed by the Skia HUD. */
export interface OverlayState {
  ball: { x: number; y: number; r: number } | null;
  rim: Box | null;
  /** Flattened x,y pairs of the live shot trajectory (analysis px). */
  traj: number[];
  phase: 'IDLE' | 'SHOT_LIVE' | 'COOLDOWN';
  frameW: number;
  frameH: number;
}

export const EMPTY_OVERLAY: OverlayState = {
  ball: null,
  rim: null,
  traj: [],
  phase: 'IDLE',
  frameW: 640,
  frameH: 640,
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
  /** Which delegate the model loaded with ('core-ml' | 'android-gpu' | 'cpu' | 'loading'). */
  delegate: string;
  /** Load failure reason, empty when loaded. */
  modelError: string;
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
  delegate: 'loading',
  modelError: '',
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
  /** Session-relative seconds (same clock as shot timestamps). */
  nowSec: () => number;
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

  const detectorModel = useSettings((s) => s.detectorModel);

  useEffect(() => {
    let alive = true;
    setModelState({ model: null, delegate: 'loading', error: '', inferenceMs: 0 });
    void (async () => {
      const fast: { label: string; delegates: ('core-ml' | 'android-gpu')[] } =
        Platform.OS === 'ios'
          ? { label: 'core-ml', delegates: ['core-ml'] }
          : { label: 'android-gpu', delegates: ['android-gpu'] };
      type Delegates = ('core-ml' | 'android-gpu')[];
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
      const attempts: Attempt[] =
        detectorModel === 'auto'
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
          const dummy = new Float32Array(
            DETECTION.inputSize * DETECTION.inputSize * 3,
          );
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
  }, [detectorModel]);

  const isModelLoaded = modelState.model != null;
  const activeMode: 'demo' | 'camera' =
    mode === 'demo' || (mode === 'auto' && !isModelLoaded) || device == null
      ? 'demo'
      : 'camera';


  const overlay = useSharedValue<OverlayState>(EMPTY_OVERLAY);
  const debug = useSharedValue<EngineDebug>({ ...EMPTY_DEBUG });

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

  // Session clock: monotonic seconds since engine mount.
  const t0 = useRef<number>(performance.now());
  const nowSec = useMemo(() => () => (performance.now() - t0.current) / 1000, []);

  // Keep latest events in a ref so the pipeline never holds stale closures.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  // Net ROI (analysis-frame px) published to the frame worklet so it can
  // compute the net-motion make/miss signal; previous samples live worklet-side.
  const netRoiSv = useSharedValue<Box | null>(null);
  const prevNetSamples = useSharedValue<number[]>([]);

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
          ball: state.ball ? { x: state.ball.cx, y: state.ball.cy, r: state.ball.r } : null,
          rim: state.rim?.box ?? null,
          traj: flattenTrajectory(state.liveTrajectory),
          phase: state.phase,
          frameW: state.frameWidth,
          frameH: state.frameHeight,
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

  // Detection-rate budget (Settings > Detection). Captured as a plain const —
  // changing the setting re-renders and re-registers the frame worklet with
  // the new gate. 'battery' ~15fps (66ms), 'auto' ~30fps (33ms), 'max' = every
  // frame (0 = no gate, current behavior).
  const detectionRate = useSettings((s) => s.detectionRate);
  const gateMs = detectionRate === 'battery' ? 66 : detectionRate === 'max' ? 0 : 33;
  const lastRunMs = useSharedValue(0);

  const { resizer } = useResizer({
    width: DETECTION.inputSize,
    height: DETECTION.inputSize,
    channelOrder: 'rgb',
    dataType: 'float32',
    scaleMode: 'cover',
    // PLANAR (NCHW): the exported YOLO tflite input tensor is [1,3,640,640],
    // channels-first. Verified empirically — interleaved (NHWC) feeds the model
    // scrambled pixels and every score collapses to ~0 (no detections), planar
    // produces real detections (scores up to 0.7). fast-tflite does NOT
    // transpose; the buffer layout must match the tensor exactly.
    pixelLayout: 'planar',
  });

  const onPayload = useMemo(
    () => (payload: FramePayload) => {
      // Rebase worklet time onto the session clock at arrival (v1 clock; see
      // BUILDING.md for the camera-timestamp upgrade).
      pipeline.step({ ...payload, frame: { ...payload.frame, t: nowSec() } });
    },
    [pipeline, nowSec],
  );

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    // ML gets small buffers; the video output keeps recording at full res.
    enablePreviewSizedOutputBuffers: true,
    // Backpressure: drop frames while the detector is still running.
    dropFramesWhileBusy: true,
    onFrame(frame) {
      'worklet';
      try {
        // Detection-rate gate: skip frames beyond the budget. Skipped frames
        // still dispose (finally below) and return early WITHOUT bumping the
        // debug heartbeat — only processed frames count.
        if (gateMs > 0) {
          const nowMs = Date.now();
          if (nowMs - lastRunMs.value < gateMs) return;
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
        const tflite = boxed.unbox() as TensorflowModel;
        const resized = resizer.resize(frame);
        const buffer = resized.getPixelBuffer();
        // Sample the model input range (should read ~0..1) for the debug panel.
        const inArr = new Float32Array(buffer);
        let inMin = 1e9;
        let inMax = -1e9;
        for (let k = 0; k < inArr.length; k += 1499) {
          const v = inArr[k]!;
          if (v < inMin) inMin = v;
          if (v > inMax) inMax = v;
        }
        // Insurance: YOLO expects 0..1 input. If the resizer ever emits
        // 0..255 floats on some device, normalize in place — a wrong input
        // range is the classic "model loaded but maxScore stays 0" failure.
        if (inMax > 1.6) {
          for (let k = 0; k < inArr.length; k++) inArr[k] = inArr[k]! / 255;
          inMin /= 255;
          inMax /= 255;
        }
        // Net-motion signal: sample a 12×12 grid of green-channel values inside
        // the locked rim's net ROI and diff against the previous frame. A made
        // shot whips the net → a burst of change. Score normalizes mean |Δ|
        // (0..1 floats) so ~0.12 saturates to 1. Costs ~144 reads/frame.
        let netMotionScore = 0;
        const roi = netRoiSv.value;
        if (roi != null) {
          const S = DETECTION.inputSize;
          const N = 12;
          // PLANAR buffer: the green channel plane starts at offset S*S (after
          // the full red plane), so green(px,py) = inArr[S*S + py*S + px].
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
              samples[si++] = inArr[gPlane + py * S + px]!;
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

        const outputs = tflite.runSync([buffer]);
        resized.dispose();
        const parsed = parseYoloOutput(new Float32Array(outputs[0]!), 0, {
          inputSize: DETECTION.inputSize,
        });
        const d = parsed.debug;
        debug.value = {
          mode: 'camera',
          modelLoaded: true,
          frames: debug.value.frames + 1,
          outputLen: d ? d.outputLen : 0,
          layout: d ? d.layout : '-',
          maxScore: d ? d.maxScore : 0,
          detCount: parsed.detections.length,
          inputMin: inMin,
          inputMax: inMax,
          delegate: debug.value.delegate,
          modelError: '',
        };
        scheduleOnRN(onPayload, { frame: parsed, netMotionScore });
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
    startRecording,
    stopRecording,
    isModelLoaded,
    inferenceMs: modelState.inferenceMs,
    setManualRim: (box: Box) =>
      pipeline.setManualRim(box, {
        width: DETECTION.inputSize,
        height: DETECTION.inputSize,
      }),
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
