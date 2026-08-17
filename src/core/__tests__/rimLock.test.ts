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
  test('locks after 3 stable frames, null before', () => {
    const lock = new RimLock();
    for (let i = 0; i < 2; i++) {
      expect(lock.step(frame(i / FPS, [rimDet(rimBox)]), i / FPS)).toBeNull();
      expect(lock.geometry).toBeNull();
    }
    const g = lock.step(frame(2 / FPS, [rimDet(rimBox)]), 2 / FPS);
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
        frame(i / FPS, [ball, rimDet(rimBox, 0.34)]), // 0.34 < rimScoreMin 0.35
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
      if (count < 3) expect(g).toBeNull();
    }
    expect(g).not.toBeNull(); // 3rd observation arrived on frame index 4
  });

  test('an inconsistent observation restarts the pre-lock cluster', () => {
    const lock = new RimLock();
    const elsewhere: Box = { x: 400, y: 300, width: 40, height: 20 };
    feed(lock, rimBox, 2, 0); // 2 consistent (not yet locked — needs 3)
    expect(lock.step(frame(2 / FPS, [rimDet(elsewhere)]), 2 / FPS)).toBeNull();
    // Needs a fresh run of 3 at the original spot; 2 more are not enough...
    expect(feed(lock, rimBox, 2, 3)).toBeNull();
    // ...the 3rd consistent observation locks.
    const g = feed(lock, rimBox, 1, 5);
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
  // MODERATE displacement: past the reject threshold (~22px) but UNDER the
  // large-jump/pan threshold (largeJumpDiagFactor 2.5 · diag ≈ 112px), so these
  // tests exercise the SLOW 5-reject drift path (not the fast pan path).
  const movedBox: Box = { x: 160, y: 50, width: 40, height: 20 }; // cx=180, cy=60, dist 60

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
    expect(g!.cx).toBe(180);
    expect(g!.cy).toBe(60);
    expect(g).toEqual(computeRimGeometry(movedBox));
    expect(lock.driftDetected).toBe(false);

    // The new lock behaves normally: old-spot detections are now the outliers.
    const back = lock.step(frame(14 / FPS, [rimDet(rimBox)]), 14 / FPS);
    expect(back!.cx).toBe(180);
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

  // UPDATED — was `inconsistent rejects never re-lock`, which asserted that
  // drift was still set after 20 straight inconsistent rejects and left it
  // there. JUSTIFICATION FOR THE CHANGE: that assertion pinned the UNBOUNDED
  // half of the drift latch, which is the defect itself. Mutually-inconsistent
  // rejects are exactly what a knocked camera produces, they can never form a
  // cluster, so drift — and the pipeline arm lockout it drives — persisted for
  // the WHOLE session: zero attempts recorded, and a drift banner that had
  // already timed out after ~4 s, i.e. "NOTHING triggers at all" with no
  // signal. What the old test legitimately encoded is kept below (inconsistent
  // rejects must never RE-LOCK, and must not drop the lock EARLY); the test now
  // continues past DRIFT_MAX_UNRESOLVED_SEC to pin the self-heal that replaces
  // the latch.
  test('inconsistent rejects never re-lock, and drift is bounded not latched', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    const wild = (i: number): Box => ({ ...rimBox, x: 300 + (i % 2) * 200 }); // 300/500
    // Rejects that disagree with EACH OTHER: drift is reported but no re-lock.
    let i = 0;
    for (; i < 20; i++) {
      lock.step(frame((5 + i) / FPS, [rimDet(wild(i))]), (5 + i) / FPS);
    }
    expect(lock.driftDetected).toBe(true);
    expect(lock.geometry!.cx).toBe(120); // still the original lock
    // ...and it is still held here: 20 frames is 0.67 s, well inside the 1.5 s
    // unresolved-drift bound, so nothing is dropped EARLY.
    expect(lock.geometry).not.toBeNull();

    // Same junk, carried past the bound: the machine must let the lock go
    // rather than publish stale geometry forever while arming is refused.
    for (; (5 + i) / FPS < 2.6; i++) {
      lock.step(frame((5 + i) / FPS, [rimDet(wild(i))]), (5 + i) / FPS);
    }
    expect(lock.driftDetected).toBe(false);
    expect(lock.geometry).toBeNull(); // back to ACQUIRING, never re-locked on junk
    expect(lock.lockGeneration).toBe(1); // an unlock is not a lock
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

  test('a LARGE strong-confidence jump re-locks fast (no 5 rejects needed)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5); // lock at cx=120
    const pan: Box = { x: 300, y: 150, width: 40, height: 20 }; // cx=320, far (dist ~226 > large-jump ~112)
    // One strong far detection flags drift immediately (not after 5 rejects).
    lock.step(frame(5 / FPS, [rimDet(pan, 0.9)]), 5 / FPS);
    expect(lock.driftDetected).toBe(true);
    expect(lock.geometry!.cx).toBe(120); // not re-locked yet — still needs a full cluster
    // Two more consistent frames complete the LOCK_CLUSTER_SIZE(3) cluster → re-lock.
    let g = lock.geometry;
    for (let i = 0; i < 2; i++) {
      g = lock.step(frame((6 + i) / FPS, [rimDet(pan, 0.9)]), (6 + i) / FPS);
    }
    expect(g!.cx).toBe(320); // re-locked in 3 frames total, not 8
    expect(lock.driftDetected).toBe(false);
  });

  test('a large jump with WEAK score does NOT fast-path (falls to the slow 5-reject path)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    const farWeak: Box = { x: 300, y: 150, width: 40, height: 20 }; // far but low score
    for (let i = 0; i < 4; i++) {
      lock.step(frame((5 + i) / FPS, [rimDet(farWeak, 0.5)]), (5 + i) / FPS); // 0.5 < relockStrongScore 0.6
      expect(lock.driftDetected).toBe(false);
    }
    lock.step(frame(9 / FPS, [rimDet(farWeak, 0.5)]), 9 / FPS);
    expect(lock.driftDetected).toBe(true); // drift only after the 5th slow reject
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
    // Moderate displacement → slow 5-reject drift (no re-lock), so drift is
    // still set when setManual overrides it.
    const moved: Box = { x: 160, y: 50, width: 40, height: 20 };
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

    // Fresh 3-frame cluster locks again.
    expect(feed(lock, rimBox, 2, 40)).toBeNull();
    expect(feed(lock, rimBox, 1, 42)).toEqual(computeRimGeometry(rimBox));
  });
});

