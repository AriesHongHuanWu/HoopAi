/**
 * Firebase config — read from the environment, NEVER from a tracked file.
 *
 * WHY THIS FILE EXISTS AT ALL: the cloud half of Hoopilot is optional. The app
 * has always worked with no account and no network, and it still must. So the
 * whole cloud layer hangs off ONE question — "did this build ship a Firebase
 * project?" — answered here, synchronously, with no imports from the firebase
 * SDK and no IO. Everything downstream (firebaseApp, firebaseSync, authStore,
 * the Account screen) treats `null` as a normal, silent, first-class state:
 * local-only. Not an error, not a modal, not a retry loop.
 *
 * WHERE THE VALUES COME FROM, in order:
 *   1. `process.env.EXPO_PUBLIC_FIREBASE_*` — Metro inlines these at bundle
 *      time from `.env` (see .env.example + docs/FIREBASE-SETUP.md). The reads
 *      below are written as LITERAL `process.env.X` member expressions on
 *      purpose: Expo's transform is a static find-and-replace, so a computed
 *      lookup like `process.env[name]` would silently be undefined on device.
 *   2. `Constants.expoConfig.extra.firebase` — for an owner who would rather
 *      inject the values from CI via app.config.js.
 *
 * A Firebase WEB config is not a credential (it identifies the project; the
 * Firestore security rules are what protect the data — see
 * docs/FIREBASE-SETUP.md). It still does not belong hardcoded in a public
 * repo, so there is no default, no fallback and no example value anywhere in
 * this file: an unconfigured checkout reads `null` and stays local-only.
 *
 * NO STORAGE BUCKET IS READ, deliberately. Hoopilot uploads numbers and
 * metadata only — never a frame, a clip or a thumbnail — so the client is
 * never handed the name of a bucket it has no business writing to.
 */
import Constants from 'expo-constants';

/** The minimum viable Firebase web config for Auth + Firestore. */
export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** Keys that MUST all be present for the cloud layer to come up. */
export const REQUIRED_CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'] as const;

/**
 * Placeholder-ish values, as found in `.env.example` or a half-filled `.env`.
 * Treated as ABSENT rather than passed to initializeApp — a build that carries
 * `apiKey=your-api-key-here` must degrade to local-only, not spend the demo
 * throwing `auth/invalid-api-key` at the user.
 */
const PLACEHOLDER = /^(x{3,}|\.{3}|-+)$|your|example|changeme|change-me|replace|todo|placeholder/i;

/** A present, non-placeholder string, or null. */
function clean(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (PLACEHOLDER.test(value)) return null;
  return value;
}

/** Shape of the optional `extra.firebase` block in app config. */
type ExtraConfig = Partial<Record<keyof FirebaseConfig, unknown>>;

function fromAppConfig(): ExtraConfig {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const firebase = extra?.firebase;
  if (firebase == null || typeof firebase !== 'object') return {};
  return firebase as ExtraConfig;
}

/**
 * The build's Firebase config, or null when this build has none.
 *
 * Read at CALL time (not module load) so a test — and an owner flipping an
 * env var between reloads — sees the current environment.
 */
export function readFirebaseConfig(): FirebaseConfig | null {
  const extra = fromAppConfig();
  const pick = (envValue: string | undefined, key: keyof FirebaseConfig): string | null =>
    clean(envValue) ?? clean(extra[key] as string | undefined);

  const apiKey = pick(process.env.EXPO_PUBLIC_FIREBASE_API_KEY, 'apiKey');
  const authDomain = pick(process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN, 'authDomain');
  const projectId = pick(process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID, 'projectId');
  const appId = pick(process.env.EXPO_PUBLIC_FIREBASE_APP_ID, 'appId');

  // All four or nothing: a partial config produces an app object that fails on
  // first use, which is strictly worse than staying local-only.
  if (apiKey == null || authDomain == null || projectId == null || appId == null) return null;
  return { apiKey, authDomain, projectId, appId };
}

/**
 * Cheap boolean for UI copy ("Cloud backup is off in this build"). Never
 * touches the network and never loads the firebase SDK.
 */
export function isFirebaseConfigured(): boolean {
  return readFirebaseConfig() !== null;
}
