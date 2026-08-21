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
export {
  ArcReveal,
  arcMotif,
  type ArcMotif,
  type ArcPoint,
  type ArcRevealProps,
} from './ArcReveal';
export { CountUp, type CountUpProps } from '../fx/CountUp';
export { Confetti, type ConfettiProps } from '../fx/Confetti';
// Wave-3 primitives. Both are ALSO importable from their concrete paths —
// suites that stub this barrel down to a few symbols reach past it the same
// way ui.tsx reaches for PressScale.
export { SheetScrim, type SheetScrimProps } from './SheetScrim';
export { SelectableChip, type SelectableChipProps } from './SelectableChip';
