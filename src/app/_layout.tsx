/**
 * Root layout — fonts, splash gate, dark navigation theme.
 *
 * First-launch flow: the native splash stays up until BOTH the display/body
 * fonts and the persisted settings store have hydrated. app/index.tsx then
 * renders a <Redirect> to /onboarding when settings.onboardingDone is false,
 * so returning users never see an onboarding flash while settings load.
 */
import {
  BarlowCondensed_500Medium,
  BarlowCondensed_700Bold,
} from '@expo-google-fonts/barlow-condensed';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { color, motion } from '@/constants/tokens';
import { useDeviceTuning } from '@/camera/deviceTuning';
import { useSettings } from '@/state/settingsStore';

SplashScreen.preventAutoHideAsync().catch(() => {
  // Reloading during development may reject this; safe to ignore.
});

/** React Navigation theme mapped onto the broadcast tokens. */
const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: color.accent,
    background: color.bg,
    card: color.surface,
    text: color.text,
    border: color.border,
    notification: color.accent,
  },
};

/** True once the persisted settings store has rehydrated from SQLite. */
function useSettingsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useSettings.persist.hasHydrated());
  useEffect(() => {
    if (useSettings.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useSettings.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    BarlowCondensed_500Medium,
    BarlowCondensed_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });
  const settingsHydrated = useSettingsHydrated();
  // Screen transitions are native, so the OS "Reduce Motion" setting does not
  // reach them on its own. When it is on, every class below collapses to a
  // cross-fade: no travel, no direction, but still a transition rather than a
  // hard cut — the same substitution Apple makes system-wide.
  const reduceMotion = useReducedMotion();
  const drillDown = reduceMotion ? 'fade' : ('slide_from_right' as const);
  const utilityPanel = reduceMotion ? 'fade' : ('slide_from_bottom' as const);
  // One-time per-device detector tuning, applied once settings have hydrated
  // (so it never races the persisted store — see useDeviceTuning).
  useDeviceTuning(settingsHydrated);
  // If fonts fail to load (rare, bundled assets) we still start the app with
  // system-font fallbacks rather than hanging on the splash forever.
  const ready = (fontsLoaded || fontError != null) && settingsHydrated;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready]);

  // Returning null keeps the native splash visible.
  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={navTheme}>
        <StatusBar style="light" />
        <ErrorBoundary>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: color.bg },
              // TRANSITION CLASS 1 — DRILL-DOWN (the default).
              // Declared rather than left to the per-platform default so
              // "I went one level deeper" has the SAME shape and the same
              // timing on both platforms, and so the classes below read as
              // deliberate exceptions to a stated rule instead of noise.
              // Routes that DELIBERATELY stay Class 1 (no per-route entry —
              // an entry whose options equal the default would be noise):
              // trends, records, scoreboard, jump, formcheck, formstudio,
              // formstudio3d, shotlab, leaderboard, history/[id], video/[id],
              // reel/[sessionId], session/setup, session/analyze,
              // settings-advanced, calibration-guide, and the legal sub-pages
              // (privacy, terms, licenses). All of them are "one level deeper
              // into your shooting" — or deeper into a panel — so they slide.
              animation: drillDown,
              animationDuration: motion.standard,
            }}
          >
            {/* The bottom-tab navigator is the app's home surface; every other
                route in this Stack pushes full-bleed OVER its tab bar. */}
            <Stack.Screen name="(tabs)" />

            {/* CLASS 2 — TAKEOVER: a screen that owns the device until it is
                finished. Arrives by cross-fade (there is no "back" to point
                at) and refuses the swipe-back. */}
            {/* Onboarding fades in over the splash and can't be swiped away. */}
            <Stack.Screen name="onboarding" options={{ animation: 'fade', gestureEnabled: false }} />
            {/* Live session: swipe-back would silently drop an in-progress
                (possibly recording) session. The screen's own beforeRemove
                listener shows a confirm-end sheet instead, but disabling the
                iOS swipe gesture here removes the one-motion "flick and it's
                gone" path entirely — Android hardware back still routes
                through beforeRemove and gets the same confirmation. */}
            <Stack.Screen name="session/live" options={{ gestureEnabled: false }} />

            {/* CLASS 3 — PAYOFF ARRIVAL. Summary is reached by
                router.replace() from the live camera: nothing slid sideways,
                the session RESOLVED into its scoreboard, so a lateral push
                mis-describes the moment. It cross-fades instead, and the
                swipe-back is off because "swipe right to re-enter a session
                that already ended" is not a real destination — the screen's
                own dismissTo actions are the only way out. */}
            <Stack.Screen
              name="session/summary"
              options={{ animation: 'fade', gestureEnabled: false }}
            />

            {/* CLASS 4 — UTILITY PANEL. Settings, storage, the legal hub and
                the how-it-works explainer are not "deeper into your shooting"
                — they are app machinery summoned from wherever you were
                (Settings row, the first-summary nudge, receipt HintChips), so
                they rise from the bottom instead of sliding in from the side.
                WHY animation and not `presentation: 'modal'`: Settings is a
                HUB that pushes six further routes, and react-navigation
                auto-promotes every screen pushed after a modal to a modal
                too (see getModalRouteKeys) — settings -> legal -> privacy
                would stack three sheets, and a sheet-presented screen still
                reads WINDOW safe-area insets, so Screen's paddingTop would
                double up inside the card. slide_from_bottom buys the "a
                panel appeared" reading with none of that.
                Their own sub-pages (legal/privacy, terms, licenses) keep the
                Class 1 drill-down, so going deeper inside a panel still
                reads as going deeper. */}
            <Stack.Screen name="settings" options={{ animation: utilityPanel }} />
            <Stack.Screen name="storage" options={{ animation: utilityPanel }} />
            <Stack.Screen name="legal/index" options={{ animation: utilityPanel }} />
            <Stack.Screen name="how-it-works" options={{ animation: utilityPanel }} />
          </Stack>
        </ErrorBoundary>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
