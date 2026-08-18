/**
 * particles — pure, deterministic particle-system math for the celebration FX.
 *
 * This module owns everything that can be reasoned about (and unit-tested)
 * WITHOUT Skia or React: a tiny seeded PRNG, particle spawning, and the
 * closed-form position/alpha of a particle at a given age. The Skia components
 * (Confetti, the ShotFlash flame-lick set) import from here and only turn the
 * returned numbers into draw calls — no physics lives in a worklet.
 *
 * Why closed-form (not a per-frame integrator): every particle's motion is a
 * pure function `state(seed, tSec)`. That means:
 *   - the arrays are spawned ONCE (pooled, zero per-frame allocation), and each
 *     frame only reads/advances a scalar clock;
 *   - the exact same inputs always produce the exact same frame, so the paths
 *     are testable deterministically from seeds alone.
 *
 * Kept free of Skia/React/Reanimated imports so it stays trivially unit-testable.
 *
 * WORKLET BOUNDARY — read before adding anything here.
 * The per-frame evaluator ({@link particleState} and the two helpers it calls)
 * runs INSIDE the callers' `useDerivedValue` worklets, so each one carries its
 * own `'worklet'` directive. A caller marking ITSELF a worklet does not
 * workletize an imported callee: react-native-worklets serializes any captured
 * non-worklet function as a Remote Function whose entire body is
 * `throw new Error('[Worklets] Tried to synchronously call a Remote Function')`
 * (see node_modules/react-native-worklets/src/memory/serializable.native.ts and
 * remoteFunctionUnpacker.native.ts). That throw lands on the UI runtime, where
 * no React error boundary can catch it — it takes the app down.
 * The spawners below stay plain JS on purpose: they are called once from
 * `useMemo` on the JS thread and never cross the boundary.
 */

/**
 * mulberry32 — a fast, well-distributed 32-bit seeded PRNG. Deterministic:
 * the same seed always yields the same sequence, which is what makes the
 * particle fields reproducible (and the tests stable). Returns a generator
 * producing floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A single spawned particle. All spatial units are px; velocity is px/sec. */
export interface Particle {
  /** Spawn origin x (px). */
  x0: number;
  /** Spawn origin y (px). */
  y0: number;
  /** Initial velocity x (px/sec). */
  vx: number;
  /** Initial velocity y (px/sec; negative = upward, screen +y is down). */
  vy: number;
  /** Base size (px) — half-extent for a square, radius for a spark. */
  size: number;
  /** Initial rotation (radians). */
  rot: number;
  /** Angular velocity (radians/sec). */
  spin: number;
  /** Palette index the caller maps to a concrete color. */
  colorIndex: number;
  /** Stagger: seconds this particle waits before it begins (0 = immediate). */
  delay: number;
}

/** Live, evaluated state of a particle at some age — what a renderer draws. */
export interface ParticleState {
  x: number;
  y: number;
  /** Current rotation (radians). */
  rot: number;
  /** Current size (px), after any age-based scaling. */
  size: number;
  /** 0..1 opacity (already includes fade-in and fade-out). */
  alpha: number;
  colorIndex: number;
}

/** Tuning for {@link spawnConfetti}. All fields optional; sensible defaults. */
export interface ConfettiConfig {
  /** Number of pieces to spawn. */
  count?: number;
  /** Emitter width (px) — pieces spread across [cx - w/2, cx + w/2]. */
  width?: number;
  /** Emitter center x (px). */
  cx?: number;
  /** Emitter y (px) — pieces start at/above this line. */
  cy?: number;
  /** Number of palette entries the caller provides (colorIndex is 0..n-1). */
  paletteSize?: number;
  /** Min/max upward launch speed (px/sec). */
  vyMin?: number;
  vyMax?: number;
  /** Horizontal spread speed magnitude (px/sec). */
  vxSpread?: number;
  /** Total burst window over which pieces stagger in (sec). */
  spawnWindow?: number;
}

const CONFETTI_DEFAULTS: Required<ConfettiConfig> = {
  count: 40,
  width: 280,
  cx: 0,
  cy: 0,
  paletteSize: 4,
  vyMin: 220,
  vyMax: 420,
  vxSpread: 160,
  spawnWindow: 0.18,
};

/**
 * spawnConfetti — build a one-shot confetti field deterministically from a
 * seed. Pieces launch upward-and-outward from a horizontal emitter, then fall
 * under gravity (applied later by {@link particleState}). Allocated once by the
 * caller and never mutated per frame.
 */
