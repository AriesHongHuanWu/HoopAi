/**
 * CoachMarks — reusable spotlight/tooltip walkthrough.
 *
 * Given an ordered list of steps, dims the screen behind a deep scrim (darker
 * than hudGlass so the teaching card clearly owns the moment) and shows one
 * card at a time with Next/Skip actions, animated progress dots, and a
 * reduced-motion-aware fade. When a step provides a targetRect, the card is
 * positioned near it — below by default, or above via `placement: 'above'`
 * for bottom-anchored targets — and a soft highlight ring is cut into the
 * scrim around that rect; otherwise the card is centered. Position math lives
 * in coachMarkLayout.ts (pure, unit-tested). With `tapToAdvance`, a tap
 * anywhere on the scrim advances; the buttons stay the accessible path.
 *
 * Skia is not required — plain Views are enough for the highlight ring, kept
 * simple so this mounts cheaply over camera/session screens.
 *
 * Pair with useCoachMarks(screenKey, steps) to auto-show on first visit and
 * persist "seen" state via the settings store.
 *
 * A11Y CAVEAT: `accessibilityViewIsModal` (below) is iOS-only and only hides
 * OTHER top-level siblings of this element from VoiceOver — it cannot reach
 * into a sibling screen's own subtree, and Android has no equivalent prop at
 * all. Because CoachMarks is mounted as a sibling of the screen content (see
 * call sites in app/index.tsx, app/session/live.tsx, app/session/summary.tsx)
 * rather than wrapping it, fully hiding the dimmed background from
 * TalkBack/VoiceOver-while-scrimmed requires each host screen to also set
 * `importantForAccessibility="no-hide-descendants"` (Android) / fold its root
 * into this modal boundary (iOS) on its own content while `visible` is true —
 * that wiring lives in the screen files, not here.
 */
import React, { useState } from 'react';
import {
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutRectangle,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ReduceMotion,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, motion, radius, shadow, space, touch, type } from '../../constants/tokens';
import { useSettings, type TutorialScreen } from '../../state/settingsStore';
import { Row } from '../ui';
import { cardPosFor, HIGHLIGHT_PAD } from './coachMarkLayout';

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export interface CoachStep {
  title: string;
  text: string;
  /** Screen-space rect to highlight; omit to center the card. */
  targetRect?: LayoutRectangle;
  /**
   * Where the card sits relative to targetRect. 'below' (default) matches the
   * original behavior; use 'above' for bottom-anchored targets (e.g. the live
   * action bar) so the card doesn't cover them. Ignored when targetRect is
   * omitted (card centers).
   */
  placement?: 'below' | 'above';
}

const CARD_MAX_WIDTH = 360;

const dotGrow = LinearTransition.duration(motion.quick).reduceMotion(ReduceMotion.System);

/** Soft highlight ring cut around a target rect — four dim panels + a border. */
function Highlight({ rect }: { rect: LayoutRectangle }) {
  const x = rect.x - HIGHLIGHT_PAD;
  const y = rect.y - HIGHLIGHT_PAD;
  const w = rect.width + HIGHLIGHT_PAD * 2;
  const h = rect.height + HIGHLIGHT_PAD * 2;
  return (
    <View pointerEvents="none" style={absoluteFill}>
      <View
        style={[
          styles.highlightRing,
          { left: x, top: y, width: w, height: h, borderRadius: radius.lg },
        ]}
      />
    </View>
  );
}

/** One progress dot; grows into an accent pill when active (animated width). */
function StepDot({ active }: { active: boolean }) {
  return <Animated.View layout={dotGrow} style={[styles.dot, active && styles.dotActive]} />;
}

