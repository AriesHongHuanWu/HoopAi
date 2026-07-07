/**
 * User settings, persisted across launches via expo-sqlite's key-value store.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { SoundPack } from '../camera/soundPacks';
import type { ShootingHand } from '../core/types';

/** Which clips survive when a recorded session ends. */
export type KeepMode = 'makes' | 'decided' | 'all' | 'none';

/** Metric read aloud after each shot (HomeCourt-style voice announcements). */
export type VoiceMetric = 'none' | 'result' | 'entryAngle' | 'fgPct';

/**
 * Which detector to run.
 * - 'auto' (default): measure the precise model's real speed on THIS device at
 *   load; keep it when fast enough, otherwise drop to standard automatically —
 *   new phones get accuracy, older ones (iPhone XR/11 class) get smoothness.
 * - 'standard' = YOLO11n (fast, lightest battery).
 * - 'precise'  = YOLO11s (higher accuracy, slower).
 */
export type DetectorModel = 'auto' | 'standard' | 'precise';

/**
 * How often the detector analyzes camera frames.
 * - 'auto' (default): ~30fps gate — smooth tracking on every supported phone.
 * - 'battery': ~15fps gate — cooler phone, longer sessions.
 * - 'max': every camera frame — newest phones only.
 */
export type DetectionRate = 'auto' | 'battery' | 'max';

/**
 * Detector input resolution — the biggest speed lever (cost ∝ pixels²).
 * - 'quality' (default): 640px — best accuracy, ~13fps detection on iPhone XR.
 * - 'speed': 320px — ~4× faster (30-60fps on XR), slightly weaker on a tiny/
 *   far ball. Uses a dedicated 320-exported nano model.
 */
export type PerfMode = 'quality' | 'speed';

/**
 * Which detector architecture to run.
 * - 'yolox' (default): the Apache-2.0 YOLOX-Nano detector (416px, obj-aware). A
 *   standard-conv graph the Metal GPU runs correctly, so it's fast AND accurate
 *   on iPhone — and its licence is clean for a paid app (AP50 0.873).
 * - 'yolo' (legacy fallback): the older Ultralytics YOLO11 detector (AGPL). GPU
 *   delegates corrupt its graph on some iPhones, so the self-healing delegate
 *   falls back to CPU there (see useShotEngine). Kept selectable as a fallback.
 */
export type DetectorEngine = 'yolo' | 'yolox';

/**
 * Which compute delegate runs the YOLOX detector.
 * - 'cpu' (default): XNNPACK — always numerically correct (the Test AI verify
 *   screen uses it and gets accurate boxes). YOLOX-Nano @416 is small, so it's
 *   ~real-time, but on an older phone (iPhone XR/A11) it may not hit full fps.
 * - 'gpu': Metal (iOS) / GPU (Android) — faster, but the GPU delegate can DEGRADE
 *   YOLOX output on some devices (imprecise/missed boxes). Try it for speed; if
 *   tracking looks worse than the CPU option, switch back.
 * Only affects the YOLOX engine; YOLO11 keeps its own auto delegate + self-heal.
 */
export type DetectorAccel = 'cpu' | 'gpu';

/**
 * A one-tap tracking preset that bundles the four low-level detector knobs
 * (engine / accelerator / input resolution / frame rate) into a single
 * accuracy↔speed choice, so most users never open the advanced controls.
 * - 'accuracy': the most precise setup — YOLOX on CPU at 640px (what the Test
 *   AI screen uses). Best ball tracking; heaviest on the phone.
 * - 'balanced': YOLOX on GPU at 640px — the big input keeps the ball visible,
 *   the GPU keeps it fast. The recommended middle.
 * - 'smooth': YOLOX on GPU at 416px — lightest and fastest for older phones,
 *   at some cost to a tiny/far ball.
 * - 'custom': the knobs were set individually and don't match a preset.
 */
export type TrackingPreset = 'accuracy' | 'balanced' | 'smooth' | 'custom';

/** The four detector knobs a non-custom {@link TrackingPreset} sets together. */
export type TrackingKnobs = Pick<
  SettingsState,
  'detectorEngine' | 'detectorAccel' | 'perfMode' | 'detectionRate'
>;

