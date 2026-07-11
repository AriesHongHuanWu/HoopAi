/**
 * haptic gateway — every method must (1) respect Settings > Haptics, reading
 * it fresh per call, (2) map to the right expo-haptics call, and (3) swallow
 * rejections (haptics can be unavailable on simulators/OS settings).
 *
 * expo-sqlite/kv-store is mocked to an in-memory map (zustand persist
 * middleware is not under test); expo-haptics is fully mocked.
 */
jest.mock('expo-sqlite/kv-store', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mem.set(key, value);
      },
      removeItem: (key: string) => {
        mem.delete(key);
      },
    },
  };
});

jest.mock('expo-haptics', () => ({
  __esModule: true,
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

import * as Haptics from 'expo-haptics';

import { useSettings } from '@/state/settingsStore';
import { haptic } from '../haptics';

const selectionAsync = Haptics.selectionAsync as jest.Mock;
const impactAsync = Haptics.impactAsync as jest.Mock;
const notificationAsync = Haptics.notificationAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useSettings.setState({ hapticsEnabled: true });
});

describe('haptic (gate ON)', () => {
  it('selection → selectionAsync', () => {
    haptic.selection();
    expect(selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('impactLight → impactAsync(Light)', () => {
    haptic.impactLight();
    expect(impactAsync).toHaveBeenCalledTimes(1);
    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('impactMedium → impactAsync(Medium)', () => {
    haptic.impactMedium();
    expect(impactAsync).toHaveBeenCalledTimes(1);
    expect(impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it('success/warning/error → notificationAsync with the matching type', () => {
    haptic.success();
    haptic.warning();
    haptic.error();
    expect(notificationAsync).toHaveBeenCalledTimes(3);
    expect(notificationAsync).toHaveBeenNthCalledWith(1, Haptics.NotificationFeedbackType.Success);
    expect(notificationAsync).toHaveBeenNthCalledWith(2, Haptics.NotificationFeedbackType.Warning);
    expect(notificationAsync).toHaveBeenNthCalledWith(3, Haptics.NotificationFeedbackType.Error);
  });
});

describe('haptic (gate OFF)', () => {
  beforeEach(() => {
    useSettings.setState({ hapticsEnabled: false });
  });

  it('fires nothing from any method', () => {
    haptic.selection();
    haptic.impactLight();
    haptic.impactMedium();
    haptic.success();
    haptic.warning();
    haptic.error();
    expect(selectionAsync).not.toHaveBeenCalled();
    expect(impactAsync).not.toHaveBeenCalled();
    expect(notificationAsync).not.toHaveBeenCalled();
  });

  it('reads the toggle fresh per call (flip mid-run)', () => {
    haptic.selection();
    expect(selectionAsync).not.toHaveBeenCalled();
    useSettings.setState({ hapticsEnabled: true });
    haptic.selection();
    expect(selectionAsync).toHaveBeenCalledTimes(1);
  });
});

describe('haptic (unavailable hardware)', () => {
  it('does not throw (sync or async) when the native call rejects', async () => {
    selectionAsync.mockImplementationOnce(() => Promise.reject(new Error('no haptics')));
    impactAsync.mockImplementationOnce(() => Promise.reject(new Error('no haptics')));
    notificationAsync.mockImplementationOnce(() => Promise.reject(new Error('no haptics')));
    expect(() => {
      haptic.selection();
      haptic.impactLight();
      haptic.success();
    }).not.toThrow();
    // Flush microtasks — the swallowed rejections must not surface as
    // unhandled rejections either.
    await Promise.resolve();
    await Promise.resolve();
  });
});
