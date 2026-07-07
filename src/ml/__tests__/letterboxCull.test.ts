/**
 * Letterbox phantom cull — the fix for "the model keeps hallucinating people
 * in the black bars at the frame edges". Geometry mirrors overlayMapping.ts:
 * 'contain' into the S×S square, content CENTERED, bars symmetric.
 */
import { cullLetterboxDetections, LETTERBOX_CULL_MARGIN_FRAC } from '../letterboxCull';
import type { Detection } from '../../core/types';

const S = 640;

function det(cx: number, cy: number, cls: Detection['cls'] = 'person', size = 40): Detection {
  return {
    cls,
    score: 0.7,
    box: { x: cx - size / 2, y: cy - size / 2, width: size, height: size },
  };
}

describe('cullLetterboxDetections', () => {
  // Portrait 1080×1920 'contain' into 640²: scale 1/3, content 360×640,
  // bars LEFT/RIGHT: x < 140 and x > 500 (± the rounding margin, 6.4px).
  const PW = 1080;
  const PH = 1920;
  const MARGIN = S * LETTERBOX_CULL_MARGIN_FRAC; // 6.4

  test('portrait: phantom person centered in the left bar is dropped', () => {
    const phantom = det(50, 320);
    const ball = det(320, 320, 'ball');
    const out = cullLetterboxDetections([phantom, ball], S, PW, PH);
    expect(out).toEqual([ball]);
  });

  test('portrait: phantom in the right bar is dropped too (symmetry)', () => {
    const phantom = det(600, 100);
    const out = cullLetterboxDetections([phantom], S, PW, PH);
    expect(out).toEqual([]);
  });

  test('landscape 1920×1080: bars are top/bottom', () => {
    const topPhantom = det(320, 60);
    const bottomPhantom = det(320, 580);
    const rim = det(320, 320, 'rim');
    const out = cullLetterboxDetections([topPhantom, rim, bottomPhantom], S, 1920, 1080);
    expect(out).toEqual([rim]);
  });

  test('rounding margin: a center just outside the exact content edge survives', () => {
    // Content starts at x=140; the margin tolerates resize rounding.
    const justOutside = det(140 - MARGIN + 0.5, 320);
    const wellOutside = det(140 - MARGIN - 2, 320);
    expect(cullLetterboxDetections([justOutside], S, PW, PH)).toEqual([justOutside]);
    expect(cullLetterboxDetections([wellOutside], S, PW, PH)).toEqual([]);
  });

  test('a real object half-off the content edge keeps its center inside → kept', () => {
    // Box straddles the left content boundary but its CENTER is in content.
    const straddler = det(150, 320, 'person', 60); // box 120..180
    expect(cullLetterboxDetections([straddler], S, PW, PH)).toEqual([straddler]);
  });

  test('square source: no bars, nothing culled, SAME array back (no realloc)', () => {
    const dets = [det(5, 5), det(635, 635, 'ball')];
    expect(cullLetterboxDetections(dets, S, 1080, 1080)).toBe(dets);
  });

  test('degenerate source dims: culls nothing rather than guessing', () => {
    const dets = [det(5, 320)];
    expect(cullLetterboxDetections(dets, S, 0, 1920)).toBe(dets);
    expect(cullLetterboxDetections(dets, 0, 1080, 1920)).toBe(dets);
  });

  test('all classes are culled, not just person', () => {
    const barBall = det(50, 320, 'ball');
    const barRim = det(50, 100, 'rim');
    const barBasket = det(600, 320, 'ball_in_basket');
    expect(cullLetterboxDetections([barBall, barRim, barBasket], S, PW, PH)).toEqual([]);
  });

  test('untouched array is returned by reference when nothing is culled', () => {
    const dets = [det(320, 320), det(400, 100, 'ball')];
    expect(cullLetterboxDetections(dets, S, PW, PH)).toBe(dets);
  });
});
