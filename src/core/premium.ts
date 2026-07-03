/**
 * HoopAI Pro — single source of truth for the future paywall.
 *
 * BETA POLICY (CRITICAL): while {@link IS_BETA} is true NOTHING in the app is
 * gated or locked. {@link isUnlocked} returns true for every feature, so every
 * screen stays fully usable. The PRO badge (src/components/ProBadge.tsx) is
 * purely informational — it seeds the expectation of what joins the paid plan
 * at launch, and its copy always says the feature is free during beta.
 *
 * WHERE THE PAYWALL LANDS LATER: this module is the one choke point. At
 * launch, flip IS_BETA to false and route isUnlocked() through the
 * entitlement source (StoreKit 2 / react-native-iap / RevenueCat — decided in
 * docs/MONETIZATION.md; no purchase packages are added during beta). Screens
 * only ever call isUnlocked(), so turning on the paywall requires zero UI
 * rewiring.
 *
 * The feature registry below mirrors docs/MONETIZATION.md §4 — keep the two
 * in sync when the plan changes.
 */

/** Beta flag — everything is free while true. Flipped once, at launch. */
export const IS_BETA = true;

/** Every feature that becomes part of the HoopAI Pro plan at launch. */
export type ProFeatureId =
  | 'gameModes'
  | 'unlimitedHistory'
  | 'replayHighlights'
  | 'clipWindow'
  | 'soundPacks'
  | 'voiceAnnouncements'
  | 'deepRecords'
  | 'cleanShareCards'
  | 'preciseModels'
  | 'formAnalysis'
  | 'customModes'
  | 'cloudSync';

export interface ProFeature {
  id: ProFeatureId;
  /** Short display name, sentence case. */
  name: string;
  /** One-line pitch, ready for the future paywall screen. */
  blurb: string;
}

/**
 * The Pro plan, feature by feature. Order = how the paywall will list them
 * (strongest daily-use hooks first, future promises last).
 */
export const PRO_FEATURES: readonly ProFeature[] = [
  {
    id: 'gameModes',
    name: 'All game modes',
    blurb:
      'Around the World, Spot Shooting, Timed Challenge, 3-Point Contest, Free Throw Streak and H-O-R-S-E.',
  },
  {
    id: 'unlimitedHistory',
    name: 'Unlimited history',
    blurb: 'Every session you ever shoot, kept forever — free keeps the last 10.',
  },
  {
    id: 'replayHighlights',
    name: 'Replay and highlights',
    blurb: 'Instant replay player plus auto-cut highlight reels of your best makes.',
  },
  {
    id: 'clipWindow',
    name: 'Clip window control',
    blurb: 'Tune how many seconds before and after each shot end up in a clip.',
  },
  {
    id: 'soundPacks',
    name: 'All sound packs',
    blurb: 'Classic, Arcade and Stadium feedback voices — custom sound import later.',
  },
  {
    id: 'voiceAnnouncements',
    name: 'Voice announcements',
    blurb: 'Hear your result, entry angle or FG% called out after every shot.',
  },
  {
    id: 'deepRecords',
    name: 'Deep records',
    blurb: 'Lifetime records plus the full badge board with progress tracking.',
  },
  {
    id: 'cleanShareCards',
    name: 'Share cards without watermark',
    blurb: 'Post your session cards clean — no watermark.',
  },
  {
    id: 'preciseModels',
    name: 'Precise detection models',
    blurb: 'Higher-accuracy detector models for tough courts, distance and lighting.',
  },
  {
    id: 'formAnalysis',
    name: 'Form analysis',
    blurb: 'Release angle and jump metrics from pose tracking. Planned after launch.',
  },
  {
    id: 'customModes',
    name: 'Custom mode builder',
    blurb: 'Build your own drills, spots and scoring rules. Planned after launch.',
  },
  {
    id: 'cloudSync',
    name: 'Cloud sync',
    blurb: 'Back up sessions and stats across devices. Planned after launch.',
  },
];

/** Lookup a Pro feature definition by id. */
export function getProFeature(id: ProFeatureId): ProFeature {
  const def = PRO_FEATURES.find((f) => f.id === id);
  if (def === undefined) throw new Error(`Unknown pro feature: ${id}`);
  return def;
}

/**
 * Is a Pro feature usable right now?
 *
 * Beta: ALWAYS true — nothing is gated. This is the one function the launch
 * paywall reroutes through real entitlements (`IS_BETA || owns(id)`); callers
 * must never check IS_BETA or entitlements themselves.
 */
export function isUnlocked(_id: ProFeatureId): boolean {
  return true;
}

/**
 * Number of sessions a free (non-Pro) user keeps in History — the
 * 'unlimitedHistory' Pro feature's free-tier floor (see PRO_FEATURES above).
 *
 * PRE-LAUNCH CHECKLIST ITEM (not enforced during beta): once IS_BETA flips to
 * false, callers that list/prune History (e.g. src/data/db.ts listSessions,
 * or the History screen itself) should check `isUnlocked('unlimitedHistory')`
 * and, if false, cap the visible/retained list to this many most-recent
 * sessions — warning the user before deleting older local video files. This
 * constant exists now so that enforcement point has a single source of truth
 * to reference; it intentionally does nothing on its own.
 */
export const FREE_HISTORY_LIMIT = 10;

/**
 * How many of `totalSessions` should be visible/retained right now, given
 * Pro status. Beta (isUnlocked always true) ⇒ unlimited. Pure helper, no I/O —
 * callers decide what to do with sessions beyond the returned count (e.g.
 * hide them from History, or delete their videos before dropping the rows).
 */
export function historyRetentionLimit(): number | null {
  return isUnlocked('unlimitedHistory') ? null : FREE_HISTORY_LIMIT;
}
