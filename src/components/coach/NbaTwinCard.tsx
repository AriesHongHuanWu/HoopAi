/**
 * NbaTwinCard — "Your NBA twin": the closest shooting archetype for the week
 * (matched on ball-flight metrics, so no pose needed) plus the coachable
 * universals worth stealing from that player's form. The identity hook the
 * user asked for ("who do I shoot like?") folded into the weekly report.
 *
 * Extracted 1:1 from coach.tsx (presentational only — the match comes from
 * matchArchetype over the week's shots, wired by the screen).
 */
import { Ionicons } from '@expo/vector-icons';
import React, { type ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type Animated from 'react-native-reanimated';

import { SectionEyebrow } from '@/components/ScreenHeader';
import { Card, Chip, Row } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { ArchetypeMatch } from '@/core/shotLab';

export function NbaTwinCard({
  match,
  entering,
}: {
  match: ArchetypeMatch;
  entering?: ComponentProps<typeof Animated.View>['entering'];
}) {
  const p = match.player;
  return (
    <Card entering={entering}>
      <SectionEyebrow icon="person-outline" style={styles.eyebrow}>
        Your NBA twin
      </SectionEyebrow>
      <Row style={styles.twinHead} gap={space.md}>
        <View style={styles.twinHeadText}>
          <Text
            style={styles.twinName}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {p.name}
          </Text>
          <Text style={styles.twinStyle}>{p.style}</Text>
        </View>
        <Chip label={`${match.similarity}% match`} tone="accent" />
      </Row>
      <Text style={styles.body}>{p.mechanics}</Text>
      <Text style={styles.twinCopyLabel}>STEAL THIS FROM THEIR FORM</Text>
      <View style={styles.twinCopyList}>
        {p.whatToCopy.slice(0, 2).map((c, i) => (
          <Row key={i} gap={space.sm} style={styles.twinCopyRow}>
            <Ionicons
              name="checkmark-circle"
              size={16}
              color={color.make}
              style={styles.twinCopyIcon}
            />
            <Text style={styles.twinCopy}>{c}</Text>
          </Row>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Shared SectionEyebrow leaves margins to the call site (screens own rhythm).
  eyebrow: {
    marginBottom: space.sm,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  twinHead: {
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: space.sm,
  },
  twinHeadText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  twinName: {
    ...type.heading,
    color: color.text,
  },
  twinStyle: {
    ...type.body,
    color: color.textDim,
  },
  twinCopyLabel: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1,
    marginTop: space.md,
    marginBottom: space.sm,
  },
  twinCopyList: {
    gap: space.sm,
  },
  twinCopyRow: {
    alignItems: 'flex-start',
  },
  twinCopyIcon: {
    marginTop: 1,
  },
  twinCopy: {
    ...type.body,
    color: color.text,
    flex: 1,
    minWidth: 0,
  },
});
