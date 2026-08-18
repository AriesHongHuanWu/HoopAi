/**
 * SummaryHero count-up contract (WI-B) — the PTS and FG% columns roll in via
 * MotionStat while everything the honesty rules care about stays put:
 *
 * - MotionStat receives EXACTLY the same numbers StatNumber used to show
 *   (points verbatim; FG% = Math.round(fgPct * 100) with fgPct computed
 *   upstream with unsure shots excluded). Presentation only — never new math.
 * - The MAKES column stays a static StatNumber: "12/20" is a compound string
 *   a count-up cannot roll honestly, so it is not faked.
 * - The 0-attempt session keeps its static '—' (no MotionStat for FG%).
 * - The box-score accessibility summary string is byte-identical to the
 *   pre-count-up copy (the strip stays one accessible container, so the
 *   decorative roll never double-announces).
 * - The unsure integrity line still renders when stats.unsure > 0.
 */
// Reanimated's worklets runtime can't load under jest without native modules.
// Stub just the surface SummaryHero + ui.tsx import — animations are no-ops.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: { duration: () => ({ delay: () => ({}) }) },
  FadeInDown: { duration: () => ({ delay: () => ({}) }) },
  interpolate: () => 0,
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withDelay: (_ms: number, value: unknown) => value,
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

// Icons are decorative here; skip the font machinery.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// The motion module is mocked virtually against the agreed API. The spy
// records every props object so the tests can pin exactly which numbers reach
// the count-up. ArcReveal/arcMotif back the decorative arc band behind the
// strip — stubs only (the band renders after onLayout, which react-test-
// renderer never fires, so it stays out of these trees either way).
jest.mock(
  '@/components/motion',
  () => ({
    __esModule: true,
    MotionStat: jest.fn(() => null),
    ArcReveal: jest.fn(() => null),
    arcMotif: jest.fn((width: number, height: number) => ({
      p0: { x: -24, y: height + 24 },
      c: { x: width * 0.36, y: -height * 0.6 },
      p1: { x: width - 44, y: height * 0.42 },
      path: '',
      pointAt: () => ({ x: 0, y: 0 }),
    })),
  }),
  { virtual: true },
);

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { emptyStats } from '../../core/stats';
import type { SessionStats } from '../../core/types';
import { isPerfectSession, SummaryHero } from '../SummaryHero';

const { MotionStat: mockMotionStat } = jest.requireMock('@/components/motion') as {
  MotionStat: jest.Mock;
};

// ---------------------------------------------------------------------------
// Helpers

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Flatten every rendered string for "does this copy appear" assertions. */
function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

/** Stats fixture: plain-field copy of emptyStats with overrides. SummaryHero
 *  only READS scalar fields, so a spread copy is safe here. */
function makeStats(over: Partial<SessionStats>): SessionStats {
  return { ...emptyStats(), ...over };
}

/** All props objects MotionStat was rendered with, in order. */
function motionStatCalls(): Array<Record<string, unknown>> {
  return mockMotionStat.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(() => {
  mockMotionStat.mockClear();
});

// ---------------------------------------------------------------------------

describe('SummaryHero count-ups (attempts > 0)', () => {
  const stats = makeStats({
    attempts: 20,
    makes: 12,
    misses: 8,
    unsure: 0,
    fgPct: 12 / 20,
    bestStreak: 4,
    points: 27,
  });

  it('rolls FG% via MotionStat with the same rounded value as before', () => {
    render(<SummaryHero stats={stats} />);
    const fg = motionStatCalls().find((p) => p.suffix === '%');
    expect(fg).toBeDefined();
    expect(fg!.value).toBe(Math.round(stats.fgPct * 100)); // 60 — same math
    expect(fg!.label).toBe('field goals');
    expect(fg!.size).toBe('large');
  });

  it('rolls PTS via MotionStat with the verbatim points value', () => {
    render(<SummaryHero stats={stats} />);
    const pts = motionStatCalls().find((p) => p.label === 'pts');
    expect(pts).toBeDefined();
    expect(pts!.value).toBe(27);
    expect(pts!.size).toBe('medium');
    expect(pts!.trigger).toBe(27);
  });

  it('keeps the compound MAKES column a static StatNumber (never rolled)', () => {
    const r = render(<SummaryHero stats={stats} />);
    expect(textOf(r.toJSON())).toContain('12/20');
    // No MotionStat ever receives the makes column.
    for (const call of motionStatCalls()) {
      expect(call.label).not.toBe('makes');
      expect(String(call.value)).not.toContain('/');
    }
    // Exactly two count-ups: FG% and PTS.
    expect(mockMotionStat).toHaveBeenCalledTimes(2);
  });

  it('keeps the box-score accessibility summary byte-identical', () => {
    const r = render(<SummaryHero stats={stats} />);
    const labels: string[] = [];
    for (const node of r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string')) {
      labels.push(node.props.accessibilityLabel as string);
    }
    expect(labels).toContain(
      'Box score. 60% field goals. 12 of 20 makes. 27 points.',
    );
  });
});

describe('SummaryHero with no attempts', () => {
  const stats = makeStats({});

  it("keeps the static '—' StatNumber for FG% (no percent roll)", () => {
    const r = render(<SummaryHero stats={stats} />);
    expect(textOf(r.toJSON())).toContain('—');
    expect(motionStatCalls().find((p) => p.suffix === '%')).toBeUndefined();
  });

  it('announces the no-shots summary unchanged', () => {
    const r = render(<SummaryHero stats={stats} />);
    const node = r.root.findAll(
      (n) => n.props.accessibilityLabel === 'Box score. No shots recorded this session.',
    );
    expect(node.length).toBeGreaterThan(0);
  });
});

describe('SummaryHero honesty surfaces (unchanged by motion)', () => {
  it('still renders the unsure integrity line when unsure > 0', () => {
    const stats = makeStats({
      attempts: 10,
      makes: 5,
      misses: 3,
      unsure: 2,
      fgPct: 5 / 8,
      points: 10,
    });
    const r = render(<SummaryHero stats={stats} />);
    expect(textOf(r.toJSON())).toContain('2 shots unsure — not counted either way');
  });

  it('isPerfectSession still requires a decided, non-trivial sample', () => {
    expect(
      isPerfectSession(makeStats({ attempts: 3, makes: 3, misses: 0, unsure: 0 })),
    ).toBe(true);
    expect(
      isPerfectSession(makeStats({ attempts: 2, makes: 2, misses: 0, unsure: 0 })),
    ).toBe(false);
    expect(
      isPerfectSession(makeStats({ attempts: 4, makes: 3, misses: 0, unsure: 1 })),
    ).toBe(false);
  });
});
