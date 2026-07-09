/**
 * User settings, persisted across launches via expo-sqlite's key-value store.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { SoundPack } from '../camera/soundPacks';
import { DEVICE_TUNING, type DeviceTier } from '../core/deviceProfile';
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
/**
 * Detector input resolution — a big speed lever (cost ∝ pixels²).
 * - 'speed' (DEFAULT since v3): 416px — tested MORE accurate than 640 on the
 *   small-ball model (ball cold-gate 61.5% vs 38.6%) at ~half the cost, so
 *   it's now the default on every tier.
 * - 'quality': 640px — a bigger ball in pixels but, on the current model,
 *   lower real-footage recall AND slower; kept selectable, no longer default.
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

/**
 * Concrete knob values each preset applies. Deliberately kept 1:1 with the
 * DEVICE_TUNING tiers (src/core/deviceProfile.ts) so the "Your device" auto-tune
 * always lands the knobs ON a real preset (never a phantom 'Custom' on a fresh
 * install) and the two Detection selectors stay mutually consistent:
 *   accuracy = entry tier   (CPU — numerically exact, no Metal YOLOX degrade)
 *   balanced = mid tier      (GPU, standard cadence)
 *   smooth   = high tier      (GPU, every-frame cadence = smoothest tracking)
 * All three run at 416 ('speed') — it tested MORE accurate than 640 on the
 * small-ball model at ~half the cost, so 640 is no longer a preset choice.
 */
