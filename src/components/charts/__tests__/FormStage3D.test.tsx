/**
 * Render + behavior tests for FormStage3D's round-2 additions: the
 * controlled-camera contract (onCameraChange fires only from gestures, the
 * view-only no-listener mode, throttle flush on finalize), the honest wrist
 * trail (gap frames stay visually disconnected, taper/fade math), and the
 * joint-anchored callout chips (layout, missing-joint skip, 3-chip cap).
 *
 * Skia and gesture-handler are mocked to inert host elements so the projected
 * geometry can be asserted directly off the render tree; the pose3d math
 * (camera3d, trail) is the REAL pure implementation.
 */
import React from 'react';
import renderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

// --- Skia: inert host elements + a deterministic matchFont --------------------
jest.mock('@shopify/react-native-skia', () => {
  const ReactLocal = require('react');
  const host =
    (name: string) =>
    (props: Record<string, unknown>): React.ReactElement =>
      ReactLocal.createElement(name, props);
  return {
    __esModule: true,
    Canvas: ({ children }: { children?: React.ReactNode }) =>
      ReactLocal.createElement('skCanvas', null, children),
    Group: ({ children }: { children?: React.ReactNode }) =>
      ReactLocal.createElement('skGroup', null, children),
    Line: host('skLine'),
    Circle: host('skCircle'),
    RoundedRect: host('skRoundedRect'),
    Text: host('skText'),
    DashPathEffect: host('skDashPathEffect'),
    vec: (x: number, y: number) => ({ x, y }),
    // 6 px per char keeps chip-width assertions exact.
    matchFont: () => ({ measureText: (t: string) => ({ width: t.length * 6 }) }),
  };
});

// --- Gesture handler: capture the plain-JS handlers for direct invocation -----
jest.mock('react-native-gesture-handler', () => {
  const bag: {
    pan: Record<string, (e?: unknown) => void>;
    pinch: Record<string, (e?: unknown) => void>;
  } = { pan: {}, pinch: {} };
  const makeBuilder = (slot: Record<string, (e?: unknown) => void>) => {
    const builder: Record<string, unknown> = {};
    for (const m of ['runOnJS', 'maxPointers', 'activeOffsetX', 'activeOffsetY']) {
      builder[m] = () => builder;
    }
    builder.onChange = (fn: (e?: unknown) => void) => {
      slot.onChange = fn;
      return builder;
    };
    builder.onFinalize = (fn: (e?: unknown) => void) => {
      slot.onFinalize = fn;
      return builder;
    };
    return builder;
  };
  return {
    __esModule: true,
    Gesture: {
      Pan: () => makeBuilder(bag.pan),
      Pinch: () => makeBuilder(bag.pinch),
      Simultaneous: (...gestures: unknown[]) => ({ gestures }),
    },
    GestureDetector: ({ children }: { children: React.ReactElement }) => children,
    __bag: bag,
  };
});

import { color } from '@/constants/tokens';
import {
  DEFAULT_CAMERA,
  orbitFromDrag,
  pinchZoom,
  projectPoint,
} from '@/core/pose3d/camera3d';
import type { Frame3D, Joint3D, LiftedSequence } from '@/core/pose3d/lift';

import FormStage3D, { type FormStage3DProps } from '../FormStage3D';

const gestureBag = (
  jest.requireMock('react-native-gesture-handler') as {
    __bag: {
      pan: Record<string, (e?: unknown) => void>;
      pinch: Record<string, (e?: unknown) => void>;
    };
  }
).__bag;

const W = 300;
const H = 330;

const j = (x: number, y: number, z: number, c: number): Joint3D => ({ x, y, z, c });

const seq = (frames: Frame3D[]): LiftedSequence => ({
  frames,
  confidence: 0.8,
  azimuthDeg: 0,
});

function renderStage(props: Partial<FormStage3DProps> & { user: LiftedSequence }) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <FormStage3D
        pos={0}
        width={W}
        height={H}
        accessibilityLabel="stage"
        {...props}
      />,
    );
  });
  return tree;
}

// Mocked Skia hosts are plain string element types; @types/react's ElementType
// doesn't admit arbitrary strings, so comparisons go through this helper.
const typeOf = (n: ReactTestInstance): string => n.type as unknown as string;

const linesWithColor = (tree: ReactTestRenderer, c: string) =>
  tree.root.findAll((n) => typeOf(n) === 'skLine' && n.props.color === c);

