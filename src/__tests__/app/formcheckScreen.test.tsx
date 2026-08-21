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
 *     guidanceBanner, lowConfidenceLine, armChipLabel, formSessionRowOf) —
 *     including the summaryJson-carries-no-sequences contract.
 *  6. V4 BUFFER ORIENTATION — the check opens on the BACK camera; the rail
 *     carries a VIEW chip that says UNVERIFIED (never a silent "upright")
 *     until the detector commits, DURING calibration as well as past it,
 *     takes a one-tap human override that latches as MANUAL, and drops that
 *     latch when the session restarts or the camera changes.
 *  7. V3 STAGE HARDENING — the loader warms the interpreter up before
 *     publishing it and reports a dead ladder with a Retry instead of an
 *     eternal "warming up"; permission is asked at MOUNT; a null device says
 *     so rather than blaming the room; "Starting the camera…" is its own
 *     state; Recalibrate is a hold; Restart and Check again are the two
 *     one-tap recoveries; and every relaxed-gate reason the core reports is
 *     rendered on the rep and in the report.
 *  8. FRAME-INGEST HARDENING — the watched arm follows a Settings value that
 *     rehydrates AFTER first render (a left-handed session used to be
 *     measured end to end on the wrong arm), without ever moving mid-session
 *     or over a manual pick; and the pure frameStall() watchdog plus its
 *     banner priority, which is what stops a frozen pose loop from wearing
 *     the last live frame's green readiness verdict.
 *
 * What these CANNOT reach: anything downstream of a real pose frame. The
 * frame output is stubbed inert, so the session never receives a sample and
 * the "Ready — shoot when you like." rail state (readiness.ready true) has no
 * render path here — its trigger is pinned instead as guidanceBanner
 * returning null, which is exactly the condition the rail branches on. For
 * the same reason the ORIENTATION detector never receives a frame here, so
 * its two auto verdicts are pinned through the exported copy helpers (and, at
 * the source, by src/__tests__/core/poseOrientation.test.ts); what the screen
 * itself is pinned on is the zero-frame state — UNVERIFIED — and the manual
 * override, which needs no frames at all. The same limit puts the sink's
 * SESSION REBUILD out of reach here: it fires on the frame where the
 * correction switches on or off, and no frame ever arrives under jest, so
 * its rail copy ("restarted after the view flipped") is verifiable only on a
 * device. Nothing below claims otherwise.
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
  // The real useSharedValue returns a STABLE object across renders (it is a
  // ref underneath). The old `(value) => ({ value })` handed back a fresh
  // object every render, so any effect listing one in its deps re-ran on
  // every render — invisible while the tflite mock never resolved, an
  // infinite loop the moment it does. Backed by a ref so the mock keeps the
  // contract the screen is written against.
  useSharedValue: (value: unknown) => {
    const ref = (require('react') as typeof React).useRef<{ value: unknown } | null>(null);
    if (ref.current === null) ref.current = { value };
    return ref.current;
  },
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

