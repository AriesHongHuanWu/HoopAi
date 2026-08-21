/**
 * Does the pose interpreter's OUTPUT look like MoveNet's output?
 *
 * WHY THIS EXISTS. The pose loader tries an accelerated delegate first
 * (Core ML on iOS, the GPU delegate on Android) and falls through to the CPU
 * interpreter only when the load or the warm-up THROWS. Nothing in that path
 * ever looked at a single output NUMBER, so a delegate that constructs
 * cleanly, invokes cleanly and returns wrong values wins the ladder silently
 * and the frame loop — which counts only frames that threw — registers a
 * perfectly healthy session. The detector path has guarded this since it
 * learned the same lesson ("a corrupt output tensor means the accelerator
 * delegate mis-ran the graph", src/camera/useShotEngine.ts); the pose path
 * had no equivalent. This module is that equivalent, kept pure so every
 * decision in it is testable off-device.
 *
 * WHAT IS AND IS NOT CLAIMED HERE. A capture reached the owner's Form Check
 * in which every keypoint's x was a CONSTANT — the whole figure on one
 * column. A forensic pass exonerated the parser (output order (y, x, score)
 * proven by translation equivariance on the real graph), every memory-layout
 * permutation of those 51 floats, eleven input-buffer corruptions, roll, and
 * every JS transform between the tensor and the stage: 210 runs of the real
 * graph produced ZERO bit-identical x pairs, because conv padding and the
 * centre prior break the symmetry even for a mathematically x-uniform image.
 * So the constant enters between the interpreter and the Float32Array, and
 * the delegate is the one unguarded thing there. Whether Core ML is ACTUALLY
 * the culprit is unproven and cannot be proven without the phone. Nothing
 * here says it is. What is certain, and what this fixes on its own terms, is
 * that the pose path accepted a delegate whose numbers were never checked.
 *
 * TWO CHECKS, TWO DIFFERENT JOBS AND TWO DIFFERENT FAILURE COSTS:
 *
 *  - {@link poseWarmupVerdict} runs at LOAD, against a fingerprint recorded
 *    from the real asset on the CPU reference. It can reject a rung, so a
 *    false positive costs frame rate (the ladder falls to CPU) — the cheap
 *    direction, deliberately chosen.
 *  - {@link poseXChannelLive} runs at FRAME RATE, on real output. It only
 *    ever raises a banner: it never refuses a frame and never pauses rep
 *    counting, so a false positive costs one wrong sentence on the rail —
 *    never the demo.
 */

/**
 * SHA-256 of `assets/models/movenet-pose.tflite` as {@link POSE_WARMUP_GOLDEN}
 * was recorded from it. Pinned so a model swap fails LOUDLY in the test suite
 * instead of silently invalidating a fingerprint that would then reject every
 * delegate on every device.
 */
export const POSE_ASSET_SHA256 =
  '0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab';

/**
 * What the real MoveNet asset returns on an all-zero uint8 192x192x3 input,
 * measured on the CPU reference interpreter (LiteRT, single-threaded, and
 * bit-identical at 2, 4 and 8 threads — the whole output moves by at most
 * 9e-7 across reduction orders).
 *
 * All-zero because that is exactly what the warm-up already feeds the
 * interpreter, and because the answer is stable there: perturbing ONE pixel
 * by one LSB moves no coordinate by more than 1e-4. It is NOT stable across
 * brightness — a uniform grey of 8 already moves a coordinate by 0.39 — which
 * is why the warm-up buffer must stay zero-filled, and why this fingerprint
 * may only ever be compared against a run on that exact buffer.
 */
export const POSE_WARMUP_GOLDEN = {
  /** Flat length of the [1,1,17,3] output. */
  length: 51,
  /** (y, x, score) for nose, left_eye, right_eye — the identity probe. */
  head: [
    [0.344149, 0.463774, 0.067864],
    [0.342034, 0.477978, 0.081331],
    [0.341573, 0.455284, 0.057946],
  ],
  /** Largest score over all 17 keypoints — an empty image confidently holds no one. */
  maxScore: 0.081331,
  /** max(x) - min(x) over all 17 keypoints — the liveness probe. */
  xSpread: 0.718388,
  /** max(y) - min(y). Recorded for the pin test; not asserted at run time. */
  ySpread: 0.25177,
} as const;

