/**
 * ScreenHeader + SectionEyebrow — the header kit contract.
 *
 * What matters here is the canon: the H1 wears type.title and announces
 * itself as a header, the lede wears body/textDim with THE one lede margin
 * (space.xs above), eyebrows are uppercased type.eyebrow, and the optional
 * `right` slot renders without stealing the title's role. Screens adopting
 * the kit keep their own section rhythm — this block owns nothing below the
 * lede.
 */
import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { color, space, type } from '@/constants/tokens';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import { ScreenHeader, SectionEyebrow } from '../ScreenHeader';

type Json = ReturnType<ReactTestRenderer['toJSON']>;

/** Flatten every rendered string for "does this copy appear" assertions. */
function textOf(json: Json): string {
  if (json == null) return '';
  if (Array.isArray(json)) return json.map(textOf).join(' ');
  const kids = json.children ?? [];
  return kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join(' ');
}

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

/** Flattened style object of the Text node whose content is `content`. */
function styleOfText(r: ReactTestRenderer, content: string): Record<string, unknown> {
  const node = r.root
    .findAllByType(Text)
    .find((n) => React.Children.toArray(n.props.children).join('') === content);
  expect(node).toBeDefined();
  const raw = node!.props.style;
  const flat = (Array.isArray(raw) ? raw : [raw]).flat(Infinity);
  return Object.assign({}, ...flat.filter(Boolean));
}

describe('ScreenHeader', () => {
  it('renders the title as a header in type.title', () => {
    const r = render(<ScreenHeader title="Train" />);
    const title = r.root
      .findAllByType(Text)
      .find((n) => n.props.accessibilityRole === 'header');
    expect(title).toBeDefined();
    expect(textOf(r.toJSON())).toContain('Train');
    const style = styleOfText(r, 'Train');
    expect(style.fontFamily).toBe(type.title.fontFamily);
    expect(style.fontSize).toBe(type.title.fontSize);
    expect(style.color).toBe(color.text);
    act(() => r.unmount());
  });

  it('renders the lede in body/textDim with THE canonical margin', () => {
    const r = render(<ScreenHeader title="Data" lede="Every session, trends and records." />);
    const style = styleOfText(r, 'Every session, trends and records.');
    expect(style.fontFamily).toBe(type.body.fontFamily);
    expect(style.color).toBe(color.textDim);
    expect(style.marginTop).toBe(space.xs);
    act(() => r.unmount());
  });

  it('uppercases the eyebrow and tracks it in type.eyebrow', () => {
    const r = render(<ScreenHeader title="Coach" eyebrow="Weekly report" />);
    const style = styleOfText(r, 'WEEKLY REPORT');
    expect(style.letterSpacing).toBe(type.eyebrow.letterSpacing);
    expect(style.color).toBe(color.textFaint);
    act(() => r.unmount());
  });

  it('renders the right slot alongside the title', () => {
    const r = render(
      <ScreenHeader title="You" right={<View testID="gear" />} />,
    );
    expect(r.root.findAllByProps({ testID: 'gear' }).length).toBeGreaterThan(0);
    // The slot must not become a second header.
    const headers = r.root
      .findAllByType(Text)
      .filter((n) => n.props.accessibilityRole === 'header');
    expect(headers).toHaveLength(1);
    act(() => r.unmount());
  });

  it('renders no empty lede/eyebrow nodes when the props are absent', () => {
    const r = render(<ScreenHeader title="Home" />);
    const texts = r.root.findAllByType(Text);
    expect(texts).toHaveLength(1);
    act(() => r.unmount());
  });
});

describe('SectionEyebrow', () => {
  it('uppercases its children into type.eyebrow/textFaint', () => {
    const r = render(<SectionEyebrow icon="calendar-outline">Week of Aug 18</SectionEyebrow>);
    const style = styleOfText(r, 'WEEK OF AUG 18');
    expect(style.fontFamily).toBe(type.eyebrow.fontFamily);
    expect(style.fontSize).toBe(type.eyebrow.fontSize);
    expect(style.letterSpacing).toBe(type.eyebrow.letterSpacing);
    expect(style.color).toBe(color.textFaint);
    act(() => r.unmount());
  });
});
