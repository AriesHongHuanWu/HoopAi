/**
 * @/components/motion — the ONE motion module. Every screen imports its
 * motion primitives from here (including the fx re-exports), so the app has
 * a single stagger step and a single reduced-motion idiom instead of
 * per-screen hand-rolls.
 */
export * from './stagger';
// PressScale / Shimmer / AnimatedProgressBar were built, tested and then held
// OUT of this barrel until a consumer landed. That inverted: screens kept
// hand-rolling press springs and dim-text loaders precisely BECAUSE the shared
// ones were unreachable, so the app ended up with several motion dialects.
// They are exported now — the barrel is the single source of press feedback,
// skeleton shimmer and determinate progress.
export { PressScale, type PressScaleProps } from './PressScale';
export { Shimmer, type ShimmerProps } from './Shimmer';
export { AnimatedProgressBar, clamp01 } from './AnimatedProgressBar';
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