/**
 * How far a warm-up coordinate may sit from the golden one before the rung is
 * called broken.
 *
 * 0.06 normalized = 11.5 px of 192. The measured legitimate variation on this
 * graph is 9e-7 across fp32 reduction orders and 1e-4 for a one-LSB change in
 * the input image, so this is ~600x the largest drift anyone has been able to
 * produce here. fp16 on the ANE cannot be measured without the phone, so the
 * headroom is deliberately absurd: MoveNet decodes by argmax over a 48x48
 * heatmap (one cell = 0.0208), and 0.06 survives an argmax that lands three
 * whole cells away. What it does NOT survive is a dead channel — the golden x
 * values span 0.030..0.749, so a collapsed x channel misses its golden value
 * by more than 0.06 on at least fifteen of the seventeen keypoints.
 */
export const WARMUP_COORD_EPS = 0.06;

/**
 * Slack on the golden max score. 0.05 against a golden of 0.0813 is a band of
 * 0.031..0.131; the widest legitimate spread observed across every uniform
 * input from black to white was 0.064..0.114, well inside it. This catches
 * "a different graph ran" (real detection heat on an empty image), not
 * arithmetic.
 */
export const WARMUP_SCORE_EPS = 0.05;

/**
 * Floor on the warm-up x spread — the check this module exists for.
 *
 * ONE-SIDED on purpose. The failure being guarded is a channel that carries
 * NO lateral information; a delegate that spreads x FURTHER than the CPU
 * reference is not that failure, so a two-sided band would only add ways to
 * be wrong. 0.35 is half the golden 0.7184: no arithmetic difference erases
 * 0.37 of spread, and a dead channel scores ~0.
 */
export const WARMUP_X_SPREAD_MIN = 0.35;

/** Coordinates may drift a little outside 0..1 (refinement offsets) — sanity band only. */
const COORD_BAND = 0.1;

/** What a warm-up inference was found to be. */
export type PoseWarmupVerdict =
  /** The output matches the fingerprint — this rung computes MoveNet. */
  | { kind: 'ok'; detail: null }
  /**
   * There was no output tensor to look at. NOT a failure: the app never
   * reports what it did not see, and an absent output is an unmeasurable
   * rung, not a wrong one. The caller must publish it — the live guard is
   * what covers the case where those unchecked numbers turn out to be wrong.
   */
  | { kind: 'unverifiable'; detail: string }
  /** The output is present and is not what this asset computes. */
  | { kind: 'mismatch'; detail: string };

/**
 * Compare one warm-up inference against {@link POSE_WARMUP_GOLDEN}.
 *
 * @param out The array `TensorflowModel.run()` resolved with. Anything that
 *            is not a readable, at-least-51-element tensor is `unverifiable`.
 */
export function poseWarmupVerdict(out: unknown): PoseWarmupVerdict {
  if (!Array.isArray(out) || out.length === 0) {
    return { kind: 'unverifiable', detail: 'no output tensor' };
  }
  const t = out[0] as ArrayLike<number> | undefined;
  if (t == null || typeof t.length !== 'number' || t.length < POSE_WARMUP_GOLDEN.length) {
    return { kind: 'unverifiable', detail: `output length ${String(t?.length)}` };
  }
  // From here the tensor IS readable, so every remaining verdict is a claim
  // about its VALUES and a mismatch is a real finding.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let maxScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < POSE_WARMUP_GOLDEN.length; i++) {
    const v = t[i]!;
    if (!Number.isFinite(v)) return { kind: 'mismatch', detail: `non-finite at ${i}` };
    if (i % 3 === 2) {
      if (v > maxScore) maxScore = v;
      continue;
    }
    if (v < -COORD_BAND || v > 1 + COORD_BAND) {
      return { kind: 'mismatch', detail: `coord ${v.toFixed(3)} out of range at ${i}` };
    }
    if (i % 3 === 1) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  // LIVENESS first: it is the whole reason this function exists, and its
  // message is the one worth reading in a log.
  const spread = hi - lo;
  if (!(spread >= WARMUP_X_SPREAD_MIN)) {
    return {
      kind: 'mismatch',
      detail: `x spread ${spread.toFixed(4)} < ${WARMUP_X_SPREAD_MIN}`,
    };
  }
  // IDENTITY: is this the graph the fingerprint was taken from at all?
  for (let k = 0; k < POSE_WARMUP_GOLDEN.head.length; k++) {
    const g = POSE_WARMUP_GOLDEN.head[k]!;
    for (let c = 0; c < 2; c++) {
      const d = Math.abs(t[k * 3 + c]! - g[c]!);
      if (d > WARMUP_COORD_EPS) {
        return { kind: 'mismatch', detail: `keypoint ${k} axis ${c} off by ${d.toFixed(4)}` };
      }
    }
  }
  if (Math.abs(maxScore - POSE_WARMUP_GOLDEN.maxScore) > WARMUP_SCORE_EPS) {
    return { kind: 'mismatch', detail: `max score ${maxScore.toFixed(4)}` };
  }
  return { kind: 'ok', detail: null };
}

