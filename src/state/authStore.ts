/**
 * authStore — who is signed in, and nothing else the app has to wait for.
 *
 * THE RULE THIS STORE IS BUILT AROUND: signed out, guest, unconfigured and
 * offline are all NORMAL. Hoopilot worked with no account before this store
 * existed and still does; the cloud is an opt-in mirror of a local SQLite
 * database that stays the source of truth. So:
 *
 *   - `status` starts as 'starting' and settles to 'unconfigured' on a build
 *     with no Firebase config. No screen is gated on it, no modal appears, and
 *     nothing retries in the background.
 *   - {@link bootstrap} never awaits the network. It resolves the (already
 *     persisted) auth session if there is one, and returns immediately
 *     otherwise. The root layout fires it and forgets it.
 *   - ANONYMOUS sign-in is never automatic. It happens when the user taps
 *     "keep going without an account", because that is the only moment where
 *     paying for a network round trip is what they asked for.
 *   - Every action swallows its failure and leaves `notice` — one short line
 *     that says what to DO next, never an SDK error code.
 *
 * Sessions survive a restart through the SDK's own persistence, wired to
 * expo-sqlite in firebaseApp.ts (no new native dependency — see that file).
 *
 * A guest is a real account: signing up from a guest session UPGRADES it in
 * place with linkWithCredential, keeping the same uid, so the history a guest
 * already mirrored stays theirs instead of being orphaned.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { getFirebase, withTimeout } from '../data/firebaseApp';
import { syncRecords } from '../data/firebaseSync';

export type AuthStatus =
  /** Resolving the persisted session. Transient, and never gates a screen. */
  | 'starting'
  /** This build ships no Firebase config. Local-only, and that is fine. */
  | 'unconfigured'
  /** Cloud is available; nobody is signed in. */
  | 'signed-out'
  /** Anonymous account — full app, records mirrored, no email yet. */
  | 'guest'
  /** Email account. */
  | 'account';

export interface AuthState {
  status: AuthStatus;
  uid: string | null;
  email: string | null;
  /** An action is in flight — disables the form's buttons, nothing else. */
  busy: boolean;
  /** One short line of guidance for the user. Never an error code. */
  notice: string | null;
  syncing: boolean;
  /** Epoch ms of the last completed mirror. Persisted. */
  lastSyncAt: number | null;
  /** Plain result of the last mirror attempt. Persisted so the screen opens honest. */
  lastSyncNote: string | null;