describe('RimLock oversized-box admission gate', () => {
  test('a huge bottom-right rim box (> rimMaxSizeFraction) never locks', () => {
    // 220px on a 640 square = 0.34 of the side, above rimMaxSizeFraction (0.30).
    // Bottom-right corner, mimicking the reported phantom.
    const huge: Box = { x: 400, y: 400, width: 220, height: 220 };
    const lock = new RimLock();
    // Far more frames than LOCK_CLUSTER_SIZE(3): must still never lock.
    for (let i = 0; i < 10; i++) {
      const g = lock.step(frame(i / FPS, [rimDet(huge, 0.9)]), i / FPS);
      expect(g).toBeNull();
    }
    expect(lock.geometry).toBeNull();
    expect(lock.driftDetected).toBe(false);
  });

  test('a huge box cannot hijack or corrupt an existing good lock', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5); // lock at the small 40x20 rim, cx=120
    const huge: Box = { x: 400, y: 400, width: 220, height: 220 };
    for (let i = 0; i < 10; i++) {
      const g = lock.step(frame((5 + i) / FPS, [rimDet(huge, 0.95)]), (5 + i) / FPS);
      // Held geometry stays the original small rim, never the huge corner box.
      expect(g!.box.width).toBe(40);
      expect(g!.cx).toBe(120);
    }
    expect(lock.driftDetected).toBe(false);
  });

  test('a normal-sized rim box just under the cap still locks', () => {
    // 180px = 0.28 of 640, under rimMaxSizeFraction(0.30): admitted normally.
    const ok: Box = { x: 200, y: 200, width: 180, height: 180 };
    const g = feed(new RimLock(), ok, 3);
    expect(g).not.toBeNull();
    expect(g!.box.width).toBe(180);
  });
});

