/**
 * Persist-migration guard for useSettings (kv-store name 'hoopai-settings').
 *
 * Pins the persist version and replays migrate() from every historical
 * version. If you bump the version: add a migrate branch in settingsStore,
 * add an assertion block here IN THE SAME COMMIT, and update the version
 * pin. Deleting this pin re-opens the v3 device-tuning incident (a persisted
 * key change shipped WITHOUT a version bump, silently auto-retuning installs
 * that already owned their knobs).
 *
 * expo-sqlite/kv-store is mocked to an in-memory map (persistence itself is
 * zustand middleware, not under test); migrate() is exercised directly via
 * the persist API, so no store state is mutated.
 */
jest.mock('expo-sqlite/kv-store', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, value);
      },
      removeItem: (key: string) => {
        mem.delete(key);
      },
    },
  };
});

import { useSettings } from '../settingsStore';

const persistApi: any = (useSettings as any).persist;
const opts: any = persistApi.getOptions();

describe('useSettings persist options', () => {
  test('persist version + storage key pin', () => {
    expect(opts.name).toBe('hoopai-settings');
    // v7: round-2 mega-upgrade — bumped exactly once for all sibling features
    // (tutorialSeen re-spread for liveHud/formstudio3d, hintSeen ledger,
    // detectionExplainerSeen, trackerRescue, setup pre-flight defaults).
    expect(opts.version).toBe(7);
  });

  test('migrate from v1 backfills engine/perf defaults (full chain to v7)', () => {
    const out: any = opts.migrate({}, 1);
    expect(out.detectorEngine).toBe('yolox'); // v2: YOLOX becomes default
    expect(out.perfMode).toBe('speed'); // v3: 416 becomes default
    expect(out.rimHeightM).toBe(3.05); // v4: regulation height backfill
    expect(out.deviceTuned).toBe(true); // v4: pre-existing installs own knobs
    expect(out.useFlightArc).toBe(true); // v5: flight arc on
    expect(out.replay3d).toBe(true); // v6: 3D replay on
    expect(out.trackerRescue).toBe(true); // v7: track rescue on
    expect(out.hintSeen).toEqual({ unsureLive: false, unsureSummary: false }); // v7
    expect(out.detectionExplainerSeen).toBe(false); // v7
    expect(out.lastDurationSec).toBe(60); // v7: setup pre-flight defaults
    expect(out.lastMakesPerSpot).toBe(5); // v7
    expect(out.tutorialSeen).toEqual({
      home: false,
      live: false,
      liveHud: false,
      summary: false,
      formstudio3d: false,
    }); // v7: nested record fully backfilled
  });

  test('migrate from v3 backfills rim height and freezes manual tuning', () => {
    const out: any = opts.migrate({ detectorEngine: 'yolox', perfMode: 'speed' }, 3);
    expect(out.rimHeightM).toBe(3.05);
    // The v3 incident guard: an install predating the deviceTuned key already
    // set its own detector knobs, so it is marked tuned — applyDeviceTuning
    // must never auto-retune over manual choices.
    expect(out.deviceTuned).toBe(true);
    expect(out.deviceTierOverride).toBe('auto');
    expect(out.detectedTier).toBeNull();
    // Manually chosen knobs survive: v<3 branches must not fire AT v3.
    const manual: any = opts.migrate({ detectorEngine: 'yolo', perfMode: 'quality' }, 3);
    expect(manual.detectorEngine).toBe('yolo');
    expect(manual.perfMode).toBe('quality');
  });

  test('migrate from v4 turns flight arc on', () => {
    const out: any = opts.migrate({}, 4);
    expect(out.useFlightArc).toBe(true);
    // ...but never stomps an explicit opt-out persisted under v5+ shapes.
    const optedOut: any = opts.migrate({ useFlightArc: false }, 4);
    expect(optedOut.useFlightArc).toBe(false);
  });

  test('migrate from v5 turns 3D replay on', () => {
    const out: any = opts.migrate({}, 5);
    expect(out.replay3d).toBe(true);
    // ...but never stomps an explicit opt-out persisted under v6+ shapes.
    const optedOut: any = opts.migrate({ replay3d: false }, 5);
    expect(optedOut.replay3d).toBe(false);
  });

  test('migrate from v6 backfills every v7 key', () => {
    // trackerRescue: a v6 blob predates the key entirely — default ON.
    const out: any = opts.migrate({}, 6);
    expect(out.trackerRescue).toBe(true);
    expect(out.hintSeen).toEqual({ unsureLive: false, unsureSummary: false });
    expect(out.detectionExplainerSeen).toBe(false);
    expect(out.lastDurationSec).toBe(60);
    expect(out.lastMakesPerSpot).toBe(5);
  });

  test('migrate from v6 re-spreads tutorialSeen UNDER the persisted flags', () => {
    // tutorialSeen is a NESTED record: zustand's shallow rehydrate keeps the
    // old persisted object wholesale, so migrate must backfill the new screen
    // keys while preserving every seen=true the user already earned.
    const out: any = opts.migrate(
      { tutorialSeen: { home: true, live: true, summary: false } },
      6,
    );
    expect(out.tutorialSeen).toEqual({
      home: true,
      live: true,
      liveHud: false,
      summary: false,
      formstudio3d: false,
    });
    // A blob missing the record entirely (defensive) gets the full default.
    const bare: any = opts.migrate({}, 6);
    expect(bare.tutorialSeen).toEqual({
      home: false,
      live: false,
      liveHud: false,
      summary: false,
      formstudio3d: false,
    });
  });

  test('migrate at v7 preserves an explicit trackerRescue opt-out', () => {
    // A v7 blob with trackerRescue:false must pass through untouched — the
    // v<7 branch does not fire at the current version.
    const out: any = opts.migrate({ trackerRescue: false }, 7);
    expect(out.trackerRescue).toBe(false);
    // Same for the setup pre-flight defaults: user-chosen values survive.
    const chips: any = opts.migrate({ lastDurationSec: 120, lastMakesPerSpot: 3 }, 7);
    expect(chips.lastDurationSec).toBe(120);
    expect(chips.lastMakesPerSpot).toBe(3);
  });

  test('migrate is idempotent at current version', () => {
    expect(opts.migrate({ detectorEngine: 'yolox' }, opts.version)).toMatchObject({
      detectorEngine: 'yolox',
    });
    // A complete current-shape snapshot passes through byte-identical (the
    // deviceTuned backfill is keyed on the KEY being absent, not the version,
    // so a populated snapshot must not be touched).
    const snapshot: any = {
      detectorEngine: 'yolo',
      perfMode: 'quality',
      rimHeightM: 2.6,
      deviceTuned: false,
      deviceTierOverride: 'auto',
      detectedTier: null,
      useFlightArc: false,
    };
    const out: any = opts.migrate({ ...snapshot }, opts.version);
    expect(out).toEqual(snapshot);
  });

  test('partialize output is JSON-safe (what reaches kv-store round-trips)', () => {
    const persisted: any = opts.partialize
      ? opts.partialize(useSettings.getState())
      : useSettings.getState();
    // partialize strips the generic `set` action explicitly. The remaining
    // named actions (applyTrackingPreset etc.) are function-valued and are
    // dropped by createJSONStorage's JSON.stringify at write time, then
    // re-supplied from the store creator on rehydrate — so what actually
    // reaches kv-store is data-only.
    expect('set' in persisted).toBe(false);
    expect(() => JSON.stringify(persisted)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(persisted));
    const dataOnly = Object.fromEntries(
      Object.entries(persisted).filter(([, v]) => typeof v !== 'function'),
    );
    // Every persisted DATA value survives a JSON round trip unchanged (a
    // Date, NaN, or Infinity sneaking into settings would fail here).
    expect(roundTripped).toEqual(dataOnly);
  });
});