// The camera stack: inert stubs. Permission + device state is per-test
// mutable — v3 drops the `device != null` precondition on the permission
// wall, and adds a "no camera on this device" branch, so both need driving.
const mockCameraState = {
  hasPermission: false,
  canRequestPermission: true,
  requestPermission: jest.fn(async () => false),
  device: { id: 'mock-cam' } as { id: string } | null,
  /**
   * Which sensor the screen last asked for. The default is load-bearing: the
   * capture protocol puts the phone at the shooter's side 2–4 m away, where
   * the front preview cannot be read — and defaulting to BACK also keeps the
   * whole front-camera path out of a demo.
   */
  position: null as 'front' | 'back' | null,
};
jest.mock('react-native-vision-camera', () => ({
  __esModule: true,
  Camera: () => null,
  useCameraDevice: (position: 'front' | 'back') => {
    mockCameraState.position = position;
    return mockCameraState.device;
  },
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

/**
 * The pose loader is per-test mutable (v3): the loader ladder now warms the
 * interpreter up before publishing it, reports its failure instead of
 * swallowing it, and offers a Retry that re-enters the effect — none of which
 * is observable while the mock never resolves.
 *
 * 'pending' is the v2 default and stays the default: the effect hangs, so
 * there is no act() noise and the states under test never need a model.
 */
const mockTflite: {
  mode: 'pending' | 'ok' | 'fail';
  calls: number;
  warmRuns: number;
} = { mode: 'pending', calls: 0, warmRuns: 0 };
jest.mock('react-native-fast-tflite', () => ({
  __esModule: true,
  loadTensorflowModel: () => {
    mockTflite.calls++;
    if (mockTflite.mode === 'pending') return new Promise(() => {});
    if (mockTflite.mode === 'fail') return Promise.reject(new Error('no delegate'));
    return Promise.resolve({
      inputs: [{ name: 'in', dataType: 'uint8', shape: [1, 192, 192, 3] }],
      outputs: [],
      delegates: [],
      runSync: () => [],
      run: async () => {
        mockTflite.warmRuns++;
        return [];
      },
    });
  },
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
  chipGauges,
  formSessionRowOf,
  frameStall,
  guidanceBanner,
  lowConfidenceLine,
  orientationChipHint,
  orientationChipLabel,
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
import { useSettings } from '@/state/settingsStore';

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

/** Press the first control carrying `label` as its accessibility label. */
async function pressA11y(r: ReactTestRenderer, label: string): Promise<void> {
  const target = r.root.findAll(
    (n) =>
      typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === label,
  )[0];
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
  mockCameraState.device = { id: 'mock-cam' };
  mockCameraState.position = null;
  mockProfileState.heightCm = null;
  mockTflite.mode = 'pending';
  mockTflite.calls = 0;
  mockTflite.warmRuns = 0;
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

  it('names the sensitivity the relaxed motion thresholds bought', async () => {
    // The core now counts a slow, ball-free motion on purpose. The guide has
    // to say what that costs BEFORE the room sees an arm raise count.
    const r = await render(<FormCheckScreen />);
    const text = textOf(r.toJSON());
    expect(text).toContain('counts shooting MOTIONS');
    expect(text).toContain('a raised arm can count');
    await unmount(r);
  });

  it('asks for the camera at MOUNT, and offers the fix on the guide if refused', async () => {
    // The OS dialog must resolve while the presenter reads the guide, never
    // three interactions deep in front of judges.
    const r = await render(<FormCheckScreen />);
    expect(mockCameraState.requestPermission).toHaveBeenCalledTimes(1);
    expect(textOf(r.toJSON())).toContain('Allow camera access');
    await unmount(r);
  });

  it('a permanently refused camera points at Settings from the guide', async () => {
    mockCameraState.canRequestPermission = false;
    const r = await render(<FormCheckScreen />);
    expect(textOf(r.toJSON())).toContain('Open settings for camera access');
    await unmount(r);
  });

  it('a granted camera adds no permission pill', async () => {
    mockCameraState.hasPermission = true;
    const r = await render(<FormCheckScreen />);
    expect(mockCameraState.requestPermission).not.toHaveBeenCalled();
    expect(textOf(r.toJSON())).not.toContain('Allow camera access');
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Pose loader (v3): warm-up, the failure that used to be swallowed, Retry

describe('FormCheck — pose model loading', () => {
  beforeEach(() => {
    mockCameraState.hasPermission = true;
  });

  it('warms the interpreter up BEFORE publishing the model', async () => {
    // loadTensorflowModel resolves as soon as the delegate is constructed —
    // the CoreML graph compile happens on the first Invoke. Without these two
    // throwaway runs that Invoke is the first camera frame, on stage, with
    // the screen already claiming it has finished warming up.
    mockTflite.mode = 'ok';
    const r = await render(<FormCheckScreen />);
    expect(mockTflite.warmRuns).toBe(2);
    await unmount(r);
  });

  it('a loaded model stops the warmup line and says the camera is starting', async () => {
    mockTflite.mode = 'ok';
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    const text = textOf(r.toJSON());

    expect(text).not.toContain('Warming up the pose model');
    // Zero frames so far: "no data yet" is its OWN state. Blaming the room's
    // lighting before a frame has landed is the first thing an audience reads.
    expect(text).toContain('Starting the camera…');
    expect(text).not.toContain('More light helps');
    expect(text).not.toContain('Pose is at');
    await unmount(r);
  });

  it('both rungs failing says so and offers Retry, which reloads', async () => {
    mockTflite.mode = 'fail';
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');

    const text = textOf(r.toJSON());
    expect(text).toContain("The pose model didn't load — tap Retry.");
    // Still the honest paused contract, never a silent dead screen.
    expect(text).toContain('paused');

    // Both rungs (accelerated + CPU) were tried before giving up.
    expect(mockTflite.calls).toBe(2);
    const before = mockTflite.calls;
    mockTflite.mode = 'ok';
    await pressButton(r, 'Retry');
    expect(mockTflite.calls).toBeGreaterThan(before);
    expect(textOf(r.toJSON())).not.toContain("didn't load");
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

  it('Recalibrate is a HOLD — a stray tap only hints', async () => {
    // A tap used to drop an armed session back into calibration: the counter
    // freezes and nothing at the bottom of the screen, where the presenter is
    // looking, changes. It reads as "the detector stopped working".
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');

    const pill = r.root.findAll((n) => n.props?.accessibilityLabel === 'Recalibrate')[0]!;
    expect(typeof pill.props.onLongPress).toBe('function');

    await act(async () => {
      (pill.props.onPress as () => void)();
    });
    expect(textOf(r.toJSON())).toContain('Hold to recalibrate');
    // Still calibrating from the SAME session — the tap reset nothing.
    expect(textOf(r.toJSON())).toContain('PRACTICE MOTION 1 OF 2');

    await unmount(r);
  });

  it('Restart begins a fresh session without leaving the live view', async () => {
    // Ranked demo failure #7: no way to restart quickly after a stumble.
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    await pressButton(r, 'Skip');
    expect(textOf(r.toJSON())).not.toContain('PRACTICE MOTION');

    await pressButton(r, 'Restart');
    // The rail re-reads the session on its own 4 Hz poll (it is not
    // remounted), so let one tick land before asserting.
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    const text = textOf(r.toJSON());
    // Back to a brand-new session's calibration, still live, no guide detour.
    expect(text).toContain('PRACTICE MOTION 1 OF 2');
    expect(text).not.toContain('Check your shooting motion');

    await unmount(r);
  });

  it('no enumerated camera says so instead of blaming the room', async () => {
    // The permission wall used to be gated on `device != null`, so a null
    // device rendered a black scrim whose only content read "too slow. More
    // light helps." with no action.
    mockCameraState.device = null;
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');

    const text = textOf(r.toJSON());
    expect(text).toContain('No camera available');
    expect(text).not.toContain('More light helps');
    await unmount(r);
  });

  it('a missing device does NOT hide the permission wall', async () => {
    mockCameraState.hasPermission = false;
    mockCameraState.device = null;
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    expect(textOf(r.toJSON())).toContain('Camera access needed');
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// The watched arm — seeded from Settings, which rehydrates LATE

describe('FormCheck — shooting hand from Settings', () => {
  const ARM_CHIP_RIGHT =
    'Watching your right arm (assumed from Settings). Tap to watch the other arm.';

  beforeEach(() => {
    jest.useFakeTimers();
    mockCameraState.hasPermission = true;
  });
  afterEach(() => {
    jest.useRealTimers();
    // Never leak the pick into the next test — the store is a real one.
    useSettings.setState({ shootingHand: 'right' });
  });

  it('adopts a hand that rehydrated AFTER the first render', async () => {
    // The settings store persists through expo-sqlite and rehydrates
    // ASYNCHRONOUSLY, so the screen's `useState`/`useRef` seeds run against
    // the built-in 'right' default. Without the guide-phase re-sync a
    // left-handed session was measured end to end on the arm they don't
    // shoot with — every angle, every phase timing, every spread, and the
    // persisted hand column.
    const r = await render(<FormCheckScreen />);
    await act(async () => {
      useSettings.setState({ shootingHand: 'left' });
    });
    await pressButton(r, 'Start form check');
    await pressButton(r, 'Skip');
    expect(textOf(r.toJSON())).toContain('ASSUMED LEFT');
    await unmount(r);
  });

  it('never re-syncs mid-session, and never over the human’s own pick', async () => {
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    await pressButton(r, 'Skip');
    expect(textOf(r.toJSON())).toContain('ASSUMED RIGHT');

    // The presenter's call: LEFT, manual.
    await pressA11y(r, ARM_CHIP_RIGHT);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    expect(textOf(r.toJSON())).toContain('LEFT ARM');

    // A store change landing MID-CAPTURE must not move the watched arm: the
    // session is already measuring one, and switching arms underneath it
    // would split a single report across two of them.
    await act(async () => {
      useSettings.setState({ shootingHand: 'right' });
      jest.advanceTimersByTime(400);
    });
    expect(textOf(r.toJSON())).toContain('LEFT ARM');

    // Back on the guide the sync is allowed to run again — but a manual pick
    // is a statement about the SHOOTER, so it outranks the Settings default.
    await pressButton(r, 'Cancel');
    await pressButton(r, 'Start form check');
    await pressButton(r, 'Skip');
    expect(textOf(r.toJSON())).toContain('LEFT');
    expect(textOf(r.toJSON())).not.toContain('RIGHT');

    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// V4 — the camera default and the buffer-orientation chip

describe('FormCheck — camera default', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens on the BACK sensor, not the front one', async () => {
    // The protocol props the phone at the shooter's SIDE, 2–4 m away: the
    // front preview was never readable from there, and the back sensor is
    // the better one. It also keeps the entire front-camera path — mirroring
    // included — out of a demo.
    const r = await render(<FormCheckScreen />);
    expect(mockCameraState.position).toBe('back');
    await unmount(r);
  });

  it('the guide asks for the CAMERA to point at you, not the screen', async () => {
    const r = await render(<FormCheckScreen />);
    const text = textOf(r.toJSON());
    expect(text).toContain('camera pointing at you');
    expect(text).not.toContain('screen facing you');
    await unmount(r);
  });

  it('keeps the one-tap flip to the front camera', async () => {
    mockCameraState.hasPermission = true;
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    expect(mockCameraState.position).toBe('back');

    await pressA11y(r, 'Switch to the front camera');
    expect(mockCameraState.position).toBe('front');
    await unmount(r);
  });
});

describe('FormCheck — buffer orientation chip', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCameraState.hasPermission = true;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Live, past calibration, on the chip row — where the VIEW chip lives. */
  async function armedRail(): Promise<ReactTestRenderer> {
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    await pressButton(r, 'Skip');
    return r;
  }

  it('says UNVERIFIED until the detector commits — never a silent "upright"', async () => {
    // No frames reach the detector under jest, which IS the honest zero-frame
    // state: nothing was verified, so nothing is corrected and the chip says
    // exactly that. A green "upright" here would be a claim about a check
    // that never ran.
    const r = await armedRail();
    const text = textOf(r.toJSON());
    expect(text).toContain('VIEW UNVERIFIED');
    expect(text).not.toContain('VIEW UPRIGHT');
    expect(text).not.toContain('FLIP FIXED');

    const chip = r.root.findAll(
      (n) =>
        typeof n.props?.onPress === 'function' &&
        typeof n.props?.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Camera orientation unverified'),
    )[0];
    expect(chip).toBeDefined();
    expect(String(chip!.props.accessibilityLabel)).toContain('left uncorrected');

    await unmount(r);
  });

  it('carries the VIEW chip DURING calibration, not only past it', async () => {
    // Collecting is the exact window the verdict is designed to settle in.
    // The chip row used to render only in the armed branch, so through that
    // whole phase the verdict was invisible and the override untappable —
    // the honesty contract, unreachable precisely where it is relied on.
    // (armedRail() presses Skip first, which is why it could not see this.)
    const r = await render(<FormCheckScreen />);
    await pressButton(r, 'Start form check');
    let text = textOf(r.toJSON());
    expect(text).toContain('PRACTICE MOTION 1 OF 2');
    expect(text).toContain('VIEW UNVERIFIED');

    // And it takes the override right there, without leaving calibration.
    await pressButton(r, 'VIEW UNVERIFIED');
    text = textOf(r.toJSON());
    expect(text).toContain('FLIP FIXED · MANUAL');
    expect(text).toContain('PRACTICE MOTION 1 OF 2');
    await unmount(r);
  });

  it('one tap latches the human call, and taps back the other way', async () => {
    // The stage recovery: a skeleton on its head must be fixable in one tap,
    // and a wrong tap undone in one more. Manual wins and latches over the
    // detector — src/core/poseOrientation.ts pins that half.
    const r = await armedRail();
    await pressButton(r, 'VIEW UNVERIFIED');
    expect(textOf(r.toJSON())).toContain('FLIP FIXED · MANUAL');

    await pressButton(r, 'FLIP FIXED · MANUAL');
    expect(textOf(r.toJSON())).toContain('VIEW UPRIGHT · MANUAL');
    await unmount(r);
  });

  it('Restart drops the latch back to unverified', async () => {
    const r = await armedRail();
    await pressButton(r, 'VIEW UNVERIFIED');
    expect(textOf(r.toJSON())).toContain('FLIP FIXED · MANUAL');

    await pressButton(r, 'Restart');
    // The rail re-reads the detector on its own 4 Hz poll (it is not
    // remounted), so let one tick land before asserting.
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    await pressButton(r, 'Skip');
    const text = textOf(r.toJSON());
    expect(text).toContain('VIEW UNVERIFIED');
    expect(text).not.toContain('MANUAL');
    await unmount(r);
  });

  it('a camera change drops the latch — a new sensor is a new orientation', async () => {
    const r = await armedRail();
    await pressButton(r, 'VIEW UNVERIFIED');
    expect(textOf(r.toJSON())).toContain('FLIP FIXED · MANUAL');

    await pressA11y(r, 'Switch to the front camera');
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    const text = textOf(r.toJSON());
    expect(text).toContain('VIEW UNVERIFIED');
    expect(text).not.toContain('MANUAL');
    await unmount(r);
  });

  it('the chip sits in the readiness row, beside the other gauges', async () => {
    // Consistency, not a new surface: it renders in the SAME chip row as FPS
    // / BODY / ARM / SIDE, so nothing about the rail moved.
    const r = await armedRail();
    const text = textOf(r.toJSON());
    expect(text).toContain('BODY');
    expect(text).toContain('SIDE');
    expect(text).toContain('ASSUMED RIGHT');
    expect(text).toContain('VIEW UNVERIFIED');
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

  it('a passing-but-angled stance is qualified, a square one is not', async () => {
    // The side gate now passes from SIDE_PROFILE_MIN (≈40° of tolerance) so
    // an ordinary room can be used — but the ANGLES do not survive the same
    // tolerance, and the receipt has to say which side of that line it was on.
    const reps = [rep(1)];
    const angled = reportOf(reps, { calibration: calib({ sidenessAvg: 0.42 }) });
    const r1 = await render(
      <FormCheckReport reps={reps} report={angled} hand="right" savedId={1} />,
    );
    const t1 = textOf(r1.toJSON());
    expect(t1).toContain('42% side-on');
    expect(t1).toContain('2D angles read low');
    await unmount(r1);

    const square = reportOf(reps, { calibration: calib({ sidenessAvg: 0.85 }) });
    const r2 = await render(
      <FormCheckReport reps={reps} report={square} hand="right" savedId={1} />,
    );
    const t2 = textOf(r2.toJSON());
    expect(t2).toContain('85% side-on');
    expect(t2).not.toContain('2D angles read low');
    await unmount(r2);
  });
});

// ---------------------------------------------------------------------------
// Low confidence (v3) — the other half of the relaxed-gate bargain.
//
// The core relaxed its gates so a hoop-free demo in an unknown room can
// happen, and reports on every rep WHY its numbers are worth less. A screen
// that ignores those fields presents a relaxed capture as a clean one, which
// is the one thing the honesty contract forbids.

describe('FormCheckReport — low-confidence reporting', () => {
  it('a clean session says nothing about confidence', async () => {
    const reps = [rep(1, { setPointElbowDeg: 84 }, { lowConfidence: [] })];
    const report = reportOf(reps, { lowConfidence: { reps: 0, reasons: [] } });
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" savedId={1} />,
    );
    expect(textOf(r.toJSON())).not.toContain('relaxed gate');
    await unmount(r);
  });

  it('names how many reps were relaxed, and what each relaxation cost', async () => {
    const reps = [
      rep(1, { setPointElbowDeg: 84 }, { lowConfidence: ['lowPoseFps'] }),
      rep(2, { setPointElbowDeg: 85 }, { lowConfidence: ['angledStance'] }),
      rep(3, { setPointElbowDeg: 86 }),
    ];
    const report = reportOf(reps, {
      lowConfidence: { reps: 2, reasons: ['lowPoseFps', 'angledStance'] },
    });
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" savedId={1} />,
    );
    const text = textOf(r.toJSON());

    expect(text).toContain('2 of 3 reps were caught under a relaxed gate');
    expect(text).toContain('pose ran under 15 fps');
    expect(text).toContain('angled to the camera');
    // The reps are REAL — the line must not read as a disclaimer that they
    // were invented.
    expect(text).toContain('Really measured, just lower-confidence.');
    await unmount(r);
  });

  it('per-rep reasons ride as chips and spell themselves out when expanded', async () => {
    const reps = [
      rep(1, { setPointElbowDeg: 84 }, { lowConfidence: ['gateDropout'] }),
    ];
    const report = reportOf(reps, {
      lowConfidence: { reps: 1, reasons: ['gateDropout'] },
    });
    const r = await render(
      <FormCheckReport reps={reps} report={report} hand="right" savedId={1} />,
    );
    await switchTo(r, 'Reps');
    expect(textOf(r.toJSON())).toContain('landmarks dropped');

    const row = r.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Rep 1 details' &&
        typeof n.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      (row.props.onPress as () => void)();
    });
    expect(textOf(r.toJSON())).toContain('landmarks dropped mid-motion');
    await unmount(r);
  });

  it('lowConfidenceLine: null when clean, "All N" when the whole session was', () => {
    const reps = [rep(1), rep(2)];
    expect(lowConfidenceLine(reportOf(reps))).toBeNull();
    expect(
      lowConfidenceLine(reportOf(reps, { lowConfidence: { reps: 0, reasons: [] } })),
    ).toBeNull();
    const all = lowConfidenceLine(
      reportOf(reps, { lowConfidence: { reps: 2, reasons: ['lowPoseFps'] } }),
    );
    expect(all).toContain('All 2 reps were caught under a relaxed gate');
  });
});

describe('FormCheckReport — one-action restart', () => {
  it('offers Check again, which runs the callback without leaving the report', async () => {
    // Done pops the whole /formcheck route, which re-mounts the screen and
    // re-pays the model load — dead air at the exact moment after a stumble.
    const reps = [rep(1, { setPointElbowDeg: 84 })];
    const onAgain = jest.fn();
    const r = await render(
      <FormCheckReport
        reps={reps}
        report={reportOf(reps)}
        hand="right"
        savedId={1}
        onAgain={onAgain}
      />,
    );
    await pressButton(r, 'Check again');
    expect(onAgain).toHaveBeenCalledTimes(1);
    await unmount(r);
  });

  it('a report with no restart callback still renders (Done only)', async () => {
    const reps = [rep(1)];
    const r = await render(
      <FormCheckReport reps={reps} report={reportOf(reps)} hand="right" savedId={1} />,
    );
    expect(textOf(r.toJSON())).not.toContain('Check again');
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

  // RE-PINNED (v3 stage hardening): the report now OPENS on Compare whenever
  // a rep captured a decodable motion, so the best-rep card — which lives on
  // Overview — is no longer the mount-time tab. Every assertion is kept, with
  // one explicit hop to Overview in front of them; the jump-into-Compare
  // contract this test exists for is unchanged and still asserted.
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

    await switchTo(r, 'Overview');
    expect(textOf(r.toJSON())).toContain('elbow 88° in band');
    await pressButton(r, 'View in Compare');
    expect(textOf(r.toJSON())).toContain('MOTION_STAGE');
    await unmount(r);
  });

  it('opens ON the theater when a rep decoded, on Overview when none did', async () => {
    // A stage demo is two or three reps: Overview would greet the room with a
    // nag headline and four em dashes while the showpiece sat one tap away.
    const seq = realSequence();
    const withMotion = [rep(1, { setPointElbowDeg: 88 }, { sequence: seq })];
    const r1 = await render(
      <FormCheckReport
        reps={withMotion}
        report={reportOf(withMotion)}
        hand="right"
        savedId={1}
      />,
    );
    expect(textOf(r1.toJSON())).toContain('MOTION_STAGE');
    await unmount(r1);

    // Nothing decodable ⇒ the old default stands, no empty theater on mount.
    const flat = [rep(1), rep(2)];
    const r2 = await render(
      <FormCheckReport reps={flat} report={reportOf(flat)} hand="right" savedId={1} />,
    );
    const text = textOf(r2.toJSON());
    expect(text).not.toContain('MOTION_STAGE');
    expect(text).toContain('CONSISTENCY');
    await unmount(r2);
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

  it('a dead loader outranks everything and names the recovery', () => {
    // The ladder used to exhaust itself with a bare catch: model stayed null,
    // the rail said "Warming up the pose model…" forever, and rep counting
    // was silently dead behind a live preview.
    const b = guidanceBanner(false, readyAll, 'right', null, false, {
      modelErr: 'no delegate',
    });
    expect(b).toEqual({ text: "The pose model didn't load — tap Retry.", pauses: true });
    // Even with a loaded model and every gate green, the error still wins.
    expect(
      guidanceBanner(true, readyAll, 'right', null, false, { modelErr: 'boom' })!.text,
    ).toContain('Retry');
  });

  it('"no frame yet" is its own state, never a lighting complaint', () => {
    // medianFps returns 0 until two samples exist, so EVERY session used to
    // open by telling the room the light was bad.
    const noData = { ...readyAll, fps: 0, fpsOk: false, ready: false };
    expect(guidanceBanner(true, noData, 'right', null, false)!).toEqual({
      text: 'Starting the camera…',
      pauses: true,
    });
    // Frames not arrived yet, even with a measured rate carried over.
    expect(
      guidanceBanner(true, readyAll, 'right', null, false, { warming: true })!.text,
    ).toBe('Starting the camera…');
    // A MEASURED sub-floor rate still reports the number.
    expect(
      guidanceBanner(true, { ...readyAll, fps: 12, fpsOk: false, ready: false }, 'right', null, false)!
        .text,
    ).toContain('12 fps');
  });

  it('the too-slow line names the flip button on the front camera', () => {
    // "More light helps" is not an instruction a presenter can follow on
    // stage. The back camera has a materially larger aperture and the flip
    // pill is already on screen.
    const slow = { ...readyAll, fps: 11, fpsOk: false, ready: false };
    expect(
      guidanceBanner(true, slow, 'right', null, false, { camPosition: 'front' })!.text,
    ).toContain('Tap flip for the back camera');
    expect(
      guidanceBanner(true, slow, 'right', null, false, { camPosition: 'back' })!.text,
    ).toContain('More light helps');
  });

  it('an fps override is stated as an advisory and never pauses', () => {
    // MIN_POSE_FPS never moved: the override is carrying fpsOk, so the screen
    // has to say the timing numbers are worth less.
    const over = { ...readyAll, fps: 11, fpsOk: true, fpsOverridden: true };
    const b = guidanceBanner(true, over, 'right', null, false)!;
    expect(b.pauses).toBe(false);
    expect(b.text).toContain('below the 15 fps floor');
    expect(b.text).toContain('low-confidence');
    // A hard gate still outranks it — that message is actionable.
    expect(
      guidanceBanner(true, { ...over, fullBodyOk: false, ready: false }, 'right', null, false)!.text,
    ).toContain('Step back');
  });

  it('a measured-but-angled stance is qualified; an unmeasurable one is not', () => {
    const angled = { ...readyAll, sideness: 0.45, sideOk: true, sideTrusted: false };
    const b = guidanceBanner(true, angled, 'right', null, false)!;
    expect(b.pauses).toBe(false);
    expect(b.text).toContain('Angled to the camera');
    // sideness null = the gauge could not vote. Occlusion is not evidence of
    // facing the camera, so nothing is claimed either way.
    expect(
      guidanceBanner(
        true,
        { ...angled, sideness: null },
        'right',
        null,
        false,
      ),
    ).toBeNull();
  });

  it('a stalled pose loop outranks the readiness verdict it froze', () => {
    // FormCheckSession recomputes readiness only inside push(), so a dead
    // loop leaves the LAST frame's verdict on the rail forever: green chips
    // and "Ready — shoot when you like." over a skeleton that stopped moving.
    // The stall has to win over that, and over a stale failing gate too.
    expect(guidanceBanner(true, readyAll, 'right', null, false, { stalled: true })).toEqual({
      text: 'No camera frames — the pose loop stalled.',
      pauses: true,
    });
    expect(
      guidanceBanner(
        true,
        { ...readyAll, fpsOk: false, fps: 9, ready: false },
        'right',
        null,
        false,
        { stalled: true },
      )!.text,
    ).toContain('stalled');
  });

  it('a stall never displaces the cold-start or dead-loader copy', () => {
    // Before the first frame the honest state is "Starting the camera…" —
    // frameStall is what keeps `stalled` false there, but the ORDER is
    // pinned here so a future edit cannot call every cold start a failure.
    expect(
      guidanceBanner(true, readyAll, 'right', null, false, { warming: true, stalled: true })!.text,
    ).toBe('Starting the camera…');
    expect(
      guidanceBanner(true, readyAll, 'right', null, false, { modelErr: 'boom', stalled: true })!
        .text,
    ).toContain("didn't load");
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

describe('frameStall', () => {
  it('never arms before the first frame — a cold start is not a stall', () => {
    // "Starting the camera…" owns the pre-first-frame state. Arming here
    // would label every slow camera open a failure.
    expect(frameStall(0, 5_000, false)).toBe(false);
  });

  it('holds while the counter is still advancing', () => {
    expect(frameStall(7, 250, true)).toBe(false);
    // Even ONE frame in the window is a loop that is alive.
    expect(frameStall(1, 5_000, true)).toBe(false);
  });

  it('arms only once the counter has stood still past the window', () => {
    // 0, 1 and 3 poll ticks of 250 ms since the last frame actually landed —
    // only the third clears the 750 ms window.
    expect(frameStall(0, 0, true)).toBe(false);
    expect(frameStall(0, 250, true)).toBe(false);
    expect(frameStall(0, 750, true)).toBe(true);
  });
});

describe('armChipLabel', () => {
  it('prefixes per source and never says "detected" for an abstain', () => {
    expect(armChipLabel('right', 'settings')).toBe('ASSUMED RIGHT');
    expect(armChipLabel('left', 'auto')).toBe('AUTO LEFT');
    expect(armChipLabel('left', 'manual')).toBe('LEFT ARM');
  });
});

describe('chipGauges — a gauge may only read green while it is reading', () => {
  // `readiness` is a LATCHED verdict from the last frame that arrived. Drawing
  // it while no frame is arriving is the rail claiming a measurement it is not
  // taking, which is the same over-claim the app refuses to make about a shot.
  const green = {
    fps: 30,
    fpsOk: true,
    fpsOverridden: false,
    fullBodyOk: true,
    armOk: true,
    sideOk: true,
  } as unknown as Parameters<typeof chipGauges>[0];

  it('passes a live verdict through untouched', () => {
    expect(chipGauges(green)).toEqual({
      fps: 30,
      fpsOk: true,
      overridden: false,
      fullBodyOk: true,
      armOk: true,
      sideOk: true,
    });
  });

  it('refuses every gauge while STALLED, however green the last verdict was', () => {
    const g = chipGauges(green, { stalled: true });
    expect(g).toEqual({
      fps: 0,
      fpsOk: false,
      overridden: false,
      fullBodyOk: false,
      armOk: false,
      sideOk: false,
    });
  });

  it('refuses every gauge while WARMING — the common case, and the one that leaked', () => {
    // Returning from the background stops and restarts the capture session.
    // For the ~1s reacquire the verdict is pre-interruption; it used to render
    // green underneath a banner saying the camera was starting. The stall path
    // was covered from the start and this one was not, which is exactly why
    // the rule lives in one pure function now.
    const g = chipGauges(green, { warming: true });
    expect(g).toEqual({
      fps: 0,
      fpsOk: false,
      overridden: false,
      fullBodyOk: false,
      armOk: false,
      sideOk: false,
    });
  });

  it('never shows an OVERRIDE as a passing rate, and never while blind', () => {
    const overridden = { ...(green as object), fpsOk: false, fpsOverridden: true } as Parameters<
      typeof chipGauges
    >[0];
    expect(chipGauges(overridden).overridden).toBe(true);
    expect(chipGauges(overridden).fpsOk).toBe(false);
    expect(chipGauges(overridden, { warming: true }).overridden).toBe(false);
  });

  it('does not let the open-by-default side gate turn green while blind', () => {
    // sideOk defaults TRUE when unknown, so it is the one gauge that could go
    // green purely because nothing contradicted it while nothing was watching.
    expect(chipGauges(null).sideOk).toBe(true);
    expect(chipGauges(null, { warming: true }).sideOk).toBe(false);
    expect(chipGauges(null, { stalled: true }).sideOk).toBe(false);
  });

  it('is already honest on a cold start, with no verdict at all', () => {
    expect(chipGauges(null)).toEqual({
      fps: 0,
      fpsOk: false,
      overridden: false,
      fullBodyOk: false,
      armOk: false,
      sideOk: true,
    });
  });
});

describe('orientationChipLabel / orientationChipHint', () => {
  it('an uncommitted verdict reads UNVERIFIED and promises nothing', () => {
    // The honesty contract: 'unknown' means NOT VERIFIED, never "probably
    // fine". The keypoints go through untouched in that state and the chip
    // has to say so.
    expect(orientationChipLabel('unknown', null)).toBe('VIEW UNVERIFIED');
    const hint = orientationChipHint('unknown', null);
    expect(hint).toContain('unverified');
    expect(hint).toContain('left uncorrected');
  });

  it('states the committed verdict and marks the human ones MANUAL', () => {
    expect(orientationChipLabel('upright', 'auto')).toBe('VIEW UPRIGHT');
    expect(orientationChipLabel('flipped', 'auto')).toBe('FLIP FIXED');
    expect(orientationChipLabel('upright', 'manual')).toBe('VIEW UPRIGHT · MANUAL');
    expect(orientationChipLabel('flipped', 'manual')).toBe('FLIP FIXED · MANUAL');
  });

  it('a fired correction names itself, and says whose call it was', () => {
    // A correction nobody can see is a correction nobody can overrule.
    const auto = orientationChipHint('flipped', 'auto');
    expect(auto).toContain('upside down');
    expect(auto).toContain('corrected');
    expect(auto).toContain('auto-detected');
    expect(orientationChipHint('upright', 'manual')).toContain('your pick');
    expect(orientationChipHint('upright', 'auto')).toContain('used as captured');
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

  // Saving must not launder a relaxed capture. The live report already says
  // which reps were caught under a relaxed gate; if the write path drops it,
  // the saved copy reads exactly like a clean check forever after.
  it('the relaxed-gate receipt survives the write — per rep AND session-level', () => {
    const reps = [
      rep(1, { setPointElbowDeg: 84 }, { lowConfidence: ['lowPoseFps'] }),
      rep(2, { setPointElbowDeg: 86 }, { lowConfidence: [] }),
    ];
    const report = reportOf(reps, {
      lowConfidence: { reps: 1, reasons: ['lowPoseFps'] },
    });
    const summary = JSON.parse(formSessionRowOf(report, reps, 1).summaryJson) as {
      reps: { lowConfidence: string[] }[];
      lowConfidence: { reps: number; reasons: string[] };
    };

    expect(summary.reps[0]!.lowConfidence).toEqual(['lowPoseFps']);
    expect(summary.reps[1]!.lowConfidence).toEqual([]);
    expect(summary.lowConfidence).toEqual({ reps: 1, reasons: ['lowPoseFps'] });
  });

  it('a clean session persists an EMPTY receipt, never a missing one', () => {
    const reps = [rep(1, {}, { lowConfidence: [] })];
    const report = reportOf(reps, { lowConfidence: { reps: 0, reasons: [] } });
    const summary = JSON.parse(formSessionRowOf(report, reps, 1).summaryJson) as {
      lowConfidence: { reps: number; reasons: string[] };
    };
    expect(summary.lowConfidence).toEqual({ reps: 0, reasons: [] });
  });
});
