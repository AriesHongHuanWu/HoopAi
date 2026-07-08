/**
 * FormatPicker — a compact bottom sheet to choose a share layout (Story /
 * Poster / Feed / Grid) before rendering. Each option shows a live mini Skia
 * preview of the actual card, so the choice is WYSIWYG.
 *
 * The default single-tap path never sees this — callers only open it when the
 * user explicitly wants to pick. Tapping a card fires onPick(format); the sheet
 * closes itself. Never blocks: "Skip" shares the default story format.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, PillButton, Row } from '../ui';
import { color, radius, space, type } from '../../constants/tokens';
import { ShareCard, type CardFormat, type ShareCardData } from '../ShareCard';

interface FormatOption {
  format: CardFormat;
  label: string;
  blurb: string;
}

const OPTIONS: readonly FormatOption[] = [
  { format: 'story', label: 'Story', blurb: '9:16 · IG & TikTok' },
  { format: 'poster', label: 'Poster', blurb: 'Giant stat · arc' },
  { format: 'feed', label: 'Feed', blurb: '4:5 · classic' },
  { format: 'grid', label: 'Stat grid', blurb: '2×2 broadcast' },
];

/** Preview width per mini card — small enough that four fit a phone width. */
const PREVIEW_W = 128;

export function FormatPicker({
  data,
  initial = 'story',
  onPick,
  onCancel,
}: {
  data: ShareCardData;
  initial?: CardFormat;
  onPick: (format: CardFormat) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<CardFormat>(initial);

  return (
    <View style={styles.scrim} accessibilityViewIsModal>
      <Card style={styles.card}>
        <Text style={styles.title}>Choose a look</Text>
        <Text style={styles.sub}>Every format is branded — pick the one that fits.</Text>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}
        >
          {OPTIONS.map((opt) => {
            const active = opt.format === selected;
            return (
              <Pressable
                key={opt.format}
                onPress={() => setSelected(opt.format)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${opt.label} format`}
                style={[styles.option, active && styles.optionActive]}
              >
                <View style={styles.previewWrap}>
                  <ShareCard data={data} width={PREVIEW_W} format={opt.format} />
                </View>
                <Text style={[styles.optLabel, active && styles.optLabelActive]}>{opt.label}</Text>
                <Text style={styles.optBlurb}>{opt.blurb}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Row gap={space.md} style={styles.actions}>
          <PillButton label="Cancel" variant="ghost" onPress={onCancel} style={styles.btn} />
          <PillButton label="Share this" onPress={() => onPick(selected)} style={styles.btn} />
        </Row>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.hudGlass,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  card: {
    width: '100%',
    maxWidth: 560,
  },
  title: {
    ...type.heading,
    color: color.text,
  },
  sub: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.lg,
  },
  strip: {
    gap: space.md,
    paddingVertical: space.xs,
    paddingRight: space.md,
  },
  option: {
    width: PREVIEW_W + space.md * 2,
    alignItems: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionActive: {
    borderColor: color.accent,
    backgroundColor: color.surfaceRaised,
  },
  previewWrap: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  optLabel: {
    ...type.caption,
    color: color.textDim,
    marginTop: space.md,
    textTransform: 'uppercase',
  },
  optLabelActive: {
    color: color.text,
  },
  optBlurb: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
  actions: {
    marginTop: space.lg,
  },
  btn: {
    flex: 1,
  },
});