describe('RimLock bump-settle boost', () => {
  const diag = Math.hypot(rimBox.width, rimBox.height); // ≈ 44.72
  // 0.3·diag ≈ 13.4 px bump: INSIDE the accept zone (maxDriftDiagFactor 0.5 ·
  // diag ≈ 22.4 px), so every observation is ACCEPTED and drift never fires —
  // only the damping speed is in play.
  const bumped: Box = { ...rimBox, x: rimBox.x + 0.3 * diag };
  const bumpedCx = bumped.x + bumped.width / 2;

  test('settle boost converges after a small bump', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5); // lock at cx=120
    let g = lock.geometry;
    for (let i = 0; i < 6; i++) {
      g = lock.step(frame((5 + i) / FPS, [rimDet(bumped)]), (5 + i) / FPS);
    }
    // Re-centered within 0.05·diag (≈ 2.2 px) by observation 6. Plain
    // lockAlpha would still be ≈ 9.9 px off here (see the control below).
    expect(Math.abs(g!.cx - bumpedCx)).toBeLessThan(0.05 * diag);
    expect(lock.driftDetected).toBe(false);
  });

  test('control: setBumpSettle(false) keeps the slow lockAlpha convergence', () => {
    const lock = new RimLock();
    lock.setBumpSettle(false);
    feed(lock, rimBox, 5);
    let g = lock.geometry;
    for (let i = 0; i < 6; i++) {
      g = lock.step(frame((5 + i) / FPS, [rimDet(bumped)]), (5 + i) / FPS);
    }
    // 13.4 · 0.95^6 ≈ 9.9 px — still well off after 6 accepted frames.
    expect(Math.abs(g!.cx - bumpedCx)).toBeGreaterThan(0.15 * diag);
  });

  test('boost disengages after convergence: back to the slow alpha', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    // Converge on the bumped position and let the offset EMA decay below the
    // exit threshold (hysteresis) so the boost is disengaged again.
    for (let i = 0; i < 20; i++) {
      lock.step(frame((5 + i) / FPS, [rimDet(bumped)]), (5 + i) / FPS);
    }
    const cxBefore = lock.geometry!.cx;
    // A small one-frame jitter must now move the lock by ≈ lockAlpha·dx
    // (~0.05·dx), not SETTLE_ALPHA·dx (0.35·dx).
    const jitter: Box = { ...bumped, x: bumped.x + 4 };
    const g = lock.step(frame(25 / FPS, [rimDet(jitter)]), 25 / FPS);
    const dx = jitter.x + jitter.width / 2 - cxBefore;
    const moved = Math.abs(g!.cx - cxBefore);
    expect(moved).toBeLessThan(0.1 * Math.abs(dx)); // slow again
    expect(moved).toBeGreaterThan(0.02 * Math.abs(dx)); // ...but not frozen
  });

  test('symmetric jitter never engages the boost (EMA cancels)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    // Same ±4 px alternation as the damping suite: the offset EMA oscillates
    // near zero, so damping must stay at lockAlpha throughout.
    let prevCx = lock.geometry!.cx;
    let maxStep = 0;
    for (let i = 0; i < 30; i++) {
      const jittered: Box = { ...rimBox, x: rimBox.x + (i % 2 === 0 ? 4 : -4) };
      const g = lock.step(frame((5 + i) / FPS, [rimDet(jittered)]), (5 + i) / FPS);
      maxStep = Math.max(maxStep, Math.abs(g!.cx - prevCx));
      prevCx = g!.cx;
    }
    // A boosted frame would step ≈ 0.35 · 8 = 2.8 px; lockAlpha steps ≈ 0.4 px.
    expect(maxStep).toBeLessThan(RIM.lockAlpha * 8 * 1.5);
  });
});

describe('RimLock lockGeneration', () => {
  // Moderate displacement (same recipe as the drift suite): past the reject
  // threshold, under the large-jump threshold → slow 5-reject drift path.
  const movedBox: Box = { x: 160, y: 50, width: 40, height: 20 };

  test('0 before lock, 1 after first lock, stable across EMA accepts', () => {
    const lock = new RimLock();
    expect(lock.lockGeneration).toBe(0);
    feed(lock, rimBox, 5);
    expect(lock.lockGeneration).toBe(1);
    // 20 ordinary accepted EMA frames never bump the generation.
    feed(lock, rimBox, 20, 5);
    expect(lock.lockGeneration).toBe(1);
  });

  test('increments once on a drift + re-lock sequence', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    expect(lock.lockGeneration).toBe(1);
    // 5 slow rejects flag drift, then a consistent cluster at the new spot
    // re-locks there — the generation must move so in-place-mutation
    // consumers (fsm.setRim, worklet ROI sync) can see the re-lock.
    let g = null;
    for (let i = 0; i < 9; i++) {
      g = lock.step(frame((5 + i) / FPS, [rimDet(movedBox)]), (5 + i) / FPS);
    }
    expect(g!.cx).toBe(180); // re-locked at the new spot...
    expect(lock.driftDetected).toBe(false);
    expect(lock.lockGeneration).toBe(2); // ...and the generation moved once
  });

  test('increments on setManual', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    expect(lock.lockGeneration).toBe(1);
    lock.setManual({ x: 200, y: 100, width: 50, height: 25 });
    expect(lock.lockGeneration).toBe(2);
  });

  test('survives reset (monotonic), then increments on the next lock', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 5);
    lock.reset();
    // Monotonic across resets so a consumer comparing a cached generation can
    // never miss a re-lock that follows a session reset.
    expect(lock.lockGeneration).toBe(1);
    feed(lock, rimBox, 3, 40);
    expect(lock.lockGeneration).toBe(2);
  });
});

