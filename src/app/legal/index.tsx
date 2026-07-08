/**
 * Legal hub — the front door for Privacy, Terms and Open-source licenses.
 *
 * Reached from Settings via <LegalLink/> (post-merge wiring). Everything here
 * ships inside the bundle and works fully offline, so App Store / Play review
 * can read every policy with no network. The store listing's required Privacy
 * Policy URL points at a hosted copy of docs/PRIVACY-POLICY.md, which mirrors
 * legal/privacy.tsx word for word.
 *
 * Dark broadcast idiom: an eyebrow, a plain-spoken lede that states the whole
 * privacy posture up front (nothing leaves the phone), then three tap rows.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BackPill } from '@/components/ShotList';
import { Card, Eyebrow, Screen } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface HubRow {
  label: string;
  description: string;
  icon: IconName;
  href: '/legal/privacy' | '/legal/terms' | '/legal/licenses';
}

const ROWS: readonly HubRow[] = [
  {
    label: 'Privacy policy',
    description: 'Exactly what the app collects, where it stays, and what never leaves your phone.',
    icon: 'lock-closed-outline',
    href: '/legal/privacy',
  },
  {
    label: 'Terms of use',
    description: 'The fair, plain-language agreement for using Hoopilot.',
    icon: 'document-text-outline',
    href: '/legal/terms',
  },
  {
    label: 'Open-source & data licenses',
    description: 'Credits for the models, datasets, libraries and fonts Hoopilot is built on.',
    icon: 'ribbon-outline',
    href: '/legal/licenses',
  },
] as const;

export default function LegalHub() {
  const reduceMotion = useReducedMotion();
  const enter = (i: number) =>
    reduceMotion ? undefined : FadeInDown.delay(i * 70).duration(360);

  return (
    <Screen scroll>
      <BackPill />
      <View style={styles.head}>
        <Eyebrow>Legal</Eyebrow>
        <Text style={styles.title}>Privacy & terms</Text>
        <Text style={styles.lede}>
          Hoopilot runs entirely on your phone. Your camera feed and session
          videos are processed on-device and are never uploaded — nothing is
          shared unless you tap Share or Export yourself. No ads, no trackers, no
          analytics.
        </Text>
      </View>

      <View style={styles.rows}>
        {ROWS.map((r, i) => (
          <Card key={r.href} entering={enter(i + 1)} style={styles.cardReset}>
            <Pressable
              onPress={() => router.push(r.href)}
              accessibilityRole="button"
              accessibilityLabel={r.label}
              accessibilityHint={r.description}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.iconWrap}>
                <Ionicons name={r.icon} size={20} color={color.accent} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{r.label}</Text>
                <Text style={styles.rowDesc}>{r.description}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={color.textFaint} />
            </Pressable>
          </Card>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: {
    marginTop: space.sm,
    marginBottom: space.lg,
  },
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.sm,
  },
  lede: {
    ...type.body,
    color: color.textDim,
  },
  rows: {
    gap: space.md,
  },
  cardReset: {
    padding: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touch.minTarget,
    borderRadius: radius.md,
  },
  rowPressed: {
    opacity: 0.7,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowLabel: {
    ...type.heading,
    color: color.text,
  },
  rowDesc: {
    ...type.caption,
    color: color.textDim,
    marginTop: 2,
    letterSpacing: 0,
  },
});
