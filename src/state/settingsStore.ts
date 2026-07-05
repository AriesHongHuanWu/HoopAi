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
 * - 'yolo' (default): the shipping Ultralytics YOLO11 detector (AGPL). GPU
 *   delegates corrupt its graph on some iPhones, so the self-healing delegate
 *   falls back to CPU there (see useShotEngine).
 * - 'yolox' (beta): the Apache-2.0 YOLOX-Nano detector (416px, obj-aware). A
 *   standard-conv graph the Metal GPU runs correctly, so it should be fast AND
 *   accurate on iPhone — and its licence is clean for a paid app. Offline-
 *   validated (AP50 0.873); the live camera feed still needs an on-device
 *   confirmation, which is why it's opt-in and default-off.
 */
export type DetectorEngine = 'yolo' | 'yolox';

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
  /** For jump/release-height calibration. Null until profile setup. */
  playerHeightCm: number | null;
  onboardingDone: boolean;
  detectorModel: DetectorModel;
  /** Detection frame-rate budget (see DetectionRate). */
  detectionRate: DetectionRate;
  /** Detector input resolution / speed tradeoff (see PerfMode). */
  perfMode: PerfMode;
  /** Detector architecture (see DetectorEngine). Default 'yolo'. */
  detectorEngine: DetectorEngine;
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
      playerHeightCm: null,
      onboardingDone: false,
      detectorModel: 'auto',
      detectionRate: 'auto',
      perfMode: 'quality',
      detectorEngine: 'yolo',
      lastBenchmark: null,
      debugMode: false,
      formAnalysis: false,
      tutorialSeen: TUTORIAL_SEEN_DEFAULT,
      dailyGoalMakes: 0,
      set: (key, value) => set({ [key]: value } as Pick<SettingsState, typeof key>),
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
      version: 1,
      migrate: (persisted) => persisted as SettingsState,
    },
  ),
);
