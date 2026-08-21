/**
 * Height picker — the onboarding step where the player sets their height.
 *
 * Two things are pinned here.
 *
 * 1. THE NUMBER IS ON SCREEN. The reported bug was a height step with no
 *    number at all. The value was never the problem (see
 *    numberSliderReadout.test.tsx for the readout shape that ate it) — this
 *    suite guards the screen-level result: a visible numeral, with a visible
 *    unit, before the player touches anything.
 *
 * 2. cm <-> ft/in SWITCHING. Imperial players think in feet and inches, so the
 *    readout must say 5'11" rather than 71. The STORED value stays canonical
 *    centimetres whichever unit is on screen, the choice is remembered in
 *    settingsStore like every other preference, and switching units cannot
 *    change the height that gets saved by more than the one-inch resolution of
 *    the imperial readout.
 */
jest.mock('react-native-reanimated', () => {
  const RN = require('react-native');
  const anim = { duration: () => anim, delay: () => anim, reduceMotion: () => anim };
  return {
    __esModule: true,
    default: { View: RN.View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: anim,
    FadeInDown: anim,
    FadeOut: anim,
    ReduceMotion: { System: 'system' },
    runOnJS: (fn: unknown) => fn,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => true,
    withTiming: (v: unknown) => v,
  };
});
jest.mock('react-native-gesture-handler', () => {
  const g = () => {
    const o: Record<string, unknown> = {};
    o.onBegin = () => o;
    o.onUpdate = () => o;
    o.onEnd = () => o;
    return o;
  };
  return {
    Gesture: { Pan: g, Tap: g, Race: (...a: unknown[]) => a },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  NotificationFeedbackType: {},
  ImpactFeedbackStyle: {},
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({ router: { replace: jest.fn(), push: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-sqlite/kv-store', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));
// Skia-backed decoration — out of scope and unloadable under jest.
jest.mock('@/components/motion', () => ({
  __esModule: true,
  SuccessBurst: () => null,
  MotionStat: () => null,
  ArcReveal: () => null,
  arcMotif: () => ({ path: '' }),
}));

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { DEFAULT_HEIGHT_CM, useProfile } from '@/state/profileStore';
import { useSettings } from '@/state/settingsStore';

import Onboarding from '../../app/onboarding';

type Json = ReturnType<ReactTestRenderer['toJSON']>;

function textOf(json: Json | string): string {
  if (json == null) return '';
  if (typeof json === 'string') return json;
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  return (json.children ?? []).map(textOf).join(' ');
}

/** Render the wizard and walk it forward to the height question (step 2). */
function atHeightStep(): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<Onboarding />);
  });
  const advance = () => {
    const btns = r.root
      .findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
      .filter(
        (n) =>
          n.props.accessibilityLabel !== 'Back' &&
          n.props.accessibilityLabel !== 'Skip this question',
      );
    act(() => {
      btns[btns.length - 1]!.props.onPress();
    });
  };
  advance(); // welcome -> nickname
  advance(); // nickname -> height
  return r;
}

/** Press a chip / control by its accessible name. */
function press(r: ReactTestRenderer, label: string) {
  const node = r.root.findAll(
    (n) => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === label,
  )[0];
  expect(node).toBeDefined();
  act(() => {
    node!.props.onPress();
  });
}

function commit(r: ReactTestRenderer) {
  const btns = r.root
    .findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
    .filter(
      (n) =>
        n.props.accessibilityLabel !== 'Back' && n.props.accessibilityLabel !== 'Skip this question',
    );
  act(() => {
    btns[btns.length - 1]!.props.onPress();
  });
}

/** The adjustable slider's accessible name — the only readout a11y ever sees. */
function sliderLabel(r: ReactTestRenderer): string {
  const adj = r.root.findAll((n) => n.props.accessibilityRole === 'adjustable')[0];
  expect(adj).toBeDefined();
  return String(adj!.props.accessibilityLabel);
}

beforeEach(() => {
  useProfile.getState().reset();
  useSettings.getState().set('heightUnit', 'cm');
});

describe('the height question shows a number', () => {
  it('paints the default height and its unit before any interaction', () => {
    const r = atHeightStep();
    const flat = textOf(r.toJSON());
    expect(flat).toContain('How tall are you?');
    expect(flat).toContain(String(DEFAULT_HEIGHT_CM));
    expect(flat).toContain('cm');
  });

  it('announces the number and unit to a screen reader', () => {
    expect(sliderLabel(atHeightStep())).toBe(`Height: ${DEFAULT_HEIGHT_CM} centimetres`);
  });
});

describe('cm <-> ft/in switching', () => {
  it('offers both units on the height step', () => {
    const r = atHeightStep();
    const flat = textOf(r.toJSON());
    expect(flat).toContain('cm');
    expect(flat).toContain('ft · in');
  });

  it('switches the readout to feet and inches', () => {
    const r = atHeightStep();
    press(r, 'ft · in');
    // 178 cm is 70 in.
    expect(textOf(r.toJSON())).toContain("5'10\"");
    expect(sliderLabel(r)).toBe('Height: 5 feet 10 inches');
  });

  it('remembers the choice in the settings store', () => {
    const r = atHeightStep();
    press(r, 'ft · in');
    expect(useSettings.getState().heightUnit).toBe('ftin');
    press(r, 'cm');
    expect(useSettings.getState().heightUnit).toBe('cm');
  });

  it('stores canonical centimetres even when the screen reads imperial', () => {
    const r = atHeightStep();
    press(r, 'ft · in');
    commit(r);
    const stored = useProfile.getState().heightCm;
    expect(stored).not.toBeNull();
    // Whole centimetres, inside the profile bounds — never inches.
    expect(Number.isInteger(stored)).toBe(true);
    expect(stored).toBe(DEFAULT_HEIGHT_CM);
  });

  it('does not walk the value when the unit is toggled repeatedly', () => {
    const r = atHeightStep();
    for (let i = 0; i < 6; i++) {
      press(r, 'ft · in');
      press(r, 'cm');
    }
    commit(r);
    expect(useProfile.getState().heightCm).toBe(DEFAULT_HEIGHT_CM);
  });

  it('honours a unit already chosen before the wizard opens', () => {
    useSettings.getState().set('heightUnit', 'ftin');
    const r = atHeightStep();
    expect(textOf(r.toJSON())).toContain("5'10\"");
  });
});
