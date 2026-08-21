/**
 * Contract tests for the cloud payload and the sync merge rule
 * (src/data/firebaseRecords.ts). Pure module, so no mocks and no device.
 *
 * TWO THINGS ARE PINNED HERE, and neither may be relaxed:
 *
 * 1. THE PRIVACY BOUNDARY. Only numbers and short labels may leave the phone.
 *    Frames, video, images, clip paths, trajectories, pose data and every JSON
 *    blob must be stripped from an uploaded document, and a payload that still
 *    carries one must be REFUSED rather than uploaded. This is the product's
 *    stated identity and it is written on the pitch deck.
 * 2. THE MERGE RULE. A device that was offline must not lose rows and must not
 *    duplicate them — including across a full round trip (record pulled from
 *    another phone, then pushed back up from this one).
 */
import type { SessionSummaryRow, ShotOutcomeRow, ShotRow } from '../db';
import {
  CLOUD_SESSION_FIELDS,
  CLOUD_SHOT_FIELDS,
  MAX_STRING_LEN,
  MEDIA_FIELD_PATTERN,
  assertUploadable,
  emptyLedger,
  findForbiddenField,
  keyForLocalRow,
  markImported,
  markPushed,
  parseCloudSession,
  parseCloudShot,
  parseLedger,
  parseRecordKey,
  planSync,
  recordKeyFor,
  toCloudSession,
  toCloudShot,
  toSessionRow,
  toShotRow,
  type CloudSession,
} from '../firebaseRecords';

const DEVICE = 'aa11bb22cc33';
const OTHER = 'ff99ee88dd77';

function session(over: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return {
    id: 1,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_600_000,
    label: 'Evening run',
    videoPath: '/var/mobile/Containers/Data/Application/x/session-1.mp4',
    keepMode: 'makes',
    recordingStartSec: 12.5,
    modeId: 'freeplay',
    modeResultJson: '{"score":9}',
    attempts: 10,
    makes: 6,
    fgPct: 0.6,
    ...over,
  };
}

function shot(over: Partial<ShotRow> = {}): ShotRow {
  return {
    id: 41,
    sessionId: 1,
    shotIndex: 0,
    tStart: 1.5,
    tResolved: 2.75,
    outcome: 'make',
    corrected: 0,
    outcomeCorrected: 0,
    rimBounce: 1,
    entryAngleDeg: 46.2,
    releaseAngleDeg: 52.1,
    xCross: 0.51,
    originX: 0.33,
    originY: 0.81,
    signalsJson: '{"peak":0.9}',
    trajectoryJson: '[[0,0.1,0.2],[1,0.3,0.4]]',
    clipPath: 'file:///var/mobile/clip-0.mp4',
    shotValue: 3,
    formJson: '{"knee":118}',
    rechecked: 1,
    valueSource: 'court',
    valueConfidence: 0.72,
    courtX: 4.2,
    courtY: 6.9,
    arcJson: '[[0,1],[1,2]]',
    ...over,
  };
}

function outcomes(...pairs: [ShotOutcomeRow['outcome'], number | null][]): ShotOutcomeRow[] {
  return pairs.map(([outcome, shotValue]) => ({ outcome, shotValue }));
}

// ---------------------------------------------------------------------------
// 1. The boundary
// ---------------------------------------------------------------------------

