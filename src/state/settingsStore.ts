/**
 * User settings, persisted across launches via expo-sqlite's key-value store.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ShootingHand } from '../core/types';

/** Which clips survive when a recorded session ends. */
export type KeepMode = 'makes' | 'decided' | 'all' | 'none';

/** Metric read aloud after each shot (HomeCourt-style voice announcements). */
export type VoiceMetric = 'none' | 'result' | 'entryAngle' | 'fgPct';

export interface SettingsState {
  soundsEnabled: boolean;
  hapticsEnabled: boolean;
  /** Record video during sessions at all. */
  recordVideo: boolean;
  keepMode: KeepMode;
  voiceMetric: VoiceMetric;
  shootingHand: ShootingHand;
  /** For jump/release-height calibration. Null until profile setup. */
  playerHeightCm: number | null;
  onboardingDone: boolean;

  set: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      soundsEnabled: true,
      hapticsEnabled: true,
      recordVideo: true,
      keepMode: 'makes',
      voiceMetric: 'none',
      shootingHand: 'right',
      playerHeightCm: null,
      onboardingDone: false,
      set: (key, value) => set({ [key]: value } as Pick<SettingsState, typeof key>),
    }),
    {
      name: 'hoopai-settings',
      storage: createJSONStorage(() => Storage),
      partialize: ({ set: _set, ...rest }) => rest,
    },
  ),
);
