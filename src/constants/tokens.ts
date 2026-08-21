/**
 * HoopAI design tokens — dark "broadcast" system.
 *
 * Rationale (from the UX research pass):
 * - Dark-first is FUNCTIONAL: the HUD sits over a live camera feed and must be
 *   glanceable from across the court. Big tabular numerals, one hot accent.
 * - Neutrals are warmed toward court-maple rather than pure gray, so the app
 *   feels like a gym at night, not a terminal.
 * - Make/miss is always COLOR + SHAPE (green dot / red X) for colorblind safety.
 * - Signature motif: the shot arc. Trajectory trail, summary hero arc and
 *   progress rings all reuse the same quadratic arc geometry.
 */

export const palette = {
  /** Canvas. Warm coal, not pure black — keeps OLED deep but not dead. */
  coal: '#121010',
  /** Elevated surfaces (cards, sheets). */
  court: '#1C1917',
  /** Higher elevation / pressed. */
  courtRaised: '#262220',
  /** Hairlines and strokes on dark. */
  line: '#37312E',

  /** Primary accent — basketball leather, hot but not neon. */
  leather: '#F05A24',
  /** Pressed/darker leather. */
  leatherDeep: '#C2431A',
  /** Subtle leather tint for fills (12% on coal). */
  leatherTint: 'rgba(240, 90, 36, 0.12)',
  /**
   * Accent HAIRLINE. Deliberately hotter than leatherTint: a 12% fill read as
   * a border disappears against `court`, so every emphasized edge (hero card,
   * selected week chip, WSS badge) was hand-rolling its own 0.4–0.5 alpha.
   */
  leatherEdge: 'rgba(240, 90, 36, 0.45)',
  /**
   * Leather at ZERO alpha — the transparent end of an accent-tint crossfade.
   * A fade between `transparent` and leatherTint ramps through black on some
   * interpolators; starting on the same hue keeps the ramp clean. Lives here
   * so a leather hue change carries, instead of desyncing a hardcoded rgba.
   */
  leatherClear: 'rgba(240, 90, 36, 0)',

  /** Make — cyan-leaning green (separable for deuteranopia). */
  swish: '#2FD6A3',
  swishTint: 'rgba(47, 214, 163, 0.14)',
  /** Miss — warm red, never punishing-bright. */
  brick: '#E8574F',
  brickTint: 'rgba(232, 87, 79, 0.14)',
  /** Miss hairline — the "fix first" severity edge. */
  brickEdge: 'rgba(232, 87, 79, 0.45)',
  /** Unsure / needs review. */
  chalkYellow: '#E8B84F',
  chalkYellowTint: 'rgba(232, 184, 79, 0.14)',

  /** Informational (charts secondary series, links). */
  paintBlue: '#4F8DE8',
  paintBlueTint: 'rgba(79, 141, 232, 0.14)',

  /** 3-point accent — downtown gold, distinct from make-green & leather. */
  downtown: '#F2C14E',
  downtownTint: 'rgba(242, 193, 78, 0.16)',
  /**
   * Dimmed downtown gold as a SOLID, pre-blended on `court` (downtown at
   * ~66%). Replaces the 0.6-alpha gold that secondary 3PT numerals wore,
   * which measured under AA: this hue holds 5.2:1 on surface and 4.7:1 on
   * surfaceRaised, so the "/attempts" half of a gold split stays legible.
   */
  downtownDim: '#A9883B',

  /** Ghost Challenge — spectral violet, distinct from paint blue & leather. */
  spectral: '#9C7BF0',
  spectralTint: 'rgba(156, 123, 240, 0.14)',

  /** Text. Chalk white, then dimmed steps. */
  chalk: '#F5F1EC',
  chalkDim: '#B3ACA5',
  /**
   * Lifted from #7A736D: the old value measured under 4.5:1 on every surface,
   * so ~200 sites of genuinely useful fine print (units, timestamps, axis
   * labels, hints) were sub-AA — the first thing to disappear on an outdoor
   * court in daylight, which is the actual use case. Same warm-neutral hue,
   * lightness only: 5.14:1 on surface, 4.63:1 on surfaceRaised, 5.57:1 on bg.
   */
  chalkFaint: '#918A83',
  /** Neutral "no signal" tint — the dim third of the confidence ladder. */
  chalkFaintTint: 'rgba(145, 138, 131, 0.14)',

  /**
   * Tier metals — the medal ladder (streak tiers, achievement crests).
   * ONE bronze: StreakTierCard ('#C8823C') and AchievementRow ('#C08552') had
   * each picked their own; the more metallic '#C8823C' wins because bronze
   * must read as a MEDAL between silver and gold, and '#C08552' drifts tan
   * enough to muddle with the leather accent family.
   */
  tierBronze: '#C8823C',
  tierBronzeTint: 'rgba(200, 130, 60, 0.14)',
  /** Cool metallic silver (StreakTierCard's), not the warm textDim gray. */
  tierSilver: '#C2CAD2',
  tierSilverTint: 'rgba(194, 202, 210, 0.14)',
  /** Same hue as downtown gold — a medal and a 3-pointer share the metal. */
  tierGold: '#F2C14E',
  tierGoldTint: 'rgba(242, 193, 78, 0.14)',

  /** On-accent text. */
  onLeather: '#140A05',
} as const;

