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
  consumeSound: () => SoundEvent | null;
  setRecording: (recording: boolean, path?: string | null) => void;
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
      pendingSound: null,
      lastShot: null,
    });
  },

  setRimLocked: (locked) => set({ rimLocked: locked }),

  goLive: async ({ keepMode, nowMs }) => {
    const id = await createSession({ startedAt: nowMs, keepMode });
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
      void insertShot(sessionId, shot).then((rowId) => {
        set((s) => ({
          shots: s.shots.map((e) => (e.shot.id === shot.id ? { ...e, rowId } : e)),
        }));
        // If the shot was corrected before its row id arrived, persist now —
        // otherwise the DB keeps the pre-correction outcome forever.
        const current = get().shots.find((e) => e.shot.id === shot.id);
        if (current && current.shot.outcome !== shot.outcome) {
          void updateShotOutcome(rowId, current.shot.outcome);
        }
      });
    }
  },

  correctShot: (shotId, outcome) => {
    set((s) => {
      const shots = s.shots.map((e) =>
        e.shot.id === shotId
          ? { ...e, shot: { ...e.shot, outcome, corrected: true } }
          : e,
      );
      // Rebuild the module accumulator from the corrected list so any later
      // addShot stays consistent (acc otherwise keeps the old outcome).
      acc = shots.reduce((a, e) => pushShot(a, e.shot), createAccumulator());
      const target = shots.find((e) => e.shot.id === shotId);
      if (target?.rowId != null) void updateShotOutcome(target.rowId, outcome);
      return { shots, stats: acc.stats, lastShot: shots[shots.length - 1]?.shot ?? null };
    });
  },

  consumeSound: () => {
    const sound = get().pendingSound;
    if (sound) set({ pendingSound: null });
    return sound;
  },

  setRecording: (recording, path = null) =>
    set({ isRecording: recording, recordingPath: path ?? null }),

  finish: async ({ nowMs, videoPath }) => {
    const { sessionId } = get();
    if (sessionId != null) {
      await endSession(sessionId, { endedAt: nowMs, videoPath: videoPath ?? null });
    }
    set({ phase: 'ended', isRecording: false });
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
      pendingSound: null,
      lastShot: null,
    });
  },
}));
