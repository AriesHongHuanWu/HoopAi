/**
 * Sound packs — three complete feedback voices, each covering every sound
 * event the app fires. All files are synthesized deterministically by
 * scripts/generate-sounds.mjs into assets/sounds/<pack>/.
 *
 * - 'classic' — the original swish-chime voice (plucked sines).
 * - 'arcade'  — chippy 8-bit square-wave blips (coin make, arpeggio streaks).
 * - 'stadium' — deeper broadcast voice (air-horn triads, crowd, low thuds).
 *
 * The active pack lives in settings (useSettings().soundPack). Playback code
 * (src/camera/useShotSounds.ts) should resolve sources via
 * {@link getSoundSource} instead of hard-coded requires.
 */
import type { SoundEvent } from '../core/types';

export type SoundPack = 'classic' | 'arcade' | 'stadium';

/** Every playable cue: shot events plus the two session chrome sounds. */
export type PackSoundEvent = SoundEvent | 'session_start' | 'rim_locked';

export const SOUND_PACKS: readonly SoundPack[] = ['classic', 'arcade', 'stadium'];

/** Display copy for the settings chip row. */
export const SOUND_PACK_LABELS: Record<SoundPack, string> = {
  classic: 'Classic',
  arcade: 'Arcade',
  stadium: 'Stadium',
};

/* eslint-disable @typescript-eslint/no-var-requires */
export const SOUND_PACK_FILES: Record<SoundPack, Record<PackSoundEvent, number>> = {
  classic: {
    make: require('../../assets/sounds/classic/make.wav'),
    miss: require('../../assets/sounds/classic/miss.wav'),
    streak3: require('../../assets/sounds/classic/streak3.wav'),
    streak5: require('../../assets/sounds/classic/streak5.wav'),
    streak10: require('../../assets/sounds/classic/streak10.wav'),
    session_start: require('../../assets/sounds/classic/session_start.wav'),
    rim_locked: require('../../assets/sounds/classic/rim_locked.wav'),
  },
  arcade: {
    make: require('../../assets/sounds/arcade/make.wav'),
    miss: require('../../assets/sounds/arcade/miss.wav'),
    streak3: require('../../assets/sounds/arcade/streak3.wav'),
    streak5: require('../../assets/sounds/arcade/streak5.wav'),
    streak10: require('../../assets/sounds/arcade/streak10.wav'),
    session_start: require('../../assets/sounds/arcade/session_start.wav'),
    rim_locked: require('../../assets/sounds/arcade/rim_locked.wav'),
  },
  stadium: {
    make: require('../../assets/sounds/stadium/make.wav'),
    miss: require('../../assets/sounds/stadium/miss.wav'),
    streak3: require('../../assets/sounds/stadium/streak3.wav'),
    streak5: require('../../assets/sounds/stadium/streak5.wav'),
    streak10: require('../../assets/sounds/stadium/streak10.wav'),
    session_start: require('../../assets/sounds/stadium/session_start.wav'),
    rim_locked: require('../../assets/sounds/stadium/rim_locked.wav'),
  },
};
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * Resolve the asset module id for `event` in `pack`. Unknown events fall back
 * to the classic pack's 'make' so playback code never throws on a bad key.
 */
export function getSoundSource(pack: SoundPack, event: string): number {
  const files = SOUND_PACK_FILES[pack] ?? SOUND_PACK_FILES.classic;
  return (
    files[event as PackSoundEvent] ?? SOUND_PACK_FILES.classic.make
  );
}
