/**
 * ModeComplete — the celebratory sheet shown when a game mode finishes.
 *
 * Fades up a deep scrim with a glass card: the mode's Ionicons mark on its
 * accent plate, the result headline in scoreboard numerals under a Skia
 * arc-and-sparks flourish tinted in the mode's hue (the signature shot arc —
 * no confetti), a per-mode stat line row, an optional per-spot breakdown, and
 * a clear action hierarchy — bold Play again on top, Share result / Done as
 * ghosts. Everything enters as one staggered celebratory beat; all animations
 * respect the system reduce-motion setting.
 *
 * Presentation only; the live screen owns when to mount it and what the buttons
 * do (replay re-inits the mode, exit runs the normal end-session flow).
 */
import { BlurMask, Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  ZoomIn,
  useReducedMotion,
} from 'react-native-reanimated';

import { modeCardData, shareCardImage } from '../ShareCard';
import { Card, PillButton, Row } from '../ui';
import { color, motion, space, type } from '../../constants/tokens';
import { drillOf } from '../../core/drills';
import { getModeDef, type ModeState } from '../../core/gameModes';
import { useSession } from '../../state/sessionStore';
import { MODE_IDENTITY } from './modeIdentity';

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
  // A structured drill rides inside spotShooting — give it its own headline
  // instead of the generic "across five spots" copy (drills vary in spot count).
  const drill = drillOf(mode);
  if (drill != null) {
    const makes = mode.spots?.reduce((a, s) => a + s.makes, 0) ?? mode.score;
    const attempts = mode.spots?.reduce((a, s) => a + s.attempts, 0) ?? 0;
    const cleared = mode.spots?.every(
      (s, i) => s.makes >= (mode.config?.drill?.goals[i] ?? 1),
    ) ?? false;
    return {
      banner: cleared ? 'DRILL DONE' : 'DRILL',
      value: `${makes}`,
      unit: makes === 1 ? 'make' : 'makes',
      sub: cleared
        ? `${drill.title} — every spot cleared${attempts > 0 ? ` on ${attempts} shots.` : '.'}`
        : `${drill.title} — ${makes}/${attempts} before you ran out of shots.`,
      share: `🎯 ${drill.title}: ${makes}/${attempts} on Hoopilot.`,
    };
  }
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
    case 'ghost': {
      const you = mode.ghost?.yourMakes ?? mode.score;
      const ghostFinal = mode.ghost?.finalGhostMakes ?? 0;
      const margin = mode.ghost?.finalMargin ?? you - ghostFinal;
      const result =
        mode.ghost?.result ?? (margin > 0 ? 'win' : margin < 0 ? 'loss' : 'tie');
      return {
        banner: result === 'win' ? 'GHOST DOWN' : result === 'loss' ? 'GHOST WINS' : 'DEAD HEAT',
        value: `${you}`,
        unit: you === 1 ? 'make' : 'makes',
        sub:
          result === 'win'
            ? `You outran your past self ${you}–${ghostFinal}.`
            : result === 'loss'
              ? `Your past self held you off ${ghostFinal}–${you}.`
              : `Level with your past self at ${you} apiece.`,
        share: `👻 Ghost Challenge: ${
          result === 'win' ? 'beat' : result === 'loss' ? 'lost to' : 'tied'
        } my past self ${you}–${ghostFinal} on Hoopilot.`,
      };
    }
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
 * Per-mode stat lines under the hero — small scoreboard cells that tell the
 * rest of the story (clock, pace, accuracy…). Empty when the hero numeral
 * already says everything (HORSE, streak, free play).
 */
function statLinesFor(mode: ModeState): { label: string; value: string }[] {
  switch (mode.modeId) {
    case 'timed': {
      const dur = mode.config?.durationSec ?? 60;
      const perMin = dur > 0 ? (mode.score * 60) / dur : mode.score;
      return [
        { label: 'Clock', value: `${dur}s` },
        { label: 'Pace', value: `${perMin.toFixed(1)}/min` },
      ];
    }
    case 'aroundTheWorld':
    case 'spotShooting': {
      const makes = mode.spots?.reduce((a, s) => a + s.makes, 0) ?? mode.score;
      const attempts = mode.spots?.reduce((a, s) => a + s.attempts, 0) ?? 0;
      return [
        { label: 'Shots', value: `${attempts}` },
        {
          label: 'Accuracy',
          value: attempts > 0 ? `${Math.round((makes / attempts) * 100)}%` : '—',
        },
      ];
    }
    case 'threePoint':
      return [
        { label: 'Possible', value: '30' },
        { label: 'Racks', value: '5' },
      ];
    case 'ghost': {
      const ghostFinal = mode.ghost?.finalGhostMakes ?? 0;
      const margin =
        mode.ghost?.finalMargin ?? (mode.ghost?.yourMakes ?? mode.score) - ghostFinal;
      const clock = mode.config?.ghost?.durationSec;
      return [
        { label: 'Ghost', value: `${ghostFinal}` },
        { label: 'Margin', value: margin > 0 ? `+${margin}` : `${margin}` },
        ...(clock != null ? [{ label: 'Clock', value: `${Math.round(clock)}s` }] : []),
      ];
    }
    case 'ftStreak':
    case 'horse':
    case 'free':
    default:
      return [];
  }
}

