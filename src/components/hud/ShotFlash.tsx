/**
 * ShotFlash — full-screen result flash for the live HUD.
 *
 * make   → "SPLASH" in swish green over a brief accent wash, scale + fade;
 *          a flame "🔥 ×N" joins at streak ≥ 3.
 * miss   → small neutral "MISS" (never punishing — no red wash, no shake).
 * unsure → small "UNSURE" in chalk yellow (fix later in the summary).
 *
 * Auto-dismisses after ~700 ms (motion.celebrate + fade headroom).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';

import { color, motion, space, type } from '../../constants/tokens';
import type { ResolvedShot } from '../../core/types';
import { useSession } from '../../state/sessionStore';

const FLASH_MS = motion.celebrate + 100;

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export function ShotFlash() {
  const lastShot = useSession((s) => s.lastShot);
  const streak = useSession((s) => s.stats.currentStreak);
  const [shot, setShot] = useState<ResolvedShot | null>(null);

  useEffect(() => {
    if (!lastShot) return;
    setShot(lastShot);
    const id = setTimeout(() => setShot(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [lastShot]);

  if (!shot) return null;

  if (shot.outcome === 'make') {
    return (
      <View style={styles.fill} pointerEvents="none">
        <Animated.View
          key={`wash-${shot.id}`}
          entering={FadeIn.duration(motion.instant)}
          exiting={FadeOut.duration(motion.standard)}
          style={[styles.fill, styles.makeWash]}
        />
        <Animated.View
          key={`splash-${shot.id}`}
          entering={ZoomIn.duration(motion.quick)}
          exiting={FadeOut.duration(motion.standard)}
          style={styles.center}
        >
          <Text style={styles.splash} accessibilityLabel="Make">
            SPLASH
          </Text>
          {streak >= 3 && <Text style={styles.flame}>{`🔥 ×${streak}`}</Text>}
        </Animated.View>
      </View>
    );
  }

  const isMiss = shot.outcome === 'miss';
  return (
    <View style={styles.fill} pointerEvents="none">
      <Animated.View
        key={`${shot.outcome}-${shot.id}`}
        entering={FadeIn.duration(motion.quick)}
        exiting={FadeOut.duration(motion.standard)}
        style={styles.center}
      >
        <Text style={[styles.quiet, !isMiss && styles.unsure]}>
          {isMiss ? 'MISS' : 'UNSURE'}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...absoluteFill,
  },
  center: {
    ...absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  makeWash: {
    backgroundColor: color.makeTint,
  },
  splash: {
    ...type.scoreboard,
    color: color.make,
  },
  flame: {
    ...type.statMedium,
    color: color.accent,
    marginTop: space.sm,
  },
  quiet: {
    ...type.statMedium,
    color: color.textDim,
  },
  unsure: {
    color: color.unsure,
  },
});
