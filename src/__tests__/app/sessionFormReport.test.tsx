/**
 * SessionFormReport render contract — the automatic report's honesty seams.
 *
 * WHY these cases: this card is the only place the app analyses a shot nobody
 * asked it to analyse, so both halves of that promise need pinning.
 *
 *  1. It renders the PICK's real analysis. Cue text, drills, the archetype
 *     line and the "why this shot" sentence are all compared against what the
 *     REAL cores returned for exactly this input (pickShotOfSession /
 *     posturePlan / matchArchetype are imported, never stubbed) — so a core
 *     that drifts away from the copy fails here instead of shipping.
 *  2. It offers the other made shots and actually SWAPS: the alternatives
 *     strip lists every analysable make, misses never appear in it, and a tap
 *     moves the whole report onto the chosen shot — including dropping the
 *     picker's "most analysable" claim, which belongs to the automatic pick
 *     alone.
 *  3. Every honest empty state renders its own gap: form analysis off (with
 *     the route to the setting), no made shot, and a made shot whose pose
 *     capture is too thin. Plus the ordering rule that matters for history
 *     sessions — a real capture still renders when the SETTING is off today.
 *
 * Mock set follows src/__tests__/app/bodyDirectionCard.test.tsx (reanimated /
 * icons / router / safe-area / haptics), plus the in-memory kv-store so the
 * REAL settings store drives the form-analysis gate.
 */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks

// Reanimated's worklets runtime can't load under jest without native modules.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({}) },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  LinearTransition: { duration: () => ({}) },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The single settings-gated haptics gateway (never expo-haptics directly).
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

// Persistence is zustand middleware, not under test — the same in-memory map
// the store tests use, so the real settings store (and its selectors) run.
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

import { SessionFormReport, verdictLine } from '@/components/SessionFormReport';
import { SEQ_SCALE, SEQ_MISSING, SEQ_KEYPOINT_ORDER } from '@/core/formSequence';
import { PLAYER_ARCHETYPES } from '@/core/nbaBenchmarks';
import { referenceSequence } from '@/core/nbaReferenceForms';
import { posturePlan } from '@/core/postureFix';
import { matchArchetype } from '@/core/shotLab';
import { describeCandidate, pickShotOfSession, scoreCandidate } from '@/core/shotOfSession';
import type {
  FormMetrics,
  FormSequence,
  PoseKeypointName,
  ResolvedShot,
  ShotOutcome,
} from '@/core/types';
import { useSettings } from '@/state/settingsStore';

const routerMod = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
const hapticsMod = jest.requireMock('@/utils/haptics') as {
  haptic: Record<string, jest.Mock>;
};

// ---------------------------------------------------------------------------
// Helpers

async function render(el: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  await act(async () => {});
  return r;
}

/** Unmount inside act — teardown schedules React work like any other update. */
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

/** Flattened copy for "does this line appear anywhere" assertions. */
function textOf(json: Json): string {
  return stringsOf(json).join(' ');
}

/**
 * Every accessibilityLabel in the tree. A label lands on both the composite
 * and its host view, so this collapses them to a set rather than counting
 * nodes (which would assert on react-test-renderer internals).
 */
function labelsOf(r: ReactTestRenderer): Set<string> {
  return new Set(
    r.root
      .findAll((n) => typeof n.props?.accessibilityLabel === 'string')
      .map((n) => n.props.accessibilityLabel as string),
  );
}

/** Press the first pressable whose accessibilityLabel starts with `prefix`. */
async function pressByLabelPrefix(r: ReactTestRenderer, prefix: string): Promise<void> {
  const target = r.root.findAll(
    (n) =>
      typeof n.props?.accessibilityLabel === 'string' &&
      (n.props.accessibilityLabel as string).startsWith(prefix) &&
      typeof n.props?.onPress === 'function',
  )[0];
  expect(target).toBeDefined();
  await act(async () => {
    (target!.props.onPress as () => void)();
  });
}

/** Press the card's single action button (EmptyState renders exactly one). */
async function pressOnlyButton(r: ReactTestRenderer): Promise<void> {
  const buttons = r.root.findAll(
    (n) => typeof n.props?.onPress === 'function' && n.props?.accessibilityRole === 'button',
  );
  expect(buttons.length).toBeGreaterThan(0);
  await act(async () => {
    (buttons[0]!.props.onPress as () => void)();
  });
}

// ---------------------------------------------------------------------------
// Fixtures

/**
 * A plausible standing pose in the body-relative frame the decoder produces
 * (hip-center origin, +y DOWN, body-heights). Eyes and ears are deliberately
 * absent — a real MoveNet capture from the side loses them constantly, and
 * their absence keeps coverage honestly under 100%.
 */
