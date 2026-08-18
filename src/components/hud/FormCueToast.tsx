/**
 * FormCueToast — a quiet, non-blocking form-coaching cue on the live HUD.
 *
 * When form analysis is on, each resolved shot may carry `shot.form?.tips`
 * (coachingTips()). This card surfaces the single top cue for ~3.5 s under the
 * ShotToast, heavily throttled by the pure picker (pickFormCue): never on a
 * heater, headline-only after makes, 20 s cooldown, no metric repeats.
 *
 * Purely reactive presentation: it never touches the pipeline/FSM and renders
 * nothing when form analysis is off (no tips ever arrive). Lifecycle mirrors
 * ShotToast — a new shot re-arms, tap dismisses early, reduced motion drops
 * the slide/fade, and the wrapper is box-none so only the card captures touch.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { color, motion, space, type } from '../../constants/tokens';
import type { CoachingTip, ResolvedShot } from '../../core/types';
import { Row } from '../ui';
import { HudChip } from './HudChip';
import { EMPTY_CUE_MEMO, pickFormCue, type FormCueMemo } from './formCue';

/** How long the cue stays up before fading out. */
const CUE_MS = 3500;

/**
 * PERF (memo): same shape as ShotToast — driven by the resolved shot, not by
 * the live screen's tick-level state.
 */
export const FormCueToast = React.memo(function FormCueToast({
  shot,
  streak,
}: {
  /** Latest resolved shot; each new one re-arms the picker. */
  shot: ResolvedShot | null;
  /** Current make streak from the session store (post-shot). */
  streak: number;
}): React.JSX.Element | null {
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState<{ tip: CoachingTip; shotId: number } | null>(null);
  // Throttle memo lives across shots; the picker stays pure.
  const memo = useRef<FormCueMemo>({ ...EMPTY_CUE_MEMO });
  // Dismiss timer lives in a ref (not the effect cleanup): a cue-less shot
  // arriving mid-toast must NOT cancel the pending auto-dismiss, or the card
  // would linger until the next cue. Only a replacing cue or unmount clears it.
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `streak` read inside the effect is already the POST-shot streak: live.tsx's
  // streak selector updates in the same commit as toastShot, so the effect run
  // for a new shot sees both together. Date.now() is fine here — this is
  // UI-thread React code, not pure core.
  useEffect(() => {
    if (shot == null) return;
    const tip = pickFormCue(shot, streak, memo.current, Date.now());
    if (tip == null) return;
    memo.current = { lastShownAtMs: Date.now(), lastMetric: tip.metric };
    setVisible({ tip, shotId: shot.id });
    if (dismissTimer.current != null) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => setVisible(null), CUE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot]);

  // Clear the pending dismiss on unmount only.
  useEffect(
    () => () => {
      if (dismissTimer.current != null) clearTimeout(dismissTimer.current);
    },
    [],
  );

  if (visible == null) return null;

  return (
    <Animated.View
      key={visible.shotId}
      entering={reducedMotion ? undefined : FadeInUp.duration(motion.quick)}
      exiting={reducedMotion ? undefined : FadeOut.duration(motion.standard)}
      style={styles.wrap}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={() => setVisible(null)}
        accessibilityRole="button"
        accessibilityLabel={`Form cue: ${visible.tip.title}`}
        accessibilityHint="Dismisses the form cue"
      >
        <HudChip style={styles.chip}>
          <Row gap={space.sm}>
            <Ionicons name="school-outline" size={14} color={color.accent} />
            <View>
              <Text style={styles.eyebrow}>FORM CUE</Text>
              {/* polite queues AFTER ShotFlash's assertive outcome announcement —
                  no double-speak over the make/miss call. */}
              <Text style={styles.title} numberOfLines={1} accessibilityLiveRegion="polite">
                {visible.tip.title}
              </Text>
            </View>
          </Row>
        </HudChip>
      </Pressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'center',
    marginTop: space.sm,
  },
  chip: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    // numberOfLines={1} on the title keeps a long tip from wrapping the HUD;
    // HudChip clips any overflow past this cap.
    maxWidth: 280,
  },
  eyebrow: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1.2,
  },
  title: {
    ...type.bodyMedium,
    color: color.text,
  },
});
