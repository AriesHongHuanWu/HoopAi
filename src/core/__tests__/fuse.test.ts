/**
 * Fusion truth-table tests — the make/miss decision core.
 *
 * These pin the #1 product rule: NEVER fabricate a make ("bread ball"). In
 * particular, when the net channel is available, `cls` (the weak
 * ball_in_basket classifier) may only contribute to a make by AGREEING with
 * net — it must never override a `net === false` into a make.
 */
import { fuse } from '../shotFsm';

describe('fuse — net available', () => {
  test('geo crossing + net swish is a make', () => {
    expect(fuse(true, true, false, false)).toBe('make');
  });

  test('net + cls agree (occluded crossing) is a make', () => {
    expect(fuse(null, true, true, true)).toBe('make');
  });

  test('geo crossing but no net motion is a miss (airball across the plane)', () => {
    expect(fuse(true, false, false, false)).toBe('miss');
  });

  test('geo === false (crossing outside span) is always a miss', () => {
    expect(fuse(false, true, true, true)).toBe('miss');
  });

  // THE bread-ball guarantee: net says "no swish", a lone cls blip at the rim
  // must NOT mint a make — the outcome is unsure, never make.
  test('net === false + cls + occluded does NOT mint a make', () => {
    expect(fuse(null, false, true, true)).not.toBe('make');
    expect(fuse(null, false, true, true)).toBe('unsure');
  });

  test('cls alone (net false, not occluded) is unsure', () => {
    expect(fuse(null, false, true, false)).toBe('unsure');
  });
});

describe('fuse — netless hoop (net === null)', () => {
  test('a tracked geometric crossing counts', () => {
    expect(fuse(true, null, false, false)).toBe('make');
  });

  test('an occluded ball with ball_in_basket firing counts (only signal available)', () => {
    expect(fuse(null, null, true, true)).toBe('make');
  });

  test('cls alone with the ball NOT occluded at the rim is too weak — unsure', () => {
    expect(fuse(null, null, true, false)).toBe('unsure');
  });

  test('geo === false is a miss even on a netless hoop', () => {
    expect(fuse(false, null, true, true)).toBe('miss');
  });

  test('no signal at all is unsure', () => {
    expect(fuse(null, null, false, false)).toBe('unsure');
  });
});
