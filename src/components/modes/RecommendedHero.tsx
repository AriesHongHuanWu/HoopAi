/**
 * RecommendedHero — the larger QUICK START card for the recommended mode/drill.
 *
 * Bigger identity badge (52px — same recipe as the old ModeCard cartridge),
 * accent tagline, an honesty/reason line and a bold START pill. Tapping arms
 * the recommended target and routes to setup (the caller owns that sequence).
 * The card OUTRANKS the shelf below it: its resting border is the identity's
 * 45% `edge` (never the neutral hairline), the identity tint washes the badge
 * column, and one static arcMotif stroke sweeps from the badge toward the
 * START pill — a single JS-built Skia path, drawn once, no animation and no
 * worklet (the fx/particles crash precedent).
 *
 * Iron rule 8 (honesty): `reason` is rendered VERBATIM from
 * recommendationReason() — this component never invents copy. The only text it
 * appends is the fixed provenance suffix "from your session history", which
 * states exactly where the count came from (real db rows, not a fabricated
 * stat). The 'starter' variant (a new player with no history to recommend
 * from) therefore carries NO reason row at all — omitting the line is the only
 * honest option when there is no history to cite; the union type makes passing
 * one impossible.
 *
 * Fully prop-driven: no store reads, no self-animation (entrance is owned by
 * the parent's Animated.View wrapper; the only motion is the pressed-state
 * style).
 */
import { Ionicons } from '@expo/vector-icons';
import { Canvas, Path } from '@shopify/react-native-skia';
import React, { useState, type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

// Concrete import (the ScreenHeader precedent): screen suites stub the motion
// barrel down to the hooks under test, and arcMotif is pure geometry.
import { arcMotif } from '@/components/motion/ArcReveal';
import { color, iconSize, radius, space, type } from '@/constants/tokens';

/** Identity-accent alpha for the decorative arc stroke. */
const ARC_OPACITY = 0.18;
const ARC_STROKE_WIDTH = 3;
/** Width of the tint wash behind the badge column: padding + 52px badge + gap. */
const BADGE_WASH_WIDTH = space.lg + 52 + space.lg / 2;

interface RecommendedHeroBaseProps {
  /** The recommended mode/drill's Ionicons mark. */
  icon: ComponentProps<typeof Ionicons>['name'];
  name: string;
  tagline: string;
  /** Identity accent (token-derived). */
  accent: string;
  /** Identity 14% tint wash for the badge fill and the badge-column wash. */
  tint: string;
  /** Identity 45% hairline (ModeIdentity.edge) — the RESTING border. */
  edge: string;
  /** Hero target is the currently armed mode. */
  selected: boolean;
  onPress: () => void;
}

export type RecommendedHeroProps = RecommendedHeroBaseProps &
  (
    | {
        /** Default: a real recommendation derived from session history. */
        variant?: 'recommended';
        /** Exact recommendationReason() output, e.g. 'Played 3× in the last 2 weeks'. */
        reason: string;
      }
    | {
        /**
         * New player, no history to recommend from — Free Play promoted into
         * the hero. NO reason accepted: there is no history to cite, and
         * fabricating one would break the honesty contract.
         */
        variant: 'starter';
        reason?: undefined;
      }
  );

export function RecommendedHero(props: RecommendedHeroProps): React.JSX.Element {
  const { icon, name, tagline, accent, tint, edge, selected, onPress } = props;
  const starter = props.variant === 'starter';
  // Measured card size for the decorative arc — the Skia canvas needs plain
  // numbers, and the card's width is layout-driven.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  return (
    <Pressable
      onPress={onPress}
      onLayout={(e: LayoutChangeEvent) =>
        setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
      accessibilityRole="button"
      accessibilityLabel={
        starter ? `Start here: ${name}. ${tagline}` : `Recommended: ${name}. ${tagline}`
      }
      accessibilityHint={
        starter
          ? 'Starts setup with this mode armed.'
          : `${props.reason}. Starts setup with this mode armed.`
      }
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.card,
        { borderColor: edge },
        selected && [styles.cardSelected, { borderColor: accent }],
        pressed && styles.cardPressed,
      ]}
    >
      {/* Identity tint wash behind the badge column — decorative only. */}
      <View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no"
        style={[styles.badgeWash, { backgroundColor: tint }]}
      />

      {/* ONE static shot-arc stroke, badge → START pill. arcMotif geometry,
          plain Skia path, drawn once — NO animation, NO worklet. */}
      {size != null && size.w > 0 && size.h > 0 && (
        <Canvas
          pointerEvents="none"
          accessible={false}
          importantForAccessibility="no"
          style={[styles.arcCanvas, { width: size.w, height: size.h }]}
        >
          <Path
            path={arcMotif(size.w, size.h).path}
            style="stroke"
            strokeWidth={ARC_STROKE_WIDTH}
            color={accent}
            opacity={ARC_OPACITY}
          />
        </Canvas>
      )}

      {/* The identity mark — glyph on its accent-tinted badge. */}
      <View style={[styles.iconBadge, { borderColor: accent, backgroundColor: tint }]}>
        <Ionicons name={icon} size={iconSize.xl} color={accent} />
      </View>

      <View style={styles.body}>
        <View style={styles.eyebrowRow}>
          <Text style={styles.eyebrow}>
            {starter ? 'START HERE' : 'RECOMMENDED FOR YOU'}
          </Text>
          {selected && (
            <View style={[styles.pickedTag, { backgroundColor: accent }]}>
              <Text style={styles.pickedText}>✓ PICKED</Text>
            </View>
          )}
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.tagline, { color: accent }]} numberOfLines={1}>
          {tagline}
        </Text>

        {/* Honesty line: exact db-derived count, labeled with its source.
            The starter variant omits the ROW, never invents a reason. */}
        {!starter && (
          <View style={styles.reasonRow}>
            <Ionicons name="time-outline" size={iconSize.xs} color={color.textFaint} />
            <Text style={styles.reasonText}>{`${props.reason} · from your session history`}</Text>
          </View>
        )}

        <View style={styles.footRow}>
          <View style={[styles.startPill, { backgroundColor: accent }]}>
            <Ionicons name="play" size={11} color={color.onAccent} />
            <Text style={styles.startText}>START</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: space.lg,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    // Resting border color is the identity edge, set inline per instance.
    padding: space.lg,
    // Clips the badge wash and the arc to the rounded card.
    overflow: 'hidden',
  },
  cardSelected: {
    borderWidth: 1.5,
    backgroundColor: color.surfaceRaised,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
    transform: [{ scale: 0.985 }],
  },
  // RN 0.86 dropped StyleSheet.absoluteFillObject — explicit edges only.
  badgeWash: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: BADGE_WASH_WIDTH,
  },
  arcCanvas: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  eyebrow: {
    ...type.eyebrow,
    color: color.textFaint,
  },
  pickedTag: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  pickedText: {
    ...type.micro,
    color: color.onAccent,
  },
  name: {
    ...type.heading,
    color: color.text,
    marginTop: space.xs,
  },
  tagline: {
    ...type.bodyMedium,
    marginTop: 2,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
  },
  reasonText: {
    ...type.caption,
    color: color.textFaint,
    flexShrink: 1,
  },
  footRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: space.md,
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
});
