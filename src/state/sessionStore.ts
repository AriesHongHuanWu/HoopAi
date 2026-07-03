/**
 * Live-session state (Zustand). The frame worklet publishes resolved shots to
 * JS via scheduleOnRN → `addShot`; screens subscribe to stats/shots slices.
 */
import { create } from 'zustand';

import {
  createSession,
  endSession,
  insertShot,
  updateShotOutcome,
} from '../data/db';
import {
  createAccumulator,
  pushShot,
  streakSoundFor,
  type StatsAccumulator,
} from '../core/stats';
import type {
  ResolvedShot,
  SessionStats,
  ShotOutcome,
  ShotValue,
  SoundEvent,
} from '../core/types';

export type SessionPhase = 'idle' | 'setup' | 'live' | 'ended';

interface ShotEntry {
  shot: ResolvedShot;
  /** DB row id (assigned async after insert). */
  rowId: number | null;
}

export interface SessionState {
  phase: SessionPhase;
  sessionId: number | null;
  startedAtMs: number | null;
  shots: ShotEntry[];
  stats: SessionStats;
  rimLocked: boolean;
  isRecording: boolean;
  recordingPath: string | null;
  /**
   * Engine-clock second when the recording started; aligns shot timestamps
   * with the video (videoTime = shot.tResolved − recordingStartSec).
   */
  recordingStartSec: number | null;
  /** Sound the UI should play for the latest shot (consumed once). */
  pendingSound: SoundEvent | null;
  /** The most recent shot, for the result flash card. */
  lastShot: ResolvedShot | null;

  beginSetup: () => void;
  setRimLocked: (locked: boolean) => void;
  /** Creates the DB session row and flips to live. */
  goLive: (opts: { keepMode: string; nowMs: number }) => Promise<void>;
  addShot: (shot: ResolvedShot) => void;
  /** One-tap make↔miss correction by shot id (in-session index). */
  correctShot: (shotId: number, outcome: ShotOutcome) => void;
  /**
   * One-tap 2↔3 correction by shot id. Updates the in-memory shot value and
   * rebuilds stats (points + 2/3 splits fold shotValue automatically). Live
   * only — persisted sessions don't carry a value column yet.
   */
  correctShotValue: (shotId: number, value: ShotValue) => void;
  consumeSound: () => SoundEvent | null;
  setRecording: (recording: boolean, path?: string | null, startSec?: number | null) => void;
  finish: (opts: { nowMs: number; videoPath?: string | null }) => Promise<void>;
  resetToIdle: () => void;
}

const emptyAcc = (): StatsAccumulator => createAccumulator();

let acc: StatsAccumulator = emptyAcc();

