/**
 * HorseLetters — the H-O-R-S-E letter board.
 *
 * Renders all five letters; the ones the player has accrued light up red (a
 * taken letter is a bad thing), the rest sit faint. A small "called" dot shows
 * when a shot is in the air waiting to be matched. Reads {@link ModeState}
 * letters + currentSpot directly.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, space, type } from '../../constants/tokens';

const HORSE = ['H', 'O', 'R', 'S', 'E'] as const;

export function HorseLetters({
  letters,
  called,
}: {
  /** Accrued letters so far, e.g. "HOR". */
  letters: string;
  /** A shot is called and awaiting a match (currentSpot === 1). */
  called?: boolean;
}) {
  const taken = letters.length;
  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityLabel={
        taken > 0 ? `You have ${letters.split('').join(', ')}` : 'No letters yet'
      }
    >
      <View style={styles.row}>
        {HORSE.map((ch, i) => {
          const isTaken = i < taken;
          return (
            <Text key={ch} style={[styles.letter, isTaken && styles.letterTaken]}>
              {ch}
            </Text>
          );
        })}
      </View>
      <View style={styles.status}>
        <View style={[styles.dot, called ? styles.dotCalled : styles.dotOpen]} />
        <Text style={styles.statusText}>
          {called ? 'Match your shot' : 'Call a shot'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: space.xs,
  },
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  letter: {
    ...type.statMedium,
    color: color.textFaint,
    opacity: 0.4,
  },
  letterTaken: {
    color: color.miss,
    opacity: 1,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotCalled: {
    backgroundColor: color.accent,
  },
  dotOpen: {
    backgroundColor: color.textFaint,
  },
  statusText: {
    ...type.caption,
    color: color.textDim,
    textTransform: 'uppercase',
  },
});
