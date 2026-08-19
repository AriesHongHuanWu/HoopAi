/**
 * Form Check screen — render contracts for the NON-CAMERA states (v2).
 *
 * The live camera loop (VisionCamera + tflite worklet) cannot run under jest,
 * so those modules are stubbed inert and these tests pin what a phone-less
 * render can honestly verify:
 *
 *  1. GUIDE — the placement rules (side-on, 2–4 m, whole body, practice
 *     motions) and the two honesty lines (motion-only / refuse-below-15fps).
 *  2. PERMISSION — starting a check without camera permission shows the
 *     "everything stays on this phone" gate, requests permission on the CTA,
 *     and Cancel returns to the guide.
 *  3. CALIBRATION RAIL — with permission granted, the live rail opens on the
 *     explicit stepper ("PRACTICE MOTION 1 OF 2", not scored), offers Skip
 *     but NOT "Start scoring" before any shadow rep, and after Skip degrades
 *     to the chip row with the honest ASSUMED arm label and a paused banner.
 *  4. REPORT (exported FormCheckReport, driven directly) — the consistency
 *     verdict hero refuses under 3 reps and fabricates no ± spread; the
 *     ball-derived rows keep the em dash; metres render only from a height
 *     scale and always as an estimate; the calibration receipt renders every
 *     degraded label honestly; similarity is labeled a style match against a
 *     synthesized reference and refuses when too few joints were seen; the
 *     saved/not-saved footer follows the insert result.
 *  5. Pure copy/write-path helpers (repCallout, verdictHeadline,
 *     guidanceBanner, armChipLabel, formSessionRowOf) — including the
 *     summaryJson-carries-no-sequences contract.
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
  Easing: {
    out: (fn: unknown) => fn,
    inOut: (fn: unknown) => fn,
    cubic: 'cubic',
    quad: 'quad',
  },
  FadeIn: { duration: () => ({}), reduceMotion: () => ({}) },
  FadeInDown: { delay: () => ({ duration: () => ({}) }) },
  LinearTransition: { duration: () => ({}) },
  ReduceMotion: { System: 'system' },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  useAnimatedStyle: () => ({}),
  withRepeat: (value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
  cancelAnimation: jest.fn(),
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
        Make: () => ({
          moveTo() {},
          lineTo() {},
          quadTo() {},
          close() {},
          addCircle() {},
          addArc() {},
        }),
      },
      XYWHRect: (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h }),
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

// Voice callouts route through expo-speech; the gateway behavior itself
// (stop-before-speak) is the useVoiceAnnouncements pattern, tested there.
jest.mock('expo-speech', () => ({
  __esModule: true,
  stop: jest.fn(async () => {}),
  speak: jest.fn(),
}));

// SQLite persistence — the report's save chip is driven by the RESULT of this
// insert; the write-path row shape is pinned via formSessionRowOf below.
jest.mock('@/data/db', () => ({
  __esModule: true,
  insertFormSession: jest.fn(async () => 1),
}));

// Profile height (canonical metres source). Mutable per test.
const mockProfileState: { heightCm: number | null } = { heightCm: null };
jest.mock('@/state/profileStore', () => ({
  useProfile: (sel: (s: { heightCm: number | null }) => unknown) => sel(mockProfileState),
}));

// The motion theater's Skia stage — a marker so "Compare mounted the theater"
// is assertable without rendering a canvas.
jest.mock('@/components/charts/FormMotionStage', () => {
  const ReactLocal = require('react') as typeof React;
  const { Text } = require('react-native');
  return {
    __esModule: true,
    FormMotionStage: () => ReactLocal.createElement(Text, null, 'MOTION_STAGE'),
  };
});

// The motion barrel: real arcMotif geometry (rings call it at render — a stub
// would math-crash), static ArcReveal stub (the armed moment is decorative).
jest.mock('@/components/motion', () => ({
  __esModule: true,
  arcMotif: jest.requireActual('@/components/motion/ArcReveal').arcMotif,
  ArcReveal: () => null,
}));

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

import FormCheckScreen, {
  FormCheckReport,
  armChipLabel,
  formSessionRowOf,
  guidanceBanner,
  repCallout,
  verdictHeadline,
} from '@/app/formcheck';
import {
  ELBOW_SPREAD_FLAG_DEG,
  KNEE_SPREAD_FLAG_DEG,
  MIN_SPREAD_REPS,
  RELEASE_HEIGHT_SPREAD_FLAG,
  TEMPO_SPREAD_FLAG_MS,
  sessionSpreads,
  type CalibrationState,
  type FormCheckReadiness,
  type FormCheckRep,
  type FormCheckSessionReport,
} from '@/core/formCheck';
import { buildSequence, type RawSeqFrame } from '@/core/formSequence';
import type { FormMetrics, PoseKeypointName } from '@/core/types';

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

/** Switch a SegmentedTabs tablist (coachSegments.test.tsx idiom). */
async function switchTo(r: ReactTestRenderer, label: string): Promise<void> {
  const list = r.root.find(
    (n) =>
      typeof n.type === 'string' &&
      n.props.accessibilityRole === 'tablist' &&
      n.props.accessibilityLabel === 'Report sections',
  );
  const tab = list
    .findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tab')
    .find((t) => String(t.props.accessibilityLabel).startsWith(label));
  if (tab == null) throw new Error(`No report tab labelled ${label}`);
  const pressable = tab.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityRole === 'none' &&
      n.props.haptic === undefined,
  )[0]!;
  await act(async () => {
    pressable.props.onPress();
  });
}

