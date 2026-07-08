/**
 * Open-source & data licenses (in-app). Generated from the credit registry
 * (src/core/legalCredits.ts): on-device models, training datasets, libraries,
 * fonts and algorithm references — each a name, a license chip and a tappable
 * link.
 *
 * The AGPL YOLO11 fallback is visually flagged and annotated: it is NOT the
 * default detector (Settings defaults to Apache-2.0 YOLOX) and its AGPL weights
 * are removed from the paid build. This screen is the "open-source license
 * list" required by the store legal baseline (docs/MASTER-PLAN.md B08).
 */
import { Ionicons } from '@expo/vector-icons';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { BackPill } from '@/components/ShotList';
import { Card, Eyebrow, Screen } from '@/components/ui';
import { color, font, radius, space, touch, type } from '@/constants/tokens';
import {
  CREDIT_SECTIONS,
  LICENSE_LABEL,
  NBA_REFERENCE_NAMES,
  type CreditRow,
} from '@/core/legalCredits';

/** One credit line: name + note on the left, license chip; whole row opens the
 *  link. Flagged (AGPL) rows get a warning accent + inline caveat. */
function CreditItem({ row }: { row: CreditRow }) {
  const flagged = row.flagged === true;
  return (
    <Pressable
      onPress={() => void Linking.openURL(row.link)}
      accessibilityRole="link"
      accessibilityLabel={`${row.name}, ${LICENSE_LABEL[row.license]}`}
      accessibilityHint="Opens the license or project page in your browser"
      style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
    >
      <View style={styles.itemText}>
        <Text style={styles.itemName}>{row.name}</Text>
        {row.note !== undefined && <Text style={styles.itemNote}>{row.note}</Text>}
        {flagged && (
          <View style={styles.flagRow}>
            <Ionicons name="alert-circle" size={13} color={color.unsure} />
            <Text style={styles.flagText}>
              Not the default engine. Removed from the paid build.
            </Text>
          </View>
        )}
      </View>
      <View style={[styles.chip, flagged && styles.chipFlagged]}>
        <Text style={[styles.chipText, flagged && styles.chipTextFlagged]}>{row.license}</Text>
      </View>
    </Pressable>
  );
}

export default function Licenses() {
  const reduceMotion = useReducedMotion();
  const enter = (i: number) =>
    reduceMotion ? undefined : FadeInDown.delay(i * 60).duration(360);

  return (
    <Screen scroll>
      <BackPill />
      <View style={styles.head}>
        <Eyebrow>Legal</Eyebrow>
        <Text style={styles.title}>Open-source & data</Text>
        <Text style={styles.lede}>
          Hoopilot stands on open models, datasets and libraries. Credits and
          licenses below — tap any row to open its source.
        </Text>
      </View>

      {CREDIT_SECTIONS.map((section, i) => (
        <Card key={section.title} entering={enter(i + 1)} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          <Text style={styles.sectionBlurb}>{section.blurb}</Text>
          <View style={styles.items}>
            {section.rows.map((row) => (
              <CreditItem key={row.name} row={row} />
            ))}
          </View>
        </Card>
      ))}

      {/* Content-rights note: pro player names are factual textual references. */}
      <Card entering={enter(CREDIT_SECTIONS.length + 1)} style={styles.section}>
        <Text style={styles.sectionTitle}>Player references</Text>
        <Text style={styles.sectionBlurb}>
          Shot Lab and Form Studio compare your shot to public, factual
          pro-shooting benchmarks (release angle, tempo and so on) attributed to
          well-known players such as {NBA_REFERENCE_NAMES.slice(0, 3).join(', ')} and
          others. These are <Text style={styles.inlineStrong}>textual references
          only</Text> — Hoopilot uses no team logos, no photographs, and no
          player likeness, and is not affiliated with, endorsed by, or sponsored
          by the NBA or any player.
        </Text>
      </Card>
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
  section: {
    marginBottom: space.md,
  },
  sectionTitle: {
    ...type.heading,
    color: color.text,
  },
  sectionBlurb: {
    ...type.caption,
    color: color.textDim,
    letterSpacing: 0,
    marginTop: 2,
    marginBottom: space.md,
  },
  inlineStrong: {
    ...type.caption,
    fontFamily: font.bodySemiBold,
    letterSpacing: 0,
    color: color.text,
  },
  items: {
    gap: space.xs,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touch.minTarget,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  itemPressed: {
    opacity: 0.6,
  },
  itemText: {
    flex: 1,
  },
  itemName: {
    ...type.bodyMedium,
    color: color.text,
  },
  itemNote: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 0,
    marginTop: 1,
  },
  flagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
  },
  flagText: {
    ...type.micro,
    color: color.unsure,
    letterSpacing: 0,
    flex: 1,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    backgroundColor: color.surfaceRaised,
  },
  chipFlagged: {
    backgroundColor: 'rgba(232,184,79,0.14)',
  },
  chipText: {
    ...type.micro,
    color: color.textDim,
  },
  chipTextFlagged: {
    color: color.unsure,
  },
});
