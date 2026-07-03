/**
 * Scripted demo detector — drives the full pipeline with a synthetic scene
 * (static rim + shooter + projectile ball) so the app runs end-to-end with no
 * model file and no camera (dev mode, simulators, UI work, e2e tests).
 *
 * The script loops: make → miss (front rim) → make → rim-rattler make → miss.
 */
import { DETECTION } from '../core/config';
import type { Detection, FrameDetections } from '../core/types';

const SIZE = DETECTION.inputSize;
const RIM = { x: 420, y: 180, width: 80, height: 24 };
const PERSON = { x: 80, y: 300, width: 90, height: 260 };
const G = 900; // px/s²

interface ShotScript {
  /** Launch position/velocity. */
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  /** Seconds of flight to simulate. */
  duration: number;
  /** Emit ball_in_basket detections near the rim center. */
  scoresBasket: boolean;
  /** Simulate a rim bounce (flip vy at rim contact). */
  rimBounce?: boolean;
}

/** vy chosen so the arc peaks above the rim and lands in/near the hoop. */
const SHOTS: ShotScript[] = [
  { x0: 150, y0: 380, vx: 190, vy: -620, duration: 1.9, scoresBasket: true },
  { x0: 150, y0: 380, vx: 165, vy: -600, duration: 1.8, scoresBasket: false },
  { x0: 150, y0: 380, vx: 192, vy: -625, duration: 1.9, scoresBasket: true },
  { x0: 150, y0: 380, vx: 188, vy: -610, duration: 2.2, scoresBasket: true, rimBounce: true },
  { x0: 150, y0: 380, vx: 210, vy: -640, duration: 1.8, scoresBasket: false },
];

const IDLE_BETWEEN_SHOTS = 2.5;

export interface MockDetectorApi {
  readonly inputSize: number;
  /** Produce the scripted detections for time t (seconds). */
  frameAt(t: number): FrameDetections;
}

export function createMockDetector(): MockDetectorApi {
  const cycle = SHOTS.map((s) => s.duration + IDLE_BETWEEN_SHOTS);
  const total = cycle.reduce((a, b) => a + b, 0);

  function frameAt(t: number): FrameDetections {
    const detections: Detection[] = [
      { cls: 'rim', score: 0.92, box: { ...RIM } },
      { cls: 'person', score: 0.85, box: { ...PERSON } },
    ];

    let tc = t % total;
    let shot: ShotScript | null = null;
    let ts = 0;
    for (let i = 0; i < SHOTS.length; i++) {
      if (tc < cycle[i]!) {
        if (tc < SHOTS[i]!.duration) {
          shot = SHOTS[i]!;
          ts = tc;
        }
        break;
      }
      tc -= cycle[i]!;
    }

    if (shot) {
      let x = shot.x0 + shot.vx * ts;
      let y = shot.y0 + shot.vy * ts + 0.5 * G * ts * ts;
      const rimCx = RIM.x + RIM.width / 2;

      if (shot.rimBounce) {
        // Crude bounce: reflect a slice of time around rim contact.
        const tContact = timeAtY(shot, RIM.y);
        if (tContact != null && ts > tContact && ts < tContact + 0.35) {
          y = RIM.y - Math.abs(Math.sin((ts - tContact) * 12)) * 30;
          x = rimCx + Math.sin((ts - tContact) * 8) * 14;
        }
      }

      const r = 13;
      if (y < SIZE + 40) {
        detections.push({
          cls: 'ball',
          score: 0.86,
          box: { x: x - r, y: y - r, width: r * 2, height: r * 2 },
        });
      }
      if (
        shot.scoresBasket &&
        y > RIM.y - 6 &&
        y < RIM.y + RIM.height + 30 &&
        Math.abs(x - rimCx) < RIM.width * 0.5
      ) {
        detections.push({
          cls: 'ball_in_basket',
          score: Math.max(DETECTION.ballInBasketScoreMin + 0.1, 0.6),
          box: { x: rimCx - 24, y: RIM.y, width: 48, height: 40 },
        });
      }
    }

    return { t, frameWidth: SIZE, frameHeight: SIZE, detections };
  }

  return { inputSize: SIZE, frameAt };
}

function timeAtY(s: ShotScript, y: number): number | null {
  // Solve y0 + vy t + g/2 t² = y for the later (descending) root.
  const a = G / 2;
  const b = s.vy;
  const c = s.y0 - y;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  return (-b + Math.sqrt(disc)) / (2 * a);
}
