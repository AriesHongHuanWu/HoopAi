/**
 * DebugPanel funnel surfaces — the panel renders EXACTLY what funnelRows
 * returns and COPY DIAG shares EXACTLY what buildDiagnostics returns, so these
 * tests pin the field-report contract: the funnel rows' strings/colors
 * (silent-death states read as problems, healthy states as green), the
 * `gates:`/`arm:` lines riding the diagnostics paste, the cfg settings line,
 * and that everything degrades cleanly to the pre-integration output when no
 * funnel exists (f == null).
 */
// settingsStore persists via expo-sqlite/kv-store — mock to an in-memory map
// (persistence is zustand middleware, not under test).
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
jest.mock('expo-device', () => ({
  __esModule: true,
  modelName: 'TestPhone',
  deviceName: 'TestPhone',
  modelId: 'T1,1',
}));
jest.mock('expo-haptics', () => ({
  __esModule: true,
  selectionAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The acquisition-funnel module is owned by the core work item; DebugPanel
// only threads its outputs through. Mock the runtime functions so these tests
// pin THIS file's splicing, not the funnel module's formatting (its own tests
// live in src/core/__tests__). Types still come from the real module.
jest.mock('../../../core/acquisitionFunnel', () => ({
  __esModule: true,
  funnelChanged: jest.fn((a: unknown, b: unknown) => a !== b),
  formatFunnelDiag: jest.fn(() => ['gates: MOCK-GATES', 'arm: MOCK-ARM']),
}));

import type { EngineDebug } from '../../../camera/useShotEngine';
import type { FrameFunnel } from '../../../core/acquisitionFunnel';
import { color } from '../../../constants/tokens';
import { useSettings } from '../../../state/settingsStore';
import { buildDiagnostics, funnelRows } from '../DebugPanel';

/** Complete EngineDebug fixture (mirrors EMPTY_DEBUG without importing the
 *  camera module, which can't load under jest). */
function makeDebug(over: Partial<EngineDebug> = {}): EngineDebug {
  return {
    mode: 'camera',
    modelLoaded: true,
    frames: 120,
    outputLen: 3549,
    layout: 'anchors-last',
    maxScore: 0.62,
    detCount: 2,
    inputMin: 0,
    inputMax: 1,
    bufBytes: 2076672,
    nonZeroPct: 88,
    light: 0.5,
    delegate: 'core-ml',
    modelError: '',
    avgMs: 21,
    fps: 28,
    dropped: 3,
    roiFrames: 4,
    roiHits: 1,
    roiAvgMs: 12,
    thermalLevel: 0,
    lens: '',
    ...over,
  };
}

/** Complete FrameFunnel fixture (typed against the real module, so a contract
 *  drift surfaces as a compile error here, not a silent display bug). */
const BASE_FUNNEL: FrameFunnel = {
  ballDets: 1,
  floor: 0.35,
  gate: 'cold',
  rejScore: 0,
  rejSize: 0,
  rejAspect: 0,
  rejJump: 0,
  lastReject: null,
  accepted: true,
  rescued: false,
  rawBall: 1,
  track: 'real',
  armRefusal: 'live',
  dribbleLatch: false,
  arcR2y: null,
  arcSuppressed: false,
};
function makeFunnel(over: Partial<FrameFunnel> = {}): FrameFunnel {
  return { ...BASE_FUNNEL, ...over };
}

function row(f: FrameFunnel, k: string) {
  const r = funnelRows(f).find((x) => x.k === k);
  if (r == null) throw new Error(`missing row ${k}`);
  return r;
}

describe('funnelRows', () => {
  it('renders the five stages in seen→tracked→armed order', () => {
    expect(funnelRows(makeFunnel()).map((r) => r.k)).toEqual([
      'ball gate',
      'rej',
      'track',
      'arm',
      'dribble',
    ]);
  });

  it('shows the ACTIVE floor at its exact configured precision + gate used', () => {
    expect(row(makeFunnel({ floor: 0.35, gate: 'cold' }), 'ball gate').v).toBe('0.35 cold');
    expect(row(makeFunnel({ floor: 0.16, gate: 'none' }), 'ball gate').v).toBe('0.16 none');
    expect(row(makeFunnel({ floor: 0.2, gate: 'tracking' }), 'ball gate').v).toBe('0.20 tracking');
    expect(row(makeFunnel({ floor: 0.2, gate: 'hoopRoi' }), 'ball gate').v).toBe('0.20 hoopRoi');
  });

  it('healthy live shot reads green: real track, live arm, no dribble hold', () => {
    const f = makeFunnel({ track: 'real', armRefusal: 'live' });
    expect(row(f, 'rej')).toMatchObject({ v: 's0 a0 j0 z0', vc: color.textDim });
    expect(row(f, 'track')).toMatchObject({ v: 'real', vc: color.make });
    expect(row(f, 'arm')).toMatchObject({ v: 'live', vc: color.make });
    expect(row(f, 'dribble')).toMatchObject({ v: '--', vc: color.textFaint });
  });

  it('silent death reads red: rejections with NO track, no rim to arm', () => {
    const f = makeFunnel({
      rejAspect: 2,
      rejJump: 1,
      track: 'none',
      armRefusal: 'no-rim',
      dribbleLatch: true,
    });
    expect(row(f, 'rej')).toMatchObject({ v: 's0 a2 j1 z0', vc: color.miss });
    expect(row(f, 'track')).toMatchObject({ v: 'none', vc: color.miss });
    expect(row(f, 'arm')).toMatchObject({ v: 'no-rim', vc: color.miss });
    expect(row(f, 'dribble')).toMatchObject({ v: 'latched', vc: color.unsure });
  });

  it('rejections while a track EXISTS are dim, not red (normal pruning)', () => {
    const f = makeFunnel({ rejScore: 5, track: 'real' });
    expect(row(f, 'rej').vc).toBe(color.textDim);
  });

  it('coast + rescue + suppressor states use the unsure tier', () => {
    const f = makeFunnel({
      track: 'coast',
      rescued: true,
      armRefusal: 'no-branch',
      arcSuppressed: true,
    });
    expect(row(f, 'track')).toMatchObject({ v: 'coast ·R', vc: color.unsure });
    expect(row(f, 'arm')).toMatchObject({ v: 'no-branch', vc: color.unsure });
    expect(row(f, 'dribble')).toMatchObject({ v: 'apex-hold', vc: color.unsure });
  });

  it("'armed' is green; every canArm refusal is unsure", () => {
    expect(row(makeFunnel({ armRefusal: 'armed' }), 'arm').vc).toBe(color.make);
    for (const r of ['no-ball', 'lockout', 'cooldown', 'putback', 'resting'] as const) {
      expect(row(makeFunnel({ armRefusal: r }), 'arm')).toMatchObject({ v: r, vc: color.unsure });
    }
  });

  it('dribble latch wins over apex-hold in the display (matches gate order)', () => {
    const f = makeFunnel({ dribbleLatch: true, arcSuppressed: true });
    expect(row(f, 'dribble').v).toBe('latched');
  });

  it('every value fits the fixed 92px column (~15ch at micro size)', () => {
    const worst = makeFunnel({
      floor: 0.35,
      gate: 'tracking',
      rejScore: 12,
      rejAspect: 34,
      rejJump: 5,
      rejSize: 6,
      track: 'coast',
      rescued: true,
      armRefusal: 'no-branch',
      dribbleLatch: true,
    });
    for (const r of funnelRows(worst)) expect(r.v.length).toBeLessThanOrEqual(15);
  });
});

describe('buildDiagnostics', () => {
  it('appends the funnel lines after roi: and before the cfg line', () => {
    const out = buildDiagnostics(makeDebug(), 1.9, makeFunnel());
    const lines = out.split('\n');
    const roi = lines.findIndex((l) => l.startsWith('roi:'));
    expect(roi).toBeGreaterThan(-1);
    expect(lines[roi + 1]).toBe('gates: MOCK-GATES');
    expect(lines[roi + 2]).toBe('arm: MOCK-ARM');
    expect(lines[roi + 3]).toMatch(/^cfg: rescue /);
  });

  it('skips the funnel lines (but keeps cfg) when no funnel exists', () => {
    const out = buildDiagnostics(makeDebug(), 0, null);
    expect(out).not.toContain('gates:');
    expect(out).not.toContain('arm:');
    expect(out).toContain('cfg: rescue ');
  });

  it('cfg reflects the store toggles; trackerRescue defaults ON before v7 lands', () => {
    const prev = useSettings.getState();
    try {
      useSettings.setState({ multiBallGuard: false, rimGuard: true });
      expect(buildDiagnostics(makeDebug(), 0, null)).toContain(
        'cfg: rescue on · multiBall off · rimGuard on',
      );
      // Once the integrator ships the v7 key, the line follows it.
      useSettings.setState({ trackerRescue: false } as Partial<typeof prev>);
      expect(buildDiagnostics(makeDebug(), 0, null)).toContain('cfg: rescue off');
    } finally {
      useSettings.setState({
        multiBallGuard: prev.multiBallGuard,
        rimGuard: prev.rimGuard,
        trackerRescue: (prev as { trackerRescue?: boolean }).trackerRescue,
      } as Partial<typeof prev>);
    }
  });

  it('keeps the pre-funnel lines byte-identical (report parsers keep working)', () => {
    const out = buildDiagnostics(makeDebug(), 1.9, null);
    expect(out).toContain('HOOPILOT DIAG');
    expect(out).toContain('device: TestPhone (T1,1)');
    expect(out).toContain('ball: maxScore 0.620 · dets 2');
    expect(out).toContain('rim aspect: 1.90');
    expect(out).toContain('roi: 1/4 · 12ms');
    expect(out).toContain('frames 120 · dropped 3');
  });
});
