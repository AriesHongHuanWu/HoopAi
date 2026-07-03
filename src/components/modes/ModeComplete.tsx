/**
 * ModeComplete — the celebratory sheet shown when a game mode finishes.
 *
 * Fades up a scrim with a glass card: the mode's headline result, a springy
 * hero numeral under a Skia arc-and-sparks flourish (the signature shot arc —
 * no confetti), an optional per-spot or contest breakdown, and three actions —
 * share the result (a rendered ShareCard image, text share as fallback), play
 * the mode again, or exit to the session summary. All entering animations respect the system reduce-motion
 * setting.
 *
 * Presentation only; the live screen owns when to mount it and what the buttons
 * do (replay re-inits the mode, exit runs the normal end-session flow).
 */
import { BlurMask, Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  ZoomIn,
} from 'react-native-reanimated';

import { modeCardData, shareCardImage } from '../ShareCard';
import { Card, PillButton, Row } from '../ui';
import { color, motion, space, type } from '../../constants/tokens';
import { getModeDef, type ModeState } from '../../core/gameModes';
import { useSession } from '../../state/sessionStore';

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

/** Height of the arc flourish above the numeral, px. */
const FLOURISH_H = 64;

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
        share: `⏱️ Timed Challenge: ${mode.score} makes in ${mode.config?.durationSec ?? 60}s on Hoopilot.`,
      };
    case 'aroundTheWorld':
      return {
        banner: 'COMPLETE',
        value: `${mode.spots?.length ?? 5}`,
        unit: 'spots',
        sub: 'Corner to corner — you cleared them all.',
        share: '🌍 Around the World — all five spots on Hoopilot.',
      };
    case 'spotShooting': {
      const makes = mode.spots?.reduce((a, s) => a + s.makes, 0) ?? mode.score;
      const attempts = mode.spots?.reduce((a, s) => a + s.attempts, 0) ?? 0;
      return {
        banner: 'COMPLETE',
        value: `${makes}`,
        unit: 'makes',
        sub: attempts > 0 ? `${makes}/${attempts} across five spots.` : 'Every spot cleared.',
        share: `🎯 Spot Shooting: ${makes}/${attempts} on Hoopilot.`,
      };
    }
    case 'threePoint':
      return {
        banner: 'FINAL',
        value: `${mode.score}`,
        unit: 'points',
        sub: '25 balls, money on the fifth. 30 possible.',
        share: `💰 3-Point Contest: ${mode.score} points on Hoopilot.`,
      };
    case 'ftStreak':
      return {
        banner: 'BEST RUN',
        value: `${mode.bestStreak ?? mode.score}`,
        unit: 'in a row',
        sub: 'Free throws, back to back.',
        share: `🔥 ${mode.bestStreak ?? mode.score} free throws in a row on Hoopilot.`,
      };
    case 'horse':
      return {
        banner: "YOU'RE OUT",
        value: mode.letters ?? 'HORSE',
        unit: '',
        sub: 'Spelled the whole word. Run it back?',
        share: '🐴 Played myself in H-O-R-S-E on Hoopilot.',
      };
    case 'free':
    default:
      return {
        banner: 'DONE',
        value: `${mode.score}`,
        unit: 'points',
        sub: 'Nice session.',
        share: `🏀 ${mode.score} points on Hoopilot.`,
      };
  }
}

/**
 * Arc flourish — the signature shot arc landing at a glowing ball, with a few
 * spark ticks radiating from the landing point. Static (reduced-motion safe);
 * the celebration energy comes from the springy numeral beneath it.
 */
function ArcFlourish() {
  const [width, setWidth] = useState(0);

  const geom = useMemo(() => {
    if (width <= 0) return null;
    const h = FLOURISH_H;
    const landX = width * 0.72;
    const landY = h - 14;
    const arc = Skia.Path.Make();
    arc.moveTo(width * 0.16, h - 8);
    arc.quadTo(width * 0.44, -6, landX, landY);
    // Spark ticks fanning out from the landing point.
    const sparks = Skia.Path.Make();
    for (const deg of [-78, -42, -8]) {
      const rad = (deg * Math.PI) / 180;
      const x1 = landX + Math.cos(rad) * 12;
      const y1 = landY + Math.sin(rad) * 12;
      const x2 = landX + Math.cos(rad) * 21;
      const y2 = landY + Math.sin(rad) * 21;
      sparks.moveTo(x1, y1);
      sparks.lineTo(x2, y2);
    }
    return { arc, sparks, landX, landY };
  }, [width]);

  return (
    <View
      pointerEvents="none"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={styles.flourish}
    >
      {geom != null && (
        <Canvas style={{ width, height: FLOURISH_H }}>
          <Path
            path={geom.arc}
            style="stroke"
            strokeWidth={7}
            strokeCap="round"
            color={color.accent}
            opacity={0.25}
          >
            <BlurMask blur={8} style="normal" />
          </Path>
          <Path
            path={geom.arc}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            color={color.accent}
            opacity={0.7}
          />
          <Path
            path={geom.sparks}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            color={color.threePt}
            opacity={0.9}
          />
          <Circle cx={geom.landX} cy={geom.landY} r={9} color={color.accent} opacity={0.35}>
            <BlurMask blur={6} style="normal" />
          </Circle>
          <Circle cx={geom.landX} cy={geom.landY} r={4.5} color={color.accent} />
        </Canvas>
      )}
    </View>
  );
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

  // Share the score-led image card (session stats/shots from the live store);
  // shareCardImage falls back to the plain-text caption itself and never
  // throws, so failure here just re-enables the button.
  const stats = useSession((s) => s.stats);
  const shotEntries = useSession((s) => s.shots);
  const [sharing, setSharing] = useState(false);
  const onShare = () => {
    if (sharing) return;
    setSharing(true);
    const data = modeCardData({
      modeName: def.name,
      value: h.value,
      unit: h.unit !== '' ? h.unit : h.banner,
      stats,
      shots: shotEntries.map((e) => e.shot),
    });
    void shareCardImage(data, h.share).then(() => setSharing(false));
  };

  return (
    <Animated.View
      entering={FadeIn.duration(motion.standard).reduceMotion(ReduceMotion.System)}
      style={styles.scrim}
      accessibilityViewIsModal
    >
      <Animated.View
        entering={FadeInDown.duration(motion.celebrate)
          .springify()
          .reduceMotion(ReduceMotion.System)}
      >
        <Card style={styles.card}>
          <ArcFlourish />
          <Text style={styles.emoji}>{def.emoji}</Text>
          <Text style={styles.banner}>{h.banner}</Text>

          <Animated.View
            entering={ZoomIn.delay(120)
              .duration(motion.celebrate)
              .springify()
              .damping(11)
              .reduceMotion(ReduceMotion.System)}
            style={styles.heroRow}
          >
            <Text style={styles.hero} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
              {h.value}
            </Text>
          </Animated.View>
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
            <PillButton
              label={sharing ? 'Preparing…' : 'Share result'}
              onPress={onShare}
              disabled={sharing}
            />
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
    overflow: 'hidden',
  },
  flourish: {
    ...absoluteFill,
    bottom: undefined,
    height: FLOURISH_H,
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
