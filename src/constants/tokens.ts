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

  /** Make — cyan-leaning green (separable for deuteranopia). */
  swish: '#2FD6A3',
  swishTint: 'rgba(47, 214, 163, 0.14)',
  /** Miss — warm red, never punishing-bright. */
  brick: '#E8574F',
  brickTint: 'rgba(232, 87, 79, 0.14)',
  /** Unsure / needs review. */
  chalkYellow: '#E8B84F',

  /** Informational (charts secondary series, links). */
  paintBlue: '#4F8DE8',

  /** Text. Chalk white, then dimmed steps. */
  chalk: '#F5F1EC',
  chalkDim: '#B3ACA5',
  chalkFaint: '#7A736D',

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
  onAccent: palette.onLeather,
  make: palette.swish,
  makeTint: palette.swishTint,
  miss: palette.brick,
  missTint: palette.brickTint,
  unsure: palette.chalkYellow,
  info: palette.paintBlue,
  /** Live HUD chip background over camera (glass). */
  hudGlass: 'rgba(18, 16, 16, 0.62)',
  hudGlassBorder: 'rgba(245, 241, 236, 0.14)',
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
  /** Screen titles. */
  title: { fontFamily: font.display, fontSize: 28, lineHeight: 32, letterSpacing: 0.2 },
  /** Card headings. */
  heading: { fontFamily: font.bodySemiBold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 21 },
  bodyMedium: { fontFamily: font.bodyMedium, fontSize: 15, lineHeight: 21 },
  /** Chips, axis labels, eyebrows. Uppercase + tracked when used as eyebrow. */
  caption: { fontFamily: font.bodyMedium, fontSize: 12, lineHeight: 16, letterSpacing: 0.4 },
  micro: { fontFamily: font.bodyMedium, fontSize: 10, lineHeight: 13, letterSpacing: 0.6 },
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
  quick: 180,
  standard: 260,
  celebrate: 600,
} as const;

/** Hit targets: 48dp Android / 44pt iOS floor. */
export const touch = {
  minTarget: 48,
} as const;
