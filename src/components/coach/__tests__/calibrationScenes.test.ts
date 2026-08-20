/**
 * calibrationSceneMath tests — pure keyframe math for the calibration guide's
 * animated Skia mini-scenes. Verifies the tap-order diagram projects the real
 * 5-landmark ritual, and that every pose helper is deterministic, clamps t,
 * and lands on its documented final (reduced-motion) pose at t = 1.
 */
import { CALIBRATION_LANDMARK_IDS } from '../../../core/courtModel';
import {
  FRAME_RIM_TO_X,
  FRAME_RIM_TO_Y,
  HEIGHT_PHONE_FROM_Y,
  HEIGHT_PHONE_TO_Y,
  SCENE_H,
  SCENE_LOOP_MS,
  SCENE_W,
  SIDE_PHONE_FROM_X,
  SIDE_PHONE_TO_X,
  courtPathSvg,
  framePose,
  heightPose,
  sidePose,
  tapDotPoints,
  tapPose,
} from '../calibrationSceneMath';

describe('scene constants', () => {
  it('exports the documented loop and canvas dimensions', () => {
    expect(SCENE_LOOP_MS).toBe(3600);
    expect(SCENE_W).toBe(96);
    expect(SCENE_H).toBe(72);
  });
});

describe('tapDotPoints', () => {
  const W = 300;
  const H = 130;
  const dots = tapDotPoints(W, H);

  it('returns 5 points in CALIBRATION_LANDMARK_IDS ritual order', () => {
    // Lock the ritual-order assumption the geometry checks below rely on.
    expect(CALIBRATION_LANDMARK_IDS).toEqual([
      'basket',
      'cornerThreeLeft',
      'cornerThreeRight',
      'topOfArc',
      'ftCenter',
    ]);
    expect(dots).toHaveLength(5);
    expect(dots.map((d) => d.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('puts the basket at bottom-center (baseline at the bottom edge)', () => {
    const basket = dots[0]!;
    expect(basket.x).toBeCloseTo(W / 2, 6);
    // Basket floor point sits just inside the baseline (y ≈ 0.84 * h).
    expect(basket.y).toBeGreaterThan(0.75 * H);
    expect(basket.y).toBeLessThanOrEqual(H);
  });

  it('puts the corners on the baseline, symmetric about center', () => {
    const [, left, right] = dots;
    expect(left!.y).toBeCloseTo(H, 6);
    expect(right!.y).toBeCloseTo(H, 6);
    expect(left!.x).toBeLessThan(W / 2);
    expect(right!.x).toBeGreaterThan(W / 2);
    // FIBA court is symmetric, so the corners mirror around the center.
    expect(left!.x).toBeCloseTo(W - right!.x, 6);
  });

  it('puts top-of-arc near the top and FT line between arc and basket', () => {
    const [basket, , , top, ft] = dots;
    expect(top!.x).toBeCloseTo(W / 2, 6);
    expect(top!.y).toBeLessThan(0.3 * H);
    expect(ft!.x).toBeCloseTo(W / 2, 6);
    expect(ft!.y).toBeGreaterThan(top!.y);
    expect(ft!.y).toBeLessThan(basket!.y);
  });

  it('keeps every dot inside the diagram bounds', () => {
    for (const d of dots) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(W);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(H);
    }
  });
});

describe('sidePose', () => {
  it('is deterministic', () => {
    expect(sidePose(0.42)).toEqual(sidePose(0.42));
  });

  it('clamps t below 0 and above 1', () => {
    expect(sidePose(-5)).toEqual(sidePose(0));
    expect(sidePose(7)).toEqual(sidePose(1));
  });

  it('starts parked behind with nothing drawn', () => {
    expect(sidePose(0)).toEqual({
      phoneX: SIDE_PHONE_FROM_X,
      lineProgress: 0,
      rimPulse: 0,
    });
  });

  it('t = 1 is the documented final pose (the reduced-motion frame)', () => {
    expect(sidePose(1)).toEqual({
      phoneX: SIDE_PHONE_TO_X,
      lineProgress: 1,
      rimPulse: 1,
    });
  });

  it('slides the phone monotonically during the 0–0.35 window', () => {
    let prev = sidePose(0).phoneX;
    for (const t of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) {
      const x = sidePose(t).phoneX;
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
    expect(prev).toBeCloseTo(SIDE_PHONE_TO_X, 6);
  });

  it('does not start the sight-line before the phone settles', () => {
    expect(sidePose(0.3).lineProgress).toBe(0);
    expect(sidePose(0.5).lineProgress).toBeGreaterThan(0);
  });

  it('holds the final pose through the tail of the loop', () => {
    expect(sidePose(0.9)).toEqual(sidePose(1));
  });
});

describe('framePose', () => {
  it('is deterministic and clamps t', () => {
    expect(framePose(0.33)).toEqual(framePose(0.33));
    expect(framePose(-1)).toEqual(framePose(0));
    expect(framePose(2)).toEqual(framePose(1));
  });

  it('starts with the rim adrift and the bracket invisible at 1.3 scale', () => {
    const p = framePose(0);
    expect(p.bracketScale).toBeCloseTo(1.3, 6);
    expect(p.bracketAlpha).toBe(0);
    expect(p.floorAlpha).toBe(0);
    // Rim starts lower-left of the upper-third target.
    expect(p.rimX).toBeLessThan(FRAME_RIM_TO_X);
    expect(p.rimY).toBeGreaterThan(FRAME_RIM_TO_Y);
  });

  it('t = 1 is the documented final pose', () => {
    expect(framePose(1)).toEqual({
      rimX: FRAME_RIM_TO_X,
      rimY: FRAME_RIM_TO_Y,
      bracketScale: 1,
      bracketAlpha: 1,
      floorAlpha: 1,
    });
    expect(framePose(1).bracketAlpha).toBe(1);
  });

  it('keeps the bracket hidden until the rim has drifted in', () => {
    expect(framePose(0.4).bracketAlpha).toBe(0);
    expect(framePose(0.6).bracketAlpha).toBeGreaterThan(0);
  });
});

describe('heightPose', () => {
  it('is deterministic and clamps t', () => {
    expect(heightPose(0.5)).toEqual(heightPose(0.5));
    expect(heightPose(-0.1)).toEqual(heightPose(0));
    expect(heightPose(1.5)).toEqual(heightPose(1));
  });

  it('starts low with the chest tick hidden', () => {
    expect(heightPose(0)).toEqual({ phoneY: HEIGHT_PHONE_FROM_Y, tickAlpha: 0 });
  });

  it('t = 1 is the documented final pose', () => {
    expect(heightPose(1)).toEqual({ phoneY: HEIGHT_PHONE_TO_Y, tickAlpha: 1 });
  });

  it('raises the phone monotonically (screen Y decreases)', () => {
    let prev = heightPose(0).phoneY;
    for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
      const y = heightPose(t).phoneY;
      expect(y).toBeLessThanOrEqual(prev);
      prev = y;
    }
    expect(prev).toBeCloseTo(HEIGHT_PHONE_TO_Y, 6);
  });
});

describe('tapPose', () => {
  it('is deterministic and clamps t', () => {
    expect(tapPose(0.4, 2)).toEqual(tapPose(0.4, 2));
    expect(tapPose(-3, 0)).toEqual(tapPose(0, 0));
    expect(tapPose(2, 2)).toEqual(tapPose(1, 2));
  });

  it('lights dot k at t = 0.12 + k * 0.15, not before', () => {
    expect(tapPose(0, 0).lit).toBe(false);
    expect(tapPose(0.11, 0).lit).toBe(false);
    expect(tapPose(0.12, 0).lit).toBe(true);
    expect(tapPose(0.26, 1).lit).toBe(false);
    expect(tapPose(0.28, 1).lit).toBe(true);
    expect(tapPose(0.56, 3).lit).toBe(false);
    expect(tapPose(0.58, 3).lit).toBe(true);
  });

  it('expands the ripple over the 0.12 after lighting', () => {
    expect(tapPose(0.12, 0).ripple).toBe(0);
    const mid = tapPose(0.18, 0).ripple;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(tapPose(0.25, 0).ripple).toBe(1);
  });

  it('t = 1 is the documented final pose for every dot', () => {
    for (let k = 0; k < 5; k++) {
      expect(tapPose(1, k)).toEqual({ lit: true, ripple: 1 });
    }
  });
});

describe('courtPathSvg', () => {
  const W = 300;
  const H = 130;
  const svg = courtPathSvg(W, H);

  it('is a well-formed multi-subpath string', () => {
    expect(svg.startsWith('M ')).toBe(true);
    // Baseline, 3-point line, FT line = 3 subpaths.
    expect(svg.match(/M /g)).toHaveLength(3);
    expect(svg).toContain('L ');
    expect(svg).not.toContain('NaN');
  });

  it('keeps every coordinate inside the diagram bounds', () => {
    const nums = svg.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(nums.length % 2).toBe(0);
    for (let i = 0; i < nums.length; i += 2) {
      expect(nums[i]!).toBeGreaterThanOrEqual(-0.1);
      expect(nums[i]!).toBeLessThanOrEqual(W + 0.1);
      expect(nums[i + 1]!).toBeGreaterThanOrEqual(-0.1);
      expect(nums[i + 1]!).toBeLessThanOrEqual(H + 0.1);
    }
  });

  it('passes through the landmark dots it decorates', () => {
    const dots = tapDotPoints(W, H);
    const [, left, right, top] = dots;
    // Corner posts rise from the corner dots; arc apex is the top dot.
    expect(svg).toContain(`M ${left!.x.toFixed(1)} ${left!.y.toFixed(1)}`);
    expect(svg).toContain(`L ${right!.x.toFixed(1)} ${right!.y.toFixed(1)}`);
    expect(svg).toContain(`${top!.x.toFixed(1)} ${top!.y.toFixed(1)}`);
  });
});
