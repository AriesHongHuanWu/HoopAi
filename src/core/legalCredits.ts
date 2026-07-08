/**
 * Open-source & data attribution registry — the single source of truth the
 * in-app Licenses screen (src/app/legal/licenses.tsx) and the store checklist
 * (docs/APPSTORE-CHECKLIST.md) both read from.
 *
 * WHY A HAND-CURATED LIST (not a build-time scan): the sensitive licenses here
 * are the ML MODELS and DATASETS, which never appear in package.json — they
 * live in assets/models and were trained on Roboflow data. A node_modules
 * scanner would miss exactly the credits that matter for store review and the
 * AGPL red line. So we curate all three tiers (runtime deps, models, data) in
 * one place, keyed to the licenses actually in the shipped bundle.
 *
 * KEEP IN SYNC: docs/MODELS.md §6 (attribution) and app package.json deps.
 */

export type LicenseId =
  | 'MIT'
  | 'Apache-2.0'
  | 'CC-BY-4.0'
  | 'OFL-1.1'
  | 'AGPL-3.0';

export interface CreditRow {
  /** Display name. */
  name: string;
  /** SPDX-ish license id (what shows in the license chip). */
  license: LicenseId;
  /** Optional one-line note (what it powers / caveat). */
  note?: string;
  /** Canonical link (repo, dataset page, or license text). */
  link: string;
  /**
   * True for the AGPL YOLO11 fallback ONLY. Flagged so the screen can visually
   * mark it and the checklist can reference the launch removal plan. It is not
   * the default engine (Settings > Detector engine defaults to Apache YOLOX);
   * the AGPL weights are a user-selectable fallback that the paid build drops.
   */
  flagged?: boolean;
}

export interface CreditSection {
  title: string;
  /** Short lead line under the section title. */
  blurb: string;
  rows: readonly CreditRow[];
}

/**
 * Runtime libraries. Sourced from package.json — every direct dependency here
 * resolves to MIT (verified against the installed package.json `license`
 * fields). The font PACKAGES are MIT but the font FILES they bundle are OFL-1.1
 * (Barlow Condensed, Inter) — credited under Fonts below, where the OFL that
 * actually governs redistribution belongs.
 */
export const RUNTIME_CREDITS: readonly CreditRow[] = [
  { name: 'React & React Native', license: 'MIT', link: 'https://github.com/facebook/react-native', note: 'App framework.' },
  { name: 'Expo & Expo Router', license: 'MIT', link: 'https://github.com/expo/expo', note: 'Runtime, navigation and native modules.' },
  { name: 'react-native-vision-camera', license: 'MIT', link: 'https://github.com/mrousavy/react-native-vision-camera', note: 'Live camera + frame processing.' },
  { name: 'react-native-fast-tflite', license: 'MIT', link: 'https://github.com/mrousavy/react-native-fast-tflite', note: 'On-device TensorFlow Lite inference.' },
  { name: 'react-native-reanimated & worklets', license: 'MIT', link: 'https://github.com/software-mansion/react-native-reanimated', note: 'Animations and worklet threading.' },
  { name: 'react-native-gesture-handler', license: 'MIT', link: 'https://github.com/software-mansion/react-native-gesture-handler', note: 'Touch gestures.' },
  { name: '@shopify/react-native-skia', license: 'MIT', link: 'https://github.com/Shopify/react-native-skia', note: 'HUD overlay and chart rendering.' },
  { name: 'zustand', license: 'MIT', link: 'https://github.com/pmndrs/zustand', note: 'State stores (settings, profile, sessions).' },
] as const;

/**
 * ML models bundled in assets/models. This is where the license story matters
 * most for store review and the AGPL red line.
 */
export const MODEL_CREDITS: readonly CreditRow[] = [
  {
    name: 'YOLOX-Nano — ball & rim detector (default)',
    license: 'Apache-2.0',
    link: 'https://github.com/Megvii-BaseDetection/YOLOX',
    note: 'The default on-device detector. Clean commercial license.',
  },
  {
    name: 'MoveNet SinglePose Lightning — pose',
    license: 'Apache-2.0',
    link: 'https://www.kaggle.com/models/google/movenet',
    note: 'Optional 2D form analysis (17 keypoints). Runs only when you turn form analysis on.',
  },
  {
    name: 'YOLO11 — detector (non-default fallback)',
    license: 'AGPL-3.0',
    link: 'https://github.com/ultralytics/ultralytics',
    flagged: true,
    note: 'A user-selectable fallback only — not the default. Its AGPL weights are removed from the paid build (see docs/MASTER-PLAN.md B08).',
  },
] as const;

