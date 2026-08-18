/**
 * shotOfSession — pick the ONE made shot the session report should analyse.
 *
 * WHY this exists: the app already knows how to analyse a shot in depth
 * (formAnalysis metrics + cues, postureFix cues against an NBA reference), but
 * every one of those surfaces waits for the user to CHOOSE a shot first. The
 * promise this file delivers is the opposite: the session ends and a full form
 * report is already sitting there, on a rep that was actually worth studying.
 *
 * WHY "most analysable" and not "best-looking": nothing in the pipeline
 * measures how good a made shot looked, so ranking makes by prettiness would
 * be exactly the kind of confident fiction this codebase refuses to ship. What
 * we CAN measure is how much evidence a shot carries, so the pick is the make
 * the analysis can say the most TRUE things about:
 *
 *   1. a usable pose sequence  — frame count, keypoint coverage, and which of
 *                                the four cue phases actually have the
 *                                shooting arm in view
 *   2. a complete flight       — release angle and entry angle both measured
 *   3. a confident make call   — how many fusion channels agreed, or a
 *                                hand-confirmed correction
 *
 * The weights make term 1 outrank terms 2 and 3 COMBINED (see
 * {@link FLIGHT_WEIGHT} / {@link CALL_WEIGHT}), so a materially better pose
 * capture always wins and the other two only decide near-ties. A strict
 * lexicographic order was rejected on purpose: continuous sequence scores
 * essentially never tie exactly, which would leave the flight and confidence
 * terms as dead code that reads as though it mattered.
 *
 * WHY it refuses: a made shot whose pose was never tracked cannot be given a
 * form report, and the honest answer is to name the missing piece (form
 * analysis off, shooter out of frame, capture too thin) rather than render a
 * report built out of nothing. {@link pickShotOfSession} returns a null pick
 * with a reason that says which gap it hit.
 *
 * Pure + deterministic: no React, no I/O, no wall clock. Same shots in ⇒ same
 * pick, same order, same sentence out (ties broken by ascending shot id).
 */
import {
  SEQ_KEYPOINT_ORDER,
  SEQ_TARGET_FRAMES,
  decodeSequence,
  type DecodedFrame,
} from './formSequence';
import { clamp } from './geometry';
import type { FixPhase } from './postureFix';
import type { PoseKeypointName, ResolvedShot, ShootingHand } from './types';

// ---------------------------------------------------------------------------
// Analysability thresholds
// ---------------------------------------------------------------------------

/**
 * Fewest decoded frames carrying at least one keypoint before a sequence is
 * worth analysing. Below this the phase sampling in src/core/postureFix.ts
 * collapses onto near-identical frames, so "dip versus follow-through" stops
 * meaning anything. Six is a quarter of {@link SEQ_TARGET_FRAMES}.
 */
export const MIN_USABLE_FRAMES = 6;

/**
 * Lowest mean keypoint coverage (0..1 of the COCO-17 set, averaged over every
 * decoded frame) that still supports a report. Under ~30% the shooter was
 * clipped by the frame edge or the pose model was mostly guessing.
 */
export const MIN_COVERAGE = 0.3;

/**
 * The cue engine's phase sampling points, MIRRORED from PHASE_FRAC in
 * src/core/postureFix.ts — the single source of truth for where a cue is
 * measured. postureFix keeps them private, so they are restated here for one
 * narrow purpose: asking "would the cue engine find a shooting arm to look at
 * in this phase?". If the two ever drift, this picker becomes slightly more or
 * less generous about which makes qualify; it can never make posturePlan
 * report something posturePlan did not measure.
 */
const PHASE_FRACTIONS: readonly { phase: FixPhase; frac: number }[] = [
  { phase: 'DIP', frac: 0.25 },
  { phase: 'SET', frac: 0.6 },
  { phase: 'RELEASE', frac: 0.75 },
  { phase: 'FOLLOW', frac: 0.95 },
] as const;

/** Weight of the flight-completeness term in the ranking score. */
export const FLIGHT_WEIGHT = 0.25;
/** Weight of the make-call-confidence term in the ranking score. */
export const CALL_WEIGHT = 0.1;

