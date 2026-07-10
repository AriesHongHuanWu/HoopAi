import { RIM } from '../config';
import { apexAboveRim, DribbleDetector, type DribbleSample } from '../dribbleGate';
import type { Box, RimGeometry } from '../types';

// ---------------------------------------------------------------------------
// Fixtures & helpers (rim fixture matches shotFsm.test.ts)
// ---------------------------------------------------------------------------

/**
 * Rim box: planeY=200, rim width 40 → reversal depth line at cy=240 and an
 * apex limit of y=280 at marginRimWidths=2 (240 at margin 1).
 */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };

function rimFromBox(box: Box): RimGeometry {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const planeY = box.y;
  const halfSpan = (box.width * RIM.spanFraction) / 2;
  const upW = box.width * RIM.upZoneWidthFactor;
  const upH = box.height * RIM.upZoneHeightFactor;
  const roiW = box.width * RIM.hoopRoiFactor;
  const roiH = box.height * RIM.hoopRoiFactor;
  return {
    box,
    cx,
    cy,
    planeY,
    spanLeft: cx - halfSpan,
    spanRight: cx + halfSpan,
    belowY: box.y + box.height + RIM.belowMarginFactor * box.height,
    upZone: { x: cx - upW / 2, y: planeY - upH, width: upW, height: upH },
    hoopRoi: { x: cx - roiW / 2, y: cy - roiH / 2, width: roiW, height: roiH },
    netRoi: {
      x: box.x,
      y: box.y + box.height,
      width: box.width,
      height: box.height * RIM.netRoiHeightFactor,
    },
  };
}

const HOOP = rimFromBox(RIM_BOX);

const FPS = 30;
const DT = 1 / FPS;

function ds(t: number, cy: number, vy: number, real = true): DribbleSample {
  return { t, cy, vy, real };
}

/**
 * A waist-high dribble train: `bounces` floor bounces, one every `period`
 * seconds starting at t0. Every sample sits far below the rim plane
 * (cy 558..598 ≥ depth line 240). Each bounce contributes exactly ONE
 * falling→rising reversal (sample index 2 of its 5); the rising→falling flip
 * at the top of the dribble between bounces is NOT a reversal.
 */
function bounceTrain(t0: number, bounces: number, period: number): DribbleSample[] {
  const out: DribbleSample[] = [];
  for (let k = 0; k < bounces; k++) {
    const tk = t0 + k * period;
    out.push(ds(tk, 560, 350));
    out.push(ds(tk + DT, 585, 400));
    out.push(ds(tk + 2 * DT, 598, -400)); // floor bounce — the reversal
    out.push(ds(tk + 3 * DT, 580, -360));
    out.push(ds(tk + 4 * DT, 558, -300));
  }
  return out;
}

// ---------------------------------------------------------------------------
// DribbleDetector
// ---------------------------------------------------------------------------