export const TRACKING_PRESETS: Record<Exclude<TrackingPreset, 'custom'>, TrackingKnobs> = {
  accuracy: { detectorEngine: 'yolox', detectorAccel: 'cpu', perfMode: 'speed', detectionRate: 'auto' },
  balanced: { detectorEngine: 'yolox', detectorAccel: 'gpu', perfMode: 'speed', detectionRate: 'auto' },
  smooth: { detectorEngine: 'yolox', detectorAccel: 'gpu', perfMode: 'speed', detectionRate: 'max' },
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
  /**
   * Rim height above the floor, meters. 3.05 (regulation, default) or 2.6
   * (youth hoops). Feeds the metric 2/3-point estimator's pinhole geometry
   * (src/core/courtGeometric.ts) — the rim is the vertical ruler, so a
   * youth-height hoop set to 3.05 would overstate every distance. Persisted.
   */
  rimHeightM: 3.05 | 2.6;
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
   * nano-v2 detector (experimental): an aggressive small-ball finetune. Higher
   * ball recall (finds a small/fast ball more often) but noisier — it fires
   * more low-confidence phantom boxes on lights/rafters/background hoops, so it
   * runs with a higher cold-acquisition gate (config ballScoreMinNanoV2) to
   * hold those back. OFF (default) uses the cleaner conservative nano. Only
   * affects the Nano rung (slow phones / Speed); the Tiny model is unchanged.
   */
  nanoV2: boolean;
  /**
   * Manual court range. 'auto' (default) uses the automatic 2/3-point estimate;
   * '2pt'/'3pt' pin every decided shot's value — the calibration-free way to
   * score a pure 3-point (or 2-point) session accurately when you're shooting
   * from one spot/range.
   */
  courtRange: 'auto' | '2pt' | '3pt';
  /**
   * Gap-crossing reappearance corroborator (experimental): when the ball
   * vanishes at the rim and reappears BELOW it on the same flight arc,
   * descending, in-span and depth-consistent, the occluded crossing may be
   * upgraded — only with net/cls agreement. Hardened against rim-bounce,
   * parallax and putback fakes; default off pending field validation.
   */
  reappearance: boolean;
  /**
   * Full-flight parabola tracking (src/core/flightArc.ts). A persistent arc
   * fitted over the whole shot gives the tracker a standing score-floor
   * relaxation along the predicted path, so a faint mid-arc ball keeps being
   * detected between the release and the rim — not only near the hoop. Default
   * ON (trivial compute, recall-only, cannot mint a make); this toggle is the
   * escape hatch if it ever misbehaves on a specific phone.
   */
  useFlightArc: boolean;
  /**
   * Frame-diff motion assist (experimental): when the detector loses the ball
   * mid-flight, the strongest local mover on a coarse luma grid is injected as
   * a continuation-only synthetic candidate. Default OFF — field testing
   * showed it can distract the tracker with non-ball movers.
   */
  motionAssist: boolean;
  /**
   * Manual device-tier override. 'auto' (default) lets the app classify this
   * phone (src/core/deviceProfile.ts) and, once, apply that tier's tuned
   * detector defaults. A user who knows better can pin 'entry'/'mid'/'high'
   * from Settings — e.g. force 'entry' on a phone that thermal-throttles.
   */
  deviceTierOverride: 'auto' | DeviceTier;
  /**
   * The tier we actually detected + tuned for (diagnostic display in
   * Settings). Null until the one-time device tuning has run.
   */
  detectedTier: DeviceTier | null;
  /**
   * Guard so device tuning applies its defaults exactly ONCE (first launch on
   * this device). After that the user owns the detector knobs — re-detecting
   * on every launch would stomp their manual choices.
   */
  deviceTuned: boolean;
  /** Last session orientation — powers the Home quick-start (skip setup). */
  lastOrient: 'portrait' | 'landscape';
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
  /**
   * Apply the tuned detector defaults for a device tier — but ONLY the first
   * time (deviceTuned guard), so a user's later manual knob changes are never
   * overwritten on relaunch. Records detectedTier for the Settings display and
   * flips deviceTuned. A no-op once tuned (still records the tier). Called by
   * {@link useDeviceTuning} after expo-device + the first benchmark resolve.
   */
  applyDeviceTuning: (tier: DeviceTier) => void;
  /**
   * Manual device-tier override from Settings. Unlike {@link applyDeviceTuning}
   * this is a deliberate user choice, so it applies the tier's detector knobs
   * immediately (no once-guard). 'auto' re-applies the detected tier's knobs
   * and hands the live rung decision back to the benchmark.
   */
  setDeviceTier: (override: 'auto' | DeviceTier) => void;
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
      rimHeightM: 3.05,
      playerHeightCm: null,
      onboardingDone: false,
      detectorModel: 'auto',
      detectionRate: 'auto',
      // 'speed' (416): measured BETTER detection than 640 with the small-ball
      // Tiny model on real footage, at ~half the compute — see v3 migration.
      perfMode: 'speed',
      detectorEngine: 'yolox',
      detectorAccel: 'cpu',
      lastBenchmark: null,
      debugMode: false,
      roiZoom: true,
      depthVeto: false,
      metric23: false,
      nanoV2: false,
      courtRange: 'auto',
      reappearance: false,
      useFlightArc: true,
      motionAssist: false,
      deviceTierOverride: 'auto',
      detectedTier: null,
      deviceTuned: false,
      lastOrient: 'portrait',
      formAnalysis: false,
      tutorialSeen: TUTORIAL_SEEN_DEFAULT,
      dailyGoalMakes: 0,
      set: (key, value) => set({ [key]: value } as Pick<SettingsState, typeof key>),
      // Picking a tracking preset is an explicit knob choice, so hand the tier
      // control back to 'auto' — otherwise the "Your device" row would keep
      // showing a manual tier whose knobs the preset just overrode.
      applyTrackingPreset: (preset) =>
        set({ ...TRACKING_PRESETS[preset], deviceTierOverride: 'auto' }),
      applyDeviceTuning: (tier) =>
        set((s) => {
          // Always record what we detected (cheap, drives the Settings label).
          if (s.deviceTuned) return { detectedTier: tier };
          const t = DEVICE_TUNING[tier];
          // First-launch tuning: seed the detector knobs + heavy-feature
          // defaults from the tier, then never again.
          return {
            detectedTier: tier,
            deviceTuned: true,
            perfMode: t.perfMode,
            detectorAccel: t.detectorAccel,
            detectionRate: t.detectionRate,
            roiZoom: t.roiZoomSafe,
            formAnalysis: t.poseSafe ? s.formAnalysis : false,
          };
        }),
      setDeviceTier: (override) =>
        set((s) => {
          const tier = override === 'auto' ? s.detectedTier : override;
          if (tier == null) return { deviceTierOverride: 'auto' };
          const t = DEVICE_TUNING[tier];
          return {
            deviceTierOverride: override,
            perfMode: t.perfMode,
            detectorAccel: t.detectorAccel,
            detectionRate: t.detectionRate,
            roiZoom: t.roiZoomSafe,
          };
        }),
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
      version: 5,
      migrate: (persisted, version) => {
        const s = persisted as SettingsState;
        // v2: YOLOX (Apache-2.0, GPU-correct) becomes the default detector. Move
        // existing installs off the old YOLO11 default onto it — the opt-in beta
        // shipped only hours earlier, so there are no meaningful explicit 'yolo'
        // choices worth preserving. Anyone can re-select YOLO11 in Settings.
        if (version < 2) s.detectorEngine = 'yolox';
        // v3: Speed (416) becomes the default performance mode. The small-ball
        // Tiny model landed measurably BETTER at 416 than 640 on real footage
        // (ball cold-gate 61.5% vs 38.6%) while costing ~half the compute —
        // "Quality" was inverted on both axes. One-time flip for existing
        // installs too (the old default was ours, not a meaningful choice);
        // anyone can re-pick Quality in Settings.
        if (version < 3) s.perfMode = 'speed';
        // v4: rimHeightM added (P11). Existing installs predate the youth-hoop
        // option, so default them to regulation 3.05 m — the height the metric
        // 2/3 estimator already assumed as a hardcoded constant, making this a
        // byte-identical no-op for every persisted user.
        if (version < 4 && s.rimHeightM == null) s.rimHeightM = 3.05;
        // v4 also: device-tuning (shipped at v3 WITHOUT a bump) auto-applies a
        // tier's detector defaults once, guarded by deviceTuned. But any install
        // predating that key is a user who ALREADY set their own detector knobs
        // under an older build — auto-tuning them would silently wipe those
        // choices on first launch of the upgrade. If the key is missing, they
        // own their knobs: mark them tuned so applyDeviceTuning leaves them be.
        if (s.deviceTuned == null) {
          s.deviceTuned = true;
          s.deviceTierOverride = 'auto';
          s.detectedTier = null;
        }
        // v5: full-flight tracking added, default ON (recall-only, cannot mint a
        // make). Turn it on for existing installs too — it's a strict detection
        // improvement, and the Settings toggle lets anyone opt out.
        if (version < 5 && s.useFlightArc == null) s.useFlightArc = true;
        return s;
      },
    },
  ),
);
