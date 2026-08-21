/**
 * firebaseApp — the ONE place the Firebase JS SDK is loaded, and the only
 * module in the app that may import from `firebase/*`.
 *
 * WHY THE JS SDK (`firebase`, v12 modular) AND NOT @react-native-firebase:
 * iron rule 1 of this repo is no new native dependencies — nothing that needs
 * a config plugin, a prebuild or a pod install. The JS SDK is pure JavaScript,
 * so it drops into this Expo project with no native surface at all. The native
 * SDK would have cost a prebuild and taken Expo Go off the table.
 *
 * WHY EVERY IMPORT IS DYNAMIC: an unconfigured build (the hackathon demo, and
 * every fresh checkout) must never even pay to parse the SDK. `load()` is only
 * reached after {@link readFirebaseConfig} has returned a real config, so on a
 * local-only build the firebase modules are never required at all — no
 * initialization, no listeners, no sockets, nothing to hang on.
 *
 * WHY PERSISTENCE COMES FROM expo-sqlite: auth sessions must survive a
 * restart, which the SDK does through an AsyncStorage-shaped object handed to
 * `getReactNativePersistence`. `@react-native-async-storage/async-storage` is
 * a NATIVE module (pod install), so it is out — but `expo-sqlite/kv-store` is
 * already a dependency of this app and already exposes exactly the
 * getItem/setItem/removeItem async contract the SDK wants. Same behaviour,
 * zero new native code. Every persisted store in this repo (settings, profile,
 * challenges) already sits on that same kv-store.
 *
 * NOTHING HERE THROWS. Any failure — bad config, no network, an SDK that will
 * not initialize — resolves to `null`, which every caller reads as
 * "local-only". Unconfigured and offline are normal states, not errors.
 */
import Storage from 'expo-sqlite/kv-store';

import { readFirebaseConfig, type FirebaseConfig } from './firebaseConfig';

/**
 * The loaded `firebase/auth` module. Handing the whole module out (rather than
 * re-exporting a dozen functions) is what keeps every `firebase/*` import in
 * this one file: authStore and firebaseSync call `services.authApi.signOut(…)`
 * and never import the SDK themselves. It also makes them trivially testable —
 * a suite fakes `getFirebase()` and never loads the real SDK at all.
 */
export type AuthApi = typeof import('firebase/auth');
/** The loaded `firebase/firestore` module. Same rationale as {@link AuthApi}. */
export type StoreApi = typeof import('firebase/firestore');

export interface FirebaseServices {
  auth: import('firebase/auth').Auth;
  db: import('firebase/firestore').Firestore;
  authApi: AuthApi;
  storeApi: StoreApi;
  projectId: string;
}

/** Default ceiling on any single network round trip. */
export const NETWORK_TIMEOUT_MS = 10_000;

/**
 * Resolve `promise`, or reject with a timeout after `ms`.
 *
 * Every cloud call in this package goes through here. Firebase's own retry
 * behaviour can leave a promise pending for a very long time on a flaky gym
 * wifi, and a pending promise is how a UI ends up spinning forever. A hard
 * ceiling turns "no network" into a fast, ordinary answer.
 */
export function withTimeout<T>(promise: Promise<T>, ms = NETWORK_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The AsyncStorage-shaped adapter the auth SDK persists its session through.
 * `expo-sqlite/kv-store` already returns promises from these three names; the
 * wrapper exists to pin the exact contract (and to keep removeItem returning
 * void rather than kv-store's boolean).
 */
export const authPersistenceStore = {
  getItem: (key: string): Promise<string | null> => Storage.getItem(key),
  setItem: (key: string, value: string): Promise<void> => Storage.setItem(key, value),
  removeItem: async (key: string): Promise<void> => {
    await Storage.removeItem(key);
  },
};

let cached: Promise<FirebaseServices | null> | null = null;

/**
 * The SDK's React-Native persistence factory.
 *
 * `getReactNativePersistence` ships in the react-native build of
 * @firebase/auth but is absent from the package's default .d.ts surface (a
 * known gap in the published types), so it is read off the module object
 * through one narrow cast, in one place, with this comment attached.
 */
function reactNativePersistence(
  authModule: AuthApi,
): import('firebase/auth').Persistence | null {
  const factory = (authModule as unknown as Record<string, unknown>).getReactNativePersistence;
  if (typeof factory !== 'function') return null;
  return (
    factory as (store: typeof authPersistenceStore) => import('firebase/auth').Persistence
  )(authPersistenceStore);
}

async function load(config: FirebaseConfig): Promise<FirebaseServices | null> {
  try {
    const [appModule, authModule, storeModule] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]);

    const { initializeApp, getApps, getApp } = appModule;
    const app = getApps().length > 0 ? getApp() : initializeApp(config);

    const persistence = reactNativePersistence(authModule);
    let auth: import('firebase/auth').Auth;
    try {
      auth =
        persistence != null
          ? authModule.initializeAuth(app, { persistence })
          : authModule.initializeAuth(app);
    } catch {
      // Already initialized (a Fast Refresh in dev re-enters this module).
      auth = authModule.getAuth(app);
    }

    // Long polling rather than the streaming transport: React Native has no
    // full fetch-streams implementation, and the auto-detect handshake spends
    // the first seconds of every launch failing over. Forcing it keeps the
    // first read predictable.
    let db: import('firebase/firestore').Firestore;
    try {
      db = storeModule.initializeFirestore(app, { experimentalForceLongPolling: true });
    } catch {
      db = storeModule.getFirestore(app);
    }

    return {
      auth,
      db,
      authApi: authModule,
      storeApi: storeModule,
      projectId: config.projectId,
    };
  } catch (err) {
    // A build that cannot bring up Firebase is a LOCAL-ONLY build. Log once
    // for the developer; the user never sees an error for this.
    console.warn('[firebase] cloud features are off for this build', err);
    return null;
  }
}

/**
 * Bring up (or reuse) the Firebase services, or `null` when this build has no
 * config. Never throws. Cheap and synchronous-ish on the unconfigured path:
 * it does not touch the network and does not load the SDK.
 */
export function getFirebase(): Promise<FirebaseServices | null> {
  if (cached != null) return cached;
  const config = readFirebaseConfig();
  if (config == null) {
    cached = Promise.resolve(null);
    return cached;
  }
  cached = load(config);
  return cached;
}

/** Test seam — drops the memoized services so a suite can re-evaluate config. */
export function resetFirebaseForTests(): void {
  cached = null;
}
