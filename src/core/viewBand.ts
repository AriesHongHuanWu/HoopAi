/**
 * viewBand — classify the camera placement from the locked rim's box aspect
 * plus (optional) IMU pitch, and emit per-mechanism enablement.
 *
 * WHY BOTH SIGNALS: a circle seen edge-on projects to a wide flat ellipse and
 * seen from above/below to a round one — so the rim box aspect (w/h) encodes
 * elevation. But aspect ALONE cannot separate under-hoop (looking up) from
 * overhead (looking down): both measure ~1.1-1.5. IMU pitch disambiguates;
 * when it's unavailable (null) the classifier stays CONSERVATIVE (ambiguous
 * low-aspect views disable the fragile mechanisms rather than guessing).
 *
 * Adversarial-verification note: the original aspect-only band tables
 * INVERTED reality (real tripod side views measure 3-6, not 1.15-2.2). These
 * bands are the corrected ones; boundaries are expected to shift ±0.2-0.5
 * from telemetry before the routing flag ships on.
 *
 * Pure TypeScript, stateless, unit-testable.
 */
import { VIEW } from './config';
import type { ViewBandName } from './depthRatioGate';

export interface ViewBandEnablement {
  /** The rim-plane y-line crossing test is geometrically meaningful. */
  planeYGeo: boolean;
  /** The depth-ratio parallax veto may run. */
  depthGate: boolean;
  /** Rim-ellipse containment should REPLACE the plane test as primary geo. */
  ellipsePrimary: boolean;
  /** Reappearance corroborator may run. */
  reappearanceOverride: boolean;
  /** ball_in_basket must persist this many frames before it may decide. */
  clsMinPersistFrames: number;
  /** Metric 2/3 estimation is meaningful from this view. */
  metric23: boolean;
}

export interface ViewBandResult {
  band: ViewBandName;
  enable: ViewBandEnablement;
}

const DEFAULT_ENABLE: ViewBandEnablement = {
  planeYGeo: true,
  depthGate: true,
  ellipsePrimary: false,
  reappearanceOverride: true,
  clsMinPersistFrames: 1,
  metric23: true,
};

/**
 * @param rimAspect Locked rim box width/height (>= ~1 for any real view).
 * @param pitchDeg  Camera pitch from the IMU at rim lock: positive = tilted
 *                  UP (under-hoop), negative = tilted DOWN (elevated), null
 *                  when unavailable.
 */
export function classifyViewBand(
  rimAspect: number,
  pitchDeg: number | null,
): ViewBandResult {
  const a = Number.isFinite(rimAspect) && rimAspect > 0 ? rimAspect : 1;

  // Degraded: extreme flat ellipse — nearly edge-on/rolled geometry.
  if (a > VIEW.bandDegradedAspect) {
    return {
      band: 'degraded',
      enable: {
        planeYGeo: false,
        depthGate: false,
        ellipsePrimary: false,
        reappearanceOverride: false,
        clsMinPersistFrames: 2,
        metric23: false,
      },
    };
  }

  // Low aspect: near-round rim ⇒ camera far above or below the rim plane.
  if (a < VIEW.bandUnderOverAspect) {
    const under =
      pitchDeg != null ? pitchDeg > VIEW.underHoopPitchDeg : null;
    if (under === true) {
      // Under-hoop: image-descending ≠ world-descending; the ball is at rim
      // depth for EVERY shot (gate blind). Ellipse containment + persistent
      // cls carry the call.
      return {
        band: 'under_hoop',
        enable: {
          planeYGeo: false,
          depthGate: false,
          ellipsePrimary: true,
          reappearanceOverride: false,
          clsMinPersistFrames: 2,
          metric23: false,
        },
      };
    }
    if (under === false) {
      // Overhead/balcony looking down: geometry fine for 2/3, depth gate
      // structurally weak (depth differences barely change apparent size).
      return {
        band: 'overhead',
        enable: {
          planeYGeo: true,
          depthGate: false,
          ellipsePrimary: false,
          reappearanceOverride: true,
          clsMinPersistFrames: 1,
          metric23: true,
        },
      };
    }
    // No IMU: ambiguous — conservative union of the two (disable fragile
    // mechanisms, keep the safe ones).
    return {
      band: 'under_hoop',
      enable: {
        planeYGeo: false,
        depthGate: false,
        ellipsePrimary: true,
        reappearanceOverride: false,
        clsMinPersistFrames: 2,
        metric23: false,
      },
    };
  }

  // Elevated far view (bleachers): strong downward pitch with a side-ish
  // aspect — best 2/3 view, but the gate is depth-blind at range.
  if (pitchDeg != null && pitchDeg < -20 && a >= VIEW.bandGeoPrimaryAspect[0]) {
    return {
      band: 'elevated_far',
      enable: {
        planeYGeo: true,
        depthGate: false,
        ellipsePrimary: false,
        reappearanceOverride: true,
        clsMinPersistFrames: 1,
        metric23: true,
      },
    };
  }

  // The workhorse bands. side_wing = the verified geo-primary envelope;
  // anything between under/over and that range behaves like a behind-shooter
  // or shallow-wing view: plane test valid, gate at its BEST (short/long
  // misses are pure camera-axis parallax there), 2/3 poor.
  if (a >= VIEW.bandGeoPrimaryAspect[0] && a <= VIEW.bandGeoPrimaryAspect[1]) {
    return { band: 'side_wing', enable: { ...DEFAULT_ENABLE } };
  }
  return {
    band: 'behind_shooter',
    enable: { ...DEFAULT_ENABLE, metric23: false },
  };
}
