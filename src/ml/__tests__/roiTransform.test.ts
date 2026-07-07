import { squareCropRect, remapRoiBox } from '../roiTransform';
import type { Box } from '../../core/types';

/** Build a Box centered on (cx,cy) with the given width/height. */
function centered(cx: number, cy: number, w: number, h = w): Box {
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

describe('squareCropRect', () => {
  test('centers a square on the hoop center (interior case)', () => {
    const crop = squareCropRect(centered(380, 300, 160), 640);
    expect(crop).toEqual({ rx: 300, ry: 220, rs: 160 });
  });

  test('clamps to the top-left edge', () => {
    // Hoop center at (40,40) would put the square at (-40,-40) → clamped to 0.
    const crop = squareCropRect(centered(40, 40, 160), 640);
    expect(crop).toEqual({ rx: 0, ry: 0, rs: 160 });
  });

  test('clamps to the bottom-right edge', () => {
    // Center (600,600): raw top-left 520 > S-rs (480) → clamped to 480.
    const crop = squareCropRect(centered(600, 600, 160), 640);
    expect(crop).toEqual({ rx: 480, ry: 480, rs: 160 });
  });

  test('caps the side at S when the hoopRoi is larger than the frame', () => {
    const crop = squareCropRect(centered(320, 320, 800), 640);
    expect(crop.rs).toBe(640);
    expect(crop.rx).toBe(0);
    expect(crop.ry).toBe(0);
  });

  test('squares a non-square hoopRoi to its larger side', () => {
    // width 120, height 200 → rs = 200, centered on (300,300).
    const crop = squareCropRect(centered(300, 300, 120, 200), 640);
    expect(crop.rs).toBe(200);
    // center x 300, rs 200 → rx = 300-100 = 200; center y 300 → ry = 200.
    expect(crop.rx).toBe(200);
    expect(crop.ry).toBe(200);
  });
});

describe('remapRoiBox', () => {
  test('reproduces the worked example exactly', () => {
    // A 78px ball at (260,208) in a 416 ROI, cropped from rs=160 at (300,220),
    // maps back to a 30px ball at (400,300) in analysis-frame px.
    const out = remapRoiBox({ x: 260, y: 208, width: 78, height: 78 }, 300, 220, 160, 416);
    expect(out.x).toBeCloseTo(400, 6);
    expect(out.y).toBeCloseTo(300, 6);
    expect(out.width).toBeCloseTo(30, 6);
    expect(out.height).toBeCloseTo(30, 6);
  });

  test('a box at the ROI origin maps to the crop origin', () => {
    const out = remapRoiBox({ x: 0, y: 0, width: 40, height: 40 }, 128, 96, 160, 640);
    expect(out.x).toBeCloseTo(128, 6);
    expect(out.y).toBeCloseTo(96, 6);
    // z = 640/160 = 4 → 40/4 = 10.
    expect(out.width).toBeCloseTo(10, 6);
    expect(out.height).toBeCloseTo(10, 6);
  });

  test('round-trips: analysis box → ROI space → back to analysis box', () => {
    const rx = 300;
    const ry = 220;
    const rs = 160;
    const Sroi = 640;
    const analysis: Box = { x: 372, y: 296, width: 18, height: 22 };
    // Forward map (inverse of remapRoiBox): scale by Sroi/rs about the crop origin.
    const z = Sroi / rs;
    const roiBox: Box = {
      x: (analysis.x - rx) * z,
      y: (analysis.y - ry) * z,
      width: analysis.width * z,
      height: analysis.height * z,
    };
    const back = remapRoiBox(roiBox, rx, ry, rs, Sroi);
    expect(back.x).toBeCloseTo(analysis.x, 6);
    expect(back.y).toBeCloseTo(analysis.y, 6);
    expect(back.width).toBeCloseTo(analysis.width, 6);
    expect(back.height).toBeCloseTo(analysis.height, 6);
  });

  test('remapped ball center stays inside the crop rect for an in-crop detection', () => {
    // Ball near the center of a 640 ROI → its remapped center sits inside (rx,ry,rs).
    const rx = 200;
    const ry = 150;
    const rs = 200;
    const Sroi = 640;
    const out = remapRoiBox({ x: 300, y: 300, width: 60, height: 60 }, rx, ry, rs, Sroi);
    const cxOut = out.x + out.width / 2;
    const cyOut = out.y + out.height / 2;
    expect(cxOut).toBeGreaterThanOrEqual(rx);
    expect(cxOut).toBeLessThanOrEqual(rx + rs);
    expect(cyOut).toBeGreaterThanOrEqual(ry);
    expect(cyOut).toBeLessThanOrEqual(ry + rs);
  });
});
