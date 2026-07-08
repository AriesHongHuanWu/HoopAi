/**
 * Parametric NBA reference-form SEQUENCE generator for Form Studio.
 *
 * ┌─ LEGAL / HONESTY ────────────────────────────────────────────────────────┐
 * │ These skeletons are SYNTHESIZED from each archetype's PUBLISHED mechanics  │
 * │ (release angle, tempo, dip depth, release height — see nbaBenchmarks.ts),  │
 * │ NOT player motion-capture. They are idealized coaching illustrations of a  │
 * │ style, deterministic from a handful of documented numbers. No real player  │
 * │ pose data is used or reproduced.                                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The output lives in the SAME normalized body-relative frame as a captured
 * {@link FormSequence} (hip-center origin, +y DOWN, axes in body-heights), so
 * a reference form overlays a user's form directly. We build a small set of
 * kinematic KEYFRAMES (stance → dip → rise → release → follow-through) for a
 * canonical right-handed shooter, then Catmull-Rom–interpolate to a smooth
 * 24-frame motion. The four archetype parameters bend those keyframes:
 * dip depth sets how low the wrist/hips sink, release height sets the set/
 * release point, release angle tilts the release+follow wrist vector, and
 * tempo (release time) controls WHERE in the 24 frames the release lands
 * (a quick one-motion release fires earlier than a deliberate two-motion one).
 *
 * Pure + deterministic: same archetype in ⇒ byte-identical frames out.
 */
import { clamp } from './geometry';
import { PLAYER_ARCHETYPES, type PlayerArchetype } from './nbaBenchmarks';
import { SEQ_KEYPOINT_ORDER, type DecodedFrame } from './formSequence';
import type { PoseKeypointName, ShootingHand } from './types';

/** Frames in a generated reference motion (matches SEQ_TARGET_FRAMES). */
export const REF_FRAMES = 24;

interface XY {
  x: number;
  y: number;
}

/**
 * A canonical body pose in NORMALIZED body-relative units: hip-center at the
 * origin, +y DOWN, ~1 body-height tall head-to-ankle. This is the neutral
 * "ball at set point, about to rise" base we deform through the shot. Values
 * are anthropometric proportions (a standing figure is ~[-0.5, +0.5] in y
 * around the hip-center, shoulders ~0.42 above the hips).
 *
 * Only the joints that matter for a shooting-form skeleton are populated
 * (eyes/ears are omitted — the studio doesn't draw them). Right arm is the
 * shooting arm in this canonical pose; a left-handed reference mirrors x.
 */
const BASE: Partial<Record<PoseKeypointName, XY>> = {
  nose: { x: 0.02, y: -0.5 },
  left_shoulder: { x: -0.14, y: -0.42 },
  right_shoulder: { x: 0.14, y: -0.42 },
  left_hip: { x: -0.1, y: 0 },
  right_hip: { x: 0.1, y: 0 },
  left_knee: { x: -0.11, y: 0.26 },
  right_knee: { x: 0.11, y: 0.26 },
  left_ankle: { x: -0.11, y: 0.5 },
  right_ankle: { x: 0.11, y: 0.5 },
  // Guide (left) arm — tucked, near-static.
  left_elbow: { x: -0.2, y: -0.22 },
  left_wrist: { x: -0.14, y: -0.34 },
  // Shooting (right) arm — pose per keyframe overrides these.
  right_elbow: { x: 0.2, y: -0.22 },
  right_wrist: { x: 0.14, y: -0.34 },
};

/** Params extracted from an archetype's published mechanics. */
interface RefParams {
  /** Release launch angle, degrees above horizontal (from profile). */
  releaseAngleDeg: number;
  /** Normalized set/release wrist height above hip-center (bigger = higher). */
  releaseHeight: number;
  /** How deep the dip sinks the hips/knees, in body-heights. */
  dipDepth: number;
  /** Fraction [0..1] through the 24 frames where release occurs (tempo). */
  releaseFrac: number;
  /** Elbow set-point angle target (shoulder-elbow-wrist), degrees. */
  setPointElbowDeg: number;
  hand: ShootingHand;
}

/**
 * Map an archetype's published numbers into the generator's kinematic params.
 * All conversions are documented, deterministic, and coaching-reasonable.
 */
