/**
 * backup — export/import format + merge tests (P19). Pure module, no db or
 * filesystem; every case (round-trip, corruption, duplicates) is exercised
 * directly against the plain functions.
 */
import { describe, expect, it } from '@jest/globals';

import type { JumpRow, SessionRow, ShotRow } from '../../data/db';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  checksumOf,
  mergeBackup,
  parseBackup,
  serializeBackup,
  type BackupData,
  type ExistingIds,
} from '../../data/backup';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function session(id: number, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    startedAt: 1_700_000_000_000 + id * 1000,
    endedAt: 1_700_000_100_000 + id * 1000,
    label: `Session ${id}`,
    videoPath: id % 2 === 0 ? `/videos/s${id}.mp4` : null,
    keepMode: 'makes',
    recordingStartSec: 3,
    modeId: null,
    modeResultJson: null,
    ...overrides,
  };
}

function shot(sessionId: number, shotIndex: number, overrides: Partial<ShotRow> = {}): ShotRow {
  return {
    id: sessionId * 100 + shotIndex,
    sessionId,
    shotIndex,
    tStart: 1.0,
    tResolved: 2.0,
    outcome: 'make',
    corrected: 0,
    rimBounce: 0,
    entryAngleDeg: 45,
    releaseAngleDeg: 52,
    xCross: 0.5,
    originX: 0.4,
    originY: 0.9,
    signalsJson: '{}',
    trajectoryJson: '[]',
    clipPath: null,
    shotValue: 2,
    ...overrides,
  };
}

function jump(id: number): JumpRow {
  return { id, ts: 1_700_000_000_000 + id, heightCm: 50 + id, method: 'hang-time', confidence: 0.8 };
}

function data(overrides: Partial<BackupData> = {}): BackupData {
  return {
    sessions: [session(1), session(2)],
    shots: [shot(1, 0), shot(1, 1), shot(2, 0)],
    jumps: [jump(1), jump(2)],
    achievementsSeen: { hasVisited: true, seenBadgeIds: ['first_make', 'streak_5'] },
    challenges: { dateKey: '2026-07-07', completedIds: ['c1', 'c2'], totalPoints: 120 },
    ...overrides,
  };
}

const NO_EXISTING: ExistingIds = { sessionIds: [], jumpIds: [] };
const EMPTY_ACH: BackupData['achievementsSeen'] = { hasVisited: false, seenBadgeIds: [] };
const EMPTY_CH: BackupData['challenges'] = { dateKey: '', completedIds: [], totalPoints: 0 };

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

