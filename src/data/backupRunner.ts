/**
 * backupRunner — the impure glue that connects the PURE backup format module
 * (src/data/backup.ts) to the database + persisted zustand stores and the
 * native share sheet. Kept out of backup.ts on purpose so that module stays
 * unit-testable without a device; this file does the I/O.
 *
 * Export: gather the whole local dataset → build a checksummed bundle → hand
 * the JSON to the same never-throw write+share pipeline History's CSV export
 * uses (src/core/csvExport.ts exportCsv). Import: parse+validate a pasted/
 * loaded string, plan an additive merge against what's already local, write
 * the new rows and fold the two key/value snapshots into their stores.
 *
 * Every function is never-throw: a failure returns a typed result the UI can
 * show, never an exception.
 */
import { exportCsv } from '../core/csvExport';
import { useAchievementsSeen } from '../state/achievementsSeenStore';
import { useChallenges } from '../state/challengeStore';
import {
  allJumps,
  allSessions,
  allShots,
  importBackup,
  listSessions,
} from './db';
import {
  buildBackup,
  mergeBackup,
  parseBackup,
  serializeBackup,
  type BackupData,
  type BackupParseError,
} from './backup';

/** Gather the full device-local dataset into a backup payload. */
async function gather(): Promise<BackupData> {
  const [sessions, shots, jumps] = await Promise.all([allSessions(), allShots(), allJumps()]);
  const ach = useAchievementsSeen.getState();
  const ch = useChallenges.getState();
  return {
    sessions,
    shots,
    jumps,
    achievementsSeen: { hasVisited: ach.hasVisited, seenBadgeIds: [...ach.seenBadgeIds] },
    challenges: {
      dateKey: ch.dateKey,
      completedIds: [...ch.completedIds],
      totalPoints: ch.totalPoints,
    },
  };
}

/**
 * Export everything to a shared JSON file. Resolves false only when even the
 * text-share fallback failed (see exportCsv). Never throws.
 */
export async function runBackupExport(): Promise<boolean> {
  const bundle = buildBackup(await gather());
  return exportCsv(serializeBackup(bundle), 'hoopilot-backup.json');
}

export type ImportOutcome =
  | { ok: true; imported: number; skipped: number }
  | { ok: false; error: BackupParseError | 'write-failed' };

/**
 * Import a backup string: validate → merge (additive; skips duplicate session
 * ids, never overwrites) → write. On success also folds the achievements-seen
 * and challenge-ledger snapshots into their persisted stores. Returns the
 * per-session imported/skipped counts for the summary line. Never throws.
 */
export async function runBackupImport(raw: string): Promise<ImportOutcome> {
  const parsed = parseBackup(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Dedupe against what's already local. listSessions caps at its default
  // page; ask for a high limit so a large library still dedupes fully.
  const [existingSessions, existingJumps] = await Promise.all([listSessions(100000), allJumps()]);
  const ach = useAchievementsSeen.getState();
  const ch = useChallenges.getState();

  const plan = mergeBackup(
    parsed.bundle.data,
    {
      sessionIds: existingSessions.map((s) => s.id),
      jumpIds: existingJumps.map((j) => j.id),
    },
    { hasVisited: ach.hasVisited, seenBadgeIds: [...ach.seenBadgeIds] },
    { dateKey: ch.dateKey, completedIds: [...ch.completedIds], totalPoints: ch.totalPoints },
  );

  const written = await importBackup({
    sessions: plan.sessions,
    shots: plan.shots,
    jumps: plan.jumps,
  });
  // importBackup returns zeros on a db failure (never throws) — surface it so
  // the user isn't told "Imported N" when nothing landed.
  if (plan.sessions.length > 0 && written.sessions === 0) {
    return { ok: false, error: 'write-failed' };
  }

  // Fold the mergeable key/value snapshots into their persisted stores.
  useAchievementsSeen.setState({
    hasVisited: plan.achievementsSeen.hasVisited,
    seenBadgeIds: plan.achievementsSeen.seenBadgeIds,
  });
  useChallenges.setState({
    dateKey: plan.challenges.dateKey,
    completedIds: plan.challenges.completedIds,
    totalPoints: plan.challenges.totalPoints,
  });

  return { ok: true, imported: plan.imported, skipped: plan.skipped };
}
