/**
 * FirstBallRitual — the first-ball onboarding polish on the live HUD.
 *
 * A tiny self-contained state machine that runs once per rim lock:
 *   awaitBall — "Take a shot — I'm watching the rim" right after lock;
 *   ballSeen  — a brief "✓ Ball in sight" flash on the first REAL (non-
 *               predicted) tracked ball;
 *   quiet     — nothing, waiting for the session's first resolved shot;
 *   tour      — once per install (persisted receiptTourSeen), points the
 *               user at the shot receipt in the summary;
 *   done      — nothing until the rim unlocks (re-aim restarts the ritual).
 *
 * Strictly visual: chips never intercept camera taps (pointerEvents none),
 * the ball poll only runs during awaitBall, and the 8 s give-up means the
 * prompt never nags. No wall clock — timers only.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import type { ShotEngine } from '@/camera/useShotEngine';
import { HudChip } from '@/components/hud/HudChip';
import { color, motion, space, type } from '@/constants/tokens';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

/** Ball poll cadence during awaitBall only — never per-frame React. */
const BALL_POLL_MS = 250;
/** Give-up window: advance to quiet unanswered so the chip never nags. */
const AWAIT_TIMEOUT_MS = 8000;
/** How long the "Ball in sight" flash stays up. */
const BALL_SEEN_MS = 1500;
/** How long the one-time receipt tour chip stays up. */
const TOUR_MS = 5000;

const AWAIT_TEXT = 'Take a shot — I’m watching the rim';
const BALL_SEEN_TEXT = '✓ Ball in sight';
const TOUR_TEXT = 'Every call comes with a receipt — see WHY in your summary';

type Stage = 'idle' | 'awaitBall' | 'ballSeen' | 'quiet' | 'tour' | 'done';

export function FirstBallRitual({ overlay }: { overlay: ShotEngine['overlay'] }) {
  const rimLocked = useSession((s) => s.rimLocked);
  const shotCount = useSession((s) => s.shots.length);
  const tourSeen = useSettings((s) => s.receiptTourSeen);
  const set = useSettings((s) => s.set);
  const reducedMotion = useReducedMotion();

  const [stage, setStage] = useState<Stage>('idle');

  // Rim lock drives entry; unlock resets — re-aim restarts the ritual.
  useEffect(() => {
    if (!rimLocked) {
      setStage('idle');
      return;
    }
    setStage((s) => (s === 'idle' ? 'awaitBall' : s));
  }, [rimLocked]);

  // awaitBall: poll for the first REAL tracked ball (Kalman coasts are
  // predicted=true and must not count), give up quietly after 8 s.
  useEffect(() => {
    if (stage !== 'awaitBall') return;
    const poll = setInterval(() => {
      const o = overlay.value;
      if (o.ball != null && o.ball.predicted !== true) setStage('ballSeen');
    }, BALL_POLL_MS);
    const giveUp = setTimeout(() => setStage('quiet'), AWAIT_TIMEOUT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [stage, overlay]);

  // ballSeen: brief confirmation flash, then quiet.
  useEffect(() => {
    if (stage !== 'ballSeen') return;
    const id = setTimeout(() => setStage('quiet'), BALL_SEEN_MS);
    return () => clearTimeout(id);
  }, [stage]);

  // quiet: the session's first resolved shot triggers the one-time tour;
  // if the tour was already seen on this install, skip straight to done.
  useEffect(() => {
    if (stage !== 'quiet' || shotCount < 1) return;
    setStage(tourSeen === false ? 'tour' : 'done');
  }, [stage, shotCount, tourSeen]);

  // tour: show once, persist, done.
  useEffect(() => {
    if (stage !== 'tour') return;
    const id = setTimeout(() => {
      set('receiptTourSeen', true);
      setStage('done');
    }, TOUR_MS);
    return () => clearTimeout(id);
  }, [stage, set]);

  const chip =
    stage === 'awaitBall'
      ? { text: AWAIT_TEXT, style: styles.awaitText }
      : stage === 'ballSeen'
        ? { text: BALL_SEEN_TEXT, style: styles.ballSeenText }
        : stage === 'tour'
          ? { text: TOUR_TEXT, style: styles.tourText }
          : null;
  if (chip == null) return null;

  return (
    <View style={styles.wrap} pointerEvents="none">
      {/* key remounts per stage so each chip gets its own entrance. */}
      <Animated.View
        key={stage}
        entering={reducedMotion ? undefined : FadeInDown.duration(motion.quick)}
      >
        <HudChip accessible accessibilityLabel={chip.text}>
          <Text style={chip.style}>{chip.text}</Text>
        </HudChip>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    marginTop: space.sm,
  },
  awaitText: {
    ...type.micro,
    color: color.textDim,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  ballSeenText: {
    ...type.micro,
    color: color.make,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  tourText: {
    ...type.caption,
    color: color.accent,
  },
});