/**
 * Module consts under test. They are deliberately private to rimLock.ts (same
 * reason DRIFT_REJECT_COUNT is), so the numbers are mirrored here and every
 * assertion below states the physical claim it is checking, not just the number.
 */
const DRIFT_REJECT_SPAN_SEC = 0.4;
const DRIFT_MAX_UNRESOLVED_SEC = 1.5;
const FOLLOW_MAX_STEP_FRAC = 0.08;

describe('RimLock drift self-heal (bounded lockout)', () => {
  /** Moderate displacement: past the reject gate (~22 px), under the large-jump
   *  pan threshold (~112 px) → the slow reject path. */
  const bumped: Box = { ...rimBox, x: rimBox.x + 60 };

  test('an unresolved drift self-heals to UNLOCKED, then re-locks normally', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    expect(lock.lockGeneration).toBe(1);
    expect(lock.trusted).toBe(true);

    // Mutually-inconsistent rejects: a knocked camera's signature, and the case
    // that can never resolve itself by re-locking.
    const wild = (i: number): Box => ({ ...rimBox, x: 300 + (i % 2) * 200 });
    let t = 0.1;
    let driftAt = -1;
    for (let i = 0; t < 1.0; i++, t += 1 / FPS) {
      lock.step(frame(t, [rimDet(wild(i))]), t);
      if (lock.driftDetected && driftAt < 0) driftAt = t;
    }
    // Inside the bound the old behaviour is preserved exactly: drifted, and the
    // last known geometry is still published for the HUD.
    expect(driftAt).toBeGreaterThan(0);
    expect(lock.driftDetected).toBe(true);
    expect(lock.trusted).toBe(false);
    expect(lock.geometry!.cx).toBe(120);
    // The age query the UI needs so a bump banner can outlive its 4 s timer.
    expect(lock.driftSinceSec(t)!).toBeCloseTo(t - driftAt, 6);

    // Past the bound: give up the lock instead of publishing stale geometry
    // forever while the pipeline refuses every arm branch.
    const healBy = driftAt + DRIFT_MAX_UNRESOLVED_SEC + 2 / FPS;
    for (let i = 0; t < healBy; i++, t += 1 / FPS) {
      lock.step(frame(t, [rimDet(wild(i))]), t);
    }
    expect(lock.driftDetected).toBe(false);
    expect(lock.geometry).toBeNull();
    expect(lock.driftSinceSec(t)).toBeNull();
    expect(lock.trusted).toBe(false);
    expect(lock.lockCountdown).toBeNull();
    expect(lock.lockGeneration).toBe(1); // an unlock is not a lock

    // ...and the ordinary acquire path works from there: 3 consistent
    // detections at the new location re-lock (this is the path that shows the
    // 3-2-1 countdown when lockHoldSec is configured).
    const newSpot: Box = { x: 300, y: 150, width: 40, height: 20 };
    expect(feed(lock, newSpot, 2, Math.round(t * FPS) + 1)).toBeNull();
    const g = feed(lock, newSpot, 1, Math.round(t * FPS) + 3);
    expect(g!.cx).toBe(320);
    expect(lock.trusted).toBe(true);
    expect(lock.lockGeneration).toBe(2); // monotonic: the RE-LOCK is the bump
  });

  test('a drift resolved inside the bound never costs the lock', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    for (let i = 0; i < 5; i++) {
      lock.step(frame((3 + i) / FPS, [rimDet(bumped)]), (3 + i) / FPS);
    }
    expect(lock.driftDetected).toBe(true);

    // Camera wobbles back 0.5 s later — well inside the 1.5 s bound, so the
    // cheap resolution (accepted observation at the old spot) still wins and no
    // re-acquisition is paid for.
    lock.step(frame(0.5, [rimDet(rimBox)]), 0.5);
    expect(lock.driftDetected).toBe(false);
    expect(lock.geometry!.cx).toBe(120);
    expect(lock.lockGeneration).toBe(1);
  });

  test('self-heal survives a rim that simply vanishes (no observations at all)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    // One disagreeing frame, then the rim is gone: no observation can ever
    // clear the drift, so only the clock can.
    lock.step(frame(1.0, [rimDet(bumped)]), 1.0);
    let t = 1.0;
    for (; t < 1.0 + DRIFT_REJECT_SPAN_SEC + DRIFT_MAX_UNRESOLVED_SEC + 0.1; t += 1 / FPS) {
      lock.step(frame(t, []), t);
    }
    expect(lock.geometry).toBeNull();
    expect(lock.driftDetected).toBe(false);
  });
});