// ---------------------------------------------------------------------------
// Fixtures

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

function rep(
  index: number,
  metrics: Partial<FormMetrics> = {},
  over: Partial<FormCheckRep> = {},
): FormCheckRep {
  return {
    index,
    releaseT: index,
    sequence: null,
    metrics: { ...NULL_METRICS, ...metrics },
    phases: { dipMs: null, riseMs: null, releaseMs: null, followMs: null },
    releaseHeightM: null,
    flags: [],
    tips: [],
    poseFps: 28,
    ...over,
  };
}

function calib(over: Partial<CalibrationState> = {}): CalibrationState {
  return {
    phase: 'done',
    shadowReps: 2,
    hand: 'right',
    handSource: 'settings',
    sidenessAvg: 0.8,
    tilt: null,
    scale: null,
    standingWristY: null,
    stanceWidthN: null,
    setPointWristY: null,
    ...over,
  };
}

/** Report from real sessionSpreads + the core's own steady/measured gauge. */
function reportOf(
  reps: readonly FormCheckRep[],
  over: Partial<FormCheckSessionReport> = {},
): FormCheckSessionReport {
  const spreads = sessionSpreads(reps);
  const gauges: [number | null, number][] = [
    [spreads.setPointElbowSpreadDeg.value, ELBOW_SPREAD_FLAG_DEG],
    [spreads.tempoSpreadMs.value, TEMPO_SPREAD_FLAG_MS],
    [spreads.kneeSpreadDeg.value, KNEE_SPREAD_FLAG_DEG],
    [spreads.releaseHeightSpread.value, RELEASE_HEIGHT_SPREAD_FLAG],
  ];
  let steady = 0;
  let measured = 0;
  for (const [v, flag] of gauges) {
    if (v == null) continue;
    measured++;
    if (v <= flag) steady++;
  }
  return {
    repCount: reps.length,
    medianPoseFps: 28,
    spreads,
    best: null,
    calibration: calib(),
    verdict: { steady, measured },
    ...over,
  };
}

// — a REAL packed sequence (the core test's scripted right-handed shooter) —

const DT = 1 / 30;

const STATIC: Partial<Record<PoseKeypointName, [number, number]>> = {
  nose: [100, 25],
  right_shoulder: [95, 45],
  left_shoulder: [85, 45],
  right_hip: [100, 95],
  left_hip: [92, 95],
  right_knee: [100, 130],
  right_ankle: [131.18, 148],
  left_knee: [92, 130],
  left_ankle: [92, 165],
};

function armAt(i: number, dipFrames: number): { elbow: [number, number]; wrist: [number, number] } {
  const k = i - dipFrames;
  if (k < 0) return { elbow: [95, 80], wrist: [120, 80] };
  if (k >= 5) return { elbow: [95, 30], wrist: [95, 15] };
  const u = (k + 1) / 5;
  return { elbow: [95, 80 - 50 * u], wrist: [120 - 25 * u, 80 - 65 * u] };
}