export function spawnConfetti(seed: number, config: ConfettiConfig = {}): Particle[] {
  const c = { ...CONFETTI_DEFAULTS, ...config };
  const rnd = mulberry32(seed);
  const out: Particle[] = new Array(c.count);
  for (let i = 0; i < c.count; i++) {
    const spread = (rnd() - 0.5) * c.width;
    // Bias horizontal velocity outward from the emitter center so the fan opens.
    const dir = spread >= 0 ? 1 : -1;
    out[i] = {
      x0: c.cx + spread,
      y0: c.cy - rnd() * 8,
      vx: dir * rnd() * c.vxSpread + (rnd() - 0.5) * c.vxSpread * 0.5,
      vy: -(c.vyMin + rnd() * (c.vyMax - c.vyMin)),
      size: 4 + rnd() * 4,
      rot: rnd() * Math.PI * 2,
      spin: (rnd() - 0.5) * 12,
      colorIndex: Math.floor(rnd() * c.paletteSize) % c.paletteSize,
      delay: rnd() * c.spawnWindow,
    };
  }
  return out;
}

/** Tuning for {@link spawnFlames}. */
export interface FlameConfig {
  /** Number of flame-lick particles (kept small — thermal budget). */
  count?: number;
  /** Emitter center x (px). */
  cx?: number;
  /** Emitter baseline y (px) — flames rise from here. */
  cy?: number;
  /** Half-width of the emitter mouth (px). */
  spread?: number;
  /** Min/max rise speed (px/sec; stored as negative vy). */
  riseMin?: number;
  riseMax?: number;
  /** Number of palette entries (ember → flame → tip). */
  paletteSize?: number;
  /** Stagger window (sec). */
  spawnWindow?: number;
}

const FLAME_DEFAULTS: Required<FlameConfig> = {
  count: 14,
  cx: 0,
  cy: 0,
  spread: 60,
  riseMin: 90,
  riseMax: 200,
  paletteSize: 3,
  spawnWindow: 0.24,
};

/**
 * spawnFlames — the flame-lick set that garnishes a 7+ streak make around the
 * score area. Particles rise from a narrow mouth, drift sideways slightly, and
 * shrink as they climb (buoyant lick, not a fountain). Count is intentionally
 * capped low; callers must keep the grand total (all effects) <= 24.
 */
export function spawnFlames(seed: number, config: FlameConfig = {}): Particle[] {
  const c = { ...FLAME_DEFAULTS, ...config };
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const out: Particle[] = new Array(c.count);
  for (let i = 0; i < c.count; i++) {
    out[i] = {
      x0: c.cx + (rnd() - 0.5) * 2 * c.spread,
      y0: c.cy,
      vx: (rnd() - 0.5) * 40,
      vy: -(c.riseMin + rnd() * (c.riseMax - c.riseMin)),
      size: 5 + rnd() * 6,
      rot: 0,
      spin: 0,
      // Hotter (higher index) particles are rarer → weight toward the base.
      colorIndex: Math.min(c.paletteSize - 1, Math.floor(rnd() * rnd() * c.paletteSize)),
      delay: rnd() * c.spawnWindow,
    };
  }
  return out;
}

/** Physics/appearance constants shared by the closed-form evaluator. */
export const GRAVITY = 900; // px/sec^2, screen-down.
/** Air drag: velocity is scaled by exp(-DRAG * age); light so motion reads. */
export const DRAG = 1.1;

// DECLARATION ORDER IS LOAD-BEARING BELOW THIS LINE.
// The worklets babel plugin captures a worklet's free variables EAGERLY, into a
// closure object built where the function is defined — and workletizing a
// `function` declaration costs it its hoisting. So a helper worklet declared
// AFTER its caller is still in TDZ when the caller's closure is built, and the
// call fails with "lifeAlpha is not a function" on BOTH runtimes. Helpers first,
// callers after. (Same rule as docs/INTEGRATION-REVIEW.md Lens 4, check 1.)