/** Default cap on how many alternatives the UI is offered. */
const DEFAULT_MAX_RANKED = 8;

/** Sub-weights inside the sequence score. They sum to 1. */
const W_FRAMES = 0.3;
const W_COVERAGE = 0.3;
const W_PHASES = 0.4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One made shot, scored for how much a form report could honestly say about
 * it. Every field is a measurement of the EVIDENCE, never a judgement of how
 * good the shot looked.
 */
export interface ShotPickCandidate {
  shot: ResolvedShot;
  /** Shooting hand the sequence was captured for (drives the arm-phase test). */
  hand: ShootingHand;
  /**
   * The decoded, body-normalized motion — carried so a caller can feed
   * posturePlan() without decoding the same blob a second time. Empty when the
   * shot captured no sequence at all.
   */
  sequence: DecodedFrame[];
  /** Decoded rows carrying at least one keypoint. */
  usableFrames: number;
  /** Decoded rows in total (all-missing rows included). */
  totalFrames: number;
  /** Mean fraction of the COCO-17 keypoints present per decoded frame, 0..1. */
  coverage: number;
  /** Cue phases whose sampled frame has the whole shooting arm in view. */
  armPhases: FixPhase[];
  /** 0..1 — how analysable the pose capture is (frames, coverage, phases). */
  sequenceScore: number;
  /** 0..1 — flight completeness: release angle 0.5 + entry angle 0.5. */
  flightScore: number;
  /** 0..1 — confidence in the make call itself. */
  callScore: number;
  /** Weighted total; the ranking key. */
  score: number;
  /** True when this shot clears every analysability floor. */
  usable: boolean;
}

export interface ShotOfSessionOptions {
  /** Cap on `ranked` (the alternatives strip). Default 8. */
  maxRanked?: number;
  /** Override {@link MIN_USABLE_FRAMES}. */
  minUsableFrames?: number;
  /** Override {@link MIN_COVERAGE}. */
  minCoverage?: number;
}

export interface ShotOfSessionPick {
  /** The made shot to analyse, or null when none can be analysed honestly. */
  pick: ResolvedShot | null;
  /** Every ANALYSABLE made shot, best first — the alternatives the UI offers. */
  ranked: ResolvedShot[];
  /** Plain-language sentence naming why this shot won, or what was missing. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Shooting-arm keypoints for a hand — all three are needed for any arm cue. */
function armKeypoints(hand: ShootingHand): PoseKeypointName[] {
  const s = hand === 'left' ? 'left' : 'right';
  return [
    `${s}_shoulder` as PoseKeypointName,
    `${s}_elbow` as PoseKeypointName,
    `${s}_wrist` as PoseKeypointName,
  ];
}

/** Nearest frame index to a phase fraction — mirrors postureFix's phaseIndex. */
function phaseIndex(n: number, frac: number): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.max(0, Math.round(frac * (n - 1))));
}

/** Which cue phases have the full shooting arm in view. */
function armPhasesOf(seq: readonly DecodedFrame[], hand: ShootingHand): FixPhase[] {
  if (seq.length === 0) return [];
  const arm = armKeypoints(hand);
  const out: FixPhase[] = [];
  for (const { phase, frac } of PHASE_FRACTIONS) {
    const frame = seq[phaseIndex(seq.length, frac)];
    if (!frame) continue;
    if (arm.every((name) => frame[name] != null)) out.push(phase);
  }
  return out;
}

/**
 * Release / entry angle for a shot, preferring the FSM's ball-flight value and
 * falling back to the pose report — the same precedence src/core/shotLab.ts
 * uses, so two surfaces never disagree about whether an angle exists.
 */
function angleOf(shot: ResolvedShot, which: 'release' | 'entry'): number | null {
  const v =
    which === 'release'
      ? (shot.releaseAngleDeg ?? shot.form?.metrics.releaseAngleDeg ?? null)
      : (shot.entryAngleDeg ?? shot.form?.metrics.entryAngleDeg ?? null);
  return v != null && Number.isFinite(v) ? v : null;
}

