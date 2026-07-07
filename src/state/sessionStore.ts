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
  updateShotValue,
} from '../data/db';
import { getModeDef } from '../core/gameModes';
import {
  createAccumulator,
  pushShot,
  streakSoundFor,
  type StatsAccumulator,
} from '../core/stats';
import type {
  GameModeId,
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
  /**
   * The outcome value already flushed to the DB for this row (or null before
   * insertShot resolves). Used so a correction made while the row id was
   * still in flight is guaranteed to be persisted exactly once, against the
   * LATEST outcome, rather than only when it happens to differ from the
   * outcome captured at addShot-call time.
   */
  syncedOutcome: ShotOutcome | null;
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
  goLive: (opts: { keepMode: string; nowMs: number; modeId?: GameModeId | null }) => Promise<void>;
  addShot: (shot: ResolvedShot) => void;
  /**
   * One-tap/swipe make↔miss correction by shot id (in-session index).
   * `corrected` (default true) stamps the user-edited flag; the undo path
   * passes the shot's pre-correction flag back to restore it exactly.
   */
  correctShot: (shotId: number, outcome: ShotOutcome, corrected?: boolean) => void;
  /**
   * One-tap 2↔3 correction by shot id. Updates the in-memory shot value and
   * rebuilds stats (points + 2/3 splits fold shotValue automatically). Live
   * only — persisted sessions don't carry a value column yet.
   */
  correctShotValue: (shotId: number, value: ShotValue) => void;
  consumeSound: () => SoundEvent | null;
  setRecording: (recording: boolean, path?: string | null, startSec?: number | null) => void;
  /**
   * `modeResultJson`, when supplied, is a JSON snapshot of the final
   * ModeState (src/core/gameModes.ts ModeState) so History can reconstruct
   * the mode's final breakdown later. Omit entirely for Free Play / no mode
   * — passing undefined leaves the persisted column untouched rather than
   * clearing it.
   */
  finish: (opts: {
    nowMs: number;
    videoPath?: string | null;
    modeResultJson?: string | null;
  }) => Promise<void>;
  resetToIdle: () => void;
}

const emptyAcc = (): StatsAccumulator => createAccumulator();

let acc: StatsAccumulator = emptyAcc();

/**
 * Bumped every time the session identity changes (beginSetup / goLive /
 * resetToIdle). addShot captures the generation live at call time and its
 * async insertShot callback checks it before mutating the store, so a shot
 * from a stale (already-reset or superseded) session can never leak into the
 * next one — closing the cross-session race the module-level `acc` singleton
 * would otherwise be exposed to.
 */
let sessionGeneration = 0;

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
    sessionGeneration += 1;
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

  goLive: async ({ keepMode, nowMs, modeId }) => {
    // Persistence is best-effort: if the DB is unavailable the session still
    // goes live in memory (sessionId null ⇒ shots are simply not persisted).
    let id: number | null = null;
    // Auto-label the session with the mode's display name (e.g. "H-O-R-S-E")
    // so History can identify a mode game vs Free Play without a join;
    // getModeDef is a static lookup over GAME_MODES, never throws for a valid
    // GameModeId. Free Play / no mode keeps the historical '' default.
    const label = modeId != null && modeId !== 'free' ? getModeDef(modeId).name : undefined;
    try {
      const rowId = await createSession({
        startedAt: nowMs,
        keepMode,
        modeId: modeId ?? null,
        label,
      });
      id = rowId >= 0 ? rowId : null;
    } catch (err) {
      console.warn('[session] createSession failed; continuing without persistence', err);
    }
    sessionGeneration += 1;
    set({ phase: 'live', sessionId: id, startedAtMs: nowMs });
  },

  addShot: (shot) => {
    acc = pushShot(acc, shot);
    const sound = streakSoundFor(acc.stats.currentStreak, shot.outcome);
    const entry: ShotEntry = { shot, rowId: null, syncedOutcome: null };
    set((s) => ({
      shots: [...s.shots, entry],
      stats: acc.stats,
      pendingSound: sound,
      lastShot: shot,
    }));
    const sessionId = get().sessionId;
    // Capture the session identity NOW: if beginSetup/resetToIdle/goLive run
    // again before insertShot resolves, this closure must not touch the new
    // session's state (the module-level `acc` and the store's `shots` array
    // would otherwise leak a shot from the old session into the new one).
    const generation = sessionGeneration;
    if (sessionId != null) {
      void insertShot(sessionId, shot)
        .then((rowId) => {
          if (sessionGeneration !== generation) return;
          // insertShot returns -1 when persistence failed — keep rowId null so
          // later corrections don't try to update a nonexistent row.
          if (rowId < 0) return;
          set((s) => ({
            shots: s.shots.map((e) => (e.shot.id === shot.id ? { ...e, rowId } : e)),
          }));
          // Always flush the CURRENT outcome once the row id is known — not
          // just when it differs from the outcome captured at addShot time —
          // so a second correction that lands while rowId was still null is
          // guaranteed to be persisted exactly once, with the latest value,
          // rather than racing a diff against a stale snapshot.
          const current = get().shots.find((e) => e.shot.id === shot.id);
          if (current) {
            // Preserve the shot's actual corrected flag: an outcome that was
            // never hand-edited must not be stamped as a user correction.
            updateShotOutcome(rowId, current.shot.outcome, current.shot.corrected === true)
              .then(() => {
                if (sessionGeneration !== generation) return;
                set((s) => ({
                  shots: s.shots.map((e) =>
                    e.shot.id === shot.id ? { ...e, syncedOutcome: current.shot.outcome } : e,
                  ),
                }));
              })
              .catch((err) => {
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

  correctShot: (shotId, outcome, corrected = true) => {
    const generation = sessionGeneration;
    set((s) => {
      // Unknown shot id (stale UI, double correction race): leave state alone.
      if (!s.shots.some((e) => e.shot.id === shotId)) return s;
      const shots = s.shots.map((e) =>
        e.shot.id === shotId
          ? { ...e, shot: { ...e.shot, outcome, corrected } }
          : e,
      );
      // Rebuild the module accumulator from the corrected list so any later
      // addShot stays consistent (acc otherwise keeps the old outcome).
      acc = shots.reduce((a, e) => pushShot(a, e.shot), createAccumulator());
      const target = shots.find((e) => e.shot.id === shotId);
      if (target?.rowId != null && target.rowId >= 0) {
        const rowId = target.rowId;
        updateShotOutcome(rowId, outcome, corrected)
          .then(() => {
            if (sessionGeneration !== generation) return;
            set((s2) => ({
              shots: s2.shots.map((e) =>
                e.shot.id === shotId ? { ...e, syncedOutcome: outcome } : e,
              ),
            }));
          })
          .catch((err) => {
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
      // Persist so lifetime records (career threes) reflect corrections.
      const target = shots.find((e) => e.shot.id === shotId);
      if (target?.rowId != null && target.rowId >= 0) {
        updateShotValue(target.rowId, value).catch((err) => {
          console.warn('[session] updateShotValue failed', err);
        });
      }
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

  finish: async ({ nowMs, videoPath, modeResultJson }) => {
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
          // Only include the key when the caller actually has a mode result —
          // omitting it (rather than passing null) leaves any previously
          // persisted result untouched (see endSession's COALESCE).
          ...(modeResultJson !== undefined ? { modeResultJson } : {}),
        });
      } catch (err) {
        console.warn('[session] endSession failed', err);
      }
    }
  },

  resetToIdle: () => {
    acc = emptyAcc();
    sessionGeneration += 1;
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