describe('RimLock time-bounded drift declaration', () => {
  const bumped: Box = { ...rimBox, x: rimBox.x + 60 };

  test('a bump that makes the rim UNDETECTABLE still declares drift', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    // The bump frame is one reject; then the rim stops being detected at all
    // (motion blur / knocked partly out of frame / newly backlit). The reject
    // COUNTER freezes at 1 forever, so DRIFT_REJECT_COUNT can never be reached
    // and the lock used to keep publishing geometry for a rim that moved.
    lock.step(frame(1.0, [rimDet(bumped)]), 1.0);
    expect(lock.driftDetected).toBe(false); // 1 reject alone: unchanged

    let t = 1.0 + 1 / FPS;
    for (; t < 1.0 + DRIFT_REJECT_SPAN_SEC - 1 / FPS; t += 1 / FPS) {
      lock.step(frame(t, []), t); // EMPTY frames only
      expect(lock.driftDetected).toBe(false); // still inside the span bound
    }
    for (; t < 1.0 + DRIFT_REJECT_SPAN_SEC + 1 / FPS; t += 1 / FPS) {
      lock.step(frame(t, []), t);
    }
    expect(lock.driftDetected).toBe(true);
    expect(lock.driftSinceSec(t)).not.toBeNull();
  });

  test('sparse rejects declare drift on the clock, before the count rule could', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    // ~6.7 Hz reject cadence (a slow phone, or intermittent detection after the
    // bump). Three rejects span 0.30 s: inside the bound, and nowhere near
    // DRIFT_REJECT_COUNT (5).
    for (const t of [1.0, 1.15, 1.3]) {
      lock.step(frame(t, [rimDet(bumped)]), t);
      expect(lock.driftDetected).toBe(false);
    }
    // The 4th spans 0.45 s ≥ 0.4 s → drift, one reject before the count rule
    // could have fired (and ~0.3 s before it actually would have).
    lock.step(frame(1.45, [rimDet(bumped)]), 1.45);
    expect(lock.driftDetected).toBe(true);
  });

  test('at 30 fps the COUNT rule still fires first (nominal behaviour unchanged)', () => {
    // 5 consecutive rejects at 30 fps span 4/30 = 0.133 s, so the 0.4 s time
    // rule can never pre-empt the count rule at the fps the frame-count gates
    // were authored against. Only slow / intermittent detection changes.
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    for (let i = 0; i < 4; i++) {
      lock.step(frame((3 + i) / FPS, [rimDet(bumped)]), (3 + i) / FPS);
      expect(lock.driftDetected).toBe(false);
    }
    lock.step(frame(7 / FPS, [rimDet(bumped)]), 7 / FPS);
    expect(lock.driftDetected).toBe(true);
  });

  test('absence alone never declares drift (an occluded rim costs nothing)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    // A player stands in front of the rim for 2 s: no rejects, so no positive
    // evidence the geometry is wrong → the lock is kept, untouched.
    for (let t = 0.2; t < 2.2; t += 1 / FPS) lock.step(frame(t, []), t);
    expect(lock.driftDetected).toBe(false);
    expect(lock.geometry!.cx).toBe(120);
    expect(lock.trusted).toBe(true);
  });
});