const POSE: Partial<Record<PoseKeypointName, { x: number; y: number }>> = {
  nose: { x: 0.02, y: -0.5 },
  left_shoulder: { x: -0.14, y: -0.42 },
  right_shoulder: { x: 0.14, y: -0.42 },
  left_elbow: { x: -0.2, y: -0.22 },
  right_elbow: { x: 0.26, y: -0.18 },
  left_wrist: { x: -0.14, y: -0.34 },
  right_wrist: { x: 0.22, y: -0.48 },
  left_hip: { x: -0.1, y: 0 },
  right_hip: { x: 0.1, y: 0 },
  left_knee: { x: -0.11, y: 0.26 },
  right_knee: { x: 0.11, y: 0.26 },
  left_ankle: { x: -0.11, y: 0.5 },
  right_ankle: { x: 0.11, y: 0.5 },
};

/** `frames` copies of {@link POSE}, packed as a real FormSequence blob. */
function poseSequence(frames: number): FormSequence {
  const data: number[] = [];
  for (let f = 0; f < frames; f++) {
    for (const name of SEQ_KEYPOINT_ORDER) {
      const p = POSE[name];
      if (p == null) data.push(SEQ_MISSING, SEQ_MISSING);
      else data.push(Math.round(p.x * SEQ_SCALE), Math.round(p.y * SEQ_SCALE));
    }
  }
  return { v: 1, hand: 'right', frames, durationSec: 1.2, data };
}

const NO_METRICS: FormMetrics = {
  setPointElbowDeg: null,
  kneeFlexionDeg: null,
  releaseAngleDeg: null,
  entryAngleDeg: null,
  releaseTimeMs: null,
  followThroughHeldMs: null,
  followThroughElbowDeg: null,
  releaseHeightNorm: null,
};

function shot(
  id: number,
  opts: { outcome?: ShotOutcome; frames?: number | null; metrics?: FormMetrics } = {},
): ResolvedShot {
  const frames = opts.frames === undefined ? 24 : opts.frames;
  return {
    id,
    tStart: id,
    tResolved: id + 0.9,
    outcome: opts.outcome ?? 'make',
    signals: { geo: true, net: true, cls: true },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: 45,
    releaseAngleDeg: 52,
    releasePoint: null,
    originX: 0.5,
    originY: 0.8,
    trajectory: [],
    ...(frames != null
      ? { form: { metrics: opts.metrics ?? NO_METRICS, tips: [], sequence: poseSequence(frames) } }
      : {}),
  };
}

/**
 * Three analysable makes of DIFFERENT capture lengths plus one miss. Shot 2
 * has the longest capture, so it is the automatic pick; the miss must never
 * reach the strip.
 */
function session(): ResolvedShot[] {
  return [
    shot(1, { frames: 18 }),
    shot(2, { frames: 24 }),
    shot(3, { frames: 12 }),
    shot(4, { outcome: 'miss' }),
  ];
}

/** The cues the REAL engines produce for one candidate of a session. */
function expectedCues(shots: readonly ResolvedShot[], shotId: number) {
  const candidate = scoreCandidate(shots.find((s) => s.id === shotId)!);
  const archetype = matchArchetype(shots)[0]?.player ?? PLAYER_ARCHETYPES[0]!;
  return posturePlan(
    candidate.sequence,
    referenceSequence(archetype, candidate.hand),
    candidate.hand,
  );
}

beforeEach(() => {
  routerMod.router.push.mockClear();
  Object.values(hapticsMod.haptic).forEach((fn) => fn.mockClear());
  act(() => {
    useSettings.setState({ formAnalysis: true });
  });
});

// ---------------------------------------------------------------------------
// The automatic pick