/**
 * Arc flourish — the signature shot arc landing at a glowing ball, with a few
 * spark ticks radiating from the landing point, inked in the mode's accent.
 * Static (reduced-motion safe); the celebration energy comes from the springy
 * numeral beneath it.
 */
function ArcFlourish({ accent }: { accent: string }) {
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
            color={accent}
            opacity={0.25}
          >
            <BlurMask blur={8} style="normal" />
          </Path>
          <Path
            path={geom.arc}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            color={accent}
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
          <Circle cx={geom.landX} cy={geom.landY} r={9} color={accent} opacity={0.35}>
            <BlurMask blur={6} style="normal" />
          </Circle>
          <Circle cx={geom.landX} cy={geom.landY} r={4.5} color={accent} />
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
  const drill = drillOf(mode);
  // A drill hosts on spotShooting; show the DRILL's name/glyph so the sheet
  // reads as the drill the player picked, not the host mode.
  const displayName = drill?.title ?? def.name;
  const id = MODE_IDENTITY[mode.modeId];
  const h = headlineFor(mode);
  const statRows = statLinesFor(mode);
  const reducedMotion = useReducedMotion();
  /** Stagger delays collapse under reduced motion so nothing appears to lag. */
  const d = (ms: number) => (reducedMotion ? 0 : ms);

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
      modeName: displayName,
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
          <ArcFlourish accent={id.accent} />

          <View style={[styles.iconBadge, { backgroundColor: id.tint, borderColor: id.accent }]}>
            <Ionicons name={id.icon} size={26} color={id.accent} />
          </View>
          <Text style={styles.modeName}>{displayName.toUpperCase()}</Text>
          <Text style={[styles.banner, { color: id.accent }]}>{h.banner}</Text>

          <Animated.View
            entering={ZoomIn.delay(d(120))
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

          {statRows.length > 0 && (
            <Animated.View
              entering={FadeInDown.delay(d(220))
                .duration(motion.standard)
                .reduceMotion(ReduceMotion.System)}
              style={styles.statRow}
            >
              {statRows.map((r, i) => (
                <React.Fragment key={r.label}>
                  {i > 0 && <View style={styles.statDivider} />}
                  <View style={styles.statCell}>
                    <Text style={styles.statValue}>{r.value}</Text>
                    <Text style={styles.statLabel}>{r.label.toUpperCase()}</Text>
                  </View>
                </React.Fragment>
              ))}
            </Animated.View>
          )}

          {mode.spots != null && mode.spots.length > 0 && (
            <Animated.View
              entering={FadeInDown.delay(d(280))
                .duration(motion.standard)
                .reduceMotion(ReduceMotion.System)}
              style={styles.breakdown}
            >
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
            </Animated.View>
          )}

          <Animated.View
            entering={FadeInDown.delay(d(340))
              .duration(motion.standard)
              .reduceMotion(ReduceMotion.System)}
            style={styles.actions}
          >
            <PillButton label="Play again" icon="refresh" onPress={onReplay} />
            <Row gap={space.md} style={styles.secondaryRow}>
              <PillButton
                label={sharing ? 'Preparing…' : 'Share result'}
                icon="share-outline"
                variant="ghost"
                onPress={onShare}
                disabled={sharing}
                style={styles.secondaryBtn}
              />
              <PillButton
                label="Done"
                variant="ghost"
                onPress={onExit}
                style={styles.secondaryBtn}
              />
            </Row>
          </Animated.View>
        </Card>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...absoluteFill,
    backgroundColor: color.hudGlassDeep,
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
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  modeName: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  banner: {
    ...type.caption,
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
  statRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: space.lg,
    marginTop: space.lg,
  },
  statCell: {
    alignItems: 'center',
    minWidth: 72,
  },
  statValue: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: color.border,
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