describe('checksumOf', () => {
  it('is deterministic and value-based (key order independent)', () => {
    const a = data();
    const b = data();
    expect(checksumOf(a)).toBe(checksumOf(b));
    // Reorder object keys — checksum must not change (canonical sort).
    const reordered = JSON.parse(
      JSON.stringify({ challenges: a.challenges, jumps: a.jumps, shots: a.shots, sessions: a.sessions, achievementsSeen: a.achievementsSeen }),
    ) as BackupData;
    expect(checksumOf(reordered)).toBe(checksumOf(a));
  });

  it('changes when any value changes', () => {
    const base = checksumOf(data());
    expect(checksumOf(data({ challenges: { dateKey: '2026-07-07', completedIds: ['c1'], totalPoints: 121 } }))).not.toBe(base);
    expect(checksumOf(data({ jumps: [jump(1)] }))).not.toBe(base);
  });

  it('is a fixed 8-char hex string', () => {
    expect(checksumOf(data())).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// Build + serialize + parse round-trip
// ---------------------------------------------------------------------------

describe('round-trip', () => {
  it('build → serialize → parse recovers the exact data', () => {
    const bundle = buildBackup(data(), 1_700_000_500_000);
    expect(bundle.format).toBe(BACKUP_FORMAT);
    expect(bundle.version).toBe(BACKUP_VERSION);
    expect(bundle.exportedAt).toBe(1_700_000_500_000);

    const str = serializeBackup(bundle);
    const result = parseBackup(str);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.data).toEqual(data());
    expect(result.bundle.checksum).toBe(bundle.checksum);
  });

  it('serializes to human-readable (indented) JSON', () => {
    const str = serializeBackup(buildBackup(data()));
    expect(str).toContain('\n');
    expect(str).toContain(`"format": "${BACKUP_FORMAT}"`);
  });

  it('an empty dataset round-trips', () => {
    const empty = data({ sessions: [], shots: [], jumps: [] });
    const result = parseBackup(serializeBackup(buildBackup(empty)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle.data).toEqual(empty);
  });
});

// ---------------------------------------------------------------------------
// Corruption / rejection
// ---------------------------------------------------------------------------

describe('parseBackup rejects bad input', () => {
  it('non-JSON → not-json', () => {
    expect(parseBackup('not json at all {')).toEqual({ ok: false, error: 'not-json' });
    expect(parseBackup('')).toEqual({ ok: false, error: 'not-json' });
  });

  it('JSON but not an object → wrong-format', () => {
    expect(parseBackup('42')).toEqual({ ok: false, error: 'wrong-format' });
    expect(parseBackup('"hi"')).toEqual({ ok: false, error: 'wrong-format' });
    expect(parseBackup('null')).toEqual({ ok: false, error: 'wrong-format' });
  });

  it('wrong format marker → wrong-format', () => {
    const str = JSON.stringify({ format: 'something-else', version: 1, data: data(), checksum: 'x' });
    expect(parseBackup(str)).toEqual({ ok: false, error: 'wrong-format' });
  });

  it('unknown version → unsupported-version', () => {
    const bundle = buildBackup(data());
    const str = serializeBackup({ ...bundle, version: 999 });
    expect(parseBackup(str)).toEqual({ ok: false, error: 'unsupported-version' });
  });

  it('malformed data (missing arrays / wrong types) → malformed', () => {
    const withData = (d: unknown) =>
      JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, data: d, checksum: 'x' });
    expect(parseBackup(withData({ sessions: [] })).ok).toBe(false);
    expect(parseBackup(withData({ sessions: 'no', shots: [], jumps: [] })).ok).toBe(false);
    const badAch = { sessions: [], shots: [], jumps: [], achievementsSeen: { hasVisited: 'yes', seenBadgeIds: [] }, challenges: EMPTY_CH };
    expect(parseBackup(withData(badAch))).toEqual({ ok: false, error: 'malformed' });
    const badCh = { sessions: [], shots: [], jumps: [], achievementsSeen: EMPTY_ACH, challenges: { dateKey: 1, completedIds: [], totalPoints: 0 } };
    expect(parseBackup(withData(badCh))).toEqual({ ok: false, error: 'malformed' });
  });

  it('tampered data (checksum mismatch) → checksum-mismatch', () => {
    const bundle = buildBackup(data());
    const tampered = { ...bundle, data: { ...bundle.data, challenges: { ...bundle.data.challenges, totalPoints: 999999 } } };
    // checksum still the OLD one → mismatch
    expect(parseBackup(serializeBackup(tampered))).toEqual({ ok: false, error: 'checksum-mismatch' });
  });

  it('a hand-truncated backup string is caught', () => {
    const str = serializeBackup(buildBackup(data()));
    const truncated = str.slice(0, str.length - 30);
    const result = parseBackup(truncated);
    expect(result.ok).toBe(false); // not-json (broke mid-token)
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe('mergeBackup', () => {
  it('imports everything into an empty local dataset', () => {
    const plan = mergeBackup(data(), NO_EXISTING, EMPTY_ACH, EMPTY_CH);
    expect(plan.imported).toBe(2);
    expect(plan.skipped).toBe(0);
    expect(plan.sessions.map((s) => s.id)).toEqual([1, 2]);
    expect(plan.shots).toHaveLength(3);
    expect(plan.jumps.map((j) => j.id)).toEqual([1, 2]);
  });

  it('skips sessions whose id already exists locally (never overwrites)', () => {
    const incoming = data({
      sessions: [session(1, { label: 'IMPORTED OVERWRITE ATTEMPT' }), session(3)],
      shots: [shot(1, 0), shot(3, 0)],
    });
    const plan = mergeBackup(incoming, { sessionIds: [1], jumpIds: [] }, EMPTY_ACH, EMPTY_CH);
    expect(plan.imported).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.sessions.map((s) => s.id)).toEqual([3]);
    // Session 1's shots must NOT come along (its session was skipped).
    expect(plan.shots.every((s) => s.sessionId === 3)).toBe(true);
  });

  it('produces the "Imported N, skipped M" numbers', () => {
    const incoming = data({ sessions: [session(1), session(2), session(3)], shots: [] });
    const plan = mergeBackup(incoming, { sessionIds: [1, 2], jumpIds: [] }, EMPTY_ACH, EMPTY_CH);
    expect(`Imported ${plan.imported}, skipped ${plan.skipped}`).toBe('Imported 1, skipped 2');
  });

  it('collapses duplicate session ids within the incoming set', () => {
    const incoming = data({ sessions: [session(5), session(5, { label: 'dup' })], shots: [] });
    const plan = mergeBackup(incoming, NO_EXISTING, EMPTY_ACH, EMPTY_CH);
    expect(plan.imported).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.sessions).toHaveLength(1);
  });

  it('drops orphan shots whose session is not being inserted', () => {
    const incoming = data({ sessions: [session(9)], shots: [shot(9, 0), shot(99, 0)] });
    const plan = mergeBackup(incoming, NO_EXISTING, EMPTY_ACH, EMPTY_CH);
    expect(plan.shots.map((s) => s.sessionId)).toEqual([9]);
  });

  it('keeps shots whose PRIMARY KEY ids collide locally — only the parent session id decides', () => {
    // Shot ids are deliberately NOT deduped here: nothing references
    // shots.id, and importBackup (src/data/db.ts) omits the id column on
    // insert so AUTOINCREMENT assigns fresh PKs. Dropping a shot because its
    // id happened to collide would silently lose data from another install.
    const incoming = data({ sessions: [session(3)], shots: [shot(3, 0, { id: 100 })] });
    // sessionIds: [1] — session 3 is new, but shot id 100 exists locally.
    const plan = mergeBackup(incoming, { sessionIds: [1], jumpIds: [] }, EMPTY_ACH, EMPTY_CH);
    expect(plan.shots).toHaveLength(1);
    expect(plan.shots[0]!.id).toBe(100); // carried verbatim; db assigns the real PK
  });

  it('dedupes jumps by id against existing and within the set', () => {
    const incoming = data({ jumps: [jump(1), jump(2), jump(2), jump(3)] });
    const plan = mergeBackup(incoming, { sessionIds: [], jumpIds: [1] }, EMPTY_ACH, EMPTY_CH);
    expect(plan.jumps.map((j) => j.id)).toEqual([2, 3]);
  });

  it('unions seen badges and ORs hasVisited', () => {
    const incoming = data({ achievementsSeen: { hasVisited: false, seenBadgeIds: ['streak_5', 'night_owl'] } });
    const local = { hasVisited: true, seenBadgeIds: ['first_make'] };
    const plan = mergeBackup(incoming, NO_EXISTING, local, EMPTY_CH);
    expect(plan.achievementsSeen.hasVisited).toBe(true);
    expect(plan.achievementsSeen.seenBadgeIds.sort()).toEqual(['first_make', 'night_owl', 'streak_5']);
  });

  it('takes the larger points total (ledger only grows)', () => {
    const incoming = data({ challenges: { dateKey: '2026-07-07', completedIds: [], totalPoints: 500 } });
    const local = { dateKey: '2026-07-07', completedIds: [], totalPoints: 120 };
    const plan = mergeBackup(incoming, NO_EXISTING, EMPTY_ACH, local);
    expect(plan.challenges.totalPoints).toBe(500);
  });

  it('unions today completions only when the day matches', () => {
    const incoming = data({ challenges: { dateKey: '2026-07-07', completedIds: ['c3'], totalPoints: 0 } });
    const sameDay = { dateKey: '2026-07-07', completedIds: ['c1'], totalPoints: 0 };
    const same = mergeBackup(incoming, NO_EXISTING, EMPTY_ACH, sameDay);
    expect(same.challenges.completedIds.sort()).toEqual(['c1', 'c3']);

    const otherDay = { dateKey: '2026-07-08', completedIds: ['c1'], totalPoints: 0 };
    const diff = mergeBackup(incoming, NO_EXISTING, EMPTY_ACH, otherDay);
    // Local day wins; stale imported completions from another day are dropped.
    expect(diff.challenges.dateKey).toBe('2026-07-08');
    expect(diff.challenges.completedIds).toEqual(['c1']);
  });

  it('re-importing your own backup is a no-op (all skipped)', () => {
    const mine = data();
    const plan = mergeBackup(
      mine,
      { sessionIds: mine.sessions.map((s) => s.id), jumpIds: mine.jumps.map((j) => j.id) },
      mine.achievementsSeen,
      mine.challenges,
    );
    expect(plan.imported).toBe(0);
    expect(plan.skipped).toBe(2);
    expect(plan.sessions).toHaveLength(0);
    expect(plan.shots).toHaveLength(0);
    expect(plan.jumps).toHaveLength(0);
  });
});
