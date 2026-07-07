/**
 * ShotFlash — the full-screen result celebration for the live HUD.
 *
 * make   → a Skia "splash" burst (expanding ring + radiating spokes) blooms
 *          behind a scoreboard "SPLASH", scale-punched in on a stiff spring
 *          (fast in, gentle settle); the shot's point value rides along as a
 *          gold "3" ring for downtown makes; a flame "🔥 ×N" joins at streak ≥ 3.
 * miss   → a quiet neutral "MISS" (never punishing — no wash, no shake).
 * unsure → the quietest treatment: small chalk-yellow "UNSURE" with a faint
 *          "saved for review" line, eased in gently (fix later in the summary).
 *
 * The burst runs entirely on Skia/Reanimated shared values (no per-frame React
 * state) and is skipped when the system requests reduced motion. Everything is
 * pointerEvents="none" — the flash can never block a tap. Auto-dismisses after
 * motion.celebrate + fade headroom.
 */
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  ZoomIn,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  Path,
  Skia,
} from '@shopify/react-native-skia';

import { color, glow, motion, space, type } from '../../constants/tokens';
import type { ResolvedShot } from '../../core/types';
import { useSession } from '../../state/sessionStore';

const FLASH_MS = motion.celebrate + 100;
const BURST_SPOKES = 12;

/** Fast-in / gentle-out: expo-style deceleration so the burst leaps off the
 * rim in the first frames and settles softly instead of easing in lazily. */
const BURST_EASING = Easing.bezier(0.16, 1, 0.3, 1);

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

/**
 * MakeBurst — a radial splash drawn once per make. `t` animates 0→1; a ring
 * expands and fades while spokes shoot outward. Colored gold for a 3, green
 * for a 2, so the burst itself signals the point value.
 */
function MakeBurst({ is3 }: { is3: boolean }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = 0;
    t.value = withTiming(1, {
      duration: motion.celebrate,
      easing: BURST_EASING,
    });
  }, [t]);

  const cx = size.w / 2;
  const cy = size.h / 2;
  const maxR = Math.min(size.w, size.h) * 0.42;
  const hue = is3 ? glow.rimLive : color.make; // green for both; gold accent handled by ring badge
  const spokeColor = is3 ? glow.downtown : color.make;

  const ringR = useDerivedValue(() => maxR * (0.3 + t.value * 0.7));
  const ringOpacity = useDerivedValue(() => (1 - t.value) * 0.9);
  const ringStroke = useDerivedValue(() => 6 * (1 - t.value) + 1.5);

  const spokePath = useDerivedValue(() => {
    const p = Skia.Path.Make();
    if (size.w <= 0) return p;
    const inner = maxR * (0.24 + t.value * 0.55);
    const outer = maxR * (0.42 + t.value * 0.9);
    for (let i = 0; i < BURST_SPOKES; i++) {
      const a = (i / BURST_SPOKES) * Math.PI * 2 + (is3 ? Math.PI / BURST_SPOKES : 0);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      p.moveTo(cx + dx * inner, cy + dy * inner);
      p.lineTo(cx + dx * outer, cy + dy * outer);
    }
    return p;
  });
  const spokeOpacity = useDerivedValue(() => (1 - t.value) * 0.8);

  const coreR = useDerivedValue(() => maxR * (0.5 - t.value * 0.2));
  const coreOpacity = useDerivedValue(() => (1 - t.value) * 0.5);

  return (
    <Canvas
      style={absoluteFill}
      pointerEvents="none"
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {size.w > 0 && (
        <Group>
          <Circle cx={cx} cy={cy} r={coreR} color={hue} opacity={coreOpacity}>
            <BlurMask blur={30} style="normal" />
          </Circle>
          <Circle
            cx={cx}
            cy={cy}
            r={ringR}
            style="stroke"
            strokeWidth={ringStroke}
            color={hue}
            opacity={ringOpacity}
          >
            <BlurMask blur={3} style="normal" />
          </Circle>
          <Path
            path={spokePath}
            style="stroke"
            strokeWidth={3}
            strokeCap="round"
            color={spokeColor}
            opacity={spokeOpacity}
          >
            <BlurMask blur={2} style="normal" />
          </Path>
        </Group>
      )}
    </Canvas>
  );
}

/** Small gold "3" ring badge — the downtown mark shown on 3-point results. */
function ValueBadge({ value }: { value: 2 | 3 }) {
  if (value !== 3) return null;
  return (
    <View style={styles.badge} accessibilityLabel="Three pointer">
      <Text style={styles.badgeText}>3</Text>
    </View>
  );
}

