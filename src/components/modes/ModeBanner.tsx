/**
 * ModeBanner — the in-mode HUD overlay for the live session.
 *
 * A single glassy chip stack, top-center over the camera: the mode's status
 * {message}, a big score/streak numeral labelled per mode, and the mode's own
 * progress widget (spot rail, timer ring, HORSE board, contest racks, or a
 * plain progress bar). Reads {@link ModeState} directly and renders nothing for
 * the free-play mode (its score already shows in the shared StatStrip).
 *
 * Pure presentation — the live screen wires modeStore.applyShot / tick.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { HudChip } from '../hud/HudChip';
import { color, radius, space, type } from '../../constants/tokens';
import { getModeDef, type ModeState } from '../../core/gameModes';
import { ContestRacks } from './ContestRacks';
import { HorseLetters } from './HorseLetters';
import { SpotTracker } from './SpotTracker';
import { TimerRing } from './TimerRing';

/** Score-pill label per mode; score means different things (see gameModes). */
function scoreLabel(mode: ModeState): string {
  switch (mode.modeId) {
    case 'timed':
    case 'spotShooting':
    case 'aroundTheWorld':
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

export function ModeBanner({ mode }: { mode: ModeState }) {
  const def = getModeDef(mode.modeId);

  // Free play has no game structure worth a banner — the shared StatStrip
  // already carries makes / FG% / streak.
  if (mode.modeId === 'free') return null;

  const showBar =
    !def.needsTimer && !def.needsSpots && mode.modeId !== 'horse' && mode.modeId !== 'threePoint';

  return (
    <HudChip style={styles.chip}>
      {/* Header: emoji + mode name + score numeral */}
      <View style={styles.header}>
        <View style={styles.title}>
          <Text style={styles.emoji}>{def.emoji}</Text>
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
            <Text style={styles.scoreLabel}>{scoreLabel(mode).toUpperCase()}</Text>
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
          <View style={[styles.barFill, { width: `${Math.round(mode.progress * 100)}%` }]} />
        </View>
      )}

      {/* Status line */}
      <Text style={styles.message} numberOfLines={1}>
        {mode.message}
      </Text>
    </HudChip>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'stretch',
    alignItems: 'stretch',
    paddingVertical: space.md,
    gap: space.sm,
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
  emoji: {
    fontSize: 20,
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
    color: color.textFaint,
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
    backgroundColor: color.accent,
  },
  message: {
    ...type.bodyMedium,
    color: color.textDim,
    textAlign: 'center',
  },
});
