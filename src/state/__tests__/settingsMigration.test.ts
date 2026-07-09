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
    // v6: mega-upgrade — bumped exactly once for all sibling features
    // (replay3d backfill; the other v6 keys are plain additive defaults).
    expect(opts.version).toBe(6);
  });

  test('migrate from v1 backfills engine/perf defaults (full chain to v6)', () => {
    const out: any = opts.migrate({}, 1);
    expect(out.detectorEngine).toBe('yolox'); // v2: YOLOX becomes default
    expect(out.perfMode).toBe('speed'); // v3: 416 becomes default
    expect(out.rimHeightM).toBe(3.05); // v4: regulation height backfill
    expect(out.deviceTuned).toBe(true); // v4: pre-existing installs own knobs
    expect(out.useFlightArc).toBe(true); // v5: flight arc on
    expect(out.replay3d).toBe(true); // v6: 3D replay on
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
