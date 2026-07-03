/**
 * Voice announcements (HomeCourt-style) — speaks one metric after each
 * resolved shot via expo-speech, driven by Settings > Voice announcements
 * (voiceMetric: 'none' | 'result' | 'entryAngle' | 'fgPct').
 *
 * Deliberately INDEPENDENT of soundsEnabled — voice has its own setting.
 * The utterance is delayed slightly so the make/miss sound (played the
 * instant the shot resolves) lands first instead of colliding with speech.
 *
 * TTS is best-effort: every call is guarded so a speech failure can never
 * take down a live session.
 */
import { useEffect, useRef } from 'react';
import * as Speech from 'expo-speech';

import type { ResolvedShot, SessionStats } from '../core/types';
import { useSession } from '../state/sessionStore';
import { useSettings, type VoiceMetric } from '../state/settingsStore';

/** Let the make/miss sound fire first — speak this many ms after the shot. */
const SPEAK_DELAY_MS = 400;

/** English voice by default; normal rate/pitch reads scores most clearly. */
const SPEECH_OPTIONS: Speech.SpeechOptions = {
  language: 'en-US',
  rate: 1.0,
  pitch: 1.0,
};

/**
 * The spoken text for a resolved shot under the given metric, or null when
 * there is nothing to say (metric off, or entry angle unavailable).
 *
 * - 'result': "Make!" / "Miss" / "Unsure — tap to fix".
 * - 'entryAngle': "44 degrees" (rounded); makes say "Make, 44 degrees".
 *   Silent when the shot has no entry angle.
 * - 'fgPct': running "7 for 10" (makes for attempts) after every shot.
 */
export function announcementFor(
  metric: VoiceMetric,
  shot: ResolvedShot,
  stats: SessionStats,
): string | null {
  switch (metric) {
    case 'result':
      return shot.outcome === 'make'
        ? 'Make!'
        : shot.outcome === 'miss'
          ? 'Miss'
          : 'Unsure — tap to fix';
    case 'entryAngle': {
      if (shot.entryAngleDeg === null) return null;
      const deg = Math.round(shot.entryAngleDeg);
      const angle = `${deg} ${deg === 1 ? 'degree' : 'degrees'}`;
      return shot.outcome === 'make' ? `Make, ${angle}` : angle;
    }
    case 'fgPct':
      return `${stats.makes} for ${stats.attempts}`;
    case 'none':
    default:
      return null;
  }
}

/**
 * Hook: announces each NEW resolved shot exactly once. Corrections replace
 * the store's lastShot with the same shot id, so they never re-announce.
 * A new announcement always replaces any pending or in-flight one
 * (Speech.stop() before speak) — the voice never builds a backlog behind a
 * fast shooter.
 */
export function useVoiceAnnouncements(): void {
  const lastShot = useSession((s) => s.lastShot);
  const voiceMetric = useSettings((s) => s.voiceMetric);

  const announcedShotId = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lastShot === null) {
      // Session reset — shot ids restart at 1 next session, so forget them.
      announcedShotId.current = null;
      return;
    }
    if (voiceMetric === 'none') return;
    // Same shot re-published (outcome/value correction): stay quiet.
    if (announcedShotId.current === lastShot.id) return;
    announcedShotId.current = lastShot.id;

    // Stats are set atomically with lastShot in addShot, so a snapshot here
    // already includes this shot.
    const text = announcementFor(voiceMetric, lastShot, useSession.getState().stats);
    if (text === null) return;

    // Replace, never queue: drop any announcement still waiting to start…
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      try {
        // …and cut off any utterance still playing before the new one.
        void Speech.stop().catch(() => {});
        Speech.speak(text, SPEECH_OPTIONS);
      } catch (err) {
        // TTS engine unavailable (device settings, mid-call) — skip quietly.
        console.warn('[voice] announcement failed', err);
      }
    }, SPEAK_DELAY_MS);
  }, [lastShot, voiceMetric]);

  // Unmount: cancel anything pending and silence any in-flight utterance.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      try {
        void Speech.stop().catch(() => {});
      } catch {
        // Speech teardown must never crash the app on the way out.
      }
    },
    [],
  );
}
