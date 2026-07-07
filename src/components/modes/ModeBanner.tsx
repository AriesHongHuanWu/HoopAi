/**
 * ModeBanner — the in-mode HUD overlay for the live session.
 *
 * A single tight glass panel, top-center over the camera: the mode's Ionicons
 * mark on an accent-tinted plate, name, a big score/streak numeral labelled per
 * mode, and the mode's own progress widget (spot rail, timer ring, HORSE board,
 * contest racks, or a plain progress bar). The glass recipe (deep rgba fill +
 * hairline border + top highlight) is deliberately the same treatment as
 * HudChip so the banner sits flush with the rest of the HUD, tightened here
 * with a per-mode accent rail on the left edge. Reads {@link ModeState}
 * directly and renders nothing for the free-play mode (its score already shows
 * in the shared StatStrip).
 *
 * Pure presentation — the live screen wires modeStore.applyShot / tick.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';

import { color, motion, radius, space, type } from '../../constants/tokens';
import { getModeDef, type ModeState } from '../../core/gameModes';
import { ContestRacks } from './ContestRacks';
import { HorseLetters } from './HorseLetters';
import { MODE_IDENTITY } from './modeIdentity';
import { SpotTracker } from './SpotTracker';
import { TimerRing } from './TimerRing';

/** Score-pill label per mode; score means different things (see gameModes). */
function scoreLabel(mode: ModeState): string {
  switch (mode.modeId) {
    case 'timed':
    case 'spotShooting':
    case 'aroundTheWorld':
    case 'ghost':
      return 'Makes';
    case 'ftStreak':
      return 'Streak';
    case 'horse':
      return 'Letters';
    case 'threePoint':
    case 'free':
    default:
      return 'Points';
  }
}

/** Composed a11y string for the whole banner, mirroring StatStrip's `a11y`. */
function bannerA11yLabel(mode: ModeState, def: ReturnType<typeof getModeDef>): string {
  const scoreValue =
    mode.modeId === 'horse' ? (mode.letters?.length ?? 0) : mode.score;
  const parts = [`${def.name}.`, `${scoreLabel(mode)}: ${scoreValue}.`];
  if (mode.modeId === 'timed') {
    parts.push(`${Math.max(0, Math.round(mode.timeLeftSec ?? 0))} seconds left.`);
  }
  if (mode.modeId === 'horse' && mode.letters) {
    parts.push(`Letters: ${mode.letters.split('').join(' ')}.`);
  }
  if (mode.modeId === 'ghost' && mode.ghost != null) {
    // Spoken race status replaces the visual "YOU 7 · GHOST 6 · +1" line.
    parts.push(`Ghost: ${mode.ghost.ghostMakesNow}.`);
    parts.push(
      mode.ghost.lead > 0
        ? `Ahead by ${mode.ghost.lead}.`
        : mode.ghost.lead < 0
          ? `Behind by ${-mode.ghost.lead}.`
          : 'Tied.',
    );
    return parts.join(' ');
  }
  if (mode.message) parts.push(mode.message);
  return parts.join(' ');
}

export function ModeBanner({ mode }: { mode: ModeState }) {
  const def = getModeDef(mode.modeId);

  // Free play has no game structure worth a banner — the shared StatStrip
  // already carries makes / FG% / streak.
  if (mode.modeId === 'free') return null;

  const id = MODE_IDENTITY[mode.modeId];
  const showBar =
    !def.needsTimer && !def.needsSpots && mode.modeId !== 'horse' && mode.modeId !== 'threePoint';

  return (
    <Animated.View
      entering={FadeInDown.duration(motion.standard).reduceMotion(ReduceMotion.System)}
      style={styles.glass}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={bannerA11yLabel(mode, def)}
    >
      {/* top highlight — the single hairline that sells the glass (HudChip recipe) */}
      <View pointerEvents="none" style={styles.highlight} />
      {/* per-mode accent rail on the left edge — the banner's identity stripe */}
      <View pointerEvents="none" style={[styles.rail, { backgroundColor: id.accent }]} />

      {/* Header: mode mark + name + score numeral (or timer ring) */}
      <View style={styles.header}>
        <View style={styles.title}>
          <View style={[styles.iconPlate, { backgroundColor: id.tint }]}>
            <Ionicons name={id.icon} size={13} color={id.accent} />
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {def.name.toUpperCase()}
          </Text>
        </View>
        {mode.modeId === 'timed' ? (
          <TimerRing timeLeftSec={mode.timeLeftSec ?? 0} progress={mode.progress} />
        ) : (
          <View style={styles.scoreBox}>
            <Text style={styles.score}>
              {mode.modeId === 'horse' ? (mode.letters?.length ?? 0) : mode.score}
            </Text>
            <Text style={[styles.scoreLabel, { color: id.accent }]}>
              {scoreLabel(mode).toUpperCase()}
            </Text>
          </View>
        )}
      </View>

      {/* Mode-specific progress widget */}
      {def.needsSpots && mode.spots != null && (
        <View style={styles.widget}>
          <SpotTracker
            spots={mode.spots}
            currentSpot={mode.currentSpot ?? 0}
            makesPerSpot={mode.config?.makesPerSpot}
            done={mode.done}
          />
        </View>
      )}

      {mode.modeId === 'horse' && (
        <View style={styles.widget}>
          <HorseLetters letters={mode.letters ?? ''} called={mode.currentSpot === 1} />
        </View>
      )}

      {mode.modeId === 'threePoint' && (
        <View style={styles.widget}>
          <ContestRacks progress={mode.progress} done={mode.done} />
        </View>
      )}

      {showBar && (
        <View style={styles.bar}>
          <View
            style={[
              styles.barFill,
              { width: `${Math.round(mode.progress * 100)}%`, backgroundColor: id.accent },
            ]}
          />
        </View>
      )}

      {/* Status line — messageTone tints it when the mode sets one (ghost lead:
          ahead = make green, behind = miss red, tied = neutral). */}
      <Text
        style={[
          styles.message,
          mode.messageTone === 'positive' && { color: color.make },
          mode.messageTone === 'negative' && { color: color.miss },
        ]}
        numberOfLines={1}
      >
        {mode.message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  glass: {
    alignSelf: 'stretch',
    alignItems: 'stretch',
    // Same glass recipe as HudChip (deep fill + hairline border + highlight),
    // tightened: less vertical padding so the court stays the star.
    backgroundColor: color.hudGlassDeep,
    borderColor: color.hudGlassBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: 'hidden',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(245, 241, 236, 0.22)',
  },
  rail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 3,
    opacity: 0.9,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  title: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  iconPlate: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    ...type.caption,
    color: color.text,
    flexShrink: 1,
  },
  scoreBox: {
    alignItems: 'center',
    minWidth: 56,
  },
  score: {
    ...type.statLarge,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  scoreLabel: {
    ...type.micro,
    marginTop: -2,
  },
  widget: {
    marginTop: space.xs,
    alignItems: 'center',
  },
  bar: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.hudGlassBorder,
    overflow: 'hidden',
    marginTop: space.xs,
  },
  barFill: {
    height: '100%',
    borderRadius: radius.pill,
  },
  message: {
    ...type.bodyMedium,
    color: color.textDim,
    textAlign: 'center',
  },
});
