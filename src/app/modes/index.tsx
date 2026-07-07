/**
 * Mode picker — choose how you want to play before opening the camera.
 *
 * Every mode reads like a game cartridge: its Ionicons mark in an accent-tinted
 * badge, name, tagline inked in the mode's own hue, two-line rules, a
 * rules-at-a-glance chip row and a bold START affordance (the whole card is the
 * button). Cards rise in with a reduced-motion-aware stagger. Picking one arms
 * the mode store and routes to /session/setup; the previously picked mode wears
 * a solid PICKED tag + accent border so it is unmistakable.
 */
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';

import { ProBadge } from '@/components/ProBadge';
import { BackPill } from '@/components/ShotList';
import { MODE_IDENTITY, type ModeIdentity } from '@/components/modes/modeIdentity';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import { GAME_MODES, type GameModeDef } from '@/core/gameModes';
import { PRO_FEATURES } from '@/core/premium';
import { useMode } from '@/state/modeStore';
import { useSettings } from '@/state/settingsStore';

export default function ModePickerScreen() {
  const selectMode = useMode((s) => s.selectMode);
  const activeMode = useMode((s) => s.activeMode);
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const reducedMotion = useReducedMotion();
  const [proOpen, setProOpen] = useState(false);
  const hasProModes = GAME_MODES.some((m) => m.id !== 'free');

  // Entrance stagger: header first, then cards rise one by one. Under reduced
  // motion the delays collapse so nothing appears to lag.
  const enter = (i: number) =>
    FadeInDown.delay(reducedMotion ? 0 : 60 + i * 50)
      .duration(motion.standard)
      .reduceMotion(ReduceMotion.System);

  const pick = (id: GameModeDef['id']) => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    selectMode(id);
    router.push('/session/setup');
  };

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Animated.View
        entering={FadeIn.duration(motion.standard).reduceMotion(ReduceMotion.System)}
      >
        <Eyebrow>Choose a mode</Eyebrow>
        <Text style={styles.title}>How do you want to play?</Text>
        <Text style={styles.lede}>
          Every mode runs on the same automatic make/miss tracking — pick a game and prop your
          phone up.
        </Text>
      </Animated.View>

      <View style={styles.list}>
        {GAME_MODES.map((mode, i) => (
          <Animated.View key={mode.id} entering={enter(i)}>
            <ModeCard
              mode={mode}
              identity={MODE_IDENTITY[mode.id]}
              selected={activeMode?.modeId === mode.id}
              onPress={() => pick(mode.id)}
            />
          </Animated.View>
        ))}
      </View>

      {hasProModes && (
        <View style={styles.proSection}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={proOpen ? 'Hide what Pro unlocks' : 'What does Pro unlock?'}
            accessibilityState={{ expanded: proOpen }}
            onPress={() => {
              if (hapticsEnabled) void Haptics.selectionAsync();
              setProOpen((v) => !v);
            }}
            style={({ pressed }) => [styles.proLink, pressed && { opacity: 0.7 }]}
          >
            <ProBadge />
            <Text style={styles.proLinkText}>
              {proOpen ? 'Hide what Pro unlocks' : 'What does Pro unlock?'}
            </Text>
            <Text style={styles.proChevron}>{proOpen ? '︿' : '﹀'}</Text>
          </Pressable>
          {proOpen && (
            <Animated.View entering={FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System)}>
              <Card style={styles.proCard}>
                <Text style={styles.proCardNote}>
                  Everything below is unlocked and free during beta. This is what stays part of
                  Hoopilot Pro after launch.
                </Text>
                <View style={styles.proFeatureList}>
                  {PRO_FEATURES.map((f) => (
                    <View key={f.id} style={styles.proFeatureRow}>
                      <Text style={styles.proFeatureName}>{f.name}</Text>
                      <Text style={styles.proFeatureBlurb}>{f.blurb}</Text>
                    </View>
                  ))}
                </View>
              </Card>
            </Animated.View>
          )}
        </View>
      )}
    </Screen>
  );
}

function ModeCard({
  mode,
  identity,
  selected,
  onPress,
}: {
  mode: GameModeDef;
  identity: ModeIdentity;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${mode.name}. ${mode.tagline}`}
      accessibilityHint={mode.rules}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.card,
        selected && [styles.cardSelected, { borderColor: identity.accent }],
        pressed && styles.cardPressed,
        pressed && { transform: [{ scale: 0.985 }] },
      ]}
    >
      {/* The mode's mark — glyph on its own accent-tinted badge. */}
      <View
        style={[
          styles.iconBadge,
          { borderColor: identity.accent, backgroundColor: identity.tint },
        ]}
      >
        <Ionicons name={identity.icon} size={24} color={identity.accent} />
      </View>

      <View style={styles.cardBody}>
        <Row style={styles.cardHead} gap={space.sm}>
          <Text style={styles.name} numberOfLines={1}>
            {mode.name}
          </Text>
          <Row gap={space.xs}>
            {mode.id !== 'free' && <ProBadge />}
            {selected && (
              <View style={[styles.selectedTag, { backgroundColor: identity.accent }]}>
                <Text style={styles.selectedTagText}>✓ PICKED</Text>
              </View>
            )}
          </Row>
        </Row>
        <Text style={[styles.tagline, { color: identity.accent }]}>{mode.tagline}</Text>
        <Text style={styles.rules} numberOfLines={2}>
          {mode.rules}
        </Text>

        {/* Rules at a glance + bold Start (the whole card is the button). */}
        <Row gap={space.sm} style={styles.footRow}>
          <Row gap={space.xs} style={styles.glanceRow}>
            {identity.glance.map((g) => (
              <View key={g} style={styles.glanceChip}>
                <Text style={styles.glanceText}>{g.toUpperCase()}</Text>
              </View>
            ))}
          </Row>
          <View style={[styles.startPill, { backgroundColor: identity.accent }]}>
            <Ionicons name="play" size={11} color={color.onAccent} />
            <Text style={styles.startText}>START</Text>
          </View>
        </Row>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
  },
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.xl,
  },
  list: {
    gap: space.md,
  },
  card: {
    flexDirection: 'row',
    gap: space.lg,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  cardSelected: {
    borderWidth: 1.5,
    backgroundColor: color.surfaceRaised,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    minWidth: 0,
  },
  cardHead: {
    justifyContent: 'space-between',
  },
  name: {
    ...type.heading,
    color: color.text,
    flexShrink: 1,
  },
  selectedTag: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  selectedTagText: {
    ...type.micro,
    color: color.onAccent,
  },
  tagline: {
    ...type.bodyMedium,
    marginTop: 2,
  },
  rules: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  footRow: {
    marginTop: space.md,
    justifyContent: 'space-between',
  },
  glanceRow: {
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  glanceChip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 3,
  },
  glanceText: {
    ...type.micro,
    color: color.textFaint,
  },
  startPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  startText: {
    ...type.micro,
    color: color.onAccent,
  },
  proSection: {
    marginTop: space.xl,
  },
  proLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'center',
    minHeight: touch.minTarget,
    paddingHorizontal: space.lg,
  },
  proLinkText: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  proChevron: {
    ...type.caption,
    color: color.textFaint,
  },
  proCard: {
    marginTop: space.md,
  },
  proCardNote: {
    ...type.body,
    color: color.textDim,
    marginBottom: space.md,
  },
  proFeatureList: {
    gap: space.md,
  },
  proFeatureRow: {
    gap: 2,
  },
  proFeatureName: {
    ...type.bodyMedium,
    color: color.text,
  },
  proFeatureBlurb: {
    ...type.body,
    color: color.textDim,
  },
});