/** Classic smoothstep on [0,1]; clamps outside. Pure. */
export function smoothstep(x: number): number {
  // WHY 'worklet': reached from particleState via lifeAlpha, so it crosses the
  // same boundary one level down — a non-worklet callee of a worklet is still a
  // Remote Function.
  'worklet';
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/**
 * lifeAlpha — 0..1 opacity envelope for a particle of the given `age` within
 * `lifeSec`, ramping in over the first `fadeIn` fraction and out over the last
 * `fadeOut` fraction. Returns 0 once age >= life. Exported for direct reuse by
 * effects that drive their own alpha (and for testing the envelope in isolation).
 */
export function lifeAlpha(age: number, lifeSec: number, fadeIn: number, fadeOut: number): number {
  // WHY 'worklet': particleState calls this on the UI runtime every frame per
  // particle — see the WORKLET BOUNDARY note at the top of this file.
  'worklet';
  if (age <= 0 || age >= lifeSec) return 0;
  const u = age / lifeSec; // 0..1 through life.
  const rampIn = fadeIn > 0 ? smoothstep(u / fadeIn) : 1;
  const rampOut = fadeOut > 0 ? smoothstep((1 - u) / fadeOut) : 1;
  return rampIn * rampOut;
}

/**
 * particleState — the closed-form state of a particle at absolute age `tSec`
 * (seconds since the field was spawned). `lifeSec` is the field's total
 * lifetime, used to normalize the fade-out tail.
 *
 * Motion model (per axis, after the particle's own `delay`):
 *   v(a)  = v0 * exp(-DRAG * a)                       // drag-decayed velocity
 *   x(a)  = x0 + v0 * (1 - exp(-DRAG * a)) / DRAG     // integral of v
 *   y(a)  = same, plus gravity term ½·g·a²·gravityMul
 *
 * Alpha ramps up over the first `fadeIn` fraction of remaining life and eases
 * out over the last `fadeOut` fraction (smoothstep), reaching 0 at end of life.
 *
 * Fully pure and allocation-free; safe to call every frame per particle inside
 * a worklet.
 */
export function particleState(
  p: Particle,
  tSec: number,
  lifeSec: number,
  opts?: {
    /** Multiplier on gravity (0 = float, 1 = full fall). Default 1. */
    gravityMul?: number;
    /** Fraction of life spent fading in. Default 0.08. */
    fadeIn?: number;
    /** Fraction of life spent fading out. Default 0.45. */
    fadeOut?: number;
    /** Per-second size shrink factor (size *= exp(-shrink * age)). Default 0. */
    shrink?: number;
  },
): ParticleState {
  // WHY 'worklet': every caller invokes this from inside a useDerivedValue
  // worklet on the UI runtime (Confetti, SuccessBurst, FlameLicks). Without the
  // directive it is captured as a Remote Function and throws the moment the
  // first particle field is non-empty — see the WORKLET BOUNDARY note above.
  'worklet';
  const gravityMul = opts?.gravityMul ?? 1;
  const fadeIn = opts?.fadeIn ?? 0.08;
  const fadeOut = opts?.fadeOut ?? 0.45;
  const shrink = opts?.shrink ?? 0;

  const age = tSec - p.delay;
  if (age <= 0) {
    // Not yet born: sit invisibly at the spawn point.
    return { x: p.x0, y: p.y0, rot: p.rot, size: p.size, alpha: 0, colorIndex: p.colorIndex };
  }

  // Drag-decayed displacement (closed form of ∫ v0·e^(-DRAG·a) da).
  const decay = (1 - Math.exp(-DRAG * age)) / DRAG;
  const x = p.x0 + p.vx * decay;
  const y = p.y0 + p.vy * decay + 0.5 * GRAVITY * gravityMul * age * age;

  const rot = p.rot + p.spin * age;
  const size = shrink > 0 ? p.size * Math.exp(-shrink * age) : p.size;

  const alpha = lifeAlpha(age, lifeSec, fadeIn, fadeOut);

  return { x, y, rot, size, alpha, colorIndex: p.colorIndex };
}

/**
 * escalationTier — maps a make streak to the ShotFlash v2 celebration tier.
 * Pure so the component (and tests) share one definition of the thresholds:
 *   0: base burst only          (streak < 3)
 *   1: + ember-ring pulse        (streak 3–4)
 *   2: + rising heat-shimmer band(streak 5–6)
 *   3: + flame-lick particle set (streak 7+)
 * Each tier is additive (a tier-3 make shows the ring, the band AND the flames).
 */
export function escalationTier(streak: number): 0 | 1 | 2 | 3 {
  if (streak >= 7) return 3;
  if (streak >= 5) return 2;
  if (streak >= 3) return 1;
  return 0;
}