afterEach(() => {
  jest.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// Controlled camera
// -----------------------------------------------------------------------------

describe('camera control', () => {
  it('uncontrolled: pan updates internal camera AND reports through onCameraChange', () => {
    const onCameraChange = jest.fn();
    renderStage({ user: seq([{}]), onCameraChange });

    act(() => gestureBag.pan.onChange!({ changeX: 60, changeY: 0 }));

    expect(onCameraChange).toHaveBeenCalledTimes(1);
    expect(onCameraChange).toHaveBeenCalledWith(orbitFromDrag(DEFAULT_CAMERA, 60, 0, W));
  });

  it('controlled: gestures dispatch through onCameraChange from the provided camera', () => {
    const onCameraChange = jest.fn();
    renderStage({ user: seq([{}]), camera: DEFAULT_CAMERA, onCameraChange });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(100000);
    act(() => gestureBag.pan.onChange!({ changeX: 60, changeY: 0 }));
    const first = orbitFromDrag(DEFAULT_CAMERA, 60, 0, W);
    expect(onCameraChange).toHaveBeenNthCalledWith(1, first);

    // Same-tick second event is throttled (delta accumulates)...
    act(() => gestureBag.pan.onChange!({ changeX: 10, changeY: 0 }));
    expect(onCameraChange).toHaveBeenCalledTimes(1);

    // ...and onFinalize flushes the leftover from the advanced camera.
    act(() => gestureBag.pan.onFinalize!());
    expect(onCameraChange).toHaveBeenNthCalledWith(2, orbitFromDrag(first, 10, 0, W));
    nowSpy.mockRestore();
  });

  it('controlled: pinch reports pinchZoom of the provided camera', () => {
    const onCameraChange = jest.fn();
    renderStage({ user: seq([{}]), camera: DEFAULT_CAMERA, onCameraChange });

    act(() => gestureBag.pinch.onChange!({ scaleChange: 2 }));

    expect(onCameraChange).toHaveBeenCalledWith(pinchZoom(DEFAULT_CAMERA, 2));
  });

  it('controlled without onCameraChange is view-only: gestures no-op without crashing', () => {
    const tree = renderStage({ user: seq([{}]), camera: DEFAULT_CAMERA });

    act(() => {
      gestureBag.pan.onChange!({ changeX: 60, changeY: 20 });
      gestureBag.pan.onFinalize!();
      gestureBag.pinch.onChange!({ scaleChange: 2 });
      gestureBag.pinch.onFinalize!();
    });

    // Still renders the grid; nothing threw, nothing re-rendered oddly.
    expect(linesWithColor(tree, color.ghostTint).length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Wrist trail
// -----------------------------------------------------------------------------

describe('wrist trail', () => {
  // Wrist-only frames: no bones/joins besides the wrist dot, so every accent
  // LINE on the canvas is a trail segment.
  const wristFrames: Frame3D[] = [
    { right_wrist: j(-0.2, -0.4, 0, 1) },
    { right_wrist: j(0, -0.5, 0, 1) },
    {}, // wrist missing → the trail must show a GAP here
    { right_wrist: j(0.2, -0.6, 0, 1) },
  ];

  it('skips the segment across a missing-wrist frame (honest gap)', () => {
    const tree = renderStage({ user: seq(wristFrames), pos: 1, trailHand: 'right' });

    // Points exist at frames 0, 1, 3 → only the 0→1 segment is drawn.
    const trailLines = linesWithColor(tree, color.accent).filter(
      (n) => n.props.strokeCap === 'round' && n.props.opacity !== undefined,
    );
    expect(trailLines).toHaveLength(1);
  });

  it('renders a tip dot at the newest trail point', () => {
    const tree = renderStage({ user: seq(wristFrames), pos: 1, trailHand: 'right' });

    const tips = tree.root.findAll(
      (n) =>
        typeOf(n) === 'skCircle' &&
        n.props.color === color.accent &&
        n.props.r === 3 &&
        n.props.opacity === 0.9,
    );
    expect(tips).toHaveLength(1);
  });

  it('tapers width and fades opacity from oldest to newest segment', () => {
    const contiguous: Frame3D[] = [
      { right_wrist: j(-0.2, -0.4, 0, 1) },
      { right_wrist: j(0, -0.5, 0, 1) },
      { right_wrist: j(0.2, -0.6, 0, 1) },
    ];
    const tree = renderStage({ user: seq(contiguous), pos: 1, trailHand: 'right' });

    const trailLines = linesWithColor(tree, color.accent).filter(
      (n) => n.props.strokeCap === 'round' && n.props.opacity !== undefined,
    );
    expect(trailLines).toHaveLength(2);
    // N = 3 points → k=0: ageT 0 → 1.5 px @ 0.2; k=1: ageT 1 → 3 px @ 0.7.
    expect(trailLines[0]!.props.strokeWidth).toBeCloseTo(1.5);
    expect(trailLines[0]!.props.opacity).toBeCloseTo(0.2);
    expect(trailLines[1]!.props.strokeWidth).toBeCloseTo(3);
    expect(trailLines[1]!.props.opacity).toBeCloseTo(0.7);
  });

  it('only draws the trail up to the current scrub position', () => {
    const tree = renderStage({ user: seq(wristFrames), pos: 0, trailHand: 'right' });

    // One point so far → no segments, but the tip dot marks it.
    const trailLines = linesWithColor(tree, color.accent).filter(
      (n) => n.props.strokeCap === 'round' && n.props.opacity !== undefined,
    );
    expect(trailLines).toHaveLength(0);
    expect(
      tree.root.findAll((n) => typeOf(n) === 'skCircle' && n.props.r === 3),
    ).toHaveLength(1);
  });

  it('draws no trail when trailHand is omitted', () => {
    const tree = renderStage({ user: seq(wristFrames), pos: 1 });

    const trailLines = linesWithColor(tree, color.accent).filter(
      (n) => n.props.strokeCap === 'round' && n.props.opacity !== undefined,
    );
    expect(trailLines).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Callout chips
// -----------------------------------------------------------------------------

describe('callout chips', () => {
  const elbow = j(0.1, -0.3, 0, 0.9);
  const frame: Frame3D = { right_elbow: elbow };

  it('renders a chip for a present joint and skips callouts on absent joints', () => {
    const tree = renderStage({
      user: seq([frame]),
      callouts: [
        { joint: 'right_elbow', text: 'ELBOW ≈92°' },
        { joint: 'left_ankle', text: 'NEVER SHOWN' },
      ],
    });

    const texts = tree.root.findAll((n) => typeOf(n) === 'skText');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.props.text).toBe('ELBOW ≈92°');
    // Fill + stroke pair for the single chip.
    expect(tree.root.findAll((n) => typeOf(n) === 'skRoundedRect')).toHaveLength(2);
  });

  it('lays the chip out from the projected joint with clamped placement', () => {
    const text = 'ELBOW ≈92°';
    const tree = renderStage({
      user: seq([frame]),
      callouts: [{ joint: 'right_elbow', text }],
    });

    const p = projectPoint(elbow, DEFAULT_CAMERA, { w: W, h: H })!;
    const chipW = text.length * 6 + 16; // mocked measureText: 6 px per char
    const chipH = 20;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const chipX = clamp(p.x + 12, 4, W - chipW - 4);
    const chipY = clamp(p.y - 30, 4, H - chipH - 4);

    const rects = tree.root.findAll((n) => typeOf(n) === 'skRoundedRect');
    expect(rects[0]!.props.x).toBeCloseTo(chipX);
    expect(rects[0]!.props.y).toBeCloseTo(chipY);
    expect(rects[0]!.props.width).toBeCloseTo(chipW);
    expect(rects[0]!.props.height).toBe(chipH);

    const skText = tree.root.findAll((n) => typeOf(n) === 'skText')[0]!;
    expect(skText.props.x).toBeCloseTo(chipX + 8);
    expect(skText.props.y).toBeCloseTo(chipY + 14);

    // Leader line anchors at the projected joint.
    const leader = linesWithColor(tree, color.textFaint)[0]!;
    expect(leader.props.p1.x).toBeCloseTo(p.x);
    expect(leader.props.p1.y).toBeCloseTo(p.y);
  });

  it('caps rendering at the first three callouts', () => {
    const busy: Frame3D = {
      right_elbow: j(0.1, -0.3, 0, 0.9),
      right_wrist: j(0.15, -0.45, 0, 0.9),
      right_shoulder: j(0.05, -0.4, 0, 0.9),
      left_knee: j(-0.1, 0.2, 0, 0.9),
    };
    const tree = renderStage({
      user: seq([busy]),
      callouts: [
        { joint: 'right_elbow', text: 'A' },
        { joint: 'right_wrist', text: 'B' },
        { joint: 'right_shoulder', text: 'C' },
        { joint: 'left_knee', text: 'D' },
      ],
    });

    expect(tree.root.findAll((n) => typeOf(n) === 'skText')).toHaveLength(3);
    expect(tree.root.findAll((n) => typeOf(n) === 'skRoundedRect')).toHaveLength(6);
  });

  it('renders no chips by default', () => {
    const tree = renderStage({ user: seq([frame]) });
    expect(tree.root.findAll((n) => typeOf(n) === 'skText')).toHaveLength(0);
    expect(tree.root.findAll((n) => typeOf(n) === 'skRoundedRect')).toHaveLength(0);
  });
});
