/**
 * Low-latency make/miss/streak sounds (expo-audio, preloaded players).
 * Subscribes to the session store's pendingSound and plays it once.
 */
import { useEffect } from 'react';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';

import type { SoundEvent } from '../core/types';
import { useSession } from '../state/sessionStore';
import { useSettings } from '../state/settingsStore';

/* eslint-disable @typescript-eslint/no-var-requires */
const SOURCES: Record<SoundEvent | 'session_start' | 'rim_locked', number> = {
  make: require('../../assets/sounds/make.wav'),
  miss: require('../../assets/sounds/miss.wav'),
  streak3: require('../../assets/sounds/streak3.wav'),
  streak5: require('../../assets/sounds/streak5.wav'),
  streak10: require('../../assets/sounds/streak10.wav'),
  session_start: require('../../assets/sounds/session_start.wav'),
  rim_locked: require('../../assets/sounds/rim_locked.wav'),
};
/* eslint-enable @typescript-eslint/no-var-requires */

let players: Partial<Record<keyof typeof SOURCES, AudioPlayer>> = {};
let audioModeSet = false;

async function ensureAudioMode(): Promise<void> {
  if (audioModeSet) return;
  audioModeSet = true;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      // Never fight VisionCamera's recording audio session.
      interruptionMode: 'mixWithOthers',
      allowsRecording: true,
    });
  } catch (err) {
    // Audio session configuration can fail on some devices (or mid-call);
    // allow a retry on the next play instead of crashing.
    audioModeSet = false;
    console.warn('[sounds] setAudioModeAsync failed', err);
  }
}

/**
 * Fire-and-forget playback; safe to call from anywhere on the JS thread.
 * Never throws — audio failures must not take down a live session.
 */
export function playSound(event: keyof typeof SOURCES): void {
  void ensureAudioMode()
    .then(() => {
      try {
        let p = players[event];
        if (!p) {
          p = createAudioPlayer(SOURCES[event]);
          players[event] = p;
        }
        p.seekTo(0);
        p.play();
      } catch (err) {
        console.warn(`[sounds] playback failed for "${event}"`, err);
      }
    })
    .catch((err) => {
      console.warn('[sounds] audio unavailable', err);
    });
}

/** Release all players (call when leaving the session flow). Never throws. */
export function releaseSounds(): void {
  for (const p of Object.values(players)) {
    try {
      p?.release();
    } catch (err) {
      console.warn('[sounds] release failed', err);
    }
  }
  players = {};
}

/** Hook: plays the session store's pending sound exactly once per shot. */
export function useShotSounds(): void {
  const pendingSound = useSession((s) => s.pendingSound);
  const consumeSound = useSession((s) => s.consumeSound);
  const soundsEnabled = useSettings((s) => s.soundsEnabled);

  useEffect(() => {
    if (!pendingSound) return;
    const sound = consumeSound();
    if (sound && soundsEnabled) playSound(sound);
  }, [pendingSound, consumeSound, soundsEnabled]);

  useEffect(() => releaseSounds, []);
}