export function paramsForArchetype(a: PlayerArchetype, hand: ShootingHand = 'right'): RefParams {
  const rel = a.profile.releaseAngleDeg;
  // Release height (~2.3–2.9 m published) → normalized wrist height. Map the
  // published band to a modest visual spread so taller-release shooters (KD,
  // Dirk) sit visibly higher than compact guards (Curry, Nash) without leaving
  // the canvas. 2.3m→0.62, 2.9m→0.86 body-heights above the hip.
  const relH = clamp(0.62 + (a.releaseHeightM - 2.3) * (0.24 / 0.6), 0.55, 0.9);
  // Dip depth: one-motion shooters (Curry, Lillard) use a shallow dip; a
  // deliberate two-motion load (Durant, Kawhi) sinks deeper. Also nudged by a
  // slower release time (more time = deeper gather).
  const tempoDepth = clamp((a.profile.releaseTimeMs - 400) / 450, 0, 1); // 400ms→0, 850ms→1
  const dip = (a.motion === 'one-motion' ? 0.05 : 0.09) + tempoDepth * 0.06;
  // Tempo → release frame fraction: a 400 ms release fires early (frac ~0.45),
  // an 850 ms two-motion release later (frac ~0.66). Clamped to keep room for
  // a follow-through tail.
  const relFrac = clamp(0.45 + (a.profile.releaseTimeMs - 400) * (0.22 / 450), 0.42, 0.7);
  // Set-point elbow: most archetypes document ~90°; keep a small spread by
  // motion so the studio's angle callouts differ meaningfully.
  const elbow = a.motion === 'one-motion' ? 88 : 92;
  return {
    releaseAngleDeg: rel,
    releaseHeight: relH,
    dipDepth: dip,
    releaseFrac: relFrac,
    setPointElbowDeg: elbow,
    hand,
  };
}

/** Clone the base body, mirrored in x for a left-handed reference. */
function baseBody(hand: ShootingHand): Map<PoseKeypointName, XY> {
  const m = new Map<PoseKeypointName, XY>();
  const mir = hand === 'left' ? -1 : 1;
  for (const name of SEQ_KEYPOINT_ORDER) {
    const p = BASE[name];
    if (p) m.set(name, { x: p.x * mir, y: p.y });
  }
  return m;
}

/** Shooting-side / guide-side joint names for the given hand. */
function armNames(hand: ShootingHand) {
  const s = hand === 'right' ? 'right' : 'left';
  const g = hand === 'right' ? 'left' : 'right';
  return {
    shoulder: `${s}_shoulder` as PoseKeypointName,
    elbow: `${s}_elbow` as PoseKeypointName,
    wrist: `${s}_wrist` as PoseKeypointName,
    guideElbow: `${g}_elbow` as PoseKeypointName,
    guideWrist: `${g}_wrist` as PoseKeypointName,
  };
}

/**
 * A single kinematic keyframe: the whole body at one phase. We build 5 of them
 * (stance, dip, rise/set, release, follow-through) then interpolate.
 */
