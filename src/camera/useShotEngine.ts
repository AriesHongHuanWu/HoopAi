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

// Placeholder until a trained model replaces it (load failure → demo mode).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MODEL_ASSET = require('../../assets/models/hoopai-det.tflite');

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
  }>({ model: null, delegate: 'loading', error: '' });

  useEffect(() => {
    let alive = true;
    void (async () => {
      const attempts: { label: string; delegates: ('core-ml' | 'android-gpu')[] }[] =
        Platform.OS === 'ios'
          ? [{ label: 'core-ml', delegates: ['core-ml'] }, { label: 'cpu', delegates: [] }]
          : [{ label: 'android-gpu', delegates: ['android-gpu'] }, { label: 'cpu', delegates: [] }];
      let lastError = '';
      for (const a of attempts) {
        try {
          const m = await loadTensorflowModel(MODEL_ASSET, a.delegates);
          if (!alive) return;
          setModelState({ model: m, delegate: a.label, error: '' });
          return;
        } catch (e) {
          lastError = `${a.label}: ${String(e).slice(0, 160)}`;
          if (!alive) return;
          setModelState({ model: null, delegate: a.label, error: lastError });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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

  const pipeline = useMemo(() => {
    const p = new ShotPipeline();
    p.setEvents({
      onShot: (s) => eventsRef.current.onShot?.(s),
      onRimLocked: (r) => eventsRef.current.onRimLocked?.(r),
      onRimDrift: () => eventsRef.current.onRimDrift?.(),
      onFrame: (state) => {
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
  // -------------------------------------------------------------------------
  const boxedModel = useMemo(
    () => (modelState.model != null ? NitroModules.box(modelState.model) : undefined),
    [modelState.model],
  );

  const { resizer } = useResizer({
    width: DETECTION.inputSize,
    height: DETECTION.inputSize,
    channelOrder: 'rgb',
    dataType: 'float32',
    scaleMode: 'cover',
    pixelLayout: 'interleaved',
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
        if (boxedModel == null || resizer == null) return;
        const tflite = boxedModel.unbox();
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
        scheduleOnRN(onPayload, { frame: parsed, netMotionScore: 0 });
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