function rawAt(t: number, i: number, dipFrames: number): RawSeqFrame {
  const m = new Map<PoseKeypointName, { x: number; y: number }>();
  for (const [name, p] of Object.entries(STATIC) as [PoseKeypointName, [number, number]][]) {
    m.set(name, { x: p[0], y: p[1] });
  }
  const arm = armAt(i, dipFrames);
  m.set('right_elbow', { x: arm.elbow[0], y: arm.elbow[1] });
  m.set('right_wrist', { x: arm.wrist[0], y: arm.wrist[1] });
  return { t, pts: m };
}

/** A genuinely decodable FormSequence for the theater/similarity tests. */
function realSequence() {
  const frames: RawSeqFrame[] = [];
  for (let i = 0; i < 38; i++) frames.push(rawAt(i * DT, i, 20));
  const seq = buildSequence(frames, 'right', 27 * DT);
  expect(seq).not.toBeNull();
  return seq!;
}

beforeEach(() => {
  mockCameraState.hasPermission = false;
  mockCameraState.canRequestPermission = true;
  mockCameraState.requestPermission.mockClear();
  mockProfileState.heightCm = null;
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
    // Placement: side, distance band, whole body, side-on, practice motions.
    expect(text).toContain('shooting-arm side');
    expect(text).toContain('2–4 m away');
    expect(text).toContain('head to feet');
    expect(text).toContain('side-on to the camera');
    expect(text).toContain('practice motions');
    expect(text).toContain('never scored');
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
// Calibration rail (live view with permission; the model never loads, so the
// session receives no frames — the states here are the honest zero-frame ones)

describe('FormCheck — calibration rail', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCameraState.hasPermission = true;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens on the stepper: practice motion 1 of 2, not scored, no Start scoring yet', async () => {
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');

    const text = textOf(r.toJSON());
    expect(text).toContain('PRACTICE MOTION 1 OF 2');
    expect(text).toContain('Not scored — calibrating.');
    expect(text).toContain('Skip');
    // "Start scoring" requires at least one shadow rep — zero so far.
    expect(text).not.toContain('Start scoring');
    // Zero-frame gates read as paused practice, honestly.
    expect(text).toContain('Practice motions are paused.');

    await unmount(r);
  });

  it('Skip arms scoring with the ASSUMED arm chip and a paused banner', async () => {
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    await pressButton(r, 'Skip');

    const text = textOf(r.toJSON());
    expect(text).not.toContain('PRACTICE MOTION');
    // Skipped calibration: the arm is ASSUMED (never "detected").
    expect(text).toContain('ASSUMED RIGHT');
    expect(text).toContain('SIDE');
    // Model never loads under jest — the warmup banner + the paused contract.
    expect(text).toContain('Warming up the pose model…');
    expect(text).toContain('Rep counting is paused.');

    await unmount(r);
  });

  it('carries the Recalibrate pill and disables End session at zero reps', async () => {
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');

    expect(
      r.root.findAll((n) => n.props?.accessibilityLabel === 'Recalibrate').length,
    ).toBeGreaterThan(0);
    const endBtn = r.root
      .findAll((n) => typeof n.props?.onPress === 'function' && n.props?.disabled === true)
      .find(
        (n) =>
          n.findAll(
            (m) => typeof m.props?.children === 'string' && m.props.children === 'End session',
          ).length > 0,
      );
    expect(endBtn).toBeDefined();

    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Report (driven directly — the camera never runs under jest)

describe('FormCheckReport — verdict hero and honest thin states', () => {
  it('under 3 reps: verdict says how many more and fabricates no spread', async () => {
    const reps = [rep(1, { setPointElbowDeg: 84 })];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={-1} />,
    );
    const text = textOf(r.toJSON());

    expect(text).toContain('1 reps detected');
    expect(text).toContain('Need 2 more reps');
    // No spread value may render without 3 measured reps.
    expect(text).not.toMatch(/±/);
    // The insert failed — the footer keeps the honest not-saved line.
    expect(text).toContain("couldn't be saved");
    expect(text).toContain('Not saved');
    // Motion-only line survives into the report.
    expect(text).toContain('nothing here claims a make or a miss');
    // Form Studio cross-link is labeled for TRACKED shots.
    expect(text).toContain('Form Studio compares TRACKED shots');

    await unmount(r);
  });

  it('a saved report wears the Saved chip and drops the not-saved sentence', async () => {
    const reps = [rep(1, { setPointElbowDeg: 84 })];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={7} />,
    );
    const text = textOf(r.toJSON());

    expect(text).toContain('Saved');
    expect(text).toContain('Saved on this phone');
    expect(text).not.toContain("couldn't be saved");
    await unmount(r);
  });

  it('verdictHeadline: needs-more / steady / drifting / unmeasured', () => {
    const two = [rep(1, { setPointElbowDeg: 84 }), rep(2, { setPointElbowDeg: 85 })];
    expect(verdictHeadline(reportOf(two))).toBe('Need 1 more rep');

    const steady = [1, 2, 3].map((i) => rep(i, { setPointElbowDeg: 84 + i * 0.1 }));
    expect(verdictHeadline(reportOf(steady))).toBe('Steady session');

    const drifting = [
      rep(1, { setPointElbowDeg: 60 }),
      rep(2, { setPointElbowDeg: 85 }),
      rep(3, { setPointElbowDeg: 110 }),
    ];
    expect(verdictHeadline(reportOf(drifting))).toBe('1 of 1 drifting');

    const blank = [rep(1), rep(2), rep(3)];
    expect(verdictHeadline(reportOf(blank))).toBe('No consistency read');
  });
});

describe('FormCheckReport — Reps tab', () => {
  it('ball-derived rows carry the em dash and the tempo row is Dip → release', async () => {
    const reps = [rep(1, { setPointElbowDeg: 84, releaseTimeMs: 610 })];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={1} />,
    );
    await switchTo(r, 'Reps');

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
    // No sequence decoded ⇒ similarity honestly refuses.
    expect(text).toContain('too few joints seen');

    await unmount(r);
  });

  it('metres render only from a height scale, one decimal, labeled estimate', async () => {
    const reps = [
      rep(1, { releaseHeightNorm: 0.72 }, { releaseHeightM: 2.41 }),
      rep(2, { releaseHeightNorm: 0.7 }),
    ];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={1} />,
    );
    await switchTo(r, 'Reps');
    for (const label of ['Rep 1 details', 'Rep 2 details']) {
      const row = r.root.findAll(
        (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
      )[0]!;
      await act(async () => {
        (row.props.onPress as () => void)();
      });
    }

    const text = textOf(r.toJSON());
    // One decimal max — an estimate must not wear false precision.
    expect(text).toContain('≈ 2.4 m');
    expect(text).toContain('estimate from your profile height');
    // The scale-less rep keeps v1's camera-relative % verbatim.
    expect(text).toContain('70%');
    expect(text).toContain('camera-relative');

    await unmount(r);
  });

  it('flags annotate as chips and the best rep wears the star', async () => {
    const reps = [
      rep(1, { setPointElbowDeg: 84 }, { flags: ['shallowDip', 'stanceDrift'] }),
      rep(2, { setPointElbowDeg: 85 }),
    ];
    const report = reportOf(reps, { best: { index: 2, reason: 'elbow 85° in band' } });
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" savedId={1} />,
    );
    await switchTo(r, 'Reps');
    const text = textOf(r.toJSON());

    expect(text).toContain('shallow dip');
    expect(text).toContain('stance drift');
    expect(
      r.root.findAll((n) => n.props?.accessibilityLabel === 'Rep 2 details, best rep').length,
    ).toBeGreaterThan(0);
    await unmount(r);
  });
});