/** Spoken confirmation for a resolved shot — independent of the Settings
 * "voice announcements" toggle, since this is the only screen-reader signal
 * for the core make/miss/unsure result. */
function announcement(shot: ResolvedShot, streak: number): string {
  if (shot.outcome === 'make') {
    const value = shot.shotValue ?? 2;
    const parts = [value === 3 ? 'Splash. Three pointer made.' : 'Splash. Shot made.'];
    if (streak >= 3) parts.push(`${streak} in a row.`);
    return parts.join(' ');
  }
  if (shot.outcome === 'miss') return 'Miss.';
  return 'Unsure — review this shot later.';
}

export function ShotFlash() {
  const lastShot = useSession((s) => s.lastShot);
  const streak = useSession((s) => s.stats.currentStreak);
  const reducedMotion = useReducedMotion();
  const [shot, setShot] = useState<ResolvedShot | null>(null);

  useEffect(() => {
    if (!lastShot) return;
    setShot(lastShot);
    AccessibilityInfo.announceForAccessibility(announcement(lastShot, streak));
    const id = setTimeout(() => setShot(null), FLASH_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastShot]);

  if (!shot) return null;

  if (shot.outcome === 'make') {
    const value = shot.shotValue ?? 2;
    const is3 = value === 3;
    return (
      <View
        style={styles.fill}
        pointerEvents="none"
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={announcement(shot, streak)}
      >
        <Animated.View
          key={`wash-${shot.id}`}
          entering={FadeIn.duration(motion.instant).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.standard).reduceMotion(ReduceMotion.System)}
          style={[styles.fill, is3 ? styles.downtownWash : styles.makeWash]}
        />
        {/* Skia burst is pure motion — drop it entirely under reduced motion. */}
        {!reducedMotion && (
          <View style={styles.fill} pointerEvents="none">
            <MakeBurst key={`burst-${shot.id}`} is3={is3} />
          </View>
        )}
        <Animated.View
          key={`splash-${shot.id}`}
          entering={ZoomIn.springify()
            .damping(14)
            .stiffness(320)
            .mass(0.8)
            .reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(motion.standard).reduceMotion(ReduceMotion.System)}
          style={styles.center}
        >
          <View style={styles.splashRow}>
            <Text style={styles.splash}>SPLASH</Text>
            <ValueBadge value={value} />
          </View>
          {is3 && <Text style={styles.downtownTag}>DOWNTOWN · +3</Text>}
          {streak >= 3 && <Text style={styles.flame}>{`🔥 ×${streak}`}</Text>}
        </Animated.View>
      </View>
    );
  }

  const isMiss = shot.outcome === 'miss';
  return (
    <View
      style={styles.fill}
      pointerEvents="none"
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={announcement(shot, streak)}
    >
      <Animated.View
        key={`${shot.outcome}-${shot.id}`}
        entering={FadeIn.duration(isMiss ? motion.quick : motion.standard).reduceMotion(
          ReduceMotion.System,
        )}
        exiting={FadeOut.duration(motion.standard).reduceMotion(ReduceMotion.System)}
        style={styles.center}
      >
        {isMiss ? (
          <Text style={styles.quiet}>MISS</Text>
        ) : (
          // Unsure is deliberately the quietest state: it's a "we'll sort it
          // out later", not a verdict — smaller type, no wash, soft fade.
          <View style={styles.unsureWrap}>
            <Text style={styles.unsureTitle}>UNSURE</Text>
            <Text style={styles.unsureSub}>SAVED FOR REVIEW</Text>
          </View>
        )}
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
  downtownWash: {
    backgroundColor: color.threePtTint,
  },
  splashRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  splash: {
    ...type.scoreboard,
    color: color.make,
  },
  downtownTag: {
    ...type.caption,
    color: color.threePt,
    letterSpacing: 2,
    marginTop: space.xs,
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
  unsureWrap: {
    alignItems: 'center',
  },
  unsureTitle: {
    ...type.statMedium,
    fontSize: 24,
    lineHeight: 26,
    color: 'rgba(232, 184, 79, 0.9)',
    letterSpacing: 1,
  },
  unsureSub: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1.2,
    marginTop: space.xs,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 3,
    borderColor: color.threePt,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.threePtTint,
  },
  badgeText: {
    ...type.statMedium,
    color: color.threePt,
  },
});