export const useSession = create<SessionState>((set, get) => ({
  phase: 'idle',
  sessionId: null,
  startedAtMs: null,
  shots: [],
  stats: emptyAcc().stats,
  rimLocked: false,
  isRecording: false,
  recordingPath: null,
  recordingStartSec: null,
  pendingSound: null,
  lastShot: null,

  beginSetup: () => {
    acc = emptyAcc();
    set({
      phase: 'setup',
      sessionId: null,
      startedAtMs: null,
      shots: [],
      stats: acc.stats,
      rimLocked: false,
      isRecording: false,
      recordingPath: null,
      recordingStartSec: null,
      pendingSound: null,
      lastShot: null,
    });
  },

  setRimLocked: (locked) => set({ rimLocked: locked }),

  goLive: async ({ keepMode, nowMs }) => {
    // Persistence is best-effort: if the DB is unavailable the session still
    // goes live in memory (sessionId null ⇒ shots are simply not persisted).
    let id: number | null = null;
    try {
      const rowId = await createSession({ startedAt: nowMs, keepMode });
      id = rowId >= 0 ? rowId : null;
    } catch (err) {
      console.warn('[session] createSession failed; continuing without persistence', err);
    }
    set({ phase: 'live', sessionId: id, startedAtMs: nowMs });
  },

  addShot: (shot) => {
    acc = pushShot(acc, shot);
    const sound = streakSoundFor(acc.stats.currentStreak, shot.outcome);
    const entry: ShotEntry = { shot, rowId: null };
    set((s) => ({
      shots: [...s.shots, entry],
      stats: acc.stats,
      pendingSound: sound,
      lastShot: shot,
    }));
    const sessionId = get().sessionId;
    if (sessionId != null) {
      void insertShot(sessionId, shot)
        .then((rowId) => {
          // insertShot returns -1 when persistence failed — keep rowId null so
          // later corrections don't try to update a nonexistent row.
          if (rowId < 0) return;
          set((s) => ({
            shots: s.shots.map((e) => (e.shot.id === shot.id ? { ...e, rowId } : e)),
          }));
          // If the shot was corrected before its row id arrived, persist now —
          // otherwise the DB keeps the pre-correction outcome forever.
          const current = get().shots.find((e) => e.shot.id === shot.id);
          if (current && current.shot.outcome !== shot.outcome) {
            updateShotOutcome(rowId, current.shot.outcome).catch((err) => {
              console.warn('[session] late outcome sync failed', err);
            });
          }
        })
        .catch((err) => {
          // Defensive: db functions shouldn't reject, but an unhandled
          // rejection here would crash the app mid-session.
          console.warn('[session] insertShot failed', err);
        });
    }
  },

  correctShot: (shotId, outcome) => {
    set((s) => {
      // Unknown shot id (stale UI, double correction race): leave state alone.
      if (!s.shots.some((e) => e.shot.id === shotId)) return s;
      const shots = s.shots.map((e) =>
        e.shot.id === shotId
          ? { ...e, shot: { ...e.shot, outcome, corrected: true } }
          : e,
      );
      // Rebuild the module accumulator from the corrected list so any later
      // addShot stays consistent (acc otherwise keeps the old outcome).
      acc = shots.reduce((a, e) => pushShot(a, e.shot), createAccumulator());
      const target = shots.find((e) => e.shot.id === shotId);
      if (target?.rowId != null && target.rowId >= 0) {
        updateShotOutcome(target.rowId, outcome).catch((err) => {
          console.warn('[session] updateShotOutcome failed', err);
        });
      }
      return { shots, stats: acc.stats, lastShot: shots[shots.length - 1]?.shot ?? null };
    });
  },

  correctShotValue: (shotId, value) => {
    set((s) => {
      // Unknown shot id: no-op rather than rebuilding stats for nothing.
      if (!s.shots.some((e) => e.shot.id === shotId)) return s;
      const shots = s.shots.map((e) =>
        e.shot.id === shotId
          ? { ...e, shot: { ...e.shot, shotValue: value, corrected: true } }
          : e,
      );
      acc = shots.reduce((a, e) => pushShot(a, e.shot), createAccumulator());
      return {
        shots,
        stats: acc.stats,
        lastShot: shots[shots.length - 1]?.shot ?? null,
      };
    });
  },

  consumeSound: () => {
    const sound = get().pendingSound;
    if (sound) set({ pendingSound: null });
    return sound;
  },

  setRecording: (recording, path = null, startSec) =>
    set((s) => ({
      isRecording: recording,
      recordingPath: path ?? s.recordingPath,
      recordingStartSec: startSec !== undefined ? startSec : s.recordingStartSec,
    })),

  finish: async ({ nowMs, videoPath }) => {
    const { sessionId, phase, recordingStartSec } = get();
    // Idempotent: a double-tap on End (or a background/foreground race) must
    // not end the session twice or overwrite endedAt with a later timestamp.
    if (phase === 'ended') return;
    // Flip the phase FIRST so the UI moves on even if persistence fails.
    set({ phase: 'ended', isRecording: false, recordingPath: videoPath ?? get().recordingPath });
    if (sessionId != null) {
      try {
        await endSession(sessionId, {
          endedAt: nowMs,
          videoPath: videoPath ?? null,
          recordingStartSec,
        });
      } catch (err) {
        console.warn('[session] endSession failed', err);
      }
    }
  },

  resetToIdle: () => {
    acc = emptyAcc();
    set({
      phase: 'idle',
      sessionId: null,
      startedAtMs: null,
      shots: [],
      stats: acc.stats,
      rimLocked: false,
      isRecording: false,
      recordingPath: null,
      recordingStartSec: null,
      pendingSound: null,
      lastShot: null,
    });
  },
}));