/**
 * Confidence a keypoint must clear before its x is allowed to vote on
 * liveness. Mirrors the literal `scoreMin = 0.3` default in
 * src/ml/poseParser.ts — the points this asks about are exactly the points
 * that get drawn and measured.
 */
export const POSE_SCORE_MIN = 0.3;

/**
 * Confident keypoints needed before liveness is judged at all.
 *
 * Six is a head point, a hip pair and a foot pair — the least from which a
 * lateral extent means anything. Below it there is no claim to make, and
 * {@link poseXChannelLive} says ALIVE rather than guessing.
 */
export const X_SPREAD_MIN_KEYPOINTS = 6;

/**
 * Total x extent, normalized 0..1, at or below which the x channel is
 * carrying no lateral information.
 *
 * 0.02 = 3.8 px of the 192 analysis square. The forensics set both ends of
 * this: even a mathematically x-uniform IMAGE through the real graph spreads
 * x over 35-91 px (0.18-0.47), the most degenerate legitimate case anyone
 * could construct, so this sits ~9x below it; and the capture that started
 * all of this held every keypoint within 0.84 view px of the hip-centre's own
 * x, which on a 192-square displayed at 192 px or more is 0.0044 or less —
 * well inside. The gap between those two numbers is the whole margin, and the
 * threshold is parked at the safe end of it.
 */
export const X_SPREAD_DEAD_MAX = 0.02;

/**
 * Does this frame's x channel carry lateral information?
 *
 * `'worklet'` and exported from a module, exactly like `parseMoveNet` in
 * src/ml/poseParser.ts — the pattern this file's one caller (formcheck.tsx's
 * frame processor) already runs on device, so the callee is workletised and
 * resolvable at the call site.
 *
 * Returns TRUE — alive — whenever it cannot tell, which is the direction that
 * costs nothing: too few confident keypoints is not evidence of a dead
 * channel, it is an absence of evidence.
 *
 * @param data     Flattened [1,1,17,3] MoveNet output (y, x, score).
 * @param scoreMin Confidence gate; defaults to {@link POSE_SCORE_MIN}.
 */
export function poseXChannelLive(data: ArrayLike<number>, scoreMin = POSE_SCORE_MIN): boolean {
  'worklet';
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let n = 0;
  const kp = Math.min(17, Math.floor(data.length / 3));
  for (let i = 0; i < kp; i++) {
    const s = data[i * 3 + 2]!;
    const x = data[i * 3 + 1]!;
    if (!Number.isFinite(s) || !Number.isFinite(x)) continue;
    if (s < scoreMin) continue;
    n += 1;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (n < X_SPREAD_MIN_KEYPOINTS) return true;
  return hi - lo > X_SPREAD_DEAD_MAX;
}

/**
 * Consecutive dead-x frames before the rail is allowed to say so.
 *
 * 12 is ~0.4 s at 30 fps — the same cadence formcheck's INFERENCE_FAIL_FRAMES
 * uses, and close to the detector path's own 15-frame corrupt streak. Long
 * enough that a couple of ragged frames at capture start are not a verdict.
 */
export const DEAD_TENSOR_STREAK = 12;

/**
 * Has the x channel been dead long enough to be a diagnosis rather than a
 * hiccup? A STREAK, not a total: one live frame is a counter-example and
 * resets it, the same way `inferenceFailing` refuses to say "every frame"
 * once one frame has parsed.
 */
export function poseTensorDead(deadStreak: number): boolean {
  return deadStreak >= DEAD_TENSOR_STREAK;
}