  bootstrap: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  upgradeToAccount: (email: string, password: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOutNow: () => Promise<void>;
  syncNow: () => Promise<void>;
  clearNotice: () => void;
}

/** Shortest password Firebase accepts. Checked locally so a typo costs no round trip. */
export const MIN_PASSWORD = 6;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Local form validation. Returns the line to show, or null when it is fine. */
export function validateCredentials(email: string, password: string): string | null {
  if (!EMAIL.test(email.trim())) return 'Enter an email address like you@example.com.';
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the password.`;
  return null;
}

/**
 * Firebase error code -> one line that tells the user what to do.
 *
 * Exported so a test can pin the mapping. Anything unmapped falls through to
 * a plain retry line: the user never reads "auth/internal-error".
 */
export function noticeForError(err: unknown): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : err instanceof Error
        ? err.message
        : '';
  switch (code) {
    case 'auth/invalid-email':
      return 'Check the email address and try again.';
    case 'auth/missing-password':
    case 'auth/weak-password':
      return `Use at least ${MIN_PASSWORD} characters for the password.`;
    case 'auth/email-already-in-use':
    case 'auth/credential-already-in-use':
      return 'That email already has an account. Sign in instead.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password do not match. Try again, or reset your password.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a minute, then try again.';
    case 'auth/network-request-failed':
    case 'timeout':
      return 'No connection. Your history is safe on this phone — try again when you have signal.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is switched off for this project. Turn it on in Firebase, then try again.';
    default:
      return 'That did not go through. Try again.';
  }
}

/** Only ever attach one auth listener per launch. */
let listening = false;

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      status: 'starting',
      uid: null,
      email: null,
      busy: false,
      notice: null,
      syncing: false,
      lastSyncAt: null,
      lastSyncNote: null,

      bootstrap: () => {
        if (listening) return;
        listening = true;
        // Fire and forget on purpose: the root layout must not await this, and
        // an unconfigured build resolves without touching the network.
        void (async () => {
          const services = await getFirebase();
          if (services == null) {
            set({ status: 'unconfigured' });
            return;
          }
          services.authApi.onAuthStateChanged(services.auth, (user) => {
            if (user == null) {
              set({ status: 'signed-out', uid: null, email: null });
              return;
            }
            set({
              status: user.isAnonymous ? 'guest' : 'account',
              uid: user.uid,
              email: user.email ?? null,
            });
          });
        })();
      },

      signIn: async (email, password) => {
        const local = validateCredentials(email, password);
        if (local != null) {
          set({ notice: local });
          return;
        }
        const services = await getFirebase();
        if (services == null) return;
        set({ busy: true, notice: null });
        try {
          await withTimeout(
            services.authApi.signInWithEmailAndPassword(services.auth, email.trim(), password),
          );
          set({ busy: false, notice: null });
          // Signing in IS the "get my history onto this phone" action.
          void get().syncNow();
        } catch (err) {
          set({ busy: false, notice: noticeForError(err) });
        }
      },

      signUp: async (email, password) => {
        const local = validateCredentials(email, password);
        if (local != null) {
          set({ notice: local });
          return;
        }
        // A guest signing up must KEEP their uid and their records.
        if (get().status === 'guest') {
          await get().upgradeToAccount(email, password);
          return;
        }
        const services = await getFirebase();
        if (services == null) return;
        set({ busy: true, notice: null });
        try {
          await withTimeout(
            services.authApi.createUserWithEmailAndPassword(services.auth, email.trim(), password),
          );
          set({ busy: false, notice: null });
          void get().syncNow();
        } catch (err) {
          set({ busy: false, notice: noticeForError(err) });
        }
      },

      continueAsGuest: async () => {
        const services = await getFirebase();
        if (services == null) return;
        set({ busy: true, notice: null });
        try {
          await withTimeout(services.authApi.signInAnonymously(services.auth));
          set({ busy: false, notice: null });
        } catch (err) {
          set({ busy: false, notice: noticeForError(err) });
        }
      },

      upgradeToAccount: async (email, password) => {
        const local = validateCredentials(email, password);
        if (local != null) {
          set({ notice: local });
          return;
        }
        const services = await getFirebase();
        if (services == null) return;
        const current = services.auth.currentUser;
        if (current == null) {
          // Nothing to upgrade — make it a plain sign-up rather than a dead end.
          await get().signUp(email, password);
          return;
        }
        set({ busy: true, notice: null });
        try {
          const credential = services.authApi.EmailAuthProvider.credential(email.trim(), password);
          const result = await withTimeout(
            services.authApi.linkWithCredential(current, credential),
          );
          // linkWithCredential mutates the SAME user, so onAuthStateChanged may
          // not fire — settle the state here rather than leaving it as 'guest'.
          set({
            busy: false,
            notice: null,
            status: 'account',
            uid: result.user.uid,
            email: result.user.email ?? email.trim(),
          });
          void get().syncNow();
        } catch (err) {
          set({ busy: false, notice: noticeForError(err) });
        }
      },

      resetPassword: async (email) => {
        if (!EMAIL.test(email.trim())) {
          set({ notice: 'Enter the email address for your account first.' });
          return;
        }
        const services = await getFirebase();
        if (services == null) return;
        set({ busy: true, notice: null });
        try {
          await withTimeout(services.authApi.sendPasswordResetEmail(services.auth, email.trim()));
          set({ busy: false, notice: 'Check your inbox for the reset link.' });
        } catch (err) {
          set({ busy: false, notice: noticeForError(err) });
        }
      },

      signOutNow: async () => {
        const services = await getFirebase();
        if (services == null) return;
        set({ busy: true, notice: null });
        try {
          await withTimeout(services.authApi.signOut(services.auth));
          set({ busy: false, status: 'signed-out', uid: null, email: null });
        } catch (err) {
          set({ busy: false, notice: noticeForError(err) });
        }
      },

      syncNow: async () => {
        const { uid, status, syncing } = get();
        // Unconfigured, signed out, or already running: nothing to say.
        if (syncing || uid == null || status === 'unconfigured' || status === 'signed-out') return;
        set({ syncing: true });
        const result = await syncRecords(uid);
        if (result.outcome === 'done') {
          const moved = result.pushed + result.imported;
          set({
            syncing: false,
            lastSyncAt: Date.now(),
            lastSyncNote:
              result.imported > 0
                ? `Added ${result.imported} session${result.imported === 1 ? '' : 's'} from your other device.`
                : moved > 0
                  ? `Backed up ${result.pushed} session${result.pushed === 1 ? '' : 's'}.`
                  : 'Everything is already backed up.',
          });
          return;
        }
        set({
          syncing: false,
          lastSyncNote:
            result.outcome === 'off'
              ? null
              : 'Could not reach your account. Your history is safe on this phone — try again when you have signal.',
        });
      },

      clearNotice: () => set({ notice: null }),
    }),
    {
      name: 'hoopai-auth',
      storage: createJSONStorage(() => Storage),
      // Only the sync receipt is persisted. The SESSION itself is the auth
      // SDK's business (it owns token refresh), and mirroring uid/status into
      // our own store would let a stale copy claim someone is signed in.
      partialize: ({ lastSyncAt, lastSyncNote }) => ({ lastSyncAt, lastSyncNote }),
      version: 1,
    },
  ),
);

/** Test seam — lets a suite re-arm bootstrap()'s once-per-launch guard. */
export function resetAuthBootstrapForTests(): void {
  listening = false;
}
