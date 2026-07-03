import { RIM } from '../config';
import { computeRimGeometry, RimLock } from '../rimLock';
import type { Box, Detection, FrameDetections } from '../types';

const FPS = 30;

const rimBox: Box = { x: 100, y: 50, width: 40, height: 20 };

function rimDet(box: Box, score = 0.9): Detection {
  return { cls: 'rim', score, box };
}

function frame(t: number, detections: Detection[]): FrameDetections {
  return { t, frameWidth: 640, frameHeight: 640, detections };
}

/** Steps `lock` with n identical rim frames starting at frame index `i0`. */
function feed(lock: RimLock, box: Box, n: number, i0 = 0, score = 0.9) {
  let out = null;
  for (let i = 0; i < n; i++) {
    out = lock.step(frame((i0 + i) / FPS, [rimDet(box, score)]), (i0 + i) / FPS);
  }
  return out;
}

describe('computeRimGeometry', () => {
  test('numbers exactly match config math for a known box', () => {
    // Sanity-pin the config values this math depends on.
    expect(RIM.spanFraction).toBe(0.8);
    expect(RIM.crossingBufferPx).toBe(10);
    expect(RIM.belowMarginFactor).toBe(0.5);
    expect(RIM.upZoneWidthFactor).toBe(4);
    expect(RIM.upZoneHeightFactor).toBe(2);
    expect(RIM.hoopRoiFactor).toBe(2.5);
    expect(RIM.netRoiHeightFactor).toBe(1.2);

    const g = computeRimGeometry(rimBox);

    expect(g.box).toEqual(rimBox);
    expect(g.cx).toBe(120);
    expect(g.cy).toBe(60);

    // planeY = top edge.
    expect(g.planeY).toBe(50);

    // span = center ± (0.8/2)*40 = ±16, widened by 10 px each side.
    expect(g.spanLeft).toBe(120 - 16 - 10); // 94
    expect(g.spanRight).toBe(120 + 16 + 10); // 146

    // belowY = bottom (70) + 0.5 * 20.
    expect(g.belowY).toBe(80);

    // upZone: 160x40, centered on cx, bottom edge sits ON planeY.
    expect(g.upZone).toEqual({ x: 40, y: 10, width: 160, height: 40 });
    expect(g.upZone.y + g.upZone.height).toBe(g.planeY);

    // hoopRoi: rim box scaled 2.5x about the center.
    expect(g.hoopRoi).toEqual({ x: 70, y: 35, width: 100, height: 50 });

    // netRoi: rim-width wide, top at rim bottom, 1.2x rim height tall.
    expect(g.netRoi).toEqual({ x: 100, y: 70, width: 40, height: 24 });
  });

  test('returns a fresh object and does not alias the input box', () => {
    const g = computeRimGeometry(rimBox);
    expect(g.box).not.toBe(rimBox);
    const g2 = computeRimGeometry(rimBox);
    expect(g2).not.toBe(g);
  });
});

describe('RimLock locking', () => {
  test('locks after 5 stable frames, null before', () => {
    const lock = new RimLock();
    for (let i = 0; i < 4; i++) {
      expect(lock.step(frame(i / FPS, [rimDet(rimBox)]), i / FPS)).toBeNull();
      expect(lock.geometry).toBeNull();
    }
    const g = lock.step(frame(4 / FPS, [rimDet(rimBox)]), 4 / FPS);
    expect(g).not.toBeNull();
    // Mean of five identical boxes == the box; geometry matches the pure fn.
    expect(g).toEqual(computeRimGeometry(rimBox));
    expect(lock.geometry).toEqual(computeRimGeometry(rimBox));
    expect(lock.driftDetected).toBe(false);
  });

  test('ignores non-rim classes and sub-threshold rim scores', () => {
    const lock = new RimLock();
    const ball: Detection = {
      cls: 'ball',
      score: 0.99,
      box: { x: 10, y: 10, width: 20, height: 20 },
    };
    for (let i = 0; i < 20; i++) {
      const out = lock.step(
        frame(i / FPS, [ball, rimDet(rimBox, 0.49)]), // 0.49 < rimScoreMin 0.5
        i / FPS,
      );
      expect(out).toBeNull();
    }
  });

  test('highest-score rim wins per frame', () => {
    const lock = new RimLock();
    const decoy: Box = { x: 400, y: 300, width: 40, height: 20 };
    let g = null;
    for (let i = 0; i < 5; i++) {
      g = lock.step(
        frame(i / FPS, [rimDet(decoy, 0.6), rimDet(rimBox, 0.9)]),
        i / FPS,
      );
    }
    // Had the decoy ever won, the cluster would have reset and not locked.
    expect(g).not.toBeNull();
    expect(g!.cx).toBe(120);
  });

  test('frames without rim detections do not reset the pre-lock cluster', () => {
    const lock = new RimLock();
    let count = 0;
    let g = null;
    for (let i = 0; i < 9; i++) {
      const dets = i % 2 === 0 ? [rimDet(rimBox)] : []; // rim on even frames only
      if (i % 2 === 0) count++;
      g = lock.step(frame(i / FPS, dets), i / FPS);
      if (count < 5) expect(g).toBeNull();
    }
    expect(g).not.toBeNull(); // 5th observation arrived on frame index 8
  });

  test('an inconsistent observation restarts the pre-lock cluster', () => {
    const lock = new RimLock();
    const elsewhere: Box = { x: 400, y: 300, width: 40, height: 20 };
    feed(lock, rimBox, 4, 0); // 4 consistent
    expect(lock.step(frame(4 / FPS, [rimDet(elsewhere)]), 4 / FPS)).toBeNull();
    // Needs a fresh run of 5 at the original spot; 4 more are not enough...
    expect(feed(lock, rimBox, 4, 5)).toBeNull();
    // ...the 5th consistent observation locks.
    const g = feed(lock, rimBox, 1, 9);
    expect(g).not.toBeNull();
    expect(g!.cx).toBe(120);
  });
});

