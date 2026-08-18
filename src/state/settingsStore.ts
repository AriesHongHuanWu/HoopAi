/**
 * User settings, persisted across launches via expo-sqlite's key-value store.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { SoundPack } from '../camera/soundPacks';
import { DEVICE_TUNING, type DeviceTier } from '../core/deviceProfile';
import type { ShootingHand } from '../core/types';
// Type-only: courtCalibrationStore imports useSettings at runtime, so this
// import MUST stay `import type` to keep the runtime dependency one-way.
import type { CourtCalSummary } from './courtCalibrationStore';

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
export type TutorialScreen = 'home' | 'live' | 'liveHud' | 'summary' | 'formstudio3d';

/** Has the walkthrough for each screen been seen (and dismissed) once? */
export type TutorialSeen = Record<TutorialScreen, boolean>;

const TUTORIAL_SEEN_DEFAULT: TutorialSeen = {
  home: false,
  live: false,
  liveHud: false,
  summary: false,
  formstudio3d: false,
};

/**
 * One-shot contextual hint chips (components/hud/HintChip.tsx). Keys are
 * persistence contracts — stable forever, never renamed.
 */
export type HintKey = 'unsureLive' | 'unsureSummary';

/** Has each one-shot contextual hint been dismissed/acted on once? */
export type HintSeen = Record<HintKey, boolean>;

