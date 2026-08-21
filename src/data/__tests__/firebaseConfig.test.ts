/**
 * Tests for src/data/firebaseConfig.ts — and specifically for THE STATE THE
 * DEMO RUNS IN: no Firebase config at all.
 *
 * "Unconfigured" must be a silent, ordinary answer (`null`), never a throw,
 * never a partial config that blows up on first use, and never a hardcoded
 * fallback key. A half-filled `.env` (a placeholder left in place) counts as
 * unconfigured too — a build that would spend the demo throwing
 * `auth/invalid-api-key` is worse than a build with no cloud at all.
 */
const extra: { firebase?: Record<string, unknown> } = {};

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra };
    },
  },
}));

import { REQUIRED_CONFIG_KEYS, isFirebaseConfigured, readFirebaseConfig } from '../firebaseConfig';

const ENV_KEYS = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
] as const;

/** A complete, obviously fake config. No real key ever appears in this repo. */
const FULL = {
  EXPO_PUBLIC_FIREBASE_API_KEY: 'unit-test-key-0000',
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'unit-test.firebaseapp.com',
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'unit-test-project',
  EXPO_PUBLIC_FIREBASE_APP_ID: '1:000:web:0000',
} as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  delete extra.firebase;
});

describe('an unconfigured build', () => {
  it('reads as local-only instead of throwing', () => {
    expect(readFirebaseConfig()).toBeNull();
    expect(isFirebaseConfigured()).toBe(false);
  });

  it('ships no fallback config of its own', () => {
    // Guards the rule that no key, project id or domain is ever hardcoded in
    // a tracked file — the module must have nothing to fall back ON.
    expect(readFirebaseConfig()).toBeNull();
  });

  it('treats a PARTIAL config as unconfigured, one missing key at a time', () => {
    for (const missing of ENV_KEYS) {
      for (const key of ENV_KEYS) process.env[key] = FULL[key];
      delete process.env[missing];
      expect([missing, readFirebaseConfig()]).toEqual([missing, null]);
    }
  });

  it('treats a left-in placeholder as unconfigured', () => {
    for (const key of ENV_KEYS) process.env[key] = FULL[key];
    for (const placeholder of ['your-api-key', 'xxxxx', 'CHANGEME', 'replace-me', 'TODO', '']) {
      process.env.EXPO_PUBLIC_FIREBASE_API_KEY = placeholder;
      expect([placeholder, readFirebaseConfig()]).toEqual([placeholder, null]);
    }
  });
});

describe('a configured build', () => {
  it('reads all four values out of the environment', () => {
    for (const key of ENV_KEYS) process.env[key] = FULL[key];
    expect(readFirebaseConfig()).toEqual({
      apiKey: FULL.EXPO_PUBLIC_FIREBASE_API_KEY,
      authDomain: FULL.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: FULL.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
      appId: FULL.EXPO_PUBLIC_FIREBASE_APP_ID,
    });
    expect(isFirebaseConfigured()).toBe(true);
  });

  it('accepts values injected through app config extra instead', () => {
    extra.firebase = {
      apiKey: 'from-app-config',
      authDomain: 'x.firebaseapp.com',
      projectId: 'x',
      appId: '1:1:web:1',
    };
    expect(readFirebaseConfig()?.apiKey).toBe('from-app-config');
  });

  it('lets the environment win over app config', () => {
    extra.firebase = {
      apiKey: 'from-app-config',
      authDomain: 'x.firebaseapp.com',
      projectId: 'x',
      appId: '1:1:web:1',
    };
    process.env.EXPO_PUBLIC_FIREBASE_API_KEY = 'from-env';
    expect(readFirebaseConfig()?.apiKey).toBe('from-env');
  });

  it('trims whitespace a copy-paste leaves behind', () => {
    for (const key of ENV_KEYS) process.env[key] = `  ${FULL[key]}  `;
    expect(readFirebaseConfig()?.projectId).toBe(FULL.EXPO_PUBLIC_FIREBASE_PROJECT_ID);
  });

  it('needs exactly the four documented keys', () => {
    expect([...REQUIRED_CONFIG_KEYS]).toEqual(['apiKey', 'authDomain', 'projectId', 'appId']);
  });
});
