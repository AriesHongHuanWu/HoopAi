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
 *
 * BROADCAST IDENTITY (v2): the focused tab sits in an accent pill — the exact
 * accentTint-fill-on-accentEdge-hairline selection pair SegmentedTabs and the
 * Coach week chips already wear — with the icon swapping outline → filled.
 * Focus is a STATIC style swap on purpose (no Reanimated, zero worklet risk);
 * the existing motion.tab cross-fade carries all the movement. Each switch
 * ticks the settings-gated selection haptic via src/utils/haptics.ts.
 */
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { color, motion, radius, space, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';

/**
 * One place to declare the tabs so the icons + titles stay in sync. The
 * name/title strings are pinned by tabIaCategorisation.test.tsx (tab word ==
 * screen H1) — change them there deliberately or not at all.
 */
const TABS: {
  name: string;
  title: string;
  /** Filled glyph — shown inside the pill when focused. */
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** Outline sibling — the resting state. */
  iconOutline: React.ComponentProps<typeof Ionicons>['name'];
}[] = [
  { name: 'index', title: 'Home', icon: 'home', iconOutline: 'home-outline' },
  { name: 'modes', title: 'Train', icon: 'basketball', iconOutline: 'basketball-outline' },
  { name: 'history', title: 'Data', icon: 'stats-chart', iconOutline: 'stats-chart-outline' },
  { name: 'coach', title: 'Coach', icon: 'school', iconOutline: 'school-outline' },
  { name: 'profile', title: 'You', icon: 'person-circle', iconOutline: 'person-circle-outline' },
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
          paddingTop: space.xs,
        },
        tabBarLabelStyle: styles.label,
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          // Gated selection tick on every switch — the gateway checks the
          // Settings > Haptics toggle, never raw expo-haptics here.
          listeners={{ tabPress: () => haptic.selection() }}
          options={{
            title: t.title,
            tabBarIcon: ({ color: c, size, focused }) => (
              <View style={[styles.pill, focused && styles.pillFocused]}>
                <Ionicons name={focused ? t.icon : t.iconOutline} size={size} color={c} />
              </View>
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
  /**
   * Fixed footprint whether focused or not (transparent border included) so
   * gaining the pill never nudges the icon by a hairline.
   */
  pill: {
    width: 56,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  pillFocused: {
    backgroundColor: color.accentTint,
    borderColor: color.accentEdge,
  },
});
