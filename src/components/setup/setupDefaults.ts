/**
 * Pure setup-screen vocabulary — section ids, collapsed defaults, and every
 * summary/subtitle string the redesigned /session/setup renders.
 *
 * This module is the single home for that copy so StartHero, StickyStartBar,
 * the collapsible option sections, and setup.tsx never drift from each other.
 * It is deliberately store-free and framework-free: no React, no Reanimated,
 * no zustand reads — callers pass plain values in and get strings/records out,
 * so everything here is trivially unit-testable and safe to call anywhere.
 */
import { getDrill } from '@/core/drills';
import { getModeDef } from '@/core/gameModes';
import type { KeepMode } from '@/state/settingsStore';

// ---------------------------------------------------------------------------
// Section vocabulary
// ---------------------------------------------------------------------------

/** Stable ids for the five collapsible option sections on /session/setup. */
export type SetupSectionId = 'mode' | 'camera' | 'recording' | 'courtBall' | 'calibration';

/** Render order of the option sections, top to bottom. */
export const SETUP_SECTION_ORDER: readonly SetupSectionId[] = [
  'mode',
  'camera',
  'recording',
  'courtBall',
  'calibration',
];

// ---------------------------------------------------------------------------
// Collapsed defaults
// ---------------------------------------------------------------------------

/** The two live signals that decide which sections open on mount. */
export interface SetupContext {
  /** A game mode or drill is currently armed (useMode activeMode != null). */
  modeArmed: boolean;
  /** Camera permission is already granted. */
  cameraGranted: boolean;
}

/**
 * Session-local collapsed defaults, computed once on mount.
 * mode: expanded only when a mode/drill is armed (the player just picked it
 * and may need config chips). camera: expanded only when permission still
 * needs attention. calibration: always expanded — the honesty/health surface
 * stays visible. Deliberately NOT persisted.
 */
export function defaultExpanded(ctx: SetupContext): Record<SetupSectionId, boolean> {
  return {
    mode: ctx.modeArmed,
    camera: !ctx.cameraGranted,
    recording: false,
    courtBall: false,
    calibration: true,
  };
}

// ---------------------------------------------------------------------------
// Start summary (hero sub line + sticky bar text)
// ---------------------------------------------------------------------------

/** Short clip-policy fragments for the one-line start summary. */
const KEEP_SHORT: Record<KeepMode, string> = {
  makes: 'makes only',
  decided: 'makes + misses',
  all: 'every shot',
  none: 'none',
};

/** Inputs for the one-line session summary shown next to both start CTAs. */
export interface SummaryInput {
  /** Armed mode/drill display name, or null for the free-play default. */
  modeName: string | null;
  orient: 'portrait' | 'landscape';
  recordVideo: boolean;
  keepMode: KeepMode;
}

/** "Free Play · Portrait · Clips: makes only" — the CTA-adjacent summary. */
export function startSummaryLine(s: SummaryInput): string {
  const mode = s.modeName ?? 'Free Play';
  const orient = s.orient === 'portrait' ? 'Portrait' : 'Landscape';
  const video = s.recordVideo ? `Clips: ${KEEP_SHORT[s.keepMode]}` : 'No video';
  return `${mode} · ${orient} · ${video}`;
}

// ---------------------------------------------------------------------------
// Section subtitles (current-value line on each collapsed section header)
// ---------------------------------------------------------------------------

/**
 * Subtitle for the "Game mode" section. A drill wins over the plain mode id
 * (a drill runs AS spotShooting, so drillId must be checked first). Unknown
 * ids fall back defensively — getDrill/getModeDef throw on unknown ids, so
 * lookups are wrapped rather than letting a stale persisted id crash setup.
 */
export function modeSubtitle(args: {
  modeId: string | null;
  drillId: string | null;
  durationSec: number;
  makesPerSpot: number;
}): string {
  if (args.drillId != null) {
    try {
      return getDrill(args.drillId as Parameters<typeof getDrill>[0]).title;
    } catch {
      return 'Drill';
    }
  }
  if (args.modeId == null || args.modeId === 'free') return 'Free Play';
  if (args.modeId === 'timed') return `Timed Challenge · ${args.durationSec}s`;
  if (args.modeId === 'spotShooting') return `Spot Shooting · ${args.makesPerSpot} per spot`;
  try {
    return getModeDef(args.modeId as Parameters<typeof getModeDef>[0])?.name ?? args.modeId;
  } catch {
    return args.modeId;
  }
}

/** Subtitle for the "Camera & placement" section. */
export function cameraSubtitle(args: {
  granted: boolean;
  orient: 'portrait' | 'landscape';
}): string {
  if (!args.granted) return 'Camera access needed';
  return `${args.orient === 'portrait' ? 'Portrait' : 'Landscape'} · Camera ready`;
}

/** Full clip-policy labels for the "Recording" section subtitle. */
const KEEP_LABEL: Record<KeepMode, string> = {
  makes: 'Makes only',
  decided: 'Makes + misses',
  all: 'Every shot',
  none: 'No clips',
};

/** Subtitle for the "Recording" section. */
export function recordingSubtitle(args: { recordVideo: boolean; keepMode: KeepMode }): string {
  return args.recordVideo ? `On · ${KEEP_LABEL[args.keepMode]}` : 'Off';
}

/**
 * Subtitle for the "Court & ball" section. The pinned suffix only appears
 * when the player has overridden the honest auto (estimated) court range.
 */
export function courtBallSubtitle(args: {
  rimHeightM: 3.05 | 2.6;
  ballSize: 7 | 6 | 5;
  courtRange: 'auto' | '2pt' | '3pt';
}): string {
  const rim = args.rimHeightM === 2.6 ? 'Youth rim' : 'Standard rim';
  const pinned =
    args.courtRange === '2pt' ? ' · Pinned 2s' : args.courtRange === '3pt' ? ' · Pinned 3s' : '';
  return `${rim} · Size ${args.ballSize}${pinned}`;
}

// ---------------------------------------------------------------------------
// Hero summary chips
// ---------------------------------------------------------------------------

/**
 * The three summary chips under the hero CTA — each expands + scrolls to its
 * section. Labels come from the subtitle functions at the call site.
 */
export const HERO_CHIP_DEFS: { id: SetupSectionId; icon: string }[] = [
  { id: 'mode', icon: 'game-controller-outline' },
  { id: 'camera', icon: 'phone-portrait-outline' },
  { id: 'recording', icon: 'videocam-outline' },
];
