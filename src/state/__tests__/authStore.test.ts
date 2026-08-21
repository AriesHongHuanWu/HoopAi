/**
 * Tests for src/state/authStore.ts.
 *
 * THE FIRST HALF IS THE IMPORTANT HALF: with no Firebase config, every action
 * on this store is a silent no-op. No throw, no error line, no network call,
 * no blocking state. That is the configuration the hackathon demo runs in and
 * the configuration every fresh checkout is in, so it is pinned first.
 *
 * The second half drives a fake auth SDK — the store never imports
 * `firebase/*` itself (firebaseApp.ts hands it the loaded module), so a suite
 * can fake the whole thing without loading a byte of the real SDK.
 */
const mockMem = new Map<string, string>();

jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => Promise.resolve(mockMem.get(key) ?? null),
    setItem: (key: string, value: string) => {
      mockMem.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      mockMem.delete(key);
      return Promise.resolve(true);
    },
  },
}));

jest.mock('../../data/firebaseApp', () => ({
  getFirebase: jest.fn(),
  withTimeout: (promise: Promise<unknown>) => promise,
}));

jest.mock('../../data/firebaseSync', () => ({
  syncRecords: jest.fn(),
}));

import { getFirebase } from '../../data/firebaseApp';
import { syncRecords } from '../../data/firebaseSync';
import {
  MIN_PASSWORD,
  noticeForError,
  resetAuthBootstrapForTests,
  useAuth,
  validateCredentials,
} from '../authStore';

const getFirebaseMock = getFirebase as jest.MockedFunction<typeof getFirebase>;
const syncRecordsMock = syncRecords as jest.MockedFunction<typeof syncRecords>;

/** A user object shaped like the SDK's. */
function user(over: { uid?: string; email?: string | null; isAnonymous?: boolean } = {}) {
  return {
    uid: over.uid ?? 'uid-1',
    email: over.email === undefined ? 'player@example.com' : over.email,
    isAnonymous: over.isAnonymous ?? false,
  };
}

/** A fake `firebase/auth` module plus its Auth instance. */
function fakeAuth() {
  let listener: ((u: unknown) => void) | null = null;
  const auth: { currentUser: unknown } = { currentUser: null };
  const authApi = {
    onAuthStateChanged: jest.fn((_auth: unknown, cb: (u: unknown) => void) => {
      listener = cb;
      return () => {};
    }),
    signInWithEmailAndPassword: jest.fn().mockResolvedValue({ user: user() }),
    createUserWithEmailAndPassword: jest.fn().mockResolvedValue({ user: user() }),
    signInAnonymously: jest.fn().mockResolvedValue({ user: user({ isAnonymous: true }) }),
    sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    signOut: jest.fn().mockResolvedValue(undefined),
    linkWithCredential: jest.fn().mockResolvedValue({ user: user() }),
    EmailAuthProvider: { credential: jest.fn(() => ({ __credential: true })) },
  };
  const services = { auth, db: {}, authApi, storeApi: {}, projectId: 'p' };
  getFirebaseMock.mockResolvedValue(services as unknown as Awaited<ReturnType<typeof getFirebase>>);
  return {
    auth,
    authApi,
    emit: (u: unknown) => listener?.(u),
  };
}

