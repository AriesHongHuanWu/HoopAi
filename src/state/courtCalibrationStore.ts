/**
 * courtCalibrationStore — holds the ACTIVE court registration + any in-progress
 * calibration session for the current camera setup.
 *
 * Deliberately NOT persisted: a homography is only valid for the exact camera
 * pose it was tapped against, and the phone moves between sessions. Persisting
 * one would silently apply a wrong court to the next setup. So it lives in
 * memory, is (re)built via the "tap the court" ritual, and is fed to the
 * pipeline by useShotEngine. All reducer logic delegates to the pure,
 * unit-tested engine in src/core/courtCalibration.ts.
 */
import { create } from 'zustand';

import {
  buildRegistration,
  startCalibration,
  withTap,
  withoutTap,
  type CalibrationResult,
  type CalibrationSession,
} from '@/core/courtCalibration';
import { FIBA_COURT, type CourtSpec, type LandmarkId } from '@/core/courtModel';
import type { CourtRegistration } from '@/core/courtRegistration';
import { useSettings } from './settingsStore';

/**
 * Persisted receipt of the last successful court-tap (when + how tight),
 * written into settingsStore under 'lastCourtCalSummary' so the calibration
 * health card can show it. Only the SUMMARY persists — never the homography.
 */
export interface CourtCalSummary {
  /** Wall-clock ms of the successful commit. */
  ts: number;
  /** Mean reprojection error of that solve, meters. */
  reprojErrM: number;
}

interface CourtCalibrationState {
  /** The active registration fed to the pipeline, or null (uncalibrated). */
  registration: CourtRegistration | null;
  /** Mean reprojection error of the ACTIVE registration, meters; null when uncalibrated. */
  reprojectionErrorM: number | null;
  /** The in-progress tap session, or null when not calibrating. */
  session: CalibrationSession | null;
  /** Start a fresh calibration for a rulebook (default FIBA). */
  begin: (spec?: CourtSpec) => void;
  /** Place (or replace) a landmark tap, in ANALYSIS-frame px. */
  placeTap: (id: LandmarkId, image: { x: number; y: number }) => void;
  /** Remove a landmark's tap (redo). */
  removeTap: (id: LandmarkId) => void;
  /** Build from the current session; on success stores the registration. */
  commit: () => CalibrationResult;
  /** Abandon the in-progress session (keep any existing registration). */
  cancel: () => void;
  /** Drop the registration (and any session) — back to uncalibrated. */
  clear: () => void;
}

export const useCourtCalibration = create<CourtCalibrationState>((set, get) => ({
  registration: null,
  reprojectionErrorM: null,
  session: null,
  begin: (spec = FIBA_COURT) => set({ session: startCalibration(spec) }),
  placeTap: (id, image) => {
    const s = get().session;
    if (s) set({ session: withTap(s, id, image) });
  },
  removeTap: (id) => {
    const s = get().session;
    if (s) set({ session: withoutTap(s, id) });
  },
  commit: () => {
    const s = get().session;
    if (!s) return { ok: false, reason: 'incomplete' };
    const result = buildRegistration(s);
    if (result.ok) {
      set({
        registration: result.registration,
        session: null,
        reprojectionErrorM: result.reprojectionErrorM,
      });
      // Persist a lightweight receipt for the calibration health card (same
      // imperative pattern as the engine's lastBenchmark write). One-way
      // runtime dependency: settingsStore only type-imports this store.
      const summary: CourtCalSummary = { ts: Date.now(), reprojErrM: result.reprojectionErrorM };
      useSettings.getState().set('lastCourtCalSummary', summary);
    }
    return result;
  },
  // Old registration (and its error) survives a cancelled re-calibration.
  cancel: () => set({ session: null }),
  clear: () => set({ registration: null, session: null, reprojectionErrorM: null }),
}));