describe('RimLock damping and outliers', () => {
  test('jittery detections are damped: geometry moves far less than raw jitter', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5); // lock at cx = 120

    const jitterPx = 4; // raw center jumps 8 px frame-to-frame
    let prevCx = lock.geometry!.cx;
    let maxStep = 0;
    let maxDev = 0;
    for (let i = 0; i < 30; i++) {
      const jittered: Box = { ...rimBox, x: rimBox.x + (i % 2 === 0 ? jitterPx : -jitterPx) };
      const g = lock.step(frame((5 + i) / FPS, [rimDet(jittered)]), (5 + i) / FPS);
      expect(g).not.toBeNull();
      maxStep = Math.max(maxStep, Math.abs(g!.cx - prevCx));
      maxDev = Math.max(maxDev, Math.abs(g!.cx - 120));
      prevCx = g!.cx;
    }
    const rawStep = 2 * jitterPx; // 8 px raw frame-to-frame movement
    expect(maxStep).toBeLessThan(rawStep); // strictly less than raw jitter
    expect(maxStep).toBeLessThan(RIM.lockAlpha * rawStep * 1.5); // heavily damped (~0.4 px)
    expect(maxDev).toBeLessThan(jitterPx); // never chases the jitter amplitude
    expect(lock.driftDetected).toBe(false);
  });

  test('a one-off outlier is rejected and leaves geometry untouched', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    const before = { cx: lock.geometry!.cx, cy: lock.geometry!.cy, x: lock.geometry!.box.x };

    // Displacement 100 px >> maxDriftDiagFactor * diag (≈ 22.4 px).
    const outlier: Box = { ...rimBox, x: rimBox.x + 100 };
    const g = lock.step(frame(5 / FPS, [rimDet(outlier)]), 5 / FPS);

    expect(g!.cx).toBe(before.cx);
    expect(g!.cy).toBe(before.cy);
    expect(g!.box.x).toBe(before.x);
    expect(lock.driftDetected).toBe(false);

    // A consistent observation afterwards is still accepted normally.
    lock.step(frame(6 / FPS, [rimDet(rimBox)]), 6 / FPS);
    expect(lock.geometry!.cx).toBe(120);
    expect(lock.driftDetected).toBe(false);
  });
});

