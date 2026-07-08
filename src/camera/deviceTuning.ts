/**
 * Device tuning glue — reads expo-device, resolves this phone's capability
 * tier, and applies its tuned detector defaults ONCE on first launch.
 *
 * The pure classification lives in src/core/deviceProfile.ts (unit-tested);
 * this file is the thin native-reading + store-wiring layer.
 */
import { useEffect } from 'react';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import {
  classifyDevice,
  DEVICE_TUNING,
  resolveTier,
  type DeviceSignals,
  type DeviceTier,
  type DeviceTuning,
} from '../core/deviceProfile';
import { useSettings } from '../state/settingsStore';

/**
 * Snapshot the device facts expo-device exposes (synchronous module
 * constants). Guarded so a missing field / web / test never throws — every
 * value is optional and classifyDevice tolerates nulls.
 */
export function readDeviceSignals(): DeviceSignals {
  try {
    return {
      os: Platform.OS,
      modelId: Device.modelId ?? null,
      deviceYearClass: Device.deviceYearClass ?? null,
      totalMemoryBytes: Device.totalMemory ?? null,
    };
  } catch {
    return { os: Platform.OS, modelId: null, deviceYearClass: null, totalMemoryBytes: null };
  }
}

/**
 * The tier + tuning to use RIGHT NOW: the static model-string guess, refined
 * by the most recent measured inference time (the benchmark can only lower
 * the tier — see resolveTier). A manual override pins the tier outright.
 */
export function resolvedTuning(
  override: 'auto' | DeviceTier,
  benchmarkMs: number | null,
): { tier: DeviceTier; tuning: DeviceTuning; detected: DeviceTier } {
  const detected = classifyDevice(readDeviceSignals());
  const tier = override === 'auto' ? resolveTier(detected, benchmarkMs) : override;
  return { tier, tuning: DEVICE_TUNING[tier], detected };
}

/**
 * First-launch hook: classify this device and seed the detector defaults from
 * its tier exactly once (applyDeviceTuning's own guard enforces the "once").
 * Runs after settings hydration (call it high in the tree, e.g. root layout).
 * Uses the STATIC tier — no benchmark exists yet on a fresh install; the
 * runtime speed budget in useShotEngine still corrects an over-optimistic
 * guess live, and the Settings label shows the benchmark-refined tier.
 */
export function useDeviceTuning(enabled: boolean): void {
  const applyDeviceTuning = useSettings((s) => s.applyDeviceTuning);
  useEffect(() => {
    // Gate on hydration: applying before the persisted store loads would write
    // tier defaults onto the un-hydrated state, only for rehydration to stomp
    // it back (and lose the deviceTuned guard's memory of a prior tuning).
    if (!enabled) return;
    const detected = classifyDevice(readDeviceSignals());
    applyDeviceTuning(detected);
  }, [enabled, applyDeviceTuning]);
}
