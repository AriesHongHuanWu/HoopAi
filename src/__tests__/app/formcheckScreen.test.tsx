/**
 * Form Check screen — render contracts for the NON-CAMERA states.
 *
 * The live camera loop (VisionCamera + tflite worklet) cannot run under jest,
 * so those modules are stubbed inert and these tests pin what a phone-less
 * render can honestly verify:
 *
 *  1. GUIDE — the placement rules (side-on, 2–4 m, whole body) and the two
 *     honesty lines (motion-only / refuse-below-15fps) actually render.
 *  2. PERMISSION — starting a check without camera permission shows the
 *     "everything stays on this phone" gate, requests permission on the CTA,
 *     and Cancel returns to the guide.
 *  3. REPORT (exported FormCheckReport, driven directly) — with fewer than 3
 *     reps the consistency card says "need N more reps" and renders NO ±
 *     spread number; the ball-derived rows carry the honest em dash; the
 *     tempo row is labeled "Dip → release", never pickup→release; and the
 *     not-saved line is present.
 *
 * Mock set follows src/__tests__/app/sessionFormReport.test.tsx.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({}) },
  FadeInDown: { delay: () => ({ duration: () => ({}) }) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// Skia is ESM-only under jest; every canvas here is decorative.
jest.mock('@shopify/react-native-skia', () => {
  const stub = () => null;
  return {
    __esModule: true,
    Canvas: stub,
    Circle: stub,
    Line: stub,
    Oval: stub,
    Path: stub,
    BlurMask: stub,
    vec: (x: number, y: number) => ({ x, y }),
    Skia: {
      Path: {
        Make: () => ({ moveTo() {}, lineTo() {}, quadTo() {}, close() {} }),
      },
    },
  };
});

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/utils/haptics', () => ({
  haptic: {
    selection: jest.fn(),
    impactLight: jest.fn(),
    impactMedium: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));

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

jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));

// The camera stack: inert stubs. Permission state is per-test mutable.
const mockCameraState = {
  hasPermission: false,
  canRequestPermission: true,
  requestPermission: jest.fn(async () => false),
};
jest.mock('react-native-vision-camera', () => ({
  __esModule: true,
  Camera: () => null,
  useCameraDevice: () => ({ id: 'mock-front' }),
  useCameraPermission: () => ({
    hasPermission: mockCameraState.hasPermission,
    canRequestPermission: mockCameraState.canRequestPermission,
    requestPermission: mockCameraState.requestPermission,
  }),
  useFrameOutput: () => ({}),
}));
jest.mock('react-native-vision-camera-resizer', () => ({
  __esModule: true,
  useResizer: () => ({ resizer: null }),
}));
jest.mock('react-native-fast-tflite', () => ({
  __esModule: true,
  // Never resolves: the loader effect stays pending — no act() noise, and
  // the non-camera states under test never need a model.
  loadTensorflowModel: () => new Promise(() => {}),
}));
jest.mock('react-native-nitro-modules', () => ({
  __esModule: true,
  NitroModules: { box: (v: unknown) => ({ unbox: () => v }) },
}));
jest.mock('react-native-worklets', () => ({
  __esModule: true,
  scheduleOnRN: jest.fn(),
}));
// The MoveNet binary asset can't pass through babel — its value is opaque.
// Path is relative to THIS test file; it resolves to the same file the
// screen's relative require does, so the registered mock intercepts it.
jest.mock('../../../assets/models/movenet-pose.tflite', () => 1);
// ShotList drags in gesture-handler + the whole recap kit; only BackPill is
// consumed here.
jest.mock('@/components/ShotList', () => ({ BackPill: () => null }));

import FormCheckScreen, { FormCheckReport } from '@/app/formcheck';
import { sessionSpreads, type FormCheckRep } from '@/core/formCheck';
import type { FormMetrics } from '@/core/types';

// ---------------------------------------------------------------------------
// Helpers (sessionFormReport.test.tsx idiom)

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  await act(async () => {});
  return r;
}

async function unmount(r: ReactTestRenderer): Promise<void> {
  await act(async () => {
    r.unmount();
  });
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

function stringsOf(json: Json): string[] {
  if (json == null) return [];
  if (Array.isArray(json)) return json.flatMap(stringsOf);
  const kids = json.children ?? [];
  return kids.flatMap((k) => (typeof k === 'string' ? [k] : stringsOf(k)));
}

function textOf(json: Json): string {
  return stringsOf(json).join(' ');
}

/** Press the first button whose subtree renders exactly `label`. */
async function pressButton(r: ReactTestRenderer, label: string): Promise<void> {
  const target = r.root
    .findAll((n) => typeof n.props?.onPress === 'function')
    .find((n) =>
      n.findAll(
        (m) =>
          typeof m.props?.children === 'string' && m.props.children === label,
      ).length > 0,
    );
  expect(target).toBeDefined();
  await act(async () => {
    (target!.props.onPress as () => void)();
  });
}