const HINT_SEEN_DEFAULT: HintSeen = {
  unsureLive: false,
  unsureSummary: false,
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
   * Depth-ratio parallax veto ("錯視" / optical-illusion guard): uses the
   * ball's known size vs the rim's to catch a ball crossing the 2D rim line
   * while flying IN FRONT of (or behind) the hoop — the airball that "looks
   * like it went in" — and stop it being miscalled a make. Veto-only: it can
   * ONLY turn a would-be make into a miss, NEVER fabricate one, and it stays
   * silent outside its verified confidence envelope (bread-ball-safe by
   * construction). DEFAULT ON — the error direction is safe, the decision is
   * surfaced in the per-shot receipt, and this toggle lets you disable it if
   * it ever vetoes a real make on your setup. See depthRatioGate.ts.
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
   * Gap-crossing reappearance corroborator: when the ball vanishes at the rim
   * and reappears BELOW it on the same flight arc, descending, in-span and
   * depth-consistent, the occluded crossing may be upgraded to a make — but
   * ONLY with net-motion or ball_in_basket agreement, never on its own. This
   * recovers clean swishes that get swallowed by the net (the "I made it but
   * it said nothing" case) while staying bread-ball-safe: it can never flip a
   * seen miss into a make. Hardened against rim-bounce, parallax and putback
   * fakes. DEFAULT ON (corroboration-gated, so the error direction is safe).
   */
  reappearance: boolean;
  /**
   * Rattle-out make guard: stricter make confirmation. When the ball crosses
   * the rim line in-span and the net twitches — but the ball is then SEEN
   * bouncing/caroming back OUT instead of dropping cleanly through the hoop —
   * the shot is held as 'unsure' instead of being counted as a make. Recovers
   * accuracy on rim rattles and front-lip caroms that a net brush would
   * otherwise miscount. Bread-ball-safe: it can only downgrade a make to
   * unsure, never invent a miss, and it never touches a clean swish or a
   * swish the net swallows. DEFAULT ON (safe error direction); this toggle is
   * the escape hatch if it ever holds a real make on your setup. Takes effect
   * at the next rim lock.
   */
  rattleGuard: boolean;
  /**
   * Settle window before a make is scored. When ON, the tracker waits a few
   * frames (~0.13s) after the ball drops below the rim before deciding, so a
   * LATE rim bounce-out — the ball dips in then pops back up over the rim and
   * out — is caught and held as 'unsure' instead of being counted. Pairs with
   * the rattle-out guard. Bread-ball-safe: it can only downgrade a make to
   * unsure, never invent a miss, and a clean or net-swallowed swish (which
   * never climbs back above the rim) is untouched. DEFAULT ON; this toggle is
   * the escape hatch. Takes effect at the next rim lock.
   */
  settleWindow: boolean;
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
  /** Last-used Timed Challenge duration (seconds) — seeds setup's pre-flight chips. */
  lastDurationSec: number;
  /** Last-used Spot Shooting makes-per-spot target — seeds setup's pre-flight chips. */
  lastMakesPerSpot: number;
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
  /**
   * Receipt of the last successful court-landmark calibration. Written
   * imperatively by courtCalibrationStore.commit() on every successful
   * registration; read by CalibrationHealthCard. Registrations themselves are
   * per-camera-pose and never persisted — only this receipt survives.
   */
  lastCourtCalSummary: CourtCalSummary | null;
  /**
   * Receipt of the last successful FT-line calibration, written by live.tsx's
   * FtCalibrationChip success branch. Null until an FT calibration succeeds.
   */
  lastFtCalSummary: { ts: number } | null;
  /** One-shot flag: the calibration guide screen has been opened once. */
  calGuideSeen: boolean;
  /**
   * One-shot flag: the first-ball receipt tour (FirstBallRitual) has run.
   * Same pattern as tutorialSeen — consumed/written only by FirstBallRitual.
   */
  receiptTourSeen: boolean;
  /** One-shot contextual hint flags — consumed by HintChip; reset by resetTutorial. */
  hintSeen: HintSeen;
  /** One-shot: the /how-it-works explainer has been opened at least once. */
  detectionExplainerSeen: boolean;
  /**
   * 3D replay viewer master switch. Pure-Skia projection is visual-only but
   * costs GPU on entry phones — this is the escape hatch.
   *
   * Consumers: src/app/formstudio.tsx hides its VIEW IN 3D entry button when
   * false, and src/app/formstudio3d.tsx (also reachable by deep link) gates
   * itself — it shows a "turned off in Settings" empty state instead of
   * fetching/lifting/rendering the 3D theater. Toggled by the Settings › Video
   * row (src/app/settings.tsx).
   */
  replay3d: boolean;
  /**
   * Suppress NEW shot arming while several confident balls are in flight
   * (warmups). Suppression-only — can never create a call.
   */
  multiBallGuard: boolean;
  /**
   * Fast rim re-settle after camera bumps + hold new arming while the rim
   * lock is drift-stale.
   */
  rimGuard: boolean;
  /**
   * Persistence rescue: adopt a ball the detector keeps seeing in the
   * raised-gate band but the tracker never starts on. DETECTION-side recall
   * only — never touches arming or make/miss.
   */
  trackerRescue: boolean;
  /**
   * Inference-time-based thermal governor: sheds ROI/pose and caps frame
   * rate when the chip is hot.
   */
  adaptiveThermal: boolean;
  /**
   * Pre-session advisory chip when lens glare or haze is detected. Never
   * gates anything.
   */
  lensCheck: boolean;

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
  /** Mark one contextual hint as seen (called by HintChip on dismiss/action). */
  markHintSeen: (key: HintKey) => void;
  /**
   * Clear the coach marks, contextual hints and the first-ball receipt tour
   * so every walkthrough re-triggers. onboardingDone is left untouched.
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
      depthVeto: true,
      metric23: false,
      nanoV2: false,
      courtRange: 'auto',
      reappearance: true,
      rattleGuard: true,
      settleWindow: true,
      useFlightArc: true,
      motionAssist: false,
      deviceTierOverride: 'auto',
      detectedTier: null,
      deviceTuned: false,
      lastOrient: 'portrait',
      lastDurationSec: 60,
      lastMakesPerSpot: 5,
      formAnalysis: false,
      tutorialSeen: TUTORIAL_SEEN_DEFAULT,
      dailyGoalMakes: 0,
      lastCourtCalSummary: null,
      lastFtCalSummary: null,
      calGuideSeen: false,
      receiptTourSeen: false,
      hintSeen: { ...HINT_SEEN_DEFAULT },
      detectionExplainerSeen: false,
      replay3d: true,
      multiBallGuard: true,
      rimGuard: true,
      trackerRescue: true,
      adaptiveThermal: true,
      lensCheck: true,
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
            // Form analysis is no longer force-disabled on mid/entry phones.
            // The pose pass is now THROTTLED per tier (FORM.poseMinIntervalMs:
            // ~16Hz mid, ~10Hz entry) instead of running on every frame, which
            // is what made it unaffordable there. poseSafe therefore only
            // decides whether it is ON BY DEFAULT — a user who wants the
            // shooting-form comparison on a slower phone can now turn it on and
            // keep it on, instead of having device tuning silently revoke it.
            formAnalysis: s.formAnalysis || t.poseSafe,
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
      markHintSeen: (key) => set((s) => ({ hintSeen: { ...s.hintSeen, [key]: true } })),
      resetTutorial: () =>
        set({
          tutorialSeen: { ...TUTORIAL_SEEN_DEFAULT },
          hintSeen: { ...HINT_SEEN_DEFAULT },
          receiptTourSeen: false,
        }),
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
      version: 9,
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
        // v6 (mega-upgrade — bumped exactly ONCE for every sibling feature):
        // 3D replay viewer added, default ON (visual-only; the persisted
        // arc/skeleton data exists either way). The other keys landing at v6
        // (calibration receipts, one-shot tour flags, detection guards) are
        // plain additive keys whose creator defaults merge cleanly on
        // rehydrate, so replay3d is the only backfill this version needs.
        if (version < 6 && s.replay3d == null) s.replay3d = true;
        // v7 (round-2 mega-upgrade — bumped exactly ONCE for every sibling
        // feature landing together):
        // - tutorials/form3d: 'liveHud' + 'formstudio3d' walkthroughs added.
        //   tutorialSeen is a NESTED record — zustand's shallow rehydrate
        //   keeps the old persisted object wholesale, so the new keys must be
        //   backfilled explicitly (unlike top-level additive keys).
        //   Re-spreading the defaults UNDER the persisted flags preserves
        //   every seen=true while filling the new screens with false.
        // - tutorials: contextual-hint ledger + explainer one-shot, backfilled
        //   so rehydrated stores carry every key (shallow-merge would
        //   otherwise leave the nested hintSeen undefined forever).
        // - tracking-gap: trackerRescue defaults ON (detection-side recall
        //   only; provably inert unless a per-model cold gate raised the
        //   acquisition floor — it can never touch make/miss judging).
        // - setup-flow: the pre-flight screen remembers per-user defaults.
        //   Additive keys — backfill creator defaults so seeded chips never
        //   read undefined.
        if (version < 7) {
          s.tutorialSeen = { ...TUTORIAL_SEEN_DEFAULT, ...(s.tutorialSeen ?? {}) };
          s.hintSeen = { ...HINT_SEEN_DEFAULT };
          s.detectionExplainerSeen = false;
          if (s.trackerRescue == null) s.trackerRescue = true;
          if (s.lastDurationSec == null) s.lastDurationSec = 60;
          if (s.lastMakesPerSpot == null) s.lastMakesPerSpot = 5;
        }
        // v8: rattle-out make guard added, default ON (bread-ball-safe — it can
        // only downgrade a make to 'unsure', never fabricate a miss, and never
        // touches a clean/occluded swish). Turn it on for existing installs too;
        // the Settings toggle lets anyone opt out.
        if (version < 8 && s.rattleGuard == null) s.rattleGuard = true;
        // v9: settle window before scoring a make added, default ON (bread-ball-
        // safe — make -> 'unsure' only, never a fabricated miss; a clean or net-
        // swallowed swish never climbs back above the rim so it is untouched).
        // Enable it for existing installs too; the Settings toggle lets anyone
        // opt out.
        if (version < 9 && s.settleWindow == null) s.settleWindow = true;
        return s;
      },
    },
  ),
);