export function CoachMarks({
  steps,
  onFinish,
  onSkip,
  tapToAdvance = false,
}: {
  steps: CoachStep[];
  /** Called after the last step's "Got it" is pressed. */
  onFinish: () => void;
  /** Called when the user dismisses early via Skip. Defaults to onFinish. */
  onSkip?: () => void;
  /**
   * When true, a tap anywhere on the scrim advances to the next step (and
   * finishes on the last one). The card's Skip/Next buttons keep priority and
   * remain the screen-reader path.
   */
  tapToAdvance?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(0);
  if (steps.length === 0) return null;

  const step = steps[index]!;
  const isLast = index === steps.length - 1;
  const skip = onSkip ?? onFinish;

  const next = () => {
    if (isLast) {
      onFinish();
      return;
    }
    setIndex((i) => i + 1);
  };

  const cardPos = cardPosFor(
    step.targetRect,
    step.placement ?? 'below',
    Dimensions.get('window').height,
    insets.top,
    insets.bottom,
  );

  return (
    <Animated.View
      entering={FadeIn.duration(motion.standard).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.quick).reduceMotion(ReduceMotion.System)}
      style={[styles.scrim, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      accessibilityViewIsModal
    >
      {tapToAdvance && (
        // Full-scrim underlay: rendered BEFORE the card wrapper so the card's
        // own Skip/Next Pressables win hit-testing; those buttons remain the
        // screen-reader path.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next tip — tap anywhere to continue"
          onPress={next}
          style={absoluteFill}
        />
      )}

      {step.targetRect != null && <Highlight rect={step.targetRect} />}

      <View
        style={[
          styles.cardWrap,
          cardPos == null
            ? styles.cardWrapCentered
            : { position: 'absolute', left: space.lg, right: space.lg, ...cardPos },
        ]}
      >
        <Animated.View
          key={step.title}
          entering={FadeInDown.duration(motion.standard).reduceMotion(ReduceMotion.System)}
          style={styles.card}
        >
          <Text
            style={styles.cardTitle}
            accessibilityRole="header"
            accessibilityLabel={`Step ${index + 1} of ${steps.length}. ${step.title}`}
          >
            {step.title}
          </Text>
          <Text style={styles.cardText}>{step.text}</Text>

          <Row style={styles.footer}>
            <View importantForAccessibility="no-hide-descendants" style={styles.dots}>
              <Row gap={space.xs}>
                {steps.map((s, i) => (
                  <StepDot key={s.title} active={i === index} />
                ))}
              </Row>
            </View>
            <Row gap={space.md}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Skip walkthrough"
                onPress={skip}
                hitSlop={space.sm}
                style={({ pressed }) => [styles.skipBtn, pressed && styles.skipBtnPressed]}
              >
                <Text style={styles.skipLabel}>Skip</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isLast ? 'Got it, close walkthrough' : 'Next tip'}
                onPress={next}
                style={({ pressed }) => [
                  styles.nextBtn,
                  { backgroundColor: pressed ? color.accentPressed : color.accent },
                ]}
              >
                <Text style={styles.nextLabel}>{isLast ? 'Got it' : 'Next'}</Text>
              </Pressable>
            </Row>
          </Row>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/**
 * Shows a CoachMarks walkthrough the first time a screen is visited (per the
 * persisted settingsStore.tutorialSeen flags) and marks it seen on finish or
 * skip. Returns { visible, steps, finish } — render <CoachMarks> only while
 * visible is true.
 */
export function useCoachMarks(screenKey: TutorialScreen, steps: CoachStep[]) {
  const seen = useSettings((s) => s.tutorialSeen[screenKey]);
  const markTutorialSeen = useSettings((s) => s.markTutorialSeen);
  const [dismissed, setDismissed] = useState(false);

  const visible = !seen && !dismissed && steps.length > 0;

  const finish = () => {
    setDismissed(true);
    markTutorialSeen(screenKey);
  };

  return { visible, steps, finish };
}

const styles = StyleSheet.create({
  scrim: {
    // The app-wide overlay scrim (the exact value this file used to inline —
    // darker than hudGlass, so the app behind clearly recedes while teaching).
    ...absoluteFill,
    backgroundColor: color.scrim,
    paddingHorizontal: space.lg,
  },
  highlightRing: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: color.accent,
    backgroundColor: 'transparent',
    shadowColor: color.accent,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  cardWrap: {
    width: '100%',
  },
  cardWrapCentered: {
    flex: 1,
    justifyContent: 'center',
  },
  card: {
    maxWidth: CARD_MAX_WIDTH,
    alignSelf: 'center',
    width: '100%',
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    padding: space.lg,
    // The ONE sanctioned drop shadow — this popover is the transient-overlay
    // case shadow.pop exists for (iOS shadow + Android elevation together).
    ...shadow.pop,
  },
  cardTitle: {
    ...type.heading,
    color: color.text,
    marginBottom: space.xs,
  },
  cardText: {
    ...type.body,
    color: color.textDim,
  },
  footer: {
    marginTop: space.lg,
    justifyContent: 'space-between',
  },
  dots: {
    flexShrink: 0,
  },
  dot: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.border,
  },
  dotActive: {
    backgroundColor: color.accent,
    width: space.lg,
  },
  skipBtn: {
    minHeight: touch.minTarget,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  skipBtnPressed: {
    backgroundColor: color.surfaceRaised,
  },
  skipLabel: {
    ...type.bodyMedium,
    color: color.textFaint,
  },
  nextBtn: {
    minHeight: touch.minTarget,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
  },
  nextLabel: {
    ...type.bodyMedium,
    color: color.onAccent,
  },
});
