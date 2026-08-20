/**
 * Rim-drift → FT-seed lifecycle wiring.
 *
 * The width sentinel (> 15 % rim-width change) already clears a stale seed,
 * but a camera PAN that keeps rim distance roughly constant slips past it
 * while still rotating the seed's yaw — every subsequent court placement
 * would run through the pre-bump transform. So the driftDetected branch must
 * mirror reAim(): drop the seed, any pending arm, and the tracker's derived
 * session ball-size cap alongside the FT calibration it already dropped.
 *
 * Same synthetic-projectile harness as ftSeedWiring.test.ts (kept minimal —
 * only what these lifecycle assertions need).
 */
import {
  ShotPipeline,
  type FramePayload,
  type FtSeedFeedback,
} from '../shotPipeline';
import type { Box, Detection, ResolvedShot } from '../../core/types';

const FRAME = { width: 640, height: 640 };
const DT = 1 / 30;
/** Manual rim: planeY = 200, cx = 320, span 304..336, belowY = 230. */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };

// Synthetic projectile (same family as shotFsm.test.ts): +y DOWN,
// y(τ) = 400 − 700τ + 450τ², x(τ) = x0 + 60τ.
const G = 900;
const VY0 = -700;
const Y0 = 400;
const VX = 60;
const T_CROSS_DOWN =
  (700 + Math.sqrt(700 * 700 - 4 * (G / 2) * (Y0 - 200))) / (2 * (G / 2));
const SHOT_FRAMES = 48;

/** FT foot pixel whose pinhole solve lands inside the FT accept band. */
const FT_FOOT = { x: 320, y: 560 };

function ballDet(cx: number, cy: number): Detection {
  return {
    cls: 'ball',
    score: 0.8,
    box: { x: cx - 15, y: cy - 15, width: 30, height: 30 },
  };
}

function personDet(footX: number, footY: number): Detection {
  return {
    cls: 'person',
    score: 0.9,
    box: { x: footX - 30, y: footY - 100, width: 60, height: 100 },
  };
}

function framePayload(t: number, detections: Detection[]): FramePayload {
  return {
    frame: {
      t,
      frameWidth: FRAME.width,
      frameHeight: FRAME.height,
      detections,
    },
    netMotionScore: 0,
  };
}

class Session {
  clock = 0;
  readonly shots: ResolvedShot[] = [];
  readonly feedbacks: FtSeedFeedback[] = [];
  drifts = 0;
  readonly pipeline: ShotPipeline;

  constructor() {
    this.pipeline = new ShotPipeline({
      onShot: (s) => this.shots.push(s),
      onFtSeed: (r) => this.feedbacks.push(r),
      onRimDrift: () => {
        this.drifts++;
      },
    });
    this.pipeline.setManualRim(RIM_BOX, FRAME);
  }

  step(detections: Detection[]): void {
    this.pipeline.step(framePayload(this.clock, detections));
    this.clock += DT;
  }

  driveShot(xCross: number, person: Detection | null): void {
    const x0 = xCross - VX * T_CROSS_DOWN;
    for (let i = 0; i < SHOT_FRAMES; i++) {
      const tau = i * DT;
      const cy = Y0 + VY0 * tau + (G / 2) * tau * tau;
      const cx = x0 + VX * tau;
      const dets = [ballDet(cx, cy)];
      if (person) dets.push(person);
      this.step(dets);
    }
  }

  /** Flip the rim lock's private drift flag — the pan-without-width-change
   *  case the width sentinel can NEVER see (rim box untouched). */
  forceDrift(): void {
    (this.pipeline as unknown as { rimLock: { drift: boolean } }).rimLock.drift = true;
  }
}

function seedState(p: ShotPipeline): { ftSeed: unknown; ftSeedArm: unknown } {
  const priv = p as unknown as { ftSeed: unknown; ftSeedArm: unknown };
  return { ftSeed: priv.ftSeed, ftSeedArm: priv.ftSeedArm };
}

function trackerCapSpy(p: ShotPipeline): jest.SpyInstance {
  const tracker = (p as unknown as {
    tracker: { setSessionBallSizeCap: (f: number | null) => void };
  }).tracker;
  return jest.spyOn(tracker, 'setSessionBallSizeCap');
}

describe('rim drift → FT-seed lifecycle', () => {
  test('a drift event clears the derived seed and the tracker ball-size cap even when rim width is unchanged', () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    s.driveShot(320, personDet(FT_FOOT.x, FT_FOOT.y));

    // Non-vacuous: the seed really derived.
    expect(s.feedbacks).toHaveLength(1);
    expect(s.feedbacks[0]!.ok).toBe(true);
    expect(seedState(s.pipeline).ftSeed).not.toBeNull();

    const cap = trackerCapSpy(s.pipeline);
    s.forceDrift();
    s.step([]);

    expect(s.drifts).toBe(1);
    expect(seedState(s.pipeline).ftSeed).toBeNull();
    expect(cap).toHaveBeenLastCalledWith(null);
  });

  test('a drift event also cancels a pending (not yet derived) arm', () => {
    const s = new Session();
    s.pipeline.armFtSeed();
    expect(seedState(s.pipeline).ftSeedArm).not.toBeNull();

    s.forceDrift();
    s.step([]);

    expect(s.drifts).toBe(1);
    expect(seedState(s.pipeline).ftSeedArm).toBeNull();
    expect(seedState(s.pipeline).ftSeed).toBeNull();
  });
});