/** Fusion channels that voted "make" on this shot (0..3). */
export function agreeingChannels(shot: ResolvedShot): number {
  const s = shot.signals;
  return (s.geo === true ? 1 : 0) + (s.net === true ? 1 : 0) + (s.cls === true ? 1 : 0);
}

/**
 * 0..1 confidence that this really was a make.
 *
 * A hand-corrected shot scores 1: the user watching their own rep is the only
 * ground truth this app has. Otherwise it is the share of fusion channels that
 * agreed, docked 0.1 per demotion guard that argued against the call (`holds`
 * is diagnostic vocabulary elsewhere — it is READ here and never written).
 */
function callConfidence(shot: ResolvedShot): number {
  if (shot.corrected === true) return 1;
  const base = agreeingChannels(shot) / 3;
  const penalty = 0.1 * (shot.holds?.length ?? 0);
  return clamp(base - penalty, 0, 1);
}

/**
 * Score one shot. Exported so the UI can describe a shot the user swapped to
 * by hand with the same numbers the automatic pick was judged on.
 */
export function scoreCandidate(
  shot: ResolvedShot,
  opts?: ShotOfSessionOptions,
): ShotPickCandidate {
  const minFrames = opts?.minUsableFrames ?? MIN_USABLE_FRAMES;
  const minCoverage = opts?.minCoverage ?? MIN_COVERAGE;

  const raw = shot.form?.sequence ?? null;
  const hand: ShootingHand = raw?.hand ?? 'right';
  const sequence = raw ? decodeSequence(raw) : [];

  let usableFrames = 0;
  let presentPoints = 0;
  for (const frame of sequence) {
    let n = 0;
    for (const name of SEQ_KEYPOINT_ORDER) if (frame[name] != null) n++;
    if (n > 0) usableFrames++;
    presentPoints += n;
  }
  const totalFrames = sequence.length;
  const coverage =
    totalFrames > 0 ? presentPoints / (totalFrames * SEQ_KEYPOINT_ORDER.length) : 0;
  const armPhases = armPhasesOf(sequence, hand);

  const frameScore = clamp(usableFrames / SEQ_TARGET_FRAMES, 0, 1);
  const phaseScore = armPhases.length / PHASE_FRACTIONS.length;
  const sequenceScore =
    W_FRAMES * frameScore + W_COVERAGE * coverage + W_PHASES * phaseScore;

  const flightScore =
    (angleOf(shot, 'release') != null ? 0.5 : 0) +
    (angleOf(shot, 'entry') != null ? 0.5 : 0);
  const callScore = callConfidence(shot);

  const usable =
    usableFrames >= minFrames && coverage >= minCoverage && armPhases.length >= 1;

  return {
    shot,
    hand,
    sequence,
    usableFrames,
    totalFrames,
    coverage,
    armPhases,
    sequenceScore,
    flightScore,
    callScore,
    score: sequenceScore + FLIGHT_WEIGHT * flightScore + CALL_WEIGHT * callScore,
    usable,
  };
}

/**
 * Every MADE shot in the session, scored and sorted best-first. Misses and
 * unsure shots are excluded entirely — the promise is a report on a rep that
 * went in. Ties break on ascending shot id so the order is stable across runs.
 */
