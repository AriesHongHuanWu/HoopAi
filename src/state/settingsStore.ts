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

/** Clip window bounds (seconds), used by the Settings > Video steppers. */
export const CLIP_PRE_ROLL_MIN = 2;
export const CLIP_PRE_ROLL_MAX = 10;
export const CLIP_POST_ROLL_MIN = 1;
export const CLIP_POST_ROLL_MAX = 5;

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
  /** Show the on-screen detection diagnostics panel. Default off. */
  debugMode: boolean;

  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
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
      debugMode: false,
      set: (key, value) => set({ [key]: value } as Pick<SettingsState, typeof key>),
    }),
    {
      name: 'hoopai-settings',
      storage: createJSONStorage(() => Storage),
      partialize: ({ set: _set, ...rest }) => rest,
    },
  ),
);
