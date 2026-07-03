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

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { color } from '@/constants/tokens';
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
            }}
          >
            {/* Onboarding fades in over the splash and can't be swiped away. */}
            <Stack.Screen name="onboarding" options={{ animation: 'fade', gestureEnabled: false }} />
          </Stack>
        </ErrorBoundary>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
