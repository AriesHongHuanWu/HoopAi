/**
 * detectionExplainer — the single source of truth for the "How detection
 * works" explainer copy (src/app/how-it-works.tsx). Same pattern as
 * calibrationGuide.ts: every surface renders from this module so the
 * explainer, the receipt chips and the honesty language can never drift
 * apart. The signal keys mirror evidence.ts EVIDENCE_CHANNELS exactly and
 * the demo receipt is rendered with the REAL evidence helpers.
 *
 * Pure TypeScript: no React, no I/O, no clocks.
 *
 * IRON-RULE GUARD (bread-ball rule, copy layer): a `receiptDemo` whose
 * outcome is 'make' MUST have `signals.geo === true`. The geometric path is
 * the only signal that can establish a make — the explainer may never show
 * corroborators outvoting it, or the teaching surface itself would lie about
 * how calls are made. Locked by detectionExplainer.test.ts.
 */
import type { EvidenceChannel } from './evidence';

/** One of the three fusion channels, exactly as the receipt row keys them. */
export type ExplainerSignalKey = EvidenceChannel['key'];

export interface ExplainerSignal {
  key: ExplainerSignalKey;
  title: string;
  body: string;
}

export interface ExplainerRule {
  /** Ionicons glyph name — kept as a plain string so core stays UI-free. */
  icon: string;
  title: string;
  body: string;
}

/**
 * Sample receipt for the explainer screen. Shaped ShotSignals-compatible
 * (evidence.ts helpers consume it directly); `illusion` is banned here — the
 * demo teaches the three fusion channels, not the parallax veto.
 */
export interface ExplainerReceiptDemo {
  signals: { geo: boolean | null; net: boolean | null; cls: boolean | null; illusion?: never };
  rimBounce: boolean;
  outcome: 'make' | 'miss' | 'unsure';
}

export interface DetectionExplainer {
  headline: string;
  lede: string;
  signals: readonly ExplainerSignal[];
  rules: readonly ExplainerRule[];
  receiptDemo: ExplainerReceiptDemo;
}

export const EXPLAINER = {
  headline: 'How every call is made',
  lede: "Three independent signals watch each shot. When they agree you get a call. When they don't, you get UNSURE — never a guess.",
  signals: [
    {
      key: 'geo',
      title: 'Path',
      body: 'The tracked flight must cross DOWN through the hoop. This is the only signal that can establish a make.',
    },
    {
      key: 'net',
      title: 'Net',
      body: 'A net-motion burst as the ball arrives. It can confirm a make the path already showed — it can never create one.',
    },
    {
      key: 'cls',
      title: 'Seen',
      body: 'The AI literally seeing the ball inside the hoop. Confirmation only, same rule: corroborate, never invent.',
    },
  ],
  rules: [
    {
      icon: 'shield-checkmark-outline',
      title: 'Makes are never manufactured',
      body: "If the geometry didn't show it, it isn't a make. Extra signals can upgrade a blocked view to a call — they cannot outvote the path.",
    },
    {
      icon: 'help-circle-outline',
      title: 'UNSURE is an honest answer',
      body: 'Disagreeing signals stay UNSURE. Correct it yourself any time — corrections are labeled EDITED, keep the original receipt, and never re-judge other shots.',
    },
    {
      icon: 'analytics-outline',
      title: 'Estimates say so',
      body: 'Distance and 2/3 calls carry their source — Estimated, Measured, or Court-registered — plus a confidence tier. No fake precision, ever.',
    },
  ],
  receiptDemo: { signals: { geo: true, net: true, cls: null }, rimBounce: false, outcome: 'make' },
} as const satisfies DetectionExplainer;
