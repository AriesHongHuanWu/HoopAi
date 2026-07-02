/// <reference types="jest" />
// ^ Workaround: the project tsconfig does not wire jest globals in
//   (TS 6 + expo/tsconfig.base picks up no test-runner types), so every
//   test file references them explicitly to typecheck clean.
import { SOUND_FILES } from '../soundMap';
import { STREAKS } from '../config';
import type { SoundEvent } from '../types';

/** Exhaustive list of SoundEvent values (type-checked against the union). */
const SOUND_EVENTS: readonly SoundEvent[] = [
  'make',
  'miss',
  'streak3',
  'streak5',
  'streak10',
];

describe('soundMap', () => {
  test('every SoundEvent maps to a .wav basename', () => {
    for (const ev of SOUND_EVENTS) {
      expect(SOUND_FILES[ev]).toMatch(/^[a-z0-9_]+\.wav$/);
    }
  });

  test('app-lifecycle cues exist', () => {
    expect(SOUND_FILES.session_start).toBe('session_start.wav');
    expect(SOUND_FILES.rim_locked).toBe('rim_locked.wav');
  });

  test('every celebrated streak length has a stinger', () => {
    for (const n of STREAKS.celebrateAt) {
      const key = `streak${n}` as SoundEvent;
      expect(SOUND_FILES[key]).toBe(`streak${n}.wav`);
    }
  });

  test('basenames are unique', () => {
    const names = Object.values(SOUND_FILES);
    expect(new Set(names).size).toBe(names.length);
  });
});
