/**
 * ModeComplete — the celebratory sheet shown when a game mode finishes.
 *
 * Fades up a scrim with a glass card: the mode's headline result, the hero
 * numeral (points / makes / letters / streak), an optional per-spot or contest
 * breakdown, and three actions — share the result (native share sheet), play
 * the mode again, or exit to the session summary.
 *
 * Presentation only; the live screen owns when to mount it and what the buttons
 * do (replay re-inits the mode, exit runs the normal end-session flow).
 */
import React from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { Card, PillButton, Row } from '../ui';
import { color, motion, space, type } from '../../constants/tokens';
import { getModeDef, type ModeState } from '../../core/gameModes';

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

interface Headline {
  /** Big word above the numeral, e.g. "COMPLETE" / "TIME" / "OUT". */
  banner: string;
  /** The hero numeral. */
  value: string;
  /** Small label under the numeral. */
  unit: string;
  /** One-line congratulatory / result subline. */
  sub: string;
  /** Ready-to-share caption. */
  share: string;
}

function headlineFor(mode: ModeState): Headline {
  const def = getModeDef(mode.modeId);
  switch (mode.modeId) {
    case 'timed':
      return {
        banner: 'TIME',
        value: `${mode.score}`,
        unit: mode.score === 1 ? 'make' : 'makes',
        sub: `${mode.config?.durationSec ?? 60}s on the clock.`,
        share: `⏱️ Timed Challenge: ${mode.score} makes in ${mode.config?.durationSec ?? 60}s on HoopAI.`,
      };
    case 'aroundTheWorld':
      return {
        banner: 'COMPLETE',
        value: `${mode.spots?.length ?? 5}`,
        unit: 'spots',
        sub: 'Corner to corner — you cleared them all.',
        share: '🌍 Around the World — all five spots on HoopAI.',
      };
    case 'spotShooting': {
      const makes = mode.spots?.reduce((a, s) => a + s.makes, 0) ?? mode.score;
      const attempts = mode.spots?.reduce((a, s) => a + s.attempts, 0) ?? 0;
      return {
        banner: 'COMPLETE',
        value: `${makes}`,
        unit: 'makes',
        sub: attempts > 0 ? `${makes}/${attempts} across five spots.` : 'Every spot cleared.',
        share: `🎯 Spot Shooting: ${makes}/${attempts} on HoopAI.`,
      };
    }
    case 'threePoint':
      return {
        banner: 'FINAL',
        value: `${mode.score}`,
        unit: 'points',
        sub: '25 balls, money on the fifth. 30 possible.',
        share: `💰 3-Point Contest: ${mode.score} points on HoopAI.`,
      };
    case 'ftStreak':
      return {
        banner: 'BEST RUN',
        value: `${mode.bestStreak ?? mode.score}`,
        unit: 'in a row',
        sub: 'Free throws, back to back.',
        share: `🔥 ${mode.bestStreak ?? mode.score} free throws in a row on HoopAI.`,
      };
    case 'horse':
      return {
        banner: "YOU'RE OUT",
        value: mode.letters ?? 'HORSE',
        unit: '',
        sub: 'Spelled the whole word. Run it back?',
        share: '🐴 Played myself in H-O-R-S-E on HoopAI.',
      };
    case 'free':
    default:
      return {
        banner: 'DONE',
        value: `${mode.score}`,
        unit: 'points',
        sub: 'Nice session.',
        share: `🏀 ${mode.score} points on HoopAI.`,
      };
  }
}

export function ModeComplete({
  mode,
  onReplay,
  onExit,
}: {
  mode: ModeState;
  /** Restart the same mode with a fresh state. */
  onReplay: () => void;
  /** Leave the mode and end the session (to the summary). */
  onExit: () => void;
}) {
  const def = getModeDef(mode.modeId);
  const h = headlineFor(mode);

  const onShare = () => {
    void Share.share({ message: h.share }).catch(() => {
      // User dismissed the sheet or share failed — nothing to recover.
    });
  };

  return (
    <Animated.View
      entering={FadeIn.duration(motion.standard)}
      style={styles.scrim}
      accessibilityViewIsModal
    >
      <Animated.View entering={FadeInDown.duration(motion.celebrate).springify()}>
        <Card style={styles.card}>
          <Text style={styles.emoji}>{def.emoji}</Text>
          <Text style={styles.banner}>{h.banner}</Text>

          <View style={styles.heroRow}>
            <Text style={styles.hero} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
              {h.value}
            </Text>
          </View>
          {h.unit !== '' && <Text style={styles.unit}>{h.unit.toUpperCase()}</Text>}

          <Text style={styles.sub}>{h.sub}</Text>

          {mode.spots != null && mode.spots.length > 0 && (
            <View style={styles.breakdown}>
              {mode.spots.map((s) => (
                <Row key={s.label} style={styles.breakRow}>
                  <Text style={styles.breakLabel} numberOfLines={1}>
                    {s.label}
                  </Text>
                  <Text style={styles.breakVal}>
                    {s.attempts > 0 ? `${s.makes}/${s.attempts}` : '—'}
                  </Text>
                </Row>
              ))}
            </View>
          )}

          <View style={styles.actions}>
            <PillButton label="Share result" onPress={onShare} />
            <Row gap={space.md} style={styles.secondaryRow}>
              <PillButton
                label="Play again"
                variant="ghost"
                onPress={onReplay}
                style={styles.secondaryBtn}
              />
              <PillButton
                label="End session"
                variant="ghost"
                onPress={onExit}
                style={styles.secondaryBtn}
              />
            </Row>
          </View>
        </Card>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...absoluteFill,
    backgroundColor: color.hudGlass,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingVertical: space.xl,
  },
  emoji: {
    fontSize: 40,
    marginBottom: space.xs,
  },
  banner: {
    ...type.caption,
    color: color.accent,
    letterSpacing: 2,
  },
  heroRow: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  hero: {
    ...type.scoreboard,
    color: color.text,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  unit: {
    ...type.caption,
    color: color.textFaint,
    marginTop: -4,
  },
  sub: {
    ...type.body,
    color: color.textDim,
    textAlign: 'center',
    marginTop: space.md,
  },
  breakdown: {
    alignSelf: 'stretch',
    marginTop: space.lg,
    gap: space.xs,
  },
  breakRow: {
    justifyContent: 'space-between',
  },
  breakLabel: {
    ...type.body,
    color: color.textDim,
    flex: 1,
  },
  breakVal: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  actions: {
    alignSelf: 'stretch',
    marginTop: space.xl,
    gap: space.md,
  },
  secondaryRow: {
    alignSelf: 'stretch',
  },
  secondaryBtn: {
    flex: 1,
  },
});