/** Concrete knob values each preset applies. */
export const TRACKING_PRESETS: Record<Exclude<TrackingPreset, 'custom'>, TrackingKnobs> = {
  accuracy: { detectorEngine: 'yolox', detectorAccel: 'cpu', perfMode: 'quality', detectionRate: 'auto' },
  balanced: { detectorEngine: 'yolox', detectorAccel: 'gpu', perfMode: 'quality', detectionRate: 'auto' },
  smooth: { detectorEngine: 'yolox', detectorAccel: 'gpu', perfMode: 'speed', detectionRate: 'auto' },
};

/**
 * Which preset the current knob values correspond to, or 'custom' when they
 * match none. Derived (not persisted) so the preset selector and the advanced
 * knobs can never drift out of sync.
 */
export function presetFromKnobs(s: TrackingKnobs): TrackingPreset {
  for (const key of ['accuracy', 'balanced', 'smooth'] as const) {
    const p = TRACKING_PRESETS[key];
    if (
      p.detectorEngine === s.detectorEngine &&
      p.detectorAccel === s.detectorAccel &&
      p.perfMode === s.perfMode &&
      p.detectionRate === s.detectionRate
    ) {
      return key;
    }
  }
  return 'custom';
}

/** Clip window bounds (seconds), used by the Settings > Video steppers. */
export const CLIP_PRE_ROLL_MIN = 2;
export const CLIP_PRE_ROLL_MAX = 10;
export const CLIP_POST_ROLL_MIN = 1;
export const CLIP_POST_ROLL_MAX = 5;

/** Screens with an in-app coach-marks walkthrough. */
export type TutorialScreen = 'home' | 'live' | 'summary';

/** Has the walkthrough for each screen been seen (and dismissed) once? */
export type TutorialSeen = Record<TutorialScreen, boolean>;

const TUTORIAL_SEEN_DEFAULT: TutorialSeen = {
  home: false,
  live: false,
  summary: false,
};

