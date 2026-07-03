/**
 * Low-latency make/miss/streak sounds (expo-audio, preloaded players).
 * Subscribes to the session store's pendingSound and plays it once, using
 * whichever sound pack is currently selected in Settings (see
 * src/camera/soundPacks.ts) — playback resolves sources via
 * {@link getSoundSource} rather than a single hardcoded set, so switching
 * packs (classic/arcade/stadium) actually changes what plays in a live
 * session, not just the settings-screen preview.
 */
import { useEffect } from 'react';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';

import { useSession } from '../state/sessionStore';
import { useSettings } from '../state/settingsStore';
import { getSoundSource, type PackSoundEvent, type SoundPack } from './soundPacks';

/** Player cache keyed by `${pack}:${event}` so switching packs mid-session never reuses the wrong clip. */
let players: Map<string, AudioPlayer> = new Map();
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
 *
 * @param pack Sound pack to resolve `event` against; defaults to 'classic'
 *   for callers that haven't been updated to pass the active pack (keeps
 *   this a non-breaking addition to the call signature).
 */
export function playSound(event: PackSoundEvent, pack: SoundPack = 'classic'): void {
  void ensureAudioMode()
    .then(() => {
      try {
        const key = `${pack}:${event}`;
        let p = players.get(key);
        if (!p) {
          p = createAudioPlayer(getSoundSource(pack, event));
          players.set(key, p);
        }
        p.seekTo(0);
        p.play();
      } catch (err) {
        console.warn(`[sounds] playback failed for "${event}" (pack "${pack}")`, err);
      }
    })
    .catch((err) => {
      console.warn('[sounds] audio unavailable', err);
    });
}

/** Release all players (call when leaving the session flow). Never throws. */
export function releaseSounds(): void {
  for (const p of players.values()) {
    try {
      p.release();
    } catch (err) {
      console.warn('[sounds] release failed', err);
    }
  }
  players = new Map();
}

/** Hook: plays the session store's pending sound exactly once per shot. */
export function useShotSounds(): void {
  const pendingSound = useSession((s) => s.pendingSound);
  const consumeSound = useSession((s) => s.consumeSound);
  const soundsEnabled = useSettings((s) => s.soundsEnabled);
  const soundPack = useSettings((s) => s.soundPack);

  useEffect(() => {
    if (!pendingSound) return;
    const sound = consumeSound();
    if (sound && soundsEnabled) playSound(sound, soundPack);
  }, [pendingSound, consumeSound, soundsEnabled, soundPack]);

  useEffect(() => releaseSounds, []);
}