export const color = {
  bg: palette.coal,
  surface: palette.court,
  surfaceRaised: palette.courtRaised,
  border: palette.line,
  text: palette.chalk,
  textDim: palette.chalkDim,
  textFaint: palette.chalkFaint,
  accent: palette.leather,
  accentPressed: palette.leatherDeep,
  accentTint: palette.leatherTint,
  /** Border for accent-emphasized surfaces — see palette.leatherEdge. */
  accentEdge: palette.leatherEdge,
  /** Accent at zero alpha — the rest end of a tint fade. See leatherClear. */
  accentClear: palette.leatherClear,
  onAccent: palette.onLeather,
  make: palette.swish,
  makeTint: palette.swishTint,
  miss: palette.brick,
  missTint: palette.brickTint,
  missEdge: palette.brickEdge,
  /**
   * Status tints — the fill that goes UNDER a status glyph/label. One value
   * per status so a caution chip reads identically wherever it lands; screens
   * were previously inlining their own alphas (0.10 here, 0.14 there), which
   * made the same warning look like two different severities.
   */
  unsure: palette.chalkYellow,
  unsureTint: palette.chalkYellowTint,
  info: palette.paintBlue,
  infoTint: palette.paintBlueTint,
  /** Dim/neutral status — "not enough signal", pairs with confidenceColor.low. */
  dim: palette.chalkFaint,
  dimTint: palette.chalkFaintTint,
  /** 2-point shots / stat pill. */
  twoPt: palette.chalkDim,
  /** 3-point shots / stat pill accent. */
  threePt: palette.downtown,
  threePtTint: palette.downtownTint,
  /** Dimmed 3-point gold for secondary numerals — see palette.downtownDim. */
  threePtDim: palette.downtownDim,
  /** Ghost Challenge accent (mode identity, race HUD). */
  ghost: palette.spectral,
  ghostTint: palette.spectralTint,
  /** Live HUD chip background over camera (glass). */
  hudGlass: 'rgba(18, 16, 16, 0.62)',
  hudGlassBorder: 'rgba(245, 241, 236, 0.14)',
  /** Deeper glass for stacked HUD panels. */
  hudGlassDeep: 'rgba(14, 12, 12, 0.74)',
  /**
   * Full-screen dimming layer under overlays (coach marks, debug panel,
   * modal scrims). The warm near-coal value those surfaces already wore —
   * one scrim app-wide instead of per-overlay alphas.
   */
  scrim: 'rgba(10, 9, 9, 0.82)',
  /**
   * TRUE black, only for letterboxing behind video/camera frames — the one
   * place the warm coal would visibly tint footage. Never a UI surface.
   */
  cameraBed: '#000',
} as const;

/**
 * ONE confidence palette — high = trust green, medium = caution gold, low =
 * dim. Every detection surface (receipt, quality badge, court-zone tint) reads
 * confidence through THIS map, so it registers as a single signal app-wide
 * rather than three unrelated meters. Keyed by ConfidenceLevel (evidence.ts).
 */
export const confidenceColor = {
  high: palette.swish,
  medium: palette.chalkYellow,
  low: palette.chalkFaint,
} as const;

/**
 * Skia overlay glow palette — raw rgba strings consumed directly by the live
 * tracking canvas (Skia color props, not RN styles). Kept here so the HUD's
 * bloom, comet trail and rim reticle all pull from one source of truth.
 */
export const glow = {
  /** Comet trail body — leather orange at full heat. */
  trail: 'rgba(240, 90, 36, 1)',
  /** Trail outer bloom. */
  trailBloom: 'rgba(240, 90, 36, 0.55)',
  /** Chalk-white comet core. */
  cometCore: '#FFFFFF',
  /** Warm halo just outside the core. */
  cometHalo: 'rgba(255, 214, 170, 0.9)',
  /** Ball detection reticle (idle tracking). */
  reticle: 'rgba(245, 241, 236, 0.92)',
  /** Rim lock brackets, resting. */
  rimIdle: 'rgba(245, 241, 236, 0.85)',
  /** Rim lock brackets + fill, live shot (swish green). */
  rimLive: '#2FD6A3',
  rimLiveGlow: 'rgba(47, 214, 163, 0.6)',
  /** Downtown gold for the 3-point range ring. */
  downtown: '#F2C14E',
  downtownGlow: 'rgba(242, 193, 78, 0.5)',
} as const;

/**
 * Typography. Display = Barlow Condensed (broadcast scoreboard voice,
 * tabular lining figures at hero sizes). Body/UI = Inter.
 * Font loading lives in app/_layout.tsx via @expo-google-fonts packages.
 */
