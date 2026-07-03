/**
 * Mode picker — choose how you want to play before opening the camera.
 *
 * A scroll of mode cards (emoji badge with a per-mode accent ring, name,
 * tagline, rules). Picking one arms the mode store and routes to
 * /session/setup, which carries the selection into the live session. Free
 * Play is featured first as the default open run. The previously picked mode
 * wears a solid PICKED tag + accent border so it is unmistakable.
 */
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, ReduceMotion } from 'react-native-reanimated';

import { ProBadge } from '@/components/ProBadge';
import { BackPill } from '@/components/ShotList';
import { Card, Eyebrow, Row, Screen } from '@/components/ui';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import { GAME_MODES, type GameModeDef } from '@/core/gameModes';
import { PRO_FEATURES } from '@/core/premium';
import type { GameModeId } from '@/core/types';
import { useMode } from '@/state/modeStore';
import { useSettings } from '@/state/settingsStore';

/**
 * Per-mode accent for the emoji badge ring — kept subtle (ring + tagline
 * only; the card itself stays neutral). All colors are tokens.
 */
const MODE_ACCENT: Record<GameModeId, string> = {
  free: color.accent,
  aroundTheWorld: color.info,
  spotShooting: color.make,
  timed: color.unsure,
  threePoint: color.threePt,
  ftStreak: color.accent,
  horse: color.textDim,
};

export default function ModePickerScreen() {
  const selectMode = useMode((s) => s.selectMode);
  const activeMode = useMode((s) => s.activeMode);
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const [proOpen, setProOpen] = useState(false);
  const hasProModes = GAME_MODES.some((m) => m.id !== 'free');

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
      <Eyebrow>Choose a mode</Eyebrow>
      <Text style={styles.title}>How do you want to play?</Text>
      <Text style={styles.lede}>
        Every mode runs on the same automatic make/miss tracking — pick a game and prop your phone
        up.
      </Text>

      <View style={styles.list}>
        {GAME_MODES.map((mode, i) => (
          <Animated.View
            key={mode.id}
            entering={FadeInDown.delay(i * 40)
              .duration(motion.standard)
              .reduceMotion(ReduceMotion.System)}
          >
            <ModeCard
              mode={mode}
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
                  HoopAI Pro after launch.
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
  selected,
  onPress,
}: {
  mode: GameModeDef;
  selected: boolean;
  onPress: () => void;
}) {
  const meta = [
    mode.needsTimer ? 'Timed' : null,
    mode.needsSpots ? '5 spots' : null,
  ].filter(Boolean) as string[];
  const accent = MODE_ACCENT[mode.id];

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${mode.name}. ${mode.tagline}`}
      accessibilityHint={mode.rules}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        pressed && styles.cardPressed,
        pressed && { transform: [{ scale: 0.985 }] },
      ]}
    >
      <View style={[styles.emojiBadge, { borderColor: accent }]}>
        <Text style={styles.emoji}>{mode.emoji}</Text>
      </View>
      <View style={styles.cardBody}>
        <Row style={styles.cardHead} gap={space.sm}>
          <Text style={styles.name} numberOfLines={1}>
            {mode.name}
          </Text>
          <Row gap={space.xs}>
            {mode.id !== 'free' && <ProBadge />}
            {selected && (
              <View style={styles.selectedTag}>
                <Text style={styles.selectedTagText}>✓ PICKED</Text>
              </View>
            )}
          </Row>
        </Row>
        <Text style={styles.tagline}>{mode.tagline}</Text>
        <Text style={styles.rules} numberOfLines={2}>
          {mode.rules}
        </Text>
        {meta.length > 0 && (
          <Row gap={space.sm} style={styles.metaRow}>
            {meta.map((m) => (
              <View key={m} style={styles.metaChip}>
                <Text style={styles.metaText}>{m.toUpperCase()}</Text>
              </View>
            ))}
          </Row>
        )}
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
    borderColor: color.accent,
    backgroundColor: color.surfaceRaised,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  emojiBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    backgroundColor: color.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 26,
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
    backgroundColor: color.accent,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  selectedTagText: {
    ...type.micro,
    color: color.onAccent,
  },
  tagline: {
    ...type.bodyMedium,
    color: color.accent,
    marginTop: 2,
  },
  rules: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  metaRow: {
    marginTop: space.sm,
  },
  metaChip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.md,
    paddingVertical: 4,
    minHeight: 0,
  },
  metaText: {
    ...type.micro,
    color: color.textFaint,
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
