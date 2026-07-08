/**
 * Career milestones — the "you just hit your 500th make" moment at session end.
 *
 * A milestone fires exactly once, on the session that CROSSES a threshold
 * (career total went from below it to at-or-above it). Pure + deterministic:
 * given the totals it returns which milestones were crossed, so it is trivially
 * testable and never double-fires. Formatting/celebration lives in the UI.
 */

export type MilestoneKind = 'makes' | 'sessions';

export interface Milestone {
  kind: MilestoneKind;
  /** The threshold crossed (e.g. 500 makes, 25 sessions). */
  value: number;
  /** Ionicons name for the celebration. */
  icon: string;
  /** One-line congratulation. */
  blurb: string;
}

/** Career-make thresholds worth a celebration. */
const MAKE_TIERS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const;
/** Sessions-logged thresholds. */
const SESSION_TIERS = [5, 10, 25, 50, 100, 250, 500] as const;

function makesBlurb(v: number): string {
  if (v >= 1000) return `${v.toLocaleString()} career makes. That's a serious body of work.`;
  if (v >= 250) return `${v} career makes — the reps are stacking up.`;
  return `${v} career makes and counting. Keep filling it up.`;
}

function sessionsBlurb(v: number): string {
  if (v >= 100) return `${v} sessions in the gym. Showing up is the whole game.`;
  if (v >= 25) return `${v} sessions logged — this is a real habit now.`;
  return `${v} sessions down. The work is becoming routine.`;
}

/**
 * Milestones crossed by THIS session. Inputs are lifetime totals AFTER the
 * session has been saved, plus what this session contributed, so the "before"
 * totals are derived and only a genuine crossing fires. Most significant first
 * (biggest makes milestone leads).
 */
export function detectMilestones(input: {
  /** Career makes after this session. */
  makesAfter: number;
  /** Makes this session contributed. */
  makesGained: number;
  /** Career session count after this session (includes this one). */
  sessionsAfter: number;
}): Milestone[] {
  const { makesAfter, makesGained, sessionsAfter } = input;
  const makesBefore = Math.max(0, makesAfter - Math.max(0, makesGained));
  const sessionsBefore = Math.max(0, sessionsAfter - 1);

  const out: Milestone[] = [];
  for (const t of MAKE_TIERS) {
    if (makesBefore < t && makesAfter >= t) {
      out.push({ kind: 'makes', value: t, icon: 'basketball', blurb: makesBlurb(t) });
    }
  }
  for (const t of SESSION_TIERS) {
    if (sessionsBefore < t && sessionsAfter >= t) {
      out.push({ kind: 'sessions', value: t, icon: 'calendar', blurb: sessionsBlurb(t) });
    }
  }
  // Biggest makes milestone first; sessions after. Within a kind, larger first.
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'makes' ? -1 : 1;
    return b.value - a.value;
  });
}