describe('RimLock continuous clamped re-lock', () => {
  const diag = Math.hypot(rimBox.width, rimBox.height); // ≈ 44.72
  const clampPx = FOLLOW_MAX_STEP_FRAC * diag; // ≈ 3.58 px per frame, per coord

  test('a SMALL sustained offset converges within a few frames, not tens', () => {
    // 0.1·diag ≈ 4.5 px: inside the accept gate (0.5·diag ≈ 22 px) and BELOW the
    // old 0.12·diag fast-damp threshold, so it used to crawl at lockAlpha —
    // ≈3.0 px still wrong after 8 frames, seconds of subtly-wrong zones.
    const shifted: Box = { ...rimBox, x: rimBox.x + 0.1 * diag };
    const targetCx = shifted.x + shifted.width / 2;
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    let g = lock.geometry;
    for (let i = 0; i < 8; i++) {
      g = lock.step(frame((3 + i) / FPS, [rimDet(shifted)]), (3 + i) / FPS);
    }
    expect(Math.abs(g!.cx - targetCx)).toBeLessThan(0.025 * diag); // ≈1.1 px
    expect(lock.driftDetected).toBe(false); // never left the accept gate
  });

  test('one accepted edge-of-gate observation moves the box by at most the clamp', () => {
    // 0.49·diag ≈ 21.9 px is the largest displacement the (unchanged) gate
    // accepts. Unclamped, the fast damp would lurch 0.35·21.9 ≈ 7.7 px on the
    // strength of ONE frame; clamped it is a sub-rim-radius nudge.
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    const before = lock.geometry!.box.x;
    const edge: Box = { ...rimBox, x: rimBox.x + 0.49 * diag };
    const g = lock.step(frame(3 / FPS, [rimDet(edge)]), 3 / FPS);
    const moved = g!.box.x - before;
    expect(moved).toBeGreaterThan(0); // it does follow...
    expect(moved).toBeLessThanOrEqual(clampPx + 1e-9); // ...but only this far
  });

  test('a single far outlier is still rejected outright (zero movement)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    const before = lock.geometry!.box.x;
    const outlier: Box = { ...rimBox, x: rimBox.x + 100 }; // 100 px >> 0.5·diag
    const g = lock.step(frame(3 / FPS, [rimDet(outlier, 0.95)]), 3 / FPS);
    expect(g!.box.x).toBe(before); // 0 px — well inside the clamp
    expect(lock.driftDetected).toBe(false);
  });

  test('the accept/reject gate is byte-identical (0.5·diag boundary)', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    const x0 = lock.geometry!.box.x;
    // Just OUTSIDE the gate: rejected, geometry frozen.
    const out: Box = { ...rimBox, x: rimBox.x + 0.501 * diag };
    lock.step(frame(3 / FPS, [rimDet(out)]), 3 / FPS);
    expect(lock.geometry!.box.x).toBe(x0);
    // Just INSIDE: accepted, and followed by no more than the clamp.
    const inside: Box = { ...rimBox, x: rimBox.x + 0.499 * diag };
    lock.step(frame(4 / FPS, [rimDet(inside)]), 4 / FPS);
    expect(lock.geometry!.box.x).toBeGreaterThan(x0);
    expect(lock.geometry!.box.x - x0).toBeLessThanOrEqual(clampPx + 1e-9);
  });

  test('a static decoy outside the gate can never walk the lock toward it', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    const decoy: Box = { ...rimBox, x: rimBox.x + 100 }; // e.g. a second hoop
    for (let i = 0; i < 4; i++) {
      lock.step(frame((3 + i) / FPS, [rimDet(decoy, 0.95)]), (3 + i) / FPS);
      // Not one pixel of creep: the decoy is never inside the gate around the
      // box's CURRENT position, so it contributes no accepted frame at all.
      expect(lock.geometry!.box.x).toBe(rimBox.x);
    }
    // The 5th declares drift instead — handing the decision to the visible,
    // countdown-gated acquire path rather than creeping across the frame.
    lock.step(frame(7 / FPS, [rimDet(decoy, 0.95)]), 7 / FPS);
    expect(lock.driftDetected).toBe(true);
    expect(lock.geometry!.box.x).toBe(rimBox.x);
  });
});

