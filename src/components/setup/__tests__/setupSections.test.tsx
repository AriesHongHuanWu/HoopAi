/**
 * CollapsibleSection + SetupSections contract tests.
 *
 * These pin the WI-2 seams that integration relies on:
 * - CollapsibleSection is CONTROLLED (parent owns expanded), body is a
 *   conditional render, and the header speaks its state to screen readers.
 * - Section bodies are pure props-in/callbacks-out — including the drill
 *   guard: an armed coach drill must HIDE the duration/spot chips so a tap
 *   can never silently replace the prescription with plain spot shooting.
 * - SetupSections.tsx never imports store VALUES (type-only imports allowed),
 *   so the bodies stay renderable from props alone.
 */
// Reanimated's worklets runtime can't load under jest without native modules.
// Stub just the surface these components (and ui.tsx) import — everything
// under test renders fine with animations as no-ops.
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

// Icons are decorative in every body under test; skip the font machinery.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// A section header tick routes through the settings-gated gateway; stub it so
// header presses never reach expo-haptics or the settings store.
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

// CalibrationHealthCard subscribes to stores — WI-2 only forwards props to
// it, so mock the boundary and assert the forwarding.
jest.mock('@/components/CalibrationHealthCard', () => ({
  CalibrationHealthCard: jest.fn(() => null),
}));

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { Switch, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { CollapsibleSection } from '../CollapsibleSection';
import {
  CalibrationSectionBody,
  CameraSectionBody,
  CourtBallSectionBody,
  KEEP_OPTIONS,
  ModeSectionBody,
  RecordingSectionBody,
  type ModeSectionBodyProps,
} from '../SetupSections';

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

/** Outermost node carrying this accessibilityLabel (composite Pressable). */
function byLabel(r: ReactTestRenderer, a11yLabel: string) {
  const nodes = r.root.findAll((n) => n.props?.accessibilityLabel === a11yLabel);
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function press(r: ReactTestRenderer, a11yLabel: string) {
  const node = byLabel(r, a11yLabel);
  expect(typeof node.props.onPress).toBe('function');
  act(() => {
    node.props.onPress();
  });
}

// ---------------------------------------------------------------------------

describe('CollapsibleSection', () => {
  it('renders children only when expanded (controlled by the parent)', () => {
    const collapsed = render(
      <CollapsibleSection title="Recording" expanded={false} onToggle={() => {}}>
        <Text>SECTION-BODY</Text>
      </CollapsibleSection>,
    );
    expect(textOf(collapsed.toJSON())).not.toContain('SECTION-BODY');

    const expanded = render(
      <CollapsibleSection title="Recording" expanded onToggle={() => {}}>
        <Text>SECTION-BODY</Text>
      </CollapsibleSection>,
    );
    expect(textOf(expanded.toJSON())).toContain('SECTION-BODY');
  });

  it('speaks its state: label includes subtitle, hint and expanded flip', () => {
    const r = render(
      <CollapsibleSection title="Recording" subtitle="On · Makes only" expanded={false} onToggle={() => {}}>
        <Text>x</Text>
      </CollapsibleSection>,
    );
    const header = byLabel(r, 'Recording, On · Makes only');
    expect(header.props.accessibilityRole).toBe('button');
    expect(header.props.accessibilityState).toEqual({ expanded: false });
    expect(header.props.accessibilityHint).toBe('Expands this section');

    const open = render(
      <CollapsibleSection title="Recording" expanded onToggle={() => {}}>
        <Text>x</Text>
      </CollapsibleSection>,
    );
    const openHeader = byLabel(open, 'Recording');
    expect(openHeader.props.accessibilityState).toEqual({ expanded: true });
    expect(openHeader.props.accessibilityHint).toBe('Collapses this section');
  });

  it('reports header taps via onToggle without mutating anything itself', () => {
    const onToggle = jest.fn();
    const r = render(
      <CollapsibleSection title="Court & ball" expanded={false} onToggle={onToggle}>
        <Text>x</Text>
      </CollapsibleSection>,
    );
    press(r, 'Court & ball');
    expect(onToggle).toHaveBeenCalledTimes(1);
    // Still collapsed — the parent owns the state.
    expect(textOf(r.toJSON())).not.toContain('x');
  });

  it('plainBody still renders header and children', () => {
    const r = render(
      <CollapsibleSection title="Calibration" expanded plainBody onToggle={() => {}}>
        <Text>HEALTH</Text>
      </CollapsibleSection>,
    );
    expect(textOf(r.toJSON())).toContain('CALIBRATION');
    expect(textOf(r.toJSON())).toContain('HEALTH');
  });
});

// ---------------------------------------------------------------------------

const TIMED = [30, 60, 90, 120] as const;
const SPOTS = [3, 5, 7, 10] as const;

function modeProps(over: Partial<ModeSectionBodyProps> = {}): ModeSectionBodyProps {
  return {
    modeName: null,
    modeTagline: null,
    modeId: 'free',
    drillArmed: false,
    needsTimer: false,
    isSpotShooting: false,
    durationSec: 60,
    makesPerSpot: 5,
    onPickDuration: jest.fn(),
    onPickMakes: jest.fn(),
    onChangeMode: jest.fn(),
    timedDurations: TIMED,
    spotTargets: SPOTS,
    ...over,
  };
}

describe('ModeSectionBody', () => {
  it('falls back to Free Play copy and a Choose button when no mode is armed', () => {
    const r = render(<ModeSectionBody {...modeProps()} />);
    const text = textOf(r.toJSON());
    expect(text).toContain('Free Play');
    expect(text).toContain('Just shoot — every make counts.');
    expect(text).toContain('Choose');
    expect(text).not.toContain('Change');
    expect(text).not.toContain('60s');
  });

  it('shows duration chips for timed mode and reports picks', () => {
    const onPickDuration = jest.fn();
    const r = render(
      <ModeSectionBody
        {...modeProps({
          modeName: 'Timed Challenge',
          modeTagline: 'Most makes wins.',
          modeId: 'timed',
          needsTimer: true,
          durationSec: 60,
          onPickDuration,
        })}
      />,
    );
    expect(byLabel(r, '60 seconds').props.accessibilityState).toEqual({ selected: true });
    expect(byLabel(r, '90 seconds').props.accessibilityState).toEqual({ selected: false });
    press(r, '90 seconds');
    expect(onPickDuration).toHaveBeenCalledWith(90);
    expect(textOf(r.toJSON())).toContain('Change');
  });

  it('shows makes-per-spot chips for spot shooting and reports picks', () => {
    const onPickMakes = jest.fn();
    const r = render(
      <ModeSectionBody
        {...modeProps({
          modeName: 'Spot Shooting',
          modeId: 'spotShooting',
          isSpotShooting: true,
          makesPerSpot: 5,
          onPickMakes,
        })}
      />,
    );
    expect(byLabel(r, '5 makes per spot').props.accessibilityState).toEqual({ selected: true });
    press(r, '7 makes per spot');
    expect(onPickMakes).toHaveBeenCalledWith(7);
  });

  it('DRILL GUARD: an armed drill hides both chip blocks and explains why', () => {
    const r = render(
      <ModeSectionBody
        {...modeProps({
          modeName: 'Spot Shooting',
          modeId: 'spotShooting',
          needsTimer: true,
          isSpotShooting: true,
          drillArmed: true,
        })}
      />,
    );
    const text = textOf(r.toJSON());
    expect(text).toContain('Drill rules are set by the drill.');
    expect(r.root.findAll((n) => n.props?.accessibilityLabel === '60 seconds')).toHaveLength(0);
    expect(r.root.findAll((n) => n.props?.accessibilityLabel === '5 makes per spot')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('CameraSectionBody', () => {
  const base = {
    orient: 'portrait' as const,
    onSetOrient: jest.fn(),
    cameraGranted: true,
    canRequest: true,
    onRequestPermission: jest.fn(),
    onOpenSystemSettings: jest.fn(),
    showMicNote: false,
  };

  it('granted state: Ready chip copy, no permission button', () => {
    const r = render(<CameraSectionBody {...base} />);
    const text = textOf(r.toJSON());
    expect(text).toContain('Granted — the live view is ready to go.');
    expect(text).toContain('Ready');
    expect(text).not.toContain('Allow camera access');
    expect(text).not.toContain('Open settings');
  });

  /**
   * The permission CTA is the only role=button node WITHOUT an a11y label in
   * this body (the orientation cards and chips all carry labels) — PillButton
   * exposes its label as rendered text.
   */
  function pressPermissionCta(r: ReactTestRenderer) {
    const ctas = r.root.findAll(
      (n) =>
        typeof n.props?.onPress === 'function' &&
        n.props?.accessibilityRole === 'button' &&
        n.props?.accessibilityLabel == null,
    );
    expect(ctas.length).toBeGreaterThan(0);
    act(() => {
      ctas[0]!.props.onPress();
    });
  }

  it('requestable state routes the button to onRequestPermission', () => {
    const onRequestPermission = jest.fn();
    const r = render(
      <CameraSectionBody {...base} cameraGranted={false} onRequestPermission={onRequestPermission} />,
    );
    const text = textOf(r.toJSON());
    expect(text).toContain('Needed to watch the rim and track shots. Nothing is uploaded.');
    expect(text).toContain('Allow camera access');
    pressPermissionCta(r);
    expect(onRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('hard-denied state routes the button to onOpenSystemSettings', () => {
    const onOpenSystemSettings = jest.fn();
    const r = render(
      <CameraSectionBody
        {...base}
        cameraGranted={false}
        canRequest={false}
        onOpenSystemSettings={onOpenSystemSettings}
      />,
    );
    const text = textOf(r.toJSON());
    expect(text).toContain('Camera access is off. Turn it on in system settings to track shots.');
    expect(text).toContain('Open settings');
    pressPermissionCta(r);
    expect(onOpenSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('orientation cards report selection and reflect the current pick', () => {
    const onSetOrient = jest.fn();
    const r = render(<CameraSectionBody {...base} onSetOrient={onSetOrient} />);
    expect(byLabel(r, 'Portrait — phone propped upright').props.accessibilityState).toEqual({
      selected: true,
    });
    press(r, 'Landscape — phone propped on its side');
    expect(onSetOrient).toHaveBeenCalledWith('landscape');
  });

  it('mic note and placement checklist render in the body', () => {
    const r = render(<CameraSectionBody {...base} showMicNote />);
    const text = textOf(r.toJSON());
    expect(text).toContain('The microphone is only used for game audio in recordings.');
    expect(text).toContain('PLACEMENT CHECKLIST');
    expect(text).toContain('Rim fully visible');
    expect(text).toContain('Good light');

    const noNote = render(<CameraSectionBody {...base} showMicNote={false} />);
    expect(textOf(noNote.toJSON())).not.toContain(
      'The microphone is only used for game audio in recordings.',
    );
  });
});

// ---------------------------------------------------------------------------

describe('RecordingSectionBody', () => {
  it('hides keep-clips chips while recording is off and toggles via the switch', () => {
    const onToggleRecord = jest.fn();
    const r = render(
      <RecordingSectionBody
        recordVideo={false}
        keepMode="makes"
        onToggleRecord={onToggleRecord}
        onSetKeepMode={jest.fn()}
      />,
    );
    expect(textOf(r.toJSON())).not.toContain('Makes only');
    const sw = r.root.findAllByType(Switch)[0]!;
    act(() => {
      sw.props.onValueChange(true);
    });
    expect(onToggleRecord).toHaveBeenCalledWith(true);
  });

  it('shows all four keep options when recording and reports picks', () => {
    const onSetKeepMode = jest.fn();
    const r = render(
      <RecordingSectionBody
        recordVideo
        keepMode="makes"
        onToggleRecord={jest.fn()}
        onSetKeepMode={onSetKeepMode}
      />,
    );
    for (const opt of KEEP_OPTIONS) {
      expect(textOf(r.toJSON())).toContain(opt.label);
    }
    expect(byLabel(r, 'Keep clips: Makes only').props.accessibilityState).toEqual({
      selected: true,
    });
    press(r, 'Keep clips: Every shot');
    expect(onSetKeepMode).toHaveBeenCalledWith('all');
  });
});

// ---------------------------------------------------------------------------

describe('CourtBallSectionBody', () => {
  const base = {
    rimHeightM: 3.05 as const,
    ballSize: 7 as const,
    courtRange: 'auto' as const,
    onSetRimHeight: jest.fn(),
    onSetBallSize: jest.fn(),
    onSetCourtRange: jest.fn(),
  };

  it('reflects current values and reports every pick with typed values', () => {
    const onSetRimHeight = jest.fn();
    const onSetBallSize = jest.fn();
    const onSetCourtRange = jest.fn();
    const r = render(
      <CourtBallSectionBody
        {...base}
        onSetRimHeight={onSetRimHeight}
        onSetBallSize={onSetBallSize}
        onSetCourtRange={onSetCourtRange}
      />,
    );
    expect(byLabel(r, 'Rim height: 10 feet standard').props.accessibilityState).toEqual({
      selected: true,
    });
    press(r, 'Rim height: 8.5 feet youth');
    expect(onSetRimHeight).toHaveBeenCalledWith(2.6);
    press(r, 'Ball size 5, kids');
    expect(onSetBallSize).toHaveBeenCalledWith(5);
    press(r, 'Shot value: all 3-pointers');
    expect(onSetCourtRange).toHaveBeenCalledWith('3pt');
  });

  it('keeps the honesty captions: estimated is labeled estimated', () => {
    const r = render(<CourtBallSectionBody {...base} />);
    const text = textOf(r.toJSON());
    expect(text).toContain('The rim is the ruler — the wrong height overstates every distance.');
    expect(text).toContain('Auto estimates shot value from rim geometry — estimated, not measured.');
    expect(text).toContain('Auto (estimated)');
  });
});

// ---------------------------------------------------------------------------

describe('CalibrationSectionBody', () => {
  it("forwards variant='setup' and onOpenGuide to CalibrationHealthCard untouched", () => {
    const { CalibrationHealthCard } = jest.requireMock('@/components/CalibrationHealthCard') as {
      CalibrationHealthCard: jest.Mock;
    };
    CalibrationHealthCard.mockClear();
    const onOpenGuide = jest.fn();
    render(<CalibrationSectionBody onOpenGuide={onOpenGuide} />);
    expect(CalibrationHealthCard).toHaveBeenCalledTimes(1);
    const props = CalibrationHealthCard.mock.calls[0]![0] as {
      variant: string;
      onOpenGuide: () => void;
    };
    expect(props.variant).toBe('setup');
    props.onOpenGuide();
    expect(onOpenGuide).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe('purity fence', () => {
  it('SetupSections.tsx imports no store values (type-only allowed)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'SetupSections.tsx'), 'utf8');
    const stateImports = src.match(/import\s+[^;]*?from\s+'@\/state\/[^']+'/g) ?? [];
    // Every @/state import must be `import type` — no store values.
    for (const imp of stateImports) {
      expect(imp).toMatch(/^import\s+type\s/);
    }
    // And no store hooks referenced anywhere.
    expect(src).not.toMatch(/useSettings|useMode|useSession\b/);
  });
});
