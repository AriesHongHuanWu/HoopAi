/**
 * @/components/motion — the ONE motion module. Every screen imports its
 * motion primitives from here (including the fx re-exports), so the app has
 * a single stagger step and a single reduced-motion idiom instead of
 * per-screen hand-rolls.
 */
export * from './stagger';
// NOT exported (yet): PressScale, Shimmer and AnimatedProgressBar are fully
// built but have zero render sites — keeping them out of the barrel keeps
// them out of the app bundle until a consumer actually lands (screens like
// StartHero still hand-roll their press spring; migrate them here first and
// restore the exports then). progressBar.test.ts imports clamp01 from its
// module directly, so nothing test-side depends on these barrel lines.
export {
  SuccessBurst,
  MAX_BURST_PIECES,
  burstConfig,
  burstPieceCount,
  type SuccessBurstProps,
} from './SuccessBurst';
export { MotionStat, type MotionStatProps } from './MotionStat';
export { CountUp, type CountUpProps } from '../fx/CountUp';
export { Confetti, type ConfettiProps } from '../fx/Confetti';