describe('SessionFormReport — the automatic pick', () => {
  it('renders the picked shot with the cues the core actually produced', async () => {
    const shots = session();
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    const { pick, reason } = pickShotOfSession(shots);
    expect(pick!.id).toBe(2);

    // The pick, its verdict, and the picker's own sentence for choosing it.
    expect(text).toContain('Shot of the session'.toUpperCase());
    expect(text).toContain('Shot 2');
    expect(text).toContain(reason);
    expect(text).toContain('is the most analysable make of this session');

    // Every posture cue and drill comes from posturePlan, verbatim.
    const cues = expectedCues(shots, 2);
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      expect(text).toContain(cue.cue);
      expect(text).toContain(cue.drill);
      expect(text).toContain(cue.joint);
    }

    await unmount(r);
  });

  it('labels the archetype exactly as shotLab reported it, matched or not', async () => {
    const shots = session();
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    const match = matchArchetype(shots)[0] ?? null;
    const archetype = match?.player ?? PLAYER_ARCHETYPES[0]!;
    expect(text).toContain(
      match != null
        ? `Matched from your own shots: ${match.similarity}% similar to ${archetype.name}.`
        : `Not enough measured shots to match you to an archetype yet — comparing against ${archetype.name} as a baseline.`,
    );

    // What to copy is the archetype's own published list, not invented copy.
    for (const line of archetype.whatToCopy) expect(text).toContain(line);
    expect(text).toContain('not motion capture');

    await unmount(r);
  });

  it('renders the metric rows from the reused FormReportCard', async () => {
    const metrics: FormMetrics = { ...NO_METRICS, setPointElbowDeg: 88, kneeFlexionDeg: 130 };
    const shots = [shot(1, { frames: 24, metrics })];
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    expect(text).toContain('Elbow set point');
    expect(text).toContain('88°');
    expect(text).toContain('Knee flexion');
    expect(text).toContain('130°');
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Alternatives

describe('SessionFormReport — swapping shots', () => {
  it('offers every analysable make in the strip and never a miss', async () => {
    const shots = session();
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    expect(text).toContain('Analyse another make'.toUpperCase());
    const labels = labelsOf(r);
    expect(labels).toContain('Analyse shot 1, 18 pose frames tracked');
    expect(labels).toContain('Analyse shot 2, 24 pose frames tracked');
    expect(labels).toContain('Analyse shot 3, 12 pose frames tracked');
    // Shot 4 is the miss — a made-shot report must never offer it.
    expect([...labels].some((l) => l.startsWith('Analyse shot 4'))).toBe(false);

    await unmount(r);
  });

  it('re-analyses the tapped shot and drops the pick-only claim', async () => {
    const shots = session();
    const r = await render(<SessionFormReport shots={shots} />);

    await pressByLabelPrefix(r, 'Analyse shot 3');
    const text = textOf(r.toJSON());

    const chosen = scoreCandidate(shots.find((s) => s.id === 3)!);
    expect(text).toContain(`You chose this one. ${describeCandidate(chosen)}`);
    // The "most analysable" claim belongs to the automatic pick alone.
    expect(text).not.toContain('is the most analysable make of this session');
    expect(text).toContain('12 frames');
    expect(hapticsMod.haptic.selection).toHaveBeenCalled();

    await unmount(r);
  });

  it('hides the strip when there is only one analysable make', async () => {
    const shots = [shot(1, { frames: 24 }), shot(2, { outcome: 'miss' })];
    const r = await render(<SessionFormReport shots={shots} />);
    expect(textOf(r.toJSON())).not.toContain('Analyse another make'.toUpperCase());
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Honest empty states

describe('SessionFormReport — honest empty states', () => {
  it('says form analysis is off and routes to the setting', async () => {
    act(() => {
      useSettings.setState({ formAnalysis: false });
    });
    const shots = [shot(1, { frames: null })];
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    expect(text).toContain('Form analysis is off');
    expect(text).toContain('Shooting form analysis in Settings');
    expect(text).toContain(pickShotOfSession(shots).reason);

    expect(text).toContain('Open Settings');
    await pressOnlyButton(r);
    expect(routerMod.router.push).toHaveBeenCalledWith('/settings');

    await unmount(r);
  });

  it('still renders a real capture when the setting is off today (history sessions)', async () => {
    act(() => {
      useSettings.setState({ formAnalysis: false });
    });
    const r = await render(<SessionFormReport shots={session()} />);
    const text = textOf(r.toJSON());

    expect(text).not.toContain('Form analysis is off');
    expect(text).toContain('Shot 2');
    await unmount(r);
  });

  it('says there is no made shot, in the picker’s own words', async () => {
    const shots = [shot(1, { outcome: 'miss' }), shot(2, { outcome: 'unsure' })];
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    expect(text).toContain('No made shot to break down');
    expect(text).toContain(pickShotOfSession(shots).reason);
    expect(text).toContain('No made shot to analyse');
    await unmount(r);
  });

  it('says a made shot captured no usable pose sequence', async () => {
    const shots = [shot(1, { frames: null }), shot(2, { frames: null })];
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    expect(text).toContain('No usable pose capture');
    expect(text).toContain('none captured a pose sequence');
    await unmount(r);
  });

  it('says a pose capture was too thin, with the numbers behind that call', async () => {
    const shots = [shot(5, { frames: 3 })];
    const r = await render(<SessionFormReport shots={shots} />);
    const text = textOf(r.toJSON());

    expect(text).toContain('No usable pose capture');
    expect(text).toContain('Shot 5 captured only 3 usable pose frames');
    expect(text).toContain('too thin to analyse');
    await unmount(r);
  });
});

// ---------------------------------------------------------------------------
// Verdict copy

describe('verdictLine', () => {
  const target = shot(3);

  it('leads with the headline coaching tip when the tip engine flagged one', () => {
    const line = verdictLine(
      target,
      [
        { metric: 'entryAngleDeg', severity: 1, title: 'Add arc', message: 'x' },
        { metric: 'kneeFlexionDeg', severity: 3, title: 'Bend your knees', message: 'y' },
      ],
      [],
      true,
    );
    expect(line).toBe(
      'Shot 3 is the most analysable make of this session — repeat it, and change one thing: bend your knees.',
    );
  });

  it('never claims metrics were good when the tip engine simply had nothing', () => {
    const cues = expectedCues([target], 3);
    const line = verdictLine(target, [], cues, true);
    expect(line).toContain('nothing in its measured metrics was flagged');
    expect(line).not.toContain('in range');
  });

  it('says nothing stood out rather than inventing a fix', () => {
    expect(verdictLine(target, [], [], false)).toBe(
      'Shot 3 — nothing measurable stood out to fix on this rep.',
    );
  });
});