function keyframe(
  phase: 'stance' | 'dip' | 'rise' | 'release' | 'follow',
  p: RefParams,
): Map<PoseKeypointName, XY> {
  const body = baseBody(p.hand);
  const { shoulder, elbow, wrist } = armNames(p.hand);
  const mir = p.hand === 'left' ? -1 : 1;
  const sh = body.get(shoulder)!;

  // Lower body / hips sink during the dip and recover.
  const sink = (d: number) => {
    for (const n of [
      'left_hip',
      'right_hip',
      'left_shoulder',
      'right_shoulder',
      'nose',
    ] as PoseKeypointName[]) {
      const j = body.get(n);
      if (j) j.y += d;
    }
    // Knees bend forward+down as the body sinks.
    for (const n of ['left_knee', 'right_knee'] as PoseKeypointName[]) {
      const j = body.get(n);
      if (j) {
        j.y += d * 0.5;
        j.x += mir * d * 0.4;
      }
    }
  };

  /** Place the shooting elbow + wrist for a given wrist height and elbow bend. */
  const placeArm = (wristY: number, wristX: number) => {
    body.set(wrist, { x: wristX, y: wristY });
    // Elbow sits between shoulder and wrist, pushed out to make the L.
    const midX = (sh.x + wristX) / 2 + mir * 0.06;
    const midY = (sh.y + wristY) / 2 + 0.04;
    body.set(elbow, { x: midX, y: midY });
  };

  switch (phase) {
    case 'stance': {
      // Ball at chest/waist pocket, arm relaxed.
      placeArm(-0.18, mir * 0.16);
      break;
    }
    case 'dip': {
      sink(p.dipDepth);
      // Ball dips low into the pocket with the body.
      placeArm(-0.1 + p.dipDepth, mir * 0.18);
      break;
    }
    case 'rise': {
      // Set point: ball at the forehead, elbow under it (the L).
      const setY = -(p.releaseHeight * 0.8);
      placeArm(setY, mir * 0.12);
      break;
    }
    case 'release': {
      // Full extension up-and-out at the release height; wrist leads along the
      // launch vector (release angle tilts how far forward the wrist reaches).
      const ang = (p.releaseAngleDeg * Math.PI) / 180;
      const reach = 0.16;
      const wx = mir * (0.08 + Math.cos(ang) * reach);
      const wy = -(p.releaseHeight + Math.sin(ang) * reach);
      placeArm(wy, wx);
      break;
    }
    case 'follow': {
      // Follow-through: arm fully extended, wrist snapped (gooseneck) slightly
      // further along the launch line, elbow near-straight.
      const ang = (p.releaseAngleDeg * Math.PI) / 180;
      const reach = 0.2;
      const wx = mir * (0.1 + Math.cos(ang) * reach);
      const wy = -(p.releaseHeight + Math.sin(ang) * reach);
      body.set(wrist, { x: wx, y: wy });
      // Straight arm: elbow on the shoulder→wrist line.
      body.set(elbow, {
        x: sh.x + (wx - sh.x) * 0.52,
        y: sh.y + (wy - sh.y) * 0.52,
      });
      break;
    }
  }
  return body;
}

/**
 * Phase timeline (frame fraction 0..1) for the 5 keyframes. Release lands at
 * the tempo-driven `releaseFrac`; the follow-through fills the remainder.
 */
function phaseTimeline(p: RefParams): { at: number; kf: Map<PoseKeypointName, XY> }[] {
  const rf = p.releaseFrac;
  return [
    { at: 0, kf: keyframe('stance', p) },
    { at: rf * 0.35, kf: keyframe('dip', p) },
    { at: rf * 0.72, kf: keyframe('rise', p) },
    { at: rf, kf: keyframe('release', p) },
    { at: 1, kf: keyframe('follow', p) },
  ];
}

/** Smoothstep ease for interframe blending (C1-continuous, no overshoot). */
function smooth(t: number): number {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * Interpolate the keyframe timeline into a smooth `REF_FRAMES`-long motion in
 * the normalized body-relative frame — the SAME coordinate space as a decoded
 * captured {@link FormSequence}, so it overlays a user's form directly.
 */
export function referenceSequence(
  archetype: PlayerArchetype,
  hand: ShootingHand = 'right',
): DecodedFrame[] {
  const p = paramsForArchetype(archetype, hand);
  const timeline = phaseTimeline(p);
  const out: DecodedFrame[] = [];
  for (let f = 0; f < REF_FRAMES; f++) {
    const u = f / (REF_FRAMES - 1);
    // Find the surrounding keyframes.
    let i = 0;
    while (i < timeline.length - 1 && timeline[i + 1]!.at < u) i++;
    const a = timeline[i]!;
    const b = timeline[Math.min(i + 1, timeline.length - 1)]!;
    const span = Math.max(1e-6, b.at - a.at);
    const local = smooth((u - a.at) / span);
    const frame: DecodedFrame = {};
    for (const name of SEQ_KEYPOINT_ORDER) {
      const pa = a.kf.get(name);
      const pb = b.kf.get(name);
      if (!pa || !pb) continue;
      frame[name] = {
        x: pa.x + (pb.x - pa.x) * local,
        y: pa.y + (pb.y - pa.y) * local,
      };
    }
    out.push(frame);
  }
  return out;
}

/**
 * The frame index at which the RELEASE keyframe lands, for a given archetype —
 * used by the studio to label the RELEASE phase marker on the reference track.
 */
export function referenceReleaseFrame(archetype: PlayerArchetype): number {
  const p = paramsForArchetype(archetype);
  return Math.round(p.releaseFrac * (REF_FRAMES - 1));
}

/** Look up an archetype by exact name (studio selection). Undefined if absent. */
export function archetypeByName(name: string): PlayerArchetype | undefined {
  return PLAYER_ARCHETYPES.find((a) => a.name === name);
}