export const font = {
  display: 'BarlowCondensed_700Bold',
  displayMedium: 'BarlowCondensed_500Medium',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
} as const;

export const type = {
  /** Hero stat on Live HUD / session summary. Glanceable from ~6 m. */
  scoreboard: { fontFamily: font.display, fontSize: 96, lineHeight: 96, letterSpacing: -1 },
  /** Secondary big stat (FG%, streak). */
  statLarge: { fontFamily: font.display, fontSize: 56, lineHeight: 58 },
  statMedium: { fontFamily: font.display, fontSize: 32, lineHeight: 34 },
  /**
   * Smallest broadcast numeral — dense stat GRIDS (method columns, 2pt/3pt
   * splits) where statMedium would collide at three-across. Missing step:
   * Jump Lab and the HUD split strip had each hand-rolled `statMedium` +
   * fontSize 22 with different line heights.
   */
  statSmall: { fontFamily: font.display, fontSize: 22, lineHeight: 24 },
  /** Screen titles. */
  title: { fontFamily: font.display, fontSize: 28, lineHeight: 32, letterSpacing: 0.2 },
  /**
   * The heading that LEADS a card (finding title, program name, hero lede) —
   * one step above the heading that labels a sub-block. Missing step: Coach,
   * Jump Lab and Shot Lab each re-declared `heading` + fontSize 18 with line
   * heights of 24/25/22, so the same rank of text sat differently per screen.
   */
  headingLarge: { fontFamily: font.bodySemiBold, fontSize: 18, lineHeight: 24 },
  /** Card headings. */
  heading: { fontFamily: font.bodySemiBold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 21 },
  bodyMedium: { fontFamily: font.bodyMedium, fontSize: 15, lineHeight: 21 },
  /** Chips and axis labels — data-adjacent fine print, tight tracking. */
  caption: { fontFamily: font.bodyMedium, fontSize: 12, lineHeight: 16, letterSpacing: 0.4 },
  /**
   * Section eyebrows — the UPPERCASE kicker above a block. Wider tracking
   * than caption (1.2, the value Home/Profile/Coach findings had each
   * hand-rolled) because an all-caps line needs air that axis labels do not.
   */
  eyebrow: { fontFamily: font.bodyMedium, fontSize: 12, lineHeight: 16, letterSpacing: 1.2 },
  micro: { fontFamily: font.bodyMedium, fontSize: 10, lineHeight: 13, letterSpacing: 0.6 },
} as const;

/**
 * Icon sizes — the ladder inline Ionicons pull from instead of inventing
 * one-off numbers (12/14/15/16/18/20 were all in circulation). xs pairs with
 * eyebrows/captions, xl with the tab bar and headline rows.
 */
export const iconSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
} as const;

/** 4pt base spacing scale. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  hero: 48,
} as const;

/**
 * Layout rhythm — the ONE vertical grid every screen breathes on.
 *
 * WHY this exists as tokens rather than per-screen literals: the tabs are
 * SIBLINGS the user swipes between, and the cross-fade shows both layouts in
 * the same 140 ms. Coach and Profile were stacking on space.lg while Home and
 * Records used space.xl, so a lateral swipe visibly tightened the page —
 * exactly the kind of seam that reads as "unfinished" without being nameable.
 * Screens pull `sectionGap` for their top-level stack; nothing hand-picks it.
 */
export const layout = {
  /** Between top-level sections/cards in a screen's scroll stack. */
  sectionGap: space.xl,
  /** Between sibling items INSIDE one section — a tighter, related group. */
  cardGap: space.lg,
  /** A card's inner padding. Mirrors `card` in components/ui.tsx. */
  cardPadding: space.lg,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  /** HUD chips: full pill. */
  pill: 999,
} as const;

/** Motion durations (ms) + easing hints for Reanimated. */
export const motion = {
  /** Feedback must land inside the Doherty window. */
  instant: 90,
  /**
   * Lateral tab switch. Deliberately the shortest non-instant step: a tab is a
   * SIBLING, so the cross-fade only needs to stop the hard cut — anything
   * longer starts to feel like the app is thinking before it obeys.
   */
  tab: 140,
  quick: 180,
  standard: 260,
  celebrate: 600,
} as const;

/** Hit targets: 48dp Android / 44pt iOS floor. */
export const touch = {
  minTarget: 48,
} as const;

/**
 * Elevation. depth = borders and surface steps; shadow.pop is the ONLY drop
 * shadow, reserved for transient overlays. Everything that sits IN the page
 * separates with hairlines and surface/surfaceRaised steps (borderWidth
 * 1/1.5 marks hierarchy and identity rings); only a surface floating OVER
 * the darkened app (coach-mark popover, and overlays like it) earns the
 * drop. The recipe is the CoachMarks popover's — soft and wide, no harsh
 * edge — on the warm coal instead of pure black.
 */
export const shadow = {
  pop: {
    shadowColor: palette.coal,
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
} as const;
