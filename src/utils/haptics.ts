/**
 * haptics — the ONLY sanctioned haptics entry point. Never call expo-haptics
 * directly from screens.
 *
 * Every method checks the user's Settings > Haptics toggle synchronously
 * (useSettings.getState() — no hook, callable anywhere including callbacks
 * scheduled from worklets via scheduleOnRN) and then fires-and-forgets:
 * haptics can be unavailable (simulator, OS setting), so rejections are
 * swallowed. This is where 14+ formerly-ungated call sites converge.
 */
import * as Haptics from 'expo-haptics';

import { useSettings } from '@/state/settingsStore';

/** The single settings gate. */
function enabled(): boolean {
  return useSettings.getState().hapticsEnabled;
}

export const haptic = {
  /** Selection tick — pickers, segmented controls, chips. */
  selection(): void {
    if (!enabled()) return;
    void Haptics.selectionAsync().catch(() => {});
  },
  /** Light impact — card taps, minor confirmations. */
  impactLight(): void {
    if (!enabled()) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  /** Medium impact — primary actions, session start/stop. */
  impactMedium(): void {
    if (!enabled()) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  },
  /** Success notification — a made shot, an export finishing. */
  success(): void {
    if (!enabled()) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
  /** Warning notification — unsure calls, recoverable problems. */
  warning(): void {
    if (!enabled()) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  },
  /** Error notification — misses, failures. */
  error(): void {
    if (!enabled()) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
  },
};