describe('DribbleDetector', () => {
  test('three-bounce dribble latches on the second reversal and stays latched', () => {
    const det = new DribbleDetector();
    const frames = bounceTrain(0, 3, 0.5); // reversals at ≈0.067, 0.567, 1.067 s
    const results = frames.map((s) => det.update(s, HOOP));

    // Nothing suppressed before the second reversal (index 7 = bounce 1's flip)…
    expect(results.slice(0, 7)).toEqual(new Array(7).fill(false));
    // …then the latch snaps ON and holds through the rest of the dribble.
    expect(results[7]).toBe(true);
    expect(results.slice(7)).toEqual(new Array(results.length - 7).fill(true));
    expect(det.active).toBe(true);
  });

  test('a shot after dribbling clears the latch on the first REAL sample above the plane (the arc draws for the shot)', () => {
    const det = new DribbleDetector();
    for (const s of bounceTrain(0, 3, 0.5)) det.update(s, HOOP);
    expect(det.active).toBe(true);

    // A Kalman ghost above the plane is opinion, not evidence — no clear.
    expect(det.update(ds(1.2, 150, -600, false), HOOP)).toBe(true);

    // The real release rise: still suppressed while below the plane…
    expect(det.update(ds(1.2 + DT, 420, -620), HOOP)).toBe(true);
    expect(det.update(ds(1.2 + 2 * DT, 330, -650), HOOP)).toBe(true);
    // …and cleared the instant a REAL sample rises above planeY (200).
    expect(det.update(ds(1.2 + 3 * DT, 195, -660), HOOP)).toBe(false);
    expect(det.active).toBe(false);
    // The actual shot keeps drawing.
    expect(det.update(ds(1.2 + 4 * DT, 150, -640), HOOP)).toBe(false);
  });

  test('a single bounce (dropped ball) never latches', () => {
    const det = new DribbleDetector();
    for (const s of bounceTrain(0, 1, 0.5)) {
      expect(det.update(s, HOOP)).toBe(false);
    }
    expect(det.active).toBe(false);
  });

  test('layup approach — ball low then rising to the hoop — is never suppressed, including above the plane', () => {
    const det = new DribbleDetector();
    // Gather bobble (one deep reversal at index 2 — never enough to latch),
    // then a continuous drive up through the rim plane.
    const seq: Array<[number, number]> = [
      [500, 60],
      [505, 40],
      [498, -120], // drive starts — a single reversal
      [460, -300],
      [400, -450],
      [330, -520],
      [260, -560],
      [210, -580],
      [195, -560], // above the plane — must not be suppressed
      [180, -520],
    ];
    seq.forEach(([cy, vy], i) => {
      expect(det.update(ds(i * DT, cy, vy), HOOP)).toBe(false);
    });
    expect(det.active).toBe(false);
  });

  test('latch clears after 1.2 s with no new reversal (ball picked up and held)', () => {
    const det = new DribbleDetector();
    for (const s of bounceTrain(0, 2, 0.4)) det.update(s, HOOP);
    expect(det.active).toBe(true); // last reversal at t ≈ 0.4667

    // Ball held at the waist: no flips, time flows from sample timestamps.
    expect(det.update(ds(1.6, 520, 20), HOOP)).toBe(true); // 1.13 s since reversal
    expect(det.update(ds(1.7, 520, 20), HOOP)).toBe(false); // ≥ 1.2 s → cleared
    expect(det.active).toBe(false);
  });

  test('rim == null: update never reports active — no rim, no suppression', () => {
    const det = new DribbleDetector();
    for (const s of bounceTrain(0, 3, 0.5)) {
      expect(det.update(s, null)).toBe(false);
    }
    expect(det.active).toBe(false);
  });

  test('reset() clears the latch and the reversal history', () => {
    const det = new DribbleDetector();
    for (const s of bounceTrain(0, 2, 0.5)) det.update(s, HOOP);
    expect(det.active).toBe(true);

    det.reset();
    expect(det.active).toBe(false);
    // One lone bounce after reset cannot re-latch (history really cleared).
    for (const s of bounceTrain(2.0, 1, 0.5)) {
      expect(det.update(s, HOOP)).toBe(false);
    }
    expect(det.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apexAboveRim
// ---------------------------------------------------------------------------

describe('apexAboveRim', () => {
  test('a real shot fit passes at margin 2', () => {
    // shotFsm.test.ts arc physics: y(t) = 450t² − 700t + 400 → vertex y ≈ 127.8,
    // well above the limit 200 + 2·40 = 280.
    expect(apexAboveRim({ ya: 450, yb: -700, yc: 400 }, HOOP, 2)).toBe(true);
  });

  test('a waist-high dribble fit fails at margin 2', () => {
    // A between-bounce fall fitted globally: apex at waist height (y = 450),
    // far below the limit 280.
    expect(apexAboveRim({ ya: 450, yb: 0, yc: 450 }, HOOP, 2)).toBe(false);
  });

  test('margin scales in rim widths', () => {
    // Vertex at y = 260: inside margin 2 (limit 280) but not margin 1 (240).
    expect(apexAboveRim({ ya: 450, yb: 0, yc: 260 }, HOOP, 2)).toBe(true);
    expect(apexAboveRim({ ya: 450, yb: 0, yc: 260 }, HOOP, 1)).toBe(false);
  });

  test('null fit or null rim are permissive (never suppress a real shot for lack of info)', () => {
    expect(apexAboveRim(null, HOOP, 2)).toBe(true);
    expect(apexAboveRim({ ya: 450, yb: 0, yc: 450 }, null, 2)).toBe(true);
  });

  test('a non-gravity fit (ya <= 0) is permissive — no finite apex to judge', () => {
    expect(apexAboveRim({ ya: -450, yb: 0, yc: 450 }, HOOP, 2)).toBe(true);
    expect(apexAboveRim({ ya: 0, yb: 100, yc: 450 }, HOOP, 2)).toBe(true);
  });
});