describe('FormCheckReport — calibration receipt (degraded labels)', () => {
  it('assumed arm, no tilt compensation, no metres — every absence named', async () => {
    const reps = [rep(1)];
    const report = reportOf(reps, {
      calibration: calib({
        handSource: 'settings',
        sidenessAvg: null,
        tilt: { tiltDeg: 9, stdDeg: 8, frames: 20, confident: false },
        scale: null,
      }),
    });
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" savedId={1} heightCm={null} />,
    );
    const text = textOf(r.toJSON());

    expect(text).toContain('right arm · assumed');
    expect(text).toContain('assumed from Settings');
    expect(text).toContain('not compensated');
    // No profile height ⇒ the Settings link, not silence.
    expect(text).toContain('Height not set — add it in Settings for metres');
    await unmount(r);
  });

  it('confident tilt and a locked scale read as compensated + metres on', async () => {
    const reps = [rep(1)];
    const report = reportOf(reps, {
      calibration: calib({
        handSource: 'auto',
        tilt: { tiltDeg: -4.2, stdDeg: 1.1, frames: 24, confident: true },
        scale: { metersPerPx: 0.011, standingSpanPx: 140, heightCm: 178 },
      }),
    });
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" savedId={1} heightCm={178} />,
    );
    const text = textOf(r.toJSON());

    expect(text).toContain('right arm · auto');
    expect(text).toContain('auto-detected');
    expect(text).toContain('compensated -4°');
    expect(text).toContain('178 cm profile height');
    await unmount(r);
  });

  it('height set but scale unlocked names the unsteady standing span', async () => {
    const reps = [rep(1)];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={1} heightCm={178} />,
    );
    expect(textOf(r.toJSON())).toContain('standing span too unsteady');
    await unmount(r);
  });
});