describe('nothing but numbers and metadata leaves the device', () => {
  const cloudSession = toCloudSession({
    row: session(),
    recordKey: recordKeyFor(DEVICE, 1),
    originDeviceId: DEVICE,
    shotCount: 1,
    updatedAt: 999,
  });

  it('uploads exactly the whitelisted session fields, no more', () => {
    expect(Object.keys(cloudSession).sort()).toEqual([...CLOUD_SESSION_FIELDS].sort());
  });

  it('strips the recording, the retention mode and the mode blob off a session', () => {
    const keys = Object.keys(cloudSession);
    expect(keys).not.toContain('videoPath');
    expect(keys).not.toContain('keepMode');
    expect(keys).not.toContain('recordingStartSec');
    expect(keys).not.toContain('modeResultJson');
    expect(findForbiddenField(cloudSession as unknown as Record<string, unknown>)).toBeNull();
  });

  const cloudShot = toCloudShot(shot());

  it('uploads exactly the whitelisted shot fields, no more', () => {
    expect(Object.keys(cloudShot).sort()).toEqual([...CLOUD_SHOT_FIELDS].sort());
  });

  it('strips the trajectory, the clip, the form report and the arc off a shot', () => {
    const keys = Object.keys(cloudShot);
    for (const banned of [
      'trajectoryJson',
      'signalsJson',
      'formJson',
      'arcJson',
      'clipPath',
      'xCross',
      'originX',
      'originY',
      'courtX',
      'courtY',
    ]) {
      expect(keys).not.toContain(banned);
    }
    expect(findForbiddenField(cloudShot as unknown as Record<string, unknown>)).toBeNull();
  });

  it('keeps the measurements that ARE records', () => {
    expect(cloudShot.entryAngleDeg).toBe(46.2);
    expect(cloudShot.outcome).toBe('make');
    expect(cloudShot.shotValue).toBe(3);
  });

  it('refuses a payload carrying a frame, a sequence or a blob field', () => {
    // The future edit this guards against: someone widens the whitelist.
    const cases: Record<string, unknown>[] = [
      { startedAt: 1, framesJson: '[]' },
      { startedAt: 1, poseSequence: 'x' },
      { startedAt: 1, clipPath: 'clip.mp4' },
      { startedAt: 1, videoPath: '/v.mp4' },
      { startedAt: 1, thumbnailUri: 'u' },
      { startedAt: 1, trajectory: 'x' },
      { startedAt: 1, imageBase64: 'x' },
      { startedAt: 1, keypoints: 'x' },
    ];
    for (const payload of cases) {
      const bad = findForbiddenField(payload);
      expect(bad).not.toBeNull();
      expect(() => assertUploadable(payload, 'test')).toThrow(/refused to upload/);
    }
  });

  it('refuses a non-scalar value even under an innocent field name', () => {
    // An array or a map is how a per-frame sequence would sneak through.
    expect(findForbiddenField({ makes: [1, 2, 3] })).toBe('makes');
    expect(findForbiddenField({ makes: { a: 1 } })).toBe('makes');
    expect(findForbiddenField({ attempts: Number.NaN })).toBe('attempts');
  });

  it('refuses a string long enough to be base64 pixels, or a file reference', () => {
    expect(findForbiddenField({ label: 'x'.repeat(MAX_STRING_LEN + 1) })).toBe('label');
    expect(findForbiddenField({ label: 'data:image/png;base64,AAAA' })).toBe('label');
    expect(findForbiddenField({ label: 'file:///v.mp4' })).toBe('label');
  });

  it('never whitelists a field whose own name reads like media', () => {
    // Keeps the whitelist and the name guard from contradicting each other:
    // if they ever did, every upload would be refused at run time and only
    // this test would say why.
    for (const field of [...CLOUD_SESSION_FIELDS, ...CLOUD_SHOT_FIELDS]) {
      expect([field, MEDIA_FIELD_PATTERN.test(field)]).toEqual([field, false]);
    }
  });

  it('clamps a very long session label instead of uploading it whole', () => {
    const long = toCloudSession({
      row: session({ label: 'L'.repeat(400) }),
      recordKey: recordKeyFor(DEVICE, 1),
      originDeviceId: DEVICE,
      shotCount: 0,
      updatedAt: 1,
    });
    expect(long.label.length).toBe(MAX_STRING_LEN);
    expect(findForbiddenField(long as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe('the boundary holds on the way IN too', () => {
  it('reads only whitelisted keys off a session document', () => {
    const parsed = parseCloudSession({
      recordKey: `${OTHER}-7`,
      startedAt: 100,
      attempts: 4,
      makes: 2,
      // A document that somehow carried media could not reach SQLite.
      clipPath: 'file:///nope.mp4',
      framesJson: '[[1,2]]',
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as object).sort()).toEqual([...CLOUD_SESSION_FIELDS].sort());
    expect(findForbiddenField(parsed as unknown as Record<string, unknown>)).toBeNull();
  });

  it('skips a malformed document rather than importing half a session', () => {
    expect(parseCloudSession({ startedAt: 1 })).toBeNull();
    expect(parseCloudSession({ recordKey: 'nodash', startedAt: 1 })).toBeNull();
    expect(parseCloudSession(null)).toBeNull();
    expect(parseCloudShot({ shotIndex: 0, outcome: 'banana' })).toBeNull();
    expect(parseCloudShot({ outcome: 'make' })).toBeNull();
  });

  it('takes the document id as the record key when the field is missing', () => {
    const parsed = parseCloudSession({ startedAt: 1 }, `${OTHER}-3`);
    expect(parsed?.recordKey).toBe(`${OTHER}-3`);
    expect(parsed?.localId).toBe(3);
  });
});

describe('a pulled record comes back empty where the cloud carried nothing', () => {
  const cloud = parseCloudSession({
    recordKey: `${OTHER}-7`,
    startedAt: 100,
    endedAt: 200,
    label: 'Their run',
    attempts: 3,
    makes: 2,
  }) as CloudSession;

  it('never invents a video, a recording clock or a mode snapshot', () => {
    const row = toSessionRow(cloud, 42);
    expect(row.id).toBe(42);
    expect(row.videoPath).toBeNull();
    expect(row.recordingStartSec).toBeNull();
    expect(row.modeResultJson).toBeNull();
    expect(row.keepMode).toBe('none');
    expect(row.label).toBe('Their run');
  });

  it('gives an imported shot an EMPTY trajectory rather than a fabricated one', () => {
    const row = toShotRow(
      {
        schema: 1,
        shotIndex: 2,
        tStart: 1,
        tResolved: 2,
        outcome: 'miss',
        corrected: 0,
        outcomeCorrected: 0,
        rimBounce: 0,
        entryAngleDeg: 44,
        releaseAngleDeg: null,
        shotValue: 2,
        valueConfidence: null,
      },
      42,
    );
    expect(row.trajectoryJson).toBe('[]');
    expect(row.signalsJson).toBe('{}');
    expect(row.clipPath).toBeNull();
    expect(row.arcJson).toBeNull();
    expect(row.formJson).toBeNull();
    expect(row.entryAngleDeg).toBe(44);
    expect(row.sessionId).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 2. The merge rule
// ---------------------------------------------------------------------------

describe('record keys are stable, parseable document ids', () => {
  it('round-trips through parseRecordKey', () => {
    expect(parseRecordKey(recordKeyFor(DEVICE, 17))).toEqual({ deviceId: DEVICE, localId: 17 });
  });

  it('never produces a key Firestore would reject', () => {
    expect(recordKeyFor('AA:11/22 33', 5)).toBe('aa112233-5');
    expect(recordKeyFor('', 5)).toBe('unknown-5');
  });
});

describe('planSync — push', () => {
  const local = [
    { row: session({ id: 1 }), outcomes: outcomes(['make', 2]) },
    { row: session({ id: 2, startedAt: 2, label: 'Two' }), outcomes: outcomes(['miss', null]) },
  ];

  it('pushes everything on a first sync, keyed by this device', () => {
    const plan = planSync({
      deviceId: DEVICE,
      local,
      remote: [],
      ledger: emptyLedger(),
      now: 1,
      nextLocalId: 3,
    });
    expect(plan.push.map((p) => p.recordKey)).toEqual([
      recordKeyFor(DEVICE, 1),
      recordKeyFor(DEVICE, 2),
    ]);
    expect(plan.push[0].localRowId).toBe(1);
    expect(plan.unchanged).toBe(0);
  });

  it('pushes nothing on a second sync with unchanged records', () => {
    const first = planSync({
      deviceId: DEVICE,
      local,
      remote: [],
      ledger: emptyLedger(),
      now: 1,
      nextLocalId: 3,
    });
    let ledger = emptyLedger();
    for (const item of first.push) ledger = markPushed(ledger, item.recordKey, item.hash);

    // A different `now` must NOT look like a change — the content hash
    // deliberately excludes updatedAt.
    const second = planSync({ deviceId: DEVICE, local, remote: [], ledger, now: 9999, nextLocalId: 3 });
    expect(second.push).toEqual([]);
    expect(second.unchanged).toBe(2);
  });

  it('re-pushes only the record that changed, under the SAME key', () => {
    let ledger = emptyLedger();
    for (const item of planSync({
      deviceId: DEVICE,
      local,
      remote: [],
      ledger,
      now: 1,
      nextLocalId: 3,
    }).push) {
      ledger = markPushed(ledger, item.recordKey, item.hash);
    }

    const renamed = [local[0], { ...local[1], row: session({ id: 2, startedAt: 2, label: 'Renamed' }) }];
    const plan = planSync({ deviceId: DEVICE, local: renamed, remote: [], ledger, now: 2, nextLocalId: 3 });
    expect(plan.push).toHaveLength(1);
    // Same document id as the first upload — an overwrite, never a second copy.
    expect(plan.push[0].recordKey).toBe(recordKeyFor(DEVICE, 2));
  });

  it('notices an edit the session totals cannot show, via the outcome stream', () => {
    let ledger = emptyLedger();
    const before = [{ row: session({ id: 1 }), outcomes: outcomes(['make', 2]) }];
    for (const item of planSync({
      deviceId: DEVICE,
      local: before,
      remote: [],
      ledger,
      now: 1,
      nextLocalId: 2,
    }).push) {
      ledger = markPushed(ledger, item.recordKey, item.hash);
    }
    // A 2 -> 3 value correction changes no attempt, no make and no FG%.
    const after = [{ row: session({ id: 1 }), outcomes: outcomes(['make', 3]) }];
    const plan = planSync({ deviceId: DEVICE, local: after, remote: [], ledger, now: 2, nextLocalId: 2 });
    expect(plan.push).toHaveLength(1);
  });

  it('pushes the whole backlog after a week offline, losing nothing', () => {
    // Only session 1 ever made it up; 2 and 3 were recorded in airplane mode.
    const first = planSync({
      deviceId: DEVICE,
      local: [local[0]],
      remote: [],
      ledger: emptyLedger(),
      now: 1,
      nextLocalId: 2,
    });
    const ledger = markPushed(emptyLedger(), first.push[0].recordKey, first.push[0].hash);

    const backlog = [
      ...local,
      { row: session({ id: 3, startedAt: 3, label: 'Three' }), outcomes: outcomes(['unsure', null]) },
    ];
    const plan = planSync({ deviceId: DEVICE, local: backlog, remote: [], ledger, now: 2, nextLocalId: 4 });
    expect(plan.push.map((p) => p.localRowId)).toEqual([2, 3]);
    expect(plan.unchanged).toBe(1);
  });
});

describe('planSync — pull', () => {
  const remote: CloudSession[] = [
    parseCloudSession({ recordKey: `${OTHER}-4`, startedAt: 500, attempts: 5, makes: 3 }) as CloudSession,
    parseCloudSession({ recordKey: `${OTHER}-9`, startedAt: 100, attempts: 2, makes: 1 }) as CloudSession,
  ];

  it('imports another device records under FRESH local ids, oldest first', () => {
    const plan = planSync({
      deviceId: DEVICE,
      local: [],
      remote,
      ledger: emptyLedger(),
      now: 1,
      nextLocalId: 12,
    });
    // Sorted by startedAt, so the ids handed out ascend with real time.
    expect(plan.pull.map((p) => [p.recordKey, p.localId])).toEqual([
      [`${OTHER}-9`, 12],
      [`${OTHER}-4`, 13],
    ]);
    // Never the remote localId — that belongs to the other phone's sequence.
    expect(plan.pull.map((p) => p.session.localId)).toEqual([9, 4]);
  });

  it('does not import the same record twice', () => {
    let ledger = emptyLedger();
    const first = planSync({
      deviceId: DEVICE,
      local: [],
      remote,
      ledger,
      now: 1,
      nextLocalId: 12,
    });
    for (const item of first.pull) ledger = markImported(ledger, item.recordKey, item.localId);

    const second = planSync({ deviceId: DEVICE, local: [], remote, ledger, now: 2, nextLocalId: 14 });
    expect(second.pull).toEqual([]);
    expect(second.alreadyLocal).toBe(2);
  });

  it('does not resurrect a record this device recorded and then deleted', () => {
    const mine = parseCloudSession({
      recordKey: recordKeyFor(DEVICE, 8),
      startedAt: 50,
      attempts: 1,
      makes: 0,
    }) as CloudSession;
    const plan = planSync({
      deviceId: DEVICE,
      local: [],
      remote: [mine],
      ledger: emptyLedger(),
      now: 1,
      nextLocalId: 20,
    });
    expect(plan.pull).toEqual([]);
    expect(plan.alreadyLocal).toBe(1);
  });

  it('a full round trip does not duplicate the record in the cloud', () => {
    // 1. pull one record from the other phone...
    let ledger = emptyLedger();
    const pulled = planSync({
      deviceId: DEVICE,
      local: [],
      remote: [remote[0]],
      ledger,
      now: 1,
      nextLocalId: 30,
    }).pull[0];
    ledger = markImported(ledger, pulled.recordKey, pulled.localId);

    // 2. ...it is now a local row with local id 30. Sync again.
    const localAfterImport = [
      { row: session({ id: 30, startedAt: 500, label: '' }), outcomes: outcomes(['make', 2]) },
    ];
    const plan = planSync({
      deviceId: DEVICE,
      local: localAfterImport,
      remote: [remote[0]],
      ledger,
      now: 2,
      nextLocalId: 31,
    });

    // It is pushed back under the ORIGINATING key, not a new one under this
    // device — one document, updated, rather than a second copy per sync.
    expect(plan.push).toHaveLength(1);
    expect(plan.push[0].recordKey).toBe(`${OTHER}-4`);
    expect(plan.push[0].localRowId).toBe(30);
    expect(plan.push[0].session.originDeviceId).toBe(OTHER);
    expect(plan.pull).toEqual([]);
    // And the key resolution is what did it.
    expect(keyForLocalRow(DEVICE, 30, ledger)).toBe(`${OTHER}-4`);
  });
});

describe('the ledger survives a corrupt or missing blob', () => {
  it('starts empty rather than throwing', () => {
    expect(parseLedger(null)).toEqual(emptyLedger());
    expect(parseLedger('{ not json')).toEqual(emptyLedger());
    expect(parseLedger('{"pushed":{"a":1},"imported":{"b":"x"}}')).toEqual(emptyLedger());
  });

  it('round-trips what it understands', () => {
    const ledger = markImported(markPushed(emptyLedger(), 'k', 'h'), 'j', 4);
    expect(parseLedger(JSON.stringify(ledger))).toEqual(ledger);
  });
});
