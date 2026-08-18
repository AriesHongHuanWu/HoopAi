/**
 * Bottom tab bar — the app's primary navigation.
 *
 * Five tabs mirror the real jobs-to-be-done and put every feature one tap away
 * (they used to be buried in a scroll-to-bottom 3x3 grid on Home):
 *   Home  — the launcher: Start CTA, quick start, daily goal/challenges, last session
 *   Train — everything you do at the court besides a tracked session (modes,
 *           scoreboard, jump lab, form studio, AI video check)
 *   Data  — the review screens (history · trends · records)
 *   Coach — the weekly report + Shot Lab deep analysis
 *   You   — identity + config (profile · settings · storage · legal)
 *
 * The immersive/drill-down screens (session/*, onboarding, history/[id],
 * video/[id], reel/[sessionId], and the standalone tools like trends, records,
 * scoreboard, jump, formstudio, shotlab, settings, storage, legal) live in the
 * ROOT Stack and push full-bleed OVER this bar — see app/_layout.tsx.
 */
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';

import { color, motion, type } from '@/constants/tokens';

/** One place to declare the tabs so the icons + titles stay in sync. */
const TABS: {
  name: string;
  title: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
}[] = [
  { name: 'index', title: 'Home', icon: 'home' },
  { name: 'modes', title: 'Train', icon: 'basketball' },
  { name: 'history', title: 'Data', icon: 'stats-chart' },
  { name: 'coach', title: 'Coach', icon: 'school' },
  { name: 'profile', title: 'You', icon: 'person-circle' },
];

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Tab switches used to hard-cut: the new screen appeared in one frame
        // and only THEN did its cards stagger in, so the app read as two
        // unrelated events instead of one movement. A short cross-fade carries
        // the eye across and lands just as the card ladder starts.
        animation: 'fade',
        transitionSpec: {
          animation: 'timing',
          config: { duration: motion.tab },
        },
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.textDim,
        tabBarStyle: {
          backgroundColor: color.surface,
          borderTopColor: color.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        tabBarLabelStyle: styles.label,
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
            tabBarIcon: ({ color: c, size }) => (
              <Ionicons name={t.icon} size={size} color={c} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    ...type.micro,
  },
});