/**
 * Training datasets. All CC BY 4.0 (commercial use OK with attribution) — the
 * attribution obligation is discharged by listing them here and in MODELS.md.
 */
export const DATA_CREDITS: readonly CreditRow[] = [
  { name: 'Roboflow Universe — "Basketball and rim"', license: 'CC-BY-4.0', link: 'https://universe.roboflow.com/', note: 'Ball + rim training images.' },
  { name: 'Roboflow Universe — "Basketball Detection"', license: 'CC-BY-4.0', link: 'https://universe.roboflow.com/', note: 'Ball + hoop training images.' },
  { name: 'Roboflow Universe — "basketball-player-detection-3"', license: 'CC-BY-4.0', link: 'https://universe.roboflow.com/', note: 'Ball-in-basket + player training images.' },
] as const;

/** Fonts — bundled font FILES are OFL-1.1 even though the npm packages are MIT. */
export const FONT_CREDITS: readonly CreditRow[] = [
  { name: 'Barlow Condensed', license: 'OFL-1.1', link: 'https://fonts.google.com/specimen/Barlow+Condensed', note: 'Display / scoreboard type.' },
  { name: 'Inter', license: 'OFL-1.1', link: 'https://fonts.google.com/specimen/Inter', note: 'Body / UI type.' },
] as const;

/**
 * Algorithm references — MIT-licensed projects consulted for make/miss logic.
 * No code was copied; credited for good faith per docs/MODELS.md §6.
 */
export const REFERENCE_CREDITS: readonly CreditRow[] = [
  { name: 'josephattalla/Basketball-Shot-Detection', license: 'MIT', link: 'https://github.com/josephattalla/Basketball-Shot-Detection', note: 'Shot-detection algorithm reference.' },
  { name: 'Ed-Zh/Basketball-Analytics', license: 'MIT', link: 'https://github.com/Ed-Zh/Basketball-Analytics', note: 'Analytics algorithm reference.' },
] as const;

/** Ordered sections for the Licenses screen. */
export const CREDIT_SECTIONS: readonly CreditSection[] = [
  { title: 'On-device models', blurb: 'The neural networks that run entirely on your phone.', rows: MODEL_CREDITS },
  { title: 'Training data', blurb: 'Open datasets the detector learned from (CC BY 4.0).', rows: DATA_CREDITS },
  { title: 'Open-source libraries', blurb: 'The software Hoopilot is built on.', rows: RUNTIME_CREDITS },
  { title: 'Fonts', blurb: 'Typefaces used throughout the app (SIL Open Font License).', rows: FONT_CREDITS },
  { title: 'Algorithm references', blurb: 'Projects consulted for shot logic. No code copied.', rows: REFERENCE_CREDITS },
] as const;

/** Human-readable full name for a license id (used in the license chip / a11y). */
export const LICENSE_LABEL: Record<LicenseId, string> = {
  MIT: 'MIT License',
  'Apache-2.0': 'Apache License 2.0',
  'CC-BY-4.0': 'Creative Commons BY 4.0',
  'OFL-1.1': 'SIL Open Font License 1.1',
  'AGPL-3.0': 'GNU AGPL v3.0',
};

/** The NBA player names referenced as factual benchmarks in Shot Lab / Form
 *  Studio. Surfaced here so the store checklist and an in-app note can state
 *  plainly that these are textual references only — no logos, photos, team
 *  marks or likeness. Kept in sync with src/core/nbaBenchmarks.ts. */
export const NBA_REFERENCE_NAMES: readonly string[] = [
  'Stephen Curry',
  'Klay Thompson',
  'Ray Allen',
  'Reggie Miller',
  'Kevin Durant',
  'Kawhi Leonard',
  'Damian Lillard',
  'Kyrie Irving',
  'Devin Booker',
  'Luka Doncic',
  'Steve Nash',
  'Dirk Nowitzki',
] as const;