describe('FormCheckReport — Compare tab and similarity', () => {
  it('reps without sequences render the honest empty compare state', async () => {
    const reps = [rep(1), rep(2)];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={1} />,
    );
    await switchTo(r, 'Compare');
    const text = textOf(r.toJSON());

    expect(text).not.toContain('MOTION_STAGE');
    expect(text).toContain('nothing to compare');
    await unmount(r);
  });

  it('a decodable rep mounts the theater with the style-match label', async () => {
    const seq = realSequence();
    const reps = [rep(1, { setPointElbowDeg: 88 }, { sequence: seq })];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={1} />,
    );
    await switchTo(r, 'Compare');
    const text = textOf(r.toJSON());

    expect(text).toContain('MOTION_STAGE');
    // A real similarity computed from real measured angles, labeled a STYLE
    // MATCH against a SYNTHESIZED reference — never a quality score.
    expect(text).toContain('STYLE MATCH');
    expect(text).toMatch(/style match vs synthesized .+ reference — not a quality score/);
    expect(text).toContain('RULES MEASURED');
    await unmount(r);
  });

  it('the best-rep card jumps into Compare', async () => {
    const seq = realSequence();
    const reps = [
      rep(1, { setPointElbowDeg: 88 }, { sequence: seq }),
      rep(2, { setPointElbowDeg: 84 }),
    ];
    const report = reportOf(reps, { best: { index: 1, reason: 'elbow 88° in band' } });
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" savedId={1} />,
    );

    expect(textOf(r.toJSON())).toContain('elbow 88° in band');
    await pressButton(r, 'View in Compare');
    expect(textOf(r.toJSON())).toContain('MOTION_STAGE');
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers

describe('repCallout', () => {
  it('speaks the count word alone for a clean rep', () => {
    expect(repCallout(rep(4, { followThroughHeldMs: 400 }))).toBe('Four');
  });

  it('appends at most ONE flag, ≤ 5 words', () => {
    const short = repCallout(rep(4, { followThroughHeldMs: 50 }));
    expect(short).toBe('Four — hold the follow-through');
    // Both flags set — still exactly one spoken.
    const flagged = repCallout(rep(2, {}, { flags: ['shallowDip', 'stanceDrift'] }));
    expect(flagged).toBe('Two — sink the dip');
    for (const line of [short, flagged]) {
      expect(line.replace('—', '').split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(5);
    }
  });

  it('falls back to digits past the word list', () => {
    expect(repCallout(rep(23))).toBe('23');
  });
});

describe('guidanceBanner', () => {
  const readyAll: FormCheckReadiness = {
    fps: 30,
    fullBodyFrac: 1,
    armFrac: 1,
    sideness: 0.8,
    fpsOk: true,
    fullBodyOk: true,
    armOk: true,
    sideOk: true,
    ready: true,
  };

  it('prioritizes warmup, then fps, then body, then arm, then side', () => {
    expect(guidanceBanner(false, readyAll, 'right', null, false)!.text).toContain('Warming up');
    expect(
      guidanceBanner(true, { ...readyAll, fpsOk: false, fps: 9, ready: false }, 'right', null, false)!
        .text,
    ).toContain('9 fps');
    expect(
      guidanceBanner(true, { ...readyAll, fullBodyOk: false, ready: false }, 'right', null, false)!
        .text,
    ).toContain('Step back');
    expect(
      guidanceBanner(true, { ...readyAll, armOk: false, ready: false }, 'right', null, false)!.text,
    ).toContain('right arm');
  });

  it('grades the side-profile guidance and degrades honestly while collecting', () => {
    const facing = { ...readyAll, sideOk: false, sideness: 0.2, ready: false };
    expect(guidanceBanner(true, facing, 'right', null, false)!.text).toContain('turn 90°');
    const nearly = { ...readyAll, sideOk: false, sideness: 0.5, ready: false };
    expect(guidanceBanner(true, nearly, 'right', null, false)!.text).toContain('a little more');
    // While collecting, a failing ARM gate must not block (calibration is
    // what determines the arm) — side guidance still speaks.
    const armDown = { ...readyAll, armOk: false, sideOk: false, sideness: 0.2, ready: false };
    expect(guidanceBanner(true, armDown, 'right', null, true)!.text).toContain('turn 90°');
  });

  it('heavy tilt is an ADVISORY — it never pauses rep counting', () => {
    const banner = guidanceBanner(
      true,
      readyAll,
      'right',
      calib({ tilt: { tiltDeg: 22, stdDeg: 1, frames: 20, confident: false } }),
      false,
    );
    expect(banner).toEqual({ text: 'Straighten the phone.', pauses: false });
    // All gates green, small tilt ⇒ no banner at all.
    expect(
      guidanceBanner(
        true,
        readyAll,
        'right',
        calib({ tilt: { tiltDeg: 3, stdDeg: 1, frames: 20, confident: true } }),
        false,
      ),
    ).toBeNull();
  });
});

describe('armChipLabel', () => {
  it('prefixes per source and never says "detected" for an abstain', () => {
    expect(armChipLabel('right', 'settings')).toBe('ASSUMED RIGHT');
    expect(armChipLabel('left', 'auto')).toBe('AUTO LEFT');
    expect(armChipLabel('left', 'manual')).toBe('LEFT ARM');
  });
});

describe('formSessionRowOf (write path)', () => {
  it('summaryJson carries reps WITHOUT sequences; bestRepJson carries exactly one', () => {
    const seq = realSequence();
    const reps = [
      rep(1, { setPointElbowDeg: 84, releaseTimeMs: 600 }, { sequence: seq }),
      rep(2, { setPointElbowDeg: 86, releaseTimeMs: 640 }, { sequence: seq }),
    ];
    const report = reportOf(reps, { best: { index: 2, reason: 'elbow 86° in band' } });
    const row = formSessionRowOf(report, reps, 1234);

    expect(row.ts).toBe(1234);
    expect(row.hand).toBe('right');
    expect(row.handSource).toBe('settings');
    expect(row.repCount).toBe(2);
    // Blob discipline: NO sequence data in the scan-facing summary.
    expect(row.summaryJson).not.toContain('"sequence"');
    const summary = JSON.parse(row.summaryJson) as { reps: unknown[] };
    expect(summary.reps).toHaveLength(2);
    // Exactly ONE encoded sequence rides in bestRepJson.
    expect(row.bestRepJson).not.toBeNull();
    const bestRep = JSON.parse(row.bestRepJson!) as { index: number; sequence: unknown };
    expect(bestRep.index).toBe(2);
    expect(bestRep.sequence).toBeTruthy();
  });

  it('unmeasured spreads persist as nulls and unconfident tilt is never written', () => {
    const reps = [rep(1)];
    const report = reportOf(reps, {
      calibration: calib({ tilt: { tiltDeg: 9, stdDeg: 8, frames: 20, confident: false } }),
    });
    const row = formSessionRowOf(report, reps, 1);

    expect(row.elbowSpreadDeg).toBeNull();
    expect(row.tempoSpreadMs).toBeNull();
    expect(row.releaseHeightM).toBeNull();
    expect(row.tiltDeg).toBeNull();
    expect(row.bestRepJson).toBeNull();
  });

  it('confident tilt and median metric height persist as scalars', () => {
    const reps = [
      rep(1, {}, { releaseHeightM: 2.4 }),
      rep(2, {}, { releaseHeightM: 2.6 }),
    ];
    const report = reportOf(reps, {
      calibration: calib({ tilt: { tiltDeg: -4.2, stdDeg: 1, frames: 24, confident: true } }),
    });
    const row = formSessionRowOf(report, reps, 1);

    expect(row.tiltDeg).toBeCloseTo(-4.2);
    expect(row.releaseHeightM).toBeCloseTo(2.5);
  });

  it('MIN_SPREAD_REPS is the spread gate the columns inherit', () => {
    const reps = [1, 2, 3].map((i) => rep(i, { releaseTimeMs: 600 + i * 10 }));
    expect(reps.length).toBe(MIN_SPREAD_REPS);
    const row = formSessionRowOf(reportOf(reps), reps, 1);
    expect(row.tempoSpreadMs).not.toBeNull();
  });
});