describe('RimLock geometry-moved query', () => {
  const diag = Math.hypot(rimBox.width, rimBox.height);

  test('reports the first lock, then only movement past the 1 px hysteresis', () => {
    const lock = new RimLock();
    expect(lock.geometryMoved).toBe(false); // nothing locked yet
    feed(lock, rimBox, 3);
    expect(lock.geometryMoved).toBe(true); // a fresh lock is unseen geometry
    expect(lock.consumeGeometryMoved()).toBe(true);
    expect(lock.consumeGeometryMoved()).toBe(false); // consumed

    // Identical accepted observations: the EMA step is exactly 0.
    feed(lock, rimBox, 10, 3);
    expect(lock.consumeGeometryMoved()).toBe(false);

    // A sustained offset the accept gate allows: the box follows, so consumers
    // that cache rim-relative state must be told — `lockGeneration` cannot see
    // this (no re-lock happened) and neither can ref-equality (in-place mutation).
    const shifted: Box = { ...rimBox, x: rimBox.x + 0.2 * diag };
    feed(lock, shifted, 3, 13);
    expect(lock.lockGeneration).toBe(1);
    expect(lock.consumeGeometryMoved()).toBe(true);
  });

  test('a hard re-lock always reports moved', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    expect(lock.consumeGeometryMoved()).toBe(true);
    lock.setManual({ x: 200, y: 100, width: 50, height: 25 });
    expect(lock.consumeGeometryMoved()).toBe(true);
    expect(lock.consumeGeometryMoved()).toBe(false);
  });

  test('nothing to push while unlocked after a self-heal drop', () => {
    const lock = new RimLock();
    feed(lock, rimBox, 3);
    lock.consumeGeometryMoved();
    // Drift on inconsistent junk, then carry it past the unresolved bound.
    let t = 0.2;
    for (let i = 0; t < 2.6; i++, t += 1 / FPS) {
      const wild: Box = { ...rimBox, x: 300 + (i % 2) * 200 };
      lock.step(frame(t, [rimDet(wild)]), t);
    }
    expect(lock.geometry).toBeNull();
    expect(lock.geometryMoved).toBe(false); // unlocked: no geometry to push
    // The re-lock that follows is reported.
    feed(lock, rimBox, 3, Math.round(t * FPS) + 1);
    expect(lock.consumeGeometryMoved()).toBe(true);
  });
});

describe('RimLock — pre-lock hold countdown', () => {
  const step = (lock: RimLock, box: Box, t: number) =>
    lock.step(frame(t, [rimDet(box)]), t);

  test('default (no hold) locks immediately, no countdown', () => {
    const lock = new RimLock();
    const g = feed(lock, rimBox, 3);
    expect(g).not.toBeNull();
    expect(lock.lockCountdown).toBeNull();
  });

  test('locks only after lockHoldSec of continuous stable rim, exposing 3-2-1', () => {
    const hold = 2.5;
    const lock = new RimLock({ lockHoldSec: hold });
    let out = null;
    let t = 0;
    // Continuous stable rim up to just before the hold — cluster forms, no lock.
    for (; t < hold - 0.1; t += 1 / FPS) out = step(lock, rimBox, t);
    expect(out).toBeNull();
    expect(lock.lockCountdown).not.toBeNull();
    expect(lock.lockCountdown!).toBeGreaterThan(0);
    expect(Math.ceil(lock.lockCountdown!)).toBe(1); // final "1" of 3-2-1
    // A few more frames past the hold → locks, countdown clears.
    for (; t < hold + 0.15; t += 1 / FPS) out = step(lock, rimBox, t);
    expect(out).not.toBeNull();
    expect(lock.lockCountdown).toBeNull();
  });

  test('a big move restarts the countdown (no lock on a jittering rim)', () => {
    const hold = 2.0;
    const lock = new RimLock({ lockHoldSec: hold });
    let t = 0;
    for (; t < 1.0; t += 1 / FPS) step(lock, rimBox, t);
    const mid = lock.lockCountdown;
    expect(mid).not.toBeNull();
    // A large jump resets the cluster → countdown restarts near full.
    const moved: Box = { x: rimBox.x + 300, y: rimBox.y + 200, width: rimBox.width, height: rimBox.height };
    step(lock, moved, t);
    expect(lock.lockCountdown!).toBeGreaterThan(mid!);
    expect(lock.geometry).toBeNull();
  });

  test('a vanished rim clears the forming cluster', () => {
    const lock = new RimLock({ lockHoldSec: 2.0 });
    step(lock, rimBox, 0);
    expect(lock.lockCountdown).not.toBeNull();
    // No rim for > CLUSTER_STALE_SEC (1s) → cluster discarded.
    const gone = lock.step(frame(1.5, []), 1.5);
    expect(gone).toBeNull();
    expect(lock.lockCountdown).toBeNull();
  });
});