const NULL_METRICS: FormMetrics = {
  setPointElbowDeg: null,
  kneeFlexionDeg: null,
  releaseAngleDeg: null,
  entryAngleDeg: null,
  releaseTimeMs: null,
  followThroughHeldMs: null,
  followThroughElbowDeg: null,
  releaseHeightNorm: null,
};

function rep(index: number, metrics: Partial<FormMetrics> = {}): FormCheckRep {
  return {
    index,
    releaseT: index,
    sequence: null,
    metrics: { ...NULL_METRICS, ...metrics },
    tips: [],
    poseFps: 28,
  };
}

beforeEach(() => {
  mockCameraState.hasPermission = false;
  mockCameraState.canRequestPermission = true;
  mockCameraState.requestPermission.mockClear();
});

// ---------------------------------------------------------------------------
// Guide

describe('FormCheck — guide', () => {
  it('renders the placement rules and both honesty lines', async () => {
    const r = await render(<FormCheckScreen />);
    const text = textOf(r.toJSON());

    expect(text).toContain('FORM CHECK');
    expect(text).toContain('Check your shooting motion');
    // Motion-only honesty: no make/miss claim without a ball.
    expect(text).toContain('it never claims a make or a miss');
    // Placement: side, distance band, whole body, side-on.
    expect(text).toContain('shooting-arm side');
    expect(text).toContain('2–4 m away');
    expect(text).toContain('head to feet');
    expect(text).toContain('side-on to the camera');
    // Refuse-below-15fps honesty (Jump Lab's contract, reused).
    expect(text).toMatch(/at least\s+15\s+fps pose/);
    expect(text).toContain('refuses to count reps');

    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Permission gate

describe('FormCheck — camera permission', () => {
  it('starting without permission shows the on-device promise and asks', async () => {
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');

    const text = textOf(r.toJSON());
    expect(text).toContain('Camera access needed');
    expect(text).toContain('Everything stays on this phone');

    await pressButton(r, 'Allow camera access');
    expect(mockCameraState.requestPermission).toHaveBeenCalled();

    await unmount(r);
  });

  it('offers Open settings when the OS will no longer prompt', async () => {
    mockCameraState.canRequestPermission = false;
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    expect(textOf(r.toJSON())).toContain('Open settings');
    await unmount(r);
  });

  it('Cancel returns to the guide', async () => {
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    expect(textOf(r.toJSON())).toContain('Camera access needed');

    await pressButton(r, 'Cancel');
    const text = textOf(r.toJSON());
    expect(text).not.toContain('Camera access needed');
    expect(text).toContain('Check your shooting motion');

    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Report (driven directly — the camera never runs under jest)

describe('FormCheckReport — honest empty / thin states', () => {
  it('under 3 reps: says how many more are needed and fabricates no spread', async () => {
    const reps = [rep(1, { setPointElbowDeg: 84 })];
    const report = {
      repCount: 1,
      medianPoseFps: 28,
      spreads: sessionSpreads(reps),
    };
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" />,
    );
    const text = textOf(r.toJSON());

    expect(text).toContain('1 reps detected');
    expect(text).toMatch(/Need\s+2\s+more\s+reps\s+for a consistency read/);
    // No spread value may render without 3 measured reps.
    expect(text).not.toMatch(/±/);
    // The report is not persisted in v1 — the copy must say so.
    expect(text).toContain('not saved');
    // Motion-only line survives into the report.
    expect(text).toContain('nothing here claims a make or a miss');
    // Form Studio cross-link is labeled for TRACKED shots.
    expect(text).toContain('Form Studio compares TRACKED shots');

    await unmount(r);
  });

  it('ball-derived rows carry the em dash and the tempo row is Dip → release', async () => {
    const reps = [rep(1, { setPointElbowDeg: 84, releaseTimeMs: 610 })];
    const report = {
      repCount: 1,
      medianPoseFps: 28,
      spreads: sessionSpreads(reps),
    };
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" />,
    );

    // Expand rep 1's metric table.
    const row = r.root.findAll(
      (n) =>
        n.props?.accessibilityLabel === 'Rep 1 details' &&
        typeof n.props?.onPress === 'function',
    )[0];
    expect(row).toBeDefined();
    await act(async () => {
      (row!.props.onPress as () => void)();
    });

    const text = textOf(r.toJSON());
    // HomeCourt's pickup→release does not exist here — dip→release only.
    expect(text).toContain('Dip → release');
    expect(text).toContain('0.61s');
    expect(text).toContain('84°');
    // Ball-trajectory rows: named, dashed, and explained — never a number.
    expect(text).toContain('Release angle');
    expect(text).toContain('Entry angle');
    expect(text).toContain('needs the ball — not measured here');
    expect(text).toContain('—');

    await unmount(r);
  });

  it('reps without sequences render no motion theater', async () => {
    const reps = [rep(1), rep(2)];
    const report = {
      repCount: 2,
      medianPoseFps: 28,
      spreads: sessionSpreads(reps),
    };
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" />,
    );
    expect(textOf(r.toJSON())).not.toContain('Motion theater'.toUpperCase());
    await unmount(r);
  });
});