export interface SettingsState {
  soundsEnabled: boolean;
  hapticsEnabled: boolean;
  /** Which feedback sound voice plays (see src/camera/soundPacks.ts). */
  soundPack: SoundPack;
  /** Record video during sessions at all. */
  recordVideo: boolean;
  /** Auto-save each session recording to the device photo library. */
  saveToPhotos: boolean;
  keepMode: KeepMode;
  /** Seconds of video kept before a shot resolves in highlight clips (2–10). */
  clipPreRollSec: number;
  /** Seconds of video kept after a shot resolves in highlight clips (1–5). */
  clipPostRollSec: number;
  voiceMetric: VoiceMetric;
  shootingHand: ShootingHand;
  /**
   * Ball size (7 men's standard / 6 women+youth / 5 kids). Feeds the depth-
   * ratio parallax gate — the ball's REAL diameter is the metric ruler, so a
   * mis-set size costs about half the far-range discrimination signal.
   */
  ballSize: 7 | 6 | 5;
  /** For jump/release-height calibration. Null until profile setup. */
  playerHeightCm: number | null;
  onboardingDone: boolean;
  detectorModel: DetectorModel;
  /** Detection frame-rate budget (see DetectionRate). */
  detectionRate: DetectionRate;
  /** Detector input resolution / speed tradeoff (see PerfMode). */
  perfMode: PerfMode;
  /** Detector architecture (see DetectorEngine). Default 'yolox'. */
  detectorEngine: DetectorEngine;
  /** Compute delegate for the YOLOX detector (see DetectorAccel). Default 'cpu'. */
  detectorAccel: DetectorAccel;
  /**
   * Last on-device model smoke-test result — delegate label (e.g.
   * "precise/core-ml") + measured latency in ms. Written by useShotEngine
   * after each successful model load so Settings can show real device
   * numbers without running the camera. Null until the first session.
   */
  lastBenchmark: { delegate: string; ms: number } | null;
  /** Show the on-screen detection diagnostics panel. Default off. */
  debugMode: boolean;
  /**
   * Rim-anchored ROI ("digital zoom") second detection pass — re-runs the
   * detector on a magnified crop of the locked-rim region when the full-frame
   * pass missed the near-rim ball, to recover it at the make/miss instant.
   * Self-limiting (only fires during a live shot, when the cheap pass missed,
   * and only on phones fast enough — see DETECTION.roi). Default on; experimental
   * because its on-device recall gain is unverified. See useShotEngine.ts.
   */
  roiZoom: boolean;
  /**
   * Depth-ratio parallax veto (experimental): uses the ball's known size vs
   * the rim's to catch airballs crossing IN FRONT of the hoop being miscalled
   * as makes. Veto-only (can only turn a false make into a miss), silent
   * outside its verified envelope. Default off pending field validation.
   */
  depthVeto: boolean;
  /**
   * Metric 2/3 estimation (experimental): pinhole geometry off the rim's real
   * size (0.45m) + height (3.05m) computes the shooter's TRUE distance in
   * meters instead of the perspective-fudged rim-widths heuristic. Falls back
   * to the heuristic whenever the scene can't support a confident answer.
   */
  metric23: boolean;
  /**
   * Run the pose model for shooting-form analysis + coaching. Default off — it
   * runs a second model per frame, best on recent phones. See formAnalysis.ts.
   */
  formAnalysis: boolean;
  /** Per-screen "has the coach-marks walkthrough been shown once?" flags. */
  tutorialSeen: TutorialSeen;
  /**
   * Daily make goal shown as a progress ring on Home (src/core/goals.ts).
   * 0 means the goal is off — no ring is shown. Persisted, 0–500 by 10s in
   * the Settings stepper.
   */
  dailyGoalMakes: number;

  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  /**
   * Apply a tracking preset atomically — sets engine + accelerator + input
   * resolution + frame rate in one update so the four never land in an
   * inconsistent intermediate state. See {@link TRACKING_PRESETS}.
   */
  applyTrackingPreset: (preset: Exclude<TrackingPreset, 'custom'>) => void;
  /** Mark one screen's walkthrough as seen (called on finish/skip). */
  markTutorialSeen: (screen: TutorialScreen) => void;
  /**
   * Clear all tutorial-seen flags so every walkthrough re-triggers.
   * onboardingDone is left untouched — only the in-app coach marks reset.
   * Exposed for Settings > "Restart tutorial".
   */
  resetTutorial: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      soundsEnabled: true,
      hapticsEnabled: true,
      soundPack: 'classic',
      recordVideo: true,
      saveToPhotos: true,
      keepMode: 'makes',
      clipPreRollSec: 6,
      clipPostRollSec: 2,
      voiceMetric: 'none',
      shootingHand: 'right',
      ballSize: 7,
      playerHeightCm: null,
      onboardingDone: false,
      detectorModel: 'auto',
      detectionRate: 'auto',
      perfMode: 'quality',
      detectorEngine: 'yolox',
      detectorAccel: 'cpu',
      lastBenchmark: null,
      debugMode: false,
      roiZoom: true,
      depthVeto: false,
      metric23: false,
      formAnalysis: false,
      tutorialSeen: TUTORIAL_SEEN_DEFAULT,
      dailyGoalMakes: 0,
      set: (key, value) => set({ [key]: value } as Pick<SettingsState, typeof key>),
      applyTrackingPreset: (preset) => set({ ...TRACKING_PRESETS[preset] }),
      markTutorialSeen: (screen) =>
        set((s) => ({ tutorialSeen: { ...s.tutorialSeen, [screen]: true } })),
      resetTutorial: () => set({ tutorialSeen: { ...TUTORIAL_SEEN_DEFAULT } }),
    }),
    {
      name: 'hoopai-settings',
      storage: createJSONStorage(() => Storage),
      partialize: ({ set: _set, ...rest }) => rest,
      // Bump this whenever a persisted key is renamed or removed, and extend
      // `migrate` to translate the old shape forward. Starting at 1 (rather
      // than leaving it unset) gives every future schema change a concrete
      // "from version N" to branch on instead of relying on zustand's default
      // shallow-merge rehydration, which silently keeps stale/renamed keys
      // around forever.
      version: 2,
      migrate: (persisted, version) => {
        const s = persisted as SettingsState;
        // v2: YOLOX (Apache-2.0, GPU-correct) becomes the default detector. Move
        // existing installs off the old YOLO11 default onto it — the opt-in beta
        // shipped only hours earlier, so there are no meaningful explicit 'yolo'
        // choices worth preserving. Anyone can re-select YOLO11 in Settings.
        if (version < 2) s.detectorEngine = 'yolox';
        return s;
      },
    },
  ),
);