describe('RimLock drift and re-lock', () => {
  const movedBox: Box = { x: 300, y: 150, width: 40, height: 20 }; // cx=320, cy=160

  test('sustained new position: driftDetected after 5 rejects, then re-lock', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5); // lock at cx=120

    // Rejects 1..4: no drift yet, geometry pinned at the old spot.
    for (let i = 0; i < 4; i++) {
      const g = lock.step(frame((5 + i) / FPS, [rimDet(movedBox)]), (5 + i) / FPS);
      expect(lock.driftDetected).toBe(false);
      expect(g!.cx).toBe(120);
    }

    // 5th consecutive reject: camera bump reported, lock still held.
    lock.step(frame(9 / FPS, [rimDet(movedBox)]), 9 / FPS);
    expect(lock.driftDetected).toBe(true);
    expect(lock.geometry!.cx).toBe(120);

    // A fresh consistent cluster at the new spot re-locks there.
    let g = lock.geometry;
    for (let i = 0; i < 4; i++) {
      g = lock.step(frame((10 + i) / FPS, [rimDet(movedBox)]), (10 + i) / FPS);
    }
    expect(g!.cx).toBe(320);
    expect(g!.cy).toBe(160);
    expect(g).toEqual(computeRimGeometry(movedBox));
    expect(lock.driftDetected).toBe(false);

    // The new lock behaves normally: old-spot detections are now the outliers.
    const back = lock.step(frame(14 / FPS, [rimDet(rimBox)]), 14 / FPS);
    expect(back!.cx).toBe(320);
  });

  test('an accepted observation at the old spot clears drift (camera came back)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    for (let i = 0; i < 5; i++) {
      lock.step(frame((5 + i) / FPS, [rimDet(movedBox)]), (5 + i) / FPS);
    }
    expect(lock.driftDetected).toBe(true);

    lock.step(frame(10 / FPS, [rimDet(rimBox)]), 10 / FPS);
    expect(lock.driftDetected).toBe(false);
    expect(lock.geometry!.cx).toBe(120);
  });

  test('inconsistent rejects never re-lock', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    // Rejects that disagree with EACH OTHER: drift is reported but no re-lock.
    for (let i = 0; i < 20; i++) {
      const wild: Box = { ...rimBox, x: 300 + (i % 2) * 200 }; // alternates 300/500
      lock.step(frame((5 + i) / FPS, [rimDet(wild)]), (5 + i) / FPS);
    }
    expect(lock.driftDetected).toBe(true);
    expect(lock.geometry!.cx).toBe(120); // still the original lock
  });

  test('a mutually-consistent cluster with implausible size (decoy object) does not re-lock', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5); // lock at 40x20

    // A much larger, mutually-consistent object (e.g. a scoreboard) at a new
    // location — internally consistent but not plausibly the same rim.
    // First 5 observations are rejects (flag drift); the cluster only starts
    // accumulating once drift is flagged, so a full re-lock attempt needs 5
    // more beyond that.
    const decoy: Box = { x: 300, y: 150, width: 40 * 3, height: 20 * 3 };
    for (let i = 0; i < 20; i++) {
      lock.step(frame((5 + i) / FPS, [rimDet(decoy)]), (5 + i) / FPS);
    }
    expect(lock.driftDetected).toBe(true);
    // Must NOT have re-locked onto the decoy: still the original lock.
    expect(lock.geometry!.cx).toBe(120);
    expect(lock.geometry!.box.width).toBe(40);
  });

  test('a mutually-consistent cluster with plausible size re-locks normally', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);

    // Same size as the original, just moved — plausible re-lock. Needs
    // DRIFT_REJECT_COUNT (5) rejects to flag drift, THEN LOCK_CLUSTER_SIZE
    // (5) more consistent observations to re-lock.
    const moved: Box = { x: 300, y: 150, width: 40, height: 20 };
    let g = null;
    for (let i = 0; i < 9; i++) {
      g = lock.step(frame((5 + i) / FPS, [rimDet(moved)]), (5 + i) / FPS);
    }
    expect(g).not.toBeNull();
    expect(g!.cx).toBe(320);
    expect(g!.cy).toBe(160);
    expect(lock.driftDetected).toBe(false);
  });

  test('a moderately different but still plausible size re-locks (within relockMaxSizeRatio)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5); // 40x20

    // 1.5x size, under RIM.relockMaxSizeRatio (1.8) — perspective/parallax
    // change from a camera bump should still be allowed to re-lock. 5 rejects
    // to flag drift, then 5 more consistent observations to re-lock.
    const moved: Box = { x: 300, y: 150, width: 60, height: 30 };
    let g = null;
    for (let i = 0; i < 10; i++) {
      g = lock.step(frame((5 + i) / FPS, [rimDet(moved)]), (5 + i) / FPS);
    }
    expect(g).not.toBeNull();
    expect(g!.box.width).toBe(60);
    expect(lock.driftDetected).toBe(false);
  });
});

describe('RimLock manual override and reset', () => {
  test('setManual locks immediately, before any detections', () => {
    const lock = new RimLock();
    lock.setManual(rimBox);
    expect(lock.geometry).toEqual(computeRimGeometry(rimBox));
    // Step with an empty frame still returns the locked geometry.
    const g = lock.step(frame(0, []), 0);
    expect(g).toEqual(computeRimGeometry(rimBox));
  });

  test('setManual overrides an existing lock and clears drift', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    const moved: Box = { x: 300, y: 150, width: 40, height: 20 };
    for (let i = 0; i < 5; i++) {
      lock.step(frame((5 + i) / FPS, [rimDet(moved)]), (5 + i) / FPS);
    }
    expect(lock.driftDetected).toBe(true);

    const manual: Box = { x: 200, y: 100, width: 50, height: 25 };
    lock.setManual(manual);
    expect(lock.driftDetected).toBe(false);
    expect(lock.geometry).toEqual(computeRimGeometry(manual));
  });

  test('reset returns to the unlocked state and can lock again', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    expect(lock.geometry).not.toBeNull();

    lock.reset();
    expect(lock.geometry).toBeNull();
    expect(lock.driftDetected).toBe(false);
    expect(lock.step(frame(1, []), 1)).toBeNull();

    // Fresh 5-frame cluster locks again.
    expect(feed(lock, rimBox, 4, 40)).toBeNull();
    expect(feed(lock, rimBox, 1, 44)).toEqual(computeRimGeometry(rimBox));
  });
});
