/**
 * NumberSlider readout — the contract that keeps the chosen number ON SCREEN.
 *
 * THE BUG this pins: the height step showed no number at all. The value, the
 * state and the formatter were all correct (the string reached the tree); what
 * killed it was the shape of the readout. It was the app's ONLY
 * `adjustsFontSizeToFit` + `numberOfLines={1}` Text with a NESTED <Text> child
 * — the unit chip lived inside the auto-shrinking numeral, mixing a 96/96
 * font+lineHeight run with a 32/34 run inside a paragraph iOS was
 * simultaneously being asked to shrink to fit one line. Every other hero
 * numeral in the app (ModeComplete's hero, Home's START SESSION, the profile
 * name, the NBA-twin name) feeds `adjustsFontSizeToFit` a single plain string
 * and keeps the unit as a SIBLING. This suite makes that the rule here too.
 *
 * Also pinned: the scale labels under the track are formatted with the same
 * formatter as the readout (an imperial slider must read 3'11" … 7'3", never
 * the raw inch counts 47 … 87), and the adjustable's accessible name carries
 * the number AND its unit — the visible one was missing entirely, so the
 * spoken one is the only thing some users had.
 */
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {
    View: require('react-native').View,
    createAnimatedComponent: (c: unknown) => c,
  },
  runOnJS: (fn: unknown) => fn,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: (fn: () => unknown) => fn(),
  withTiming: (v: unknown) => v,
}));
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
jest.mock('expo-haptics', () => ({ selectionAsync: jest.fn() }));
jest.mock('expo-sqlite/kv-store', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { formatDisplayHeight, spokenDisplayHeight } from '@/core/heightUnits';

import { NumberSlider } from '../profile/NumberSlider';

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Every rendered string, flattened — "does this appear on screen at all". */
function textOf(json: Json | string): string {
  if (json == null) return '';
  if (typeof json === 'string') return json;
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  return (json.children ?? []).map(textOf).join(' ');
}

/** The Text node iOS is asked to auto-shrink — the one that went blank. */
function shrinkingText(r: ReactTestRenderer) {
  const nodes = r.root
    .findAllByType(Text)
    .filter((n) => n.props.adjustsFontSizeToFit === true);
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

const metric = {
  label: 'Height',
  min: 120,
  max: 220,
  unit: 'cm',
  formatValue: (v: number) => formatDisplayHeight(v, 'cm'),
};

describe('the readout renders the chosen number', () => {
  it('paints the number and its unit', () => {
    const r = render(<NumberSlider {...metric} value={178} onChange={() => {}} />);
    const flat = textOf(r.toJSON());
    expect(flat).toContain('178');
    expect(flat).toContain('cm');
  });

  it('feeds the auto-shrinking Text ONE plain string, never a nested Text', () => {
    // The regression that blanked the height step. A nested <Text> inside an
    // adjustsFontSizeToFit + numberOfLines={1} paragraph is the one shape iOS
    // does not survive, and it is the shape this readout had.
    const r = render(<NumberSlider {...metric} value={178} onChange={() => {}} />);
    const node = shrinkingText(r);
    // Children.toArray already drops null / undefined / booleans.
    const kids = React.Children.toArray(node.props.children);
    expect(kids).toHaveLength(1);
    expect(typeof kids[0]).toBe('string');
    expect(kids[0]).toBe('178');
    // And nothing nested below it either.
    expect(node.findAllByType(Text)).toHaveLength(1);
  });

  it('keeps the unit as a visible SIBLING of the numeral', () => {
    const r = render(<NumberSlider {...metric} value={178} onChange={() => {}} />);
    const isUnit = (n: { props: { children?: React.ReactNode } }) =>
      React.Children.toArray(n.props.children).join('').trim() === 'cm';
    const unitNode = r.root.findAllByType(Text).find(isUnit);
    expect(unitNode).toBeDefined();
    expect(unitNode!.props.adjustsFontSizeToFit).toBeFalsy();
    // Sibling, not descendant: nothing lives inside the shrinking paragraph.
    expect(shrinkingText(r).findAllByType(Text).filter(isUnit)).toHaveLength(0);
  });

  it('still shows a numeral with no unit and no formatter (weight/year steps)', () => {
    const r = render(
      <NumberSlider label="Birth year" value={2005} min={1930} max={2021} onChange={() => {}} />,
    );
    expect(textOf(r.toJSON())).toContain('2005');
    expect(React.Children.toArray(shrinkingText(r).props.children)).toEqual(['2005']);
  });
});

describe('imperial readout', () => {
  const imperial = {
    label: 'Height',
    min: 47,
    max: 87,
    formatValue: (v: number) => formatDisplayHeight(v, 'ftin'),
    spokenValue: (v: number) => spokenDisplayHeight(v, 'ftin'),
  };

  it('shows feet and inches, not a raw inch count', () => {
    const r = render(<NumberSlider {...imperial} value={71} onChange={() => {}} />);
    const flat = textOf(r.toJSON());
    expect(flat).toContain("5'11\"");
    expect(React.Children.toArray(shrinkingText(r).props.children)).toEqual(["5'11\""]);
  });

  it('formats the min/max scale labels with the same formatter', () => {
    const r = render(<NumberSlider {...imperial} value={71} onChange={() => {}} />);
    const flat = textOf(r.toJSON());
    expect(flat).toContain("3'11\"");
    expect(flat).toContain("7'3\"");
    // The raw inch bounds must not leak onto the screen as if they were height.
    expect(flat).not.toMatch(/\b47\b/);
    expect(flat).not.toMatch(/\b87\b/);
  });
});

describe('accessible name', () => {
  it('carries the label, the number and the unit', () => {
    const r = render(<NumberSlider {...metric} value={178} onChange={() => {}} />);
    const adj = r.root.findAll((n) => n.props.accessibilityRole === 'adjustable')[0]!;
    expect(adj.props.accessibilityLabel).toBe('Height: 178 cm');
    expect(adj.props.accessibilityValue).toEqual({ min: 120, max: 220, now: 178 });
  });

  it('speaks imperial in words, since \'11" is not readable punctuation', () => {
    const r = render(
      <NumberSlider
        label="Height"
        value={71}
        min={47}
        max={87}
        formatValue={(v) => formatDisplayHeight(v, 'ftin')}
        spokenValue={(v) => spokenDisplayHeight(v, 'ftin')}
        onChange={() => {}}
      />,
    );
    const adj = r.root.findAll((n) => n.props.accessibilityRole === 'adjustable')[0]!;
    expect(adj.props.accessibilityLabel).toBe('Height: 5 feet 11 inches');
  });

  it('hides the decorative readout so the number is announced once', () => {
    const r = render(<NumberSlider {...metric} value={178} onChange={() => {}} />);
    const hidden = r.root.findAll(
      (n) => n.props.importantForAccessibility === 'no-hide-descendants',
    );
    expect(hidden.length).toBeGreaterThan(0);
  });
});