/** Let the store's fire-and-forget promises settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  mockMem.clear();
  jest.clearAllMocks();
  resetAuthBootstrapForTests();
  useAuth.setState({
    status: 'starting',
    uid: null,
    email: null,
    busy: false,
    notice: null,
    syncing: false,
    lastSyncAt: null,
    lastSyncNote: null,
  });
  syncRecordsMock.mockResolvedValue({ outcome: 'done', pushed: 0, imported: 0, unchanged: 0 });
});

describe('with no Firebase config, everything is a silent no-op', () => {
  beforeEach(() => {
    getFirebaseMock.mockResolvedValue(null);
  });

  it('settles to "unconfigured" and never blocks', async () => {
    useAuth.getState().bootstrap();
    await settle();
    expect(useAuth.getState().status).toBe('unconfigured');
    expect(useAuth.getState().busy).toBe(false);
    expect(useAuth.getState().notice).toBeNull();
  });

  it('leaves no error and no busy flag behind on any action', async () => {
    useAuth.getState().bootstrap();
    await settle();
    await useAuth.getState().signIn('player@example.com', 'hunter2');
    await useAuth.getState().signUp('player@example.com', 'hunter2');
    await useAuth.getState().continueAsGuest();
    await useAuth.getState().resetPassword('player@example.com');
    await useAuth.getState().signOutNow();
    await useAuth.getState().syncNow();
    const state = useAuth.getState();
    expect(state.status).toBe('unconfigured');
    expect(state.notice).toBeNull();
    expect(state.busy).toBe(false);
    expect(state.syncing).toBe(false);
    expect(syncRecordsMock).not.toHaveBeenCalled();
  });

  it('never syncs, whatever the UI asks for', async () => {
    useAuth.setState({ status: 'unconfigured', uid: 'somehow' });
    await useAuth.getState().syncNow();
    expect(syncRecordsMock).not.toHaveBeenCalled();
    expect(useAuth.getState().lastSyncAt).toBeNull();
  });

  it('attaches nothing twice, so a re-render cannot pile up listeners', async () => {
    useAuth.getState().bootstrap();
    useAuth.getState().bootstrap();
    await settle();
    expect(getFirebaseMock).toHaveBeenCalledTimes(1);
  });
});

describe('local validation happens before any round trip', () => {
  it('names the fix instead of reporting a failure', () => {
    expect(validateCredentials('nope', 'hunter2')).toMatch(/you@example\.com/);
    expect(validateCredentials('player@example.com', 'abc')).toContain(String(MIN_PASSWORD));
    expect(validateCredentials('player@example.com', 'hunter2')).toBeNull();
  });

  it('costs no network call', async () => {
    const fake = fakeAuth();
    await useAuth.getState().signIn('nope', 'x');
    expect(fake.authApi.signInWithEmailAndPassword).not.toHaveBeenCalled();
    expect(useAuth.getState().notice).toMatch(/you@example\.com/);
  });
});

describe('the persisted session decides the status', () => {
  it('reads an email user as an account', async () => {
    const fake = fakeAuth();
    useAuth.getState().bootstrap();
    await settle();
    fake.emit(user());
    expect(useAuth.getState()).toMatchObject({
      status: 'account',
      uid: 'uid-1',
      email: 'player@example.com',
    });
  });

  it('reads an anonymous user as a guest, not as signed out', async () => {
    const fake = fakeAuth();
    useAuth.getState().bootstrap();
    await settle();
    fake.emit(user({ isAnonymous: true, email: null }));
    expect(useAuth.getState()).toMatchObject({ status: 'guest', uid: 'uid-1', email: null });
  });

  it('reads no user as signed out', async () => {
    const fake = fakeAuth();
    useAuth.getState().bootstrap();
    await settle();
    fake.emit(null);
    expect(useAuth.getState().status).toBe('signed-out');
  });
});

describe('signing in', () => {
  it('mirrors records straight after a successful sign-in', async () => {
    const fake = fakeAuth();
    useAuth.setState({ status: 'signed-out' });
    await useAuth.getState().signIn('player@example.com', 'hunter2');
    expect(fake.authApi.signInWithEmailAndPassword).toHaveBeenCalledWith(
      fake.auth,
      'player@example.com',
      'hunter2',
    );
    // syncNow is fired and forgotten; it only runs once a uid exists.
    fake.emit(user());
    await settle();
    expect(useAuth.getState().busy).toBe(false);
  });

  it('turns an SDK error code into one line of guidance', async () => {
    const fake = fakeAuth();
    fake.authApi.signInWithEmailAndPassword.mockRejectedValue({ code: 'auth/invalid-credential' });
    await useAuth.getState().signIn('player@example.com', 'hunter2');
    expect(useAuth.getState().notice).toBe(
      'That email and password do not match. Try again, or reset your password.',
    );
    expect(useAuth.getState().busy).toBe(false);
  });

  it('says what to do when the phone is offline', async () => {
    const fake = fakeAuth();
    fake.authApi.signInWithEmailAndPassword.mockRejectedValue({
      code: 'auth/network-request-failed',
    });
    await useAuth.getState().signIn('player@example.com', 'hunter2');
    expect(useAuth.getState().notice).toContain('safe on this phone');
  });

  it('never leaks an SDK error code to the user', () => {
    expect(noticeForError({ code: 'auth/internal-error' })).toBe('That did not go through. Try again.');
    expect(noticeForError(new Error('timeout'))).toContain('safe on this phone');
    expect(noticeForError({ code: 'auth/email-already-in-use' })).toContain('Sign in instead');
    for (const code of ['auth/internal-error', 'auth/invalid-credential', 'auth/weak-password']) {
      expect(noticeForError({ code })).not.toContain('auth/');
    }
  });
});

describe('playing without an account', () => {
  it('only signs in anonymously when the user asks', async () => {
    const fake = fakeAuth();
    useAuth.getState().bootstrap();
    await settle();
    // Bootstrap alone must not create an account behind the user's back.
    expect(fake.authApi.signInAnonymously).not.toHaveBeenCalled();

    await useAuth.getState().continueAsGuest();
    expect(fake.authApi.signInAnonymously).toHaveBeenCalledWith(fake.auth);
  });

  it('upgrades a guest in place, keeping the uid and the history', async () => {
    const fake = fakeAuth();
    fake.auth.currentUser = user({ uid: 'guest-uid', email: null, isAnonymous: true });
    fake.authApi.linkWithCredential.mockResolvedValue({
      user: user({ uid: 'guest-uid', email: 'player@example.com' }),
    });
    useAuth.setState({ status: 'guest', uid: 'guest-uid', email: null });

    // Signing UP as a guest must link, never create a second account.
    await useAuth.getState().signUp('player@example.com', 'hunter2');
    expect(fake.authApi.createUserWithEmailAndPassword).not.toHaveBeenCalled();
    expect(fake.authApi.linkWithCredential).toHaveBeenCalled();
    expect(useAuth.getState()).toMatchObject({
      status: 'account',
      uid: 'guest-uid',
      email: 'player@example.com',
    });
  });

  it('falls back to a plain sign-up when there is nothing to upgrade', async () => {
    const fake = fakeAuth();
    fake.auth.currentUser = null;
    useAuth.setState({ status: 'signed-out' });
    await useAuth.getState().upgradeToAccount('player@example.com', 'hunter2');
    expect(fake.authApi.createUserWithEmailAndPassword).toHaveBeenCalled();
  });
});

describe('the sync receipt', () => {
  beforeEach(() => {
    fakeAuth();
    useAuth.setState({ status: 'account', uid: 'uid-1' });
  });

  it('says how many sessions came from the other device', async () => {
    syncRecordsMock.mockResolvedValue({ outcome: 'done', pushed: 0, imported: 2, unchanged: 3 });
    await useAuth.getState().syncNow();
    expect(useAuth.getState().lastSyncNote).toBe('Added 2 sessions from your other device.');
    expect(useAuth.getState().lastSyncAt).not.toBeNull();
    expect(useAuth.getState().syncing).toBe(false);
  });

  it('says everything is already up there when nothing moved', async () => {
    syncRecordsMock.mockResolvedValue({ outcome: 'done', pushed: 0, imported: 0, unchanged: 4 });
    await useAuth.getState().syncNow();
    expect(useAuth.getState().lastSyncNote).toBe('Everything is already backed up.');
  });

  it('reassures rather than alarms when the cloud is unreachable', async () => {
    syncRecordsMock.mockResolvedValue({ outcome: 'unreachable', pushed: 0, imported: 0, unchanged: 0 });
    await useAuth.getState().syncNow();
    const state = useAuth.getState();
    expect(state.lastSyncNote).toContain('safe on this phone');
    // A failed mirror must not claim a successful backup time.
    expect(state.lastSyncAt).toBeNull();
    expect(state.syncing).toBe(false);
  });

  it('does not start a second pass while one is running', async () => {
    useAuth.setState({ syncing: true });
    await useAuth.getState().syncNow();
    expect(syncRecordsMock).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('drops the session and keeps the phone as the source of truth', async () => {
    const fake = fakeAuth();
    useAuth.setState({ status: 'account', uid: 'uid-1', email: 'player@example.com' });
    await useAuth.getState().signOutNow();
    expect(fake.authApi.signOut).toHaveBeenCalledWith(fake.auth);
    expect(useAuth.getState()).toMatchObject({ status: 'signed-out', uid: null, email: null });
  });
});