export function rankMadeShots(
  shots: readonly ResolvedShot[],
  opts?: ShotOfSessionOptions,
): ShotPickCandidate[] {
  const made = shots.filter((s) => s.outcome === 'make');
  const scored = made.map((s) => scoreCandidate(s, opts));
  scored.sort((a, b) => b.score - a.score || a.shot.id - b.shot.id);
  return scored;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** "release and entry angle both measured" … "neither flight angle measured". */
function flightPhrase(c: ShotPickCandidate): string {
  const rel = angleOf(c.shot, 'release') != null;
  const entry = angleOf(c.shot, 'entry') != null;
  if (rel && entry) return 'release and entry angle both measured';
  if (rel) return 'release angle measured but no entry angle';
  if (entry) return 'entry angle measured but no release angle';
  return 'neither flight angle measured';
}

/** "3 of 3 make signals agreed" / "you marked this one a make yourself". */
function callPhrase(c: ShotPickCandidate): string {
  if (c.shot.corrected === true) return 'you marked this one a make yourself';
  const n = agreeingChannels(c.shot);
  if (n === 0) return 'no make signal corroborated the call';
  return `${n} of 3 make ${plural(n, 'signal')} agreed`;
}

/**
 * The human sentence for one candidate — what the analysis has to work with.
 * Used for the automatic pick AND for a shot the user swapped to by hand, so
 * the card can always answer "why am I looking at this rep?".
 */
export function describeCandidate(c: ShotPickCandidate): string {
  if (!c.usable) {
    if (c.totalFrames === 0) {
      return `Shot ${c.shot.id} went in, but no pose sequence was captured for it — form analysis was off, or the shooter was out of frame.`;
    }
    return `Shot ${c.shot.id} captured only ${c.usableFrames} usable pose ${plural(
      c.usableFrames,
      'frame',
    )} at ${pct(c.coverage)} keypoint coverage, with the shooting arm visible in ${
      c.armPhases.length
    } of ${PHASE_FRACTIONS.length} shot phases — too thin to analyse.`;
  }
  const phases =
    c.armPhases.length === PHASE_FRACTIONS.length
      ? 'the shooting arm tracked through all four phases (dip, set, release, follow-through)'
      : `the shooting arm tracked in ${c.armPhases.length} of ${
          PHASE_FRACTIONS.length
        } phases (${c.armPhases.join(', ').toLowerCase()})`;
  return `Shot ${c.shot.id}: ${c.usableFrames} usable pose ${plural(
    c.usableFrames,
    'frame',
  )} at ${pct(c.coverage)} keypoint coverage, ${phases}, ${flightPhrase(c)}, ${callPhrase(c)}.`;
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

/**
 * Pick the made shot with the most to analyse, plus the ranked alternatives.
 *
 * `pick` is null when nothing qualifies, and `reason` then names the actual
 * gap — no shots, no makes, no captured pose, or a capture too thin to read —
 * because "we could not analyse this session" is a real answer and a
 * fabricated report is not.
 */
export function pickShotOfSession(
  shots: readonly ResolvedShot[],
  opts?: ShotOfSessionOptions,
): ShotOfSessionPick {
  const maxRanked = opts?.maxRanked ?? DEFAULT_MAX_RANKED;
  const candidates = rankMadeShots(shots, opts);
  const usable = candidates.filter((c) => c.usable);

  if (usable.length > 0) {
    const best = usable[0]!;
    return {
      pick: best.shot,
      ranked: usable.slice(0, Math.max(1, maxRanked)).map((c) => c.shot),
      reason: `Picked the most analysable make. ${describeCandidate(best)}`,
    };
  }

  // ---- Refusals, most specific gap first --------------------------------
  if (shots.length === 0) {
    return { pick: null, ranked: [], reason: 'No shots logged in this session yet.' };
  }
  if (candidates.length === 0) {
    const misses = shots.filter((s) => s.outcome === 'miss').length;
    const unsure = shots.filter((s) => s.outcome === 'unsure').length;
    const tail =
      misses + unsure > 0
        ? ` This session has ${misses} ${plural(misses, 'miss', 'misses')} and ${unsure} unsure ${plural(unsure, 'shot')}.`
        : '';
    return {
      pick: null,
      ranked: [],
      reason: `No made shot to analyse — the form report follows a make, so the cues describe a rep that actually went in.${tail}`,
    };
  }
  const withSequence = candidates.filter((c) => c.totalFrames > 0);
  if (withSequence.length === 0) {
    const n = candidates.length;
    return {
      pick: null,
      ranked: [],
      reason: `${n} made ${plural(n, 'shot')}, but none captured a pose sequence — turn on Shooting form analysis in Settings and keep your whole body in frame from the side.`,
    };
  }
  // Sequences exist but every one is too thin: name the closest one to the bar.
  const best = withSequence[0]!;
  return {
    pick: null,
    ranked: [],
    reason: `${describeCandidate(best)} Film side-on with your whole body in frame so the pose model can follow the dip through the follow-through.`,
  };
}
